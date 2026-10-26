import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { parse as parseYaml, stringify } from 'yaml'
import {
  BACKUP_DIR,
  EXPORT_DIR,
  LOCK_FILE,
  PROJECT_FILE,
  STATE_DIR,
  STATE_FILES,
  chapterFile,
  checkFile,
  deprecatedChapterFile,
  planChapterFile,
  planWorldFile,
  reviewFile,
} from '../constants.js'
import { canRun, STAGE_NEXT, nextStage as computeNextStage } from '../domain/index.js'
import { textSimilarity } from '../domain/simhash.js'
import { splitParagraphs } from '../domain/text.js'
import { countWordMetrics } from '../domain/wordcount.js'
import { reviewArithmeticProblems, totalScore } from '../domain/scoring.js'
import { runMachineChecks, type MachineOptions, type MachineResult } from '../rules/pipeline.js'
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
import { KeyedMutex, FileLock } from '../store/lock.js'
import { appendJournal, assertJournalConsistent, readJournal, reconcileJournal } from '../store/journal.js'
import { listBackups } from '../store/backup.js'
import { narrow, type DocKind } from '../store/schema.js'
import { buildEpub } from '../export/epub.js'
import {
  renderBlurb,
  renderCover,
  renderMarkdown,
  renderPlainText,
  type ExportChapter,
} from '../export/render.js'
import { BriefLibrary } from './brief.js'
import { briefContext } from './context.js'
import { applyStateDelta } from './state-delta.js'
import { evaluateSemantic } from './semantic.js'
import { briefStageFor, evaluateGates, gateName } from './gates.js'
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
  EngineBlockedError,
  EngineFaultError,
  EngineInputError,
  type AuditRow,
  type ArchiveHandoff,
  type BlockingItem,
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
  type StatusReport,
  type Warning,
  type WordMetrics,
  type WorldPlanInput,
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
  /** The four P6 semantic items; omission is a failed check, never a pass. */
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
  chapter: number
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
  root?: string
}

export interface WordCountInput {
  text?: string
  chapter?: number
  root?: string
}

interface Snapshot {
  root: string
  project: NovelProject
  pipeline: PipelineState
  chapters: ChaptersDocument
  characters: import('../types.js').CharactersDocument
  world: import('../types.js').WorldDocument
  locks: import('../types.js').LocksDocument
  timeline: import('../types.js').TimelineDocument
  foreshadows: import('../types.js').ForeshadowsDocument
  relationships: import('../types.js').RelationshipsDocument
  handoff: import('../types.js').HandoffDocument | null
  text: string | null
  previousText: string | null
  previousTexts: string[]
  plan: (ChapterPlanInput & { summary?: ChapterSummary }) | null
  review: ReviewDocument | null
  check: CheckDocument | null
}

const ROUND_TRANSITIONS: Record<RollbackSubmission['toStage'], Stage> = {
  P1: 'idle',
  P2: 'P2',
  P3: 'P3',
  P4: 'P4',
  P5: 'P5',
  P6: 'P6',
}

const MUTABLE_STATE: Record<string, DocKind> = {
  [joinRel(STATE_DIR, STATE_FILES.pipeline)]: 'pipeline',
  [joinRel(STATE_DIR, STATE_FILES.chapters)]: 'chapters',
  [joinRel(STATE_DIR, STATE_FILES.characters)]: 'characters',
  [joinRel(STATE_DIR, STATE_FILES.world)]: 'world',
  [joinRel(STATE_DIR, STATE_FILES.locks)]: 'locks',
  [joinRel(STATE_DIR, STATE_FILES.timeline)]: 'timeline',
  [joinRel(STATE_DIR, STATE_FILES.foreshadows)]: 'foreshadows',
  [joinRel(STATE_DIR, STATE_FILES.relationships)]: 'relationships',
  [joinRel(STATE_DIR, STATE_FILES.handoff)]: 'handoff',
}

/**
 * The single write authority. Tools, commands, the panel and task books never
 * touch a file; every mutation is one of these operations.
 */
export class EngineService {
  private readonly stores = new Map<string, FsStore>()
  private readonly mutex = new KeyedMutex()
  private readonly replay = new Map<string, OpResult<unknown>>()
  private readonly briefs: BriefLibrary
  private readonly now: () => Date

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
      const [min, max] = input.words_per_chapter
      if (
        input.words_per_chapter.length !== 2 ||
        !Number.isInteger(min) ||
        !Number.isInteger(max) ||
        min <= 0 ||
        max < min
      ) {
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
      const [min, max] = input.dialogue_ratio
      if (
        input.dialogue_ratio.length !== 2 ||
        !Number.isFinite(min) ||
        !Number.isFinite(max) ||
        min < 0 ||
        max > 1 ||
        max < min
      ) {
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
        const files: StagedFile[] = [
          { path: PROJECT_FILE, text: yaml(project) },
          { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(pipeline) },
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

  /* --------------------------------------------------------------- queries */

  async getStatus(input: StatusInput = {}): Promise<OpResult<StatusReport>> {
    const snapshot = await this.load(input.root)
    const chapter = input.chapter ?? snapshot.pipeline.chapter
    const metrics = await this.metricsFor(snapshot, chapter)
    const next = this.nextStep(snapshot)
    const report: StatusReport = {
      project: {
        title: snapshot.project.title,
        genre: snapshot.project.genre,
        platform: snapshot.project.platform,
        root: snapshot.root,
      },
      chapter,
      stage: snapshot.pipeline.stage,
      rounds: { ...snapshot.pipeline.rounds },
      blocking: snapshot.pipeline.blocking,
      metrics,
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
    const snapshot = await this.load(input.root)
    const text =
      (input.chapter === undefined ? snapshot.text : await this.readChapter(snapshot, input.chapter)) ?? ''
    return { data: countWordMetrics(text), revision: snapshot.pipeline.revision, warnings: [] }
  }

  async queryState(input: StateQueryInput): Promise<OpResult<unknown>> {
    const snapshot = await this.load(input.root)
    const chapter = input.chapter ?? snapshot.pipeline.chapter
    const store = this.storeFor(input.root)
    switch (input.kind) {
      case 'pipeline':
        return { data: snapshot.pipeline, revision: snapshot.pipeline.revision, warnings: [] }
      case 'chapters':
        return { data: snapshot.chapters, revision: snapshot.pipeline.revision, warnings: [] }
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
      case 'review':
        return { data: snapshot.review, revision: snapshot.pipeline.revision, warnings: [] }
      case 'check':
        return { data: snapshot.check, revision: snapshot.pipeline.revision, warnings: [] }
      case 'novel':
        return { data: snapshot.project, revision: snapshot.pipeline.revision, warnings: [] }
      case 'planWorld': {
        const raw = await store.readText(planWorldFile(chapter))
        return {
          data: raw === null ? null : parseYamlLoose(raw),
          revision: snapshot.pipeline.revision,
          warnings: [],
        }
      }
      case 'planChapter': {
        const raw = await store.readText(planChapterFile(chapter))
        return {
          data: raw === null ? null : parseYamlLoose(raw),
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
    }>
  > {
    const snapshot = await this.load(input.root)
    const next = this.nextStep(snapshot)
    return {
      data: {
        stage: snapshot.pipeline.stage,
        chapter: snapshot.pipeline.chapter,
        tool: next.tool,
        args: next.args,
        reason: next.reason,
        blocking: snapshot.pipeline.blocking,
      },
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
    const snapshot = await this.load(input.root)
    const chapter = input.chapter ?? snapshot.pipeline.chapter
    const context = this.briefContextFor(input.stage, snapshot, chapter)
    const digest = this.briefDigest(input.stage, snapshot, context)
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
      next_tool: NEXT_TOOL_BY_BRIEF[input.stage],
    }
    const existing = snapshot.pipeline.briefs[input.stage]
    if (existing !== undefined && existing.digest === digest) {
      return {
        data: {
          stage: input.stage,
          chapter,
          digest,
          title: rendered.title,
          content: rendered.content,
          content_hash: rendered.contentHash,
          fields,
          context,
        },
        revision: snapshot.pipeline.revision,
        warnings: [],
      }
    }
    return this.mutate({
      root: input.root,
      op: 'getBrief',
      run: async (fresh, ctx) => {
        const nextPipeline = pipelineWith(fresh, ctx.revision, {
          briefs: {
            ...fresh.pipeline.briefs,
            [input.stage]: { issued_at: this.now().toISOString(), digest },
          },
          last_action: action('novel_brief', this.now(), digest),
        })
        return {
          files: [{ path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) }],
          backup: false,
          data: {
            stage: input.stage,
            chapter,
            digest,
            title: rendered.title,
            content: rendered.content,
            content_hash: rendered.contentHash,
            fields,
            context,
          },
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
    return this.mutate({
      root: input.root,
      op: 'submitWorldPlan',
      key: (snapshot) => `world:${snapshot.pipeline.chapter}:${sha256(stableJson(input))}`,
      run: async (snapshot, context) => {
        await this.assertGates(snapshot, 'submitWorldPlan', { briefStage: 'P1' })
        const chapter = snapshot.pipeline.chapter
        const plan: WorldPlanInput = {
          chapter,
          objective: input.objective,
          constraints: input.constraints,
          characters: input.characters,
          locations: input.locations,
          continuity_notes: input.continuity_notes,
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
    if (!(SCENE_TYPES as readonly string[]).includes(input.scene_type)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `unknown scene_type "${String(input.scene_type)}"`,
        `allowed: ${SCENE_TYPES.join(', ')}`,
      )
    }
    const [min, max] = input.target_words
    if (
      input.target_words.length !== 2 ||
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min <= 0 ||
      max < min
    ) {
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
        await this.assertGates(snapshot, 'submitChapterPlan', { briefStage: 'P2' })
        const chapter = snapshot.pipeline.chapter
        const path = planChapterFile(chapter)
        const plan = { ...input, chapter, schema_version: 1 as const }
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
      key: () => `draft:${input.chapter}:${sha256(input.content)}`,
      run: async (snapshot, context) => {
        this.assertChapter(snapshot, input.chapter)
        await this.assertGates(snapshot, 'submitDraft', {
          briefStage: 'P3',
          text: input.content,
          summary: input.summary,
          draftTitle: input.chapter_title,
          sceneType: input.scene_type,
        })
        const machine = this.machine(snapshot, input.content, {
          title: input.chapter_title,
          sceneType: input.scene_type,
          summary: input.summary,
        })
        const chapter = input.chapter
        const planPath = planChapterFile(chapter)
        const planText = await context.store.readText(planPath)
        const plan = planText === null ? null : (parseYamlLoose(planText) as Record<string, unknown>)
        const mergedPlan = {
          ...(plan ?? { schema_version: 1, chapter }),
          title: input.chapter_title,
          scene_type: input.scene_type,
          narrator: input.narrator,
          summary: input.summary,
        }
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
        const review: ReviewDocument = {
          schema_version: 1,
          chapter: input.chapter,
          round: snapshot.pipeline.rounds.review + 1,
          content_hash: sha256(text),
          dimensions: excluded.dimensions,
          issues: input.issues,
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
        const openBlockers = input.issues.filter(
          (issue) => issue.severity === 'blocker' && issue.status !== 'fixed',
        ).length
        const next = computeNextStage(snapshot.pipeline.stage, 'submitReview', openBlockers)
        const blocking: BlockingItem[] = input.issues
          .filter((issue) => issue.severity === 'blocker' && issue.status !== 'fixed')
          .map((issue) => ({
            code: `ISSUE-${issue.id}`,
            scope: issue.dimension,
            detail: `${issue.problem} → ${issue.fix}`,
            hint: issue.location,
          }))
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          stage: next,
          rounds: { ...snapshot.pipeline.rounds, review: snapshot.pipeline.rounds.review + 1 },
          blocking,
          last_action: action('novel_review', this.now(), sha256(stableJson(review))),
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
        const patchedReview =
          snapshot.review === null
            ? null
            : {
                ...snapshot.review,
                content_hash: sha256(input.content),
                issues: input.issues ?? snapshot.review.issues,
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
          const firstTwo = splitParagraphs(input.content).slice(0, 2)
          if (!firstTwo.some((paragraph) => paragraph.includes(opening))) {
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
          last_action: action('novel_revise', this.now(), sha256(input.content)),
        })
        const planPath = planChapterFile(input.chapter)
        const planText = await context.store.readText(planPath)
        const plan = planText === null ? null : (parseYamlLoose(planText) as Record<string, unknown>)
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
    return this.mutate({
      root: input.root,
      op: 'runCheck',
      key: (snapshot) =>
        `check:${input.chapter}:${sha256(snapshot.text ?? '')}:${sha256(stableJson(input.semantic ?? []))}`,
      run: async (snapshot, context) => {
        this.assertChapter(snapshot, input.chapter)
        const text = snapshot.text ?? ''
        const semantic = Array.isArray(input.semantic) ? input.semantic : []
        await this.assertGates(snapshot, 'runCheck', {
          briefStage: 'P6',
          text,
          proof: snapshot.review?.proof ?? null,
          semantic,
        })
        const machine = this.machine(snapshot, text, { summary: snapshot.plan?.summary ?? null })
        const machineBlocking = machine.violations.filter((violation) => violation.severity === 'blocker')
        const semanticResult = evaluateSemantic(text, semantic)
        const blocking = machineBlocking.length
        const verdict: 'pass' | 'fail' = blocking === 0 && !semanticResult.failed ? 'pass' : 'fail'
        const check: CheckDocument = {
          schema_version: 1,
          chapter: input.chapter,
          scope: input.scope ?? ['content', 'integrity'],
          content_hash: sha256(text),
          machine: { violations: machine.violations, metrics: machine.metrics },
          semantic: { items: semantic },
          verdict,
        }
        const nextStage: Stage = verdict === 'pass' ? 'ready_to_archive' : 'P6'
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
          rounds: { ...snapshot.pipeline.rounds, check: snapshot.pipeline.rounds.check + 1 },
          blocking: blockingItems,
          last_action: action('novel_check', this.now(), sha256(text)),
        })
        return {
          files: [
            { path: checkFile(input.chapter), text: yaml(check) },
            { path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) },
          ],
          data: {
            chapter: input.chapter,
            verdict,
            violations: machine.violations.length,
            metrics: machine.metrics,
            stage: nextStage,
          },
          warnings: machineWarnings(machine),
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
    return this.mutate({
      root: input.root,
      op: 'archiveChapter',
      key: (snapshot) => {
        // After the first archive the chapter file is indexed and the active
        // manuscript is gone. Bind the replay key to the indexed content hash so
        // a duplicate call is idempotent instead of a stage-order failure.
        const archived = snapshot.chapters.chapters.find((record) => record.num === input.chapter)
        return `archive:${input.chapter}:${archived?.content_hash ?? sha256(snapshot.text ?? '')}`
      },
      run: async (snapshot, context) => {
        this.assertChapter(snapshot, input.chapter)
        const text = snapshot.text ?? ''
        const summary = snapshot.plan?.summary
        if (summary === undefined) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            'the draft has no summary; resubmit the draft with a summary',
            'call novel_write_draft with the full summary block',
          )
        }
        await this.assertGates(snapshot, 'archiveChapter', {
          briefStage: 'P8',
          text,
          summary,
          review: snapshot.review,
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
        // cannot bypass the four P6 checks at the last write boundary.
        const archivedSemantic = evaluateSemantic(text, snapshot.check?.semantic.items ?? [])
        if (archivedSemantic.failed) {
          throw new EngineBlockedError(
            ERROR_CODES.GATE_BLOCKED,
            `archiveChapter blocked by ${archivedSemantic.blocking.length} semantic finding(s), first: ${archivedSemantic.blocking[0]!.code}`,
            archivedSemantic.blocking.map((item) => ({ ...item, scope: 'archive' })),
            're-run novel_check with the four evidence-backed semantic items',
          )
        }
        const metrics = countWordMetrics(text)
        const score = snapshot.review?.total ?? 0
        const chapter = input.chapter
        const storedTitle = (snapshot.plan?.title ?? '').replace(/^第\s*\d+\s*章\s*/, '').trim()
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

        const totalChapters = snapshot.project.targets.total_chapters
        const derivedVolume = Math.max(1, Math.ceil(chapter / 20))
        const handoff = {
          schema_version: 1 as const,
          current_chapter: chapter,
          volume: input.handoff?.volume ?? derivedVolume,
          volume_name: input.handoff?.volume_name ?? `第${derivedVolume}卷`,
          act: input.handoff?.act ?? `第${Math.max(1, Math.ceil(((chapter - 1) % 20) / 5) + 1)}幕`,
          act_progress:
            input.handoff?.act_progress ??
            (totalChapters === null ? `进至第${chapter}章` : `${chapter}/${totalChapters}`),
          next_chapter: chapter + 1,
          last_summary: summary.events.join('；').slice(0, 200),
          open_hooks: foreshadows.items
            .filter((item) => item.status !== 'resolved')
            .slice(-5)
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
    const store = this.storeFor(input.root)
    const absolute = store.path(input.path)
    const kind = MUTABLE_STATE[input.path]
    if (kind === undefined || absolute.length === 0) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `amend can only target state documents: ${Object.keys(MUTABLE_STATE).join(', ')}`,
        'edit novel content through the draft/revision tools, not amend',
      )
    }
    return this.mutate({
      root: input.root,
      op: 'amend',
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
        const document = narrow(kind, { ...input.content, schema_version: input.content.schema_version ?? 1 })
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
    const snapshot = await this.load(input.root)
    if (!Number.isInteger(input.chapter) || input.chapter < 1) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `chapter must be a positive integer (got ${String(input.chapter)})`,
      )
    }
    const store = this.storeFor(input.root)
    const after = input.after ?? (await this.readChapter(snapshot, input.chapter)) ?? ''
    const before = input.before ?? (await this.latestBackup(store, chapterFile(input.chapter))) ?? ''
    const report = diffLines(before, after)
    return {
      data: {
        chapter: input.chapter,
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
    const store = this.storeFor(input.root)
    const { rows, malformed } = await readJournal(store)
    const health = await reconcileJournal(store)
    const warnings: Warning[] = []
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
    if (input.kind !== 'md' && input.kind !== 'txt' && input.kind !== 'epub') {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `unknown export kind "${String(input.kind)}"`,
        'allowed: md, txt, epub',
      )
    }
    if (input.chapter !== undefined && (!Number.isInteger(input.chapter) || input.chapter < 1)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'chapter must be a positive integer')
    }
    return this.mutate({
      root: input.root,
      op: 'export',
      // Export itself advances the revision, so the cache key must bind to the
      // content that was exported, not to a revision this operation is about to
      // change. Otherwise a later revision keeps returning the old file.
      key: (snapshot) =>
        `export:${input.kind}:${input.chapter ?? 'all'}:${sha256(
          stableJson({
            text: sha256(snapshot.text ?? ''),
            chapters: snapshot.chapters.chapters.map((chapter) => chapter.content_hash),
            title: snapshot.project.title,
          }),
        )}`,
      run: async (snapshot, context) => {
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
        const nextPipeline = pipelineWith(snapshot, context.revision, {
          last_action: action('novel_export', this.now(), input.kind),
        })
        files.push({ path: joinRel(STATE_DIR, STATE_FILES.pipeline), text: yaml(nextPipeline) })
        return {
          files,
          backup: false,
          data: { kind: input.kind, files: [base, cover, blurb] },
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
  }> {
    const snapshot = await this.load(input.root)
    const totalWords = snapshot.chapters.chapters.reduce((total, chapter) => total + chapter.word_count, 0)
    const scores = snapshot.chapters.chapters.map((chapter) => chapter.score)
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
    return { active: document.active }
  }

  /** Forget a registry row; the project directory is never touched. */
  async forgetProject(input: {
    root: string
  }): Promise<{ active: string | null; projects: RegistryEntry[] }> {
    const document = await this.registry().forget(resolve(input.root))
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
    const path = joinRel(STATE_DIR, STATE_FILES[input.kind])
    const result = await this.mutate({
      root: input.root,
      op: 'amend',
      key: () => `import:${input.kind}:${sha256(stableJson(input.content))}`,
      run: async (fresh, context) => {
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

  private async panelSnapshot(root?: string): Promise<PanelSnapshot> {
    const snapshot = await this.load(root)
    const archived = snapshot.chapters.chapters
    const archivedCurrent = archived.some((chapter) => chapter.num === snapshot.pipeline.chapter)
    const draftWords = snapshot.text === null ? 0 : countWordMetrics(snapshot.text).total_word_count
    const draft =
      archivedCurrent || snapshot.pipeline.stage === 'done'
        ? null
        : {
            num: snapshot.pipeline.chapter,
            title:
              (snapshot.plan?.title ?? '').replace(/^第\s*\d+\s*章\s*/, '').trim() ||
              `第${snapshot.pipeline.chapter}章`,
            wordCount: draftWords,
            score: snapshot.review?.total ?? 0,
            status: (snapshot.pipeline.blocking.length > 0 ? 'blocked' : 'draft') as 'blocked' | 'draft',
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
      blocking: snapshot.pipeline.blocking,
      next: this.nextStep(snapshot),
      chapters: archived,
      draft,
      totalWords:
        archived.reduce((total, chapter) => total + chapter.word_count, 0) +
        (draft === null ? 0 : draft.wordCount),
      phases: phaseStrip(snapshot.pipeline.stage),
    }
  }

  private nextStep(snapshot: Snapshot): StatusReport['next'] {
    if (snapshot.pipeline.blocking.length > 0) {
      const first = snapshot.pipeline.blocking[0]!
      return {
        tool: 'novel_status',
        args: {},
        reason: `${first.code}: ${first.detail}${first.hint === undefined ? '' : ` (${first.hint})`}`,
      }
    }
    const step = STAGE_NEXT[snapshot.pipeline.stage]
    return { tool: step.tool, args: { chapter: snapshot.pipeline.chapter }, reason: step.reason }
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

  private async latestBackup(store: FsStore, path: string): Promise<string | null> {
    for (const entry of await listBackups(store)) {
      const text = await store.readText(joinRel(BACKUP_DIR, entry.name, path))
      if (text !== null) return text
    }
    return null
  }

  private async chaptersForExport(snapshot: Snapshot, chapter?: number): Promise<ExportChapter[]> {
    const records = snapshot.chapters.chapters
    if (chapter !== undefined && !records.some((record) => record.num === chapter)) {
      throw new EngineInputError(
        ERROR_CODES.STAGE_ORDER,
        `chapter ${chapter} is not in the archive index`,
        'archive the chapter first, or export all archived chapters',
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
    if (chapters.length === 0 && snapshot.text !== null && chapter === undefined) {
      chapters.push({
        num: snapshot.pipeline.chapter,
        title: snapshot.plan?.title ?? '未命名',
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
      title: composeTitle(snapshot.pipeline.chapter, extra.title ?? snapshot.plan?.title ?? null),
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
    const machine =
      ['P4', 'P5', 'P6'].includes(stage) && snapshot.text !== null
        ? this.machine(snapshot, snapshot.text, { summary: snapshot.plan?.summary ?? null })
        : undefined
    return briefContext({
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
      plan: snapshot.plan,
      review: snapshot.review,
      check: snapshot.check,
      text: snapshot.text,
      machine,
      previousText: snapshot.previousText,
      handoff: snapshot.handoff,
    })
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
      min_words: snapshot.project.targets.words_per_chapter[0],
      max_words: snapshot.project.targets.words_per_chapter[1],
      min_score: this.config.quality.minScore,
      round: snapshot.pipeline.rounds.review + 1,
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
      >
    >,
  ): Promise<void> {
    const text = extras.text ?? snapshot.text ?? ''
    if (!canRun(snapshot.pipeline.stage, operation)) {
      throw new EngineInputError(
        ERROR_CODES.STAGE_ORDER,
        `${operation} is not allowed at stage ${snapshot.pipeline.stage}`,
        'call novel_status to see the next legal step',
      )
    }
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
    const input: GateInput = {
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
      draftTitle: composeTitle(snapshot.pipeline.chapter, extras.draftTitle ?? snapshot.plan?.title ?? null),
      sceneType: extras.sceneType ?? snapshot.plan?.scene_type ?? null,
      summary: extras.summary ?? snapshot.plan?.summary ?? null,
      summaryProvided: extras.summaryProvided,
      review: extras.review ?? snapshot.review,
      check: extras.check ?? snapshot.check,
      semantic: extras.semantic ?? [],
      proof: extras.proof ?? null,
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
    }
    const result = evaluateGates(input, { rulepack: this.rulepack, minScore: this.config.quality.minScore })
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

  private assertChapter(snapshot: Snapshot, chapter: number): void {
    if (!Number.isInteger(chapter) || chapter < 1) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `chapter must be a positive integer (got ${String(chapter)})`,
      )
    }
    if (chapter !== snapshot.pipeline.chapter) {
      throw new EngineInputError(
        ERROR_CODES.STAGE_ORDER,
        `chapter ${chapter} is not the active chapter (${snapshot.pipeline.chapter})`,
        'archive the active chapter before starting the next one',
      )
    }
  }

  private async load(root?: string): Promise<Snapshot> {
    const store = this.storeFor(root)
    if (!(await store.exists(PROJECT_FILE))) {
      throw new EngineInputError(
        ERROR_CODES.PROJECT_NOT_FOUND,
        `no novel project at ${store.root}`,
        'call novel_init to create one, or pass the correct project root',
      )
    }
    const project = await store.readDoc(PROJECT_FILE, 'project')
    if (project === null)
      throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, `${PROJECT_FILE} disappeared mid-read`)
    const pipeline = (await store.readDoc(
      joinRel(STATE_DIR, STATE_FILES.pipeline),
      'pipeline',
    )) as unknown as PipelineState | null
    if (pipeline === null)
      throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, 'state/pipeline.yaml is missing')
    const chapters =
      (await store.readDoc(joinRel(STATE_DIR, STATE_FILES.chapters), 'chapters')) ?? emptyChapters()
    const characters =
      (await store.readDoc(joinRel(STATE_DIR, STATE_FILES.characters), 'characters')) ?? emptyCharacters()
    const world = (await store.readDoc(joinRel(STATE_DIR, STATE_FILES.world), 'world')) ?? emptyWorld()
    const locks = (await store.readDoc(joinRel(STATE_DIR, STATE_FILES.locks), 'locks')) ?? {
      schema_version: 1 as const,
      locked_at_chapter: 0,
      characters: {},
      locations: {},
    }
    const timeline = (await store.readDoc(joinRel(STATE_DIR, STATE_FILES.timeline), 'timeline')) ?? {
      schema_version: 1 as const,
      next_seq: 1,
      items: [],
    }
    const foreshadows = (await store.readDoc(joinRel(STATE_DIR, STATE_FILES.foreshadows), 'foreshadows')) ?? {
      schema_version: 1 as const,
      next_seq: 1,
      items: [],
    }
    const relationships = (await store.readDoc(
      joinRel(STATE_DIR, STATE_FILES.relationships),
      'relationships',
    )) ?? { schema_version: 1 as const, next_seq: 1, items: [] }
    const handoff = (await store.readDoc(
      joinRel(STATE_DIR, STATE_FILES.handoff),
      'handoff',
    )) as unknown as HandoffDocument | null
    const chapter = pipeline.chapter
    const text = await store.readText(chapterFile(chapter))
    const previousText = chapter > 1 ? await store.readText(chapterFile(chapter - 1)) : null
    const previousTexts: string[] = []
    for (let offset = 1; offset <= 3 && chapter - offset >= 1; offset += 1) {
      const previous = await store.readText(chapterFile(chapter - offset))
      if (previous !== null) previousTexts.push(previous)
    }
    const planRaw = await store.readText(planChapterFile(chapter))
    const plan =
      planRaw === null ? null : (parseYamlLoose(planRaw) as ChapterPlanInput & { summary?: ChapterSummary })
    const review = (await store.readDoc(reviewFile(chapter), 'review')) as unknown as ReviewDocument | null
    const check = (await store.readDoc(checkFile(chapter), 'check')) as unknown as CheckDocument | null
    return {
      root: store.root,
      project: project as unknown as NovelProject,
      pipeline: pipeline as unknown as PipelineState,
      chapters: chapters as unknown as ChaptersDocument,
      characters: characters as unknown as Snapshot['characters'],
      world: world as unknown as Snapshot['world'],
      locks: locks as unknown as Snapshot['locks'],
      timeline: timeline as unknown as Snapshot['timeline'],
      foreshadows: foreshadows as unknown as Snapshot['foreshadows'],
      relationships: relationships as unknown as Snapshot['relationships'],
      handoff,
      text,
      previousText,
      previousTexts,
      plan,
      review,
      check,
    }
  }

  private async mutate<T>(options: {
    root?: string
    op: Operation
    key?: (snapshot: Snapshot) => string
    emptyAllowed?: boolean
    run: (
      snapshot: Snapshot,
      context: { store: FsStore; revision: number },
    ) => Promise<{
      files: StagedFile[]
      data: T
      backup?: boolean
      event?: EngineEvent
      warnings?: Warning[]
    }>
  }): Promise<OpResult<T>> {
    const root = resolve(options.root ?? this.config.projectRoot)
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
      const lock = new FileLock(join(root, LOCK_FILE), undefined, undefined, async (record) => {
        await appendJournal(store, {
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
        })
      })
      await lock.acquire()
      try {
        if (options.emptyAllowed === true) {
          const exists = await store.exists(PROJECT_FILE)
          if (!exists) {
            const created = await options.run(this.emptySnapshot(root), { store, revision: 1 })
            await runTransaction(store, {
              txid: randomUUID(),
              op: options.op,
              chapter: 1,
              revision: 1,
              files: created.files,
              backup: false,
              signal,
            })
            this.replay.clear()
            return { data: created.data, revision: 1, warnings: created.warnings ?? [] }
          }
        }
        // The snapshot must be read while holding the cross-process lock;
        // otherwise a second process can commit between read and write and the
        // later writer silently overwrites it with a stale revision.
        await assertJournalConsistent(store)
        const snapshot = await this.load(root)
        const key = options.key?.(snapshot)
        if (key !== undefined) {
          const cached = this.replay.get(`${root}|${options.op}|${key}`)
          if (cached !== undefined) return { ...(cached as OpResult<T>), replayed: true }
        }
        const revision = snapshot.pipeline.revision + 1
        abortIfNeeded()
        const outcome = await options.run(snapshot, { store, revision })
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
      pipeline: emptyPipeline({ revision: 1, chapter: 1, stage: 'idle' }),
      chapters: emptyChapters(),
      characters: emptyCharacters(),
      world: emptyWorld(),
      locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
      handoff: null,
      text: null,
      previousText: null,
      previousTexts: [],
      plan: null,
      review: null,
      check: null,
    }
  }
}

/* ------------------------------------------------------------------ helpers */

const NEXT_TOOL_BY_BRIEF: Record<import('../types.js').BriefStage, string> = {
  P1: 'novel_plan_world',
  P2: 'novel_plan_chapter',
  P3: 'novel_write_draft',
  P4: 'novel_review',
  P5: 'novel_revise',
  P6: 'novel_check',
  P8: 'novel_archive',
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
  last_action: snapshot.pipeline.last_action,
  ...patch,
})

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

/** Titles are stored as bodies; the format rule judges the rendered heading. */
const composeTitle = (chapter: number, title: string | null): string | null => {
  if (title === null) return null
  return /^第\s*\d+\s*章/.test(title) ? title : `第${chapter}章 ${title}`
}

const stableJson = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (typeof input === 'object' && input !== null) {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, value]) => value !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, normalize(value)]),
      )
    }
    return input
  }
  return JSON.stringify(normalize(value))
}

const parseYamlLoose = (text: string): unknown => parseYaml(text)

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
