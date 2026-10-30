import { bigramSimilarity } from '../domain/simhash.js'
import { splitParagraphs, splitSentenceSpans, type SentenceSpan } from '../domain/text.js'
import { ERROR_CODES, EngineInputError, type BlockingItem, type SemanticItem } from '../types.js'

/** The five checks the P6 task book requires; a subset cannot pass. */
export const SEMANTIC_CHECK_IDS = [
  'L2-SCENE-ANCHOR',
  'L2-CHARACTER-STATE',
  'L2-CAUSALITY',
  'L2-VOICE',
  'L2-POV',
] as const

/** A short evidence interval may share this many characters before it is "meaningful". */
export const SEMANTIC_OVERLAP_MIN_CHARS = 8
/** A longer evidence interval must share at least this share of the shorter quote. */
export const SEMANTIC_OVERLAP_RATIO = 0.5
/** Below this Dice similarity, a nearest paragraph would be a misleading coincidence. */
export const SEMANTIC_NEAREST_MIN_SCORE = 0.5

export type SemanticItemState =
  | 'pass'
  | 'fail'
  | 'missing'
  | 'invalid'
  | 'not_found'
  | 'too_short'
  | 'duplicate'
  | 'overlap'
  | 'same_sentence'
  | 'boundary'

export type SemanticConflictKind = 'duplicate' | 'same_sentence' | 'interval_overlap'

export interface SemanticConflict {
  kind: SemanticConflictKind
  other_id: string
  /** Only for interval_overlap; a verbatim excerpt, capped at 120 characters. */
  overlap_text?: string
  overlap_chars?: number
  /** overlap_chars / min(quoteA, quoteB), 0..1. */
  overlap_ratio?: number
  paragraphs?: number[]
  /** Only for same_sentence. */
  sentence?: { id: number; text: string; paragraph: number }
}

export interface SemanticNearest {
  paragraph: number
  quote: string
  score: number
}

export interface SemanticItemResult {
  id: string
  state: SemanticItemState
  quote?: string
  detail?: string
  nearest?: SemanticNearest
  /** Kept for older adapters; the full pair is in `conflicts`. */
  conflict_with?: string
  conflicts?: SemanticConflict[]
}

export interface SemanticEvaluation {
  items: SemanticItemResult[]
  conflicts: SemanticConflict[]
  /** Content findings only; these are written to a check document. */
  findings: BlockingItem[]
  /** Findings for every failed item, used by the archive preflight compatibility path. */
  blocking: BlockingItem[]
  submission_failed: boolean
  content_failed: boolean
  failed: boolean
}

const conflictSummary = (itemId: string, conflict: SemanticConflict): string => {
  const pair = `${itemId}↔${conflict.other_id}`
  if (conflict.kind === 'same_sentence') {
    const where =
      conflict.sentence === undefined
        ? ''
        : ` at paragraph ${conflict.sentence.paragraph} sentence ${conflict.sentence.id}`
    return `${pair} same sentence${where}`
  }
  if (conflict.kind === 'duplicate') return `${pair} exact duplicate`
  const chars = conflict.overlap_chars ?? 0
  const ratio = conflict.overlap_ratio === undefined ? '' : ` (${Math.round(conflict.overlap_ratio * 100)}%)`
  const where =
    conflict.paragraphs === undefined || conflict.paragraphs.length === 0
      ? ''
      : ` at paragraph ${conflict.paragraphs.join('/')}`
  return `${pair} overlaps ${chars} chars${ratio}${where}`
}

/**
 * A caller supplied evidence that cannot be evaluated as a content judgement.
 * It must never be persisted as a failed check or consume a content round.
 */
export class CheckSubmissionError extends EngineInputError {
  readonly items: SemanticItemResult[]
  readonly passed: number
  readonly failed: number
  readonly conflicts: SemanticConflict[]
  readonly blocking: BlockingItem[]
  readonly rounds_consumed = 0 as const
  readonly failure_class = 'submission' as const

  constructor(items: SemanticItemResult[], blocking?: BlockingItem[]) {
    const passed = items.filter((item) => item.state === 'pass').length
    const failed = items.filter((item) => item.state !== 'pass' && item.state !== 'fail').length
    const first = items.find((item) => item.state !== 'pass' && item.state !== 'fail')
    const conflicts = items.flatMap((item) => item.conflicts ?? [])
    const summaries = items
      .flatMap((item) => (item.conflicts ?? []).map((conflict) => conflictSummary(item.id, conflict)))
      .slice(0, 5)
    super(
      ERROR_CODES.CHECK_SUBMISSION_INVALID,
      `semantic submission is invalid: ${first?.id ?? 'semantic'} ${first?.state ?? 'invalid'}${
        first?.detail === undefined ? '' : ` (${first.detail})`
      }${summaries.length === 0 ? '' : `; conflicts: ${summaries.join('; ')}`}; ${passed} passed, ${failed} failed; no check was written and no round was consumed`,
      'resubmit novel_check with all five semantic items; use distinct quotes from different sentences and paragraphs, and never reuse a sentence for two dimensions',
    )
    this.items = items
    this.passed = passed
    this.failed = failed
    this.conflicts = conflicts
    this.blocking =
      blocking ??
      items
        .filter((item) => submissionState(item.state))
        .map((item) => ({
          code: codeForState(item.state),
          scope: 'check',
          detail: detailFor(item),
        }))
  }
}

/** Extract the quoted part of an evidence string, tolerating "第 N 段：" labels. */
export function evidenceQuote(value: string): string {
  let candidate = value.trim()
  const labelled = /^第\s*\d+\s*段\s*[：:]\s*/.exec(candidate)
  if (labelled !== null) candidate = candidate.slice(labelled[0].length)
  candidate = candidate.trim()
  candidate = candidate
    .replace(/^[「『“"']/, '')
    .replace(/[」』”"']$/, '')
    .trim()
  return candidate
}

function nearestParagraph(text: string, quote: string): SemanticNearest | null {
  const paragraphs = splitParagraphs(text)
  let best: { index: number; paragraph: string; score: number } | null = null
  for (const [index, paragraph] of paragraphs.entries()) {
    const score = bigramSimilarity(paragraph, quote)
    if (best === null || score > best.score) best = { index, paragraph, score }
  }
  if (best === null || best.score < SEMANTIC_NEAREST_MIN_SCORE) return null
  return {
    paragraph: best.index + 1,
    quote: Array.from(best.paragraph).slice(0, 120).join(''),
    score: Math.round(best.score * 1000) / 1000,
  }
}

const submissionState = (state: SemanticItemState): boolean => state !== 'pass' && state !== 'fail'

const codeForState = (state: SemanticItemState): string => {
  switch (state) {
    case 'not_found':
      return 'SEMANTIC_EVIDENCE_NOT_FOUND'
    case 'too_short':
      return 'SEMANTIC_EVIDENCE_TOO_SHORT'
    case 'duplicate':
      return 'SEMANTIC_EVIDENCE_DUPLICATE'
    case 'overlap':
      return 'SEMANTIC_EVIDENCE_OVERLAP'
    case 'same_sentence':
      return 'SEMANTIC_EVIDENCE_SAME_SENTENCE'
    case 'missing':
      return 'SEMANTIC_MISSING'
    case 'boundary':
      return 'SEMANTIC_EVIDENCE_BOUNDARY'
    default:
      return 'SEMANTIC_ITEM_INVALID'
  }
}

const detailFor = (result: SemanticItemResult): string => {
  if (result.detail !== undefined) return result.detail
  switch (result.state) {
    case 'not_found':
      return `${result.id} cites a quote that does not appear verbatim in the manuscript`
    case 'too_short':
      return `${result.id} quotes fewer than 8 characters`
    case 'duplicate':
      return `${result.id} repeats ${result.conflict_with ?? 'another item'}'s quote`
    case 'overlap':
      return `${result.id} overlaps ${result.conflict_with ?? 'another item'}'s accepted evidence interval`
    case 'same_sentence':
      return `${result.id} reuses a sentence already cited by ${result.conflict_with ?? 'another item'}`
    case 'boundary':
      return `${result.id} cannot be mapped onto a sentence boundary`
    case 'missing':
      return `${result.id} is required by the P6 task book`
    default:
      return `${result.id} is invalid`
  }
}

interface AcceptedSpan {
  start: number
  end: number
  id: string
  quote: string
  sentenceIds: number[]
}

const sentenceIdsFor = (sentences: readonly SentenceSpan[], start: number, end: number): number[] =>
  sentences
    .map((sentence, index) => ({ sentence, index }))
    .filter(({ sentence }) => start < sentence.end && sentence.start < end)
    .map(({ index }) => index)

const paragraphsFor = (sentences: readonly SentenceSpan[], start: number, end: number): number[] => {
  const values = new Set<number>()
  for (const sentence of sentences) {
    if (start < sentence.end && sentence.start < end) values.add(sentence.paragraph)
  }
  return [...values].sort((left, right) => left - right)
}

const intervalOverlap = (
  start: number,
  end: number,
  other: AcceptedSpan,
): { start: number; end: number; chars: number; ratio: number; contains: boolean } => {
  const overlapStart = Math.max(start, other.start)
  const overlapEnd = Math.min(end, other.end)
  const overlapChars = Math.max(0, overlapEnd - overlapStart)
  const minLength = Math.min(end - start, other.end - other.start)
  return {
    start: overlapStart,
    end: overlapEnd,
    chars: overlapChars,
    ratio: minLength === 0 ? 0 : overlapChars / minLength,
    contains: (start <= other.start && end >= other.end) || (other.start <= start && other.end >= end),
  }
}

/**
 * Evaluate all five L2 semantic items.
 *
 * Sentence boundaries come from the domain owner. A failure never consumes an
 * interval or a sentence, so one bad quote cannot cascade into the next item.
 * Exact duplicate, same-sentence reuse and meaningful interval overlap are
 * distinct, pair-level conflicts; merely sharing a few words in different
 * sentences is not a conflict.
 */
export function evaluateSemantic(text: string, input: unknown): SemanticEvaluation {
  const items: SemanticItemResult[] = []
  const accepted: AcceptedSpan[] = []
  const sentences = splitSentenceSpans(text)
  const usedSentences = new Map<number, string>()
  const seenIds = new Set<string>()
  const acceptedQuotes = new Map<string, string>()
  const rawItems: unknown[] = Array.isArray(input) ? input : []

  if (!Array.isArray(input)) {
    items.push({
      id: 'semantic',
      state: 'invalid',
      detail: 'semantic must be an array of five items',
    })
  }

  for (const [index, raw] of rawItems.entries()) {
    const where = `semantic[${index}]`
    if (typeof raw !== 'object' || raw === null) {
      items.push({ id: where, state: 'invalid', detail: `${where} is not an object` })
      continue
    }
    const item = raw as Partial<SemanticItem>
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      items.push({ id: where, state: 'invalid', detail: `${where} has no id` })
      continue
    }
    const id = item.id.trim()
    if (seenIds.has(id)) {
      items.push({ id, state: 'invalid', detail: `${id} is declared twice` })
      continue
    }
    seenIds.add(id)
    if (item.verdict !== 'pass' && item.verdict !== 'fail') {
      items.push({
        id,
        state: 'invalid',
        detail: `${id} has verdict ${String(item.verdict)}; expected pass|fail`,
      })
      continue
    }
    if (typeof item.evidence !== 'string' || item.evidence.trim() === '') {
      items.push({ id, state: 'invalid', detail: `${id} has no evidence quote` })
      continue
    }
    const quote = evidenceQuote(item.evidence)
    if (Array.from(quote).length < 8) {
      items.push({ id, state: 'too_short', quote, detail: `${id} quotes fewer than 8 characters` })
      continue
    }
    if (!(SEMANTIC_CHECK_IDS as readonly string[]).includes(id)) {
      items.push({ id, state: 'invalid', detail: `${id} is not one of the required P6 semantic checks` })
      continue
    }
    const duplicate = acceptedQuotes.get(quote)
    if (duplicate !== undefined) {
      const conflict: SemanticConflict = { kind: 'duplicate', other_id: duplicate }
      items.push({
        id,
        state: 'duplicate',
        quote,
        conflict_with: duplicate,
        conflicts: [conflict],
        detail: `${id} repeats ${duplicate}'s quote exactly`,
      })
      continue
    }

    const occurrences: number[] = []
    let found = text.indexOf(quote)
    while (found !== -1) {
      occurrences.push(found)
      found = text.indexOf(quote, found + 1)
    }
    if (occurrences.length === 0) {
      const nearest = nearestParagraph(text, quote)
      items.push({
        id,
        state: 'not_found',
        quote,
        ...(nearest === null ? {} : { nearest }),
        detail: `${id} cites "${Array.from(quote).slice(0, 40).join('')}", which does not appear verbatim in the manuscript`,
      })
      continue
    }

    let acceptedSpan: AcceptedSpan | null = null
    const conflicts: SemanticConflict[] = []
    for (const start of occurrences) {
      const end = start + quote.length
      const sentenceIds = sentenceIdsFor(sentences, start, end)
      if (sentenceIds.length === 0) {
        continue
      }
      let rejected = false
      for (const other of accepted) {
        const overlap = intervalOverlap(start, end, other)
        const minLength = Math.min(quote.length, other.quote.length)
        const threshold = Math.max(SEMANTIC_OVERLAP_MIN_CHARS, Math.ceil(SEMANTIC_OVERLAP_RATIO * minLength))
        if (overlap.chars > 0 && (overlap.contains || overlap.chars >= threshold)) {
          conflicts.push({
            kind: 'interval_overlap',
            other_id: other.id,
            overlap_text: Array.from(text.slice(overlap.start, overlap.end)).slice(0, 120).join(''),
            overlap_chars: overlap.chars,
            overlap_ratio: Math.round(overlap.ratio * 1000) / 1000,
            paragraphs: paragraphsFor(sentences, overlap.start, overlap.end),
          })
          rejected = true
        }
      }
      if (!rejected) {
        for (const sentenceId of sentenceIds) {
          const owner = usedSentences.get(sentenceId)
          if (owner !== undefined) {
            const sentence = sentences[sentenceId]!
            conflicts.push({
              kind: 'same_sentence',
              other_id: owner,
              sentence: { id: sentenceId + 1, text: sentence.text, paragraph: sentence.paragraph },
            })
            rejected = true
          }
        }
      }
      if (!rejected) {
        acceptedSpan = { start, end, id, quote, sentenceIds }
        break
      }
    }

    if (acceptedSpan === null) {
      const unique = new Map<string, SemanticConflict>()
      for (const conflict of conflicts) {
        const key = `${conflict.kind}:${conflict.other_id}:${conflict.overlap_chars ?? ''}:${conflict.sentence?.id ?? ''}`
        unique.set(key, conflict)
      }
      const all = [...unique.values()]
      const overlap = all.find((conflict) => conflict.kind === 'interval_overlap')
      const same = all.find((conflict) => conflict.kind === 'same_sentence')
      const chosen = overlap ?? same
      const state: SemanticItemState =
        overlap !== undefined ? 'overlap' : same !== undefined ? 'same_sentence' : 'boundary'
      items.push({
        id,
        state,
        quote,
        ...(chosen === undefined ? {} : { conflict_with: chosen.other_id }),
        ...(all.length === 0 ? {} : { conflicts: all }),
        detail:
          chosen === undefined
            ? `${id} cannot be mapped onto a sentence boundary`
            : `${id} ${chosen.kind} with ${chosen.other_id}`,
      })
      continue
    }

    accepted.push(acceptedSpan)
    for (const sentenceId of acceptedSpan.sentenceIds) usedSentences.set(sentenceId, id)
    acceptedQuotes.set(quote, id)
    items.push({
      id,
      state: item.verdict === 'fail' ? 'fail' : 'pass',
      quote,
      ...(item.verdict === 'fail'
        ? {
            detail: `${id}: ${
              typeof item.note === 'string' && item.note.trim() !== '' ? item.note : 'semantic check failed'
            }`,
          }
        : {}),
    })
  }

  for (const id of SEMANTIC_CHECK_IDS) {
    if (!seenIds.has(id)) {
      items.push({ id, state: 'missing', detail: `${id} is required by the P6 task book` })
    }
  }

  const conflicts = items.flatMap((item) => item.conflicts ?? [])
  const findings: BlockingItem[] = items
    .filter((item) => item.state === 'fail')
    .map((item) => ({
      code: 'SEMANTIC_CHECK_FAILED',
      scope: 'check',
      detail: item.detail ?? `${item.id}: semantic check failed`,
    }))
  const submissionItems = items.filter((item) => submissionState(item.state))
  const blocking: BlockingItem[] = [
    ...submissionItems.map((item) => ({
      code: codeForState(item.state),
      scope: 'check',
      detail: detailFor(item),
    })),
    ...submissionItems.flatMap((item) =>
      (item.conflicts ?? []).slice(0, 5).map((conflict) => ({
        code: codeForState(item.state),
        scope: 'check',
        detail: `${item.id}: ${conflictSummary(item.id, conflict)}`,
      })),
    ),
    ...findings,
  ]
  return {
    items,
    conflicts,
    findings,
    blocking,
    submission_failed: submissionItems.length > 0,
    content_failed: findings.length > 0,
    failed: blocking.length > 0,
  }
}

/** Throw a typed submission error when shape/evidence errors exist. */
export function validateSemanticSubmission(text: string, input: unknown): SemanticEvaluation {
  const evaluation = evaluateSemantic(text, input)
  if (evaluation.submission_failed) {
    throw new CheckSubmissionError(evaluation.items, evaluation.blocking)
  }
  return evaluation
}
