import { LIMITS } from '../constants.js'
import { compareText } from '../domain/stable.js'
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
import type { StylePack } from '../rules/types.js'

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
  /** 0.2.17: the compiled style pack; P2–P6 receive it, P1/P8 do not. */
  style?: StylePack | null
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
    // the declared cast so one pathological summary cannot name 200 people.
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
function stageBriefContext(input: BriefContextInput): Record<string, unknown> {
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
    // 0.2.17: the style block reaches P2–P6 only. P1 declares the world and P8
    // closes the chapter; neither needs to be told how the prose should read.
    ...(input.style === undefined ||
    input.style === null ||
    !['P2', 'P3', 'P4', 'P5', 'P6'].includes(input.stage)
      ? {}
      : { style: styleBlock(input.style, input.project) }),
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
        // Copy the array: this candidate list is a separate view of the world
        // plan, so mutating one must not empty the other.
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
        // Sorted, not storage order: the same ledger written in a different row
        // order must produce the same brief, or the signed digest changes for a
        // reason the author cannot see. Trimming used to hide this by dropping
        // most rows; a complete brief has to be order-independent on its own.
        characters: [...input.characters.characters].sort((left, right) =>
          compareText(left.name, right.name),
        ),
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

/**
 * The style block a P2–P6 brief carries.
 *
 * C6: `dialogue` carries *both* the aiming point and the accepted range. Giving
 * only the target hides the acceptance line; giving only the range hides where
 * to aim. A pack range may only tighten the project range (C5 / 附录 C-29).
 */
function styleBlock(pack: StylePack, project: NovelProject): Record<string, unknown> {
  const base = project.targets.dialogue_ratio
  const min = Math.max(base[0], pack.thresholds.dialogue_ratio_min ?? base[0])
  const max = Math.min(base[1], pack.thresholds.dialogue_ratio_max ?? base[1])
  // A pack whose range cannot intersect the confirmed range is a contradiction
  // for `novel_doctor` to report; the brief keeps the range the user confirmed.
  const range: [number, number] = min <= max ? [min, max] : base
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    register: pack.register,
    pov: pack.pov,
    tense: pack.tense,
    targets: {
      sentence: pack.sentence,
      paragraph: pack.paragraph,
      dialogue: {
        target: pack.dialogue.ratio,
        range,
        metric: project.targets.dialogue_ratio_metric ?? 'both',
      },
      structure: pack.structure,
      emotion: pack.emotion,
    },
    banned_patterns: pack.banned_patterns.slice(0, 12),
    exemplars: pack.exemplars.slice(0, 1),
    critic_rubric: pack.critic_rubric,
    thresholds: pack.thresholds,
  }
}

/**
 * 0.2.17: the brief carries the **complete** context.
 *
 * There used to be a per-stage byte budget here that deleted ledgers, trimmed
 * lists and reported what it had thrown away. It was justified as "the host
 * prunes oversized results anyway", but the effect was that the model received
 * a task book that was missing rows it was being judged on — and a style block
 * it could not see. Trimming is not a feature the author can reason about, so
 * it is gone: the only thing left is an honest size report.
 */
interface ContextMeta {
  version: 1
  stage: string
  /** UTF-8 bytes of the assembled brief, metadata included. */
  used: number
  complete: true
  strategy: 'complete'
}

const jsonSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

/**
 * Build the complete stage-specific context pack.
 *
 * `context_meta.used` is measured on the exact document that is returned, so
 * the size the model sees reported is the size it receives. Nothing is
 * removed: what the stage needs is what the stage gets.
 */
export function briefContext(input: BriefContextInput): Record<string, unknown> {
  const context = stageBriefContext(input)
  const meta: ContextMeta = {
    version: 1,
    stage: input.stage,
    used: 0,
    complete: true,
    strategy: 'complete',
  }
  // `used` is part of the document it measures, so measure to a fixpoint rather
  // than reporting a number one metadata edit out of date.
  let used = 0
  for (let pass = 0; pass < 4; pass += 1) {
    const size = jsonSize({ ...context, context_meta: { ...meta, used } })
    if (size === used) break
    used = size
  }
  return { ...context, context_meta: { ...meta, used } }
}
