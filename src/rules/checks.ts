import { countWordMetrics, countWordMetricsOfParagraph } from '../domain/wordcount.js'
import { dialogueCharacterRatio, sentenceRhythm, splitParagraphs } from '../domain/text.js'
import { maxParagraphSimilarity } from '../domain/simhash.js'
import { CROSS_RULES, FORMAT_RULES, LEXICON_RULES, PUNCTUATION_RULES, SEMANTIC_RULES } from '../codes.js'
import type { Severity, Violation } from '../types.js'
import type { Rule } from './types.js'

const v = (code: string, severity: Severity, paragraph: number, detail: string): Violation => ({
  code,
  severity,
  location: { paragraph },
  detail,
})

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

const countHits = (text: string, term: string): number => countOccurrences(text, term)

/* ------------------------------------------------------------------ format */

const mdContamination: Rule = (ctx) => {
  if (!ctx.rulepack.format.forbid_markdown) return []
  const results: Violation[] = []
  splitParagraphs(ctx.text).forEach((paragraph, index) => {
    for (const marker of ctx.rulepack.format.markdown_markers) {
      if (paragraph.includes(marker))
        results.push(
          v(FORMAT_RULES.MD_CONTAMINATION, 'blocker', index + 1, `contains Markdown marker "${marker}"`),
        )
    }
  })
  return results
}

const illegalQuote: Rule = (ctx) => {
  const results: Violation[] = []
  splitParagraphs(ctx.text).forEach((paragraph, index) => {
    const matches = paragraph.match(/[“”「」『』]/g)
    if (matches !== null)
      results.push(
        v(
          FORMAT_RULES.ILLEGAL_QUOTE,
          'blocker',
          index + 1,
          `contains ${matches.length} curly/CJK quote mark(s)`,
        ),
      )
  })
  return results
}

const semicolon: Rule = (ctx) => {
  if (!ctx.rulepack.format.forbid_semicolon) return []
  return splitParagraphs(ctx.text).flatMap((paragraph, index) =>
    paragraph.includes('；')
      ? [v(FORMAT_RULES.SEMICOLON, 'blocker', index + 1, 'contains a full-width semicolon')]
      : [],
  )
}

const englishEllipsis: Rule = (ctx) => {
  if (!ctx.rulepack.format.forbid_english_ellipsis) return []
  return splitParagraphs(ctx.text).flatMap((paragraph, index) =>
    /\.{3,}/.test(paragraph)
      ? [v(FORMAT_RULES.ENGLISH_ELLIPSIS, 'blocker', index + 1, 'contains "..." instead of "……"')]
      : [],
  )
}

const sceneSeparator: Rule = (ctx) => {
  const results: Violation[] = []
  splitParagraphs(ctx.text).forEach((paragraph, index) => {
    for (const separator of ctx.rulepack.format.scene_separators) {
      if (paragraph.includes(separator))
        results.push(
          v(FORMAT_RULES.SCENE_SEPARATOR, 'blocker', index + 1, `contains scene separator "${separator}"`),
        )
    }
  })
  return results
}

const longParagraph: Rule = (ctx) => {
  const max = ctx.rulepack.format.paragraph_max_words
  return splitParagraphs(ctx.text).flatMap((paragraph, index) => {
    const words = countWordMetricsOfParagraph(paragraph)
    return words > max
      ? [
          v(
            FORMAT_RULES.LONG_PARAGRAPH,
            'blocker',
            index + 1,
            `paragraph has ${words} words, limit is ${max}`,
          ),
        ]
      : []
  })
}

const titleFormat: Rule = (ctx) => {
  if (ctx.title === null) return []
  const template = ctx.rulepack.format.title
  if (!new RegExp(template.pattern).test(ctx.title)) {
    return [
      v(FORMAT_RULES.TITLE_FORMAT, 'blocker', 0, `title "${ctx.title}" does not match /${template.pattern}/`),
    ]
  }
  const suffix = ctx.title.replace(new RegExp(template.pattern), '').trim()
  const length = Array.from(suffix).length
  if (length < template.min_chars || length > template.max_chars) {
    return [
      v(
        FORMAT_RULES.TITLE_FORMAT,
        'blocker',
        0,
        `title body has ${length} characters, expected ${template.min_chars}..${template.max_chars}`,
      ),
    ]
  }
  return []
}

const systemLabel: Rule = (ctx) => {
  const labels = ctx.rulepack.format.system_labels
  const results: Violation[] = []
  splitParagraphs(ctx.text).forEach((paragraph, index) => {
    for (const label of labels) {
      const match = paragraph.match(new RegExp(label))
      if (match !== null)
        results.push(
          v(FORMAT_RULES.SYSTEM_LABEL, 'blocker', index + 1, `contains out-of-story label "${match[0]}"`),
        )
    }
  })
  return results
}

/* ----------------------------------------------------------------- lexicon */

const zeroTolerance: Rule = (ctx) =>
  ctx.rulepack.lexicon.zero_tolerance.flatMap((entry) => {
    const dominant = ctx.rulepack.punctuation.dialogue_dominant_ratio
    const paragraphs = splitParagraphs(ctx.text)
    const eligible =
      entry.dialogueExempt === true
        ? paragraphs
            .map((paragraph, index) => ({ paragraph, index }))
            .filter(({ paragraph }) => dialogueCharacterRatio(paragraph) < dominant)
        : paragraphs.map((paragraph, index) => ({ paragraph, index }))
    const source = eligible.map(({ paragraph }) => paragraph).join('\n\n')
    const hits = countHits(source, entry.term)
    if (hits === 0) return []
    const paragraph = (eligible.find(({ paragraph }) => paragraph.includes(entry.term))?.index ?? 0) + 1
    return [
      v(
        LEXICON_RULES.ZERO_TOLERANCE,
        'blocker',
        paragraph,
        `"${entry.term}" is zero-tolerance (${hits}x)${entry.note === undefined ? '' : `: ${entry.note}`}`,
      ),
    ]
  })

/** Soft limits apply chapter-wide; contextual limits relax by genre (0 elsewhere). */
const softLimit: Rule = (ctx) =>
  [...ctx.rulepack.lexicon.soft, ...ctx.rulepack.lexicon.contextual].flatMap((entry) => {
    const genres = 'genres' in entry ? entry.genres : undefined
    const allowed = genres === undefined || genres.includes(ctx.genre)
    const limit = allowed ? entry.limit : 0
    const hits = countHits(ctx.text, entry.term)
    if (hits <= limit) return []
    return [
      v(
        LEXICON_RULES.SOFT_LIMIT,
        'advisory',
        firstParagraphContaining(ctx.text, entry.term),
        `"${entry.term}" used ${hits}x, limit is ${limit}`,
      ),
    ]
  })

const metaNarration: Rule = (ctx) =>
  ctx.rulepack.lexicon.meta_narration.flatMap((entry) => {
    const hits = countHits(ctx.text, entry.term)
    if (hits === 0) return []
    return [
      v(
        LEXICON_RULES.META_NARRATION,
        'blocker',
        firstParagraphContaining(ctx.text, entry.term),
        `"${entry.term}" is meta narration`,
      ),
    ]
  })

const readerIntrusion: Rule = (ctx) =>
  ctx.rulepack.lexicon.reader_intrusion.flatMap((entry) => {
    const match = new RegExp(entry.pattern).exec(ctx.text)
    if (match === null) return []
    return [
      v(
        LEXICON_RULES.READER_INTRUSION,
        'blocker',
        paragraphOfIndex(ctx.text, match.index),
        `reader-address pattern /${entry.pattern}/ matched "${match[0]}"`,
      ),
    ]
  })

const godView: Rule = (ctx) =>
  ctx.rulepack.lexicon.god_view.flatMap((entry) => {
    const match = new RegExp(entry.pattern).exec(ctx.text)
    if (match === null) return []
    return [
      v(
        LEXICON_RULES.GOD_VIEW,
        'advisory',
        paragraphOfIndex(ctx.text, match.index),
        `omniscient-view pattern /${entry.pattern}/ matched "${match[0]}"`,
      ),
    ]
  })

const conclusionFirst: Rule = (ctx) => {
  const { verbs, causals } = ctx.rulepack.lexicon.conclusion_first
  if (verbs.length === 0 || causals.length === 0) return []
  const results: Violation[] = []
  splitParagraphs(ctx.text).forEach((paragraph, index) => {
    for (const verb of verbs) {
      const position = paragraph.indexOf(verb)
      if (position === -1) continue
      // Only a cause after the conclusion is a conclusion-first violation.
      // A causal marker before the verb is the correct cause-first order.
      const window = paragraph.slice(position, Math.min(paragraph.length, position + 20))
      if (causals.some((causal) => window.includes(causal))) {
        results.push(
          v(
            LEXICON_RULES.CONCLUSION_FIRST,
            'advisory',
            index + 1,
            `conclusion before action: "${verb}" with a causal marker`,
          ),
        )
        break
      }
    }
  })
  return results
}

/* ------------------------------------------------------------- punctuation */

const dashBudget: Rule = (ctx) => {
  const metrics = countWordMetrics(ctx.text)
  const budget = ctx.rulepack.punctuation.dash.base[ctx.sceneType]
  const scaled =
    budget * Math.max(1, Math.ceil(metrics.total_word_count / ctx.rulepack.punctuation.dash.scale_words))
  const token = ctx.rulepack.punctuation.dash.token
  const total = countOccurrences(ctx.text, token)
  let inDialogue = 0
  for (const match of ctx.text.matchAll(/["“][^"“”]*["”]/g)) {
    inDialogue += countOccurrences(match[0], token)
  }
  // A dash inside dialogue carries two speakers' interruption, so it costs double.
  const weighted = total - inDialogue + inDialogue * 2
  if (weighted <= scaled) return []
  return [
    v(
      PUNCTUATION_RULES.DASH_BUDGET,
      'advisory',
      firstParagraphContaining(ctx.text, token),
      `dash weight ${weighted} (dialogue ${inDialogue}x double), budget is ${scaled} for ${ctx.sceneType}`,
    ),
  ]
}

const periodDensity: Rule = (ctx) => {
  const { min, max } = ctx.rulepack.punctuation.period_density
  const dominant = ctx.rulepack.punctuation.dialogue_dominant_ratio
  const results: Violation[] = []
  splitParagraphs(ctx.text).forEach((paragraph, index) => {
    if (dialogueCharacterRatio(paragraph) >= dominant) return
    const metrics = countWordMetrics(paragraph)
    if (metrics.non_ws_chars < 40) return
    // Count every sentence terminator, not only the full stop. A normal
    // exclamation-only paragraph otherwise reports a density of zero.
    const marks = paragraph.match(/[。！？!?]|…+/g)?.length ?? 0
    const density = (marks / metrics.non_ws_chars) * 100
    if (density >= min && density <= max) return
    results.push(
      v(
        PUNCTUATION_RULES.PERIOD_DENSITY,
        'advisory',
        index + 1,
        `sentence-terminator density ${density.toFixed(2)}/100 chars is outside ${min}..${max}`,
      ),
    )
  })
  return results
}

const ellipsisRun: Rule = (ctx) => {
  const token = ctx.rulepack.punctuation.ellipsis_run.token
  const max = ctx.rulepack.punctuation.ellipsis_run.max
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const results: Violation[] = []
  splitParagraphs(ctx.text).forEach((paragraph, index) => {
    const runs = paragraph.match(new RegExp(`(?:${escaped}){${max + 1},}`, 'g'))
    if (runs !== null)
      results.push(
        v(
          PUNCTUATION_RULES.ELLIPSIS_RUN,
          'advisory',
          index + 1,
          `ellipsis repeated ${max + 1}+ times in a row`,
        ),
      )
  })
  return results
}

const uniformSentence: Rule = (ctx) => {
  const { min_sentences, ratio } = ctx.rulepack.punctuation.uniform_sentence
  const dominant = ctx.rulepack.punctuation.dialogue_dominant_ratio
  const results: Violation[] = []
  splitParagraphs(ctx.text).forEach((paragraph, index) => {
    if (dialogueCharacterRatio(paragraph) >= dominant) return
    const rhythm = sentenceRhythm(paragraph)
    if (rhythm.count < min_sentences || rhythm.uniformRatio < ratio) return
    results.push(
      v(
        PUNCTUATION_RULES.UNIFORM_SENTENCE,
        'advisory',
        index + 1,
        `${Math.round(rhythm.uniformRatio * 100)}% of sentences share one length`,
      ),
    )
  })
  return results
}

const consecutiveLe: Rule = (ctx) => {
  const { max, char } = ctx.rulepack.punctuation.consecutive_le
  const results: Violation[] = []
  splitParagraphs(ctx.text).forEach((paragraph, index) => {
    let run = 0
    for (const character of paragraph) {
      run = character === char ? run + 1 : 0
      if (run > max) {
        results.push(
          v(
            PUNCTUATION_RULES.CONSECUTIVE_LE,
            'advisory',
            index + 1,
            `"${char}" appears ${run} times in a row`,
          ),
        )
        break
      }
    }
  })
  return results
}

/* --------------------------------------------------------------- semantics */

const adjectiveDensity: Rule = (ctx) => {
  const { max, adjectives } = ctx.rulepack.semantics.adjective_density
  if (adjectives.length === 0) return []
  const metrics = countWordMetrics(ctx.text)
  const hits = adjectives.reduce((total, adjective) => total + countOccurrences(ctx.text, adjective), 0)
  if (metrics.non_ws_chars === 0) return []
  const density = (hits / metrics.non_ws_chars) * 100
  if (density <= max) return []
  return [
    v(
      SEMANTIC_RULES.ADJECTIVE_DENSITY,
      'advisory',
      1,
      `adjectives every ${(100 / density).toFixed(1)} chars; limit is ${max}%`,
    ),
  ]
}

export const slidingWindows = (text: string, size: number): string[] => {
  const positions: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    if (/\S/.test(text[index]!)) positions.push(index)
  }
  if (positions.length <= size) return [text]
  const windows: string[] = []
  for (let startIndex = 0; startIndex + size <= positions.length; startIndex += 1) {
    const start = positions[startIndex]!
    const end = startIndex + size < positions.length ? positions[startIndex + size]! : text.length
    windows.push(text.slice(start, end))
  }
  const tail = text.slice(positions[positions.length - size]!)
  if (windows[windows.length - 1] !== tail) windows.push(tail)
  return windows
}

const dialogueRatio: Rule = (ctx) => {
  const target = ctx.targets?.dialogue_ratio
  if (target === undefined) return []
  const ratio = countWordMetrics(ctx.text).dialogue_ratio
  if (ratio >= target[0] && ratio <= target[1]) return []
  return [
    v(
      SEMANTIC_RULES.DIALOGUE_RATIO,
      'advisory',
      1,
      `dialogue ratio ${Math.round(ratio * 1000) / 10}% is outside target ${Math.round(target[0] * 1000) / 10}%..${Math.round(target[1] * 1000) / 10}% (quoted lines / non-empty lines)`,
    ),
  ]
}

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}
const CN_UNITS: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000, 万: 10_000 }

/** Parse a small Chinese/Arabic number; null means the token was not a number. */
function parseSmallNumber(raw: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw)
  let total = 0
  let section = 0
  let digit: number | null = null
  for (const char of raw) {
    if (char in CN_DIGITS) {
      digit = CN_DIGITS[char]!
      continue
    }
    const unit = CN_UNITS[char]
    if (unit === undefined) return null
    if (unit === 10_000) {
      section = (section + (digit ?? 0)) * unit
      total += section
      section = 0
      digit = null
    } else {
      section += (digit ?? 1) * unit
      digit = null
    }
  }
  return total + section + (digit ?? 0)
}

const NUMBER_TOKEN = '[零一二两三四五六七八九十百千万]+|\\d+(?:\\.\\d+)?'
const DISTANCE_RE = new RegExp(`(${NUMBER_TOKEN})\\s*(海里|公里|千米|米|里)`, 'g')
const DURATION_RE = new RegExp(`(${NUMBER_TOKEN})\\s*个?\\s*(小时|钟头|分钟)`, 'g')
const SPEED_RE = new RegExp(`(?:时速|每小时|速度(?:是|为)?)\\s*(${NUMBER_TOKEN})\\s*(海里|公里|千米|米)`, 'g')

const METRES: Readonly<Record<string, number>> = {
  米: 1,
  里: 500,
  公里: 1000,
  千米: 1000,
  海里: 1852,
}
const HOURS: Readonly<Record<string, number>> = { 分钟: 1 / 60, 小时: 1, 钟头: 1 }

interface Quantity {
  value: number
  unit: string
  index: number
  raw: string
}

const collect = (text: string, pattern: RegExp, units: Readonly<Record<string, number>>): Quantity[] => {
  const result: Quantity[] = []
  for (const match of text.matchAll(pattern)) {
    const value = parseSmallNumber(match[1] ?? '')
    if (value === null || units[match[2] ?? ''] === undefined) continue
    result.push({ value, unit: match[2]!, index: match.index ?? 0, raw: match[0] })
  }
  return result
}

const numericContradiction: Rule = (ctx) => {
  // Explicit speed anchors do not need a distance/duration pair.
  const explicit = collect(ctx.text, SPEED_RE, METRES).map((quantity) => ({
    at: quantity.index,
    kmh: (quantity.value * METRES[quantity.unit]!) / 1000,
    raw: quantity.raw,
  }))
  const distances = collect(ctx.text, DISTANCE_RE, METRES)
  const durations = collect(ctx.text, DURATION_RE, HOURS)
  const speeds: Array<{ at: number; kmh: number; raw: string }> = []
  if (distances.length > 0 && durations.length > 0) {
    for (const distance of distances) {
      const nearest = durations
        .map((duration) => ({ duration, distance: Math.abs(duration.index - distance.index) }))
        .sort((left, right) => left.distance - right.distance)[0]
      if (nearest === undefined || nearest.distance > 60) continue
      const metres = distance.value * METRES[distance.unit]!
      const hours = nearest.duration.value * HOURS[nearest.duration.unit]!
      if (hours <= 0) continue
      speeds.push({
        at: Math.min(distance.index, nearest.duration.index),
        kmh: metres / 1000 / hours,
        raw: `${distance.raw} / ${nearest.duration.raw}`,
      })
    }
  }
  // An explicit speed statement is a stronger anchor than an implied pair.
  const anchors = explicit.length > 0 ? explicit : speeds
  if (anchors.length < 2) return []
  const positive = anchors.filter((anchor) => anchor.kmh > 0)
  if (positive.length < 2) return []
  const min = Math.min(...positive.map((anchor) => anchor.kmh))
  const max = Math.max(...positive.map((anchor) => anchor.kmh))
  if (max / Math.max(0.0001, min) < 1.5) return []
  const firstNeedle = positive[0]!.raw.split(' / ')[0]!
  const paragraphIndex = splitParagraphs(ctx.text).findIndex((paragraph) => paragraph.includes(firstNeedle))
  return [
    // Chinese prose rarely names the subject of two speed clauses, so this
    // cannot distinguish a car at 60 km/h from a boat at 12 knots. It is a
    // reading aid, never a hard archive gate.
    v(
      SEMANTIC_RULES.NUMERIC_CONTRADICTION,
      'advisory',
      Math.max(1, paragraphIndex + 1),
      `numeric statements imply different speeds (${min.toFixed(1)}–${max.toFixed(1)} km/h): ${positive
        .slice(0, 3)
        .map((anchor) => anchor.raw)
        .join('; ')}`,
    ),
  ]
}

const escapePattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const numericFactMismatch: Rule = (ctx) => {
  if (ctx.facts === undefined || ctx.facts.length === 0) return []
  const results: Violation[] = []
  const paragraphs = splitParagraphs(ctx.text)
  for (const fact of ctx.facts) {
    if (fact.alias.trim() === '' || !Number.isFinite(fact.value)) continue
    const tolerance = fact.tolerance ?? 0
    // Require alias + optional copula/colon + number + the declared unit.
    // A bare number anywhere in a ±40-char window is usually another noun
    // (「数了三遍」 next to 「船价」), and ignoring the unit makes the advisory
    // permanently noisy.
    const pattern = new RegExp(
      `${escapePattern(fact.alias)}\\s*(?:是|为|约|有|：|:)?\\s*(${NUMBER_TOKEN})\\s*${escapePattern(fact.unit)}`,
      'g',
    )
    for (const match of ctx.text.matchAll(pattern)) {
      const value = parseSmallNumber(match[1] ?? '')
      if (value === null) continue
      if (Math.abs(value - fact.value) <= tolerance) continue
      const paragraph = paragraphs.findIndex((candidate) => candidate.includes(match[0]))
      results.push(
        v(
          SEMANTIC_RULES.NUMERIC_FACT_MISMATCH,
          'advisory',
          Math.max(1, paragraph + 1),
          `"${fact.alias}" declares ${fact.value}${fact.unit}, text shows ${value}${fact.unit}`,
        ),
      )
      break
    }
  }
  return results
}

const pleasureDensity: Rule = (ctx) => {
  const { min, keywords, window } = ctx.rulepack.semantics.pleasure_density
  if (keywords.length === 0) return []
  const results: Violation[] = []
  const windows = slidingWindows(ctx.text, window)
  const short = windows.findIndex((slice) => {
    const hits = keywords.reduce((total, keyword) => total + countOccurrences(slice, keyword), 0)
    return hits < min
  })
  if (short !== -1)
    results.push(
      v(
        SEMANTIC_RULES.PLEASURE_DENSITY,
        'advisory',
        1,
        `a ${window}-char window has fewer than ${min} pleasure keyword(s)`,
      ),
    )
  return results
}

const sensoryDensity: Rule = (ctx) => {
  const { min, senses, window } = ctx.rulepack.semantics.sensory_density
  if (senses.length === 0) return []
  const bare = slidingWindows(ctx.text, window).findIndex((slice) => {
    const hits = senses.reduce((total, sense) => total + countOccurrences(slice, sense), 0)
    return hits < min
  })
  return bare === -1
    ? []
    : [
        v(
          SEMANTIC_RULES.SENSORY_DENSITY,
          'advisory',
          1,
          `a ${window}-char window has fewer than ${min} sensory words`,
        ),
      ]
}

const waterWords: Rule = (ctx) => {
  const { window, threshold, terms, scene_thresholds } = ctx.rulepack.semantics.water_words
  if (terms.length === 0) return []
  const sceneThreshold = scene_thresholds?.[ctx.sceneType] ?? threshold
  const results: Violation[] = []
  for (const slice of slidingWindows(ctx.text, window)) {
    const hits = terms.reduce((total, term) => total + countOccurrences(slice, term), 0)
    const density = hits / window
    if (density > sceneThreshold) {
      results.push(
        v(
          SEMANTIC_RULES.WATER_WORDS,
          'advisory',
          1,
          `a ${window}-char window is ${Math.round(density * 100)}% filler words (limit ${sceneThreshold})`,
        ),
      )
      break
    }
  }
  return results
}

/* ------------------------------------------------------------ crosschapter */

const duplicateParagraph: Rule = (ctx) => {
  const previous =
    ctx.evidence.previousTexts.length > 0
      ? ctx.evidence.previousTexts
      : ctx.evidence.previousText === null
        ? []
        : [ctx.evidence.previousText]
  if (previous.length === 0) return []
  const minChars = ctx.rulepack.crosschapter.duplicate_min_chars
  // Do not let a writer hide a repeated paragraph by inserting newlines: merge
  // consecutive short paragraphs until each comparison unit reaches minChars.
  const longParagraphs = (text: string): string => {
    const units: string[] = []
    let buffer = ''
    for (const paragraph of splitParagraphs(text)) {
      buffer += paragraph
      if (Array.from(buffer.replace(/\s+/g, '')).length >= minChars) {
        units.push(buffer)
        buffer = ''
      }
    }
    if (buffer !== '') {
      if (units.length === 0) {
        if (Array.from(buffer.replace(/\s+/g, '')).length >= minChars) units.push(buffer)
      } else {
        units[units.length - 1] += buffer
      }
    }
    return units.join('\n\n')
  }
  const best = maxParagraphSimilarity(
    longParagraphs(ctx.text),
    previous.map((text) => longParagraphs(text)).filter((text) => text !== ''),
  )
  const advisory = ctx.rulepack.crosschapter.duplicate_advisory
  if (best < advisory) return []
  const severity = best >= ctx.rulepack.crosschapter.duplicate_similarity ? 'blocker' : 'advisory'
  return [
    v(
      CROSS_RULES.DUPLICATE_PARAGRAPH,
      severity,
      1,
      `paragraph reuses ${Math.round(best * 100)}% of a paragraph from the previous three chapters`,
    ),
  ]
}

const foreshadowDormant: Rule = (ctx) => {
  const ledger = ctx.evidence.foreshadows
  if (ledger === null) return []
  const after = ctx.rulepack.crosschapter.foreshadow_dormant_after
  return ledger.items
    .filter((item) => item.status !== 'resolved' && ctx.chapter - item.last_touched >= after)
    .map((item) =>
      v(
        CROSS_RULES.FORESHADOW_DORMANT,
        'advisory',
        1,
        `foreshadow ${item.id} has slept for ${ctx.chapter - item.last_touched} chapters`,
      ),
    )
}

const revisitedTooSoon: Rule = (ctx) => {
  const ledger = ctx.evidence.foreshadows
  if (ledger === null) return []
  const min = ctx.rulepack.crosschapter.foreshadow_min_dormancy
  const advances = ctx.summary?.foreshadows.advanced ?? []
  return ledger.items
    .filter((item) => {
      if (!ctx.text.includes(item.title)) return false
      if (ctx.chapter - item.last_touched >= min || ctx.chapter <= item.last_touched) return false
      // A genuine advance with new information is the documented exception.
      return !advances.some(
        (advance) => (advance.key === item.id || advance.key === item.title) && advance.new_info === true,
      )
    })
    .map((item) =>
      v(
        CROSS_RULES.FS_REVISITED_TOO_SOON,
        'advisory',
        1,
        `foreshadow ${item.id} reappears after ${ctx.chapter - item.last_touched} chapters (minimum ${min})`,
      ),
    )
}

const resourceMismatch: Rule = (ctx) => {
  const changes = ctx.summary?.resource_changes ?? []
  const positive = /(增加|多了|得到|获得|赚|加|上升|增|\+)/
  const negative = /(减少|少了|失去|消耗|花|损失|下降|减|-|−)/
  return changes.flatMap((change) => {
    if (change.delta === 0) return []
    const magnitude = Math.abs(change.delta)
    // Match a sign and a resource only in the same local statement as the
    // amount. A global "text contains '-' somewhere" would accept an opposite
    // change in a different paragraph.
    const stated = [...ctx.text.matchAll(/\d+/g)].some((match) => {
      if (Number(match[0]) !== magnitude) return false
      const index = match.index ?? 0
      const window = ctx.text.slice(
        Math.max(0, index - 80),
        Math.min(ctx.text.length, index + match[0].length + 80),
      )
      return (
        window.includes(change.character) &&
        window.includes(change.resource) &&
        (change.delta > 0 ? positive : negative).test(window)
      )
    })
    return stated
      ? []
      : [
          v(
            CROSS_RULES.RESOURCE_MISMATCH,
            'advisory',
            1,
            `${change.character}'s ${change.resource} change (${change.delta}) is not stated with the right sign in the text`,
          ),
        ]
  })
}

const timeRegression: Rule = (ctx) => {
  if (!ctx.rulepack.crosschapter.check_time) return []
  const ledger = ctx.evidence.timeline
  if (ledger === null || ledger.items.length === 0) return []
  const dayOf = (value: string): number | null => {
    const match = /(?:Day\s*(\d+)|第\s*(\d+)\s*[天日])/i.exec(value)
    if (match === null) return null
    return Number(match[1] ?? match[2])
  }
  const ordered = [...ledger.items].sort((left, right) => left.chapter - right.chapter)
  const last = ordered[ordered.length - 1]!
  const previous = ordered.length >= 2 ? ordered[ordered.length - 2]! : null
  const currentFromText = dayOf(ctx.text)
  const current = currentFromText ?? dayOf(last.story_time)
  const before = previous === null ? null : dayOf(previous.story_time)
  if (current === null) return []
  if (
    currentFromText !== null &&
    dayOf(last.story_time) !== null &&
    currentFromText < dayOf(last.story_time)!
  ) {
    return [
      v(
        CROSS_RULES.TIME_REGRESSION,
        'advisory',
        ctx.chapter,
        `story time goes back from ${last.story_time} to Day ${currentFromText}`,
      ),
    ]
  }
  if (before === null || current >= before) return []
  return [
    v(
      CROSS_RULES.TIME_REGRESSION,
      'advisory',
      last.chapter,
      `story time goes back from ${previous!.story_time} to ${last.story_time}`,
    ),
  ]
}

const relationUnknown: Rule = (ctx) => {
  const characters = ctx.evidence.characters
  const known = characters === null ? [] : characters.characters.map((character) => character.name)
  const names = new Set(known)
  if (ctx.evidence.relationships !== null) {
    for (const item of ctx.evidence.relationships.items) {
      names.add(item.a)
      names.add(item.b)
    }
  }
  if (names.size < 2) return []
  const results: Violation[] = []
  for (const [index, paragraph] of splitParagraphs(ctx.text).entries()) {
    const present = [...names].filter((name) => paragraph.includes(name))
    for (let first = 0; first < present.length; first += 1) {
      for (let second = first + 1; second < present.length; second += 1) {
        const a = present[first]!
        const b = present[second]!
        const declared =
          ctx.evidence.relationships?.items.some(
            (item) => (item.a === a && item.b === b) || (item.a === b && item.b === a),
          ) ?? false
        if (!declared) {
          results.push(
            v(
              CROSS_RULES.RELATION_UNKNOWN,
              'advisory',
              index + 1,
              `${a} and ${b} appear together but have no ledger entry`,
            ),
          )
        }
      }
    }
  }
  return results
}

const lockedDetailDrift: Rule = (ctx) => {
  if (ctx.evidence.locks === null) return []
  const locks = ctx.evidence.locks
  const results: Violation[] = []
  for (const [name, lock] of Object.entries(locks.locations)) {
    if (!ctx.text.includes(name)) continue
    if (lock.layout.trim() === '') continue
    const paragraph = splitParagraphs(ctx.text).find((candidate) => candidate.includes(name))
    if (paragraph === undefined) continue
    const similarity = lockedDetailCoverage(paragraph, lock.layout)
    if (similarity < ctx.rulepack.crosschapter.lock_similarity) {
      results.push(
        v(
          CROSS_RULES.LOCKED_DETAIL_DRIFT,
          'advisory',
          paragraphOfIndex(ctx.text, ctx.text.indexOf(paragraph)),
          `${name} is described differently from its locked layout`,
        ),
      )
    }
  }
  for (const [name, lock] of Object.entries(locks.characters)) {
    if (!ctx.text.includes(name)) continue
    if (lock.appearance.trim() === '') continue
    const paragraph = splitParagraphs(ctx.text).find((candidate) => candidate.includes(name))
    if (paragraph === undefined) continue
    const similarity = lockedDetailCoverage(paragraph, lock.appearance)
    if (similarity < ctx.rulepack.crosschapter.lock_similarity) {
      results.push(
        v(
          CROSS_RULES.LOCKED_DETAIL_DRIFT,
          'advisory',
          paragraphOfIndex(ctx.text, ctx.text.indexOf(paragraph)),
          `${name} is described differently from the locked first appearance`,
        ),
      )
    }
  }
  return results
}

/**
 * How much of a short locked description survives in a whole paragraph.
 * Symmetric SimHash on a 40-80 character paragraph vs a 10-20 character lock
 * scores normal prose as drift; bigram coverage asks the question the rule
 * actually means: are the locked details still present?
 */
function lockedDetailCoverage(paragraph: string, locked: string): number {
  const clean = (value: string): string => value.replace(/[\s\p{P}]+/gu, '')
  const reference = Array.from(clean(locked))
  const source = clean(paragraph)
  if (reference.length === 0) return 1
  if (reference.length === 1) return source.includes(reference[0]!) ? 1 : 0
  const grams: string[] = []
  for (let index = 0; index + 1 < reference.length; index += 1) {
    grams.push(`${reference[index]}${reference[index + 1]}`)
  }
  const present = grams.filter((gram) => source.includes(gram)).length
  return present / grams.length
}

/* ----------------------------------------------------------------- helpers */

function firstParagraphContaining(text: string, needle: string): number {
  const paragraphs = splitParagraphs(text)
  const index = paragraphs.findIndex((paragraph) => paragraph.includes(needle))
  return Math.max(1, index + 1)
}

function paragraphOfIndex(text: string, index: number): number {
  const prefix = text.slice(0, Math.max(0, index))
  const completed = splitParagraphs(prefix).length
  // A match at the first character of a paragraph has no character from that
  // paragraph in `prefix`; without this adjustment its location is reported as
  // the previous line.
  return /\n\s*$/.test(prefix) ? completed + 1 : Math.max(1, completed)
}

/** All built-in rules by code. The registry is populated from this table. */
export const BUILTIN_RULES: Readonly<Record<string, Rule>> = {
  [FORMAT_RULES.MD_CONTAMINATION]: mdContamination,
  [FORMAT_RULES.ILLEGAL_QUOTE]: illegalQuote,
  [FORMAT_RULES.SEMICOLON]: semicolon,
  [FORMAT_RULES.ENGLISH_ELLIPSIS]: englishEllipsis,
  [FORMAT_RULES.SCENE_SEPARATOR]: sceneSeparator,
  [FORMAT_RULES.LONG_PARAGRAPH]: longParagraph,
  [FORMAT_RULES.TITLE_FORMAT]: titleFormat,
  [FORMAT_RULES.SYSTEM_LABEL]: systemLabel,
  [LEXICON_RULES.ZERO_TOLERANCE]: zeroTolerance,
  [LEXICON_RULES.SOFT_LIMIT]: softLimit,
  [LEXICON_RULES.META_NARRATION]: metaNarration,
  [LEXICON_RULES.READER_INTRUSION]: readerIntrusion,
  [LEXICON_RULES.GOD_VIEW]: godView,
  [LEXICON_RULES.CONCLUSION_FIRST]: conclusionFirst,
  [PUNCTUATION_RULES.DASH_BUDGET]: dashBudget,
  [PUNCTUATION_RULES.PERIOD_DENSITY]: periodDensity,
  [PUNCTUATION_RULES.ELLIPSIS_RUN]: ellipsisRun,
  [PUNCTUATION_RULES.UNIFORM_SENTENCE]: uniformSentence,
  [PUNCTUATION_RULES.CONSECUTIVE_LE]: consecutiveLe,
  [SEMANTIC_RULES.ADJECTIVE_DENSITY]: adjectiveDensity,
  [SEMANTIC_RULES.PLEASURE_DENSITY]: pleasureDensity,
  [SEMANTIC_RULES.SENSORY_DENSITY]: sensoryDensity,
  [SEMANTIC_RULES.WATER_WORDS]: waterWords,
  [SEMANTIC_RULES.DIALOGUE_RATIO]: dialogueRatio,
  [SEMANTIC_RULES.NUMERIC_CONTRADICTION]: numericContradiction,
  [SEMANTIC_RULES.NUMERIC_FACT_MISMATCH]: numericFactMismatch,
  [CROSS_RULES.DUPLICATE_PARAGRAPH]: duplicateParagraph,
  [CROSS_RULES.FORESHADOW_DORMANT]: foreshadowDormant,
  [CROSS_RULES.FS_REVISITED_TOO_SOON]: revisitedTooSoon,
  [CROSS_RULES.RESOURCE_MISMATCH]: resourceMismatch,
  [CROSS_RULES.TIME_REGRESSION]: timeRegression,
  [CROSS_RULES.RELATION_UNKNOWN]: relationUnknown,
  [CROSS_RULES.LOCKED_DETAIL_DRIFT]: lockedDetailDrift,
}
