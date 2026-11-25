import { LIMITS } from '../constants.js'
import { compareText } from '../domain/stable.js'
import { SELF_CHECK_SPEC } from '../rules/selfcheck.js'
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

/**
 * 0.2.20 WP1: the host prunes a task result larger than this, in code points.
 *
 * Measured with `Array.from(...)`, never bytes: the host counts Unicode code
 * points and keeps the first 4,096 + last 1,024 of anything above the limit.
 * The internal target leaves room for the tool-result envelope so a payload
 * that fits here cannot be pushed over by the wrapper.
 */
export const BRIEF_BUDGET_CODEPOINTS = 8192

/** Unicode code points of a JSON value (or of a string as-is). */
export function codepoints(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text === undefined ? 0 : Array.from(text).length
}

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
  /**
   * 0.2.19 机检度: the engine's score for the five format dimensions.
   *
   * P4 must submit a total that matches it, so it is handed the numbers up front.
   * Null or absent means "no draft to score", which keeps P1/P2/P5/P6 identical.
   */
  machineScores?: Record<string, unknown> | null
  /**
   * 0.2.19: whether the rule pack carries a `selfcheck` block.
   *
   * Without the block the eleven checklist codes never run, so promising the
   * model a checklist would be a promise the engine cannot keep. Absent means
   * "no checklist", which keeps a pre-0.2.19 pack's brief byte-identical.
   */
  selfcheck?: boolean
  previousText: string | null
  handoff: HandoffDocument | null
  /** 0.2.0 planning layer; optional for older callers and tests. */
  outline?: import('../types.js').OutlineDocument | null
  outlinePresent?: boolean
  outline_error?: string | null
  worldbook?: import('../types.js').WorldbookDocument | null
  worldbookPresent?: boolean
  worldbook_error?: string | null
  /**
   * 0.2.20 WP1: code points still available for the context document.
   *
   * Absent or `Infinity` means "no windowing": the full pack is returned (the
   * `novel_brief { full: true }` escape and direct `briefContext` callers).
   * A finite budget keeps every required block whole and fills the optional
   * blocks in stage order until the document would exceed it.
   */
  budget?: number
}

type Character = CharactersDocument['characters'][number]

/**
 * 0.2.20 WP1: the continuity row a P1/P3 brief can afford.
 *
 * The seven-field version cost 792 code points for one chapter on a real book —
 * more than half of P1's entire optional budget — so the window could show one
 * summary *or* one foreshadow, never both. What opening a chapter actually needs
 * is what happened, who was on stage, and how the last one ended; the foreshadow
 * bookkeeping has its own gate at P8.
 */
const compactSummary = (row: ChaptersDocument['chapters'][number]): Record<string, unknown> => ({
  num: row.num,
  title: row.title,
  events: row.summary.events,
  characters_appeared: row.summary.characters_appeared,
  ends_with: row.summary.continuity.ends_with,
  open_foreshadows: row.summary.foreshadows.advanced.length + row.summary.foreshadows.planted.length,
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
  /**
   * 0.2.19: the submission checklist, in checklist order.
   *
   * One table, three stages: P3 writes against it, P4 answers the eight rows the
   * engine cannot decide, P6 confirms them again. Three copies of the list would
   * let the three stages describe three different standards.
   */
  const selfCheckBlock = (): Record<string, unknown> | null => {
    // 0.2.20 WP1: the checklist is answered where it is submitted (P3/P4). P6
    // confirms the answers did not go stale while revising; re-sending the 13
    // rows there cost 741 code points of a budget the manuscript needs.
    if (input.selfcheck !== true || !['P3', 'P4'].includes(input.stage)) return null
    return {
      version: 1,
      // 0.2.20 WP1: the id and a short title are what the model answers with;
      // the standard behind each row is in `docs/selfcheck.md` and the rule
      // pack. Sending the full `basis` column cost 1,431 code points — a fifth
      // of the whole brief — for prose the model never quotes back.
      checklist: SELF_CHECK_SPEC.map((entry) => ({
        id: entry.id,
        title: excerptOf(entry.title, 12),
      })),
      // The five `machine` rows are the engine's; a submission for one is refused.
      must_answer: SELF_CHECK_SPEC.filter((entry) => entry.basis !== 'machine').map((entry) => entry.id),
    }
  }
  const selfCheck = selfCheckBlock()
  const mentioned = [
    input.text ?? '',
    input.project.description,
    input.plan?.title ?? '',
    ...(input.plan?.beats ?? []),
    input.worldPlan?.objective ?? '',
    ...(input.worldPlan?.constraints ?? []),
    ...activeNames,
  ].join('\n')
  /**
   * 0.2.20 WP1: which stages read the book-level roadmap.
   *
   * P1–P3 place the chapter, P5 revises it; P4/P6/P8 judge the manuscript that
   * already exists and read its own card (`outline_card`). Carrying the whole
   * book plan into the review stages cost 243 code points of the 8,192 budget
   * for text those stages never act on, and the same is true of the previous
   * chapter's ending and the scene-type distribution.
   */
  const READS_ROADMAP = new Set(['P1', 'P2', 'P3', 'P5'])

  const base: Record<string, unknown> = {
    project: {
      title: input.project.title,
      genre: input.project.genre,
      platform: input.project.platform,
      targets: input.project.targets,
    },
    // 0.2.20 WP2: the engine's own score for the five format dimensions is data
    // the stage must submit, not part of the self-check block. It used to live
    // inside `self_check`, so a pack without that block hid it entirely.
    ...(input.machineScores === undefined || input.machineScores === null
      ? {}
      : { machine_scores: input.machineScores }),
    ...(selfCheck === null ? {} : { self_check: selfCheck }),
    // 0.2.17: the style block reaches P2–P6 only. P1 declares the world and P8
    // closes the chapter; neither needs to be told how the prose should read.
    ...(input.style === undefined ||
    input.style === null ||
    !['P2', 'P3', 'P4', 'P5', 'P6'].includes(input.stage)
      ? {}
      : { style: styleBlock(input.style, input.project) }),
    chapter: input.chapter,
    stage: input.pipeline.stage,
    ...(READS_ROADMAP.has(input.stage)
      ? {
          scene_distribution: sceneDistribution(input.chapters),
          previous_ending: previousEnding,
          book_plan: bookBrief(outline, input.chapter),
        }
      : {}),
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
        // 0.2.20 review: the full machine pass at P4 (1.3 KB on a short chapter)
        // could not fit next to the cast and the manuscript, and the window
        // answered by dropping both to zero rows. `COMPACTABLE.P4` now keeps the
        // counts, the metrics and a few samples and records the rest as a
        // `compacted` locator, so P4 still sees the word metrics it scores with.
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
        // 0.2.20 review 4: no top-level `issues`. It was always a byte-identical
        // copy of `review.issues` (and `[]` whenever there is no review), so a
        // 30-issue review cost the task book twice — 21,528 code points, cut by
        // the host with `complete: true`. `review` carries the rows and
        // `COMPACTABLE.P5` keeps the blockers visible when it has to shrink.
        review: input.review,
        world_plan: worldPlan,
        characters: activeCast,
        other_characters: otherCharacters,
      }
    case 'P6':
      return {
        ...base,
        text: input.text ?? '',
        // 0.2.20 WP1: P6 judges the chapter against the summary it will archive
        // with, not against the P2 card. The plan cost 525 code points and the
        // five L2 rows never quote a beat, so it stays with P3/P4/P5.
        summary: input.plan?.summary ?? null,
        // 0.2.20: no `machine` block. It is the P4/P5 snapshot of a pass that
        // has already been superseded, and P6 runs its own check; the 757 code
        // points it cost were the difference between fitting and being pruned.
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
        score_history: input.chapters.chapters.slice(-5).map((row) => ({ num: row.num, score: row.score })),
      }
    case 'P8':
      return {
        ...base,
        // 0.2.20 WP1: the archive stage checks the draft summary against the
        // prose, not the P2 card. The card cost 525 code points and the delta
        // never quotes a beat.
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
    // D4: every banned pattern, not the first twelve. The check judges the
    // chapter against the whole pack, so a truncated brief deducted points for
    // phrases the model was never shown. Truncation here was a silent lie.
    banned_patterns: pack.banned_patterns,
    exemplars: pack.exemplars,
    critic_rubric: pack.critic_rubric,
    thresholds: pack.thresholds,
  }
}

/**
 * 0.2.20 WP1: window the pack to the host's limit.
 *
 * 0.2.17 removed the old byte budget because it silently deleted rows the
 * stage was judged on. That was right about the lie and wrong about the host:
 * the task-result pruner keeps only the first 4,096 + last 1,024 code points of
 * anything over 8,192, so a "complete" 281 KB P6 brief arrived half missing
 * while `context_meta.complete` still said `true`.
 *
 * The contract now: required blocks stay whole unless they are documents with
 * no rows to drop (review, check, machine, self-check: those are handed over as
 * locators plus a `novel_state` pointer), optional blocks are filled in a fixed
 * per-stage relevance order until the code-point budget is reached, and the
 * receipt names every row that did not fit plus the tool call that fetches it.
 * The manuscript is cut last and only by paragraph — the host would cut it
 * mid-sentence at an arbitrary offset with no receipt at all.
 */
interface ContextMeta {
  version: 2
  stage: string
  /** UTF-8 bytes of the assembled brief, metadata included. */
  used: number
  complete: boolean
  strategy: 'complete' | 'windowed'
  budget: {
    unit: 'codepoint'
    limit: number
    /** Code points of the exact document this metadata is part of. */
    used: number
    /**
     * Blocks that are never windowed. 0.2.20 has none: the manuscript used to
     * be exempt, but letting the host cut it mid-sentence was worse than a
     * paragraph window with a `novel_export` pointer.
     */
    exempt: string[]
    overflow: boolean
  }
  /**
   * Rows that are not in this brief. `clipped` is the subset that is present
   * but shortened: a cell longer than `WINDOW_CELL_CHARS` or a nested list
   * deeper than `WINDOW_LIST_KEEP` entries is cut to keep the row affordable.
   *
   * 0.2.20 review: cell clipping used to happen on every windowed block and was
   * not reported, so a brief whose foreshadow description had been cut at 80
   * code points still said `complete: true` with an empty `omitted` and no
   * `fetch` pointer. A row that is in the document but not whole is not
   * complete, and the caller has no other way to find out.
   */
  omitted: Record<string, { total: number; shown: number; clipped?: number }>
  /**
   * 0.2.20 WP1: required blocks that were reduced to their locators instead of
   * their full text, with the code-point size of the full document. These are
   * not rows that did not fit — the whole document exists and is fetchable —
   * but the brief is no longer complete either, so `complete` is false.
   */
  compacted: Record<string, { full: number; shown: number; why: string }>
  fetch: Array<{
    tool: 'novel_state' | 'novel_export'
    args: Record<string, unknown>
    why: string
  }>
}

type WindowKind = 'array' | 'document' | 'record'
type WindowRelevance = 'timeline' | 'foreshadows' | 'characters'

interface WindowSpec {
  key: string
  kind: WindowKind
  /** For document/record blocks: the inner arrays/records that may be cut. */
  sections?: readonly string[]
  relevance?: WindowRelevance
  /**
   * A block the stage judges against: filled before the optional blocks and
   * allowed to take the whole remainder. It is still windowed when it cannot be
   * shown whole, and the receipt says which rows were shortened.
   */
  required?: boolean
  fetch: { kind: string; extra?: Record<string, unknown>; why: string }
}

/**
 * Optional blocks, in the order this stage fills them.
 *
 * Order is part of the contract: the same state and budget must produce the
 * same document, and the signed digest must cover the resulting window. A
 * block that is not listed here is required and never split. `score_history`
 * is stage shape (five rows), so it is not windowed even where the plan lists
 * it among the optional readers.
 */
const WINDOWABLE: Record<string, readonly WindowSpec[]> = {
  P1: [
    // 0.2.20: continuity first. On a real 58-chapter book the two blocks compete
    // for ~500 code points, and one recent summary is worth more to P1 than one
    // foreshadow reminder — the foreshadow ledger has its own gate at P8.
    {
      key: 'recent_summaries',
      kind: 'array',
      fetch: {
        kind: 'chapters',
        extra: { include_summary: true },
        why: '最近章节摘要被窗口截断，可读取完整摘要',
      },
    },
    {
      key: 'open_foreshadows',
      kind: 'array',
      relevance: 'foreshadows',
      fetch: {
        kind: 'foreshadows',
        extra: { status: 'open' },
        why: '未回收伏笔清单在窗口之外，可按状态分页读取',
      },
    },
    {
      key: 'worldbook',
      kind: 'document',
      sections: ['characters', 'locations', 'factions', 'rules', 'glossary', 'backstory', 'facts', 'themes'],
      fetch: { kind: 'worldbook', why: '世界观条目在窗口之外' },
    },
  ],
  P2: [
    {
      key: 'world_plan',
      kind: 'document',
      sections: ['characters', 'locations', 'constraints', 'continuity_notes'],
      fetch: { kind: 'planWorld', why: '世界计划超出窗口，可读取完整计划' },
    },
    {
      key: 'open_foreshadows',
      kind: 'array',
      relevance: 'foreshadows',
      fetch: {
        kind: 'foreshadows',
        extra: { status: 'open' },
        why: '未回收伏笔清单在窗口之外，可按状态分页读取',
      },
    },
    {
      key: 'worldbook',
      kind: 'document',
      sections: ['characters', 'locations', 'factions', 'rules', 'glossary', 'backstory', 'facts', 'themes'],
      fetch: { kind: 'worldbook', why: '世界观条目在窗口之外' },
    },
    {
      key: 'characters',
      kind: 'array',
      relevance: 'characters',
      required: true,
      fetch: { kind: 'characters', why: 'P1 人物候选超出窗口，可读取人物台账' },
    },
    {
      key: 'other_characters',
      kind: 'array',
      fetch: { kind: 'characters', why: '未上场人物超出窗口，可读取人物台账' },
    },
  ],
  P3: [
    // 0.2.20 review: the cast the draft must stay consistent with fills first.
    {
      key: 'characters',
      kind: 'array',
      relevance: 'characters',
      required: true,
      fetch: { kind: 'characters', why: '本章活跃人物被窗口截断，可读取完整人物卡' },
    },
    {
      key: 'world_plan',
      kind: 'document',
      sections: ['characters', 'locations', 'constraints', 'continuity_notes'],
      fetch: { kind: 'planWorld', why: '世界计划超出窗口，可读取完整计划' },
    },
    {
      key: 'open_foreshadows',
      kind: 'array',
      relevance: 'foreshadows',
      fetch: {
        kind: 'foreshadows',
        extra: { status: 'open' },
        why: '未回收伏笔清单在窗口之外，可按状态分页读取',
      },
    },
    {
      key: 'recent_summaries',
      kind: 'array',
      fetch: {
        kind: 'chapters',
        extra: { include_summary: true },
        why: '最近章节摘要被窗口截断，可读取完整摘要',
      },
    },
    {
      key: 'other_characters',
      kind: 'array',
      fetch: { kind: 'characters', why: '未上场人物超出窗口，可读取人物台账' },
    },
    {
      key: 'locks',
      kind: 'record',
      sections: ['characters', 'locations'],
      fetch: { kind: 'locks', why: '锁定描写超出窗口，可读取锁定台账' },
    },
    {
      key: 'worldbook',
      kind: 'document',
      sections: ['characters', 'locations', 'factions', 'rules', 'glossary', 'backstory', 'facts', 'themes'],
      fetch: { kind: 'worldbook', why: '世界观条目在窗口之外' },
    },
  ],
  // P4/P5 `characters` is the active cast (their `active_cast` key): the brief
  // says that block is required, so only the off-stage readers are windowed.
  P4: [
    // 0.2.20 review: the active cast is what P4 judges the chapter against. It
    // is `required`, so it fills first and reports shortened rows instead of
    // being squeezed by the fair share (a P4 brief on a modest project used to
    // be 11.4 KB because eight 200-character cast bios could not shrink).
    {
      key: 'characters',
      kind: 'array',
      relevance: 'characters',
      required: true,
      fetch: { kind: 'characters', why: '本章活跃人物被窗口截断，可读取完整人物卡' },
    },
    {
      key: 'world_plan',
      kind: 'document',
      sections: ['characters', 'locations', 'constraints', 'continuity_notes'],
      fetch: { kind: 'planWorld', why: '世界计划超出窗口，可读取完整计划' },
    },
    {
      key: 'other_characters',
      kind: 'array',
      fetch: { kind: 'characters', why: '未上场人物超出窗口，可读取人物台账' },
    },
  ],
  P5: [
    {
      key: 'characters',
      kind: 'array',
      relevance: 'characters',
      required: true,
      fetch: { kind: 'characters', why: '本章活跃人物被窗口截断，可读取完整人物卡' },
    },
    {
      key: 'world_plan',
      kind: 'document',
      sections: ['characters', 'locations', 'constraints', 'continuity_notes'],
      fetch: { kind: 'planWorld', why: '世界计划超出窗口，可读取完整计划' },
    },
    {
      key: 'other_characters',
      kind: 'array',
      fetch: { kind: 'characters', why: '未上场人物超出窗口，可读取人物台账' },
    },
  ],
  P6: [
    {
      key: 'world_plan',
      kind: 'document',
      sections: ['characters', 'locations', 'constraints', 'continuity_notes'],
      fetch: { kind: 'planWorld', why: '世界计划超出窗口，可读取完整计划' },
    },
    {
      key: 'timeline',
      kind: 'array',
      relevance: 'timeline',
      fetch: { kind: 'timeline', extra: { limit: 200 }, why: '时间线在窗口之外，可按章节范围分页读取' },
    },
    {
      key: 'foreshadows',
      kind: 'document',
      sections: ['items'],
      relevance: 'foreshadows',
      fetch: { kind: 'foreshadows', extra: { limit: 200 }, why: '伏笔台账在窗口之外，可按状态分页读取' },
    },
    {
      key: 'relationships',
      kind: 'document',
      sections: ['items'],
      fetch: { kind: 'relationships', extra: { limit: 200 }, why: '关系台账在窗口之外，可翻页读取' },
    },
    {
      key: 'characters',
      kind: 'array',
      relevance: 'characters',
      required: true,
      fetch: { kind: 'characters', why: '人物台账在窗口之外，可翻页读取' },
    },
    {
      key: 'other_characters',
      kind: 'array',
      fetch: { kind: 'characters', why: '未上场人物超出窗口，可读取人物台账' },
    },
    {
      key: 'world',
      kind: 'document',
      sections: ['locations', 'abilities', 'artifacts', 'factions', 'rules'],
      fetch: { kind: 'world', why: '世界观台账在窗口之外' },
    },
    {
      key: 'locks',
      kind: 'record',
      sections: ['characters', 'locations'],
      fetch: { kind: 'locks', why: '锁定描写超出窗口，可读取锁定台账' },
    },
  ],
  P8: [
    {
      key: 'open_foreshadows',
      kind: 'array',
      relevance: 'foreshadows',
      fetch: {
        kind: 'foreshadows',
        extra: { status: 'open' },
        why: '未回收伏笔清单在窗口之外，可按状态分页读取',
      },
    },
    {
      key: 'recent_summaries',
      kind: 'array',
      fetch: {
        kind: 'chapters',
        extra: { include_summary: true },
        why: '最近章节摘要被窗口截断，可读取完整摘要',
      },
    },
    {
      key: 'other_characters',
      kind: 'array',
      fetch: { kind: 'characters', why: '未上场人物超出窗口，可读取人物台账' },
    },
  ],
}

const rowsIn = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const recordEntries = (value: unknown): Array<[string, unknown]> =>
  typeof value === 'object' && value !== null ? Object.entries(value as Record<string, unknown>) : []

/** Rows in a whole block, across every inner array/record a document carries. */
const totalRows = (value: unknown, spec: WindowSpec): number => {
  if (spec.kind === 'array') return rowsIn(value).length
  let total = 0
  const document = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  for (const section of spec.sections ?? []) {
    const inner = document[section]
    total += spec.kind === 'record' ? recordEntries(inner).length : rowsIn(inner).length
  }
  return total
}

/** The chapter an item belongs to; foreshadows carry `last_touched`, not `chapter`. */
const itemChapter = (row: unknown): number => {
  if (typeof row !== 'object' || row === null) return Number.POSITIVE_INFINITY
  const record = row as Record<string, unknown>
  for (const key of ['chapter', 'last_touched', 'planted']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return Number.POSITIVE_INFINITY
}

interface OrderedSection {
  section: string | null
  rows: unknown[]
}

/**
 * Relevance order for one block. Ties fall back to the original index so the
 * same ledger always windows to the same rows: the digest depends on it.
 */
const orderedSections = (
  source: unknown,
  spec: WindowSpec,
  chapter: number,
  activeCast: ReadonlyMap<string, number>,
): OrderedSection[] => {
  const order = (rows: unknown[]): unknown[] => {
    if (spec.relevance === undefined) return rows.slice()
    if (spec.relevance === 'characters') {
      const rank = (row: unknown, index: number): [number, number, number] => {
        const name =
          typeof row === 'object' && row !== null ? String((row as Record<string, unknown>).name ?? '') : ''
        const active = activeCast.get(name)
        if (active !== undefined) return [0, active, index]
        const first = (row as Record<string, unknown> | null)?.first_appearance
        return [1, typeof first === 'number' && Number.isFinite(first) ? -first : 0, index]
      }
      return rows
        .map((row, index) => ({ row, rank: rank(row, index) }))
        .sort(
          (left, right) =>
            left.rank[0] - right.rank[0] || left.rank[1] - right.rank[1] || left.rank[2] - right.rank[2],
        )
        .map((entry) => entry.row)
    }
    return rows
      .map((row, index) => ({ row, distance: Math.abs(itemChapter(row) - chapter), index }))
      .sort((left, right) => left.distance - right.distance || left.index - right.index)
      .map((entry) => entry.row)
  }
  if (spec.kind === 'array') return [{ section: null, rows: order(rowsIn(source)) }]
  const document = typeof source === 'object' && source !== null ? (source as Record<string, unknown>) : {}
  return (spec.sections ?? []).map((section) => {
    const inner = document[section]
    return {
      section,
      rows: spec.kind === 'record' ? order(recordEntries(inner) as unknown[]) : order(rowsIn(inner)),
    }
  })
}

/** Copy of a block with the first `count` relevant rows and the rest omitted. */
/**
 * 0.2.20 WP1: longest free-text cell a windowed ledger row keeps.
 *
 * A single 2,000-character foreshadow description cost more than the whole
 * remaining budget, so the fill loop broke on row 1 and the block showed *zero*
 * rows — the P1 brief of a real 58-chapter book carried no open foreshadow at
 * all while claiming to window them. Clipping the long cells keeps every row
 * recognizable (id, title, status, chapter) and lets a dozen fit; the receipt's
 * `fetch` still points at the full ledger.
 */
const WINDOW_CELL_CHARS = 80

const clipCell = (value: unknown, limit = WINDOW_CELL_CHARS): unknown => {
  if (typeof value !== 'string') return value
  const points = Array.from(value)
  return points.length <= limit ? value : `${points.slice(0, limit).join('')}…`
}

/** Nested lists a windowed row keeps; the rest is one `fetch` away. */
const WINDOW_LIST_KEEP = 2

/**
 * A windowed row, clipped deeply enough that one row always fits.
 *
 * Clipping only top-level strings was not enough: a foreshadow row carries an
 * `advance_log` whose entries each hold a note and an anchor, so a single row
 * could still exceed the whole remaining budget and the block fell back to zero
 * rows. Nested arrays keep their first few entries, and every string in them is
 * clipped, so a row's size is bounded by its shape rather than by its history.
 */
const clipRow = (
  row: unknown,
  depth = 2,
  cellChars = WINDOW_CELL_CHARS,
  listKeep = WINDOW_LIST_KEEP,
): unknown => {
  if (typeof row === 'string') return clipCell(row, cellChars)
  if (Array.isArray(row)) {
    return depth <= 0
      ? `[${row.length} rows]`
      : row.slice(0, listKeep).map((entry) => clipRow(entry, depth - 1, cellChars, listKeep))
  }
  if (typeof row !== 'object' || row === null) return row
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    next[key] =
      depth <= 0 && Array.isArray(value)
        ? `[${value.length} rows]`
        : clipRow(value, depth, cellChars, listKeep)
  }
  return next
}

/** Code points a single row adds to its block, before the separator comma. */
const rowCost = (row: unknown, spec: WindowSpec): number =>
  spec.kind === 'record'
    ? codepoints((row as [string, unknown])[0]) + 1 + codepoints((row as [string, unknown])[1])
    : codepoints(row)

interface ChosenRows {
  sections: OrderedSection[]
  count: number
  /** Rows that are in the window but shortened; `0` means every row is whole. */
  clipped: number
}

/**
 * Pick the rows a block can afford.
 *
 * 0.2.20 review: the previous version always rendered the *clipped* form of
 * every row, even when the whole row fit. On a one-chapter project that turned
 * a five-event summary into two events and a four-name cast into two names
 * while the receipt said `complete`. Clipping is now the fallback, not the
 * default: a row is kept whole unless keeping it whole would push the block
 * past its share, and every shortened row is counted so the receipt can say so.
 */
const chooseRows = (
  source: unknown,
  spec: WindowSpec,
  available: number,
  chapter: number,
  activeCast: ReadonlyMap<string, number>,
): ChosenRows => {
  const ordered = orderedSections(source, spec, chapter, activeCast)
  const sections: OrderedSection[] = ordered.map((section) => ({ section: section.section, rows: [] }))
  let spent = 0
  let count = 0
  let clipped = 0
  fill: for (const [sectionIndex, section] of ordered.entries()) {
    for (const row of section.rows) {
      const separator = count === 0 ? 0 : 1
      const whole = rowCost(row, spec) + separator
      if (spent + whole <= available) {
        sections[sectionIndex]!.rows.push(row)
        spent += whole
        count += 1
        continue
      }
      // 0.2.20 review 3: one clip level is not enough when the share is small.
      // The real 65-chapter book gave P1's foreshadow block a ~290-code-point
      // share; its nearest row clips to ~330 at 80 characters per cell, so the
      // block showed none of 97 rows. Fall back to a minimal form (24-character
      // cells, one list entry) before giving up on the row.
      let shortened = clipRow(row)
      if (JSON.stringify(shortened) === JSON.stringify(row)) break fill
      let cost = rowCost(shortened, spec) + separator
      if (spent + cost > available) {
        const minimal = clipRow(row, 1, 24, 1)
        const minimalCost = rowCost(minimal, spec) + separator
        if (spent + minimalCost > available) break fill
        shortened = minimal
        cost = minimalCost
      }
      sections[sectionIndex]!.rows.push(shortened)
      spent += cost
      count += 1
      clipped += 1
    }
  }
  return { sections, count, clipped }
}

const withShown = (
  source: unknown,
  spec: WindowSpec,
  count: number,
  sections: readonly OrderedSection[],
): unknown => {
  if (spec.kind === 'array') return (sections[0]?.rows ?? []).slice(0, count)
  const next: Record<string, unknown> = { ...(source as Record<string, unknown>) }
  let remaining = count
  for (const section of sections) {
    const take = Math.min(remaining, section.rows.length)
    next[section.section!] =
      spec.kind === 'record'
        ? Object.fromEntries((section.rows as Array<[string, unknown]>).slice(0, take))
        : section.rows.slice(0, take)
    remaining -= take
  }
  return next
}

const collectOmitted = (
  full: Record<string, unknown>,
  document: Record<string, unknown>,
  specs: readonly WindowSpec[],
  clipped: Readonly<Record<string, number>> = {},
): ContextMeta['omitted'] => {
  const omitted: ContextMeta['omitted'] = {}
  for (const spec of specs) {
    const total = totalRows(full[spec.key], spec)
    const shown = totalRows(document[spec.key], spec)
    const shortened = clipped[spec.key] ?? 0
    if (total > 0 && (shown < total || shortened > 0)) {
      omitted[spec.key] = { total, shown, ...(shortened > 0 ? { clipped: shortened } : {}) }
    }
  }
  return omitted
}

interface Measured {
  context: Record<string, unknown>
  /** Code points of `context`, the document that is actually returned. */
  cps: number
  overflow: boolean
}

/**
 * 0.2.20 WP1: required blocks that have no rows to drop.
 *
 * A 15-dimension review and a check document with dozens of findings are not
 * lists the author can page through — they are documents. Window-mode cannot
 * shrink them without lying, so above the threshold the brief keeps the part
 * that locates the work (codes, paragraph numbers, one short excerpt each) and
 * points at `novel_state` for the rest. The full document is unchanged on
 * disk: nothing here rewrites state.
 */
interface CompactSpec {
  key: string
  /** Compact only when the full block is larger than this many code points. */
  threshold: number
  render: (value: unknown) => unknown
  fetch: { kind: string; why: string }
}

const EXCERPT_LIMIT = 60

const excerptOf = (value: unknown, limit: number = EXCERPT_LIMIT): string => {
  const text = typeof value === 'string' ? value : ''
  const points = Array.from(text)
  return points.length <= limit ? text : `${points.slice(0, limit).join('')}…`
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

const countValues = (rows: unknown[], key: string): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    const value = asRecord(row)[key]
    if (typeof value === 'string') counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

const compactViolation = (row: unknown): unknown => {
  const violation = asRecord(row)
  return {
    code: violation.code,
    severity: violation.severity,
    ...(violation.id === undefined ? {} : { id: violation.id }),
    location: violation.location,
    excerpt: excerptOf(violation.detail),
    ...(Array.isArray(violation.locations) ? { merged_locations: violation.locations.length } : {}),
  }
}

/** The metric numbers rules and self-checks quote; the rest is derivable. */
const METRIC_KEYS = [
  'total_word_count',
  'cjk_chars',
  'non_empty_lines',
  'dialogue_lines',
  'dialogue_ratio',
  'dialogue_char_ratio',
  'paragraph_count',
  'paragraph_max_words',
] as const

const compactMetrics = (value: unknown): Record<string, unknown> => {
  const metrics = asRecord(value)
  const kept: Record<string, unknown> = {}
  for (const key of METRIC_KEYS) {
    if (metrics[key] !== undefined) kept[key] = metrics[key]
  }
  return kept
}

const compactCheck = (value: unknown): unknown => {
  const check = asRecord(value)
  const machine = asRecord(check.machine)
  const violations = rowsIn(machine.violations)
  const advisories = rowsIn(machine.advisories)
  const semantic = asRecord(check.semantic)
  const items = rowsIn(semantic.items)
  return {
    chapter: check.chapter,
    verdict: check.verdict,
    scope: check.scope,
    content_hash: check.content_hash,
    machine: {
      counts: {
        violations: violations.length,
        advisories: advisories.length,
        by_code: countValues(violations, 'code'),
      },
      metrics: compactMetrics(machine.metrics),
      ...(machine.dialogue === undefined ? {} : { dialogue: machine.dialogue }),
      violations: violations.slice(0, 6).map(compactViolation),
      advisories: advisories.slice(0, 4).map(compactViolation),
    },
    semantic: {
      items: items.map((item) => ({ id: asRecord(item).id, verdict: asRecord(item).verdict })),
      failing: items
        .filter((item) => asRecord(item).verdict !== 'pass')
        .map((item) => ({ id: asRecord(item).id, note: excerptOf(asRecord(item).note) })),
    },
  }
}

const REVIEW_SEVERITY_RANK: Record<string, number> = { blocker: 0, advisory: 1 }
const REVIEW_STATUS_RANK: Record<string, number> = { open: 0, fixed: 1, waived: 2 }

/**
 * Which issue rows a compacted review keeps.
 *
 * Storage order is the order the reviewer typed them in, so `slice(0, 6)` could
 * drop the only blocker. A revision that cannot see a blocker's id cannot fix it
 * and PG-08 rejects the submission with no way to learn the id from the brief.
 * Blockers first, then still-open rows, then the rest; ties keep storage order so
 * the same review always compacts to the same rows (the brief digest covers it).
 */
const orderedIssues = (issues: unknown[]): unknown[] =>
  issues
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftRow = asRecord(left.row)
      const rightRow = asRecord(right.row)
      const severity =
        (REVIEW_SEVERITY_RANK[String(leftRow.severity)] ?? 3) -
        (REVIEW_SEVERITY_RANK[String(rightRow.severity)] ?? 3)
      if (severity !== 0) return severity
      const status =
        (REVIEW_STATUS_RANK[String(leftRow.status)] ?? 3) - (REVIEW_STATUS_RANK[String(rightRow.status)] ?? 3)
      return status !== 0 ? status : left.index - right.index
    })
    .map((entry) => entry.row)

/** The row shape a compacted review keeps: same keys, clipped cells. */
const clippedIssue = (issue: unknown, cell: number): Record<string, unknown> => {
  const row = asRecord(issue)
  return {
    id: row.id,
    severity: row.severity,
    dimension: row.dimension,
    location: row.location,
    problem: excerptOf(row.problem, cell),
    ...(row.fix === undefined ? {} : { fix: excerptOf(row.fix, cell) }),
    ...(row.evidence === undefined ? {} : { evidence: excerptOf(row.evidence, 60) }),
    status: row.status,
  }
}

const issueCounts = (issues: unknown[]): Record<string, number> => {
  const byStatus = countValues(issues, 'status')
  return {
    total: issues.length,
    open: byStatus.open ?? 0,
    fixed: byStatus.fixed ?? 0,
    waived: byStatus.waived ?? 0,
  }
}

/**
 * Review -> locator form.
 *
 * `issues` stays an *array* with the same row keys as the full document; only
 * the cells are shortened. An earlier version of this function turned it into
 * `{counts, rows}`, which meant a model reading the brief had to branch on the
 * shape of the one block a revision cannot do without. The counts move to a
 * sibling `issue_counts` instead.
 */
const compactReview = (value: unknown, limit = 6): unknown => {
  const review = asRecord(value)
  const issues = orderedIssues(rowsIn(review.issues))
  return {
    ...reviewHead(review),
    issue_counts: issueCounts(rowsIn(review.issues)),
    issues: issues.slice(0, limit).map((issue) => clippedIssue(issue, 36)),
    ...(review.proof === undefined ? {} : { proof: review.proof }),
    ...(review.machine_scores === undefined ? {} : { machine_scores: review.machine_scores }),
    ...(review.amendments === undefined ? {} : { amendments: review.amendments }),
  }
}

/** Everything a compacted review keeps besides the issue rows. */
const reviewHead = (review: Record<string, unknown>): Record<string, unknown> => {
  const dimensions = rowsIn(review.dimensions)
  return {
    chapter: review.chapter,
    round: review.round,
    total: review.total,
    content_hash: review.content_hash,
    // `[id, score]` pairs, not objects: fifteen dimensions cost 675 code points
    // as objects and 250 as pairs, and P6 only needs to know which dimension is
    // short. The deductions behind a score are in `novel_state {kind:'review'}`.
    dimensions: dimensions.map((dimension) => {
      const row = asRecord(dimension)
      const deducted = rowsIn(row.deductions).reduce<number>(
        (sum, entry) =>
          sum + (typeof asRecord(entry).delta === 'number' ? (asRecord(entry).delta as number) : 0),
        0,
      )
      return [row.id, (typeof row.max === 'number' ? row.max : 0) - deducted]
    }),
  }
}

/**
 * P5 acts on the issues, so its compact form must still carry the work order.
 *
 * Dropping rows is the last resort for a revision: a blocker the brief does not
 * name is a blocker the model cannot mark `fixed`, and PG-08 then rejects the
 * submission. So the first form keeps *every* row with `problem`/`fix` clipped
 * (96 code points each is a sentence and a half — enough to act on, with the
 * full text one `novel_state` call away). Only when that still cannot fit does
 * the brief fall back to the locator rows, blockers first.
 */
const REVISION_CELL_CHARS = 96
const REVISION_REVIEW_BUDGET = 4_000

const compactReviewForRevision = (value: unknown): unknown => {
  const review = asRecord(value)
  const issues = orderedIssues(rowsIn(review.issues))
  const candidate = {
    ...reviewHead(review),
    issue_counts: issueCounts(rowsIn(review.issues)),
    issues: issues.map((issue) => clippedIssue(issue, REVISION_CELL_CHARS)),
    ...(review.proof === undefined ? {} : { proof: review.proof }),
    ...(review.machine_scores === undefined ? {} : { machine_scores: review.machine_scores }),
    ...(review.amendments === undefined ? {} : { amendments: review.amendments }),
  }
  return codepoints(candidate) <= REVISION_REVIEW_BUDGET ? candidate : compactReview(value, 10)
}

/**
 * The machine pass re-rendered: the draft's findings are the part a stage acts
 * on, and the metric echo is mostly derivable from `fields`.
 */
const compactMachine = (value: unknown): unknown => {
  const machine = asRecord(value)
  const violations = rowsIn(machine.violations)
  const advisories = rowsIn(machine.advisories)
  return {
    counts: {
      violations: violations.length,
      advisories: advisories.length,
      by_code: countValues(violations, 'code'),
    },
    metrics: compactMetrics(machine.metrics),
    violations: violations.slice(0, 6).map(compactViolation),
    ...(advisories.length === 0 ? {} : { advisories: advisories.slice(0, 4).map(compactViolation) }),
    ...(machine.dialogue === undefined ? {} : { dialogue: machine.dialogue }),
  }
}

/**
 * The P4 form of the machine pass: counts, metrics and the dialogue ratio only.
 *
 * P4 is the review stage; a format blocker never reaches it (PG-04 stopped the
 * draft at P3), so the violation rows are advisories the reviewer does not
 * score against, while the metrics are what it does. Keeping the rows cost 700
 * code points that the manuscript and the cast needed.
 */
const compactMachineMetrics = (value: unknown): unknown => {
  const machine = asRecord(value)
  const violations = rowsIn(machine.violations)
  const advisories = rowsIn(machine.advisories)
  return {
    counts: {
      violations: violations.length,
      advisories: advisories.length,
      by_code: countValues(violations, 'code'),
    },
    metrics: compactMetrics(machine.metrics),
    ...(machine.dialogue === undefined ? {} : { dialogue: machine.dialogue }),
  }
}

/** Stages that carry a whole review/check document they are not reading row by row. */
const COMPACTABLE: Record<string, readonly CompactSpec[]> = {
  P4: [
    {
      key: 'machine',
      threshold: 600,
      render: compactMachineMetrics,
      fetch: { kind: 'check', why: '机检明细只给了计数与字数指标，完整结果可读取' },
    },
    {
      key: 'check',
      threshold: 1600,
      render: compactCheck,
      fetch: { kind: 'check', why: '检查文档只给了码、位置与摘录，完整文档可读取' },
    },
  ],
  P5: [
    {
      // 0.2.20 review 4: the review was neither windowable nor compactable, so
      // thirty issues overflowed the task book while the receipt said complete.
      // The compact form keeps every blocker id (see `orderedIssues`) and points
      // at the full document for the rest.
      key: 'review',
      threshold: 900,
      render: compactReviewForRevision,
      fetch: { kind: 'review', why: '评审只列了阻断项与要点，完整问题清单可读取' },
    },
    {
      key: 'machine',
      threshold: 700,
      render: compactMachine,
      fetch: { kind: 'check', why: '机检明细只给了码与摘录，完整结果可读取' },
    },
  ],
  P6: [
    {
      key: 'check',
      threshold: 1200,
      render: compactCheck,
      fetch: { kind: 'check', why: '检查文档只给了码、位置与摘录，完整文档可读取' },
    },
    {
      key: 'review',
      threshold: 1000,
      render: compactReview,
      fetch: { kind: 'review', why: '评审文档只给了维度得分与问题摘录，完整文档可读取' },
    },
    {
      key: 'machine',
      threshold: 600,
      render: compactMachine,
      fetch: { kind: 'check', why: '机检明细只给了码与摘录，完整结果可读取' },
    },
  ],
  P8: [
    {
      key: 'check',
      threshold: 1000,
      render: compactCheck,
      fetch: { kind: 'check', why: '检查文档只给了码、位置与摘录，完整文档可读取' },
    },
    {
      key: 'review',
      threshold: 1000,
      render: compactReview,
      fetch: { kind: 'review', why: '评审文档只给了维度得分与问题摘录，完整文档可读取' },
    },
  ],
}

interface Compacted {
  document: Record<string, unknown>
  receipt: Record<string, { full: number; shown: number; why: string }>
  specs: readonly CompactSpec[]
}

/** Replace the oversized required blocks with their locator form. */
const compactBlocks = (stage: string, full: Record<string, unknown>): Compacted => {
  const document: Record<string, unknown> = { ...full }
  const receipt: Record<string, { full: number; shown: number; why: string }> = {}
  const used: CompactSpec[] = []
  for (const spec of COMPACTABLE[stage] ?? []) {
    const value = full[spec.key]
    if (value === undefined || value === null) continue
    const size = codepoints(value)
    if (size <= spec.threshold) continue
    const rendered = spec.render(value)
    document[spec.key] = rendered
    const shown = codepoints(rendered)
    receipt[spec.key] = { full: size, shown, why: spec.fetch.why }
    used.push(spec)
  }
  return { document, receipt, specs: used }
}

/**
 * Attach `context_meta` and measure to a fixpoint: `used` (bytes) and
 * `budget.used` (code points) are part of the document they measure.
 */
const measure = (
  full: Record<string, unknown>,
  document: Record<string, unknown>,
  specs: readonly WindowSpec[],
  stage: string,
  compactions: Record<string, { full: number; shown: number; why: string }> = {},
  compactSpecs: readonly CompactSpec[] = [],
  textWindow: { total: number; shown: number } | null = null,
  clipped: Readonly<Record<string, number>> = {},
): Measured => {
  const omitted = collectOmitted(full, document, specs, clipped)
  if (textWindow !== null && textWindow.shown < textWindow.total) {
    omitted.text = textWindow
  }
  const complete = Object.keys(omitted).length === 0 && Object.keys(compactions).length === 0
  const fetch = [
    ...specs
      .filter((spec) => omitted[spec.key] !== undefined)
      .map((spec) => ({
        tool: 'novel_state' as const,
        args: { kind: spec.fetch.kind, ...(spec.fetch.extra ?? {}) },
        why: spec.fetch.why,
      })),
    ...(textWindow !== null && textWindow.shown < textWindow.total
      ? [
          {
            tool: 'novel_export' as const,
            args: { kind: 'md', chapter: document.chapter },
            why: '正文超出任务书预算，只给了前几段；完整本章用 novel_export 读取',
          },
        ]
      : []),
    ...compactSpecs.map((spec) => ({
      tool: 'novel_state' as const,
      args: { kind: spec.fetch.kind, chapter: document.chapter },
      why: spec.fetch.why,
    })),
  ]
  // `overflow` answers one question: will the host prune this result? It is
  // therefore measured against the host limit, not against the smaller internal
  // allocation. 0.2.20 review: it used to be `min(budget, limit)`, so a brief
  // built to a 7,424-code-point allocation could report `overflow: true` while
  // `budget.limit` was 8,192 and `used` was below it — a receipt that
  // contradicted itself.
  const build = (used: number, budgetUsed: number, overflow: boolean): Record<string, unknown> => ({
    ...document,
    context_meta: {
      version: 2 as const,
      stage,
      used,
      complete,
      strategy: complete ? ('complete' as const) : ('windowed' as const),
      budget: {
        unit: 'codepoint' as const,
        limit: BRIEF_BUDGET_CODEPOINTS,
        used: budgetUsed,
        exempt: [],
        overflow,
      },
      omitted,
      compacted: compactions,
      fetch,
    } satisfies ContextMeta,
  })
  let used = 0
  let budgetUsed = 0
  let overflow = false
  for (let pass = 0; pass < 8; pass += 1) {
    const context = build(used, budgetUsed, overflow)
    const text = JSON.stringify(context)
    const nextUsed = Buffer.byteLength(text, 'utf8')
    const nextBudgetUsed = Array.from(text).length
    const nextOverflow = nextBudgetUsed > BRIEF_BUDGET_CODEPOINTS
    if (nextUsed === used && nextBudgetUsed === budgetUsed && nextOverflow === overflow) {
      return { context, cps: nextBudgetUsed, overflow: nextOverflow }
    }
    used = nextUsed
    budgetUsed = nextBudgetUsed
    overflow = nextOverflow
  }
  return { context: build(used, budgetUsed, overflow), cps: budgetUsed, overflow }
}

export interface BriefWindowBlock {
  block: string
  total: number
  shown: number
  /** Rows in `shown` that were shortened to fit; absent when every row is whole. */
  clipped?: number
}

/** The exact window a brief was built under; the digest signs it. */
export interface BriefWindow {
  budget: number
  blocks: BriefWindowBlock[]
}

/**
 * Build the stage-specific context pack and report the window it used.
 *
 * Service code needs both halves: the document goes into the payload, the
 * window (budget + per-block totals) goes into the signed digest, so a brief
 * signed under a different window cannot pass PG-01.
 */
export function briefContextPack(input: BriefContextInput): {
  context: Record<string, unknown>
  window: BriefWindow
} {
  const full = stageBriefContext(input)
  // `!= null`, not `!== undefined`: a null block is "this stage has no P1 plan
  // yet", and windowing it turned that into an empty object that looked like a
  // plan with nothing in it (0.2.20 review).
  const specs = (WINDOWABLE[input.stage] ?? []).filter(
    (spec) => full[spec.key] !== undefined && full[spec.key] !== null,
  )
  const budget = input.budget ?? Number.POSITIVE_INFINITY
  const activeCast = new Map<string, number>()
  if (Array.isArray(full.active_cast)) {
    for (const [index, row] of (full.active_cast as Array<{ name?: unknown }>).entries()) {
      if (typeof row.name === 'string') activeCast.set(row.name, index)
    }
  }

  if (!Number.isFinite(budget)) {
    const measured = measure(full, full, specs, input.stage)
    return {
      context: measured.context,
      window: {
        budget,
        blocks: specs.map((spec) => {
          const total = totalRows(full[spec.key], spec)
          return { block: spec.key, total, shown: total }
        }),
      },
    }
  }

  const document: Record<string, unknown> = { ...full }
  // `full: true` is the diagnostic escape hatch: it asks for everything, so it
  // keeps the documents whole and reports the overflow instead.
  const compaction = compactBlocks(input.stage, full)
  for (const key of Object.keys(compaction.receipt)) {
    document[key] = compaction.document[key]
  }
  let textWindow: { total: number; shown: number } | null = null
  /** Shortened-but-shown rows per block, accumulated as the window fills. */
  const clippedRows = new Map<string, number>()
  const clippedReceipt = (): Record<string, number> => Object.fromEntries(clippedRows)
  const measureDoc = (candidate: Record<string, unknown>): Measured =>
    measure(
      full,
      candidate,
      specs,
      input.stage,
      compaction.receipt,
      compaction.specs,
      textWindow,
      clippedReceipt(),
    )
  for (const spec of specs) {
    document[spec.key] = withShown(
      full[spec.key],
      spec,
      0,
      orderedSections(full[spec.key], spec, input.chapter, activeCast),
    )
  }
  // The manuscript comes before every optional ledger: a stage that judges the
  // chapter reads the chapter, not its timeline. It is cut last, and only by
  // paragraph, because a mid-sentence cut would corrupt the quotes PG-09
  // re-verifies. `novel_export` is the recovery path named in `fetch`.
  const rawText = typeof full.text === 'string' ? full.text : null
  if (rawText !== null && rawText !== '' && measureDoc(document).cps > budget) {
    const paragraphs = rawText.split(/\n+/)
    const joined = (count: number): string => paragraphs.slice(0, count).join('\n\n')
    let low = 0
    let high = paragraphs.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (measureDoc({ ...document, text: joined(middle) }).cps <= budget) low = middle
      else high = middle - 1
    }
    document.text = joined(low)
    textWindow = { total: paragraphs.length, shown: low }
    // The receipt row is a few dozen code points and can push a tight document
    // over; shrink the window until the measured document — receipt included —
    // really fits.
    while (textWindow.shown > 0 && measureDoc(document).cps > budget) {
      textWindow = { total: paragraphs.length, shown: textWindow.shown - 1 }
      document.text = joined(textWindow.shown)
    }
  }
  const shown = new Map<string, number>()
  /**
   * Fill one block up to `available` code points.
   *
   * Rows are kept whole while they fit; only a row that does not fit on its own
   * is shortened, and the count of shortened rows goes into the receipt (see
   * `chooseRows`).
   */
  const fillBlock = (spec: WindowSpec, available: number): void => {
    const source = full[spec.key]
    if (available <= 0) {
      shown.set(spec.key, 0)
      return
    }
    const chosen = chooseRows(source, spec, available, input.chapter, activeCast)
    let count = chosen.count
    document[spec.key] = withShown(source, spec, count, chosen.sections)
    if (measureDoc(document).cps > budget) {
      // The estimate may be a few code points optimistic once `shown` digits
      // grow; find the largest prefix of the same order that really fits.
      let low = 0
      let high = count
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        const candidate = { ...document, [spec.key]: withShown(source, spec, middle, chosen.sections) }
        if (measureDoc(candidate).cps <= budget) low = middle
        else high = middle - 1
      }
      count = low
      document[spec.key] = withShown(source, spec, count, chosen.sections)
    }
    shown.set(spec.key, count)
    // A shortened row that was then trimmed away is not shown at all; the
    // receipt must not claim it.
    if (chosen.clipped > 0) {
      clippedRows.set(spec.key, Math.min(chosen.clipped, count))
    }
  }
  for (const [specIndex, spec] of specs.entries()) {
    const source = full[spec.key]
    const total = totalRows(source, spec)
    if (total === 0) {
      shown.set(spec.key, 0)
      continue
    }
    // Reserve a few code points for the growing `shown` digits; the exact
    // check below trims to the real document, so this only avoids overshoot.
    const remaining = budget - measureDoc(document).cps - 16
    if (remaining <= 0) {
      shown.set(spec.key, 0)
      continue
    }
    // 0.2.20: fair share, not first-come. A greedy fill let the first block in
    // the list take the whole window — on a real 58-chapter book P1 showed three
    // summaries and zero of the 97 open foreshadows. Each block gets an equal
    // slice of what is left (the last one keeps the remainder), so every block
    // shows something before any block shows everything.
    //
    // 0.2.20 review: a `required` block (the active cast a stage judges against)
    // is not something to share — it fills greedily first, and reports clipped
    // rows if it cannot be shown whole. Otherwise the cast of a P4 chapter got a
    // third of the window and the brief overran the host limit anyway.
    const specsLeft = specs.length - specIndex
    const available =
      spec.required === true
        ? remaining
        : specsLeft <= 1
          ? remaining
          : Math.max(0, Math.floor(remaining / specsLeft))
    fillBlock(spec, available)
  }
  // 0.2.20 review 3: the fair share can leave a block at zero while thousands of
  // code points go unused — on the real 65-chapter book P1 gave the foreshadow
  // block a 290-code-point share and its smallest row is 224, so the block showed
  // none of 97 rows with 3,800 code points still free. After the fair pass,
  // leftover budget is handed back to every block that is still short.
  for (let pass = 0; pass < 4; pass += 1) {
    let progressed = false
    for (const spec of specs) {
      const total = totalRows(full[spec.key], spec)
      const current = shown.get(spec.key) ?? 0
      if (current >= total) continue
      const remaining = budget - measureDoc(document).cps - 16
      if (remaining <= 0) break
      // Rows already shown stay: the allowance is what they cost plus the rest.
      fillBlock(spec, codepoints(document[spec.key]) + remaining)
      if ((shown.get(spec.key) ?? 0) > current) progressed = true
    }
    if (!progressed) break
  }
  const measured = measureDoc(document)
  return {
    context: measured.context,
    window: {
      budget,
      blocks: [
        // The manuscript window is signed like any other: a brief signed while
        // the text was cut must not pass PG-01 after it grows back.
        ...(textWindow === null ? [] : [{ block: 'text', total: textWindow.total, shown: textWindow.shown }]),
        ...specs.map((spec) => ({
          block: spec.key,
          total: totalRows(full[spec.key], spec),
          shown: shown.get(spec.key) ?? totalRows(full[spec.key], spec),
          ...(clippedRows.has(spec.key) ? { clipped: clippedRows.get(spec.key) } : {}),
        })),
      ],
    },
  }
}

/** The context document alone; callers that sign the brief use the pack form. */
export function briefContext(input: BriefContextInput): Record<string, unknown> {
  return briefContextPack(input).context
}
