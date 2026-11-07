import type { StudioDb } from '../storage/db.js'
import type { LoadedProject } from '../kernel/project/layout.js'
import { ArtifactStore, type StoredArtifact } from '../kernel/artifacts/store.js'
import { assertReceiptBindsDraft, latestHumanApproval } from '../kernel/artifacts/receipts.js'
import {
  applyStateDelta,
  loadBible,
  loadCanon,
  saveBiblePlan,
  saveCanon,
  saveOutlinePlan,
} from '../kernel/book/store.js'
import { evaluateArchiveTone, evaluateGates, type GateReport } from '../kernel/gates/index.js'
import {
  appendEvent,
  cancelRun,
  completeTask,
  createRun,
  createTasks,
  getRun,
  listAssignments,
  listHumanGates,
  listRuns,
  listTasks,
  markTaskValidating,
  maxEventSeq,
  refreshReadyTasks,
  settleTask,
  updateRun,
  usageForRun,
  type TaskRow,
} from '../storage/repositories/runs.js'
import {
  insertFindings,
  insertGateResult,
  latestArtifact,
  latestGateResults,
  listFindings,
  listGateResults,
  setArtifactStatus,
} from '../storage/repositories/artifacts.js'
import { upsertMemoryChunk } from '../storage/repositories/memory.js'
import { sha256Hex } from '../domain/hash.js'
import { countWordMetrics } from '../domain/wordcount.js'
import {
  ARTIFACT_SCHEMAS,
  DecisionSchema,
  ExportSchema,
  type BiblePlan,
  type ContinuityReport,
  type Decision,
  type Draft,
  type OutlinePlan,
  type PolishPatch,
  type ReviewReport,
  type StateDelta,
} from '../contracts/artifacts.js'
import { StudioError, STUDIO_ERROR_CODES } from '../contracts/errors.js'
import type { ChapterStage, HumanGate } from '../contracts/stages.js'
import { HumanGateService } from './human-gate.js'
import { assertRunEvent } from './state-machines.js'
import { appendTrace } from './trace.js'
import { publishPackage } from '../kernel/export/publish.js'
import type { StatusDto } from '../contracts/dto.js'
import { genrePath } from '../domain/taxonomy.js'

const taskChapter = (task: TaskRow): number => {
  const parsed = JSON.parse(task.inputJson) as { chapter?: number }
  return parsed.chapter ?? 1
}

const taskRound = (task: TaskRow): number => {
  const parsed = JSON.parse(task.inputJson) as { round?: number }
  return parsed.round ?? 1
}

const asDraft = (artifact: StoredArtifact | null): Draft => {
  if (artifact === null)
    throw new StudioError(STUDIO_ERROR_CODES.ARTIFACT_NOT_FOUND, 'latest Draft is missing')
  return artifact.content as Draft
}

export interface ChapterRunOptions {
  chapter: number
  mode?: 'full' | 'review' | 'rewrite'
}

/** Deterministic DAG owner. Agents execute tasks; this class decides order. */
export class StudioDirector {
  readonly project: LoadedProject
  readonly db: StudioDb
  readonly artifacts: ArtifactStore
  readonly gates: HumanGateService

  constructor(project: LoadedProject, db: StudioDb, artifacts = new ArtifactStore(project, db)) {
    this.project = project
    this.db = db
    this.artifacts = artifacts
    this.gates = new HumanGateService(db.orm)
  }

  private activeChapterRun(chapter: number): ReturnType<typeof listRuns>[number] | undefined {
    return listRuns(this.db.orm, this.project.config.id, 100).find(
      (row) =>
        (row.kind === 'chapter' || row.kind === 'rewrite') &&
        row.targetChapter === chapter &&
        ['queued', 'running', 'awaiting_human', 'paused'].includes(row.status),
    )
  }

  private activeWriterRun(): ReturnType<typeof listRuns>[number] | undefined {
    return listRuns(this.db.orm, this.project.config.id, 100).find(
      (row) =>
        (row.kind === 'chapter' || row.kind === 'rewrite') &&
        ['queued', 'running', 'awaiting_human', 'paused'].includes(row.status),
    )
  }

  private activeBookRun(): ReturnType<typeof listRuns>[number] | undefined {
    return listRuns(this.db.orm, this.project.config.id, 100).find(
      (row) => row.kind === 'book' && ['queued', 'running', 'awaiting_human', 'paused'].includes(row.status),
    )
  }

  createChapterRun(options: ChapterRunOptions): string {
    if (this.activeChapterRun(options.chapter) !== undefined) {
      throw new StudioError(
        STUDIO_ERROR_CODES.RUN_STATE_INVALID,
        `chapter ${options.chapter} already has an active run`,
        'pause/cancel it or wait for it to settle; one writer per chapter',
      )
    }
    const writer = this.activeWriterRun()
    if (writer !== undefined) {
      throw new StudioError(
        STUDIO_ERROR_CODES.RUN_STATE_INVALID,
        `another writer run is active for this project (${writer.id})`,
        'one writer per project; pause/cancel it before starting a different chapter',
        { runId: writer.id, chapter: writer.targetChapter },
      )
    }
    const book = options.mode === 'review' ? undefined : this.activeBookRun()
    if (book !== undefined) {
      throw new StudioError(
        STUDIO_ERROR_CODES.RUN_STATE_INVALID,
        `a book run is active for this project (${book.id})`,
        'finish or cancel the bible/outline run before writing prose',
        { runId: book.id },
      )
    }
    if (options.mode === 'rewrite') {
      const draft = latestArtifact(this.db.orm, this.project.config.id, 'Draft', options.chapter)
      if (draft === undefined) {
        throw new StudioError(
          STUDIO_ERROR_CODES.RUN_STATE_INVALID,
          `chapter ${options.chapter} has no draft to rewrite`,
          'start a full chapter run first, or import an existing manuscript',
        )
      }
    } else if (options.mode !== 'review') {
      const draft = latestArtifact(this.db.orm, this.project.config.id, 'Draft', options.chapter)
      if (draft?.status === 'approved') {
        throw new StudioError(
          STUDIO_ERROR_CODES.RUN_STATE_INVALID,
          `chapter ${options.chapter} is already archived`,
          'use /novel run rewrite or the Review Center revision action instead of a fresh full run',
        )
      }
    }
    const runId = createRun(this.db.orm, {
      projectId: this.project.config.id,
      kind: options.mode === 'review' ? 'review' : options.mode === 'rewrite' ? 'rewrite' : 'chapter',
      targetChapter: options.chapter,
      input: { chapter: options.chapter, mode: options.mode ?? 'full' },
    })
    const task = (
      role: import('../contracts/artifacts.js').RoleId,
      kind: string,
      dependsOn: string[],
      input: Record<string, unknown>,
      priority: number,
    ) => createTasks(this.db.orm, [{ runId, role, kind, dependsOn, input, priority }])[0]!
    if (options.mode === 'review') {
      const story = task('critic-story', 'review.story', [], { chapter: options.chapter, round: 1 }, 1)
      const character = task(
        'critic-character',
        'review.character',
        [],
        { chapter: options.chapter, round: 1 },
        1,
      )
      const prose = task('critic-prose', 'review.prose', [], { chapter: options.chapter, round: 1 }, 1)
      const continuity = task(
        'continuity',
        'continuity.precheck',
        [],
        { chapter: options.chapter, round: 1 },
        1,
      )
      task(
        'showrunner',
        'review.merge',
        [story, character, prose, continuity],
        { chapter: options.chapter, round: 1 },
        0,
      )
    } else if (options.mode === 'rewrite') {
      const revise = task('drafter', 'revise', [], { chapter: options.chapter, round: 1, blockers: [] }, 6)
      const story = task('critic-story', 'review.story', [revise], { chapter: options.chapter, round: 1 }, 5)
      const character = task(
        'critic-character',
        'review.character',
        [revise],
        { chapter: options.chapter, round: 1 },
        5,
      )
      const prose = task('critic-prose', 'review.prose', [revise], { chapter: options.chapter, round: 1 }, 5)
      const continuity = task(
        'continuity',
        'continuity.precheck',
        [revise],
        { chapter: options.chapter, round: 1 },
        5,
      )
      task(
        'showrunner',
        'review.merge',
        [story, character, prose, continuity],
        { chapter: options.chapter, round: 1 },
        4,
      )
    } else {
      const plan = task('planner', 'plan', [], { chapter: options.chapter, round: 1 }, 10)
      const draft = task('drafter', 'draft', [plan], { chapter: options.chapter, round: 1 }, 9)
      const story = task('critic-story', 'review.story', [draft], { chapter: options.chapter, round: 1 }, 8)
      const character = task(
        'critic-character',
        'review.character',
        [draft],
        { chapter: options.chapter, round: 1 },
        8,
      )
      const prose = task('critic-prose', 'review.prose', [draft], { chapter: options.chapter, round: 1 }, 8)
      const continuity = task(
        'continuity',
        'continuity.precheck',
        [draft],
        { chapter: options.chapter, round: 1 },
        8,
      )
      task(
        'showrunner',
        'review.merge',
        [story, character, prose, continuity],
        { chapter: options.chapter, round: 1 },
        7,
      )
    }
    updateRun(this.db.orm, runId, { status: 'queued' })
    appendEvent(this.db.orm, {
      projectId: this.project.config.id,
      runId,
      type: 'run.start',
      payload: {
        kind: options.mode === 'review' ? 'review' : options.mode === 'rewrite' ? 'rewrite' : 'chapter',
        chapter: options.chapter,
      },
    })
    void appendTrace(this.project, runId, 'run:start', { chapter: options.chapter })
    return runId
  }

  createMarketRun(): string {
    const runId = createRun(this.db.orm, {
      projectId: this.project.config.id,
      kind: 'market',
      input: { platform: this.project.config.platform },
    })
    createTasks(this.db.orm, [
      {
        runId,
        role: 'radar',
        kind: 'market',
        dependsOn: [],
        input: { platform: this.project.config.platform, chapter: 0 },
        priority: 1,
      },
    ])
    appendEvent(this.db.orm, {
      projectId: this.project.config.id,
      runId,
      type: 'run.start',
      payload: { kind: 'market' },
    })
    return runId
  }

  createBookRun(): string {
    const active = this.activeBookRun() ?? this.activeWriterRun()
    if (active !== undefined) {
      throw new StudioError(
        STUDIO_ERROR_CODES.RUN_STATE_INVALID,
        `another structured run is active for this project (${active.id})`,
        'bible/outline and prose runs cannot mutate the same project concurrently',
        { runId: active.id, kind: active.kind },
      )
    }
    const runId = createRun(this.db.orm, {
      projectId: this.project.config.id,
      kind: 'book',
      input: {},
    })
    const bible = createTasks(this.db.orm, [
      { runId, role: 'architect', kind: 'bible', dependsOn: [], input: {}, priority: 2 },
    ])[0]!
    const outline = createTasks(this.db.orm, [
      { runId, role: 'architect', kind: 'outline', dependsOn: [bible], input: {}, priority: 1 },
    ])[0]!
    createTasks(this.db.orm, [
      { runId, role: 'worldsmith', kind: 'worldbook', dependsOn: [outline], input: {}, priority: 0 },
    ])
    appendEvent(this.db.orm, {
      projectId: this.project.config.id,
      runId,
      type: 'run.start',
      payload: { kind: 'book' },
    })
    return runId
  }

  async onTaskSettled(task: TaskRow): Promise<void> {
    if (task.kind === 'review.merge') await this.onMerge(task)
    else if (task.kind === 'approve') await this.onApproveRequest(task)
    else if (task.kind === 'archive') await this.onArchive(task)
    else if (task.kind === 'bible') await this.onBookGate(task, 'bible')
    else if (task.kind === 'outline') await this.onBookGate(task, 'outline')
  }

  private async onBookGate(task: TaskRow, gate: 'bible' | 'outline'): Promise<void> {
    const kind = gate === 'bible' ? 'BiblePlan' : 'OutlinePlan'
    const artifact = await this.artifacts.latest(kind, null)
    if (artifact === null) {
      settleTask(this.db.orm, task.id, 'failed', `${kind} artifact missing`)
      return
    }
    const pending = listHumanGates(this.db.orm, this.project.config.id).find((row) => row.taskId === task.id)
    if (pending !== undefined) return
    this.gates.open({
      projectId: this.project.config.id,
      runId: task.runId,
      taskId: task.id,
      gate,
      artifactId: artifact.id,
    })
    this.db.raw
      .prepare('UPDATE task SET status = ?, updated_at = ? WHERE id = ?')
      .run('awaiting_human', new Date().toISOString(), task.id)
    updateRun(this.db.orm, task.runId, { status: 'awaiting_human' })
    appendEvent(this.db.orm, {
      projectId: this.project.config.id,
      runId: task.runId,
      taskId: task.id,
      type: 'human_gate.awaiting',
      payload: { gate, artifactId: artifact.id },
    })
  }

  private async latestReviews(
    chapter: number,
  ): Promise<Array<{ artifact: StoredArtifact; report: ReviewReport }>> {
    const rows = this.artifacts.list({ kind: 'ReviewReport', chapter, limit: 100 })
    const best = new Map<ReviewReport['role'], { artifact: StoredArtifact; report: ReviewReport }>()
    for (const row of rows) {
      const stored = await this.artifacts.read(row.id)
      if (stored === null) continue
      const report = stored.content as ReviewReport
      if (best.has(report.role)) continue
      const findingRows = listFindings(this.db.orm, stored.id)
      if (findingRows.length > 0) {
        const statuses = new Map(
          findingRows.map((finding) => [
            `${finding.role}\u0000${finding.location}\u0000${finding.dimension}\u0000${finding.problem}`,
            { status: finding.status, resolution: finding.resolution },
          ]),
        )
        report.findings = report.findings.map((finding) => {
          const row = statuses.get(
            `${report.role}\u0000${finding.location}\u0000${finding.dimension}\u0000${finding.problem}`,
          )
          return row === undefined
            ? finding
            : {
                ...finding,
                status: row.status as typeof finding.status,
                resolution: row.resolution,
              }
        })
      }
      best.set(report.role, { artifact: stored, report })
    }
    return [...best.values()].sort((left, right) => left.report.role.localeCompare(right.report.role))
  }

  private async latestContinuity(
    chapter: number,
  ): Promise<{ artifact: StoredArtifact | null; report: ContinuityReport | null }> {
    const artifact = await this.artifacts.latest('ContinuityReport', chapter)
    if (artifact === null) return { artifact: null, report: null }
    const report = artifact.content as ContinuityReport
    const rows = listFindings(this.db.orm, artifact.id)
    if (rows.length > 0) {
      const statuses = new Map(
        rows.map((finding) => [
          `${finding.dimension}\u0000${finding.location}\u0000${finding.problem}`,
          { status: finding.status, resolution: finding.resolution },
        ]),
      )
      report.findings = report.findings.map((finding) => {
        const row = statuses.get(`${finding.kind}\u0000${finding.location}\u0000${finding.problem}`)
        return row === undefined
          ? finding
          : { ...finding, status: row.status as typeof finding.status, resolution: row.resolution }
      })
    }
    return { artifact, report }
  }

  private async onMerge(task: TaskRow): Promise<void> {
    const chapter = taskChapter(task)
    const round = taskRound(task)
    const planArtifact = await this.artifacts.latest('ChapterPlan', chapter)
    const draftArtifact = await this.artifacts.latest('Draft', chapter)
    const continuityState = await this.latestContinuity(chapter)
    const plan = planArtifact?.content as import('../contracts/artifacts.js').ChapterPlan | undefined
    if (plan === undefined || draftArtifact === null) {
      settleTask(this.db.orm, task.id, 'failed', 'plan or draft artifact missing')
      updateRun(this.db.orm, task.runId, {
        status: 'failed',
        error: 'plan or draft artifact missing',
        endedAt: new Date().toISOString(),
      })
      return
    }
    const draft = asDraft(draftArtifact)
    const reviewRows = await this.latestReviews(chapter)
    const reviews = reviewRows.map((row) => row.report)
    const continuity = continuityState.report
    const canon = await loadCanon(this.project.store)
    const bible = await loadBible(this.project.store)
    const previousTexts: Array<{ chapter: number; text: string }> = []
    for (let offset = 1; offset <= 10 && chapter - offset >= 1; offset += 1) {
      const text = await this.project.store.readText(
        `manuscript/ch-${String(chapter - offset).padStart(4, '0')}.md`,
      )
      if (text !== null) previousTexts.push({ chapter: chapter - offset, text })
    }
    const report = evaluateGates({
      project: this.project,
      chapter,
      plan,
      draft,
      draftHash: draftArtifact.contentHash,
      reviews,
      continuity,
      canon,
      bible,
      previousTexts,
      round,
      maxRounds: this.project.config.quality.review_rounds,
    })
    for (const finding of report.findings) {
      insertGateResult(this.db.orm, {
        artifactId: draftArtifact.id,
        gate: finding.code,
        verdict: finding.verdict,
        details: { name: finding.name, message: finding.message, ...(finding.details ?? {}) },
      })
    }
    for (const row of reviewRows) {
      if (listFindings(this.db.orm, row.artifact.id).length > 0) continue
      insertFindings(
        this.db.orm,
        row.report.findings.map((finding) => ({
          artifactId: row.artifact.id,
          role: row.report.role,
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
    appendEvent(this.db.orm, {
      projectId: this.project.config.id,
      runId: task.runId,
      taskId: task.id,
      type: report.pass ? 'gate.pass' : 'gate.fail',
      payload: { chapter, round, score: report.score, blockers: report.blockers.map((row) => row.code) },
    })
    void appendTrace(this.project, task.runId, report.pass ? 'gate:pass' : 'gate:fail', {
      chapter,
      round,
      score: report.score,
      blockers: report.blockers.map((row) => row.code),
    })
    markTaskValidating(this.db.orm, task.id)
    const runRow = getRun(this.db.orm, task.runId)
    if (runRow?.kind === 'review') {
      if (report.pass) {
        completeTask(this.db.orm, task.id, null)
        // A review run is the re-review half of the chapter pipeline. Passing it
        // must continue to polish -> human gate -> archive; otherwise a manual
        // edit or a Review Center re-run dead-ends at "completed".
        this.createPostReviewTasks(task.runId, chapter, round)
      } else {
        settleTask(this.db.orm, task.id, 'failed', 'review run found blockers')
        updateRun(this.db.orm, task.runId, {
          status: 'failed',
          error: 'review run found blockers',
          endedAt: new Date().toISOString(),
        })
      }
      refreshReadyTasks(this.db.orm, task.runId)
      return
    }
    if (report.pass) {
      completeTask(this.db.orm, task.id, null)
      this.createPostReviewTasks(task.runId, chapter, round)
    } else if (round >= this.project.config.quality.review_rounds) {
      settleTask(this.db.orm, task.id, 'failed', 'review rounds exhausted')
      updateRun(this.db.orm, task.runId, {
        status: 'failed',
        error: `review rounds exhausted: ${report.blockers.map((row) => `${row.code} ${row.message}`).join('; ')}`,
        endedAt: new Date().toISOString(),
      })
      appendEvent(this.db.orm, {
        projectId: this.project.config.id,
        runId: task.runId,
        taskId: task.id,
        type: 'run.fail',
        payload: { reason: 'review rounds exhausted', blockers: report.blockers.map((row) => row.code) },
      })
    } else {
      completeTask(this.db.orm, task.id, null)
      this.createRevisionTasks(task.runId, chapter, round + 1, report)
    }
    refreshReadyTasks(this.db.orm, task.runId)
  }

  private createPostReviewTasks(runId: string, chapter: number, round: number): void {
    const existing = listTasks(this.db.orm, runId).filter((row) => {
      const input = JSON.parse(row.inputJson) as { chapter?: number }
      return input.chapter === chapter
    })
    if (existing.some((row) => row.kind === 'polish')) return
    const polish = createTasks(this.db.orm, [
      {
        runId,
        role: 'polisher',
        kind: 'polish',
        dependsOn: [],
        input: { chapter, round },
        priority: 4,
      },
    ])[0]!
    const continuity = createTasks(this.db.orm, [
      {
        runId,
        role: 'continuity',
        kind: 'continuity.final',
        dependsOn: [polish],
        input: { chapter, round },
        priority: 3,
      },
    ])[0]!
    const approve = createTasks(this.db.orm, [
      {
        runId,
        role: 'showrunner',
        kind: 'approve',
        dependsOn: [continuity],
        input: { chapter, round },
        priority: 2,
      },
    ])[0]!
    createTasks(this.db.orm, [
      {
        runId,
        role: 'archivist',
        kind: 'archive',
        dependsOn: [approve],
        input: { chapter, round },
        priority: 1,
      },
    ])
  }

  private createRevisionTasks(runId: string, chapter: number, round: number, report: GateReport): void {
    const existing = listTasks(this.db.orm, runId).filter((row) => {
      const input = JSON.parse(row.inputJson) as { chapter?: number; round?: number }
      return input.chapter === chapter && (input.round ?? 1) === round && row.kind === 'revise'
    })
    if (existing.length > 0) return
    const revise = createTasks(this.db.orm, [
      {
        runId,
        role: 'drafter',
        kind: 'revise',
        dependsOn: [],
        input: {
          chapter,
          round,
          blockers: report.blockers.map((row) => ({ code: row.code, message: row.message })),
        },
        priority: 6,
      },
    ])[0]!
    const reviewStory = createTasks(this.db.orm, [
      {
        runId,
        role: 'critic-story',
        kind: 'review.story',
        dependsOn: [revise],
        input: { chapter, round },
        priority: 5,
      },
    ])[0]!
    const reviewCharacter = createTasks(this.db.orm, [
      {
        runId,
        role: 'critic-character',
        kind: 'review.character',
        dependsOn: [revise],
        input: { chapter, round },
        priority: 5,
      },
    ])[0]!
    const reviewProse = createTasks(this.db.orm, [
      {
        runId,
        role: 'critic-prose',
        kind: 'review.prose',
        dependsOn: [revise],
        input: { chapter, round },
        priority: 5,
      },
    ])[0]!
    const continuity = createTasks(this.db.orm, [
      {
        runId,
        role: 'continuity',
        kind: 'continuity.precheck',
        dependsOn: [revise],
        input: { chapter, round },
        priority: 5,
      },
    ])[0]!
    createTasks(this.db.orm, [
      {
        runId,
        role: 'showrunner',
        kind: 'review.merge',
        dependsOn: [reviewStory, reviewCharacter, reviewProse, continuity],
        input: { chapter, round },
        priority: 4,
      },
    ])
  }

  private async onApproveRequest(task: TaskRow): Promise<void> {
    const chapter = taskChapter(task)
    const draft = await this.artifacts.latest('Draft', chapter)
    if (draft === null) {
      settleTask(this.db.orm, task.id, 'failed', 'no draft to approve')
      return
    }
    // Always re-evaluate before opening the human gate. Reusing a previously
    // written gate result would let a human approve a draft whose blockers were
    // never actually cleared.
    {
      const planArtifact = await this.artifacts.latest('ChapterPlan', chapter)
      const plan = planArtifact?.content as import('../contracts/artifacts.js').ChapterPlan | undefined
      if (plan === undefined) {
        settleTask(this.db.orm, task.id, 'failed', 'chapter plan missing before approval')
        updateRun(this.db.orm, task.runId, {
          status: 'failed',
          error: 'chapter plan missing before approval',
          endedAt: new Date().toISOString(),
        })
        return
      }
      const reviews = (await this.latestReviews(chapter)).map((row) => row.report)
      const continuity = (await this.latestContinuity(chapter)).report
      const canon = await loadCanon(this.project.store)
      const bible = await loadBible(this.project.store)
      const previousTexts: Array<{ chapter: number; text: string }> = []
      for (let offset = 1; offset <= 10 && chapter - offset >= 1; offset += 1) {
        const text = await this.project.store.readText(
          `manuscript/ch-${String(chapter - offset).padStart(4, '0')}.md`,
        )
        if (text !== null) previousTexts.push({ chapter: chapter - offset, text })
      }
      let proofSource: Draft | undefined
      let proofSourceHash: string | undefined
      for (const row of this.artifacts.list({ kind: 'Draft', chapter, limit: 20 })) {
        if (row.id === draft.id) continue
        if (listGateResults(this.db.orm, row.id).length === 0) continue
        const stored = await this.artifacts.read(row.id)
        if (stored !== null) {
          proofSource = stored.content as Draft
          proofSourceHash = stored.contentHash
          break
        }
      }
      const polishArtifact = await this.artifacts.latest('PolishPatch', chapter)
      const polish =
        polishArtifact !== null && proofSource !== undefined
          ? { patch: polishArtifact.content as PolishPatch, sourceDraft: proofSource }
          : undefined
      const report = evaluateGates({
        project: this.project,
        chapter,
        plan,
        draft: draft.content as Draft,
        draftHash: draft.contentHash,
        ...(proofSourceHash === undefined ? {} : { reviewHash: proofSourceHash }),
        ...(proofSource === undefined ? {} : { proofSource }),
        ...(polish === undefined ? {} : { polish }),
        reviews,
        continuity,
        canon,
        bible,
        previousTexts,
        round: taskRound(task),
        maxRounds: this.project.config.quality.review_rounds,
      })
      for (const finding of report.findings) {
        insertGateResult(this.db.orm, {
          artifactId: draft.id,
          gate: finding.code,
          verdict: finding.verdict,
          details: { name: finding.name, message: finding.message, ...(finding.details ?? {}) },
        })
      }
      if (!report.pass) {
        settleTask(this.db.orm, task.id, 'failed', 'post-polish gates failed')
        updateRun(this.db.orm, task.runId, {
          status: 'failed',
          error: `post-polish gates failed: ${report.blockers.map((row) => `${row.code} ${row.message}`).join('; ')}`,
          endedAt: new Date().toISOString(),
        })
        appendEvent(this.db.orm, {
          projectId: this.project.config.id,
          runId: task.runId,
          taskId: task.id,
          type: 'gate.fail',
          payload: { chapter, phase: 'post-polish', blockers: report.blockers.map((row) => row.code) },
        })
        return
      }
    }
    const pending = listHumanGates(this.db.orm, this.project.config.id).find((row) => row.taskId === task.id)
    if (pending !== undefined) return
    this.gates.open({
      projectId: this.project.config.id,
      runId: task.runId,
      taskId: task.id,
      gate: 'chapter',
      chapter,
      artifactId: draft.id,
    })
    this.db.raw
      .prepare('UPDATE task SET status = ?, updated_at = ? WHERE id = ?')
      .run('awaiting_human', new Date().toISOString(), task.id)
    updateRun(this.db.orm, task.runId, { status: 'awaiting_human' })
    appendEvent(this.db.orm, {
      projectId: this.project.config.id,
      runId: task.runId,
      taskId: task.id,
      type: 'human_gate.awaiting',
      payload: { gate: 'chapter', chapter, artifactId: draft.id },
    })
  }

  /**
   * Host-only decision path. Returns the decision artifact id.
   *
   * Side effects run after token verification but before the gate is marked,
   * so a failed publish/plan write leaves the gate open and retryable. A gate
   * receipt is bound to the exact artifact version the human saw; changing the
   * draft afterwards invalidates it.
   */
  async decide(input: {
    gateId: string
    token: string
    decision: 'approve' | 'reject' | 'edit' | 'regenerate'
    actor: string
    reason: string
    editedContent?: string
    editedArtifact?: unknown
  }): Promise<{ decisionArtifactId: string; nextRunId?: string }> {
    const gate = this.gates.verify(input.gateId, input.token)
    if (gate.projectId !== this.project.config.id) {
      throw new StudioError(
        STUDIO_ERROR_CODES.HUMAN_GATE_REQUIRED,
        `gate ${input.gateId} belongs to another project`,
      )
    }
    const gateKind = gate.gate as HumanGate
    const target = gate.artifactId === null ? null : await this.artifacts.read(gate.artifactId)
    if (gate.artifactId !== null && target === null) {
      throw new StudioError(
        STUDIO_ERROR_CODES.ARTIFACT_NOT_FOUND,
        `gate ${gate.id} points at a missing artifact ${gate.artifactId}`,
      )
    }
    const approving = input.decision === 'approve' || input.decision === 'edit'
    if (approving && target !== null) {
      const latest = await this.artifacts.latest(target.kind, target.chapter)
      if (latest === null || latest.id !== target.id) {
        throw new StudioError(
          STUDIO_ERROR_CODES.HUMAN_GATE_REQUIRED,
          'the artifact changed after the gate opened',
          're-run review and open a fresh gate; approving stale bytes is forbidden',
          { gateArtifactId: target.id, latestArtifactId: latest?.id ?? null },
        )
      }
    }

    // `edit` is "human-edited, then re-review", not a silent approve. Chapter
    // prose is saved as a new Draft, the old run is closed, and a review run is
    // branched from the new hash. Bible/outline edits are themselves the
    // artifact, so they can be finalized immediately after schema validation.
    let editedTarget: StoredArtifact | null = null
    let nextRunId: string | undefined
    if (input.decision === 'edit') {
      if (gateKind === 'publish' || target === null) {
        throw new StudioError(
          STUDIO_ERROR_CODES.APPROVAL_INVALID,
          'edit is not supported for the publish gate',
          'use approve/reject for a publish package',
        )
      }
      if (gateKind === 'chapter') {
        if (gate.chapter === null) {
          throw new StudioError(STUDIO_ERROR_CODES.APPROVAL_INVALID, 'chapter gate has no chapter number')
        }
        if (input.editedContent === undefined || input.editedContent.trim() === '') {
          throw new StudioError(
            STUDIO_ERROR_CODES.APPROVAL_INVALID,
            'edit requires editedContent',
            'send the human-edited chapter text, or use reject/regenerate',
          )
        }
        const { buildHumanDraft } = await import('../kernel/book/draft.js')
        const { evaluateDraftFormat } = await import('../kernel/gates/index.js')
        const existing = target.content as Draft
        const edited = buildHumanDraft({
          existing,
          chapter: gate.chapter,
          title: existing.title,
          content: input.editedContent,
          baseArtifactId: target.id,
          baseHash: target.contentHash,
        })
        const formatBlockers = evaluateDraftFormat(this.project, gate.chapter, edited.title, edited.content)
        if (formatBlockers.length > 0) {
          throw new StudioError(
            STUDIO_ERROR_CODES.ARTIFACT_INVALID,
            'edited chapter failed the deterministic format gate',
            'fix Markdown/quotes/ellipsis/paragraph length before approving the edit',
            { blockers: formatBlockers },
          )
        }
        editedTarget = await this.artifacts.saveHumanEdit({
          kind: 'Draft',
          chapter: gate.chapter,
          content: edited,
          baseHash: target.contentHash,
          actor: input.actor,
          runId: gate.runId,
        })
        // The original run must not archive a draft that no longer matches the
        // reviews it was gated on. Close it and branch a review run on the edit.
        cancelRun(this.db.orm, gate.runId)
        nextRunId = this.createChapterRun({ chapter: gate.chapter, mode: 'review' })
      } else {
        if (input.editedArtifact === undefined) {
          throw new StudioError(
            STUDIO_ERROR_CODES.APPROVAL_INVALID,
            'edit requires editedArtifact for a bible/outline gate',
            'send the full edited BiblePlan or OutlinePlan object',
          )
        }
        const kind = gateKind === 'bible' ? 'BiblePlan' : 'OutlinePlan'
        const parsed = ARTIFACT_SCHEMAS[kind].safeParse(input.editedArtifact)
        if (!parsed.success) {
          throw new StudioError(
            STUDIO_ERROR_CODES.ARTIFACT_INVALID,
            `edited ${kind} does not match its schema`,
            'fix the missing or invalid fields and resubmit',
            { issues: parsed.error.issues },
          )
        }
        editedTarget = await this.artifacts.saveHumanEdit({
          kind,
          chapter: null,
          content: parsed.data,
          baseHash: target.contentHash,
          actor: input.actor,
          runId: gate.runId,
        })
      }
    }

    const decisionTarget = editedTarget ?? target
    const decision: Decision = {
      schema_version: 2,
      kind: 'Decision',
      gate: gateKind,
      action: input.decision,
      target_artifact_id: decisionTarget?.id ?? 'none',
      target_version: decisionTarget?.version ?? 1,
      actor: input.actor,
      reason: input.reason || input.decision,
      approval_token: sha256Hex(input.token),
      at: new Date().toISOString(),
    }
    if (input.decision === 'approve' && gateKind === 'publish') {
      const packageResult = await publishPackage(this.project, this.db, this.artifacts)
      await this.artifacts.submit({
        kind: 'Export',
        chapter: null,
        content: ExportSchema.parse({
          schema_version: 2,
          kind: 'Export',
          format: 'publish',
          path: packageResult.path,
          chapters: packageResult.chapters,
          content_hash: packageResult.contentHash,
          profile: packageResult.profile,
          package_path: packageResult.path,
          manifest: packageResult.manifest,
          checks: packageResult.checks,
        }),
        provenance: {
          runId: gate.runId,
          taskId: `publish:${gate.id}`,
          role: 'showrunner',
          preset: 'human-gate',
          model: 'human',
          agentSessionId: input.actor,
        },
        status: 'approved',
      })
    }
    if ((input.decision === 'approve' || input.decision === 'edit') && decisionTarget !== null) {
      if (gateKind === 'bible') {
        await saveBiblePlan(this.project.store, decisionTarget.content as BiblePlan)
      } else if (gateKind === 'outline') {
        await saveOutlinePlan(this.project.store, decisionTarget.content as OutlinePlan)
      }
      if (gateKind === 'bible' || gateKind === 'outline') {
        const { rebuildProjectIndex } = await import('../kernel/read/index.js')
        await rebuildProjectIndex(this.project, this.db)
      }
    }
    const artifact = await this.artifacts.submit({
      kind: 'Decision',
      chapter: gate.chapter,
      content: DecisionSchema.parse(decision),
      provenance: {
        runId: gate.runId,
        taskId: `human:${gate.id}`,
        role: 'showrunner',
        preset: 'human-gate',
        model: 'human',
        agentSessionId: input.actor,
      },
      status: approving ? 'approved' : 'rejected',
    })
    if (input.decision === 'approve' || (input.decision === 'edit' && gateKind !== 'chapter')) {
      if (decisionTarget !== null) {
        setArtifactStatus(this.db.orm, decisionTarget.id, 'approved')
        await this.artifacts.approve(decisionTarget.id)
      }
      if (gate.taskId != null) completeTask(this.db.orm, gate.taskId, decisionTarget?.id ?? null)
      if (gateKind !== 'publish') {
        updateRun(this.db.orm, gate.runId, { status: 'running' })
        refreshReadyTasks(this.db.orm, gate.runId)
      }
      appendEvent(this.db.orm, {
        projectId: this.project.config.id,
        runId: gate.runId,
        type: 'human_gate.approved',
        payload: {
          gate: gate.gate,
          chapter: gate.chapter,
          decision: input.decision,
          decisionArtifactId: artifact.id,
          ...(nextRunId === undefined ? {} : { nextRunId }),
        },
      })
    } else if (input.decision === 'edit' && gateKind === 'chapter') {
      // cancelRun already closed the original run and its tasks.
      appendEvent(this.db.orm, {
        projectId: this.project.config.id,
        runId: gate.runId,
        type: 'human_gate.edited',
        payload: {
          gate: gate.gate,
          chapter: gate.chapter,
          decisionArtifactId: artifact.id,
          ...(nextRunId === undefined ? {} : { nextRunId }),
        },
      })
    } else {
      if (gate.taskId != null) settleTask(this.db.orm, gate.taskId, 'failed', `human ${input.decision}`)
      if (gateKind !== 'publish') {
        updateRun(this.db.orm, gate.runId, {
          status: 'failed',
          error: `human ${input.decision}: ${input.reason}`,
          endedAt: new Date().toISOString(),
        })
      }
      appendEvent(this.db.orm, {
        projectId: this.project.config.id,
        runId: gate.runId,
        type: 'human_gate.rejected',
        payload: { gate: gate.gate, chapter: gate.chapter, decisionArtifactId: artifact.id },
      })
    }
    this.gates.mark({ ...input, gateId: input.gateId })
    return {
      decisionArtifactId: artifact.id,
      ...(nextRunId === undefined ? {} : { nextRunId }),
    }
  }

  /**
   * Plan §8.6: rewind creates new versions and a new run; it never deletes
   * history. Artifact rewind is pure versioning; chapter/run rewind also
   * branches a rewrite run so the restored bytes must pass review again.
   */
  async rewind(input: {
    target: 'artifact' | 'chapter' | 'run'
    artifactId?: string
    chapter?: number
    runId?: string
    actor: string
    reason: string
  }): Promise<{
    artifact?: { id: string; version: number; kind: string; chapter: number | null }
    runId?: string
  }> {
    if (input.target === 'artifact') {
      if (input.artifactId === undefined || input.artifactId === '') {
        throw new StudioError(STUDIO_ERROR_CODES.ARTIFACT_NOT_FOUND, 'artifactId is required')
      }
      const artifact = await this.artifacts.restore(input.artifactId, input.actor, input.reason)
      return {
        artifact: {
          id: artifact.id,
          version: artifact.version,
          kind: artifact.kind,
          chapter: artifact.chapter,
        },
      }
    }
    let chapter = input.chapter
    if (input.target === 'run') {
      if (input.runId === undefined || input.runId === '') {
        throw new StudioError(STUDIO_ERROR_CODES.RUN_NOT_FOUND, 'runId is required')
      }
      const run = getRun(this.db.orm, input.runId)
      if (run === undefined) throw new StudioError(STUDIO_ERROR_CODES.RUN_NOT_FOUND, `no run ${input.runId}`)
      chapter = run.targetChapter ?? undefined
    }
    if (chapter === undefined || !Number.isInteger(chapter) || chapter < 1) {
      throw new StudioError(
        STUDIO_ERROR_CODES.RUN_STATE_INVALID,
        'chapter rewind needs a positive chapter number',
      )
    }
    let artifact: { id: string; version: number; kind: string; chapter: number | null } | undefined
    if (input.artifactId !== undefined && input.artifactId !== '') {
      const restored = await this.artifacts.restore(input.artifactId, input.actor, input.reason)
      artifact = {
        id: restored.id,
        version: restored.version,
        kind: restored.kind,
        chapter: restored.chapter,
      }
    } else {
      const latest = await this.artifacts.latest('Draft', chapter)
      if (latest === null) {
        throw new StudioError(
          STUDIO_ERROR_CODES.ARTIFACT_NOT_FOUND,
          `chapter ${chapter} has no draft to rewind`,
        )
      }
    }
    // `status.stage` treats the manuscript file as the archived truth and the
    // exporter reads it directly. A rewrite must therefore retire the archived
    // copy first, or the status stays `archived` and export could ship old
    // prose. History is kept under .studio/history instead of being deleted.
    const padded = String(chapter).padStart(4, '0')
    const manuscriptPath = `manuscript/ch-${padded}.md`
    const archivedText = await this.project.store.readText(manuscriptPath)
    if (archivedText !== null) {
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
      const historyPath = `.studio/history/manuscript/ch-${padded}.${stamp}.md`
      await this.project.store.ensureDir('.studio/history/manuscript')
      await this.project.store.writeText(historyPath, archivedText)
      await this.project.store.remove(manuscriptPath)
      appendEvent(this.db.orm, {
        projectId: this.project.config.id,
        type: 'chapter.rewind',
        payload: { chapter, historyPath, actor: input.actor, reason: input.reason },
      })
    }
    const runId = this.createChapterRun({ chapter, mode: 'rewrite' })
    return { ...(artifact === undefined ? {} : { artifact }), runId }
  }

  private async onArchive(task: TaskRow): Promise<void> {
    const chapter = taskChapter(task)
    const draftArtifact = await this.artifacts.latest('Draft', chapter)
    const deltaArtifact = await this.artifacts.latest('StateDelta', chapter)
    const receipt = await latestHumanApproval(this.artifacts, chapter, 'chapter')
    if (draftArtifact === null || deltaArtifact === null) {
      settleTask(this.db.orm, task.id, 'failed', 'draft or state delta missing')
      updateRun(this.db.orm, task.runId, {
        status: 'failed',
        error: 'draft or state delta missing',
        endedAt: new Date().toISOString(),
      })
      return
    }
    if (receipt === null) {
      settleTask(this.db.orm, task.id, 'failed', 'human approval receipt missing')
      updateRun(this.db.orm, task.runId, {
        status: 'failed',
        error: 'human approval receipt missing: role-submitted Decision is advice only',
        endedAt: new Date().toISOString(),
      })
      return
    }
    try {
      assertReceiptBindsDraft(receipt, draftArtifact)
    } catch (error) {
      settleTask(this.db.orm, task.id, 'failed', error instanceof Error ? error.message : String(error))
      updateRun(this.db.orm, task.runId, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        endedAt: new Date().toISOString(),
      })
      return
    }
    if (draftArtifact.status !== 'approved') {
      settleTask(this.db.orm, task.id, 'failed', `draft is ${draftArtifact.status}, not approved`)
      updateRun(this.db.orm, task.runId, {
        status: 'failed',
        error: `draft is ${draftArtifact.status}, not approved`,
        endedAt: new Date().toISOString(),
      })
      return
    }
    const draft = asDraft(draftArtifact)
    const archiveBible = await loadBible(this.project.store)
    const previousTexts: Array<{ chapter: number; text: string }> = []
    for (let offset = 1; offset <= 10 && chapter - offset >= 1; offset += 1) {
      const text = await this.project.store.readText(
        `manuscript/ch-${String(chapter - offset).padStart(4, '0')}.md`,
      )
      if (text !== null) previousTexts.push({ chapter: chapter - offset, text })
    }
    const archiveTone = evaluateArchiveTone({
      project: this.project,
      chapter,
      draft,
      bible: archiveBible,
      previousTexts,
    })
    if (archiveTone.length > 0) {
      insertGateResult(this.db.orm, {
        artifactId: draftArtifact.id,
        gate: 'PG-12',
        verdict: 'fail',
        details: {
          name: 'ARCHIVE_ATOMIC',
          message: `${archiveTone.length} AI-tone finding(s) must be fixed before archive`,
          findings: archiveTone,
        },
      })
      settleTask(this.db.orm, task.id, 'failed', 'archive-stage AI tone escalation')
      updateRun(this.db.orm, task.runId, {
        status: 'failed',
        error: `archive-stage AI tone escalation: ${archiveTone.map((row) => row.entryId).join(', ')}`,
        endedAt: new Date().toISOString(),
      })
      return
    }
    const delta = deltaArtifact.content as StateDelta
    for (const foreshadow of delta.foreshadows) {
      if (
        foreshadow.action === 'resolved' &&
        (foreshadow.resolved_anchor === undefined || !draft.content.includes(foreshadow.resolved_anchor))
      ) {
        throw new StudioError(
          STUDIO_ERROR_CODES.ARTIFACT_INVALID,
          `foreshadow ${foreshadow.key} resolved_anchor is not in the approved draft`,
          'quote the exact sentence that closes the foreshadow',
        )
      }
    }
    const canon = await loadCanon(this.project.store)
    const nextCanon = applyStateDelta(canon, delta)
    const manuscriptPath = `manuscript/ch-${String(chapter).padStart(4, '0')}.md`
    const existing = await this.project.store.readText(manuscriptPath)
    const previousCanon = await this.project.store.readText('state/canon.yaml')
    const body = `${draft.content.trim()}\n`
    const hash = sha256Hex(body)
    const markerPath = `.studio/archive/ch-${String(chapter).padStart(4, '0')}.json`
    if (existing !== null && sha256Hex(existing) === hash) {
      const markerText = await this.project.store.readText(markerPath)
      if (markerText !== null) {
        let marker: { draftHash?: string; canon?: import('../contracts/project.js').Canon }
        try {
          marker = JSON.parse(markerText) as {
            draftHash?: string
            canon?: import('../contracts/project.js').Canon
          }
        } catch {
          throw new StudioError(
            STUDIO_ERROR_CODES.ARTIFACT_INVALID,
            `archive recovery marker ${markerPath} is corrupt`,
            'restore .studio/archive from backup or remove the marker after verifying canon.yaml',
          )
        }
        if (marker.draftHash !== hash || marker.canon === undefined) {
          throw new StudioError(
            STUDIO_ERROR_CODES.ARTIFACT_CONFLICT,
            `archive recovery marker ${markerPath} does not belong to the current draft`,
            'inspect canon.yaml and the marker; do not archive over a stale recovery point',
            { markerHash: marker.draftHash, draftHash: hash },
          )
        }
        await saveCanon(this.project.store, marker.canon)
        await this.project.store.remove(markerPath)
      }
      insertGateResult(this.db.orm, {
        artifactId: draftArtifact.id,
        gate: 'PG-12',
        verdict: 'pass',
        details: { name: 'ARCHIVE_ATOMIC', message: 'recovered archive marker and verified canon' },
      })
      upsertMemoryChunk(this.db.orm, {
        projectId: this.project.config.id,
        kind: 'chapter',
        chapter,
        sourcePath: manuscriptPath,
        sourceHash: `sha256:${hash.replace(/^sha256:/u, '')}`,
        text: draft.content,
        meta: { entities: draft.summary.characters_appeared, events: draft.summary.events },
      })
      setArtifactStatus(this.db.orm, draftArtifact.id, 'approved')
      completeTask(this.db.orm, task.id, deltaArtifact.id)
      updateRun(this.db.orm, task.runId, { status: 'completed', endedAt: new Date().toISOString() })
      return
    }
    const restore = async (): Promise<void> => {
      if (existing === null) await this.project.store.remove(manuscriptPath)
      else await this.project.store.writeText(manuscriptPath, existing)
      if (previousCanon === null) await this.project.store.remove('state/canon.yaml')
      else await this.project.store.writeText('state/canon.yaml', previousCanon)
    }
    try {
      await this.project.store.ensureDir('.studio/archive')
      await this.project.store.writeText(
        markerPath,
        `${JSON.stringify({ chapter, draftHash: hash, canon: nextCanon }, null, 2)}\n`,
      )
      if (existing !== null && sha256Hex(existing) !== hash) {
        await this.project.store.ensureDir('.studio/history')
        const prior = sha256Hex(existing).slice(0, 12)
        await this.project.store.writeText(
          `.studio/history/ch-${String(chapter).padStart(4, '0')}-${prior}.md`,
          existing,
        )
      }
      await this.project.store.writeText(manuscriptPath, body)
      await saveCanon(this.project.store, nextCanon)
      const readback = await this.project.store.readText(manuscriptPath)
      if (readback === null || sha256Hex(readback) !== hash) {
        throw new StudioError(STUDIO_ERROR_CODES.ARTIFACT_HASH_MISMATCH, 'archive readback hash mismatch')
      }
      await this.project.store.remove(markerPath)
      insertGateResult(this.db.orm, {
        artifactId: draftArtifact.id,
        gate: 'PG-12',
        verdict: 'pass',
        details: { name: 'ARCHIVE_ATOMIC', message: 'draft/canon/manuscript hash verified' },
      })
    } catch (error) {
      try {
        await restore()
        await this.project.store.remove(markerPath)
      } catch {
        // Keep the marker so a retry can finish the compensation.
      }
      settleTask(this.db.orm, task.id, 'failed', error instanceof Error ? error.message : String(error))
      updateRun(this.db.orm, task.runId, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        endedAt: new Date().toISOString(),
      })
      return
    }
    setArtifactStatus(this.db.orm, draftArtifact.id, 'approved')
    upsertMemoryChunk(this.db.orm, {
      projectId: this.project.config.id,
      kind: 'chapter',
      chapter,
      sourcePath: manuscriptPath,
      sourceHash: `sha256:${hash.replace(/^sha256:/u, '')}`,
      text: draft.content,
      meta: { entities: draft.summary.characters_appeared, events: draft.summary.events },
    })
    completeTask(this.db.orm, task.id, deltaArtifact.id)
    updateRun(this.db.orm, task.runId, {
      status: 'completed',
      endedAt: new Date().toISOString(),
      output: { chapter, manuscript: manuscriptPath, hash, score: 0 },
    })
    appendEvent(this.db.orm, {
      projectId: this.project.config.id,
      runId: task.runId,
      taskId: task.id,
      type: 'run.done',
      payload: { chapter, manuscript: manuscriptPath, hash },
    })
    void appendTrace(this.project, task.runId, 'run:done', { chapter, manuscript: manuscriptPath, hash })
  }

  pause(runId: string): void {
    const run = getRun(this.db.orm, runId)
    if (run === undefined) throw new StudioError(STUDIO_ERROR_CODES.RUN_NOT_FOUND, `no run ${runId}`)
    assertRunEvent(run.status as import('../contracts/stages.js').RunStatus, 'PAUSE')
    updateRun(this.db.orm, runId, { status: 'paused' })
    appendEvent(this.db.orm, { projectId: this.project.config.id, runId, type: 'run.pause', payload: {} })
  }

  resume(runId: string): void {
    const run = getRun(this.db.orm, runId)
    if (run === undefined) throw new StudioError(STUDIO_ERROR_CODES.RUN_NOT_FOUND, `no run ${runId}`)
    if (run.status === 'awaiting_human') {
      throw new StudioError(
        STUDIO_ERROR_CODES.HUMAN_GATE_REQUIRED,
        'run is waiting for a human gate, not paused',
        'approve/reject the gate, or use revision.request to branch a rewrite',
      )
    }
    assertRunEvent(run.status as import('../contracts/stages.js').RunStatus, 'RESUME')
    updateRun(this.db.orm, runId, { status: 'running' })
    appendEvent(this.db.orm, { projectId: this.project.config.id, runId, type: 'run.resume', payload: {} })
    refreshReadyTasks(this.db.orm, runId)
  }

  cancel(runId: string): void {
    const run = getRun(this.db.orm, runId)
    if (run === undefined) throw new StudioError(STUDIO_ERROR_CODES.RUN_NOT_FOUND, `no run ${runId}`)
    assertRunEvent(run.status as import('../contracts/stages.js').RunStatus, 'CANCEL')
    cancelRun(this.db.orm, runId)
    appendEvent(this.db.orm, { projectId: this.project.config.id, runId, type: 'run.cancel', payload: {} })
  }

  async status(chapterHint?: number): Promise<StatusDto> {
    const plans = (await this.project.store.list('outline/chapters')).filter((name) =>
      /^ch-\d{4}\.yaml$/u.test(name),
    )
    const manuscripts = (await this.project.store.list('manuscript')).filter((name) =>
      /^ch-\d{4}\.md$/u.test(name),
    )
    const latestRun = listRuns(this.db.orm, this.project.config.id, 1)[0]
    let chapter = chapterHint ?? latestRun?.targetChapter ?? 1
    if (chapter < 1) chapter = 1
    const draft = await this.artifacts.latest('Draft', chapter)
    const archived = manuscripts.includes(`ch-${String(chapter).padStart(4, '0')}.md`)
    const runsForChapter = listRuns(this.db.orm, this.project.config.id, 100).filter(
      (run) => run.targetChapter === chapter,
    )
    const chapterTasks = runsForChapter.flatMap((run) => listTasks(this.db.orm, run.id))
    const doneKinds = new Set(
      chapterTasks.filter((task) => task.status === 'completed').map((task) => task.kind),
    )
    const stage: ChapterStage = archived
      ? 'archived'
      : draft?.status === 'approved'
        ? 'approved'
        : doneKinds.has('continuity.final')
          ? 'continuity'
          : doneKinds.has('polish')
            ? 'polished'
            : doneKinds.has('revise')
              ? 'revised'
              : ['review.story', 'review.character', 'review.prose'].every((kind) => doneKinds.has(kind))
                ? 'reviewed'
                : draft !== null
                  ? 'drafted'
                  : plans.includes(`ch-${String(chapter).padStart(4, '0')}.yaml`)
                    ? 'planned'
                    : 'planned'
    const draftContent = draft === null ? '' : (draft.content as Draft).content
    const metrics = countWordMetrics(draftContent)
    const gateRows = draft === null ? [] : [...latestGateResults(this.db.orm, draft.id).values()]
    const gateBlocking = gateRows.filter((row) => row.verdict === 'fail').length
    const findings = draft === null ? [] : listFindings(this.db.orm, draft.id)
    const continuityArtifact =
      draft === null ? null : await this.artifacts.latest('ContinuityReport', chapter)
    const continuityFindings =
      continuityArtifact === null ? [] : listFindings(this.db.orm, continuityArtifact.id)
    const openBlockerFindings = [...findings, ...continuityFindings].filter(
      (finding) => finding.status === 'open' && finding.severity === 'blocker',
    ).length
    const blocking = Math.max(gateBlocking, openBlockerFindings)
    const scoreRow = gateRows.find((row) => row.gate === 'PG-07')
    let score: number | null = null
    if (typeof scoreRow?.detailsJson === 'string' && scoreRow.detailsJson.includes('score')) {
      try {
        score = Number((JSON.parse(scoreRow.detailsJson) as { score?: number }).score ?? 0)
      } catch {
        score = null
      }
    }
    const pending = listHumanGates(this.db.orm, this.project.config.id)
    const next =
      pending.length > 0
        ? { action: 'human.approve', label: '等待人工批准', args: { gateId: pending[0]!.id } }
        : latestRun === undefined ||
            latestRun.status === 'failed' ||
            latestRun.status === 'cancelled' ||
            latestRun.status === 'completed'
          ? { action: 'run.start', label: '启动章节创作', args: { chapter } }
          : latestRun.status === 'paused'
            ? { action: 'run.resume', label: '恢复 Run', args: { runId: latestRun.id } }
            : latestRun.status === 'awaiting_human'
              ? {
                  action: 'run.cancel',
                  label: '人工处理：取消后重开',
                  args: { runId: latestRun.id, error: latestRun.error },
                }
              : { action: 'run.tick', label: '推进 Run', args: { runId: latestRun.id } }
    return {
      project: {
        id: this.project.config.id,
        root: this.project.root,
        title: this.project.config.title,
        author: this.project.config.author,
        genre: {
          ...this.project.config.genre,
          audience: this.project.config.audience,
          platform: this.project.config.platform,
        },
        genre_path: genrePath(this.project.config.genre, this.project.taxonomy),
        tags: this.project.config.genre.tags,
        format_version: 2,
        created_at: this.project.config.created_at,
        updated_at: this.project.config.updated_at,
      },
      stage,
      chapter,
      words: metrics.total_word_count,
      score,
      min_score: this.project.config.quality.min_score,
      blocking,
      run:
        latestRun === undefined
          ? null
          : {
              id: latestRun.id,
              kind: latestRun.kind,
              status: latestRun.status,
              targetChapter: latestRun.targetChapter,
            },
      next,
      counts: {
        chapters: plans.length,
        archived: manuscripts.length,
        artifacts: this.artifacts.list({ limit: 100_000 }).length,
        openFindings: [...findings, ...continuityFindings].filter((finding) => finding.status === 'open')
          .length,
      },
      cost_usd: usageForRun(this.db.orm, latestRun?.id ?? '').costUsd,
    }
  }

  board() {
    const runs = listRuns(this.db.orm, this.project.config.id, 100)
    const tasks = runs.flatMap((run) => listTasks(this.db.orm, run.id))
    const assignments = listAssignments(
      this.db.orm,
      tasks.map((task) => task.id),
    )
    const gates = listHumanGates(this.db.orm, this.project.config.id)
    const artifacts = this.artifacts.list({ limit: 500 })
    return {
      projectId: this.project.config.id,
      runs: runs.map((run) => ({
        id: run.id,
        projectId: run.projectId,
        kind: run.kind as import('../contracts/stages.js').RunKind,
        status: run.status as import('../contracts/stages.js').RunStatus,
        targetChapter: run.targetChapter,
        error: run.error,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      })),
      tasks: tasks.map((task) => ({
        id: task.id,
        runId: task.runId,
        role: task.role as import('../contracts/artifacts.js').RoleId,
        kind: task.kind,
        status: task.status as import('../contracts/stages.js').TaskStatus,
        dependsOn: JSON.parse(task.dependsOnJson) as string[],
        priority: task.priority,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
        leaseOwner: task.leaseOwner,
        leaseUntil: task.leaseUntil,
        outputArtifactId: task.outputArtifactId,
        error: task.error,
      })),
      assignments: assignments.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        agentSessionId: row.agentSessionId,
        provider: row.provider,
        preset: row.preset,
        model: row.model,
        status: row.status as import('../contracts/stages.js').AssignmentStatus,
        stopReason: row.stopReason,
        usage: row.usageJson === null ? null : (JSON.parse(row.usageJson) as Record<string, unknown>),
        startedAt: row.startedAt,
        endedAt: row.endedAt,
      })),
      gates: gates.map((row) => ({
        id: row.id,
        gate: row.gate as HumanGate,
        runId: row.runId,
        taskId: row.taskId,
        artifactId: row.artifactId,
        chapter: row.chapter,
        requestedAt: row.requestedAt,
      })),
      artifacts: artifacts.map((row) => ({
        id: row.id,
        kind: row.kind as import('../contracts/artifacts.js').ArtifactKind,
        chapter: row.chapter,
        version: row.version,
      })),
      seq: maxEventSeq(this.db.orm, this.project.config.id),
    }
  }
}
