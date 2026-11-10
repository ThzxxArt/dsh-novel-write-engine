/** Paragraph splitting is the unit of every location the engine reports. */
export function splitParagraphs(text: string): string[] {
  return paragraphSpans(text).map((span) => span.text)
}

/** One paragraph with its exact source offsets; `start`/`end` exclude the blank margin. */
export interface ParagraphSpan {
  start: number
  end: number
  text: string
}

const isSpace = (char: string): boolean => char === '\u3000' || /\s/u.test(char)

/**
 * Offset-preserving paragraph view. `splitParagraphs` is the string-only
 * convenience view of it; evidence matching needs the offsets to map a hit
 * back to a paragraph without re-scanning the manuscript.
 */
export function paragraphSpans(text: string): ParagraphSpan[] {
  const spans: ParagraphSpan[] = []
  let lineStart = 0
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    let start = lineStart
    let end = lineEnd
    while (start < end && isSpace(text[start]!)) start += 1
    while (end > start && isSpace(text[end - 1]!)) end -= 1
    if (end > start) spans.push({ start, end, text: text.slice(start, end) })
    if (newline === -1) break
    lineStart = newline + 1
  }
  return spans
}

/** 1-based paragraph containing `offset`; the last paragraph when past the end. */
export function paragraphAtOffset(spans: readonly ParagraphSpan[], offset: number): number {
  for (const [index, span] of spans.entries()) {
    if (offset < span.end) return index + 1
  }
  return Math.max(1, spans.length)
}

/** One sentence occurrence with exact source offsets and 1-based paragraph. */
export interface SentenceSpan {
  start: number
  end: number
  paragraph: number
  text: string
}

const SENTENCE_TERMINATOR = /[。！？!?]+|…+|\.(?=\s|$)/g
const SENTENCE_CLOSERS = new Set(['」', '』', '”', '"', '’', "'", '）', ')', '】', ']'])

/**
 * Sentence boundaries have one owner. This offset-preserving variant is used
 * by semantic evidence and any caller that must map a quote back to a
 * paragraph; `splitSentences` is the string-only convenience view of it.
 */
export function splitSentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = []
  let paragraph = 1
  let lineStart = 0
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    const line = text.slice(lineStart, lineEnd)
    if (line.trim() !== '') {
      let cursor = 0
      while (cursor < line.length) {
        SENTENCE_TERMINATOR.lastIndex = cursor
        const match = SENTENCE_TERMINATOR.exec(line)
        let rawEnd = match === null ? line.length : match.index + match[0].length
        while (rawEnd < line.length && SENTENCE_CLOSERS.has(line[rawEnd]!)) rawEnd += 1
        let start = cursor
        while (start < rawEnd && /\s/.test(line[start]!)) start += 1
        const body = line.slice(start, rawEnd).trimEnd()
        const end = start + body.length
        if (body !== '') {
          spans.push({
            start: lineStart + start,
            end: lineStart + end,
            paragraph,
            text: body,
          })
        }
        cursor = rawEnd
      }
      paragraph += 1
    }
    if (newline === -1) break
    lineStart = newline + 1
  }
  return spans
}

/** Sentence splitting uses Chinese and English terminators; empty runs collapse. */
export function splitSentences(text: string): string[] {
  return splitSentenceSpans(text)
    .map((span) =>
      span.text
        .replace(/([。！？!?]+|…+|\.)$/u, '')
        .replace(/[」』”"'’）)】\]]+$/u, '')
        .trim(),
    )
    .filter((sentence) => sentence !== '')
}

/** Character length of each sentence, in document order. */
export function sentenceLengths(sentences: readonly string[]): number[] {
  return sentences.map((sentence) => Array.from(sentence).length)
}

/** A coarse descriptor used by the rhythm profile and the uniform-sentence rule. */
export interface SentenceRhythm {
  count: number
  average: number
  min: number
  max: number
  /** Share of sentences whose length lands within +/- 2 of the average. */
  uniformRatio: number
}

/** Compute the rhythm profile of a text; never throws on empty input. */
export function sentenceRhythm(text: string): SentenceRhythm {
  const lengths = sentenceLengths(splitSentences(text))
  if (lengths.length === 0) return { count: 0, average: 0, min: 0, max: 0, uniformRatio: 0 }
  const sum = lengths.reduce((total, length) => total + length, 0)
  const average = sum / lengths.length
  const uniform = lengths.filter((length) => Math.abs(length - average) <= 2).length
  return {
    count: lengths.length,
    average,
    min: Math.min(...lengths),
    max: Math.max(...lengths),
    uniformRatio: uniform / lengths.length,
  }
}

/** Paragraph numbers are 1-based and refer to non-empty lines, matching `splitParagraphs`. */
/** Share of a paragraph's characters that sit inside legal straight quotes. */
export function dialogueCharacterRatio(paragraph: string): number {
  const total = Array.from(paragraph).length
  if (total === 0) return 0
  let quoted = 0
  for (const match of paragraph.matchAll(/["“]([^"“”]*)["”]/g)) {
    quoted += Array.from(match[1]!).length
  }
  return quoted / total
}

export function paragraphAt(text: string, paragraph: number): string | null {
  const paragraphs = splitParagraphs(text)
  if (!Number.isInteger(paragraph) || paragraph < 1 || paragraph > paragraphs.length) return null
  return paragraphs[paragraph - 1]!
}

/**
 * The opening quote rule is shared by PG-05 (draft/revise) and the P5 fast
 * check. Keeping one implementation prevents the two paths from disagreeing
 * about what counts as the first two paragraphs.
 */
export function openingInFirstTwoParagraphs(text: string, opening: string): boolean {
  const needle = opening.trim()
  if (needle === '') return false
  return splitParagraphs(text)
    .slice(0, 2)
    .some((paragraph) => paragraph.includes(needle))
}

/* ------------------------------------------------------------ evidence match */

/** Fold every quote style to the one legal ASCII form. */
export function normalizeQuoteStyle(text: string): string {
  return text
    .replace(/[“”«»]/g, '"')
    .replace(/[「」『』]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[−–—]/g, '-')
    .replace(/…{2,}|\.{3,}/g, '…')
}

/** Ignore whitespace differences, including line breaks inside a quote. */
export function normalizeEvidenceText(text: string): string {
  return normalizeQuoteStyle(text).replace(/\s+/g, '')
}

/** One character-level fold shared by the plain and the offset-preserving normalizer. */
const QUOTE_FOLD: Readonly<Record<string, string>> = {
  '“': '"',
  '”': '"',
  '«': '"',
  '»': '"',
  '「': '"',
  '」': '"',
  '『': '"',
  '』': '"',
  '‘': "'",
  '’': "'",
  '−': '-',
  '–': '-',
  '—': '-',
}

/**
 * The normalized string plus, for every normalized character, the offset of
 * the source character that produced it. Evidence matching needs both: the
 * comparison runs on the folded text, while every reported location, sentence
 * id and interval must be expressed in manuscript offsets.
 */
interface NormalizedText {
  value: string
  offsets: number[]
}

function normalizeWithOffsets(text: string): NormalizedText {
  const value: string[] = []
  const offsets: number[] = []
  const push = (char: string, at: number): void => {
    value.push(char)
    offsets.push(at)
  }
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (char === '…') {
      let end = index
      while (end < text.length && text[end] === '…') end += 1
      push('…', index)
      index = end - index >= 2 ? end : index + 1
      continue
    }
    if (char === '.') {
      let end = index
      while (end < text.length && text[end] === '.') end += 1
      if (end - index >= 3) {
        push('…', index)
        index = end
        continue
      }
      push('.', index)
      index += 1
      continue
    }
    const folded = QUOTE_FOLD[char] ?? char
    if (!isSpace(folded)) push(folded, index)
    index += 1
  }
  return { value: value.join(''), offsets }
}

/** How a quote was located: exact text, normalized text, or across a line break. */
export type EvidenceMatchVia = 'exact' | 'normalized' | 'crossline'

/** One located occurrence in manuscript offsets. */
export interface EvidenceOccurrence {
  start: number
  end: number
  /** 1-based paragraph the occurrence starts in. */
  paragraph: number
  via: EvidenceMatchVia
}

export interface EvidenceMatch {
  found: boolean
  /** 1-based paragraph the quote starts in. */
  paragraph: number | null
  via: EvidenceMatchVia | null
  /** Paragraph range the occurrence covers; only a crossline hit spans two. */
  span?: { from: number; to: number }
  /** Closest paragraph when the quote was not found. */
  nearest?: { paragraph: number; text: string; offset: number; similarity: number }
}

/** Longest common substring length; small inputs only (quotes and paragraphs). */
function commonSubstringLength(left: string, right: string): number {
  // Callers pass a non-empty quote and a non-empty paragraph; the empty case is
  // handled before this function is reached.
  const a = Array.from(left)
  const b = Array.from(right)
  let best = 0
  let previous = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        const run = (previous[j - 1] as number) + 1
        current[j] = run
        if (run > best) best = run
      }
    }
    previous = current
  }
  return best
}

/**
 * Every place a quote occurs, in manuscript offsets.
 *
 * Three passes, in decreasing strictness: the raw text, the quote/whitespace
 * normalized text, then **adjacent paragraph pairs only**. The old
 * implementation joined every paragraph into one string, so a quote could be
 * stitched together from any two paragraphs of the chapter and still be
 * "verbatim"; limiting the join to a real neighbour pair keeps the legitimate
 * case (dialogue split by an action beat) without inventing text.
 */
export function evidenceOccurrences(text: string, quote: string): EvidenceOccurrence[] {
  const needle = quote.trim()
  if (needle === '') return []
  const spans = paragraphSpans(text)
  const push = (results: EvidenceOccurrence[], start: number, end: number, via: EvidenceMatchVia): void => {
    results.push({ start, end, paragraph: paragraphAtOffset(spans, start), via })
  }
  const exact: EvidenceOccurrence[] = []
  let at = text.indexOf(needle)
  while (at !== -1) {
    push(exact, at, at + needle.length, 'exact')
    at = text.indexOf(needle, at + 1)
  }
  if (exact.length > 0) return exact

  // `needle` is already trimmed and non-empty; folding quotes and stripping
  // spaces cannot empty it, so there is no second emptiness check here.
  const normalizedNeedle = normalizeEvidenceText(needle)

  // The normalized pass is per paragraph. Running it over the concatenated
  // chapter would delete every paragraph break and re-create the very splice
  // this function exists to forbid.
  const normalized: EvidenceOccurrence[] = []
  for (const span of spans) {
    const normalizedParagraph = normalizeWithOffsets(span.text)
    let hit = normalizedParagraph.value.indexOf(normalizedNeedle)
    while (hit !== -1) {
      push(
        normalized,
        span.start + normalizedParagraph.offsets[hit]!,
        span.start + normalizedParagraph.offsets[hit + normalizedNeedle.length - 1]! + 1,
        'normalized',
      )
      hit = normalizedParagraph.value.indexOf(normalizedNeedle, hit + 1)
    }
  }
  if (normalized.length > 0) return normalized

  const crossline: EvidenceOccurrence[] = []
  for (let index = 0; index + 1 < spans.length; index += 1) {
    const left = spans[index]!
    const right = spans[index + 1]!
    const pair = normalizeWithOffsets(text.slice(left.start, right.end))
    let pairHit = pair.value.indexOf(normalizedNeedle)
    while (pairHit !== -1) {
      push(
        crossline,
        left.start + pair.offsets[pairHit]!,
        left.start + pair.offsets[pairHit + normalizedNeedle.length - 1]! + 1,
        'crossline',
      )
      pairHit = pair.value.indexOf(normalizedNeedle, pairHit + 1)
    }
  }
  return crossline
}

/**
 * One matcher shared by PG-08 evidence, PG-09 reading proof, the P6 semantic
 * checks and delta anchors. A quote copied from the manuscript must not be
 * rejected because the model typed a curly quote or split it across a line,
 * and it must not be accepted because two unrelated paragraphs were glued.
 */
export function matchEvidence(text: string, quote: string): EvidenceMatch {
  const needle = quote.trim()
  if (needle === '') return { found: false, paragraph: null, via: null }
  const spans = paragraphSpans(text)
  const occurrences = evidenceOccurrences(text, needle)
  const first = occurrences[0]
  if (first !== undefined) {
    return {
      found: true,
      paragraph: first.paragraph,
      via: first.via,
      span: { from: first.paragraph, to: paragraphAtOffset(spans, first.end - 1) },
    }
  }
  let best: EvidenceMatch['nearest']
  for (const [index, paragraph] of spans.entries()) {
    const length = commonSubstringLength(normalizeEvidenceText(needle), normalizeEvidenceText(paragraph.text))
    const similarity = length / Math.max(1, Array.from(normalizeEvidenceText(needle)).length)
    if (best === undefined || similarity > best.similarity) {
      best = {
        paragraph: index + 1,
        text: Array.from(paragraph.text).slice(0, 30).join(''),
        offset: length,
        similarity,
      }
    }
  }
  return { found: false, paragraph: null, via: null, ...(best === undefined ? {} : { nearest: best }) }
}

/** Reading-proof floor: an 8-character Chinese quote is a real read; ASCII needs 12. */
export function quoteMeetsFloor(quote: string, minChars = 8): boolean {
  const trimmed = quote.trim()
  if (trimmed === '') return false
  const cjk = (trimmed.match(/[\u3400-\u9fff]/g) ?? []).length
  if (cjk >= minChars) return true
  return Array.from(trimmed).length >= Math.max(12, minChars)
}
