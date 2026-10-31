/**
 * Public contracts of the engine. Everything else in `src/` is an implementation
 * detail; adapters (tools, commands, panel, presets) may only import this file
 * and the engine service.
 */

/** On-disk schema version for every YAML file the engine owns. */
export const SCHEMA_VERSION = 1 as const

/** Pipeline control-flow state. This is the state machine value, not a brief id. */
export type Stage = 'idle' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'ready_to_archive' | 'done'

/** Brief (task book) ids. `P7`/`P9` are transactions and never hand out a brief. */
export type BriefStage = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P8'

/** The twelve supported commercial genres. */
export const GENRES = [
  '玄幻修仙',
  '都市现代',
  '西方奇幻',
  '悬疑推理',
  '科幻',
  '游戏系统',
  '历史架空',
  '无限流',
  '轻小说',
  '军事',
  '末世流',
  '言情',
] as const
export type Genre = (typeof GENRES)[number]

/** Platform style profiles. */
export const PLATFORMS = ['fanqie', 'qidian', 'qimao', 'jinjiang'] as const
export type Platform = (typeof PLATFORMS)[number]

/** Scene types used by rhythm budgets and PG-06. */
export const SCENE_TYPES = ['战斗/动作章', '日常过渡章', '情感爆发章', '纯叙事章'] as const
export type SceneType = (typeof SCENE_TYPES)[number]

/** A violation is blocking unless the rule pack declares it advisory. */
export type Severity = 'blocker' | 'advisory'

/** All thirty-two service operations (22 inherited + 9 book-level + restoreBackup). */
export const OPERATIONS = [
  'initProject',
  'archiveChapter',
  'amend',
  'rollback',
  'reopenChapter',
  'submitWorldPlan',
  'submitChapterPlan',
  'submitDraft',
  'submitReview',
  'submitRevision',
  'runCheck',
  'submitBookPlan',
  'submitOutline',
  'importOutline',
  'submitWorldbook',
  'getStatus',
  'getBrief',
  'countWords',
  'queryState',
  'diff',
  'auditHistory',
  'advise',
  'search',
  'doctor',
  'report',
  'guide',
  'export',
  'panelSummary',
  'panelChapters',
  'panelGates',
  'stats',
  'restoreBackup',
] as const
export type Operation = (typeof OPERATIONS)[number]

/** Structured, non-fatal note attached to a successful result. */
export interface Warning {
  code: string
  message: string
}

/** One reason a gate refused progress. */
export interface BlockingItem {
  code: string
  scope?: string
  detail: string
  hint?: string
}

/** Uniform success envelope of every service operation. */
export interface OpResult<T> {
  data: T
  revision: number
  warnings: Warning[]
  /** True when an idempotent retry was answered from the replay cache. */
  replayed?: boolean
}

/** A single reading-proof reference: the quoted text, its paragraph and chapter. */
export interface ReadingProofReference {
  chapter?: number
  paragraph: number
  quote: string
}

/** Three references proving the model read the chapter it claims to review. */
export interface ReadingProof {
  opening: ReadingProofReference
  middle: ReadingProofReference
  ending: ReadingProofReference
}

/** Error families map one-to-one to the three repair actions a caller can take. */
export const ERROR_CODES = {
  PROJECT_NOT_FOUND: 'ENGINE_PROJECT_NOT_FOUND',
  PROJECT_AMBIGUOUS: 'ENGINE_PROJECT_AMBIGUOUS',
  PROJECT_MISSING: 'ENGINE_PROJECT_MISSING',
  PROJECT_IDENTITY_MISMATCH: 'ENGINE_PROJECT_IDENTITY_MISMATCH',
  PROJECT_EXISTS: 'ENGINE_PROJECT_EXISTS',
  STAGE_ORDER: 'ENGINE_STAGE_ORDER',
  /** The exact same keyed submission already failed in the same context. */
  RETRY_UNCHANGED: 'ENGINE_RETRY_UNCHANGED',
  GATE_BLOCKED: 'ENGINE_GATE_BLOCKED',
  CHECK_SUBMISSION_INVALID: 'ENGINE_CHECK_SUBMISSION_INVALID',
  PENDING_PARTIAL: 'ENGINE_PENDING_PARTIAL',
  IO_PERMISSION: 'ENGINE_IO_PERMISSION',
  READING_PROOF_INVALID: 'ENGINE_READING_PROOF_INVALID',
  SCORE_MISMATCH: 'ENGINE_SCORE_MISMATCH',
  /** A revision tried to rewrite reviewer-owned issue fields. */
  ISSUE_IMMUTABLE: 'ENGINE_ISSUE_IMMUTABLE',
  DELTA_UNVERIFIED: 'ENGINE_DELTA_UNVERIFIED',
  RESOURCE_NEGATIVE_BALANCE: 'ENGINE_RESOURCE_NEGATIVE_BALANCE',
  SCHEMA_TOO_NEW: 'ENGINE_SCHEMA_TOO_NEW',
  SCHEMA_INVALID: 'ENGINE_SCHEMA_INVALID',
  PATH_ESCAPE: 'ENGINE_PATH_ESCAPE',
  LOCK_TIMEOUT: 'ENGINE_LOCK_TIMEOUT',
  TXN_ABORTED: 'ENGINE_TXN_ABORTED',
  JOURNAL_MISSING: 'ENGINE_JOURNAL_MISSING',
  TXN_IN_PROGRESS: 'ENGINE_TXN_IN_PROGRESS',
  RULEPACK_INVALID: 'ENGINE_RULEPACK_INVALID',
  ID_EXHAUSTED: 'ENGINE_ID_EXHAUSTED',
  CONFIG_INVALID: 'ENGINE_CONFIG_INVALID',
} as const
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** Base class: carries a stable machine-readable code and an actionable hint. */
export class EngineError extends Error {
  readonly code: string
  readonly hint: string | undefined

  constructor(code: string, message: string, hint?: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
    this.code = code
    this.hint = hint
  }
}

/** Bad arguments or illegal preconditions: the model must change its call. */
export class EngineInputError extends EngineError {}

/** Content did not pass a gate: the author must change the manuscript. */
export class EngineBlockedError extends EngineError {
  readonly blocking: BlockingItem[]

  constructor(code: string, message: string, blocking: BlockingItem[], hint?: string) {
    super(code, message, hint)
    this.blocking = blocking
  }
}

/** System fault: the environment or the code is wrong, not the caller. */
export class EngineFaultError extends EngineError {}

/** Convenience constructor set, kept close to the classes so adapters agree. */
export const inputError = (code: string, message: string, hint?: string): EngineInputError =>
  new EngineInputError(code, message, hint)
export const blockedError = (
  code: string,
  message: string,
  blocking: BlockingItem[],
  hint?: string,
): EngineBlockedError => new EngineBlockedError(code, message, blocking, hint)
export const faultError = (code: string, message: string, cause?: unknown): EngineFaultError =>
  new EngineFaultError(code, message, undefined, cause === undefined ? undefined : { cause })

/** One deduction inside one scoring dimension. */
export interface Deduction {
  rule: string
  location: string
  delta: number
  note: string
}

/** One of the fifteen scoring dimensions. */
export interface ScoreDimension {
  id: string
  max: number
  deductions: Deduction[]
}

/** A review issue; blockers cannot be waived. */
export interface ReviewIssue {
  id: string
  severity: Severity
  dimension: string
  location: string
  problem: string
  fix: string
  status: 'open' | 'fixed' | 'waived'
  evidence?: string
}

/** The persisted review document. */
export interface ReviewDocument {
  schema_version: 1
  chapter: number
  round: number
  content_hash: string
  dimensions: ScoreDimension[]
  issues: ReviewIssue[]
  total: number
  /** The three reading proofs accepted at P4; PG-09 re-verifies them at P6. */
  proof?: ReadingProof
}

/** Structured machine finding. */
export interface Violation {
  code: string
  severity: Severity
  location: { paragraph: number }
  detail: string
}

/** Metric block produced by the machine pass. */
export interface MachineMetrics {
  total_word_count: number
  non_empty_lines: number
  dialogue_lines: number
  dialogue_ratio: number
  paragraph_max: number
}

/** The persisted check document. */
export interface CheckDocument {
  schema_version: 1
  chapter: number
  scope: string[]
  content_hash: string
  machine: { violations: Violation[]; advisories?: Violation[]; metrics: WordMetrics }
  semantic: {
    items: Array<{ id: string; verdict: 'pass' | 'fail'; evidence: string; note: string }>
    /** 0.2.5: explain a persisted content failure; historical checks omit it. */
    findings?: BlockingItem[]
  }
  /** Advisory codes the author has explicitly acknowledged for this content. */
  acknowledged?: string[]
  /** 0.2.5: content failures consume the check budget; submission errors never persist. */
  failure_class?: 'submission' | 'content'
  counted?: boolean
  verdict: 'pass' | 'fail'
}

/** Every persisted document whose damage status/panel can report. */
export type StateErrorCode =
  | 'PROJECT_UNREADABLE'
  | 'PIPELINE_UNREADABLE'
  | 'PLAN_UNREADABLE'
  | 'WORLD_PLAN_UNREADABLE'
  | 'REVIEW_UNREADABLE'
  | 'CHECK_UNREADABLE'
  | 'CHAPTERS_UNREADABLE'
  | 'CHARACTERS_UNREADABLE'
  | 'WORLD_UNREADABLE'
  | 'LOCKS_UNREADABLE'
  | 'TIMELINE_UNREADABLE'
  | 'FORESHADOWS_UNREADABLE'
  | 'RELATIONSHIPS_UNREADABLE'
  | 'HANDOFF_UNREADABLE'
  | 'OUTLINE_UNREADABLE'
  | 'WORLDBOOK_UNREADABLE'

/** A state document that exists but cannot be read safely. */
export interface StateError {
  path: string
  code: StateErrorCode
  message: string
}

/** Word statistics with the single engine-wide counting rule. */
export interface WordMetrics {
  total_word_count: number
  cjk_chars: number
  english_words: number
  numbers: number
  chinese_punct: number
  english_punct: number
  /** All punctuation counted by the engine; total = cjk + words + numbers + punctuation. */
  punctuation_chars: number
  non_ws_chars: number
  total_lines: number
  non_empty_lines: number
  dialogue_lines: number
  dialogue_ratio: number
  paragraph_count: number
  paragraph_max_words: number
}

/** Derived chapter row kept in `state/chapters.yaml`. */
export interface ChapterRecord {
  num: number
  title: string
  file: string
  word_count: number
  dialogue_lines: number
  dialogue_ratio: number
  scene_type: SceneType
  narrator: string
  score: number
  status: 'draft' | 'reviewed'
  content_hash: string
  summary: ChapterSummary
  /** How hard this chapter was before it was archived. */
  rounds?: RoundCounters
  final_check?: 'pass' | 'fail'
  archived_at?: string
  /** Keys allocated by the archive transaction; lets a cross-process retry replay. */
  assigned_ids?: Record<string, string>
  /** Digest of the archive request that produced this row. */
  archive_digest?: string
}

/** Summary block the model supplies with a draft and the engine persists. */
export interface ChapterSummary {
  events: string[]
  characters_appeared: string[]
  foreshadows: {
    planted: Array<{ key: string; title: string; description: string; anchor?: string }>
    advanced: Array<{ key: string; note: string; new_info: boolean }>
    resolved: string[]
  }
  new_elements: { locations: string[]; abilities: string[]; artifacts: string[] }
  /** Optional P3/P5 verbatim manuscript anchors for readable entity names. */
  new_element_anchors?: {
    locations?: Record<string, string[]>
    abilities?: Record<string, string[]>
    artifacts?: Record<string, string[]>
  }
  resource_changes: Array<{ character: string; resource: string; delta: number; reason: string }>
  opening: string
  continuity: { opens_from: string; ends_with: string }
  hook_strength: number
  pleasure_points: string[]
  plot_advancement: 'high' | 'mid' | 'low'
}

/** Round counters live in the pipeline and are engine-owned. */
export interface RoundCounters {
  review: number
  revise: number
  check: number
  /** Lifetime rollback count on a chapter record; never stored in the live pipeline. */
  rollbacks?: number
}

/** How one ledger entity changed in this chapter. */
export type DeltaAction = 'created' | 'updated' | 'no_change'

/** One character declaration inside `state_delta.characters`. */
export interface CharacterDelta {
  action: DeltaAction
  reason?: string
  role?: string
  profile?: Record<string, unknown>
  current_state?: Record<string, unknown>
  /** Chapter is engine-assigned from the archive transaction, not caller-supplied. */
  growth?: { change: string; status_change: string }
}

/** One world entity declaration inside `state_delta.world`. */
export interface WorldDelta {
  action: DeltaAction
  reason?: string
  kind?: 'location' | 'ability' | 'artifact' | 'faction' | 'rule'
  description?: string
  layout?: string
  capacity?: number
  detail?: Record<string, unknown>
}

/** One foreshadow declaration inside `state_delta.foreshadows`. */
export interface ForeshadowDelta {
  action: DeltaAction
  reason?: string
  title?: string
  /** Verbatim manuscript quote used for verification; title stays a readable label. */
  anchor?: string
  description?: string
  note?: string
  new_info?: boolean
}

/** One timeline-event declaration; keys are `summary.events` indices. */
export interface TimelineDelta {
  action: DeltaAction
  reason?: string
  story_time?: string
  description?: string
  location?: string
  characters?: string[]
}

/** One relationship declaration; keys are `"a|b"`. */
export interface RelationshipDelta {
  action: DeltaAction
  reason?: string
  a?: string
  b?: string
  type?: string
  description?: string
  note?: string
}

/**
 * The archive reconciliation sheet. Every entity the chapter claims (appeared
 * characters, new world elements, foreshadow keys, events, relationships) must
 * appear here; omission is a hard error, never an implicit no_change.
 */
export interface StateDelta {
  characters: Record<string, CharacterDelta>
  foreshadows: Record<string, ForeshadowDelta>
  timeline: Record<string, TimelineDelta>
  world: Record<string, WorldDelta>
  relationships: Record<string, RelationshipDelta>
}

/** Optional handoff override; omitted values are derived by the engine. */
export interface ArchiveHandoff {
  volume?: number
  volume_name?: string
  act?: string
  act_progress?: string
}

/** One issued task-book receipt; the brief itself is rendered on demand. */
export interface BriefReceipt {
  chapter: number
  stage: BriefStage
  digest: string
  issued_at: string
}

/** `state/briefs.yaml`: append-only task-book evidence outside content transactions. */
export interface BriefReceiptsDocument {
  schema_version: 1
  receipts: BriefReceipt[]
}

/** The active draft's own metadata; P2 plan stays immutable after submission. */
export interface DraftState {
  chapter: number
  title: string
  scene_type: SceneType
  narrator: string
  summary: ChapterSummary
  content_hash: string
  updated_at: string
}

/** Pipeline document (`state/pipeline.yaml`). */
export interface PipelineState {
  schema_version: 1
  revision: number
  chapter: number
  stage: Stage
  rounds: RoundCounters
  briefs: Record<string, { issued_at: string; digest: string }>
  blocking: BlockingItem[]
  /** Current draft summary/title; never written into the P2 plan file. */
  draft?: DraftState
  /** Hash of the review document last written by submitReview/submitRevision. */
  review_digest?: string
  last_action: { op: string; at: string; digest: string } | null
}

/** Chapter index document (`state/chapters.yaml`). */
export interface ChaptersDocument {
  schema_version: 1
  chapters: ChapterRecord[]
}

/** Character registry document. */
export interface CharactersDocument {
  schema_version: 1
  characters: Array<{
    name: string
    role: string
    first_appearance: number
    profile: Record<string, unknown>
    current_state: Record<string, unknown>
    growth: Array<{ chapter: number; change: string; status_change: string }>
    updated_at: number
  }>
}

/** World registry document. */
export interface WorldDocument {
  schema_version: 1
  locations: Array<{
    name: string
    /** 0.2.6 additive: readable-name anchors; old ledgers omit this. */
    anchors?: string[]
    first_appearance: number
    locked: boolean
    description: string
    layout: string
    capacity: number
    changes: Array<{ chapter: number; change: string; reason: string }>
  }>
  abilities: unknown[]
  artifacts: unknown[]
  factions: unknown[]
  rules: unknown[]
}

/** Locked first-appearance snapshots. */
export interface LocksDocument {
  schema_version: 1
  locked_at_chapter: number
  characters: Record<string, { first_appearance: number; locked_at: number; appearance: string }>
  locations: Record<string, { first_appearance: number; locked_at: number; layout: string; capacity: number }>
}

/** Foreshadow ledger document. */
export interface ForeshadowsDocument {
  schema_version: 1
  next_seq: number
  items: Array<{
    id: string
    title: string
    planted: number
    last_touched: number
    status: 'planted' | 'dormant' | 'advanced' | 'resolved'
    resolved_at: number | null
    description: string
    anchor?: string
    /** New 0.2.3 writes are distinguishable from pre-0.2.3 rows by this marker. */
    format_version?: 1
    advance_log: Array<{ chapter: number; note: string; new_info: boolean }>
  }>
}

/** Timeline ledger document. */
export interface TimelineDocument {
  schema_version: 1
  next_seq: number
  items: Array<{
    id: string
    chapter: number
    story_time: string
    description: string
    location: string
    characters: string[]
  }>
}

/** Relationship ledger document. */
export interface RelationshipsDocument {
  schema_version: 1
  next_seq: number
  items: Array<{
    id: string
    a: string
    b: string
    type: string
    since: number
    description: string
    evolution: Array<{ chapter: number; note: string }>
  }>
}

/** Handoff document (`state/handoff.yaml`). */
export interface HandoffDocument {
  schema_version: 1
  current_chapter: number
  volume: number
  volume_name: string
  act: string
  act_progress: string
  next_chapter: number
  last_summary: string
  open_hooks: Array<{ id: string; title: string }>
  updated_at: string
}

/** Project definition (`novel.yaml`). */
export interface NovelProject {
  schema_version: 1
  title: string
  genre: Genre
  platform: Platform
  author: string
  description: string
  created_at: string
  targets: {
    words_per_chapter: [number, number]
    total_chapters: number | null
    dialogue_ratio: [number, number]
  }
}

/** World plan (`plans/chNNN.world.yaml`). */
export interface WorldPlanInput {
  chapter: number
  objective: string
  constraints: string[]
  characters: Array<{ name: string; role: string; current_state: string }>
  locations: Array<{ name: string; layout: string; capacity: number }>
  continuity_notes: string[]
}

/** A character the chapter plan puts on stage; no new persisted schema. */
export interface ChapterCastMember {
  name: string
  entry_state?: string
  goal?: string
  knowledge?: string[]
  exit_change?: string
}

/** Chapter plan (`plans/chNNN.chapter.yaml`). */
export interface ChapterPlanInput {
  chapter: number
  title: string
  scene_type: SceneType
  narrator: string
  beats: string[]
  opening: string
  ending: string
  target_words: [number, number]
  /** Optional in 0.1.3: older plans remain readable; new plans may name 1–8 actors. */
  cast?: ChapterCastMember[]
}

/* ------------------------------------------------------- 0.2.0 book layer */

/** Book-level pitch and structure, persisted in `outline/outline.yaml`. */
export interface BookPlan {
  premise: string
  logline: string
  themes: string[]
  tone: string
  pov: string
  audience: string
  selling_points: string[]
  ending: string
  /** Strict mode requires a chapter card before P2/P3 for every chapter. */
  strict: boolean
  /** True once the author explicitly chose strict on/off; used for the first-outline default. */
  strict_explicit?: boolean
}

/** One volume of the planned book. `end_chapter` is inclusive. */
export interface OutlineVolume {
  id: string
  title: string
  start_chapter: number
  end_chapter: number
  goal: string
  arc: string
  climax: string
  status: 'planned' | 'writing' | 'done'
}

/** One planned chapter card. Only the archive transaction may write the archived fields. */
export interface OutlineChapter {
  num: number
  volume: number | null
  title: string
  scene_type: SceneType
  goal: string
  conflict: string
  hook: string
  cast: string[]
  target_words: [number, number]
  notes: string
  status: 'planned' | 'archived'
  archived_at: string | null
  word_count: number | null
  score: number | null
}

/** The planning SSOT read by P1–P8, PG-13, report, doctor and export. */
export interface OutlineDocument {
  schema_version: 1
  updated_at: string
  book: BookPlan
  volumes: OutlineVolume[]
  chapters: OutlineChapter[]
}

/** One worldbuilding rule/constraint. */
export interface WorldbookRule {
  name: string
  description: string
}

/** One faction in the world bible. */
export interface WorldbookFaction {
  name: string
  description: string
  goal: string
}

/** One location in the world bible. */
export interface WorldbookLocation {
  name: string
  description: string
  layout: string
  capacity: number
}

/** One planned character (not the post-prose ledger entry). */
export interface WorldbookCharacter {
  name: string
  role: string
  description: string
  arc: string
}

/** One glossary entry. */
export interface WorldbookGlossary {
  term: string
  definition: string
}

/** One backstory event. */
export interface WorldbookBackstory {
  time: string
  event: string
}

/** One declared numeric canon, checked against the manuscript on request. */
export interface WorldbookFact {
  alias: string
  value: number
  unit: string
  tolerance?: number
  note?: string
}

/** Worldbuilding plan, persisted in `outline/worldbook.yaml`. */
export interface WorldbookDocument {
  schema_version: 1
  updated_at: string
  premise: string
  setting: string
  rules: WorldbookRule[]
  factions: WorldbookFaction[]
  locations: WorldbookLocation[]
  characters: WorldbookCharacter[]
  glossary: WorldbookGlossary[]
  backstory: WorldbookBackstory[]
  /** Optional numeric canon; old documents omit it. */
  facts?: WorldbookFact[]
  themes: string[]
}

/** One hit from `novel_search`; the scope names the source family. */
export interface SearchResultItem {
  kind: 'chapters' | 'summaries' | 'outline' | 'worldbook' | 'ledgers'
  chapter?: number
  title?: string
  paragraph?: number
  snippet: string
}

/** Search response; `total` counts every matching segment, `results` is capped by `limit`. */
export interface SearchReport {
  query: string
  scope: 'all' | 'chapters' | 'summaries' | 'outline' | 'worldbook' | 'ledgers'
  total: number
  truncated: boolean
  results: SearchResultItem[]
}

/** One structured health check. */
export interface DoctorCheck {
  id: string
  severity: 'ok' | 'info' | 'warning' | 'error'
  title: string
  detail: string
  hint?: string
}

/** `novel_doctor` payload; a missing project is reported, never thrown. */
export interface DoctorReport {
  ok: boolean
  root: string
  checks: DoctorCheck[]
  summary: { errors: number; warnings: number; infos: number }
}

/** One canonical outline-progress calculation shared by every adapter. */
export interface OutlineProgress {
  present: boolean
  target: number | null
  total: number
  planned: number
  archived: number
  missingCards: number
  plannedCoverage: number | null
  archivedCoverage: number | null
  /** Compatibility alias: planned coverage when a target exists, otherwise card coverage. */
  coverage: number
  /** Fraction of archived chapters that have a matching archived card. */
  cardCoverage: number
  volumes: number
}

/** Book-wide quality, outline, cast and pacing aggregates. */
export interface BookReport {
  progress: {
    archived: number
    target: number | null
    words: number
    average_words: number
    percent: number
    remaining_words: number | null
    remaining_words_min: number | null
    remaining_words_average: number | null
    remaining_words_basis: 'actual_average' | 'minimum_target' | 'none'
  }
  outline: {
    present: boolean
    strict: boolean
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
    drift: Array<{ chapter: number; field: string; planned: string; actual: string }>
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
    /** 0.2.6 persisted world-ledger anchors, capped for report payloads. */
    anchors?: Array<{ name: string; kind: string; anchors: string[] }>
  }
  quality: {
    average: number
    median: number
    min: number
    max: number
    last_five: number[]
    /** Null when there are not enough distinct chapter reviews to compare. */
    trend: number | null
    trend_basis: 'last_five_vs_previous_five' | 'insufficient_samples' | 'insufficient_history'
    /** Number of chapters represented by a final review. */
    samples: number
    /** Committed review rounds for this report, including history. */
    attempts: number
    dimensions: Array<{ id: string; average: number; samples: number }>
  }
  /** Per-chapter effort survives archive (pipeline rounds are reset). */
  effort: {
    reviews: number
    revisions: number
    checks: number
    rollbacks: number
    chapters: Array<{
      num: number
      reviews: number
      revisions: number
      checks: number
      rollbacks: number
      final_check: 'pass' | 'fail' | null
      archived_at: string | null
    }>
  }
  pacing: {
    scene_types: Record<string, number>
    hook_strength: Record<string, number>
    plot_advancement: Record<string, number>
    longest: { chapter: number; words: number } | null
    shortest: { chapter: number; words: number } | null
  }
  cast: {
    total: number
    top: Array<{ name: string; appearances: number; last_seen: number; role: string }>
  }
  foreshadows: {
    open: number
    dormant: number
    overdue: number
    resolved: number
    oldest: Array<{ id: string; title: string; last_touched: number; age: number }>
  }
  timeline: { events: number; first_chapter: number | null; last_chapter: number | null }
  relationships: { total: number; types: Record<string, number> }
  activity: Array<{ at: string; op: string; chapter: number; status: string }>
  warnings: string[]
}

/** One onboarding step. */
export interface GuideStep {
  id: string
  title: string
  detail: string
  done: boolean
  tool?: string
}

/** `novel_guide` payload. */
export interface GuideReport {
  state: 'no-project' | 'new' | 'planning' | 'writing' | 'blocked' | 'finished'
  title: string
  steps: GuideStep[]
  next: { tool: string; args: Record<string, unknown>; reason: string }
  commands: string[]
  tips: string[]
}

/** Draft submission payload. */
export interface DraftInput {
  chapter: number
  content: string
  chapter_title: string
  scene_type: SceneType
  narrator: string
  summary: ChapterSummary
}

/** Review submission payload. */
export interface ReviewInput {
  chapter: number
  dimensions: ScoreDimension[]
  issues: ReviewIssue[]
  /** The model's claimed headline score; checked against 150 - Σdelta. */
  total: number
  proof: ReadingProof
}

/** One exact, unique replacement used by patch-mode revisions. */
export interface RevisionEdit {
  old_text: string
  new_text: string
  /** 1-based occurrence; defaults to requiring exactly one match. */
  occurrence?: number
}

/** Patch-mode revision; content and patch are mutually exclusive. */
export interface RevisionPatch {
  expected_hash: string
  edits: RevisionEdit[]
}

/** Revision submission payload. */
export interface RevisionInput {
  chapter: number
  content?: string
  patch?: RevisionPatch
  summary: ChapterSummary
}

/** Semantic check items supplied by the model. */
export interface SemanticItem {
  id: string
  verdict: 'pass' | 'fail'
  evidence: string
  note: string
}

/** Everything a gate evaluation needs, gathered by the engine before writing. */
export interface GateInput {
  operation: Operation
  stage: Stage
  text: string
  chapter: number
  project: NovelProject
  pipeline: PipelineState
  chapters: ChaptersDocument
  briefDigest: string | null
  briefStage: BriefStage | null
  draftTitle: string | null
  sceneType: SceneType | null
  /** The submitted/active plan narrator; PG-05 uses it before a draft exists. */
  narrator?: string | null
  summary: ChapterSummary | null
  /** P5 may omit `summary`; when omitted, the previous plan summary is reused. */
  summaryProvided?: boolean
  /** Summary-only repair: no manuscript change, no P4/P6 proof requirement. */
  summaryOnly?: boolean
  /** The last write was a summary-only repair; P6 may continue without a new brief. */
  summaryOnlyRevision?: boolean
  review: ReviewDocument | null
  check: CheckDocument | null
  /** When set, result-bearing gates run only the named check scopes. */
  scope?: string[]
  semantic: SemanticItem[]
  proof: ReadingProof | null
  rounds: RoundCounters
  /** Facts PG-12 checks before the archive transaction starts. */
  archive: { chapterExists: boolean; checkPassed: boolean; hashMatches: boolean } | null
  evidence: {
    characters: CharactersDocument | null
    foreshadows: ForeshadowsDocument | null
    timeline: TimelineDocument | null
    relationships: RelationshipsDocument | null
    world: WorldDocument | null
    locks: LocksDocument | null
  }
  previousText: string | null
  /** The three preceding chapters, newest first, for the duplicate rule. */
  previousTexts: string[]
  priorSceneTypes: SceneType[]
  /** 0.2.0 planning input; undefined means "no outline" for older fixtures. */
  outline?: OutlineDocument | null
  /** The chapter plan's target range, used by PG-13. */
  planTargetWords?: [number, number] | null
  /** The chapter plan's declared cast names, used by PG-13. */
  planCast?: string[] | null
}

/** Gate evaluation outcome. */
export interface GateResult {
  passed: boolean
  blocking: BlockingItem[]
}

/** A chapter row projected to the panel and status output. */
export interface ChapterStatusRow {
  num: number
  title: string
  word_count: number
  score: number
  stage: Stage
  passed: boolean
}

/** Where an omitted project root came from. */
export type SelectionSource = 'explicit' | 'session' | 'workspace' | 'active' | 'config' | 'single'

/** One resolved project choice, before the project is loaded. */
export interface Selection {
  root: string
  source: SelectionSource
  title?: string
  created_at?: string
}

/**
 * One human-readable projection of the pipeline's chapter boundary.
 *
 * `pipeline.chapter`/`stage` are protocol values: after archiving chapter N the
 * pipeline points at N+1 and still says `done` because `done` describes the
 * chapter that was just archived. This projection is the only place that turns
 * those values into "chapter N archived; chapter N+1 starts at P1".
 */
export interface ChapterProgress {
  active_chapter: number
  stage: Stage
  /** The chapter currently being written; null while `stage === 'done'`. */
  current: { chapter: number; stage: Stage } | null
  /** Highest archived chapter, or null before the first archive. */
  last_archived: number | null
  /** Next chapter to start at P1; null while writing or after the book is finished. */
  next: { chapter: number; stage: 'P1' } | null
  /** True only when the configured target has been reached at `stage === 'done'`. */
  finished: boolean
  /** One line for status cards, commands and the panel. */
  label: string
  /** Sentence used by the resume prompt instead of "当前第 N 章，阶段 done". */
  resume: string
}

/** The `getStatus` payload. */
export interface StatusReport {
  project: { title: string; genre: Genre; platform: Platform; root: string }
  /** Why this project was chosen; lets the model notice a wrong book. */
  selection?: { source: SelectionSource; root: string }
  /** The chapter requested for metrics; may be historical. */
  chapter: number
  /** The chapter the pipeline is currently working on. */
  active_chapter: number
  /** SHA-256 of the active manuscript, or null when the stage has no draft. */
  manuscript_hash: string | null
  stage: Stage
  /** Chapter-boundary projection shared by every human-readable surface. */
  progress?: ChapterProgress
  rounds: RoundCounters
  blocking: BlockingItem[]
  /** Non-blocking recovery notes, e.g. a recoverable pending transaction. */
  warnings?: Warning[]
  /** plan/review/check/ledger files that exist but cannot be read safely. */
  state_errors: StateError[]
  metrics: WordMetrics | null
  /** Inherited handoff labels; absent before the first archive. */
  volume?: number
  volume_name?: string
  act?: string
  act_progress?: string
  /** 0.2.0 book-level visibility; absent on older synthetic payloads. */
  book?: {
    premise: string
    logline: string
    strict: boolean
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
      volumes: number
      current: OutlineChapter | null
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
  next: { tool: string; args: Record<string, unknown>; reason: string }
}

/** `advise` answer: which tool to call next and why. */
export interface AdviceReport {
  stage: Stage
  chapter: number
  /** Same chapter-boundary projection as getStatus. */
  progress?: ChapterProgress
  tool: string
  args: Record<string, unknown>
  reason: string
  blocking: BlockingItem[]
  state_errors: StateError[]
}

/** One history row derived from the journal. */
export interface AuditRow {
  /** Stable chronological cursor; absent only on hand-built test rows. */
  seq?: number
  at: string
  op: string
  chapter: number
  revision: number
  txid: string
  status: 'committed' | 'aborted'
  files: string[]
  /** Machine code and human reason for a refused attempt. */
  code?: string
  reason?: string
  hint?: string
  stage?: string
  /** True when no transaction started: the gate/input refused the call. */
  attempt?: boolean
  blocking?: BlockingItem[]
  /** Keyed operation fingerprint; lets an identical failed retry be refused. */
  retry_key?: string
  /** Brief/stage/revision context for `retry_key`. */
  retry_context?: string
}

/** One diff hunk between two revisions of a chapter. */
export interface DiffReport {
  chapter: number
  before: string
  after: string
  added: number
  removed: number
  hunks: Array<{ kind: 'add' | 'remove' | 'same'; line: string }>
}

/** Export capabilities; the last three are book-planning deliverables. */
export type ExportKind = 'md' | 'txt' | 'epub' | 'outline' | 'worldbook' | 'proposal'
