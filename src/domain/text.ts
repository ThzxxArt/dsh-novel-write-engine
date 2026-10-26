/** Paragraph splitting is the unit of every location the engine reports. */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** Sentence splitting uses Chinese and English terminators; empty runs collapse. */
export function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?]+/)
    .map((sentence) => sentence.trim())
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
