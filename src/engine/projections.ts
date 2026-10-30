import { PANEL_CHAPTER_LIMIT, PANEL_ID, PHASE_STRIP, REMOTE_VERSION } from '../constants.js'
import type { BlockingItem, ChapterRecord, Stage, StatusReport } from '../types.js'
import type { PanelBookData } from '../panel-contract.js'

/** The shared read model: everything the panel, status and commands render. */
export interface PanelDraft {
  num: number
  title: string
  wordCount: number
  score: number
  status: 'draft' | 'blocked'
  details: string
}

export interface PanelSnapshot {
  root: string
  title: string
  genre: string
  platform: string
  chapter: number
  stage: Stage
  revision: number
  rounds: { review: number; revise: number; check: number }
  blocking: BlockingItem[]
  volume?: number
  volume_name?: string
  act?: string
  act_progress?: string
  /** Recommended next action; lets the panel explain a stage with no blockers. */
  next?: StatusReport['next']
  /** True only when the configured total chapter target has been reached. */
  finished?: boolean
  chapters: ChapterRecord[]
  /** The active, not-yet-archived chapter; archived rows come from `chapters`. */
  draft?: PanelDraft | null
  /** Total words across the index, for the header. */
  totalWords: number
  /** Book-wide archived average, not just the panel's capped rows. */
  averageScore?: number
  /** The nine-phase strip state, derived from the pipeline stage. */
  phases: Array<{ id: string; done: boolean; active: boolean }>
  /** 0.2.0 book-level planning and health blocks. */
  book?: PanelBook
  quality?: {
    averageScore: number
    scores: number[]
    trend: number | null
    trend_basis?: 'last_five_vs_previous_five' | 'insufficient_samples' | 'insufficient_history'
    samples?: number
    attempts?: number
  }
  health?: { ok: boolean; blocking: number; stateErrors: number; pending?: boolean }
  activity?: Array<{ at: string; op: string; chapter: number; status: string }>
  /** Unacknowledged machine advisories; never mixed into `blocking`. */
  advisories?: Array<{ code: string; detail: string; hint?: string }>
  /** Number of advisory codes already acknowledged for the current check. */
  acknowledgedAdvisories?: number
  /** Read-only upgrade findings; null when the project needs no explanation. */
  legacy?: Array<{ code: string; detail: string }>
  /** Crash-left pending transaction; complete/untouched are warnings. */
  pending?: { state: string; txid: string; detail: string }
  /** v6 read-only book data; v5 payloads omit it. */
  bookData?: PanelBookData
}

export interface PanelBook {
  premise: string
  logline: string
  strict: boolean
  target: number | null
  outline: {
    present: boolean
    target: number | null
    total: number
    planned: number
    archived: number
    missing_cards: number
    planned_coverage: number | null
    archived_coverage: number | null
    coverage: number
    card_coverage: number
    volumes: Array<{ title: string; start: number; end: number; planned: number; archived: number }>
  }
  worldbook: {
    present: boolean
    characters: number
    locations: number
    factions: number
    rules: number
    glossary: number
    backstory: number
    facts?: number
  }
}

export interface PanelSummaryDto {
  schemaVersion: number
  panelId: string
  /** Absolute project root, so a stale title cannot hide a wrong book. */
  root: string
  title: string
  genre: string
  platform: string
  chapter: number
  stage: Stage
  revision: number
  totalWords: number
  totalChapters: number
  /** Book-wide archived average; absent on older payloads. */
  averageScore?: number
  volume?: number
  volume_name?: string
  act?: string
  act_progress?: string
  phases: Array<{ id: string; done: boolean; active: boolean }>
  blocking: BlockingItem[]
  next?: { tool: string; reason: string }
  /** Absent for older payloads; false means the current chapter cycle is done. */
  finished?: boolean
  /** 0.2.0 planning, quality, health and activity blocks. */
  book?: PanelBook
  quality?: {
    averageScore: number
    scores: number[]
    trend: number | null
    trend_basis?: 'last_five_vs_previous_five' | 'insufficient_samples' | 'insufficient_history'
    samples?: number
    attempts?: number
  }
  health?: { ok: boolean; blocking: number; stateErrors: number; pending?: boolean }
  activity?: Array<{ at: string; op: string; chapter: number; status: string }>
  /** Unacknowledged machine advisories; never mixed into `blocking`. */
  advisories?: Array<{ code: string; detail: string; hint?: string }>
  /** Number of advisory codes already acknowledged for the current check. */
  acknowledgedAdvisories?: number
  /** Read-only upgrade findings; null when the project needs no explanation. */
  legacy?: Array<{ code: string; detail: string }>
  /** Crash-left pending transaction; complete/untouched are warnings. */
  pending?: { state: string; txid: string; detail: string }
  /** v6 read-only book data; v5 payloads omit it. */
  bookData?: PanelBookData
}

export interface PanelChapterRow {
  num: number
  title: string
  wordCount: number
  score: number
  stage: Stage
  status: 'passed' | 'blocked' | 'draft'
  /** One-line summary shown when the row is expanded. */
  details: string
  sceneType?: string
  dialogueRatio?: number
  hookStrength?: number
  finalCheck?: 'pass' | 'fail' | null
  reviews?: number
  revisions?: number
  checks?: number
  rollbacks?: number
  archivedAt?: string | null
}

export interface PanelChaptersDto {
  schemaVersion: number
  panelId: string
  rows: PanelChapterRow[]
}

export interface PanelGatesDto {
  schemaVersion: number
  panelId: string
  stage: Stage
  blocking: BlockingItem[]
  /** Human-facing one-liner per blocking item. */
  explanations: string[]
}

/** One selectable project in the panel; state is cheap, not a full load. */
export interface PanelProjectOption {
  root: string
  title: string
  active: boolean
  registered: boolean
  state: 'ok' | 'damaged' | 'missing' | 'not-project' | 'unreadable'
  /** The path now holds a different project identity; writes will fail closed. */
  identity_changed?: boolean
}

export interface PanelSelection {
  root: string | null
  source: 'query' | 'active' | 'single' | 'config' | 'none'
}

export interface PanelMissing {
  root: string
  title: string
  code: 'ENGINE_PROJECT_MISSING' | 'ENGINE_PROJECT_NOT_FOUND' | 'ENGINE_TXN_IN_PROGRESS'
  reason: 'missing' | 'not-project' | 'damaged' | 'not_registered' | 'unreadable' | 'busy'
  hint: string
}

export interface PanelBundle {
  projects: PanelProjectOption[]
  selection: PanelSelection
  summary?: PanelSummaryDto
  chapters?: PanelChaptersDto
  gates?: PanelGatesDto
  resume?: { text: string }
  missing?: PanelMissing
  empty?: true
  error?: string
}

export interface ResumePromptInput {
  title: string
  root: string
  chapter: number | string
  stage: string
  nextTool: string
}

/** One shared prompt template for `/novel resume` and the panel copy button. */
export function formatResumePrompt(input: ResumePromptInput): string {
  return [
    `请继续《${input.title}》。`,
    `项目根：${input.root}（第一次工具调用必须显式传 project_root=${input.root}）。`,
    `当前第 ${input.chapter} 章，阶段 ${input.stage}。`,
    `下一步：${input.nextTool}。`,
    '先调用 novel_status 核对项目根与书名，再按 novel_pipeline 的下一步执行；',
    '只操作这个项目，不要读取或写入其他书。',
  ].join('\n')
}

const STAGE_TO_PHASE: Record<Stage, string> = {
  idle: 'P1',
  P2: 'P2',
  P3: 'P3',
  P4: 'P4',
  P5: 'P5',
  P6: 'P6',
  ready_to_archive: 'P7',
  done: 'P9',
}

/** The nine-phase progress strip: phases before the active one are done. */
export function phaseStrip(
  stage: Stage,
  finished = false,
): Array<{ id: string; done: boolean; active: boolean }> {
  // `done` is the archive state for the current chapter, not proof that the
  // whole book is finished. A book with a configured target only goes all-green
  // when that target has been reached; otherwise the next cycle starts at P1.
  if (stage === 'done') {
    return finished
      ? PHASE_STRIP.map((id) => ({ id, done: true, active: false }))
      : PHASE_STRIP.map((id) => ({ id, done: false, active: id === 'P1' }))
  }
  const active = STAGE_TO_PHASE[stage]
  const activeIndex = PHASE_STRIP.indexOf(active as (typeof PHASE_STRIP)[number])
  return PHASE_STRIP.map((id, index) => ({
    id,
    done: index < activeIndex,
    active: id === active,
  }))
}

/** Project a chapter row for the table; a reviewed chapter without blockers reads as passed. */
export function projectChapter(record: ChapterRecord): PanelChapterRow {
  return {
    num: record.num,
    title: record.title,
    wordCount: record.word_count,
    score: record.score,
    stage: record.status === 'reviewed' ? 'done' : 'P3',
    status: record.status === 'reviewed' ? 'passed' : 'draft',
    details: record.summary.events.join('；').slice(0, 240),
    sceneType: record.scene_type,
    dialogueRatio: record.dialogue_ratio,
    hookStrength: record.summary.hook_strength,
    finalCheck: record.final_check ?? null,
    reviews: record.rounds?.review ?? 0,
    revisions: record.rounds?.revise ?? 0,
    checks: record.rounds?.check ?? 0,
    rollbacks: record.rounds?.rollbacks ?? 0,
    archivedAt: record.archived_at ?? null,
  }
}

export function projectSummary(snapshot: PanelSnapshot): PanelSummaryDto {
  return {
    schemaVersion: REMOTE_VERSION,
    panelId: PANEL_ID,
    root: snapshot.root,
    title: snapshot.title,
    genre: snapshot.genre,
    platform: snapshot.platform,
    chapter: snapshot.chapter,
    stage: snapshot.stage,
    revision: snapshot.revision,
    totalWords: snapshot.totalWords,
    totalChapters: snapshot.chapters.length,
    averageScore:
      snapshot.averageScore ??
      (snapshot.chapters.length === 0
        ? 0
        : snapshot.chapters.reduce((sum, chapter) => sum + chapter.score, 0) / snapshot.chapters.length),
    ...(snapshot.volume === undefined ? {} : { volume: snapshot.volume }),
    ...(snapshot.volume_name === undefined ? {} : { volume_name: snapshot.volume_name }),
    ...(snapshot.act === undefined ? {} : { act: snapshot.act }),
    ...(snapshot.act_progress === undefined ? {} : { act_progress: snapshot.act_progress }),
    phases: snapshot.phases,
    blocking: snapshot.blocking,
    finished: snapshot.finished,
    ...(snapshot.book === undefined ? {} : { book: snapshot.book }),
    ...(snapshot.quality === undefined ? {} : { quality: snapshot.quality }),
    ...(snapshot.health === undefined ? {} : { health: snapshot.health }),
    ...(snapshot.bookData === undefined ? {} : { bookData: snapshot.bookData }),
    ...(snapshot.pending === undefined ? {} : { pending: snapshot.pending }),
    ...(snapshot.activity === undefined ? {} : { activity: snapshot.activity }),
    ...(snapshot.advisories === undefined ? {} : { advisories: snapshot.advisories }),
    ...(snapshot.acknowledgedAdvisories === undefined
      ? {}
      : { acknowledgedAdvisories: snapshot.acknowledgedAdvisories }),
    ...(snapshot.legacy === undefined ? {} : { legacy: snapshot.legacy }),
    ...(snapshot.next === undefined
      ? {}
      : { next: { tool: snapshot.next.tool, reason: snapshot.next.reason } }),
  }
}

export function projectChapters(snapshot: PanelSnapshot): PanelChaptersDto {
  // Keep the payload bounded for a long book. `projectSummary` still reports
  // the true total; the panel only renders recent history. An active draft is
  // part of that history, so reserve one of the thirty slots for it instead of
  // appending a thirty-first row.
  const draft = snapshot.draft
  const draftNeedsRow =
    draft !== undefined && draft !== null && !snapshot.chapters.some((row) => row.num === draft.num)
  const archivedLimit = draftNeedsRow ? PANEL_CHAPTER_LIMIT - 1 : PANEL_CHAPTER_LIMIT
  const rows = snapshot.chapters.slice(-archivedLimit).map(projectChapter)
  if (draftNeedsRow) {
    rows.push({
      num: draft.num,
      title: draft.title,
      wordCount: draft.wordCount,
      score: draft.score,
      stage: snapshot.stage,
      status: draft.status,
      details: draft.details,
    })
  }
  return { schemaVersion: REMOTE_VERSION, panelId: PANEL_ID, rows }
}

export function projectGates(snapshot: PanelSnapshot): PanelGatesDto {
  return {
    schemaVersion: REMOTE_VERSION,
    panelId: PANEL_ID,
    stage: snapshot.stage,
    blocking: snapshot.blocking,
    explanations: snapshot.blocking.map(
      (item) => `${item.code}${item.scope === undefined ? '' : ` (${item.scope})`}: ${item.detail}`,
    ),
  }
}
