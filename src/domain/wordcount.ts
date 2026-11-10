import { splitParagraphs } from './text.js'
import type { WordMetrics } from '../types.js'

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g
const ENGLISH_WORD = /[A-Za-z]+/g
const NUMBER = /(?<![A-Za-z0-9])[0-9]+(?![A-Za-z0-9])/g
/**
 * 0.2.17: U+3000 is an indent, not punctuation. Counting it made every
 * indented paragraph two words longer, so a 1,900-word chapter passed a
 * 2,000-word floor. The range now starts at U+3001.
 */
const CHINESE_PUNCT = /[\u3001-\u303f\uff00-\uffef\u2018\u2019\u201c\u201d\u2014\u2026]/g
const INDENT = /\u3000/g
const ENGLISH_PUNCT = /[^\p{L}\p{N}_\s\u3000-\u303f\uff00-\uffef\u2018\u2019\u201c\u201d\u2014\u2026]/gu
/** A line participates in dialogue if it contains any of the four common quote pairs. */
const DIALOGUE_MARKS = /["“”「」『』]/
const DIALOGUE_SPAN = /["“「『]([\s\S]*?)["”」』]/g

const matchCount = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0

/**
 * The one whitespace predicate. `\s` already covers U+3000, but the indent is
 * named explicitly so a future regex change cannot silently make it a word.
 */
export const isBlank = (char: string): boolean => char === '\u3000' || /\s/u.test(char)

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
  const indentChars = matchCount(text, INDENT)
  const dialogueLines = nonEmptyLines.filter((line) => DIALOGUE_MARKS.test(line)).length
  const paragraphs = splitParagraphs(text)
  const punctuation = chinesePunct + englishPunct
  const dialogueChars = Array.from(text.matchAll(DIALOGUE_SPAN)).reduce(
    (total, match) => total + match[1]!.replace(/\s+/g, '').length,
    0,
  )
  const nonWsChars = Array.from(text).filter((char) => !isBlank(char)).length
  const dialogueQuotes = matchCount(text, /["“”「」『』]/g)

  return {
    total_word_count: cjkChars + englishWords + numbers + punctuation,
    cjk_chars: cjkChars,
    english_words: englishWords,
    numbers,
    chinese_punct: chinesePunct,
    english_punct: englishPunct,
    punctuation_chars: punctuation,
    non_ws_chars: nonWsChars,
    total_lines: lines.length,
    non_empty_lines: nonEmptyLines.length,
    dialogue_lines: dialogueLines,
    dialogue_ratio: nonEmptyLines.length === 0 ? 0 : dialogueLines / nonEmptyLines.length,
    paragraph_count: paragraphs.length,
    paragraph_max_words: paragraphs.reduce((max, p) => Math.max(max, countWordMetricsOfParagraph(p)), 0),
    dialogue_chars: dialogueChars,
    dialogue_char_ratio: nonWsChars === 0 ? 0 : Math.min(1, dialogueChars / nonWsChars),
    indent_chars: indentChars,
    punctuation_breakdown: {
      chinese: chinesePunct,
      ascii: englishPunct,
      dialogue_quotes: dialogueQuotes,
      other: Math.max(0, punctuation - chinesePunct - englishPunct),
    },
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
