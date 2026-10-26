import type { Genre, Platform, SceneType, Stage } from './types.js'

/** Panel and session identifiers. */
export const PLUGIN_NAME = 'dsh-novel-write-engine'
export const PANEL_ID = 'novel-workshop'
export const PANEL_ROUTE = '/api/novel-write-engine/panel'
export const SKILL_NAME = 'novel-write-engine'
export const REMOTE_VERSION = 1

/** Project-relative locations. Every write goes through these constants. */
export const PROJECT_FILE = 'novel.yaml'
export const STATE_DIR = 'state'
export const CHAPTERS_DIR = 'chapters'
export const PLAN_DIR = 'plans'
export const REVIEW_DIR = 'reviews'
export const CHECK_DIR = 'checks'
export const EXPORT_DIR = 'exports'
export const BACKUP_DIR = 'backups'
export const OUTLINE_DIR = 'outline'
export const LOCK_FILE = '.engine.lock'
export const STAGING_DIR = '.staging'
export const REGISTRY_FILE = 'projects.yaml'

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

/** Limits that are structural, not taste. */
export const LIMITS = {
  /** P4 <-> P5 and P6 -> P5 retries before a forced rollback. */
  maxRounds: 3,
  /** Lock staleness in milliseconds. */
  lockStaleMs: 90_000,
  /** How long a writer waits for the keyed mutex before failing. */
  lockWaitMs: 10_000,
  /** Reading proofs shorter than this cannot be verified. */
  minQuoteChars: 12,
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
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/** The eight high-frequency tools kept when `tools.mode = core`. */
export const CORE_TOOLS: readonly ToolName[] = [
  'novel_status',
  'novel_brief',
  'novel_write_draft',
  'novel_review',
  'novel_revise',
  'novel_check',
  'novel_archive',
  'novel_word_count',
]
