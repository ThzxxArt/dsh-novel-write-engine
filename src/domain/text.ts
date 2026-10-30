/** Paragraph splitting is the unit of every location the engine reports. */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
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
