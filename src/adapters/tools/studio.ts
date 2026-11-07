import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { StudioRuntime } from '../../studio/runtime.js'
import { StudioError, STUDIO_ERROR_CODES } from '../../contracts/errors.js'
import { BiblePlanSchema, OutlinePlanSchema } from '../../contracts/artifacts.js'
import { loadBible, loadBookOutline, listChapterPlans } from '../../kernel/book/store.js'
import { listArtifacts } from '../../storage/repositories/artifacts.js'
import { listAssignments, listRuns, listTasks } from '../../storage/repositories/runs.js'
import { searchMemory } from '../../storage/repositories/memory.js'
import { exportProject, type ExportKind } from '../../kernel/export/index.js'
import { ROLES } from '../../contracts/roles.js'
import { loadTaxonomy } from '../../taxonomy.js'
import { genrePath, sortTags } from '../../domain/taxonomy.js'
import type { RunKind } from '../../contracts/stages.js'

export interface StudioToolExec {
  signal?: AbortSignal
  agent?: Agent
}

const text = (value: unknown): Array<{ type: 'text'; text: string }> => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
]

const output = {
  schema: { type: 'json' as const },
  render: (_args: unknown, raw: unknown) => text(raw),
}

/** Adapter-level schema checks are runtime-owned; the DSL's literal inference
 * cannot express every canonical artifact union without duplicating it. */
const makeTool = (options: unknown): ToolDefinition => defineTool(options as never)

const rootParameter = {
  type: 'string' as const,
  description: 'Project root. Defaults to the configured projectRoot.',
}

const fail = (error: unknown): never => {
  if (error instanceof StudioError) {
    const details = error.details === undefined ? '' : ` details=${JSON.stringify(error.details)}`
    throw new Error(
      `[${error.code}] ${error.message}${error.hint === undefined ? '' : ` — ${error.hint}`}${details}`,
    )
  }
  throw error
}

const asAgent = (exec: StudioToolExec): Agent => {
  if (exec.agent === undefined) {
    throw new StudioError(
      STUDIO_ERROR_CODES.AGENT_PROVIDER_UNSUPPORTED,
      'this operation needs a live parent Agent to spawn role subagents',
      'call novel_run from a DSH session; background runs use the project director agent',
    )
  }
  return exec.agent
}

const open = async (runtime: StudioRuntime, root?: string) => {
  try {
    return await runtime.open(root)
  } catch (error) {
    return fail(error)
  }
}

export function createStudioTools(runtime: StudioRuntime): ToolDefinition[] {
  return [
    makeTool({
      name: 'novel_init',
      description:
        'Create a 0.3.0 studio project (format v2): studio.yaml, bible, outline, manuscript, canon and SQLite orchestration. Rejects an existing project.',
      parameters: {
        title: { type: 'string', required: true },
        author: { type: 'string' },
        genre: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            major: { type: 'string', required: true },
            sub: { type: 'string', required: true },
            tags: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        audience: { type: 'string', required: true, enum: ['male', 'female', 'general', 'teen', 'adult'] },
        platform: { type: 'string', required: true, enum: ['fanqie', 'qidian', 'qimao', 'jinjiang'] },
        premise: { type: 'string' },
        total_chapters: { type: 'integer' },
        words_per_chapter: { type: 'array', items: { type: 'integer' } },
        project_root: rootParameter,
      },
      output,
      async execute(args: unknown, exec: StudioToolExec) {
        void exec
        const input = args as {
          title: string
          author?: string
          genre: { major: string; sub: string; tags: string[] }
          audience: 'male' | 'female' | 'general' | 'teen' | 'adult'
          platform: 'fanqie' | 'qidian' | 'qimao' | 'jinjiang'
          premise?: string
          total_chapters?: number
          words_per_chapter?: number[]
          project_root?: string
        }
        try {
          const handle = await runtime.init({
            root: input.project_root,
            title: input.title,
            author: input.author,
            genre: input.genre,
            audience: input.audience,
            platform: input.platform,
            premise: input.premise,
            ...(input.total_chapters === undefined
              ? {}
              : { targets: { total_chapters: input.total_chapters } }),
            ...(input.words_per_chapter === undefined
              ? {}
              : {
                  targets: {
                    words_per_chapter: [
                      input.words_per_chapter[0] ?? 2200,
                      input.words_per_chapter[1] ?? 3200,
                    ] as [number, number],
                    total_chapters: input.total_chapters ?? 120,
                  },
                }),
          })
          return {
            ok: true,
            project: {
              id: handle.project.config.id,
              root: handle.project.root,
              title: handle.project.config.title,
              genre_path: genrePath(handle.project.config.genre, handle.project.taxonomy),
              tags: sortTags(handle.project.config.genre.tags),
            },
            next: 'novel_bible action=propose or novel_run kind=book',
          }
        } catch (error) {
          return fail(error)
        }
      },
    }),

    makeTool({
      name: 'novel_status',
      description: 'Read project state, next legal action, active run, score, blocking count and cost.',
      parameters: { chapter: { type: 'integer' }, project_root: rootParameter },
      output,
      async execute(args: unknown) {
        const input = args as { chapter?: number; project_root?: string }
        const handle = await open(runtime, input.project_root)
        return handle.director.status(input.chapter)
      },
    }),

    makeTool({
      name: 'novel_bible',
      description:
        'Read the Story Bible, or propose a new BiblePlan artifact (human Bible Gate required before it is written).',
      parameters: {
        action: { type: 'string', required: true, enum: ['read', 'propose'] },
        patch: { type: 'json', description: 'BiblePlan object for propose.' },
        project_root: rootParameter,
      },
      output,
      async execute(args: unknown) {
        const input = args as { action: 'read' | 'propose'; patch?: unknown; project_root?: string }
        const handle = await open(runtime, input.project_root)
        if (input.action === 'read') return loadBible(handle.project.store)
        const parsed = BiblePlanSchema.safeParse(input.patch)
        if (!parsed.success)
          return fail(
            new StudioError(STUDIO_ERROR_CODES.ARTIFACT_INVALID, 'BiblePlan schema failed', undefined, {
              issues: parsed.error.issues,
            }),
          )
        const artifact = await handle.artifacts.submit({
          kind: 'BiblePlan',
          chapter: null,
          content: parsed.data,
          provenance: {
            runId: 'proposal',
            taskId: `bible:${randomUUID()}`,
            role: 'architect',
            preset: 'novel-role-architect',
            model: 'human-tool',
          },
          status: 'draft',
        })
        handle.director.gates.open({
          projectId: handle.project.config.id,
          runId: 'proposal',
          gate: 'bible',
          artifactId: artifact.id,
        })
        return {
          ok: true,
          artifact: { id: artifact.id, version: artifact.version },
          next: 'host novel_approve gate=bible',
        }
      },
    }),

    makeTool({
      name: 'novel_outline',
      description:
        'Read the book outline and chapter cards, or propose an OutlinePlan artifact (human Outline Gate required).',
      parameters: {
        action: { type: 'string', required: true, enum: ['read', 'propose'] },
        content: { type: 'json', description: 'OutlinePlan object for propose.' },
        project_root: rootParameter,
      },
      output,
      async execute(args: unknown) {
        const input = args as { action: 'read' | 'propose'; content?: unknown; project_root?: string }
        const handle = await open(runtime, input.project_root)
        if (input.action === 'read') {
          return {
            book: await loadBookOutline(handle.project.store),
            chapters: await listChapterPlans(handle.project.store),
          }
        }
        const parsed = OutlinePlanSchema.safeParse(input.content)
        if (!parsed.success)
          return fail(
            new StudioError(STUDIO_ERROR_CODES.ARTIFACT_INVALID, 'OutlinePlan schema failed', undefined, {
              issues: parsed.error.issues,
            }),
          )
        const artifact = await handle.artifacts.submit({
          kind: 'OutlinePlan',
          chapter: null,
          content: parsed.data,
          provenance: {
            runId: 'proposal',
            taskId: `outline:${randomUUID()}`,
            role: 'architect',
            preset: 'novel-role-architect',
            model: 'human-tool',
          },
          status: 'draft',
        })
        handle.director.gates.open({
          projectId: handle.project.config.id,
          runId: 'proposal',
          gate: 'outline',
          artifactId: artifact.id,
        })
        return {
          ok: true,
          artifact: { id: artifact.id, version: artifact.version },
          next: 'host novel_approve gate=outline',
        }
      },
    }),

    makeTool({
      name: 'novel_run',
      description:
        'Start, pause, resume, cancel or advance a deterministic studio run. LLM does not choose the DAG.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['start', 'pause', 'resume', 'cancel', 'tick', 'status'],
        },
        kind: { type: 'string', enum: ['book', 'chapter', 'rewrite', 'review', 'market'] },
        chapter: { type: 'integer' },
        run_id: { type: 'string' },
        project_root: rootParameter,
      },
      output,
      async execute(args: unknown, exec: StudioToolExec) {
        const input = args as {
          action: 'start' | 'pause' | 'resume' | 'cancel' | 'tick' | 'status'
          kind?: RunKind
          chapter?: number
          run_id?: string
          project_root?: string
        }
        const handle = await open(runtime, input.project_root)
        try {
          if (input.action === 'status') {
            return { runs: listRuns(handle.db.orm, handle.project.config.id, 20) }
          }
          if (input.action === 'pause' || input.action === 'resume' || input.action === 'cancel') {
            if (input.run_id === undefined)
              throw new StudioError(STUDIO_ERROR_CODES.RUN_NOT_FOUND, 'run_id is required')
            if (input.action === 'pause') handle.director.pause(input.run_id)
            else if (input.action === 'resume') handle.director.resume(input.run_id)
            else {
              handle.scheduler.abort(input.run_id)
              handle.director.cancel(input.run_id)
            }
            return {
              ok: true,
              run: handle.director.board().runs.find((row) => row.id === input.run_id) ?? null,
            }
          }
          let runId = input.run_id
          if (input.action === 'start') {
            const kind = input.kind ?? 'chapter'
            const chapter = input.chapter ?? 1
            if (kind === 'book') runId = handle.director.createBookRun()
            else if (kind === 'market') runId = handle.director.createMarketRun()
            else
              runId = handle.director.createChapterRun({
                chapter,
                mode: kind === 'review' ? 'review' : kind === 'rewrite' ? 'rewrite' : 'full',
              })
          }
          if (runId === undefined) {
            const latest = listRuns(handle.db.orm, handle.project.config.id, 1)[0]
            if (latest === undefined) throw new StudioError(STUDIO_ERROR_CODES.RUN_NOT_FOUND, 'no run exists')
            runId = latest.id
          }
          await handle.scheduler.run(runId, asAgent(exec), exec.signal ?? new AbortController().signal)
          return {
            ok: true,
            run: handle.director.board().runs.find((row) => row.id === runId) ?? null,
            board: handle.director.board(),
          }
        } catch (error) {
          return fail(error)
        }
      },
    }),

    makeTool({
      name: 'novel_artifact',
      description: 'List, read or diff immutable artifacts. Versions are never overwritten.',
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'get', 'diff', 'restore'] },
        kind: {
          type: 'string',
          enum: [
            'BiblePlan',
            'WorldbookPatch',
            'OutlinePlan',
            'VolumePlan',
            'ChapterPlan',
            'Draft',
            'ReviewReport',
            'ContinuityReport',
            'PolishPatch',
            'StateDelta',
            'Decision',
            'MarketBrief',
            'Export',
          ],
        },
        chapter: { type: 'integer' },
        id: { type: 'string' },
        left: { type: 'string' },
        right: { type: 'string' },
        reason: { type: 'string' },
        limit: { type: 'integer' },
        project_root: rootParameter,
      },
      output,
      async execute(args: unknown) {
        const input = args as {
          action: 'list' | 'get' | 'diff' | 'restore'
          kind?: import('../../contracts/artifacts.js').ArtifactKind
          chapter?: number
          id?: string
          left?: string
          right?: string
          reason?: string
          limit?: number
          project_root?: string
        }
        const handle = await open(runtime, input.project_root)
        if (input.action === 'list') {
          return handle.artifacts.list({
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            ...(input.chapter === undefined ? {} : { chapter: input.chapter }),
            limit: input.limit ?? 100,
          })
        }
        if (input.action === 'get') {
          if (input.id === undefined)
            throw new StudioError(STUDIO_ERROR_CODES.ARTIFACT_NOT_FOUND, 'id is required')
          const artifact = await handle.artifacts.read(input.id)
          if (artifact === null)
            throw new StudioError(STUDIO_ERROR_CODES.ARTIFACT_NOT_FOUND, `no artifact ${input.id}`)
          return artifact
        }
        if (input.action === 'restore') {
          if (input.id === undefined)
            throw new StudioError(STUDIO_ERROR_CODES.ARTIFACT_NOT_FOUND, 'id is required')
          return { artifact: await handle.artifacts.restore(input.id, 'tool', input.reason ?? '') }
        }
        if (input.left === undefined || input.right === undefined)
          throw new StudioError(STUDIO_ERROR_CODES.ARTIFACT_NOT_FOUND, 'left and right are required')
        return { diff: await handle.artifacts.diffContent(input.left, input.right) }
      },
    }),

    makeTool({
      name: 'novel_state',
      description:
        'Query canon and ledgers: characters, locations, factions, items, concepts, relationships, timeline, foreshadows, resources, handoff.',
      parameters: {
        kind: {
          type: 'string',
          required: true,
          enum: [
            'canon',
            'characters',
            'locations',
            'factions',
            'items',
            'concepts',
            'relationships',
            'timeline',
            'foreshadows',
            'resources',
            'handoff',
          ],
        },
        project_root: rootParameter,
      },
      output,
      async execute(args: unknown) {
        const input = args as { kind: string; project_root?: string }
        const handle = await open(runtime, input.project_root)
        const canon = await import('../../kernel/book/store.js').then((module) =>
          module.loadCanon(handle.project.store),
        )
        if (input.kind === 'canon') return canon
        if (input.kind === 'handoff') return canon.handoff
        if (input.kind in canon.entities) return (canon.entities as Record<string, unknown>)[input.kind]
        return (canon as unknown as Record<string, unknown>)[input.kind]
      },
    }),

    makeTool({
      name: 'novel_search',
      description:
        'FTS5 memory search with explainable reasons (bm25, active cast, recency, protected source).',
      parameters: {
        query: { type: 'string', required: true },
        scope: { type: 'array', items: { type: 'string' } },
        chapter: { type: 'integer' },
        limit: { type: 'integer' },
        project_root: rootParameter,
      },
      output,
      async execute(args: unknown) {
        const input = args as {
          query: string
          scope?: string[]
          chapter?: number
          limit?: number
          project_root?: string
        }
        const handle = await open(runtime, input.project_root)
        return {
          hits: searchMemory(handle.db.orm, {
            projectId: handle.project.config.id,
            query: input.query,
            ...(input.scope === undefined ? {} : { scope: input.scope }),
            ...(input.chapter === undefined ? {} : { chapter: input.chapter }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          }),
        }
      },
    }),

    makeTool({
      name: 'novel_export',
      description: 'Render a publishable export after the ExportGate passes. Writes only inside exports/.',
      parameters: {
        kind: {
          type: 'string',
          required: true,
          enum: ['markdown', 'txt', 'epub', 'outline', 'worldbook', 'proposal', 'publish'],
        },
        chapter: { type: 'integer' },
        project_root: rootParameter,
      },
      output,
      async execute(args: unknown) {
        const input = args as { kind: ExportKind | 'publish'; chapter?: number; project_root?: string }
        const handle = await open(runtime, input.project_root)
        try {
          if (input.kind === 'publish') {
            const files = (await handle.project.store.list('manuscript')).filter((name) =>
              /^ch-\d{4}\.md$/u.test(name),
            )
            const chapters = files.map((name) => Number(name.slice(3, 7)))
            const { assertExportReady } = await import('../../kernel/export/index.js')
            await assertExportReady(handle.project, handle.db, handle.artifacts, chapters)
            const gate = handle.director.gates.open({
              projectId: handle.project.config.id,
              runId: 'publish',
              gate: 'publish',
            })
            return { ok: true, gateId: gate.id, next: 'host novel_approve gate=publish' }
          }
          return await exportProject(
            handle.project,
            handle.db,
            handle.artifacts,
            input.kind,
            input.chapter === undefined ? undefined : [input.chapter],
          )
        } catch (error) {
          return fail(error)
        }
      },
    }),

    makeTool({
      name: 'novel_agent',
      description:
        'List the 12 role agents/presets, inspect live assignments, message a live role child, or cancel its run.',
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'status', 'message', 'interrupt'] },
        role: { type: 'string' },
        message: { type: 'string' },
        run_id: { type: 'string' },
        project_root: rootParameter,
      },
      output,
      async execute(args: unknown, exec: StudioToolExec) {
        const input = args as {
          action: 'list' | 'status' | 'message' | 'interrupt'
          role?: string
          message?: string
          run_id?: string
          project_root?: string
        }
        const handle = await open(runtime, input.project_root)
        if (input.action === 'list') {
          return {
            roles: Object.values(ROLES).map((role) => ({
              id: role.id,
              label: role.label,
              preset: role.preset,
              canWrite: role.canWrite,
              canRead: role.canRead,
              canCommitCanon: role.canCommitCanon,
              canUseNetwork: role.canUseNetwork,
            })),
            taxonomyVersion: loadTaxonomy().taxonomyVersion,
          }
        }
        if (input.action === 'interrupt') {
          if (input.run_id === undefined)
            throw new StudioError(STUDIO_ERROR_CODES.RUN_NOT_FOUND, 'run_id is required')
          handle.scheduler.abort(input.run_id)
          handle.director.cancel(input.run_id)
          return { ok: true, runId: input.run_id }
        }
        const runs = listRuns(handle.db.orm, handle.project.config.id, 10)
        const tasks = runs.flatMap((run) => listTasks(handle.db.orm, run.id))
        const assignments = listAssignments(
          handle.db.orm,
          tasks.map((task) => task.id),
        )
        if (input.action === 'message') {
          if (input.run_id === undefined || input.role === undefined || input.message === undefined) {
            throw new StudioError(STUDIO_ERROR_CODES.AGENT_FAILED, 'run_id, role and message are required')
          }
          const taskIds = new Set(
            tasks
              .filter(
                (task) =>
                  task.runId === input.run_id &&
                  task.role === input.role &&
                  ['leased', 'running', 'validating'].includes(task.status),
              )
              .map((task) => task.id),
          )
          const assignment = assignments.find(
            (row) =>
              taskIds.has(row.taskId) &&
              row.agentSessionId !== null &&
              ['created', 'started'].includes(row.status),
          )
          if (assignment?.agentSessionId === undefined || assignment.agentSessionId === null) {
            throw new StudioError(
              STUDIO_ERROR_CODES.AGENT_FAILED,
              'no live assignment for that role in this run',
            )
          }
          await runtime.sendRoleMessage(
            asAgent(exec),
            assignment.agentSessionId,
            input.message,
            exec.signal ?? new AbortController().signal,
          )
          return { ok: true, targetId: assignment.agentSessionId }
        }
        return { assignments }
      },
    }),
  ]
}

export interface HostActionContext {
  runtime: StudioRuntime
}

/** Host-only definitions; never pass these to `ctx.tools.register`. */
export function createHostTools({ runtime }: HostActionContext): ToolDefinition[] {
  const actions = createHostActions({ runtime })
  return [
    makeTool({
      name: 'novel_approve',
      description: 'Host-only human gate decision. Requires a one-time approval token.',
      parameters: {
        gate_id: { type: 'string', required: true },
        decision: { type: 'string', required: true, enum: ['approve', 'reject', 'edit', 'regenerate'] },
        actor: { type: 'string', required: true },
        reason: { type: 'string' },
        editedContent: { type: 'string' },
        editedArtifact: { type: 'json' },
        token: { type: 'string' },
        project_root: rootParameter,
      },
      output,
      async execute(args: unknown) {
        const input = args as {
          gate_id: string
          decision: 'approve' | 'reject' | 'edit' | 'regenerate'
          actor: string
          reason?: string
          editedContent?: string
          editedArtifact?: unknown
          token?: string
          project_root?: string
        }
        try {
          return await actions.approve({
            project_root: input.project_root,
            gate_id: input.gate_id,
            decision: input.decision,
            actor: input.actor,
            reason: input.reason ?? '',
            ...(input.editedContent === undefined ? {} : { editedContent: input.editedContent }),
            ...(input.editedArtifact === undefined ? {} : { editedArtifact: input.editedArtifact }),
            ...(input.token === undefined ? {} : { token: input.token }),
          })
        } catch (error) {
          return fail(error)
        }
      },
    }),
    makeTool({
      name: 'novel_admin',
      description: 'Host-only doctor/repair/prune/import.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['doctor', 'repair', 'prune', 'import', 'rewind', 'snapshot'],
        },
        args: { type: 'json' },
        project_root: rootParameter,
      },
      output,
      async execute(args: unknown) {
        const input = args as {
          action: 'doctor' | 'repair' | 'prune' | 'import' | 'rewind' | 'snapshot'
          args?: Record<string, unknown>
          project_root?: string
        }
        try {
          return await actions.admin(input)
        } catch (error) {
          return fail(error)
        }
      },
    }),
  ]
}

export function createHostActions({ runtime }: HostActionContext) {
  return {
    async approve(input: {
      project_root?: string
      gate_id: string
      decision: 'approve' | 'reject' | 'edit' | 'regenerate'
      actor: string
      reason: string
      editedContent?: string
      editedArtifact?: unknown
      token?: string
    }): Promise<{ decisionArtifactId: string; nextRunId?: string }> {
      const handle = await runtime.open(input.project_root)
      const token = input.token ?? handle.director.gates.authorize(input.gate_id)
      return handle.director.decide({
        gateId: input.gate_id,
        token,
        decision: input.decision,
        actor: input.actor,
        reason: input.reason,
        ...(input.editedContent === undefined ? {} : { editedContent: input.editedContent }),
        ...(input.editedArtifact === undefined ? {} : { editedArtifact: input.editedArtifact }),
      })
    },
    async admin(input: {
      project_root?: string
      action: 'doctor' | 'repair' | 'prune' | 'import' | 'rewind' | 'snapshot'
      args?: Record<string, unknown>
    }): Promise<unknown> {
      if (input.action === 'rewind') {
        const handle = await runtime.open(input.project_root)
        const target = String(input.args?.target ?? '')
        if (!['artifact', 'chapter', 'run'].includes(target)) {
          throw new StudioError(STUDIO_ERROR_CODES.RUN_STATE_INVALID, 'target must be artifact/chapter/run')
        }
        return handle.director.rewind({
          target: target as 'artifact' | 'chapter' | 'run',
          ...(typeof input.args?.artifactId === 'string' ? { artifactId: input.args.artifactId } : {}),
          ...(input.args?.chapter === undefined ? {} : { chapter: Number(input.args.chapter) }),
          ...(typeof input.args?.runId === 'string' ? { runId: input.args.runId } : {}),
          actor: String(input.args?.actor ?? 'host'),
          reason: String(input.args?.reason ?? 'host rewind'),
        })
      }
      if (input.action === 'snapshot') {
        const handle = await runtime.open(input.project_root)
        const { createSnapshot } = await import('../../kernel/export/snapshot.js')
        return createSnapshot(handle.project)
      }
      if (input.action === 'import') {
        const from = String(input.args?.from ?? '')
        const to = String(input.args?.to ?? '')
        if (from === '' || to === '')
          throw new StudioError(STUDIO_ERROR_CODES.IMPORT_INVALID, 'import needs from and to')
        const { importLegacyProject } = await import('../../kernel/project/import.js')
        return await importLegacyProject(from, to)
      }
      const handle = await runtime.open(input.project_root)
      if (input.action === 'doctor') {
        const integrity = handle.db.integrity()
        const artifacts = listArtifacts(handle.db.orm, handle.project.config.id, { limit: 100_000 })
        const orphaned: string[] = []
        for (const row of artifacts) {
          try {
            const stored = await handle.artifacts.read(row.id)
            if (stored === null) orphaned.push(row.id)
          } catch {
            orphaned.push(row.id)
          }
        }
        const runs = listRuns(handle.db.orm, handle.project.config.id, 100)
        const tasks = runs.flatMap((run) => listTasks(handle.db.orm, run.id))
        const expired = tasks.filter(
          (task) => task.leaseUntil !== null && Date.parse(task.leaseUntil) < Date.now(),
        )
        return {
          ok: integrity === 'ok' && orphaned.length === 0,
          integrity,
          artifacts: artifacts.length,
          orphaned,
          expiredLeases: expired.map((task) => task.id),
          chapters: (await handle.project.store.list('manuscript')).filter((name) =>
            /^ch-\d{4}\.md$/u.test(name),
          ).length,
          database: resolve(handle.project.root, '.studio/studio.db'),
        }
      }
      if (input.action === 'repair') {
        const { rebuildProjectIndex } = await import('../../kernel/read/index.js')
        const result = await rebuildProjectIndex(handle.project, handle.db)
        handle.db.checkpoint()
        return { ok: true, repaired: ['fts5'], ...result }
      }
      if (input.action === 'prune') {
        const files = await handle.project.store.list('.studio/backups')
        const keep = Number(input.args?.keep ?? 10)
        const remove = files.sort().slice(0, Math.max(0, files.length - keep))
        for (const file of remove) await handle.project.store.remove(`.studio/backups/${file}`)
        return { ok: true, removed: remove }
      }
      throw new StudioError(STUDIO_ERROR_CODES.IMPORT_INVALID, 'unknown admin action')
    },
  }
}
