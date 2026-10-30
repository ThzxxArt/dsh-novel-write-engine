import { textSimilarity } from '../domain/simhash.js'
import { splitParagraphs } from '../domain/text.js'
import { ERROR_CODES, EngineInputError, type BlockingItem, type SemanticItem } from '../types.js'

/** The five checks the P6 task book requires; a subset cannot pass. */
export const SEMANTIC_CHECK_IDS = [
  'L2-SCENE-ANCHOR',
  'L2-CHARACTER-STATE',
  'L2-CAUSALITY',
  'L2-VOICE',
  'L2-POV',
] as const

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
  conflict_with?: string
}

export interface SemanticEvaluation {
  items: SemanticItemResult[]
  /** Content findings only; these are written to a check document. */
  findings: BlockingItem[]
  /** Findings for every failed item, used by the archive preflight compatibility path. */
  blocking: BlockingItem[]
  submission_failed: boolean
  content_failed: boolean
  failed: boolean
}

/**
 * A caller supplied evidence that cannot be evaluated as a content judgement.
 * It must never be persisted as a failed check or consume a content round.
 */
export class CheckSubmissionError extends EngineInputError {
  readonly items: SemanticItemResult[]
  readonly passed: number
  readonly failed: number
  readonly rounds_consumed = 0 as const
  readonly failure_class = 'submission' as const

  constructor(items: SemanticItemResult[]) {
    const passed = items.filter((item) => item.state === 'pass').length
    const failed = items.filter((item) => item.state !== 'pass' && item.state !== 'fail').length
    const first = items.find((item) => item.state !== 'pass' && item.state !== 'fail')
    super(
      ERROR_CODES.CHECK_SUBMISSION_INVALID,
      `semantic submission is invalid: ${first?.id ?? 'semantic'} ${first?.state ?? 'invalid'}${
        first?.detail === undefined ? '' : ` (${first.detail})`
      }; ${passed} passed, ${failed} failed; no check was written and no round was consumed`,
      'resubmit novel_check with all five semantic items; each needs a distinct verbatim quote of at least 8 characters',
    )
    this.items = items
    this.passed = passed
    this.failed = failed
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

interface SentenceSpan {
  start: number
  end: number
  paragraph: number
}

const CLOSING_PUNCTUATION = new Set(['」', '』', '”', '"', '’', "'", '）', ')', '】', ']'])

/**
 * Split text into sentence spans while treating every non-empty line as a
 * paragraph boundary. A quote may cover multiple sentences or paragraphs; the
 * spans are only used to prove that no two evidence items reuse the same
 * passage. Trailing closing quotes belong to the sentence they terminate.
 */
function sentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = []
  let paragraph = 1
  let lineStart = 0
  let sentenceStart = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (char === '\n') {
      if (text.slice(lineStart, index).trim() !== '') {
        if (index > sentenceStart) spans.push({ start: sentenceStart, end: index, paragraph })
        paragraph += 1
      }
      lineStart = index + 1
      sentenceStart = index + 1
      continue
    }
    if ('。！？!?'.includes(char)) {
      let end = index + 1
      while (end < text.length && CLOSING_PUNCTUATION.has(text[end]!)) end += 1
      spans.push({ start: sentenceStart, end, paragraph })
      sentenceStart = end
      index = end - 1
    }
  }
  if (sentenceStart < text.length) {
    spans.push({ start: sentenceStart, end: text.length, paragraph })
  }
  return spans
}

function nearestParagraph(text: string, quote: string): SemanticNearest | null {
  const paragraphs = splitParagraphs(text)
  let best: { index: number; paragraph: string; score: number } | null = null
  for (const [index, paragraph] of paragraphs.entries()) {
    const score = textSimilarity(paragraph, quote)
    if (best === null || score > best.score) best = { index, paragraph, score }
  }
  if (best === null) return null
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

/**
 * Validate and evaluate all five L2 semantic items.
 *
 * Evidence is located by character range, not by requiring one sentence. Two
 * items may not overlap or reuse a sentence; a quote that exists but fails
 * those rules is reported as OVERLAP/SAME_SENTENCE instead of the old generic
 * "overlapping text or the same sentence" message.
 */
export function evaluateSemantic(text: string, input: unknown): SemanticEvaluation {
  const items: SemanticItemResult[] = []
  const spans: Array<{ start: number; end: number; id: string }> = []
  const sentences = sentenceSpans(text)
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
    const duplicate = acceptedQuotes.get(quote)
    if (duplicate !== undefined) {
      items.push({
        id,
        state: 'duplicate',
        quote,
        conflict_with: duplicate,
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

    let accepted: { start: number; end: number; id: string } | null = null
    let overlapWith: string | undefined
    let sameSentenceWith: string | undefined
    let boundary = false
    for (const start of occurrences) {
      const end = start + quote.length
      const conflict = spans.find((span) => start < span.end && span.start < end)
      if (conflict !== undefined) {
        overlapWith ??= conflict.id
        continue
      }
      const covered = sentences
        .map((sentence, sentenceIndex) => ({ sentence, sentenceIndex }))
        .filter(({ sentence }) => start < sentence.end && sentence.start < end)
      if (covered.length === 0) {
        boundary = true
        continue
      }
      const used = covered.find(({ sentenceIndex }) => usedSentences.has(sentenceIndex))
      if (used !== undefined) {
        sameSentenceWith ??= usedSentences.get(used.sentenceIndex)
        continue
      }
      accepted = { start, end, id }
      for (const { sentenceIndex } of covered) usedSentences.set(sentenceIndex, id)
      break
    }

    if (accepted === null) {
      if (overlapWith !== undefined) {
        items.push({
          id,
          state: 'overlap',
          quote,
          conflict_with: overlapWith,
          detail: `${id} overlaps ${overlapWith}'s accepted evidence interval`,
        })
      } else if (sameSentenceWith !== undefined) {
        items.push({
          id,
          state: 'same_sentence',
          quote,
          conflict_with: sameSentenceWith,
          detail: `${id} reuses a sentence already cited by ${sameSentenceWith}`,
        })
      } else {
        items.push({
          id,
          state: boundary ? 'boundary' : 'same_sentence',
          quote,
          ...(boundary ? {} : { conflict_with: id }),
          detail: boundary
            ? `${id} cannot be mapped onto a sentence boundary`
            : `${id} reuses a sentence already cited by another item`,
        })
      }
      continue
    }

    spans.push(accepted)
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
  for (const id of seenIds) {
    if (!(SEMANTIC_CHECK_IDS as readonly string[]).includes(id)) {
      items.push({ id, state: 'invalid', detail: `${id} is not one of the required P6 semantic checks` })
    }
  }

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
    ...findings,
  ]
  return {
    items,
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
    throw new CheckSubmissionError(evaluation.items)
  }
  return evaluation
}
