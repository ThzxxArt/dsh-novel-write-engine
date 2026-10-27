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
  /** Set when the review file exists but cannot be parsed; exposed for repair. */
  review_error?: string | null
  check: CheckDocument | null
  /** Set when the check file exists but cannot be parsed; exposed for repair. */
  check_error?: string | null
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
function unbudgetedBriefContext(input: BriefContextInput): Record<string, unknown> {
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
    ...(input.review_error === undefined || input.review_error === null
      ? {}
      : { review_error: input.review_error }),
    ...(input.check_error === undefined || input.check_error === null
      ? {}
      : { check_error: input.check_error }),
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
        plan: input.plan,
        machine: input.machine ?? null,
        characters: input.characters.characters,
        check: input.check,
        score_history: input.chapters.chapters.slice(-5).map((row) => ({ num: row.num, score: row.score })),
      }
    case 'P5':
      return {
        ...base,
        text: input.text ?? '',
        plan: input.plan,
        machine: input.machine ?? null,
        review: input.review,
        issues: input.review?.issues ?? [],
      }
    case 'P6':
      return {
        ...base,
        text: input.text ?? '',
        plan: input.plan,
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
        plan: input.plan,
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

/** Per-stage context budgets, measured in JSON characters (metadata excluded). */
export const CONTEXT_BUDGETS: Readonly<Record<string, number>> = {
  P1: 6_000,
  P2: 8_000,
  P3: 16_000,
  P4: 24_000,
  P5: 24_000,
  P6: 32_000,
  P8: 12_000,
}

interface ContextMeta {
  version: 1
  stage: string
  budget: number
  used: number
  over_budget: boolean
  protected: string[]
  truncated: string[]
  omitted: Record<string, number>
  strategy: 'stage-v1'
}

type MutableRecord = Record<string, unknown>

const asRecord = (value: unknown): MutableRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as MutableRecord) : null

const asArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null)

const jsonSize = (value: unknown): number => Array.from(JSON.stringify(value)).length

const mentionScore = (mentioned: string, value: string): number =>
  value !== '' && mentioned.includes(value) ? 1 : 0

/**
 * Apply the stage budget after the stage-specific pack exists. Protected keys
 * are never candidates; optional ledgers are trimmed round-robin so one large
 * list cannot starve every other kind of context.
 */
function withContextBudget(stage: string, raw: Record<string, unknown>): Record<string, unknown> {
  const context = structuredClone(raw)
  const budget = CONTEXT_BUDGETS[stage] ?? 8_000
  const protectedKeys = [
    'project',
    'chapter',
    'stage',
    'previous_ending',
    'text',
    'plan',
    'precheck',
    'review',
    'check',
    'machine',
    'summary',
  ]
  const mentioned = [
    typeof context.text === 'string' ? context.text : '',
    JSON.stringify(context.plan ?? ''),
    JSON.stringify(context.review ?? ''),
    JSON.stringify(context.check ?? ''),
    JSON.stringify(context.summary ?? ''),
  ].join('\n')
  const omitted: Record<string, number> = {}
  const truncated = new Set<string>()

  interface Candidate {
    key: string
    count: () => number
    trim: () => boolean
    prepare: () => void
  }

  const candidates: Candidate[] = []
  const stableKey = (value: unknown): string => {
    const row = asRecord(value)
    if (row === null) return JSON.stringify(value) ?? ''
    for (const key of ['id', 'name', 'title'] as const) {
      const item = row[key]
      if (typeof item === 'string' && item !== '') return item
    }
    return JSON.stringify(row)
  }
  const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
  const addArray = (
    key: string,
    array: () => unknown[] | null,
    rank: (value: unknown) => number,
    tie: (value: unknown) => string = stableKey,
  ): void => {
    let prepared = false
    const sort = (): void => {
      if (prepared) return
      prepared = true
      array()?.sort((left, right) => {
        const byRank = rank(right) - rank(left)
        return byRank !== 0 ? byRank : compareText(tie(left), tie(right))
      })
    }
    candidates.push({
      key,
      count: () => array()?.length ?? 0,
      trim: () => {
        sort()
        const list = array()
        if (list === null || list.length === 0) return false
        list.pop()
        return true
      },
      prepare: sort,
    })
  }
  const addObject = (
    key: string,
    map: () => MutableRecord | null,
    rank: (key: string, value: unknown) => number,
  ): void => {
    let keys: string[] | null = null
    const ensure = (): string[] => {
      const target = map()
      keys ??= target === null ? [] : Object.keys(target)
      keys.sort((left, right) => {
        const byRank = rank(right, map()?.[right]) - rank(left, map()?.[left])
        return byRank !== 0 ? byRank : compareText(left, right)
      })
      return keys
    }
    candidates.push({
      key,
      count: () => Object.keys(map() ?? {}).length,
      trim: () => {
        const target = map()
        if (target === null) return false
        const ordered = ensure()
        const keyToDelete = ordered.pop()
        if (keyToDelete === undefined || !Object.hasOwn(target, keyToDelete)) return false
        delete target[keyToDelete]
        return true
      },
      prepare: ensure,
    })
  }

  // Relevance is expressed as a number; recency and stable keys break ties.
  const chapter = (value: unknown): number => (asRecord(value)?.num as number | undefined) ?? 0
  addArray(
    'characters',
    () => asArray(context.characters),
    (value) => {
      const row = asRecord(value)
      const name = typeof row?.name === 'string' ? row.name : ''
      return mentionScore(mentioned, name) * 1_000 + Number(row?.first_appearance ?? 0)
    },
    (value) => {
      const row = asRecord(value)
      return typeof row?.name === 'string' ? row.name : stableKey(value)
    },
  )
  const world = asRecord(context.world)
  for (const key of ['locations', 'abilities', 'artifacts', 'factions', 'rules'] as const) {
    addArray(
      `world.${key}`,
      () => asArray(world?.[key]),
      (value) => {
        const row = asRecord(value)
        const name = typeof row?.name === 'string' ? row.name : ''
        return mentionScore(mentioned, name) * 1_000 + Number(row?.first_appearance ?? 0)
      },
      (value) => {
        const row = asRecord(value)
        return typeof row?.name === 'string' ? row.name : stableKey(value)
      },
    )
  }
  const locks = asRecord(context.locks)
  for (const key of ['characters', 'locations'] as const) {
    addObject(
      `locks.${key}`,
      () => asRecord(locks?.[key]),
      (name) => mentionScore(mentioned, name) * 1_000,
    )
  }
  addArray(
    'open_foreshadows',
    () => asArray(context.open_foreshadows),
    (value) => {
      const row = asRecord(value)
      const title = typeof row?.title === 'string' ? row.title : ''
      return mentionScore(mentioned, title) * 1_000 - Number(row?.last_touched ?? 0)
    },
    (value) => {
      const row = asRecord(value)
      return `${typeof row?.title === 'string' ? row.title : ''}\u0000${
        typeof row?.id === 'string' ? row.id : ''
      }`
    },
  )
  const foreshadows = asRecord(context.foreshadows)
  addArray(
    'foreshadows',
    () => asArray(foreshadows?.items),
    (value) => {
      const row = asRecord(value)
      const title = typeof row?.title === 'string' ? row.title : ''
      const id = typeof row?.id === 'string' ? row.id : ''
      return (
        Math.max(mentionScore(mentioned, title), mentionScore(mentioned, id)) * 1_000 -
        Number(row?.last_touched ?? 0)
      )
    },
    (value) => {
      const row = asRecord(value)
      return `${typeof row?.id === 'string' ? row.id : ''}\u0000${
        typeof row?.title === 'string' ? row.title : ''
      }`
    },
  )
  addArray(
    'timeline',
    () => asArray(context.timeline),
    (value) => {
      const row = asRecord(value)
      const text = `${String(row?.description ?? '')}${String(row?.location ?? '')}`
      return mentionScore(mentioned, text) * 1_000 + Number(row?.chapter ?? 0)
    },
    (value) => {
      const row = asRecord(value)
      return `${typeof row?.id === 'string' ? row.id : ''}\u0000${String(row?.chapter ?? '')}`
    },
  )
  const relationships = asRecord(context.relationships)
  addArray(
    'relationships',
    () => asArray(relationships?.items),
    (value) => {
      const row = asRecord(value)
      const text = `${String(row?.a ?? '')}${String(row?.b ?? '')}`
      return mentionScore(mentioned, text) * 1_000 + Number(row?.since ?? 0)
    },
    (value) => {
      const row = asRecord(value)
      return `${typeof row?.id === 'string' ? row.id : ''}\u0000${String(row?.a ?? '')}\u0000${String(
        row?.b ?? '',
      )}`
    },
  )
  addArray(
    'recent_summaries',
    () => asArray(context.recent_summaries),
    (value) => chapter(value),
    (value) => String(chapter(value)).padStart(8, '0'),
  )
  addArray(
    'score_history',
    () => asArray(context.score_history),
    (value) => Number(asRecord(value)?.num ?? 0),
    (value) => String(Number(asRecord(value)?.num ?? 0)).padStart(8, '0'),
  )

  // Sort every candidate even when the pack already fits, so a ledger's input
  // order cannot leak into the brief digest. The budget pass then works on a
  // deterministic order and equal-priority items have a stable tie-break.
  for (const candidate of candidates) candidate.prepare()

  const used = (): number => {
    const measure = { ...context }
    delete measure.context_meta
    return jsonSize(measure)
  }
  const buildMeta = (finalUsed: number): ContextMeta => ({
    version: 1,
    stage,
    budget,
    used: finalUsed,
    over_budget: false,
    protected: protectedKeys,
    truncated: [...truncated].sort(),
    omitted: Object.fromEntries(Object.entries(omitted).sort(([left], [right]) => left.localeCompare(right))),
    strategy: 'stage-v1',
  })
  // Measure the real document, including the `"context_meta":` key and the
  // comma that joins it. Adding jsonSize(meta) to the content size alone is a
  // few bytes short and can overshoot the advertised budget at the boundary.
  const totalWith = (finalUsed: number, meta: ContextMeta): number =>
    jsonSize({ ...context, context_meta: { ...meta, used: finalUsed } })

  // Round-robin: one item from every candidate per pass, so P6 does not spend
  // the whole budget on characters before noticing the timeline. The metadata
  // itself is measured in the loop: its omitted/truncated lists grow as we trim.
  let finalUsed = used()
  let metaBase = buildMeta(finalUsed)
  while (totalWith(finalUsed, metaBase) > budget) {
    let changed = false
    for (const candidate of candidates) {
      finalUsed = used()
      metaBase = buildMeta(finalUsed)
      if (totalWith(finalUsed, metaBase) <= budget) break
      if (candidate.count() === 0) continue
      candidate.prepare()
      if (candidate.trim()) {
        omitted[candidate.key] = (omitted[candidate.key] ?? 0) + 1
        truncated.add(candidate.key)
        changed = true
      }
    }
    finalUsed = used()
    metaBase = buildMeta(finalUsed)
    if (!changed) break
  }

  const overBudget = totalWith(finalUsed, metaBase) > budget
  const meta: ContextMeta = { ...metaBase, over_budget: overBudget }
  return { ...context, context_meta: meta }
}

/**
 * Build the stage-specific context pack plus the deterministic budget report.
 * The budget report is part of the brief digest; a truncated pack cannot be
 * silently mistaken for the full ledger set.
 */
export function briefContext(input: BriefContextInput): Record<string, unknown> {
  return withContextBudget(input.stage, unbudgetedBriefContext(input))
}
