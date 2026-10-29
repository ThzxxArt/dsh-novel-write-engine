import { LIMITS } from '../constants.js'
import { compareText, stableJson as stableStringify } from '../domain/stable.js'
import { bookBrief, emptyOutline, emptyWorldbook, outlineCard, worldbookBrief } from './book.js'
import { projectHandoff } from './handoff.js'
import type {
  ChapterCastMember,
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
  WorldPlanInput,
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
  /** The current chapter's P1 world plan; P2/P3/P4 must see it. */
  worldPlan?: WorldPlanInput | null
  /** Set when the world plan exists but cannot be parsed; exposed for repair. */
  world_plan_error?: string | null
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
  /** 0.2.0 planning layer; optional for older callers and tests. */
  outline?: import('../types.js').OutlineDocument | null
  outlinePresent?: boolean
  outline_error?: string | null
  worldbook?: import('../types.js').WorldbookDocument | null
  worldbookPresent?: boolean
  worldbook_error?: string | null
}

type Character = CharactersDocument['characters'][number]

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

const unique = (values: readonly string[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/** Match known names at occurrence level, longest first, without substring theft. */
const mentionedNames = (text: string, characters: CharactersDocument): string[] => {
  let remaining = text
  const names = [...new Set(characters.characters.map((character) => character.name))]
    .filter((name) => name !== '')
    .sort((left, right) => {
      const length = Array.from(right).length - Array.from(left).length
      return length !== 0 ? length : compareText(left, right)
    })
  const matched: string[] = []
  for (const name of names) {
    if (!remaining.includes(name)) continue
    matched.push(name)
    // Mask this occurrence so a shorter ledger name inside it is not counted
    // a second time; a genuinely separate mention later in the text survives.
    remaining = remaining.split(name).join('\u0000')
  }
  return matched
}

/** The names the current chapter is actually about. */
const activeCastNames = (
  plan: BriefContextInput['plan'],
  characters: CharactersDocument,
  text: string | null,
  appearances: ReadonlyMap<string, number>,
): string[] => {
  const explicit = unique([
    ...(plan?.cast ?? []).map((member) => member.name),
    ...(plan?.summary?.characters_appeared ?? []),
  ])
  // Older plans predate `cast`. Fall back to the narrator and names the plan
  // or current manuscript actually mentions, so the active cast is never empty
  // merely because the plan was written before 0.1.3.
  const narrator = (plan?.narrator ?? '').split(/[（(]/, 1)[0]!.trim()
  const narratorKnown =
    narrator !== '' && characters.characters.some((character) => character.name === narrator)
  const planText = [
    plan?.title ?? '',
    plan?.narrator ?? '',
    plan?.opening ?? '',
    plan?.ending ?? '',
    ...(plan?.beats ?? []),
    text ?? '',
  ].join('\n')
  const byName = new Map(characters.characters.map((character) => [character.name, character]))
  const mentioned = mentionedNames(planText, characters)
  const orderedMentioned = mentioned
    .map((name) => byName.get(name)!)
    .sort((left, right) => {
      const byRecency = recencyOf(right, appearances) - recencyOf(left, appearances)
      return byRecency !== 0 ? byRecency : compareText(left.name, right.name)
    })
    .map((character) => character.name)
  if (explicit.length > 0) {
    // Explicit cast is a declaration, but the manuscript may introduce a known
    // actor during revision without rewriting the stored summary. Keep the
    // declaration first, then add independently mentioned known actors; cap
    // the protected block so one pathological summary cannot wedge the budget.
    return unique([...explicit, ...orderedMentioned]).slice(0, LIMITS.maxActiveCast)
  }
  return unique([...(narratorKnown ? [narrator] : []), ...orderedMentioned]).slice(0, 8)
}

const recencyOf = (character: Character, appearances: ReadonlyMap<string, number>): number =>
  Math.max(Number(character.updated_at ?? 0), appearances.get(character.name) ?? 0)

const appearancesByChapter = (chapters: ChaptersDocument): Map<string, number> => {
  const result = new Map<string, number>()
  for (const row of chapters.chapters) {
    for (const name of row.summary.characters_appeared) {
      result.set(name, Math.max(result.get(name) ?? 0, row.num))
    }
  }
  return result
}

const compactCharacter = (character: Character, appearances: ReadonlyMap<string, number>) => ({
  name: character.name,
  role: character.role,
  first_appearance: character.first_appearance,
  last_seen: recencyOf(character, appearances),
})

const castCard = (
  name: string,
  character: Character | undefined,
  member: ChapterCastMember | undefined,
  declared: Record<string, unknown> | undefined,
) => {
  const base = character ?? declared ?? { name }
  return {
    ...base,
    name,
    ...(member === undefined
      ? {}
      : {
          entry_state: member.entry_state,
          goal: member.goal,
          knowledge: member.knowledge,
          exit_change: member.exit_change,
        }),
  }
}

const worldPlanBrief = (plan: WorldPlanInput | null): Record<string, unknown> | null =>
  plan === null
    ? null
    : {
        chapter: plan.chapter,
        objective: plan.objective,
        constraints: plan.constraints,
        characters: plan.characters,
        locations: plan.locations,
        continuity_notes: plan.continuity_notes,
      }

const filterLocks = (
  locks: LocksDocument,
  cast: readonly string[],
  locations: readonly string[],
): LocksDocument => {
  const characterNames = new Set(cast)
  const locationNames = new Set(locations)
  return {
    ...locks,
    characters:
      characterNames.size === 0
        ? locks.characters
        : Object.fromEntries(Object.entries(locks.characters).filter(([name]) => characterNames.has(name))),
    locations:
      locationNames.size === 0
        ? locks.locations
        : Object.fromEntries(Object.entries(locks.locations).filter(([name]) => locationNames.has(name))),
  }
}

/**
 * Build the stage-specific context pack. The task book explains the rules; this
 * pack is the minimum project state the model needs to apply them without
 * guessing who exists, what was locked, or what the previous chapter ended on.
 */
function unbudgetedBriefContext(input: BriefContextInput): Record<string, unknown> {
  const previousEnding = input.previousText === null ? '' : input.previousText.trim().slice(-400)
  const appearances = appearancesByChapter(input.chapters)
  const activeNames = activeCastNames(input.plan, input.characters, input.text, appearances)
  const activeSet = new Set(activeNames)
  const planCast = new Map((input.plan?.cast ?? []).map((member) => [member.name, member]))
  const byName = new Map(input.characters.characters.map((character) => [character.name, character]))
  const worldPlanByName = new Map(
    (input.worldPlan?.characters ?? []).map((character) => [
      character.name,
      character as unknown as Record<string, unknown>,
    ]),
  )
  const activeCast = activeNames.map((name) =>
    castCard(name, byName.get(name), planCast.get(name), worldPlanByName.get(name)),
  )
  const candidateNames = new Set(
    input.stage === 'P2' ? (input.worldPlan?.characters ?? []).map((character) => character.name) : [],
  )
  const otherCharacters = input.characters.characters
    .filter((character) => !activeSet.has(character.name) && !candidateNames.has(character.name))
    .sort((left, right) => {
      const byRecency = recencyOf(right, appearances) - recencyOf(left, appearances)
      return byRecency !== 0 ? byRecency : compareText(left.name, right.name)
    })
    .map((character) => compactCharacter(character, appearances))
  const worldPlan = worldPlanBrief(input.worldPlan ?? null)
  const epoch = '1970-01-01T00:00:00.000Z'
  const outline = input.outline ?? emptyOutline(epoch)
  const worldbook = input.worldbook ?? emptyWorldbook(epoch)
  const mentioned = [
    input.text ?? '',
    input.project.description,
    input.plan?.title ?? '',
    ...(input.plan?.beats ?? []),
    input.worldPlan?.objective ?? '',
    ...(input.worldPlan?.constraints ?? []),
    ...activeNames,
  ].join('\n')
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
    book_plan: bookBrief(outline, input.chapter),
    outline_card: outlineCard(outline, input.chapter),
    ...(input.stage === 'P1' || input.stage === 'P2' || input.stage === 'P3'
      ? { worldbook: worldbookBrief(worldbook, mentioned, activeNames) }
      : {}),
    ...(input.outline_error === undefined || input.outline_error === null
      ? {}
      : { outline_error: input.outline_error }),
    ...(input.worldbook_error === undefined || input.worldbook_error === null
      ? {}
      : { worldbook_error: input.worldbook_error }),
    ...(input.world_plan_error === undefined || input.world_plan_error === null
      ? {}
      : { world_plan_error: input.world_plan_error }),
    ...(input.plan_error === undefined || input.plan_error === null ? {} : { plan_error: input.plan_error }),
    ...(input.review_error === undefined || input.review_error === null
      ? {}
      : { review_error: input.review_error }),
    ...(input.check_error === undefined || input.check_error === null
      ? {}
      : { check_error: input.check_error }),
  }

  switch (input.stage) {
    case 'P1': {
      const position = input.handoff === null ? null : projectHandoff(input.handoff, input.chapter)
      return {
        ...base,
        recent_summaries: input.chapters.chapters.slice(-5).map(compactSummary),
        open_foreshadows: pendingForeshadows(input.foreshadows),
        volume: position?.volume ?? 1,
        volume_name: position?.volume_name ?? '',
        act: position?.act ?? '',
        act_progress: position?.act_progress ?? '',
      }
    }
    case 'P2':
      return {
        ...base,
        world_plan: worldPlan,
        // Before the chapter plan exists, the P1 character declarations are the
        // cast candidates. The ledger index lets the model avoid duplicate names.
        // Copy the array: the budget may trim the world-plan copy, and sharing
        // one array would silently empty this protected candidate list too.
        characters: [...(input.worldPlan?.characters ?? [])],
        other_characters: otherCharacters,
        plan: input.plan,
        open_foreshadows: pendingForeshadows(input.foreshadows),
      }
    case 'P3':
      return {
        ...base,
        world_plan: worldPlan,
        characters: activeCast,
        other_characters: otherCharacters,
        locks: filterLocks(
          input.locks,
          activeNames,
          (input.worldPlan?.locations ?? []).map((location) => location.name),
        ),
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
        world_plan: worldPlan,
        characters: activeCast,
        other_characters: otherCharacters,
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
        world_plan: worldPlan,
        characters: activeCast,
        other_characters: otherCharacters,
      }
    case 'P6':
      return {
        ...base,
        text: input.text ?? '',
        plan: input.plan,
        machine: input.machine ?? null,
        world_plan: worldPlan,
        characters: input.characters.characters,
        active_cast: activeCast,
        other_characters: otherCharacters,
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
  strategy: 'stage-v2'
}

type MutableRecord = Record<string, unknown>

const asRecord = (value: unknown): MutableRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as MutableRecord) : null

const asArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null)

const jsonSize = (value: unknown): number => JSON.stringify(value).length

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
  // P2 normally has a small candidate list from the P1 plan. Keep it visible
  // when it is ordinary-sized, but do not let a pathological 120-name plan
  // buy an unbounded protected block; the larger list is trimmed like every
  // other optional candidate.
  const smallP2Candidates =
    stage === 'P2' && Array.isArray(context.characters) && context.characters.length <= 32
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
    'world_plan',
    'book_plan',
    'outline_card',
    'worldbook',
    'outline_error',
    'worldbook_error',
    'active_cast',
    // P3–P5 are about this chapter's cast; trimming it first is the bug this
    // version exists to fix. P6 has active_cast as the protected subset and
    // may trim the full character ledger. P2's ordinary candidate list is
    // protected only while it is small enough to be a useful brief.
    ...(stage === 'P3' || stage === 'P4' || stage === 'P5' || smallP2Candidates ? ['characters'] : []),
  ]
  const mentioned = [
    typeof context.text === 'string' ? context.text : '',
    stableStringify(context.plan ?? ''),
    stableStringify(context.review ?? ''),
    stableStringify(context.check ?? ''),
    stableStringify(context.summary ?? ''),
    stableStringify(context.world_plan ?? ''),
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
    if (row === null) return stableStringify(value)
    for (const key of ['id', 'name', 'title'] as const) {
      const item = row[key]
      if (typeof item === 'string' && item !== '') return item
    }
    return stableStringify(row)
  }
  const addArray = (
    key: string,
    array: () => unknown[] | null,
    rank: (value: unknown) => number,
    tie: (value: unknown) => string = stableKey,
  ): void => {
    if (protectedKeys.includes(key)) return
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
    if (protectedKeys.includes(key)) return
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
  const activeNames = new Set(
    Array.isArray(context.active_cast)
      ? context.active_cast
          .map((value) => (asRecord(value)?.name as string | undefined) ?? '')
          .filter((name) => name !== '')
      : [],
  )
  const recency = (row: MutableRecord): number =>
    Math.max(Number(row.updated_at ?? 0), Number(row.last_seen ?? 0))
  addArray(
    'characters',
    () => asArray(context.characters),
    (value) => {
      const row = asRecord(value)
      const name = typeof row?.name === 'string' ? row.name : ''
      const active = activeNames.has(name) ? 1_000_000 : 0
      return active + mentionScore(mentioned, name) * 100_000 + recency(row ?? {})
    },
    (value) => {
      const row = asRecord(value)
      return typeof row?.name === 'string' ? row.name : stableKey(value)
    },
  )
  addArray(
    'other_characters',
    () => asArray(context.other_characters),
    (value) => {
      const row = asRecord(value)
      return Number(row?.last_seen ?? 0)
    },
    (value) => {
      const row = asRecord(value)
      return typeof row?.name === 'string' ? row.name : stableKey(value)
    },
  )
  // The P1 plan's narrative constraints are protected, but its roster and
  // location list are candidates that can be large. Trim those arrays rather
  // than letting a 120-character plan push every consumer over budget.
  const worldPlan = asRecord(context.world_plan)
  addArray(
    'world_plan.characters',
    () => asArray(worldPlan?.characters),
    (value) => {
      const row = asRecord(value)
      const name = typeof row?.name === 'string' ? row.name : ''
      return (activeNames.has(name) ? 1_000_000 : 0) + mentionScore(mentioned, name) * 100_000
    },
    (value) => {
      const row = asRecord(value)
      return typeof row?.name === 'string' ? row.name : stableKey(value)
    },
  )
  addArray(
    'world_plan.locations',
    () => asArray(worldPlan?.locations),
    (value) => {
      const row = asRecord(value)
      const name = typeof row?.name === 'string' ? row.name : ''
      return mentionScore(mentioned, name) * 1_000
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
      (name) => (activeNames.has(name) ? 1_000_000 : 0) + mentionScore(mentioned, name) * 1_000,
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

  // `context` does not carry context_meta yet; measuring it directly avoids a
  // full clone and a second stringify on every trim decision.
  const used = (): number => jsonSize(context)
  const buildMeta = (finalUsed: number): ContextMeta => ({
    version: 1,
    stage,
    budget,
    used: finalUsed,
    over_budget: false,
    protected: protectedKeys,
    truncated: [...truncated].sort(compareText),
    omitted: Object.fromEntries(Object.entries(omitted).sort(([left], [right]) => compareText(left, right))),
    strategy: 'stage-v2',
  })
  // Measure the real document, including the `"context_meta":` key and the
  // comma that joins it. Adding jsonSize(meta) to the content size alone is a
  // few bytes short and can overshoot the advertised budget at the boundary.
  const totalWith = (finalUsed: number, meta: ContextMeta): number => {
    // The exact serialized object = content JSON + comma + `"context_meta":` +
    // the metadata's own JSON. `context` always has at least project/chapter.
    const metaSize = jsonSize({ ...meta, used: finalUsed })
    return finalUsed + 1 + '"context_meta":'.length + metaSize
  }

  // Round-robin: one item from every candidate per pass, so P6 does not spend
  // the whole budget on characters before noticing the timeline. The metadata
  // itself is measured in the loop: its omitted/truncated lists grow as we trim.
  let finalUsed = used()
  let metaBase = buildMeta(finalUsed)
  while (totalWith(finalUsed, metaBase) > budget) {
    let changed = false
    for (const candidate of candidates) {
      if (totalWith(finalUsed, metaBase) <= budget) break
      if (candidate.count() === 0) continue
      candidate.prepare()
      if (candidate.trim()) {
        omitted[candidate.key] = (omitted[candidate.key] ?? 0) + 1
        truncated.add(candidate.key)
        changed = true
        finalUsed = used()
        metaBase = buildMeta(finalUsed)
      }
    }
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
