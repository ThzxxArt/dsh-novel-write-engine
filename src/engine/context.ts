import type {
  ChapterPlanInput,
  ChapterSummary,
  ChaptersDocument,
  CharactersDocument,
  CheckDocument,
  ForeshadowsDocument,
  HandoffDocument,
  LocksDocument,
  NovelProject,
  PipelineState,
  RelationshipsDocument,
  ReviewDocument,
  TimelineDocument,
  WorldDocument,
} from '../types.js'

/** The slice of project state the task-book context pack may read. */
export interface BriefContextInput {
  stage: string
  chapter: number
  project: NovelProject
  pipeline: PipelineState
  chapters: ChaptersDocument
  characters: CharactersDocument
  world: WorldDocument
  locks: LocksDocument
  foreshadows: ForeshadowsDocument
  timeline: TimelineDocument
  relationships: RelationshipsDocument
  plan: (ChapterPlanInput & { summary?: ChapterSummary }) | null
  /** Set when the plan file exists but cannot be parsed; exposed for repair. */
  plan_error?: string | null
  review: ReviewDocument | null
  check: CheckDocument | null
  /** The active chapter manuscript; P4/P5 need it to judge and revise the real text. */
  text: string | null
  /** Fresh machine findings, so P4 is not asked to rediscover format defects. */
  machine?: unknown
  previousText: string | null
  handoff: HandoffDocument | null
}

const compactSummary = (row: ChaptersDocument['chapters'][number]): Record<string, unknown> => ({
  num: row.num,
  title: row.title,
  events: row.summary.events,
  characters_appeared: row.summary.characters_appeared,
  foreshadows: row.summary.foreshadows,
  continuity: row.summary.continuity,
  hook_strength: row.summary.hook_strength,
  plot_advancement: row.summary.plot_advancement,
})

const sceneDistribution = (chapters: ChaptersDocument): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const row of chapters.chapters.slice(-5)) {
    counts[row.scene_type] = (counts[row.scene_type] ?? 0) + 1
  }
  return counts
}

const pendingForeshadows = (ledger: ForeshadowsDocument): ForeshadowsDocument['items'] =>
  ledger.items.filter((item) => item.status !== 'resolved')

/**
 * Build the stage-specific context pack. The task book explains the rules; this
 * pack is the minimum project state the model needs to apply them without
 * guessing who exists, what was locked, or what the previous chapter ended on.
 */
export function briefContext(input: BriefContextInput): Record<string, unknown> {
  const previousEnding = input.previousText === null ? '' : input.previousText.trim().slice(-400)
  const base: Record<string, unknown> = {
    project: {
      title: input.project.title,
      genre: input.project.genre,
      platform: input.project.platform,
      targets: input.project.targets,
    },
    chapter: input.chapter,
    stage: input.pipeline.stage,
    scene_distribution: sceneDistribution(input.chapters),
    previous_ending: previousEnding,
    ...(input.plan_error === undefined || input.plan_error === null ? {} : { plan_error: input.plan_error }),
  }

  switch (input.stage) {
    case 'P1':
      return {
        ...base,
        recent_summaries: input.chapters.chapters.slice(-5).map(compactSummary),
        open_foreshadows: pendingForeshadows(input.foreshadows),
        volume: input.handoff?.volume ?? 1,
        volume_name: input.handoff?.volume_name ?? '',
        act: input.handoff?.act ?? '',
      }
    case 'P2':
      return {
        ...base,
        plan: input.plan,
        open_foreshadows: pendingForeshadows(input.foreshadows),
      }
    case 'P3':
      return {
        ...base,
        characters: input.characters.characters,
        locks: input.locks,
        precheck: input.plan,
        open_foreshadows: pendingForeshadows(input.foreshadows),
        recent_summaries: input.chapters.chapters.slice(-5).map(compactSummary),
      }
    case 'P4':
      return {
        ...base,
        text: input.text ?? '',
        summary: input.plan?.summary ?? null,
        machine: input.machine ?? null,
        characters: input.characters.characters,
        check: input.check,
        score_history: input.chapters.chapters.slice(-5).map((row) => ({ num: row.num, score: row.score })),
      }
    case 'P5':
      return {
        ...base,
        text: input.text ?? '',
        machine: input.machine ?? null,
        review: input.review,
        issues: input.review?.issues ?? [],
      }
    case 'P6':
      return {
        ...base,
        text: input.text ?? '',
        machine: input.machine ?? null,
        characters: input.characters.characters,
        world: input.world,
        locks: input.locks,
        foreshadows: input.foreshadows,
        timeline: input.timeline.items,
        relationships: input.relationships,
        check: input.check,
        review: input.review,
        summary: input.plan?.summary ?? null,
        score_history: input.chapters.chapters.slice(-5).map((row) => ({ num: row.num, score: row.score })),
      }
    case 'P8':
      return {
        ...base,
        check: input.check,
        review: input.review,
        summary: input.plan?.summary ?? null,
        open_foreshadows: pendingForeshadows(input.foreshadows),
        recent_summaries: input.chapters.chapters.slice(-5).map(compactSummary),
      }
    default:
      return base
  }
}
