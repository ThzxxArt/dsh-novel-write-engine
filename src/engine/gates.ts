import { GATE_ORDER, GATES, type GateId } from '../codes.js'
import { LIMITS } from '../constants.js'
import { canRun, roundsExhausted } from '../domain/transitions.js'
import { reviewArithmeticProblems } from '../domain/scoring.js'
import { splitParagraphs } from '../domain/text.js'
import { countWordMetrics } from '../domain/wordcount.js'
import { runRules } from '../rules/pipeline.js'
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
      `text has ${metrics.total_word_count} words, minimum is ${min}`,
      `write at least ${min - metrics.total_word_count} more words, then call novel_word_count to verify`,
    ),
  ]
}

/** PG-04: format blockers must be zero before length is judged. */
const format: Gate = (input, options) => {
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
          violations.map((violation) => `${violation.code}@${violation.location.paragraph}`).join(', '),
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
    for (const key of ['locations', 'abilities', 'artifacts'] as const) {
      if (!textArray(newElements[key])) problems.push(`new_elements.${key} must be a string array`)
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
    const firstTwo = splitParagraphs(input.text).slice(0, 2)
    if (!firstTwo.some((paragraph) => paragraph.includes(opening))) {
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

/** Parse "第 12 段" into 12; null when the location is not a paragraph reference. */
export function parseParagraphLocation(location: string): number | null {
  const match = /第\s*(\d+)\s*段/.exec(location)
  return match === null ? null : Number(match[1])
}

/** PG-07: arithmetic closes, every deduction locates, and the score clears the bar. */
const score: Gate = (input, options) => {
  const review = input.review
  if (review === null) return [block('PG-07', 'no review document supplied')]
  const problems = reviewArithmeticProblems(review.dimensions, review.total)
  const paragraphCount = splitParagraphs(input.text).length
  for (const dimension of review.dimensions) {
    for (const deduction of dimension.deductions) {
      const paragraph = parseParagraphLocation(deduction.location)
      if (paragraph === null) {
        problems.push(`${dimension.id}: location "${deduction.location}" is not a paragraph reference`)
      } else if (paragraph < 1 || paragraph > paragraphCount) {
        problems.push(`${dimension.id}: location "${deduction.location}" is outside the chapter`)
      }
    }
  }
  const minScore = options.minScore
  if (review.total < minScore) problems.push(`score ${review.total} is below the minimum ${minScore}`)
  return problems.length === 0
    ? []
    : [block('PG-07', problems.join('; '), 'fix the deductions and the total, then resubmit')]
}

/** PG-08: blocker issues must be fixed with evidence that exists in the text. */
const issuesCleared: Gate = (input) => {
  if (input.review === null) return []
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
    if (issue.evidence === undefined || issue.evidence.trim() === '') {
      problems.push(`${issue.id} is fixed but has no evidence quote`)
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

/** Paragraph index (1-based) that contains the quote, or -1. */
function actualParagraph(text: string, reference: ReadingProofReference): number {
  const quote = reference.quote.trim()
  if (Array.from(quote).length < LIMITS.minQuoteChars) return -1
  return splitParagraphs(text).findIndex((paragraph) => paragraph.includes(quote)) + 1
}

/** Verify one reading-proof reference against the manuscript. */
export function verifyReference(text: string, reference: ReadingProofReference): string | null {
  const quote = reference.quote
  if (Array.from(quote.trim()).length < LIMITS.minQuoteChars) {
    return `quote "${quote}" is shorter than ${LIMITS.minQuoteChars} characters`
  }
  const paragraphs = splitParagraphs(text)
  const actual = paragraphs.findIndex((paragraph) => paragraph.includes(quote))
  if (actual === -1) return `quote "${quote}" does not appear in the text`
  if (Math.abs(actual + 1 - reference.paragraph) > 1) {
    return `quote "${quote}" is at paragraph ${actual + 1}, not ${reference.paragraph}`
  }
  return null
}

/** PG-09: three verifiable quotes from three distinct paragraphs. */
const readingProof: Gate = (input) => {
  if (input.proof === null) return [block('PG-09', 'no reading proof supplied')]
  const problems: string[] = []
  const opening = verifyReference(input.text, input.proof.opening)
  const middle = verifyReference(input.text, input.proof.middle)
  const ending = verifyReference(input.text, input.proof.ending)
  for (const problem of [opening, middle, ending]) if (problem !== null) problems.push(problem)
  const paragraphs = splitParagraphs(input.text).length
  if (input.proof.opening.paragraph > 2)
    problems.push('the opening quote must come from the first two paragraphs')
  if (input.proof.ending.paragraph < Math.max(1, paragraphs - 1)) {
    problems.push('the ending quote must come from the last two paragraphs')
  }
  const actuals = [input.proof.opening, input.proof.middle, input.proof.ending].map((reference) =>
    actualParagraph(input.text, reference),
  )
  if (new Set(actuals.filter((index) => index > 0)).size < 3) {
    problems.push('the three quotes must come from three distinct paragraphs')
  }
  return problems.length === 0
    ? []
    : [block('PG-09', problems.join('; '), 'quote at least 12 characters from the real paragraph you read')]
}

/** PG-10: cross-chapter reconciliation must be clean. */
const consistency: Gate = (input, options) => {
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
  const relevant =
    input.operation === 'submitReview' ||
    input.operation === 'submitRevision' ||
    input.operation === 'runCheck'
  if (!relevant) return []
  if (!roundsExhausted(input.rounds)) return []
  return [
    block(
      'PG-11',
      `round limits reached (review ${input.rounds.review}, revise ${input.rounds.revise}, check ${input.rounds.check})`,
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
  return problems.length === 0
    ? []
    : [block('PG-12', problems.join('; '), 're-run novel_check on the current manuscript')]
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
}

/** Evaluate all twelve gates and return every blocking item, in canonical order. */
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
    case 'submitDraft':
      return [...always, 'PG-04', 'PG-03', 'PG-05', 'PG-06']
    case 'submitRevision':
      return [...always, 'PG-04', 'PG-03', 'PG-09', 'PG-08']
    case 'submitReview':
      return [...always, 'PG-09', 'PG-07', 'PG-11']
    case 'runCheck':
      return [...always, 'PG-10']
    case 'archiveChapter':
      return ['PG-01', 'PG-02', 'PG-04', 'PG-03', 'PG-05', 'PG-06', 'PG-07', 'PG-08', 'PG-10', 'PG-12']
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
