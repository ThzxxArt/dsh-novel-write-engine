import {
  paragraphAtOffset,
  paragraphSpans,
  splitParagraphs,
  splitSentences,
  sentenceLengths,
} from './text.js'
import { isBlank } from './wordcount.js'
import type { StylePack, SensoryChannel } from '../rules/types.js'

/**
 * 0.2.17 style metrics — the *measurements* a style pack is judged against.
 *
 * Everything here is pure and deterministic: same text and pack, same numbers.
 * The nine definitions live in one place (附录 C 17–22) so a rule, the panel and
 * `novel_report` cannot drift into three slightly different readings.
 */

/** 附录 C-17: a sentence of at most 12 CJK chars is short; 32 or more is long. */
export const SHORT_SENTENCE_MAX = 12
export const LONG_SENTENCE_MIN = 32

/** A channel counts as hit when any of its terms appears. Engine concept, not taste. */
const SENSORY_CHANNEL_TERMS: Readonly<Record<SensoryChannel, readonly string[]>> = {
  sight: ['看', '望', '光', '影', '亮', '暗'],
  sound: ['听', '声', '响', '静', '噪'],
  smell: ['闻', '香', '臭', '味'],
  taste: ['尝', '甜', '苦', '咸', '酸', '辣'],
  touch: ['摸', '触', '碰', '疼', '痒', '麻', '粗糙', '滑', '指尖', '掌心'],
  cold: ['冷', '寒', '凉', '冰'],
  heat: ['热', '烫', '暖', '烧'],
}

/** Word lists a pack does not own: they come from the rulepack. */
export interface StyleVocabulary {
  abstractEmotion: readonly string[]
  metaphor: MetaphorVocabulary
  emotionCues: readonly string[]
  pleasure: readonly string[]
  adjectives: readonly string[]
  senses: readonly string[]
}

/**
 * The words the metaphor matcher needs.
 *
 * `markers` are the simile markers; `concrete_anchors` are the concrete nouns
 * and measure words that must appear right after a marker for it to be a
 * simile at all. Both are vocabulary, so the rulepack owns them (C10).
 */
export interface MetaphorVocabulary {
  markers: readonly string[]
  concrete_anchors: readonly string[]
}

/* ---------------------------------------------------------- metaphor matcher */

/**
 * 0.2.19 D2: characters that make 像 part of a compound noun rather than a
 * simile. `好` covers 好像, `图/画/肖/头` cover 图像/画像/肖像/头像, `偶/雕/佛/
 * 塑/铜/石/木/泥` cover 偶像/雕像/佛像/塑像/铜像/石像/木像/泥像, `影/录/想`
 * cover 影像/录像/想像, and `不` covers the negation 不像.
 *
 * This list is grammar, not taste, so it lives in code: a pack that ships only
 * markers still gets the compound exclusion and cannot reintroduce the 0.2.18
 * over-count.
 */
const METAPHOR_COMPOUND_HEADS: ReadonlySet<string> = new Set([
  '好',
  '图',
  '画',
  '肖',
  '头',
  '偶',
  '雕',
  '佛',
  '塑',
  '铜',
  '石',
  '木',
  '泥',
  '影',
  '录',
  '想',
  '不',
])

/** 似的 is a simile only when it hangs off one of these. 风似的走开了 is not one. */
const SIMILE_LEADS: ReadonlySet<string> = new Set(['像', '跟', '和', '如'])

/** 像 + a pronoun/demonstrative is the preposition: 像他这样的人也能活下来。 */
const PREPOSITIONAL_HEADS: ReadonlySet<string> = new Set([
  '他',
  '她',
  '它',
  '我',
  '你',
  '您',
  '这',
  '那',
  '谁',
  '其',
  '们',
  '如',
  '此',
  '什',
  '咋',
  '哪',
])

/** How far right of the marker a concrete anchor may sit. */
const METAPHOR_RIGHT_WINDOW = 12

/** One simile occurrence, with the paragraph it starts in. */
export interface MetaphorHit {
  marker: string
  /** Character offset of the marker in the source text. */
  start: number
  /** 1-based paragraph number, matching `splitParagraphs`. */
  paragraph: number
}

/**
 * Every simile in `text`, under one definition.
 *
 * The 0.2.17 counter was a substring scan over `markers`, and `像` is a single
 * character: 好像是这样的，画像挂在墙上，他偶像的照片。 measured three similes.
 * A marker now only counts when
 *
 * 1. the character before it is not a compound head,
 * 2. 似的 hangs off 像/跟/和/如,
 * 3. the next character is not a pronoun/demonstrative (the prepositional 像),
 * 4. the twelve characters to its right contain a concrete anchor — skipped
 *    when the pack declares no anchors, so an old pack degrades to 1–3 only.
 */
export function metaphorHits(text: string, vocabulary: MetaphorVocabulary): MetaphorHit[] {
  const markers = vocabulary.markers.filter((marker) => marker !== '')
  if (markers.length === 0) return []
  // Longest first so 如同 wins over 如 and 好似 over 好 at the same offset.
  const ordered = [...markers].sort((left, right) => right.length - left.length)
  const spans = paragraphSpans(text)
  const hits: MetaphorHit[] = []
  let cursor = 0
  while (cursor < text.length) {
    const marker = ordered.find((candidate) => text.startsWith(candidate, cursor))
    if (marker === undefined) {
      cursor += 1
      continue
    }
    const start = cursor
    const end = start + marker.length
    // Never re-read a matched marker as part of the next one.
    cursor = end
    const previous = start === 0 ? undefined : text[start - 1]
    if (marker === '似的' && (previous === undefined || !SIMILE_LEADS.has(previous))) continue
    if (previous !== undefined && METAPHOR_COMPOUND_HEADS.has(previous)) continue
    const right = text.slice(end, end + METAPHOR_RIGHT_WINDOW)
    if (PREPOSITIONAL_HEADS.has(right[0] ?? '')) continue
    if (
      vocabulary.concrete_anchors.length > 0 &&
      !vocabulary.concrete_anchors.some((anchor) => right.includes(anchor))
    ) {
      continue
    }
    hits.push({ marker, start, paragraph: paragraphAtOffset(spans, start) })
  }
  return hits
}

export interface StyleMetrics {
  version: 1
  style_id: string
  sentence: {
    total: number
    short: number
    medium: number
    long: number
    short_ratio: number
    medium_ratio: number
    long_ratio: number
    mean_length: number
    /** 附录 C-18: coefficient of variation, `std/mean`; 0 when the mean is 0. */
    cv: number
    /** Longest run of consecutive sentences in the same length bucket. */
    longest_run: number
  }
  paragraph: {
    count: number
    max_chars: number
    max_sentences: number
    mean_sentences: number
  }
  dialogue: { line_ratio: number; char_ratio: number }
  diction: {
    abstract_emotion_per_1000: number
    metaphor_per_1000: number
    adjective_per_100: number
    sensory_per_1000: number
    sensory_channels_hit: string[]
  }
  structure: { longest_cool_gap_chars: number }
  emotion: { cues_per_1000: number }
  banned: { hits: number; by_pattern: Record<string, number> }
}

/**
 * The one banned-pattern matcher (C2). A `……` entry is a bounded template —
 * `A[\s\S]{0,12}B` — and everything else is a literal substring.
 *
 * The gap is **lazy**. A greedy `{0,12}` starts at the first A and stretches to
 * the last B it can reach, so 不是要钱，而是要命。他不是怕死，而是怕疼。 counted
 * as *one* frame instead of two: the single match swallowed both occurrences.
 * Occurrence counting needs the nearest B, not the furthest (0.2.19 S3).
 *
 * It lives here, next to the metrics that count its hits, because the rule and
 * the measurement must never disagree about what "hit" means. `rules/style.ts`
 * re-exports it so the compiler validates with the exact same function.
 */
export function stylePatternToRegExp(pattern: string): RegExp {
  const source = pattern.includes('……')
    ? pattern
        .split('……')
        .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s\\S]{0,12}?')
    : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(source, 'g')
}

const countOccurrences = (text: string, needle: string): number => {
  if (needle === '') return 0
  let count = 0
  let index = text.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

const countTerms = (text: string, terms: readonly string[]): number =>
  terms.reduce((total, term) => total + countOccurrences(text, term), 0)

const nonWsLength = (text: string): number => Array.from(text).filter((char) => !isBlank(char)).length

/** Per-1000 normalisation; a zero denominator yields 0 rather than Infinity. */
const per1000 = (count: number, nonWs: number): number => (nonWs === 0 ? 0 : (count * 1000) / nonWs)

const round = (value: number): number => Math.round(value * 1000) / 1000

/**
 * Measure a chapter against a pack.
 *
 * `pack` supplies the targets; `vocabulary` supplies the words (the rulepack
 * owns those, C10). The function never throws on empty text.
 */
export function measureStyle(text: string, pack: StylePack, vocabulary: StyleVocabulary): StyleMetrics {
  const sentences = splitSentences(text)
  const lengths = sentenceLengths(sentences)
  const total = lengths.length
  const short = lengths.filter((length) => length <= SHORT_SENTENCE_MAX).length
  const long = lengths.filter((length) => length >= LONG_SENTENCE_MIN).length
  const medium = total - short - long

  let meanLength = 0
  let cv = 0
  if (total > 0) {
    meanLength = lengths.reduce((sum, length) => sum + length, 0) / total
    if (meanLength > 0) {
      const variance = lengths.reduce((sum, length) => sum + (length - meanLength) ** 2, 0) / total
      cv = Math.sqrt(variance) / meanLength
    }
  }

  let longestRun = 0
  let run = 0
  let previousBucket = ''
  for (const length of lengths) {
    const bucket = length <= SHORT_SENTENCE_MAX ? 'short' : length >= LONG_SENTENCE_MIN ? 'long' : 'medium'
    run = bucket === previousBucket ? run + 1 : 1
    previousBucket = bucket
    if (run > longestRun) longestRun = run
  }

  const paragraphs = splitParagraphs(text)
  const paragraphChars = paragraphs.map((paragraph) => nonWsLength(paragraph))
  const sentencesPerParagraph = paragraphs.map((paragraph) => splitSentences(paragraph).length)
  const nonWs = nonWsLength(text)

  // Dialogue uses the same two readings as `DIALOGUE_RATIO` (C6): whole-line and
  // quoted characters, so the style target and the project range speak one language.
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const dialogueLines = lines.filter((line) => /["“”「」『』]/.test(line)).length
  const quoted = Array.from(text.matchAll(/["“「『]([\s\S]*?)["”」』]/g)).reduce(
    (sum, match) => sum + nonWsLength(match[1]!),
    0,
  )

  const abstractEmotion = countTerms(text, vocabulary.abstractEmotion)
  const metaphor = metaphorHits(text, vocabulary.metaphor).length
  const adjectives = countTerms(text, vocabulary.adjectives)
  const sensory = countTerms(text, vocabulary.senses)
  const cues = countTerms(text, vocabulary.emotionCues)
  const sensoryChannelsHit = (Object.keys(SENSORY_CHANNEL_TERMS) as SensoryChannel[]).filter((channel) =>
    SENSORY_CHANNEL_TERMS[channel].some((term) => text.includes(term)),
  )

  // 附录 C-21: the longest stretch of non-whitespace between adjacent pleasure hits.
  const positions: Array<{ start: number; end: number }> = []
  for (const keyword of vocabulary.pleasure) {
    // An empty keyword would make `indexOf` return the same offset forever.
    // The rulepack compiler rejects empty terms; this guard keeps a hand-built
    // vocabulary from hanging the engine.
    if (keyword === '') continue
    let index = text.indexOf(keyword)
    while (index !== -1) {
      positions.push({ start: index, end: index + keyword.length })
      index = text.indexOf(keyword, index + keyword.length)
    }
  }
  positions.sort((left, right) => left.start - right.start)
  let longestCoolGap = 0
  for (let index = 1; index < positions.length; index += 1) {
    const gap = nonWsLength(text.slice(positions[index - 1]!.end, positions[index]!.start))
    if (gap > longestCoolGap) longestCoolGap = gap
  }
  // No pleasure hit at all means the whole chapter is one gap; that is the
  // honest reading, and `STYLE_COOL_POINT_GAP` decides whether it matters.
  if (positions.length === 0) longestCoolGap = nonWs

  const byPattern: Record<string, number> = {}
  let bannedHits = 0
  for (const pattern of pack.banned_patterns) {
    const hits = text.match(stylePatternToRegExp(pattern))?.length ?? 0
    if (hits > 0) {
      byPattern[pattern] = hits
      bannedHits += hits
    }
  }

  return {
    version: 1,
    style_id: pack.id,
    sentence: {
      total,
      short,
      medium,
      long,
      short_ratio: total === 0 ? 0 : round(short / total),
      medium_ratio: total === 0 ? 0 : round(medium / total),
      long_ratio: total === 0 ? 0 : round(long / total),
      mean_length: round(meanLength),
      cv: round(cv),
      longest_run: longestRun,
    },
    paragraph: {
      count: paragraphs.length,
      max_chars: paragraphChars.reduce((max, value) => Math.max(max, value), 0),
      max_sentences: sentencesPerParagraph.reduce((max, value) => Math.max(max, value), 0),
      mean_sentences:
        sentencesPerParagraph.length === 0
          ? 0
          : round(
              sentencesPerParagraph.reduce((sum, value) => sum + value, 0) / sentencesPerParagraph.length,
            ),
    },
    dialogue: {
      line_ratio: lines.length === 0 ? 0 : round(dialogueLines / lines.length),
      char_ratio: nonWs === 0 ? 0 : round(Math.min(1, quoted / nonWs)),
    },
    diction: {
      abstract_emotion_per_1000: round(per1000(abstractEmotion, nonWs)),
      metaphor_per_1000: round(per1000(metaphor, nonWs)),
      adjective_per_100: nonWs === 0 ? 0 : round((adjectives * 100) / nonWs),
      sensory_per_1000: round(per1000(sensory, nonWs)),
      sensory_channels_hit: sensoryChannelsHit,
    },
    structure: { longest_cool_gap_chars: longestCoolGap },
    emotion: { cues_per_1000: round(per1000(cues, nonWs)) },
    banned: { hits: bannedHits, by_pattern: byPattern },
  }
}

/** The actual dialogue reading a project asked for (`dialogue_ratio_metric`). */
export function dialogueRatioFor(
  metrics: Pick<StyleMetrics, 'dialogue'>,
  metric: 'lines' | 'chars' | 'both',
): { lines: number; chars: number; used: number } {
  const lines = metrics.dialogue.line_ratio
  const chars = metrics.dialogue.char_ratio
  const used = metric === 'chars' ? chars : metric === 'lines' ? lines : Math.max(lines, chars)
  return { lines, chars, used }
}

/** Pull the three style word lists out of the rulepack (C10: the pack owns words). */
export function styleVocabulary(rulepack: {
  semantics: {
    abstract_emotion?: { terms: string[] }
    metaphor?: { markers: string[]; concrete_anchors?: string[] }
    emotion_cues?: { terms: string[] }
    adjective_density: { adjectives: string[] }
    sensory_density: { senses: string[] }
    pleasure_density: { keywords: string[] }
  }
}): StyleVocabulary {
  return {
    abstractEmotion: rulepack.semantics.abstract_emotion?.terms ?? [],
    metaphor: {
      markers: rulepack.semantics.metaphor?.markers ?? [],
      concrete_anchors: rulepack.semantics.metaphor?.concrete_anchors ?? [],
    },
    emotionCues: rulepack.semantics.emotion_cues?.terms ?? [],
    pleasure: rulepack.semantics.pleasure_density.keywords,
    adjectives: rulepack.semantics.adjective_density.adjectives,
    senses: rulepack.semantics.sensory_density.senses,
  }
}
