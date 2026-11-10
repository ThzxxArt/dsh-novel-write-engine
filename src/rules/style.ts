import { GENRES, type Genre } from '../types.js'
import { stylePatternToRegExp } from '../domain/style.js'
import type { EmotionBeat, HookMove, OpeningMove, SensoryChannel, StylePack } from './types.js'

/**
 * 0.2.17 style-pack compiler.
 *
 * A style pack is a *book-level* declaration ("what this book should look
 * like"), not a word list. The rulepack keeps owning words and global
 * thresholds; a pack only owns per-project targets (C1–C10, §4.2). Everything
 * here is pure: parse, validate, normalise. No IO, no clock.
 */

/** C1: the assets ship English tags; the engine speaks twelve Chinese genres. */
export const STYLE_GENRE_ALIASES: Readonly<Record<string, Genre>> = {
  mystery: '悬疑推理',
  suspense: '悬疑推理',
  horror: '末世流',
  urban: '都市现代',
  daily: '都市现代',
  historical: '历史架空',
  fantasy: '西方奇幻',
  romance: '言情',
  'ancient-romance': '言情',
  'sci-fi': '科幻',
  game: '游戏系统',
  wuxia: '玄幻修仙',
  xianxia: '玄幻修仙',
  apocalypse: '末世流',
  military: '军事',
  'light-novel': '轻小说',
  'infinite-flow': '无限流',
}

/** A pack id: lowercase, digits, hyphens; 2–32 chars and equal to its file name. */
const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/

const AUDIENCES = ['general', 'male', 'female'] as const
const POVS = ['first', 'third-limited', 'third-omniscient'] as const
const TENSES = ['past', 'present'] as const
const REGISTERS = ['restrained', 'neutral', 'colloquial'] as const
const DISTANCES = ['close', 'medium', 'far'] as const
const LEVELS = ['low', 'medium', 'high'] as const
const TAG_STYLES = ['sparse', 'balanced', 'rich'] as const
const TRANSITIONS = ['hard_cut', 'time_skip', 'soft'] as const
const EXPRESSIONS = ['concrete', 'restrained', 'direct'] as const
const SENSORY: readonly SensoryChannel[] = ['sight', 'sound', 'smell', 'taste', 'touch', 'cold', 'heat']
const BEATS: readonly EmotionBeat[] = [
  'body_reaction',
  'relationship_stake',
  'cost',
  'vulnerability',
  'choice',
]
const OPENING_MOVES: readonly OpeningMove[] = [
  'action',
  'anomaly',
  'ceremony',
  'countdown',
  'dialogue',
  'object',
  'routine',
  'rule',
  'silence',
  'small_anomaly',
]
const HOOK_MOVES: readonly HookMove[] = [
  'alliance_shift',
  'cost',
  'death_toll',
  'joke',
  'misunderstanding',
  'new_clue',
  'new_resource',
  'new_rule',
  'new_threat',
  'relationship',
  'relationship_shift',
  'reversal',
  'sanity_cost',
  'small_crisis',
  'unresolved_question',
]

/** One problem found while compiling; `path` is a dot path inside the pack. */
export interface StyleProblem {
  code: string
  path: string
  message: string
}

/** A compiled pack plus the advisory warnings compilation produced. */
export interface StyleCompileResult {
  pack: StylePack
  warnings: StyleProblem[]
}

/** Raised when a pack cannot be compiled; carries every problem, not just the first. */
export class StylePackError extends Error {
  readonly problems: StyleProblem[]

  constructor(fileId: string, problems: StyleProblem[]) {
    super(
      `style pack ${fileId} is invalid: ${problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ')}`,
    )
    this.name = 'StylePackError'
    this.problems = problems
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isString = (value: unknown): value is string => typeof value === 'string'

/** Count by code points so a 80-char description means 80 Chinese characters. */
const charLength = (value: string): number => [...value].length

/**
 * C2's matcher. Defined next to the metrics that count its hits so the rule and
 * the measurement cannot disagree; re-exported here because the compiler is
 * what validates a pack.
 */
export { stylePatternToRegExp }

/** Whether a banned pattern is a template rather than a literal substring. */
export const isTemplatePattern = (pattern: string): boolean => pattern.includes('……')

/**
 * Compile one style pack from parsed YAML.
 *
 * `fileId` is the file stem; the pack's `id` must match it so `/novel style show
 * <id>` can never resolve a file under a different name.
 */
export function compileStylePack(
  raw: unknown,
  options: { fileId: string; zeroTolerance?: readonly string[] },
): StyleCompileResult {
  const problems: StyleProblem[] = []
  const warnings: StyleProblem[] = []
  const fail = (path: string, message: string): void => {
    problems.push({ code: 'STYLE_INVALID', path, message })
  }

  if (!isRecord(raw)) {
    throw new StylePackError(options.fileId, [
      { code: 'STYLE_INVALID', path: '', message: 'style pack must be a mapping' },
    ])
  }

  // 1. schema_version, id, and id == file name.
  if (raw.schema_version !== 1) fail('schema_version', 'must be 1')
  const id = raw.id
  if (!isString(id) || !ID_PATTERN.test(id)) {
    fail('id', 'must match ^[a-z][a-z0-9-]{1,31}$')
  } else if (id !== options.fileId) {
    fail('id', `must equal the file name "${options.fileId}"`)
  }

  // 2. name / description.
  const name = isString(raw.name) ? raw.name.trim() : ''
  if (name === '') fail('name', 'must be a non-empty string')
  const description = isString(raw.description) ? raw.description.trim() : ''
  if (description === '') fail('description', 'must be a non-empty string')
  else if (charLength(description) > 80) fail('description', 'must be at most 80 characters')

  const enumField = <T extends string>(
    path: string,
    value: unknown,
    allowed: readonly T[],
  ): T | undefined => {
    if (!isString(value) || !(allowed as readonly string[]).includes(value)) {
      fail(path, `must be one of ${allowed.join(', ')}`)
      return undefined
    }
    return value as T
  }

  const audience = enumField('audience', raw.audience, AUDIENCES)
  const pov = enumField('pov', raw.pov, POVS)
  const tense = enumField('tense', raw.tense, TENSES)
  const register = enumField('register', raw.register, REGISTERS)
  const narrativeDistance = enumField('narrative_distance', raw.narrative_distance, DISTANCES)

  // 10. genres: every tag must normalise to an engine genre.
  const genreTags = Array.isArray(raw.genres) ? raw.genres : []
  if (genreTags.length === 0) fail('genres', 'must list at least one genre tag')
  const genres: Genre[] = []
  for (const [index, tag] of genreTags.entries()) {
    if (!isString(tag)) {
      fail(`genres[${index}]`, 'must be a string')
      continue
    }
    const normalised = (GENRES as readonly string[]).includes(tag) ? (tag as Genre) : STYLE_GENRE_ALIASES[tag]
    if (normalised === undefined) {
      fail(`genres[${index}]`, `unknown genre tag "${tag}"`)
      continue
    }
    if (!genres.includes(normalised)) genres.push(normalised)
  }

  const numberIn = (path: string, value: unknown, min: number, max: number): number | undefined => {
    if (!isNumber(value)) {
      fail(path, 'must be a finite number')
      return undefined
    }
    if (value < min || value > max) {
      fail(path, `must be within ${min}..${max}`)
      return undefined
    }
    return value
  }

  // 3. sentence ratios.
  const sentenceRaw = isRecord(raw.sentence) ? raw.sentence : {}
  if (!isRecord(raw.sentence)) fail('sentence', 'must be a mapping')
  const shortRatio = numberIn('sentence.short_ratio', sentenceRaw.short_ratio, 0, 1)
  const mediumRatio = numberIn('sentence.medium_ratio', sentenceRaw.medium_ratio, 0, 1)
  const longRatio = numberIn('sentence.long_ratio', sentenceRaw.long_ratio, 0, 1)
  if (shortRatio !== undefined && mediumRatio !== undefined && longRatio !== undefined) {
    const sum = shortRatio + mediumRatio + longRatio
    if (sum < 0.98 || sum > 1.02) fail('sentence', `ratios must sum to 1 (got ${sum.toFixed(3)})`)
  }
  const burstiness = enumField('sentence.burstiness', sentenceRaw.burstiness, LEVELS)
  const maxConsecutive = numberIn(
    'sentence.max_consecutive_same_length',
    sentenceRaw.max_consecutive_same_length,
    1,
    12,
  )

  // 4. paragraph limits.
  const paragraphRaw = isRecord(raw.paragraph) ? raw.paragraph : {}
  if (!isRecord(raw.paragraph)) fail('paragraph', 'must be a mapping')
  const maxChars = numberIn('paragraph.max_chars', paragraphRaw.max_chars, 40, 400)
  const maxSentences = numberIn('paragraph.max_sentences', paragraphRaw.max_sentences, 1, 12)
  const maxActions = numberIn('paragraph.max_actions', paragraphRaw.max_actions, 0, 12)
  if (typeof paragraphRaw.one_action_per_paragraph !== 'boolean') {
    fail('paragraph.one_action_per_paragraph', 'must be a boolean')
  }

  // 5. dialogue.
  const dialogueRaw = isRecord(raw.dialogue) ? raw.dialogue : {}
  if (!isRecord(raw.dialogue)) fail('dialogue', 'must be a mapping')
  const dialogueRatio = numberIn('dialogue.ratio', dialogueRaw.ratio, 0, 1)
  const tagStyle = enumField('dialogue.tag_style', dialogueRaw.tag_style, TAG_STYLES)
  if (typeof dialogueRaw.allow_interruptions !== 'boolean')
    fail('dialogue.allow_interruptions', 'must be a boolean')
  if (typeof dialogueRaw.allow_fragments !== 'boolean') fail('dialogue.allow_fragments', 'must be a boolean')

  // diction: enum levels plus sensory channels.
  const dictionRaw = isRecord(raw.diction) ? raw.diction : {}
  if (!isRecord(raw.diction)) fail('diction', 'must be a mapping')
  const abstractEmotionDensity = enumField(
    'diction.abstract_emotion_density',
    dictionRaw.abstract_emotion_density,
    LEVELS,
  )
  const metaphorDensity = enumField('diction.metaphor_density', dictionRaw.metaphor_density, LEVELS)
  const adjectiveDensity = enumField('diction.adjective_density', dictionRaw.adjective_density, LEVELS)
  const slang = enumField('diction.slang', dictionRaw.slang, LEVELS)
  const idiom = enumField('diction.idiom', dictionRaw.idiom, LEVELS)
  const sensoryChannels: SensoryChannel[] = []
  if (!Array.isArray(dictionRaw.sensory_channels)) {
    fail('diction.sensory_channels', 'must be an array')
  } else {
    for (const [index, channel] of dictionRaw.sensory_channels.entries()) {
      if (!isString(channel) || !(SENSORY as readonly string[]).includes(channel)) {
        fail(`diction.sensory_channels[${index}]`, `must be one of ${SENSORY.join(', ')}`)
        continue
      }
      if (!sensoryChannels.includes(channel as SensoryChannel))
        sensoryChannels.push(channel as SensoryChannel)
    }
  }

  // structure: moves and cool-point spacing.
  const structureRaw = isRecord(raw.structure) ? raw.structure : {}
  if (!isRecord(raw.structure)) fail('structure', 'must be a mapping')
  const moves = <T extends string>(path: string, value: unknown, allowed: readonly T[]): T[] => {
    if (!Array.isArray(value)) {
      fail(path, 'must be an array')
      return []
    }
    const out: T[] = []
    for (const [index, item] of value.entries()) {
      if (!isString(item) || !(allowed as readonly string[]).includes(item)) {
        fail(`${path}[${index}]`, `must be one of ${allowed.join(', ')}`)
        continue
      }
      if (!out.includes(item as T)) out.push(item as T)
    }
    return out
  }
  const openingMoves = moves('structure.opening_moves', structureRaw.opening_moves, OPENING_MOVES)
  const hookMoves = moves('structure.hook_moves', structureRaw.hook_moves, HOOK_MOVES)
  const sceneTransition = enumField('structure.scene_transition', structureRaw.scene_transition, TRANSITIONS)
  const coolPointEvery = numberIn(
    'structure.cool_point_every_chars',
    structureRaw.cool_point_every_chars,
    200,
    5000,
  )

  // emotion.
  const emotionRaw = isRecord(raw.emotion) ? raw.emotion : {}
  if (!isRecord(raw.emotion)) fail('emotion', 'must be a mapping')
  const emotionIntensity = enumField('emotion.intensity', emotionRaw.intensity, LEVELS)
  const emotionExpression = enumField('emotion.expression', emotionRaw.expression, EXPRESSIONS)
  const requiredBeats = moves('emotion.required_beats', emotionRaw.required_beats, BEATS)
  const minCuesPer1000 = numberIn('emotion.min_cues_per_1000', emotionRaw.min_cues_per_1000, 0, 10)

  // 6. banned_patterns.
  const bannedRaw = Array.isArray(raw.banned_patterns) ? raw.banned_patterns : []
  if (!Array.isArray(raw.banned_patterns)) fail('banned_patterns', 'must be an array')
  if (bannedRaw.length < 1 || bannedRaw.length > 40) {
    fail('banned_patterns', 'must hold 1..40 entries')
  }
  const zeroTolerance = new Set(options.zeroTolerance ?? [])
  const bannedPatterns: string[] = []

  for (const [index, pattern] of bannedRaw.entries()) {
    if (!isString(pattern)) {
      fail(`banned_patterns[${index}]`, 'must be a string')
      continue
    }
    const trimmed = pattern.trim()
    const length = charLength(trimmed)
    if (length < 2 || length > 40) {
      fail(`banned_patterns[${index}]`, 'must be 2..40 characters')
      continue
    }
    if (bannedPatterns.includes(trimmed)) {
      fail(`banned_patterns[${index}]`, `duplicate pattern "${trimmed}"`)
      continue
    }
    if (trimmed.includes('……')) {
      // `不是……而是……` is the shape authors actually write: two gaps, one of
      // them trailing. A leading gap is rejected because `……X` can only ever
      // match `X`, i.e. it is a substring rule wearing a template's clothes.
      if (trimmed.startsWith('……')) {
        fail(`banned_patterns[${index}]`, 'a template pattern cannot start with ……')
        continue
      }
      const gaps = trimmed.split('……').length - 1
      if (gaps > 3) {
        fail(`banned_patterns[${index}]`, 'a template pattern supports at most 3 gaps')
        continue
      }
      // 14. the template must compile into `A.{0,12}B`. Escaping makes this
      // total, so a compile failure is not a reachable state; the assertion is
      // the guard, not a try/catch around it.
      stylePatternToRegExp(trimmed)
    }
    // 13/C3: one word, one owner — zero-tolerance already blocks it.
    if (zeroTolerance.has(trimmed)) {
      warnings.push({
        code: 'STYLE_BANNED_OVERLAP',
        path: `banned_patterns[${index}]`,
        message: `"${trimmed}" is already zero-tolerance; removed from the style side`,
      })
      continue
    }
    bannedPatterns.push(trimmed)
  }

  // 7. exemplars.
  const exemplarsRaw = Array.isArray(raw.exemplars) ? raw.exemplars : []
  if (!Array.isArray(raw.exemplars)) fail('exemplars', 'must be an array')
  if (exemplarsRaw.length < 1 || exemplarsRaw.length > 3) fail('exemplars', 'must hold 1..3 entries')
  const exemplars: string[] = []
  for (const [index, exemplar] of exemplarsRaw.entries()) {
    if (!isString(exemplar)) {
      fail(`exemplars[${index}]`, 'must be a string')
      continue
    }
    const text = exemplar.trim()
    const length = charLength(text)
    if (length < 40 || length > 400) {
      fail(`exemplars[${index}]`, 'must be 40..400 characters')
      continue
    }
    if (text.includes('\r')) {
      fail(`exemplars[${index}]`, 'must not contain CRLF')
      continue
    }
    const marker = ['#', '**', '---'].find((candidate) => text.includes(candidate))
    if (marker !== undefined) {
      fail(`exemplars[${index}]`, `must not contain the markdown marker ${marker}`)
      continue
    }
    exemplars.push(text)
  }

  // 8. critic_rubric.
  const rubricRaw = Array.isArray(raw.critic_rubric) ? raw.critic_rubric : []
  if (!Array.isArray(raw.critic_rubric)) fail('critic_rubric', 'must be an array')
  if (rubricRaw.length < 3 || rubricRaw.length > 8) fail('critic_rubric', 'must hold 3..8 entries')
  const criticRubric: string[] = []
  for (const [index, line] of rubricRaw.entries()) {
    if (!isString(line)) {
      fail(`critic_rubric[${index}]`, 'must be a string')
      continue
    }
    const text = line.trim()
    const length = charLength(text)
    if (length < 4 || length > 60) {
      fail(`critic_rubric[${index}]`, 'must be 4..60 characters')
      continue
    }
    criticRubric.push(text)
  }

  // 11 + 5. thresholds.
  const thresholdsRaw = isRecord(raw.thresholds) ? raw.thresholds : {}
  if (!isRecord(raw.thresholds)) fail('thresholds', 'must be a mapping')
  const optionalNumber = (path: string, value: unknown, min: number, max: number): number | undefined => {
    if (value === undefined) return undefined
    return numberIn(path, value, min, max)
  }
  const burstinessMin = optionalNumber('thresholds.burstiness_min', thresholdsRaw.burstiness_min, 0, 5)
  const dialogueRatioMin = optionalNumber(
    'thresholds.dialogue_ratio_min',
    thresholdsRaw.dialogue_ratio_min,
    0,
    1,
  )
  const dialogueRatioMax = optionalNumber(
    'thresholds.dialogue_ratio_max',
    thresholdsRaw.dialogue_ratio_max,
    0,
    1,
  )
  if (
    dialogueRatioMin !== undefined &&
    dialogueRatioMax !== undefined &&
    dialogueRatioMin > dialogueRatioMax
  ) {
    fail('thresholds', 'dialogue_ratio_min must not exceed dialogue_ratio_max')
  }
  const bannedPatternsMax = optionalNumber(
    'thresholds.banned_patterns_max',
    thresholdsRaw.banned_patterns_max,
    0,
    100,
  )
  const abstractEmotionMax = optionalNumber(
    'thresholds.abstract_emotion_max',
    thresholdsRaw.abstract_emotion_max,
    1,
    100,
  )
  const metaphorPer1000Max = optionalNumber(
    'thresholds.metaphor_per_1000_max',
    thresholdsRaw.metaphor_per_1000_max,
    0,
    100,
  )
  const sentenceMixTolerance = optionalNumber(
    'thresholds.sentence_mix_tolerance',
    thresholdsRaw.sentence_mix_tolerance,
    0,
    1,
  )
  const dialogueTargetTolerance = optionalNumber(
    'thresholds.dialogue_target_tolerance',
    thresholdsRaw.dialogue_target_tolerance,
    0,
    1,
  )
  const coolPointGapFactor = optionalNumber(
    'thresholds.cool_point_gap_factor',
    thresholdsRaw.cool_point_gap_factor,
    1,
    10,
  )

  if (problems.length > 0) throw new StylePackError(options.fileId, problems)

  return {
    pack: {
      schema_version: 1,
      id: id as string,
      name,
      description,
      audience: audience as StylePack['audience'],
      genre_tags: genreTags.filter(isString),
      genres,
      pov: pov as StylePack['pov'],
      tense: tense as StylePack['tense'],
      register: register as StylePack['register'],
      narrative_distance: narrativeDistance as StylePack['narrative_distance'],
      sentence: {
        short_ratio: shortRatio as number,
        medium_ratio: mediumRatio as number,
        long_ratio: longRatio as number,
        burstiness: burstiness as StylePack['sentence']['burstiness'],
        max_consecutive_same_length: maxConsecutive as number,
      },
      paragraph: {
        max_chars: maxChars as number,
        one_action_per_paragraph: paragraphRaw.one_action_per_paragraph as boolean,
        max_sentences: maxSentences as number,
        max_actions: maxActions as number,
      },
      dialogue: {
        ratio: dialogueRatio as number,
        tag_style: tagStyle as StylePack['dialogue']['tag_style'],
        allow_interruptions: dialogueRaw.allow_interruptions as boolean,
        allow_fragments: dialogueRaw.allow_fragments as boolean,
      },
      diction: {
        abstract_emotion_density: abstractEmotionDensity as StylePack['diction']['abstract_emotion_density'],
        metaphor_density: metaphorDensity as StylePack['diction']['metaphor_density'],
        adjective_density: adjectiveDensity as StylePack['diction']['adjective_density'],
        slang: slang as StylePack['diction']['slang'],
        idiom: idiom as StylePack['diction']['idiom'],
        sensory_channels: sensoryChannels,
      },
      structure: {
        opening_moves: openingMoves,
        scene_transition: sceneTransition as StylePack['structure']['scene_transition'],
        hook_moves: hookMoves,
        cool_point_every_chars: coolPointEvery as number,
      },
      emotion: {
        intensity: emotionIntensity as StylePack['emotion']['intensity'],
        expression: emotionExpression as StylePack['emotion']['expression'],
        required_beats: requiredBeats,
        min_cues_per_1000: minCuesPer1000 as number,
      },
      banned_patterns: bannedPatterns,
      exemplars,
      critic_rubric: criticRubric,
      thresholds: {
        ...(burstinessMin === undefined ? {} : { burstiness_min: burstinessMin }),
        ...(dialogueRatioMin === undefined ? {} : { dialogue_ratio_min: dialogueRatioMin }),
        ...(dialogueRatioMax === undefined ? {} : { dialogue_ratio_max: dialogueRatioMax }),
        ...(bannedPatternsMax === undefined ? {} : { banned_patterns_max: bannedPatternsMax }),
        ...(abstractEmotionMax === undefined ? {} : { abstract_emotion_max: abstractEmotionMax }),
        ...(metaphorPer1000Max === undefined ? {} : { metaphor_per_1000_max: metaphorPer1000Max }),
        ...(sentenceMixTolerance === undefined ? {} : { sentence_mix_tolerance: sentenceMixTolerance }),
        ...(dialogueTargetTolerance === undefined
          ? {}
          : { dialogue_target_tolerance: dialogueTargetTolerance }),
        ...(coolPointGapFactor === undefined ? {} : { cool_point_gap_factor: coolPointGapFactor }),
      },
    },
    warnings,
  }
}

/**
 * Compile a whole catalogue and enforce the cross-pack rules (`id` and `name`
 * are unique). Returns packs sorted by id so output and ETags are stable.
 */
export function compileStyleCatalogue(
  entries: ReadonlyArray<{ fileId: string; raw: unknown }>,
  options: { zeroTolerance?: readonly string[] } = {},
): { packs: StylePack[]; warnings: StyleProblem[] } {
  const packs: StylePack[] = []
  const warnings: StyleProblem[] = []
  const seenIds = new Map<string, string>()
  const seenNames = new Map<string, string>()
  for (const entry of entries) {
    const result = compileStylePack(entry.raw, { fileId: entry.fileId, zeroTolerance: options.zeroTolerance })
    const duplicateId = seenIds.get(result.pack.id)
    if (duplicateId !== undefined) {
      throw new StylePackError(entry.fileId, [
        {
          code: 'STYLE_DUPLICATE_ID',
          path: 'id',
          message: `duplicate id "${result.pack.id}" (also in ${duplicateId})`,
        },
      ])
    }
    const duplicateName = seenNames.get(result.pack.name)
    if (duplicateName !== undefined) {
      throw new StylePackError(entry.fileId, [
        {
          code: 'STYLE_DUPLICATE_NAME',
          path: 'name',
          message: `duplicate name "${result.pack.name}" (also in ${duplicateName})`,
        },
      ])
    }
    seenIds.set(result.pack.id, entry.fileId)
    seenNames.set(result.pack.name, entry.fileId)
    packs.push(result.pack)
    warnings.push(
      ...result.warnings.map((warning) => ({ ...warning, path: `${entry.fileId}:${warning.path}` })),
    )
  }
  packs.sort((left, right) => left.id.localeCompare(right.id))
  return { packs, warnings }
}

/** Resolve the three optional tolerances to their documented defaults. */
export function styleTolerances(pack: StylePack): {
  sentenceMix: number
  dialogueTarget: number
  coolPointGapFactor: number
} {
  return {
    sentenceMix: pack.thresholds.sentence_mix_tolerance ?? 0.15,
    dialogueTarget: pack.thresholds.dialogue_target_tolerance ?? 0.15,
    coolPointGapFactor: pack.thresholds.cool_point_gap_factor ?? 1.5,
  }
}
