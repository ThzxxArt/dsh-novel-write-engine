import { splitParagraphs } from './text.js'
import type { WordMetrics } from '../types.js'

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g
const ENGLISH_WORD = /[A-Za-z]+/g
const NUMBER = /(?<![A-Za-z0-9])[0-9]+(?![A-Za-z0-9])/g
const CHINESE_PUNCT = /[\u3000-\u303f\uff00-\uffef]/g
const ENGLISH_PUNCT = /[^\p{L}\p{N}_\s\u3000-\u303f\uff00-\uffef]/gu

const matchCount = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0

/**
 * The one word-count rule of the engine.
 *
 * Punctuation counts (that is how commercial platforms count), numbers count
 * only as standalone sequences so `ABC123` is one English word and zero numbers,
 * and the two punctuation ranges are mutually exclusive by construction.
 */
export function countWordMetrics(text: string): WordMetrics {
  const lines = text.split('\n')
  const nonEmptyLines = lines.filter((line) => line.trim() !== '')
  const cjkChars = matchCount(text, CJK)
  const englishWords = matchCount(text, ENGLISH_WORD)
  const numbers = matchCount(text, NUMBER)
  const chinesePunct = matchCount(text, CHINESE_PUNCT)
  const englishPunct = matchCount(text, ENGLISH_PUNCT)
  const dialogueLines = nonEmptyLines.filter((line) => line.includes('"')).length
  const paragraphs = splitParagraphs(text)

  return {
    total_word_count: cjkChars + englishWords + numbers + chinesePunct + englishPunct,
    cjk_chars: cjkChars,
    english_words: englishWords,
    numbers,
    chinese_punct: chinesePunct,
    english_punct: englishPunct,
    non_ws_chars: matchCount(text, /\S/g),
    total_lines: lines.length,
    non_empty_lines: nonEmptyLines.length,
    dialogue_lines: dialogueLines,
    dialogue_ratio: nonEmptyLines.length === 0 ? 0 : dialogueLines / nonEmptyLines.length,
    paragraph_count: paragraphs.length,
    paragraph_max_words: paragraphs.reduce((max, p) => Math.max(max, countWordMetricsOfParagraph(p)), 0),
  }
}

/** Word count for a single paragraph, used by the long-paragraph rule. */
export function countWordMetricsOfParagraph(paragraph: string): number {
  return (
    matchCount(paragraph, CJK) +
    matchCount(paragraph, ENGLISH_WORD) +
    matchCount(paragraph, NUMBER) +
    matchCount(paragraph, CHINESE_PUNCT) +
    matchCount(paragraph, ENGLISH_PUNCT)
  )
}

/** Plain character count used when a caller explicitly wants characters. */
export function countCharacters(text: string): number {
  return Array.from(text).length
}
