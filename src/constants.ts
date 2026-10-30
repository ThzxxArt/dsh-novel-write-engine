import type { Genre, Platform, SceneType, Stage } from './types.js'

/** Panel and session identifiers. */
export const PLUGIN_NAME = 'dsh-novel-write-engine'
export const PANEL_ID = 'novel-workshop'
export const PANEL_ROUTE = '/api/novel-write-engine/panel'
export const SKILL_NAME = 'novel-write-engine'
export const REMOTE_VERSION = 5
/** The panel is a recent-history view; the wire payload and UI use one cap. */
export const PANEL_CHAPTER_LIMIT = 30

/** Project-relative locations. Every write goes through these constants. */
export const PROJECT_FILE = 'novel.yaml'
export const OUTLINE_FILE = 'outline/outline.yaml'
/** Last outline replaced by a normal planning write; one level is enough for repair. */
export const OUTLINE_DEPRECATED_FILE = 'outline/outline.deprecated.yaml'
export const WORLDBOOK_FILE = 'outline/worldbook.yaml'
export const STATE_DIR = 'state'
export const CHAPTERS_DIR = 'chapters'
export const PLAN_DIR = 'plans'
export const REVIEW_DIR = 'reviews'
export const CHECK_DIR = 'checks'
export const EXPORT_DIR = 'exports'
export const BACKUP_DIR = 'backups'
export const HISTORY_DIR = 'history'
/** Brief receipts are append-only evidence, separate from content transactions. */
export const BRIEF_RECEIPTS_FILE = 'state/briefs.yaml'
export const OUTLINE_DIR = 'outline'
export const LOCK_FILE = '.engine.lock'
export const STAGING_DIR = '.staging'
export const REGISTRY_FILE = 'projects.yaml'
export const SESSION_BINDINGS_FILE = 'session-bindings.yaml'
export const METADATA_LOCK_FILE = '.metadata.lock'
export const ARCHIVE_DIGESTS_FILE = 'state/archive-digests.json'

/** Files owned by the engine under `state/`. */
export const STATE_FILES = {
  pipeline: 'pipeline.yaml',
  chapters: 'chapters.yaml',
  characters: 'characters.yaml',
  world: 'world.yaml',
  locks: 'locks.yaml',
  timeline: 'timeline.yaml',
  foreshadows: 'foreshadows.yaml',
  relationships: 'relationships.yaml',
  handoff: 'handoff.yaml',
  journal: 'journal.jsonl',
} as const

/** Chapter file name, zero padded to three digits. */
export const chapterFile = (chapter: number): string =>
  `${CHAPTERS_DIR}/chapter-${String(chapter).padStart(3, '0')}.md`

/** Kept for reference when a rollback discards the current draft. */
export const deprecatedChapterFile = (chapter: number): string =>
  `${CHAPTERS_DIR}/chapter-${String(chapter).padStart(3, '0')}.deprecated.md`

export const planWorldFile = (chapter: number): string =>
  `${PLAN_DIR}/ch${String(chapter).padStart(3, '0')}.world.yaml`
export const planChapterFile = (chapter: number): string =>
  `${PLAN_DIR}/ch${String(chapter).padStart(3, '0')}.chapter.yaml`
export const reviewFile = (chapter: number): string =>
  `${REVIEW_DIR}/ch${String(chapter).padStart(3, '0')}.review.yaml`
export const checkFile = (chapter: number): string =>
  `${CHECK_DIR}/ch${String(chapter).padStart(3, '0')}.check.yaml`

/** Immutable-ish prior versions; the primary paths always hold the current one. */
const historyChapter = (chapter: number): string => `ch${String(chapter).padStart(3, '0')}`
const historyRevision = (revision: number): string => `r${String(Math.max(0, revision)).padStart(4, '0')}`
export const reviewHistoryFile = (chapter: number, revision: number): string =>
  `${HISTORY_DIR}/reviews/${historyChapter(chapter)}.${historyRevision(revision)}.review.yaml`
export const checkHistoryFile = (chapter: number, revision: number): string =>
  `${HISTORY_DIR}/checks/${historyChapter(chapter)}.${historyRevision(revision)}.check.yaml`
export const chapterHistoryFile = (chapter: number, revision: number): string =>
  `${HISTORY_DIR}/chapters/${historyChapter(chapter)}.${historyRevision(revision)}.md`
export const deprecatedHistoryFile = (chapter: number, revision: number): string =>
  `${HISTORY_DIR}/deprecated/${historyChapter(chapter)}.${historyRevision(revision)}.md`
export const planHistoryFile = (chapter: number, revision: number): string =>
  `${HISTORY_DIR}/plans/${historyChapter(chapter)}.${historyRevision(revision)}.chapter.yaml`
export const HISTORY_KINDS = ['reviews', 'checks', 'chapters', 'deprecated', 'plans'] as const
export type HistoryKind = (typeof HISTORY_KINDS)[number]

/** Limits that are structural, not taste. */
export const LIMITS = {
  /** P4 <-> P5/P6 retries before a forced rollback. */
  maxRounds: 3,
  /** Lock staleness in milliseconds. */
  lockStaleMs: 90_000,
  /** How long a writer waits for the keyed mutex before failing. */
  lockWaitMs: 10_000,
  /** Reading proofs shorter than this cannot be verified. */
  minQuoteChars: 12,
  /** World-plan text fields are protected context, so they need a hard bound. */
  maxWorldPlanItems: 64,
  maxWorldPlanTextChars: 4_000,
  maxWorldPlanObjectiveChars: 2_000,
  /** Cast plus summary may exceed eight, but not without a bound. */
  maxActiveCast: 12,
  /** Outline and worldbook are protected context, so they need hard bounds. */
  maxOutlineChapters: 2_000,
  maxOutlineVolumes: 50,
  maxOutlineTextFieldChars: 400,
  maxOutlineNotesChars: 1_000,
  maxWorldbookEntries: 200,
  maxWorldbookTextChars: 2_000,
  maxSearchQueryChars: 200,
}

/** Re-exported enums make adapter code readable without importing types twice. */
export const SCENE_TYPE_DEFAULT: SceneType = '日常过渡章'
export const DEFAULT_GENRE: Genre = '都市现代'
export const DEFAULT_PLATFORM: Platform = 'fanqie'
export const INITIAL_STAGE: Stage = 'idle'

/** The order used to render the nine-phase progress strip. */
export const PHASE_STRIP = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'] as const

/** Tool names, kept here so the arch test can assert one namespace. */
export const TOOL_NAMES = [
  'novel_init',
  'novel_status',
  'novel_brief',
  'novel_plan_world',
  'novel_plan_chapter',
  'novel_write_draft',
  'novel_review',
  'novel_revise',
  'novel_check',
  'novel_archive',
  'novel_word_count',
  'novel_state',
  'novel_amend',
  'novel_rollback',
  'novel_diff',
  'novel_export',
  'novel_audit',
  'novel_pipeline',
  'novel_blueprint',
  'novel_outline',
  'novel_outline_import',
  'novel_worldbook',
  'novel_search',
  'novel_doctor',
  'novel_report',
  'novel_guide',
  'novel_reopen',
  'novel_restore',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/** The ten high-frequency tools kept when `tools.mode = core`. */
export const CORE_TOOLS: readonly ToolName[] = [
  'novel_init',
  'novel_status',
  'novel_guide',
  'novel_brief',
  'novel_outline',
  'novel_write_draft',
  'novel_review',
  'novel_revise',
  'novel_check',
  'novel_archive',
]
