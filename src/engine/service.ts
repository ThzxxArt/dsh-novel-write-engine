import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { parse as parseYaml, stringify } from 'yaml'
import {
  BACKUP_DIR,
  CHAPTERS_DIR,
  EXPORT_DIR,
  LIMITS,
  LOCK_FILE,
  OUTLINE_FILE,
  PROJECT_FILE,
  STATE_DIR,
  WORLDBOOK_FILE,
  STATE_FILES,
  chapterFile,
  checkFile,
  deprecatedChapterFile,
  planChapterFile,
  planWorldFile,
  reviewFile,
} from '../constants.js'
import { canRun, roundsExhausted, STAGE_NEXT, nextStage as computeNextStage } from '../domain/index.js'
import { textSimilarity } from '../domain/simhash.js'
import { compareText, stableJson } from '../domain/stable.js'
import { openingInFirstTwoParagraphs, splitParagraphs } from '../domain/text.js'
import { countWordMetrics } from '../domain/wordcount.js'
import { reviewArithmeticProblems, totalScore } from '../domain/scoring.js'
import { runMachineChecks, scopeOfRule, type MachineOptions, type MachineResult } from '../rules/pipeline.js'
import type { Rulepack } from '../rules/types.js'
import { applyExclusions } from '../domain/scoring.js'
import {
  FsStore,
  joinRel,
  sha256,
  shortDigest,
  ProjectRegistry,
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
  readJournal,
  reconcileJournal,
} from '../store/journal.js'
import { listBackups } from '../store/backup.js'
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
  autoCardCast,
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
import { buildBookReport, buildGuide, searchSnapshot } from './insight.js'
import { BriefLibrary } from './brief.js'
import { briefContext } from './context.js'
import { applyStateDelta } from './state-delta.js'
import { evaluateSemantic } from './semantic.js'
import { briefStageFor, evaluateGates, gateName, parseParagraphLocation } from './gates.js'
import { advanceHandoff, parseActProgress, projectHandoff } from './handoff.js'
import {
  phaseStrip,
  projectChapters,
  projectGates,
  projectSummary,
  type PanelChaptersDto,
  type PanelGatesDto,
  type PanelSnapshot,
  type PanelSummaryDto,
} from './projections.js'
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
  type BlockingItem,
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
  type ScoreDimension,
  type SemanticItem,
  type Stage,
  type StateDelta,
  type StateError,
  type StatusReport,
  type Warning,
  type WordMetrics,
  type WorldPlanInput,
  type BookReport,
  type DoctorCheck,
  type DoctorReport,
  type GuideReport,
  type OutlineDocument,
  type SearchReport,
  type WorldbookDocument,
} from '../types.js'

export interface InitProjectInput {
  title: string
  genre: NovelProject['genre']
  platform: NovelProject['platform']
  author?: string
  description?: string
  words_per_chapter?: [number, number]
  total_chapters?: number | null
  dialogue_ratio?: [number, number]
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
  stage: import('../types.js').BriefStage
  chapter?: number
  root?: string
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

export interface ReviewSubmission extends ReviewInput {
  root?: string
}

export interface RevisionSubmission extends Omit<RevisionInput, 'summary'> {
  summary?: ChapterSummary
  /** Updated issue statuses/evidence; the review document is patched in place. */
  issues?: ReviewDocument['issues']
  /** Proof that the revised text was read; PG-09 verifies it against the new text. */
  proof: ReadingProof
  root?: string
}

export interface CheckSubmission {
  chapter: number
  /** The five P6 semantic items; omission is a failed check, never a pass. */
  semantic: SemanticItem[]
  scope?: string[]
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

export interface AmendSubmission {
  path: string
  content: Record<string, unknown>
  reason: string
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
  root?: string
}

export interface ExportInput {
  kind: ExportKind
  chapter?: number
  root?: string
}

export interface StateQueryInput {
  kind: DocKind | 'novel' | 'planWorld' | 'planChapter'
  chapter?: number
  /** Chapter index defaults to a compact read; opt in to the full summaries. */
  include_summary?: boolean
  /** Inclusive chapter range for the `chapters` index. */
  chapter_range?: [number, number]
  root?: string
}

export interface WordCountInput {
  text?: string
  chapter?: number
  root?: string
}

export interface BookPlanSubmission extends BookPatch {
  volumes?: VolumeInput[]
  root?: string
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
  root?: string
}

export interface ReportSubmission {
  root?: string
}

export interface GuideInput {
  root?: string
}

interface Snapshot {
  root: string
  project: NovelProject
  /** Set when novel.yaml exists but cannot be parsed/narrowed. */
  projectError: string | null
  pipeline: PipelineState
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
const ARCHIVE_DIGESTS = joinRel(STATE_DIR, 'archive-digests.json')

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
}

/**
 * The single write authority. Tools, commands, the panel and task books never
 * touch a file; every mutation is one of these operations.
 */
export class EngineService {
  private readonly stores = new Map<string, FsStore>()
  private readonly mutex = new KeyedMutex()
  private readonly replay = new Map<string, OpResult<unknown>>()
  /** Status, panel and gates ask for the same stage context repeatedly. */
  private readonly briefContextCache = new WeakMap<Snapshot, Map<string, Record<string, unknown>>>()
  private readonly briefs: BriefLibrary
  private readonly now: () => Date
  /** The project this process last touched; the panel follows it without a workspace hint. */
  private lastRoot: string | null = null

  constructor(
    private readonly config: EngineConfig,
    rulepack: Rulepack | (() => Rulepack),
    options: { briefs?: BriefLibrary; now?: () => Date; onEvent?: (event: EngineEvent) => void } = {},
  ) {
    this.rulepackSource = typeof rulepack === 'function' ? rulepack : () => rulepack
    this.briefs =
      options.briefs ?? new BriefLibrary(config.briefs.overrides === '' ? undefined : config.briefs.overrides)
    this.now = options.now ?? (() => new Date())
    this.onEvent = options.onEvent
  }

  /** Compiled on first use so `apply()` performs no IO. */
  private readonly rulepackSource: () => Rulepack
  private compiled: Rulepack | null = null
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
    this.lastRoot = null
    this.compiled = null
  }

  private get rulepack(): Rulepack {
    this.compiled ??= this.rulepackSource()
    return this.compiled
  }

  private readonly onEvent: ((event: EngineEvent) => void) | undefined
  private readonly signalContext = new AsyncLocalStorage<AbortSignal | undefined>()

  /** Bind the host cancellation signal to the engine work of one tool call. */
  withSignal<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    return this.signalContext.run(signal, task)
  }

  /** The configured default project root. */
  defaultRoot(): string {
    return resolve(this.config.projectRoot)
  }

  /**
   * Resolve an omitted root through the cross-project registry. The registry is
   * convenience state, so a corrupt or unreadable registry falls back to the
   * configured root instead of making every call fail.
   */
  private async resolveRoot(root?: string): Promise<string> {
    if (root !== undefined) return resolve(root)
    // A live tool call is the strongest signal for the panel: it runs in the
    // same engine process as the read route. The registry is the cold-start
    // fallback, then the configured root.
    if (this.lastRoot !== null) return this.lastRoot
    try {
      const document = await this.registry().read()
      if (document.active !== null) return resolve(document.active)
    } catch {
      // Convenience metadata must not take the project down with it.
    }
    return resolve(this.config.projectRoot)
  }

  private storeFor(root?: string): FsStore {
    const absolute = resolve(root ?? this.config.projectRoot)
    const existing = this.stores.get(absolute)
    if (existing !== undefined) return existing
    const store = new FsStore(absolute)
    this.stores.set(absolute, store)
    return store
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
    return this.mutate({
      root: input.root,
      op: 'initProject',
      key: () => `init:${resolve(input.root ?? this.config.projectRoot)}`,
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
          },
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
        }
      },
      emptyAllowed: true,
    })
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
          Object.entries(input).filter(([key]) => key !== 'volumes' && key !== 'root'),
        ) as BookPatch
        const book = mergeBookPlan(snapshot.outline.book, bookPatch)
        const volumes =
          input.volumes === undefined
            ? snapshot.outline.volumes
            : normalizeVolumes(input.volumes, { totalChapters: snapshot.project.targets.total_chapters })
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

  async submitOutline(
    input: OutlineSubmission,
  ): Promise<
    OpResult<{ planned: number; archived: number; total: number; strict: boolean; volumes: number }>
  > {
    const allowed = new Set(['book', 'volumes', 'chapters', 'strict', 'root'])
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
    this.assertProjectReadable(current, 'novel_outline')
    this.assertPlanningDocumentReadable(current, 'outline', 'novel_outline')
    this.assertArchiveIndexReadable(current, 'novel_outline')
    return this.mutate({
      root: input.root,
      op: 'submitOutline',
      key: () => `outline:${sha256(stableJson(input))}`,
      run: async (snapshot, context) => {
        this.assertProjectReadable(snapshot, 'novel_outline')
        this.assertPlanningDocumentReadable(snapshot, 'outline', 'novel_outline')
        this.assertArchiveIndexReadable(snapshot, 'novel_outline')
        const now = this.now().toISOString()
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
          // authored a blueprint or volume, preserve their strict choice; the
          // old check only looked at chapter cards, so importing an outline
          // after `novel_blueprint {strict:false}` silently re-enabled it.
          const firstCardSubmission =
            snapshot.outline.chapters.length === 0 && snapshot.outline.book.strict_explicit !== true
          if (firstCardSubmission) {
            book.strict = true
            book.strict_explicit = true
          }
        }
        const volumes =
          input.volumes === undefined
            ? snapshot.outline.volumes
            : normalizeVolumes(input.volumes, { totalChapters: snapshot.project.targets.total_chapters })
        const chapters = normalizeOutlineChapters(input.chapters, {
          volumes,
          existing: snapshot.outline.chapters,
          archived: snapshot.chapters.chapters,
          titleRule: this.rulepack.format.title,
          totalChapters: snapshot.project.targets.total_chapters,
          defaultTargetWords: snapshot.project.targets.words_per_chapter,
          now,
        })
        const outline: OutlineDocument = { schema_version: 1, updated_at: now, book, volumes, chapters }
        this.assertActiveCardPreserved(snapshot, book.strict, chapters, 'novel_outline')
        this.assertOutlineWritable(snapshot, outline, 'novel_outline')
        const planned = chapters.filter((card) => card.status === 'planned').length
        const archived = chapters.filter((card) => card.status === 'archived').length
        const kept = new Set(chapters.filter((card) => card.status === 'planned').map((card) => card.num))
        const dropped = snapshot.outline.chapters
          .filter((card) => card.status === 'planned' && !kept.has(card.num))
          .map((card) => card.num)
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          last_action: action('novel_outline', this.now(), shortDigest(stableJson(input))),
        })
        return {
          files: [
            { path: OUTLINE_FILE, text: yaml(outline) },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
          backup: true,
          data: { planned, archived, total: chapters.length, strict: book.strict, volumes: volumes.length },
          warnings:
            dropped.length === 0
              ? []
              : [
                  {
                    code: 'OUTLINE_PLANNED_DROPPED',
                    message: `this replacement dropped planned cards: ${dropped.join(', ')}; resubmit every existing card when adding one`,
                  },
                ],
          event: {
            name: 'novel/planned',
            payload: {
              schemaVersion: 1,
              projectRoot: snapshot.root,
              kind: 'outline',
              chapters: chapters.length,
              volumes: volumes.length,
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
    const candidate: OutlineDocument = { schema_version: 1, updated_at: now, book, volumes, chapters }
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
        const outline: OutlineDocument = {
          schema_version: 1,
          updated_at: now,
          book: nextBook,
          volumes: nextVolumes,
          chapters: nextChapters,
        }
        this.assertActiveCardPreserved(fresh, nextBook.strict, nextChapters, 'novel_outline_import')
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
        }
        const entries =
          counts.characters +
          counts.locations +
          counts.factions +
          counts.rules +
          counts.glossary +
          counts.backstory
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
          if (path === joinRel(STATE_DIR, STATE_FILES.pipeline) || path === OUTLINE_FILE) continue
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
   * Read-only paths must surface a committed-journal mismatch. The write path
   * already fails closed; without this, status recommends the next write and
   * the model only learns about the mismatch when that write aborts.
   */
  private async journalBlocking(snapshot: Snapshot): Promise<BlockingItem[]> {
    const store = this.storeFor(snapshot.root)
    // A stale lock left by a crash must not hide journal damage. load() already
    // waited for a live writer, so only a live lock suppresses this check.
    if (await this.lockIsLive(store)) return []
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

  async getStatus(input: StatusInput = {}): Promise<OpResult<StatusReport>> {
    if (input.chapter !== undefined) this.assertChapterParameter(input.chapter)
    const snapshot = await this.load(input.root)
    const chapter = input.chapter ?? snapshot.pipeline.chapter
    const metrics = await this.metricsFor(snapshot, chapter)
    const journal = await this.journalBlocking(snapshot)
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
      stage: snapshot.pipeline.stage,
      rounds: { ...snapshot.pipeline.rounds },
      blocking: [...this.effectiveBlocking(snapshot), ...journal],
      state_errors: this.stateErrors(snapshot),
      metrics,
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

  async countWords(input: WordCountInput = {}): Promise<OpResult<WordMetrics>> {
    // The counting rule is pure: callers may count arbitrary text before a
    // project exists, so do not make this tool require a project file.
    if (input.text !== undefined) {
      return { data: countWordMetrics(input.text), revision: 1, warnings: [] }
    }
    if (input.chapter !== undefined) this.assertChapterParameter(input.chapter)
    const snapshot = await this.load(input.root)
    const text =
      (input.chapter === undefined ? snapshot.text : await this.readChapter(snapshot, input.chapter)) ?? ''
    return { data: countWordMetrics(text), revision: snapshot.pipeline.revision, warnings: [] }
  }

  async queryState(input: StateQueryInput): Promise<OpResult<unknown>> {
    if (input.chapter !== undefined) this.assertChapterParameter(input.chapter)
    const snapshot = await this.load(input.root)
    const chapter = input.chapter ?? snapshot.pipeline.chapter
    const store = this.storeFor(snapshot.root)
    const ledgerPath = LEDGER_PATHS[input.kind]
    if (ledgerPath !== undefined) {
      const damage = snapshot.ledgerErrors.find((error) => error.path === ledgerPath)
      if (damage !== undefined) {
        return {
          data: {
            error: damage.code,
            message: damage.message,
            path: damage.path,
            raw: await store.readText(damage.path),
          },
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
    }
    switch (input.kind) {
      case 'pipeline':
        return { data: snapshot.pipeline, revision: snapshot.pipeline.revision, warnings: [] }
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
        const data =
          input.include_summary === true
            ? { schema_version: 1 as const, chapters: rows }
            : {
                schema_version: 1 as const,
                chapters: rows.map((row) => ({
                  num: row.num,
                  title: row.title,
                  word_count: row.word_count,
                  score: row.score,
                  status: row.status,
                })),
              }
        return { data, revision: snapshot.pipeline.revision, warnings: [] }
      }
      case 'characters':
        return { data: snapshot.characters, revision: snapshot.pipeline.revision, warnings: [] }
      case 'world':
        return { data: snapshot.world, revision: snapshot.pipeline.revision, warnings: [] }
      case 'locks':
        return { data: snapshot.locks, revision: snapshot.pipeline.revision, warnings: [] }
      case 'timeline':
        return { data: snapshot.timeline, revision: snapshot.pipeline.revision, warnings: [] }
      case 'foreshadows':
        return { data: snapshot.foreshadows, revision: snapshot.pipeline.revision, warnings: [] }
      case 'relationships':
        return { data: snapshot.relationships, revision: snapshot.pipeline.revision, warnings: [] }
      case 'handoff':
        return { data: snapshot.handoff, revision: snapshot.pipeline.revision, warnings: [] }
      case 'outline':
        if (snapshot.outlineError !== null) {
          return {
            data: {
              error: 'OUTLINE_UNREADABLE',
              message: snapshot.outlineError,
              path: OUTLINE_FILE,
              raw: await store.readText(OUTLINE_FILE),
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
              raw: await store.readText(WORLDBOOK_FILE),
            },
            revision: snapshot.pipeline.revision,
            warnings: [],
          }
        }
        return { data: snapshot.worldbook, revision: snapshot.pipeline.revision, warnings: [] }
      case 'review': {
        if (chapter === snapshot.pipeline.chapter && snapshot.reviewError !== null) {
          return {
            data: {
              error: 'REVIEW_UNREADABLE',
              message: snapshot.reviewError,
              path: reviewFile(chapter),
              raw: await store.readText(reviewFile(chapter)),
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
              raw: await store.readText(checkFile(chapter)),
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
              raw: await store.readText(PROJECT_FILE),
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
      tool: string
      args: Record<string, unknown>
      reason: string
      blocking: BlockingItem[]
      state_errors: StateError[]
    }>
  > {
    const snapshot = await this.load(input.root)
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

  async doctor(input: DoctorInput = {}): Promise<OpResult<DoctorReport>> {
    const root = await this.resolveRoot(input.root)
    const store = this.storeFor(root)
    const checks: DoctorCheck[] = []
    const add = (check: DoctorCheck): void => {
      checks.push(check)
    }
    if (!(await store.exists(PROJECT_FILE)) && !(await this.projectStateExists(store))) {
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
      snapshot = await this.load(root)
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
    add({
      id: 'pipeline',
      severity: 'ok',
      title: '流水线',
      detail: `revision ${snapshot.pipeline.revision} · 第 ${snapshot.pipeline.chapter} 章 · ${snapshot.pipeline.stage}`,
    })
    for (const error of this.stateErrors(snapshot)) {
      add({
        id: `state:${error.path}`,
        severity: 'error',
        title: '状态文档不可读',
        detail: `${error.code}: ${error.message}`,
        hint: `repair ${error.path} with novel_amend`,
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
    add({
      id: 'worldbook',
      severity: snapshot.worldbookError !== null ? 'error' : snapshot.worldbookPresent ? 'ok' : 'info',
      title: '世界观设定集',
      detail:
        snapshot.worldbookError ??
        (snapshot.worldbookPresent ? 'worldbook is readable' : 'outline/worldbook.yaml is missing'),
      ...(snapshot.worldbookError !== null ? { hint: 'repair outline/worldbook.yaml with novel_amend' } : {}),
    })
    try {
      const journalPresent = await store.exists(joinRel(STATE_DIR, STATE_FILES.journal))
      const journal = await readJournal(store)
      const journalCommitted = hasCommittedJournal(journal.records)
      const health = await reconcileJournal(store)
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
    const coverage =
      archivedRecords.length === 0
        ? 0
        : (archivedRecords.length - missingCards.length) / archivedRecords.length
    add({
      id: 'outline-coverage',
      severity: missingCards.length === 0 && extraCards.length === 0 ? 'ok' : 'warning',
      title: '大纲覆盖率',
      detail:
        archivedRecords.length === 0
          ? '0%（暂无已归档章节）'
          : `${Math.round(coverage * 100)}% · ${missingCards.length} 章缺卡 · ${extraCards.length} 张卡无正文`,
      ...(missingCards.length === 0 && extraCards.length === 0
        ? {}
        : {
            hint: `missing cards: ${missingCards.map((record) => record.num).join(', ') || 'none'}; extra cards: ${extraCards.join(', ') || 'none'}`,
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
    add({
      id: 'backups',
      severity: 'info',
      title: '备份',
      detail: `${backups.length} backup snapshot(s)`,
    })
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

  private recoveryForSafe(error: unknown): string {
    if (error instanceof EngineFaultError) return error.hint ?? 'inspect the project files'
    if (error instanceof EngineInputError) return error.hint ?? 'call novel_status first'
    return 'inspect the project files'
  }

  async report(input: ReportSubmission = {}): Promise<OpResult<BookReport>> {
    const snapshot = await this.load(input.root)
    const store = this.storeFor(snapshot.root)
    const reviews: ReviewDocument[] = []
    const reviewIssues: string[] = []
    for (const record of snapshot.chapters.chapters) {
      try {
        const review = await store.readDoc(reviewFile(record.num), 'review')
        if (review === null) reviewIssues.push(`chapter ${record.num}: review is missing`)
        else reviews.push(review as unknown as ReviewDocument)
      } catch (error) {
        reviewIssues.push(`chapter ${record.num}: ${errorMessage(error)}`)
      }
    }
    const journal = await readJournal(store)
    const report = buildBookReport({
      project: snapshot.project,
      outline: snapshot.outline,
      outlinePresent: snapshot.outlinePresent,
      outlineError: snapshot.outlineError,
      worldbook: snapshot.worldbook,
      worldbookPresent: snapshot.worldbookPresent,
      worldbookError: snapshot.worldbookError,
      chapters: snapshot.chapters.chapters,
      characters: snapshot.characters,
      timeline: snapshot.timeline,
      foreshadows: snapshot.foreshadows,
      relationships: snapshot.relationships,
      reviews,
      activity: journal.rows.slice(-8),
      targetChapters: snapshot.project.targets.total_chapters,
      minScore: this.config.quality.minScore,
      foreshadowDormantAfter: this.rulepack.crosschapter.foreshadow_dormant_after,
    })
    if (snapshot.projectError !== null) {
      report.warnings.push(`项目定义不可读：${snapshot.projectError}`)
    }
    for (const error of snapshot.ledgerErrors) {
      report.warnings.push(`${error.code} @ ${error.path}：${error.message}`)
    }
    for (const issue of reviewIssues) report.warnings.push(`评审文档不可读：${issue}`)
    report.warnings = [...new Set(report.warnings)]
    return { data: report, revision: snapshot.pipeline.revision, warnings: [] }
  }

  async guide(input: GuideInput = {}): Promise<OpResult<GuideReport>> {
    const root = await this.resolveRoot(input.root)
    const store = this.storeFor(root)
    if (!(await store.exists(PROJECT_FILE)) && !(await this.projectStateExists(store))) {
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
    const snapshot = await this.load(root)
    const target = snapshot.project.targets.total_chapters
    const finished =
      snapshot.pipeline.stage === 'done' && target !== null && snapshot.chapters.chapters.length >= target
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

  async getBrief(input: BriefInput): Promise<
    OpResult<{
      stage: string
      chapter: number
      digest: string
      title: string
      content: string
      content_hash: string
      fields: Record<string, unknown>
      context: Record<string, unknown>
    }>
  > {
    // Surface project/schema errors before the journal-consistency check. A
    // future schema_version must not be reported as an unrelated external-edit
    // mismatch; this preflight is validation only and the locked mutation still
    // reloads the snapshot before signing anything.
    await this.load(input.root)
    // Compute the brief only after taking the write lock. The old fast path
    // loaded the snapshot before locking, so a concurrent archive or amend
    // could issue a digest for a chapter/context that no longer existed.
    return this.mutate({
      root: input.root,
      op: 'getBrief',
      run: async (snapshot, context) => {
        const chapter = input.chapter ?? snapshot.pipeline.chapter
        // A brief signs the active snapshot; issuing one for a historical
        // chapter would produce a digest the gates can never match. Keep the
        // tool honest instead of silently signing a different chapter.
        if (chapter !== snapshot.pipeline.chapter) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `brief ${input.stage} belongs to active chapter ${snapshot.pipeline.chapter}, not ${chapter}`,
            `omit chapter or pass ${snapshot.pipeline.chapter}`,
          )
        }
        const contextPack = this.briefContextFor(input.stage, snapshot, chapter)
        const digest = this.briefDigest(input.stage, snapshot, contextPack)
        const variables = this.briefVariables(snapshot, chapter)
        const rendered = this.briefs.render(input.stage, variables)
        const fields = {
          stage: input.stage,
          chapter,
          digest,
          min_words: snapshot.project.targets.words_per_chapter[0],
          min_score: this.config.quality.minScore,
          scene_types: ['战斗/动作章', '日常过渡章', '情感爆发章', '纯叙事章'],
          platform_style: this.rulepack.platform[snapshot.project.platform],
          genre_guide: this.rulepack.genres[snapshot.project.genre],
          /** P4 must apply exclusions before its arithmetic closes. */
          score_exclusions: this.rulepack.exclusions,
          next_tool: NEXT_TOOL_BY_BRIEF[input.stage],
          book_plan: snapshot.outline.book,
          outline_card: outlineCard(snapshot.outline, chapter),
          worldbook_counts: worldbookCounts(snapshot.worldbook),
          ...(snapshot.worldPlanError === null ? {} : { world_plan_error: snapshot.worldPlanError }),
          ...(snapshot.planError === null ? {} : { plan_error: snapshot.planError }),
          ...(snapshot.reviewError === null ? {} : { review_error: snapshot.reviewError }),
          ...(snapshot.checkError === null ? {} : { check_error: snapshot.checkError }),
          ...(snapshot.outlineError === null ? {} : { outline_error: snapshot.outlineError }),
          ...(snapshot.worldbookError === null ? {} : { worldbook_error: snapshot.worldbookError }),
        }
        const data = {
          stage: input.stage,
          chapter,
          digest,
          title: rendered.title,
          content: rendered.content,
          content_hash: rendered.contentHash,
          fields,
          context: contextPack,
        }
        const existing = snapshot.pipeline.briefs[input.stage]
        if (existing !== undefined && existing.digest === digest) {
          return { files: [], data, replay: true }
        }
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          briefs: {
            ...snapshot.pipeline.briefs,
            [input.stage]: { issued_at: this.now().toISOString(), digest },
          },
          last_action: action('novel_brief', this.now(), digest),
        })
        return {
          files: [{ path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) }],
          backup: false,
          data,
        }
      },
    })
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
        'keep the protected objective within the P2 context budget',
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
          'keep constraints/continuity notes concise; the protected context has a fixed budget',
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
        return {
          files: [
            { path, text: yaml(plan) },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
          data: { chapter, stage: 'P3' as Stage, plan_file: path },
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
        const mergedPlan = {
          ...plan,
          title: input.chapter_title,
          scene_type: input.scene_type,
          narrator: input.narrator,
          summary: input.summary,
        }
        const planPath = planChapterFile(chapter)
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          stage: 'P4',
          blocking: [],
          last_action: action('novel_write_draft', this.now(), sha256(input.content)),
        })
        return {
          files: [
            { path: chapterFile(chapter), text: input.content },
            { path: planPath, text: yaml(mergedPlan) },
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

  async submitReview(
    input: ReviewSubmission,
  ): Promise<
    OpResult<{ chapter: number; round: number; total: number; open_blockers: number; next_stage: Stage }>
  > {
    return this.mutate({
      root: input.root,
      op: 'submitReview',
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
        const provided: ScoreDimension[] = input.dimensions
        const excluded = applyExclusions(provided, this.rulepack.exclusions)
        const computed = totalScore(excluded.dimensions)
        if (!Number.isInteger(input.total) || input.total !== computed) {
          throw new EngineInputError(
            ERROR_CODES.SCORE_MISMATCH,
            `claimed total ${String(input.total)} does not equal 150 - Σdelta (${computed})`,
            'recompute the total after applying the rulepack exclusions',
          )
        }
        const arithmetic = reviewArithmeticProblems(excluded.dimensions, input.total)
        if (arithmetic.length > 0) {
          throw new EngineInputError(
            ERROR_CODES.SCORE_MISMATCH,
            `review arithmetic does not close: ${arithmetic.join('; ')}`,
          )
        }
        const issues = Array.isArray(input.issues) ? input.issues : []
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
          total: input.total,
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
        const belowMin = input.total < this.config.quality.minScore
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
            detail: `score ${input.total} is below the minimum ${this.config.quality.minScore}`,
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
            { path: reviewFile(input.chapter), text: yaml(review) },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
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
                    message: `${excluded.dropped} mutually exclusive deduction(s) were dropped`,
                  },
                ]
              : [],
        }
      },
    })
  }

  async submitRevision(
    input: RevisionSubmission,
  ): Promise<OpResult<{ chapter: number; stage: Stage; metrics: WordMetrics }>> {
    return this.mutate({
      root: input.root,
      op: 'submitRevision',
      key: () =>
        `revision:${input.chapter}:${sha256(input.content)}:${sha256(
          stableJson({ summary: input.summary, issues: input.issues, proof: input.proof }),
        )}`,
      run: async (snapshot, context) => {
        this.assertChapter(snapshot, input.chapter)
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
                    ERROR_CODES.SCHEMA_INVALID,
                    `issue ${submitted.id} cannot change its ${field} during revision`,
                    'only status and evidence may change; new findings belong in the next review',
                  )
                }
              }
              if (submitted.severity !== undefined && submitted.severity !== before.severity) {
                throw new EngineInputError(
                  ERROR_CODES.SCHEMA_INVALID,
                  `issue ${submitted.id} cannot change severity during revision`,
                  'only status and evidence may change; a blocker stays a blocker until re-reviewed',
                )
              }
              if (
                before.severity === 'blocker' &&
                submitted.severity !== undefined &&
                submitted.severity !== 'blocker'
              ) {
                throw new EngineInputError(
                  ERROR_CODES.SCHEMA_INVALID,
                  `issue ${submitted.id} is a blocker and cannot be downgraded`,
                  'keep severity blocker and mark it fixed with evidence',
                )
              }
              if (before.severity === 'blocker' && submitted.status === 'waived') {
                throw new EngineInputError(
                  ERROR_CODES.SCHEMA_INVALID,
                  `issue ${submitted.id} is a blocker and cannot be waived`,
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
          text: input.content,
          summary: input.summary,
          summaryProvided: input.summary !== undefined,
          review: patchedReview,
          proof: input.proof,
        })
        // P5 may omit the summary only while it still describes the revised
        // opening. Otherwise the stale PG-05 opening survives to P6 and costs
        // another revision (and a PG-11 round) to repair.
        if (input.summary === undefined && snapshot.plan?.summary !== undefined) {
          const opening = snapshot.plan.summary.opening
          if (!openingInFirstTwoParagraphs(input.content, opening)) {
            throw new EngineInputError(
              ERROR_CODES.SCHEMA_INVALID,
              'summary omitted, but the stored opening no longer appears in the revised first two paragraphs',
              'resubmit novel_revise with a summary whose opening quotes the revised text',
            )
          }
        }
        const machine = this.machine(snapshot, input.content, {
          summary: input.summary ?? snapshot.plan?.summary ?? null,
        })
        const nextStage = computeNextStage(snapshot.pipeline.stage, 'submitRevision', 0)
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          stage: nextStage,
          rounds: { ...snapshot.pipeline.rounds, revise: snapshot.pipeline.rounds.revise + 1 },
          blocking: [],
          ...(patchedReview === null ? {} : { review_digest: sha256(stableJson(patchedReview)) }),
          last_action: action('novel_revise', this.now(), sha256(input.content)),
        })
        const planPath = planChapterFile(input.chapter)
        const planText = await context.store.readText(planPath)
        const plan = planText === null ? null : parsePlanYaml(planText, planPath)
        const files: StagedFile[] = [
          { path: chapterFile(input.chapter), text: input.content },
          { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
        ]
        if (plan !== null && input.summary !== undefined)
          files.push({ path: planPath, text: yaml({ ...plan, summary: input.summary }) })
        if (patchedReview !== null && patchedReview !== snapshot.review) {
          files.push({ path: reviewFile(input.chapter), text: yaml(patchedReview) })
        }
        return {
          files,
          backup: true,
          data: { chapter: input.chapter, stage: nextStage, metrics: machine.metrics },
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
      metrics: WordMetrics
      stage: Stage
    }>
  > {
    const scope = normalizeCheckScope(input.scope)
    return this.mutate({
      root: input.root,
      op: 'runCheck',
      key: (snapshot) =>
        `check:${input.chapter}:${sha256(snapshot.text ?? '')}:${sha256(
          stableJson({ semantic: input.semantic ?? [], scope }),
        )}`,
      run: async (snapshot, context) => {
        this.assertChapter(snapshot, input.chapter)
        const text = snapshot.text ?? ''
        const semantic = Array.isArray(input.semantic) ? input.semantic : []
        await this.assertGates(snapshot, 'runCheck', {
          briefStage: 'P6',
          text,
          proof: snapshot.review?.proof ?? null,
          semantic,
          scope,
        })
        const machine = this.machine(snapshot, text, { summary: snapshot.plan?.summary ?? null })
        const scopedMachine: MachineResult = {
          ...machine,
          violations: machine.violations.filter((violation) => scope.includes(scopeOfRule(violation.code))),
        }
        const machineBlocking = scopedMachine.violations.filter(
          (violation) => violation.severity === 'blocker',
        )
        const semanticResult = evaluateSemantic(text, semantic)
        const blocking = machineBlocking.length
        const verdict: 'pass' | 'fail' = blocking === 0 && !semanticResult.failed ? 'pass' : 'fail'
        const check: CheckDocument = {
          schema_version: 1,
          chapter: input.chapter,
          scope,
          content_hash: sha256(text),
          machine: { violations: scopedMachine.violations, metrics: scopedMachine.metrics },
          semantic: { items: semantic },
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
                ...semanticResult.blocking,
              ]
            : []
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          stage: nextStage,
          // A partial pass is informational and stays at P6; it must not burn
          // the check retry budget before the required full-scope run.
          rounds: {
            ...snapshot.pipeline.rounds,
            check: snapshot.pipeline.rounds.check + (verdict === 'fail' || fullScope ? 1 : 0),
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
            { path: checkFile(input.chapter), text: yaml(check) },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
          data: {
            chapter: input.chapter,
            verdict,
            violations: scopedMachine.violations.length,
            metrics: scopedMachine.metrics,
            stage: nextStage,
          },
          warnings: [
            ...machineWarnings(scopedMachine),
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

  async archiveChapter(
    input: ArchiveSubmission,
  ): Promise<
    OpResult<{ chapter: number; assigned_ids: Record<string, string>; metrics: WordMetrics; score: number }>
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
            },
            warnings: [],
            replay: true,
          }
        }
        this.assertChapter(snapshot, input.chapter)
        this.assertChapterWithinTarget(snapshot, input.chapter, 'novel_archive')
        const text = snapshot.text ?? ''
        const summary = snapshot.plan?.summary
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
        const storedTitle = stripTitlePrefix(snapshot.plan?.title ?? '')
        const title = storedTitle === '' ? `第${chapter}章` : storedTitle
        const record: ChapterRecord = {
          num: chapter,
          title,
          file: chapterFile(chapter),
          word_count: metrics.total_word_count,
          dialogue_lines: metrics.dialogue_lines,
          dialogue_ratio: metrics.dialogue_ratio,
          scene_type: snapshot.plan?.scene_type ?? '日常过渡章',
          narrator: snapshot.plan?.narrator ?? '',
          score,
          status: 'reviewed',
          content_hash: sha256(text),
          summary,
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
          narrator: snapshot.plan?.narrator ?? null,
        })
        record.assigned_ids = ledger.assigned
        record.archive_digest = archiveDigest
        const archivedAt = this.now().toISOString()
        const outline = markOutlineArchived(
          snapshot.outline,
          record,
          archivedAt,
          snapshot.project.targets.words_per_chapter,
        )
        this.assertOutlineWritable(snapshot, outline, 'novel_archive')
        const foreshadows = ledger.foreshadows
        const timeline = ledger.timeline
        for (const item of foreshadows.items) {
          if (
            item.status !== 'resolved' &&
            chapter - item.last_touched >= this.rulepack.crosschapter.foreshadow_dormant_after
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
        const files: StagedFile[] = [
          // Re-staging the manuscript makes the archive backup a true snapshot of
          // the archived version; the body itself is unchanged by this transaction.
          { path: chapterFile(chapter), text },
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
        ]
        return {
          files,
          backup: true,
          data: { chapter, assigned_ids: ledger.assigned, metrics, score },
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

  async amend(input: AmendSubmission): Promise<OpResult<{ path: string; revision: number }>> {
    if (typeof input.path !== 'string' || input.path.trim() === '') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'amend path must be a non-empty string')
    }
    if (typeof input.reason !== 'string' || input.reason.trim() === '') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'amend requires a reason')
    }
    if (typeof input.content !== 'object' || input.content === null || Array.isArray(input.content)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'amend content must be an object')
    }
    const resolvedRoot = await this.resolveRoot(input.root)
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
    const repairPaths: string[] = []
    for (const [path, docKind] of Object.entries(MUTABLE_STATE)) {
      if (docKind === 'pipeline') continue
      if (await this.stateDocIsUnreadable(store, path, docKind)) repairPaths.push(path)
    }
    return this.mutate({
      root: resolvedRoot,
      op: 'amend',
      reason: input.reason,
      ...(repairPaths.length === 0 ? {} : { repairPaths }),
      key: (snapshot) => `amend:${input.path}:${snapshot.pipeline.revision}`,
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
        let document = (
          kind === 'project'
            ? snapshot.projectError !== null
              ? narrow('project', { ...input.content, schema_version: input.content.schema_version ?? 1 })
              : mergeProjectAmendment(input.content, snapshot.project)
            : narrow(kind, { ...input.content, schema_version: input.content.schema_version ?? 1 })
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
        // A corrupt outline may have no backup card for an auto-created
        // archived card. Reconstruct the comparison card only from independent
        // evidence (the archive record plus the stored plan/project target);
        // title/scene/word/score are still checked by amendProblems below.
        if (kind === 'outline' && (snapshot.outlineError !== null || !snapshot.outlinePresent)) {
          const old = recordOf(oldDocument)
          const oldChapters = Array.isArray(old?.chapters) ? [...old.chapters] : []
          const known = new Set(
            oldChapters
              .map((raw) => recordOf(raw))
              .filter((row): row is Record<string, unknown> => row !== null)
              .map((row) => row.num)
              .filter((num): num is number => Number.isInteger(num)),
          )
          const candidates = new Map(
            (Array.isArray(document.chapters) ? document.chapters : [])
              .map((raw) => recordOf(raw))
              .filter((row): row is Record<string, unknown> => row !== null && Number.isInteger(row.num))
              .map((row) => [row.num as number, row] as const),
          )
          for (const record of snapshot.chapters.chapters) {
            if (known.has(record.num)) continue
            const candidate = candidates.get(record.num)
            if (candidate === undefined || candidate.status !== 'archived') continue
            let plan: Record<string, unknown> | null = null
            const planRaw = await context.store.readText(planChapterFile(record.num))
            if (planRaw !== null) {
              try {
                const parsed = parsePlanYaml(planRaw, planChapterFile(record.num))
                validateStoredChapterPlan(parsed, planChapterFile(record.num))
                plan = parsed
              } catch {
                plan = null
              }
            }
            const planCast = Array.isArray(plan?.cast)
              ? plan.cast
                  .map((member) => (recordOf(member)?.name as string | undefined) ?? '')
                  .filter((name) => name !== '')
              : []
            const allowedTargets = [
              snapshot.project.targets.words_per_chapter,
              ...(Array.isArray(plan?.target_words) ? [plan.target_words] : []),
            ]
            const allowedCasts = [planCast, autoCardCast(record)]
            const targetMatches = allowedTargets.some(
              (target) => JSON.stringify(target) === JSON.stringify(candidate.target_words),
            )
            const castMatches = allowedCasts.some(
              (cast) => JSON.stringify(cast) === JSON.stringify(candidate.cast),
            )
            if (!targetMatches || !castMatches) continue
            oldChapters.push({ ...candidate })
            known.add(record.num)
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
        )
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
          data: { path: input.path, revision: context.revision },
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
      reason: input.reason,
      key: () => `rollback:${input.chapter}:${input.toStage}`,
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
        const files: StagedFile[] = [
          { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
        ]
        const current = await context.store.readText(chapterFile(input.chapter))
        if (current !== null) {
          files.push({ path: deprecatedChapterFile(input.chapter), text: current })
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
      // Text-to-text diff is independent of a project by contract. If a project
      // happens to exist, still report its active chapter and revision so the
      // existing project-scoped callers keep their chapter number.
      let chapter = input.chapter
      let revision = 1
      if (chapter === undefined) {
        try {
          const snapshot = await this.load(input.root)
          chapter = snapshot.pipeline.chapter
          revision = snapshot.pipeline.revision
        } catch {
          chapter = 0
        }
      }
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
    const requested = input.limit ?? 50
    const limit = Number.isFinite(requested) ? Math.max(0, Math.min(1000, Math.floor(requested))) : 50
    return { data: limit === 0 ? [] : rows.slice(-limit), revision: snapshot.pipeline.revision, warnings }
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
    return this.mutate<{ kind: ExportKind; files: string[] }>({
      root: input.root,
      op: 'export',
      // Export itself advances the revision, so the cache key must bind to the
      // content that was exported, not to a revision this operation is about to
      // change. Otherwise a later revision keeps returning the old file.
      key: (snapshot) =>
        `export:${input.kind}:${input.chapter ?? 'all'}:${sha256(
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

  /** One snapshot, three projections: the panel never mixes revisions. */
  async panelBundle(input: { root?: string } = {}): Promise<{
    summary: PanelSummaryDto
    chapters: PanelChaptersDto
    gates: PanelGatesDto
  }> {
    const snapshot = await this.panelSnapshot(input.root)
    return {
      summary: projectSummary(snapshot),
      chapters: projectChapters(snapshot),
      gates: projectGates(snapshot),
    }
  }

  async stats(input: { root?: string } = {}): Promise<{
    totalWords: number
    chapters: number
    revision: number
    rulepack: string
    averageScore: number
    lastScore: number
    openForeshadows: number
    plannedChapters: number
    outlineCoverage: number
    blueprintReady: boolean
    worldbookEntries: number
    strictOutline: boolean
    targetChapters: number | null
  }> {
    const snapshot = await this.load(input.root)
    const totalWords = snapshot.chapters.chapters.reduce((total, chapter) => total + chapter.word_count, 0)
    const scores = snapshot.chapters.chapters.map((chapter) => chapter.score)
    const outline = outlineSummary(snapshot.outline, snapshot.chapters.chapters.length)
    const counts = worldbookCounts(snapshot.worldbook)
    return {
      totalWords,
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
      outlineCoverage: outline.coverage,
      blueprintReady: bookPlanPresent(snapshot.outline.book),
      worldbookEntries:
        counts.characters +
        counts.locations +
        counts.factions +
        counts.rules +
        counts.glossary +
        counts.backstory,
      strictOutline: snapshot.outline.book.strict,
      targetChapters: snapshot.project.targets.total_chapters,
    }
  }

  /* ------------------------------------------------------- multi-project ops */

  private registry(): ProjectRegistry {
    const dir =
      this.config.stateDir === '' ? join(homedir(), '.dsh', 'novel-write-engine') : this.config.stateDir
    return new ProjectRegistry(new FsStore(dir))
  }

  /** List known projects (convenience only; a project opens without a row). */
  async listProjects(): Promise<{ active: string | null; projects: RegistryEntry[] }> {
    const document = await this.registry().read()
    return { active: document.active, projects: document.projects }
  }

  /** Record the current project in the registry. */
  async registerProject(
    input: { root?: string } = {},
  ): Promise<{ active: string | null; projects: RegistryEntry[] }> {
    const snapshot = await this.load(input.root)
    const document = await this.registry().register({ root: snapshot.root, title: snapshot.project.title })
    return { active: document.active, projects: document.projects }
  }

  /** Choose the default project for future convenience calls. */
  async setActiveProject(input: { root: string }): Promise<{ active: string | null }> {
    const document = await this.registry().setActive(resolve(input.root))
    this.lastRoot = document.active === null ? null : resolve(document.active)
    return { active: document.active }
  }

  /** Forget a registry row; the project directory is never touched. */
  async forgetProject(input: {
    root: string
  }): Promise<{ active: string | null; projects: RegistryEntry[] }> {
    const document = await this.registry().forget(resolve(input.root))
    if (this.lastRoot === resolve(input.root)) {
      this.lastRoot = document.active === null ? null : resolve(document.active)
    }
    return { active: document.active, projects: document.projects }
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
   * A strict outline cannot silently lose the active chapter's card while the
   * chapter is still being written. Otherwise a late replacement turns a
   * strict project non-strict in effect and archive would auto-create the card
   * the author was required to provide.
   */
  private assertActiveCardPreserved(
    snapshot: Snapshot,
    strict: boolean,
    chapters: readonly { num: number }[],
    operation: string,
  ): void {
    if (!strict) return
    const chapter = snapshot.pipeline.chapter
    if (!snapshot.outline.chapters.some((card) => card.num === chapter)) return
    if (chapters.some((card) => card.num === chapter)) return
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `${operation} cannot remove the active chapter ${chapter} card while strict mode is on`,
      'include the active card in the replacement, or turn strict mode off with novel_blueprint {"strict":false}',
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
    const summary = outlineSummary(snapshot.outline, snapshot.chapters.chapters.length)
    const counts = worldbookCounts(snapshot.worldbook)
    return {
      premise: snapshot.outline.book.premise,
      logline: snapshot.outline.book.logline,
      strict: snapshot.outline.book.strict,
      outline: {
        present: snapshot.outlinePresent && summary.present,
        total: summary.total,
        planned: summary.planned,
        archived: summary.archived,
        coverage: summary.coverage,
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
      },
    }
  }

  private async panelSnapshot(root?: string): Promise<PanelSnapshot> {
    const snapshot = await this.load(root)
    const archived = snapshot.chapters.chapters
    const archivedCurrent = archived.some((chapter) => chapter.num === snapshot.pipeline.chapter)
    const target = snapshot.project.targets.total_chapters
    const finished = snapshot.pipeline.stage === 'done' && target !== null && archived.length >= target
    const draftWords = snapshot.text === null ? 0 : countWordMetrics(snapshot.text).total_word_count
    const journal = await readJournal(this.storeFor(snapshot.root))
    const journalBlocking = await this.journalBlocking(snapshot)
    const outline = outlineSummary(snapshot.outline, archived.length)
    const counts = worldbookCounts(snapshot.worldbook)
    const scores = archived.slice(-10).map((chapter) => chapter.score)
    const blocking = [...this.effectiveBlocking(snapshot), ...journalBlocking]
    const healthBlocking = blocking.length
    const stateErrorCount = this.stateErrors(snapshot).length
    const book = {
      premise: snapshot.outline.book.premise,
      logline: snapshot.outline.book.logline,
      strict: snapshot.outline.book.strict,
      target,
      outline: {
        present: snapshot.outlinePresent && outline.present,
        total: outline.total,
        planned: outline.planned,
        archived: outline.archived,
        coverage: outline.coverage,
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
      },
    }
    const qualityScores = scores.slice(-5)
    const previousScores = scores.slice(-10, -5)
    const quality = {
      averageScore:
        scores.length === 0 ? 0 : scores.reduce((total, score) => total + score, 0) / scores.length,
      scores,
      trend:
        previousScores.length === 0
          ? 0
          : qualityScores.reduce((total, score) => total + score, 0) / qualityScores.length -
            previousScores.reduce((total, score) => total + score, 0) / previousScores.length,
    }
    const activity = journal.rows.slice(-5).map((row) => ({
      at: row.at,
      op: row.op,
      chapter: row.chapter,
      status: row.status,
    }))
    const draft =
      archivedCurrent || snapshot.pipeline.stage === 'done'
        ? null
        : {
            num: snapshot.pipeline.chapter,
            title: stripTitlePrefix(snapshot.plan?.title ?? '') || `第${snapshot.pipeline.chapter}章`,
            wordCount: draftWords,
            score: snapshot.review?.total ?? 0,
            status: (blocking.length > 0 ? 'blocked' : 'draft') as 'blocked' | 'draft',
            details: (snapshot.plan?.summary?.events ?? []).join('；').slice(0, 240),
          }
    return {
      root: snapshot.root,
      title: snapshot.project.title,
      genre: snapshot.project.genre,
      platform: snapshot.project.platform,
      chapter: snapshot.pipeline.chapter,
      stage: snapshot.pipeline.stage,
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
      totalWords:
        archived.reduce((total, chapter) => total + chapter.word_count, 0) +
        (draft === null ? 0 : draft.wordCount),
      averageScore:
        archived.length === 0
          ? 0
          : archived.reduce((total, chapter) => total + chapter.score, 0) / archived.length,
      phases: phaseStrip(snapshot.pipeline.stage, finished),
      book,
      quality,
      health: {
        ok: healthBlocking === 0 && stateErrorCount === 0,
        blocking: healthBlocking,
        stateErrors: stateErrorCount,
      },
      activity,
    }
  }

  /**
   * The archive stage has only one legal operation, so a status/panel that
   * recommends it without checking the same gates as the archive creates a
   * loop. Evaluate the real archive gates through `gateInput`, then add the
   * machine pass and semantic evidence that archive re-checks separately.
   */
  private archivePreflight(
    snapshot: Snapshot,
  ): { item: BlockingItem; to_stage: RollbackSubmission['toStage'] } | null {
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
      const first = gateResult.blocking[0]!
      const target: RollbackSubmission['toStage'] =
        first.code === 'PG-03' || first.code === 'PG-04' || first.code === 'PG-05' || first.code === 'PG-06'
          ? 'P3'
          : first.code === 'PG-07' || first.code === 'PG-08' || first.code === 'PG-09'
            ? 'P4'
            : first.code === 'PG-11'
              ? 'P4'
              : 'P6'
      return { item: { ...first, scope: first.scope ?? 'archive' }, to_stage: target }
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
          hint: 'call novel_rollback with to_stage P3 and re-submit the draft and plan fields',
        },
        to_stage: 'P3',
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
          hint: 'call novel_rollback with to_stage P6, then re-run novel_check',
        },
        to_stage: 'P6',
      }
    }
    return null
  }

  private nextStep(snapshot: Snapshot): StatusReport['next'] {
    const stage = snapshot.pipeline.stage
    const chapter = snapshot.pipeline.chapter
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
    const target = snapshot.project.targets.total_chapters
    const finished = stage === 'done' && target !== null && snapshot.chapters.chapters.length >= target
    if (finished) {
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
    const briefStage = STATUS_BRIEF[stage]
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
    const archive = this.archivePreflight(snapshot)
    if (archive !== null) {
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
        hint: 'call novel_outline to add the card, or novel_blueprint {"strict":false} to turn strict mode off',
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
    return errors
  }

  /** The earliest rebuild point for the current state damage. */
  private recoveryFor(snapshot: Snapshot): {
    tool: 'novel_rollback' | 'novel_amend'
    args: Record<string, unknown>
    reason: string
  } {
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
    return relevant.map((error) => ({
      code: 'STATE_UNREADABLE',
      scope: 'state',
      detail: `${error.code}: ${error.message}`,
      hint: this.recoveryFor(snapshot).reason,
    }))
  }

  /** Whether the stored brief still signs the current snapshot. */
  private briefIsCurrent(snapshot: Snapshot, stage: BriefStage): boolean {
    const record = snapshot.pipeline.briefs[stage]
    if (record === undefined) return false
    const context = this.briefContextFor(stage, snapshot, snapshot.pipeline.chapter)
    return record.digest === this.briefDigest(stage, snapshot, context)
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

  private machine(
    snapshot: Snapshot,
    text: string,
    extra: {
      title?: string | null
      sceneType?: import('../types.js').SceneType
      summary?: ChapterSummary | null
    },
  ): MachineResult {
    const options: MachineOptions = {
      chapter: snapshot.pipeline.chapter,
      title: composeTitle(
        snapshot.pipeline.chapter,
        extra.title ?? snapshot.plan?.title ?? null,
        this.rulepack.format.title.pattern,
      ),
      genre: snapshot.project.genre,
      sceneType: extra.sceneType ?? snapshot.plan?.scene_type ?? '日常过渡章',
      rulepack: this.rulepack,
      summary: extra.summary ?? snapshot.plan?.summary ?? null,
      evidence: {
        characters: snapshot.characters.characters.length > 0 ? snapshot.characters : null,
        previousText: snapshot.previousText,
        previousTexts: snapshot.previousTexts,
        foreshadows: snapshot.foreshadows.items.length > 0 ? snapshot.foreshadows : null,
        timeline: snapshot.timeline.items.length > 0 ? snapshot.timeline : null,
        relationships: snapshot.relationships.items.length > 0 ? snapshot.relationships : null,
        world: snapshot.world,
        locks: snapshot.locks,
      },
    }
    return runMachineChecks(text, options)
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
    })
    cache.set(cacheKey, context)
    return context
  }

  private briefDigest(stage: string, snapshot: Snapshot, context: Record<string, unknown>): string {
    // The rendered file is part of the contract: editing briefs/P5.md must
    // invalidate a digest issued against the old text.
    const briefHash = this.briefs.render(
      stage as import('../types.js').BriefStage,
      this.briefVariables(snapshot, snapshot.pipeline.chapter),
    ).contentHash
    return shortDigest(
      stableJson({
        stage,
        briefHash,
        chapter: snapshot.pipeline.chapter,
        pipelineStage: snapshot.pipeline.stage,
        rounds: snapshot.pipeline.rounds,
        min_score: this.config.quality.minScore,
        rulepack: `${this.rulepack.name}@${this.rulepack.version}`,
        context,
      }),
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
        | 'draftTitle'
        | 'sceneType'
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
      pipeline: snapshot.pipeline,
      chapters: snapshot.chapters,
      briefDigest:
        extras.briefDigest ??
        (extras.briefStage === undefined || extras.briefStage === null
          ? null
          : this.briefDigest(
              extras.briefStage,
              snapshot,
              this.briefContextFor(extras.briefStage, snapshot, snapshot.pipeline.chapter),
            )),
      briefStage: extras.briefStage ?? briefStageFor(operation, snapshot.pipeline.stage),
      draftTitle: composeTitle(
        snapshot.pipeline.chapter,
        extras.draftTitle ?? snapshot.plan?.title ?? null,
        this.rulepack.format.title.pattern,
      ),
      sceneType: extras.sceneType ?? snapshot.plan?.scene_type ?? null,
      summary: extras.summary ?? snapshot.plan?.summary ?? null,
      summaryProvided: extras.summaryProvided,
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
      },
      previousText: snapshot.previousText,
      previousTexts: snapshot.previousTexts,
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
        | 'draftTitle'
        | 'sceneType'
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

  /** True when anything survives in the project directory besides novel.yaml. */
  private async projectStateExists(store: FsStore): Promise<boolean> {
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
    stateFiles.push(joinRel(STATE_DIR, STATE_FILES.journal), ARCHIVE_DIGESTS)
    return (
      (await Promise.all(stateFiles.map((path) => store.exists(path)))).some(Boolean) ||
      (await store.list(CHAPTERS_DIR)).length > 0 ||
      (await store.list('plans')).length > 0 ||
      (await store.list('reviews')).length > 0 ||
      (await store.list('checks')).length > 0 ||
      (await store.exists(OUTLINE_FILE)) ||
      (await store.exists(WORLDBOOK_FILE))
    )
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

  private async load(root?: string, retries = 1, allowLock = false): Promise<Snapshot> {
    const store = this.storeFor(await this.resolveRoot(root))
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
    if (!projectExists && !(await this.projectStateExists(store))) {
      throw new EngineInputError(
        ERROR_CODES.PROJECT_NOT_FOUND,
        `no novel project at ${store.root}`,
        'call novel_init to create one, or pass the correct project root',
      )
    }
    let project: NovelProject = {
      ...ENGINE_PROJECT_INITIAL,
      title: '（项目文件不可读）',
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
    const pipeline = (await store.readDoc(
      joinRel(STATE_DIR, STATE_FILES.pipeline),
      'pipeline',
    )) as unknown as PipelineState | null
    if (pipeline === null)
      throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, 'state/pipeline.yaml is missing')
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
    for (let offset = 1; offset <= 3 && chapter - offset >= 1; offset += 1) {
      const previous = await store.readText(chapterFile(chapter - offset))
      if (previous !== null) previousTexts.push(previous)
    }
    const planRaw = await store.readText(planChapterFile(chapter))
    let plan: (ChapterPlanInput & { summary?: ChapterSummary }) | null = null
    let planError: string | null = null
    if (planRaw !== null) {
      try {
        const parsed = parsePlanYaml(planRaw, planChapterFile(chapter))
        validateStoredChapterPlan(parsed, planChapterFile(chapter))
        plan = parsed as unknown as ChapterPlanInput & { summary?: ChapterSummary }
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
    const latest = (await store.readDoc(
      joinRel(STATE_DIR, STATE_FILES.pipeline),
      'pipeline',
    )) as unknown as PipelineState | null
    if (latest === null || latest.revision !== pipeline.revision) {
      if (retries > 0) return this.load(store.root, retries - 1, allowLock)
      throw new EngineFaultError(
        ERROR_CODES.TXN_ABORTED,
        'the project changed while its snapshot was being read',
        'retry the read; if it keeps moving, wait for the writer to finish',
      )
    }
    // A writer may have taken the lock after the initial check. Re-check before
    // returning: otherwise this read can see new ledgers with the old pipeline
    // while the writer is still before its pipeline rename.
    if (!allowLock && (await this.lockIsLive(store))) {
      if (retries > 0) return this.load(store.root, retries - 1, false)
      throw new EngineFaultError(
        ERROR_CODES.TXN_IN_PROGRESS,
        'a writer started while the snapshot was being read; the snapshot is torn',
        'retry after the write finishes; do not interpret this snapshot as stable',
      )
    }
    // Only a confirmed snapshot may become the panel's remembered root. A typo
    // in project_root must not make every later rootless call point at it.
    this.lastRoot = store.root
    return {
      root: store.root,
      project: project as unknown as NovelProject,
      projectError,
      pipeline: pipeline as unknown as PipelineState,
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
    op: Operation
    key?: (snapshot: Snapshot) => string
    emptyAllowed?: boolean
    /** Human reason for a maintenance transaction; persisted in the journal. */
    reason?: string
    /** Only an explicit amend may overwrite these externally changed paths. */
    repairPaths?: readonly string[]
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
    const root = await this.resolveRoot(options.root)
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
      const journalPath = joinRel(STATE_DIR, STATE_FILES.journal)
      const journalWasPresent = await store.exists(journalPath)
      const projectExists = await store.exists(PROJECT_FILE)
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
            stateFiles.push(joinRel(STATE_DIR, STATE_FILES.journal), ARCHIVE_DIGESTS)
            // A journal created by the lock-reclaim callback is part of this
            // init, not pre-existing project evidence. Only count a journal
            // that was present before the lock attempt.
            const stateCandidates = journalWasPresent
              ? stateFiles
              : stateFiles.filter((path) => path !== joinRel(STATE_DIR, STATE_FILES.journal))
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
            await assertJournalConsistent(store)
            const created = await options.run(this.emptySnapshot(root), { store, revision: 1 })
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
            this.lastRoot = root
            return { data: created.data, revision: 1, warnings: created.warnings ?? [] }
          }
        }
        // The snapshot must be read while holding the cross-process lock;
        // otherwise a second process can commit between read and write and the
        // later writer silently overwrites it with a stale revision.
        await assertJournalConsistent(store, options.repairPaths ?? [])
        const snapshot = await this.load(root, 1, true)
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
        const revision = snapshot.pipeline.revision + 1
        abortIfNeeded()
        const outcome = await options.run(snapshot, { store, revision })
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
          chapter: snapshot.pipeline.chapter,
          revision,
          files: outcome.files,
          backup: outcome.backup ?? false,
          backupRetention: this.config.storage.backupRetention,
          signal,
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        })
        const result: OpResult<T> = { data: outcome.data, revision, warnings: outcome.warnings ?? [] }
        if (key !== undefined) {
          this.invalidateReplay(root, options.op)
          this.replay.set(`${root}|${options.op}|${key}`, result)
        } else {
          this.invalidateReplay(root, options.op)
        }
        if (outcome.event !== undefined) this.onEvent?.(outcome.event)
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

  private emptySnapshot(root: string): Snapshot {
    return {
      root,
      project: { ...ENGINE_PROJECT_INITIAL },
      projectError: null,
      pipeline: emptyPipeline({ revision: 1, chapter: 1, stage: 'idle' }),
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
  briefs: snapshot.pipeline.briefs,
  blocking: snapshot.pipeline.blocking,
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

const machineWarnings = (machine: MachineResult): Warning[] =>
  machine.violations
    .filter((violation) => violation.severity === 'advisory')
    .slice(0, 5)
    .map((violation) => ({
      code: violation.code,
      message: `${violation.detail} (paragraph ${violation.location.paragraph})`,
    }))

/** 0.1.2 archive digests used localeCompare; keep that comparison only for upgrades. */
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
  const allowed = new Set(['schema_version', 'title', 'author', 'description', 'targets', 'total_chapters'])
  for (const key of Object.keys(content)) {
    if (!allowed.has(key)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `novel.yaml amend cannot change "${key}"`,
        'only title, author, description and targets.total_chapters are mutable',
      )
    }
  }
  const merged: Record<string, unknown> = { ...old, ...content }
  if (content.targets !== undefined) {
    const targets = recordOf(content.targets)
    if (targets === null) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'targets must be an object')
    }
    const allowedTargets = new Set(['words_per_chapter', 'dialogue_ratio', 'total_chapters'])
    for (const key of Object.keys(targets)) {
      if (!allowedTargets.has(key)) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `novel.yaml targets cannot change "${key}"`,
          'only targets.total_chapters is mutable; words_per_chapter and dialogue_ratio are immutable',
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
        problems.push('words_per_chapter and dialogue_ratio are immutable; only total_chapters may change')
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
      if (stableJson(before.assigned_ids ?? {}) !== stableJson(after.assigned_ids ?? {})) {
        problems.push(`archived chapter ${String(before.num)} cannot change its assigned_ids`)
      }
      for (const field of [
        'title',
        'file',
        'word_count',
        'dialogue_lines',
        'dialogue_ratio',
        'scene_type',
        'narrator',
        'score',
        'status',
        'summary',
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
    }
    const nextSeq = nextDocument.next_seq
    const prefix = kind === 'foreshadows' ? 'FS-' : kind === 'timeline' ? 'TE-' : 'RL-'
    let engineFloor = 0
    for (const chapter of snapshot.chapters.chapters) {
      for (const value of Object.values(chapter.assigned_ids ?? {})) {
        if (typeof value !== 'string' || !value.startsWith(prefix)) continue
        const match = /-(\d+)$/.exec(value)
        if (match !== null) engineFloor = Math.max(engineFloor, Number(match[1]))
      }
    }
    if (kind === 'foreshadows' && snapshot.handoff !== null) {
      for (const hook of snapshot.handoff.open_hooks) {
        if (!hook.id.startsWith(prefix)) continue
        const match = /-(\d+)$/.exec(hook.id)
        if (match !== null) engineFloor = Math.max(engineFloor, Number(match[1]))
      }
    }
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
    const names = new Set(
      (Array.isArray(nextDocument.characters) ? nextDocument.characters : [])
        .map((raw) => recordOf(raw)?.name)
        .filter((name): name is string => typeof name === 'string'),
    )
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
    return problems
  }

  if (kind === 'relationships') {
    if (snapshot.ledgerErrors.some((error) => error.code === 'CHARACTERS_UNREADABLE')) {
      problems.push('cannot validate relationships while characters.yaml is unreadable')
      return problems
    }
    const names = new Set(snapshot.characters.characters.map((character) => character.name))
    for (const raw of Array.isArray(nextDocument.items) ? nextDocument.items : []) {
      const row = recordOf(raw)
      if (row !== null && (typeof row.a !== 'string' || typeof row.b !== 'string')) {
        problems.push('relationship endpoints must be strings')
      } else if (row !== null && (!names.has(row.a as string) || !names.has(row.b as string))) {
        problems.push(`relationship ${String(row.id)} references an unknown character`)
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

const castShapeProblems = (value: unknown): string[] => {
  if (!Array.isArray(value)) return ['cast must be an array']
  if (value.length < 1 || value.length > 8) return ['cast must contain 1..8 members']
  const problems: string[] = []
  const names = new Set<string>()
  for (const [index, raw] of value.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      problems.push(`cast[${index}] must be an object`)
      continue
    }
    const member = raw as Record<string, unknown>
    if (typeof member.name !== 'string' || member.name.trim() === '') {
      problems.push(`cast[${index}].name must be non-empty`)
      continue
    }
    if (names.has(member.name)) problems.push(`cast contains duplicate name "${member.name}"`)
    names.add(member.name)
    for (const field of ['entry_state', 'goal', 'exit_change'] as const) {
      if (member[field] !== undefined && typeof member[field] !== 'string') {
        problems.push(`cast[${index}].${field} must be a string`)
      }
    }
    if (
      member.knowledge !== undefined &&
      (!Array.isArray(member.knowledge) || member.knowledge.some((item) => typeof item !== 'string'))
    ) {
      problems.push(`cast[${index}].knowledge must be a string array`)
    }
  }
  return problems
}

const normalizeCast = (value: unknown, snapshot: Snapshot): ChapterCastMember[] | undefined => {
  if (value === undefined) return undefined
  const problems = castShapeProblems(value)
  if (problems.length > 0) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, problems.join('; '))
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
    const problems = castShapeProblems(plan.cast)
    if (problems.length > 0) fail(problems.join('; '))
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
