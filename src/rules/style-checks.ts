import { STYLE_RULES } from '../codes.js'
import { dialogueRatioFor } from '../domain/style.js'
import { countWordMetrics } from '../domain/wordcount.js'
import { styleTolerances } from './style.js'
import type { Rule, RuleContext } from './types.js'
import type { Severity, Violation } from '../types.js'

/**
 * 0.2.17 style rules.
 *
 * Ten codes, one owner each. Nine are advisory: a style pack describes taste,
 * and taste must not block archiving. The single exception is
 * `STYLE_BANNED_PATTERN`, which escalates to blocker only after the pack's own
 * `banned_patterns_max` is exceeded (C4) — the author wrote "allow 1".
 *
 * Every rule returns `[]` when the project has no style, so a pre-0.2.17 project
 * produces exactly the 0.2.16 findings.
 */

const v = (code: string, severity: Severity, detail: string, paragraph = 1): Violation => ({
  code,
  severity,
  location: { paragraph },
  detail,
})

/**
 * Style rules never fire without a pack, its measurements, and actual prose.
 * An empty chapter has no style to judge — judging it would report a 0% dialogue
 * ratio as a deviation, which is a false positive about nothing.
 */
const guard = (ctx: RuleContext): boolean =>
  ctx.style !== undefined && ctx.styleMetrics !== undefined && ctx.text.trim() !== ''

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`

const bannedPattern: Rule = (ctx) => {
  if (!guard(ctx)) return []
  const pack = ctx.style!
  const metrics = ctx.styleMetrics!
  if (metrics.banned.hits === 0) return []
  const max = pack.thresholds.banned_patterns_max ?? 0
  // C4: `banned_patterns_max: 1` means "one occurrence is tolerated".
  const severity: Severity = metrics.banned.hits > max ? 'blocker' : 'advisory'
  const worst = Object.entries(metrics.banned.by_pattern)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([pattern, hits]) => `${pattern}×${hits}`)
    .join('、')
  return [
    v(
      STYLE_RULES.BANNED_PATTERN,
      severity,
      `风格禁句命中 ${metrics.banned.hits} 次（上限 ${max}）：${worst}`,
    ),
  ]
}

const sentenceMix: Rule = (ctx) => {
  if (!guard(ctx)) return []
  const pack = ctx.style!
  const metrics = ctx.styleMetrics!
  if (metrics.sentence.total === 0) return []
  const tolerance = styleTolerances(pack).sentenceMix
  const buckets: Array<[string, number, number]> = [
    ['短句', metrics.sentence.short_ratio, pack.sentence.short_ratio],
    ['中句', metrics.sentence.medium_ratio, pack.sentence.medium_ratio],
    ['长句', metrics.sentence.long_ratio, pack.sentence.long_ratio],
  ]
  const drifted = buckets.filter(([, actual, target]) => Math.abs(actual - target) > tolerance)
  if (drifted.length === 0) return []
  const detail = drifted
    .map(([label, actual, target]) => `${label} ${percent(actual)}（目标 ${percent(target)}）`)
    .join('、')
  return [v(STYLE_RULES.SENTENCE_MIX, 'advisory', `句长分布偏离目标超过 ${percent(tolerance)}：${detail}`)]
}

const burstiness: Rule = (ctx) => {
  if (!guard(ctx)) return []
  const pack = ctx.style!
  const metrics = ctx.styleMetrics!
  const min = pack.thresholds.burstiness_min
  if (min === undefined) return []
  if (metrics.sentence.total < 2) return []
  const findings: Violation[] = []
  if (metrics.sentence.cv < min) {
    findings.push(
      v(
        STYLE_RULES.BURSTINESS,
        'advisory',
        `句长变异系数 ${metrics.sentence.cv.toFixed(3)} 低于 ${min}，句子太齐整`,
      ),
    )
  }
  // The same code owns the "same length in a row" half of the design asset.
  const runLimit = pack.sentence.max_consecutive_same_length
  if (metrics.sentence.longest_run > runLimit) {
    findings.push(
      v(
        STYLE_RULES.BURSTINESS,
        'advisory',
        `连续 ${metrics.sentence.longest_run} 句长度档相同（上限 ${runLimit}）`,
      ),
    )
  }
  return findings
}

const paragraphChars: Rule = (ctx) => {
  if (!guard(ctx)) return []
  const pack = ctx.style!
  const metrics = ctx.styleMetrics!
  const limit = pack.paragraph.max_chars
  // C5: the global blocker (`LONG_PARAGRAPH`) stays the only blocker owner; this
  // rule only speaks when the pack is stricter than the global limit.
  const globalLimit = ctx.rulepack.format.paragraph_max_words
  if (limit >= globalLimit) return []
  if (metrics.paragraph.max_chars <= limit) return []
  return [
    v(
      STYLE_RULES.PARAGRAPH_CHARS,
      'advisory',
      `最长段落 ${metrics.paragraph.max_chars} 字，风格上限 ${limit} 字`,
    ),
  ]
}

const paragraphSentences: Rule = (ctx) => {
  if (!guard(ctx)) return []
  const pack = ctx.style!
  const metrics = ctx.styleMetrics!
  const limit = pack.paragraph.max_sentences
  if (metrics.paragraph.max_sentences <= limit) return []
  return [
    v(
      STYLE_RULES.PARAGRAPH_SENTENCES,
      'advisory',
      `最长段落 ${metrics.paragraph.max_sentences} 句，风格上限 ${limit} 句`,
    ),
  ]
}

const styleDialogueRatio: Rule = (ctx) => {
  if (!guard(ctx)) return []
  const pack = ctx.style!
  const metrics = ctx.styleMetrics!
  const tolerance = styleTolerances(pack).dialogueTarget
  const metric = ctx.targets?.dialogue_ratio_metric ?? 'both'
  const actual = dialogueRatioFor(metrics, metric).used
  const target = pack.dialogue.ratio
  if (Math.abs(actual - target) <= tolerance) return []
  // C6: this judges distance from the *aiming point*. `DIALOGUE_RATIO` keeps
  // judging whether the project's accepted range was left. Two questions, two codes.
  return [
    v(
      STYLE_RULES.DIALOGUE_RATIO,
      'advisory',
      `对白占比 ${percent(actual)}（口径 ${metric}）偏离风格目标 ${percent(target)} 超过 ${percent(tolerance)}`,
    ),
  ]
}

const abstractEmotion: Rule = (ctx) => {
  if (!guard(ctx)) return []
  const pack = ctx.style!
  const metrics = ctx.styleMetrics!
  const max = pack.thresholds.abstract_emotion_max
  if (max === undefined) return []
  const actual = metrics.diction.abstract_emotion_per_1000
  if (actual <= max) return []
  return [
    v(
      STYLE_RULES.ABSTRACT_EMOTION,
      'advisory',
      `抽象情绪词每千字 ${actual} 个，上限 ${max}；改写成身体反应或动作`,
    ),
  ]
}

const metaphorDensity: Rule = (ctx) => {
  if (!guard(ctx)) return []
  const pack = ctx.style!
  const metrics = ctx.styleMetrics!
  const max = pack.thresholds.metaphor_per_1000_max
  if (max === undefined) return []
  const actual = metrics.diction.metaphor_per_1000
  if (actual <= max) return []
  return [v(STYLE_RULES.METAPHOR_DENSITY, 'advisory', `比喻标记每千字 ${actual} 个，上限 ${max}`)]
}

const coolPointGap: Rule = (ctx) => {
  if (!guard(ctx)) return []
  const pack = ctx.style!
  const metrics = ctx.styleMetrics!
  const factor = styleTolerances(pack).coolPointGapFactor
  const allowed = Math.round(pack.structure.cool_point_every_chars * factor)
  const gap = metrics.structure.longest_cool_gap_chars
  if (gap <= allowed) return []
  return [
    v(
      STYLE_RULES.COOL_POINT_GAP,
      'advisory',
      `最长爽点空窗 ${gap} 字，允许 ${allowed} 字（${pack.structure.cool_point_every_chars}×${factor}）`,
    ),
  ]
}

const emotionCues: Rule = (ctx) => {
  if (!guard(ctx)) return []
  const pack = ctx.style!
  const metrics = ctx.styleMetrics!
  const min = pack.emotion.min_cues_per_1000
  if (min <= 0) return []
  const words = countWordMetrics(ctx.text).non_ws_chars
  // A very short chapter cannot carry a per-1000 floor honestly.
  if (words < 500) return []
  const actual = metrics.emotion.cues_per_1000
  if (actual >= min) return []
  return [
    v(STYLE_RULES.EMOTION_CUES, 'advisory', `情绪线索每千字 ${actual} 个，低于 ${min}；情绪要落在身体上`),
  ]
}

/** The ten style rules, in display order. Registered only when a pack exists. */
export const STYLE_RULE_IMPLEMENTATIONS: Readonly<Record<string, Rule>> = {
  [STYLE_RULES.BANNED_PATTERN]: bannedPattern,
  [STYLE_RULES.SENTENCE_MIX]: sentenceMix,
  [STYLE_RULES.BURSTINESS]: burstiness,
  [STYLE_RULES.PARAGRAPH_CHARS]: paragraphChars,
  [STYLE_RULES.PARAGRAPH_SENTENCES]: paragraphSentences,
  [STYLE_RULES.DIALOGUE_RATIO]: styleDialogueRatio,
  [STYLE_RULES.ABSTRACT_EMOTION]: abstractEmotion,
  [STYLE_RULES.METAPHOR_DENSITY]: metaphorDensity,
  [STYLE_RULES.COOL_POINT_GAP]: coolPointGap,
  [STYLE_RULES.EMOTION_CUES]: emotionCues,
}
