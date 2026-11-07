import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ARTIFACT_SCHEMAS, type ArtifactKind, type RoleId } from '../contracts/artifacts.js'
import { ROLES, type RoleDefinition } from '../contracts/roles.js'
import { StudioError, STUDIO_ERROR_CODES } from '../contracts/errors.js'
import type { StudioRuntime } from '../studio/runtime.js'
import { findAssignmentByAgent } from '../storage/repositories/runs.js'
import { findArtifactByTask } from '../storage/repositories/artifacts.js'
import { loadCanon } from '../kernel/book/store.js'

/** Scoped tool names per role. These are never registered in the main session. */
export const ROLE_TOOLS: Record<RoleId, readonly string[]> = {
  showrunner: ['novel_task_read', 'novel_decision_submit', 'novel_agent_message'],
  architect: ['novel_task_read', 'novel_bible_submit', 'novel_outline_submit'],
  worldsmith: ['novel_task_read', 'novel_worldbook_submit'],
  planner: ['novel_task_read', 'novel_chapter_plan_submit'],
  drafter: ['novel_task_read', 'novel_draft_submit'],
  'critic-story': ['novel_task_read', 'novel_review_submit'],
  'critic-character': ['novel_task_read', 'novel_review_submit'],
  'critic-prose': ['novel_task_read', 'novel_review_submit'],
  continuity: ['novel_task_read', 'novel_continuity_submit', 'novel_canon_query'],
  polisher: ['novel_task_read', 'novel_polish_submit'],
  archivist: ['novel_task_read', 'novel_delta_submit', 'novel_archive_commit'],
  radar: ['novel_task_read', 'novel_market_submit', 'web_search', 'web_fetch'],
}

export const roleDefinition = (role: RoleId): RoleDefinition => ROLES[role]

/** The structural permission boundary. Prompt text is never the enforcement. */
export function assertRoleCanWrite(role: RoleId, kind: ArtifactKind): void {
  const definition = ROLES[role]
  if (definition === undefined) {
    throw new StudioError(STUDIO_ERROR_CODES.AGENT_FAILED, `unknown role ${role}`)
  }
  if (!definition.canWrite.includes(kind)) {
    throw new StudioError(
      STUDIO_ERROR_CODES.AGENT_FAILED,
      `role ${role} cannot write ${kind}`,
      'permissions are enforced by the kernel, not by prompt text',
      { role, kind, allowed: definition.canWrite },
    )
  }
}

/** Every role is sandboxed: no fs, no shell, no spawn. */
export function assertRoleTool(role: RoleId, tool: string): void {
  if (!ROLE_TOOLS[role].includes(tool)) {
    throw new StudioError(STUDIO_ERROR_CODES.AGENT_FAILED, `role ${role} cannot use ${tool}`, undefined, {
      role,
      tool,
      allowed: ROLE_TOOLS[role],
    })
  }
}

const SUBMIT_KIND: Record<string, ArtifactKind> = {
  novel_bible_submit: 'BiblePlan',
  novel_outline_submit: 'OutlinePlan',
  novel_worldbook_submit: 'WorldbookPatch',
  novel_chapter_plan_submit: 'ChapterPlan',
  novel_draft_submit: 'Draft',
  novel_review_submit: 'ReviewReport',
  novel_continuity_submit: 'ContinuityReport',
  novel_polish_submit: 'PolishPatch',
  novel_delta_submit: 'StateDelta',
  novel_decision_submit: 'Decision',
  novel_market_submit: 'MarketBrief',
}

const text = (value: unknown): Array<{ type: 'text'; text: string }> => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
]
const output = { schema: { type: 'json' as const }, render: (_args: unknown, raw: unknown) => text(raw) }
const makeTool = (options: unknown): ToolDefinition => defineTool(options as never)

/** Role-scoped tool definitions; callers register them only in the role agent scope. */
export function createRoleToolDefinitions(runtime: StudioRuntime, role: RoleId): ToolDefinition[] {
  const definition = ROLES[role]
  const tools: ToolDefinition[] = []
  if (ROLE_TOOLS[role].includes('novel_task_read')) {
    tools.push(
      makeTool({
        name: 'novel_task_read',
        description: 'Read the current assignment, task input and available artifact refs.',
        parameters: {},
        output,
        async execute(_args: unknown, exec: { agent?: Agent }) {
          const handle = await openForAgent(runtime, exec.agent)
          const found = findAssignmentByAgent(handle.db.orm, exec.agent!.id)
          if (found === undefined)
            throw new StudioError(STUDIO_ERROR_CODES.AGENT_FAILED, 'no assignment for this agent session')
          return {
            assignment: {
              id: found.assignment.id,
              preset: found.assignment.preset,
              model: found.assignment.model,
            },
            task: {
              id: found.task.id,
              kind: found.task.kind,
              role: found.task.role,
              chapter: JSON.parse(found.task.inputJson).chapter ?? null,
            },
            input: JSON.parse(found.task.inputJson) as Record<string, unknown>,
          }
        },
      }),
    )
  }
  for (const [toolName, kind] of Object.entries(SUBMIT_KIND)) {
    if (!ROLE_TOOLS[role].includes(toolName)) continue
    tools.push(
      makeTool({
        name: toolName,
        description: `Submit one ${kind} artifact for this assignment.`,
        parameters: { content: { type: 'json', required: true } },
        output,
        async execute(args: unknown, exec: { agent?: Agent }) {
          const handle = await openForAgent(runtime, exec.agent)
          const found = findAssignmentByAgent(handle.db.orm, exec.agent!.id)
          if (found === undefined)
            throw new StudioError(STUDIO_ERROR_CODES.AGENT_FAILED, 'no assignment for this agent session')
          assertRoleCanWrite(role, kind)
          const parsed = ARTIFACT_SCHEMAS[kind].safeParse((args as { content: unknown }).content)
          if (!parsed.success)
            throw new StudioError(STUDIO_ERROR_CODES.ARTIFACT_INVALID, `${kind} schema failed`, undefined, {
              issues: parsed.error.issues,
            })
          const chapter = (JSON.parse(found.task.inputJson) as { chapter?: number }).chapter ?? null
          const draftArtifact = chapter === null ? null : await handle.artifacts.latest('Draft', chapter)
          const body = parsed.data as Record<string, unknown>
          // An idempotent retry belongs to the artifact this task already
          // produced, not to the latest draft (which may be a later polish).
          const existing = findArtifactByTask(handle.db.orm, found.task.id)
          if (kind === 'Draft' && existing === undefined) {
            const expectedId = draftArtifact?.id ?? null
            const expectedHash = draftArtifact?.contentHash ?? null
            const sameBytes =
              draftArtifact !== null &&
              handle.artifacts.contentHash('Draft', body) === draftArtifact.contentHash
            if (
              !sameBytes &&
              (body.base_artifact_id !== expectedId || (body.expected_hash ?? null) !== expectedHash)
            ) {
              throw new StudioError(
                STUDIO_ERROR_CODES.ARTIFACT_INVALID,
                'Draft does not bind the current draft version',
                'copy base_artifact_id and expected_hash from the task prompt',
                {
                  expectedId,
                  expectedHash,
                  receivedId: body.base_artifact_id,
                  receivedHash: body.expected_hash,
                },
              )
            }
          }
          if (
            (kind === 'ReviewReport' || kind === 'ContinuityReport') &&
            existing === undefined &&
            draftArtifact !== null &&
            body.base_hash !== draftArtifact.contentHash
          ) {
            throw new StudioError(
              STUDIO_ERROR_CODES.ARTIFACT_INVALID,
              `${kind} base_hash does not match the current draft`,
              'copy base_hash from the task prompt',
              { expected: draftArtifact.contentHash, received: body.base_hash },
            )
          }
          if (kind === 'PolishPatch' && existing === undefined && draftArtifact !== null) {
            if (
              body.base_hash !== draftArtifact.contentHash ||
              body.expected_hash !== draftArtifact.contentHash
            ) {
              throw new StudioError(
                STUDIO_ERROR_CODES.ARTIFACT_INVALID,
                'PolishPatch base_hash/expected_hash do not match the current draft',
                'copy both hashes from the task prompt',
              )
            }
          }
          const artifact = await handle.artifacts.submit({
            kind,
            chapter:
              kind === 'BiblePlan' || kind === 'OutlinePlan' || kind === 'MarketBrief' ? null : chapter,
            content: parsed.data,
            provenance: {
              runId: found.task.runId,
              taskId: found.task.id,
              role,
              preset: definition.preset,
              agentSessionId: exec.agent!.id,
            },
          })
          return { ok: true, artifactId: artifact.id, version: artifact.version }
        },
      }),
    )
  }
  if (ROLE_TOOLS[role].includes('novel_canon_query')) {
    tools.push(
      makeTool({
        name: 'novel_canon_query',
        description: 'Read the current canon snapshot.',
        parameters: {},
        output,
        async execute(_args: unknown, exec: { agent?: Agent }) {
          const handle = await openForAgent(runtime, exec.agent)
          return loadCanon(handle.project.store)
        },
      }),
    )
  }
  if (ROLE_TOOLS[role].includes('novel_archive_commit')) {
    tools.push(
      makeTool({
        name: 'novel_archive_commit',
        description: 'Commit the already-submitted StateDelta through the kernel archive gate.',
        parameters: {},
        output,
        async execute(_args: unknown, exec: { agent?: Agent }) {
          const handle = await openForAgent(runtime, exec.agent)
          const found = findAssignmentByAgent(handle.db.orm, exec.agent!.id)
          if (found === undefined)
            throw new StudioError(STUDIO_ERROR_CODES.AGENT_FAILED, 'no assignment for this agent session')
          if (found.task.kind !== 'archive' || !['running', 'validating'].includes(found.task.status)) {
            throw new StudioError(
              STUDIO_ERROR_CODES.TASK_STATE_INVALID,
              'archive commit is only legal while the archive task is running',
              'submit the StateDelta first; the kernel commits archive when the task settles',
            )
          }
          await handle.director.onTaskSettled(found.task)
          return { ok: true, note: 'archive commit evaluated by kernel' }
        },
      }),
    )
  }
  if (ROLE_TOOLS[role].includes('novel_agent_message')) {
    tools.push(
      makeTool({
        name: 'novel_agent_message',
        description: 'Send one message to a direct role child.',
        parameters: {
          target_id: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
        output,
        async execute(args: unknown, exec: { agent?: Agent; signal?: AbortSignal }) {
          if (exec.agent === undefined)
            throw new StudioError(STUDIO_ERROR_CODES.AGENT_FAILED, 'no sender agent')
          const input = args as { target_id: string; message: string }
          await runtime.sendRoleMessage(
            exec.agent,
            input.target_id,
            input.message,
            exec.signal ?? new AbortController().signal,
          )
          return { ok: true }
        },
      }),
    )
  }
  return tools
}

async function openForAgent(
  runtime: StudioRuntime,
  agent: Agent | undefined,
): Promise<Awaited<ReturnType<StudioRuntime['open']>>> {
  if (agent === undefined)
    throw new StudioError(STUDIO_ERROR_CODES.AGENT_FAILED, 'role tool called without an agent')
  const handle = await runtime.openForAgent(agent.id)
  if (handle === undefined)
    throw new StudioError(STUDIO_ERROR_CODES.AGENT_FAILED, 'cannot resolve project for this agent')
  return handle
}
