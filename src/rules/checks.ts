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

const slidingWindows = (text: string, size: number): string[] => {
  if (text.length <= size) return [text]
  const windows: string[] = []
  for (let start = 0; start + size <= text.length; start += 1) windows.push(text.slice(start, start + size))
  const tail = text.slice(text.length - size)
  if (windows[windows.length - 1] !== tail) windows.push(tail)
  return windows
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
  const longParagraphs = (text: string): string =>
    splitParagraphs(text)
      .filter((paragraph) => Array.from(paragraph.replace(/\s+/g, '')).length >= minChars)
      .join('\n\n')
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
  return changes.flatMap((change) => {
    if (change.delta === 0) return []
    const magnitude = String(Math.abs(change.delta))
    const mentioned = ctx.text.includes(change.character) && ctx.text.includes(magnitude)
    return mentioned
      ? []
      : [
          v(
            CROSS_RULES.RESOURCE_MISMATCH,
            'advisory',
            1,
            `${change.character}'s ${change.resource} change (${change.delta}) is not stated in the text`,
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
  [CROSS_RULES.DUPLICATE_PARAGRAPH]: duplicateParagraph,
  [CROSS_RULES.FORESHADOW_DORMANT]: foreshadowDormant,
  [CROSS_RULES.FS_REVISITED_TOO_SOON]: revisitedTooSoon,
  [CROSS_RULES.RESOURCE_MISMATCH]: resourceMismatch,
  [CROSS_RULES.TIME_REGRESSION]: timeRegression,
  [CROSS_RULES.RELATION_UNKNOWN]: relationUnknown,
  [CROSS_RULES.LOCKED_DETAIL_DRIFT]: lockedDetailDrift,
}
