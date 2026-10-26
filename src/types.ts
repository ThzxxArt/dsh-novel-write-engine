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

/** All twenty-two service operations. */
export const OPERATIONS = [
  'initProject',
  'archiveChapter',
  'amend',
  'rollback',
  'submitWorldPlan',
  'submitChapterPlan',
  'submitDraft',
  'submitReview',
  'submitRevision',
  'runCheck',
  'getStatus',
  'getBrief',
  'countWords',
  'queryState',
  'diff',
  'auditHistory',
  'advise',
  'export',
  'panelSummary',
  'panelChapters',
  'panelGates',
  'stats',
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
  PROJECT_EXISTS: 'ENGINE_PROJECT_EXISTS',
  STAGE_ORDER: 'ENGINE_STAGE_ORDER',
  GATE_BLOCKED: 'ENGINE_GATE_BLOCKED',
  READING_PROOF_INVALID: 'ENGINE_READING_PROOF_INVALID',
  SCORE_MISMATCH: 'ENGINE_SCORE_MISMATCH',
  DELTA_UNVERIFIED: 'ENGINE_DELTA_UNVERIFIED',
  RESOURCE_NEGATIVE_BALANCE: 'ENGINE_RESOURCE_NEGATIVE_BALANCE',
  SCHEMA_TOO_NEW: 'ENGINE_SCHEMA_TOO_NEW',
  SCHEMA_INVALID: 'ENGINE_SCHEMA_INVALID',
  PATH_ESCAPE: 'ENGINE_PATH_ESCAPE',
  LOCK_TIMEOUT: 'ENGINE_LOCK_TIMEOUT',
  TXN_ABORTED: 'ENGINE_TXN_ABORTED',
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
  machine: { violations: Violation[]; metrics: WordMetrics }
  semantic: {
    items: Array<{ id: string; verdict: 'pass' | 'fail'; evidence: string; note: string }>
  }
  verdict: 'pass' | 'fail'
}

/** Word statistics with the single engine-wide counting rule. */
export interface WordMetrics {
  total_word_count: number
  cjk_chars: number
  english_words: number
  numbers: number
  chinese_punct: number
  english_punct: number
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
}

/** Summary block the model supplies with a draft and the engine persists. */
export interface ChapterSummary {
  events: string[]
  characters_appeared: string[]
  foreshadows: {
    planted: Array<{ key: string; title: string; description: string }>
    advanced: Array<{ key: string; note: string; new_info: boolean }>
    resolved: string[]
  }
  new_elements: { locations: string[]; abilities: string[]; artifacts: string[] }
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
  growth?: { chapter: number; change: string; status_change: string }
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

/** Pipeline document (`state/pipeline.yaml`). */
export interface PipelineState {
  schema_version: 1
  revision: number
  chapter: number
  stage: Stage
  rounds: RoundCounters
  briefs: Record<string, { issued_at: string; digest: string }>
  blocking: BlockingItem[]
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

/** Revision submission payload. */
export interface RevisionInput {
  chapter: number
  content: string
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
  summary: ChapterSummary | null
  /** P5 may omit `summary`; when omitted, the previous plan summary is reused. */
  summaryProvided?: boolean
  review: ReviewDocument | null
  check: CheckDocument | null
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

/** The `getStatus` payload. */
export interface StatusReport {
  project: { title: string; genre: Genre; platform: Platform; root: string }
  chapter: number
  stage: Stage
  rounds: RoundCounters
  blocking: BlockingItem[]
  metrics: WordMetrics | null
  next: { tool: string; args: Record<string, unknown>; reason: string }
}

/** `advise` answer: which tool to call next and why. */
export interface AdviceReport {
  stage: Stage
  chapter: number
  tool: string
  args: Record<string, unknown>
  reason: string
  blocking: BlockingItem[]
}

/** One history row derived from the journal. */
export interface AuditRow {
  at: string
  op: string
  chapter: number
  revision: number
  txid: string
  status: 'committed' | 'aborted'
  files: string[]
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

/** Export capabilities. */
export type ExportKind = 'md' | 'txt' | 'epub'
