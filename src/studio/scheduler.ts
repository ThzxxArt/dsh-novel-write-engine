import type { Agent } from '@deepseek-ai/dsh-agent'
import type { StudioDb } from '../storage/db.js'
import type { LoadedProject } from '../kernel/project/layout.js'
import type { ArtifactStore } from '../kernel/artifacts/store.js'
import type { StudioDirector } from './director.js'
import type { AgentBridge, AgentStartResult } from './agent-bridge.js'
import { ROLES } from '../contracts/roles.js'
import type { RoleId } from '../contracts/artifacts.js'
import { loadBible, loadCanon, saveChapterPlan, applyWorldbookPatch } from '../kernel/book/store.js'
import { buildTaskPrompt } from './prompt.js'
import { taskContract, contractKindForRoleTask } from './task-contract.js'
import { BudgetGuard } from './budget.js'
import {
  appendEvent,
  claimTask,
  completeTask,
  createAssignment,
  getRun,
  heartbeatTask,
  listTasks,
  markTaskRunning,
  markTaskValidating,
  recordUsage,
  reclaimExpiredLeases,
  refreshReadyTasks,
  retryTask,
  settleTask,
  updateAssignment,
  updateRun,
  claimTaskById,
  type TaskRow,
} from '../storage/repositories/runs.js'
import { insertFindings } from '../storage/repositories/artifacts.js'
import { StudioError, STUDIO_ERROR_CODES } from '../contracts/errors.js'
import type { Draft, PolishPatch, ReviewReport } from '../contracts/artifacts.js'
import {
  applyPolishPatch,
  CRITIC_DIMENSIONS,
  dimensionMax,
  evaluateDraftFormat,
  keywordHit,
  quoteFrom,
  validatePolishPatch,
} from '../kernel/gates/index.js'
import { countWordMetrics } from '../domain/wordcount.js'
import { splitSentenceSpans } from '../domain/text.js'
import { applyTaxonomyProfile } from '../kernel/gates/index.js'
import { loadRulepack } from '../rulepack.js'
import { assertRoleCanWrite } from '../agents/role-tools.js'
import { appendTrace } from './trace.js'
import { assertTaskDag } from './dag.js'
import { buildContextPack } from '../kernel/read/context.js'

const SPECIAL = new Set(['review.merge', 'approve'])

const parseTask = (task: TaskRow): { chapter: number; round: number } => {
  try {
    const input = JSON.parse(task.inputJson) as { chapter?: number; round?: number }
    return { chapter: input.chapter ?? 1, round: input.round ?? 1 }
  } catch {
    // A corrupt input_json is data, not a programming fault. Default to
    // chapter 1 so the task can still produce a diagnosable artifact.
    return { chapter: 1, round: 1 }
  }
}

const roleOf = (task: TaskRow) => {
  const role = ROLES[task.role as RoleId]
  if (role === undefined)
    throw new StudioError(STUDIO_ERROR_CODES.TASK_STATE_INVALID, `unknown role ${task.role}`)
  return role
}

const assignmentStatus = (
  stopReason: string,
): 'completed' | 'failed' | 'aborted' | 'max_tokens' | 'refusal' => {
  if (stopReason === 'completed') return 'completed'
  if (stopReason === 'aborted') return 'aborted'
  if (stopReason === 'max-tokens') return 'max_tokens'
  if (stopReason === 'refusal') return 'refusal'
  return 'failed'
}

export class StudioScheduler {
  readonly project: LoadedProject
  readonly db: StudioDb
  readonly artifacts: ArtifactStore
  readonly director: StudioDirector
  readonly bridge: AgentBridge
  readonly owner: string
  readonly budget: BudgetGuard

  constructor(input: {
    project: LoadedProject
    db: StudioDb
    artifacts: ArtifactStore
    director: StudioDirector
    bridge: AgentBridge
    owner?: string
  }) {
    this.project = input.project
    this.db = input.db
    this.artifacts = input.artifacts
    this.director = input.director
    this.bridge = input.bridge
    this.owner = input.owner ?? 'studio-director'
    this.budget = new BudgetGuard(this.project, this.db.orm)
  }

  /** Live scheduler executions, so `run.cancel` can abort the in-flight LLM call. */
  private readonly active = new Map<string, AbortController>()

  /**
   * Cancel is a two-part operation: the run row becomes `cancelled`, and the
   * live signal must abort. Writing the row alone let a pending model call
   * finish and persist an artifact after the user had already cancelled.
   */
  abort(runId: string): boolean {
    const controller = this.active.get(runId)
    if (controller === undefined) return false
    controller.abort()
    return true
  }

  /** Advance one run until it needs a human, pauses, fails, or completes. */
  async run(runId: string, parent: Agent, signal: AbortSignal): Promise<void> {
    const controller = new AbortController()
    const relay = (): void => controller.abort()
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', relay, { once: true })
    this.active.set(runId, controller)
    try {
      await this.runInternal(runId, parent, controller.signal)
    } finally {
      signal.removeEventListener('abort', relay)
      if (this.active.get(runId) === controller) this.active.delete(runId)
    }
  }

  private async runInternal(runId: string, parent: Agent, signal: AbortSignal): Promise<void> {
    let run = getRun(this.db.orm, runId)
    if (run === undefined) throw new StudioError(STUDIO_ERROR_CODES.RUN_NOT_FOUND, `no run ${runId}`)
    if (run.status === 'queued') {
      updateRun(this.db.orm, runId, { status: 'running', startedAt: new Date().toISOString() })
      run = getRun(this.db.orm, runId)!
    }
    if (run.status !== 'running' && run.status !== 'awaiting_human') return
    reclaimExpiredLeases(this.db.orm, runId)
    try {
      assertTaskDag(
        listTasks(this.db.orm, runId).map((task) => ({
          id: task.id,
          dependsOn: JSON.parse(task.dependsOnJson) as string[],
        })),
      )
    } catch (error) {
      updateRun(this.db.orm, runId, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        endedAt: new Date().toISOString(),
      })
      throw error
    }
    for (let step = 0; step < 500; step += 1) {
      if (signal.aborted) {
        const aborted = getRun(this.db.orm, runId)
        if (aborted !== undefined && !['cancelled', 'completed', 'failed'].includes(aborted.status)) {
          this.director.cancel(runId)
        }
        return
      }
      const current = getRun(this.db.orm, runId)
      if (current === undefined) throw new StudioError(STUDIO_ERROR_CODES.RUN_NOT_FOUND, `no run ${runId}`)
      if (
        current.status === 'paused' ||
        current.status === 'cancelled' ||
        current.status === 'failed' ||
        current.status === 'completed'
      )
        return
      if (current.status === 'awaiting_human') return
      refreshReadyTasks(this.db.orm, runId)
      // The three critics + continuity precheck are independent. Fan them out
      // as one concurrent batch; the writer remains single-run.
      const fanout = listTasks(this.db.orm, runId).filter(
        (row) =>
          row.status === 'ready' && (row.kind.startsWith('review.') || row.kind === 'continuity.precheck'),
      )
      if (fanout.length > 1) {
        const claimed = fanout
          .map((row) => claimTaskById(this.db.orm, { id: row.id, owner: this.owner }))
          .filter((row): row is TaskRow => row !== undefined)
        await Promise.all(claimed.map((row) => this.execute(row, parent, signal)))
        continue
      }
      const task = claimTask(this.db.orm, { runId, owner: this.owner })
      if (task === undefined) {
        const remaining = listTasks(this.db.orm, runId).filter((row) =>
          ['pending', 'ready', 'leased', 'running', 'validating', 'retry_wait', 'awaiting_human'].includes(
            row.status,
          ),
        )
        if (remaining.length === 0) {
          updateRun(this.db.orm, runId, { status: 'completed', endedAt: new Date().toISOString() })
          appendEvent(this.db.orm, {
            projectId: this.project.config.id,
            runId,
            type: 'run.done',
            payload: {},
          })
          return
        }
        return
      }
      await this.execute(task, parent, signal)
    }
    updateRun(this.db.orm, runId, {
      status: 'failed',
      error: 'scheduler exceeded 500 steps',
      endedAt: new Date().toISOString(),
    })
    throw new StudioError(STUDIO_ERROR_CODES.RUN_STATE_INVALID, `run ${runId} exceeded 500 scheduler steps`)
  }

  private async execute(task: TaskRow, parent: Agent, signal: AbortSignal): Promise<void> {
    let started: AgentStartResult | undefined
    let assignmentId: string | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    try {
      if (SPECIAL.has(task.kind)) {
        await this.director.onTaskSettled(task)
        return
      }
      const budget = this.budget.checkRun(task.runId)
      if (!budget.ok) {
        settleTask(this.db.orm, task.id, 'retry_wait', budget.reason)
        updateRun(this.db.orm, task.runId, { status: 'paused', error: budget.reason })
        appendEvent(this.db.orm, {
          projectId: this.project.config.id,
          runId: task.runId,
          taskId: task.id,
          type: 'budget.exceeded',
          payload: { reason: budget.reason },
        })
        return
      }
      const role = roleOf(task)
      const { chapter } = parseTask(task)
      const contract = taskContract(task.kind)
      const model = this.project.config.models[role.id]
      markTaskRunning(this.db.orm, task.id)
      assignmentId = createAssignment(this.db.orm, {
        taskId: task.id,
        provider: this.bridge.name,
        preset: role.preset,
        ...(model === undefined ? {} : { model: model.model }),
      })
      updateAssignment(this.db.orm, assignmentId, { status: 'started' })
      appendEvent(this.db.orm, {
        projectId: this.project.config.id,
        runId: task.runId,
        taskId: task.id,
        type: 'assignment.start',
        payload: { role: role.id, preset: role.preset, model: model?.model ?? null },
      })
      heartbeat = setInterval(() => {
        try {
          heartbeatTask(this.db.orm, task.id, this.owner)
        } catch {
          // A later write will surface DB failures; heartbeat must not crash the run.
        }
      }, 30_000)
      heartbeat.unref?.()
      const planArtifact = await this.artifacts.latest('ChapterPlan', chapter)
      const draftArtifact = await this.artifacts.latest('Draft', chapter)
      const continuityArtifact = await this.artifacts.latest('ContinuityReport', chapter)
      const reviewArtifacts = this.artifacts
        .list({ kind: 'ReviewReport', chapter, limit: 9 })
        .map((row) => row.id)
      const reviews = (await Promise.all(reviewArtifacts.map((id) => this.artifacts.read(id)))).filter(
        (row): row is NonNullable<typeof row> => row !== null,
      )
      const bible = await loadBible(this.project.store)
      const canon = await loadCanon(this.project.store)
      const previousChapters: Array<{ chapter: number; title: string; text: string }> = []
      for (let offset = 1; offset <= 3 && chapter - offset >= 1; offset += 1) {
        const text = await this.project.store.readText(
          `manuscript/ch-${String(chapter - offset).padStart(4, '0')}.md`,
        )
        if (text !== null)
          previousChapters.push({ chapter: chapter - offset, title: `第 ${chapter - offset} 章`, text })
      }
      const contextPack = await buildContextPack(this.project, this.db, {
        chapter,
        stage:
          task.kind === 'plan'
            ? 'plan'
            : task.kind === 'draft' || task.kind === 'revise'
              ? 'draft'
              : task.kind.startsWith('review.')
                ? 'review'
                : task.kind.startsWith('continuity')
                  ? 'continuity'
                  : task.kind === 'polish'
                    ? 'polish'
                    : 'review',
        role: role.id,
        activeCast:
          planArtifact === null
            ? []
            : ((planArtifact.content as import('../contracts/artifacts.js').ChapterPlan).cast ?? []),
      })
      const built = buildTaskPrompt({
        project: this.project,
        task,
        bible,
        canon,
        contextPack,
        artifacts: {
          draft: draftArtifact,
          plan: planArtifact,
          reviews,
          continuity: continuityArtifact,
        },
        previousChapters,
      })
      await this.project.store.writeText(
        `runs/${task.runId}/context/${task.id}.json`,
        `${JSON.stringify(contextPack, null, 2)}\n`,
      )
      const result = await this.callWithRepair({
        task,
        role,
        parent,
        signal,
        prompt: built.prompt,
        promptHash: built.promptHash,
        schema: contract.schema,
        // Schema-valid is not gate-valid. Repair cheap problems (paragraph
        // length, role-owned dimensions, invented quotes) before a full round.
        validate: (structured) =>
          this.validateAgentOutput({
            taskKind: task.kind,
            chapter,
            artifactKind: contract.artifactKind,
            structured,
            planArtifact,
            draftArtifact,
          }),
        normalize: (structured) =>
          this.normalizeAgentOutput({
            artifactKind: contract.artifactKind,
            structured,
            draftArtifact,
          }),
      })
      started = result
      markTaskValidating(this.db.orm, task.id)
      const parsed = contract.schema.safeParse(result.structured)
      if (!parsed.success) {
        throw new StudioError(
          STUDIO_ERROR_CODES.AGENT_FAILED,
          `structured output for ${task.kind} does not match schema`,
          'the Director validated the output again rather than trusting the model',
          { issues: parsed.error.issues },
        )
      }
      const artifactKind = contractKindForRoleTask(role.id, task.kind)
      assertRoleCanWrite(role.id, artifactKind)
      if (
        draftArtifact !== null &&
        (artifactKind === 'ReviewReport' || artifactKind === 'ContinuityReport')
      ) {
        const declared = (parsed.data as { base_hash?: unknown }).base_hash
        if (declared !== draftArtifact.contentHash) {
          throw new StudioError(
            STUDIO_ERROR_CODES.ARTIFACT_INVALID,
            `${artifactKind} base_hash does not match the current draft`,
            'the reviewer must quote the exact hash from its prompt; stale reviews never reach the gate',
            { expected: draftArtifact.contentHash, received: declared },
          )
        }
      }
      if (artifactKind === 'Draft') {
        const draftBody = parsed.data as Draft
        const sameBytes =
          draftArtifact !== null &&
          this.artifacts.contentHash('Draft', draftBody) === draftArtifact.contentHash
        if (sameBytes) {
          // Idempotent resubmission of the current bytes is always legal.
        } else if (task.kind === 'revise') {
          if (draftArtifact === null) {
            throw new StudioError(
              STUDIO_ERROR_CODES.ARTIFACT_INVALID,
              'revise produced a draft without any draft to revise',
              'start a full chapter run before rewriting',
            )
          }
          if (
            draftBody.base_artifact_id !== draftArtifact.id ||
            draftBody.expected_hash !== draftArtifact.contentHash
          ) {
            throw new StudioError(
              STUDIO_ERROR_CODES.ARTIFACT_INVALID,
              'revised draft is not based on the current draft',
              'quote the exact base artifact id and expected hash from the prompt',
              {
                expectedId: draftArtifact.id,
                expectedHash: draftArtifact.contentHash,
                receivedId: draftBody.base_artifact_id,
                receivedHash: draftBody.expected_hash,
              },
            )
          }
        } else if (draftArtifact !== null) {
          if (
            draftBody.base_artifact_id !== draftArtifact.id ||
            draftBody.expected_hash !== draftArtifact.contentHash
          ) {
            throw new StudioError(
              STUDIO_ERROR_CODES.ARTIFACT_INVALID,
              'redraft is not based on the current draft',
              'quote the exact base artifact id and expected hash from the prompt',
              {
                expectedId: draftArtifact.id,
                expectedHash: draftArtifact.contentHash,
                receivedId: draftBody.base_artifact_id,
                receivedHash: draftBody.expected_hash,
              },
            )
          }
        }
      }
      if (draftArtifact !== null && artifactKind === 'PolishPatch') {
        const patch = parsed.data as PolishPatch
        if (
          patch.base_hash !== draftArtifact.contentHash ||
          patch.expected_hash !== draftArtifact.contentHash
        ) {
          throw new StudioError(
            STUDIO_ERROR_CODES.ARTIFACT_INVALID,
            'PolishPatch base_hash/expected_hash do not match the current draft',
            're-run the polisher against the latest draft',
            {
              expected: draftArtifact.contentHash,
              base: patch.base_hash,
              expectedHash: patch.expected_hash,
            },
          )
        }
      }
      const artifactContent =
        artifactKind === 'Draft' ? this.normalizeDraft(parsed.data as Draft) : parsed.data
      const stored = await this.artifacts.submit({
        kind: artifactKind,
        chapter:
          artifactKind === 'BiblePlan' || artifactKind === 'OutlinePlan' || artifactKind === 'MarketBrief'
            ? null
            : chapter,
        content: artifactContent,
        provenance: {
          runId: task.runId,
          taskId: task.id,
          role: role.id,
          preset: role.preset,
          agentSessionId: result.agentSessionId,
          model: model?.model ?? '',
          promptHash: built.promptHash,
        },
        baseArtifactId: draftArtifact?.id ?? null,
      })
      if (artifactKind === 'ChapterPlan') {
        await saveChapterPlan(
          this.project.store,
          parsed.data as import('../contracts/artifacts.js').ChapterPlan,
        )
      }
      if (artifactKind === 'WorldbookPatch') {
        await applyWorldbookPatch(
          this.project.store,
          parsed.data as import('../contracts/artifacts.js').WorldbookPatch,
        )
        const { rebuildProjectIndex } = await import('../kernel/read/index.js')
        await rebuildProjectIndex(this.project, this.db)
      }
      if (artifactKind === 'ReviewReport') {
        const report = parsed.data as ReviewReport
        insertFindings(
          this.db.orm,
          report.findings.map((finding) => ({
            artifactId: stored.id,
            role: report.role,
            dimension: finding.dimension,
            severity: finding.severity,
            location: finding.location,
            evidence: finding.evidence,
            problem: finding.problem,
            fix: finding.fix,
            status: finding.status,
          })),
        )
      }
      if (artifactKind === 'ContinuityReport') {
        const report = parsed.data as import('../contracts/artifacts.js').ContinuityReport
        insertFindings(
          this.db.orm,
          report.findings.map((finding) => ({
            artifactId: stored.id,
            role: 'continuity',
            dimension: finding.kind,
            severity: finding.severity,
            location: finding.location,
            evidence: finding.evidence,
            problem: finding.problem,
            fix: finding.fix,
            status: finding.status,
          })),
        )
      }
      if (artifactKind === 'PolishPatch') {
        const patch = parsed.data as PolishPatch
        const draft = draftArtifact === null ? null : (draftArtifact.content as Draft)
        if (draft !== null) {
          const problems = validatePolishPatch(draft, patch)
          if (problems.length > 0)
            throw new StudioError(STUDIO_ERROR_CODES.ARTIFACT_INVALID, problems.join('; '))
          const polished = applyPolishPatch(draft, patch)
          await this.artifacts.submit({
            kind: 'Draft',
            chapter,
            content: polished,
            provenance: {
              runId: task.runId,
              taskId: `${task.id}:polished`,
              role: 'polisher',
              preset: role.preset,
              agentSessionId: result.agentSessionId,
              model: model?.model ?? '',
              promptHash: built.promptHash,
            },
            baseArtifactId: draftArtifact?.id ?? null,
          })
        }
      }
      updateAssignment(this.db.orm, assignmentId, {
        status: assignmentStatus(result.stopReason),
        stopReason: result.stopReason,
        usage: result.usage,
        agentSessionId: result.agentSessionId,
        endedAt: new Date().toISOString(),
      })
      recordUsage(this.db.orm, {
        runId: task.runId,
        taskId: task.id,
        role: role.id,
        model: model?.model ?? 'unknown',
        promptTokens: result.usage.promptTokens ?? 0,
        completionTokens: result.usage.completionTokens ?? 0,
        costUsd: result.usage.costUsd ?? 0,
      })
      if (task.kind === 'archive' || task.kind === 'bible' || task.kind === 'outline') {
        await this.director.onTaskSettled({ ...task, outputArtifactId: stored.id })
      } else {
        completeTask(this.db.orm, task.id, stored.id)
        appendEvent(this.db.orm, {
          projectId: this.project.config.id,
          runId: task.runId,
          taskId: task.id,
          type: 'task.done',
          payload: { kind: task.kind, artifactId: stored.id, artifactKind },
        })
        await appendTrace(this.project, task.runId, `task:${task.kind}:done`, {
          taskId: task.id,
          artifactId: stored.id,
        })
      }
      refreshReadyTasks(this.db.orm, task.runId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (signal.aborted) {
        if (assignmentId !== undefined) {
          updateAssignment(this.db.orm, assignmentId, {
            status: 'aborted',
            stopReason: 'aborted',
            endedAt: new Date().toISOString(),
          })
        }
        try {
          this.director.cancel(task.runId)
        } catch {
          // Already cancelled by another path.
        }
        return
      }
      if (assignmentId !== undefined) {
        updateAssignment(this.db.orm, assignmentId, {
          status: 'failed',
          stopReason: 'error',
          endedAt: new Date().toISOString(),
        })
      }
      appendEvent(this.db.orm, {
        projectId: this.project.config.id,
        runId: task.runId,
        taskId: task.id,
        type: 'task.fail',
        payload: { kind: task.kind, error: message },
      })
      await appendTrace(this.project, task.runId, `task:${task.kind}:fail`, {
        taskId: task.id,
        error: message,
      })
      const current = listTasks(this.db.orm, task.runId).find((row) => row.id === task.id)
      if (current !== undefined && current.status !== 'cancelled' && current.attempt < current.maxAttempts) {
        settleTask(this.db.orm, task.id, 'retry_wait', message)
        retryTask(this.db.orm, task.id)
      } else if (current?.status !== 'cancelled') {
        settleTask(this.db.orm, task.id, 'failed', message)
        // Plan §8.5: exhausted retries leave the task failed but the run waits
        // for a human instead of disappearing as a terminal failure.
        updateRun(this.db.orm, task.runId, {
          status: 'awaiting_human',
          error: message,
        })
        appendEvent(this.db.orm, {
          projectId: this.project.config.id,
          runId: task.runId,
          taskId: task.id,
          type: 'run.awaiting_human',
          payload: { reason: 'task attempts exhausted', error: message },
        })
      }
      return
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      await started?.dispose().catch(() => undefined)
    }
  }

  /**
   * Mechanical typesetting fixes that never change the words: CJK corner
   * quotes become “”, and over-long paragraphs are split at sentence
   * boundaries. Models reliably miss the 90-word paragraph rule; bouncing the
   * whole task is worse than applying the same rule the gate enforces.
   */
  private normalizeProse(content: string, maxWords: number): string {
    // Models often emit ASCII straight quotes even when told not to. Pair them
    // into Chinese quotes; ILLEGAL_QUOTE is an ASCII-only rule after 0.2.13.
    let open = true
    const paired = content.replace(/"/gu, () => {
      const quote = open ? '“' : '”'
      open = !open
      return quote
    })
    const cleaned = paired.replace(/「/gu, '“').replace(/」/gu, '”').replace(/『/gu, '“').replace(/』/gu, '”')
    const paragraphs = cleaned
      .split(/\n{2,}/u)
      .map((row) => row.trim())
      .filter((row) => row !== '')
    const out: string[] = []
    for (const paragraph of paragraphs) {
      const sentences = paragraph.match(/[^。！？!?…]+[。！？!?…]*/gu) ?? [paragraph]
      let current = ''
      for (const sentence of sentences) {
        const next = `${current}${sentence}`
        if (current !== '' && countWordMetrics(next).total_word_count > maxWords) {
          out.push(current)
          current = sentence
        } else {
          current = next
        }
      }
      if (current !== '') out.push(current)
    }
    return out.join('\n\n')
  }

  private normalizeDraft(draft: Draft): Draft {
    const pack = applyTaxonomyProfile(this.project, loadRulepack())
    const content = this.normalizeProse(draft.content, pack.format.paragraph_max_words)
    if (content === draft.content) return draft
    const metrics = countWordMetrics(content)
    return {
      ...draft,
      content,
      self_check: {
        ...draft.self_check,
        word_count: metrics.total_word_count,
        cjk_chars: metrics.cjk_chars,
      },
    }
  }

  /**
   * Deterministic checks the gate would run later in the round. Returning a
   * message triggers the same bounded repair call the schema uses.
   */
  private validateAgentOutput(input: {
    taskKind: string
    chapter: number
    artifactKind: import('../contracts/artifacts.js').ArtifactKind
    structured: unknown
    planArtifact: { content: unknown } | null
    draftArtifact: { id: string; contentHash: string; content: unknown } | null
  }): string | null {
    const problems: string[] = []
    const plan = input.planArtifact?.content as import('../contracts/artifacts.js').ChapterPlan | undefined
    const draft = input.draftArtifact?.content as Draft | undefined
    if (input.artifactKind === 'ChapterPlan') {
      const body = input.structured as import('../contracts/artifacts.js').ChapterPlan
      const suffix = body.title.replace(/^第\d+章\s*/u, '')
      const titleLength = Array.from(suffix).length
      if (titleLength < 4 || titleLength > 8) {
        problems.push(`chapter-card title body must be 4..8 characters, got ${titleLength}`)
      }
    }
    if (input.artifactKind === 'Draft') {
      const body = input.structured as Draft
      const pack = applyTaxonomyProfile(this.project, loadRulepack())
      const normalized = this.normalizeProse(body.content, pack.format.paragraph_max_words)
      problems.push(
        ...evaluateDraftFormat(this.project, input.chapter, body.title, normalized).map(
          (finding) => finding.message,
        ),
      )
      if (plan !== undefined) {
        if (body.title !== plan.title)
          problems.push(`Draft title must equal the chapter card title "${plan.title}"`)
        // Cast entries often carry annotations such as 陈伯（提及）; the prose
        // only has to name the character, not the parenthetical.
        const GENERIC_CAST = /^(主角|女主|男主|配角|反派|路人|群演|众人|角色|提及)$/u
        const castNames = plan.cast
          .filter((name) => !/提及/u.test(name))
          .map((name) => name.replace(/[（(].*?[）)]/gu, '').trim())
          .filter((name) => name !== '' && !GENERIC_CAST.test(name))
        const appears = (name: string): boolean => {
          if (normalized.includes(name)) return true
          // "铺主老周" in the card / "老周" in the prose is the same character.
          const tail = Array.from(name).slice(-2).join('')
          return tail.length === 2 && normalized.includes(tail)
        }
        const missingCast = castNames.filter((name) => !appears(name))
        if (missingCast.length > 0)
          problems.push(`chapter-card cast missing from prose: ${missingCast.join('、')}`)
        if (!keywordHit(normalized, plan.hook))
          problems.push(`chapter-card hook has no landing in the prose: ${plan.hook}`)
      }
      const metrics = countWordMetrics(normalized)
      const [minWords] = this.project.config.targets.words_per_chapter
      if (
        metrics.total_word_count < minWords ||
        metrics.cjk_chars < this.project.config.targets.min_cjk_chars
      ) {
        problems.push(
          `word count ${metrics.total_word_count}/${minWords}, CJK ${metrics.cjk_chars}/${this.project.config.targets.min_cjk_chars}`,
        )
      }
    }
    if (input.artifactKind === 'ReviewReport' && draft !== undefined && input.draftArtifact !== null) {
      const report = input.structured as ReviewReport
      const allowed = CRITIC_DIMENSIONS[report.role]
      const missing = allowed.filter((id) => !report.dimensions.some((row) => row.id === id))
      const extra = report.dimensions.filter((row) => !allowed.includes(row.id))
      if (missing.length > 0) problems.push(`${report.role} missing dimensions: ${missing.join(', ')}`)
      if (extra.length > 0)
        problems.push(`${report.role} cannot score: ${extra.map((row) => row.id).join(', ')}`)
      const wrongMax = report.dimensions.filter((row) => row.max !== dimensionMax(row.id))
      if (wrongMax.length > 0)
        problems.push(
          `dimension max mismatch: ${wrongMax.map((row) => `${row.id} must be ${dimensionMax(row.id)}`).join(', ')}`,
        )
      const full = allowed.reduce((total, id) => total + dimensionMax(id), 0)
      const deducted = report.dimensions.reduce(
        (total, row) => total + row.deductions.reduce((sum, item) => sum + item.delta, 0),
        0,
      )
      if (report.total !== full - deducted)
        problems.push(`total must be ${full} - ${deducted} = ${full - deducted}, got ${report.total}`)
      const proseDeductions = report.dimensions.find((row) => row.id === 'R-W-07')
      if (
        proseDeductions !== undefined &&
        proseDeductions.deductions.some((row) => !row.rule.startsWith('AI_TONE_'))
      ) {
        problems.push('R-W-07 deductions must cite AI_TONE_* rule codes')
      }
      for (const finding of report.findings) {
        if (!quoteFrom(draft, finding.evidence))
          problems.push(`finding ${finding.id} evidence is not a verbatim draft quote`)
      }
      for (const [slot, citation] of Object.entries(report.proof)) {
        if (!quoteFrom(draft, citation.quote))
          problems.push(`proof.${slot}.quote is not a verbatim draft quote`)
        if (citation.sourceHash !== input.draftArtifact.contentHash)
          problems.push(`proof.${slot}.sourceHash must equal base_hash`)
      }
    }
    if (input.artifactKind === 'ContinuityReport' && draft !== undefined && input.draftArtifact !== null) {
      const report = input.structured as import('../contracts/artifacts.js').ContinuityReport
      for (const finding of report.findings) {
        if (!quoteFrom(draft, finding.evidence))
          problems.push(`continuity finding ${finding.id} evidence is not a verbatim draft quote`)
      }
    }
    if (input.artifactKind === 'PolishPatch' && draft !== undefined) {
      const patch = input.structured as import('../contracts/artifacts.js').PolishPatch
      problems.push(...validatePolishPatch(draft, patch))
      if (problems.length === 0) {
        try {
          const applied = applyPolishPatch(draft, patch)
          problems.push(
            ...evaluateDraftFormat(this.project, input.chapter, draft.title, applied.content).map(
              (finding) => finding.message,
            ),
          )
        } catch (error) {
          problems.push(error instanceof Error ? error.message : String(error))
        }
      }
    }
    return problems.length === 0 ? null : problems.join('; ')
  }

  /**
   * Expand a short but real quote to its containing sentence. Models often
   * cite “好。” for a finding; the sentence is valid evidence, and expanding it
   * is deterministic rather than another paid repair.
   */
  private normalizeAgentOutput(input: {
    artifactKind: import('../contracts/artifacts.js').ArtifactKind
    structured: unknown
    draftArtifact: { content: unknown } | null
  }): unknown {
    if (
      (input.artifactKind !== 'ReviewReport' && input.artifactKind !== 'ContinuityReport') ||
      input.draftArtifact === null
    ) {
      return input.structured
    }
    const draft = input.draftArtifact.content as Draft
    const sentences = splitSentenceSpans(draft.content)
      .map((span) => span.text.trim())
      .filter((text) => text !== '')
    const expand = (value: unknown): unknown => {
      if (typeof value !== 'string' || value.trim() === '') return value
      if (Array.from(value).length >= 8 && quoteFrom(draft, value)) return value
      const hit = sentences.find((sentence) => sentence.includes(value))
      return hit === undefined ? value : Array.from(hit).slice(0, 40).join('')
    }
    const data = structuredClone(input.structured) as {
      findings?: Array<{ evidence?: unknown; severity?: string }>
      proof?: Record<string, { quote?: unknown }>
    }
    data.findings = (data.findings ?? []).filter((finding) => {
      finding.evidence = expand(finding.evidence)
      if (
        typeof finding.evidence === 'string' &&
        Array.from(finding.evidence).length >= 8 &&
        quoteFrom(draft, finding.evidence)
      ) {
        return true
      }
      // An advisory with invented evidence is noise, not a gate blocker.
      // Blockers stay so the repair prompt can demand a real quote.
      return finding.severity === 'blocker'
    })
    for (const citation of Object.values(data.proof ?? {})) {
      if (citation !== null && typeof citation === 'object') citation.quote = expand(citation.quote)
    }
    return data
  }

  private async callWithRepair(input: {
    task: TaskRow
    role: ReturnType<typeof roleOf>
    parent: Agent
    signal: AbortSignal
    prompt: string
    promptHash: string
    schema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: unknown } } }
    validate?: (structured: unknown) => string | null
    normalize?: (structured: unknown) => unknown
  }): Promise<AgentStartResult> {
    if (!this.bridge.available()) {
      throw new StudioError(
        STUDIO_ERROR_CODES.AGENT_PROVIDER_UNSUPPORTED,
        'no agent bridge is available',
        'mount the DSH spawn provider and the 12 role presets',
      )
    }
    const model = this.project.config.models[input.role.id]
    const outputSchema = await schemaToObjectJson(input.task.kind)
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt =
        attempt === 0
          ? input.prompt
          : `${input.prompt}\n\n上一次输出未通过 schema/门控预检：${
              typeof lastError === 'string' ? lastError : JSON.stringify(lastError)
            }。请只返回修复后的完整结构化对象。`
      try {
        const result = await this.bridge.start({
          role: input.role,
          task: input.task,
          prompt,
          outputSchema,
          parent: input.parent,
          cwd: this.project.root,
          ...(model === undefined ? {} : { model }),
          signal: input.signal,
        })
        const normalized = input.normalize?.(result.structured) ?? result.structured
        const parsed = input.schema.safeParse(normalized)
        if (parsed.success) {
          const problem = input.validate?.(normalized) ?? null
          if (problem === null) return { ...result, structured: normalized }
          lastError = problem
          await result.dispose().catch(() => undefined)
        } else {
          lastError = parsed.error
          await result.dispose().catch(() => undefined)
        }
      } catch (error) {
        if (input.signal.aborted) throw error
        lastError = error
        if (attempt === 1) throw error
      }
    }
    throw new StudioError(
      STUDIO_ERROR_CODES.AGENT_FAILED,
      `structured output failed after one repair: ${String(lastError)}`,
    )
  }
}

const schemaToObjectJson = async (taskKind: string): Promise<Record<string, unknown>> => {
  const { z } = await import('zod')
  const { sanitizeOutputSchema } = await import('./agent-bridge.js')
  const contract = taskContract(taskKind)
  return sanitizeOutputSchema(
    z.toJSONSchema(contract.schema, { target: 'draft-7', io: 'output', reused: 'inline' }),
  )
}
