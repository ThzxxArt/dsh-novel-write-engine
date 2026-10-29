import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { parse as parseYaml, stringify } from 'yaml'
import {
  ARCHIVE_DIGESTS_FILE,
  BACKUP_DIR,
  BRIEF_RECEIPTS_FILE,
  CHAPTERS_DIR,
  EXPORT_DIR,
  LIMITS,
  LOCK_FILE,
  METADATA_LOCK_FILE,
  OUTLINE_FILE,
  PROJECT_FILE,
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
  readJournal,
  reconcileJournal,
} from '../store/journal.js'
import { listBackups, readBackupManifest } from '../store/backup.js'
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
import { historyTexts, listHistory } from './history.js'
import { BriefLibrary } from './brief.js'
import { briefContext } from './context.js'
import { applyStateDelta } from './state-delta.js'
import { evaluateSemantic } from './semantic.js'
import { briefStageFor, evaluateGates, gateName, parseParagraphLocation } from './gates.js'
import { advanceHandoff, parseActProgress, projectHandoff } from './handoff.js'
import {
  formatResumePrompt,
  phaseStrip,
  projectChapters,
  projectGates,
  projectSummary,
  type PanelBundle,
  type PanelChaptersDto,
  type PanelGatesDto,
  type PanelProjectOption,
  type PanelSelection,
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
  type ScoreDimension,
  type Selection,
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
  type DraftState,
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
  /** Advisory codes the author has read and accepts; blockers cannot be acknowledged. */
  acknowledge?: string[]
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

export interface RestoreSubmission {
  txid: string
  chapter?: number
  /** Restrict to these project-relative files; omitted restores every chapter file in the snapshot. */
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
  chapter?: number
  /** Select one historical revision instead of listing history. */
  revision?: number
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
  pipeline: PipelineState
  /** Latest receipt per brief stage, loaded from state/briefs.yaml or legacy pipeline.briefs. */
  briefs: PipelineState['briefs']
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
  private readonly metadataMutex = new KeyedMutex()
  private readonly callerContext = new AsyncLocalStorage<EngineCaller | undefined>()

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
    return this.mutate({
      root: input.root,
      op: 'restoreBackup',
      chapter: input.chapter,
      reason: `restore backup ${input.txid}`,
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
                const restored = narrow(kind, parsed)
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
                  ...effectiveCheck.machine.violations.map((violation) => ({
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
   * Count every committed attempt for one chapter, not just the loop since the
   * last rollback. `pipeline.rounds` is deliberately reset by rollback to keep
   * the retry budget fair; it is not the chapter's lifetime effort.
   */
  private async lifetimeRounds(snapshot: Snapshot, chapter: number): Promise<RoundCounters> {
    const { rows } = await readJournal(this.storeFor(snapshot.root))
    const committed = (op: string): number =>
      rows.filter((row) => row.status === 'committed' && row.chapter === chapter && row.op === op).length
    return {
      review: Math.max(snapshot.pipeline.rounds.review, committed('submitReview')),
      revise: Math.max(snapshot.pipeline.rounds.revise, committed('submitRevision')),
      check: Math.max(snapshot.pipeline.rounds.check, committed('runCheck')),
      rollbacks: committed('rollback'),
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
  private async statusFor(snapshot: Snapshot, chapter: number): Promise<OpResult<StatusReport>> {
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
      selection: { source: snapshot.selection.source, root: snapshot.selection.root },
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

  async queryState(input: StateQueryInput): Promise<OpResult<unknown>> {
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
        // `pipeline.briefs` is a legacy fallback; the effective receipts live in
        // state/briefs.yaml and are merged into snapshot.briefs at load time.
        return {
          data: { ...snapshot.pipeline, briefs: snapshot.briefs },
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
      case 'briefs': {
        const receipts = await this.readBriefReceipts(store)
        if (receipts.receipts.length > 0) {
          return { data: receipts, revision: snapshot.pipeline.revision, warnings: [] }
        }
        // 0.2.0 projects signed briefs in pipeline.briefs and have no receipt
        // file. The loader already falls back to that map for gates; expose the
        // same legacy view instead of reporting an empty audit trail.
        const legacy = Object.entries(snapshot.briefs).map(([stage, receipt]) => ({
          chapter: snapshot.pipeline.chapter,
          stage,
          digest: receipt.digest,
          issued_at: receipt.issued_at,
        }))
        return {
          data: { schema_version: 1 as const, receipts: legacy },
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
      case 'history': {
        const entries = await listHistory(store, input.chapter)
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
        return {
          data: { schema_version: 1, entries, total: entries.length },
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
      case 'backups': {
        const backups = await listBackups(store)
        return {
          data: { schema_version: 1, backups },
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
    const outlineProgress = outlineSummary(
      snapshot.outline,
      archivedRecords.length,
      snapshot.project.targets.total_chapters,
      archivedRecords.map((record) => record.num),
    )
    const percentText = (value: number | null): string =>
      value === null ? '—' : `${Math.round(value * 1000) / 10}%`
    add({
      id: 'outline-coverage',
      severity:
        missingCards.length === 0 &&
        extraCards.length === 0 &&
        (outlineProgress.target === null || outlineProgress.missingCards === 0)
          ? 'ok'
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
    // List history once. Calling listHistory per chapter reread every history
    // file on every iteration, turning a whole-book report into O(chapters ×
    // history files) disk work.
    const historicalEntries = await listHistory(store)
    for (const record of snapshot.chapters.chapters) {
      try {
        const review = await store.readDoc(reviewFile(record.num), 'review')
        if (review === null) reviewIssues.push(`chapter ${record.num}: review is missing`)
        else reviews.push(review as unknown as ReviewDocument)
        for (const historical of await historyTexts(store, 'reviews', record.num, historicalEntries)) {
          try {
            const parsed = narrow('review', parseYaml(historical.text)) as unknown as ReviewDocument
            reviews.push(parsed)
          } catch (error) {
            reviewIssues.push(`chapter ${record.num} ${historical.path}: ${errorMessage(error)}`)
          }
        }
      } catch (error) {
        reviewIssues.push(`chapter ${record.num}: ${errorMessage(error)}`)
      }
    }
    // A revision that does not change issue status/evidence used to copy the
    // current review into history byte-for-byte, and report counted both
    // copies as independent quality samples. Keep each distinct review once;
    // distinct reviews from a rollback-reset round still count separately.
    const uniqueReviews = new Map<string, ReviewDocument>()
    for (const review of reviews) {
      const key = stableJson(review)
      if (!uniqueReviews.has(key)) uniqueReviews.set(key, review)
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
      reviews: [...uniqueReviews.values()],
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
      chapter: input.chapter,
      advanceRevision: false,
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
          max_words: snapshot.project.targets.words_per_chapter[1],
          word_count_policy: {
            metric: 'total_word_count',
            includes_punctuation: true,
            formula: 'cjk_chars + english_words + numbers + punctuation_chars',
            note: '引擎与商业平台一致把标点计入字数；brief/status/check 的 min_words 都是这个口径',
          },
          dialogue_ratio_target: snapshot.project.targets.dialogue_ratio,
          dialogue_ratio_metric: '含引号行数 / 非空行数',
          delta_rules: {
            title_is_a_label: true,
            anchor_required_for_verification: true,
            rule: '伏笔 title 可以写成可读短语；要逐字校验请在 anchor 里放正文原句（至少 8 个字符）。缺 anchor 时 title 必须逐字出现在正文。',
          },
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
        const existing = snapshot.briefs[input.stage]
        if (existing !== undefined && existing.digest === digest) {
          return { files: [], data, replay: true }
        }
        const issuedAt = this.now().toISOString()
        const receiptDocument = await this.readBriefReceipts(context.store)
        receiptDocument.receipts.push({
          chapter,
          stage: input.stage,
          digest,
          issued_at: issuedAt,
        })
        // Receipts are append-only evidence. Do not silently drop the oldest
        // stage signatures to keep the file small; a long book has every right
        // to audit why a task book was issued.
        const receipts = receiptDocument.receipts
        return {
          files: [
            {
              path: BRIEF_RECEIPTS_FILE,
              text: yaml({ schema_version: 1, receipts }),
            },
          ],
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

  async submitReview(
    input: ReviewSubmission,
  ): Promise<
    OpResult<{ chapter: number; round: number; total: number; open_blockers: number; next_stage: Stage }>
  > {
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
    const hasContent = typeof input.content === 'string' && input.content.trim() !== ''
    const hasPatch = input.patch !== undefined
    if (hasContent === hasPatch) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'novel_revise requires exactly one of content or patch',
        'send the full revised text, or a patch with expected_hash and unique edits',
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
        `revision:${input.chapter}:${sha256(input.content ?? stableJson(input.patch))}:${sha256(
          stableJson({ summary: input.summary, issues: input.issues, proof: input.proof }),
        )}`,
      run: async (snapshot, context) => {
        this.assertChapter(snapshot, input.chapter)
        const revisedContent =
          input.patch === undefined
            ? (input.content as string)
            : applyRevisionPatch(snapshot.text ?? '', input.patch)
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
          review: patchedReview,
          proof: input.proof,
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
        const nextStage = computeNextStage(snapshot.pipeline.stage, 'submitRevision', 0)
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          stage: nextStage,
          draft: {
            ...baseDraft,
            summary: effectiveSummary,
            content_hash: sha256(revisedContent),
            updated_at: this.now().toISOString(),
          },
          rounds: { ...snapshot.pipeline.rounds, revise: snapshot.pipeline.rounds.revise + 1 },
          blocking: [],
          ...(patchedReview === null || (!reviewChanged && snapshot.pipeline.review_digest !== undefined)
            ? {}
            : { review_digest: sha256(stableJson(patchedReview)) }),
          last_action: action('novel_revise', this.now(), sha256(revisedContent)),
        })
        const files: StagedFile[] = [
          ...(snapshot.text === null
            ? []
            : [{ path: chapterHistoryFile(input.chapter, snapshot.pipeline.revision), text: snapshot.text }]),
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
        if (reviewChanged && patchedReview !== null) {
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
      advisories: number
      advisory_codes: string[]
      acknowledged: string[]
      metrics: WordMetrics
      stage: Stage
    }>
  > {
    const scope = normalizeCheckScope(input.scope)
    return this.mutate({
      root: input.root,
      op: 'runCheck',
      chapter: input.chapter,
      key: (snapshot) =>
        `check:${input.chapter}:${sha256(snapshot.text ?? '')}:${sha256(
          stableJson({ semantic: input.semantic ?? [], scope, acknowledge: input.acknowledge ?? [] }),
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
        const machineAdvisories = scopedMachine.violations.filter(
          (violation) => violation.severity === 'advisory',
        )
        const advisoryCodes = [...new Set(machineAdvisories.map((violation) => violation.code))]
        const requestedAck = Array.isArray(input.acknowledge) ? input.acknowledge : []
        const unknownAck = requestedAck.filter((code) => !advisoryCodes.includes(code))
        if (unknownAck.length > 0) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `cannot acknowledge non-advisory finding(s): ${unknownAck.join(', ')}`,
            `advisory codes in this run: ${advisoryCodes.join(', ') || 'none'}; blockers and unknown codes cannot be acknowledged`,
          )
        }
        const priorAck =
          snapshot.check !== null && snapshot.check.content_hash === sha256(text)
            ? (snapshot.check.acknowledged ?? [])
            : []
        const acknowledged = [...new Set([...priorAck, ...requestedAck])].filter((code) =>
          advisoryCodes.includes(code),
        )
        const semanticResult = evaluateSemantic(text, semantic)
        const blocking = machineBlocking.length
        const verdict: 'pass' | 'fail' = blocking === 0 && !semanticResult.failed ? 'pass' : 'fail'
        const check: CheckDocument = {
          schema_version: 1,
          chapter: input.chapter,
          scope,
          content_hash: sha256(text),
          machine: {
            violations: machineBlocking,
            advisories: machineAdvisories,
            metrics: scopedMachine.metrics,
          },
          semantic: { items: semantic },
          ...(acknowledged.length === 0 ? {} : { acknowledged }),
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
            advisories: machineAdvisories.filter((violation) => !acknowledged.includes(violation.code))
              .length,
            advisory_codes: advisoryCodes,
            acknowledged,
            metrics: scopedMachine.metrics,
            stage: nextStage,
          },
          warnings: [
            ...machineWarnings(scopedMachine, acknowledged),
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
        })
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
    const repairPaths: string[] = []
    for (const [path, docKind] of Object.entries(MUTABLE_STATE)) {
      if (docKind === 'pipeline') continue
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
    const requested = input.limit ?? 50
    const limit = Number.isFinite(requested) ? Math.max(0, Math.min(1000, Math.floor(requested))) : 50
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

  /**
   * Build the read-only panel payload. The query root is accepted only when it
   * is registered, active or the configured root; arbitrary paths never reach
   * the filesystem from the panel route.
   */
  async panelBundle(input: { root?: string } = {}): Promise<PanelBundle> {
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
              : 'missing'
      const sameIdentity =
        expectedCreatedAt === undefined ||
        expectedCreatedAt === '' ||
        inspection.created_at === expectedCreatedAt
      const title =
        inspection.state === 'ok' && inspection.title !== '' && sameIdentity
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
    if (!rows.has(configured)) {
      const option = await optionFor(configured, false)
      // A never-created ./novel should not look like a broken project on a
      // fresh install; an active/config path that actually has evidence does.
      if (option.state !== 'missing' || active === configured) add(option)
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
    } else if (registry.projects.length === 1) {
      selection = { root: registry.projects[0]!.root, source: 'single' }
    } else if (rows.has(configured) && !registry.projects.some((entry) => entry.root === configured)) {
      selection = { root: configured, source: 'config' }
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
      snapshot = await this.panelSnapshot(selection.root)
    } catch (error) {
      // The directory can disappear between the cheap option inspection and the
      // full read. Keep the project list/selector and report the same missing
      // state instead of letting the route collapse to an empty payload.
      if (
        error instanceof EngineError &&
        (error.code === ERROR_CODES.PROJECT_MISSING || error.code === ERROR_CODES.PROJECT_NOT_FOUND)
      ) {
        return {
          projects,
          selection,
          missing: {
            root: selection.root,
            title: option.title,
            code:
              error.code === ERROR_CODES.PROJECT_MISSING
                ? ERROR_CODES.PROJECT_MISSING
                : ERROR_CODES.PROJECT_NOT_FOUND,
            reason: 'missing',
            hint: error.hint ?? '项目目录不在了；请恢复目录或挂载后刷新，登记行和面板偏好会保留。',
          },
        }
      }
      throw error
    }
    const summary = projectSummary(snapshot)
    const resume =
      summary.next === undefined
        ? undefined
        : {
            text: formatResumePrompt({
              title: summary.title,
              root: summary.root,
              chapter: summary.chapter,
              stage: summary.stage,
              nextTool: summary.next.tool,
            }),
          }
    return {
      projects,
      selection,
      summary,
      chapters: projectChapters(snapshot),
      gates: projectGates(snapshot),
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
      nextTool === undefined
        ? null
        : formatResumePrompt({
            title: status.data.project.title,
            root: status.data.project.root,
            chapter: status.data.chapter,
            stage: status.data.stage,
            nextTool,
          })
    return {
      data: { text, selection: status.data.selection },
      revision: status.revision,
      warnings: [],
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
    totalCards: number
    outlineCoverage: number | null
    archivedCoverage: number | null
    missingCards: number
    blueprintReady: boolean
    worldbookEntries: number
    strictOutline: boolean
    targetChapters: number | null
  }> {
    const snapshot = await this.load(input.root)
    const totalWords = snapshot.chapters.chapters.reduce((total, chapter) => total + chapter.word_count, 0)
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
    }
  }

  /* ------------------------------------------------------- multi-project ops */

  private registry(): ProjectRegistry {
    return new ProjectRegistry(this.stateStore())
  }

  /** List known projects with a cheap directory state for the panel/command. */
  async listProjects(): Promise<{
    active: string | null
    projects: Array<RegistryEntry & { state: ProjectState }>
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
          // describe the same project identity. Missing/damaged rows keep the
          // last known title instead of replacing it with a placeholder.
          ...(inspection.state === 'ok' && inspection.title !== '' && sameIdentity
            ? { title: inspection.title }
            : {}),
          state: inspection.state,
        }
      }),
    )
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

  private async panelSnapshot(root?: string): Promise<PanelSnapshot> {
    // The panel is a read-only projection. Use loadAt rather than load() so an
    // explicit query root or a workspace fallback can never write a session
    // binding or auto-register a project as a side effect of viewing it.
    const selection = await this.resolveRoot(root)
    const snapshot = await this.loadAt(selection)
    const archived = snapshot.chapters.chapters
    const archivedCurrent = archived.some((chapter) => chapter.num === snapshot.pipeline.chapter)
    const target = snapshot.project.targets.total_chapters
    const finished = snapshot.pipeline.stage === 'done' && target !== null && archived.length >= target
    const draftWords = snapshot.text === null ? 0 : countWordMetrics(snapshot.text).total_word_count
    const journal = await readJournal(this.storeFor(snapshot.root))
    const journalBlocking = await this.journalBlocking(snapshot)
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
    const stateErrorCount = this.stateErrors(snapshot).length
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
          hint: 'call novel_rollback to P3 and submit novel_write_draft again',
        },
        to_stage: 'P3',
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
  private async readBriefReceipts(store: FsStore): Promise<BriefReceiptsDocument> {
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

  private briefIsCurrent(snapshot: Snapshot, stage: BriefStage): boolean {
    const record = snapshot.briefs[stage]
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
      targets: snapshot.project.targets,
      facts: snapshot.worldbook.facts ?? [],
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
      pipeline: { ...snapshot.pipeline, briefs: snapshot.briefs },
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
        extras.draftTitle ?? snapshot.pipeline.draft?.title ?? snapshot.plan?.title ?? null,
        this.rulepack.format.title.pattern,
      ),
      sceneType: extras.sceneType ?? snapshot.pipeline.draft?.scene_type ?? snapshot.plan?.scene_type ?? null,
      summary: extras.summary ?? snapshot.pipeline.draft?.summary ?? snapshot.plan?.summary ?? null,
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
    const pipeline = (await store.readDoc(
      joinRel(STATE_DIR, STATE_FILES.pipeline),
      'pipeline',
    )) as unknown as PipelineState | null
    if (pipeline === null)
      throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, 'state/pipeline.yaml is missing')
    let briefs: PipelineState['briefs'] = pipeline.briefs
    const briefsRaw = await store.readText(BRIEF_RECEIPTS_FILE)
    if (briefsRaw !== null) {
      try {
        const parsed = parseYaml(briefsRaw) as Partial<BriefReceiptsDocument> | null
        if (parsed !== null && Array.isArray(parsed.receipts)) {
          const next: PipelineState['briefs'] = {}
          for (const receipt of parsed.receipts) {
            if (
              typeof receipt === 'object' &&
              receipt !== null &&
              Number.isInteger(receipt.chapter) &&
              typeof receipt.stage === 'string' &&
              typeof receipt.digest === 'string' &&
              typeof receipt.issued_at === 'string'
            ) {
              next[receipt.stage] = { digest: receipt.digest, issued_at: receipt.issued_at }
            }
          }
          briefs = next
        }
      } catch {
        // Receipts are evidence, not content. A damaged receipt file is treated
        // as missing so the model is asked for a fresh brief; the journal and
        // content gates remain fail-closed.
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
      pipeline: pipeline as unknown as PipelineState,
      briefs,
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
            files: [],
            status: 'aborted',
            reason: errorMessage(error),
            attempt: true,
            stage: snapshot.pipeline.stage,
            ...(error instanceof EngineError ? { code: error.code } : {}),
            ...(error instanceof EngineError && error.hint !== undefined ? { hint: error.hint } : {}),
            ...(error instanceof EngineBlockedError ? { blocking: error.blocking } : {}),
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

  private emptySnapshot(root: string, selection: Selection): Snapshot {
    return {
      root,
      selection,
      project: { ...ENGINE_PROJECT_INITIAL },
      projectError: null,
      pipeline: emptyPipeline({ revision: 1, chapter: 1, stage: 'idle' }),
      briefs: {},
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
    if (edit.occurrence === undefined && positions.length !== 1) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `patch.edits[${index}] matches ${positions.length} place(s); a unique old_text is required`,
        'include more surrounding text, or set occurrence explicitly',
      )
    }
    if (positions.length < expectedOccurrence) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `patch.edits[${index}].occurrence ${expectedOccurrence} exceeds ${positions.length} match(es)`,
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

const machineWarnings = (machine: MachineResult, acknowledged: readonly string[] = []): Warning[] =>
  machine.violations
    .filter((violation) => violation.severity === 'advisory' && !acknowledged.includes(violation.code))
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
