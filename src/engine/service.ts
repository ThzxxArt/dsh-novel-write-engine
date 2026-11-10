import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { parse as parseYaml, stringify } from 'yaml'
import {
  ARCHIVE_DIGESTS_FILE,
  BACKUP_DIR,
  BRIEF_RECEIPTS_FILE,
  CHAPTERS_DIR,
  DOCTOR_BASELINE_FILE,
  EXPORT_DIR,
  LIMITS,
  LOCK_FILE,
  METADATA_LOCK_FILE,
  OUTLINE_DEPRECATED_FILE,
  OUTLINE_FILE,
  PROJECT_FILE,
  REVIEW_DIR,
  STATE_DIR,
  WORLDBOOK_FILE,
  STATE_FILES,
  chapterFile,
  checkFile,
  checkHistoryFile,
  chapterHistoryFile,
  deprecatedChapterFile,
  deprecatedHistoryFile,
  planChapterFile,
  planHistoryFile,
  planWorldFile,
  reviewFile,
  reviewHistoryFile,
} from '../constants.js'
import { canRun, roundsExhausted, STAGE_NEXT, nextStage as computeNextStage } from '../domain/index.js'
import { textSimilarity } from '../domain/simhash.js'
import { compareText, stableJson } from '../domain/stable.js'
import {
  matchEvidence,
  openingInFirstTwoParagraphs,
  quoteMeetsFloor,
  splitParagraphs,
} from '../domain/text.js'
import { countWordMetrics } from '../domain/wordcount.js'
import { measureStyle, styleVocabulary } from '../domain/style.js'
import { STYLE_RULES } from '../codes.js'
import { reviewArithmeticProblems, totalScore } from '../domain/scoring.js'
import {
  dedupeAdvisories,
  runMachineChecks,
  runRules,
  scopeOfRule,
  type MachineOptions,
  type MachineResult,
} from '../rules/pipeline.js'
import type { Rulepack, StylePack } from '../rules/types.js'
import { stylePackMap } from '../stylepack.js'
import { applyExclusions } from '../domain/scoring.js'
import {
  FsStore,
  joinRel,
  sha256,
  shortDigest,
  ProjectRegistry,
  SessionBindings,
  type RegistryEntry,
  type StagedFile,
} from '../store/index.js'
import { homedir } from 'node:os'
import { ensureDirAt } from '../assets.js'
import { runTransaction } from '../store/txn.js'
import { KeyedMutex, FileLock, isLockRecord, lockRecordIsLive } from '../store/lock.js'
import {
  appendJournal,
  assertJournalConsistent,
  hasCommittedJournal,
  inspectPending,
  readJournal,
  reconcileJournal,
} from '../store/journal.js'
import { listBackups, readBackupManifest } from '../store/backup.js'
import { normalizeLegacyCheck } from '../store/migrate.js'
import { narrow, type DocKind } from '../store/schema.js'
import { buildEpub } from '../export/epub.js'
import {
  renderBlurb,
  renderCover,
  renderMarkdown,
  renderPlainText,
  renderProposal,
  type ExportChapter,
} from '../export/render.js'
import {
  bookPlanPresent,
  emptyOutline,
  emptyWorldbook,
  markOutlineArchived,
  markOutlineReopened,
  mergeBookPlan,
  mergeWorldbook,
  normalizeOutlineChapters,
  normalizeVolumes,
  outlineCard,
  outlineDrift,
  outlineSummary,
  parseOutlineInput,
  renderOutlineMarkdown,
  renderWorldbookMarkdown,
  stripChapterPrefix,
  validateOutlineDocument,
  validateWorldbookDocument,
  volumeForChapter,
  worldbookCounts,
  type BookPatch,
  type OutlineInput,
  type VolumeInput,
  type WorldbookPatch,
} from './book.js'
import { assertArchivedCardVolumes, assertArchivedCardsInVolumes, mergeOutline } from './outline-merge.js'
import { buildBookReport, buildGuide, buildPanelBookData, searchSnapshot } from './insight.js'
import { historyTexts, listHistory, type HistoryEntry } from './history.js'
import { BriefLibrary } from './brief.js'
import { briefContext } from './context.js'
import { applyStateDelta, eventKeyFor, normalizeRole } from './state-delta.js'
import { resolveLockBaseline } from './entity-anchors.js'
import { relationUnknownFindings } from '../rules/checks.js'
import { CheckSubmissionError, evaluateSemantic, validateSemanticSubmission } from './semantic.js'
import { briefStageFor, evaluateGates, gateName, parseParagraphLocation } from './gates.js'
import { advanceHandoff, parseActProgress, projectHandoff } from './handoff.js'
import {
  formatResumePrompt,
  phaseStrip,
  projectChapterProgress,
  projectChapters,
  projectGates,
  projectSummary,
  type PanelBundle,
  type PanelChaptersDto,
  type PanelGatesDto,
  type PanelProjectOption,
  type PanelSelection,
  type PanelSectionMeta,
  type PanelSectionName,
  type PanelSnapshot,
  type PanelSummaryDto,
} from './projections.js'
import {
  ambiguousError,
  describeCandidates,
  discoverWorkspace,
  hasProjectState,
  identityMismatchError,
  inspectProject,
  missingProjectError,
  projectNotFoundError,
  scanWorkspace,
  type ProjectInspection,
  type ProjectState,
} from './project-selection.js'
import {
  ENGINE_PROJECT_INITIAL,
  emptyDocuments,
  emptyPipeline,
  type EngineConfig,
  type EngineEvent,
} from './state.js'
import {
  ERROR_CODES,
  GENRES,
  PLATFORMS,
  SCENE_TYPES,
  SCHEMA_VERSION,
  EngineBlockedError,
  EngineError,
  EngineFaultError,
  EngineInputError,
  type AuditRow,
  type ArchiveHandoff,
  type ArchivedCardSnapshot,
  type BlockingItem,
  type BriefReceiptsDocument,
  type BriefStage,
  type ChapterCastMember,
  type ChapterPlanInput,
  type ChapterRecord,
  type ChapterSummary,
  type ChaptersDocument,
  type CheckDocument,
  type ExportKind,
  type GateInput,
  type ReadingProof,
  type HandoffDocument,
  type NovelProject,
  type OpResult,
  type Operation,
  type PipelineState,
  type ReviewDocument,
  type ReviewInput,
  type RevisionInput,
  type RoundCounters,
  type ChapterProgress,
  type ScoreDimension,
  type Selection,
  type SemanticItem,
  type Stage,
  type StateDelta,
  type StateError,
  type StatusReport,
  type Warning,
  type Violation,
  type WordMetrics,
  type WorldPlanInput,
  type BookReport,
  type DoctorCheck,
  type DoctorReport,
  type DraftState,
  type GuideReport,
  type OutlineChapter,
  type OutlineDocument,
  type SearchReport,
  type WorldbookDocument,
  RELATIONSHIP_TYPE_CODES,
} from '../types.js'

export interface PanelSectionQuery {
  search?: string
  status?: string
  scene?: string
  sort?: string
  cursor?: string
  limit?: number
  chapter?: number
}

export interface InitProjectInput {
  title: string
  genre: NovelProject['genre']
  platform: NovelProject['platform']
  author?: string
  description?: string
  words_per_chapter?: [number, number]
  total_chapters?: number | null
  dialogue_ratio?: [number, number]
  min_cjk_chars?: number | null
  dialogue_ratio_metric?: 'lines' | 'chars' | 'both'
  /**
   * 0.2.17: a bundled style pack id, or `'none'` for "deliberately no style".
   * Required at the *input* contract (the tool layer enforces it) while the disk
   * field stays optional, so pre-0.2.17 projects remain readable.
   */
  style?: string | 'none' | null
  /** 0.2.17: how the style choice was made; the tool layer supplies it. */
  style_confirmation?: string
  /** 0.2.0 book-planning seed; every field is optional. */
  premise?: string
  logline?: string
  themes?: string[]
  tone?: string
  pov?: string
  audience?: string
  selling_points?: string[]
  ending?: string
  /** Strict outline is opt-in; a new project defaults to false. */
  strict_outline?: boolean
  root?: string
}

export interface StatusInput {
  chapter?: number
  root?: string
}

export interface BriefInput {
  /** Single stage to sign; omit when passing `stages`. */
  stage?: import('../types.js').BriefStage
  /** 0.2.14: sign several stages in one transaction. */
  stages?: import('../types.js').BriefStage[]
  chapter?: number
  root?: string
}

type BriefPayload = {
  stage: BriefStage
  chapter: number
  digest: string
  dependencies?: Record<string, string>
  /** Present when more than one stage was requested in one transaction. */
  briefs?: BriefPayload[]
  title: string
  content: string
  content_hash: string
  fields: Record<string, unknown>
  context: Record<string, unknown>
}

export interface LegacyIssue {
  code:
    | 'LEGACY_CHECK_FORMAT'
    | 'LEGACY_EFFORT'
    | 'LEGACY_CAST_ROLE'
    | 'LEGACY_FORESHADOW_ANCHOR'
    | 'LEGACY_FORESHADOW_ADVANCE'
    | 'LEGACY_BRIEFS'
  detail: string
}

export interface WorldPlanSubmission extends WorldPlanInput {
  root?: string
}

export interface ChapterPlanSubmission extends ChapterPlanInput {
  root?: string
}

export interface DraftSubmission {
  chapter: number
  content: string
  chapter_title: string
  scene_type: import('../types.js').SceneType
  narrator: string
  summary: ChapterSummary
  root?: string
}

export interface ReviewAmendment {
  id: string
  status?: 'open' | 'fixed' | 'waived'
  severity?: 'blocker' | 'advisory'
  location?: string
  problem?: string
  fix?: string
  /**
   * 0.2.17: a blocker may only be marked fixed with a verbatim quote from the
   * current manuscript. Without this an amendment could report "no blocking
   * items" while PG-08 still refused the archive — two answers for one fact.
   */
  evidence?: string
}

export interface ReviewSubmission extends Partial<Omit<ReviewInput, 'chapter'>> {
  chapter: number
  /** 0.2.14: correct reviewer metadata without opening a new review round. */
  amend_issues?: ReviewAmendment[]
  amend_note?: string
  root?: string
}

export interface RevisionSubmission extends Omit<RevisionInput, 'summary'> {
  summary?: ChapterSummary
  /** Updated issue statuses/evidence; the review document is patched in place. */
  issues?: ReviewDocument['issues']
  /** Proof that the revised text was read; required for content/patch revisions. */
  proof?: ReadingProof
  root?: string
}

export interface CheckSubmission {
  chapter: number
  /** The five P6 semantic items; omission is a failed check, never a pass. */
  semantic: SemanticItem[]
  scope?: string[]
  /** Advisory codes or instance ids the author has read and accepts; blockers cannot be acknowledged. */
  acknowledge?: string[]
  /** 0.2.13 per-finding reason; required for every acknowledged code or id. */
  acknowledge_reasons?: Record<string, string>
  /** 0.2.14: stop re-reporting this acknowledged class after this chapter. */
  acknowledge_until_chapter?: number
  root?: string
}

export interface ArchiveSubmission {
  chapter: number
  /** Mandatory reconciliation sheet for the five derived ledgers. */
  state_delta: StateDelta
  /** Optional volume/act override; omitted values are derived by the engine. */
  handoff?: ArchiveHandoff
  root?: string
}

/** One JSON-Pointer subset operation for a local amend. */
export interface AmendPatchOp {
  op: 'replace' | 'add' | 'remove'
  /** Dot path into the document, e.g. `items.3.title` or `book.logline`. */
  path: string
  value?: unknown
}

export interface AmendSubmission {
  path: string
  content?: Record<string, unknown>
  /** 0.2.14 local edit; mutually exclusive with `content`. */
  patch?: AmendPatchOp[]
  /** Explicit permission to drop rows; a truncated read is refused without it. */
  allow_delete?: boolean
  reason: string
  root?: string
}

export interface RestoreSubmission {
  txid: string
  chapter?: number
  /** Restrict to chapter files, or exactly [outline/outline.yaml] to restore the plan. */
  paths?: string[]
  root?: string
}

export interface RollbackSubmission {
  chapter: number
  toStage: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6'
  reason?: string
  root?: string
}

export interface DiffInput {
  chapter?: number
  before?: string
  after?: string
  root?: string
}

export interface AuditInput {
  limit?: number
  cursor?: number
  chapter?: number
  op?: string
  status?: 'committed' | 'aborted'
  since?: string
  until?: string
  root?: string
}

export interface ExportInput {
  kind: ExportKind
  chapter?: number
  root?: string
}

export interface StateQueryInput {
  kind: DocKind | 'novel' | 'planWorld' | 'planChapter' | 'history' | 'backups' | 'briefs'
  /** Briefs view: `current` equals current_only:true. */
  view?: 'all' | 'current'
  chapter?: number
  /** Select one historical revision instead of listing history. */
  revision?: number
  /** Chapter index defaults to a compact read; opt in to the full summaries. */
  include_summary?: boolean
  /** Inclusive chapter range for the `chapters` index. */
  chapter_range?: [number, number]
  /** Page size, 1..200; omitted uses a section default. */
  limit?: number
  /** Opaque cursor bound to this section and its filters. */
  cursor?: string
  /** Foreshadow status filter. */
  status?: string
  /** Foreshadow advance_log detail; default false returns advance_count only. */
  include_history?: boolean
  /** Briefs: return only the current receipt per chapter/stage. */
  current_only?: boolean
  root?: string
}

export interface WordCountInput {
  text?: string
  chapter?: number
  root?: string
}

export interface BookPlanSubmission extends BookPatch {
  volumes?: VolumeInput[]
  /** Explicit confirmation when a volume-list replacement drops a volume. */
  confirm_remove?: boolean
  root?: string
}

export interface OutlineMutationResult {
  planned: number
  archived: number
  total: number
  strict: boolean
  volumes: number
  added: number[]
  updated: number[]
  reindexed: number[]
  removed: number[]
  volumes_added: string[]
  volumes_updated: string[]
  volumes_removed: string[]
  dry_run?: boolean
  would_add?: number[]
  would_update?: number[]
  would_reindex?: number[]
  would_remove?: number[]
}

export interface OutlineSubmission extends OutlineInput {
  root?: string
}

export interface OutlineImportSubmission {
  format: 'markdown' | 'yaml' | 'json'
  content: string
  dry_run?: boolean
  root?: string
}

export interface WorldbookSubmission extends WorldbookPatch {
  root?: string
}

export interface ReopenSubmission {
  chapter: number
  /** A reopen is a history-changing maintenance action; the reason is mandatory. */
  reason: string
  root?: string
}

export interface SearchInput {
  query: string
  scope?: 'all' | 'chapters' | 'summaries' | 'outline' | 'worldbook' | 'ledgers'
  limit?: number
  root?: string
}

export interface DoctorInput {
  /** Persist the current warning set as accepted; `reset` clears it. */
  baseline?: boolean
  reset?: boolean
  root?: string
}

export interface ReportSubmission {
  root?: string
  /** 0.2.17: return the summary plus the most recent effort rows only. */
  lean?: boolean
}

/** How many per-chapter effort rows a lean report keeps. */
export const REPORT_LEAN_CHAPTERS = 20

export interface GuideInput {
  root?: string
}

/** Session/workspace context of one tool or command call. */
export interface EngineCaller {
  sessionId?: string
  cwd?: string
}

interface Snapshot {
  root: string
  /** How this project was chosen; never persisted in the project itself. */
  selection: Selection
  project: NovelProject
  /** Set when novel.yaml exists but cannot be parsed/narrowed. */
  projectError: string | null
  /** Set when pipeline.yaml is unreadable and a backup fallback was used. */
  pipelineError: string | null
  pipeline: PipelineState
  /** Latest receipt per brief stage, loaded from state/briefs.yaml or legacy pipeline.briefs. */
  briefs: PipelineState['briefs']
  /**
   * 0.2.17: set when state/briefs.yaml exists but cannot be parsed. The receipt
   * file is the authority for signed briefs, so a damaged one means every
   * PG-01 check fails until the file is repaired — status must say so instead of
   * recommending `novel_brief`, which `getBrief` would reject forever.
   */
  briefsError: string | null
  chapters: ChaptersDocument
  characters: import('../types.js').CharactersDocument
  world: import('../types.js').WorldDocument
  locks: import('../types.js').LocksDocument
  timeline: import('../types.js').TimelineDocument
  foreshadows: import('../types.js').ForeshadowsDocument
  relationships: import('../types.js').RelationshipsDocument
  handoff: import('../types.js').HandoffDocument | null
  outline: OutlineDocument
  outlinePresent: boolean
  outlineError: string | null
  worldbook: WorldbookDocument
  worldbookPresent: boolean
  worldbookError: string | null
  worldPlan: import('../types.js').WorldPlanInput | null
  /** Unreadable ledgers are reported instead of wedging status/panel. */
  ledgerErrors: StateError[]
  text: string | null
  previousText: string | null
  previousTexts: string[]
  /** Chapter numbers matching `previousTexts` (newest first). */
  previousChapterNums: number[]
  plan: (ChapterPlanInput & { summary?: ChapterSummary }) | null
  /** An unreadable plan is reported to the model instead of wedging every read. */
  planError: string | null
  worldPlanError: string | null
  review: ReviewDocument | null
  reviewError: string | null
  check: CheckDocument | null
  checkError: string | null
}

const ROUND_TRANSITIONS: Record<RollbackSubmission['toStage'], Stage> = {
  P1: 'idle',
  P2: 'P2',
  P3: 'P3',
  P4: 'P4',
  P5: 'P5',
  P6: 'P6',
}

/** Forward order of stages; rollback may only move to an equal or earlier rank. */
const STAGE_RANK: Record<Stage, number> = {
  idle: 0,
  P2: 1,
  P3: 2,
  P4: 3,
  P5: 4,
  P6: 5,
  ready_to_archive: 6,
  done: 7,
}

/** Internal, journal-tracked archive idempotency ledger; not a user state doc. */
const ARCHIVE_DIGESTS = ARCHIVE_DIGESTS_FILE

const LEDGER_PATHS: Readonly<Record<string, string>> = {
  chapters: joinRel(STATE_DIR, STATE_FILES.chapters),
  characters: joinRel(STATE_DIR, STATE_FILES.characters),
  world: joinRel(STATE_DIR, STATE_FILES.world),
  locks: joinRel(STATE_DIR, STATE_FILES.locks),
  timeline: joinRel(STATE_DIR, STATE_FILES.timeline),
  foreshadows: joinRel(STATE_DIR, STATE_FILES.foreshadows),
  relationships: joinRel(STATE_DIR, STATE_FILES.relationships),
  handoff: joinRel(STATE_DIR, STATE_FILES.handoff),
}

const MUTABLE_STATE: Record<string, DocKind> = {
  [PROJECT_FILE]: 'project',
  [joinRel(STATE_DIR, STATE_FILES.pipeline)]: 'pipeline',
  [joinRel(STATE_DIR, STATE_FILES.chapters)]: 'chapters',
  [joinRel(STATE_DIR, STATE_FILES.characters)]: 'characters',
  [joinRel(STATE_DIR, STATE_FILES.world)]: 'world',
  [joinRel(STATE_DIR, STATE_FILES.locks)]: 'locks',
  [joinRel(STATE_DIR, STATE_FILES.timeline)]: 'timeline',
  [joinRel(STATE_DIR, STATE_FILES.foreshadows)]: 'foreshadows',
  [joinRel(STATE_DIR, STATE_FILES.relationships)]: 'relationships',
  [joinRel(STATE_DIR, STATE_FILES.handoff)]: 'handoff',
  [OUTLINE_FILE]: 'outline',
  [WORLDBOOK_FILE]: 'worldbook',
  // 0.2.17: a damaged receipt file is repaired by an explicit amend, not by
  // pointing the author at `novel_brief`, which refuses to overwrite it.
  [BRIEF_RECEIPTS_FILE]: 'briefs',
}

/** Refused attempts a model can fix by changing its submission. */
const RETRYABLE_ABORT_CODES = new Set<string>([
  ERROR_CODES.GATE_BLOCKED,
  ERROR_CODES.SCORE_MISMATCH,
  ERROR_CODES.READING_PROOF_INVALID,
  ERROR_CODES.DELTA_UNVERIFIED,
  ERROR_CODES.RESOURCE_NEGATIVE_BALANCE,
  ERROR_CODES.SCHEMA_INVALID,
])

/**
 * The single write authority. Tools, commands, the panel and task books never
 * touch a file; every mutation is one of these operations.
 */
interface StatePage {
  total: number
  returned: number
  limit: number
  next_cursor: string | null
  has_more: boolean
  filters: Record<string, unknown>
}

const STATE_PAGE_MAX = 200

const STATE_SECTION_DEFAULT_LIMIT = (kind: StateQueryInput['kind']): number => {
  if (kind === 'characters' || kind === 'world' || kind === 'locks') return 200
  if (
    kind === 'chapters' ||
    kind === 'foreshadows' ||
    kind === 'timeline' ||
    kind === 'relationships' ||
    kind === 'briefs' ||
    kind === 'history' ||
    kind === 'backups'
  )
    return 50
  return Number.MAX_SAFE_INTEGER
}

const encodeStateCursor = (payload: { section: string; offset: number; filters_hash: string }): string =>
  Buffer.from(JSON.stringify({ v: 1, ...payload }), 'utf8').toString('base64url')

const decodeStateCursor = (cursor: string, section: string, filtersHash: string): { offset: number } => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      v?: unknown
      section?: unknown
      offset?: unknown
      filters_hash?: unknown
    }
    if (
      parsed.v !== 1 ||
      parsed.section !== section ||
      parsed.filters_hash !== filtersHash ||
      !Number.isInteger(parsed.offset) ||
      (parsed.offset as number) < 0
    ) {
      throw new Error('cursor does not belong to this section/filter')
    }
    return { offset: parsed.offset as number }
  } catch (error) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `invalid state cursor: ${errorMessage(error)}`,
      'start without cursor; a cursor is bound to one section and its filters',
    )
  }
}

/**
 * Hard byte cap for one panel section. The read model must bound its own page
 * before this limit applies: pageable lists shrink their page and rewrite the
 * cursor, structured lists drop rows only through `panelPreviewGroups`, which
 * reports every drop in `counts`. No pass may delete a row silently.
 */
const PANEL_SECTION_BYTES = 64 * 1024
/** 0.2.17: the audit page ceiling the tool description promises. */
const AUDIT_LIMIT_MAX = 200
/** Room for the section envelope (`total`, `etag`, cursors) inside the cap. */
const PANEL_SECTION_SLACK = 2048
/** Row cap per structured worldbook group; every cap is reported as shown/total. */
const PANEL_GROUP_PREVIEW = 50

/**
 * The leads tab fuses three ledgers. Only the foreshadow ledger is paginated;
 * the timeline and relationship lists are bounded previews so the primary list
 * never pays for them.
 */
const PANEL_LEADS_AUX_LIMIT = 50
const PANEL_LEADS_PAGE_SIZE = 50

export class EngineService {
  private readonly stores = new Map<string, FsStore>()
  private readonly mutex = new KeyedMutex()
  private readonly replay = new Map<string, OpResult<unknown>>()
  /** Bumped when an export artifact disappeared; makes the replay key miss. */
  private readonly exportArtifactEpoch = new Map<string, number>()
  /** Status, panel and gates ask for the same stage context repeatedly. */
  private readonly briefContextCache = new WeakMap<Snapshot, Map<string, Record<string, unknown>>>()
  /** The 15s panel poll reuses the heavy book projection until revision/damage changes. */
  private readonly panelCache = new Map<string, { key: string; snapshot: PanelSnapshot }>()
  /** Section-level cache; writes bump revision, so a stale entry cannot survive a commit. */
  private readonly sectionCache = new Map<string, { key: string; value: PanelSectionMeta }>()
  private readonly journalCache = new WeakMap<
    Snapshot,
    Promise<{
      key: string
      journal: Awaited<ReturnType<typeof readJournal>>
      blocking: BlockingItem[]
    }>
  >()
  private readonly reviewKeyCache = new WeakMap<Snapshot, Promise<string>>()
  private readonly briefs: BriefLibrary
  private readonly now: () => Date
  private readonly metadataMutex = new KeyedMutex()
  private readonly callerContext = new AsyncLocalStorage<EngineCaller | undefined>()

  constructor(
    private readonly config: EngineConfig,
    rulepack: Rulepack | (() => Rulepack),
    options: {
      briefs?: BriefLibrary
      now?: () => Date
      onEvent?: (event: EngineEvent) => void
      /** 0.2.17: the compiled style catalogue; injectable so tests can pin one. */
      stylepacks?: () => Map<string, StylePack>
    } = {},
  ) {
    this.rulepackSource = typeof rulepack === 'function' ? rulepack : () => rulepack
    this.briefs =
      options.briefs ?? new BriefLibrary(config.briefs.overrides === '' ? undefined : config.briefs.overrides)
    this.now = options.now ?? (() => new Date())
    this.onEvent = options.onEvent
    // The rulepack's zero-tolerance list must reach the catalogue: C3 gives a
    // word exactly one owner, so `仿佛`/`不禁` stay blockers and never become a
    // second, duplicated style finding. Passing no list here silently disabled
    // that collapse — the CLI collapsed, the engine did not.
    this.stylepackSource =
      options.stylepacks ??
      (() =>
        stylePackMap({
          zeroTolerance: this.rulepack.lexicon.zero_tolerance.map((entry) => entry.term),
        }))
  }

  /** Compiled on first use so `apply()` performs no IO. */
  private readonly rulepackSource: () => Rulepack
  private readonly stylepackSource: () => Map<string, StylePack>
  private compiled: Rulepack | null = null
  private compiledStyles: Map<string, StylePack> | null = null
  private disposed = false

  /**
   * Release in-process caches on host teardown. The engine owns no file
   * handles, so this is deliberately synchronous and idempotent; it prevents a
   * disposed instance from keeping project stores and replay results alive.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stores.clear()
    this.replay.clear()
    this.exportArtifactEpoch.clear()
    // 0.2.17: the panel and section caches are keyed by root, so a disposed
    // engine would otherwise keep every project's last payload alive.
    this.panelCache.clear()
    this.sectionCache.clear()
    this.compiled = null
    this.compiledStyles = null
  }

  private get rulepack(): Rulepack {
    this.compiled ??= this.rulepackSource()
    return this.compiled
  }

  /** The bundled catalogue, compiled once. Empty when the host ships none. */
  private get stylepacks(): Map<string, StylePack> {
    this.compiledStyles ??= this.stylepackSource()
    return this.compiledStyles
  }

  /**
   * 0.2.17: the pack this book is bound to, or `null`.
   *
   * `null` covers three cases that must behave identically — no `style` key, an
   * explicit `null`, and an id that no longer exists (hand-edited file). The
   * last one is reported by `novel_doctor`, never thrown: a book must stay
   * readable even if its pack vanished.
   */
  stylepackFor(project: Pick<NovelProject, 'style'> | null | undefined): StylePack | null {
    const id = project?.style
    if (typeof id !== 'string' || id === '') return null
    return this.stylepacks.get(id) ?? null
  }

  private readonly onEvent: ((event: EngineEvent) => void) | undefined
  /** Internal: capture the raw warning set when writing a doctor baseline. */
  private skipDoctorBaseline = false
  private readonly signalContext = new AsyncLocalStorage<AbortSignal | undefined>()

  /** Bind the host cancellation signal to the engine work of one tool call. */
  withSignal<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    return this.signalContext.run(signal, task)
  }

  /** Bind the calling Agent session and cwd to every engine operation in `task`. */
  withCaller<T>(caller: EngineCaller | undefined, task: () => Promise<T>): Promise<T> {
    return this.callerContext.run(caller, task)
  }

  private caller(): EngineCaller | undefined {
    return this.callerContext.getStore()
  }

  /** The configured default project root. */
  defaultRoot(): string {
    return resolve(this.config.projectRoot)
  }

  /** Resolve a caller-supplied root against the session cwd, like /novel use. */
  private resolveProjectPath(root: string): string {
    const caller = this.caller()
    return resolve(caller?.cwd ?? process.cwd(), root)
  }

  /** The resolved metadata directory; resolves relative config once per call. */
  private stateRoot(): string {
    return this.config.stateDir === ''
      ? resolve(homedir(), '.dsh', 'novel-write-engine')
      : resolve(this.config.stateDir)
  }

  private stateStore(): FsStore {
    return new FsStore(this.stateRoot())
  }

  private bindings(): SessionBindings {
    return new SessionBindings(this.stateStore(), { now: this.now })
  }

  /**
   * Serialize metadata read-modify-write across sessions and processes. The
   * project manuscript lock is a different lock; a slow write never blocks a
   * registry update.
   */
  withMetadataLock<T>(task: () => Promise<T>): Promise<T> {
    const directory = this.stateRoot()
    return this.metadataMutex.run(directory, async () => {
      ensureDirAt(directory)
      const lock = new FileLock(join(directory, METADATA_LOCK_FILE))
      try {
        await lock.acquire()
      } catch (error) {
        if (error instanceof EngineFaultError && error.code === ERROR_CODES.LOCK_TIMEOUT) {
          throw new EngineFaultError(
            ERROR_CODES.LOCK_TIMEOUT,
            'timed out waiting for the project metadata lock',
            'another DSH instance is writing project registration or session bindings; retry after it finishes',
            { cause: error },
          )
        }
        throw error
      }
      try {
        return await task()
      } finally {
        await lock.release()
      }
    })
  }

  private async inspectConfigRoot(): Promise<ProjectInspection | null> {
    try {
      const inspection = await inspectProject(this.defaultRoot())
      return inspection.state === 'ok' || inspection.state === 'damaged' || inspection.state === 'unreadable'
        ? inspection
        : null
    } catch (error) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_INVALID,
        `cannot inspect the configured projectRoot ${this.defaultRoot()}: ${errorMessage(error)}`,
        'fix the configured path or permissions; no project was selected',
        { cause: error },
      )
    }
  }

  /**
   * Resolve the four-layer choice: explicit, session binding, bounded workspace
   * discovery, then registry/config defaults. There is deliberately no
   * process-global "last project" layer.
   */
  /** Doctor/guide may run before any project exists; that is not a failure. */
  private async resolveRootForInspection(root?: string): Promise<Selection> {
    let selection: Selection
    try {
      selection = await this.resolveRoot(root)
    } catch (error) {
      if (
        root === undefined &&
        error instanceof EngineError &&
        error.code === ERROR_CODES.PROJECT_NOT_FOUND
      ) {
        return { root: this.defaultRoot(), source: 'config' }
      }
      throw error
    }
    // Doctor/guide may inspect a fresh install, but a bound project that is
    // gone must stay MISSING. Returning the generic "no project yet" payload
    // would invite a model to call novel_init over a lost binding.
    if (root === undefined && selection.source === 'session') {
      const inspection = await inspectProject(selection.root)
      if (inspection.state === 'missing') {
        throw missingProjectError({
          selection,
          lastTitle: selection.title,
          movedTo: await this.movedProjectHint(selection),
        })
      }
      if (inspection.state === 'not-project') throw projectNotFoundError(selection.root)
      if (inspection.state === 'unreadable') {
        throw new EngineFaultError(
          ERROR_CODES.SCHEMA_INVALID,
          `the project bound to this session is unreadable: ${inspection.error ?? selection.root}`,
          'fix the directory permissions, or explicitly rebind with /novel use after the project is readable',
        )
      }
    }
    return selection
  }

  private async resolveRoot(root?: string): Promise<Selection> {
    if (root !== undefined) return { root: this.resolveProjectPath(root), source: 'explicit' }
    const caller = this.caller()
    if (caller?.sessionId !== undefined) {
      const binding = await this.bindings().get(caller.sessionId)
      if (binding !== undefined) {
        return {
          root: binding.root,
          source: 'session',
          title: binding.title,
          created_at: binding.project_created_at,
        }
      }
      if (caller.cwd !== undefined && caller.cwd !== '') {
        const found = await discoverWorkspace(caller.cwd)
        if (found.kind === 'one') return { root: found.root, source: 'workspace' }
        if (found.kind === 'many') {
          throw ambiguousError(
            await Promise.all(
              found.roots.map(async (candidate) => {
                const inspection = await inspectProject(candidate)
                return {
                  root: inspection.root,
                  title: inspection.title,
                  state: inspection.state,
                }
              }),
            ),
          )
        }
      }
    }

    const document = await this.registry().read()
    const candidates = document.projects.map((entry) => ({
      root: entry.root,
      title: entry.title,
    }))
    const ambiguous = async (): Promise<EngineInputError> => {
      const described = await Promise.all(
        document.projects.map(async (entry) => {
          const inspection = await inspectProject(entry.root).catch(() => null)
          return {
            root: entry.root,
            title: entry.title,
            ...(inspection === null ? {} : { state: inspection.state }),
          }
        }),
      )
      return ambiguousError(described)
    }
    if (caller?.sessionId !== undefined) {
      if (candidates.length === 1) return { root: candidates[0]!.root, source: 'single' }
      if (candidates.length > 1) throw await ambiguous()
      const config = await this.inspectConfigRoot()
      if (config !== null) {
        if (config.state === 'unreadable') {
          throw new EngineFaultError(
            ERROR_CODES.SCHEMA_INVALID,
            `the configured projectRoot is unreadable: ${config.error ?? this.defaultRoot()}`,
            'fix the configured path or permissions',
          )
        }
        return { root: config.root, source: 'config' }
      }
      throw projectNotFoundError(this.defaultRoot())
    }

    if (document.active !== null) {
      return { root: document.active, source: 'active' }
    }
    const config = await this.inspectConfigRoot()
    if (config !== null) {
      if (config.state === 'unreadable') {
        throw new EngineFaultError(
          ERROR_CODES.SCHEMA_INVALID,
          `the configured projectRoot is unreadable: ${config.error ?? this.defaultRoot()}`,
          'fix the configured path or permissions',
        )
      }
      return { root: config.root, source: 'config' }
    }
    if (candidates.length === 1) return { root: candidates[0]!.root, source: 'single' }
    if (candidates.length > 1) throw await ambiguous()
    throw projectNotFoundError(this.defaultRoot())
  }

  private storeFor(root?: string): FsStore {
    const absolute = resolve(root ?? this.config.projectRoot)
    const existing = this.stores.get(absolute)
    if (existing !== undefined) return existing
    const store = new FsStore(absolute)
    this.stores.set(absolute, store)
    return store
  }

  /** Persist one explicit choice for this DSH session. */
  private async bindSelection(
    root: string,
    title: string,
    projectCreatedAt: string,
    source: 'explicit' | 'init' | 'command',
  ): Promise<void> {
    const caller = this.caller()
    if (caller?.sessionId === undefined) return
    const existing = await this.bindings().get(caller.sessionId)
    if (
      existing !== undefined &&
      existing.root === resolve(root) &&
      existing.title === title &&
      existing.project_created_at === projectCreatedAt
    ) {
      // A repeated explicit read must not take the cross-process metadata write
      // lock or refresh bound_at when the binding is already exact.
      return
    }
    await this.withMetadataLock(() =>
      this.bindings().bind({
        session_id: caller.sessionId!,
        root,
        title,
        project_created_at: projectCreatedAt,
        source,
      }),
    )
  }

  /**
   * Best-effort discovery bookkeeping. A metadata failure must never turn a
   * successful project read/write into a failure; the registry is convenience.
   */
  private async autoRegister(snapshot: Snapshot): Promise<void> {
    if (snapshot.projectError !== null) return
    try {
      const registry = this.registry()
      const current = await registry.read()
      const known = current.projects.find((entry) => entry.root === snapshot.root)
      const sameRow =
        known !== undefined &&
        known.title === snapshot.project.title &&
        (known.created_at ?? '') === (snapshot.project.created_at ?? '')
      const differentIdentity =
        known !== undefined &&
        known.created_at !== undefined &&
        known.created_at !== '' &&
        known.created_at !== snapshot.project.created_at
      if (sameRow || differentIdentity) {
        // Already registered, or the path now holds another book. Neither case
        // needs the cross-process metadata write lock.
        return
      }
      await this.withMetadataLock(async () => {
        const lockedRegistry = this.registry()
        const document = await lockedRegistry.read()
        const existing = document.projects.find((entry) => entry.root === snapshot.root)
        if (existing !== undefined) {
          if (
            existing.created_at !== undefined &&
            existing.created_at !== '' &&
            existing.created_at !== snapshot.project.created_at
          ) {
            // The path now holds another book, or the replacement has no
            // created_at at all. Never let a read silently replace the
            // registered identity; explicit register/activate owns that
            // decision.
            return
          }
          if (
            existing.title === snapshot.project.title &&
            (existing.created_at ?? '') === (snapshot.project.created_at ?? '')
          ) {
            return
          }
        }
        await lockedRegistry.register({
          root: snapshot.root,
          title: snapshot.project.title,
          created_at: snapshot.project.created_at,
        })
      })
    } catch {
      // Convenience metadata only.
    }
  }

  /** Record the session binding/registration implied by a successful selection. */
  private async recordSelection(
    selection: Selection,
    snapshot: Snapshot,
    options: {
      bind?: boolean
      bindSource?: 'explicit' | 'init' | 'command'
      register?: boolean
    } = {},
  ): Promise<void> {
    const caller = this.caller()
    if (caller?.sessionId === undefined) return
    const shouldBind = options.bind ?? (options.bindSource !== undefined || selection.source === 'explicit')
    // A damaged project has a placeholder title and no trustworthy identity.
    // Reading it for repair must not overwrite the existing binding; the
    // explicit root remains usable for status/amend until the definition is
    // repaired.
    if (shouldBind && snapshot.projectError === null) {
      await this.bindSelection(
        snapshot.root,
        snapshot.project.title,
        snapshot.project.created_at,
        options.bindSource ?? 'explicit',
      )
    }
    const shouldRegister =
      options.register ?? (selection.source === 'explicit' || selection.source === 'workspace')
    if (shouldRegister) await this.autoRegister(snapshot)
  }

  /**
   * Read paths may record convenience metadata, but a corrupt or read-only
   * state directory must not turn a successful explicit-root read into a
   * failure. Resolution without an explicit root still reads the binding
   * fail-closed; writes use recordSelection directly and report a committed
   * mutation with a warning if its metadata update fails.
   */
  private async recordSelectionBestEffort(selection: Selection, snapshot: Snapshot): Promise<void> {
    try {
      await this.recordSelection(selection, snapshot)
    } catch {
      // The project snapshot is authoritative; session bindings and the
      // registry are convenience state and are never required to read a book.
    }
  }

  /** Registration/activation/use need a readable project identity. */
  private assertProjectHealthy(snapshot: Snapshot, operation: string): void {
    if (snapshot.projectError === null) return
    throw new EngineFaultError(
      ERROR_CODES.SCHEMA_INVALID,
      `${operation} requires a readable novel.yaml: ${snapshot.projectError}`,
      'repair the project definition with novel_status + novel_amend using an explicit project_root; the registry/binding was not changed',
    )
  }

  /* ------------------------------------------------------------- lifecycle */

  async initProject(
    input: InitProjectInput,
  ): Promise<OpResult<{ root: string; title: string; chapter: number; stage: Stage }>> {
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (title === '') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'title must not be empty')
    }
    if (input.author !== undefined && typeof input.author !== 'string') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'author must be a string')
    }
    if (input.description !== undefined && typeof input.description !== 'string') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'description must be a string')
    }
    if (!(GENRES as readonly string[]).includes(input.genre)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `unknown genre "${String(input.genre)}"`,
        `allowed: ${GENRES.join(', ')}`,
      )
    }
    if (!(PLATFORMS as readonly string[]).includes(input.platform)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `unknown platform "${String(input.platform)}"`,
        `allowed: ${PLATFORMS.join(', ')}`,
      )
    }
    if (input.words_per_chapter !== undefined) {
      if (!Array.isArray(input.words_per_chapter) || input.words_per_chapter.length !== 2) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          'words_per_chapter must be [min, max] positive integers with min <= max',
        )
      }
      const [min, max] = input.words_per_chapter
      if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max < min) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          'words_per_chapter must be [min, max] positive integers with min <= max',
        )
      }
    }
    if (
      input.total_chapters != null &&
      (!Number.isInteger(input.total_chapters) || input.total_chapters < 1)
    ) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'total_chapters must be a positive integer')
    }
    if (input.dialogue_ratio !== undefined) {
      if (!Array.isArray(input.dialogue_ratio) || input.dialogue_ratio.length !== 2) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          'dialogue_ratio must be [min, max] within 0..1 with min <= max',
        )
      }
      const [min, max] = input.dialogue_ratio
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 1 || max < min) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          'dialogue_ratio must be [min, max] within 0..1 with min <= max',
        )
      }
    }
    if (
      input.min_cjk_chars !== undefined &&
      input.min_cjk_chars !== null &&
      (!Number.isInteger(input.min_cjk_chars) || input.min_cjk_chars <= 0)
    ) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'min_cjk_chars must be a positive integer or null',
      )
    }
    if (
      input.dialogue_ratio_metric !== undefined &&
      !['lines', 'chars', 'both'].includes(input.dialogue_ratio_metric)
    ) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'dialogue_ratio_metric must be lines, chars or both',
      )
    }
    // 0.2.17: the style is a permanent choice, so the id is checked here rather
    // than silently falling back to "no style" on a typo.
    //
    // Three states, not two (§4.4): an omitted `style` leaves the key off the
    // file, which is what makes the migration window possible; `'none'` writes an
    // explicit `null`, which is a decision and therefore permanent.
    let styleField: { style?: string | null } = {}
    if (input.style === null || input.style === 'none') {
      styleField = { style: null }
    } else if (input.style !== undefined) {
      if (typeof input.style !== 'string') {
        throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'style must be a style pack id or "none"')
      }
      if (!this.stylepacks.has(input.style)) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `unknown style pack "${input.style}"`,
          `allowed: ${[...this.stylepacks.keys()].join(', ')}, none`,
        )
      }
      styleField = { style: input.style }
    }
    const selection: Selection = {
      root: input.root === undefined ? this.defaultRoot() : this.resolveProjectPath(input.root),
      source: input.root === undefined ? 'config' : 'explicit',
    }
    const result = await this.mutate({
      selection,
      op: 'initProject',
      bindOnSuccess: false,
      registerOnSuccess: false,
      key: () => `init:${selection.root}`,
      run: async (_snapshot, context) => {
        if (await context.store.exists(PROJECT_FILE)) {
          throw new EngineInputError(
            ERROR_CODES.PROJECT_EXISTS,
            `a project already exists at ${context.store.root}`,
            'use a different directory, or call novel_status to inspect the existing project',
          )
        }
        const project: NovelProject = {
          schema_version: 1,
          title,
          genre: input.genre,
          platform: input.platform,
          author: input.author ?? '',
          description: input.description ?? '',
          created_at: this.now().toISOString(),
          targets: {
            words_per_chapter:
              input.words_per_chapter ?? this.rulepack.platform[input.platform].words_per_chapter,
            total_chapters: input.total_chapters ?? null,
            dialogue_ratio: input.dialogue_ratio ?? this.rulepack.platform[input.platform].dialogue_ratio,
            ...(input.min_cjk_chars === undefined ? {} : { min_cjk_chars: input.min_cjk_chars }),
            ...(input.dialogue_ratio_metric === undefined
              ? {}
              : { dialogue_ratio_metric: input.dialogue_ratio_metric }),
          },
          ...styleField,
          ...(input.style_confirmation === undefined ? {} : { style_confirmation: input.style_confirmation }),
        }
        const pipeline = emptyPipeline({ revision: 1, chapter: 1, stage: 'idle' })
        const documents = emptyDocuments()
        const now = this.now().toISOString()
        const book = mergeBookPlan(
          {
            premise: '',
            logline: '',
            themes: [],
            tone: '',
            pov: '',
            audience: '',
            selling_points: [],
            ending: '',
            strict: false,
            strict_explicit: false,
          },
          {
            ...(input.premise === undefined ? {} : { premise: input.premise }),
            ...(input.logline === undefined ? {} : { logline: input.logline }),
            ...(input.themes === undefined ? {} : { themes: input.themes }),
            ...(input.tone === undefined ? {} : { tone: input.tone }),
            ...(input.pov === undefined ? {} : { pov: input.pov }),
            ...(input.audience === undefined ? {} : { audience: input.audience }),
            ...(input.selling_points === undefined ? {} : { selling_points: input.selling_points }),
            ...(input.ending === undefined ? {} : { ending: input.ending }),
            ...(input.strict_outline === undefined ? {} : { strict: input.strict_outline }),
          },
        )
        const outline = { ...emptyOutline(now), book }
        const worldbook = mergeWorldbook(
          emptyWorldbook(now),
          input.premise === undefined ? {} : { premise: input.premise },
          now,
        )
        const files: StagedFile[] = [
          { path: PROJECT_FILE, text: yaml(project) },
          { path: BRIEF_RECEIPTS_FILE, text: yaml({ schema_version: 1, receipts: [] }) },
          { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(pipeline) },
          { path: OUTLINE_FILE, text: yaml(outline) },
          { path: WORLDBOOK_FILE, text: yaml(worldbook) },
          ...Object.entries(documents).map(([name, document]) => ({
            path: joinRel(STATE_DIR, name),
            text: yaml(document),
          })),
        ]
        return {
          files,
          backup: false,
          data: { root: context.store.root, title: project.title, chapter: 1, stage: 'idle' as Stage },
          warnings: [
            ...(project.author.trim() === ''
              ? [
                  {
                    code: 'PROJECT_AUTHOR_EMPTY',
                    message: '作者为空；proposal 与导出会缺作者，可用 novel_amend 补 novel.yaml.author',
                  },
                ]
              : []),
            ...(project.description.trim() === ''
              ? [
                  {
                    code: 'PROJECT_DESCRIPTION_EMPTY',
                    message: '简介为空；proposal 与导出会缺简介，可用 novel_amend 补 novel.yaml.description',
                  },
                ]
              : []),
          ],
        }
      },
      emptyAllowed: true,
    })
    const created = await this.loadAt({ root: result.data.root, source: 'explicit' })
    await this.autoRegister(created)
    try {
      await this.bindSelection(created.root, created.project.title, created.project.created_at, 'init')
    } catch (error) {
      // The project transaction already committed. A metadata failure must be
      // visible, not reported as a failed init that invites a duplicate create.
      result.warnings.push({
        code: 'SESSION_BINDING_FAILED',
        message: `project was created, but the session binding could not be written: ${errorMessage(error)}`,
      })
    }
    return result
  }

  /* ---------------------------------------------------------- 0.2.0 book ops */

  async submitBookPlan(
    input: BookPlanSubmission,
  ): Promise<
    OpResult<{ premise: string; logline: string; strict: boolean; volumes: number; chapters: number }>
  > {
    const allowed = new Set([
      'premise',
      'logline',
      'themes',
      'tone',
      'pov',
      'audience',
      'selling_points',
      'ending',
      'strict',
      'volumes',
      'confirm_remove',
      'root',
    ])
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `unknown novel_blueprint argument "${key}"`,
          `allowed: ${[...allowed].join(', ')}`,
        )
      }
    }
    // The replay cache is consulted inside mutate() before run(). Check the
    // planning document here as well, otherwise an external corruption can be
    // masked by a cached successful answer for the same input.
    const current = await this.load(input.root)
    this.assertProjectReadable(current, 'novel_blueprint')
    this.assertPlanningDocumentReadable(current, 'outline', 'novel_blueprint')
    this.assertArchiveIndexReadable(current, 'novel_blueprint')
    return this.mutate({
      root: input.root,
      op: 'submitBookPlan',
      key: () => `blueprint:${sha256(stableJson(input))}`,
      run: async (snapshot, context) => {
        this.assertProjectReadable(snapshot, 'novel_blueprint')
        this.assertPlanningDocumentReadable(snapshot, 'outline', 'novel_blueprint')
        this.assertArchiveIndexReadable(snapshot, 'novel_blueprint')
        const now = this.now().toISOString()
        const bookPatch = Object.fromEntries(
          Object.entries(input).filter(
            ([key]) => key !== 'volumes' && key !== 'confirm_remove' && key !== 'root',
          ),
        ) as BookPatch
        const book = mergeBookPlan(snapshot.outline.book, bookPatch)
        const volumes =
          input.volumes === undefined
            ? snapshot.outline.volumes
            : normalizeVolumes(input.volumes, { totalChapters: snapshot.project.targets.total_chapters })
        const removedVolumes = snapshot.outline.volumes
          .filter((volume) => !volumes.some((next) => next.title === volume.title))
          .map((volume) => volume.title)
        if (removedVolumes.length > 0 && input.confirm_remove !== true) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `novel_blueprint would remove volumes: ${removedVolumes.join(', ')}`,
            'pass confirm_remove:true to replace the volume list, or omit volumes to keep them',
          )
        }
        assertArchivedCardVolumes(
          snapshot.chapters.chapters,
          snapshot.outline.chapters,
          snapshot.outline.volumes,
          volumes,
          'novel_blueprint',
        )
        let chapters = snapshot.outline.chapters.map((card) => ({
          ...card,
          volume: volumeForChapter(volumes, card.num, card.volume),
        }))
        // A blueprint write must never erase the archive record just because
        // the outline file was missing or had lost a card.
        for (const record of snapshot.chapters.chapters) {
          if (chapters.some((card) => card.num === record.num)) continue
          chapters = markOutlineArchived(
            { ...snapshot.outline, updated_at: now, book, volumes, chapters },
            record,
            now,
            snapshot.project.targets.words_per_chapter,
          ).chapters
        }
        assertArchivedCardsInVolumes(snapshot.chapters.chapters, chapters, volumes, 'novel_blueprint')
        const outline: OutlineDocument = {
          ...snapshot.outline,
          updated_at: now,
          book,
          volumes,
          chapters,
        }
        this.assertOutlineWritable(snapshot, outline, 'novel_blueprint')
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          last_action: action('novel_blueprint', this.now(), shortDigest(stableJson(input))),
        })
        return {
          files: [
            { path: OUTLINE_FILE, text: yaml(outline) },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
          backup: true,
          data: {
            premise: book.premise,
            logline: book.logline,
            strict: book.strict,
            volumes: volumes.length,
            chapters: chapters.length,
          },
          event: {
            name: 'novel/planned',
            payload: {
              schemaVersion: 1,
              projectRoot: snapshot.root,
              kind: 'blueprint',
              chapters: chapters.length,
              volumes: volumes.length,
            },
          },
        }
      },
    })
  }

  private outlinePlanChange(
    snapshot: Snapshot,
    input: OutlineSubmission,
    now: string,
  ): { outline: OutlineDocument; data: OutlineMutationResult } {
    const book = mergeBookPlan(
      snapshot.outline.book,
      input.book === undefined
        ? undefined
        : { ...input.book, ...(input.strict === undefined ? {} : { strict: input.strict }) },
    )
    if (input.strict !== undefined) {
      book.strict = input.strict
      book.strict_explicit = true
    } else if (input.book?.strict === undefined) {
      // First outline submission turns strict mode on. Once the author has
      // authored a blueprint or volume, preserve their strict choice. Only an
      // actual chapter submission may flip strict; an empty volumes/book patch
      // must stay a no-op.
      const firstCardSubmission =
        (input.chapters?.length ?? 0) > 0 &&
        snapshot.outline.chapters.length === 0 &&
        snapshot.outline.book.strict_explicit !== true
      if (firstCardSubmission) {
        book.strict = true
        book.strict_explicit = true
      }
    }
    const merged = mergeOutline({
      chapters: input.chapters ?? [],
      remove: input.remove,
      volumes: input.volumes,
      remove_volumes: input.remove_volumes,
      existing: snapshot.outline.chapters,
      archivedChapters: snapshot.chapters.chapters,
      existingVolumes: snapshot.outline.volumes,
      titleRule: this.rulepack.format.title,
      totalChapters: snapshot.project.targets.total_chapters,
      defaultTargetWords: snapshot.project.targets.words_per_chapter,
      now,
      activeChapter: snapshot.pipeline.chapter,
    })
    const outline: OutlineDocument = {
      schema_version: 1,
      updated_at: now,
      book,
      volumes: merged.volumes,
      chapters: merged.chapters,
    }
    return {
      outline,
      data: {
        planned: merged.chapters.filter((card) => card.status === 'planned').length,
        archived: merged.chapters.filter((card) => card.status === 'archived').length,
        total: merged.chapters.length,
        strict: book.strict,
        volumes: merged.volumes.length,
        added: merged.added,
        updated: merged.updated,
        reindexed: merged.reindexed,
        removed: merged.removed,
        volumes_added: merged.volumes_added,
        volumes_updated: merged.volumes_updated,
        volumes_removed: merged.volumes_removed,
      },
    }
  }

  async submitOutline(input: OutlineSubmission): Promise<OpResult<OutlineMutationResult>> {
    const allowed = new Set([
      'book',
      'volumes',
      'chapters',
      'strict',
      'remove',
      'remove_volumes',
      'dry_run',
      'root',
    ])
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `unknown novel_outline argument "${key}"`,
          `allowed: ${[...allowed].join(', ')}`,
        )
      }
    }
    const current = await this.load(input.root)
    this.assertPublicBookHasNoStrictExplicit(input.book, 'novel_outline')
    this.assertProjectReadable(current, 'novel_outline')
    this.assertPlanningDocumentReadable(current, 'outline', 'novel_outline')
    this.assertArchiveIndexReadable(current, 'novel_outline')
    // An empty submission is a true no-op: it must not rewrite outline.yaml,
    // advance the pipeline or add a journal row. The old implementation treated
    // it as an implicit "delete every planned card".
    const emptyRequest =
      (input.chapters === undefined || (Array.isArray(input.chapters) && input.chapters.length === 0)) &&
      (input.remove === undefined || input.remove.length === 0) &&
      (input.remove_volumes === undefined || input.remove_volumes.length === 0) &&
      (input.volumes === undefined || (Array.isArray(input.volumes) && input.volumes.length === 0)) &&
      (input.book === undefined ||
        (typeof input.book === 'object' && input.book !== null && Object.keys(input.book).length === 0)) &&
      input.strict === undefined
    if (emptyRequest && input.dry_run !== true) {
      return {
        data: {
          planned: current.outline.chapters.filter((card) => card.status === 'planned').length,
          archived: current.outline.chapters.filter((card) => card.status === 'archived').length,
          total: current.outline.chapters.length,
          strict: current.outline.book.strict,
          volumes: current.outline.volumes.length,
          added: [],
          updated: [],
          reindexed: [],
          removed: [],
          volumes_added: [],
          volumes_updated: [],
          volumes_removed: [],
        },
        revision: current.pipeline.revision,
        warnings: [],
      }
    }
    if (input.dry_run === true) {
      const plan = this.outlinePlanChange(current, input, this.now().toISOString())
      this.assertOutlineWritable(current, plan.outline, 'novel_outline')
      return {
        data: {
          ...plan.data,
          added: [],
          updated: [],
          reindexed: [],
          removed: [],
          dry_run: true,
          would_add: plan.data.added,
          would_update: plan.data.updated,
          would_reindex: plan.data.reindexed,
          would_remove: plan.data.removed,
        },
        revision: current.pipeline.revision,
        warnings: [],
      }
    }
    return this.mutate({
      root: input.root,
      op: 'submitOutline',
      key: () => `outline:${sha256(stableJson(input))}`,
      run: async (snapshot, context) => {
        this.assertProjectReadable(snapshot, 'novel_outline')
        this.assertPlanningDocumentReadable(snapshot, 'outline', 'novel_outline')
        this.assertArchiveIndexReadable(snapshot, 'novel_outline')
        const plan = this.outlinePlanChange(snapshot, input, this.now().toISOString())
        this.assertOutlineWritable(snapshot, plan.outline, 'novel_outline')
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          last_action: action('novel_outline', this.now(), shortDigest(stableJson(input))),
        })
        const files: StagedFile[] = [
          { path: OUTLINE_FILE, text: yaml(plan.outline) },
          { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
        ]
        // Keep a one-level repair copy, aligned with chapter .deprecated files.
        const prior = await context.store.readText(OUTLINE_FILE)
        if (prior !== null) files.push({ path: OUTLINE_DEPRECATED_FILE, text: prior })
        return {
          files,
          backup: true,
          data: plan.data,
          warnings: [],
          event: {
            name: 'novel/planned',
            payload: {
              schemaVersion: 1,
              projectRoot: snapshot.root,
              kind: 'outline',
              chapters: plan.data.total,
              volumes: plan.data.volumes,
            },
          },
        }
      },
    })
  }

  async importOutline(input: OutlineImportSubmission): Promise<
    OpResult<{
      format: string
      planned: number
      archived: number
      total: number
      warnings: string[]
      preview: string
      applied: boolean
    }>
  > {
    const allowed = new Set(['format', 'content', 'dry_run', 'root'])
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `unknown novel_outline_import argument "${key}"`,
          `allowed: ${[...allowed].join(', ')}`,
        )
      }
    }
    const parsed = parseOutlineInput(input.content, input.format)
    this.assertPublicBookHasNoStrictExplicit(parsed.book, 'novel_outline_import')
    const snapshot = await this.load(input.root)
    this.assertProjectReadable(snapshot, 'novel_outline_import')
    this.assertPlanningDocumentReadable(snapshot, 'outline', 'novel_outline_import')
    this.assertArchiveIndexReadable(snapshot, 'novel_outline_import')
    const now = this.now().toISOString()
    const volumes =
      parsed.volumes.length === 0
        ? snapshot.outline.volumes
        : normalizeVolumes(parsed.volumes, { totalChapters: snapshot.project.targets.total_chapters })
    const book = mergeBookPlan(
      snapshot.outline.book,
      parsed.book.strict === undefined ? parsed.book : { ...parsed.book, strict: parsed.book.strict },
    )
    if (parsed.book.strict === undefined) {
      const firstCardSubmission =
        snapshot.outline.chapters.length === 0 && snapshot.outline.book.strict_explicit !== true
      if (firstCardSubmission) {
        book.strict = true
        book.strict_explicit = true
      }
    }
    const chapters = normalizeOutlineChapters(parsed.chapters, {
      volumes,
      existing: snapshot.outline.chapters,
      archived: snapshot.chapters.chapters,
      titleRule: this.rulepack.format.title,
      totalChapters: snapshot.project.targets.total_chapters,
      defaultTargetWords: snapshot.project.targets.words_per_chapter,
      now,
    })
    assertArchivedCardsInVolumes(snapshot.chapters.chapters, chapters, volumes, 'novel_outline_import')
    const candidate: OutlineDocument = { schema_version: 1, updated_at: now, book, volumes, chapters }
    assertArchivedCardVolumes(
      snapshot.chapters.chapters,
      snapshot.outline.chapters,
      snapshot.outline.volumes,
      volumes,
      'novel_outline_import',
    )
    this.assertActiveCardPreserved(snapshot, chapters, 'novel_outline_import')
    this.assertOutlineWritable(snapshot, candidate, 'novel_outline_import')
    const preview = diffLines(yaml(snapshot.outline), yaml(candidate))
      .hunks.filter((hunk) => hunk.kind !== 'same')
      .slice(0, 80)
      .map((hunk) => `${hunk.kind === 'add' ? '+' : '-'} ${hunk.line}`)
      .join('\n')
    const summary = {
      format: parsed.format,
      planned: chapters.filter((card) => card.status === 'planned').length,
      archived: chapters.filter((card) => card.status === 'archived').length,
      total: chapters.length,
      warnings: parsed.warnings,
    }
    if (input.dry_run === true) {
      return {
        data: { ...summary, preview, applied: false },
        revision: snapshot.pipeline.revision,
        warnings: [],
      }
    }
    const result = await this.mutate({
      root: input.root,
      op: 'importOutline',
      key: (current) => `outline-import:${current.pipeline.revision}:${sha256(input.content)}`,
      run: async (fresh, context) => {
        if (fresh.pipeline.revision !== snapshot.pipeline.revision) {
          throw new EngineFaultError(
            ERROR_CODES.TXN_ABORTED,
            `outline import was prepared against revision ${snapshot.pipeline.revision}, but the project is now at ${fresh.pipeline.revision}`,
            're-run the import against the current project; nothing was written',
          )
        }
        this.assertProjectReadable(fresh, 'novel_outline_import')
        this.assertPlanningDocumentReadable(fresh, 'outline', 'novel_outline_import')
        this.assertArchiveIndexReadable(fresh, 'novel_outline_import')
        const nextVolumes =
          parsed.volumes.length === 0
            ? fresh.outline.volumes
            : normalizeVolumes(parsed.volumes, {
                totalChapters: fresh.project.targets.total_chapters,
              })
        const nextBook = mergeBookPlan(fresh.outline.book, parsed.book)
        if (parsed.book.strict === undefined) {
          const firstCardSubmission =
            fresh.outline.chapters.length === 0 && fresh.outline.book.strict_explicit !== true
          if (firstCardSubmission) {
            nextBook.strict = true
            nextBook.strict_explicit = true
          }
        }
        const nextChapters = normalizeOutlineChapters(parsed.chapters, {
          volumes: nextVolumes,
          existing: fresh.outline.chapters,
          archived: fresh.chapters.chapters,
          titleRule: this.rulepack.format.title,
          totalChapters: fresh.project.targets.total_chapters,
          defaultTargetWords: fresh.project.targets.words_per_chapter,
          now,
        })
        assertArchivedCardVolumes(
          fresh.chapters.chapters,
          fresh.outline.chapters,
          fresh.outline.volumes,
          nextVolumes,
          'novel_outline_import',
        )
        const outline: OutlineDocument = {
          schema_version: 1,
          updated_at: now,
          book: nextBook,
          volumes: nextVolumes,
          chapters: nextChapters,
        }
        this.assertActiveCardPreserved(fresh, nextChapters, 'novel_outline_import')
        this.assertOutlineWritable(fresh, outline, 'novel_outline_import')
        const appliedPreview = diffLines(yaml(fresh.outline), yaml(outline))
          .hunks.filter((hunk) => hunk.kind !== 'same')
          .slice(0, 80)
          .map((hunk) => `${hunk.kind === 'add' ? '+' : '-'} ${hunk.line}`)
          .join('\n')
        const nextPipeline = pipelineWith(fresh, context.revision, {
          last_action: action('novel_import_outline', this.now(), shortDigest(input.content)),
        })
        const kept = new Set(nextChapters.filter((card) => card.status === 'planned').map((card) => card.num))
        const dropped = fresh.outline.chapters
          .filter((card) => card.status === 'planned' && !kept.has(card.num))
          .map((card) => card.num)
        return {
          files: [
            { path: OUTLINE_FILE, text: yaml(outline) },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
          backup: true,
          warnings:
            dropped.length === 0
              ? []
              : [
                  {
                    code: 'OUTLINE_PLANNED_DROPPED',
                    message: `this import dropped planned cards: ${dropped.join(', ')}; import the complete outline when replacing it`,
                  },
                ],
          data: {
            ...summary,
            planned: nextChapters.filter((card) => card.status === 'planned').length,
            archived: nextChapters.filter((card) => card.status === 'archived').length,
            total: nextChapters.length,
            preview: appliedPreview,
            applied: true,
          },
          event: {
            name: 'novel/planned',
            payload: {
              schemaVersion: 1,
              projectRoot: fresh.root,
              kind: 'outline',
              chapters: nextChapters.length,
              volumes: nextVolumes.length,
            },
          },
        }
      },
    })
    return result
  }

  async submitWorldbook(
    input: WorldbookSubmission,
  ): Promise<OpResult<{ sections: string[]; entries: number; counts: Record<string, number> }>> {
    const allowed = new Set([
      'premise',
      'setting',
      'rules',
      'factions',
      'locations',
      'characters',
      'glossary',
      'backstory',
      'facts',
      'themes',
    ])
    const keys = Object.entries(input)
      .filter(([key, value]) => key !== 'root' && value !== undefined)
      .map(([key]) => key)
    const unknown = keys.filter((key) => !allowed.has(key))
    if (unknown.length > 0) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `unknown worldbook section(s): ${unknown.join(', ')}`,
      )
    }
    if (keys.length === 0) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'worldbook update requires at least one section',
        'send premise, setting, rules, factions, locations, characters, glossary, backstory or themes',
      )
    }
    const current = await this.load(input.root)
    this.assertProjectReadable(current, 'novel_worldbook')
    this.assertPlanningDocumentReadable(current, 'worldbook', 'novel_worldbook')
    return this.mutate({
      root: input.root,
      op: 'submitWorldbook',
      key: () => `worldbook:${sha256(stableJson(input))}`,
      run: async (snapshot, context) => {
        this.assertProjectReadable(snapshot, 'novel_worldbook')
        this.assertPlanningDocumentReadable(snapshot, 'worldbook', 'novel_worldbook')
        const now = this.now().toISOString()
        const worldbook = mergeWorldbook(snapshot.worldbook, input, now)
        const counts = {
          premise: worldbook.premise === '' ? 0 : 1,
          setting: worldbook.setting === '' ? 0 : 1,
          themes: worldbook.themes.length,
          rules: worldbook.rules.length,
          factions: worldbook.factions.length,
          locations: worldbook.locations.length,
          characters: worldbook.characters.length,
          glossary: worldbook.glossary.length,
          backstory: worldbook.backstory.length,
          facts: (worldbook.facts ?? []).length,
        }
        const entries =
          counts.characters +
          counts.locations +
          counts.factions +
          counts.rules +
          counts.glossary +
          counts.backstory +
          counts.facts
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          last_action: action('novel_worldbook', this.now(), shortDigest(stableJson(input))),
        })
        return {
          files: [
            { path: WORLDBOOK_FILE, text: yaml(worldbook) },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
          backup: true,
          data: { sections: keys, entries, counts },
          event: {
            name: 'novel/planned',
            payload: {
              schemaVersion: 1,
              projectRoot: snapshot.root,
              kind: 'worldbook',
              chapters: 0,
              volumes: 0,
            },
          },
        }
      },
    })
  }

  async reopenChapter(
    input: ReopenSubmission,
  ): Promise<OpResult<{ chapter: number; stage: Stage; restore_txid: string }>> {
    this.assertChapterParameter(input.chapter)
    if (typeof input.reason !== 'string' || input.reason.trim() === '') {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'reopen requires a non-empty reason',
        'state why the archived chapter must be restored; the reason is written to the journal',
      )
    }
    const reason = input.reason.trim()
    const current = await this.load(input.root)
    this.assertProjectReadable(current, 'novel_reopen')
    if (current.outlineError !== null) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_INVALID,
        `cannot reopen while ${OUTLINE_FILE} is unreadable: ${current.outlineError}`,
        `repair ${OUTLINE_FILE} with novel_amend first; reopening would overwrite it with an empty outline`,
      )
    }
    return this.mutate({
      root: input.root,
      op: 'reopenChapter',
      chapter: input.chapter,
      reason,
      key: () => `reopen:${input.chapter}:${shortDigest(reason)}`,
      run: async (snapshot, context) => {
        this.assertProjectReadable(snapshot, 'novel_reopen')
        if (snapshot.outlineError !== null) {
          throw new EngineFaultError(
            ERROR_CODES.SCHEMA_INVALID,
            `cannot reopen while ${OUTLINE_FILE} is unreadable: ${snapshot.outlineError}`,
            `repair ${OUTLINE_FILE} with novel_amend first; reopening would overwrite it with an empty outline`,
          )
        }
        const record = snapshot.chapters.chapters.find((row) => row.num === input.chapter)
        if (record === undefined) {
          throw new EngineInputError(
            ERROR_CODES.STAGE_ORDER,
            `chapter ${input.chapter} is not archived`,
            'only an archived chapter can be reopened',
          )
        }
        if (snapshot.pipeline.chapter !== input.chapter + 1) {
          throw new EngineInputError(
            ERROR_CODES.STAGE_ORDER,
            `chapter ${input.chapter} is not the immediately preceding chapter (active is ${snapshot.pipeline.chapter})`,
            'archive or finish the active chapter before reopening an older one',
          )
        }
        if (snapshot.pipeline.stage !== 'done' || snapshot.text !== null) {
          throw new EngineInputError(
            ERROR_CODES.STAGE_ORDER,
            `chapter ${input.chapter} cannot be reopened while chapter ${snapshot.pipeline.chapter} is in progress`,
            'finish and archive the active chapter, or remove chapters/chapter-<N>.md from the project, before reopening the previous one; novel_rollback alone keeps the manuscript',
          )
        }
        const { records } = await readJournal(this.storeFor(snapshot.root))
        const archive = [...records]
          .reverse()
          .find(
            (row) =>
              row.status === 'committed' && row.op === 'archiveChapter' && row.chapter === input.chapter,
          )
        if (archive === undefined) {
          throw new EngineFaultError(
            ERROR_CODES.TXN_ABORTED,
            `no committed archive transaction found for chapter ${input.chapter}`,
            'restore the journal or re-archive before reopening',
          )
        }
        const beforeHashes =
          archive.before ??
          records.find((row) => row.txid === archive.txid && row.before !== undefined)?.before
        const store = this.storeFor(snapshot.root)
        const changedAfterArchive: string[] = []
        if (archive.hashes !== undefined) {
          for (const path of archive.files) {
            if (
              path === joinRel(STATE_DIR, STATE_FILES.pipeline) ||
              path === OUTLINE_FILE ||
              path === ARCHIVE_DIGESTS
            ) {
              continue
            }
            const expected = archive.hashes[path]
            if (expected === undefined) continue
            const actual = await store.hashBytes(path)
            if (actual !== expected) changedAfterArchive.push(path)
          }
        }
        if (changedAfterArchive.length > 0) {
          throw new EngineFaultError(
            ERROR_CODES.TXN_ABORTED,
            `refusing to reopen: ${changedAfterArchive.join(', ')} changed after chapter ${input.chapter} was archived`,
            'move the amended files aside or restore the archived versions first; reopening would overwrite them silently',
          )
        }
        const files: StagedFile[] = []
        for (const path of archive.files) {
          if (
            path === joinRel(STATE_DIR, STATE_FILES.pipeline) ||
            path === OUTLINE_FILE ||
            path === planChapterFile(input.chapter)
          )
            continue
          const hasBeforeEntry = beforeHashes !== undefined && Object.hasOwn(beforeHashes, path)
          const expectedBefore = hasBeforeEntry ? beforeHashes![path] : undefined
          if (hasBeforeEntry && expectedBefore === null) {
            // The archive created this file; its pre-image is absence. A fresh
            // empty digest ledger is the closest representable restore.
            if (path === ARCHIVE_DIGESTS) files.push({ path, text: '{}\n' })
            continue
          }
          const backup = await store.readText(joinRel(BACKUP_DIR, archive.txid, path))
          if (backup === null) {
            if (path === ARCHIVE_DIGESTS) {
              // A pre-0.2.0 journal has no `before` map, so a missing backup
              // cannot prove whether this file existed before the archive.
              // Writing `{}` would silently erase the idempotency ledger.
              if (beforeHashes === undefined || hasBeforeEntry) {
                throw new EngineFaultError(
                  ERROR_CODES.TXN_ABORTED,
                  `backup snapshot for ${path} is missing (${joinRel(BACKUP_DIR, archive.txid)})`,
                  'reopening is impossible after the backup was pruned; restore the file manually',
                )
              }
              files.push({ path, text: '{}\n' })
              continue
            }
            // A journal written before 0.2.0 has no `before` map. In that case
            // the backup directory is the only evidence; skipping a missing
            // pre-image would silently restore only part of the project.
            if (beforeHashes === undefined || hasBeforeEntry) {
              throw new EngineFaultError(
                ERROR_CODES.TXN_ABORTED,
                `backup snapshot for ${path} is missing (${joinRel(BACKUP_DIR, archive.txid)})`,
                'reopening is impossible after the backup was pruned; restore the file manually',
              )
            }
            // A file absent from the map was created by the archive; no
            // pre-image exists and there is nothing to restore.
            continue
          }
          files.push({ path, text: backup })
        }
        const reopenedAt = this.now().toISOString()
        let outline = markOutlineReopened(
          snapshot.outline,
          input.chapter,
          reopenedAt,
          record,
          snapshot.project.targets.words_per_chapter,
        )
        // snapshot.plan belongs to the active chapter (chapter + 1), not the
        // chapter being reopened. Read the archived chapter's own plan so the
        // reopened card and the P2 contract stay aligned.
        const planRaw = await store.readText(planChapterFile(input.chapter))
        if (planRaw === null) {
          throw new EngineFaultError(
            ERROR_CODES.SCHEMA_INVALID,
            `chapter ${input.chapter} has no stored plan; reopening would leave P3 without a plan`,
            `restore ${planChapterFile(input.chapter)} from backups/ before reopening`,
          )
        }
        const plan = parsePlanYaml(planRaw, planChapterFile(input.chapter))
        validateStoredChapterPlan(plan, planChapterFile(input.chapter))
        const planCast = Array.isArray(plan.cast)
          ? plan.cast
              .map((member) => (recordOf(member)?.name as string | undefined) ?? '')
              .filter((name) => name !== '')
          : []
        outline = {
          ...outline,
          chapters: outline.chapters.map((card) =>
            card.num === input.chapter
              ? {
                  ...card,
                  title: stripChapterPrefix(plan.title as string),
                  scene_type: plan.scene_type as import('../types.js').SceneType,
                  target_words: plan.target_words as [number, number],
                  cast: planCast,
                }
              : card,
          ),
        }
        try {
          validateOutlineDocument(outline, {
            titleRule: this.rulepack.format.title,
            totalChapters: snapshot.project.targets.total_chapters,
          })
        } catch (error) {
          throw new EngineFaultError(
            ERROR_CODES.SCHEMA_INVALID,
            `reopen would write an invalid ${OUTLINE_FILE}: ${errorMessage(error)}`,
            `restore a valid ${OUTLINE_FILE} from backups/, or repair it with novel_amend before reopening`,
            { cause: error },
          )
        }
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          chapter: input.chapter,
          stage: 'P3',
          rounds: { review: 0, revise: 0, check: 0 },
          briefs: {},
          blocking: [],
          review_digest: undefined,
          draft: {
            chapter: input.chapter,
            title: stripChapterPrefix(plan.title as string),
            scene_type: plan.scene_type as import('../types.js').SceneType,
            narrator: plan.narrator as string,
            summary: record.summary,
            content_hash: record.content_hash,
            updated_at: reopenedAt,
          },
          last_action: action('novel_reopen', this.now(), shortDigest(reason)),
        })
        delete (nextPipeline as { review_digest?: string }).review_digest
        files.push({ path: OUTLINE_FILE, text: yaml(outline) })
        files.push({ path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) })
        return {
          files,
          backup: true,
          data: { chapter: input.chapter, stage: 'P3' as Stage, restore_txid: archive.txid },
          event: {
            name: 'novel/reopened',
            payload: {
              schemaVersion: 1,
              projectRoot: snapshot.root,
              chapter: input.chapter,
              restore_txid: archive.txid,
            },
          },
        }
      },
    })
  }

  /* --------------------------------------------------------------- queries */

  /**
   * Restore one active chapter from a backup transaction. Archived chapters
   * are refused: their manuscript hash is bound by the index, so restoring
   * behind the index would corrupt the project. Reopen first, then restore.
   */
  async restoreBackup(
    input: RestoreSubmission,
  ): Promise<OpResult<{ txid: string; chapter: number; restored: string[] }>> {
    if (typeof input.txid !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.txid)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'restore txid must be a transaction UUID')
    }
    if (input.chapter !== undefined) this.assertChapterParameter(input.chapter)
    if (input.paths !== undefined && (!Array.isArray(input.paths) || input.paths.length === 0)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'restore paths must be a non-empty array')
    }
    const pipelinePath = joinRel(STATE_DIR, STATE_FILES.pipeline)
    const pipelineOnly = input.paths?.length === 1 && input.paths[0] === pipelinePath
    return this.mutate({
      root: input.root,
      op: 'restoreBackup',
      chapter: input.chapter,
      reason: `restore backup ${input.txid}`,
      ...(pipelineOnly ? { allowPipelineRecovery: true, repairPaths: [pipelinePath] } : {}),
      // A restore is repair, not a pure read: the same txid/paths is still
      // meaningful after an external edit changed the target again. Replaying
      // the cached answer would report success without touching the file.
      run: async (snapshot, context) => {
        const manifest = await readBackupManifest(context.store, input.txid)
        if (manifest === null) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `backup ${input.txid} has no readable manifest`,
            'list backups with novel_state {kind:"backups"}; only marked engine backups can be restored',
          )
        }
        if (pipelineOnly) {
          if (input.chapter !== undefined) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              'restoring state/pipeline.yaml does not accept a chapter',
              'omit chapter when paths is exactly [state/pipeline.yaml]',
            )
          }
          if (!manifest.files.includes(pipelinePath)) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `backup ${input.txid} does not contain ${pipelinePath}`,
              'choose a backup created by a stage operation or amend that contains the pipeline',
            )
          }
          if (snapshot.pipelineError === null) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              'state/pipeline.yaml is readable; refusing a blind pipeline restore',
              'use the normal stage operation, or repair a genuinely unreadable pipeline',
            )
          }
          const text = await context.store.readText(`backups/${input.txid}/${pipelinePath}`)
          if (text === null) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `backup ${input.txid} does not contain ${pipelinePath}`,
              'choose another backup with a pipeline pre-image',
            )
          }
          let backupPipeline: PipelineState
          try {
            backupPipeline = narrow('pipeline', parseYaml(text)) as unknown as PipelineState
          } catch (error) {
            throw new EngineFaultError(
              ERROR_CODES.SCHEMA_INVALID,
              `backup ${input.txid} contains an invalid pipeline: ${errorMessage(error)}`,
              'choose a different backup or repair the file manually',
            )
          }
          const nextPipeline: PipelineState = {
            ...backupPipeline,
            revision: context.revision,
            last_action: action('novel_restore', this.now(), shortDigest(input.txid)),
          }
          return {
            files: [{ path: pipelinePath, text: yaml(nextPipeline) }],
            backup: true,
            data: { txid: input.txid, chapter: nextPipeline.chapter, restored: [pipelinePath] },
            warnings: [],
          }
        }
        const outlineOnly = input.paths?.length === 1 && input.paths[0] === OUTLINE_FILE
        if (outlineOnly) {
          this.assertArchiveIndexReadable(snapshot, 'novel_restore')
          if (input.chapter !== undefined) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              'restoring outline/outline.yaml does not accept a chapter',
              'omit chapter when paths is exactly [outline/outline.yaml]',
            )
          }
          if (!manifest.files.includes(OUTLINE_FILE)) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `backup ${input.txid} does not contain ${OUTLINE_FILE}`,
              'choose a backup created by novel_outline, novel_blueprint or a planning amendment',
            )
          }
          const text = await context.store.readText(`backups/${input.txid}/${OUTLINE_FILE}`)
          if (text === null) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `backup ${input.txid} does not contain ${OUTLINE_FILE}`,
              'the file was created by that transaction, so it has no pre-image to restore',
            )
          }
          let document: OutlineDocument
          try {
            document = validateOutlineDocument(parseYaml(text), {
              titleRule: this.rulepack.format.title,
              totalChapters: snapshot.project.targets.total_chapters,
            })
          } catch (error) {
            throw new EngineFaultError(
              ERROR_CODES.SCHEMA_INVALID,
              `backup ${input.txid} contains an invalid outline: ${errorMessage(error)}`,
              'restore a different backup or repair the file manually',
            )
          }
          assertArchivedCardVolumes(
            snapshot.chapters.chapters,
            snapshot.outline.chapters,
            snapshot.outline.volumes,
            document.volumes,
            'novel_restore',
          )
          assertArchivedCardsInVolumes(
            snapshot.chapters.chapters,
            document.chapters,
            document.volumes,
            'novel_restore',
          )
          const restoredCards = new Map(document.chapters.map((card) => [card.num, card]))
          const archivedNums = new Set(snapshot.chapters.chapters.map((record) => record.num))
          for (const record of snapshot.chapters.chapters) {
            const restoredCard = restoredCards.get(record.num)
            if (restoredCard?.status !== 'archived') {
              throw new EngineFaultError(
                ERROR_CODES.SCHEMA_INVALID,
                `backup ${input.txid} would make archived chapter ${record.num} ${restoredCard === undefined ? 'missing its card' : 'a planned card'}`,
                'call novel_reopen before restoring a pre-archive outline, or choose an outline backup that already contains the archived card',
              )
            }
          }
          for (const card of document.chapters) {
            if (card.status === 'archived' && !archivedNums.has(card.num)) {
              throw new EngineFaultError(
                ERROR_CODES.SCHEMA_INVALID,
                `backup ${input.txid} would restore an archived card for chapter ${card.num}, but that chapter is not archived`,
                'choose an outline backup that matches the current chapter index, or reopen/archive the chapter first',
              )
            }
          }
          const files: StagedFile[] = [{ path: OUTLINE_FILE, text }]
          const prior = await context.store.readText(OUTLINE_FILE)
          if (prior !== null) files.push({ path: OUTLINE_DEPRECATED_FILE, text: prior })
          const nextPipeline = pipelineWith(snapshot, context.revision, {
            last_action: action('novel_restore', this.now(), shortDigest(input.txid)),
          })
          files.push({ path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) })
          return {
            files,
            backup: true,
            data: { txid: input.txid, chapter: snapshot.pipeline.chapter, restored: [OUTLINE_FILE] },
            warnings: [],
          }
        }
        // 0.2.14: a ledger amendment has a pre-image, so a mistaken amend must
        // be restorable instead of only repairable by hand.
        const ledgerKinds: Record<string, DocKind> = {
          [joinRel(STATE_DIR, STATE_FILES.characters)]: 'characters',
          [joinRel(STATE_DIR, STATE_FILES.world)]: 'world',
          [joinRel(STATE_DIR, STATE_FILES.locks)]: 'locks',
          [joinRel(STATE_DIR, STATE_FILES.timeline)]: 'timeline',
          [joinRel(STATE_DIR, STATE_FILES.foreshadows)]: 'foreshadows',
          [joinRel(STATE_DIR, STATE_FILES.relationships)]: 'relationships',
          [joinRel(STATE_DIR, STATE_FILES.handoff)]: 'handoff',
          // 0.2.17: the chapter index is archive evidence. It is no longer in
          // the amend repair window, so restoring its pre-image is the only
          // sanctioned repair — which keeps a damaged index from being rewritten
          // in place by a caller that never had to prove the old rows.
          [joinRel(STATE_DIR, STATE_FILES.chapters)]: 'chapters',
        }
        // Named once so the dangling-reference hint can point at the ledger
        // that would have to be restored alongside.
        const charactersPath = joinRel(STATE_DIR, STATE_FILES.characters)
        const handoffPath = joinRel(STATE_DIR, STATE_FILES.handoff)
        const ledgerPaths = (input.paths ?? []).filter((path) => ledgerKinds[path] !== undefined)
        if (ledgerPaths.length > 0) {
          if (ledgerPaths.length !== (input.paths ?? []).length) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              'restore mixes ledger files with chapter or outline files',
              `restore either ledger files (${Object.keys(ledgerKinds).join(', ')}) or chapter files in one call`,
            )
          }
          if (input.chapter !== undefined) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              'restoring a state ledger does not accept a chapter',
              'omit chapter when restoring state/*.yaml',
            )
          }
          const restored: string[] = []
          const files: StagedFile[] = []
          const current: Record<string, unknown> = {
            characters: snapshot.characters,
            world: snapshot.world,
            locks: snapshot.locks,
            timeline: snapshot.timeline,
            foreshadows: snapshot.foreshadows,
            relationships: snapshot.relationships,
            handoff: snapshot.handoff,
          }
          for (const path of ledgerPaths) {
            const kind = ledgerKinds[path]!
            if (!manifest.files.includes(path)) {
              throw new EngineInputError(
                ERROR_CODES.SCHEMA_INVALID,
                `backup ${input.txid} manifest does not record ${path}`,
                'restore only files that the transaction captured as pre-images',
              )
            }
            const text = await context.store.readText(`backups/${input.txid}/${path}`)
            if (text === null) {
              throw new EngineInputError(
                ERROR_CODES.SCHEMA_INVALID,
                `backup ${input.txid} does not contain ${path}`,
                'the file was created by that transaction, so it has no pre-image to restore',
              )
            }
            let document: unknown
            try {
              document = narrow(kind, parseYaml(text))
            } catch (error) {
              throw new EngineFaultError(
                ERROR_CODES.SCHEMA_INVALID,
                `backup ${input.txid} contains an invalid ${kind} document: ${errorMessage(error)}`,
                'choose a different backup or repair the file manually',
              )
            }
            const before = recordOf(current[kind])
            const after = recordOf(document)
            // next_seq is the id allocator: restoring an older ledger that has
            // already issued FS-030 would re-issue FS-030 on the next archive.
            if (
              before !== null &&
              after !== null &&
              typeof before.next_seq === 'number' &&
              typeof after.next_seq === 'number' &&
              after.next_seq < before.next_seq
            ) {
              throw new EngineInputError(
                ERROR_CODES.SCHEMA_INVALID,
                `backup ${input.txid} would move ${kind}.next_seq back from ${before.next_seq} to ${after.next_seq}`,
                'ids already issued must never be reissued; edit the restored next_seq forward, or restore a newer backup',
              )
            }
            // 0.2.17: comparing only against the current ledger missed a backup
            // older than an archive — its allocator re-issued FS-0xx ids that
            // state/chapters.yaml already recorded.
            if (
              (kind === 'foreshadows' || kind === 'timeline' || kind === 'relationships') &&
              after !== null &&
              typeof after.next_seq === 'number'
            ) {
              const floor = ledgerIdFloor(kind, snapshot.chapters, snapshot.handoff)
              if (after.next_seq <= floor) {
                throw new EngineInputError(
                  ERROR_CODES.SCHEMA_INVALID,
                  `backup ${input.txid} would set ${kind}.next_seq to ${after.next_seq}, but chapter archives already issued ids up to ${floor}`,
                  'ids already issued must never be reissued; edit the restored next_seq forward, or restore a newer backup',
                )
              }
            }
            files.push({ path, text })
            restored.push(path)
            current[kind] = document
          }
          // A restore may only put back a pre-image, never a ledger that names
          // rows the rest of the state does not have (R2).
          const before = ledgerReferenceProblems(
            {
              characters: snapshot.characters,
              locks: snapshot.locks,
              timeline: snapshot.timeline,
              relationships: snapshot.relationships,
              handoff: snapshot.handoff,
            },
            snapshot.project.targets.total_chapters,
          )
          const after = ledgerReferenceProblems(
            {
              characters: current.characters as Snapshot['characters'],
              locks: current.locks as Snapshot['locks'],
              timeline: current.timeline as Snapshot['timeline'],
              relationships: current.relationships as Snapshot['relationships'],
              handoff: current.handoff as Snapshot['handoff'],
            },
            snapshot.project.targets.total_chapters,
          )
          const alreadyBroken = new Set(before)
          const introduced = after.filter((problem) => !alreadyBroken.has(problem))
          if (introduced.length > 0) {
            // A restore can only replay the files this transaction captured as
            // pre-images, so "restore the other ledgers too" is advice the
            // author cannot follow unless the manifest holds them.
            const candidates = [charactersPath, handoffPath].filter(
              (path) => manifest.files.includes(path) && !restored.includes(path),
            )
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `backup ${input.txid} would dangle ${introduced.length} cross-ledger reference(s): ${introduced
                .slice(0, 3)
                .join('; ')}`,
              candidates.length > 0
                ? `also restore ${candidates.join(', ')} in this call, or edit the restored file so those rows are declared`
                : `backup ${input.txid} captured only ${restored.join(', ')}; edit the restored file so those rows are declared, or restore a transaction that captured the declaring ledger`,
            )
          }
          const nextPipeline = pipelineWith(snapshot, context.revision, {
            last_action: action('novel_restore', this.now(), shortDigest(input.txid)),
          })
          files.push({ path: pipelinePath, text: yaml(nextPipeline) })
          return {
            files,
            backup: true,
            data: { txid: input.txid, chapter: snapshot.pipeline.chapter, restored },
            warnings: [
              {
                code: 'LEDGER_RESTORED',
                message: `restored ${restored.length} ledger file(s) from ${input.txid}; chapter files were not touched`,
              },
            ],
          }
        }
        const chapter = input.chapter ?? snapshot.pipeline.chapter
        if (snapshot.chapters.chapters.some((record) => record.num === chapter)) {
          throw new EngineInputError(
            ERROR_CODES.STAGE_ORDER,
            `chapter ${chapter} is archived; restoring it behind the index would break its content hash`,
            'call novel_reopen for the chapter, then restore the backup',
          )
        }
        if (chapter !== snapshot.pipeline.chapter) {
          throw new EngineInputError(
            ERROR_CODES.STAGE_ORDER,
            `chapter ${chapter} is not the active chapter ${snapshot.pipeline.chapter}; restore only the active chapter`,
            'switch the active chapter first, or restore files from the active chapter',
          )
        }
        if (manifest.chapter !== chapter) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `backup ${input.txid} belongs to chapter ${manifest.chapter}, not chapter ${chapter}`,
            'choose a backup whose manifest chapter matches the active chapter',
          )
        }
        const fileFor = (path: string): string => `backups/${input.txid}/${path}`
        const allowed = [
          chapterFile(chapter),
          planChapterFile(chapter),
          planWorldFile(chapter),
          reviewFile(chapter),
          checkFile(chapter),
        ]
        const requested = input.paths ?? allowed.filter((path) => manifest.files.includes(path))
        for (const path of requested) {
          if (!allowed.includes(path)) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `restore path ${path} is not a chapter file for chapter ${chapter}`,
              `allowed: ${allowed.join(', ')}`,
            )
          }
        }
        if (requested.length === 0) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `backup ${input.txid} contains no restorable file for chapter ${chapter}`,
            'choose a backup whose files include the chapter you are restoring',
          )
        }
        const files: StagedFile[] = []
        let restoredReview: ReviewDocument | null = null
        let restoredCheck: CheckDocument | null = null
        for (const path of requested) {
          if (!manifest.files.includes(path)) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `backup ${input.txid} manifest does not record ${path}`,
              'restore only files that the transaction captured as pre-images',
            )
          }
          const text = await context.store.readText(fileFor(path))
          if (text === null) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `backup ${input.txid} does not contain ${path}`,
              'the file was created by that transaction, so it has no pre-image to restore',
            )
          }
          const kind: DocKind | null =
            path === planChapterFile(chapter)
              ? 'chapterPlan'
              : path === planWorldFile(chapter)
                ? 'worldPlan'
                : path === reviewFile(chapter)
                  ? 'review'
                  : path === checkFile(chapter)
                    ? 'check'
                    : null
          if (kind !== null) {
            try {
              const parsed = parseYaml(text)
              const row = recordOf(parsed)
              if (row === null) throw new Error('document is not a mapping')
              if (kind === 'chapterPlan') {
                // The narrow schema intentionally omits P2's cast/summary
                // extensions; use the same validator the live plan loader uses.
                validateStoredChapterPlan(row, path)
                if (row.chapter !== chapter) {
                  throw new Error(`document belongs to chapter ${String(row.chapter)}, not ${chapter}`)
                }
              } else if (kind === 'worldPlan') {
                validateWorldPlanShape(narrow('worldPlan', parsed), path)
                if (row.chapter !== chapter) {
                  throw new Error(`document belongs to chapter ${String(row.chapter)}, not ${chapter}`)
                }
              } else {
                // A 0.2.0 check has no `scope` and keeps advisories inside
                // `violations`; restoring it verbatim used to fail validation
                // and, worse, would have replayed an advisory as a blocker (U16).
                const document =
                  kind === 'check' ? normalizeLegacyCheck(parsed as Record<string, unknown>) : parsed
                const restored = narrow(kind, document)
                if (restored.chapter !== chapter) {
                  throw new Error(`document belongs to chapter ${String(restored.chapter)}, not ${chapter}`)
                }
                if (kind === 'review') restoredReview = restored as unknown as ReviewDocument
                if (kind === 'check') restoredCheck = restored as unknown as CheckDocument
              }
            } catch (error) {
              throw new EngineFaultError(
                ERROR_CODES.SCHEMA_INVALID,
                `backup ${input.txid} contains an invalid ${kind} document: ${errorMessage(error)}`,
                'restore a different backup or repair the file manually',
              )
            }
          }
          files.push({ path, text })
        }
        // A restored manuscript/plan no longer matches the live draft summary.
        // Drop that summary rather than allowing the next archive to seal a
        // fresh summary against an old body; the author must re-draft or re-plan.
        const clearDraft =
          requested.includes(chapterFile(chapter)) || requested.includes(planChapterFile(chapter))
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          last_action: action('novel_restore', this.now(), shortDigest(input.txid)),
        })
        if (clearDraft) delete nextPipeline.draft
        // The review file is digest-bound at archive. Restoring it must restore
        // the same binding, not leave a digest for the review it replaced.
        if (restoredReview !== null) {
          nextPipeline.review_digest = sha256(stableJson(restoredReview))
        }
        // Pipeline.blocking is derived evidence. Restoring an older clean
        // review/check must not leave the newer failure's blockers in status.
        if (restoredReview !== null || restoredCheck !== null) {
          const effectiveReview = restoredReview ?? snapshot.review
          const effectiveCheck = restoredCheck ?? snapshot.check
          const reviewBlocking: BlockingItem[] =
            effectiveReview === null
              ? []
              : [
                  ...effectiveReview.issues
                    .filter((issue) => issue.severity === 'blocker' && issue.status !== 'fixed')
                    .map((issue) => ({
                      code: `ISSUE-${issue.id}`,
                      scope: issue.dimension,
                      detail: `${issue.problem} → ${issue.fix}`,
                      hint: issue.location,
                    })),
                  ...(effectiveReview.total < this.config.quality.minScore
                    ? [
                        {
                          code: 'SCORE-BELOW-MIN',
                          scope: 'quality',
                          detail: `score ${effectiveReview.total} is below the minimum ${this.config.quality.minScore}`,
                          hint: 'revise the chapter and submit a new P4 review',
                        },
                      ]
                    : []),
                ]
          const checkMatches =
            effectiveCheck !== null && effectiveCheck.content_hash === sha256(snapshot.text ?? '')
          const checkBlocking: BlockingItem[] =
            effectiveCheck === null || !checkMatches || effectiveCheck.verdict === 'pass'
              ? []
              : [
                  // A 0.2.0 check stored advisories inside `violations`; only
                  // blockers may come back as pipeline blocking (X5).
                  ...effectiveCheck.machine.violations
                    .filter((violation) => violation.severity !== 'advisory')
                    .map((violation) => ({
                      code: violation.code,
                      scope: 'check',
                      detail: violation.detail,
                    })),
                  ...evaluateSemantic(snapshot.text ?? '', effectiveCheck.semantic.items).blocking,
                ]
          nextPipeline.blocking = [...reviewBlocking, ...checkBlocking]
        }
        files.push({ path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) })
        return {
          files,
          backup: true,
          data: { txid: input.txid, chapter, restored: requested },
          warnings: clearDraft
            ? [
                {
                  code: 'RESTORE_DRAFT_CLEARED',
                  message:
                    'the restored manuscript/plan invalidated the live draft summary; call novel_rollback to P3, then submit novel_write_draft again',
                },
              ]
            : [],
          event: {
            name: 'novel/restored',
            payload: {
              schemaVersion: 1,
              projectRoot: snapshot.root,
              txid: input.txid,
              chapter,
              paths: requested,
            },
          },
        }
      },
    })
  }

  /**
   * Read-only paths must surface a committed-journal mismatch. The write path
   * already fails closed; without this, status recommends the next write and
   * the model only learns about the mismatch when that write aborts.
   */
  private async journalBlocking(snapshot: Snapshot): Promise<BlockingItem[]> {
    const store = this.storeFor(snapshot.root)
    // A stale lock left by a crash must not hide journal damage. load() already
    // waited for a live writer, so only a live lock suppresses this check.
    if (await this.lockIsLive(store)) return []
    const pending = await inspectPending(store)
    if (pending.state === 'partial') {
      return [
        {
          code: ERROR_CODES.PENDING_PARTIAL,
          scope: 'journal',
          detail: `pending transaction ${pending.txid ?? 'unknown'} partially changed the project: ${pending.detail ?? 'mixed before/after hashes'}`,
          hint: `do not restore the whole project; inspect ${pending.stagingDir ?? 'staging'}/before/ or state/journal.jsonl first`,
        },
      ]
    }
    const projectPresent = await store.exists(PROJECT_FILE)
    if (projectPresent) {
      const journalPresent = await store.exists(joinRel(STATE_DIR, STATE_FILES.journal))
      const journal = journalPresent ? await readJournal(store) : null
      if (!journalPresent || journal === null || !hasCommittedJournal(journal.records)) {
        return [
          {
            code: 'JOURNAL_MISSING',
            scope: 'journal',
            detail: journalPresent
              ? 'state/journal.jsonl has no committed project transaction'
              : 'state/journal.jsonl is missing',
            hint: 'restore the journal from a backup; writes are disabled until a committed history exists',
          },
        ]
      }
    }
    try {
      const { malformed, mismatches } = await reconcileJournal(store)
      // A writer may have acquired the lock after the check above and be
      // between renames. Those files are not external corruption; retry on the
      // next read instead of reporting every half-committed path.
      if (mismatches.length > 0 && (await this.lockIsLive(store))) return []
      const items: BlockingItem[] = []
      if (malformed > 0) {
        items.push({
          code: 'JOURNAL_MALFORMED',
          scope: 'journal',
          detail: `${malformed} malformed journal line(s)`,
          hint: 'inspect the journal with novel_audit; restore a known-good journal before writing',
        })
      }
      for (const mismatch of mismatches) {
        items.push({
          code: 'JOURNAL_HASH_MISMATCH',
          scope: 'journal',
          detail: `${mismatch.path} changed after commit ${mismatch.txid}`,
          hint: 'restore the file from backups/ or inspect with novel_audit; writes remain fail-closed',
        })
      }
      return items
    } catch (error) {
      return [
        {
          code: 'JOURNAL_UNREADABLE',
          scope: 'journal',
          detail: errorMessage(error),
          hint: 'inspect state/journal.jsonl and restore a known-good copy',
        },
      ]
    }
  }

  /**
   * Count review attempts per archived chapter. The journal is authoritative;
   * history fills any per-chapter gap where it has more distinct historical
   * reviews than committed journal rows (legacy or a truncated upgrade). A
   * chapter can never report fewer attempts than readable current reviews.
   */
  private async reviewAttemptsByChapter(
    store: FsStore,
    journalRows: readonly AuditRow[],
    archived: readonly number[],
    // Optional: report() already knows which current reviews it could read.
    // Readers that do not (status, pipeline) resolve it lazily, and only for a
    // chapter with no journal row and no history copy, where it can change the
    // answer. Skipping the full sweep keeps a status refresh cheap without
    // letting status and report disagree on the same book (U6/M19).
    readableCurrent?: ReadonlySet<number>,
    historicalEntries?: readonly HistoryEntry[],
  ): Promise<Map<number, number>> {
    const journalCounts = new Map<number, number>()
    for (const row of journalRows) {
      if (row.status === 'committed' && row.op === 'submitReview') {
        journalCounts.set(row.chapter, (journalCounts.get(row.chapter) ?? 0) + 1)
      }
    }
    const result = new Map<number, number>()
    if (archived.length === 0) return result
    const entries = historicalEntries ?? (await listHistory(store))
    const historyEntryCounts = new Map<number, number>()
    for (const entry of entries) {
      if (entry.kind !== 'reviews') continue
      historyEntryCounts.set(entry.chapter, (historyEntryCounts.get(entry.chapter) ?? 0) + 1)
    }
    const historyCounts = new Map<number, number>()
    // Read history when it can exceed the committed journal count. This covers
    // both a fully missing journal and a journal with two rows but four
    // distinct historical reviews.
    const needHistory = archived.filter(
      (chapter) => (historyEntryCounts.get(chapter) ?? 0) > (journalCounts.get(chapter) ?? 0),
    )
    for (const chapter of needHistory) {
      const documents = new Set<string>()
      try {
        const current = await store.readDoc(reviewFile(chapter), 'review')
        if (current !== null) documents.add(stableJson(current))
      } catch {
        // report() surfaces the unreadable review; attempts still count the
        // best evidence available.
      }
      for (const historical of await historyTexts(store, 'reviews', chapter, entries)) {
        try {
          documents.add(stableJson(narrow('review', parseYaml(historical.text))))
        } catch {
          // A malformed history copy is not an attempt.
        }
      }
      historyCounts.set(chapter, documents.size)
    }
    for (const chapter of archived) {
      const journalCount = journalCounts.get(chapter) ?? 0
      const historyCount = historyCounts.get(chapter) ?? 0
      let readable = readableCurrent?.has(chapter) ?? false
      if (!readable && readableCurrent === undefined && journalCount === 0 && historyCount === 0) {
        try {
          readable = (await store.readDoc(reviewFile(chapter), 'review')) !== null
        } catch {
          readable = false
        }
      }
      result.set(chapter, Math.max(journalCount, readable ? 1 : 0, historyCount))
    }
    return result
  }

  /**
   * Count every committed attempt for one chapter, not just the loop since the
   * last rollback. `pipeline.rounds` is deliberately reset by rollback to keep
   * the retry budget fair; it is not the chapter's lifetime effort.
   */
  private async lifetimeRounds(snapshot: Snapshot, chapter: number): Promise<RoundCounters> {
    const store = this.storeFor(snapshot.root)
    const { rows } = await readJournal(store)
    const committed = (op: string): number =>
      rows.filter((row) => row.status === 'committed' && row.chapter === chapter && row.op === op).length
    // The archived snapshot must record the same review count the read model
    // will report, so a history copy counts here too (U6/M19).
    const attempts = await this.reviewAttemptsByChapter(store, rows, [chapter])
    return {
      review: Math.max(
        snapshot.pipeline.rounds.review,
        committed('submitReview'),
        attempts.get(chapter) ?? 0,
      ),
      revise: Math.max(snapshot.pipeline.rounds.revise, committed('submitRevision')),
      check: Math.max(snapshot.pipeline.rounds.check, committed('runCheck')),
      rollbacks: committed('rollback'),
    }
  }

  /**
   * The only owner of effort arithmetic: journal rows, the chapter record and
   * review history are merged per chapter, then summed once. Report, status,
   * pipeline and the panel all read this projection.
   */
  private effortProjection(
    chapters: ChaptersDocument,
    committed: readonly AuditRow[],
    reviewCounts: ReadonlyMap<number, number> | null = null,
  ): {
    lifetime: { reviews: number; revisions: number; checks: number; rollbacks: number }
    chapters: Map<number, { reviews: number; revisions: number; checks: number; rollbacks: number }>
    basis: 'committed_journal' | 'chapter_record'
  } {
    const count = (op: string, chapter: number): number =>
      committed.filter((row) => row.status === 'committed' && row.op === op && row.chapter === chapter).length
    const rows = new Map<number, { reviews: number; revisions: number; checks: number; rollbacks: number }>()
    const lifetime = { reviews: 0, revisions: 0, checks: 0, rollbacks: 0 }
    for (const record of chapters.chapters) {
      const entry = {
        reviews: Math.max(
          record.rounds?.review ?? 0,
          count('submitReview', record.num),
          reviewCounts?.get(record.num) ?? 0,
        ),
        revisions: Math.max(record.rounds?.revise ?? 0, count('submitRevision', record.num)),
        checks: Math.max(record.rounds?.check ?? 0, count('runCheck', record.num)),
        rollbacks: Math.max(record.rounds?.rollbacks ?? 0, count('rollback', record.num)),
      }
      rows.set(record.num, entry)
      lifetime.reviews += entry.reviews
      lifetime.revisions += entry.revisions
      lifetime.checks += entry.checks
      lifetime.rollbacks += entry.rollbacks
    }
    return {
      lifetime,
      chapters: rows,
      basis: committed.some((row) => row.status === 'committed') ? 'committed_journal' : 'chapter_record',
    }
  }

  /**
   * Waivers carried from the previous chapter's check. Chaining one chapter
   * back keeps this O(1) while still honouring `acknowledge_until_chapter`
   * across a whole run: chapter N stores what chapter N+1 needs (M8).
   */
  private async carriedAcknowledgements(
    snapshot: Snapshot,
    chapter: number,
  ): Promise<NonNullable<CheckDocument['machine']['acknowledged_findings']>> {
    if (chapter <= 1) return []
    const store = this.storeFor(snapshot.root)
    const previous = (await store
      .readDoc(checkFile(chapter - 1), 'check')
      .catch(() => null)) as unknown as CheckDocument | null
    if (previous === null || previous === undefined) return []
    const findings = (previous.machine?.acknowledged_findings ??
      previous.acknowledged_findings ??
      []) as NonNullable<CheckDocument['machine']['acknowledged_findings']>
    return carryAcknowledgements(findings, chapter)
  }

  /** Journal-backed lifetime effort, using chapter rounds as the floor. */
  private async lifetimeEffort(
    store: FsStore,
    chapters: ChaptersDocument,
  ): Promise<ReturnType<EngineService['effortProjection']>> {
    let committed: AuditRow[] = []
    try {
      committed = (await readJournal(store)).rows
    } catch {
      // A damaged journal is already reported elsewhere; use the chapter floor.
    }
    // Review history fills journal gaps, so a lifetime that ignored it would
    // disagree with report() on the same book (U6/M19).
    const attempts = await this.reviewAttemptsByChapter(
      store,
      committed,
      chapters.chapters.map((record) => record.num),
    )
    return this.effortProjection(chapters, committed, attempts)
  }

  /** One dialogue verdict shared by status, check and the brief. */
  private dialogueVerdict(
    targets: NovelProject['targets'],
    metrics: WordMetrics,
  ): 'pass' | 'line_out' | 'char_out' | 'both_out' | 'skewed' | 'unconfigured' {
    const target = targets.dialogue_ratio
    const metric = targets.dialogue_ratio_metric ?? 'both'
    const lower = Math.max(0, target[0] - 0.005)
    const upper = Math.min(1, target[1] + 0.005)
    const line = metrics.dialogue_ratio
    const chars = metrics.dialogue_char_ratio ?? 0
    const lineOut = line < lower || line > upper
    const charOut = chars < lower || chars > upper
    if (!lineOut && !charOut) return 'pass'
    if (metric === 'lines') return lineOut ? 'line_out' : 'pass'
    if (metric === 'chars') return charOut ? 'char_out' : 'pass'
    if (lineOut && charOut) return 'both_out'
    return 'skewed'
  }

  /** 0.2.13 read model: pipeline rounds reset after archive, chapter records do not. */
  private previousChapterEffort(
    snapshot: Snapshot,
    totals: { reviews: number; revisions: number; checks: number; rollbacks: number },
    projection?: {
      chapters: Map<number, { reviews: number; revisions: number; checks: number; rollbacks: number }>
      basis: 'committed_journal' | 'chapter_record'
    },
  ): StatusReport['previous_chapter_effort'] {
    const prior = [...snapshot.chapters.chapters].sort((left, right) => right.num - left.num)[0]
    if (prior === undefined) return null
    const entry = projection?.chapters.get(prior.num)
    return {
      chapter: prior.num,
      // Journal backfill, not `record.rounds ?? 0`: old chapters archived
      // without rounds used to report 0 while the totals had the real number (X1).
      reviews: entry?.reviews ?? prior.rounds?.review ?? 0,
      revisions: entry?.revisions ?? prior.rounds?.revise ?? 0,
      checks: entry?.checks ?? prior.rounds?.check ?? 0,
      rollbacks: entry?.rollbacks ?? prior.rounds?.rollbacks ?? 0,
      final_check: prior.final_check ?? null,
      archived_at: prior.archived_at ?? null,
      basis: projection?.basis ?? 'unavailable',
      totals: { ...totals },
    }
  }

  async getStatus(input: StatusInput = {}): Promise<OpResult<StatusReport>> {
    if (input.chapter !== undefined) this.assertChapterParameter(input.chapter)
    const snapshot = await this.load(input.root)
    return this.statusFor(snapshot, input.chapter ?? snapshot.pipeline.chapter)
  }

  /**
   * Build a status report from an already-loaded snapshot. This deliberately
   * has no selection side effect: read-only callers such as /novel resume must
   * not register or bind the project just by reading it.
   */
  /**
   * 0.2.17: a hand-edited `novel.yaml` can name a pack that does not exist. That
   * must not block reading or writing the book, so it becomes a warning on the
   * read models instead of an error.
   */
  private styleWarnings(snapshot: Snapshot): Warning[] {
    const raw = snapshot.project.style
    if (typeof raw !== 'string' || raw === '' || this.stylepacks.has(raw)) return []
    return [
      {
        code: 'STYLE_UNKNOWN',
        message: `novel.yaml.style names an unknown pack "${raw}"; style rules are dormant until it is fixed`,
      },
    ]
  }

  /**
   * 0.2.17: the one-line style verdict the panel's overview shows.
   *
   * `unset` and `not-migrated` are different states: `unset` is a deliberate
   * "no style", `not-migrated` is an old project that could still choose one.
   */
  private styleOverview(snapshot: Snapshot): {
    id: string | null
    name: string | null
    verdict: 'pass' | 'attention' | 'unset' | 'not-migrated' | 'no-draft'
    findings: string[]
  } {
    const pack = this.stylepackFor(snapshot.project)
    if (pack === null) {
      return {
        id: null,
        name: null,
        verdict: snapshot.project.style === undefined ? 'not-migrated' : 'unset',
        findings: [],
      }
    }
    const text = snapshot.text ?? ''
    // An empty chapter has no style to judge. Reporting "pass" for it would be
    // the same class of lie the 0.2.17 evidence work exists to remove.
    if (text.trim() === '') {
      return { id: pack.id, name: pack.name, verdict: 'no-draft', findings: [] }
    }
    // Only the style rules: the overview needs their findings, not the format
    // and lexicon passes, which every gate already ran on this text.
    const findings = runRules(
      Object.values(STYLE_RULES),
      text,
      this.machineOptions(snapshot, {
        title: snapshot.plan?.title ?? null,
        sceneType: snapshot.plan?.scene_type,
        summary: snapshot.plan?.summary ?? null,
      }),
    ).map((violation) => violation.detail)
    return {
      id: pack.id,
      name: pack.name,
      verdict: findings.length === 0 ? 'pass' : 'attention',
      findings: findings.slice(0, 6),
    }
  }

  private async statusFor(snapshot: Snapshot, chapter: number): Promise<OpResult<StatusReport>> {
    const metrics = await this.metricsFor(snapshot, chapter)
    const stylepack = this.stylepackFor(snapshot.project)
    const styleWarnings = this.styleWarnings(snapshot)
    let projection: ReturnType<EngineService['effortProjection']> | undefined
    try {
      const rows = (await readJournal(this.storeFor(snapshot.root))).rows
      // Same inputs as report(): a review history copy that the journal never
      // recorded must not make status report a shorter lifetime than report.
      const attempts = await this.reviewAttemptsByChapter(
        this.storeFor(snapshot.root),
        rows,
        snapshot.chapters.chapters.map((record) => record.num),
      )
      projection = this.effortProjection(snapshot.chapters, rows, attempts)
    } catch {
      projection = undefined
    }
    const effortTotals = projection?.lifetime ?? { reviews: 0, revisions: 0, checks: 0, rollbacks: 0 }
    const progress = projectChapterProgress({
      activeChapter: snapshot.pipeline.chapter,
      stage: snapshot.pipeline.stage,
      archived: snapshot.chapters.chapters.map((record) => record.num),
      target: snapshot.project.targets.total_chapters,
    })
    const journal = await this.journalBlocking(snapshot)
    const pending = await inspectPending(this.storeFor(snapshot.root))
    const pendingWarnings: Warning[] =
      pending.state === 'complete' || pending.state === 'untouched'
        ? [
            {
              code: pending.state === 'complete' ? 'PENDING_RECOVERABLE' : 'PENDING_ABORTABLE',
              message: `${pending.detail ?? 'pending transaction detected'} (${pending.txid ?? 'unknown'})`,
            },
          ]
        : []
    const next =
      journal.length > 0 && this.stateErrors(snapshot).length === 0
        ? {
            tool: 'novel_audit',
            args: {},
            reason: `${journal[0]!.code}: ${journal[0]!.detail}; inspect and restore before the next write`,
          }
        : this.nextStep(snapshot)
    const report: StatusReport = {
      project: {
        title: snapshot.project.title,
        genre: snapshot.project.genre,
        platform: snapshot.project.platform,
        root: snapshot.root,
      },
      chapter,
      active_chapter: snapshot.pipeline.chapter,
      manuscript_hash:
        snapshot.pipeline.draft !== undefined && snapshot.text !== null ? sha256(snapshot.text) : null,
      stage: snapshot.pipeline.stage,
      progress,
      rounds: { ...snapshot.pipeline.rounds },
      previous_chapter_effort: this.previousChapterEffort(snapshot, effortTotals, projection),
      blocking: [...this.effectiveBlocking(snapshot), ...journal],
      ...(pendingWarnings.length === 0 && styleWarnings.length === 0
        ? {}
        : { warnings: [...pendingWarnings, ...styleWarnings] }),
      state_errors: this.stateErrors(snapshot),
      selection: { source: snapshot.selection.source, root: snapshot.selection.root },
      metrics,
      target_words: {
        min: snapshot.project.targets.words_per_chapter[0],
        max: snapshot.project.targets.words_per_chapter[1],
        includes_punctuation: true,
        min_cjk_chars: snapshot.project.targets.min_cjk_chars ?? null,
        basis: 'total_word_count = cjk_chars + english_words + numbers + punctuation_chars',
      },
      ...(metrics === null
        ? {}
        : {
            dialogue: {
              // C6: `target` is the style aiming point (null without a pack) and
              // `range` is the range the user confirmed at creation. The old
              // shape reused `target` for the range, which made the two
              // impossible to tell apart once a pack existed.
              target: stylepack === null ? null : stylepack.dialogue.ratio,
              range: snapshot.project.targets.dialogue_ratio,
              metric: snapshot.project.targets.dialogue_ratio_metric ?? 'both',
              line_ratio: metrics.dialogue_ratio,
              char_ratio: metrics.dialogue_char_ratio ?? 0,
              verdict: this.dialogueVerdict(snapshot.project.targets, metrics),
            },
          }),
      // 0.2.17: the book's style, plus the downgrade note when the confirmation
      // dialog could not be shown. A silent downgrade would look like a
      // confirmed choice, which is exactly what WP13 exists to prevent.
      style: stylepack === null ? null : { id: stylepack.id, name: stylepack.name },
      ...(snapshot.project.style === undefined ? {} : { style_id: snapshot.project.style }),
      ...(snapshot.project.style_confirmation === undefined
        ? {}
        : { style_confirmation: snapshot.project.style_confirmation }),
      ...(snapshot.handoff === null
        ? {}
        : (() => {
            const position = projectHandoff(snapshot.handoff, snapshot.pipeline.chapter)
            return {
              volume: position.volume,
              volume_name: position.volume_name,
              act: position.act,
              act_progress: position.act_progress,
            }
          })()),
      book: this.bookStatus(snapshot),
      next,
    }
    return { data: report, revision: snapshot.pipeline.revision, warnings: [] }
  }

  /**
   * 0.2.17: is the one-shot style migration still available for this project?
   *
   * The tool layer asks the user only when this is open; `amendProblems` remains
   * the authority on whether a write is legal. Exposing the question here keeps
   * the tool from re-deriving the three-part condition (§4.4) and drifting.
   */
  async styleMigration(
    input: { root?: string } = {},
  ): Promise<OpResult<{ open: boolean; current: string | null | undefined; archived: number }>> {
    const snapshot = await this.load(input.root)
    const archived = snapshot.chapters.chapters.filter((row) => row.archived_at != null).length
    // Chapter FILES count too: an index that lost a row must not look like "no
    // chapters archived". The active chapter's manuscript is not an archive.
    const archivedFiles = (await this.storeFor(snapshot.root).list(CHAPTERS_DIR))
      .map((name) => /^chapter-(\d+)\.md$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
      .filter((num) => num !== snapshot.pipeline.chapter).length
    return {
      data: {
        open: snapshot.project.style === undefined && styleWindowOpen(snapshot.chapters, archivedFiles),
        current: snapshot.project.style,
        archived,
      },
      revision: snapshot.pipeline.revision,
      warnings: [],
    }
  }

  async countWords(input: WordCountInput = {}): Promise<OpResult<WordMetrics>> {
    // The counting rule is pure: callers may count arbitrary text before a
    // project exists. project_root is ignored in text mode (and documented as
    // such on the tool schema); it does not create a session binding.
    if (input.text !== undefined) {
      return { data: countWordMetrics(input.text), revision: 1, warnings: [] }
    }
    if (input.chapter !== undefined) this.assertChapterParameter(input.chapter)
    const snapshot = await this.load(input.root)
    const text =
      (input.chapter === undefined ? snapshot.text : await this.readChapter(snapshot, input.chapter)) ?? ''
    return { data: countWordMetrics(text), revision: snapshot.pipeline.revision, warnings: [] }
  }

  private statePage<T>(
    kind: StateQueryInput['kind'],
    rows: T[],
    input: StateQueryInput,
    filters: Record<string, unknown>,
  ): { items: T[]; page: StatePage } {
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'limit must be a positive integer (1..200)')
    }
    const limit = Math.min(STATE_PAGE_MAX, input.limit ?? STATE_SECTION_DEFAULT_LIMIT(kind))
    const filtersHash = sha256(stableJson(filters))
    const offset = input.cursor === undefined ? 0 : decodeStateCursor(input.cursor, kind, filtersHash).offset
    if (offset > rows.length) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `cursor offset ${offset} is beyond ${kind} total ${rows.length}`,
        'start without cursor; the ledger may have changed since this cursor was issued',
      )
    }
    const items = rows.slice(offset, offset + limit)
    const nextOffset = offset + items.length
    return {
      items,
      page: {
        total: rows.length,
        returned: items.length,
        limit,
        next_cursor:
          nextOffset < rows.length
            ? encodeStateCursor({ section: kind, offset: nextOffset, filters_hash: filtersHash })
            : null,
        has_more: nextOffset < rows.length,
        filters,
      },
    }
  }

  async queryState(input: StateQueryInput): Promise<OpResult<unknown>> {
    const result = await this.queryStateUnsafe(input)
    // A read model must be JSON-serializable: callers proxy it over HTTP. Drop
    // `undefined` members instead of letting JSON.stringify silently omit them,
    // and fall back to an error summary rather than throwing at the wire.
    return { ...result, data: jsonSafeValue(result.data) }
  }

  private async queryStateUnsafe(input: StateQueryInput): Promise<OpResult<unknown>> {
    if (input.chapter !== undefined) this.assertChapterParameter(input.chapter)
    const snapshot = await this.load(input.root)
    const chapter = input.chapter ?? snapshot.pipeline.chapter
    if (input.revision !== undefined && input.kind !== 'history') {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'revision is only meaningful for kind:"history"',
        'request history with chapter+revision, or omit revision for current documents',
      )
    }
    const range = input.chapter_range
    if (range !== undefined) {
      if (
        !Array.isArray(range) ||
        range.length !== 2 ||
        !Number.isInteger(range[0]) ||
        !Number.isInteger(range[1]) ||
        range[0] < 1 ||
        range[1] < range[0]
      ) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          'chapter_range must be [start, end] positive integers with start <= end',
        )
      }
    }
    const store = this.storeFor(snapshot.root)
    const ledgerPath = LEDGER_PATHS[input.kind]
    if (ledgerPath !== undefined) {
      const damage = snapshot.ledgerErrors.find((error) => error.path === ledgerPath)
      if (damage !== undefined) {
        const raw = await store.readText(damage.path)
        return {
          data: {
            error: damage.code,
            message: damage.message,
            path: damage.path,
            // 0.2.14 (R3): a damaged ledger still answers "how much is in here",
            // so the author can choose between restoring and repairing.
            damaged: true,
            summary: damagedLedgerSummary(raw),
            ...rawForRepair(raw),
          },
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
    }
    switch (input.kind) {
      case 'pipeline':
        // `pipeline.briefs` is a legacy fallback; the effective receipts live in
        // state/briefs.yaml and are merged into snapshot.briefs at load time.
        const legacyBriefCount = Object.keys(snapshot.pipeline.briefs ?? {}).length
        // A20: the label must name the store that actually answered. A
        // pre-0.2.13 book has no receipt file at all, and once the file exists
        // the loader ignores the legacy map entirely — reporting the pair in
        // either case named a file that either did not exist or did not count.
        const receiptFilePresent = (await store.readText(BRIEF_RECEIPTS_FILE)) !== null
        const receiptSource =
          Object.keys(snapshot.briefs).length === 0
            ? 'none'
            : !receiptFilePresent
              ? 'pipeline.briefs (legacy)'
              : legacyBriefCount === 0
                ? BRIEF_RECEIPTS_FILE
                : `${BRIEF_RECEIPTS_FILE} (pipeline.briefs ignored)`
        const effort = await this.lifetimeEffort(store, snapshot.chapters)
        return {
          data: {
            ...snapshot.pipeline,
            briefs: snapshot.briefs,
            // Only claim the receipt file when it is the file that answered; a
            // legacy project with receipts solely in pipeline.briefs said
            // state/briefs.yaml and no such file existed (U8).
            briefs_source: receiptSource,
            briefs_note:
              'briefs 只列出当前章 current 收据；历史收据在 history/briefs/ 与 novel_state {kind:"briefs", view:"current"}',
            // 0.2.14 (R9): pipeline is where a writer looks after an archive,
            // and it reset every round counter. Carrying the same projection
            // status uses keeps "how hard was the last chapter" one number.
            previous_chapter_effort: this.previousChapterEffort(snapshot, effort.lifetime, effort),
            // R9: the same lifetime totals report/status use, so the pipeline
            // view is not the one place where "how much work" is missing.
            effort: { lifetime: effort.lifetime, basis: effort.basis },
          },
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      case 'chapters': {
        const range = input.chapter_range
        if (range !== undefined) {
          if (
            !Array.isArray(range) ||
            range.length !== 2 ||
            !Number.isInteger(range[0]) ||
            !Number.isInteger(range[1]) ||
            range[0] < 1 ||
            range[1] < range[0]
          ) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              'chapter_range must be [start, end] positive integers with start <= end',
            )
          }
        }
        const rows =
          range === undefined
            ? snapshot.chapters.chapters
            : snapshot.chapters.chapters.filter((row) => row.num >= range[0] && row.num <= range[1])
        const { items, page } = this.statePage('chapters', rows, input, {
          ...(range === undefined ? {} : { chapter_range: range }),
          include_summary: input.include_summary === true,
        })
        const data =
          input.include_summary === true
            ? { schema_version: 1 as const, chapters: items, page }
            : {
                schema_version: 1 as const,
                chapters: items.map((row) => ({
                  num: row.num,
                  title: row.title,
                  word_count: row.word_count,
                  // R7: `null` means the row predates 0.2.14; the count is not
                  // missing, it was never recorded.
                  cjk_words: row.cjk_words ?? null,
                  score: row.score,
                  status: row.status,
                })),
                page,
              }
        return { data, revision: snapshot.pipeline.revision, warnings: [] }
      }
      case 'characters': {
        const { items, page } = this.statePage('characters', snapshot.characters.characters, input, {})
        return {
          data: { ...snapshot.characters, characters: items, page },
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
      case 'world': {
        const groups = ['locations', 'abilities', 'artifacts', 'factions', 'rules'] as const
        const rows = groups.flatMap((group) =>
          (snapshot.world[group] as unknown[]).map((value) => ({ group, value })),
        )
        const { items, page } = this.statePage('world', rows, input, {})
        const grouped: Record<(typeof groups)[number], unknown[]> = {
          locations: [],
          abilities: [],
          artifacts: [],
          factions: [],
          rules: [],
        }
        for (const item of items) grouped[item.group].push(item.value)
        return {
          data: { ...snapshot.world, ...grouped, page },
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
      case 'locks': {
        const rows: Array<{
          kind: 'character' | 'location'
          name: string
          value: unknown
        }> = [
          ...Object.entries(snapshot.locks.characters).map(([name, value]) => ({
            kind: 'character' as const,
            name,
            value,
          })),
          ...Object.entries(snapshot.locks.locations).map(([name, value]) => ({
            kind: 'location' as const,
            name,
            value,
          })),
        ]
        const { items, page } = this.statePage('locks', rows, input, {})
        const characters: Record<string, unknown> = {}
        const locations: Record<string, unknown> = {}
        for (const item of items) {
          if (item.kind === 'character') characters[item.name] = item.value
          else locations[item.name] = item.value
        }
        return {
          data: { ...snapshot.locks, characters, locations, page },
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
      case 'timeline': {
        const range = input.chapter_range
        const chapterEvents = new Map<number, readonly string[]>()
        for (const record of snapshot.chapters.chapters) {
          chapterEvents.set(record.num, record.summary.events)
        }
        // Legacy rows have no event_key. Their key must be derived from the
        // event's position in summary.events, not from its position after the
        // ledger has been sorted (or after another row is missing). Otherwise
        // a sparse ledger silently attaches the wrong stable key to an event.
        type TimelineRow = (typeof snapshot.timeline.items)[number]
        const groups = new Map<number, Array<{ item: TimelineRow; index: number; eventIndex?: number }>>()
        for (const [index, item] of snapshot.timeline.items.entries()) {
          const group = groups.get(item.chapter) ?? []
          group.push({ item, index })
          groups.set(item.chapter, group)
        }
        const keyIndex = (item: TimelineRow): number | null => {
          const match = /^E(\d+)-(\d+)-[0-9a-f]+$/.exec(item.event_key ?? '')
          if (match === null || Number(match[1]) !== item.chapter) return null
          return Number(match[2]) - 1
        }
        const allWithKeys: Array<{
          item: TimelineRow
          eventIndex: number
          sourceIndex: number
        }> = []
        for (const [chapter, group] of groups) {
          const events = chapterEvents.get(chapter)
          const used = new Set<number>()
          // Reserve indexes proven by explicit keys before assigning legacy
          // rows, so a mixed ledger cannot make two rows claim one event.
          for (const row of group) {
            const explicit = keyIndex(row.item)
            if (
              explicit === null ||
              (events !== undefined && explicit >= events.length) ||
              used.has(explicit)
            ) {
              continue
            }
            row.eventIndex = explicit
            used.add(explicit)
          }
          for (const row of group) {
            if (row.eventIndex !== undefined) continue
            let eventIndex: number | undefined
            if (events !== undefined) {
              eventIndex = events.findIndex(
                (event, index) => !used.has(index) && event === row.item.description,
              )
              if (eventIndex < 0) eventIndex = undefined
            }
            if (eventIndex === undefined) {
              // A legacy row whose description differs from the summary event
              // cannot be matched by text. Use the next unclaimed position,
              // preserving the ledger's own order for that chapter.
              eventIndex = 0
              while (used.has(eventIndex)) eventIndex += 1
              if (events !== undefined && eventIndex >= events.length) {
                eventIndex = group.findIndex((candidate) => candidate === row)
              }
            }
            row.eventIndex = eventIndex
            used.add(eventIndex)
          }
          for (const row of group) {
            const assignedIndex = row.eventIndex ?? 0
            const canonicalEvent = events?.[assignedIndex] ?? row.item.description
            allWithKeys.push({
              item: {
                ...row.item,
                event_key:
                  row.item.event_key === undefined || row.item.event_key === ''
                    ? eventKeyFor(chapter, assignedIndex, canonicalEvent)
                    : row.item.event_key,
              },
              eventIndex: assignedIndex,
              sourceIndex: row.index,
            })
          }
        }
        const rows = allWithKeys
          .filter(
            (row) => range === undefined || (row.item.chapter >= range[0] && row.item.chapter <= range[1]),
          )
          .sort(
            (left, right) =>
              left.item.chapter - right.item.chapter ||
              left.eventIndex - right.eventIndex ||
              left.sourceIndex - right.sourceIndex,
          )
          .map((row) => row.item)
        const { items, page } = this.statePage('timeline', rows, input, {
          ...(range === undefined ? {} : { chapter_range: range }),
        })
        return {
          data: { ...snapshot.timeline, items, page },
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
      case 'foreshadows': {
        const allowed = new Set(['open', 'planted', 'dormant', 'advanced', 'resolved'])
        if (input.status !== undefined && !allowed.has(input.status)) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `unknown foreshadow status: ${input.status}`,
            `status must be one of ${[...allowed].join(', ')}`,
          )
        }
        const range = input.chapter_range
        const filtered = snapshot.foreshadows.items.filter(
          (item) =>
            (input.status === undefined ||
              (input.status === 'open' ? item.status !== 'resolved' : item.status === input.status)) &&
            (range === undefined || (item.last_touched >= range[0] && item.last_touched <= range[1])),
        )
        const { items, page } = this.statePage('foreshadows', filtered, input, {
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(range === undefined ? {} : { chapter_range: range }),
          include_history: input.include_history === true,
        })
        const shaped = items.map((item) =>
          input.include_history === true
            ? item
            : {
                ...item,
                advance_count: item.advance_log.length,
                advance_log: undefined,
              },
        )
        return {
          data: { ...snapshot.foreshadows, items: shaped, page },
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
      case 'relationships': {
        const range = input.chapter_range
        const rows =
          range === undefined
            ? snapshot.relationships.items
            : snapshot.relationships.items.filter((item) => item.since >= range[0] && item.since <= range[1])
        const { items, page } = this.statePage('relationships', rows, input, {
          ...(range === undefined ? {} : { chapter_range: range }),
        })
        return {
          data: { ...snapshot.relationships, items, page },
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
      case 'handoff':
        return { data: snapshot.handoff, revision: snapshot.pipeline.revision, warnings: [] }
      case 'outline':
        if (snapshot.outlineError !== null) {
          return {
            data: {
              error: 'OUTLINE_UNREADABLE',
              message: snapshot.outlineError,
              path: OUTLINE_FILE,
              ...rawForRepair(await store.readText(OUTLINE_FILE)),
            },
            revision: snapshot.pipeline.revision,
            warnings: [],
          }
        }
        return { data: snapshot.outline, revision: snapshot.pipeline.revision, warnings: [] }
      case 'worldbook':
        if (snapshot.worldbookError !== null) {
          return {
            data: {
              error: 'WORLDBOOK_UNREADABLE',
              message: snapshot.worldbookError,
              path: WORLDBOOK_FILE,
              ...rawForRepair(await store.readText(WORLDBOOK_FILE)),
            },
            revision: snapshot.pipeline.revision,
            warnings: [],
          }
        }
        return { data: snapshot.worldbook, revision: snapshot.pipeline.revision, warnings: [] }
      case 'briefs': {
        const receipts = await this.readBriefReceipts(store)
        const currentOnly = input.current_only === true || input.view === 'current'
        const pageFilters = {
          ...(input.chapter === undefined ? {} : { chapter: input.chapter }),
          current_only: currentOnly,
          ...(input.view === undefined ? {} : { view: input.view }),
        }
        // Archive compresses superseded receipts into history/briefs/chNNN.yaml.
        // Reading both keeps "the whole audit is still here" true while the hot
        // file stays bounded.
        const historyRows: Array<BriefReceiptsDocument['receipts'][number] & { archived?: true }> = []
        try {
          for (const name of await store.list('history/briefs')) {
            const match = /^ch(\d+)\.yaml$/.exec(name)
            if (match === null) continue
            const chapter = Number(match[1])
            if (input.chapter !== undefined && chapter !== input.chapter) continue
            const text = await store.readText(`history/briefs/${name}`)
            if (text === null) continue
            const parsed = parseYaml(text) as Partial<BriefReceiptsDocument> | null
            if (parsed === null || !Array.isArray(parsed.receipts)) continue
            for (const receipt of parsed.receipts) {
              if (typeof receipt?.digest !== 'string' || typeof receipt?.stage !== 'string') continue
              historyRows.push({ ...receipt, current: false, archived: true })
            }
          }
        } catch {
          // A damaged history file is reported by doctor; the live receipts
          // remain readable and are the ones gates use.
        }
        const filterReceipts = <T extends { chapter: number; current?: boolean }>(rows: T[]): T[] =>
          rows.filter(
            (receipt) =>
              (input.chapter === undefined || receipt.chapter === input.chapter) &&
              (!currentOnly || receipt.current !== false),
          )
        if (receipts.receipts.length > 0 || historyRows.length > 0) {
          const filtered = filterReceipts([...receipts.receipts, ...historyRows])
          const { items, page } = this.statePage('briefs', filtered, input, pageFilters)
          return {
            data: {
              schema_version: 1 as const,
              receipts: items,
              history_receipts: historyRows.length,
              page,
            },
            revision: snapshot.pipeline.revision,
            warnings: [],
          }
        }
        // 0.2.0 projects signed briefs in pipeline.briefs and have no receipt
        // file. The loader already falls back to that map for gates; expose the
        // same legacy view instead of reporting an empty audit trail.
        const legacy = Object.entries(snapshot.briefs).map(([stage, receipt]) => ({
          chapter: snapshot.pipeline.chapter,
          stage,
          digest: receipt.digest,
          issued_at: receipt.issued_at,
          current: true as const,
        }))
        const { items, page } = this.statePage('briefs', filterReceipts(legacy), input, pageFilters)
        return {
          data: { schema_version: 1 as const, receipts: items, page },
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
      case 'history': {
        const entries = await listHistory(store, input.chapter, { withChars: true })
        if (input.revision !== undefined) {
          if (!Number.isInteger(input.revision) || input.revision < 1) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              'history revision must be a positive integer',
            )
          }
          const matching = entries.filter(
            (entry) => entry.chapter === chapter && entry.revision === input.revision,
          )
          const contents = []
          for (const entry of matching) {
            contents.push({
              ...entry,
              text: await store.readText(entry.path),
            })
          }
          return {
            data: { schema_version: 1, chapter, revision: input.revision, files: contents },
            revision: snapshot.pipeline.revision,
            warnings: [],
          }
        }
        const { items, page } = this.statePage('history', entries, input, {
          ...(input.chapter === undefined ? {} : { chapter: input.chapter }),
        })
        return {
          data: { schema_version: 1, entries: items, total: entries.length, page },
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
      case 'backups': {
        const backups = await listBackups(store)
        const { items, page } = this.statePage('backups', backups, input, {})
        return {
          data: { schema_version: 1, backups: items, page },
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
      case 'review': {
        if (chapter === snapshot.pipeline.chapter && snapshot.reviewError !== null) {
          return {
            data: {
              error: 'REVIEW_UNREADABLE',
              message: snapshot.reviewError,
              path: reviewFile(chapter),
              ...rawForRepair(await store.readText(reviewFile(chapter))),
            },
            revision: snapshot.pipeline.revision,
            warnings: [],
          }
        }
        const document =
          chapter === snapshot.pipeline.chapter
            ? snapshot.review
            : ((await store.readDoc(reviewFile(chapter), 'review')) as unknown as ReviewDocument | null)
        return { data: document, revision: snapshot.pipeline.revision, warnings: [] }
      }
      case 'check': {
        if (chapter === snapshot.pipeline.chapter && snapshot.checkError !== null) {
          return {
            data: {
              error: 'CHECK_UNREADABLE',
              message: snapshot.checkError,
              path: checkFile(chapter),
              ...rawForRepair(await store.readText(checkFile(chapter))),
            },
            revision: snapshot.pipeline.revision,
            warnings: [],
          }
        }
        const document =
          chapter === snapshot.pipeline.chapter
            ? snapshot.check
            : ((await store.readDoc(checkFile(chapter), 'check')) as unknown as CheckDocument | null)
        return { data: document, revision: snapshot.pipeline.revision, warnings: [] }
      }
      case 'novel':
        if (snapshot.projectError !== null) {
          return {
            data: {
              error: 'PROJECT_UNREADABLE',
              message: snapshot.projectError,
              path: PROJECT_FILE,
              ...rawForRepair(await store.readText(PROJECT_FILE)),
            },
            revision: snapshot.pipeline.revision,
            warnings: [],
          }
        }
        return { data: snapshot.project, revision: snapshot.pipeline.revision, warnings: [] }
      case 'planWorld': {
        if (chapter === snapshot.pipeline.chapter) {
          if (snapshot.worldPlanError !== null) {
            throw new EngineFaultError(
              ERROR_CODES.SCHEMA_INVALID,
              `${planWorldFile(chapter)}: ${snapshot.worldPlanError}`,
              'run novel_status and repair or re-plan the world plan',
            )
          }
          return { data: snapshot.worldPlan, revision: snapshot.pipeline.revision, warnings: [] }
        }
        const raw = await store.readText(planWorldFile(chapter))
        if (raw === null) {
          return { data: null, revision: snapshot.pipeline.revision, warnings: [] }
        }
        const parsed = parsePlanYaml(raw, planWorldFile(chapter))
        const narrowed = narrow('worldPlan', parsed)
        validateWorldPlanShape(narrowed, planWorldFile(chapter))
        return {
          data: narrowed as unknown,
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
      case 'planChapter': {
        if (chapter === snapshot.pipeline.chapter) {
          if (snapshot.planError !== null) {
            throw new EngineFaultError(
              ERROR_CODES.SCHEMA_INVALID,
              `${planChapterFile(chapter)}: ${snapshot.planError}`,
              'run novel_status and repair or re-plan the chapter',
            )
          }
          return { data: snapshot.plan, revision: snapshot.pipeline.revision, warnings: [] }
        }
        const raw = await store.readText(planChapterFile(chapter))
        return {
          data: raw === null ? null : parsePlanYaml(raw, planChapterFile(chapter)),
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
      default:
        throw new EngineInputError(ERROR_CODES.CONFIG_INVALID, `unknown state kind ${String(input.kind)}`)
    }
  }

  async advise(input: { root?: string } = {}): Promise<
    OpResult<{
      stage: Stage
      chapter: number
      progress: ChapterProgress
      tool: string
      args: Record<string, unknown>
      reason: string
      blocking: BlockingItem[]
      state_errors: StateError[]
    }>
  > {
    const snapshot = await this.load(input.root)
    const progress = projectChapterProgress({
      activeChapter: snapshot.pipeline.chapter,
      stage: snapshot.pipeline.stage,
      archived: snapshot.chapters.chapters.map((record) => record.num),
      target: snapshot.project.targets.total_chapters,
    })
    const journal = await this.journalBlocking(snapshot)
    const next =
      journal.length > 0 && this.stateErrors(snapshot).length === 0
        ? {
            tool: 'novel_audit',
            args: {},
            reason: `${journal[0]!.code}: ${journal[0]!.detail}; inspect and restore before the next write`,
          }
        : this.nextStep(snapshot)
    return {
      data: {
        stage: snapshot.pipeline.stage,
        chapter: snapshot.pipeline.chapter,
        progress,
        tool: next.tool,
        args: next.args,
        reason: next.reason,
        blocking: [...this.effectiveBlocking(snapshot), ...journal],
        state_errors: this.stateErrors(snapshot),
      },
      revision: snapshot.pipeline.revision,
      warnings: [],
    }
  }

  /* ------------------------------------------------------- 0.2.0 observability */

  async search(input: SearchInput): Promise<OpResult<SearchReport>> {
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (query === '') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'search query must not be empty')
    }
    if (Array.from(query).length > LIMITS.maxSearchQueryChars) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `search query is longer than ${LIMITS.maxSearchQueryChars} characters`,
      )
    }
    const scope = input.scope ?? 'all'
    if (!['all', 'chapters', 'summaries', 'outline', 'worldbook', 'ledgers'].includes(scope)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `unknown search scope "${String(scope)}"`,
        'allowed: all, chapters, summaries, outline, worldbook, ledgers',
      )
    }
    const requested = input.limit ?? 20
    if (!Number.isInteger(requested) || requested < 1 || requested > 50) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `search limit must be an integer between 1 and 50, got ${String(input.limit)}`,
      )
    }
    const limit = requested
    const snapshot = await this.load(input.root)
    const warnings: Warning[] = []
    const seenWarnings = new Set<string>()
    const warn = (code: string, message: string): void => {
      const key = `${code}\u0000${message}`
      if (seenWarnings.has(key)) return
      seenWarnings.add(key)
      warnings.push({ code, message })
    }
    const chaptersInScope = scope === 'all' || scope === 'chapters' || scope === 'summaries'
    const chapterTexts = new Map<number, string>()
    const missingChapters: number[] = []
    if (scope === 'all' || scope === 'chapters') {
      for (const record of snapshot.chapters.chapters) {
        const text = await this.readChapter(snapshot, record.num)
        if (text === null) missingChapters.push(record.num)
        else chapterTexts.set(record.num, text)
      }
      if (
        snapshot.text !== null &&
        !snapshot.chapters.chapters.some((row) => row.num === snapshot.pipeline.chapter)
      ) {
        chapterTexts.set(snapshot.pipeline.chapter, snapshot.text)
      }
    }
    if (chaptersInScope) {
      const chaptersDamage = snapshot.ledgerErrors.find((error) => error.code === 'CHAPTERS_UNREADABLE')
      if (chaptersDamage !== undefined) warn(chaptersDamage.code, chaptersDamage.message)
    }
    if (missingChapters.length > 0) {
      warn(
        'CHAPTER_MANUSCRIPT_MISSING',
        `chapter manuscript(s) missing for: ${missingChapters.join(', ')}; search results omit them`,
      )
    }
    if ((scope === 'all' || scope === 'outline') && snapshot.outlineError !== null) {
      warn('OUTLINE_UNREADABLE', snapshot.outlineError)
    }
    if ((scope === 'all' || scope === 'worldbook') && snapshot.worldbookError !== null) {
      warn('WORLDBOOK_UNREADABLE', snapshot.worldbookError)
    }
    if (scope === 'all' || scope === 'ledgers') {
      for (const error of snapshot.ledgerErrors) warn(error.code, `${error.path}: ${error.message}`)
    }
    return {
      data: searchSnapshot({
        query,
        scope,
        limit,
        chapterTexts,
        chapters: snapshot.chapters.chapters,
        outline: snapshot.outline,
        worldbook: snapshot.worldbook,
        characters: snapshot.characters,
        world: snapshot.world,
        timeline: snapshot.timeline,
        foreshadows: snapshot.foreshadows,
        relationships: snapshot.relationships,
        locks: snapshot.locks,
        handoff: snapshot.handoff,
      }),
      revision: snapshot.pipeline.revision,
      warnings,
    }
  }

  /**
   * Read-only upgrade audit. It never edits a legacy document: the point is to
   * explain why an old project's numbers look different, not to rewrite history.
   */
  private async legacyIssues(snapshot: Snapshot, includeChecks: boolean): Promise<LegacyIssue[]> {
    const issues: LegacyIssue[] = []
    const store = this.storeFor(snapshot.root)
    const oldEffort = snapshot.chapters.chapters.filter(
      (record) => record.rounds === undefined || record.archived_at === undefined,
    )
    if (oldEffort.length > 0) {
      issues.push({
        code: 'LEGACY_EFFORT',
        detail: `${oldEffort.length} 章缺少 rounds/archived_at；report 已按 journal 回填，归档时不会自动改写旧记录`,
      })
    }
    if (includeChecks) {
      const oldChecks: number[] = []
      for (const record of snapshot.chapters.chapters) {
        try {
          const check = (await store.readDoc(
            checkFile(record.num),
            'check',
          )) as unknown as CheckDocument | null
          if (check === null) continue
          const machine = check.machine as {
            advisories?: unknown
            violations?: Array<{ severity?: unknown }>
          }
          // 0.2.0 checks had no `scope` and stored advisories inside
          // `violations`. readDoc normalizes them in memory and marks the row;
          // a modern check with zero advisories is not legacy just because the
          // optional array is absent (X5).
          const mixed =
            (check as unknown as { legacy_format?: unknown }).legacy_format === true ||
            !Array.isArray((check as unknown as { scope?: unknown }).scope) ||
            (Array.isArray(machine.violations) &&
              machine.violations.some((violation) => violation.severity === 'advisory'))
          if (mixed) oldChecks.push(record.num)
        } catch {
          // A damaged check already surfaces through state_errors/doctor; do not
          // turn it into a second legacy warning.
        }
      }
      if (oldChecks.length > 0) {
        // Name the chapters: "3 chapters are legacy" is not actionable when the
        // author wants to re-run exactly those checks.
        issues.push({
          code: 'LEGACY_CHECK_FORMAT',
          detail: `${oldChecks.length} 章（第 ${oldChecks.join('、')} 章）check 是 0.2.0 旧格式（advisory 混在 violations）；重新跑 novel_check 或按 0.2.3 迁移说明标记`,
        })
      }
    }
    const hints = new Map<string, string>()
    for (const character of snapshot.worldbook.characters) {
      if (character.role !== '') hints.set(character.name, character.role)
    }
    const wrongRoles = snapshot.characters.characters.filter(
      (character) =>
        character.role === 'extra' &&
        hints.has(character.name) &&
        normalizeRole(hints.get(character.name), 'extra') !== 'extra',
    )
    if (wrongRoles.length > 0) {
      issues.push({
        code: 'LEGACY_CAST_ROLE',
        detail: `${wrongRoles.length} 个角色台账仍是 extra，但世界观写的是：${wrongRoles
          .slice(0, 3)
          .map((character) => `${character.name}=${hints.get(character.name)}`)
          .join('、')}`,
      })
    }
    // New rows carry format_version=1. That lets the audit distinguish a
    // legitimate new anchorless title (already verified against the manuscript
    // at plant time) from pre-0.2.3 rows that cannot prove their label without
    // an anchor. No manuscript read is needed, so panel/doctor stay cheap.
    const noAnchor = snapshot.foreshadows.items.filter(
      (item) => item.anchor === undefined && item.format_version !== 1,
    )
    if (noAnchor.length > 0) {
      issues.push({
        code: 'LEGACY_FORESHADOW_ANCHOR',
        detail: `${noAnchor.length} 条旧伏笔没有 anchor：${noAnchor
          .slice(0, 3)
          .map((item) => `${item.id}「${item.title}」`)
          .join('、')}；不自动改写，补 anchor 时请人工确认正文原句`,
      })
    }
    const resolvedWithoutLog = snapshot.foreshadows.items.filter(
      (item) => item.status === 'resolved' && item.advance_log.length === 0,
    )
    if (resolvedWithoutLog.length > 0) {
      issues.push({
        code: 'LEGACY_FORESHADOW_ADVANCE',
        detail: `${resolvedWithoutLog.length} 条旧伏笔已 resolved 但没有 advance_log：${resolvedWithoutLog
          .slice(0, 3)
          .map((item) => item.id)
          .join('、')}；新归档会自动记录，旧记录不补写`,
      })
    }
    // Appending a receipt for a completed chapter is normal. The old defect was
    // pipeline.briefs retaining a signature from another chapter, so compare the
    // raw pipeline against the current receipts instead of treating every
    // historical receipt as stale.
    const rawBriefs = snapshot.pipeline.briefs ?? {}
    const receiptDocument = await this.readBriefReceipts(store)
    const currentReceipts = receiptDocument.receipts.filter(
      (receipt) => receipt.chapter === snapshot.pipeline.chapter,
    )
    const staleBriefs = Object.entries(rawBriefs).filter(([stage, receipt]) => {
      if (snapshot.briefs[stage]?.digest === receipt.digest) return false
      // A renewed brief leaves the old signature in pipeline.briefs. It is a
      // legitimate superseded receipt, not stale legacy data, as long as the
      // append-only audit still contains it for this chapter and stage.
      return !currentReceipts.some((current) => current.stage === stage && current.digest === receipt.digest)
    })
    if (staleBriefs.length > 0) {
      issues.push({
        code: 'LEGACY_BRIEFS',
        detail: `pipeline.briefs 有 ${staleBriefs.length} 条与第 ${snapshot.pipeline.chapter} 章收据不一致的签名（${staleBriefs
          .slice(0, 3)
          .map(([stage]) => stage)
          .join('、')}）；当前章 effective briefs 只取当前章收据`,
      })
    }
    return issues
  }

  async doctor(input: DoctorInput = {}): Promise<OpResult<DoctorReport>> {
    if (input.baseline === true || input.reset === true) return this.writeDoctorBaseline(input)
    const selection = await this.resolveRootForInspection(input.root)
    const root = selection.root
    const store = this.storeFor(root)
    const checks: DoctorCheck[] = []
    const add = (check: DoctorCheck): void => {
      checks.push(check)
    }
    if (!(await store.exists(PROJECT_FILE)) && !(await hasProjectState(store))) {
      add({
        id: 'project',
        severity: 'error',
        title: '项目不存在',
        detail: `${PROJECT_FILE} is missing`,
        hint: 'call novel_init, or pass the correct project root',
      })
      return {
        data: {
          ok: false,
          root,
          checks,
          summary: { errors: 1, warnings: 0, infos: 0 },
        },
        revision: 1,
        warnings: [],
      }
    }
    let snapshot: Snapshot
    try {
      snapshot = await this.loadAt(selection)
      await this.recordSelectionBestEffort(selection, snapshot)
    } catch (error) {
      add({
        id: 'load',
        severity: 'error',
        title: '项目无法加载',
        detail: errorMessage(error),
        hint: this.recoveryForSafe(error),
      })
      return {
        data: {
          ok: false,
          root,
          checks,
          summary: { errors: 1, warnings: 0, infos: 0 },
        },
        revision: 1,
        warnings: [],
      }
    }
    add({
      id: 'project',
      severity: snapshot.projectError === null ? 'ok' : 'error',
      title: '项目定义',
      detail: snapshot.projectError ?? `${PROJECT_FILE} is readable`,
      ...(snapshot.projectError === null
        ? {}
        : { hint: 'read novel_state {kind:"novel"} and repair it with novel_amend' }),
    })
    const profileCount = Object.values(this.rulepack.genres).filter(
      (genre) => genre.profile !== undefined,
    ).length
    add({
      id: 'rulepack',
      severity: 'ok',
      title: '规则包',
      detail: `${this.rulepack.name}@${this.rulepack.version} · ${Object.keys(this.rulepack.genres).length} 个题材 · ${profileCount} 个题材 profile`,
    })
    add({
      id: 'pipeline',
      severity: snapshot.pipelineError === null ? 'ok' : 'error',
      title: '流水线',
      detail: `revision ${snapshot.pipeline.revision} · ${
        projectChapterProgress({
          activeChapter: snapshot.pipeline.chapter,
          stage: snapshot.pipeline.stage,
          archived: snapshot.chapters.chapters.map((record) => record.num),
          target: snapshot.project.targets.total_chapters,
        }).label
      }`,
    })
    for (const error of this.stateErrors(snapshot)) {
      add({
        id: `state:${error.path}`,
        severity: 'error',
        title: '状态文档不可读',
        detail: `${error.code}: ${error.message}`,
        hint:
          error.code === 'PIPELINE_UNREADABLE'
            ? 'restore a valid pipeline backup with novel_restore { paths: ["state/pipeline.yaml"], txid }'
            : `repair ${error.path} with novel_amend`,
      })
    }
    add({
      id: 'outline',
      severity:
        snapshot.outlineError !== null ? 'error' : snapshot.outline.chapters.length > 0 ? 'ok' : 'warning',
      title: '书级大纲',
      detail:
        snapshot.outlineError ??
        (snapshot.outlinePresent
          ? `${snapshot.outline.chapters.length} 张章卡 / ${snapshot.outline.volumes.length} 卷 / strict=${String(snapshot.outline.book.strict)}`
          : 'outline/outline.yaml is missing'),
      ...(snapshot.outlineError !== null
        ? { hint: 'repair outline/outline.yaml with novel_amend' }
        : snapshot.outlinePresent
          ? {}
          : { hint: 'create a card with novel_outline before relying on PG-13' }),
    })
    if (snapshot.handoff !== null && snapshot.outlineError === null && snapshot.outline.volumes.length > 0) {
      const chapter = snapshot.pipeline.chapter
      const expectedIndex = snapshot.outline.volumes.findIndex(
        (volume) => chapter >= volume.start_chapter && chapter <= volume.end_chapter,
      )
      if (expectedIndex >= 0) {
        const expected = snapshot.outline.volumes[expectedIndex]!
        const position = projectHandoff(snapshot.handoff, chapter)
        if (position.volume !== expectedIndex + 1 || position.volume_name !== expected.title) {
          add({
            id: 'handoff-outline',
            severity: 'warning',
            title: '交接卷与大纲不一致',
            detail: `handoff 指向第 ${position.volume} 卷「${position.volume_name}」，当前章 ${chapter} 的大纲卷是第 ${expectedIndex + 1} 卷「${expected.title}」`,
            hint: '用 novel_amend 修正 state/handoff.yaml，或重新归档以推进交接；归档前请确认卷/幕是作者想要的',
          })
        }
      }
    }
    add({
      id: 'worldbook',
      severity: snapshot.worldbookError !== null ? 'error' : snapshot.worldbookPresent ? 'ok' : 'info',
      title: '世界观设定集',
      detail:
        snapshot.worldbookError ??
        (snapshot.worldbookPresent ? 'worldbook is readable' : 'outline/worldbook.yaml is missing'),
      ...(snapshot.worldbookError !== null ? { hint: 'repair outline/worldbook.yaml with novel_amend' } : {}),
    })
    if (snapshot.outline.book.strict && (snapshot.worldbook.facts ?? []).length === 0) {
      add({
        id: 'worldbook-facts',
        severity: 'info',
        title: '数值事实为空',
        detail: '严格模式已开启，但 worldbook.facts 没有声明任何汇率、物价或数量事实',
        hint: '在 novel_worldbook 的 facts 里声明可核对的数值，P6 的 NUMERIC_FACT_MISMATCH 才有参照',
      })
    }
    try {
      const journalPresent = await store.exists(joinRel(STATE_DIR, STATE_FILES.journal))
      const journal = await readJournal(store)
      const journalCommitted = hasCommittedJournal(journal.records)
      const health = await reconcileJournal(store)
      const pending = await inspectPending(store)
      if (pending.state !== 'none') {
        add({
          id: 'pending-transaction',
          severity: pending.state === 'partial' ? 'error' : 'warning',
          title:
            pending.state === 'partial'
              ? '事务只完成了一部分'
              : pending.state === 'complete'
                ? '事务可安全提升'
                : '事务可安全回滚',
          detail: `${pending.txid ?? 'unknown'}: ${pending.detail ?? pending.state}`,
          hint:
            pending.state === 'partial'
              ? `先检查 ${pending.stagingDir ?? 'staging'}/before/；不要从整库备份恢复`
              : '下一次写操作会自动完成恢复；只读命令不会改盘',
        })
      }
      add({
        id: 'journal',
        severity:
          !journalPresent || !journalCommitted || journal.malformed > 0 || health.mismatches.length > 0
            ? 'error'
            : 'ok',
        title: '事务日志',
        detail: !journalPresent
          ? 'state/journal.jsonl is missing'
          : !journalCommitted
            ? 'state/journal.jsonl has no committed project transaction'
            : journal.malformed > 0
              ? `${journal.malformed} malformed line(s)`
              : health.mismatches.length > 0
                ? `${health.mismatches.length} file(s) changed after commit`
                : `${journal.rows.length} audit rows`,
        ...(!journalPresent || !journalCommitted
          ? {
              hint: !journalPresent
                ? 'restore state/journal.jsonl from a backup; writes are disabled until it exists'
                : 'restore a journal that contains the committed project history; writes are disabled until then',
            }
          : health.mismatches.length > 0
            ? { hint: `first mismatch: ${health.mismatches[0]!.path}` }
            : {}),
      })
    } catch (error) {
      add({
        id: 'journal',
        severity: 'error',
        title: '事务日志不可读',
        detail: errorMessage(error),
        hint: 'inspect state/journal.jsonl; do not rewrite it automatically',
      })
    }
    const archived = new Set(snapshot.chapters.chapters.map((record) => record.num))
    let missing = 0
    let mismatched = 0
    for (const record of snapshot.chapters.chapters) {
      const text = await store.readText(record.file)
      if (text === null) missing += 1
      else if (sha256(text) !== record.content_hash) mismatched += 1
    }
    add({
      id: 'manuscripts',
      severity: missing > 0 || mismatched > 0 ? 'error' : 'ok',
      title: '正文与索引',
      detail:
        missing > 0 || mismatched > 0
          ? `${missing} missing, ${mismatched} hash mismatch`
          : `${archived.size} archived chapter(s) match their index`,
      ...(missing > 0 || mismatched > 0
        ? { hint: 'restore the manuscripts from backups/ or repair the index with novel_amend' }
        : {}),
    })
    const reviewProblems: string[] = []
    for (const record of snapshot.chapters.chapters) {
      try {
        if ((await store.readDoc(reviewFile(record.num), 'review')) === null) {
          reviewProblems.push(`chapter ${record.num}: missing`)
        }
      } catch (error) {
        reviewProblems.push(`chapter ${record.num}: ${errorMessage(error)}`)
      }
    }
    // 0.2.17: the style pack is a book attribute, so a wrong or missing pack is a
    // doctor finding, not a runtime surprise. An unknown id is a warning (the
    // book stays readable), and a target outside the confirmed range is info
    // (the two numbers are both legitimate; the engine only points at the gap).
    const doctorStyle = this.stylepackFor(snapshot.project)
    if (snapshot.project.style === undefined) {
      add({
        id: 'style-pack',
        severity: 'info',
        title: '文风',
        detail:
          snapshot.chapters.chapters.length === 0
            ? '这本书建于 0.2.17 之前，还没有文风；零归档章时可以用 novel_amend 设置一次'
            : '这本书建于 0.2.17 之前，已有归档章，文风窗口已关闭；规则与任务书按无风格运行',
        hint: 'novel_amend {path:"novel.yaml", content:{style:"<id>"}}，只能设置一次',
      })
    } else if (doctorStyle === null) {
      add({
        id: 'style-pack',
        severity: 'warning',
        title: '文风',
        detail: `novel.yaml 指向未知风格包 "${String(snapshot.project.style)}"；规则与任务书按无风格运行`,
        hint: `可选：${[...this.stylepacks.keys()].join(', ')}；用 novel_amend 修复`,
      })
    } else {
      const conflicts = doctorStyle.genres.filter((genre) => genre !== snapshot.project.genre)
      add({
        id: 'style-pack',
        severity: 'ok',
        title: '文风',
        detail: `${doctorStyle.id} ${doctorStyle.name} · 适用 ${doctorStyle.genres.join('/')} · 本书 ${snapshot.project.genre}`,
        ...(conflicts.length > 0
          ? {
              hint: `风格包的适用题材不含本书题材（${conflicts.join('/')}）；这是选择不是错误，题材说明与风格冲突时以风格为准`,
            }
          : {}),
      })
      const target = doctorStyle.dialogue.ratio
      const [low, high] = snapshot.project.targets.dialogue_ratio
      if (target < low || target > high) {
        add({
          id: 'style-dialogue-target',
          severity: 'info',
          title: '对白目标与验收区间',
          detail: `风格目标 ${target} 落在项目区间 ${low}–${high} 之外`,
          hint: '区间是用户确认的验收线，目标是风格给的瞄准点；两者不一致时引擎只指出，不裁决',
        })
      }
    }
    add({
      id: 'reviews',
      severity: reviewProblems.length === 0 ? 'ok' : 'error',
      title: '历史评审',
      detail:
        reviewProblems.length === 0
          ? `${snapshot.chapters.chapters.length} archived chapter review(s) readable`
          : `${reviewProblems.length} review problem(s): ${reviewProblems.slice(0, 3).join('; ')}`,
      ...(reviewProblems.length === 0
        ? {}
        : { hint: 'restore reviews/ from backups/ or consult novel_report for affected chapters' }),
    })
    const extraChapters: number[] = []
    for (const name of await store.list(CHAPTERS_DIR)) {
      const match = /^chapter-(\d+)\.md$/.exec(name)
      if (match === null) continue
      const num = Number(match[1])
      if (!archived.has(num) && num !== snapshot.pipeline.chapter) extraChapters.push(num)
    }
    add({
      id: 'orphans',
      severity: extraChapters.length === 0 ? 'ok' : 'warning',
      title: '孤立正文',
      detail:
        extraChapters.length === 0
          ? 'no orphan chapter file'
          : `chapter file(s) not in the index: ${extraChapters.join(', ')}`,
      ...(extraChapters.length === 0
        ? {}
        : { hint: 'archive the chapter, or move the file out of chapters/' }),
    })
    const drift = outlineDrift(snapshot.outline, snapshot.chapters.chapters)
    add({
      id: 'outline-drift',
      severity: drift.length === 0 ? 'ok' : 'warning',
      title: '大纲与正文',
      detail:
        drift.length === 0 ? 'no drift' : `${drift.length} drift item(s); first chapter ${drift[0]!.chapter}`,
      ...(drift.length === 0
        ? {}
        : { hint: 'read novel_report for the full drift list; do not edit archived cards directly' }),
    })
    const backups = await listBackups(store)
    const archivedRecords = snapshot.chapters.chapters
    const archivedCards = new Set(
      snapshot.outline.chapters.filter((card) => card.status === 'archived').map((card) => card.num),
    )
    const missingCards = archivedRecords.filter((record) => !archivedCards.has(record.num))
    const extraCards = [...archivedCards].filter(
      (num) => !archivedRecords.some((record) => record.num === num),
    )
    const outlineProgress = outlineSummary(
      snapshot.outline,
      archivedRecords.length,
      snapshot.project.targets.total_chapters,
      archivedRecords.map((record) => record.num),
    )
    const percentText = (value: number | null): string =>
      value === null ? '—' : `${Math.round(value * 1000) / 10}%`
    const coverageComplete =
      missingCards.length === 0 &&
      extraCards.length === 0 &&
      (outlineProgress.target === null || outlineProgress.missingCards === 0)
    add({
      id: 'outline-coverage',
      // Early books are still planning; a 3-chapter project cannot have 200
      // cards. Warning only once the plan should exist.
      severity: coverageComplete
        ? 'ok'
        : missingCards.length > 0 || extraCards.length > 0
          ? // A card that disappeared for an archived chapter is damage, not a
            // young book still planning.
            'warning'
          : archivedRecords.length < 3
            ? 'info'
            : 'warning',
      title: '大纲覆盖率',
      detail: `规划覆盖 ${percentText(outlineProgress.plannedCoverage)}（${outlineProgress.total}/${outlineProgress.target ?? '不限'} 张卡）· 归档覆盖 ${percentText(outlineProgress.archivedCoverage)}（${archivedRecords.length}/${outlineProgress.target ?? '不限'} 章）· ${outlineProgress.missingCards} 章缺卡 · ${missingCards.length} 章有正文无卡 · ${extraCards.length} 张卡无正文`,
      ...(missingCards.length === 0 &&
      extraCards.length === 0 &&
      (outlineProgress.target === null || outlineProgress.missingCards === 0)
        ? {}
        : {
            hint: `缺卡章节数 ${outlineProgress.missingCards}; archived chapters without a card: ${missingCards.map((record) => record.num).join(', ') || 'none'}; cards without a manuscript: ${extraCards.join(', ') || 'none'}`,
          }),
    })
    const stageMissing: string[] = []
    switch (snapshot.pipeline.stage) {
      case 'P2':
        if (snapshot.worldPlan === null) stageMissing.push('P1 世界计划')
        break
      case 'P3':
        if (snapshot.plan === null) stageMissing.push('P2 章节计划')
        break
      case 'P4':
        if (snapshot.plan === null) stageMissing.push('P2 章节计划')
        if (snapshot.text === null) stageMissing.push('P3 正文')
        break
      case 'P5':
      case 'P6':
        if (snapshot.plan === null) stageMissing.push('P2 章节计划')
        if (snapshot.text === null) stageMissing.push('P3 正文')
        if (snapshot.review === null) stageMissing.push('P4 评审')
        break
      case 'ready_to_archive':
        if (snapshot.plan === null) stageMissing.push('P2 章节计划')
        if (snapshot.text === null) stageMissing.push('P3 正文')
        if (snapshot.review === null) stageMissing.push('P4 评审')
        if (snapshot.check === null || snapshot.check.verdict !== 'pass') stageMissing.push('P6 通过校验')
        break
      case 'done':
        if (snapshot.text !== null) stageMissing.push('done 阶段不应有活跃正文')
        break
      default:
        break
    }
    add({
      id: 'stage-products',
      severity: stageMissing.length === 0 ? 'ok' : 'error',
      title: '当前阶段产物',
      detail:
        stageMissing.length === 0
          ? `${snapshot.pipeline.stage} 阶段所需产物齐全`
          : `缺少：${stageMissing.join('、')}`,
      ...(stageMissing.length === 0
        ? {}
        : { hint: 'use novel_brief/novel_status to rebuild the missing stage product' }),
    })
    // The newest backup is often the previous chapter's archive transaction;
    // recommending restore for it is misleading because novel_restore only
    // accepts the active chapter. Pick the newest backup that is actually
    // restorable for the active chapter, and otherwise point at reopen/listing.
    const restoreCandidates = new Set([
      chapterFile(snapshot.pipeline.chapter),
      planChapterFile(snapshot.pipeline.chapter),
      planWorldFile(snapshot.pipeline.chapter),
      reviewFile(snapshot.pipeline.chapter),
      checkFile(snapshot.pipeline.chapter),
    ])
    const activeRestorable = backups.find(
      (entry) =>
        entry.op !== null &&
        entry.chapter === snapshot.pipeline.chapter &&
        entry.files.some((path) => restoreCandidates.has(path)),
    )
    add({
      id: 'backups',
      severity: 'info',
      title: '备份',
      detail:
        backups.length === 0
          ? '0 个备份快照'
          : `${backups.length} 个备份快照；最新：${backups[0]!.op ?? '旧版备份'}${backups[0]!.chapter === null ? '' : ` · 第 ${backups[0]!.chapter} 章`} · ${backups[0]!.files.length} 个文件`,
      ...(backups.length === 0
        ? {}
        : activeRestorable !== undefined
          ? {
              hint: `用 novel_state {kind:"backups"} 列出；用 novel_restore {txid:"${activeRestorable.name}"} 恢复活动章`,
            }
          : backups[0]!.op === null || backups[0]!.files.length === 0
            ? {
                hint: '最新备份没有 manifest 或没有可恢复的 pre-image，只能列出；它不是 novel_restore 的候选',
              }
            : {
                hint: '最新备份不属于活动章或没有本章可恢复的 pre-image；用 novel_state {kind:"backups"} 列出，归档章先 novel_reopen',
              }),
    })
    // A scalar such as `deadline` is written once and never expires by itself.
    // 0.2.14 (R8): a bare list could not tell a passed deadline from a live one.
    // A chapter-number scalar is compared with the chapter being written; any
    // other shape stays "cannot judge", because the engine does not parse story
    // time.
    const currentChapter = snapshot.pipeline.chapter
    const expiredKeys: string[] = []
    const pendingKeys: string[] = []
    const unjudgedKeys: string[] = []
    for (const character of snapshot.characters.characters) {
      for (const [key, value] of Object.entries(character.current_state ?? {})) {
        if (key === 'resources') continue
        if (!/(deadline|due|expires|expiry|期限|截止|到期|deadline_at)/i.test(key)) continue
        const label = `${character.name}.${key}=${String(value)}`
        const numeric =
          typeof value === 'number'
            ? value
            : typeof value === 'string' && /^\d+$/.test(value.trim())
              ? Number(value.trim())
              : null
        if (numeric === null) unjudgedKeys.push(label)
        else if (numeric < currentChapter) expiredKeys.push(label)
        else pendingKeys.push(label)
      }
    }
    if (expiredKeys.length + pendingKeys.length + unjudgedKeys.length > 0) {
      const parts = [
        expiredKeys.length === 0
          ? ''
          : `${expiredKeys.length} 个已过期（章号 < 当前第 ${currentChapter} 章）：${expiredKeys.slice(0, 3).join('、')}`,
        pendingKeys.length === 0
          ? ''
          : `${pendingKeys.length} 个仍待办（章号 ≥ 当前第 ${currentChapter} 章）：${pendingKeys.slice(0, 3).join('、')}`,
        unjudgedKeys.length === 0
          ? ''
          : `${unjudgedKeys.length} 个无法判断（非章号）：${unjudgedKeys.slice(0, 3).join('、')}`,
      ].filter((part) => part !== '')
      add({
        id: 'scalar-state',
        severity: expiredKeys.length > 0 ? 'warning' : 'info',
        title: '可过期的标量状态',
        detail: parts.join('；'),
        hint:
          expiredKeys.length > 0
            ? '已过期的用 state_delta characters[].unset 清掉或写入新值；章号比较只说明叙事位置已越过，不等于剧情里一定到期'
            : '用 state_delta characters[].unset 清掉或写入新值；引擎不会替你判断故事时间',
      })
    }
    const uncategorized = snapshot.relationships.items.filter((item) => item.type_code === undefined).length
    if (uncategorized > 0) {
      add({
        id: 'relation-type-code',
        severity: 'warning',
        title: '关系类型未归类',
        detail: `type_code ${snapshot.relationships.items.length - uncategorized}/${snapshot.relationships.items.length}（${uncategorized} 条未归类）`,
        hint: '用 novel_amend 一次映射；引擎不会根据自由文本猜类型',
      })
    }
    const baselineNames = [
      ...snapshot.worldbook.characters.map((entry) => ['character', entry.name] as const),
      ...snapshot.worldbook.locations.map((entry) => ['location', entry.name] as const),
    ]
    const missingBaselines = baselineNames.filter(
      ([kind, name]) =>
        resolveLockBaseline(name, kind, {
          worldbook: snapshot.worldbook,
          world: snapshot.world,
          locks: snapshot.locks,
        }) === null,
    )
    if (missingBaselines.length > 0) {
      add({
        id: 'LOCK_BASELINE_MISSING',
        severity: 'warning',
        title: '锁定基线缺失',
        detail: `${missingBaselines.length} 个世界书实体没有规范描述或可读锚点`,
        hint: '补 worldbook character.appearance 或 location.description/layout；缺失时 LOCKED_DETAIL_DRIFT 不报，而不是拿旧段落冒充标准',
      })
    }
    const unplanned = snapshot.foreshadows.items.filter(
      (item) =>
        item.status !== 'resolved' && (item.planned_resolve === undefined || item.planned_resolve === null),
    ).length
    if (unplanned > 0) {
      add({
        id: 'foreshadow-plan',
        severity: 'info',
        title: '伏笔回收计划',
        detail: `${unplanned} 条未解伏笔没有 planned_resolve`,
        hint: '旧条目不会自动补计划；需要时用 novel_amend 或后续 P3 planned_resolve',
      })
    }
    const archivedChapters = snapshot.chapters.chapters
    const hook13 = archivedChapters.filter((record) => record.summary.hook_strength <= 3).length
    const plotLow = archivedChapters.filter((record) => record.summary.plot_advancement === 'low').length
    if (archivedChapters.length >= 10 && hook13 === 0 && plotLow === 0) {
      add({
        id: 'QUALITY_SELF_SCORE_FLAT',
        severity: 'warning',
        title: '自评分布可能失真',
        detail: `已归档 ${archivedChapters.length} 章，hook 1–3 为 0、plot low 为 0`,
        hint: '按 P4 锚点复核：5=最后两段新威胁/新决定并断在动作中；low=没有改变目标/关系/资源/信息状态',
      })
    }
    const legacy = await this.legacyIssues(snapshot, true)
    if (legacy.length > 0) {
      add({
        id: 'legacy-data',
        severity: 'warning',
        title: '旧数据升级提示',
        detail: `${legacy.length} 类旧数据需要解释或人工补齐：${legacy
          .slice(0, 3)
          .map((issue) => `${issue.code}（${issue.detail}）`)
          .join('；')}`,
        hint: '这是只读审计，不会自动改历史；按 0.2.3 的 WP0 处理，补 anchor/role 前先核对原文',
      })
    }
    const locked = await store.exists(LOCK_FILE)
    add({
      id: 'lock',
      severity: locked ? 'warning' : 'ok',
      title: '写锁',
      detail: locked ? '.engine.lock exists; another writer may be active' : 'no writer lock',
      ...(locked ? { hint: 'if no other process is writing, wait for the stale lock window' } : {}),
    })
    const target = snapshot.project.targets.total_chapters
    if (target !== null) {
      add({
        id: 'target',
        severity: snapshot.chapters.chapters.length > target ? 'warning' : 'info',
        title: '目标进度',
        detail: `${snapshot.chapters.chapters.length}/${target} archived chapter(s)`,
        ...(snapshot.chapters.chapters.length > target
          ? { hint: 'raise targets.total_chapters with novel_amend' }
          : {}),
      })
    }
    const journalBlocking = await this.journalBlocking(snapshot)
    const next =
      journalBlocking.length > 0 && this.stateErrors(snapshot).length === 0
        ? {
            tool: 'novel_audit',
            args: {},
            reason: `${journalBlocking[0]!.code}: ${journalBlocking[0]!.detail}; inspect and restore before the next write`,
          }
        : this.nextStep(snapshot)
    add({
      id: 'next',
      severity: 'info',
      title: '下一步',
      detail: `${next.tool}: ${next.reason}`,
    })
    // A project may accept its current warnings once, instead of seeing the
    // same three rows forever. The baseline stores id+detail, so a changed
    // count or message starts warning again.
    const baseline = this.skipDoctorBaseline ? new Map() : await this.readDoctorBaseline(store)
    if (baseline.size > 0) {
      const liveWarnings = new Set(
        checks
          .filter((check) => check.severity === 'warning')
          .map((check) => `${check.id}\u0000${check.detail}`),
      )
      const kept = checks.filter(
        (check) => check.severity !== 'warning' || !baseline.has(`${check.id}\u0000${check.detail}`),
      )
      const suppressed = checks.length - kept.length
      // 0.2.14 (R8): "accepted" and "gone" are different states. An entry that
      // no longer reproduces keeps a permanent silent veto in the baseline
      // file, so it must be reported as expired instead of being folded into
      // the same count as the rows it is still hiding.
      const stale = [...baseline.entries()].filter(([key]) => !liveWarnings.has(key))
      if (suppressed > 0) {
        checks.splice(0, checks.length, ...kept)
        checks.push({
          id: 'doctor-baseline',
          severity: 'info',
          title: '告警基线',
          detail: `${suppressed} 条既有 warning 已按 state/doctor-baseline.yaml 接受（待办）；计数或文案变化会重新告警`,
          hint: 'novel_doctor {reset:true} 清空基线',
        })
      }
      if (stale.length > 0) {
        checks.push({
          id: 'doctor-baseline-stale',
          severity: 'info',
          title: '基线过期',
          detail: `${stale.length} 条基线条目已不再复现：${stale
            .slice(0, 3)
            .map(([, entry]) => `${entry.id}（${entry.detail.slice(0, 40)}）`)
            .join('；')}`,
          hint: '这些条目已经失效，novel_doctor {baseline:true} 会重写基线并可清理；{reset:true} 全部清空',
        })
      }
    }
    const summary = {
      errors: checks.filter((check) => check.severity === 'error').length,
      warnings: checks.filter((check) => check.severity === 'warning').length,
      infos: checks.filter((check) => check.severity === 'info').length,
    }
    return {
      data: { ok: summary.errors === 0, root, checks, summary },
      revision: snapshot.pipeline.revision,
      warnings: [],
    }
  }

  /**
   * Accepted-warning baseline; empty when the file is missing or unreadable.
   * A map (not a set) so doctor can also name the entries that stopped
   * reproducing (R8).
   */
  private async readDoctorBaseline(store: FsStore): Promise<Map<string, { id: string; detail: string }>> {
    const raw = await store.readText(DOCTOR_BASELINE_FILE)
    if (raw === null) return new Map()
    try {
      const parsed = parseYaml(raw) as { entries?: Array<{ id?: unknown; detail?: unknown }> } | null
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
      const accepted = new Map<string, { id: string; detail: string }>()
      for (const entry of entries) {
        if (typeof entry.id !== 'string' || typeof entry.detail !== 'string') continue
        accepted.set(`${entry.id}\u0000${entry.detail}`, { id: entry.id, detail: entry.detail })
      }
      return accepted
    } catch {
      return new Map()
    }
  }

  /** `novel_doctor {baseline|reset}`: journaled write of the accepted warning set. */
  private async writeDoctorBaseline(input: DoctorInput): Promise<OpResult<DoctorReport>> {
    // Capture the exact checks the read-only report produces; a second,
    // hand-maintained list would drift and suppress the wrong rows.
    let fresh: Array<{ id: string; detail: string }> = []
    if (input.reset !== true) {
      this.skipDoctorBaseline = true
      try {
        const report = await this.doctor({ root: input.root })
        fresh = report.data.checks
          .filter((check) => check.severity === 'warning')
          .map((check) => ({ id: check.id, detail: check.detail }))
      } finally {
        this.skipDoctorBaseline = false
      }
    }
    return this.mutate({
      root: input.root,
      op: 'doctorBaseline',
      reason: input.reset === true ? 'reset doctor baseline' : 'accept current doctor warnings',
      run: async (snapshot, context) => {
        // 0.2.14 (R8): `baseline:true` rewrites the accepted set to the
        // warnings that still reproduce. Merging forever kept every entry that
        // had already stopped reproducing, so the file grew while its rows
        // suppressed nothing — doctor now calls those rows expired, and this is
        // the operation that clears them.
        const merged = new Map<string, { id: string; detail: string }>()
        for (const entry of fresh) {
          merged.set(`${entry.id}\u0000${entry.detail}`, entry)
        }
        const files: StagedFile[] = [
          {
            path: DOCTOR_BASELINE_FILE,
            text: yaml({
              schema_version: 1,
              updated_at: this.now().toISOString(),
              entries: [...merged.values()],
            }),
          },
          {
            path: joinRel(STATE_DIR, STATE_FILES.pipeline),
            text: yaml(
              pipelineWith(snapshot, context.revision, {
                last_action: action('novel_doctor', this.now(), shortDigest(String(merged.size))),
              }),
            ),
          },
        ]
        return {
          files,
          data: {
            ok: true,
            root: snapshot.root,
            checks: [
              {
                id: 'doctor-baseline',
                severity: 'info' as const,
                title: '基线已写入',
                detail: `${merged.size} 条已接受（reset=${String(input.reset === true)}）`,
              },
            ],
            summary: { errors: 0, warnings: 0, infos: 1 },
          },
          warnings: [],
        }
      },
    })
  }

  private recoveryForSafe(error: unknown): string {
    if (error instanceof EngineFaultError) return error.hint ?? 'inspect the project files'
    if (error instanceof EngineInputError) return error.hint ?? 'call novel_status first'
    return 'inspect the project files'
  }

  async report(input: ReportSubmission = {}): Promise<OpResult<BookReport>> {
    const snapshot = await this.load(input.root)
    const store = this.storeFor(snapshot.root)
    const currentReviews: ReviewDocument[] = []
    const reviewIssues: string[] = []
    const archivedChapterNums = new Set(snapshot.chapters.chapters.map((record) => record.num))
    const finalChecks: Record<number, 'pass' | 'fail'> = {}
    // List history once. Calling listHistory per chapter reread every history
    // file on every iteration, turning a whole-book report into O(chapters ×
    // history files) disk work.
    const historicalEntries = await listHistory(store)
    for (const record of snapshot.chapters.chapters) {
      try {
        const review = await store.readDoc(reviewFile(record.num), 'review')
        if (review === null) {
          reviewIssues.push(`chapter ${record.num}: review is missing`)
        } else {
          const document = review as unknown as ReviewDocument
          currentReviews.push(document)
        }
        for (const historical of await historyTexts(store, 'reviews', record.num, historicalEntries)) {
          try {
            // Validate history so a malformed copy is reported, but leave the
            // attempt count to the shared helper below. Identical copies are
            // not independent review rounds.
            narrow('review', parseYaml(historical.text))
          } catch (error) {
            reviewIssues.push(`chapter ${record.num} ${historical.path}: ${errorMessage(error)}`)
          }
        }
      } catch (error) {
        reviewIssues.push(`chapter ${record.num}: ${errorMessage(error)}`)
      }
      if (record.final_check === undefined || record.final_check === null) {
        try {
          const check = (await store.readDoc(
            checkFile(record.num),
            'check',
          )) as unknown as CheckDocument | null
          if (check !== null && (check.verdict === 'pass' || check.verdict === 'fail')) {
            finalChecks[record.num] = check.verdict
          } else {
            // The archive row has no verdict and the check evidence is gone.
            // Keep the null rather than fabricating a pass, but say why the
            // per-chapter final_check is unavailable.
            reviewIssues.push(`chapter ${record.num}: check is missing`)
          }
        } catch (error) {
          reviewIssues.push(`chapter ${record.num} check: ${errorMessage(error)}`)
        }
      }
    }
    const journal = await readJournal(store)
    const attemptCounts = await this.reviewAttemptsByChapter(
      store,
      journal.rows,
      [...archivedChapterNums],
      new Set(currentReviews.map((review) => review.chapter)),
      historicalEntries,
    )
    const effort = this.effortProjection(snapshot.chapters, journal.rows, attemptCounts)
    // One number for "how many reviews did this book take": the effort
    // projection, not a second addition of the same rows (U6/M19).
    const reviewAttempts = effort.lifetime.reviews
    const report = buildBookReport({
      project: snapshot.project,
      outline: snapshot.outline,
      outlinePresent: snapshot.outlinePresent,
      outlineError: snapshot.outlineError,
      worldbook: snapshot.worldbook,
      worldbookPresent: snapshot.worldbookPresent,
      worldbookError: snapshot.worldbookError,
      world: snapshot.world,
      chapters: snapshot.chapters.chapters,
      characters: snapshot.characters,
      timeline: snapshot.timeline,
      foreshadows: snapshot.foreshadows,
      relationships: snapshot.relationships,
      reviews: currentReviews,
      activity: journal.rows.filter((row) => row.op !== 'lock_reclaimed').slice(-8),
      journal: journal.rows,
      // The journal is the authoritative attempt ledger; history fills gaps
      // per chapter and duplicate history copies are de-duplicated.
      reviewAttempts,
      effortBasis: effort.basis,
      effortProjection: {
        basis: effort.basis,
        chapters: [...effort.chapters.entries()].map(([num, row]) => ({ num, ...row })),
      },
      currentEffort: {
        chapter: snapshot.pipeline.chapter,
        reviews: snapshot.pipeline.rounds.review,
        revisions: snapshot.pipeline.rounds.revise,
        checks: snapshot.pipeline.rounds.check,
        rollbacks: 0,
      },
      finalChecks,
      targetChapters: snapshot.project.targets.total_chapters,
      minScore: this.config.quality.minScore,
      dimensionMax: Object.fromEntries(
        this.rulepack.quality.dimensions.map((dimension) => [dimension.id, dimension.max]),
      ),
      foreshadowDormantAfter: this.rulepack.crosschapter.foreshadow_dormant_after,
    })
    if (snapshot.projectError !== null) {
      report.warnings.push(`项目定义不可读：${snapshot.projectError}`)
    }
    for (const error of snapshot.ledgerErrors) {
      report.warnings.push(`${error.code} @ ${error.path}：${error.message}`)
    }
    for (const issue of reviewIssues) report.warnings.push(`评审文档不可读：${issue}`)
    for (const warning of this.styleWarnings(snapshot)) report.warnings.push(warning.message)
    report.warnings = [...new Set(report.warnings)]
    // 0.2.17: a whole-book report on a 300-chapter project is larger than the
    // host result pruner keeps, so `lean` returns the summary plus the twenty
    // most recent per-chapter effort rows instead of an unreadable head/tail.
    if (input.lean === true) {
      const all = report.effort.chapters
      if (all.length > REPORT_LEAN_CHAPTERS) {
        report.effort.chapters = all.slice(-REPORT_LEAN_CHAPTERS)
        report.effort.chapters_truncated = {
          shown: REPORT_LEAN_CHAPTERS,
          total: all.length,
          note: 'lean report: only the most recent chapters are listed; call novel_report without lean for every row',
        }
      }
    }
    // 0.2.17: the report carries the style block so "is this chapter still
    // written like this book?" is answerable from one call, not three. The
    // verdict is `styleOverview`'s, not a second opinion computed here.
    const reportStyle = this.stylepackFor(snapshot.project)
    if (reportStyle !== null) {
      const overview = this.styleOverview(snapshot)
      const metrics =
        snapshot.text === null
          ? null
          : measureStyle(snapshot.text, reportStyle, styleVocabulary(this.rulepack))
      report.style =
        metrics === null
          ? {
              id: reportStyle.id,
              name: reportStyle.name,
              verdict: 'no-draft',
              findings: [],
            }
          : {
              id: reportStyle.id,
              name: reportStyle.name,
              metrics,
              findings: overview.findings,
              verdict: overview.verdict === 'pass' ? 'pass' : 'attention',
            }
    }
    return { data: report, revision: snapshot.pipeline.revision, warnings: [] }
  }

  async guide(input: GuideInput = {}): Promise<OpResult<GuideReport>> {
    const selection = await this.resolveRootForInspection(input.root)
    const root = selection.root
    const store = this.storeFor(root)
    if (!(await store.exists(PROJECT_FILE)) && !(await hasProjectState(store))) {
      const guide = buildGuide({
        projectPresent: false,
        chapter: 1,
        stage: 'idle',
        archived: 0,
        target: null,
        finished: false,
        outline: {
          schema_version: 1,
          updated_at: this.now().toISOString(),
          book: {
            premise: '',
            logline: '',
            themes: [],
            tone: '',
            pov: '',
            audience: '',
            selling_points: [],
            ending: '',
            strict: false,
            strict_explicit: false,
          },
          volumes: [],
          chapters: [],
        },
        outlinePresent: false,
        worldbook: {
          schema_version: 1,
          updated_at: this.now().toISOString(),
          premise: '',
          setting: '',
          rules: [],
          factions: [],
          locations: [],
          characters: [],
          glossary: [],
          backstory: [],
          themes: [],
        },
        worldbookPresent: false,
        next: {
          tool: 'novel_init',
          args: { title: '我的第一本书', genre: '都市现代', platform: 'fanqie' },
          reason: '还没有项目；先创建一本书',
        },
        blocking: 0,
        stateErrors: 0,
      })
      return { data: guide, revision: 1, warnings: [] }
    }
    const snapshot = await this.loadAt(selection)
    await this.recordSelectionBestEffort(selection, snapshot)
    const target = snapshot.project.targets.total_chapters
    const progress = projectChapterProgress({
      activeChapter: snapshot.pipeline.chapter,
      stage: snapshot.pipeline.stage,
      archived: snapshot.chapters.chapters.map((record) => record.num),
      target,
    })
    const finished = progress.finished
    const journalBlocking = await this.journalBlocking(snapshot)
    const next =
      journalBlocking.length > 0 && this.stateErrors(snapshot).length === 0
        ? {
            tool: 'novel_audit',
            args: {},
            reason: `${journalBlocking[0]!.code}: ${journalBlocking[0]!.detail}; inspect and restore before the next write`,
          }
        : this.nextStep(snapshot)
    return {
      data: buildGuide({
        projectPresent: true,
        chapter: snapshot.pipeline.chapter,
        stage: snapshot.pipeline.stage,
        progress,
        archived: snapshot.chapters.chapters.length,
        target,
        finished,
        outline: snapshot.outline,
        outlinePresent: snapshot.outlinePresent,
        outlineError: snapshot.outlineError,
        worldbook: snapshot.worldbook,
        worldbookPresent: snapshot.worldbookPresent,
        worldbookError: snapshot.worldbookError,
        next,
        blocking: this.effectiveBlocking(snapshot).length + journalBlocking.length,
        stateErrors: this.stateErrors(snapshot).length,
      }),
      revision: snapshot.pipeline.revision,
      warnings: [],
    }
  }

  /* ----------------------------------------------------------------- briefs */

  async getBrief(input: BriefInput): Promise<OpResult<BriefPayload>> {
    // Surface project/schema errors before the journal-consistency check. A
    // future schema_version must not be reported as an unrelated external-edit
    // mismatch; this preflight is validation only.
    await this.load(input.root)
    // Repeating the same stage on the same chapter is a replay: the run below
    // returns `{ files: [], replay: true }`, so no journal row or revision is
    // written. It still takes the project lock. A lock-free fast path here used
    // to call assertJournalConsistent() outside the writer lock, which could
    // recover or publish another live writer's pending transaction.
    return this.mutate({
      root: input.root,
      op: 'getBrief',
      chapter: input.chapter,
      advanceRevision: false,
      run: async (snapshot, context) => {
        const chapter = input.chapter ?? snapshot.pipeline.chapter
        // 0.2.14: one transaction may sign several stages. A caller that needs
        // P4/P6/P8 currently pays three journal rows and three lock round-trips.
        const stages = [
          ...new Set([...(input.stage === undefined ? [] : [input.stage]), ...(input.stages ?? [])]),
        ]
        if (stages.length === 0) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            'stages must not be empty',
            'pass stage for one task book, or stages for several in one transaction',
          )
        }
        for (const stage of stages) this.assertBriefChapter(stage, snapshot.pipeline.chapter, chapter)
        await this.assertBriefReceiptsWritable(context.store)
        const effort = await this.lifetimeEffort(context.store, snapshot.chapters)
        const payloads = stages.map((stage) =>
          this.briefPayload(snapshot, stage, chapter, effort.lifetime, effort),
        )
        const rawReceipts = await this.readRawBriefReceipts(context.store)
        const view = this.normalizeBriefReceipts(rawReceipts.receipts)
        const issuedAt = this.now().toISOString()
        let changed = false
        for (const data of payloads) {
          const alreadyView = view.find(
            (receipt) =>
              receipt.chapter === chapter && receipt.stage === data.stage && receipt.digest === data.digest,
          )
          if (
            alreadyView !== undefined &&
            alreadyView.current !== false &&
            // A 0.2.13 receipt has no dependency digest. Replaying it would make
            // PG-01 unable to say what changed, so fall through and re-sign it
            // with dependencies instead of returning the blind receipt (M1).
            alreadyView.dependencies !== undefined
          ) {
            continue
          }
          const alreadyRaw = rawReceipts.receipts.find(
            (receipt) =>
              receipt.chapter === chapter && receipt.stage === data.stage && receipt.digest === data.digest,
          )
          for (const previous of rawReceipts.receipts) {
            if (
              previous.chapter === chapter &&
              previous.stage === data.stage &&
              previous !== alreadyRaw &&
              previous.current === true
            ) {
              previous.current = false
              previous.superseded_at = issuedAt
              previous.superseded_by = `${chapter}:${data.stage}:${data.digest}`
            }
          }
          if (alreadyRaw !== undefined) {
            // The same digest existed but had been superseded. Promote it back
            // to current without adding derived fields to legacy rows.
            alreadyRaw.current = true
            alreadyRaw.dependencies = data.dependencies
            delete alreadyRaw.superseded_at
            delete alreadyRaw.superseded_by
          } else {
            rawReceipts.receipts.push({
              chapter,
              stage: data.stage,
              digest: data.digest,
              issued_at: issuedAt,
              id: `${chapter}:${data.stage}:${data.digest}`,
              current: true,
              ...(data.dependencies === undefined ? {} : { dependencies: data.dependencies }),
            })
          }
          changed = true
        }
        if (!changed) {
          // Same chapter/stage/content: replay the signed context without
          // appending a second receipt. The receipt itself is the evidence.
          return {
            files: [],
            data:
              payloads.length === 1 ? payloads[0]! : { ...payloads[0]!, briefs: payloads, replayed: true },
            replay: true,
          }
        }
        // Receipts are append-only evidence. Only the rows that actually carried
        // a current flag are marked superseded; pre-0.2.13 rows are left byte-for-
        // byte intact and current is derived on read.
        const data = payloads.length === 1 ? payloads[0]! : { ...payloads[0]!, briefs: payloads }
        return {
          files: [
            {
              path: BRIEF_RECEIPTS_FILE,
              text: yaml({ schema_version: 1, receipts: rawReceipts.receipts }),
            },
          ],
          backup: false,
          data,
        }
      },
    })
  }

  private assertBriefChapter(stage: BriefStage, active: number, requested: number): void {
    // A brief signs the active snapshot; issuing one for a historical chapter
    // would produce a digest the gates can never match.
    if (requested !== active) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `brief ${stage} belongs to active chapter ${active}, not ${requested}`,
        `omit chapter or pass ${active}`,
      )
    }
  }

  private briefPayload(
    snapshot: Snapshot,
    stage: BriefStage,
    chapter: number,
    totals: { reviews: number; revisions: number; checks: number; rollbacks: number },
    effort?: ReturnType<EngineService['effortProjection']>,
  ): BriefPayload {
    const contextPack = this.briefContextFor(stage, snapshot, chapter)
    const dependencies = this.briefDependencies(stage, snapshot, chapter)
    const digest = this.briefDigest(stage, snapshot, chapter)
    const variables = this.briefVariables(snapshot, chapter)
    const rendered = this.briefs.render(stage, variables)
    const manuscriptHash =
      snapshot.pipeline.draft !== undefined && snapshot.text !== null ? sha256(snapshot.text) : null
    const fields = {
      stage,
      chapter,
      digest,
      manuscript_hash: manuscriptHash,
      min_words: snapshot.project.targets.words_per_chapter[0],
      max_words: snapshot.project.targets.words_per_chapter[1],
      min_cjk_chars: snapshot.project.targets.min_cjk_chars ?? null,
      word_count_basis:
        'total_word_count = cjk_chars + english_words + numbers + punctuation_chars; min_cjk_chars is checked separately',
      word_count_policy: {
        metric: 'total_word_count',
        includes_punctuation: true,
        formula: 'cjk_chars + english_words + numbers + punctuation_chars',
        cjk_bound: snapshot.project.targets.min_cjk_chars ?? null,
        note: '总字数含标点；汉字下限单独判。min_words 是总字数口径，min_cjk_chars 是汉字口径。',
      },
      dialogue_ratio_target: snapshot.project.targets.dialogue_ratio,
      dialogue_ratio_metric: snapshot.project.targets.dialogue_ratio_metric ?? 'both',
      dialogue_char_ratio: countWordMetrics(snapshot.text ?? '').dialogue_char_ratio,
      punctuation_breakdown: countWordMetrics(snapshot.text ?? '').punctuation_breakdown,
      previous_chapter_effort: this.previousChapterEffort(snapshot, totals, effort),
      timeline_event_keys:
        (snapshot.pipeline.draft?.summary ?? snapshot.plan?.summary)?.events.map((event, index) =>
          eventKeyFor(chapter, index, event),
        ) ?? [],
      delta_rules: {
        title_is_a_label: true,
        anchor_required_for_verification: true,
        rule: '伏笔 title 可以写成可读短语；要逐字校验请在 anchor 里放正文原句（至少 8 个字符）。缺 anchor 时 title 必须逐字出现在正文。',
        summary_links: {
          characters_appeared:
            'characters 中 action=created 的每个名字，必须出现在 draft summary.characters_appeared。',
          new_elements:
            'world 中 action=created 的 location/ability/artifact 必须出现在 draft summary.new_elements 的对应数组，且 kind 一致；faction/rule 只需正文出现并按 kind 写入，summary.new_elements 没有对应数组。',
          timeline:
            'timeline 的每个键必须是 draft summary.events 的下标（字符串），或 fields.timeline_event_keys 给出的稳定 event_key。',
          relationships:
            'relationships 的两端必须已存在于 characters（本章 created 或台账已有），否则先声明人物。',
          archive_summary:
            'novel_archive 不接受 summary；summary 在 P3/P5 固定。若 summary 与本章事实不符，先用 novel_brief P5 → novel_revise 修正 summary，再重走 P4/P6/P8。',
        },
        minimal_schema: {
          characters: {
            '<人物名>': {
              action: 'created | updated | no_change',
              reason: 'no_change 必填；created/updated 建议写',
              role: 'protagonist | supporting | antagonist | extra（可选）',
              profile: 'object（可选）',
              current_state: 'object（可选，如 {"resources":{"资源名":-3}}）',
            },
          },
          foreshadows: {
            '<summary.planted.key 或 FS-xxx>': {
              action: 'created | updated | no_change',
              title: '2..16 字可读标签（可选）',
              anchor: '正文逐字原句，至少 8 字',
              planned_resolve: 'integer|null（可选；plot 的计划回收章）',
              kind: 'plot | motif（可选）',
              resolved_anchor: 'resolved 必填；正文逐字原句，至少 8 字',
              note: 'resolve/advance 时写清如何兑现',
              new_info: 'boolean（可选）',
            },
          },
          timeline: {
            '<summary.events 下标或 event_key>': {
              action: 'created',
              story_time: 'string',
              description: 'string',
              location: 'string',
              characters: 'string[]',
            },
          },
          world: {
            '<新地点/能力/物品名>': {
              action: 'created',
              kind: 'location | ability | artifact | faction | rule',
              description: 'string',
            },
          },
          relationships: {
            '<甲|乙>': {
              action: 'created | updated | no_change',
              type: 'string（created 必填）',
              type_code: `created 必填：${RELATIONSHIP_TYPE_CODES.join(' | ')}`,
              description: 'string',
              note: 'string（updated 时写变化）',
            },
          },
        },
        examples: [
          {
            summary_excerpt: {
              characters_appeared: ['角色甲'],
              foreshadows: { planted: [], advanced: ['FS-001'], resolved: [] },
            },
            characters: { 角色甲: { action: 'updated', current_state: { resources: { 资源名: -3 } } } },
            foreshadows: { 'FS-001': { action: 'updated', note: '债务已结清', new_info: true } },
          },
          {
            summary_excerpt: {
              events: ['收到信'],
              new_elements: { locations: ['地点甲'], abilities: [], artifacts: [] },
            },
            timeline: { '0': { action: 'created', story_time: 'Day 3 清晨', description: '收到信' } },
            world: { 地点甲: { action: 'created', kind: 'location', description: '地点说明' } },
          },
        ],
        linked_example: {
          summary: {
            characters_appeared: ['角色甲'],
            new_elements: { locations: ['地点甲'], abilities: [], artifacts: [] },
            events: ['收到信'],
          },
          delta: {
            characters: { 角色甲: { action: 'no_change', reason: '本章无变化' } },
            world: { 地点甲: { action: 'created', kind: 'location', description: '地点说明' } },
            timeline: { '0': { action: 'created', description: '收到信' } },
          },
        },
      },
      ...(stage === 'P5' && manuscriptHash !== null
        ? {
            patch_example: {
              expected_hash: manuscriptHash,
              edits: [{ old_text: '原文中的唯一片段', new_text: '替换后的片段' }],
            },
          }
        : {}),
      min_score: this.config.quality.minScore,
      scene_types: ['战斗/动作章', '日常过渡章', '情感爆发章', '纯叙事章'],
      platform_style: this.rulepack.platform[snapshot.project.platform],
      genre_guide: this.rulepack.genres[snapshot.project.genre],
      /** P4 must apply exclusions before its arithmetic closes. */
      score_exclusions: this.rulepack.exclusions,
      next_tool: NEXT_TOOL_BY_BRIEF[stage],
      book_plan: snapshot.outline.book,
      outline_card: outlineCard(snapshot.outline, chapter),
      worldbook_counts: worldbookCounts(snapshot.worldbook),
      worldbook_facts: snapshot.worldbook.facts ?? [],
      worldbook_facts_empty: snapshot.outline.book.strict && (snapshot.worldbook.facts ?? []).length === 0,
      ...(snapshot.worldPlanError === null ? {} : { world_plan_error: snapshot.worldPlanError }),
      ...(snapshot.planError === null ? {} : { plan_error: snapshot.planError }),
      ...(snapshot.reviewError === null ? {} : { review_error: snapshot.reviewError }),
      ...(snapshot.checkError === null ? {} : { check_error: snapshot.checkError }),
      ...(snapshot.outlineError === null ? {} : { outline_error: snapshot.outlineError }),
      ...(snapshot.worldbookError === null ? {} : { worldbook_error: snapshot.worldbookError }),
    }
    return {
      stage,
      chapter,
      digest,
      dependencies,
      title: rendered.title,
      content: rendered.content,
      content_hash: rendered.contentHash,
      fields,
      context: contextPack,
    }
  }

  /* ------------------------------------------------------------------ plans */

  async submitWorldPlan(
    input: WorldPlanSubmission,
  ): Promise<OpResult<{ chapter: number; stage: Stage; plan_file: string }>> {
    if (typeof input.objective !== 'string' || input.objective.trim() === '') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'world plan objective must not be empty')
    }
    const constraints = stringList(input.constraints, 'constraints')
    const continuity_notes = stringList(input.continuity_notes, 'continuity_notes')
    const objectiveChars = Array.from(input.objective).length
    if (objectiveChars > LIMITS.maxWorldPlanObjectiveChars) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `world plan objective is ${objectiveChars} characters; limit is ${LIMITS.maxWorldPlanObjectiveChars}`,
        'keep the objective to one sentence; it is the heading of the P2 plan',
      )
    }
    for (const [field, values] of [
      ['constraints', constraints],
      ['continuity_notes', continuity_notes],
    ] as const) {
      if (values.length > LIMITS.maxWorldPlanItems) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `world plan ${field} has ${values.length} items; limit is ${LIMITS.maxWorldPlanItems}`,
          'merge related constraints/notes so the protected context stays bounded',
        )
      }
      const chars = values.reduce((total, value) => total + Array.from(value).length, 0)
      if (chars > LIMITS.maxWorldPlanTextChars) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `world plan ${field} has ${chars} characters; limit is ${LIMITS.maxWorldPlanTextChars}`,
          'keep constraints/continuity notes concise; each is a single line in the brief',
        )
      }
    }
    const characters = objectList(input.characters, 'characters')
    for (const [index, character] of characters.entries()) {
      requireText(character, 'name', `characters[${index}].name`)
      requireText(character, 'role', `characters[${index}].role`)
      requireText(character, 'current_state', `characters[${index}].current_state`)
    }
    const locations = objectList(input.locations, 'locations')
    for (const [index, location] of locations.entries()) {
      requireText(location, 'name', `locations[${index}].name`)
      requireText(location, 'layout', `locations[${index}].layout`)
      if (typeof location.capacity !== 'number' || !Number.isFinite(location.capacity)) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `locations[${index}].capacity must be a finite number`,
        )
      }
    }
    return this.mutate({
      root: input.root,
      op: 'submitWorldPlan',
      key: (snapshot) => `world:${snapshot.pipeline.chapter}:${sha256(stableJson(input))}`,
      run: async (snapshot, context) => {
        this.assertChapterWithinTarget(snapshot, snapshot.pipeline.chapter, 'novel_plan_world')
        await this.assertGates(snapshot, 'submitWorldPlan', { briefStage: 'P1' })
        const chapter = snapshot.pipeline.chapter
        const plan: WorldPlanInput = {
          chapter,
          objective: input.objective,
          constraints,
          characters: characters as WorldPlanInput['characters'],
          locations: locations as WorldPlanInput['locations'],
          continuity_notes,
        }
        const path = planWorldFile(chapter)
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          stage: 'P2',
          rounds: { review: 0, revise: 0, check: 0 },
          blocking: [],
          last_action: action('novel_plan_world', this.now(), shortDigest(stableJson(plan))),
        })
        return {
          files: [
            { path, text: yaml({ schema_version: 1, ...plan }) },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
          backup: snapshot.worldPlan !== null,
          data: { chapter, stage: 'P2' as Stage, plan_file: path },
        }
      },
    })
  }

  async submitChapterPlan(
    input: ChapterPlanSubmission,
  ): Promise<OpResult<{ chapter: number; stage: Stage; plan_file: string }>> {
    if (typeof input.title !== 'string' || input.title.trim() === '') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'chapter plan title must not be empty')
    }
    const titleTemplate = this.rulepack.format.title
    if (LENIENT_TITLE_PREFIX.test(input.title)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'chapter plan title must not include the 第N章 prefix',
        'submit the title body only; the engine adds the canonical prefix',
      )
    }
    const titleBody = input.title.trim()
    const titleLength = Array.from(titleBody).length
    if (titleLength < titleTemplate.min_chars || titleLength > titleTemplate.max_chars) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `chapter plan title body must be ${titleTemplate.min_chars}..${titleTemplate.max_chars} characters, got ${titleLength}`,
        'use the same title body the P3 title rule will judge',
      )
    }
    if (typeof input.narrator !== 'string' || input.narrator.trim() === '') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'chapter plan narrator must not be empty')
    }
    const beats = stringList(input.beats, 'beats')
    if (beats.length < 5 || beats.length > 8) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `chapter plan beats must contain 5..8 non-empty items, got ${beats.length}`,
        'write the five to eight causal beats the P2 task book requires',
      )
    }
    for (const [field, value] of [
      ['opening', input.opening],
      ['ending', input.ending],
    ] as const) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `chapter plan ${field} must not be empty`)
      }
    }
    if (!(SCENE_TYPES as readonly string[]).includes(input.scene_type)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `unknown scene_type "${String(input.scene_type)}"`,
        `allowed: ${SCENE_TYPES.join(', ')}`,
      )
    }
    if (!Array.isArray(input.target_words) || input.target_words.length !== 2) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'target_words must be [min, max] positive integers with min <= max',
      )
    }
    const [min, max] = input.target_words
    if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max < min) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'target_words must be [min, max] positive integers with min <= max',
      )
    }
    return this.mutate({
      root: input.root,
      op: 'submitChapterPlan',
      key: (snapshot) => `plan:${snapshot.pipeline.chapter}:${sha256(stableJson(input))}`,
      run: async (snapshot, context) => {
        this.assertChapterWithinTarget(snapshot, snapshot.pipeline.chapter, 'novel_plan_chapter')
        const cast = normalizeCast(input.cast, snapshot)
        await this.assertGates(snapshot, 'submitChapterPlan', {
          briefStage: 'P2',
          draftTitle: input.title,
          sceneType: input.scene_type,
          planTargetWords: input.target_words,
          planCast: cast?.map((member) => member.name) ?? null,
        })
        const chapter = snapshot.pipeline.chapter
        const path = planChapterFile(chapter)
        const plan = {
          ...input,
          chapter,
          beats,
          ...(cast === undefined ? {} : { cast }),
          schema_version: 1 as const,
        }
        delete (plan as { root?: string }).root
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          stage: 'P3',
          blocking: [],
          last_action: action('novel_plan_chapter', this.now(), shortDigest(stableJson(plan))),
        })
        // PG-06 used to fire only at P3, after the prose existed; the plan now
        // warns at P2 while changing the scene type is still free (M13).
        const recentSceneTypes = snapshot.chapters.chapters.slice(-2).map((record) => record.scene_type)
        const pinnedCard = snapshot.outline.chapters.find((candidate) => candidate.num === chapter)
        const monotony =
          recentSceneTypes.length === 2 && recentSceneTypes.every((type) => type === input.scene_type)
        const warnings: Warning[] =
          monotony && pinnedCard === undefined
            ? [
                {
                  code: 'PG-06_PLAN_CONFLICT',
                  message: `三章连续「${input.scene_type}」；P3 会被 PG-06 拦下。改 scene_type，或先在 outline 里给第 ${chapter} 章建卡（卡优先）。`,
                },
              ]
            : []
        return {
          files: [
            ...(snapshot.plan === null
              ? []
              : [
                  {
                    path: planHistoryFile(chapter, snapshot.pipeline.revision),
                    text: yaml(snapshot.plan),
                  },
                ]),
            { path, text: yaml(plan) },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
          backup: snapshot.plan !== null,
          data: { chapter, stage: 'P3' as Stage, plan_file: path },
          warnings,
        }
      },
    })
  }

  /* ----------------------------------------------------------------- drafts */

  async submitDraft(
    input: DraftSubmission,
  ): Promise<OpResult<{ chapter: number; stage: Stage; metrics: WordMetrics; warnings: Warning[] }>> {
    if (typeof input.content !== 'string' || input.content.trim() === '') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'draft content must not be empty')
    }
    if (typeof input.chapter_title !== 'string' || input.chapter_title.trim() === '') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'chapter_title must not be empty')
    }
    if (typeof input.narrator !== 'string' || input.narrator.trim() === '') {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'narrator must not be empty',
        'use the narration person/name validated at P2; a blank narrator would make the stored plan unreadable',
      )
    }
    if (!(SCENE_TYPES as readonly string[]).includes(input.scene_type)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `unknown scene_type "${String(input.scene_type)}"`,
        `allowed: ${SCENE_TYPES.join(', ')}`,
      )
    }
    return this.mutate({
      root: input.root,
      op: 'submitDraft',
      chapter: input.chapter,
      key: () =>
        `draft:${input.chapter}:${sha256(
          stableJson({
            content: input.content,
            chapter_title: input.chapter_title,
            scene_type: input.scene_type,
            narrator: input.narrator,
            summary: input.summary,
          }),
        )}`,
      run: async (snapshot, context) => {
        this.assertChapter(snapshot, input.chapter)
        this.assertChapterWithinTarget(snapshot, input.chapter, 'novel_write_draft')
        await this.assertGates(snapshot, 'submitDraft', {
          briefStage: 'P3',
          text: input.content,
          summary: input.summary,
          draftTitle: input.chapter_title,
          sceneType: input.scene_type,
          narrator: input.narrator,
          planTargetWords: snapshot.plan?.target_words ?? null,
          planCast:
            snapshot.plan?.cast === undefined ? null : snapshot.plan.cast.map((member) => member.name),
        })
        const machine = this.machine(snapshot, input.content, {
          title: input.chapter_title,
          sceneType: input.scene_type,
          summary: input.summary,
        })
        const chapter = input.chapter
        // The P3 draft must extend a parsed, validated chapter plan. Reading
        // the raw file again here used to turn a missing plan into a partial
        // replacement that made the next load fail.
        const plan = snapshot.plan
        if (plan === null) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `chapter ${chapter} has no usable plan`,
            'rollback to P2 and submit novel_plan_chapter; the draft was not written',
          )
        }
        const draft: DraftState = {
          chapter,
          title: input.chapter_title,
          scene_type: input.scene_type,
          narrator: input.narrator,
          summary: input.summary,
          content_hash: sha256(input.content),
          updated_at: this.now().toISOString(),
        }
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          stage: 'P4',
          draft,
          blocking: [],
          last_action: action('novel_write_draft', this.now(), sha256(input.content)),
        })
        return {
          files: [
            ...(snapshot.text === null
              ? []
              : [
                  {
                    path: chapterHistoryFile(chapter, snapshot.pipeline.revision),
                    text: snapshot.text,
                  },
                ]),
            { path: chapterFile(chapter), text: input.content },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
          backup: true,
          data: {
            chapter,
            stage: 'P4' as Stage,
            metrics: machine.metrics,
            warnings: machineWarnings(machine),
          },
        }
      },
    })
  }

  async submitReview(input: ReviewSubmission): Promise<
    OpResult<{
      chapter: number
      round: number
      total: number
      open_blockers: number
      next_stage: Stage
      /** Present only for an issue amendment. */
      amended?: string[]
      rounds?: RoundCounters
    }>
  > {
    if (input.amend_issues !== undefined) return this.amendReviewIssues(input)
    return this.mutate({
      root: input.root,
      op: 'submitReview',
      chapter: input.chapter,
      key: (snapshot) =>
        `review:${input.chapter}:${sha256(snapshot.text ?? '')}:${sha256(
          stableJson({
            dimensions: input.dimensions,
            issues: input.issues,
            total: input.total,
            proof: input.proof,
          }),
        )}`,
      run: async (snapshot, context) => {
        this.assertChapter(snapshot, input.chapter)
        const text = snapshot.text ?? ''
        if (!Array.isArray(input.dimensions) || !Array.isArray(input.issues) || input.proof === undefined) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            'submitReview needs dimensions, issues and proof (or amend_issues)',
            'pass the fifteen dimensions, the issue list and the three reading proofs; amend_issues is only for corrections',
          )
        }
        const provided: ScoreDimension[] = input.dimensions
        const excluded = applyExclusions(provided, this.rulepack.exclusions)
        const computed = totalScore(excluded.dimensions)
        // The engine already computes the total; requiring the caller to
        // recompute it only produced "claimed X != actual Y" loops (M14).
        const claimed = input.total ?? computed
        if (input.total !== undefined && (!Number.isInteger(input.total) || input.total !== computed)) {
          throw new EngineInputError(
            ERROR_CODES.SCORE_MISMATCH,
            `claimed total ${String(input.total)} does not equal 150 - Σdelta (${computed})`,
            'omit total and let the engine compute it, or recompute after the rulepack exclusions',
            {
              details: {
                field: 'total',
                expected: computed,
                received: input.total,
                required_tool: 'novel_review',
                changed: [],
                engine_total: computed,
                raw_total: totalScore(provided),
                // The rulepack can drop duplicate or mutually exclusive
                // deductions. A bare "claimed ≠ computed" hides that policy;
                // list exactly which rows were removed (M14).
                exclusions_applied: excluded.dropped_entries,
              },
            },
          )
        }
        const arithmetic = reviewArithmeticProblems(excluded.dimensions, claimed)
        if (arithmetic.length > 0) {
          throw new EngineInputError(
            ERROR_CODES.SCORE_MISMATCH,
            `review arithmetic does not close: ${arithmetic.join('; ')}`,
          )
        }
        const issues = input.issues
        const seenIssues = new Set<string>()
        for (const [index, issue] of issues.entries()) {
          if (
            typeof issue !== 'object' ||
            issue === null ||
            typeof issue.id !== 'string' ||
            issue.id.trim() === '' ||
            !['blocker', 'advisory'].includes(issue.severity) ||
            !['open', 'fixed', 'waived'].includes(issue.status)
          ) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `issue ${index} is malformed`,
              'every issue needs id, severity, status, dimension, location, problem and fix',
            )
          }
          if (seenIssues.has(issue.id)) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `issue ${issue.id} is declared more than once`,
              'issue ids must be unique within one review',
            )
          }
          seenIssues.add(issue.id)
          for (const field of ['dimension', 'location', 'problem', 'fix'] as const) {
            if (typeof issue[field] !== 'string' || issue[field].trim() === '') {
              throw new EngineInputError(
                ERROR_CODES.SCHEMA_INVALID,
                `issue ${issue.id} has no ${field}`,
                'every issue needs id, severity, status, dimension, location, problem and fix',
              )
            }
          }
          if (issue.evidence !== undefined && typeof issue.evidence !== 'string') {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `issue ${issue.id} evidence must be a string`,
              'quote the revised text as evidence, or omit the field',
            )
          }
          if (issue.severity === 'blocker' && issue.status === 'waived') {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `issue ${issue.id} is a blocker and cannot be waived`,
              'fix the issue and quote the revised text, or keep it open',
            )
          }
          const dimension = this.rulepack.quality.dimensions.find((item) => item.id === issue.dimension)
          if (dimension === undefined) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `issue ${issue.id} references unknown dimension "${issue.dimension}"`,
              `use one of: ${this.rulepack.quality.dimensions.map((item) => item.id).join(', ')}`,
            )
          }
          const paragraph = parseParagraphLocation(issue.location)
          const paragraphCount = splitParagraphs(text).length
          if (paragraph === null || paragraph < 1 || paragraph > paragraphCount) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `issue ${issue.id} location "${issue.location}" is outside the chapter`,
              `use 第 1 段 .. 第 ${paragraphCount} 段`,
            )
          }
        }
        const review: ReviewDocument = {
          schema_version: 1,
          chapter: input.chapter,
          round: snapshot.pipeline.rounds.review + 1,
          content_hash: sha256(text),
          dimensions: excluded.dimensions,
          issues,
          total: claimed,
          proof: input.proof,
        }
        await this.assertGates(snapshot, 'submitReview', {
          briefStage: 'P4',
          review,
          proof: input.proof,
        })
        if (text === '') {
          throw new EngineInputError(
            ERROR_CODES.STAGE_ORDER,
            `chapter ${input.chapter} has no draft to review`,
            'call novel_write_draft first',
          )
        }
        const belowMin = claimed < this.config.quality.minScore
        const openBlockers =
          issues.filter((issue) => issue.severity === 'blocker' && issue.status !== 'fixed').length +
          (belowMin ? 1 : 0)
        const next = computeNextStage(snapshot.pipeline.stage, 'submitReview', openBlockers)
        const blocking: BlockingItem[] = issues
          .filter((issue) => issue.severity === 'blocker' && issue.status !== 'fixed')
          .map((issue) => ({
            code: `ISSUE-${issue.id}`,
            scope: issue.dimension,
            detail: `${issue.problem} → ${issue.fix}`,
            hint: issue.location,
          }))
        if (belowMin) {
          blocking.push({
            code: 'SCORE-BELOW-MIN',
            scope: 'quality',
            detail: `score ${claimed} is below the minimum ${this.config.quality.minScore}`,
            hint: 'revise the chapter and submit a new P4 review',
          })
        }
        const reviewDigest = sha256(stableJson(review))
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          stage: next,
          rounds: { ...snapshot.pipeline.rounds, review: snapshot.pipeline.rounds.review + 1 },
          blocking,
          review_digest: reviewDigest,
          last_action: action('novel_review', this.now(), reviewDigest),
        })
        return {
          files: [
            ...(snapshot.review === null
              ? []
              : [
                  {
                    path: reviewHistoryFile(input.chapter, snapshot.pipeline.revision),
                    text: yaml(snapshot.review),
                  },
                ]),
            { path: reviewFile(input.chapter), text: yaml(review) },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
          backup: snapshot.review !== null,
          data: {
            chapter: input.chapter,
            round: review.round,
            total: review.total,
            open_blockers: openBlockers,
            next_stage: next,
          },
          warnings:
            excluded.dropped > 0
              ? [
                  {
                    code: 'SCORE_EXCLUSIONS',
                    // M14: the count alone leaves the author unable to see
                    // which deductions the rulepack removed when `total` was
                    // omitted and nothing failed.
                    message:
                      `${excluded.dropped} mutually exclusive deduction(s) were dropped: ` +
                      excluded.dropped_entries
                        .map(
                          (entry) =>
                            `${entry.rule}${entry.location === undefined ? '' : ` at ${entry.location}`} (${entry.reason})`,
                        )
                        .join('; '),
                  },
                ]
              : [],
        }
      },
    })
  }

  /**
   * Correct reviewer-owned metadata (location/problem/fix/severity) in place.
   * This is not a new P4 round: the total, the dimensions and the review count
   * are untouched, and the journal records `reviewAmendment`.
   */
  private async amendReviewIssues(input: ReviewSubmission): Promise<
    OpResult<{
      chapter: number
      round: number
      total: number
      open_blockers: number
      next_stage: Stage
      amended: string[]
      rounds: RoundCounters
    }>
  > {
    const patches = input.amend_issues ?? []
    if (patches.length === 0) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'amend_issues must not be empty')
    }
    return this.mutate({
      root: input.root,
      op: 'reviewAmendment',
      chapter: input.chapter,
      reason: input.amend_note ?? 'correct review metadata',
      run: async (snapshot, context) => {
        this.assertChapter(snapshot, input.chapter)
        const review = snapshot.review
        if (review === null) {
          throw new EngineInputError(
            ERROR_CODES.STAGE_ORDER,
            `chapter ${input.chapter} has no review to amend`,
            'submit the P4 review first; amendments correct an existing review',
          )
        }
        if (!['P5', 'P6', 'ready_to_archive'].includes(snapshot.pipeline.stage)) {
          throw new EngineInputError(
            ERROR_CODES.STAGE_ORDER,
            `review amendments are not allowed at stage ${snapshot.pipeline.stage}`,
            'amend issues during P5/P6/ready_to_archive',
          )
        }
        const issues = review.issues.map((issue) => ({ ...issue }))
        const byId = new Map(issues.map((issue) => [issue.id, issue]))
        const amended: string[] = []
        for (const patch of patches) {
          const issue = byId.get(patch.id)
          if (issue === undefined) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `issue ${patch.id} is not in the current review`,
              `current issues: ${issues.map((row) => row.id).join(', ') || 'none'}`,
            )
          }
          if (patch.severity === 'advisory' && issue.severity === 'blocker') {
            throw new EngineInputError(
              ERROR_CODES.ISSUE_IMMUTABLE,
              `issue ${patch.id} is a blocker and cannot be downgraded`,
              'fix the issue, or keep it a blocker; severity cannot be lowered by an amendment',
            )
          }
          if (patch.status === 'waived' && issue.severity === 'blocker') {
            throw new EngineInputError(
              ERROR_CODES.ISSUE_IMMUTABLE,
              `issue ${patch.id} is a blocker and cannot be waived`,
            )
          }
          if (patch.location !== undefined) {
            const paragraph = parseParagraphLocation(patch.location)
            const paragraphCount = splitParagraphs(snapshot.text ?? '').length
            if (paragraph === null || paragraph < 1 || paragraph > paragraphCount) {
              throw new EngineInputError(
                ERROR_CODES.SCHEMA_INVALID,
                `issue ${patch.id} location "${patch.location}" is outside the chapter`,
                `use 第 1 段 .. 第 ${paragraphCount} 段`,
              )
            }
            issue.location = patch.location
          }
          if (patch.problem !== undefined) issue.problem = patch.problem
          if (patch.fix !== undefined) issue.fix = patch.fix
          if (patch.severity !== undefined) issue.severity = patch.severity
          if (patch.status !== undefined) issue.status = patch.status
          if (patch.evidence !== undefined) issue.evidence = patch.evidence
          // 0.2.17: PG-08 requires a verbatim quote for every fixed blocker. An
          // amendment that skipped it produced a read model saying "no blocking
          // items" while the archive gate still refused, costing a round trip
          // and hiding which field was missing.
          if (issue.status === 'fixed' && issue.severity === 'blocker') {
            const evidence = typeof issue.evidence === 'string' ? issue.evidence.trim() : ''
            if (evidence === '') {
              throw new EngineInputError(
                ERROR_CODES.ISSUE_IMMUTABLE,
                `issue ${patch.id} is a blocker and cannot be marked fixed without evidence`,
                'quote the revised sentence that fixes it; PG-08 verifies the same quote at archive time',
                { details: { field: `${patch.id}.evidence`, required: 'evidence', received: null } },
              )
            }
            if (!quoteMeetsFloor(evidence, 8)) {
              throw new EngineInputError(
                ERROR_CODES.ISSUE_IMMUTABLE,
                `issue ${patch.id} evidence is shorter than 8 characters`,
                'quote at least 8 Chinese characters (12 characters overall) from the current manuscript',
                { details: { field: `${patch.id}.evidence`, required: 'evidence', received: evidence } },
              )
            }
            const match = matchEvidence(snapshot.text ?? '', evidence)
            if (!match.found) {
              throw new EngineInputError(
                ERROR_CODES.ISSUE_IMMUTABLE,
                `issue ${patch.id} evidence is not in the current manuscript`,
                'quote the revised sentence verbatim; novel_diff shows what the revision changed',
                {
                  details: {
                    field: `${patch.id}.evidence`,
                    required: 'evidence',
                    received: evidence,
                    ...(match.nearest === undefined
                      ? {}
                      : {
                          nearest: {
                            paragraph: match.nearest.paragraph,
                            text: match.nearest.text,
                            offset: match.nearest.offset,
                          },
                        }),
                  },
                },
              )
            }
          }
          amended.push(issue.id)
        }
        const updated: ReviewDocument = {
          ...review,
          issues,
          amendments: [
            ...(review.amendments ?? []),
            {
              at: this.now().toISOString(),
              note: input.amend_note ?? 'review metadata corrected',
              issues: [...new Set(amended)],
            },
          ],
        }
        const blocking: BlockingItem[] = issues
          .filter((issue) => issue.severity === 'blocker' && issue.status !== 'fixed')
          .map((issue) => ({
            code: `ISSUE-${issue.id}`,
            scope: issue.dimension,
            detail: `${issue.problem} → ${issue.fix}`,
            hint: issue.location,
          }))
        const digest = sha256(stableJson(updated))
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          blocking,
          review_digest: digest,
          last_action: action('novel_review_amend', this.now(), digest),
        })
        return {
          files: [
            { path: reviewFile(input.chapter), text: yaml(updated) },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
          backup: true,
          data: {
            chapter: input.chapter,
            round: review.round,
            total: review.total,
            open_blockers: blocking.length,
            next_stage: snapshot.pipeline.stage,
            amended: [...new Set(amended)],
            rounds: snapshot.pipeline.rounds,
          },
          warnings: [],
        }
      },
    })
  }

  async submitRevision(input: RevisionSubmission): Promise<
    OpResult<{
      chapter: number
      stage: Stage
      metrics: WordMetrics
      summary_only?: boolean
      rounds_consumed?: 0 | 1
    }>
  > {
    const hasContent = input.content !== undefined
    const hasPatch = input.patch !== undefined
    const summaryOnly = !hasContent && !hasPatch && input.summary !== undefined
    if (!hasContent && !hasPatch && !summaryOnly) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'novel_revise requires content, patch, or summary',
        'send revised text, a patch, or a full summary for a summary-only repair',
      )
    }
    if (hasContent && hasPatch) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'novel_revise accepts only one of content or patch',
        'send the full revised text, or a patch with expected_hash and unique edits',
      )
    }
    if (summaryOnly && (input.issues !== undefined || input.proof !== undefined)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'summary-only repair cannot change review issues or reading proof',
        'send only chapter and summary; use content/patch for a prose revision that needs a new proof',
      )
    }
    if (!summaryOnly && input.proof === undefined) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'novel_revise requires proof for a content or patch revision',
        'provide opening/middle/ending quotes from the revised text',
      )
    }
    if (hasPatch) {
      const patch = input.patch!
      if (
        patch === null ||
        typeof patch !== 'object' ||
        !Array.isArray(patch.edits) ||
        patch.edits.length === 0
      ) {
        throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'patch.edits must be a non-empty array')
      }
      if (typeof patch.expected_hash !== 'string' || patch.expected_hash.trim() === '') {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          'patch.expected_hash must be the sha256 of the current manuscript',
          'read novel_status or the current manuscript, then hash the exact text',
        )
      }
      for (const [index, edit] of patch.edits.entries()) {
        if (
          typeof edit !== 'object' ||
          edit === null ||
          typeof edit.old_text !== 'string' ||
          edit.old_text === '' ||
          typeof edit.new_text !== 'string'
        ) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `patch.edits[${index}] needs non-empty old_text and a string new_text`,
          )
        }
        if (edit.occurrence !== undefined && (!Number.isInteger(edit.occurrence) || edit.occurrence < 1)) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `patch.edits[${index}].occurrence must be a positive integer`,
          )
        }
      }
    }
    return this.mutate({
      root: input.root,
      op: 'submitRevision',
      chapter: input.chapter,
      key: () =>
        `revision:${input.chapter}:${sha256(
          input.patch !== undefined
            ? stableJson(input.patch)
            : typeof input.content === 'string'
              ? input.content
              : stableJson(input.content),
        )}:${sha256(stableJson({ summary: input.summary, issues: input.issues, proof: input.proof }))}`,
      run: async (snapshot, context) => {
        this.assertChapter(snapshot, input.chapter)
        if (summaryOnly && !['P5', 'P6', 'ready_to_archive'].includes(snapshot.pipeline.stage)) {
          throw new EngineInputError(
            ERROR_CODES.STAGE_ORDER,
            `summary-only repair is not available at ${snapshot.pipeline.stage}`,
            'use novel_revise with content/patch for an early-stage rewrite, or wait until P5/P6',
          )
        }
        const revisedContent = summaryOnly
          ? (snapshot.text ?? '')
          : input.patch === undefined
            ? (input.content as string)
            : applyRevisionPatch(snapshot.text ?? '', input.patch)
        if (summaryOnly && snapshot.text === null) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            'summary-only repair requires an existing draft',
            'write the draft first, then repair its summary',
          )
        }
        if (typeof revisedContent !== 'string') {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            'revision content must be a string',
            'send the full revised text as a string, or a patch object',
          )
        }
        if (revisedContent.trim() === '') {
          throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'revision content must not be empty')
        }
        let patchedReview: ReviewDocument | null = null
        if (snapshot.review !== null) {
          const original = snapshot.review.issues
          let issues = original
          if (input.issues !== undefined) {
            if (!Array.isArray(input.issues)) {
              throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'issues must be an array')
            }
            const byId = new Map(original.map((issue) => [issue.id, issue]))
            const seen = new Set<string>()
            issues = original.map((issue) => ({ ...issue }))
            for (const submitted of input.issues) {
              if (typeof submitted !== 'object' || submitted === null || typeof submitted.id !== 'string') {
                throw new EngineInputError(
                  ERROR_CODES.SCHEMA_INVALID,
                  'every issue in a revision must be an object with an id',
                )
              }
              if (
                typeof submitted.status !== 'string' ||
                !['open', 'fixed', 'waived'].includes(submitted.status)
              ) {
                throw new EngineInputError(
                  ERROR_CODES.SCHEMA_INVALID,
                  `issue ${submitted.id} has an invalid status`,
                  'status must be open, fixed, or waived',
                )
              }
              if (submitted.evidence !== undefined && typeof submitted.evidence !== 'string') {
                throw new EngineInputError(
                  ERROR_CODES.SCHEMA_INVALID,
                  `issue ${submitted.id} evidence must be a string`,
                )
              }
              for (const field of ['dimension', 'location', 'problem', 'fix'] as const) {
                if (
                  submitted[field] !== undefined &&
                  (typeof submitted[field] !== 'string' || submitted[field].trim() === '')
                ) {
                  throw new EngineInputError(
                    ERROR_CODES.SCHEMA_INVALID,
                    `issue ${submitted.id} has an invalid ${field}`,
                  )
                }
              }
              if (seen.has(submitted.id)) {
                throw new EngineInputError(
                  ERROR_CODES.SCHEMA_INVALID,
                  `issue ${submitted.id} appears more than once in the revision`,
                )
              }
              seen.add(submitted.id)
              const before = byId.get(submitted.id)
              if (before === undefined) {
                throw new EngineInputError(
                  ERROR_CODES.SCHEMA_INVALID,
                  `revision references unknown issue ${submitted.id}`,
                  'only update issues from the current review; new issues belong in the next review',
                )
              }
              // A revision may close an issue with status/evidence, but it may
              // not rewrite what the reviewer found. Otherwise "fixing" an
              // issue can mean editing its text until the blocker disappears.
              for (const field of ['dimension', 'location', 'problem', 'fix'] as const) {
                if (submitted[field] !== undefined && submitted[field] !== before[field]) {
                  throw new EngineInputError(
                    ERROR_CODES.ISSUE_IMMUTABLE,
                    `issue ${submitted.id} cannot change its ${field} during revision (received ${typeof submitted[field]}: ${JSON.stringify(submitted[field])})`,
                    'only status and evidence may change; new findings belong in the next review',
                  )
                }
              }
              if (submitted.severity !== undefined && submitted.severity !== before.severity) {
                throw new EngineInputError(
                  ERROR_CODES.ISSUE_IMMUTABLE,
                  `issue ${submitted.id} cannot change severity during revision (received ${typeof submitted.severity}: ${JSON.stringify(submitted.severity)})`,
                  'only status and evidence may change; a blocker stays a blocker until re-reviewed',
                )
              }
              if (
                before.severity === 'blocker' &&
                submitted.severity !== undefined &&
                submitted.severity !== 'blocker'
              ) {
                throw new EngineInputError(
                  ERROR_CODES.ISSUE_IMMUTABLE,
                  `issue ${submitted.id} is a blocker and cannot be downgraded (received ${JSON.stringify(submitted.severity)})`,
                  'keep severity blocker and mark it fixed with evidence',
                )
              }
              if (before.severity === 'blocker' && submitted.status === 'waived') {
                throw new EngineInputError(
                  ERROR_CODES.ISSUE_IMMUTABLE,
                  `issue ${submitted.id} is a blocker and cannot be waived (received status: ${JSON.stringify(submitted.status)})`,
                  'keep severity blocker and mark it fixed with evidence',
                )
              }
              const index = issues.findIndex((issue) => issue.id === submitted.id)
              issues[index] = { ...before, ...submitted, severity: before.severity }
            }
          }
          // Never rewrite content_hash here. It binds the version actually
          // reviewed; rewriting it would let an old score satisfy PG-07 after
          // a revision without a new P4 review.
          patchedReview = { ...snapshot.review, issues }
        }
        const reviewChanged =
          patchedReview !== null &&
          (snapshot.review === null || stableJson(patchedReview) !== stableJson(snapshot.review))
        if (patchedReview !== null) {
          try {
            narrow('review', patchedReview)
          } catch (error) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `revision would write an invalid review document: ${
                error instanceof Error ? error.message : String(error)
              }`,
              'only update issue status/evidence fields from the current review',
            )
          }
        }
        await this.assertGates(snapshot, 'submitRevision', {
          briefStage: briefStageFor('submitRevision', snapshot.pipeline.stage),
          text: revisedContent,
          summary: input.summary,
          summaryProvided: input.summary !== undefined,
          summaryOnly,
          summaryOnlyRevision: summaryOnly,
          review: patchedReview,
          proof: input.proof ?? snapshot.review?.proof ?? null,
        })
        // P5 may omit the summary only while it still describes the revised
        // opening. Otherwise the stale PG-05 opening survives to P6 and costs
        // another revision (and a PG-11 round) to repair.
        const inheritedSummary = snapshot.pipeline.draft?.summary ?? snapshot.plan?.summary
        if (input.summary === undefined && inheritedSummary !== undefined) {
          const opening = inheritedSummary.opening
          if (!openingInFirstTwoParagraphs(revisedContent, opening)) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              'summary omitted, but the stored opening no longer appears in the revised first two paragraphs',
              'resubmit novel_revise with a summary whose opening quotes the revised text',
            )
          }
        }
        const effectiveSummary = input.summary ?? inheritedSummary
        if (effectiveSummary === undefined) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            'the revised draft has no summary',
            'resubmit novel_revise with the ten-field summary',
          )
        }
        const machine = this.machine(snapshot, revisedContent, {
          summary: effectiveSummary,
        })
        const baseDraft: DraftState = snapshot.pipeline.draft ?? {
          chapter: input.chapter,
          title: snapshot.plan?.title ?? `第${input.chapter}章`,
          scene_type: snapshot.plan?.scene_type ?? '日常过渡章',
          narrator: snapshot.plan?.narrator ?? '',
          summary: effectiveSummary,
          content_hash: sha256(snapshot.text ?? ''),
          updated_at: this.now().toISOString(),
        }
        const nextStage = summaryOnly
          ? snapshot.pipeline.stage === 'P5'
            ? 'P6'
            : snapshot.pipeline.stage
          : computeNextStage(snapshot.pipeline.stage, 'submitRevision', 0)
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          stage: nextStage,
          draft: {
            ...baseDraft,
            summary: effectiveSummary,
            content_hash: summaryOnly ? baseDraft.content_hash : sha256(revisedContent),
            updated_at: this.now().toISOString(),
          },
          rounds: summaryOnly
            ? { ...snapshot.pipeline.rounds }
            : { ...snapshot.pipeline.rounds, revise: snapshot.pipeline.rounds.revise + 1 },
          blocking: summaryOnly ? snapshot.pipeline.blocking.filter((item) => item.code !== 'PG-05') : [],
          ...(patchedReview === null || (!reviewChanged && snapshot.pipeline.review_digest !== undefined)
            ? {}
            : { review_digest: sha256(stableJson(patchedReview)) }),
          last_action: action(
            summaryOnly ? 'novel_revise_summary' : 'novel_revise',
            this.now(),
            sha256(revisedContent),
          ),
        })
        const files: StagedFile[] = summaryOnly
          ? [{ path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) }]
          : [
              ...(snapshot.text === null
                ? []
                : [
                    {
                      path: chapterHistoryFile(input.chapter, snapshot.pipeline.revision),
                      text: snapshot.text,
                    },
                  ]),
              ...(snapshot.review === null || !reviewChanged
                ? []
                : [
                    {
                      path: reviewHistoryFile(input.chapter, snapshot.pipeline.revision),
                      text: yaml(snapshot.review),
                    },
                  ]),
              { path: chapterFile(input.chapter), text: revisedContent },
              { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
            ]
        if (!summaryOnly && reviewChanged && patchedReview !== null) {
          files.push({ path: reviewFile(input.chapter), text: yaml(patchedReview) })
        }
        return {
          files,
          backup: !summaryOnly,
          data: {
            chapter: input.chapter,
            stage: nextStage,
            metrics: machine.metrics,
            summary_only: summaryOnly,
            rounds_consumed: summaryOnly ? 0 : 1,
          },
          warnings: machineWarnings(machine),
        }
      },
    })
  }

  async runCheck(input: CheckSubmission): Promise<
    OpResult<{
      chapter: number
      verdict: 'pass' | 'fail'
      violations: number
      advisories: number
      advisory_codes: string[]
      advisory_instances: Array<{
        id: string
        location: import('../types.js').ViolationLocation
        detail: string
      }>
      acknowledged: string[]
      acknowledged_findings: Array<{ id: string; code: string; reason: string; at: string }>
      metrics: WordMetrics
      numeric: NonNullable<CheckDocument['machine']['numeric']>
      stage: Stage
      semantic: { items: import('./semantic.js').SemanticItemResult[]; findings: BlockingItem[] }
      rounds: { check: number }
      counted: boolean
    }>
  > {
    const scope = normalizeCheckScope(input.scope)
    return this.mutate({
      root: input.root,
      op: 'runCheck',
      chapter: input.chapter,
      key: (snapshot) =>
        `check:${input.chapter}:${sha256(snapshot.text ?? '')}:${sha256(
          stableJson({
            semantic: input.semantic ?? [],
            scope,
            acknowledge: input.acknowledge ?? [],
            acknowledge_reasons: input.acknowledge_reasons ?? {},
          }),
        )}`,
      run: async (snapshot, context) => {
        this.assertChapter(snapshot, input.chapter)
        const text = snapshot.text ?? ''
        if (input.acknowledge !== undefined && !Array.isArray(input.acknowledge)) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            'acknowledge must be an array of advisory codes',
            'omit acknowledge or pass an array of advisory codes',
          )
        }
        const semanticEvaluation = validateSemanticSubmission(text, input.semantic)
        const semantic = input.semantic
        await this.assertGates(snapshot, 'runCheck', {
          briefStage: 'P6',
          text,
          proof: snapshot.review?.proof ?? null,
          semantic,
          scope,
        })
        const machine = this.machine(snapshot, text, { summary: snapshot.plan?.summary ?? null })
        const scopedViolations = machine.violations.filter((violation) =>
          scope.includes(scopeOfRule(violation.code)),
        )
        const scopedMachine: MachineResult = {
          ...machine,
          violations: scopedViolations,
          numeric: scope.includes('content')
            ? {
                ...machine.numeric,
                // `numeric` is a summary of the same scoped findings, not of
                // the full machine pass. An integrity-only check must not
                // claim that content numeric work was included.
                findings: scopedViolations.filter((violation) => violation.code.startsWith('NUMERIC_'))
                  .length,
              }
            : {
                facts_declared: 0,
                facts_checked: 0,
                facts_unused: 0,
                equations_checked: 0,
                findings: 0,
              },
        }
        const machineBlocking = scopedMachine.violations.filter(
          (violation) => violation.severity === 'blocker',
        )
        // Persist one row per instance (audit evidence); the *view* below rolls
        // them up by code so a chapter reads as one line per problem class.
        const advisoryRows = scopedMachine.violations.filter((violation) => violation.severity === 'advisory')
        const machineAdvisories = dedupeAdvisories(advisoryRows)
        const advisoryCodes = [...new Set(machineAdvisories.map((violation) => violation.code))]
        // A caller may acknowledge a whole code or one persisted instance id.
        const advisoryIds = advisoryRows.map((violation) => violation.id!).filter(Boolean)
        const requestedAck = Array.isArray(input.acknowledge) ? input.acknowledge : []
        const reasons = input.acknowledge_reasons ?? {}
        const unknownAck = requestedAck.filter(
          (token) => !advisoryCodes.includes(token) && !advisoryIds.includes(token),
        )
        if (unknownAck.length > 0) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `cannot acknowledge non-advisory finding(s): ${unknownAck.join(', ')}`,
            `advisory ids: ${advisoryIds.join(', ') || 'none'}; blockers and unknown codes cannot be acknowledged`,
          )
        }
        for (const token of requestedAck) {
          if (typeof reasons[token] !== 'string' || reasons[token]!.trim() === '') {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `acknowledging ${token} requires acknowledge_reasons["${token}"]`,
              'advisory acknowledgement is an authored decision; say why it is accepted',
            )
          }
        }
        // A waiver granted with acknowledge_until_chapter is a decision about a
        // *problem class*, not about one chapter's instance id. Carry it forward
        // from the previous check until it expires, or the same advisory returns
        // every chapter and the author has to re-waive it forever (M8).
        const carried = await this.carriedAcknowledgements(snapshot, input.chapter)
        const priorAck =
          snapshot.check !== null && snapshot.check.content_hash === sha256(text)
            ? (snapshot.check.acknowledged ?? [])
            : []
        const priorFindings = [
          ...(snapshot.check !== null && snapshot.check.content_hash === sha256(text)
            ? (snapshot.check.machine.acknowledged_findings ?? snapshot.check.acknowledged_findings ?? [])
            : []),
          ...carried,
        ]
        const acknowledgedFindings = [
          ...priorFindings,
          ...requestedAck.map((token) => {
            const finding = advisoryRows.find(
              (violation) => violation.id === token || violation.code === token,
            )!
            return {
              id: finding.id!,
              code: finding.code,
              reason: reasons[token]!.trim(),
              at: this.now().toISOString(),
              ...(input.acknowledge_until_chapter === undefined
                ? {}
                : { expires_at_chapter: input.acknowledge_until_chapter }),
            }
          }),
        ].filter((finding, index, all) => all.findIndex((candidate) => candidate.id === finding.id) === index)
        const acknowledgedFindingIds = new Set(acknowledgedFindings.map((finding) => finding.id))
        const carriedCodes = new Set(
          carried
            .filter((finding) => (finding.expires_at_chapter ?? 0) >= input.chapter)
            .map((finding) => finding.code),
        )
        const fullyAcknowledgedCodes = advisoryCodes.filter((code) => {
          if (carriedCodes.has(code)) return true
          const findings = machineAdvisories.filter((violation) => violation.code === code)
          return (
            findings.length > 0 &&
            findings.every(
              (violation) => violation.id !== undefined && acknowledgedFindingIds.has(violation.id),
            )
          )
        })
        const acknowledged = [
          ...new Set([
            ...priorAck,
            ...requestedAck.filter((token) => advisoryCodes.includes(token)),
            ...fullyAcknowledgedCodes,
          ]),
        ]
        const semanticResult = semanticEvaluation
        const verdict: 'pass' | 'fail' =
          machineBlocking.length === 0 && !semanticResult.content_failed ? 'pass' : 'fail'
        const check: CheckDocument = {
          schema_version: 1,
          chapter: input.chapter,
          scope,
          content_hash: sha256(text),
          machine: {
            violations: machineBlocking,
            advisories: advisoryRows,
            metrics: scopedMachine.metrics,
            ...(scopedMachine.dialogue === undefined ? {} : { dialogue: scopedMachine.dialogue }),
            // 0.2.17: keep the measurements behind any STYLE_* row in the record.
            ...(scopedMachine.style === undefined ? {} : { style: scopedMachine.style }),
            numeric: scopedMachine.numeric,
            ...(acknowledgedFindings.length === 0 ? {} : { acknowledged_findings: acknowledgedFindings }),
          },
          semantic: {
            items: semantic,
            ...(semanticResult.findings.length === 0 ? {} : { findings: semanticResult.findings }),
          },
          ...(acknowledged.length === 0 ? {} : { acknowledged }),
          ...(verdict === 'fail' ? { failure_class: 'content' as const, counted: true as const } : {}),
          verdict,
        }
        try {
          narrow('check', check)
        } catch (error) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `novel_check would write an invalid check document: ${
              error instanceof Error ? error.message : String(error)
            }`,
            'each semantic item needs id, verdict and a string evidence quote; nothing was written',
          )
        }
        // A pass over only one scope is not an archive pass. Advancing to
        // ready_to_archive here made status point at archive even though PG-04
        // or PG-10 never ran, producing a permanent archive/check loop.
        const fullScope = scope.includes('content') && scope.includes('integrity')
        const nextStage: Stage =
          verdict === 'pass'
            ? computeNextStage(snapshot.pipeline.stage, 'runCheck', 0, { completeCheck: fullScope })
            : 'P6'
        const blockingItems: BlockingItem[] =
          verdict === 'fail'
            ? [
                ...machineBlocking.map((violation) => ({
                  code: violation.code,
                  scope: 'check',
                  detail: violation.detail,
                })),
                ...semanticResult.findings,
              ]
            : []
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          stage: nextStage,
          // A partial pass is informational and stays at P6; it must not burn
          // the check retry budget before the required full-scope run.
          rounds: {
            ...snapshot.pipeline.rounds,
            check: snapshot.pipeline.rounds.check + (verdict === 'fail' ? 1 : 0),
            // A content-only pass is still one attempt at P6 (0.2.17): without
            // this counter a model could loop partial checks and PG-11 would
            // never stop it.
            partial_checks: (snapshot.pipeline.rounds.partial_checks ?? 0) + (verdict === 'fail' ? 0 : 1),
          },
          blocking: blockingItems,
          last_action: action('novel_check', this.now(), sha256(text)),
        })
        // A failed check changes the check document, rounds, and blocking, so
        // the P6 brief that was issued before the check is now stale. Do not
        // re-stamp it: nextStep will require a fresh P6 brief, and the model
        // must actually receive the updated context before revising.
        return {
          files: [
            ...(snapshot.check === null
              ? []
              : [
                  {
                    path: checkHistoryFile(input.chapter, snapshot.pipeline.revision),
                    text: yaml(snapshot.check),
                  },
                ]),
            { path: checkFile(input.chapter), text: yaml(check) },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
          backup: snapshot.check !== null,
          data: {
            chapter: input.chapter,
            verdict,
            violations: machineBlocking.length,
            advisories: machineAdvisories.filter(
              (violation) =>
                !advisoryAcknowledged(violation, acknowledged, acknowledgedFindings, input.chapter),
            ).length,
            advisory_instances: machineAdvisories.flatMap((violation) =>
              (violation.instances ?? []).filter(
                (instance) =>
                  !advisoryAcknowledged(
                    { ...violation, id: instance.id, instances: undefined },
                    acknowledged,
                    acknowledgedFindings,
                    input.chapter,
                  ),
              ),
            ),
            advisory_codes: advisoryCodes,
            acknowledged,
            acknowledged_findings: acknowledgedFindings,
            metrics: scopedMachine.metrics,
            ...(scopedMachine.dialogue === undefined ? {} : { dialogue: scopedMachine.dialogue }),
            // 0.2.17: keep the measurements behind any STYLE_* row in the record.
            ...(scopedMachine.style === undefined ? {} : { style: scopedMachine.style }),
            numeric: scopedMachine.numeric,
            stage: nextStage,
            semantic: { items: semanticResult.items, findings: semanticResult.findings },
            rounds: { check: nextPipeline.rounds.check },
            counted: verdict === 'fail',
          },
          warnings: [
            ...machineWarnings(
              { ...scopedMachine, violations: [...machineBlocking, ...machineAdvisories] },
              acknowledged,
              acknowledgedFindings,
              input.chapter,
            ),
            ...(acknowledged.length === 0
              ? []
              : [
                  {
                    code: 'CHECK_ADVISORY_ACKNOWLEDGED',
                    message: `已记录知悉：${acknowledged.join(', ')}；advisory 不阻塞归档`,
                  },
                ]),
            ...(verdict === 'pass' && !fullScope
              ? [
                  {
                    code: 'CHECK_SCOPE_PARTIAL',
                    message: `scope ${scope.join('+')} passed, but archive requires content+integrity; the pipeline stays at P6`,
                  },
                ]
              : []),
          ],
        }
      },
    })
  }

  /* ---------------------------------------------------------------- archive */

  async archiveChapter(input: ArchiveSubmission): Promise<
    OpResult<{
      chapter: number
      assigned_ids: Record<string, string>
      metrics: WordMetrics
      score: number
      delta_warnings?: Warning[]
      normalized_world?: Record<
        string,
        {
          from: 'created' | 'updated' | 'no_change'
          to: 'created' | 'updated' | 'no_change'
          reason:
            'existing-created-as-updated' | 'missing-updated-as-created' | 'missing-no-change-as-created'
        }
      >
    }>
  > {
    const handoffOverride = normalizeHandoffOverride(input.handoff)
    // v2 marks the locale-independent canonicalization. Legacy unprefixed
    // digests are accepted only through the explicit compatibility comparison
    // below, so a new archive can never silently adopt an old different delta.
    const archiveDigest = `v2:${sha256(
      stableJson({ chapter: input.chapter, state_delta: input.state_delta, handoff: handoffOverride }),
    )}`
    return this.mutate({
      root: input.root,
      op: 'archiveChapter',
      chapter: input.chapter,
      key: (snapshot) => {
        // After the first archive the chapter file is indexed and the active
        // manuscript is gone. Bind the replay key to the indexed content hash so
        // a duplicate call is idempotent instead of a stage-order failure.
        const archived = snapshot.chapters.chapters.find((record) => record.num === input.chapter)
        return `archive:${input.chapter}:${archived?.content_hash ?? sha256(snapshot.text ?? '')}:${archiveDigest}`
      },
      run: async (snapshot, context) => {
        const already = snapshot.chapters.chapters.find((record) => record.num === input.chapter)
        if (already !== undefined) {
          // A record without archive_digest is not proof that the archive
          // transaction ran. Treating it as an idempotent replay would let a
          // hand-written chapters.yaml bypass every gate and ledger write.
          if (already.archive_digest === undefined) {
            throw new EngineFaultError(
              ERROR_CODES.SCHEMA_INVALID,
              `chapter ${input.chapter} has no archive_digest; the index entry is not trustworthy`,
              'restore the chapter index from backups/ or re-archive from the original manuscript',
            )
          }
          if (
            already.archive_digest !== archiveDigest &&
            already.archive_digest !== legacyArchiveDigest(input)
          ) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `chapter ${input.chapter} is already archived with a different state_delta`,
              'archive is idempotent by chapter; start the next chapter instead of replaying old data',
            )
          }
          const archivedText = await this.readChapter(snapshot, input.chapter)
          if (archivedText === null || sha256(archivedText) !== already.content_hash) {
            throw new EngineFaultError(
              ERROR_CODES.TXN_ABORTED,
              `archived chapter ${input.chapter} no longer matches its index`,
              'restore the chapter from backups/ before retrying',
            )
          }
          return {
            files: [],
            data: {
              chapter: input.chapter,
              assigned_ids: already.assigned_ids ?? {},
              metrics: countWordMetrics(archivedText),
              score: already.score,
              delta_warnings: [],
              normalized_world: {},
            },
            warnings: [],
            replay: true,
          }
        }
        this.assertChapter(snapshot, input.chapter)
        this.assertChapterWithinTarget(snapshot, input.chapter, 'novel_archive')
        const text = snapshot.text ?? ''
        const draft = snapshot.pipeline.draft
        const summary = draft?.summary ?? snapshot.plan?.summary
        if (summary === undefined) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            'the draft has no summary; resubmit the draft with a summary',
            'call novel_write_draft with the full summary block',
          )
        }
        if (snapshot.review !== null && snapshot.pipeline.review_digest === undefined) {
          throw new EngineFaultError(
            ERROR_CODES.SCHEMA_INVALID,
            'the stored review has no review_digest; it predates digest-bound reviews and cannot be archived blindly',
            're-run novel_review for this chapter, then re-run the archive',
          )
        }
        if (
          snapshot.review !== null &&
          snapshot.pipeline.review_digest !== undefined &&
          snapshot.pipeline.review_digest !== sha256(stableJson(snapshot.review))
        ) {
          throw new EngineFaultError(
            ERROR_CODES.SCHEMA_INVALID,
            'the stored review changed after submission; its digest no longer matches',
            're-run novel_review instead of editing reviews/ directly',
          )
        }
        await this.assertGates(snapshot, 'archiveChapter', {
          briefStage: 'P8',
          text,
          summary,
          review: snapshot.review,
          proof: snapshot.review?.proof ?? null,
        })
        if (draft !== undefined) {
          if (draft.chapter !== input.chapter) {
            throw new EngineFaultError(
              ERROR_CODES.SCHEMA_INVALID,
              `pipeline draft belongs to chapter ${draft.chapter}, but chapter ${input.chapter} is being archived`,
              're-open the intended chapter or resubmit the draft before archiving',
            )
          }
          if (draft.content_hash !== sha256(text)) {
            throw new EngineFaultError(
              ERROR_CODES.TXN_ABORTED,
              'the manuscript changed after its draft summary was written; the summary and title cannot be sealed against this text',
              'restore the manuscript to the draft version, or call novel_write_draft / novel_revise again before archiving',
            )
          }
        }
        if (text === '')
          throw new EngineInputError(ERROR_CODES.STAGE_ORDER, `chapter ${input.chapter} has no draft`)
        // The archive is the last line of defence: re-run the full machine pass
        // rather than trusting a check document that may have been edited
        // outside the engine.
        const archiveMachine = this.machine(snapshot, text, { summary })
        const archiveBlockers = archiveMachine.violations.filter(
          (violation) => violation.severity === 'blocker',
        )
        if (archiveBlockers.length > 0) {
          throw new EngineBlockedError(
            ERROR_CODES.GATE_BLOCKED,
            `archiveChapter blocked by ${archiveBlockers.length} machine finding(s), first: ${archiveBlockers[0]!.code}`,
            archiveBlockers.map((violation) => ({
              code: violation.code,
              scope: 'archive',
              detail: violation.detail,
            })),
            'fix the manuscript before archiving',
          )
        }
        // A check document is a plain YAML file once written. Re-validate the
        // semantic evidence here as well, so editing checks/*.yaml to a pass
        // cannot bypass the five P6 checks at the last write boundary.
        const archivedSemantic = evaluateSemantic(
          text,
          Array.isArray(snapshot.check?.semantic.items) ? snapshot.check.semantic.items : [],
        )
        if (archivedSemantic.failed) {
          throw new EngineBlockedError(
            ERROR_CODES.GATE_BLOCKED,
            `archiveChapter blocked by ${archivedSemantic.blocking.length} semantic finding(s), first: ${archivedSemantic.blocking[0]!.code}`,
            archivedSemantic.blocking.map((item) => ({ ...item, scope: 'archive' })),
            're-run novel_check with the five evidence-backed semantic items',
          )
        }
        const metrics = countWordMetrics(text)
        const score = snapshot.review?.total ?? 0
        const chapter = input.chapter
        const storedTitle = stripTitlePrefix(snapshot.pipeline.draft?.title ?? snapshot.plan?.title ?? '')
        const title = storedTitle === '' ? `第${chapter}章` : storedTitle
        const record: ChapterRecord = {
          num: chapter,
          title,
          file: chapterFile(chapter),
          word_count: metrics.total_word_count,
          cjk_words: metrics.cjk_chars,
          dialogue_lines: metrics.dialogue_lines,
          dialogue_ratio: metrics.dialogue_ratio,
          scene_type: snapshot.pipeline.draft?.scene_type ?? snapshot.plan?.scene_type ?? '日常过渡章',
          narrator: snapshot.pipeline.draft?.narrator ?? snapshot.plan?.narrator ?? '',
          score,
          status: 'reviewed',
          content_hash: sha256(text),
          summary,
        }

        const roleHints: Record<string, string> = {}
        for (const character of snapshot.worldbook.characters) {
          if (character.role !== '') roleHints[character.name] = character.role
        }
        for (const character of snapshot.worldPlan?.characters ?? []) {
          if (character.role !== '') roleHints[character.name] = character.role
        }
        const ledger = applyStateDelta({
          chapter,
          text,
          summary,
          delta: input.state_delta,
          characters: snapshot.characters,
          world: snapshot.world,
          locks: snapshot.locks,
          foreshadows: snapshot.foreshadows,
          timeline: snapshot.timeline,
          relationships: snapshot.relationships,
          narrator: snapshot.pipeline.draft?.narrator ?? snapshot.plan?.narrator ?? null,
          roleHints,
          allowNegativeBalances: snapshot.project.targets.allow_negative_balances === true,
          strict: snapshot.outline.book.strict,
        })
        // 0.2.13: RELATION_UNKNOWN has exactly one active owner. P6 cannot know
        // about a relation created by this chapter; run the same pure check only
        // after the delta has been merged, and report it as a warning.
        const relationFindings = relationUnknownFindings(text, ledger.characters, ledger.relationships)
        if (relationFindings.length > 0) {
          ledger.warnings.push(
            ...relationFindings.map((finding) => ({
              code: finding.code,
              message: finding.detail,
            })),
          )
        }
        record.assigned_ids = ledger.assigned
        record.archive_digest = archiveDigest
        const archivedAt = this.now().toISOString()
        record.rounds = await this.lifetimeRounds(snapshot, chapter)
        record.final_check = snapshot.check?.verdict ?? 'fail'
        record.archived_at = archivedAt
        const outline = markOutlineArchived(
          snapshot.outline,
          record,
          archivedAt,
          snapshot.project.targets.words_per_chapter,
        )
        this.assertOutlineWritable(snapshot, outline, 'novel_archive')
        const archivedCard = outline.chapters.find((card) => card.num === chapter)
        if (archivedCard === undefined) {
          throw new EngineFaultError(
            ERROR_CODES.TXN_ABORTED,
            `archive did not produce an outline card for chapter ${chapter}`,
            'restore the outline from backups/ and retry the archive',
          )
        }
        record.archive_card = archivedCardSnapshot(archivedCard)
        record.archive_card_digest = archivedCardDigest(record.archive_card)
        const foreshadows = ledger.foreshadows
        const timeline = ledger.timeline
        const foreshadowDormantAfter =
          this.rulepack.genres[snapshot.project.genre]?.profile?.foreshadow_dormant_after ??
          this.rulepack.crosschapter.foreshadow_dormant_after
        for (const item of foreshadows.items) {
          if (
            item.kind !== 'motif' &&
            item.status !== 'resolved' &&
            chapter - item.last_touched >= foreshadowDormantAfter
          ) {
            item.status = 'dormant'
          }
        }

        const chapters = structuredClone(snapshot.chapters)
        chapters.chapters.push(record)

        // Volume and volume_name are inherited author boundaries; act and
        // act_progress advance from the stored handoff so a 21st chapter keeps
        // the fourth act's rollover instead of restarting at the first act.
        const position = advanceHandoff(snapshot.handoff, chapter, handoffOverride)
        const handoff = {
          schema_version: 1 as const,
          current_chapter: chapter,
          volume: position.volume,
          volume_name: position.volume_name,
          act: position.act,
          act_progress: position.act_progress,
          next_chapter: chapter + 1,
          last_summary: summary.events.join('；').slice(0, 200),
          open_hooks: foreshadows.items
            .filter((item) => item.status !== 'resolved')
            .sort((left, right) => {
              const byAge = left.last_touched - right.last_touched
              if (byAge !== 0) return byAge
              const byId = compareText(left.id, right.id)
              return byId !== 0 ? byId : compareText(left.title, right.title)
            })
            .slice(0, 5)
            .map((item) => ({ id: item.id, title: item.title })),
          updated_at: this.now().toISOString(),
        }

        const nextPipeline = pipelineWith(snapshot, context.revision, {
          chapter: chapter + 1,
          stage: 'done',
          rounds: { review: 0, revise: 0, check: 0 },
          briefs: {},
          blocking: [],
          last_action: action('novel_archive', this.now(), sha256(text)),
        })
        delete nextPipeline.draft

        // The ledgers are assembled from model-supplied delta fields. Validate
        // the exact documents that will be staged; otherwise an accepted archive
        // can write a scalar of the wrong type and make every later load fail.
        assertArchiveDocuments([
          ['chapters', chapters],
          ['characters', ledger.characters],
          ['world', ledger.world],
          ['locks', ledger.locks],
          ['foreshadows', foreshadows],
          ['timeline', timeline],
          ['relationships', ledger.relationships],
          ['handoff', handoff],
        ])

        const archiveDigests = await this.readArchiveDigests(context.store, snapshot)
        archiveDigests[String(chapter)] = archiveDigest
        // Keep the P2 plan byte-for-byte in the archive transaction: it is the
        // evidence reopen must not silently replace with a later external edit.
        const planText = await context.store.readText(planChapterFile(chapter))
        if (planText === null) {
          throw new EngineFaultError(
            ERROR_CODES.SCHEMA_INVALID,
            `chapter ${chapter} has no stored plan; archiving would not be able to prove it later`,
            'restore the plan from backups/ before archiving',
          )
        }
        // Keep every receipt but bound the hot file: current + newest three per
        // stage stay in state/briefs.yaml, older rows move to a per-chapter
        // history file that the read model merges back.
        const compressed = await this.compressBriefReceipts(context.store, chapter)
        if (compressed.warning !== undefined) {
          ledger.warnings.push({ code: 'BRIEF_RECEIPT_COMPACTION_FAILED', message: compressed.warning })
        }
        const briefFiles = compressed.files
        const files: StagedFile[] = [
          // Re-staging the manuscript makes the archive backup a true snapshot of
          // the archived version; the body itself is unchanged by this transaction.
          { path: chapterFile(chapter), text },
          { path: planChapterFile(chapter), text: planText },
          { path: joinRel(STATE_DIR, STATE_FILES.chapters), text: yaml(chapters) },
          { path: joinRel(STATE_DIR, STATE_FILES.foreshadows), text: yaml(foreshadows) },
          { path: joinRel(STATE_DIR, STATE_FILES.timeline), text: yaml(timeline) },
          { path: joinRel(STATE_DIR, STATE_FILES.handoff), text: yaml(handoff) },
          { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          { path: joinRel(STATE_DIR, STATE_FILES.characters), text: yaml(ledger.characters) },
          { path: joinRel(STATE_DIR, STATE_FILES.world), text: yaml(ledger.world) },
          { path: joinRel(STATE_DIR, STATE_FILES.locks), text: yaml(ledger.locks) },
          { path: joinRel(STATE_DIR, STATE_FILES.relationships), text: yaml(ledger.relationships) },
          { path: OUTLINE_FILE, text: yaml(outline) },
          { path: ARCHIVE_DIGESTS, text: `${JSON.stringify(archiveDigests, null, 2)}\n` },
          ...briefFiles,
        ]
        return {
          files,
          backup: true,
          data: {
            chapter,
            assigned_ids: ledger.assigned,
            metrics,
            score,
            delta_warnings: ledger.warnings,
            normalized_world: ledger.normalized_world,
          },
          warnings: ledger.warnings,
          event: {
            name: 'novel/archived',
            payload: {
              schemaVersion: 1,
              projectRoot: snapshot.root,
              chapter,
              score,
              words: metrics.total_word_count,
            },
          },
        }
      },
    })
  }

  /* ------------------------------------------------------------ maintenance */

  async amend(input: AmendSubmission): Promise<
    OpResult<{
      path: string
      revision: number
      before: Record<string, unknown> | null
      after: Record<string, unknown>
      changes: Array<{ path: string; before: unknown; after: unknown }>
    }>
  > {
    if (typeof input.path !== 'string' || input.path.trim() === '') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'amend path must be a non-empty string')
    }
    if (typeof input.reason !== 'string' || input.reason.trim() === '') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'amend requires a reason')
    }
    const hasContent = input.content !== undefined
    const hasPatch = input.patch !== undefined
    if (hasContent && hasPatch) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'amend accepts either content or patch, not both',
        'use patch for a local edit and content for a whole-document repair',
      )
    }
    if (!hasContent && !hasPatch) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'amend requires content or patch',
        'send patch:[{op,path,value}] for one field, or content for the whole document',
      )
    }
    if (
      hasContent &&
      (typeof input.content !== 'object' || input.content === null || Array.isArray(input.content))
    ) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'amend content must be an object')
    }
    if (hasPatch && (!Array.isArray(input.patch) || input.patch.length === 0)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'amend patch must be a non-empty array')
    }
    const selection = await this.resolveRoot(input.root)
    const resolvedRoot = selection.root
    const store = this.storeFor(resolvedRoot)
    const absolute = store.path(input.path)
    const kind = Object.hasOwn(MUTABLE_STATE, input.path) ? MUTABLE_STATE[input.path] : undefined
    if (kind === undefined || absolute.length === 0) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `amend can only target state documents: ${Object.keys(MUTABLE_STATE).join(', ')}`,
        'edit novel content through the draft/revision tools, not amend',
      )
    }
    // Repairing one damaged ledger must not be blocked by a second damaged
    // ledger: every currently unreadable state document is an allowed journal
    // mismatch, while a valid-but-edited document still fails closed.
    // 0.2.17: chapters.yaml is archive evidence, but it must stay amendable —
    // removing it from the repair window made a hand-damaged index unrecoverable
    // (there was no restore path either). Instead `amendProblems` refuses to
    // drop archived rows, refuses a row count below the archived manuscripts,
    // and pins every immutable field; `novel_restore` can also bring back its
    // pre-image now that the chapter index is a restorable ledger.
    const repairPaths: string[] = []
    for (const [path, docKind] of Object.entries(MUTABLE_STATE)) {
      if (docKind === 'pipeline') continue
      // The chapter index stays in the tolerated set so repairing another
      // damaged ledger is still possible; it can never be the amend TARGET
      // while unreadable — the explicit check above refuses that, because a
      // damaged index must not be rewritten in place.
      if (await this.stateDocIsUnreadable(store, path, docKind)) repairPaths.push(path)
    }
    return this.mutate({
      // Preserve the resolved source and identity. Re-resolving a plain root
      // here would turn a session-bound path into an explicit switch and skip
      // the created_at check, which is exactly the cross-book write 0.2.2 must
      // prevent.
      selection,
      op: 'amend',
      reason: input.reason,
      ...(repairPaths.length === 0 ? {} : { repairPaths }),
      // An amend is a repair: a second call at the same revision must still
      // apply the requested document, not replay the previous repair.
      run: async (snapshot, context) => {
        if (input.reason.trim() === '') {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            'amend requires a reason',
            'state the intent so the journal explains the change',
          )
        }
        if (kind === 'pipeline') {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            'pipeline cannot be amended directly',
            'use novel_rollback or the stage operations',
          )
        }
        let projectBaseline = snapshot.project
        let projectDamaged = snapshot.projectError !== null
        if (kind === 'project' && snapshot.projectError !== null) {
          const backup = await this.latestBackup(context.store, PROJECT_FILE)
          if (backup !== null) {
            try {
              projectBaseline = narrow('project', parseYaml(backup)) as unknown as NovelProject
              projectDamaged = false
            } catch {
              // A damaged backup cannot weaken the structural checks.
            }
          }
        }
        let amendmentContent: Record<string, unknown>
        if (input.patch === undefined) {
          amendmentContent = { ...(input.content ?? {}) }
        } else {
          const base = await this.readAmendBase(context.store, input.path, kind)
          const patched = applyAmendPatch(base, input.patch)
          // A project patch must only name the fields it changed; otherwise the
          // immutable-field guard sees the whole document and rejects every
          // patch as "genre is immutable" (R1).
          amendmentContent = kind === 'project' ? projectPatchDelta(base, patched) : patched
        }
        // `page` is a read-model wrapper added by novel_state, never a persisted
        // document field. A complete query payload can be amended, but a
        // truncated or history-stripped page must never silently delete rows.
        const suppliedPage = recordOf(amendmentContent.page)
        if (suppliedPage !== null) {
          const filters = recordOf(suppliedPage.filters)
          const incomplete =
            suppliedPage.has_more === true ||
            typeof suppliedPage.total !== 'number' ||
            typeof suppliedPage.returned !== 'number' ||
            suppliedPage.total !== suppliedPage.returned ||
            filters?.include_history === false ||
            filters?.include_summary === false ||
            filters?.current_only === true ||
            filters?.status !== undefined ||
            filters?.chapter_range !== undefined ||
            filters?.chapter !== undefined
          if (incomplete) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              'novel_amend received a truncated novel_state page',
              'fetch every cursor page and merge the section rows (or request a complete single page when total <= 200), then amend the merged document; a page is read-only and removing page does not make it complete',
            )
          }
        }
        delete amendmentContent.page
        let document = (
          kind === 'project'
            ? snapshot.projectError !== null
              ? narrow('project', {
                  ...amendmentContent,
                  schema_version: amendmentContent.schema_version ?? 1,
                })
              : mergeProjectAmendment(amendmentContent, snapshot.project)
            : narrow(kind, { ...amendmentContent, schema_version: amendmentContent.schema_version ?? 1 })
        ) as Record<string, unknown>
        if (kind === 'outline') {
          try {
            document = validateOutlineDocument(document, {
              titleRule: this.rulepack.format.title,
              totalChapters: snapshot.project.targets.total_chapters,
            }) as unknown as Record<string, unknown>
          } catch (error) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `amend would write an invalid outline: ${errorMessage(error)}`,
              error instanceof EngineError
                ? error.hint
                : `repair ${OUTLINE_FILE} with a complete valid document`,
            )
          }
        }
        if (kind === 'worldbook') {
          try {
            document = validateWorldbookDocument(document, this.now().toISOString()) as unknown as Record<
              string,
              unknown
            >
          } catch (error) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `amend would write an invalid worldbook: ${errorMessage(error)}`,
              error instanceof EngineError
                ? error.hint
                : `repair ${WORLDBOOK_FILE} with a complete valid document`,
            )
          }
        }
        let oldDocument = (snapshot as unknown as Record<string, unknown>)[kind]
        // A damaged file has no trustworthy in-memory shape. Recover the last
        // committed backup so "no archived chapter may disappear" still has
        // something to compare against; without this, repairing a corrupt index
        // would trivially pass the monotonicity check.
        if (kind === 'project') {
          oldDocument = projectBaseline
        } else if (kind === 'outline' && (snapshot.outlineError !== null || !snapshot.outlinePresent)) {
          const backup = await this.latestBackup(context.store, input.path)
          if (backup !== null) {
            try {
              oldDocument = validateOutlineDocument(narrow('outline', parseYaml(backup)), {
                titleRule: this.rulepack.format.title,
                totalChapters: snapshot.project.targets.total_chapters,
              })
            } catch {
              // A damaged backup cannot weaken the archived-card guard; the
              // chapter index still supplies every archived record below.
            }
          }
        } else if (snapshot.ledgerErrors.some((error) => error.path === input.path)) {
          const backup = await this.latestBackup(context.store, input.path)
          if (backup !== null) {
            try {
              oldDocument = narrow(kind, parseYaml(backup))
            } catch {
              // A damaged backup cannot weaken the structural checks; keep the
              // empty fallback and let the new document be validated on its own.
            }
          }
        }
        // The archive record is the primary evidence for an archived card.
        // Unlike the old reconstruction, this never derives the "before" image
        // from the candidate: a forged card can therefore only be rejected.
        if (kind === 'outline') {
          const old = recordOf(oldDocument)
          const oldChapters = Array.isArray(old?.chapters) ? [...old.chapters] : []
          const indexOf = new Map<number, number>()
          for (const [index, raw] of oldChapters.entries()) {
            const row = recordOf(raw)
            if (row !== null && Number.isInteger(row.num)) indexOf.set(row.num as number, index)
          }
          for (const record of snapshot.chapters.chapters) {
            if (record.archive_card === undefined) continue
            if (
              record.archive_card_digest === undefined ||
              record.archive_card_digest !== archivedCardDigest(record.archive_card)
            ) {
              throw new EngineFaultError(
                ERROR_CODES.SCHEMA_INVALID,
                `archived chapter ${record.num} has an archive_card whose digest does not match`,
                'restore state/chapters.yaml from backups/ or repair the card evidence manually',
              )
            }
            const archiveCardRow = archivedCardRecord(record)
            const index = indexOf.get(record.num)
            if (index === undefined) oldChapters.push(archiveCardRow)
            else oldChapters[index] = { ...(recordOf(oldChapters[index]) ?? {}), ...archiveCardRow }
          }
          oldDocument = { ...(old ?? {}), chapters: oldChapters }
        }
        const archivedChapterNumbers = (await context.store.list(CHAPTERS_DIR))
          .map((name) => /^chapter-(\d+)\.md$/.exec(name))
          .filter((match): match is RegExpExecArray => match !== null)
          .map((match) => Number(match[1]))
          // The active chapter may already have a manuscript file; it is not
          // an archived row and must not make a repair demand a row before the
          // chapter is indexed.
          .filter((num) => num !== snapshot.pipeline.chapter)
        const archivedFiles =
          kind === 'chapters' || kind === 'project' || kind === 'outline' ? archivedChapterNumbers.length : 0
        let archiveDigests: Record<string, string> = {}
        if (kind === 'chapters') {
          archiveDigests = await this.readArchiveDigests(context.store, snapshot)
          // When the chapters index itself is the document being repaired,
          // snapshot.chapters is the empty fallback. The previous image is the
          // only trustworthy source for the digests that must stay immutable.
          const oldRows = recordOf(oldDocument)?.chapters
          if (Array.isArray(oldRows)) {
            for (const raw of oldRows) {
              const row = recordOf(raw)
              if (row === null || !Number.isInteger(row.num) || typeof row.archive_digest !== 'string') {
                continue
              }
              archiveDigests[String(row.num)] = row.archive_digest
            }
          }
        }
        const problems = amendProblems(
          kind,
          oldDocument,
          document,
          snapshot,
          input.path,
          archivedFiles,
          projectBaseline,
          projectDamaged,
          archiveDigests,
          archivedChapterNumbers,
          input.allow_delete === true,
        )
        // Server-side truncation guard: a caller that drops the `page` wrapper
        // must not be able to delete rows silently. Compare the submitted row
        // set with the document the snapshot actually holds.
        if (!input.allow_delete && oldDocument !== undefined && oldDocument !== null) {
          const missing = missingLedgerRows(kind, oldDocument, document)
          if (missing.length > 0) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              `amend would delete ${missing.length} existing row(s) from ${input.path}: ${missing
                .slice(0, 5)
                .join(', ')}`,
              'a truncated novel_state page is not a complete document; fetch every cursor page, or set allow_delete:true for an intentional deletion',
              {
                details: {
                  field: input.path,
                  expected: 'every existing row, or allow_delete:true',
                  received: { missing: missing.slice(0, 20), missing_count: missing.length },
                  allowed: ['merge every cursor page', 'allow_delete:true'],
                },
              },
            )
          }
        }
        if (kind === 'chapters') {
          for (const raw of Array.isArray(document.chapters) ? document.chapters : []) {
            const row = recordOf(raw)
            if (row === null || typeof row.file !== 'string' || typeof row.content_hash !== 'string') continue
            const text = await context.store.readText(row.file)
            if (text === null) {
              problems.push(`archived chapter ${String(row.num)} has no manuscript at ${row.file}`)
            } else if (sha256(text) !== row.content_hash) {
              problems.push(`archived chapter ${String(row.num)} content_hash does not match ${row.file}`)
            }
          }
        }
        if (kind === 'foreshadows') {
          // Amend is also the explicit legacy-migration path, so an anchorless
          // old resolved row is allowed. A row that carries an anchor, however,
          // must not be able to claim manuscript evidence that is not in the
          // chapter. Existing resolved rows with the same anchor are not
          // re-read (they may predate the current manuscript history).
          const oldRows = new Map<string, Record<string, unknown>>()
          const oldForeshadowDoc = recordOf(oldDocument)
          for (const raw of Array.isArray(oldForeshadowDoc?.items) ? oldForeshadowDoc.items : []) {
            const row = recordOf(raw)
            if (row !== null && typeof row.id === 'string') oldRows.set(row.id, row)
          }
          const chapterText = new Map<number, string | null>()
          for (const raw of Array.isArray(document.items) ? document.items : []) {
            const row = recordOf(raw)
            if (row === null || row.status !== 'resolved') continue
            const previous = typeof row.id === 'string' ? oldRows.get(row.id) : undefined
            if (typeof row.resolved_anchor !== 'string' || row.resolved_anchor.trim() === '') {
              // A row that is already resolved may predate the anchor rule. Any
              // new resolve — including a brand-new id — must carry evidence.
              if (previous === undefined || previous.status !== 'resolved') {
                problems.push(
                  `resolved foreshadow ${String(row.id)} requires resolved_anchor; a status change is not evidence`,
                )
              }
              continue
            }
            if (
              previous !== undefined &&
              previous.status === 'resolved' &&
              previous.resolved_anchor === row.resolved_anchor
            ) {
              continue
            }
            const resolvedAt =
              typeof row.resolved_at === 'number' && Number.isInteger(row.resolved_at)
                ? row.resolved_at
                : null
            const lastTouched =
              typeof row.last_touched === 'number' && Number.isInteger(row.last_touched)
                ? row.last_touched
                : null
            const chapter = resolvedAt ?? lastTouched
            if (chapter === null || chapter < 1) continue
            let text = chapterText.get(chapter)
            if (text === undefined) {
              text = await this.readChapter(snapshot, chapter)
              chapterText.set(chapter, text)
            }
            if (text === null) {
              problems.push(
                `cannot verify resolved_anchor for ${String(row.id)}: chapter ${chapter} has no manuscript`,
              )
            } else if (!text.includes(row.resolved_anchor)) {
              problems.push(
                `resolved_anchor for ${String(row.id)} does not appear verbatim in chapter ${chapter}`,
              )
            }
          }
        }
        if (problems.length > 0) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `amend would break a state invariant: ${problems.join('; ')}`,
            'keep archived chapters, entity references and next_seq monotonic; nothing was written',
          )
        }
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          last_action: action('novel_amend', this.now(), shortDigest(input.reason)),
        })
        return {
          files: [
            { path: input.path, text: yaml(document) },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
          backup: true,
          data: {
            path: input.path,
            revision: context.revision,
            before: oldDocument === undefined ? null : (oldDocument as Record<string, unknown>),
            after: document,
            changes:
              input.patch === undefined
                ? documentChanges(
                    oldDocument === undefined ? null : (oldDocument as Record<string, unknown>),
                    document,
                  )
                : patchChanges(
                    oldDocument === undefined ? null : (oldDocument as Record<string, unknown>),
                    document,
                    input.patch,
                  ),
          },
          event: {
            name: 'novel/amended',
            payload: { schemaVersion: 1, projectRoot: snapshot.root, path: input.path, reason: input.reason },
          },
        }
      },
    })
  }

  async rollback(input: RollbackSubmission): Promise<OpResult<{ chapter: number; stage: Stage }>> {
    return this.mutate({
      root: input.root,
      op: 'rollback',
      chapter: input.chapter,
      reason: input.reason,
      key: (snapshot) => `rollback:${input.chapter}:${input.toStage}:${sha256(snapshot.text ?? '')}`,
      run: async (snapshot, context) => {
        this.assertChapter(snapshot, input.chapter)
        if (!Object.prototype.hasOwnProperty.call(ROUND_TRANSITIONS, input.toStage)) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `unknown rollback target "${String(input.toStage)}"`,
            `allowed targets: ${Object.keys(ROUND_TRANSITIONS).join(', ')}`,
          )
        }
        const stage = ROUND_TRANSITIONS[input.toStage]
        if (STAGE_RANK[stage] > STAGE_RANK[snapshot.pipeline.stage]) {
          throw new EngineInputError(
            ERROR_CODES.STAGE_ORDER,
            `cannot roll back from ${snapshot.pipeline.stage} to later stage ${stage}`,
            'rollback only moves to the current stage or an earlier one; use the normal stage tools to advance',
          )
        }
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          chapter: input.chapter,
          stage,
          rounds: { review: 0, revise: 0, check: 0 },
          briefs: {},
          blocking: [],
          last_action: action('novel_rollback', this.now(), shortDigest(input.reason ?? '')),
        })
        delete nextPipeline.draft
        // P3-P6 still operate on the same manuscript; keep its summary/title
        // so P6 can run after a check reset. Only an early-stage reset discards
        // the draft metadata.
        if (stage !== 'idle' && stage !== 'P2' && snapshot.pipeline.draft !== undefined) {
          nextPipeline.draft = snapshot.pipeline.draft
        }
        const files: StagedFile[] = [
          { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
        ]
        const current = await context.store.readText(chapterFile(input.chapter))
        if (current !== null) {
          files.push({ path: chapterFile(input.chapter), text: current })
          files.push({ path: deprecatedChapterFile(input.chapter), text: current })
          files.push({
            path: chapterHistoryFile(input.chapter, snapshot.pipeline.revision),
            text: current,
          })
          files.push({
            path: deprecatedHistoryFile(input.chapter, snapshot.pipeline.revision),
            text: current,
          })
        }
        return {
          files,
          backup: true,
          data: { chapter: input.chapter, stage },
        }
      },
    })
  }

  async diff(input: DiffInput): Promise<OpResult<import('../types.js').DiffReport>> {
    if (input.chapter !== undefined) this.assertChapterParameter(input.chapter)
    if (input.before !== undefined && typeof input.before !== 'string') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'diff before must be a string')
    }
    if (input.after !== undefined && typeof input.after !== 'string') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'diff after must be a string')
    }
    if (input.before !== undefined && input.after !== undefined) {
      // Text-to-text diff is independent of a project by contract. Do not
      // resolve a project even when project_root is supplied: a pure utility
      // call must never bind a session or read an unrelated book. Callers that
      // need the active chapter can pass it explicitly.
      const chapter = input.chapter ?? 0
      const revision = 1
      const report = diffLines(input.before, input.after)
      return {
        data: {
          chapter,
          before: input.before,
          after: input.after,
          added: report.added,
          removed: report.removed,
          hunks: report.hunks,
        },
        revision,
        warnings: [],
      }
    }
    const snapshot = await this.load(input.root)
    const chapter = input.chapter ?? snapshot.pipeline.chapter
    if (input.chapter === undefined && input.before === undefined && input.after === undefined) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'diff requires a chapter or supplied before/after texts',
      )
    }
    const store = this.storeFor(snapshot.root)
    const after = input.after ?? (await this.readChapter(snapshot, chapter)) ?? ''
    const before =
      input.before ??
      (await this.latestBackup(store, chapterFile(chapter))) ??
      (await store.readText(deprecatedChapterFile(chapter))) ??
      ''
    const report = diffLines(before, after)
    return {
      data: {
        chapter,
        before,
        after,
        added: report.added,
        removed: report.removed,
        hunks: report.hunks,
      },
      revision: snapshot.pipeline.revision,
      warnings: [],
    }
  }

  async auditHistory(input: AuditInput = {}): Promise<OpResult<AuditRow[]>> {
    const snapshot = await this.load(input.root)
    const store = this.storeFor(snapshot.root)
    const { rows, malformed, records } = await readJournal(store)
    let health = (await this.lockIsLive(store))
      ? { mismatches: [] as Array<{ path: string; expected: string | null; actual: string | null }> }
      : await reconcileJournal(store)
    if (health.mismatches.length > 0 && (await this.lockIsLive(store))) {
      // A writer started during the multi-file reconciliation; its half-renamed
      // paths are not evidence of external tampering.
      health = { mismatches: [] }
    }
    const warnings: Warning[] = []
    if ((await store.exists(PROJECT_FILE)) && !hasCommittedJournal(records)) {
      warnings.push({
        code: 'JOURNAL_MISSING',
        message:
          'state/journal.jsonl has no committed project transaction; audit history and crash recovery are unavailable',
      })
    }
    if (malformed > 0)
      warnings.push({ code: 'JOURNAL_MALFORMED', message: `${malformed} malformed journal line(s)` })
    if (health.mismatches.length > 0) {
      warnings.push({
        code: 'JOURNAL_HASH_MISMATCH',
        message: `${health.mismatches.length} file(s) changed after the last commit; first: ${health.mismatches[0]!.path}`,
      })
    }
    const pending = await inspectPending(store)
    if (pending.state === 'partial') {
      warnings.push({
        code: ERROR_CODES.PENDING_PARTIAL,
        message: `pending transaction ${pending.txid ?? 'unknown'} is partial: ${pending.detail ?? 'mixed hashes'}; do not restore the whole project`,
      })
    } else if (pending.state === 'complete' || pending.state === 'untouched') {
      warnings.push({
        code: pending.state === 'complete' ? 'PENDING_RECOVERABLE' : 'PENDING_ABORTABLE',
        message: `${pending.txid ?? 'unknown'}: ${pending.detail ?? pending.state}`,
      })
    }
    const requested = input.limit ?? 50
    // 0.2.17: the tool advertises 1..200 and the host result pruner cannot keep a
    // larger page self-consistent, so the engine enforces the same ceiling. The
    // DSH parameter schema has no `maximum` annotation, which is why this clamp
    // is the machine-readable half of the contract.
    const limit = Number.isFinite(requested)
      ? Math.max(0, Math.min(AUDIT_LIMIT_MAX, Math.floor(requested)))
      : 50
    if (input.chapter !== undefined) this.assertChapterParameter(input.chapter)
    if (input.cursor !== undefined && (!Number.isInteger(input.cursor) || input.cursor < 0)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'audit cursor must be a non-negative integer')
    }
    if (input.since !== undefined && Number.isNaN(Date.parse(input.since))) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'audit since must be an ISO timestamp')
    }
    if (input.until !== undefined && Number.isNaN(Date.parse(input.until))) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'audit until must be an ISO timestamp')
    }
    const filtered = rows.filter((row) => {
      if (input.chapter !== undefined && row.chapter !== input.chapter) return false
      if (input.op !== undefined && row.op !== input.op) return false
      if (input.status !== undefined && row.status !== input.status) return false
      if (input.since !== undefined && Date.parse(row.at) < Date.parse(input.since)) return false
      if (input.until !== undefined && Date.parse(row.at) > Date.parse(input.until)) return false
      if (input.cursor !== undefined && (row.seq ?? 0) <= input.cursor) return false
      return true
    })
    const data =
      limit === 0 ? [] : input.cursor === undefined ? filtered.slice(-limit) : filtered.slice(0, limit)
    return { data, revision: snapshot.pipeline.revision, warnings }
  }

  async export(input: ExportInput): Promise<OpResult<{ kind: ExportKind; files: string[] }>> {
    const exportKinds: readonly ExportKind[] = ['md', 'txt', 'epub', 'outline', 'worldbook', 'proposal']
    if (!exportKinds.includes(input.kind)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `unknown export kind "${String(input.kind)}"`,
        `allowed: ${exportKinds.join(', ')}`,
      )
    }
    if (
      (input.kind === 'outline' || input.kind === 'worldbook' || input.kind === 'proposal') &&
      input.chapter !== undefined
    ) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `${input.kind} exports the whole book; do not pass chapter`,
      )
    }
    if (input.chapter !== undefined && (!Number.isInteger(input.chapter) || input.chapter < 1)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'chapter must be a positive integer')
    }
    if (input.kind === 'outline' || input.kind === 'worldbook' || input.kind === 'proposal') {
      const current = await this.load(input.root)
      this.assertExportIndexReadable(current, input.kind)
      if ((input.kind === 'outline' || input.kind === 'proposal') && current.outlineError !== null) {
        throw new EngineFaultError(
          ERROR_CODES.SCHEMA_INVALID,
          `${OUTLINE_FILE} is unreadable; refusing to export an empty outline`,
          `repair ${OUTLINE_FILE} with novel_amend before exporting`,
        )
      }
      if ((input.kind === 'worldbook' || input.kind === 'proposal') && current.worldbookError !== null) {
        throw new EngineFaultError(
          ERROR_CODES.SCHEMA_INVALID,
          `${WORLDBOOK_FILE} is unreadable; refusing to export an empty worldbook`,
          `repair ${WORLDBOOK_FILE} with novel_amend before exporting`,
        )
      }
    } else {
      const current = await this.load(input.root)
      this.assertExportIndexReadable(current, input.kind)
    }
    const artifactSnapshot = await this.load(input.root)
    const artifactStore = this.storeFor(artifactSnapshot.root)
    const suffix = input.chapter === undefined ? '' : `-ch${String(input.chapter).padStart(3, '0')}`
    const expectedArtifacts =
      input.kind === 'outline'
        ? [joinRel(EXPORT_DIR, 'outline.md')]
        : input.kind === 'worldbook'
          ? [joinRel(EXPORT_DIR, 'worldbook.md')]
          : input.kind === 'proposal'
            ? [joinRel(EXPORT_DIR, 'proposal.md')]
            : [
                joinRel(EXPORT_DIR, `book${suffix}.${input.kind}`),
                joinRel(EXPORT_DIR, 'cover.svg'),
                joinRel(EXPORT_DIR, 'blurb.txt'),
              ]
    const artifactsPresent = (
      await Promise.all(expectedArtifacts.map((path) => artifactStore.exists(path)))
    ).every(Boolean)
    const artifactKey = `${artifactSnapshot.root}|${input.kind}|${input.chapter ?? 'all'}`
    if (!artifactsPresent) {
      this.exportArtifactEpoch.set(artifactKey, (this.exportArtifactEpoch.get(artifactKey) ?? 0) + 1)
    }
    const artifactEpoch = this.exportArtifactEpoch.get(artifactKey) ?? 0
    return this.mutate<{ kind: ExportKind; files: string[] }>({
      root: input.root,
      op: 'export',
      key: (snapshot) =>
        `export:${input.kind}:${input.chapter ?? 'all'}:${artifactEpoch}:${sha256(
          stableJson({
            chapter: snapshot.pipeline.chapter,
            text: sha256(snapshot.text ?? ''),
            plan_title: stripTitlePrefix(snapshot.plan?.title ?? ''),
            project: sha256(stableJson(snapshot.project)),
            outline: sha256(stableJson(snapshot.outline)),
            worldbook: sha256(stableJson(snapshot.worldbook)),
            chapters: snapshot.chapters.chapters.map((chapter) => ({
              content_hash: chapter.content_hash,
              title: chapter.title,
              summary: sha256(stableJson(chapter.summary)),
            })),
            title: snapshot.project.title,
          }),
        )}`,
      run: async (snapshot, context) => {
        if ((input.kind === 'outline' || input.kind === 'proposal') && snapshot.outlineError !== null) {
          throw new EngineFaultError(
            ERROR_CODES.SCHEMA_INVALID,
            `${OUTLINE_FILE} is unreadable; refusing to export an empty outline`,
            `repair ${OUTLINE_FILE} with novel_amend before exporting`,
          )
        }
        if ((input.kind === 'worldbook' || input.kind === 'proposal') && snapshot.worldbookError !== null) {
          throw new EngineFaultError(
            ERROR_CODES.SCHEMA_INVALID,
            `${WORLDBOOK_FILE} is unreadable; refusing to export an empty worldbook`,
            `repair ${WORLDBOOK_FILE} with novel_amend before exporting`,
          )
        }
        this.assertExportIndexReadable(snapshot, input.kind)
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          last_action: action('novel_export', this.now(), input.kind),
        })
        if (input.kind === 'outline') {
          const files: StagedFile[] = [
            {
              path: joinRel(EXPORT_DIR, 'outline.md'),
              text: renderOutlineMarkdown(snapshot.project, snapshot.outline, snapshot.chapters.chapters),
            },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ]
          return {
            files,
            backup: false,
            data: { kind: input.kind, files: [files[0]!.path] },
            event: {
              name: 'novel/exported',
              payload: { schemaVersion: 1, projectRoot: snapshot.root, kind: input.kind, files: 1 },
            },
          }
        }
        if (input.kind === 'worldbook') {
          const files: StagedFile[] = [
            {
              path: joinRel(EXPORT_DIR, 'worldbook.md'),
              text: renderWorldbookMarkdown(snapshot.project, snapshot.worldbook),
            },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ]
          return {
            files,
            backup: false,
            data: { kind: input.kind, files: [files[0]!.path] },
            event: {
              name: 'novel/exported',
              payload: { schemaVersion: 1, projectRoot: snapshot.root, kind: input.kind, files: 1 },
            },
          }
        }
        if (input.kind === 'proposal') {
          const files: StagedFile[] = [
            {
              path: joinRel(EXPORT_DIR, 'proposal.md'),
              text: renderProposal(
                snapshot.project,
                snapshot.outline,
                snapshot.worldbook,
                snapshot.chapters.chapters,
              ),
            },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ]
          return {
            files,
            backup: false,
            data: { kind: input.kind, files: [files[0]!.path] },
            event: {
              name: 'novel/exported',
              payload: { schemaVersion: 1, projectRoot: snapshot.root, kind: input.kind, files: 1 },
            },
          }
        }
        const chapters = await this.chaptersForExport(snapshot, input.chapter)
        const suffix = input.chapter === undefined ? '' : `-ch${String(input.chapter).padStart(3, '0')}`
        const base = joinRel(EXPORT_DIR, `book${suffix}.${input.kind}`)
        const cover = joinRel(EXPORT_DIR, 'cover.svg')
        const blurb = joinRel(EXPORT_DIR, 'blurb.txt')
        const files: StagedFile[] = [
          { path: cover, text: renderCover(snapshot.project) },
          { path: blurb, text: renderBlurb(snapshot.project) },
        ]
        if (input.kind === 'md') files.push({ path: base, text: renderMarkdown(snapshot.project, chapters) })
        else if (input.kind === 'txt')
          files.push({ path: base, text: renderPlainText(snapshot.project, chapters) })
        else files.push({ path: base, bytes: buildEpub(snapshot.project, chapters) })
        files.push({ path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) })
        return {
          files,
          backup: false,
          data: { kind: input.kind, files: [base, cover, blurb] },
          event: {
            name: 'novel/exported',
            payload: {
              schemaVersion: 1,
              projectRoot: snapshot.root,
              kind: input.kind,
              files: files.length - 1,
            },
          },
        }
      },
    })
  }

  /* -------------------------------------------------------------- projections */

  async panelSummary(input: { root?: string } = {}): Promise<PanelSummaryDto> {
    return projectSummary(await this.panelSnapshot(input.root))
  }

  async panelChapters(input: { root?: string } = {}): Promise<PanelChaptersDto> {
    return projectChapters(await this.panelSnapshot(input.root))
  }

  async panelGates(input: { root?: string } = {}): Promise<PanelGatesDto> {
    return projectGates(await this.panelSnapshot(input.root))
  }

  /**
   * Additive v7 section read model. Catalog sections reuse the Snapshot; only
   * the quality section reads archived reviews, and only chapter/quality
   * detail reads manuscripts or check files. Every section is byte-capped.
   */
  async panelSection(
    input: { root?: string; section: PanelSectionName; query?: PanelSectionQuery } = {
      section: 'overview',
    },
  ): Promise<PanelSectionMeta> {
    const selection = await this.resolveRoot(input.root)
    if (input.root !== undefined && selection.root !== null) {
      const selected = resolve(selection.root)
      const registry = await this.registry().read()
      const configured = this.defaultRoot()
      const allowed =
        registry.active !== null && resolve(registry.active) === selected
          ? true
          : registry.projects.some((entry) => resolve(entry.root) === selected) ||
            selected === resolve(configured)
      if (!allowed) {
        throw new EngineInputError(
          ERROR_CODES.PROJECT_NOT_FOUND,
          `panel section root is not registered: ${selected}`,
          '用 /novel scan --register 或 /novel admin novel_registry_register 登记后刷新；面板不读取任意路径',
        )
      }
    }
    const snapshot = await this.loadAt(selection)
    const section = input.section
    const query = input.query ?? {}
    const cacheable = section !== 'chapter_detail' && section !== 'quality_detail'
    let sectionKey: string | null = null
    if (cacheable) {
      const journalIdentity = await this.panelJournalIdentity(snapshot)
      const reviewKey = section === 'quality' ? await this.panelReviewKey(snapshot) : ''
      sectionKey = sha256(
        stableJson({
          root: snapshot.root,
          revision: snapshot.pipeline.revision,
          journalKey: journalIdentity.key,
          reviewKey,
          section,
          query,
          stage: snapshot.pipeline.stage,
          errors: [
            snapshot.projectError,
            snapshot.pipelineError,
            snapshot.planError,
            snapshot.reviewError,
            snapshot.checkError,
            snapshot.outlineError,
            snapshot.worldbookError,
            ...snapshot.ledgerErrors.map((error) => error.code),
          ],
        }),
      )
      const cachedSection = this.sectionCache.get(sectionKey)
      if (cachedSection !== undefined) return cachedSection.value
    }
    let items: unknown = null
    let total = 0
    let truncated = false
    let nextCursor: string | null = null
    let counts: Record<string, { total: number; shown: number }> | null = null
    let returnedOverride: number | null = null
    if (section === 'overview') {
      const panel = await this.panelSnapshot(undefined, { snapshot, includeQuality: false })
      items = {
        ...panel,
        chapters: panel.chapters.slice(-5),
        bookData:
          panel.bookData === undefined
            ? undefined
            : {
                ...panel.bookData,
                quality: {
                  ...panel.bookData.quality,
                  dimensions: [],
                  samples: 0,
                  attempts: 0,
                },
                effort: { ...panel.bookData.effort, chapters: [] },
              },
      }
      total = 1
    } else if (section === 'chapter_detail' || section === 'quality_detail') {
      const chapter = query.chapter ?? snapshot.pipeline.chapter
      if (!Number.isInteger(chapter) || chapter < 1) {
        throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'chapter detail requires a positive chapter')
      }
      const row = snapshot.chapters.chapters.find((record) => record.num === chapter) ?? null
      const active = chapter === snapshot.pipeline.chapter
      const store = this.storeFor(snapshot.root)
      if (section === 'quality_detail') {
        const review = await store.readText(reviewFile(chapter))
        const check = await store.readText(checkFile(chapter))
        items = { chapter, review, check }
        total = row === null && !active ? 0 : 1
      } else {
        const manuscript =
          row === null || row.file === '' ? (active ? snapshot.text : null) : await store.readText(row.file)
        const plan = await store.readText(planChapterFile(chapter))
        const worldPlan = await store.readText(planWorldFile(chapter))
        const summaryEvents = row?.summary.events ?? snapshot.pipeline.draft?.summary?.events ?? []
        items = {
          chapter,
          row,
          manuscript,
          plan,
          world_plan: worldPlan,
          summary_events: summaryEvents.slice(0, 4),
        }
        total = row === null && !active ? 0 : 1
      }
    } else if (section === 'chapters') {
      const archivedCurrent = snapshot.chapters.chapters.some(
        (record) => record.num === snapshot.pipeline.chapter,
      )
      const draftWords =
        snapshot.text === null || archivedCurrent || snapshot.pipeline.stage === 'done'
          ? 0
          : countWordMetrics(snapshot.text).total_word_count
      const rows: Array<Record<string, unknown>> = snapshot.chapters.chapters.map((record) => ({
        num: record.num,
        title: record.title,
        file: record.file,
        word_count: record.word_count,
        score: record.score,
        status: 'archived',
        scene_type: record.scene_type,
        dialogue_ratio: record.dialogue_ratio,
        final_check: record.final_check ?? null,
        archived_at: record.archived_at ?? null,
        summary_events: record.summary.events.slice(0, 4),
        rounds: record.rounds ?? null,
      }))
      if (!archivedCurrent && snapshot.pipeline.stage !== 'done') {
        rows.push({
          num: snapshot.pipeline.chapter,
          title: stripTitlePrefix(snapshot.plan?.title ?? '') || `第${snapshot.pipeline.chapter}章`,
          file: null,
          word_count: draftWords,
          score: snapshot.review?.total ?? null,
          status: 'draft',
          scene_type: snapshot.plan?.scene_type ?? null,
          dialogue_ratio: null,
          final_check: null,
          archived_at: null,
          summary_events: (snapshot.pipeline.draft?.summary?.events ?? []).slice(0, 4),
          rounds: snapshot.pipeline.rounds,
        })
      }
      const filtered = rows.filter((row) => {
        if (query.status !== undefined && query.status !== '' && row.status !== query.status) return false
        if (query.scene !== undefined && query.scene !== '' && row.scene_type !== query.scene) return false
        if (query.search !== undefined && query.search !== '') {
          const title = String(row.title ?? '')
          if (!title.includes(query.search)) return false
        }
        return true
      })
      const sorted = filtered.sort((left, right) => {
        const byNum = Number(left.num) - Number(right.num)
        return query.sort === 'num_asc' ? byNum : -byNum
      })
      total = sorted.length
      const clippedRows = this.panelSectionClip(sorted, section)
      const page = this.panelSectionPage(clippedRows.items as Array<Record<string, unknown>>, query)
      items = page.items
      truncated = page.truncated || clippedRows.truncated
      nextCursor = page.nextCursor
    } else if (section === 'characters') {
      const seen = new Map<string, { first: number; last: number; appearances: number }>()
      for (const record of snapshot.chapters.chapters) {
        for (const name of record.summary.characters_appeared) {
          const current = seen.get(name) ?? { first: record.num, last: record.num, appearances: 0 }
          current.first = Math.min(current.first, record.num)
          current.last = Math.max(current.last, record.num)
          current.appearances += 1
          seen.set(name, current)
        }
      }
      const rows = snapshot.characters.characters.map((character) => ({
        ...character,
        ...(seen.get(character.name) ?? { first: character.first_appearance, last: null, appearances: 0 }),
      }))
      const filtered = rows.filter((row) =>
        query.search === undefined || query.search === ''
          ? true
          : row.name.includes(query.search) || row.role.includes(query.search),
      )
      total = filtered.length
      const clippedRows = this.panelSectionClip(filtered, section)
      const page = this.panelSectionPage(clippedRows.items as Array<Record<string, unknown>>, query, 200)
      items = page.items
      truncated = page.truncated || clippedRows.truncated
      nextCursor = page.nextCursor
    } else if (section === 'foreshadows') {
      const rows = snapshot.foreshadows.items
      const filtered = rows.filter((row) => {
        if (query.status !== undefined && query.status !== '' && row.status !== query.status) return false
        return query.search === undefined || query.search === '' ? true : row.title.includes(query.search)
      })
      // The panel is the compact read model; `novel_state` still serves the full
      // advance_log on demand. Shipping every log here is what pushed ninety
      // foreshadows past the section cap, and the cap then deleted the primary
      // list rather than paging it.
      const compact = filtered.map((item) => {
        const { advance_log, ...rest } = item
        return { ...rest, advance_count: advance_log.length }
      })
      const clip = this.panelSectionClip(compact, section)
      let timeline = snapshot.timeline.items.slice(0, PANEL_LEADS_AUX_LIMIT)
      let relationships = snapshot.relationships.items.slice(0, PANEL_LEADS_AUX_LIMIT)
      const auxBytes = (): number =>
        Buffer.byteLength(JSON.stringify({ foreshadows: [], timeline, relationships }))
      // Previews pay first: a dropped preview row still has a total behind it,
      // while a dropped page row loses its only route back. The pageable ledger
      // claims the rest and, if it still does not fit, shrinks the page and
      // rewrites the cursor instead of deleting rows after the fact.
      while (auxBytes() > PANEL_SECTION_BYTES / 2 && (timeline.length > 0 || relationships.length > 0)) {
        if (timeline.length >= relationships.length) timeline = timeline.slice(0, -1)
        else relationships = relationships.slice(0, -1)
      }
      const page = this.panelSectionPage(
        clip.items as Array<Record<string, unknown>>,
        query,
        PANEL_LEADS_PAGE_SIZE,
        auxBytes(),
      )
      total = filtered.length
      items = { foreshadows: page.items, timeline, relationships }
      truncated =
        page.truncated ||
        clip.truncated ||
        snapshot.timeline.items.length > timeline.length ||
        snapshot.relationships.items.length > relationships.length
      nextCursor = page.nextCursor
      counts = {
        foreshadows: { total: filtered.length, shown: page.items.length },
        timeline: { total: snapshot.timeline.items.length, shown: timeline.length },
        relationships: { total: snapshot.relationships.items.length, shown: relationships.length },
      }
      returnedOverride = page.items.length
    } else if (section === 'timeline') {
      const rows = snapshot.timeline.items
      const filtered = rows.filter((row) =>
        query.search === undefined || query.search === ''
          ? true
          : row.description.includes(query.search) || (row.location ?? '').includes(query.search),
      )
      total = filtered.length
      const clippedRows = this.panelSectionClip(filtered, section)
      const page = this.panelSectionPage(clippedRows.items as Array<Record<string, unknown>>, query, 200)
      items = page.items
      truncated = page.truncated || clippedRows.truncated
      nextCursor = page.nextCursor
    } else if (section === 'relationships') {
      const rows = snapshot.relationships.items
      const filtered = rows.filter((row) =>
        query.search === undefined || query.search === ''
          ? true
          : row.a.includes(query.search) || row.b.includes(query.search) || row.type.includes(query.search),
      )
      total = filtered.length
      const clippedRows = this.panelSectionClip(filtered, section)
      const page = this.panelSectionPage(clippedRows.items as Array<Record<string, unknown>>, query, 200)
      items = page.items
      truncated = page.truncated || clippedRows.truncated
      nextCursor = page.nextCursor
    } else if (section === 'worldbook') {
      const world = snapshot.world
      const book = snapshot.worldbook
      const search = query.search?.trim() ?? ''
      const matches = (value: unknown): boolean => {
        if (search === '') return true
        if (typeof value === 'string') return value.includes(search)
        if (typeof value === 'number' || typeof value === 'boolean') return String(value).includes(search)
        if (Array.isArray(value)) return value.some((item) => matches(item))
        if (typeof value === 'object' && value !== null) {
          return Object.values(value as Record<string, unknown>).some((item) => matches(item))
        }
        return false
      }
      const filterRows = <T>(rows: readonly T[]): T[] => rows.filter((row) => matches(row))
      const groups = {
        rules: filterRows(book.rules),
        factions: filterRows(book.factions),
        locations: filterRows(book.locations),
        characters: filterRows(book.characters),
        glossary: filterRows(book.glossary),
        backstory: filterRows(book.backstory),
        facts: filterRows(book.facts ?? []),
        themes: filterRows(book.themes),
      }
      const ledger = {
        locations: filterRows(world.locations),
        abilities: filterRows(world.abilities),
        artifacts: filterRows(world.artifacts),
        factions: filterRows(world.factions),
        rules: filterRows(world.rules),
      }
      const outlineCards = filterRows(snapshot.outline.chapters)
      // Structured lists have no cursor; dropping a row here is only honest if
      // the drop is counted, so every group reports `total` next to `shown`.
      const preview = this.panelPreviewGroups(
        {
          rules: groups.rules,
          factions: groups.factions,
          locations: groups.locations,
          characters: groups.characters,
          glossary: groups.glossary,
          backstory: groups.backstory,
          facts: groups.facts,
          themes: groups.themes,
          ledger_locations: ledger.locations,
          ledger_abilities: ledger.abilities,
          ledger_artifacts: ledger.artifacts,
          ledger_factions: ledger.factions,
          ledger_rules: ledger.rules,
          outline_cards: outlineCards,
        },
        PANEL_GROUP_PREVIEW,
        PANEL_SECTION_BYTES * 0.7,
      )
      const group = (key: string): unknown[] => preview.groups[key] ?? []
      total = Object.values(preview.counts).reduce((count, entry) => count + entry.total, 0)
      truncated = Object.values(preview.counts).some((entry) => entry.shown < entry.total)
      counts = preview.counts
      items = {
        premise: book.premise,
        setting: book.setting,
        blueprint: snapshot.outline.book,
        volumes: snapshot.outline.volumes,
        rules: group('rules'),
        factions: group('factions'),
        locations: group('locations'),
        characters: group('characters'),
        glossary: group('glossary'),
        backstory: group('backstory'),
        facts: group('facts'),
        themes: group('themes'),
        ledger: {
          locations: group('ledger_locations'),
          abilities: group('ledger_abilities'),
          artifacts: group('ledger_artifacts'),
          factions: group('ledger_factions'),
          rules: group('ledger_rules'),
        },
        outline_cards: group('outline_cards'),
        drift: outlineDrift(snapshot.outline, snapshot.chapters.chapters),
      }
    } else if (section === 'quality') {
      const panel = await this.panelSnapshot(undefined, { snapshot, includeQuality: true })
      const panelStylepack = this.stylepackFor(snapshot.project)
      const maxById = new Map(
        this.rulepack.quality.dimensions.map((dimension) => [dimension.id, dimension.max]),
      )
      items = {
        quality: panel.bookData?.quality ?? null,
        dimensions: (panel.bookData?.quality.dimensions ?? []).map((dimension) => ({
          ...dimension,
          max: maxById.get(dimension.id) ?? null,
        })),
        pacing: panel.bookData?.pacing ?? null,
        effort: panel.bookData?.effort ?? null,
        // 0.2.17: the nine style measurements next to the score dimensions, so
        // "this chapter drifted" and "this chapter scored low" sit together.
        style_metrics: panel.bookData?.style_metrics ?? null,
        // The targets travel with the measurements: the client cannot colour a
        // deviation without knowing what the pack asked for.
        style_targets:
          panelStylepack === null
            ? null
            : {
                id: panelStylepack.id,
                name: panelStylepack.name,
                sentence: panelStylepack.sentence,
                dialogue: panelStylepack.dialogue.ratio,
                // The card must judge the same reading the rule judged, so the
                // metric travels with the target instead of being re-guessed.
                dialogue_metric: snapshot.project.targets.dialogue_ratio_metric ?? 'both',
                thresholds: panelStylepack.thresholds,
                cool_point_every_chars: panelStylepack.structure.cool_point_every_chars,
              },
      }
      total = items === null ? 0 : 1
    } else {
      const panel = await this.panelSnapshot(undefined, { snapshot, includeQuality: false })
      items = {
        health: panel.health ?? null,
        blocking: panel.blocking,
        state_errors: this.stateErrors(snapshot),
        outline: {
          present: snapshot.outlinePresent && snapshot.outlineError === null,
          file_existed: snapshot.outlinePresent,
          error: snapshot.outlineError,
        },
        worldbook: {
          present: snapshot.worldbookPresent && snapshot.worldbookError === null,
          file_existed: snapshot.worldbookPresent,
          error: snapshot.worldbookError,
        },
        drift: outlineDrift(snapshot.outline, snapshot.chapters.chapters),
        pending: panel.pending ?? null,
      }
      total = 1
    }
    // 0.2.17: detail sections carry the whole manuscript, so they need the byte
    // budget rather than the per-string clip (which would cut the body to 400
    // characters and call it complete).
    const clipped =
      section === 'chapter_detail' || section === 'quality_detail'
        ? this.panelDetailClip(items, section)
        : this.panelSectionClip(items, section)
    items = clipped.items
    truncated = truncated || clipped.truncated
    const updatedAt = this.now().toISOString()
    const etag = sha256(
      stableJson({
        root: snapshot.root,
        revision: snapshot.pipeline.revision,
        section,
        query,
        items,
        total,
        truncated,
      }),
    )
    const result: PanelSectionMeta = {
      payload_version: 7,
      section,
      items,
      total,
      returned: returnedOverride ?? this.panelSectionReturned(items),
      truncated,
      next_cursor: nextCursor,
      updated_at: updatedAt,
      etag,
      ...(counts === null ? {} : { counts }),
    }
    if (sectionKey !== null) {
      this.sectionCache.set(sectionKey, { key: sectionKey, value: result })
      if (this.sectionCache.size > 64) {
        const oldest = this.sectionCache.keys().next().value
        if (oldest !== undefined) this.sectionCache.delete(oldest)
      }
    }
    return result
  }

  /**
   * One page of a ledger. Fitting the byte cap happens here, before the page is
   * emitted: an oversized page is shortened and the cursor is rewritten to the
   * first row that did not fit, so every row keeps a route back. Deleting rows
   * after paging — and then nulling the cursor — is what turned ninety
   * foreshadows into one.
   */
  private panelSectionPage<T>(
    rows: readonly T[],
    query: PanelSectionQuery,
    defaultLimit = 50,
    reserveBytes = 0,
  ): { items: T[]; start: number; truncated: boolean; nextCursor: string | null } {
    const requested = query.limit ?? defaultLimit
    const limit = Number.isInteger(requested) ? Math.min(200, Math.max(1, requested)) : defaultLimit
    const cursor = Number.parseInt(query.cursor ?? '0', 10)
    const start = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0
    const take = Math.min(limit, Math.max(0, rows.length - start))
    const fits = (count: number): boolean =>
      Buffer.byteLength(JSON.stringify(rows.slice(start, start + count)) ?? 'null') + reserveBytes <=
      PANEL_SECTION_BYTES - PANEL_SECTION_SLACK
    let size = take
    while (size > 1 && !fits(size)) size -= 1
    const items = rows.slice(start, start + size)
    const end = start + items.length
    const truncated = end < rows.length
    return { items, start, truncated, nextCursor: truncated ? String(end) : null }
  }

  /**
   * Bounded preview of a structured section that has no cursor. Rows are
   * dropped only here, never silently: `counts` reports `total` beside `shown`
   * so the panel says "showing X of Y" instead of pretending the list is whole.
   */
  private panelPreviewGroups(
    groups: Record<string, readonly unknown[]>,
    cap: number,
    budget: number,
  ): {
    groups: Record<string, unknown[]>
    counts: Record<string, { total: number; shown: number }>
  } {
    const totals = new Map<string, number>()
    const shown = new Map<string, unknown[]>()
    for (const [key, rows] of Object.entries(groups)) {
      totals.set(key, rows.length)
      shown.set(key, rows.slice(0, cap))
    }
    const bytes = (): number => Buffer.byteLength(JSON.stringify(Object.fromEntries(shown)) ?? 'null')
    let guard = 0
    while (bytes() > budget && guard < 100_000) {
      guard += 1
      let pick: string | null = null
      let size = 1
      for (const [key, rows] of shown) {
        if (rows.length > size) {
          pick = key
          size = rows.length
        }
      }
      if (pick === null) break
      const rows = shown.get(pick) ?? []
      shown.set(pick, rows.slice(0, -1))
    }
    const counts: Record<string, { total: number; shown: number }> = {}
    for (const [key, rows] of shown) {
      counts[key] = { total: totals.get(key) ?? rows.length, shown: rows.length }
    }
    return { groups: Object.fromEntries(shown), counts }
  }

  private panelSectionReturned(items: unknown): number {
    if (Array.isArray(items)) return items.length
    if (typeof items === 'object' && items !== null) {
      return Object.values(items).reduce(
        (total, value) => total + (Array.isArray(value) ? value.length : 1),
        0,
      )
    }
    return items === null ? 0 : 1
  }

  /** WP3.7 free-text caps before the byte budget; both report truncation. */
  private panelSectionClip(value: unknown, section: string): { items: unknown; truncated: boolean } {
    let truncated = false
    const walk = (input: unknown, path: string[]): unknown => {
      if (typeof input === 'string') {
        const keys = path.filter((part) => !/^\d+$/.test(part))
        const key = keys[keys.length - 1] ?? ''
        const worldbookText =
          section === 'worldbook' || keys.some((part) => part === 'ledger' || part === 'worldbook')
        const max = key === 'description' && worldbookText ? 240 : 400
        const chars = Array.from(input)
        if (chars.length > max) {
          truncated = true
          return chars.slice(0, max).join('')
        }
        return input
      }
      if (Array.isArray(input)) {
        return input.map((item, index) => walk(item, [...path, String(index)]))
      }
      if (typeof input === 'object' && input !== null) {
        return Object.fromEntries(
          Object.entries(input as Record<string, unknown>).map(([key, item]) => [
            key,
            walk(item, [...path, key]),
          ]),
        )
      }
      return input
    }
    return { items: walk(value, []), truncated }
  }

  /**
   * 0.2.17: clip a detail section to the same 64KB budget as every other one.
   *
   * The per-string clip cannot be used here: it would cut the manuscript to 400
   * characters and report the section as complete. Instead the body is the one
   * field that gets shortened, the rest of the metadata survives, and the
   * payload says where the full text lives.
   */
  private panelDetailClip(items: unknown, section: string): { items: unknown; truncated: boolean } {
    const record =
      typeof items === 'object' && items !== null && !Array.isArray(items)
        ? (items as Record<string, unknown>)
        : null
    if (record === null) return { items, truncated: false }
    if (Buffer.byteLength(JSON.stringify(items), 'utf8') <= PANEL_SECTION_BYTES) {
      return { items, truncated: false }
    }
    // Drop the biggest text field first, keeping a readable head so the panel
    // still shows what chapter it is looking at.
    for (const key of ['manuscript', 'review', 'check', 'plan', 'world_plan'] as const) {
      const value = record[key]
      if (typeof value !== 'string' || value === '') continue
      const chars = Array.from(value)
      if (chars.length <= 2_000) continue
      record[key] = chars.slice(0, 2_000).join('')
      record.truncated_field = key
      record.truncated_note =
        section === 'quality_detail'
          ? '完整评审/校验用 novel_state {kind:"review"|"check"}'
          : '完整正文用 novel_state 或直接读章节文件'
      return { items: record, truncated: true }
    }
    return { items: record, truncated: true }
  }

  /**
   * Build the read-only panel payload. The query root is accepted only when it
   * is registered, active or the configured root; arbitrary paths never reach
   * the filesystem from the panel route.
   */
  async panelBundle(input: { root?: string; lean?: boolean } = {}): Promise<PanelBundle> {
    const registry = await this.registry().read()
    const active = registry.active
    const rows = new Map<string, PanelProjectOption>()
    const add = (option: PanelProjectOption): void => {
      if (!rows.has(option.root)) rows.set(option.root, option)
    }
    const optionFor = async (
      root: string,
      registered: boolean,
      fallbackTitle?: string,
      expectedCreatedAt?: string,
    ): Promise<PanelProjectOption> => {
      const inspection = await inspectProject(root)
      const state: PanelProjectOption['state'] =
        inspection.state === 'ok'
          ? 'ok'
          : inspection.state === 'damaged'
            ? 'damaged'
            : inspection.state === 'unreadable'
              ? 'unreadable'
              : inspection.state === 'not-project'
                ? 'not-project'
                : 'missing'
      const sameIdentity =
        expectedCreatedAt === undefined ||
        expectedCreatedAt === '' ||
        inspection.created_at === expectedCreatedAt
      const identityChanged = inspection.state === 'ok' && !sameIdentity
      const title =
        inspection.state === 'ok' && inspection.title !== ''
          ? inspection.title
          : fallbackTitle !== undefined && fallbackTitle !== ''
            ? fallbackTitle
            : inspection.title
      return {
        root: inspection.root,
        title,
        active: active === inspection.root,
        registered,
        state,
        ...(identityChanged ? { identity_changed: true } : {}),
      }
    }
    for (const entry of registry.projects) {
      add(await optionFor(entry.root, true, entry.title, entry.created_at))
    }
    if (active !== null && !rows.has(active)) {
      const known = registry.projects.find((entry) => entry.root === active)
      add(await optionFor(active, known !== undefined, known?.title, known?.created_at))
    }
    const configured = this.defaultRoot()
    // An explicit configured projectRoot that is currently missing is a
    // recoverable mount, not a fresh install. The default ./novel remains
    // quiet so first-run still shows the empty state.
    const explicitConfigured = this.config.projectRoot !== './novel' && configured !== resolve('./novel')
    if (!rows.has(configured)) {
      const option = await optionFor(configured, false)
      // A never-created ./novel should not look like a broken project on a
      // fresh install; an active/config path that actually has evidence does.
      if (option.state !== 'missing' || active === configured || explicitConfigured) add(option)
    }
    const selectedRoot = input.root === undefined ? undefined : resolve(input.root)
    // The configured projectRoot is a trusted query target even when it is
    // currently missing or not registered; it must report `missing`, not
    // `not_registered`, so a restored mount can keep the same preference. Add
    // it before the projects array is materialized so the selector can still
    // show the chosen root.
    if (selectedRoot !== undefined && !rows.has(selectedRoot) && selectedRoot === configured) {
      add(await optionFor(configured, false))
    }
    const projects = [...rows.values()].sort((left, right) => compareText(left.root, right.root))
    let selection: PanelSelection
    if (selectedRoot !== undefined) {
      if (!rows.has(selectedRoot)) {
        return {
          projects,
          selection: { root: selectedRoot, source: 'query' },
          missing: {
            root: selectedRoot,
            title: '（未登记的项目）',
            code: ERROR_CODES.PROJECT_NOT_FOUND,
            reason: 'not_registered',
            hint: '用 /novel scan --register 或 /novel admin novel_registry_register 登记后刷新；面板不会读取任意路径。',
          },
        }
      }
      selection = { root: selectedRoot, source: 'query' }
    } else if (active !== null) {
      selection = { root: active, source: 'active' }
    } else if (rows.has(configured) && !registry.projects.some((entry) => entry.root === configured)) {
      // The explicit configured projectRoot outranks a lone registry row:
      // otherwise a stale single registration silently redirects the panel to
      // a different book even though the deployment named its project.
      selection = { root: configured, source: 'config' }
    } else if (registry.projects.length === 1) {
      selection = { root: registry.projects[0]!.root, source: 'single' }
    } else {
      selection = { root: null, source: 'none' }
    }

    if (selection.root === null) {
      return {
        projects,
        selection,
        ...(projects.length === 0
          ? { empty: true as const, error: '还没有项目：调用 novel_init 创建。' }
          : {}),
      }
    }
    // Every selection source above is materialized into `rows`; a missing row
    // would be a resolver bug, not a user-recoverable state.
    const option = rows.get(selection.root)!
    const inspection = await inspectProject(selection.root)
    if (option.state === 'missing' || option.state === 'unreadable' || inspection.state === 'not-project') {
      return {
        projects,
        selection,
        missing: {
          root: selection.root,
          title: option.title,
          code:
            inspection.state === 'not-project' ? ERROR_CODES.PROJECT_NOT_FOUND : ERROR_CODES.PROJECT_MISSING,
          reason:
            inspection.state === 'not-project'
              ? 'not-project'
              : inspection.state === 'unreadable'
                ? 'unreadable'
                : 'missing',
          hint:
            inspection.state === 'not-project'
              ? '目录存在，但没有 novel.yaml 或项目状态；请恢复项目定义，或改选其他项目。'
              : inspection.state === 'unreadable'
                ? '目录不可读；请修复权限或 IO 错误后刷新，登记行和面板偏好会保留。'
                : '项目目录不在了；请恢复目录或挂载后刷新，登记行和面板偏好会保留。',
        },
      }
    }
    let snapshot: PanelSnapshot
    try {
      snapshot = await this.panelSnapshot(selection.root, { includeQuality: input.lean !== true })
    } catch (error) {
      // The directory can disappear between the cheap option inspection and the
      // full read. Keep the project list/selector and report the same missing
      // state instead of letting the route collapse to an empty payload.
      if (error instanceof EngineError) {
        const busy = error.code === ERROR_CODES.TXN_IN_PROGRESS
        const missingDir =
          error.code === ERROR_CODES.PROJECT_MISSING || error.code === ERROR_CODES.PROJECT_NOT_FOUND
        return {
          projects,
          selection,
          missing: {
            root: selection.root,
            title: option.title,
            code: busy
              ? ERROR_CODES.TXN_IN_PROGRESS
              : missingDir
                ? error.code
                : ERROR_CODES.PROJECT_NOT_FOUND,
            reason: busy ? 'busy' : missingDir ? 'missing' : 'unreadable',
            hint: busy
              ? '另一个写入正在进行；面板不会读取撕裂状态，请等写入完成后刷新。'
              : (error.hint ??
                (missingDir
                  ? '项目目录不在了；请恢复目录或挂载后刷新，登记行和面板偏好会保留。'
                  : `项目暂时无法读取（${error.code}）；修正后刷新，项目选择器会保留。`)),
          },
        }
      }
      throw error
    }
    const summary = projectSummary(snapshot)
    // A damaged novel.yaml cannot prove its own title. The registry row can, so
    // keep the header and the copy-resume prompt from inventing a placeholder.
    if (option.state !== 'ok' && option.title !== '') summary.title = option.title
    const resume =
      summary.next === undefined || summary.progress?.finished === true
        ? undefined
        : {
            text: formatResumePrompt({
              title: summary.title,
              root: summary.root,
              chapter: summary.chapter,
              stage: summary.stage,
              nextTool: summary.next.tool,
              ...(summary.progress === undefined ? {} : { progress: summary.progress }),
            }),
          }
    const chapters = projectChapters(snapshot)
    const etag = sha256(
      stableJson({
        root: snapshot.root,
        projects,
        selection,
        summary,
        chapters,
        ...(resume === undefined ? {} : { resume }),
      }),
    )
    return {
      projects,
      selection,
      summary,
      chapters,
      etag,
      ...(resume === undefined ? {} : { resume }),
    }
  }

  /** Read-only resume text shared with the panel copy button. */
  async resumePrompt(
    input: { root?: string } = {},
  ): Promise<OpResult<{ text: string | null; selection: StatusReport['selection'] }>> {
    if (this.caller()?.sessionId === undefined) {
      throw new EngineInputError(
        ERROR_CODES.CONFIG_INVALID,
        'resume requires an Agent session',
        'run /novel resume from an Agent conversation',
      )
    }
    // Resume is a prompt formatter, not a selection event: use loadAt directly
    // so a workspace/cwd fallback cannot auto-register, and an explicit root
    // cannot persist a new session binding.
    const selection = await this.resolveRoot(input.root)
    const snapshot = await this.loadAt(selection)
    const status = await this.statusFor(snapshot, snapshot.pipeline.chapter)
    const nextTool = status.data.next?.tool
    const text =
      nextTool === undefined || status.data.progress?.finished === true
        ? null
        : formatResumePrompt({
            title: status.data.project.title,
            root: status.data.project.root,
            chapter: status.data.chapter,
            stage: status.data.stage,
            nextTool,
            ...(status.data.progress === undefined ? {} : { progress: status.data.progress }),
          })
    return {
      data: { text, selection: status.data.selection },
      revision: status.revision,
      warnings: [],
    }
  }

  async stats(input: { root?: string } = {}): Promise<{
    totalWords: number
    archivedWords: number
    draftWords: number
    chapters: number
    revision: number
    rulepack: string
    averageScore: number
    lastScore: number
    openForeshadows: number
    plannedChapters: number
    totalCards: number
    outlineCoverage: number | null
    archivedCoverage: number | null
    missingCards: number
    blueprintReady: boolean
    worldbookEntries: number
    strictOutline: boolean
    targetChapters: number | null
    state_errors: StateError[]
    partial: boolean
  }> {
    const snapshot = await this.load(input.root)
    const stateErrors = this.stateErrors(snapshot)
    const archivedWords = snapshot.chapters.chapters.reduce((total, chapter) => total + chapter.word_count, 0)
    const activeIndexed = snapshot.chapters.chapters.some(
      (chapter) => chapter.num === snapshot.pipeline.chapter,
    )
    const draftWords =
      snapshot.text === null || activeIndexed || snapshot.pipeline.stage === 'done'
        ? 0
        : countWordMetrics(snapshot.text).total_word_count
    const totalWords = archivedWords + draftWords
    const scores = snapshot.chapters.chapters.map((chapter) => chapter.score)
    const outline = outlineSummary(
      snapshot.outline,
      snapshot.chapters.chapters.length,
      snapshot.project.targets.total_chapters,
      snapshot.chapters.chapters.map((record) => record.num),
    )
    const counts = worldbookCounts(snapshot.worldbook)
    return {
      totalWords,
      archivedWords,
      draftWords,
      chapters: snapshot.chapters.chapters.length,
      revision: snapshot.pipeline.revision,
      rulepack: `${this.rulepack.name}@${this.rulepack.version}`,
      averageScore:
        scores.length === 0
          ? 0
          : Math.round(scores.reduce((total, score) => total + score, 0) / scores.length),
      lastScore: scores.length === 0 ? 0 : scores[scores.length - 1]!,
      openForeshadows: snapshot.foreshadows.items.filter((item) => item.status !== 'resolved').length,
      plannedChapters: outline.planned,
      totalCards: outline.total,
      outlineCoverage: outline.plannedCoverage,
      archivedCoverage: outline.archivedCoverage,
      missingCards: outline.missingCards,
      blueprintReady: bookPlanPresent(snapshot.outline.book),
      worldbookEntries:
        counts.characters +
        counts.locations +
        counts.factions +
        counts.rules +
        counts.glossary +
        counts.backstory +
        counts.facts,
      strictOutline: snapshot.outline.book.strict,
      targetChapters: snapshot.project.targets.total_chapters,
      state_errors: stateErrors,
      partial: stateErrors.length > 0,
    }
  }

  /* ------------------------------------------------------- multi-project ops */

  private registry(): ProjectRegistry {
    return new ProjectRegistry(this.stateStore())
  }

  /** List known projects with a cheap directory state for the panel/command. */
  async listProjects(): Promise<{
    active: string | null
    projects: Array<RegistryEntry & { state: ProjectState; identity_changed?: boolean }>
  }> {
    const document = await this.registry().read()
    const projects = await Promise.all(
      document.projects.map(async (entry) => {
        const inspection = await inspectProject(entry.root)
        const sameIdentity =
          entry.created_at === undefined ||
          entry.created_at === '' ||
          inspection.created_at === entry.created_at
        return {
          ...entry,
          // A readable novel.yaml is fresher than a registry row written before
          // the title was amended, but only while the registry and disk still
          // describe the same project identity. The panel uses its own title
          // projection and labels identity changes; scan --register keeps the
          // last registered title so it cannot silently overwrite a row.
          ...(inspection.state === 'ok' && inspection.title !== '' && sameIdentity
            ? { title: inspection.title }
            : {}),
          state: inspection.state,
          ...(inspection.state === 'ok' && !sameIdentity ? { identity_changed: true } : {}),
        }
      }),
    )
    const configured = this.defaultRoot()
    if (
      configured !== '' &&
      !document.projects.some((entry) => resolve(entry.root) === resolve(configured))
    ) {
      const inspection = await inspectProject(configured)
      if (inspection.state === 'missing') {
        projects.push({
          root: configured,
          title: '配置项目根',
          created_at: '',
          updated_at: '',
          state: inspection.state,
        })
      }
    }
    return { active: document.active, projects }
  }

  /**
   * Record an explicit project row. An unchanged duplicate is a no-op; a path
   * reused by another project updates the row and reports `replaced`.
   */
  async registerProject(input: { root?: string } = {}): Promise<{
    active: string | null
    projects: RegistryEntry[]
    replaced: boolean
  }> {
    const selection =
      input.root === undefined
        ? await this.resolveRoot(undefined)
        : { root: this.resolveProjectPath(input.root), source: 'explicit' as const }
    const snapshot = await this.loadAt(selection)
    this.assertProjectHealthy(snapshot, 'novel_registry_register')
    return this.withMetadataLock(async () => {
      const registry = this.registry()
      const document = await registry.read()
      const previous = document.projects.find((entry) => entry.root === snapshot.root)
      const replaced =
        previous !== undefined &&
        previous.created_at !== undefined &&
        previous.created_at !== '' &&
        previous.created_at !== snapshot.project.created_at
      if (
        !replaced &&
        previous !== undefined &&
        previous.title === snapshot.project.title &&
        (previous.created_at ?? '') === (snapshot.project.created_at ?? '')
      ) {
        return { active: document.active, projects: document.projects, replaced: false }
      }
      const next = await registry.register({
        root: snapshot.root,
        title: snapshot.project.title,
        created_at: snapshot.project.created_at,
      })
      return { active: next.active, projects: next.projects, replaced }
    })
  }

  /** Choose the panel/default project. This never binds the current session. */
  async setActiveProject(input: { root: string }): Promise<{ active: string | null; replaced: boolean }> {
    const selection: Selection = { root: this.resolveProjectPath(input.root), source: 'explicit' }
    const snapshot = await this.loadAt(selection)
    this.assertProjectHealthy(snapshot, 'novel_registry_activate')
    return this.withMetadataLock(async () => {
      const registry = this.registry()
      const document = await registry.read()
      const previous = document.projects.find((entry) => entry.root === snapshot.root)
      const replaced =
        previous !== undefined &&
        previous.created_at !== undefined &&
        previous.created_at !== '' &&
        previous.created_at !== snapshot.project.created_at
      await registry.register({
        root: snapshot.root,
        title: snapshot.project.title,
        created_at: snapshot.project.created_at,
      })
      const active = await registry.setActive(snapshot.root)
      return { active: active.active, replaced }
    })
  }

  /** Forget a registry row; the project directory and bindings are never touched. */
  async forgetProject(input: {
    root: string
  }): Promise<{ active: string | null; projects: RegistryEntry[] }> {
    return this.withMetadataLock(async () => {
      const document = await this.registry().forget(this.resolveProjectPath(input.root))
      return { active: document.active, projects: document.projects }
    })
  }

  /**
   * Remove only registry rows whose directories are missing, not a project, or
   * unreadable. The default is a dry run; project files and session bindings are
   * never touched, and `--yes` is required at the command layer.
   */
  async pruneProjects(input: { apply?: boolean } = {}): Promise<{
    candidates: Array<{ root: string; title: string; state: ProjectState }>
    removed: string[]
    active: string | null
  }> {
    const listed = await this.listProjects()
    const candidates = listed.projects
      .filter(
        (project) =>
          project.state === 'missing' || project.state === 'not-project' || project.state === 'unreadable',
      )
      .map((project) => ({ root: project.root, title: project.title, state: project.state }))
    if (input.apply !== true) {
      return { candidates, removed: [], active: listed.active }
    }
    return this.withMetadataLock(async () => {
      const registry = this.registry()
      let document = await registry.read()
      const removed: string[] = []
      for (const candidate of candidates) {
        if (!document.projects.some((entry) => entry.root === candidate.root)) continue
        // Re-check immediately before removing the row. A directory restored
        // while the user was confirming must not lose its registration.
        const inspection = await inspectProject(candidate.root)
        if (
          inspection.state !== 'missing' &&
          inspection.state !== 'not-project' &&
          inspection.state !== 'unreadable'
        )
          continue
        document = await registry.forget(candidate.root)
        removed.push(candidate.root)
      }
      return { candidates, removed, active: document.active }
    })
  }

  /**
   * Bounded workspace scan. Normal mode is read-only; `register` updates only
   * healthy, newly discovered rows, never active or session bindings.
   */
  async scanProjects(input: { cwd: string; register?: boolean }): Promise<{
    cwd: string
    candidates: Array<
      ProjectInspection & { registered: boolean; identity_changed?: boolean; reason?: string }
    >
    truncated: boolean
    added: string[]
    already: string[]
    skipped: Array<{ root: string; reason: string }>
    identity_changed: string[]
  }> {
    const cwd = resolve(input.cwd)
    const scan = await scanWorkspace(cwd)
    const before = await this.registry().read()
    const registeredRoots = new Set(before.projects.map((entry) => entry.root))
    const candidates: Array<
      ProjectInspection & { registered: boolean; identity_changed?: boolean; reason?: string }
    > = scan.candidates.map((candidate) => ({
      ...candidate,
      registered: registeredRoots.has(candidate.root),
    }))
    if (input.register !== true) {
      return {
        cwd,
        candidates,
        truncated: scan.truncated,
        added: [],
        already: [],
        skipped: [],
        identity_changed: [],
      }
    }

    const loaded = new Map<string, Snapshot>()
    const skipped: Array<{ root: string; reason: string }> = []
    for (const candidate of candidates) {
      if (candidate.state !== 'ok') {
        skipped.push({
          root: candidate.root,
          reason:
            candidate.state === 'damaged'
              ? `damaged: ${candidate.error ?? 'novel.yaml is missing/unreadable'}`
              : candidate.state === 'unreadable'
                ? `unreadable: ${candidate.error ?? 'permission or IO error'}`
                : `not a project (${candidate.state})`,
        })
        continue
      }
      // Existing rows already have an identity. The scan header is enough to
      // refresh a title; building a full Snapshot for every registered book
      // would make a large workspace scan unnecessarily expensive.
      if (registeredRoots.has(candidate.root)) continue
      try {
        const snapshot = await this.loadAt({ root: candidate.root, source: 'explicit' })
        if (snapshot.projectError !== null) {
          skipped.push({
            root: candidate.root,
            reason: `damaged: ${snapshot.projectError}`,
          })
          continue
        }
        loaded.set(candidate.root, snapshot)
      } catch (error) {
        skipped.push({ root: candidate.root, reason: errorMessage(error) })
      }
    }

    const added: string[] = []
    const already: string[] = []
    const identityChanged: string[] = []
    await this.withMetadataLock(async () => {
      const registry = this.registry()
      const document = await registry.read()
      for (const candidate of candidates) {
        if (candidate.state !== 'ok') continue
        const existing = document.projects.find((entry) => entry.root === candidate.root)
        if (existing !== undefined) {
          candidate.registered = true
          already.push(candidate.root)
          const previousCreatedAt = existing.created_at ?? ''
          const currentCreatedAt = candidate.created_at ?? ''
          if (previousCreatedAt !== '' && previousCreatedAt !== currentCreatedAt) {
            identityChanged.push(candidate.root)
            candidate.identity_changed = true
            candidate.reason =
              'registered under a different created_at (or the replacement has none); not overwritten. Run explicit register/activate to confirm the replacement.'
            continue
          }
          if (
            candidate.title !== '' &&
            (existing.title !== candidate.title || previousCreatedAt !== currentCreatedAt)
          ) {
            try {
              await registry.register({
                root: candidate.root,
                title: candidate.title,
                created_at: candidate.created_at,
              })
            } catch (error) {
              // The row already existed, so keep it in `already`; the failed
              // refresh is reported separately instead of aborting the batch.
              skipped.push({
                root: candidate.root,
                reason: `registry update failed: ${errorMessage(error)}`,
              })
            }
          }
          continue
        }
        const snapshot = loaded.get(candidate.root)
        if (snapshot === undefined) continue
        try {
          await registry.register({
            root: snapshot.root,
            title: snapshot.project.title,
            created_at: snapshot.project.created_at,
          })
          added.push(candidate.root)
          candidate.registered = true
          candidate.title = snapshot.project.title
          candidate.created_at = snapshot.project.created_at
        } catch (error) {
          skipped.push({
            root: candidate.root,
            reason: `registry write failed: ${errorMessage(error)}`,
          })
        }
      }
    })

    return {
      cwd,
      candidates,
      truncated: scan.truncated,
      added,
      already,
      skipped,
      identity_changed: identityChanged,
    }
  }

  /** Current session binding, or the inferred fallback when none is set. */
  async currentProject(): Promise<{
    selection: Selection | null
    bound: boolean
    state?: ProjectState
    error?: string
  }> {
    const caller = this.caller()
    if (caller?.sessionId === undefined) {
      throw new EngineInputError(
        ERROR_CODES.CONFIG_INVALID,
        'currentProject requires an Agent session',
        'run /novel current from an Agent conversation',
      )
    }
    const binding = await this.bindings().get(caller.sessionId)
    if (binding !== undefined) {
      const inspection = await inspectProject(binding.root).catch(() => null)
      return {
        selection: {
          root: binding.root,
          source: 'session',
          title: binding.title,
          created_at: binding.project_created_at,
        },
        bound: true,
        ...(inspection === null ? {} : { state: inspection.state }),
      }
    }
    try {
      return { selection: await this.resolveRoot(undefined), bound: false }
    } catch (error) {
      return { selection: null, bound: false, error: errorMessage(error) }
    }
  }

  /** Explicitly switch this session; failure leaves the old binding untouched. */
  async useProject(input: { target: string }): Promise<{
    selection: Selection
    title: string
    created_at: string
  }> {
    const caller = this.caller()
    if (caller?.sessionId === undefined) {
      throw new EngineInputError(
        ERROR_CODES.CONFIG_INVALID,
        'useProject requires an Agent session',
        'run /novel use from an Agent conversation',
      )
    }
    const target = input.target.trim().replace(/^(["'])(.*)\1$/u, '$2')
    if (target === '') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'use requires a path, title or "."')
    }
    let root: string | undefined
    if (target === '.') {
      if (caller.cwd === undefined || caller.cwd === '') {
        throw new EngineInputError(
          ERROR_CODES.CONFIG_INVALID,
          'use "." requires a working directory',
          'run the command from a project workspace, or pass an explicit path',
        )
      }
      const found = await discoverWorkspace(caller.cwd)
      if (found.kind === 'many') {
        throw ambiguousError(found.roots.map((candidate) => ({ root: candidate })))
      }
      if (found.kind === 'none') throw projectNotFoundError(caller.cwd)
      root = found.root
    } else {
      const candidate = resolve(caller.cwd ?? process.cwd(), target)
      const inspection = await inspectProject(candidate).catch(() => null)
      if (inspection !== null && inspection.state !== 'not-project' && inspection.state !== 'missing') {
        root = candidate
      } else {
        const document = await this.registry().read()
        const matches = document.projects.filter((entry) => entry.title === target)
        if (matches.length > 1) {
          throw new EngineInputError(
            ERROR_CODES.PROJECT_AMBIGUOUS,
            `multiple registered projects are named "${target}":\n${describeCandidates(matches)}`,
            'use the full project path instead of the title',
          )
        }
        root = matches[0]?.root
      }
    }
    if (root === undefined) {
      throw new EngineInputError(
        ERROR_CODES.PROJECT_NOT_FOUND,
        `no registered project or readable directory matches "${target}"`,
        'run /novel projects or /novel scan to see available projects',
      )
    }
    const selection: Selection = { root, source: 'explicit' }
    const snapshot = await this.loadAt(selection)
    this.assertProjectHealthy(snapshot, 'novel_use')
    await this.bindSelection(snapshot.root, snapshot.project.title, snapshot.project.created_at, 'command')
    // /novel use is an explicit project choice; make it visible in the panel
    // and project list just like an explicit project_root read.
    await this.autoRegister(snapshot)
    return {
      selection: {
        root: snapshot.root,
        source: 'explicit',
        title: snapshot.project.title,
        created_at: snapshot.project.created_at,
      },
      title: snapshot.project.title,
      created_at: snapshot.project.created_at,
    }
  }

  /** Clear only this session's choice; never touches a project or registry row. */
  async unbindProject(): Promise<{ cleared: boolean }> {
    const caller = this.caller()
    if (caller?.sessionId === undefined) {
      throw new EngineInputError(
        ERROR_CODES.CONFIG_INVALID,
        'unbindProject requires an Agent session',
        'run /novel unbind from an Agent conversation',
      )
    }
    const result = await this.withMetadataLock(() => this.bindings().clear(caller.sessionId!))
    return { cleared: result.changed }
  }

  /**
   * Import one ledger from a settings pack. Always previews with a diff; a
   * dry run never writes, and an apply is a normal transaction.
   */
  async importPack(input: {
    kind: 'characters' | 'world' | 'foreshadows' | 'relationships' | 'timeline'
    content: unknown
    dryRun?: boolean
    root?: string
  }): Promise<OpResult<{ kind: string; preview: string; applied: boolean }>> {
    const document = narrow(input.kind, input.content)
    const snapshot = await this.load(input.root)
    const current = (snapshot[input.kind] ?? {}) as unknown as Record<string, unknown>
    const preview = diffLines(yaml(current), yaml(document))
      .hunks.filter((hunk) => hunk.kind !== 'same')
      .map((hunk) => `${hunk.kind === 'add' ? '+' : '-'} ${hunk.line}`)
      .join('\n')
    if (input.dryRun === true) {
      return {
        data: { kind: input.kind, preview, applied: false },
        revision: snapshot.pipeline.revision,
        warnings: [],
      }
    }
    if (!Object.hasOwn(STATE_FILES, input.kind)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `unknown state document "${String(input.kind)}"`,
        `allowed documents: ${Object.values(STATE_FILES).join(', ')}`,
      )
    }
    const path = joinRel(STATE_DIR, STATE_FILES[input.kind])
    const result = await this.mutate({
      root: input.root,
      op: 'amend',
      key: () => `import:${input.kind}:${sha256(stableJson(input.content))}`,
      run: async (fresh, context) => {
        if (fresh.pipeline.revision !== snapshot.pipeline.revision) {
          throw new EngineFaultError(
            ERROR_CODES.TXN_ABORTED,
            `${input.kind} import was prepared against revision ${snapshot.pipeline.revision}, but the project is now at ${fresh.pipeline.revision}`,
            're-run the import against the current project; nothing was written',
          )
        }
        const problems = amendProblems(input.kind, fresh[input.kind], document, fresh, path)
        if (problems.length > 0) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `import would break a state invariant: ${problems.join('; ')}`,
            'fix the pack or the referencing ledgers; nothing was written',
          )
        }
        const nextPipeline = pipelineWith(fresh, context.revision, {
          last_action: action('novel_import', this.now(), shortDigest(input.kind)),
        })
        return {
          files: [
            { path, text: yaml(document) },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
          backup: true,
          data: { kind: input.kind, preview, applied: true },
        }
      },
    })
    return result
  }

  /* ---------------------------------------------------------------- internals */

  /**
   * Planning writes use project targets as invariants. The fallback project is
   * only for reads; writing against its null target (or default word range)
   * would create a document the real novel.yaml rejects after repair.
   */
  private assertProjectReadable(snapshot: Snapshot, operation: string): void {
    if (snapshot.projectError === null) return
    throw new EngineFaultError(
      ERROR_CODES.SCHEMA_INVALID,
      `${PROJECT_FILE} is unreadable; ${operation} cannot safely enforce the project targets`,
      `read ${PROJECT_FILE} with novel_state {kind:"novel"} and repair it with novel_amend before ${operation}`,
    )
  }

  /**
   * Planning documents are read-only inputs to the write tools. A corrupt file
   * must be repaired explicitly with novel_amend; allowing a normal write to
   * proceed would silently replace every planned card or worldbook section it
   * could not read.
   */
  private assertPlanningDocumentReadable(
    snapshot: Snapshot,
    kind: 'outline' | 'worldbook',
    operation: string,
  ): void {
    const error = kind === 'outline' ? snapshot.outlineError : snapshot.worldbookError
    if (error === null) return
    const path = kind === 'outline' ? OUTLINE_FILE : WORLDBOOK_FILE
    throw new EngineFaultError(
      ERROR_CODES.SCHEMA_INVALID,
      `${path} is unreadable; ${operation} would overwrite the unreadable planning document`,
      `read ${path} with novel_state and repair it with novel_amend before ${operation}`,
    )
  }

  /**
   * `strict_explicit` is an internal provenance bit, not an author choice.
   * Exposing it lets a caller forge "the author chose strict:false" without
   * going through the strict option. Stored documents may still contain it.
   */
  private assertPublicBookHasNoStrictExplicit(book: unknown, operation: string): void {
    if (typeof book !== 'object' || book === null || Array.isArray(book)) return
    if (Object.hasOwn(book, 'strict_explicit')) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `${operation} cannot set book.strict_explicit`,
        'use the public strict boolean; strict_explicit is an internal provenance marker',
      )
    }
  }

  /**
   * An import is a full replacement, unlike novel_outline's keyed upsert. It
   * must not silently lose the active card while strict mode still requires it.
   */
  private assertActiveCardPreserved(
    snapshot: Snapshot,
    chapters: readonly { num: number }[],
    operation: string,
  ): void {
    const chapter = snapshot.pipeline.chapter
    if (!snapshot.outline.chapters.some((card) => card.num === chapter)) return
    if (chapters.some((card) => card.num === chapter)) return
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `${operation} cannot remove the active chapter ${chapter} card`,
      'include the active card in the imported outline; import replaces the whole plan and cannot remove an in-flight card',
    )
  }

  /**
   * The outline is a derived progress view and the PG-13 input. Every write
   * path must stage a document the loader will accept; otherwise a successful
   * archive/planning call can leave the project with an unreadable outline and
   * an unreachable repair path. Auto-created cards are normalized by book.ts;
   * this is the final fail-closed boundary for all callers.
   */
  private assertOutlineWritable(snapshot: Snapshot, outline: OutlineDocument, operation: string): void {
    try {
      validateOutlineDocument(outline, {
        titleRule: this.rulepack.format.title,
        totalChapters: snapshot.project.targets.total_chapters,
      })
    } catch (error) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_INVALID,
        `${operation} would write an invalid ${OUTLINE_FILE}: ${errorMessage(error)}`,
        `repair the stale card or archived chapter data before retrying; nothing was written`,
        { cause: error },
      )
    }
  }

  /**
   * total_chapters is a hard ceiling everywhere: outline cards already enforce
   * it, and writing/archiving a chapter past it would make the auto-created
   * archived card invalid. Fail at the first stage instead of after the draft.
   */
  private assertChapterWithinTarget(snapshot: Snapshot, chapter: number, operation: string): void {
    const target = snapshot.project.targets.total_chapters
    if (target === null || chapter <= target) return
    throw new EngineInputError(
      ERROR_CODES.STAGE_ORDER,
      `${operation} cannot start chapter ${chapter}; targets.total_chapters is ${target}`,
      'raise targets.total_chapters with novel_amend, or export the completed book instead of starting another chapter',
    )
  }

  /**
   * Without the chapter index, normalizeOutlineChapters cannot re-add archived
   * cards and cannot prove that a replacement did not delete them. Planning
   * writes must wait for a chapters repair; only novel_amend may repair it.
   */
  private assertArchiveIndexReadable(snapshot: Snapshot, operation: string): void {
    if (!snapshot.ledgerErrors.some((error) => error.code === 'CHAPTERS_UNREADABLE')) return
    throw new EngineFaultError(
      ERROR_CODES.SCHEMA_INVALID,
      `state/${STATE_FILES.chapters} is unreadable; ${operation} cannot preserve archived outline cards`,
      `repair state/${STATE_FILES.chapters} with novel_amend before ${operation}`,
    )
  }

  private bookStatus(snapshot: Snapshot): NonNullable<StatusReport['book']> {
    const summary = outlineSummary(
      snapshot.outline,
      snapshot.chapters.chapters.length,
      snapshot.project.targets.total_chapters,
      snapshot.chapters.chapters.map((record) => record.num),
    )
    const counts = worldbookCounts(snapshot.worldbook)
    return {
      premise: snapshot.outline.book.premise,
      logline: snapshot.outline.book.logline,
      strict: snapshot.outline.book.strict,
      outline: {
        present: snapshot.outlinePresent && summary.present,
        target: summary.target,
        total: summary.total,
        planned: summary.planned,
        archived: summary.archived,
        missing_cards: summary.missingCards,
        planned_coverage: summary.plannedCoverage,
        archived_coverage: summary.archivedCoverage,
        coverage: summary.coverage,
        card_coverage: summary.cardCoverage,
        volumes: summary.volumes,
        current: outlineCard(snapshot.outline, snapshot.pipeline.chapter),
      },
      worldbook: {
        present: snapshot.worldbookPresent && counts.present,
        characters: counts.characters,
        locations: counts.locations,
        factions: counts.factions,
        rules: counts.rules,
        glossary: counts.glossary,
        backstory: counts.backstory,
        facts: counts.facts,
      },
    }
  }

  private panelReviewKey(snapshot: Snapshot): Promise<string> {
    const cached = this.reviewKeyCache.get(snapshot)
    if (cached !== undefined) return cached
    const pending = (async (): Promise<string> => {
      const store = this.storeFor(snapshot.root)
      const names = await store.list('reviews')
      const files = await Promise.all(
        names.map(async (name) => {
          const stat = await store.stat(`reviews/${name}`)
          return [name, stat === null ? null : [stat.size, Math.round(stat.mtimeMs)]] as const
        }),
      )
      return sha256(stableJson(files))
    })()
    this.reviewKeyCache.set(snapshot, pending)
    return pending
  }

  private panelJournalIdentity(snapshot: Snapshot): Promise<{
    key: string
    journal: Awaited<ReturnType<typeof readJournal>>
    blocking: BlockingItem[]
  }> {
    const cached = this.journalCache.get(snapshot)
    if (cached !== undefined) return cached
    const pending = (async () => {
      const journal = await readJournal(this.storeFor(snapshot.root))
      const journalBlocking = await this.journalBlocking(snapshot)
      const tail = journal.rows[journal.rows.length - 1]
      const key = sha256(
        stableJson({
          rows: journal.rows.length,
          tail: tail === undefined ? null : [tail.seq, tail.at, tail.status],
          blocking: journalBlocking,
        }),
      )
      return { key, journal, blocking: journalBlocking }
    })()
    this.journalCache.set(snapshot, pending)
    return pending
  }

  private async panelSnapshot(
    root?: string,
    options: { includeQuality?: boolean; snapshot?: Snapshot } = {},
  ): Promise<PanelSnapshot> {
    // The panel is a read-only projection. Use loadAt rather than load() so an
    // explicit query root or a workspace fallback can never write a session
    // binding or auto-register a project as a side effect of viewing it.
    const snapshot = options.snapshot ?? (await this.loadAt(await this.resolveRoot(root)))
    const includeQuality = options.includeQuality !== false
    const archived = snapshot.chapters.chapters
    const archivedCurrent = archived.some((chapter) => chapter.num === snapshot.pipeline.chapter)
    const target = snapshot.project.targets.total_chapters
    const progress = projectChapterProgress({
      activeChapter: snapshot.pipeline.chapter,
      stage: snapshot.pipeline.stage,
      archived: archived.map((record) => record.num),
      target,
    })
    const finished = progress.finished
    const draftWords =
      snapshot.text === null || archivedCurrent || snapshot.pipeline.stage === 'done'
        ? 0
        : countWordMetrics(snapshot.text).total_word_count
    const archivedWords = archived.reduce((total, chapter) => total + chapter.word_count, 0)
    const pending = await inspectPending(this.storeFor(snapshot.root))
    const stateErrorCount = this.stateErrors(snapshot).length
    // Journal health and activity are part of the panel read model. Hashing the
    // journal identity into the cache key prevents an external ledger edit or a
    // fresh append from serving a stale "health.ok" card after the underlying
    // status already reports a mismatch.
    const journalIdentity = await this.panelJournalIdentity(snapshot)
    const journalKey = journalIdentity.key
    const journal = journalIdentity.journal
    const journalBlocking = journalIdentity.blocking
    const reviewKey = includeQuality ? await this.panelReviewKey(snapshot) : ''
    const panelCacheKey = `${snapshot.root}:${snapshot.pipeline.revision}:${pending.state}:${stateErrorCount}:${
      snapshot.outlineError ?? ''
    }:${snapshot.worldbookError ?? ''}:${JSON.stringify(snapshot.briefs)}:${journalKey}:${reviewKey}:${
      includeQuality ? 'full' : 'base'
    }`
    const cachedPanel = this.panelCache.get(snapshot.root)
    if (cachedPanel?.key === panelCacheKey) return cachedPanel.snapshot
    const outline = outlineSummary(
      snapshot.outline,
      archived.length,
      target,
      archived.map((record) => record.num),
    )
    const counts = worldbookCounts(snapshot.worldbook)
    const scores = archived.slice(-10).map((chapter) => chapter.score)
    const blocking = [...this.effectiveBlocking(snapshot), ...journalBlocking]
    const healthBlocking = blocking.length
    const book = {
      premise: snapshot.outline.book.premise,
      logline: snapshot.outline.book.logline,
      strict: snapshot.outline.book.strict,
      target,
      outline: {
        present: snapshot.outlinePresent && outline.present,
        target: outline.target,
        total: outline.total,
        planned: outline.planned,
        archived: outline.archived,
        missing_cards: outline.missingCards,
        planned_coverage: outline.plannedCoverage,
        archived_coverage: outline.archivedCoverage,
        coverage: outline.coverage,
        card_coverage: outline.cardCoverage,
        volumes: snapshot.outline.volumes.map((volume) => {
          const cards = snapshot.outline.chapters.filter(
            (card) => card.num >= volume.start_chapter && card.num <= volume.end_chapter,
          )
          return {
            title: volume.title,
            start: volume.start_chapter,
            end: volume.end_chapter,
            planned: cards.filter((card) => card.status === 'planned').length,
            archived: cards.filter((card) => card.status === 'archived').length,
          }
        }),
      },
      worldbook: {
        present: snapshot.worldbookPresent && counts.present,
        characters: counts.characters,
        locations: counts.locations,
        factions: counts.factions,
        rules: counts.rules,
        glossary: counts.glossary,
        backstory: counts.backstory,
        facts: counts.facts,
      },
    }
    const qualityScores = scores.slice(-5)
    const previousScores = scores.slice(-10, -5)
    // Match report()'s sample definition: an archived chapter with a readable
    // final review file. An existing but malformed file is not a sample; the
    // report surfaces the parse error, and the panel must not claim a sample it
    // cannot read. Reading only the names would make deleted and corrupt
    // reviews look identical in the two surfaces.
    const store = this.storeFor(snapshot.root)
    const currentReviews: import('../types.js').ReviewDocument[] = []
    let samples = 0
    let attempts = 0
    let effort: ReturnType<EngineService['effortProjection']> | undefined
    if (includeQuality) {
      const reviewNames = new Set(await store.list(REVIEW_DIR))
      const sampleChapters = new Set<number>()
      for (const record of archived) {
        const name = reviewFile(record.num).slice(`${REVIEW_DIR}/`.length)
        if (!reviewNames.has(name)) continue
        try {
          const review = await store.readDoc(reviewFile(record.num), 'review')
          if (review !== null) {
            sampleChapters.add(record.num)
            currentReviews.push(review as unknown as import('../types.js').ReviewDocument)
          }
        } catch {
          // Keep the panel count aligned with report()'s readable-review count.
        }
      }
      samples = sampleChapters.size
      const archivedChapterNums = new Set(archived.map((record) => record.num))
      const attemptCounts = await this.reviewAttemptsByChapter(
        store,
        journal.rows,
        [...archivedChapterNums],
        sampleChapters,
      )
      // Same projection as report(): attempts is the lifetime review count.
      effort = this.effortProjection(snapshot.chapters, journal.rows, attemptCounts)
      attempts = effort.lifetime.reviews
    }
    const qualityTrendBasis =
      samples < 3
        ? ('insufficient_samples' as const)
        : previousScores.length < 5
          ? ('insufficient_history' as const)
          : ('last_five_vs_previous_five' as const)
    const quality = {
      // Book-wide average; the last-ten window has its own field.
      averageScore:
        archived.length === 0
          ? 0
          : archived.reduce((total, chapter) => total + chapter.score, 0) / archived.length,
      last_ten_average:
        scores.length === 0 ? null : scores.reduce((total, score) => total + score, 0) / scores.length,
      scores,
      trend:
        qualityTrendBasis === 'last_five_vs_previous_five'
          ? Math.round(
              (qualityScores.reduce((total, score) => total + score, 0) / qualityScores.length -
                previousScores.reduce((total, score) => total + score, 0) / previousScores.length) *
                10,
            ) / 10
          : null,
      trend_basis: qualityTrendBasis,
      samples,
      attempts,
    }
    // A check is evidence only for the exact manuscript version it hashed. A
    // later revision leaves the old advisories in checks/*.yaml; showing them
    // as current would invite an acknowledge that no longer applies.
    const checkCurrent =
      snapshot.check !== null &&
      snapshot.text !== null &&
      snapshot.check.content_hash === sha256(snapshot.text)
    const acknowledgedCodes = checkCurrent ? (snapshot.check?.acknowledged ?? []) : []
    const advisoryFindings: AckedFinding[] = checkCurrent
      ? ((snapshot.check?.machine.acknowledged_findings ??
          snapshot.check?.acknowledged_findings ??
          []) as AckedFinding[])
      : []
    const currentAdvisories = checkCurrent ? dedupeAdvisories(snapshot.check?.machine.advisories ?? []) : []
    const ackChapter = snapshot.pipeline.chapter
    const liveAckIds = new Set(
      advisoryFindings
        .filter(
          (finding) => finding.expires_at_chapter === undefined || ackChapter <= finding.expires_at_chapter,
        )
        .map((finding) => finding.id),
    )
    // Count exactly what novel_check counts: a code covers every instance, a
    // finding id covers one. The panel used to ignore instance ids entirely, so
    // a per-instance acknowledgement never changed the UI (X12).
    let acknowledgedAdvisories = 0
    for (const violation of currentAdvisories) {
      if (acknowledgedCodes.includes(violation.code)) {
        acknowledgedAdvisories += violation.instances?.length ?? 1
        continue
      }
      const instances = violation.instances ?? []
      if (instances.length > 0) {
        acknowledgedAdvisories += instances.filter((instance) => liveAckIds.has(instance.id)).length
      } else if (violation.id !== undefined && liveAckIds.has(violation.id)) {
        acknowledgedAdvisories += 1
      }
    }
    const advisories = currentAdvisories
      .filter(
        (violation) => !advisoryAcknowledged(violation, acknowledgedCodes, advisoryFindings, ackChapter),
      )
      .map((violation) => ({
        code: violation.code,
        detail: violation.detail,
        hint:
          violation.location.paragraph !== undefined
            ? `第 ${violation.location.paragraph} 段`
            : `${violation.location.ledger ?? '台账'}${violation.location.entity === undefined ? '' : ` · ${violation.location.entity}`}`,
        instances: violation.instances?.length ?? 1,
      }))
    const legacy = await this.legacyIssues(snapshot, false)
    const activity = journal.rows
      .filter((row) => row.op !== 'lock_reclaimed')
      .slice(-5)
      .map((row) => ({
        at: row.at,
        op: row.op,
        chapter: row.chapter,
        status: row.status,
      }))
    const draftMetrics = snapshot.text === null ? null : countWordMetrics(snapshot.text)
    const panelReport = buildBookReport({
      project: snapshot.project,
      outline: snapshot.outline,
      outlinePresent: snapshot.outlinePresent,
      outlineError: snapshot.outlineError,
      worldbook: snapshot.worldbook,
      worldbookPresent: snapshot.worldbookPresent,
      worldbookError: snapshot.worldbookError,
      world: snapshot.world,
      chapters: archived,
      characters: snapshot.characters,
      timeline: snapshot.timeline,
      foreshadows: snapshot.foreshadows,
      relationships: snapshot.relationships,
      reviews: currentReviews,
      activity: journal.rows.filter((row) => row.op !== 'lock_reclaimed').slice(-8),
      journal: journal.rows,
      reviewAttempts: attempts,
      ...(effort === undefined
        ? {}
        : {
            effortProjection: {
              basis: effort.basis,
              chapters: [...effort.chapters.entries()].map(([num, row]) => ({ num, ...row })),
            },
            currentEffort: {
              chapter: snapshot.pipeline.chapter,
              reviews: snapshot.pipeline.rounds.review,
              revisions: snapshot.pipeline.rounds.revise,
              checks: snapshot.pipeline.rounds.check,
              rollbacks: 0,
            },
          }),
      finalChecks: Object.fromEntries(
        archived
          .filter((record) => record.final_check === 'pass' || record.final_check === 'fail')
          .map((record) => [record.num, record.final_check!]),
      ),
      targetChapters: target,
      minScore: this.config.quality.minScore,
      dimensionMax: Object.fromEntries(
        this.rulepack.quality.dimensions.map((dimension) => [dimension.id, dimension.max]),
      ),
      foreshadowDormantAfter: this.rulepack.crosschapter.foreshadow_dormant_after,
    })
    if (!includeQuality) {
      const baseScores = archived.map((chapter) => chapter.score)
      const sorted = [...baseScores].sort((left, right) => left - right)
      const middle = Math.floor(sorted.length / 2)
      const median =
        sorted.length === 0
          ? 0
          : sorted.length % 2 === 0
            ? (sorted[middle - 1]! + sorted[middle]!) / 2
            : sorted[middle]!
      panelReport.quality = {
        ...panelReport.quality,
        average:
          baseScores.length === 0
            ? 0
            : baseScores.reduce((total, score) => total + score, 0) / baseScores.length,
        median,
        min: baseScores.length === 0 ? 0 : Math.min(...baseScores),
        max: baseScores.length === 0 ? 0 : Math.max(...baseScores),
        last_five: baseScores.slice(-5),
        trend: null,
        trend_basis: 'insufficient_samples',
        samples: 0,
        attempts: 0,
        dimensions: [],
      }
    }
    const panelStylepack = this.stylepackFor(snapshot.project)
    // Computed once and carried by the bundle: the overview tab renders from
    // `bookData`, so a copy in the overview *section* was data nobody fetched.
    const panelStyleOverview = this.styleOverview(snapshot)
    const bookData = buildPanelBookData({
      report: panelReport,
      project: snapshot.project,
      worldbook: snapshot.worldbook,
      world: snapshot.world,
      outline: snapshot.outline,
      outlinePresent: snapshot.outlinePresent,
      worldbookPresent: snapshot.worldbookPresent,
      currentChapter: snapshot.pipeline.chapter,
      stage: snapshot.pipeline.stage,
      rounds: snapshot.pipeline.rounds,
      draftWords,
      lastTenAverage:
        scores.length === 0 ? null : scores.reduce((total, score) => total + score, 0) / scores.length,
      manuscriptHash:
        snapshot.pipeline.draft?.content_hash ?? (snapshot.text === null ? null : sha256(snapshot.text)),
      metrics: draftMetrics,
      stateErrors: this.stateErrors(snapshot).map((error) => ({
        path: error.path,
        code: error.code,
        message: error.message,
      })),
      pending:
        pending.state === 'none'
          ? null
          : { state: pending.state, txid: pending.txid ?? '', detail: pending.detail ?? '' },
      outlineError: snapshot.outlineError,
      worldbookError: snapshot.worldbookError,
      // 0.2.17: one pack resolution per panel snapshot, reused by identity and
      // the overview card so the two cannot name different styles. Metrics are
      // measured directly — re-running the whole machine pass here would be a
      // second, possibly different, evaluation.
      style: panelStylepack,
      styleMetrics:
        panelStylepack === null || snapshot.text === null
          ? null
          : measureStyle(snapshot.text, panelStylepack, styleVocabulary(this.rulepack)),
      styleVerdict:
        panelStylepack === null
          ? null
          : {
              verdict:
                panelStyleOverview.verdict === 'pass'
                  ? 'pass'
                  : panelStyleOverview.verdict === 'attention'
                    ? 'attention'
                    : 'no-draft',
              findings: panelStyleOverview.findings,
            },
    })
    const draft =
      archivedCurrent || snapshot.pipeline.stage === 'done'
        ? null
        : {
            num: snapshot.pipeline.chapter,
            title: stripTitlePrefix(snapshot.plan?.title ?? '') || `第${snapshot.pipeline.chapter}章`,
            wordCount: draftWords,
            score: snapshot.review?.total ?? null,
            status: (blocking.length > 0 ? 'blocked' : 'draft') as 'blocked' | 'draft',
            details: (snapshot.pipeline.draft?.summary?.events ?? []).join('；').slice(0, 240),
          }
    const result: PanelSnapshot = {
      root: snapshot.root,
      title: snapshot.project.title,
      genre: snapshot.project.genre,
      platform: snapshot.project.platform,
      chapter: snapshot.pipeline.chapter,
      stage: snapshot.pipeline.stage,
      progress,
      revision: snapshot.pipeline.revision,
      rounds: snapshot.pipeline.rounds,
      blocking,
      ...(snapshot.handoff === null
        ? {}
        : (() => {
            const position = projectHandoff(snapshot.handoff, snapshot.pipeline.chapter)
            return {
              volume: position.volume,
              volume_name: position.volume_name,
              act: position.act,
              act_progress: position.act_progress,
            }
          })()),
      next: finished
        ? undefined
        : journalBlocking.length > 0 && this.stateErrors(snapshot).length === 0
          ? {
              tool: 'novel_audit',
              args: {},
              reason: `${journalBlocking[0]!.code}: ${journalBlocking[0]!.detail}; inspect and restore before the next write`,
            }
          : this.nextStep(snapshot),
      finished,
      chapters: archived,
      draft,
      totalWords: archivedWords + draftWords,
      archivedWords,
      draftWords,
      averageScore:
        archived.length === 0
          ? 0
          : archived.reduce((total, chapter) => total + chapter.score, 0) / archived.length,
      phases: phaseStrip(snapshot.pipeline.stage, finished),
      book,
      bookData,
      quality,
      health: {
        ok: healthBlocking === 0 && stateErrorCount === 0 && pending.state === 'none',
        blocking: healthBlocking,
        stateErrors: stateErrorCount,
        pending: pending.state !== 'none',
      },
      activity,
      ...(advisories.length === 0 ? {} : { advisories }),
      ...(acknowledgedAdvisories === 0 ? {} : { acknowledgedAdvisories }),
      ...(legacy.length === 0 ? {} : { legacy }),
      ...(pending.state === 'none'
        ? {}
        : {
            pending: {
              state: pending.state,
              txid: pending.txid ?? '',
              detail: pending.detail ?? '',
            },
          }),
    }
    this.panelCache.set(snapshot.root, { key: panelCacheKey, snapshot: result })
    if (this.panelCache.size > 16) {
      const oldest = this.panelCache.keys().next().value
      if (oldest !== undefined) this.panelCache.delete(oldest)
    }
    return result
  }

  /**
   * The archive stage can be left by a direct revision (the 0.2.3 workflow) or
   * by rollback. Evaluate the same gates as archive so status/panel do not
   * recommend an operation that will immediately fail; when the failure is
   * prose-level, `nextStep` recommends the direct P5 revision instead.
   */
  private archivePreflight(
    snapshot: Snapshot,
  ): { item: BlockingItem; to_stage: RollbackSubmission['toStage']; revisionable: boolean } | null {
    if (snapshot.pipeline.stage !== 'ready_to_archive') return null
    const text = snapshot.text ?? ''
    const gateResult = evaluateGates(
      this.gateInput(snapshot, 'archiveChapter', {
        briefStage: 'P8',
        proof: snapshot.review?.proof ?? null,
      }),
      { rulepack: this.rulepack, minScore: this.config.quality.minScore },
    )
    if (!gateResult.passed) {
      // PG-01 says "re-sign the brief"; it is never the first thing to repair
      // when a content gate already fails on the same manuscript. Surface the
      // content problem so the advice is "revise", not "fetch P8 again".
      const ordered = [...gateResult.blocking].sort(
        (left, right) => Number(left.code === 'PG-01') - Number(right.code === 'PG-01'),
      )
      const first = ordered[0]!
      const target: RollbackSubmission['toStage'] =
        first.code === 'PG-03' || first.code === 'PG-04' || first.code === 'PG-05' || first.code === 'PG-06'
          ? 'P3'
          : first.code === 'PG-07' || first.code === 'PG-08' || first.code === 'PG-09'
            ? 'P4'
            : first.code === 'PG-11'
              ? 'P4'
              : 'P6'
      const revisionable = ['PG-03', 'PG-04', 'PG-05', 'PG-06', 'PG-07', 'PG-08', 'PG-09'].includes(
        first.code,
      )
      return {
        item: { ...first, scope: first.scope ?? 'archive' },
        to_stage: target,
        revisionable,
      }
    }
    const draft = snapshot.pipeline.draft
    if (
      draft !== undefined &&
      (draft.chapter !== snapshot.pipeline.chapter || draft.content_hash !== sha256(text))
    ) {
      return {
        item: {
          code: 'DRAFT_STALE',
          scope: 'archive',
          detail: 'the manuscript or active chapter no longer matches its draft summary',
          hint: 'fetch novel_brief P5, then novel_revise to repair the summary and re-run P4/P6; rollback only if the plan fields themselves must change',
        },
        to_stage: 'P3',
        revisionable: true,
      }
    }
    const summary = snapshot.plan?.summary ?? null
    const machine = this.machine(snapshot, text, { summary })
    const blockers = machine.violations.filter((violation) => violation.severity === 'blocker')
    if (blockers.length > 0) {
      return {
        item: {
          code: blockers[0]!.code,
          scope: 'archive',
          detail: `${blockers.length} machine blocker(s) remain; first: ${blockers[0]!.detail}`,
          hint: 'fetch novel_brief P5 and use novel_revise; rollback to P3 only if the plan fields need rewriting',
        },
        to_stage: 'P3',
        revisionable: true,
      }
    }
    const semantic = evaluateSemantic(
      text,
      Array.isArray(snapshot.check?.semantic.items) ? snapshot.check.semantic.items : [],
    )
    if (semantic.failed) {
      return {
        item: {
          code: semantic.blocking[0]?.code ?? 'SEMANTIC_CHECK_FAILED',
          scope: 'archive',
          detail: `${semantic.blocking.length} semantic check item(s) fail`,
          hint: 'fetch novel_brief P5 and revise, then re-run novel_check; rollback to P6 only if the revision cannot repair the evidence',
        },
        to_stage: 'P6',
        revisionable: true,
      }
    }
    return null
  }

  private nextStep(snapshot: Snapshot): StatusReport['next'] {
    const stage = snapshot.pipeline.stage
    const chapter = snapshot.pipeline.chapter
    const progress = projectChapterProgress({
      activeChapter: chapter,
      stage,
      archived: snapshot.chapters.chapters.map((record) => record.num),
      target: snapshot.project.targets.total_chapters,
    })
    const activeIndexed = snapshot.chapters.chapters.some((record) => record.num === chapter)
    if (activeIndexed) {
      return {
        tool: 'novel_amend',
        args: { path: joinRel(STATE_DIR, STATE_FILES.chapters) },
        reason: `chapter ${chapter} is the active chapter but is already in the index; read novel_state {kind:"chapters", include_summary:true}, remove it with novel_amend, then continue`,
      }
    }
    if (this.stateErrors(snapshot).length > 0) {
      const recovery = this.recoveryFor(snapshot)
      if (recovery.tool === 'novel_amend') return recovery
      const target = recovery.args.to_stage as RollbackSubmission['toStage']
      // Once rollback has reached its target, the normal stage tool is the
      // repair path (plan_chapter at P2, review at P4, check at P6). Pointing at
      // the same rollback forever would be a loop.
      if (STAGE_RANK[ROUND_TRANSITIONS[target]] < STAGE_RANK[stage]) return recovery
    }
    const reviewDigest = this.reviewDigestProblem(snapshot)
    if (reviewDigest !== null) {
      return {
        tool: 'novel_rollback',
        args: { chapter, to_stage: 'P4' },
        reason: `${reviewDigest.code}: ${reviewDigest.detail}; ${reviewDigest.hint}`,
      }
    }
    const targetLimit = snapshot.project.targets.total_chapters
    if (targetLimit !== null && chapter > targetLimit && snapshot.chapters.chapters.length >= targetLimit) {
      return {
        tool: 'novel_export',
        args: { kind: 'epub' },
        reason: `已归档 ${snapshot.chapters.chapters.length} 章，达到目标 ${targetLimit} 章；先导出成书，若要继续写请用 novel_amend 提高 targets.total_chapters`,
      }
    }
    const outlineMismatch = this.outlineGateBlock(snapshot)
    if (outlineMismatch !== null && outlineCard(snapshot.outline, chapter) !== null) {
      if (stage === 'P3') {
        return {
          tool: 'novel_rollback',
          args: { chapter, to_stage: 'P2' },
          reason: `${outlineMismatch.code}: ${outlineMismatch.detail}; ${outlineMismatch.hint}`,
        }
      }
      const plan = snapshot.plan
      const chapters =
        plan === null
          ? snapshot.outline.chapters.map((card) => ({ ...card }))
          : snapshot.outline.chapters.map((card) =>
              card.num === chapter
                ? {
                    ...card,
                    title: stripChapterPrefix(plan.title),
                    scene_type: plan.scene_type,
                    target_words: plan.target_words,
                    cast: (plan.cast ?? []).map((member) => member.name),
                  }
                : { ...card },
            )
      return {
        tool: 'novel_outline',
        args: { chapters },
        reason: `${outlineMismatch.code}: ${outlineMismatch.detail}; args 已将当前章卡对齐到 P2 计划，确认后提交 novel_outline`,
      }
    }
    const step = STAGE_NEXT[stage]
    if (progress.finished) {
      return {
        tool: 'novel_export',
        args: { kind: 'epub' },
        reason: '全书已完成；可导出成书，或结束本书',
      }
    }
    if (
      snapshot.outline.book.strict &&
      outlineCard(snapshot.outline, chapter) === null &&
      (stage === 'idle' ||
        stage === 'done' ||
        stage === 'P2' ||
        stage === 'P3' ||
        stage === 'P4' ||
        stage === 'P5' ||
        stage === 'P6' ||
        stage === 'ready_to_archive')
    ) {
      const chapters = snapshot.outline.chapters.map((card) => ({ ...card }))
      if (!chapters.some((card) => card.num === chapter)) {
        chapters.push({
          num: chapter,
          volume: null,
          title: '待定章卡',
          scene_type: '日常过渡章',
          goal: '待补充目标',
          conflict: '待补充冲突',
          hook: '待补充钩子',
          cast: [],
          target_words: snapshot.project.targets.words_per_chapter,
          notes: '',
          status: 'planned',
          archived_at: null,
          word_count: null,
          score: null,
        })
        chapters.sort((left, right) => left.num - right.num)
      }
      return {
        tool: 'novel_outline',
        args: { chapters },
        reason: `严格大纲模式下第 ${chapter} 章还没有章卡；args 已带现有全部章卡和一张待定卡，补齐标题/场景/目标/冲突/钩子后提交 novel_outline`,
      }
    }
    const roundsBlock = this.roundsLimitBlock(snapshot)
    if (roundsBlock !== null) {
      return {
        tool: 'novel_rollback',
        args: { chapter, to_stage: 'P4' },
        reason: `${roundsBlock.code}: ${roundsBlock.detail}; ${roundsBlock.hint ?? ''}`.trim(),
      }
    }
    const first = this.effectiveBlocking(snapshot)[0]
    const detail =
      first === undefined
        ? ''
        : `${first.code}: ${first.detail}${first.hint === undefined ? '' : ` (${first.hint})`}`
    // Every stage that consumes a task book must see a brief whose digest
    // matches the current snapshot. Presence alone is not enough: a failed
    // check, a revision round, or a state change makes an older brief stale,
    // and the next operation would fail PG-01 instead of advancing.
    // The archive preflight decides which brief is actually required: a
    // revisionable archive failure is repaired at P5, so asking for P8 first
    // would be a wasted round trip.
    const archive = this.archivePreflight(snapshot)
    const briefStage =
      stage === 'ready_to_archive' && archive !== null && archive.revisionable ? 'P5' : STATUS_BRIEF[stage]
    // After a failed check the next operation is a revision, not another
    // check; the reason must name the tool that will actually be legal after
    // the brief is refreshed.
    const followUp =
      (stage === 'P5' || stage === 'P6') && snapshot.pipeline.blocking.length > 0 ? 'novel_revise' : step.tool
    if (briefStage !== null && !this.briefIsCurrent(snapshot, briefStage)) {
      return {
        tool: 'novel_brief',
        args: { stage: briefStage, chapter },
        reason:
          detail === ''
            ? `fetch the ${briefStage} brief before ${followUp}`
            : `${detail}; fetch the ${briefStage} brief, then ${followUp}`,
      }
    }
    if (
      stage === 'P6' &&
      snapshot.check !== null &&
      snapshot.check.verdict === 'pass' &&
      (!snapshot.check.scope.includes('content') || !snapshot.check.scope.includes('integrity'))
    ) {
      return {
        tool: 'novel_check',
        args: this.nextArgs('P6', chapter),
        reason:
          'the last check covered only one scope; run novel_check without scope (content+integrity) to reach archive',
      }
    }
    if (stage === 'P6' && snapshot.checkError !== null) {
      return {
        tool: 'novel_check',
        args: this.nextArgs('P6', chapter),
        reason: `CHECK_UNREADABLE@${checkFile(chapter)}; repair the check with novel_check before any stale revision blocker`,
      }
    }
    if (archive !== null) {
      // A prose/draft/semantic archive failure can be repaired through P5
      // without losing the plan. Rollback remains the fallback for structural
      // changes, but status must not keep steering the model to it forever.
      if (stage === 'ready_to_archive' && archive.revisionable && canRun(stage, 'submitRevision')) {
        return {
          tool: 'novel_brief',
          args: { stage: 'P5', chapter },
          reason: `${archive.item.code}: ${archive.item.detail}; fetch the P5 brief, then novel_revise (rollback to ${archive.to_stage} only if the plan fields themselves must change)`,
        }
      }
      return {
        tool: 'novel_rollback',
        args: { chapter, to_stage: archive.to_stage },
        reason: `${archive.item.code}: ${archive.item.detail}; ${archive.item.hint ?? ''}`.trim(),
      }
    }
    if (snapshot.pipeline.blocking.length > 0) {
      // Blocking at P5/P6 is cleared by a revision, not by another read. A
      // status tool that points at itself is a loop the model cannot escape.
      // The revision still needs its stage brief first; that branch is above.
      if (stage === 'P5' || stage === 'P6') {
        return {
          tool: 'novel_revise',
          args: { chapter },
          reason: `${detail}; fix it with novel_revise`,
        }
      }
      return { tool: step.tool, args: this.nextArgs(stage, chapter), reason: `${detail}; ${step.reason}` }
    }
    return { tool: step.tool, args: this.nextArgs(stage, chapter), reason: step.reason }
  }

  /** A computed blocker for the retry budget the next operation would consume. */
  private roundsLimitBlock(snapshot: Snapshot): BlockingItem | null {
    const stage = snapshot.pipeline.stage
    if (!['P4', 'P5', 'P6'].includes(stage)) return null
    const block = (counter: 'review' | 'revise' | 'check'): BlockingItem => ({
      code: 'PG-11',
      scope: 'rounds',
      detail: `round limit reached for ${counter} (review ${snapshot.pipeline.rounds.review}, revise ${snapshot.pipeline.rounds.revise}, check ${snapshot.pipeline.rounds.check})`,
      hint: 'call novel_rollback with to_stage P4; the manuscript is kept for reference',
    })
    if (stage === 'P4') {
      return roundsExhausted(snapshot.pipeline.rounds, 'review') ? block('review') : null
    }
    if (stage === 'P5') {
      return roundsExhausted(snapshot.pipeline.rounds, 'revise') ? block('revise') : null
    }
    // P6 has two possible next operations: a revision clears check blockers,
    // while a check is the only way to advance. If the check budget is spent
    // no revision can eventually archive, so it must roll back; if only the
    // revision budget is spent and blockers remain, the next revise is already
    // rejected and must roll back too.
    if (roundsExhausted(snapshot.pipeline.rounds, 'check')) return block('check')
    if (snapshot.pipeline.blocking.length > 0 && roundsExhausted(snapshot.pipeline.rounds, 'revise')) {
      return block('revise')
    }
    return null
  }

  /** Pipeline blockers plus budget exhaustion, so status/panel cannot say "all clear". */
  private effectiveBlocking(snapshot: Snapshot): BlockingItem[] {
    const state = this.stateErrors(snapshot).map((error) => ({
      code: 'STATE_UNREADABLE',
      scope: 'state',
      detail: `${error.code}: ${error.message}`,
      hint: this.recoveryFor(snapshot).reason,
    }))
    const activeIndexed = snapshot.chapters.chapters.some(
      (record) => record.num === snapshot.pipeline.chapter,
    )
    const active = activeIndexed
      ? [
          {
            code: 'ACTIVE_CHAPTER_INDEXED',
            scope: 'state',
            detail: `chapter ${snapshot.pipeline.chapter} is active but already exists in state/chapters.yaml`,
            hint: 'read the index with novel_state {kind:"chapters", include_summary:true}, remove the active row with novel_amend, then continue',
          },
        ]
      : []
    const extra = this.roundsLimitBlock(snapshot)
    const reviewDigest = this.reviewDigestProblem(snapshot)
    const archive = this.archivePreflight(snapshot)
    const outline = this.outlineGateBlock(snapshot)
    const base = [
      ...state,
      ...active,
      ...(archive === null ? [] : [archive.item]),
      ...(outline === null ? [] : [outline]),
      ...(reviewDigest === null ? [] : [reviewDigest]),
      ...snapshot.pipeline.blocking,
    ]
    if (extra === null) return base
    return base.some((item) => item.code === extra.code) ? base : [...base, extra]
  }

  /** The PG-13 block that status must show before P2/P3 even tries to write. */
  private outlineGateBlock(snapshot: Snapshot): BlockingItem | null {
    if (!['P2', 'P3', 'P4', 'P5', 'P6', 'ready_to_archive'].includes(snapshot.pipeline.stage)) return null
    const card = outlineCard(snapshot.outline, snapshot.pipeline.chapter)
    if (card === null) {
      if (!snapshot.outline.book.strict) return null
      return {
        code: 'PG-13',
        scope: 'outline',
        detail: `chapter ${snapshot.pipeline.chapter} has no outline card while strict mode is on`,
        hint: 'call novel_outline to add the missing card; do not turn strict mode off just to pass this gate',
      }
    }
    const plan = snapshot.plan
    if (plan === null) return null
    const problems: string[] = []
    const title = stripChapterPrefix(plan.title)
    if (title !== card.title) problems.push(`title "${title}" != card "${card.title}"`)
    if (plan.scene_type !== card.scene_type) {
      problems.push(`scene_type "${plan.scene_type}" != card "${card.scene_type}"`)
    }
    if (
      Math.max(plan.target_words[0], card.target_words[0]) >
      Math.min(plan.target_words[1], card.target_words[1])
    ) {
      problems.push(
        `target_words ${plan.target_words.join('-')} does not overlap card ${card.target_words.join('-')}`,
      )
    }
    const planCast = new Set((plan.cast ?? []).map((member) => member.name))
    const missing = card.cast.filter((name) => !planCast.has(name))
    if (missing.length > 0) problems.push(`cast missing ${missing.join(', ')}`)
    if (problems.length === 0) return null
    return {
      code: 'PG-13',
      scope: 'outline',
      detail: problems.join('; '),
      hint: 'fix the card with novel_outline, or roll back to P2 to rewrite the plan',
    }
  }

  /**
   * A review that exists but cannot be tied to the pipeline digest would let a
   * hand-edited review pass archive. Archive already fails closed; status and
   * next must surface the same repair path instead of pointing at the archive
   * command forever.
   */
  private reviewDigestProblem(snapshot: Snapshot): BlockingItem | null {
    if (snapshot.pipeline.stage !== 'ready_to_archive' || snapshot.review === null) return null
    const chapter = snapshot.pipeline.chapter
    const hint = 'call novel_rollback with to_stage P4, then re-run novel_review before archiving'
    if (snapshot.pipeline.review_digest === undefined) {
      return {
        code: 'REVIEW_DIGEST_MISSING',
        scope: 'state',
        detail: `review ${reviewFile(chapter)} has no pipeline.review_digest; it predates digest-bound reviews`,
        hint,
      }
    }
    if (snapshot.pipeline.review_digest !== sha256(stableJson(snapshot.review))) {
      return {
        code: 'REVIEW_DIGEST_MISMATCH',
        scope: 'state',
        detail: `review ${reviewFile(chapter)} changed after submission; its digest no longer matches`,
        hint,
      }
    }
    return null
  }

  private stateErrors(snapshot: Snapshot): StateError[] {
    const errors: StateError[] = [...snapshot.ledgerErrors]
    if (snapshot.projectError !== null) {
      errors.push({ path: PROJECT_FILE, code: 'PROJECT_UNREADABLE', message: snapshot.projectError })
    }
    if (snapshot.pipelineError !== null) {
      errors.push({
        path: joinRel(STATE_DIR, STATE_FILES.pipeline),
        code: 'PIPELINE_UNREADABLE',
        message: snapshot.pipelineError,
      })
    }
    const chapter = snapshot.pipeline.chapter
    if (snapshot.worldPlanError !== null) {
      errors.push({
        path: planWorldFile(chapter),
        code: 'WORLD_PLAN_UNREADABLE',
        message: snapshot.worldPlanError,
      })
    }
    if (snapshot.planError !== null) {
      errors.push({
        path: planChapterFile(chapter),
        code: 'PLAN_UNREADABLE',
        message: snapshot.planError,
      })
    }
    if (snapshot.reviewError !== null) {
      errors.push({
        path: reviewFile(chapter),
        code: 'REVIEW_UNREADABLE',
        message: snapshot.reviewError,
      })
    }
    if (snapshot.checkError !== null) {
      errors.push({
        path: checkFile(chapter),
        code: 'CHECK_UNREADABLE',
        message: snapshot.checkError,
      })
    }
    if (snapshot.outlineError !== null) {
      errors.push({ path: OUTLINE_FILE, code: 'OUTLINE_UNREADABLE', message: snapshot.outlineError })
    }
    if (snapshot.worldbookError !== null) {
      errors.push({ path: WORLDBOOK_FILE, code: 'WORLDBOOK_UNREADABLE', message: snapshot.worldbookError })
    }
    if (snapshot.briefsError !== null) {
      errors.push({ path: BRIEF_RECEIPTS_FILE, code: 'BRIEFS_UNREADABLE', message: snapshot.briefsError })
    }
    return errors
  }

  /** The earliest rebuild point for the current state damage. */
  private recoveryFor(snapshot: Snapshot): {
    tool: 'novel_rollback' | 'novel_amend' | 'novel_restore'
    args: Record<string, unknown>
    reason: string
  } {
    if (snapshot.pipelineError !== null) {
      return {
        tool: 'novel_restore',
        args: { paths: [joinRel(STATE_DIR, STATE_FILES.pipeline)] },
        reason: `PIPELINE_UNREADABLE: ${snapshot.pipelineError}; choose a backup with a pipeline pre-image and pass its txid`,
      }
    }
    const chapter = snapshot.pipeline.chapter
    const errors = this.stateErrors(snapshot)
    if (snapshot.projectError !== null) {
      return {
        tool: 'novel_amend',
        args: { path: PROJECT_FILE, reason: `repair PROJECT_UNREADABLE: ${snapshot.projectError}` },
        reason: `${errors.map((error) => `${error.code}@${error.path}`).join('; ')}; read novel_state novel for the raw document, then amend with a complete project document`,
      }
    }
    // Ledger damage cannot be rebuilt by replaying a stage; it needs an
    // explicit, journaled amend. Point there first so the model does not
    // rollback into a wall of STATE_UNREADABLE gates.
    if (snapshot.outlineError !== null) {
      return {
        tool: 'novel_amend',
        args: { path: OUTLINE_FILE, reason: `repair OUTLINE_UNREADABLE: ${snapshot.outlineError}` },
        reason: `${OUTLINE_FILE} is unreadable; read the raw file, then amend it with a complete outline document`,
      }
    }
    if (snapshot.worldbookError !== null) {
      return {
        tool: 'novel_amend',
        args: { path: WORLDBOOK_FILE, reason: `repair WORLDBOOK_UNREADABLE: ${snapshot.worldbookError}` },
        reason: `${WORLDBOOK_FILE} is unreadable; read the raw file, then amend it with a complete worldbook document`,
      }
    }
    // 0.2.17: a damaged receipt file makes every PG-01 check fail, and
    // `getBrief` refuses to overwrite it. Recommending `novel_brief` was a loop;
    // the only way out is an explicit amend of the receipt file.
    if (snapshot.briefsError !== null) {
      return {
        tool: 'novel_amend',
        args: {
          path: BRIEF_RECEIPTS_FILE,
          reason: `repair BRIEFS_UNREADABLE: ${snapshot.briefsError}`,
        },
        reason: `${BRIEF_RECEIPTS_FILE} is unreadable, so no brief can be signed; read the raw file and amend it with { schema_version: 1, receipts: [...] } (an empty receipts array is valid and only loses the old signatures)`,
      }
    }
    if (snapshot.ledgerErrors.length > 0) {
      const first = snapshot.ledgerErrors[0]!
      return {
        tool: 'novel_amend',
        args: { path: first.path, reason: `repair ${first.code}: ${first.message}` },
        reason: `${errors.map((error) => `${error.code}@${error.path}`).join('; ')}; read novel_state for the raw document, then amend it with a complete replacement`,
      }
    }
    const desired: RollbackSubmission['toStage'] =
      snapshot.worldPlanError !== null
        ? 'P1'
        : snapshot.planError !== null
          ? 'P2'
          : snapshot.reviewError !== null
            ? 'P4'
            : 'P6'
    const target = this.clampRollbackTarget(snapshot.pipeline.stage, desired)
    const targetRank = STAGE_RANK[ROUND_TRANSITIONS[target]]
    const action =
      targetRank < STAGE_RANK[snapshot.pipeline.stage]
        ? `rollback to ${target} and rebuild through the normal stage tools`
        : `repair the file at ${snapshot.pipeline.stage} with its normal stage tool`
    return {
      tool: 'novel_rollback',
      args: { chapter, to_stage: target },
      reason: `${errors.map((error) => `${error.code}@${error.path}`).join('; ')}; ${action}`,
    }
  }

  /** Never point at a stage later than the current one; rollback only moves backward. */
  private clampRollbackTarget(
    stage: Stage,
    desired: RollbackSubmission['toStage'],
  ): RollbackSubmission['toStage'] {
    if (STAGE_RANK[ROUND_TRANSITIONS[desired]] <= STAGE_RANK[stage]) return desired
    const current: Record<Stage, RollbackSubmission['toStage']> = {
      idle: 'P1',
      P2: 'P2',
      P3: 'P3',
      P4: 'P4',
      P5: 'P5',
      P6: 'P6',
      ready_to_archive: 'P6',
      done: 'P6',
    }
    return current[stage]
  }

  /** State damage that makes this operation unsafe to start. */
  private stateGateBlock(snapshot: Snapshot, operation: Operation): BlockingItem[] {
    const planSensitive: Operation[] = [
      'submitDraft',
      'submitReview',
      'submitRevision',
      'runCheck',
      'archiveChapter',
    ]
    // The chapter-plan writer overwrites a corrupt chapter plan; it must not be
    // blocked by the very damage it repairs. The world plan is an input to P2,
    // so a corrupt world plan does block the chapter-plan writer.
    const worldPlanSensitive: Operation[] = ['submitChapterPlan', ...planSensitive]
    const reviewSensitive: Operation[] = ['submitRevision', 'runCheck', 'archiveChapter']
    const checkSensitive: Operation[] = ['archiveChapter']
    // The outline is the PG-13 input; a corrupt outline must not let P2/P3
    // silently behave as if strict mode were off. The worldbook is planning
    // context for P1/P2, so a corrupt one blocks those two writers only.
    const outlineSensitive: Operation[] = ['submitChapterPlan', 'submitDraft', 'archiveChapter']
    const worldbookSensitive: Operation[] = ['submitWorldPlan', 'submitChapterPlan']
    /** Every operation whose gate needs a signed brief receipt. */
    const briefSensitive: Operation[] = [
      'submitWorldPlan',
      'submitChapterPlan',
      'submitDraft',
      'submitReview',
      'submitRevision',
      'runCheck',
      'archiveChapter',
    ]
    const relevant: StateError[] = [...snapshot.ledgerErrors]
    if (snapshot.projectError !== null) {
      relevant.push(...this.stateErrors(snapshot).filter((error) => error.code === 'PROJECT_UNREADABLE'))
    }
    if (snapshot.worldPlanError !== null && worldPlanSensitive.includes(operation)) {
      relevant.push(...this.stateErrors(snapshot).filter((error) => error.code === 'WORLD_PLAN_UNREADABLE'))
    }
    if (snapshot.planError !== null && planSensitive.includes(operation)) {
      relevant.push(...this.stateErrors(snapshot).filter((error) => error.code === 'PLAN_UNREADABLE'))
    }
    if (snapshot.reviewError !== null && reviewSensitive.includes(operation)) {
      relevant.push(...this.stateErrors(snapshot).filter((error) => error.code === 'REVIEW_UNREADABLE'))
    }
    if (snapshot.checkError !== null && checkSensitive.includes(operation)) {
      relevant.push(...this.stateErrors(snapshot).filter((error) => error.code === 'CHECK_UNREADABLE'))
    }
    if (snapshot.outlineError !== null && outlineSensitive.includes(operation)) {
      relevant.push(...this.stateErrors(snapshot).filter((error) => error.code === 'OUTLINE_UNREADABLE'))
    }
    if (snapshot.worldbookError !== null && worldbookSensitive.includes(operation)) {
      relevant.push(...this.stateErrors(snapshot).filter((error) => error.code === 'WORLDBOOK_UNREADABLE'))
    }
    // 0.2.17: a damaged receipt file makes PG-01 unsatisfiable for every
    // operation that needs a brief; refuse early with the repair path instead
    // of letting the model call novel_brief, which must not overwrite it.
    if (snapshot.briefsError !== null && briefSensitive.includes(operation)) {
      relevant.push(...this.stateErrors(snapshot).filter((error) => error.code === 'BRIEFS_UNREADABLE'))
    }
    return relevant.map((error) => ({
      code: 'STATE_UNREADABLE',
      scope: 'state',
      detail: `${error.code}: ${error.message}`,
      hint: this.recoveryFor(snapshot).reason,
    }))
  }

  /** Read receipt rows without adding the derived read-model fields. */
  private async readRawBriefReceipts(store: FsStore): Promise<BriefReceiptsDocument> {
    const raw = await store.readText(BRIEF_RECEIPTS_FILE)
    if (raw === null) return { schema_version: 1, receipts: [] }
    try {
      const parsed = parseYaml(raw) as Partial<BriefReceiptsDocument> | null
      if (parsed === null || !Array.isArray(parsed.receipts)) {
        return { schema_version: 1, receipts: [] }
      }
      return {
        schema_version: 1,
        receipts: parsed.receipts.filter(
          (receipt): receipt is BriefReceiptsDocument['receipts'][number] =>
            typeof receipt === 'object' &&
            receipt !== null &&
            Number.isInteger(receipt.chapter) &&
            typeof receipt.stage === 'string' &&
            typeof receipt.digest === 'string' &&
            typeof receipt.issued_at === 'string',
        ),
      }
    } catch {
      return { schema_version: 1, receipts: [] }
    }
  }

  /** Read the current document so a patch edits reality, not a guess. */
  private async readAmendBase(store: FsStore, path: string, kind: DocKind): Promise<Record<string, unknown>> {
    const raw = await store.readText(path)
    if (raw === null) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `amend patch cannot read ${path}: the document does not exist`,
        'pass content to create it, or check the path with novel_state',
      )
    }
    let parsed: unknown
    try {
      parsed = parseYaml(raw)
    } catch (error) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `amend patch cannot parse ${path}: ${errorMessage(error)}`,
        'the document is damaged; repair it with a whole content document instead of a patch',
      )
    }
    const document = recordOf(parsed)
    if (document === null) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `amend patch cannot use ${path}: it is not a document object`,
        'repair it with a whole content document instead of a patch',
      )
    }
    // Validate the base so a patch never repairs a schema it does not understand.
    narrow(kind, document)
    return document
  }

  /**
   * Move superseded receipts into `history/briefs/chNNN.yaml`. Failure is
   * fail-open: the archive must not be blocked by an audit-file rewrite, and the
   * unpruned file is still valid.
   */
  private async compressBriefReceipts(
    store: FsStore,
    chapter: number,
  ): Promise<{ files: StagedFile[]; warning?: string }> {
    try {
      const current = await this.readRawBriefReceipts(store)
      if (current.receipts.length === 0) return { files: [] }
      const path = `history/briefs/ch${String(chapter).padStart(3, '0')}.yaml`
      const existingRaw = await store.readText(path)
      const archived: BriefReceiptsDocument['receipts'] = []
      if (existingRaw !== null) {
        const parsed = parseYaml(existingRaw) as Partial<BriefReceiptsDocument> | null
        if (parsed !== null && Array.isArray(parsed.receipts)) {
          archived.push(...parsed.receipts)
        }
      }
      const keep: BriefReceiptsDocument['receipts'] = []
      const move: BriefReceiptsDocument['receipts'] = []
      const groups = new Map<string, BriefReceiptsDocument['receipts']>()
      for (const receipt of current.receipts) {
        if (receipt.chapter !== chapter) {
          keep.push(receipt)
          continue
        }
        const key = receipt.stage
        const group = groups.get(key) ?? []
        group.push(receipt)
        groups.set(key, group)
      }
      for (const group of groups.values()) {
        const sorted = [...group].sort((left, right) => left.issued_at.localeCompare(right.issued_at))
        const currentRow = sorted.find((row) => row.current === true) ?? sorted.at(-1)
        const bounded = new Set<BriefReceiptsDocument['receipts'][number]>()
        if (currentRow !== undefined) bounded.add(currentRow)
        // The acceptance is "at most three live receipts per chapter+stage".
        // Adding three recent rows on top of a promoted older current row
        // produced four (M3).
        for (const row of sorted.slice(-(currentRow === undefined ? 3 : 2))) bounded.add(row)
        for (const row of sorted) {
          if (bounded.has(row)) keep.push(row)
          else move.push(row)
        }
      }
      if (move.length === 0) return { files: [] }
      // Fail-open must cover the write, not only the read: when `history` (or
      // `history/briefs`) is a regular file, staging the archive failed with
      // EEXIST and the whole archive aborted instead of keeping the receipts
      // in the hot file. Probe the path before promising to move anything.
      for (const directory of ['history', 'history/briefs']) {
        const info = await store.stat(directory)
        if (info !== null && !info.isDirectory) {
          return {
            files: [],
            warning: `${directory} is a file, not a directory; receipts stay in ${BRIEF_RECEIPTS_FILE}`,
          }
        }
      }
      const known = new Set(
        archived.map((row) => `${row.chapter}:${row.stage}:${row.digest}:${row.issued_at}`),
      )
      for (const row of move) {
        const id = `${row.chapter}:${row.stage}:${row.digest}:${row.issued_at}`
        if (known.has(id)) continue
        known.add(id)
        archived.push(row)
      }
      return {
        files: [
          { path, text: yaml({ schema_version: 1, receipts: archived }) },
          { path: BRIEF_RECEIPTS_FILE, text: yaml({ schema_version: 1, receipts: keep }) },
        ],
      }
    } catch (error) {
      // Compaction is best effort: the archive must still succeed. Returning the
      // reason lets the caller attach a warning instead of failing silently.
      return { files: [], warning: `receipt compaction failed: ${errorMessage(error)}` }
    }
  }

  /** Whether the stored brief still signs the current snapshot. */
  private async readBriefReceipts(store: FsStore): Promise<BriefReceiptsDocument> {
    const raw = await this.readRawBriefReceipts(store)
    return {
      schema_version: 1,
      receipts: this.normalizeBriefReceipts(raw.receipts),
    }
  }

  /** Derive current/superseded/id on read so pre-0.2.13 receipt files need no migration. */
  private normalizeBriefReceipts(
    receipts: BriefReceiptsDocument['receipts'],
  ): BriefReceiptsDocument['receipts'] {
    const groups = new Map<string, BriefReceiptsDocument['receipts']>()
    for (const [index, receipt] of receipts.entries()) {
      const key = `${receipt.chapter}:${receipt.stage}`
      const group = groups.get(key) ?? []
      group.push({ ...receipt, __index: index } as BriefReceiptsDocument['receipts'][number])
      groups.set(key, group)
    }
    const result: BriefReceiptsDocument['receipts'] = []
    for (const group of groups.values()) {
      group.sort(
        (left, right) =>
          left.issued_at.localeCompare(right.issued_at) ||
          Number((left as { __index?: number }).__index ?? 0) -
            Number((right as { __index?: number }).__index ?? 0),
      )
      const explicitCurrent = group.filter((receipt) => receipt.current === true)
      const latest =
        explicitCurrent.length > 0
          ? [...explicitCurrent].sort((left, right) => left.issued_at.localeCompare(right.issued_at)).at(-1)!
          : group[group.length - 1]!
      for (const [index, receipt] of group.entries()) {
        const current = receipt === latest || (explicitCurrent.length === 0 && index === group.length - 1)
        result.push({
          chapter: receipt.chapter,
          stage: receipt.stage,
          digest: receipt.digest,
          issued_at: receipt.issued_at,
          id: receipt.id ?? `${receipt.chapter}:${receipt.stage}:${receipt.digest}`,
          current,
          // Per-block digests are what let PG-01 name the dependency that
          // changed. Rebuilding the row without them silently downgraded every
          // stale report to "state" with an empty `changed` list.
          ...(receipt.dependencies === undefined ? {} : { dependencies: receipt.dependencies }),
          ...(current
            ? {}
            : {
                // A promoted older receipt can be the legitimate current row
                // even when a newer legacy row exists. Never claim it
                // superseded the newer row before that row was issued.
                superseded_at:
                  receipt.superseded_at ??
                  (latest.issued_at.localeCompare(receipt.issued_at) >= 0
                    ? latest.issued_at
                    : receipt.issued_at),
                superseded_by: receipt.superseded_by ?? `${latest.chapter}:${latest.stage}:${latest.digest}`,
              }),
        })
      }
    }
    return result.sort((left, right) => left.issued_at.localeCompare(right.issued_at))
  }

  private async assertBriefReceiptsWritable(store: FsStore): Promise<void> {
    const raw = await store.readText(BRIEF_RECEIPTS_FILE)
    if (raw === null) return
    try {
      const parsed = parseYaml(raw) as Partial<BriefReceiptsDocument> | null
      if (parsed === null || !Array.isArray(parsed.receipts)) {
        throw new Error('receipts must be an array')
      }
      for (const [index, receipt] of parsed.receipts.entries()) {
        if (
          typeof receipt !== 'object' ||
          receipt === null ||
          !Number.isInteger(receipt.chapter) ||
          typeof receipt.stage !== 'string' ||
          typeof receipt.digest !== 'string' ||
          typeof receipt.issued_at !== 'string'
        ) {
          throw new Error(`receipt ${index} has an invalid shape`)
        }
      }
    } catch (error) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_INVALID,
        `state/briefs.yaml is malformed; refusing to overwrite its append-only audit (${errorMessage(error)})`,
        'repair or move state/briefs.yaml aside, then call novel_brief again; existing receipts are never silently erased',
      )
    }
  }

  private briefIsCurrent(snapshot: Snapshot, stage: BriefStage): boolean {
    const record = snapshot.briefs[stage]
    if (record === undefined) return false
    return record.digest === this.briefDigest(stage, snapshot, snapshot.pipeline.chapter)
  }

  /** Arguments valid for the tool `STAGE_NEXT` recommends at this stage. */
  private nextArgs(stage: Stage, chapter: number): Record<string, unknown> {
    switch (stage) {
      case 'idle':
      case 'P2':
      case 'done':
        // novel_plan_world and novel_plan_chapter act on the active chapter.
        return {}
      default:
        return { chapter }
    }
  }

  private async metricsFor(snapshot: Snapshot, chapter: number): Promise<WordMetrics | null> {
    if (chapter === snapshot.pipeline.chapter && snapshot.text !== null)
      return countWordMetrics(snapshot.text)
    const text = await this.readChapter(snapshot, chapter)
    return text === null ? null : countWordMetrics(text)
  }

  private async readChapter(snapshot: Snapshot, chapter: number): Promise<string | null> {
    return this.storeFor(snapshot.root).readText(chapterFile(chapter))
  }

  /**
   * archive-digests.json is a derived mirror, not a source of truth. A damaged
   * mirror must never make every write unreachable; rebuild the missing rows
   * from the chapter index and let the next archive rewrite a valid file.
   */
  private async readArchiveDigests(store: FsStore, snapshot: Snapshot): Promise<Record<string, string>> {
    const digests: Record<string, string> = {}
    const raw = await store.readText(ARCHIVE_DIGESTS)
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw)
        const record = recordOf(parsed)
        if (record !== null && Object.values(record).every((value) => typeof value === 'string')) {
          for (const [key, value] of Object.entries(record)) digests[key] = value as string
        }
      } catch {
        // Rebuild below from indexed archive evidence.
      }
    }
    for (const chapter of snapshot.chapters.chapters) {
      if (chapter.archive_digest !== undefined) {
        digests[String(chapter.num)] = chapter.archive_digest
      }
    }
    return digests
  }

  private async latestBackup(store: FsStore, path: string): Promise<string | null> {
    for (const entry of await listBackups(store)) {
      const text = await store.readText(joinRel(BACKUP_DIR, entry.name, path))
      if (text !== null) return text
    }
    return null
  }

  /**
   * A manuscript export with an unreadable chapter index cannot prove which
   * chapters exist. Refusing is preferable to writing a short book that looks
   * complete; the repair path is novel_amend, not a silent partial export.
   */
  private assertExportIndexReadable(snapshot: Snapshot, kind: ExportKind): void {
    if (kind === 'outline' || kind === 'worldbook') return
    const damage = snapshot.ledgerErrors.find((error) => error.code === 'CHAPTERS_UNREADABLE')
    if (damage === undefined) return
    throw new EngineFaultError(
      ERROR_CODES.SCHEMA_INVALID,
      `cannot export ${kind}: state/${STATE_FILES.chapters} is unreadable (${damage.message})`,
      `repair state/${STATE_FILES.chapters} with novel_amend before exporting`,
    )
  }

  private async chaptersForExport(snapshot: Snapshot, chapter?: number): Promise<ExportChapter[]> {
    const records = snapshot.chapters.chapters
    const activeDraft =
      chapter !== undefined && chapter === snapshot.pipeline.chapter && snapshot.text !== null
    if (chapter !== undefined && !records.some((record) => record.num === chapter) && !activeDraft) {
      throw new EngineInputError(
        ERROR_CODES.STAGE_ORDER,
        `chapter ${chapter} is not archived and is not the active draft`,
        'archive the chapter first, or pass the active chapter to export its draft',
      )
    }
    const selected = chapter === undefined ? records : records.filter((record) => record.num === chapter)
    const chapters: ExportChapter[] = []
    for (const record of selected) {
      const text = await this.readChapter(snapshot, record.num)
      if (text === null) {
        throw new EngineFaultError(
          ERROR_CODES.SCHEMA_INVALID,
          `chapter ${record.num} is indexed but its file is missing`,
          'restore the chapter from backups/',
        )
      }
      chapters.push({ num: record.num, title: record.title, text })
    }
    if (
      chapters.length === 0 &&
      snapshot.text !== null &&
      (chapter === undefined || chapter === snapshot.pipeline.chapter)
    ) {
      chapters.push({
        num: snapshot.pipeline.chapter,
        title: stripTitlePrefix(snapshot.plan?.title ?? '') || '未命名',
        text: snapshot.text,
      })
    }
    if (chapters.length === 0) {
      throw new EngineInputError(
        ERROR_CODES.STAGE_ORDER,
        'no chapter is available to export',
        'write or archive at least one chapter first',
      )
    }
    return chapters
  }

  /** The machine-pass options for one chapter; shared with the style overview. */
  private machineOptions(
    snapshot: Snapshot,
    extra: {
      title?: string | null
      sceneType?: import('../types.js').SceneType
      summary?: ChapterSummary | null
    },
  ): MachineOptions {
    const stylepack = this.stylepackFor(snapshot.project)
    return {
      chapter: snapshot.pipeline.chapter,
      title: composeTitle(
        snapshot.pipeline.chapter,
        extra.title ?? snapshot.plan?.title ?? null,
        this.rulepack.format.title.pattern,
      ),
      genre: snapshot.project.genre,
      sceneType: extra.sceneType ?? snapshot.plan?.scene_type ?? '日常过渡章',
      rulepack: this.rulepack,
      targets: snapshot.project.targets,
      facts: snapshot.worldbook.facts ?? [],
      strict: snapshot.outline.book.strict,
      summary: extra.summary ?? snapshot.plan?.summary ?? null,
      disableRelationUnknown: true,
      evidence: {
        characters: snapshot.characters.characters.length > 0 ? snapshot.characters : null,
        previousText: snapshot.previousText,
        previousTexts: snapshot.previousTexts,
        previousChapterNums: snapshot.previousChapterNums,
        foreshadows: snapshot.foreshadows.items.length > 0 ? snapshot.foreshadows : null,
        timeline: snapshot.timeline.items.length > 0 ? snapshot.timeline : null,
        relationships: snapshot.relationships.items.length > 0 ? snapshot.relationships : null,
        world: snapshot.world,
        locks: snapshot.locks,
        worldbook: snapshot.worldbook,
      },
      // 0.2.17: present only when the book bound a pack, which is what keeps a
      // pre-0.2.17 project's findings exactly as they were.
      ...(stylepack === null ? {} : { style: stylepack }),
    }
  }

  private machine(
    snapshot: Snapshot,
    text: string,
    extra: {
      title?: string | null
      sceneType?: import('../types.js').SceneType
      summary?: ChapterSummary | null
    },
  ): MachineResult {
    return runMachineChecks(text, this.machineOptions(snapshot, extra))
  }

  private briefContextFor(stage: string, snapshot: Snapshot, chapter: number): Record<string, unknown> {
    let cache = this.briefContextCache.get(snapshot)
    if (cache === undefined) {
      cache = new Map()
      this.briefContextCache.set(snapshot, cache)
    }
    const cacheKey = `${stage}:${chapter}`
    const cached = cache.get(cacheKey)
    if (cached !== undefined) return cached
    const machine =
      ['P4', 'P5', 'P6'].includes(stage) && snapshot.text !== null
        ? this.machine(snapshot, snapshot.text, { summary: snapshot.plan?.summary ?? null })
        : undefined
    const context = briefContext({
      stage,
      chapter,
      project: snapshot.project,
      pipeline: snapshot.pipeline,
      chapters: snapshot.chapters,
      characters: snapshot.characters,
      world: snapshot.world,
      locks: snapshot.locks,
      foreshadows: snapshot.foreshadows,
      timeline: snapshot.timeline,
      relationships: snapshot.relationships,
      worldPlan: snapshot.worldPlan,
      world_plan_error: snapshot.worldPlanError,
      plan: snapshot.plan,
      plan_error: snapshot.planError,
      review: snapshot.review,
      review_error: snapshot.reviewError,
      check: snapshot.check,
      check_error: snapshot.checkError,
      text: snapshot.text,
      machine,
      previousText: snapshot.previousText,
      handoff: snapshot.handoff,
      outline: snapshot.outline,
      outlinePresent: snapshot.outlinePresent,
      outline_error: snapshot.outlineError,
      worldbook: snapshot.worldbook,
      worldbookPresent: snapshot.worldbookPresent,
      worldbook_error: snapshot.worldbookError,
      // 0.2.17: resolved once per brief; a book with no pack gets `null`, which
      // keeps the context byte-identical to 0.2.16.
      style: this.stylepackFor(snapshot.project),
    })
    cache.set(cacheKey, context)
    return context
  }

  /**
   * Each stage signs only the state it actually reads. A single document-wide
   * digest made one revision invalidate P4/P6/P8 together, and made a rounds
   * counter change look like a content change.
   */
  private briefDependencies(stage: BriefStage, snapshot: Snapshot, chapter: number): Record<string, string> {
    const hash = (value: unknown): string => sha256(stableJson(value)).slice(0, 32)
    const dependencies: Record<string, string> = {
      brief: this.briefs.render(stage, this.briefVariables(snapshot, chapter)).contentHash,
      rulepack: `${this.rulepack.name}@${this.rulepack.version}`,
      min_score: String(this.config.quality.minScore),
      // A rollback is an explicit reset: the stage must re-issue its brief even
      // though the signed documents did not change.
      rollback_epoch:
        snapshot.pipeline.last_action?.op === 'novel_rollback' ? snapshot.pipeline.last_action.at : 'none',
    }
    switch (stage) {
      case 'P1':
        dependencies.project = hash(snapshot.project)
        dependencies.outline = hash(snapshot.outline)
        dependencies.worldbook = hash(snapshot.worldbook)
        dependencies.handoff = hash(snapshot.handoff)
        dependencies.chapters = hash(snapshot.chapters.chapters)
        break
      case 'P2':
        dependencies.plan_error = snapshot.planError ?? ''
        dependencies.check_error = snapshot.checkError ?? ''
        dependencies.world_plan = hash(snapshot.worldPlan)
        dependencies.outline = hash(snapshot.outline)
        dependencies.worldbook = hash(snapshot.worldbook)
        dependencies.chapters = hash(snapshot.chapters.chapters)
        break
      case 'P3':
        dependencies.plan_error = snapshot.planError ?? ''
        dependencies.plan = hash(snapshot.plan)
        dependencies.world_plan = hash(snapshot.worldPlan)
        dependencies.characters = hash(snapshot.characters)
        dependencies.world = hash(snapshot.world)
        dependencies.outline = hash(snapshot.outline)
        break
      case 'P4':
        dependencies.check_error = snapshot.checkError ?? ''
        dependencies.text = hash(snapshot.text)
        dependencies.plan = hash(snapshot.plan)
        dependencies.machine = this.machineHash(snapshot)
        break
      case 'P5':
        dependencies.review_error = snapshot.reviewError ?? ''
        dependencies.text = hash(snapshot.text)
        dependencies.review = hash(snapshot.review)
        break
      case 'P6':
        dependencies.review_error = snapshot.reviewError ?? ''
        dependencies.check_error = snapshot.checkError ?? ''
        dependencies.text = hash(snapshot.text)
        dependencies.review = hash(snapshot.review)
        dependencies.machine = this.machineHash(snapshot)
        // P6 shows the current check; a failed check must be re-signed before
        // the revision that answers it.
        dependencies.check = hash(snapshot.check)
        break
      case 'P8':
        dependencies.review_error = snapshot.reviewError ?? ''
        dependencies.check_error = snapshot.checkError ?? ''
        dependencies.text = hash(snapshot.text)
        dependencies.review = hash(snapshot.review)
        dependencies.check = hash(snapshot.check)
        dependencies.plan = hash(snapshot.plan)
        // P8's context shows the open foreshadow list and recent summaries,
        // not the full world/relationship ledgers.
        dependencies.foreshadows = hash(snapshot.foreshadows)
        dependencies.chapters = hash(snapshot.chapters.chapters.slice(-5))
        break
    }
    return dependencies
  }

  private machineHash(snapshot: Snapshot): string {
    if (snapshot.text === null) return 'no-text'
    const machine = this.machine(snapshot, snapshot.text, { summary: snapshot.plan?.summary ?? null })
    return sha256(stableJson(machine)).slice(0, 32)
  }

  private briefDigest(stage: BriefStage, snapshot: Snapshot, chapter: number): string {
    return shortDigest(
      stableJson({ stage, chapter, dependencies: this.briefDependencies(stage, snapshot, chapter) }),
    )
  }

  private briefVariables(snapshot: Snapshot, chapter: number): Record<string, string | number> {
    return {
      title: snapshot.project.title,
      genre: snapshot.project.genre,
      platform: snapshot.project.platform,
      chapter,
      chapter_pad: String(chapter).padStart(3, '0'),
      min_words: snapshot.project.targets.words_per_chapter[0],
      max_words: snapshot.project.targets.words_per_chapter[1],
      min_cjk_chars: snapshot.project.targets.min_cjk_chars ?? 0,
      min_score: this.config.quality.minScore,
      round:
        snapshot.pipeline.stage === 'P5'
          ? snapshot.pipeline.rounds.revise + 1
          : snapshot.pipeline.rounds.review + 1,
    }
  }

  /**
   * The one place a gate input is assembled. Archive preflight evaluates the
   * same object as the real archive, so a gate cannot pass preflight and then
   * fail the write (the old PG-06/scope holes did exactly that).
   */
  private gateInput(
    snapshot: Snapshot,
    operation: Operation,
    extras: Partial<
      Pick<
        GateInput,
        | 'briefStage'
        | 'briefDigest'
        | 'text'
        | 'summary'
        | 'summaryProvided'
        | 'summaryOnly'
        | 'summaryOnlyRevision'
        | 'draftTitle'
        | 'sceneType'
        | 'narrator'
        | 'review'
        | 'check'
        | 'proof'
        | 'semantic'
        | 'scope'
        | 'planTargetWords'
        | 'planCast'
      >
    > = {},
  ): GateInput {
    const text = extras.text ?? snapshot.text ?? ''
    const archive =
      operation === 'archiveChapter'
        ? {
            chapterExists: snapshot.chapters.chapters.some(
              (record) => record.num === snapshot.pipeline.chapter,
            ),
            checkPassed: snapshot.check?.verdict === 'pass',
            hashMatches:
              snapshot.check !== null &&
              snapshot.text !== null &&
              snapshot.check.content_hash === sha256(snapshot.text),
          }
        : null
    return {
      operation,
      stage: snapshot.pipeline.stage,
      text,
      chapter: snapshot.pipeline.chapter,
      project: snapshot.project,
      pipeline: { ...snapshot.pipeline, briefs: snapshot.briefs },
      chapters: snapshot.chapters,
      briefDigest:
        extras.briefDigest ??
        (extras.briefStage === undefined || extras.briefStage === null
          ? null
          : this.briefDigest(extras.briefStage, snapshot, snapshot.pipeline.chapter)),
      briefDependencies:
        extras.briefStage === undefined || extras.briefStage === null
          ? null
          : this.briefDependencies(extras.briefStage, snapshot, snapshot.pipeline.chapter),
      briefStage: extras.briefStage ?? briefStageFor(operation, snapshot.pipeline.stage),
      draftTitle: composeTitle(
        snapshot.pipeline.chapter,
        extras.draftTitle ?? snapshot.pipeline.draft?.title ?? snapshot.plan?.title ?? null,
        this.rulepack.format.title.pattern,
      ),
      sceneType: extras.sceneType ?? snapshot.pipeline.draft?.scene_type ?? snapshot.plan?.scene_type ?? null,
      narrator: extras.narrator ?? snapshot.pipeline.draft?.narrator ?? snapshot.plan?.narrator ?? null,
      summary: extras.summary ?? snapshot.pipeline.draft?.summary ?? snapshot.plan?.summary ?? null,
      summaryProvided: extras.summaryProvided,
      summaryOnly: extras.summaryOnly,
      summaryOnlyRevision:
        extras.summaryOnlyRevision ??
        (operation === 'runCheck' &&
          snapshot.pipeline.stage === 'P6' &&
          snapshot.pipeline.last_action?.op === 'novel_revise_summary'),
      review: extras.review ?? snapshot.review,
      check: extras.check ?? snapshot.check,
      semantic: extras.semantic ?? [],
      proof: extras.proof ?? null,
      scope: extras.scope,
      rounds: snapshot.pipeline.rounds,
      archive,
      evidence: {
        characters: snapshot.characters.characters.length > 0 ? snapshot.characters : null,
        foreshadows: snapshot.foreshadows.items.length > 0 ? snapshot.foreshadows : null,
        timeline: snapshot.timeline.items.length > 0 ? snapshot.timeline : null,
        relationships: snapshot.relationships.items.length > 0 ? snapshot.relationships : null,
        world: snapshot.world,
        locks: snapshot.locks,
        worldbook: snapshot.worldbook,
      },
      previousText: snapshot.previousText,
      previousTexts: snapshot.previousTexts,
      previousChapterNums: snapshot.previousChapterNums,
      priorSceneTypes: snapshot.chapters.chapters.map((record) => record.scene_type),
      outline: snapshot.outline,
      planTargetWords: extras.planTargetWords ?? snapshot.plan?.target_words ?? null,
      planCast:
        extras.planCast ??
        (snapshot.plan?.cast === undefined ? null : snapshot.plan.cast.map((member) => member.name)),
    }
  }

  private async assertGates(
    snapshot: Snapshot,
    operation: Operation,
    extras: Partial<
      Pick<
        GateInput,
        | 'briefStage'
        | 'briefDigest'
        | 'text'
        | 'summary'
        | 'summaryProvided'
        | 'summaryOnly'
        | 'summaryOnlyRevision'
        | 'draftTitle'
        | 'sceneType'
        | 'narrator'
        | 'review'
        | 'check'
        | 'proof'
        | 'semantic'
        | 'scope'
        | 'planTargetWords'
        | 'planCast'
      >
    >,
  ): Promise<void> {
    if (!canRun(snapshot.pipeline.stage, operation)) {
      throw new EngineInputError(
        ERROR_CODES.STAGE_ORDER,
        `${operation} is not allowed at stage ${snapshot.pipeline.stage}`,
        'call novel_status to see the next legal step',
      )
    }
    const stateBlocking = this.stateGateBlock(snapshot, operation)
    if (stateBlocking.length > 0) {
      throw new EngineBlockedError(
        ERROR_CODES.GATE_BLOCKED,
        `${operation} blocked by unreadable state: ${stateBlocking[0]!.detail}`,
        stateBlocking,
        this.recoveryFor(snapshot).reason,
      )
    }
    const result = evaluateGates(this.gateInput(snapshot, operation, extras), {
      rulepack: this.rulepack,
      minScore: this.config.quality.minScore,
    })
    if (!result.passed) {
      const first = result.blocking[0]!
      this.onEvent?.({
        name: 'novel/blocked',
        payload: {
          schemaVersion: 1,
          projectRoot: snapshot.root,
          operation,
          blocking: result.blocking.length,
        },
      })
      const onlyProof = result.blocking.every((item) => item.code === 'PG-09')
      throw new EngineBlockedError(
        onlyProof ? ERROR_CODES.READING_PROOF_INVALID : ERROR_CODES.GATE_BLOCKED,
        `${operation} blocked by ${result.blocking.length} gate(s), first: ${first.code} ${first.detail}`,
        result.blocking,
        result.blocking.map((item) => `${item.code}: ${item.hint ?? item.detail}`).join(' | '),
      )
    }
  }

  private assertChapterParameter(chapter: unknown): void {
    if (!Number.isInteger(chapter) || (chapter as number) < 1) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `chapter must be a positive integer (got ${String(chapter)})`,
      )
    }
  }

  private assertChapter(snapshot: Snapshot, chapter: number): void {
    this.assertChapterParameter(chapter)
    if (chapter !== snapshot.pipeline.chapter) {
      throw new EngineInputError(
        ERROR_CODES.STAGE_ORDER,
        `chapter ${chapter} is not the active chapter (${snapshot.pipeline.chapter})`,
        'archive the active chapter before starting the next one',
      )
    }
  }

  /** A live writer lock makes a read-only snapshot potentially torn. */
  private async lockIsLive(store: FsStore): Promise<boolean> {
    const text = await store.readText(LOCK_FILE)
    if (text !== null) {
      try {
        const record: unknown = JSON.parse(text)
        if (isLockRecord(record)) return lockRecordIsLive(record)
      } catch {
        // A half-written lock is judged by its mtime below.
      }
    }
    const info = await store.stat(LOCK_FILE)
    return info !== null && Date.now() - info.mtimeMs < 1_000
  }

  /** Resolve a selection, load it, then persist the explicit choice (best effort). */
  private async load(root?: string): Promise<Snapshot> {
    const selection = await this.resolveRoot(root)
    const snapshot = await this.loadAt(selection)
    await this.recordSelectionBestEffort(selection, snapshot)
    return snapshot
  }

  /** Load exactly one already-resolved selection; never writes a binding. */
  private async movedProjectHint(selection: Selection): Promise<string | undefined> {
    if (selection.created_at === undefined || selection.created_at === '') return undefined
    try {
      const registry = await this.registry().read()
      return registry.projects.find(
        (entry) =>
          entry.root !== selection.root &&
          entry.created_at !== undefined &&
          entry.created_at === selection.created_at,
      )?.root
    } catch {
      // A damaged registry must not hide the more actionable missing bind.
      return undefined
    }
  }

  private async loadAt(selection: Selection, retries = 1, allowLock = false): Promise<Snapshot> {
    const store = this.storeFor(selection.root)
    if (selection.source === 'session') {
      const inspection = await inspectProject(selection.root)
      if (inspection.state === 'missing') {
        throw missingProjectError({
          selection,
          lastTitle: selection.title,
          movedTo: await this.movedProjectHint(selection),
        })
      }
      if (inspection.state === 'not-project') throw projectNotFoundError(selection.root)
      if (inspection.state === 'unreadable') {
        throw new EngineFaultError(
          ERROR_CODES.SCHEMA_INVALID,
          `the project bound to this session is unreadable: ${inspection.error ?? selection.root}`,
          'fix the directory permissions, or explicitly rebind with /novel use after the project is readable',
        )
      }
    }
    if (!allowLock && (await this.lockIsLive(store))) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        if (!(await this.lockIsLive(store))) break
      }
      if (await this.lockIsLive(store)) {
        throw new EngineFaultError(
          ERROR_CODES.TXN_IN_PROGRESS,
          'a writer is changing this project; the read-only snapshot would be torn',
          'retry after the write finishes; do not interpret this snapshot as stable',
        )
      }
    }
    const projectExists = await store.exists(PROJECT_FILE)
    if (!projectExists && !(await hasProjectState(store))) {
      // The directory can disappear between the session preflight above and
      // this read. A bound root that vanished must stay PROJECT_MISSING so the
      // caller never treats it as a fresh uninitialized path.
      if (selection.source === 'session') {
        throw missingProjectError({ selection, lastTitle: selection.title })
      }
      throw projectNotFoundError(store.root)
    }
    let project: NovelProject = {
      ...ENGINE_PROJECT_INITIAL,
      title: '（项目文件不可读）',
      // A damaged definition has no trustworthy identity. Never let the
      // initial project's epoch timestamp become a binding or registry value.
      created_at: '',
    }
    let projectError: string | null = projectExists ? null : `${PROJECT_FILE} is missing`
    if (projectExists) {
      try {
        const read = await store.readDoc(PROJECT_FILE, 'project')
        if (read === null) {
          throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, `${PROJECT_FILE} disappeared mid-read`)
        }
        project = read as unknown as NovelProject
      } catch (error) {
        // A newer schema or a path/symlink escape stays a hard stop; malformed
        // current-schema project metadata is recoverable so status, panel and
        // novel_amend can reach it.
        if (
          error instanceof EngineFaultError &&
          (error.code === ERROR_CODES.SCHEMA_TOO_NEW || error.code === ERROR_CODES.PATH_ESCAPE)
        ) {
          throw error
        }
        projectError = errorMessage(error)
      }
    }
    if (projectError === null && selection.created_at !== undefined && selection.created_at !== '') {
      // A bound project that lost its created_at is not the same identity. The
      // old code skipped the check when the disk value was empty, which let a
      // repaired/replaced project silently take over the binding.
      if (project.created_at === '' || project.created_at !== selection.created_at) {
        throw identityMismatchError({
          selection,
          actualCreatedAt: project.created_at,
          actualTitle: project.title,
        })
      }
    }
    const pipelinePath = joinRel(STATE_DIR, STATE_FILES.pipeline)
    let pipeline: PipelineState | null = null
    let pipelineError: string | null = null
    try {
      pipeline = (await store.readDoc(pipelinePath, 'pipeline')) as unknown as PipelineState | null
      if (pipeline === null) {
        throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, 'state/pipeline.yaml is missing')
      }
    } catch (error) {
      // Read-only status/doctor/restore must still reach a project whose
      // pipeline is damaged. Use the newest valid backup in memory; a write is
      // rejected by mutate() unless it is the dedicated restore transaction.
      pipelineError = errorMessage(error)
      const backup = await this.latestBackup(store, pipelinePath)
      if (backup === null) throw error
      try {
        pipeline = narrow('pipeline', parseYaml(backup)) as unknown as PipelineState
      } catch {
        throw error
      }
    }
    let briefs: PipelineState['briefs'] = pipeline.briefs
    let briefsError: string | null = null
    const briefsRaw = await store.readText(BRIEF_RECEIPTS_FILE)
    if (briefsRaw !== null) {
      // Once a receipt file exists, it is the authority for signed briefs. A
      // malformed receipt must not silently revive a legacy `pipeline.briefs`
      // signature and let a stale brief pass PG-01; treat the file as empty so
      // the next getBrief has to issue a fresh receipt.
      briefs = {}
      try {
        const parsed = parseYaml(briefsRaw) as Partial<BriefReceiptsDocument> | null
        if (parsed !== null && !Array.isArray(parsed.receipts)) {
          briefsError = 'state/briefs.yaml has no receipts array'
        }
        if (parsed !== null && Array.isArray(parsed.receipts)) {
          const valid: BriefReceiptsDocument['receipts'] = []
          for (const receipt of parsed.receipts) {
            if (
              typeof receipt === 'object' &&
              receipt !== null &&
              Number.isInteger(receipt.chapter) &&
              typeof receipt.stage === 'string' &&
              typeof receipt.digest === 'string' &&
              typeof receipt.issued_at === 'string'
            ) {
              valid.push(receipt)
            }
          }
          const next: PipelineState['briefs'] = {}
          // Use the same current/superseded derivation as novel_state. Reading
          // raw rows here used to let a newer pre-0.2.13 row (which has no
          // `current` field) override an explicitly promoted digest, so PG-01
          // believed a different brief than the one current_only showed.
          for (const receipt of this.normalizeBriefReceipts(valid)) {
            // Receipts are append-only across the whole book. A new chapter
            // must never inherit the previous chapter's P1..P8 signatures.
            if (receipt.chapter !== pipeline.chapter) continue
            if (receipt.current === false) continue
            const previous = next[receipt.stage]
            if (previous === undefined || previous.issued_at <= receipt.issued_at) {
              next[receipt.stage] = {
                digest: receipt.digest,
                issued_at: receipt.issued_at,
                ...(receipt.dependencies === undefined ? {} : { dependencies: receipt.dependencies }),
              }
            }
          }
          briefs = next
        }
      } catch (error) {
        // Receipts are evidence, not content. A damaged receipt file is treated
        // as missing so the model is asked for a fresh brief; the journal and
        // content gates remain fail-closed. 0.2.17 records the reason so status
        // and doctor can say why every PG-01 check fails.
        briefsError = errorMessage(error)
      }
    }
    const ledgerErrors: StateError[] = []
    const ledger = async <T>(
      path: string,
      kind: DocKind,
      code: StateError['code'],
      fallback: T,
    ): Promise<T> => {
      const read = await this.recoverableDoc<T>(store, path, kind)
      if (read.error !== null) {
        ledgerErrors.push({ path, code, message: read.error })
      } else if (read.value === null) {
        // A missing required ledger is damage, not an empty ledger. Treating it
        // as empty lets status report a healthy project and makes the repair
        // path unreachable; the journal would then reject every write.
        ledgerErrors.push({ path, code, message: `${path} is missing` })
      }
      return read.value ?? fallback
    }
    const chapters = await ledger(
      joinRel(STATE_DIR, STATE_FILES.chapters),
      'chapters',
      'CHAPTERS_UNREADABLE',
      emptyChapters(),
    )
    const characters = await ledger(
      joinRel(STATE_DIR, STATE_FILES.characters),
      'characters',
      'CHARACTERS_UNREADABLE',
      emptyCharacters(),
    )
    const world = await ledger(
      joinRel(STATE_DIR, STATE_FILES.world),
      'world',
      'WORLD_UNREADABLE',
      emptyWorld(),
    )
    const locks = await ledger(joinRel(STATE_DIR, STATE_FILES.locks), 'locks', 'LOCKS_UNREADABLE', {
      schema_version: 1 as const,
      locked_at_chapter: 0,
      characters: {},
      locations: {},
    })
    const timeline = await ledger(
      joinRel(STATE_DIR, STATE_FILES.timeline),
      'timeline',
      'TIMELINE_UNREADABLE',
      {
        schema_version: 1 as const,
        next_seq: 1,
        items: [],
      },
    )
    const foreshadows = await ledger(
      joinRel(STATE_DIR, STATE_FILES.foreshadows),
      'foreshadows',
      'FORESHADOWS_UNREADABLE',
      {
        schema_version: 1 as const,
        next_seq: 1,
        items: [],
      },
    )
    const relationships = await ledger(
      joinRel(STATE_DIR, STATE_FILES.relationships),
      'relationships',
      'RELATIONSHIPS_UNREADABLE',
      { schema_version: 1 as const, next_seq: 1, items: [] },
    )
    const handoff = await ledger<HandoffDocument | null>(
      joinRel(STATE_DIR, STATE_FILES.handoff),
      'handoff',
      'HANDOFF_UNREADABLE',
      null,
    )
    const nowIso = this.now().toISOString()
    // Synthesized planning documents must have a stable timestamp; otherwise
    // read-only probes and export replay keys change on every load.
    const emptyAt = project.created_at === '' ? '1970-01-01T00:00:00.000Z' : project.created_at
    let outline = emptyOutline(emptyAt)
    let outlinePresent = false
    let outlineError: string | null = null
    if (await store.exists(OUTLINE_FILE)) {
      outlinePresent = true
      try {
        const parsed = await store.readDoc(OUTLINE_FILE, 'outline')
        if (parsed === null)
          throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, `${OUTLINE_FILE} disappeared mid-read`)
        outline = validateOutlineDocument(parsed, {
          titleRule: this.rulepack.format.title,
          totalChapters: project.targets.total_chapters,
        })
      } catch (error) {
        if (error instanceof EngineFaultError && error.code === ERROR_CODES.SCHEMA_TOO_NEW) throw error
        outlineError = errorMessage(error)
      }
    }
    let worldbook = emptyWorldbook(emptyAt)
    let worldbookPresent = false
    let worldbookError: string | null = null
    if (await store.exists(WORLDBOOK_FILE)) {
      worldbookPresent = true
      try {
        const parsed = await store.readDoc(WORLDBOOK_FILE, 'worldbook')
        if (parsed === null)
          throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, `${WORLDBOOK_FILE} disappeared mid-read`)
        worldbook = validateWorldbookDocument(parsed, nowIso)
      } catch (error) {
        if (error instanceof EngineFaultError && error.code === ERROR_CODES.SCHEMA_TOO_NEW) throw error
        worldbookError = errorMessage(error)
      }
    }
    const chapter = pipeline.chapter
    const text = await store.readText(chapterFile(chapter))
    const previousText = chapter > 1 ? await store.readText(chapterFile(chapter - 1)) : null
    const previousTexts: string[] = []
    const previousChapterNums: number[] = []
    for (let offset = 1; offset <= 3 && chapter - offset >= 1; offset += 1) {
      const previous = await store.readText(chapterFile(chapter - offset))
      if (previous !== null) {
        previousTexts.push(previous)
        previousChapterNums.push(chapter - offset)
      }
    }
    const planRaw = await store.readText(planChapterFile(chapter))
    let plan: (ChapterPlanInput & { summary?: ChapterSummary }) | null = null
    let planError: string | null = null
    if (planRaw !== null) {
      try {
        const parsed = parsePlanYaml(planRaw, planChapterFile(chapter))
        validateStoredChapterPlan(parsed, planChapterFile(chapter))
        plan = parsed as unknown as ChapterPlanInput & { summary?: ChapterSummary }
        if (pipeline.draft !== undefined && pipeline.draft.chapter === chapter) {
          // The plan file is the immutable P2 evidence. The active summary
          // belongs to pipeline.draft; enriching the in-memory plan preserves
          // the existing gate/context contract without ever rewriting P2.
          plan = { ...plan, summary: pipeline.draft.summary }
        }
      } catch (error) {
        // A newer schema is not damage this engine may overwrite; the same
        // forward-compatibility boundary as every other readDoc must win over
        // the recovery path.
        if (error instanceof EngineFaultError && error.code === ERROR_CODES.SCHEMA_TOO_NEW) throw error
        planError = errorMessage(error)
      }
    }
    const worldPlanPath = planWorldFile(chapter)
    const worldPlanRaw = await store.readText(worldPlanPath)
    let worldPlan: import('../types.js').WorldPlanInput | null = null
    let worldPlanError: string | null = null
    if (worldPlanRaw !== null) {
      try {
        const parsed = parsePlanYaml(worldPlanRaw, worldPlanPath)
        const narrowed = narrow('worldPlan', parsed)
        validateWorldPlanShape(narrowed, worldPlanPath)
        worldPlan = narrowed as unknown as import('../types.js').WorldPlanInput
      } catch (error) {
        if (error instanceof EngineFaultError && error.code === ERROR_CODES.SCHEMA_TOO_NEW) throw error
        worldPlanError = errorMessage(error)
      }
    }
    const reviewRead = await this.recoverableDoc<ReviewDocument>(store, reviewFile(chapter), 'review')
    const checkRead = await this.recoverableDoc<CheckDocument>(store, checkFile(chapter), 'check')
    const review = reviewRead.value
    let reviewError = reviewRead.error
    const check = checkRead.value
    let checkError = checkRead.error
    // `done` is the archive state for the chapter that just finished, not the
    // start of a new chapter cycle. The next chapter legitimately has no world
    // plan/chapter plan/review yet; only the active cycle stages require them.
    const cycleRank = pipeline.stage === 'done' ? STAGE_RANK.idle : STAGE_RANK[pipeline.stage]
    if (worldPlanRaw === null && worldPlanError === null && cycleRank >= STAGE_RANK.P2) {
      worldPlanError = `${planWorldFile(chapter)} is missing`
    }
    if (planRaw === null && planError === null && cycleRank >= STAGE_RANK.P3) {
      planError = `${planChapterFile(chapter)} is missing`
    }
    // P5, P6 and ready_to_archive all consume the P4 review.
    if (review === null && reviewError === null && cycleRank >= STAGE_RANK.P5) {
      reviewError = `${reviewFile(chapter)} is missing`
    }
    // P6 is the check-writing stage; only ready_to_archive requires the result.
    if (check === null && checkError === null && pipeline.stage === 'ready_to_archive') {
      checkError = `${checkFile(chapter)} is missing`
    }
    if (pipelineError === null) {
      const latest = (await store.readDoc(
        joinRel(STATE_DIR, STATE_FILES.pipeline),
        'pipeline',
      )) as unknown as PipelineState | null
      if (latest === null || latest.revision !== pipeline.revision) {
        if (retries > 0) return this.loadAt(selection, retries - 1, allowLock)
        throw new EngineFaultError(
          ERROR_CODES.TXN_ABORTED,
          'the project changed while its snapshot was being read',
          'retry the read; if it keeps moving, wait for the writer to finish',
        )
      }
    }
    // A writer may have taken the lock after the initial check. Re-check before
    // returning: otherwise this read can see new ledgers with the old pipeline
    // while the writer is still before its pipeline rename.
    if (!allowLock && (await this.lockIsLive(store))) {
      if (retries > 0) return this.loadAt(selection, retries - 1, false)
      throw new EngineFaultError(
        ERROR_CODES.TXN_IN_PROGRESS,
        'a writer started while the snapshot was being read; the snapshot is torn',
        'retry after the write finishes; do not interpret this snapshot as stable',
      )
    }
    return {
      root: store.root,
      selection,
      project: project as unknown as NovelProject,
      projectError,
      pipelineError,
      pipeline: pipeline as unknown as PipelineState,
      briefs,
      briefsError,
      chapters: chapters as unknown as ChaptersDocument,
      characters: characters as unknown as Snapshot['characters'],
      world: world as unknown as Snapshot['world'],
      locks: locks as unknown as Snapshot['locks'],
      timeline: timeline as unknown as Snapshot['timeline'],
      foreshadows: foreshadows as unknown as Snapshot['foreshadows'],
      relationships: relationships as unknown as Snapshot['relationships'],
      handoff,
      outline,
      outlinePresent,
      outlineError,
      worldbook,
      worldbookPresent,
      worldbookError,
      worldPlan,
      ledgerErrors,
      text,
      previousText,
      previousTexts,
      previousChapterNums,
      plan,
      planError,
      worldPlanError,
      review,
      reviewError,
      check,
      checkError,
    }
  }

  /** A repair may bypass the journal hash only when the document is unreadable. */
  private async stateDocIsUnreadable(store: FsStore, path: string, kind: DocKind): Promise<boolean> {
    // A deleted required ledger is just as unreadable as invalid YAML, and it
    // must be repairable through the same explicit amend transaction.
    if ((await store.readText(path)) === null) return true
    try {
      const document = await store.readDoc(path, kind)
      if (kind === 'outline') {
        validateOutlineDocument(document, {
          titleRule: this.rulepack.format.title,
          totalChapters: null,
        })
      } else if (kind === 'worldbook') {
        validateWorldbookDocument(document, this.now().toISOString())
      }
      return false
    } catch (error) {
      if (error instanceof EngineFaultError && error.code === ERROR_CODES.SCHEMA_TOO_NEW) return false
      return true
    }
  }

  /** Read a review/check without letting one corrupt file wedge every read. */
  private async recoverableDoc<T>(
    store: FsStore,
    path: string,
    kind: DocKind,
  ): Promise<{ value: T | null; error: string | null }> {
    try {
      const value = (await store.readDoc(path, kind)) as unknown as T | null
      return { value, error: null }
    } catch (error) {
      // Do not turn a forward-compatible document into "recoverable damage":
      // the repair tool would overwrite a file written by a newer engine.
      if (error instanceof EngineFaultError && error.code === ERROR_CODES.SCHEMA_TOO_NEW) throw error
      return { value: null, error: errorMessage(error) }
    }
  }

  private async mutate<T>(options: {
    root?: string
    /** Pre-resolved selection (novel_init); otherwise resolveRoot owns it. */
    selection?: Selection
    /** Persist the explicit choice after a successful write (init opts out). */
    bindOnSuccess?: boolean
    /** Auto-register after a successful write; init handles registration itself. */
    registerOnSuccess?: boolean
    op: Operation
    key?: (snapshot: Snapshot) => string
    /** Chapter the caller named, used when the attempt is journaled. */
    chapter?: number
    emptyAllowed?: boolean
    /** Brief receipts deliberately do not advance pipeline.revision. */
    advanceRevision?: false
    /** Human reason for a maintenance transaction; persisted in the journal. */
    reason?: string
    /** Only an explicit amend/restore may overwrite these externally changed paths. */
    repairPaths?: readonly string[]
    /** Allow the dedicated pipeline restore path to load from a valid backup. */
    allowPipelineRecovery?: boolean
    run: (
      snapshot: Snapshot,
      context: { store: FsStore; revision: number },
    ) => Promise<{
      files: StagedFile[]
      data: T
      backup?: boolean
      event?: EngineEvent
      warnings?: Warning[]
      /** A durable idempotent answer: no transaction is committed. */
      replay?: boolean
    }>
  }): Promise<OpResult<T>> {
    const selection = options.selection ?? (await this.resolveRoot(options.root))
    const root = selection.root
    const signal = this.signalContext.getStore()
    const abortIfNeeded = (): void => {
      if (signal?.aborted === true) {
        throw new EngineFaultError(
          ERROR_CODES.TXN_ABORTED,
          `${options.op} was aborted before commit`,
          'retry the call if you still want the write',
        )
      }
    }
    abortIfNeeded()
    return this.mutex.run(root, async () => {
      if (options.emptyAllowed === true) ensureDirAt(root)
      const store = this.storeFor(root)
      if (options.emptyAllowed !== true && selection.source === 'session') {
        // Mutate takes the project lock before loadAt. Preflight the bound root
        // here so a deleted/replaced project reports MISSING/IDENTITY rather
        // than a generic NOT_FOUND (or a raw ENOENT from the lock acquire).
        const inspection = await inspectProject(selection.root)
        if (inspection.state === 'missing') {
          throw missingProjectError({
            selection,
            lastTitle: selection.title,
            movedTo: await this.movedProjectHint(selection),
          })
        }
        if (inspection.state === 'not-project') throw projectNotFoundError(selection.root)
        if (inspection.state === 'unreadable') {
          throw new EngineFaultError(
            ERROR_CODES.SCHEMA_INVALID,
            `the project bound to this session is unreadable: ${inspection.error ?? selection.root}`,
            'fix the directory permissions, or explicitly rebind with /novel use after the project is readable',
          )
        }
        if (
          inspection.state === 'damaged' &&
          selection.created_at !== undefined &&
          selection.created_at !== ''
        ) {
          // A damaged novel.yaml cannot prove identity. If the path was replaced
          // by another damaged book, a session-bound write would target the
          // wrong project. Reads may still show the damage; writes require the
          // user to pass an explicit project_root.
          throw identityMismatchError({
            selection,
            actualTitle: inspection.title,
          })
        }
      }
      const journalPath = joinRel(STATE_DIR, STATE_FILES.journal)
      const journalWasPresent = await store.exists(journalPath)
      const projectExists = await store.exists(PROJECT_FILE)
      if (options.emptyAllowed !== true && !projectExists && !(await hasProjectState(store))) {
        // Do not let FileLock/transaction mkdir recreate a deleted project.
        // A directory with surviving state is a damaged project and remains
        // repairable through amend.
        throw projectNotFoundError(root)
      }
      if (options.emptyAllowed === true && projectExists) {
        throw new EngineInputError(
          ERROR_CODES.PROJECT_EXISTS,
          `a project already exists at ${store.root}`,
          'use a different directory, or call novel_status to inspect the existing project',
        )
      }
      if (
        options.emptyAllowed !== true &&
        projectExists &&
        !(await store.exists(joinRel(STATE_DIR, STATE_FILES.journal)))
      ) {
        throw new EngineFaultError(
          ERROR_CODES.JOURNAL_MISSING,
          'state/journal.jsonl is missing; journal integrity and crash recovery are unavailable',
          'restore state/journal.jsonl from a backup before writing; a project with novel.yaml must have its audit journal',
        )
      }
      const lock = new FileLock(join(root, LOCK_FILE), undefined, undefined, async (record) => {
        await appendJournal(
          store,
          {
            txid: randomUUID(),
            at: new Date().toISOString(),
            op: 'lock_reclaimed',
            chapter: 0,
            revision: 0,
            files: [LOCK_FILE],
            status: 'committed',
            reason:
              record === null
                ? 'reclaimed a partially written lock file'
                : `reclaimed lock from pid ${record.pid}`,
          },
          { repairTrailing: true },
        )
      })
      await lock.acquire()
      try {
        if (options.emptyAllowed === true) {
          const exists = await store.exists(PROJECT_FILE)
          if (!exists) {
            const stateFiles = [
              STATE_FILES.pipeline,
              STATE_FILES.chapters,
              STATE_FILES.characters,
              STATE_FILES.world,
              STATE_FILES.locks,
              STATE_FILES.timeline,
              STATE_FILES.foreshadows,
              STATE_FILES.relationships,
              STATE_FILES.handoff,
            ].map((file) => joinRel(STATE_DIR, file))
            stateFiles.push(joinRel(STATE_DIR, STATE_FILES.journal), ARCHIVE_DIGESTS, BRIEF_RECEIPTS_FILE)
            // A crashed init must be recoverable. A complete/untouched pending
            // transaction is promoted/aborted before the hasState check; a
            // partial one fails closed with its own recovery hint instead of
            // becoming a permanent PROJECT_EXISTS. A surviving committed
            // journal without novel.yaml is project evidence and must still
            // report PROJECT_EXISTS, not a misleading hash mismatch.
            const pending = await inspectPending(store)
            if (pending.state === 'partial') {
              throw new EngineFaultError(
                ERROR_CODES.PENDING_PARTIAL,
                `pending transaction ${pending.txid ?? 'unknown'} partially changed this directory`,
                `inspect ${pending.stagingDir ?? '.staging'}/ before initializing over it`,
              )
            }
            if (pending.state === 'complete' || pending.state === 'untouched') {
              await assertJournalConsistent(store)
              if (await store.exists(PROJECT_FILE)) {
                throw new EngineInputError(
                  ERROR_CODES.PROJECT_EXISTS,
                  'a project already exists at this root after pending recovery',
                  'use a different directory, or call novel_status to inspect the existing project',
                )
              }
            }
            // A journal created by the lock-reclaim callback is part of this
            // init, not pre-existing project evidence. Only count a journal
            // that was present before the lock attempt.
            const journalPath = joinRel(STATE_DIR, STATE_FILES.journal)
            const journalHasProjectHistory =
              journalWasPresent &&
              (await readJournal(store)).records.some(
                (record) => record.status === 'committed' && record.op !== 'lock_reclaimed',
              )
            const stateCandidates = journalHasProjectHistory
              ? stateFiles
              : stateFiles.filter((path) => path !== journalPath)
            // A surviving journal or derived mirror is project evidence. Reject
            // before journal reconciliation so the caller gets PROJECT_EXISTS,
            // not a misleading hash mismatch from the old project.
            const hasState =
              (await Promise.all(stateCandidates.map((file) => store.exists(file)))).some(Boolean) ||
              (await store.list('chapters')).length > 0 ||
              (await store.list('plans')).length > 0 ||
              (await store.list('reviews')).length > 0 ||
              (await store.list('checks')).length > 0 ||
              (await store.exists(OUTLINE_FILE)) ||
              (await store.exists(WORLDBOOK_FILE))
            if (hasState) {
              throw new EngineInputError(
                ERROR_CODES.PROJECT_EXISTS,
                'state documents exist but novel.yaml is missing; refusing to overwrite the project',
                'restore novel.yaml, or initialize a new empty directory',
              )
            }
            // No surviving project evidence: reconcile a torn journal tail or
            // stale staging before the fresh init transaction.
            await assertJournalConsistent(store)
            const created = await options.run(this.emptySnapshot(root, selection), {
              store,
              revision: 1,
            })
            await runTransaction(store, {
              txid: randomUUID(),
              op: options.op,
              chapter: 1,
              revision: 1,
              files: created.files,
              backup: false,
              signal,
              ...(options.reason === undefined ? {} : { reason: options.reason }),
            })
            this.replay.clear()
            return { data: created.data, revision: 1, warnings: created.warnings ?? [] }
          }
        }
        // The snapshot must be read while holding the cross-process lock;
        // otherwise a second process can commit between read and write and the
        // later writer silently overwrites it with a stale revision.
        await assertJournalConsistent(store, options.repairPaths ?? [])
        const snapshot = await this.loadAt(selection, 1, true)
        if (snapshot.pipelineError !== null && options.allowPipelineRecovery !== true) {
          throw new EngineFaultError(
            ERROR_CODES.SCHEMA_INVALID,
            `state/pipeline.yaml is unreadable: ${snapshot.pipelineError}`,
            'restore a valid pipeline backup with novel_restore { paths: ["state/pipeline.yaml"], txid: ... }; other writes are blocked until then',
          )
        }
        if (
          selection.source === 'session' &&
          selection.created_at !== undefined &&
          selection.created_at !== '' &&
          snapshot.projectError !== null
        ) {
          // The cheap inspection can race a replacement between the preflight
          // and this locked load. Never let a session-bound write proceed when
          // the project definition cannot prove its identity.
          throw identityMismatchError({
            selection,
            actualTitle: snapshot.project.title,
          })
        }
        const key = options.key?.(snapshot)
        if (key !== undefined) {
          const cached = this.replay.get(`${root}|${options.op}|${key}`)
          // Export content is a pure function of the files it reads; other
          // exports interleaved between two identical calls advance the
          // revision without changing that content. Its key includes every
          // rendered input, so it can replay across those revisions safely.
          const revisionBound = options.op !== 'export'
          if (cached !== undefined && (!revisionBound || cached.revision === snapshot.pipeline.revision)) {
            return { ...(cached as OpResult<T>), replayed: true }
          }
        }
        // Reject an identical retry only when the brief/stage/revision context
        // is also unchanged. Renewing a brief is a real fix and must re-open the
        // operation even if the submission text is byte-identical.
        const retryContext = sha256(
          stableJson({
            revision: snapshot.pipeline.revision,
            stage: snapshot.pipeline.stage,
            briefs: snapshot.briefs,
          }),
        )
        if (key !== undefined) {
          // Compare with the latest attempt for this operation/chapter, not any
          // historical attempt. A later failed submission with different
          // content means the earlier failure is no longer "the last refused
          // attempt" and must not poison a retry forever.
          const latestAttempt = [...(await readJournal(store)).records]
            .reverse()
            .find(
              (row) =>
                row.op === options.op &&
                row.chapter === (options.chapter ?? snapshot.pipeline.chapter) &&
                (row.status === 'committed' || row.status === 'aborted'),
            )
          if (
            latestAttempt !== undefined &&
            latestAttempt.status === 'aborted' &&
            latestAttempt.attempt === true &&
            latestAttempt.retry_key === key &&
            latestAttempt.retry_context === retryContext &&
            latestAttempt.code !== undefined &&
            RETRYABLE_ABORT_CODES.has(latestAttempt.code)
          ) {
            throw new EngineInputError(
              ERROR_CODES.RETRY_UNCHANGED,
              `${options.op} is identical to the last refused attempt (${latestAttempt.code})`,
              'change the content, delta or issue evidence, or renew the current brief; an unchanged retry would waste a transaction',
            )
          }
        }
        const revision =
          options.advanceRevision === false ? snapshot.pipeline.revision : snapshot.pipeline.revision + 1
        abortIfNeeded()
        let outcome: Awaited<ReturnType<typeof options.run>>
        try {
          outcome = await options.run(snapshot, { store, revision })
        } catch (error) {
          // A gate/input refusal never reaches runTransaction, so without this
          // row the audit trail only contains successful writes. Record the
          // refusal as an attempt with its machine code and blocking items.
          await appendJournal(store, {
            txid: randomUUID(),
            at: this.now().toISOString(),
            op: options.op,
            chapter: options.chapter ?? snapshot.pipeline.chapter,
            revision: snapshot.pipeline.revision,
            intended_revision:
              options.advanceRevision === false ? snapshot.pipeline.revision : snapshot.pipeline.revision + 1,
            files: [],
            status: 'aborted',
            reason: errorMessage(error),
            attempt: true,
            stage: snapshot.pipeline.stage,
            ...(key === undefined ? {} : { retry_key: key, retry_context: retryContext }),
            ...(error instanceof EngineError ? { code: error.code } : {}),
            ...(error instanceof EngineError && error.hint !== undefined ? { hint: error.hint } : {}),
            ...(error instanceof EngineBlockedError ? { blocking: error.blocking } : {}),
            ...(error instanceof CheckSubmissionError ? { blocking: error.blocking.slice(0, 20) } : {}),
          }).catch(() => undefined)
          throw error
        }
        if (outcome.replay === true) {
          return {
            data: outcome.data,
            revision: snapshot.pipeline.revision,
            warnings: outcome.warnings ?? [],
            replayed: true,
          }
        }
        abortIfNeeded()
        await runTransaction(store, {
          txid: randomUUID(),
          op: options.op,
          chapter: options.chapter ?? snapshot.pipeline.chapter,
          revision,
          files: outcome.files,
          backup: outcome.backup ?? false,
          backupRetention: this.config.storage.backupRetention,
          signal,
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        })
        const result: OpResult<T> = { data: outcome.data, revision, warnings: outcome.warnings ?? [] }
        // An amend can change the project title. Re-read only when the project
        // definition itself was written, so the session binding and registry do
        // not keep the old title until the next explicit read.
        let metadataSnapshot = snapshot
        const metadataEnabled = options.bindOnSuccess !== false || options.registerOnSuccess !== false
        if (metadataEnabled && outcome.files.some((file) => file.path === PROJECT_FILE)) {
          try {
            metadataSnapshot = await this.loadAt(selection, 1, true)
          } catch {
            // The content transaction is already committed; keeping the old
            // metadata snapshot is safer than reporting the write as failed.
          }
        }
        try {
          await this.recordSelection(selection, metadataSnapshot, {
            bind: options.bindOnSuccess,
            register: options.registerOnSuccess,
          })
        } catch (error) {
          // The content transaction already committed. Surface metadata failure
          // as a warning; never turn a committed write into a retryable error.
          result.warnings.push({
            code: 'SESSION_BINDING_FAILED',
            message: `project write committed, but project selection metadata could not be written: ${errorMessage(error)}`,
          })
        }
        if (key !== undefined) {
          this.invalidateReplay(root, options.op)
          this.replay.set(`${root}|${options.op}|${key}`, result)
        } else {
          this.invalidateReplay(root, options.op)
        }
        if (outcome.event !== undefined) {
          try {
            this.onEvent?.(outcome.event)
          } catch (error) {
            // The transaction is already committed. A host listener that throws
            // must never turn a successful archive into a retryable failure.
            result.warnings.push({
              code: 'EVENT_LISTENER_FAILED',
              message: `the write committed, but a host event listener threw: ${errorMessage(error)}`,
            })
          }
        }
        return result
      } finally {
        await lock.release()
      }
    })
  }

  private invalidateReplay(root: string, op: Operation): void {
    const prefix = `${root}|`
    // A content-changing commit invalidates every cached answer for the
    // project, including exports. A narrower commit keeps export entries,
    // whose output depends only on the archived content.
    const contentChanging =
      op === 'archiveChapter' || op === 'amend' || op === 'rollback' || op === 'initProject'
    for (const key of [...this.replay.keys()]) {
      if (!key.startsWith(prefix)) continue
      if (contentChanging || !key.includes('|export|')) this.replay.delete(key)
    }
  }

  private emptySnapshot(root: string, selection: Selection): Snapshot {
    return {
      root,
      selection,
      project: { ...ENGINE_PROJECT_INITIAL },
      projectError: null,
      pipelineError: null,
      pipeline: emptyPipeline({ revision: 1, chapter: 1, stage: 'idle' }),
      briefs: {},
      briefsError: null,
      chapters: emptyChapters(),
      characters: emptyCharacters(),
      world: emptyWorld(),
      locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
      handoff: null,
      outline: emptyOutline(this.now().toISOString()),
      outlinePresent: false,
      outlineError: null,
      worldbook: emptyWorldbook(this.now().toISOString()),
      worldbookPresent: false,
      worldbookError: null,
      worldPlan: null,
      ledgerErrors: [],
      text: null,
      previousText: null,
      previousTexts: [],
      previousChapterNums: [],
      plan: null,
      planError: null,
      worldPlanError: null,
      review: null,
      reviewError: null,
      check: null,
      checkError: null,
    }
  }
}

/* ------------------------------------------------------------------ helpers */

const NEXT_TOOL_BY_BRIEF: Record<BriefStage, string> = {
  P1: 'novel_plan_world',
  P2: 'novel_plan_chapter',
  P3: 'novel_write_draft',
  P4: 'novel_review',
  P5: 'novel_revise',
  P6: 'novel_check',
  P8: 'novel_archive',
}

/** The task book each stage must see before its next write operation. */
const STATUS_BRIEF: Readonly<Record<Stage, BriefStage | null>> = {
  idle: 'P1',
  P2: 'P2',
  P3: 'P3',
  P4: 'P4',
  P5: 'P5',
  P6: 'P6',
  ready_to_archive: 'P8',
  done: 'P1',
}

const yaml = (value: unknown): string => stringify(value, { lineWidth: 0 })

/** Walk a dot path; array segments are numeric indices. */
function amendPathParts(path: string): string[] {
  const parts = path.split('.').filter((part) => part !== '')
  if (parts.length === 0) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'amend patch path must not be empty')
  }
  return parts
}

/**
 * 0.2.17: does this patch touch a top-level key?
 *
 * The confirmation gate must ask for exactly the writes the engine will apply.
 * Comparing raw strings (`.path === 'style'`) let `".style"` — the same field
 * after the engine's own normalisation — set the style without a dialog. Both
 * sides now parse the path with `amendPathParts`, so the gate cannot be walked
 * around by a spelling the engine accepts.
 */
export function amendPatchTouchesKey(patch: readonly { path?: unknown }[] | undefined, key: string): boolean {
  if (patch === undefined) return false
  return patch.some((edit) => {
    if (typeof edit?.path !== 'string') return false
    let parts: string[]
    try {
      parts = amendPathParts(edit.path)
    } catch {
      // An empty path is rejected by `applyAmendPatch` anyway; it changes nothing.
      return false
    }
    return parts[0] === key
  })
}

/**
 * Apply the JSON-Pointer subset (`replace|add|remove`) to a document. Paths
 * use dots; array indices are numeric segments. Unknown parents fail closed.
 */
export function applyAmendPatch(
  document: Record<string, unknown>,
  ops: readonly AmendPatchOp[],
): Record<string, unknown> {
  const root = structuredClone(document) as Record<string, unknown>
  for (const [index, op] of ops.entries()) {
    if (op === null || typeof op !== 'object') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `amend patch[${index}] must be an object`)
    }
    if (!['replace', 'add', 'remove'].includes(op.op)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `amend patch[${index}].op must be replace|add|remove`,
        'use replace for an existing field, add for a new one, remove to delete it',
        { details: { field: `patch[${index}].op`, expected: 'replace|add|remove', received: op.op } },
      )
    }
    const parts = amendPathParts(op.path)
    let cursor: unknown = root
    for (const part of parts.slice(0, -1)) {
      if (Array.isArray(cursor)) {
        const at = Number(part)
        if (!Number.isInteger(at) || at < 0 || at >= cursor.length) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `amend patch[${index}] path "${op.path}" does not exist (${part} is out of range)`,
          )
        }
        cursor = cursor[at]
        continue
      }
      if (typeof cursor !== 'object' || cursor === null) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `amend patch[${index}] path "${op.path}" does not exist`,
        )
      }
      cursor = (cursor as Record<string, unknown>)[part]
      if (cursor === undefined) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `amend patch[${index}] path "${op.path}" does not exist; add creates a field but not its parents`,
          'read the document with novel_state first and patch an existing parent',
          {
            details: {
              field: op.path,
              expected: 'an existing parent path',
              received: op.path,
              example: { op: 'replace', path: 'book.logline', value: '...' },
            },
          },
        )
      }
    }
    const last = parts[parts.length - 1]!
    if (Array.isArray(cursor)) {
      const at = Number(last)
      if (!Number.isInteger(at) || at < 0) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `amend patch[${index}] array index "${last}" must be a non-negative integer`,
        )
      }
      if (op.op === 'remove') {
        if (at >= cursor.length) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `amend patch[${index}] remove index ${at} is out of range`,
          )
        }
        cursor.splice(at, 1)
      } else if (op.op === 'add') {
        if (at > cursor.length) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `amend patch[${index}] add index ${at} skips past the end of the array`,
          )
        }
        cursor.splice(at, 0, op.value)
      } else {
        if (at >= cursor.length) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `amend patch[${index}] replace index ${at} is out of range`,
          )
        }
        cursor[at] = op.value
      }
      continue
    }
    if (typeof cursor !== 'object' || cursor === null) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `amend patch[${index}] path "${op.path}" has a non-object parent`,
      )
    }
    const target = cursor as Record<string, unknown>
    if (op.op === 'remove') {
      delete target[last]
    } else if (op.op === 'replace') {
      if (!Object.hasOwn(target, last)) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `amend patch[${index}] replace target "${op.path}" does not exist; use add`,
        )
      }
      target[last] = op.value
    } else {
      if (Object.hasOwn(target, last) && op.value !== undefined) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `amend patch[${index}] add target "${op.path}" already exists; use replace`,
        )
      }
      target[last] = op.value
    }
  }
  return root
}

/** Sections amend must not shrink unless the caller says the deletion is intentional. */
const LEDGER_SECTIONS: Partial<Record<DocKind, readonly string[]>> = {
  foreshadows: ['items'],
  timeline: ['items'],
  relationships: ['items'],
  characters: ['characters'],
  chapters: ['chapters'],
  world: ['locations', 'abilities', 'artifacts', 'factions', 'rules'],
  locks: ['characters', 'locations'],
}

/** Stable identity of a ledger row: id, name, or num. */
function ledgerRowKey(row: Record<string, unknown>, index: number): string {
  for (const key of ['id', 'name', 'num'] as const) {
    const value = row[key]
    if (typeof value === 'string' || typeof value === 'number') return `${key}:${String(value)}`
  }
  return `index:${index}`
}

/** Rows present before but absent after; used to refuse a silent truncation. */
function missingLedgerRows(kind: DocKind, before: unknown, after: Record<string, unknown>): string[] {
  const sections = LEDGER_SECTIONS[kind]
  if (sections === undefined) return []
  const baseline = recordOf(before)
  if (baseline === null) return []
  const missing: string[] = []
  for (const section of sections) {
    const left = baseline[section]
    const right = after[section]
    const leftRows = Array.isArray(left) ? left : null
    const rightRows = Array.isArray(right) ? right : null
    if (leftRows === null) continue
    const rightKeys = new Set((rightRows ?? []).map((row, index) => ledgerRowKey(recordOf(row) ?? {}, index)))
    for (const [index, row] of leftRows.entries()) {
      const record = recordOf(row)
      if (record === null) continue
      const key = ledgerRowKey(record, index)
      if (!rightKeys.has(key)) missing.push(`${section}.${key}`)
    }
  }
  return missing
}

/**
 * The highest id suffix the archive has already handed out for a ledger, or 0.
 * The next allocator value must be strictly greater, otherwise a restore or an
 * amend reissues an id the chapter index still references (P1-13).
 */
export function ledgerIdFloor(
  kind: 'foreshadows' | 'timeline' | 'relationships',
  chapters: Snapshot['chapters'],
  handoff: Snapshot['handoff'],
): number {
  const prefix = kind === 'foreshadows' ? 'FS-' : kind === 'timeline' ? 'TE-' : 'RL-'
  let floor = 0
  for (const chapter of chapters.chapters) {
    for (const value of Object.values(chapter.assigned_ids ?? {})) {
      if (typeof value !== 'string' || !value.startsWith(prefix)) continue
      const match = /-(\d+)$/.exec(value)
      if (match !== null) floor = Math.max(floor, Number(match[1]))
    }
  }
  if (kind === 'foreshadows' && handoff !== null) {
    for (const hook of handoff.open_hooks) {
      if (!hook.id.startsWith(prefix)) continue
      const match = /-(\d+)$/.exec(hook.id)
      if (match !== null) floor = Math.max(floor, Number(match[1]))
    }
  }
  return floor
}

/**
 * Cross-ledger references a restore can dangle.
 *
 * Restoring one ledger from an older pre-image while leaving the others at HEAD
 * was accepted: `state/relationships.yaml` could come back naming a character
 * the restored `state/characters.yaml` no longer declares, and nothing
 * complained until P6 rediscovered it as an advisory (R2). The guard only
 * refuses references the restore *introduces*, because a legacy book may
 * already carry rows an ideal ledger would not, and repairing one file must not
 * require repairing the whole book first.
 */
export function ledgerReferenceProblems(
  documents: {
    characters: Snapshot['characters']
    locks: Snapshot['locks']
    timeline: Snapshot['timeline']
    relationships: Snapshot['relationships']
    handoff: Snapshot['handoff']
    /** 0.2.17: locks.locations must name a location world.yaml declares. */
    world?: Snapshot['world']
  },
  totalChapters: number | null,
): string[] {
  const problems: string[] = []
  const known = new Set(documents.characters.characters.map((character) => character.name))
  for (const name of Object.keys(documents.locks.characters)) {
    if (!known.has(name)) {
      problems.push(`locks.characters["${name}"] locks a character characters.yaml does not declare`)
    }
  }
  if (documents.world !== undefined) {
    const knownLocations = new Set(documents.world.locations.map((location) => location.name))
    for (const name of Object.keys(documents.locks.locations)) {
      if (!knownLocations.has(name)) {
        problems.push(`locks.locations["${name}"] locks a location world.yaml does not declare`)
      }
    }
  }
  for (const item of documents.timeline.items) {
    for (const name of item.characters) {
      if (!known.has(name)) {
        problems.push(`timeline.${item.id} names "${name}", which characters.yaml does not declare`)
      }
    }
  }
  for (const item of documents.relationships.items) {
    for (const name of [item.a, item.b]) {
      if (!known.has(name)) {
        problems.push(`relationships.${item.id} names "${name}", which characters.yaml does not declare`)
      }
    }
  }
  const handoff = documents.handoff
  if (handoff !== null) {
    if (totalChapters !== null && handoff.volume > totalChapters) {
      problems.push(`handoff.volume ${handoff.volume} exceeds targets.total_chapters ${totalChapters}`)
    }
    if (handoff.current_chapter > handoff.next_chapter) {
      problems.push(
        `handoff.current_chapter ${handoff.current_chapter} is ahead of next_chapter ${handoff.next_chapter}`,
      )
    }
  }
  return problems
}

/**
 * A damaged ledger has no parsed shape, but "error + 64KB of raw text" left the
 * author unable to tell a truncated file from a reordered one without counting
 * rows by hand (R3). The summary is deliberately regex-only: it must never
 * claim a row the YAML parser could not see, and it must work on a file that
 * does not parse at all.
 */
export function damagedLedgerSummary(raw: string | null): Record<string, unknown> {
  if (raw === null) return { present: false }
  const lines = raw.split('\n')
  const rowIds = [...raw.matchAll(/^\s*-\s+id:\s*["']?([A-Za-z]+-\d+)["']?\s*$/gm)].map(
    (match) => match[1] as string,
  )
  const names = [...raw.matchAll(/^\s*-\s+name:\s*(.+)$/gm)].map((match) => match[1]!.trim())
  // `state/locks.yaml` is the one map-shaped ledger: its rows are two-space
  // keys under `characters:`, so the list-oriented patterns reported a damaged
  // locks file as "0 rows" while it held twenty (R3 was only exercised on the
  // list-shaped `characters.yaml`). Only exact two-space keys with nothing
  // after the colon qualify, which no list row or nested field matches.
  const mapKeys = [...raw.matchAll(/^ {2}([^\s#-][^:]*):\s*$/gm)].map((match) => match[1]!.trim())
  const nextSeq = /^next_seq:\s*(\d+)\s*$/m.exec(raw)
  return {
    present: true,
    bytes: Buffer.byteLength(raw, 'utf8'),
    lines: lines.length,
    rows: Math.max(rowIds.length, names.length, mapKeys.length),
    next_seq: nextSeq === null ? null : Number(nextSeq[1]),
    sample_ids: rowIds.slice(0, 5),
    sample_names: [...names, ...mapKeys].slice(0, 5),
    // A truncated file has a dangling last row; a reordered file does not.
    ends_without_newline: raw.length > 0 && !raw.endsWith('\n'),
  }
}

/** Top-level field changes for the amend receipt; nested edits show as the parent key. */
function documentChanges(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Array<{ path: string; before: unknown; after: unknown }> {
  if (before === null) return []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changes: Array<{ path: string; before: unknown; after: unknown }> = []
  for (const key of [...keys].sort(compareText)) {
    const left = stableJson(before[key] ?? null)
    const right = stableJson(after[key] ?? null)
    if (left === right) continue
    changes.push({ path: key, before: before[key], after: after[key] })
  }
  return changes
}

/**
 * A patch is applied to the whole raw document, but `mergeProjectAmendment`
 * treats every key it receives as an intent to change it. Sending the merged
 * document therefore claimed `genre`, `platform` and `created_at` even when the
 * patch only touched `title`, and every project patch was rejected as
 * "genre is immutable" (R1). Reduce a patched project to the fields that
 * actually differ, at both the document and the `targets` level.
 */
export function projectPatchDelta(
  base: Record<string, unknown>,
  patched: Record<string, unknown>,
): Record<string, unknown> {
  const delta: Record<string, unknown> = {}
  const keys = new Set([...Object.keys(base), ...Object.keys(patched)])
  for (const key of keys) {
    if (key === 'targets') continue
    if (stableJson(base[key] ?? null) !== stableJson(patched[key] ?? null)) delta[key] = patched[key]
  }
  const baseTargets = recordOf(base.targets) ?? {}
  const patchedTargets = recordOf(patched.targets) ?? {}
  const targetDelta: Record<string, unknown> = {}
  const targetKeys = new Set([...Object.keys(baseTargets), ...Object.keys(patchedTargets)])
  for (const key of targetKeys) {
    if (stableJson(baseTargets[key] ?? null) !== stableJson(patchedTargets[key] ?? null)) {
      targetDelta[key] = patchedTargets[key]
    }
  }
  if (Object.keys(targetDelta).length > 0) delta.targets = targetDelta
  return delta
}

/** Read one dot path out of a document; `undefined` when any segment is absent. */
function readAmendPath(document: unknown, path: string): unknown {
  let cursor: unknown = document
  for (const part of path.split('.').filter((segment) => segment !== '')) {
    if (Array.isArray(cursor)) {
      const at = Number(part)
      if (!Number.isInteger(at) || at < 0) return undefined
      cursor = cursor[at]
      continue
    }
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

/**
 * Receipt rows for a local patch. An amend that changed `items.1.title` must
 * not report `items` as the change: the caller asked for a field-level edit and
 * needs field-level evidence of what moved.
 */
function patchChanges(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  ops: readonly AmendPatchOp[],
): Array<{ path: string; before: unknown; after: unknown }> {
  const changes: Array<{ path: string; before: unknown; after: unknown }> = []
  const seen = new Set<string>()
  for (const op of ops) {
    if (seen.has(op.path)) continue
    seen.add(op.path)
    const left = readAmendPath(before, op.path) ?? null
    const right = readAmendPath(after, op.path) ?? null
    if (stableJson(left) === stableJson(right)) continue
    changes.push({ path: op.path, before: left, after: right })
  }
  return changes
}

/** Apply a patch only to the exact manuscript the caller hashed. */
function applyRevisionPatch(text: string, patch: import('../types.js').RevisionPatch): string {
  const actual = sha256(text)
  if (actual !== patch.expected_hash) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `patch expected_hash ${patch.expected_hash} does not match the current manuscript ${actual}`,
      'read the current text and compute its sha256 again; nothing was written',
    )
  }
  interface PlannedEdit {
    index: number
    start: number
    end: number
    newText: string
  }
  const planned: PlannedEdit[] = []
  for (const [index, edit] of patch.edits.entries()) {
    const positions: number[] = []
    // Search with +1, not +old_text.length: two legal matches may overlap and
    // an occurrence must select from the real match set.
    let cursor = 0
    while (cursor <= text.length) {
      const found = text.indexOf(edit.old_text, cursor)
      if (found === -1) break
      positions.push(found)
      cursor = found + 1
    }
    const expectedOccurrence = edit.occurrence ?? 1
    // "0 matches" is its own failure: the old_text is simply not there. The
    // uniqueness branch used to catch it first, so the message with the
    // nearest paragraph (and its similarity) was unreachable (R6).
    if (positions.length === 0) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `patch.edits[${index}] matches 0 place(s); the old_text is not in the current manuscript`,
        'copy old_text verbatim from the current text, including punctuation',
        {
          details: {
            field: `patch.edits[${index}].old_text`,
            expected: 'a verbatim fragment of the current manuscript',
            received: edit.old_text.slice(0, 120),
            candidates: [],
            nearest: nearestMatch(text, edit.old_text),
          },
        },
      )
    }
    if (edit.occurrence === undefined && positions.length !== 1) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `patch.edits[${index}] matches ${positions.length} place(s); a unique old_text is required`,
        'include more surrounding text, or set occurrence explicitly',
        {
          details: {
            field: `patch.edits[${index}].old_text`,
            expected: 'exactly one match',
            received: edit.old_text.slice(0, 40),
            candidate_count: positions.length,
            candidates: positions.slice(0, 3).map((position) => ({
              index: paragraphOfOffset(text, position),
              text: text.slice(Math.max(0, position - 20), position + 40),
            })),
            nearest: nearestMatch(text, edit.old_text),
          },
        },
      )
    }
    if (positions.length < expectedOccurrence) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `patch.edits[${index}].occurrence ${expectedOccurrence} exceeds ${positions.length} match(es)`,
        'the occurrence must be within the number of exact matches in the current manuscript',
        {
          details: {
            field: `patch.edits[${index}].occurrence`,
            expected: `${positions.length} match(es) available`,
            received: expectedOccurrence,
            received_type: 'integer',
            candidates: positions.slice(0, 3).map((position) => ({
              index: paragraphOfOffset(text, position),
              text: text.slice(Math.max(0, position - 20), position + 40),
            })),
          },
        },
      )
    }
    const start = positions[expectedOccurrence - 1]!
    const current = { index, start, end: start + edit.old_text.length, newText: edit.new_text }
    if (planned.some((other) => current.start < other.end && other.start < current.end)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `patch.edits[${index}] overlaps another edit; overlapping edits cannot be applied atomically`,
        'merge overlapping edits into one old_text/new_text pair; nothing was written',
      )
    }
    planned.push(current)
  }
  // Apply from the end so earlier offsets remain valid. Rejecting overlaps above
  // also means a replacement cannot accidentally become the anchor of a later
  // edit.
  planned.sort((left, right) => right.start - left.start)
  let next = text
  for (const edit of planned) {
    next = `${next.slice(0, edit.start)}${edit.newText}${next.slice(edit.end)}`
  }
  return next
}

/** Raw repair text is capped: a damaged 5MB ledger must not become the payload. */
const RAW_REPAIR_LIMIT = 64 * 1024

function rawForRepair(raw: string | null): { raw: string | null; raw_truncated: boolean } {
  if (raw === null) return { raw: null, raw_truncated: false }
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes <= RAW_REPAIR_LIMIT) return { raw, raw_truncated: false }
  return {
    raw: Buffer.from(raw, 'utf8').subarray(0, RAW_REPAIR_LIMIT).toString('utf8'),
    raw_truncated: true,
  }
}

/**
 * A read model crosses a JSON boundary. Drop `undefined` members, break cycles
 * with a marker, and fall back to a summary if serialization still fails.
 */
export function jsonSafeValue<T>(value: T): T {
  const prune = (input: unknown, seen: WeakSet<object>): unknown => {
    if (input === undefined) return undefined
    if (input === null) return null
    if (Array.isArray(input)) {
      return input.map((item) => {
        const next = prune(item, seen)
        return next === undefined ? null : next
      })
    }
    if (typeof input === 'object') {
      const object = input as Record<string, unknown>
      if (seen.has(object)) return '[Circular]'
      seen.add(object)
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(object)) {
        const next = prune(item, seen)
        if (next !== undefined) out[key] = next
      }
      seen.delete(object)
      return out
    }
    if (typeof input === 'function' || typeof input === 'symbol' || typeof input === 'bigint') {
      return String(input)
    }
    return input
  }
  try {
    const pruned = prune(value, new WeakSet<object>())
    JSON.stringify(pruned)
    return pruned as T
  } catch (error) {
    return {
      error: 'UNSERIALIZABLE_READ_MODEL',
      message: errorMessage(error),
    } as T
  }
}

/** 1-based paragraph containing a character offset. */
function paragraphOfOffset(text: string, index: number): number {
  const prefix = text.slice(0, Math.max(0, index))
  const completed = splitParagraphs(prefix).length
  return /\n\s*$/.test(prefix) ? completed + 1 : Math.max(1, completed)
}

/** Nearest paragraph for a failed exact match: the one sharing the longest run. */
function nearestMatch(
  text: string,
  needle: string,
): { paragraph: number; text: string; offset: number; similarity: number } | undefined {
  const match = matchEvidence(text, needle)
  return match.nearest === undefined
    ? undefined
    : {
        paragraph: match.nearest.paragraph,
        text: match.nearest.text,
        offset: match.nearest.offset,
        // Without the number the model cannot tell "only punctuation differs"
        // from "you copied a different paragraph" (R6).
        similarity: match.nearest.similarity,
      }
}

const emptyChapters = (): ChaptersDocument => ({ schema_version: 1, chapters: [] })
const emptyCharacters = (): Snapshot['characters'] => ({ schema_version: 1, characters: [] })
const emptyWorld = (): Snapshot['world'] => ({
  schema_version: 1,
  locations: [],
  abilities: [],
  artifacts: [],
  factions: [],
  rules: [],
})

const pipelineWith = (
  snapshot: Snapshot,
  revision: number,
  patch: Partial<PipelineState>,
): PipelineState => ({
  schema_version: 1,
  revision,
  chapter: snapshot.pipeline.chapter,
  stage: snapshot.pipeline.stage,
  rounds: snapshot.pipeline.rounds,
  // `snapshot.briefs` is the effective current-chapter view. Writing the raw
  // legacy pipeline.briefs back would preserve a stale chapter signature on
  // every unrelated edit, and doctor would report LEGACY_BRIEFS forever.
  briefs: snapshot.briefs,
  blocking: snapshot.pipeline.blocking,
  ...(snapshot.pipeline.draft === undefined ? {} : { draft: snapshot.pipeline.draft }),
  review_digest: snapshot.pipeline.review_digest,
  last_action: snapshot.pipeline.last_action,
  ...patch,
})

/**
 * Validate every document an archive is about to stage. The delta is
 * model-supplied, so checking only its action fields is not enough: a scalar
 * such as `timeline.story_time: 42` would otherwise be committed and make the
 * project unreadable for every later tool and panel request.
 */
function assertArchiveDocuments(documents: ReadonlyArray<readonly [DocKind, unknown]>): void {
  for (const [kind, document] of documents) {
    try {
      narrow(kind, document)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `archive would write an invalid ${kind} document: ${detail}`,
        'fix the state_delta or handoff field types and retry; nothing was written',
      )
    }
  }
}

const action = (op: string, at: Date, digest: string): PipelineState['last_action'] => ({
  op,
  at: at.toISOString(),
  digest,
})

/** One rule for code-level and instance-level advisory acknowledgement. */
interface AckedFinding {
  id: string
  code: string
  reason: string
  at: string
  expires_at_chapter?: number
}

/**
 * Acknowledgements that still apply at `chapter`. An expiry is inclusive: a
 * finding agreed until chapter 5 is silent in chapters 1–5 and returns in 6.
 */
const liveAckIds = (findings: readonly AckedFinding[], chapter: number): Set<string> =>
  new Set(
    findings
      .filter((finding) => finding.expires_at_chapter === undefined || chapter <= finding.expires_at_chapter)
      .map((finding) => finding.id),
  )

function advisoryAcknowledged(
  violation: Violation,
  codes: readonly string[],
  findings: readonly AckedFinding[],
  chapter: number,
): boolean {
  if (codes.includes(violation.code)) return true
  const live = liveAckIds(findings, chapter)
  // An aggregated row is suppressed only when every instance behind it is.
  if (violation.instances !== undefined && violation.instances.length > 0) {
    return violation.instances.every((instance) => live.has(instance.id))
  }
  return violation.id !== undefined && live.has(violation.id)
}

const machineWarnings = (
  machine: MachineResult,
  acknowledged: readonly string[] = [],
  acknowledgedFindings: readonly AckedFinding[] = [],
  chapter = 0,
): Warning[] =>
  machine.violations
    .filter(
      (violation) =>
        violation.severity === 'advisory' &&
        !advisoryAcknowledged(violation, acknowledged, acknowledgedFindings, chapter),
    )
    .slice(0, 5)
    .map((violation) => {
      // U9: once one instance of an aggregated advisory has been acknowledged,
      // the row must point at an instance that still needs work — it used to
      // keep the detail and location of the instance already signed off.
      const live = liveAckIds(acknowledgedFindings, chapter)
      const pending =
        violation.instances === undefined
          ? []
          : violation.instances.filter((instance) => !live.has(instance.id))
      const location = pending[0]?.location ?? violation.location
      const detail =
        pending.length === 0 ? violation.detail : pending.map((instance) => instance.detail).join('；')
      // A ledger-level finding has no paragraph; printing "paragraph undefined"
      // is what made it impossible to locate (M8/U9).
      const place =
        location.ledger === undefined
          ? location.paragraph === undefined
            ? 'manuscript'
            : `paragraph ${location.paragraph}`
          : `${location.ledger}${location.entity === undefined ? '' : ` · ${location.entity}`}`
      return { code: violation.code, message: `${detail} (${place})` }
    })

/** 0.1.2 archive digests used localeCompare; keep that comparison only for upgrades. */
const archivedCardSnapshot = (card: OutlineChapter): ArchivedCardSnapshot => ({
  title: card.title,
  scene_type: card.scene_type,
  target_words: [card.target_words[0], card.target_words[1]],
  cast: [...card.cast],
  goal: card.goal,
  conflict: card.conflict,
  hook: card.hook,
  notes: card.notes,
  archived_at: card.archived_at,
})

const archivedCardDigest = (card: ArchivedCardSnapshot): string => `v1:${sha256(stableJson(card))}`

const archivedCardRecord = (record: ChapterRecord): Record<string, unknown> => {
  const card = record.archive_card
  if (card === undefined) return {}
  return {
    num: record.num,
    ...card,
    status: 'archived',
    word_count: record.word_count,
    // R7: derived cards must show the CJK count too, including records
    // archived before the field existed (null, never 0).
    cjk_words: record.cjk_words ?? null,
    score: record.score,
  }
}

const legacyStableJson = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (typeof input === 'object' && input !== null) {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      )
    }
    return input
  }
  return JSON.stringify(normalize(value)) ?? 'null'
}

const normalizeHandoffOverride = (value: ArchiveHandoff | undefined): ArchiveHandoff | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'handoff must be an object')
  }
  const volume = value.volume
  if (volume !== undefined && (!Number.isInteger(volume) || volume < 1)) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'handoff.volume must be a positive integer')
  }
  const volumeName = value.volume_name
  if (volumeName !== undefined && (typeof volumeName !== 'string' || volumeName.trim() === '')) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'handoff.volume_name must be non-empty')
  }
  const act = value.act
  if (act !== undefined && (typeof act !== 'string' || act.trim() === '')) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'handoff.act must be non-empty')
  }
  const actProgress = value.act_progress
  if (actProgress !== undefined && parseActProgress(actProgress) === null) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      'handoff.act_progress must be n/d with a positive denominator and n <= d',
    )
  }
  return {
    ...(volume === undefined ? {} : { volume }),
    ...(volumeName === undefined ? {} : { volume_name: volumeName.trim() }),
    ...(act === undefined ? {} : { act: act.trim() }),
    ...(actProgress === undefined ? {} : { act_progress: actProgress.trim() }),
  }
}

const legacyArchiveDigest = (input: ArchiveSubmission): string =>
  sha256(legacyStableJson({ chapter: input.chapter, state_delta: input.state_delta, handoff: input.handoff }))

const LENIENT_TITLE_PREFIX = /^第\s*\d+\s*章\s*/

/** Titles are stored as bodies; the format rule judges the rendered heading. */
const stripTitlePrefix = (title: string): string => title.replace(LENIENT_TITLE_PREFIX, '').trim()

const composeTitle = (chapter: number, title: string | null, pattern?: string): string | null => {
  if (title === null) return null
  const text = title.trim()
  if (pattern !== undefined && new RegExp(pattern).test(text)) return text
  // A prefixed title with non-canonical spacing is normalized rather than
  // producing `第1章 第 1 章 …` in the export.
  const body = stripTitlePrefix(text)
  return `第${chapter}章 ${body === '' ? text : body}`
}

const errorMessage = (error: unknown): string =>
  error instanceof Error
    ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ''}`
    : String(error)

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const mergeProjectAmendment = (
  content: Record<string, unknown>,
  old: NovelProject,
): Record<string, unknown> => {
  // 0.2.17: `style` is allowed through so the migration window can reach the
  // semantic gate. `amendProblems` remains the single place that decides whether
  // a change is legal — two owners would drift.
  const allowed = new Set([
    'schema_version',
    'title',
    'author',
    'description',
    'targets',
    'total_chapters',
    'style',
  ])
  for (const key of Object.keys(content)) {
    if (!allowed.has(key)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `novel.yaml amend cannot change "${key}"`,
        'only title, author, description, targets and style are mutable (style only while the migration window is open)',
      )
    }
  }
  const merged: Record<string, unknown> = { ...old, ...content }
  if (content.targets !== undefined) {
    const targets = recordOf(content.targets)
    if (targets === null) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'targets must be an object')
    }
    const allowedTargets = new Set([
      'words_per_chapter',
      'dialogue_ratio',
      'total_chapters',
      'min_cjk_chars',
      'dialogue_ratio_metric',
      'allow_negative_balances',
    ])
    for (const key of Object.keys(targets)) {
      if (!allowedTargets.has(key)) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `novel.yaml targets cannot change "${key}"`,
          'mutable targets: total_chapters, min_cjk_chars, dialogue_ratio_metric, allow_negative_balances; words_per_chapter and dialogue_ratio are immutable',
        )
      }
    }
    merged.targets = { ...old.targets, ...targets }
  }
  if (Object.hasOwn(content, 'total_chapters')) {
    const targets = recordOf(merged.targets) ?? {}
    merged.targets = { ...targets, total_chapters: content.total_chapters }
  }
  delete merged.total_chapters
  return narrow('project', merged)
}

/**
 * 0.2.17: the one definition of "the style migration window is still open".
 *
 * Both the confirmation gate (`styleMigration`, asked before the dialog is put
 * in front of the user) and the semantic gate (`amendProblems`, the authority on
 * whether the write is legal) read this. They used to disagree — the gate
 * counted archived rows while the gate required an empty chapter list — so a
 * project with a draft row could be asked to confirm and then be refused.
 *
 * The rule is "nothing archived", not "nothing written": a project nobody has
 * finished a chapter in is exactly the case §4.4 wants migratable.
 */
const styleWindowOpen = (
  chapters: { chapters: ReadonlyArray<{ archived_at?: string | null }> },
  archivedFiles: number,
): boolean => chapters.chapters.every((row) => row.archived_at == null) && archivedFiles === 0

const amendProblems = (
  kind: DocKind,
  oldDocument: unknown,
  nextDocument: Record<string, unknown>,
  snapshot: Snapshot,
  path: string,
  archivedFiles = 0,
  projectBaseline: NovelProject = snapshot.project,
  projectDamaged = false,
  archiveDigests: Readonly<Record<string, string>> = {},
  archivedChapterNumbers?: readonly number[],
  allowDelete = false,
): string[] => {
  const problems: string[] = []
  const old = recordOf(oldDocument)
  if (kind === 'project') {
    const next = nextDocument
    const targets = recordOf(next.targets)
    if (typeof next.title !== 'string' || next.title.trim() === '') problems.push('title must not be empty')
    if (!projectDamaged) {
      if (next.genre !== projectBaseline.genre) problems.push('genre is immutable')
      if (next.platform !== projectBaseline.platform) problems.push('platform is immutable')
      if (next.created_at !== projectBaseline.created_at) problems.push('created_at is immutable')
      // 0.2.17 (§4.4): the style is immutable once decided, with exactly one
      // exception — a project created before the style layer may set it once,
      // while nothing is archived. `undefined` means "predates the feature";
      // `null` means "the user chose none", which is a decision, not a gap.
      if (next.style !== projectBaseline.style) {
        const migrating =
          projectBaseline.style === undefined && styleWindowOpen(snapshot.chapters, archivedFiles)
        if (!migrating) {
          problems.push('style is immutable; it may only be set once, before the first archived chapter')
        }
      }
    }
    const oldTargets = projectBaseline.targets
    if (targets === null) {
      problems.push('targets must be an object')
    } else {
      if (
        !projectDamaged &&
        (JSON.stringify(targets.words_per_chapter) !== JSON.stringify(oldTargets.words_per_chapter) ||
          JSON.stringify(targets.dialogue_ratio) !== JSON.stringify(oldTargets.dialogue_ratio))
      ) {
        problems.push(
          'words_per_chapter and dialogue_ratio are immutable; total_chapters, min_cjk_chars, dialogue_ratio_metric and allow_negative_balances may change',
        )
      }
      if (
        targets.min_cjk_chars !== undefined &&
        targets.min_cjk_chars !== null &&
        (!Number.isInteger(targets.min_cjk_chars) || (targets.min_cjk_chars as number) <= 0)
      ) {
        problems.push('targets.min_cjk_chars must be a positive integer or null')
      }
      if (
        targets.dialogue_ratio_metric !== undefined &&
        !['lines', 'chars', 'both'].includes(String(targets.dialogue_ratio_metric))
      ) {
        problems.push('targets.dialogue_ratio_metric must be lines|chars|both')
      }
      if (
        targets.allow_negative_balances !== undefined &&
        typeof targets.allow_negative_balances !== 'boolean'
      ) {
        problems.push('targets.allow_negative_balances must be a boolean')
      }
      const total = targets.total_chapters
      if (total !== null && (!Number.isInteger(total) || (total as number) < 1)) {
        problems.push('targets.total_chapters must be a positive integer or null')
      }
      const archivedCount = Math.max(snapshot.chapters.chapters.length, archivedFiles)
      if (typeof total === 'number' && Number.isInteger(total) && total < archivedCount) {
        problems.push(`targets.total_chapters ${total} is below the ${archivedCount} archived chapter(s)`)
      }
      if (typeof total === 'number' && Number.isInteger(total) && snapshot.outlineError === null) {
        for (const volume of snapshot.outline.volumes) {
          if (volume.end_chapter > total) {
            problems.push(
              `targets.total_chapters ${total} would truncate volume "${volume.title}" ending at ${volume.end_chapter}`,
            )
          }
        }
        for (const card of snapshot.outline.chapters) {
          if (card.num > total) {
            problems.push(`targets.total_chapters ${total} is below the existing outline card ${card.num}`)
          }
        }
      }
    }
    return problems
  }

  if (kind === 'chapters') {
    const active = snapshot.pipeline.chapter
    const oldRows = Array.isArray(old?.chapters) ? old.chapters : []
    const nextRows = Array.isArray(nextDocument.chapters) ? nextDocument.chapters : []
    const rowNum = (raw: unknown): number | null => {
      const row = recordOf(raw)
      return row !== null && Number.isInteger(row.num) ? (row.num as number) : null
    }
    const oldArchived = oldRows.filter((raw) => {
      const num = rowNum(raw)
      return num !== null && num < active
    })
    const nextArchived = nextRows.filter((raw) => {
      const num = rowNum(raw)
      return num !== null && num < active
    })
    if (nextArchived.length < oldArchived.length) {
      problems.push('archived chapters may not be deleted')
    }
    const archivedCount = Math.max(0, active - 1, archivedFiles)
    if (nextArchived.length < archivedCount) {
      problems.push(
        `chapters index has ${nextArchived.length} archived rows but ${archivedCount} chapter(s) are archived`,
      )
    }
    const byNum = new Map<number, Record<string, unknown>>()
    for (const [index, raw] of nextRows.entries()) {
      const row = recordOf(raw)
      if (row === null || !Number.isInteger(row.num)) {
        problems.push(`chapters[${index}] is not a valid record`)
        continue
      }
      const num = row.num as number
      if (num !== index + 1) problems.push(`chapters[${index}].num must be ${index + 1}`)
      if (num >= active) {
        problems.push(
          `chapter ${num} is active or in the future; the index may contain only archived chapters`,
        )
      }
      if (byNum.has(num)) problems.push(`chapter ${num} appears more than once`)
      byNum.set(num, row)
      const knownDigest = archiveDigests[String(num)]
      if (knownDigest !== undefined && row.archive_digest !== knownDigest) {
        problems.push(`archived chapter ${num} cannot change its archive_digest`)
      }
    }
    for (const raw of oldArchived) {
      const before = recordOf(raw)
      if (before === null || !Number.isInteger(before.num)) continue
      const after = byNum.get(before.num as number)
      if (after === undefined) {
        problems.push(`archived chapter ${String(before.num)} is missing`)
        continue
      }
      if (before.content_hash !== after.content_hash) {
        problems.push(`archived chapter ${String(before.num)} cannot change its content_hash`)
      }
      if (before.archive_digest !== after.archive_digest) {
        problems.push(`archived chapter ${String(before.num)} cannot change its archive_digest`)
      }
      if (before.archive_card === undefined && after.archive_card !== undefined) {
        problems.push(`archived chapter ${String(before.num)} cannot add archive_card through amend`)
      } else if (
        before.archive_card !== undefined &&
        (after.archive_card === undefined ||
          stableJson(before.archive_card) !== stableJson(after.archive_card))
      ) {
        problems.push(`archived chapter ${String(before.num)} cannot change its archive_card`)
      }
      if (before.archive_card_digest !== after.archive_card_digest) {
        problems.push(`archived chapter ${String(before.num)} cannot change its archive_card_digest`)
      }
      if (stableJson(before.assigned_ids ?? {}) !== stableJson(after.assigned_ids ?? {})) {
        problems.push(`archived chapter ${String(before.num)} cannot change its assigned_ids`)
      }
      for (const field of [
        'title',
        'file',
        'word_count',
        // R7: `cjk_words` is the number an author checks the PG-03 floor
        // against, so it is archive evidence like `word_count`; without this
        // row an amend could write any count and nothing would notice.
        'cjk_words',
        'dialogue_lines',
        'dialogue_ratio',
        'scene_type',
        'narrator',
        'score',
        'status',
        'summary',
        'rounds',
        'final_check',
        'archived_at',
      ] as const) {
        if (stableJson(before[field]) !== stableJson(after[field])) {
          problems.push(`archived chapter ${String(before.num)} cannot change its ${field}`)
        }
      }
    }
    return problems
  }

  if (kind === 'timeline' || kind === 'foreshadows' || kind === 'relationships') {
    if (snapshot.ledgerErrors.some((error) => error.code === 'CHAPTERS_UNREADABLE')) {
      problems.push('cannot validate next_seq while chapters.yaml is unreadable')
      return problems
    }
    if (
      kind === 'foreshadows' &&
      snapshot.ledgerErrors.some((error) => error.code === 'HANDOFF_UNREADABLE')
    ) {
      problems.push('cannot validate next_seq while handoff.yaml is unreadable')
      return problems
    }
    const items = Array.isArray(nextDocument.items) ? nextDocument.items : []
    const ids = new Set<string>()
    const oldById = new Map<string, Record<string, unknown>>()
    for (const raw of Array.isArray(old?.items) ? old.items : []) {
      const row = recordOf(raw)
      if (row !== null && typeof row.id === 'string') oldById.set(row.id, row)
    }
    let maxSuffix = 0
    for (const [index, raw] of items.entries()) {
      const row = recordOf(raw)
      if (row === null || typeof row.id !== 'string' || row.id === '') {
        problems.push(`items[${index}].id must be a non-empty string`)
        continue
      }
      if (ids.has(row.id)) problems.push(`item id "${row.id}" appears more than once`)
      ids.add(row.id)
      const match = /-(\d+)$/.exec(row.id)
      if (match !== null) maxSuffix = Math.max(maxSuffix, Number(match[1]))
      if (kind === 'foreshadows' && row.status === 'resolved' && old !== null) {
        const previous = oldById.get(row.id)
        const anchor =
          typeof row.resolved_anchor === 'string' ? Array.from(row.resolved_anchor.trim()).length : 0
        if (previous !== undefined && previous.status !== 'resolved' && anchor < 8) {
          problems.push(
            `newly resolved foreshadow ${row.id} must include a resolved_anchor of at least 8 characters`,
          )
        }
      }
    }
    if (old !== null) {
      const removed = [...oldById.keys()].filter((id) => !ids.has(id))
      if (removed.length > 0 && !allowDelete) {
        problems.push(`ledger rows cannot disappear through amend: ${removed.slice(0, 5).join(', ')}`)
      }
    }
    const nextSeq = nextDocument.next_seq
    const prefix = kind === 'foreshadows' ? 'FS-' : kind === 'timeline' ? 'TE-' : 'RL-'
    const engineFloor = ledgerIdFloor(kind, snapshot.chapters, snapshot.handoff)
    if (!Number.isInteger(nextSeq) || (nextSeq as number) < 1) {
      problems.push('next_seq must be a positive integer')
    } else {
      if ((nextSeq as number) < maxSuffix + 1) {
        problems.push(`next_seq ${String(nextSeq)} would collide with existing id suffix ${maxSuffix}`)
      }
      if ((nextSeq as number) < items.length + 1) {
        problems.push(`next_seq ${String(nextSeq)} is below items.length + 1`)
      }
      if ((nextSeq as number) < engineFloor + 1) {
        problems.push(
          `next_seq ${String(nextSeq)} would reuse an id already assigned by an archived chapter (${prefix}${String(engineFloor).padStart(3, '0')})`,
        )
      }
      const oldSeq = old?.next_seq
      if (typeof oldSeq === 'number' && (nextSeq as number) < oldSeq) {
        problems.push(`next_seq cannot decrease from ${oldSeq} to ${String(nextSeq)}`)
      }
    }
    if (kind !== 'relationships') return problems
  }

  if (kind === 'characters') {
    const rows = Array.isArray(nextDocument.characters) ? nextDocument.characters : []
    const names = new Set(
      rows.map((raw) => recordOf(raw)?.name).filter((name): name is string => typeof name === 'string'),
    )
    if (names.size !== rows.length) problems.push('characters must have unique names')
    if (old !== null) {
      const oldNames = (Array.isArray(old.characters) ? old.characters : [])
        .map((raw) => recordOf(raw)?.name)
        .filter((name): name is string => typeof name === 'string')
      const removed = oldNames.filter((name) => !names.has(name))
      // A small ledger can be an intentional full replacement (the concurrency
      // test swaps one entity for another). Only a ledger larger than one page
      // can be a stripped pagination payload; page-guard errors cover the
      // retained-page case.
      if (oldNames.length > STATE_PAGE_MAX && removed.length > 0) {
        problems.push(`character rows cannot disappear through amend: ${removed.slice(0, 5).join(', ')}`)
      }
    }
    // The target may be the damaged ledger being repaired; validity is decided
    // by whether the *referencing* ledgers are readable, not by the target's
    // own prior damage.
    if (!snapshot.ledgerErrors.some((error) => error.code === 'LOCKS_UNREADABLE')) {
      for (const name of Object.keys(snapshot.locks.characters)) {
        if (!names.has(name)) problems.push(`lock for removed character "${name}" still exists`)
      }
    }
    if (!snapshot.ledgerErrors.some((error) => error.code === 'RELATIONSHIPS_UNREADABLE')) {
      for (const relationship of snapshot.relationships.items) {
        if (!names.has(relationship.a) || !names.has(relationship.b)) {
          problems.push(`relationship ${relationship.id} would reference a removed character`)
        }
      }
    }
    return problems
  }

  if (kind === 'world') {
    const allNames: string[] = []
    for (const section of ['locations', 'abilities', 'artifacts', 'factions', 'rules'] as const) {
      const rows = Array.isArray(nextDocument[section]) ? nextDocument[section] : []
      for (const raw of rows) {
        const name = recordOf(raw)?.name
        if (typeof name === 'string') allNames.push(name)
      }
    }
    if (new Set(allNames).size !== allNames.length) problems.push('world entities must have unique names')
    if (old !== null) {
      const oldNames: string[] = []
      for (const section of ['locations', 'abilities', 'artifacts', 'factions', 'rules'] as const) {
        for (const raw of Array.isArray(old[section]) ? old[section] : []) {
          const name = recordOf(raw)?.name
          if (typeof name === 'string') oldNames.push(name)
        }
      }
      const present = new Set(allNames)
      const removed = oldNames.filter((name) => !present.has(name))
      if (oldNames.length > STATE_PAGE_MAX && removed.length > 0) {
        problems.push(`world rows cannot disappear through amend: ${removed.slice(0, 5).join(', ')}`)
      }
    }
    const locations = new Set(
      (Array.isArray(nextDocument.locations) ? nextDocument.locations : [])
        .map((raw) => recordOf(raw)?.name)
        .filter((name): name is string => typeof name === 'string'),
    )
    if (!snapshot.ledgerErrors.some((error) => error.code === 'LOCKS_UNREADABLE')) {
      for (const name of Object.keys(snapshot.locks.locations)) {
        if (!locations.has(name)) problems.push(`lock for removed location "${name}" still exists`)
      }
    }
    return problems
  }

  if (kind === 'locks') {
    const characters = new Set(snapshot.characters.characters.map((character) => character.name))
    const locations = new Set(snapshot.world.locations.map((location) => location.name))
    if (snapshot.ledgerErrors.some((error) => error.code === 'CHARACTERS_UNREADABLE')) {
      problems.push('cannot validate locks while characters.yaml is unreadable')
    }
    if (snapshot.ledgerErrors.some((error) => error.code === 'WORLD_UNREADABLE')) {
      problems.push('cannot validate locks while world.yaml is unreadable')
    }
    for (const name of Object.keys(recordOf(nextDocument.characters) ?? {})) {
      if (!characters.has(name)) problems.push(`lock references unknown character "${name}"`)
    }
    for (const name of Object.keys(recordOf(nextDocument.locations) ?? {})) {
      if (!locations.has(name)) problems.push(`lock references unknown location "${name}"`)
    }
    if (old !== null) {
      const nextCharacters = new Set(Object.keys(recordOf(nextDocument.characters) ?? {}))
      const nextLocations = new Set(Object.keys(recordOf(nextDocument.locations) ?? {}))
      const removedCharacters = Object.keys(recordOf(old.characters) ?? {}).filter(
        (name) => !nextCharacters.has(name),
      )
      const removedLocations = Object.keys(recordOf(old.locations) ?? {}).filter(
        (name) => !nextLocations.has(name),
      )
      const removed = [...removedCharacters, ...removedLocations]
      const oldCount =
        Object.keys(recordOf(old.characters) ?? {}).length + Object.keys(recordOf(old.locations) ?? {}).length
      if (oldCount > STATE_PAGE_MAX && removed.length > 0) {
        problems.push(`lock rows cannot disappear through amend: ${removed.slice(0, 5).join(', ')}`)
      }
    }
    return problems
  }

  if (kind === 'relationships') {
    if (snapshot.ledgerErrors.some((error) => error.code === 'CHARACTERS_UNREADABLE')) {
      problems.push('cannot validate relationships while characters.yaml is unreadable')
      return problems
    }
    const names = new Set(snapshot.characters.characters.map((character) => character.name))
    const oldIds = new Set(
      (Array.isArray(old?.items) ? old.items : [])
        .map((raw) => recordOf(raw)?.id)
        .filter((id): id is string => typeof id === 'string'),
    )
    const oldPairs = new Set<string>()
    for (const raw of Array.isArray(old?.items) ? old.items : []) {
      const row = recordOf(raw)
      if (typeof row?.a === 'string' && typeof row.b === 'string') {
        oldPairs.add(`${row.a}|${row.b}`)
        oldPairs.add(`${row.b}|${row.a}`)
      }
    }
    for (const raw of Array.isArray(nextDocument.items) ? nextDocument.items : []) {
      const row = recordOf(raw)
      if (row !== null && (typeof row.a !== 'string' || typeof row.b !== 'string')) {
        problems.push('relationship endpoints must be strings')
      } else if (row !== null && (!names.has(row.a as string) || !names.has(row.b as string))) {
        problems.push(`relationship ${String(row.id)} references an unknown character`)
      }
      const pairIsNew =
        row !== null &&
        typeof row.a === 'string' &&
        typeof row.b === 'string' &&
        !oldPairs.has(`${row.a}|${row.b}`)
      if (
        row !== null &&
        typeof row.id === 'string' &&
        old !== null &&
        (!oldIds.has(row.id) || pairIsNew) &&
        row.type_code === undefined
      ) {
        problems.push(`new relationship ${row.id} must include type_code`)
      }
    }
    return problems
  }

  if (kind === 'handoff') {
    const current = nextDocument.current_chapter
    const next = nextDocument.next_chapter
    if (!Number.isInteger(current) || (current as number) < 0) {
      problems.push('handoff.current_chapter must be a non-negative integer')
    }
    if (!Number.isInteger(next) || (next as number) < 1) {
      problems.push('handoff.next_chapter must be a positive integer')
    } else if (typeof current === 'number' && Number.isInteger(current) && next !== current + 1) {
      problems.push('handoff.next_chapter must equal current_chapter + 1')
    }
    if (!Number.isInteger(nextDocument.volume) || (nextDocument.volume as number) < 1) {
      problems.push('handoff.volume must be a positive integer')
    }
    for (const field of ['volume_name', 'act'] as const) {
      if (typeof nextDocument[field] !== 'string' || (nextDocument[field] as string).trim() === '') {
        problems.push(`handoff.${field} must be non-empty`)
      }
    }
    if (parseActProgress(nextDocument.act_progress) === null) {
      problems.push('handoff.act_progress must be n/d with a positive denominator and n <= d')
    }
    if (!snapshot.ledgerErrors.some((error) => error.code === 'CHAPTERS_UNREADABLE')) {
      const archivedMax = snapshot.chapters.chapters.reduce((max, record) => Math.max(max, record.num), 0)
      if (typeof current === 'number' && Number.isInteger(current) && current !== archivedMax) {
        problems.push(`handoff.current_chapter ${String(current)} must match archived chapter ${archivedMax}`)
      }
    }
    const hooks = Array.isArray(nextDocument.open_hooks) ? nextDocument.open_hooks : []
    const seenHooks = new Set<string>()
    if (!snapshot.ledgerErrors.some((error) => error.code === 'FORESHADOWS_UNREADABLE')) {
      const openById = new Map(snapshot.foreshadows.items.map((item) => [item.id, item]))
      for (const raw of hooks) {
        const hook = recordOf(raw)
        if (hook === null || typeof hook.id !== 'string' || typeof hook.title !== 'string') {
          problems.push('handoff.open_hooks must contain id/title strings')
          continue
        }
        if (seenHooks.has(hook.id)) problems.push(`handoff.open_hooks duplicate ${hook.id}`)
        seenHooks.add(hook.id)
        const known = openById.get(hook.id)
        if (known === undefined) {
          problems.push(`handoff.open_hooks references unknown foreshadow ${hook.id}`)
        } else if (known.title !== hook.title) {
          problems.push(`handoff.open_hooks title for ${hook.id} does not match foreshadows`)
        }
      }
    }
    return problems
  }

  if (kind === 'outline') {
    const chapters = Array.isArray(nextDocument.chapters) ? nextDocument.chapters : []
    const byNum = new Map<number, Record<string, unknown>>()
    for (const [index, raw] of chapters.entries()) {
      const row = recordOf(raw)
      if (row === null || !Number.isInteger(row.num)) {
        problems.push(`chapters[${index}] must have an integer num`)
        continue
      }
      const num = row.num as number
      if (byNum.has(num)) problems.push(`chapter ${num} appears more than once`)
      byNum.set(num, row)
    }
    const oldChapters = Array.isArray(old?.chapters) ? old.chapters : []
    const oldCards = new Map<number, Record<string, unknown>>()
    for (const raw of oldChapters) {
      const row = recordOf(raw)
      if (row !== null && Number.isInteger(row.num)) oldCards.set(row.num as number, row)
    }
    const indexed = new Set(snapshot.chapters.chapters.map((record) => record.num))
    const chaptersUnreadable = snapshot.ledgerErrors.some((error) => error.code === 'CHAPTERS_UNREADABLE')
    if (chaptersUnreadable) {
      // With no readable index, archive_card evidence is unavailable too. A
      // repair may only preserve cards already proven by the old image; it
      // must not invent or rewrite an archived card in this window.
      for (const [num, card] of byNum) {
        if (card.status === 'archived' && !oldCards.has(num)) {
          problems.push(
            `cannot verify archived chapter ${num} while chapters.yaml is unreadable; restore the chapter index from backups/ first`,
          )
        }
      }
      for (const num of archivedChapterNumbers ?? []) {
        if (byNum.get(num)?.status !== 'archived') {
          problems.push(
            `cannot verify archived chapter ${num} while chapters.yaml is unreadable; keep its archived card`,
          )
        }
      }
    }
    if (!chaptersUnreadable) {
      for (const [num, card] of byNum) {
        if (card.status === 'archived' && !indexed.has(num)) {
          problems.push(`archived chapter ${num} has a card but is not in the chapter index`)
        }
      }
    }
    const volumes = Array.isArray(nextDocument.volumes) ? nextDocument.volumes : []
    for (const [index, raw] of volumes.entries()) {
      const row = recordOf(raw)
      if (
        row === null ||
        !Number.isInteger(row.start_chapter) ||
        !Number.isInteger(row.end_chapter) ||
        (row.end_chapter as number) < (row.start_chapter as number)
      ) {
        problems.push(`volumes[${index}] must have start_chapter <= end_chapter`)
      }
    }
    if (snapshot.outlineError === null) {
      try {
        const nextVolumes = normalizeVolumes(volumes, {
          totalChapters: snapshot.project.targets.total_chapters,
          rejectDuplicateTitles: false,
        })
        assertArchivedCardVolumes(
          snapshot.chapters.chapters,
          snapshot.outline.chapters,
          snapshot.outline.volumes,
          nextVolumes,
          'novel_amend',
        )
        assertArchivedCardsInVolumes(
          snapshot.chapters.chapters,
          [...byNum.values()].map((row) => ({
            num: row.num as number,
            volume: (row.volume ?? null) as number | null,
          })),
          nextVolumes,
          'novel_amend',
        )
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error))
      }
    }
    for (const record of snapshot.chapters.chapters) {
      const card = byNum.get(record.num)
      if (card === undefined) {
        problems.push(`archived chapter ${record.num} must keep its outline card`)
        continue
      }
      if (card.status !== 'archived') {
        problems.push(`archived chapter ${record.num} cannot be changed back to planned`)
      }
      if (card.title !== stripChapterPrefix(record.title)) {
        problems.push(`archived chapter ${record.num} cannot change its card title`)
      }
      if (card.scene_type !== record.scene_type) {
        problems.push(`archived chapter ${record.num} cannot change its card scene_type`)
      }
      if (card.word_count !== record.word_count || card.score !== record.score) {
        problems.push(`archived chapter ${record.num} cannot change its word_count/score`)
      }
      // R7: a card that carries a CJK count may not disagree with the record.
      // Cards written before the field existed (absent/null) stay editable, so
      // older books are not locked out of a legitimate repair.
      if (
        card.cjk_words !== undefined &&
        card.cjk_words !== null &&
        card.cjk_words !== (record.cjk_words ?? null)
      ) {
        problems.push(`archived chapter ${record.num} cannot change its card cjk_words`)
      }
      const before = oldCards.get(record.num)
      if (before === undefined) {
        // Without the old card there is no evidence for target_words, cast or
        // archived_at. Accepting a fabricated card here would let an amend
        // bypass the archive protection after the backup was pruned.
        problems.push(
          `archived chapter ${record.num} has no previous outline card; restore its archive backup before repairing target_words/cast/archived_at`,
        )
        continue
      }
      for (const field of ['goal', 'conflict', 'hook', 'notes'] as const) {
        if (stableJson(before[field]) !== stableJson(card[field])) {
          problems.push(`archived chapter ${record.num} cannot change its ${field}`)
        }
      }
      if (JSON.stringify(before.target_words) !== JSON.stringify(card.target_words)) {
        problems.push(`archived chapter ${record.num} cannot change its target_words`)
      }
      const beforeCast = Array.isArray(before.cast) ? before.cast : []
      const afterCast = Array.isArray(card.cast) ? card.cast : []
      if (beforeCast.length !== afterCast.length || afterCast.some((name) => !beforeCast.includes(name))) {
        problems.push(`archived chapter ${record.num} cannot change its cast`)
      }
      if (
        before.archived_at !== card.archived_at &&
        !(before.archived_at === null && typeof card.archived_at === 'string')
      ) {
        problems.push(`archived chapter ${record.num} cannot change archived_at`)
      }
    }
    if (chaptersUnreadable) {
      const expected = new Set<number>(archivedChapterNumbers ?? [])
      for (const [num, card] of oldCards) {
        if (card.status === 'archived') expected.add(num)
      }
      const missing = [...expected].filter((num) => byNum.get(num)?.status !== 'archived')
      if (missing.length > 0) {
        problems.push(
          `cannot verify archived cards while chapters.yaml is unreadable; keep archived cards for ${missing.join(', ')}`,
        )
      }
      // The chapter index is the normal source for archived title/scene/word/
      // score. When it is unreadable, the old outline card is the only
      // remaining evidence; still compare every immutable field so an amend
      // cannot use the damaged-index window to rewrite an archived card.
      for (const [num, before] of oldCards) {
        if (before.status !== 'archived') continue
        const card = byNum.get(num)
        if (card === undefined) continue
        if (card.status !== 'archived') {
          problems.push(`archived chapter ${num} cannot be changed back to planned`)
        }
        for (const field of [
          'title',
          'scene_type',
          'word_count',
          'score',
          'goal',
          'conflict',
          'hook',
          'notes',
        ] as const) {
          if (stableJson(before[field]) !== stableJson(card[field])) {
            problems.push(`archived chapter ${num} cannot change its ${field}`)
          }
        }
        if (JSON.stringify(before.target_words) !== JSON.stringify(card.target_words)) {
          problems.push(`archived chapter ${num} cannot change its target_words`)
        }
        const beforeCast = Array.isArray(before.cast) ? before.cast : []
        const afterCast = Array.isArray(card.cast) ? card.cast : []
        if (beforeCast.length !== afterCast.length || afterCast.some((name) => !beforeCast.includes(name))) {
          problems.push(`archived chapter ${num} cannot change its cast`)
        }
        if (
          before.archived_at !== card.archived_at &&
          !(before.archived_at === null && typeof card.archived_at === 'string')
        ) {
          problems.push(`archived chapter ${num} cannot change archived_at`)
        }
      }
    }
    return problems
  }

  if (kind === 'worldbook') {
    for (const key of ['characters', 'locations', 'factions', 'rules', 'glossary'] as const) {
      const rows = Array.isArray(nextDocument[key]) ? nextDocument[key] : []
      const names = new Set<string>()
      for (const raw of rows) {
        const row = recordOf(raw)
        const name = row === null ? null : typeof row.name === 'string' ? row.name : row.term
        if (typeof name !== 'string' || name.trim() === '') {
          problems.push(`${key} entries must have a non-empty name/term`)
          continue
        }
        if (names.has(name)) problems.push(`${key} contains duplicate "${name}"`)
        names.add(name)
      }
    }
    return problems
  }

  // Unlisted future documents have no cross-document invariant.
  void path
  return problems
}

/** Waivers whose chapter window has not closed yet. Pure so it can be tested. */
export const carryAcknowledgements = <T extends { code: string; expires_at_chapter?: number }>(
  findings: readonly T[],
  chapter: number,
): T[] =>
  findings.filter(
    (finding) => finding.expires_at_chapter !== undefined && finding.expires_at_chapter >= chapter,
  )

export const castShapeProblems = (
  value: unknown,
): { messages: string[]; details?: Record<string, unknown> } => {
  const describe = (received: unknown): string =>
    Array.isArray(received) ? 'array' : received === null ? 'null' : typeof received
  if (!Array.isArray(value)) {
    return {
      messages: ['cast must be an array'],
      details: {
        field: 'cast',
        expected: 'array of 1..8 members',
        received_type: describe(value),
        received: typeof value === 'string' ? value.slice(0, 40) : value,
        example: [{ name: '他', entry_state: '警觉', goal: '把信送出去', knowledge: ['信在抽屉里'] }],
      },
    }
  }
  if (value.length < 1 || value.length > 8) {
    return {
      messages: ['cast must contain 1..8 members'],
      details: { field: 'cast', expected: '1..8 members', received: value.length, received_type: 'number' },
    }
  }
  const messages: string[] = []
  let details: Record<string, unknown> | undefined
  const note = (message: string, extra: Record<string, unknown>): void => {
    messages.push(message)
    details ??= extra
  }
  const names = new Set<string>()
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      note(`cast[${index}] must be an object`, {
        field: `cast[${index}]`,
        expected: 'object',
        received_type: describe(raw),
        example: { name: '他', goal: '把信送出去' },
      })
      continue
    }
    const member = raw as Record<string, unknown>
    if (typeof member.name !== 'string' || member.name.trim() === '') {
      note(`cast[${index}].name must be non-empty`, {
        field: `cast[${index}].name`,
        expected: 'non-empty string',
        received: member.name ?? 'missing',
        received_type: describe(member.name),
      })
      continue
    }
    if (names.has(member.name)) {
      note(`cast contains duplicate name "${member.name}"`, {
        field: `cast[${index}].name`,
        expected: 'unique name',
        received: member.name,
        received_type: 'string',
        allowed: [...names],
      })
    }
    names.add(member.name)
    for (const field of ['entry_state', 'goal', 'exit_change'] as const) {
      if (member[field] !== undefined && typeof member[field] !== 'string') {
        note(`cast[${index}].${field} must be a string`, {
          field: `cast[${index}].${field}`,
          expected: 'string',
          received: member[field],
          received_type: describe(member[field]),
        })
      }
    }
    if (member.knowledge !== undefined) {
      if (!Array.isArray(member.knowledge)) {
        note(`cast[${index}].knowledge must be a string array`, {
          field: `cast[${index}].knowledge`,
          expected: 'string[]',
          received: member.knowledge,
          received_type: describe(member.knowledge),
          example: ['他知道信在抽屉里', '他不知道她已经走了'],
        })
      } else {
        const bad = member.knowledge.findIndex((item) => typeof item !== 'string')
        if (bad !== -1) {
          note(`cast[${index}].knowledge[${bad}] must be a string`, {
            field: `cast[${index}].knowledge[${bad}]`,
            expected: 'string',
            received: member.knowledge[bad],
            received_type: describe(member.knowledge[bad]),
            example: ['他知道信在抽屉里'],
          })
        }
      }
    }
  }
  return details === undefined ? { messages } : { messages, details }
}

const normalizeCast = (value: unknown, snapshot: Snapshot): ChapterCastMember[] | undefined => {
  if (value === undefined) return undefined
  const { messages, details } = castShapeProblems(value)
  if (messages.length > 0) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      messages.join('; '),
      'send cast as an array of {name, entry_state?, goal?, knowledge?: string[], exit_change?}',
      details === undefined ? undefined : { details },
    )
  }
  const members = value as ChapterCastMember[]
  const known = new Set([
    ...(snapshot.worldPlan?.characters ?? []).map((character) => character.name),
    ...snapshot.characters.characters.map((character) => character.name),
  ])
  for (const member of members) {
    if (!known.has(member.name)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `cast member "${member.name}" is not declared in the P1 world plan or the character ledger`,
        'add the character to novel_plan_world first; cast cannot invent an actor',
      )
    }
  }
  return members
}

/** The summary fields the read model dereferences at P3–P6 and in the panel. */
const summaryContextProblems = (value: unknown): string[] => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['summary must be an object when present']
  }
  const summary = value as Record<string, unknown>
  const problems: string[] = []
  const strings = (key: string): void => {
    if (!Array.isArray(summary[key]) || summary[key].some((item) => typeof item !== 'string')) {
      problems.push(`summary.${key} must be a string array`)
    }
  }
  strings('events')
  strings('characters_appeared')
  strings('pleasure_points')
  const foreshadows = recordOf(summary.foreshadows)
  if (foreshadows === null) {
    problems.push('summary.foreshadows must be an object')
  } else {
    for (const key of ['planted', 'advanced', 'resolved'] as const) {
      if (!Array.isArray(foreshadows[key])) problems.push(`summary.foreshadows.${key} must be an array`)
    }
  }
  const elements = recordOf(summary.new_elements)
  if (elements === null) {
    problems.push('summary.new_elements must be an object')
  } else {
    for (const key of ['locations', 'abilities', 'artifacts'] as const) {
      if (!Array.isArray(elements[key]) || elements[key].some((item) => typeof item !== 'string')) {
        problems.push(`summary.new_elements.${key} must be a string array`)
      }
    }
  }
  if (!Array.isArray(summary.resource_changes)) problems.push('summary.resource_changes must be an array')
  if (typeof summary.opening !== 'string') problems.push('summary.opening must be a string')
  const continuity = recordOf(summary.continuity)
  if (continuity === null) {
    problems.push('summary.continuity must be an object')
  } else {
    for (const key of ['opens_from', 'ends_with'] as const) {
      if (typeof continuity[key] !== 'string') problems.push(`summary.continuity.${key} must be a string`)
    }
  }
  if (!Number.isInteger(summary.hook_strength)) problems.push('summary.hook_strength must be an integer')
  if (!['high', 'mid', 'low'].includes(summary.plot_advancement as string)) {
    problems.push('summary.plot_advancement must be high|mid|low')
  }
  return problems
}

/** Validate the nested roster fields the context builder dereferences. */
const validateWorldPlanShape = (plan: Record<string, unknown>, path: string): void => {
  const fail = (detail: string): never => {
    throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, `${path} is not a usable world plan: ${detail}`)
  }
  for (const key of ['constraints', 'continuity_notes'] as const) {
    if (!Array.isArray(plan[key]) || plan[key].some((item) => typeof item !== 'string')) {
      fail(`${key} must be a string array`)
    }
  }
  for (const key of ['characters', 'locations'] as const) {
    if (!Array.isArray(plan[key])) fail(`${key} must be an array`)
    for (const [index, raw] of (plan[key] as unknown[]).entries()) {
      const row = recordOf(raw)
      if (row === null || typeof row.name !== 'string' || row.name.trim() === '') {
        fail(`${key}[${index}].name must be a non-empty string`)
      }
    }
  }
}

/** Validate the shape a stored chapter plan must have before any stage uses it. */
const validateStoredChapterPlan = (plan: Record<string, unknown>, path: string): void => {
  const fail = (detail: string): never => {
    throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, `${path} is not a usable chapter plan: ${detail}`)
  }
  const rawVersion = plan.schema_version
  if (rawVersion !== undefined) {
    const version = typeof rawVersion === 'number' ? rawVersion : null
    if (version === null) fail('schema_version must be a positive integer')
    const checkedVersion = version as number
    if (!Number.isInteger(checkedVersion) || checkedVersion < 1) {
      fail('schema_version must be a positive integer')
    }
    if (checkedVersion > SCHEMA_VERSION) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_TOO_NEW,
        `${path} uses schema_version ${checkedVersion}, newer than supported ${SCHEMA_VERSION}`,
        'upgrade the plugin; the plan was left untouched',
      )
    }
    if (checkedVersion !== SCHEMA_VERSION) fail(`schema_version must be ${SCHEMA_VERSION}`)
  }
  if (!Number.isInteger(plan.chapter) || (plan.chapter as number) < 1)
    fail('chapter must be a positive integer')
  for (const key of ['title', 'narrator', 'opening', 'ending'] as const) {
    if (typeof plan[key] !== 'string' || (plan[key] as string).trim() === '') fail(`${key} must be non-empty`)
  }
  if (!(SCENE_TYPES as readonly string[]).includes(plan.scene_type as string)) {
    fail(`unknown scene_type "${String(plan.scene_type)}"`)
  }
  if (
    !Array.isArray(plan.beats) ||
    plan.beats.length < 5 ||
    plan.beats.length > 8 ||
    plan.beats.some((beat) => typeof beat !== 'string' || beat.trim() === '')
  ) {
    fail('beats must be 5..8 non-empty strings')
  }
  if (
    !Array.isArray(plan.target_words) ||
    plan.target_words.length !== 2 ||
    plan.target_words.some((value) => !Number.isInteger(value) || (value as number) <= 0)
  ) {
    fail('target_words must be [min, max] positive integers')
  }
  const targetWords = plan.target_words as number[]
  if (targetWords[0]! > targetWords[1]!) {
    fail('target_words min must not exceed max')
  }
  if (plan.summary !== undefined) {
    const problems = summaryContextProblems(plan.summary)
    if (problems.length > 0) fail(problems.join('; '))
  }
  if (plan.cast !== undefined) {
    const { messages, details } = castShapeProblems(plan.cast)
    if (messages.length > 0) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        messages.join('; '),
        'send cast as an array of {name, entry_state?, goal?, knowledge?: string[], exit_change?}',
        details === undefined ? undefined : { details },
      )
    }
  }
}

const CHECK_SCOPES = ['content', 'integrity'] as const

const normalizeCheckScope = (value: string[] | undefined): string[] => {
  if (value === undefined) return [...CHECK_SCOPES]
  if (!Array.isArray(value) || value.length === 0) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      'scope must contain at least one of content, integrity',
    )
  }
  const unique = [...new Set(value)]
  for (const scope of unique) {
    if (scope !== 'content' && scope !== 'integrity') {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `unknown check scope "${String(scope)}"`,
        `allowed: ${CHECK_SCOPES.join(', ')}`,
      )
    }
  }
  // Canonical order makes the replay key and the stored check independent of
  // the caller's array order while preserving the documented default.
  return CHECK_SCOPES.filter((scope) => unique.includes(scope))
}

const stringList = (value: unknown, field: string): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${field} must be an array of non-empty strings`)
  }
  return value as string[]
}

const objectList = (value: unknown, field: string): Record<string, unknown>[] => {
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'object' || item === null || Array.isArray(item))
  ) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${field} must be an array of objects`)
  }
  return value as Record<string, unknown>[]
}

const requireText = (object: Record<string, unknown>, key: string, path: string): void => {
  if (typeof object[key] !== 'string' || (object[key] as string).trim() === '') {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${path} must be a non-empty string`)
  }
}

/** Parse a plan file with a machine code instead of leaking a YAML parser error. */
const parsePlanYaml = (text: string, path: string): Record<string, unknown> => {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (error) {
    throw new EngineFaultError(
      ERROR_CODES.SCHEMA_INVALID,
      `${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      'fix the plan YAML; the engine will not silently discard a corrupt plan',
      { cause: error },
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EngineFaultError(
      ERROR_CODES.SCHEMA_INVALID,
      `${path} must be a YAML mapping`,
      'rewrite the plan as a mapping (title, scene_type, narrator, ...)',
    )
  }
  return parsed as Record<string, unknown>
}

/** Line diff with a shared prefix/suffix, enough for revision review. */
export function diffLines(
  before: string,
  after: string,
): { added: number; removed: number; hunks: Array<{ kind: 'add' | 'remove' | 'same'; line: string }> } {
  const left = before === '' ? [] : before.split('\n')
  const right = after === '' ? [] : after.split('\n')
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const hunks: Array<{ kind: 'add' | 'remove' | 'same'; line: string }> = []
  for (let index = 0; index < prefix; index += 1) hunks.push({ kind: 'same', line: left[index]! })
  const removed = left.slice(prefix, left.length - suffix)
  const added = right.slice(prefix, right.length - suffix)
  for (const line of removed) hunks.push({ kind: 'remove', line })
  for (const line of added) hunks.push({ kind: 'add', line })
  for (let index = left.length - suffix; index < left.length; index += 1)
    hunks.push({ kind: 'same', line: left[index]! })
  return { added: added.length, removed: removed.length, hunks }
}

/** Gate id → label, re-exported for status rendering without importing codes. */
export { gateName }
export { textSimilarity }
export { splitParagraphs }
export type { MachineOptions }
