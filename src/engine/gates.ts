import { GATE_ORDER, GATES, type GateId } from '../codes.js'
import { LIMITS } from '../constants.js'
import { stripChapterPrefix } from './book.js'
import { canRun, roundsExhausted } from '../domain/transitions.js'
import { applyExclusions, reviewArithmeticProblems } from '../domain/scoring.js'
import { openingInFirstTwoParagraphs, splitParagraphs } from '../domain/text.js'
import {
  anchorsForGroup,
  anchorsFromSummary,
  entityMatchHint,
  matchEntityText,
  worldEntityName,
  type AnchorMap,
} from './entity-anchors.js'
import { countWordMetrics } from '../domain/wordcount.js'
import { runRules } from '../rules/pipeline.js'
import { sha256 } from '../store/fs.js'
import type { Rulepack } from '../rules/types.js'
import type { BlockingItem, GateInput, GateResult, ReadingProofReference, Stage } from '../types.js'

/** Everything gate evaluation needs beyond the input: taste comes from the pack. */
export interface GateOptions {
  rulepack: Rulepack
  minScore: number
}

const block = (code: string, detail: string, hint?: string, scope?: string): BlockingItem => ({
  code,
  detail,
  ...(hint === undefined ? {} : { hint }),
  ...(scope === undefined ? {} : { scope }),
})

type Gate = (input: GateInput, options: GateOptions) => BlockingItem[]

/** PG-01: the model must have received the current brief before submitting. */
const briefRequired: Gate = (input) => {
  // A summary-only repair deliberately changes only draft.summary. The author
  // already supplied the new summary, and no prose/P4/P6 evidence changed, so
  // requiring a fresh model-facing brief (and a new proof) would reintroduce
  // the exact P4/P6 loop this mode removes.
  if (input.summaryOnlyRevision) return []
  if (input.briefStage === null)
    return [block('PG-01', 'this operation needs a brief, but no brief stage is mapped')]
  const record = input.pipeline.briefs[input.briefStage]
  if (record === undefined) {
    return [
      block(
        'PG-01',
        `brief ${input.briefStage} has not been issued`,
        `call novel_brief with stage ${input.briefStage} first`,
      ),
    ]
  }
  if (input.briefDigest !== null && record.digest !== input.briefDigest) {
    return [
      block(
        'PG-01',
        `brief ${input.briefStage} is stale (state changed since it was issued)`,
        'call novel_brief again to refresh it',
      ),
    ]
  }
  return []
}

/** PG-02: the operation must be legal in the current pipeline stage. */
const stageOrder: Gate = (input) => {
  if (canRun(input.stage, input.operation)) return []
  return [
    block(
      'PG-02',
      `${input.operation} is not allowed at stage ${input.stage}`,
      'call novel_status to see which operation comes next',
    ),
  ]
}

/** PG-03: word count against the project's lower target. */
const wordCount: Gate = (input) => {
  const min = input.project.targets.words_per_chapter[0]
  if (min <= 0) return []
  const metrics = countWordMetrics(input.text)
  if (metrics.total_word_count >= min) return []
  return [
    block(
      'PG-03',
      `text has ${metrics.total_word_count} counted words (${metrics.cjk_chars} 汉字 + ${metrics.punctuation_chars} 标点 + ${metrics.english_words} 英文词 + ${metrics.numbers} 数字), minimum is ${min}`,
      `the engine counts punctuation as words; write at least ${min - metrics.total_word_count} more counted words, then call novel_word_count to verify the same metric`,
    ),
  ]
}

/** PG-04: format blockers must be zero before length is judged. */
const format: Gate = (input, options) => {
  if (input.scope !== undefined && !input.scope.includes('content')) return []
  const violations = runRules(
    [
      'MD_CONTAMINATION',
      'ILLEGAL_QUOTE',
      'SEMICOLON',
      'ENGLISH_ELLIPSIS',
      'SCENE_SEPARATOR',
      'LONG_PARAGRAPH',
      'TITLE_FORMAT',
      'SYSTEM_LABEL',
    ],
    input.text,
    {
      chapter: input.chapter,
      title: input.draftTitle,
      genre: input.project.genre,
      sceneType: input.sceneType ?? '日常过渡章',
      rulepack: options.rulepack,
      summary: input.summary,
      evidence: {
        characters: input.evidence.characters,
        previousText: input.previousText,
        previousTexts: input.previousTexts,
        foreshadows: input.evidence.foreshadows,
        timeline: input.evidence.timeline,
        relationships: input.evidence.relationships,
        world: input.evidence.world,
        locks: input.evidence.locks,
      },
    },
  ).filter((violation) => violation.severity === 'blocker')
  return violations.length === 0
    ? []
    : [
        block(
          'PG-04',
          `${violations.length} format blocker(s) remain`,
          `dialogue must use ASCII double quotes (U+0022), never curly quotes; split paragraphs over ${options.rulepack.format.paragraph_max_words} chars; remove full-width semicolons. ${violations.map((violation) => `${violation.code}@${violation.location.paragraph}`).join(', ')}`,
        ),
      ]
}

const SUMMARY_FIELDS = [
  'events',
  'characters_appeared',
  'foreshadows',
  'new_elements',
  'resource_changes',
  'opening',
  'continuity',
  'hook_strength',
  'pleasure_points',
  'plot_advancement',
] as const

/** PG-05: the ten summary fields exist and have the right shape. */
const summarySchema: Gate = (input) => {
  // P5 may omit the summary and reuse the one already validated at P3/P4.
  if (input.operation === 'submitRevision' && input.summaryProvided !== true) return []
  if (input.summary === null) return [block('PG-05', 'no chapter summary supplied')]
  const summary = input.summary as unknown as Record<string, unknown>
  const missing = SUMMARY_FIELDS.filter((field) => summary[field] === undefined)
  if (missing.length > 0) {
    return [
      block(
        'PG-05',
        `summary is missing ${missing.join(', ')}`,
        'fill every summary field in the draft submission',
      ),
    ]
  }
  const problems: string[] = []
  const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
  const textArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText)
  if (!textArray(summary.events) || summary.events.length === 0) {
    problems.push('events must be a non-empty array of strings')
  }
  if (!textArray(summary.characters_appeared)) problems.push('characters_appeared must be a string array')
  if (!textArray(summary.pleasure_points)) problems.push('pleasure_points must be a string array')

  const foreshadows = summary.foreshadows as Record<string, unknown> | undefined
  if (typeof foreshadows !== 'object' || foreshadows === null) {
    problems.push('foreshadows must be an object with planted/advanced/resolved')
  } else {
    const planted = foreshadows.planted
    const advanced = foreshadows.advanced
    const resolved = foreshadows.resolved
    if (
      !Array.isArray(planted) ||
      !planted.every(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          isText((item as Record<string, unknown>).key) &&
          isText((item as Record<string, unknown>).title) &&
          isText((item as Record<string, unknown>).description),
      )
    ) {
      problems.push('foreshadows.planted must contain key/title/description strings')
    }
    if (
      !Array.isArray(advanced) ||
      !advanced.every(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          isText((item as Record<string, unknown>).key) &&
          isText((item as Record<string, unknown>).note) &&
          typeof (item as Record<string, unknown>).new_info === 'boolean',
      )
    ) {
      problems.push('foreshadows.advanced must contain key/note/new_info')
    }
    if (!Array.isArray(resolved) || !resolved.every(isText)) {
      problems.push('foreshadows.resolved must be a string array')
    }
    if (Array.isArray(planted)) {
      const keys = planted.map((item) => (item as Record<string, unknown>).key)
      if (new Set(keys).size !== keys.length) problems.push('foreshadows.planted contains a duplicate key')
    }
  }

  const newElements = summary.new_elements as Record<string, unknown> | undefined
  if (typeof newElements !== 'object' || newElements === null) {
    problems.push('new_elements must be an object')
  } else {
    let anchorMap: AnchorMap | null = null
    try {
      anchorMap = anchorsFromSummary(summary)
    } catch (error) {
      problems.push(error instanceof Error ? error.message : 'new_element_anchors is invalid')
    }
    for (const key of ['locations', 'abilities', 'artifacts'] as const) {
      if (!textArray(newElements[key])) problems.push(`new_elements.${key} must be a string array`)
      for (const name of textArray(newElements[key]) ? newElements[key] : []) {
        const anchors = anchorMap === null ? [] : anchorsForGroup(anchorMap, key, name)
        const match = matchEntityText(input.text, name, anchors)
        if (!match.ok) {
          problems.push(`new_elements.${key} lists "${name}", but ${entityMatchHint(name, anchors)}`)
        }
        if (input.operation !== 'archiveChapter') {
          const ledger = input.evidence.world
          const already =
            ledger !== null &&
            [ledger.locations, ledger.abilities, ledger.artifacts, ledger.factions, ledger.rules].some(
              (rows) => rows.some((row) => worldEntityName(row) === name),
            )
          if (already) {
            problems.push(
              `new_elements.${key} lists "${name}", but state/world.yaml already has it; remove it or use updated/no_change`,
            )
          }
        }
      }
    }
  }

  if (textArray(summary.characters_appeared)) {
    const narrator = input.pipeline.draft?.narrator ?? ''
    for (const name of summary.characters_appeared) {
      const alias =
        narrator.includes(name) &&
        (narrator.includes('第一人称') || narrator.includes('「我」')) &&
        input.text.includes('我')
      if (!input.text.includes(name) && !alias) {
        problems.push(`characters_appeared lists "${name}", but the manuscript never mentions it`)
      }
    }
  }

  const resources = summary.resource_changes
  if (
    !Array.isArray(resources) ||
    !resources.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        isText((item as Record<string, unknown>).character) &&
        isText((item as Record<string, unknown>).resource) &&
        Number.isInteger((item as Record<string, unknown>).delta) &&
        (item as Record<string, unknown>).delta !== 0 &&
        isText((item as Record<string, unknown>).reason),
    )
  ) {
    problems.push('resource_changes must contain character/resource/non-zero delta/reason')
  }

  if (!isText(summary.opening)) {
    problems.push('opening must be text')
  } else {
    const opening = summary.opening
    if (Array.from(opening).length < LIMITS.minQuoteChars) {
      problems.push(`opening must be at least ${LIMITS.minQuoteChars} characters`)
    }
    if (!openingInFirstTwoParagraphs(input.text, opening)) {
      problems.push('opening must be quoted from the first two paragraphs')
    }
  }

  const continuity = summary.continuity as Record<string, unknown> | undefined
  if (typeof continuity !== 'object' || continuity === null) {
    problems.push('continuity must be an object')
  } else {
    if (!isText(continuity.opens_from)) problems.push('continuity.opens_from must be text')
    if (!isText(continuity.ends_with)) problems.push('continuity.ends_with must be text')
  }

  if (
    !Number.isInteger(summary.hook_strength) ||
    (summary.hook_strength as number) < 1 ||
    (summary.hook_strength as number) > 5
  ) {
    problems.push('hook_strength must be 1..5')
  }
  if (!['high', 'mid', 'low'].includes(summary.plot_advancement as string)) {
    problems.push('plot_advancement must be high|mid|low')
  }
  return problems.length === 0 ? [] : [block('PG-05', problems.join('; '))]
}

/** PG-06: a valid scene type and no monotony across chapters. */
const sceneType: Gate = (input) => {
  if (input.sceneType === null) return [block('PG-06', 'scene_type is required')]
  const recent = input.priorSceneTypes.slice(-2)
  const problems: string[] = []
  if (recent.length === 2 && recent.every((type) => type === input.sceneType)) {
    problems.push(`three chapters in a row use "${input.sceneType}"`)
  }
  if (input.sceneType === '战斗/动作章' && recent[recent.length - 1] === '战斗/动作章') {
    problems.push('action chapters cannot run two in a row')
  }
  return problems.length === 0 ? [] : [block('PG-06', problems.join('; '), 'pick a different scene type')]
}

/**
 * PG-13: once the book has a chapter card, the plan and draft must honour it.
 * A strict outline also means "no card, no chapter"; a non-strict outline only
 * checks the cards that exist.
 */
const outlineAlignment: Gate = (input) => {
  const outline = input.outline
  if (outline === undefined || outline === null) return []
  const card = outline.chapters.find((candidate) => candidate.num === input.chapter)
  if (card === undefined) {
    if (!outline.book.strict) return []
    return [
      block(
        'PG-13',
        `chapter ${input.chapter} has no outline card while strict mode is on`,
        'read novel_state {kind:"outline"}, then submit only the missing card with novel_outline (upsert by num; omitted cards are kept); do not turn strict off',
      ),
    ]
  }
  const problems: string[] = []
  if (card.status === 'archived') {
    problems.push(
      `chapter ${input.chapter} is already archived but is still the active chapter; call novel_reopen first`,
    )
  }
  const title = input.draftTitle === null ? null : stripChapterPrefix(input.draftTitle)
  if (title !== null && title !== card.title) {
    problems.push(`title "${title}" does not match the card "${card.title}"`)
  }
  if (input.sceneType !== null && input.sceneType !== card.scene_type) {
    problems.push(`scene_type "${input.sceneType}" does not match the card "${card.scene_type}"`)
  }
  const planned = input.planTargetWords ?? input.project.targets.words_per_chapter
  if (
    planned !== null &&
    planned !== undefined &&
    Math.max(planned[0], card.target_words[0]) > Math.min(planned[1], card.target_words[1])
  ) {
    problems.push(
      `target_words ${planned[0]}-${planned[1]} does not overlap the card ${card.target_words[0]}-${card.target_words[1]}`,
    )
  }
  if (card.cast.length > 0) {
    const cast = new Set(input.planCast ?? [])
    const missing = card.cast.filter((name) => !cast.has(name))
    if (missing.length > 0) {
      problems.push(`cast is missing card member(s): ${missing.join(', ')}`)
    }
  }
  return problems.length === 0
    ? []
    : [
        block(
          'PG-13',
          problems.join('; '),
          'update the outline card with novel_outline, or update the chapter plan; archived chapters need novel_reopen',
        ),
      ]
}

/** Parse "第 12 段" into 12; null when the location is not a paragraph reference. */
export function parseParagraphLocation(location: string): number | null {
  const match = /第\s*(\d+)\s*段/.exec(location)
  return match === null ? null : Number(match[1])
}

/** PG-07: arithmetic closes, every deduction locates, and the score clears the bar. */
const score: Gate = (input, options) => {
  const review = input.review
  if (review === null) return [block('PG-07', 'no review document supplied')]
  if (!Array.isArray(review.dimensions)) return [block('PG-07', 'review dimensions must be an array')]
  const problems = reviewArithmeticProblems(review.dimensions, review.total)
  // `submitReview` stores the normalized dimensions. A later edit that adds
  // both sides of an exclusion pair (and adjusts the total to match) is not a
  // valid review even though its arithmetic closes.
  const normalized = applyExclusions(review.dimensions, options.rulepack.exclusions)
  if (normalized.dropped > 0) {
    problems.push(
      'review contains mutually exclusive or duplicate deductions; resubmit it through novel_review',
    )
  }
  if (review.content_hash !== sha256(input.text)) {
    problems.push('review content_hash does not match the current manuscript')
  }
  const paragraphCount = splitParagraphs(input.text).length
  for (const dimension of review.dimensions) {
    if (typeof dimension !== 'object' || dimension === null || !Array.isArray(dimension.deductions)) continue
    for (const deduction of dimension.deductions) {
      if (typeof deduction !== 'object' || deduction === null || typeof deduction.location !== 'string')
        continue
      const paragraph = parseParagraphLocation(deduction.location)
      if (paragraph === null) {
        problems.push(`${dimension.id}: location "${deduction.location}" is not a paragraph reference`)
      } else if (paragraph < 1 || paragraph > paragraphCount) {
        problems.push(`${dimension.id}: location "${deduction.location}" is outside the chapter`)
      }
    }
  }
  const minScore = options.minScore
  // A sub-threshold review is still a valid P4 result: it must be able to move
  // the pipeline to P5 for revision. The floor is enforced at the archive
  // boundary, not by refusing the honest review that reports it.
  if (input.operation !== 'submitReview' && review.total < minScore) {
    problems.push(`score ${review.total} is below the minimum ${minScore}`)
  }
  return problems.length === 0
    ? []
    : [block('PG-07', problems.join('; '), 'fix the deductions and the total, then resubmit')]
}

/** PG-08: blocker issues must be fixed with evidence that exists in the text. */
const issuesCleared: Gate = (input) => {
  if (input.review === null) return []
  if (!Array.isArray(input.review.issues)) {
    return [block('PG-08', 'review issues must be an array')]
  }
  const blockers = input.review.issues.filter((issue) => issue.severity === 'blocker')
  const problems: string[] = []
  for (const issue of blockers) {
    if (issue.status === 'waived') {
      problems.push(`${issue.id} is a blocker and cannot be waived`)
      continue
    }
    if (issue.status !== 'fixed') {
      problems.push(`${issue.id} is still ${issue.status}`)
      continue
    }
    if (typeof issue.evidence !== 'string' || issue.evidence.trim() === '') {
      problems.push(`${issue.id} is fixed but has no evidence quote`)
      continue
    }
    if (Array.from(issue.evidence.trim()).length < 8) {
      problems.push(`${issue.id} evidence is shorter than 8 characters`)
      continue
    }
    if (!input.text.includes(issue.evidence)) {
      problems.push(`${issue.id} cites evidence that is not in the text`)
    }
  }
  return problems.length === 0
    ? []
    : [block('PG-08', problems.join('; '), 'mark every blocker fixed and quote the revised text as evidence')]
}

/** Paragraph index (1-based) nearest the reference when the quote repeats, or -1. */
function actualParagraph(text: string, reference: ReadingProofReference): number {
  if (typeof reference !== 'object' || reference === null || typeof reference.quote !== 'string') return -1
  const quote = reference.quote.trim()
  if (Array.from(quote).length < LIMITS.minQuoteChars) return -1
  const matches = splitParagraphs(text)
    .map((paragraph, index) => ({ paragraph, index }))
    .filter(({ paragraph }) => paragraph.includes(quote))
  if (matches.length === 0) return -1
  const target = Number.isInteger(reference.paragraph) && reference.paragraph > 0 ? reference.paragraph : 1
  const nearest = matches.reduce((best, match) =>
    Math.abs(match.index + 1 - target) < Math.abs(best.index + 1 - target) ? match : best,
  )
  return nearest.index + 1
}

/** Verify one reading-proof reference against the manuscript. */
export function verifyReference(text: string, reference: ReadingProofReference): string | null {
  if (typeof reference !== 'object' || reference === null) return 'reading proof reference is not an object'
  if (typeof reference.quote !== 'string') return 'reading proof quote is not text'
  if (!Number.isInteger(reference.paragraph) || reference.paragraph < 1) {
    return 'reading proof paragraph must be a positive integer'
  }
  const quote = reference.quote.trim()
  if (Array.from(quote).length < LIMITS.minQuoteChars) {
    return `quote "${reference.quote}" is shorter than ${LIMITS.minQuoteChars} characters`
  }
  const paragraphs = splitParagraphs(text)
  const matches = paragraphs
    .map((paragraph, index) => ({ paragraph, index }))
    .filter(({ paragraph }) => paragraph.includes(quote))
  if (matches.length === 0) return `quote "${quote}" does not appear in the text`
  const nearest = matches.reduce((best, match) =>
    Math.abs(match.index + 1 - reference.paragraph) < Math.abs(best.index + 1 - reference.paragraph)
      ? match
      : best,
  )
  if (Math.abs(nearest.index + 1 - reference.paragraph) > 1) {
    return `quote "${quote}" is at paragraph ${nearest.index + 1}, not ${reference.paragraph}`
  }
  return null
}

/** PG-09: three verifiable quotes from three distinct paragraphs. */
const readingProof: Gate = (input) => {
  if (input.proof === null) return [block('PG-09', 'no reading proof supplied')]
  if (
    typeof input.proof !== 'object' ||
    input.proof === null ||
    [input.proof.opening, input.proof.middle, input.proof.ending].some(
      (reference) =>
        typeof reference !== 'object' ||
        reference === null ||
        typeof reference.quote !== 'string' ||
        !Number.isInteger(reference.paragraph),
    )
  ) {
    return [block('PG-09', 'reading proof must contain opening/middle/ending quote references')]
  }
  const problems: string[] = []
  const opening = verifyReference(input.text, input.proof.opening)
  const middle = verifyReference(input.text, input.proof.middle)
  const ending = verifyReference(input.text, input.proof.ending)
  for (const problem of [opening, middle, ending]) if (problem !== null) problems.push(problem)
  const paragraphs = splitParagraphs(input.text).length
  const actuals = [input.proof.opening, input.proof.middle, input.proof.ending].map((reference) =>
    actualParagraph(input.text, reference),
  )
  // The submitted paragraph is a locator hint with ±1 tolerance. The boundary
  // claim itself must use where the quote actually is, or three paragraphs can
  // be shifted by one to turn a middle quote into an "opening" quote.
  if (actuals[0]! > 2) problems.push('the opening quote must come from the first two paragraphs')
  // "Middle" must be an interior paragraph, not merely a third distinct one.
  // Short chapters need a relaxation: with four paragraphs, 2/3 are both
  // interior; with five or more, the first two and last two are excluded.
  const middleMin = paragraphs <= 4 ? 2 : 3
  const middleMax = paragraphs <= 4 ? Math.max(2, paragraphs - 1) : paragraphs - 2
  if (actuals[1]! > 0 && (actuals[1]! < middleMin || actuals[1]! > middleMax)) {
    problems.push('the middle quote must come from the body of the chapter, not its first or last edges')
  }
  if (actuals[2]! > 0 && actuals[2]! < Math.max(1, paragraphs - 1)) {
    problems.push('the ending quote must come from the last two paragraphs')
  }
  if (new Set(actuals.filter((index) => index > 0)).size < 3) {
    problems.push('the three quotes must come from three distinct paragraphs')
  }
  return problems.length === 0
    ? []
    : [block('PG-09', problems.join('; '), 'quote at least 12 characters from the real paragraph you read')]
}

/** PG-10: cross-chapter reconciliation must be clean. */
const consistency: Gate = (input, options) => {
  if (input.scope !== undefined && !input.scope.includes('integrity')) return []
  const violations = runRules(
    [
      'DUPLICATE_PARAGRAPH',
      'FORESHADOW_DORMANT',
      'FS_REVISITED_TOO_SOON',
      'RESOURCE_MISMATCH',
      'TIME_REGRESSION',
      'RELATION_UNKNOWN',
      'LOCKED_DETAIL_DRIFT',
    ],
    input.text,
    {
      chapter: input.chapter,
      title: input.draftTitle,
      genre: input.project.genre,
      sceneType: input.sceneType ?? '日常过渡章',
      rulepack: options.rulepack,
      summary: input.summary,
      evidence: {
        characters: input.evidence.characters,
        previousText: input.previousText,
        previousTexts: input.previousTexts,
        foreshadows: input.evidence.foreshadows,
        timeline: input.evidence.timeline,
        relationships: input.evidence.relationships,
        world: input.evidence.world,
        locks: input.evidence.locks,
      },
    },
  )
  if (violations.length === 0) return []
  const blockers = violations.filter((violation) => violation.severity === 'blocker')
  if (blockers.length === 0) return []
  return [
    block(
      'PG-10',
      blockers.map((violation) => `${violation.code}: ${violation.detail}`).join('; '),
      'reconcile the manuscript with state/ before archiving',
    ),
  ]
}

/** PG-11: the review/revise budget is enforced by the engine, not self-reported. */
const rounds: Gate = (input) => {
  if (input.summaryOnly === true) return []
  const relevant =
    input.operation === 'submitReview' ||
    input.operation === 'submitRevision' ||
    input.operation === 'runCheck'
  if (!relevant) return []
  const counter =
    input.operation === 'submitReview' ? 'review' : input.operation === 'submitRevision' ? 'revise' : 'check'
  if (!roundsExhausted(input.rounds, counter)) return []
  return [
    block(
      'PG-11',
      `round limits reached for ${counter} (review ${input.rounds.review}, revise ${input.rounds.revise}, check ${input.rounds.check})`,
      'call novel_rollback to restart the chapter; the manuscript is kept for reference',
    ),
  ]
}

/** PG-12: the archive transaction's preconditions, checked before staging. */
const archiveAtomic: Gate = (input) => {
  if (input.operation !== 'archiveChapter') return []
  if (input.archive === null) return [block('PG-12', 'archive preconditions were not gathered')]
  const problems: string[] = []
  if (input.archive.chapterExists) problems.push('this chapter is already in the index')
  if (!input.archive.checkPassed) problems.push('the check document has not passed')
  if (!input.archive.hashMatches) problems.push('the manuscript changed since the check was written')
  if (
    input.check === null ||
    !Array.isArray(input.check.scope) ||
    !input.check.scope.includes('content') ||
    !input.check.scope.includes('integrity')
  ) {
    problems.push('the check document did not cover content+integrity')
  }
  return problems.length === 0
    ? []
    : [
        block(
          'PG-12',
          problems.join('; '),
          'call novel_rollback to P6, then re-run novel_check on the current manuscript',
        ),
      ]
}

/** Fixed order; evaluation collects every failure instead of stopping at the first. */
const GATE_FUNCTIONS: Readonly<Record<GateId, Gate>> = {
  'PG-01': briefRequired,
  'PG-02': stageOrder,
  'PG-03': wordCount,
  'PG-04': format,
  'PG-05': summarySchema,
  'PG-06': sceneType,
  'PG-07': score,
  'PG-08': issuesCleared,
  'PG-09': readingProof,
  'PG-10': consistency,
  'PG-11': rounds,
  'PG-12': archiveAtomic,
  'PG-13': outlineAlignment,
}

/** Evaluate all thirteen gates and return every blocking item, in canonical order. */
export function evaluateGates(input: GateInput, options: GateOptions): GateResult {
  const applicable = new Set(applicableGates(input))
  const blocking: BlockingItem[] = []
  for (const id of GATE_ORDER) {
    if (!applicable.has(id)) continue
    const gate = GATE_FUNCTIONS[id]
    for (const item of gate(input, options)) blocking.push({ ...item, scope: item.scope ?? GATES[id] })
  }
  return { passed: blocking.length === 0, blocking }
}

/**
 * Which gates apply to an operation. A gate that does not apply must not run:
 * judging word count on a world plan would block every plan.
 */
export function applicableGates(input: GateInput): GateId[] {
  const always: GateId[] = ['PG-01', 'PG-02']
  switch (input.operation) {
    case 'submitChapterPlan':
      return [...always, 'PG-13']
    case 'submitDraft':
      return [...always, 'PG-04', 'PG-03', 'PG-05', 'PG-06', 'PG-13']
    case 'submitRevision':
      return input.summaryOnly === true
        ? [...always, 'PG-04', 'PG-03', 'PG-05', 'PG-06']
        : [...always, 'PG-04', 'PG-03', 'PG-05', 'PG-09', 'PG-08', 'PG-11']
    case 'submitReview':
      return [...always, 'PG-09', 'PG-07', 'PG-11']
    case 'runCheck':
      // A check is an archive precursor: it must not pass a manuscript that is
      // below the word floor or no longer matches the review it claims to
      // validate. Archive still re-runs these gates as the final boundary.
      return [...always, 'PG-04', 'PG-03', 'PG-05', 'PG-06', 'PG-07', 'PG-08', 'PG-09', 'PG-10', 'PG-11']
    case 'archiveChapter':
      return [
        'PG-01',
        'PG-02',
        'PG-04',
        'PG-03',
        'PG-05',
        'PG-06',
        'PG-07',
        'PG-08',
        'PG-09',
        'PG-10',
        'PG-12',
        'PG-13',
      ]
    default:
      return always
  }
}

/** Human-facing label of a gate id, used by status and the panel. */
export function gateName(id: GateId): string {
  return GATES[id]
}

/** Which brief stage an operation requires; `null` means no brief gate. */
export function briefStageFor(operation: GateInput['operation'], stage: Stage): GateInput['briefStage'] {
  switch (operation) {
    case 'submitWorldPlan':
      return 'P1'
    case 'submitChapterPlan':
      return 'P2'
    case 'submitDraft':
      return 'P3'
    case 'submitReview':
      return 'P4'
    case 'submitRevision':
      return stage === 'P6' ? 'P6' : 'P5'
    case 'runCheck':
      return 'P6'
    case 'archiveChapter':
      return 'P8'
    default:
      return null
  }
}
