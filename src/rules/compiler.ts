import { SCORE_DIMENSIONS, FULL_SCORE, type Exclusion } from '../domain/scoring.js'
import { ALL_RULE_CODES } from '../codes.js'
import { ERROR_CODES, GENRES, PLATFORMS, SCENE_TYPES, SCHEMA_VERSION, EngineFaultError } from '../types.js'
import type { Rulepack } from './types.js'

const platformDefaults = (words: [number, number], dialogue: [number, number]) => ({
  words_per_chapter: words,
  dialogue_ratio: dialogue,
})

/** Minimal pack used to fill optional blocks; every value is overridable in YAML. */
export const DEFAULT_RULEPACK: Rulepack = {
  schema_version: SCHEMA_VERSION,
  name: 'default',
  version: '0.0.0',
  lexicon: {
    zero_tolerance: [],
    soft: [],
    contextual: [],
    meta_narration: [],
    reader_intrusion: [],
    god_view: [],
    conclusion_first: { verbs: [], causals: [] },
  },
  format: {
    paragraph_max_words: 90,
    forbid_markdown: true,
    forbid_semicolon: true,
    forbid_english_ellipsis: true,
    title: { pattern: '^第\\d+章\\s', min_chars: 4, max_chars: 8 },
    system_labels: [],
    scene_separators: ['———', '***', '…………'],
    markdown_markers: ['#', '**', '---', '>', '|'],
  },
  punctuation: {
    dash: {
      base: { '战斗/动作章': 3, 日常过渡章: 4, 情感爆发章: 6, 纯叙事章: 3 },
      scale_words: 3000,
      token: '——',
    },
    period_density: { min: 1.5, max: 8 },
    ellipsis_run: { max: 1, token: '……' },
    uniform_sentence: { min_sentences: 8, ratio: 0.6 },
    consecutive_le: { max: 3, char: '了' },
    dialogue_dominant_ratio: 0.6,
  },
  semantics: {
    adjective_density: { max: 4, adjectives: [] },
    pleasure_density: { min: 1, keywords: [], window: 600 },
    sensory_density: { min: 2, senses: [], window: 800 },
    water_words: {
      window: 150,
      threshold: 0.35,
      scene_thresholds: { '战斗/动作章': 0.25, 日常过渡章: 0.35, 情感爆发章: 0.3, 纯叙事章: 0.4 },
      terms: [],
    },
  },
  platform: {
    fanqie: platformDefaults([2000, 3000], [0.4, 0.6]),
    qidian: platformDefaults([2000, 3500], [0.3, 0.5]),
    qimao: platformDefaults([1500, 2500], [0.45, 0.65]),
    jinjiang: platformDefaults([2500, 4000], [0.35, 0.55]),
  },
  genres: Object.fromEntries(GENRES.map((genre) => [genre, { note: '' }])) as Rulepack['genres'],
  crosschapter: {
    duplicate_similarity: 0.9,
    duplicate_advisory: 0.75,
    duplicate_min_chars: 20,
    foreshadow_min_dormancy: 2,
    foreshadow_dormant_after: 20,
    check_time: true,
    lock_similarity: 0.75,
  },
  quality: { dimensions: SCORE_DIMENSIONS.map(({ id, max }) => ({ id, max })) },
  exclusions: [],
  exemptions: [],
}

type Unknown = Record<string, unknown>

const invalid = (message: string): never => {
  throw new EngineFaultError(ERROR_CODES.RULEPACK_INVALID, `rule pack rejected: ${message}`)
}

const object = (value: unknown, path: string): Unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return invalid(`${path} must be an object`)
  return value as Unknown
}

const array = (value: unknown, path: string): unknown[] => {
  if (!Array.isArray(value)) return invalid(`${path} must be an array`)
  return value
}

const num = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(`${path} must be a number`)
  return value
}

const string = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.trim() === '') return invalid(`${path} must be a non-empty string`)
  return value
}

const bool = (value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') return invalid(`${path} must be a boolean`)
  return value
}

const knownKeys = (value: Unknown, allowed: readonly string[], path: string): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${path}.${key} is not a recognised key`)
  }
}

/**
 * Six assertions, each mapping to one class of pack defect:
 * completeness, shape, duplicate ownership, dangling references, threshold
 * bounds, and the 150-point arithmetic.
 */
export function compileRulepack(raw: unknown): Rulepack {
  const root = object(raw, 'root')
  if (root.schema_version !== SCHEMA_VERSION) invalid(`schema_version must be ${SCHEMA_VERSION}`)
  knownKeys(
    root,
    [
      'schema_version',
      'name',
      'version',
      'lexicon',
      'format',
      'punctuation',
      'semantics',
      'platform',
      'genres',
      'crosschapter',
      'quality',
      'exclusions',
      'exemptions',
    ],
    'root',
  )
  const pack = normalize(raw as Partial<Rulepack>)
  const rawPlatform = object(root.platform, 'platform')
  for (const platform of PLATFORMS) {
    if (rawPlatform[platform] === undefined) invalid(`platform.${platform} is missing`)
  }
  const rawGenres = object(root.genres, 'genres')
  for (const genre of GENRES) {
    if (rawGenres[genre] === undefined) invalid(`genres.${genre} is missing`)
  }

  // 1. completeness: the fifteen dimensions must sum to exactly 150.
  if (pack.quality.dimensions.length !== SCORE_DIMENSIONS.length) {
    invalid(`quality.dimensions must contain exactly ${SCORE_DIMENSIONS.length} dimensions`)
  }
  const ids = new Set<string>()
  for (const dimension of pack.quality.dimensions) {
    const spec = SCORE_DIMENSIONS.find((candidate) => candidate.id === dimension.id)
    if (spec === undefined) {
      invalid(`quality.dimensions contains unknown dimension ${dimension.id}`)
      continue
    }
    if (ids.has(dimension.id)) invalid(`quality.dimensions repeats ${dimension.id}`)
    ids.add(dimension.id)
    if (dimension.max !== spec.max) {
      invalid(`quality.dimensions ${dimension.id} max must be ${spec.max}, got ${dimension.max}`)
    }
  }
  const sum = pack.quality.dimensions.reduce((total, dimension) => total + dimension.max, 0)
  if (sum !== FULL_SCORE) invalid(`dimension maxima sum to ${sum}, expected ${FULL_SCORE}`)
  for (const dimension of SCORE_DIMENSIONS) {
    if (!ids.has(dimension.id)) invalid(`quality.dimensions is missing ${dimension.id}`)
  }

  // 2. shape: lexicon entries and their limits.
  const textList = (value: readonly string[], path: string): void => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
      invalid(`${path} must be a non-empty string array`)
    }
  }
  const validateTermList = (list: readonly unknown[], listName: string, kind: 'term' | 'limit'): void => {
    for (const [index, raw] of list.entries()) {
      const path = `lexicon.${listName}[${index}]`
      const entry = object(raw, path)
      knownKeys(
        entry,
        kind === 'limit' ? ['term', 'limit', 'genres'] : ['term', 'note', 'dialogueExempt'],
        path,
      )
      if (typeof entry.term !== 'string' || entry.term.trim() === '') {
        invalid('lexicon contains an empty term')
      }
      if (kind === 'limit') {
        const limit = num(entry.limit, `${path}.limit`)
        if (limit < 0) invalid(`${path}.limit must not be negative`)
        if (entry.genres !== undefined) {
          const genres = array(entry.genres, `${path}.genres`)
          for (const genre of genres) {
            if (typeof genre !== 'string' || !(GENRES as readonly string[]).includes(genre)) {
              invalid(`${path}.genres contains unknown genre ${String(genre)}`)
            }
          }
        }
      } else {
        if (entry.note !== undefined) string(entry.note, `${path}.note`)
        if (entry.dialogueExempt !== undefined) bool(entry.dialogueExempt, `${path}.dialogueExempt`)
      }
    }
  }
  validateTermList(pack.lexicon.zero_tolerance, 'zero_tolerance', 'term')
  validateTermList(pack.lexicon.soft, 'soft', 'limit')
  validateTermList(pack.lexicon.contextual, 'contextual', 'limit')
  validateTermList(pack.lexicon.meta_narration, 'meta_narration', 'term')
  for (const listName of ['reader_intrusion', 'god_view'] as const) {
    for (const [index, raw] of pack.lexicon[listName].entries()) {
      const path = `lexicon.${listName}[${index}]`
      const entry = object(raw, path)
      knownKeys(entry, ['pattern'], path)
      string(entry.pattern, `${path}.pattern`)
    }
  }
  const conclusionFirst = object(pack.lexicon.conclusion_first, 'lexicon.conclusion_first')
  knownKeys(conclusionFirst, ['verbs', 'causals'], 'lexicon.conclusion_first')
  textList(
    array(conclusionFirst.verbs, 'lexicon.conclusion_first.verbs') as string[],
    'lexicon.conclusion_first.verbs',
  )
  textList(
    array(conclusionFirst.causals, 'lexicon.conclusion_first.causals') as string[],
    'lexicon.conclusion_first.causals',
  )
  for (const genre of GENRES) {
    const guide = object(pack.genres[genre], `genres.${genre}`)
    knownKeys(guide, ['note'], `genres.${genre}`)
    if (typeof guide.note !== 'string') invalid(`genres.${genre}.note must be a string`)
  }

  const nonNegative = (value: number, path: string): void => {
    if (!Number.isFinite(value) || value < 0) invalid(`${path} must be a non-negative number`)
  }
  const positiveInt = (value: number, path: string): void => {
    if (!Number.isInteger(value) || value <= 0) invalid(`${path} must be a positive integer`)
  }
  const ratio = (value: number, path: string): void => {
    if (!Number.isFinite(value) || value < 0 || value > 1) invalid(`${path} must be within 0..1`)
  }
  if (!Number.isInteger(pack.format.title.min_chars) || pack.format.title.min_chars < 1) {
    invalid('format.title.min_chars must be a positive integer')
  }
  if (
    !Number.isInteger(pack.format.title.max_chars) ||
    pack.format.title.max_chars < pack.format.title.min_chars
  ) {
    invalid('format.title.max_chars must be an integer >= min_chars')
  }
  textList(pack.format.system_labels, 'format.system_labels')
  textList(pack.format.scene_separators, 'format.scene_separators')
  textList(pack.format.markdown_markers, 'format.markdown_markers')
  positiveInt(pack.punctuation.dash.scale_words, 'punctuation.dash.scale_words')
  if (typeof pack.punctuation.dash.token !== 'string' || pack.punctuation.dash.token === '') {
    invalid('punctuation.dash.token must be a non-empty string')
  }
  for (const scene of SCENE_TYPES) {
    nonNegative(pack.punctuation.dash.base[scene] ?? -1, `punctuation.dash.base.${scene}`)
  }
  nonNegative(pack.punctuation.period_density.min, 'punctuation.period_density.min')
  nonNegative(pack.punctuation.period_density.max, 'punctuation.period_density.max')
  if (pack.punctuation.period_density.min > pack.punctuation.period_density.max) {
    invalid('punctuation.period_density.min must not exceed max')
  }
  if (!Number.isInteger(pack.punctuation.ellipsis_run.max) || pack.punctuation.ellipsis_run.max < 0) {
    invalid('punctuation.ellipsis_run.max must be a non-negative integer')
  }
  if (typeof pack.punctuation.ellipsis_run.token !== 'string' || pack.punctuation.ellipsis_run.token === '') {
    invalid('punctuation.ellipsis_run.token must be a non-empty string')
  }
  try {
    const escaped = pack.punctuation.ellipsis_run.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    void new RegExp(`(?:${escaped}){${pack.punctuation.ellipsis_run.max + 1},}`)
  } catch {
    invalid('punctuation.ellipsis_run.token cannot form a valid repetition pattern')
  }
  positiveInt(pack.punctuation.uniform_sentence.min_sentences, 'punctuation.uniform_sentence.min_sentences')
  ratio(pack.punctuation.uniform_sentence.ratio, 'punctuation.uniform_sentence.ratio')
  if (!Number.isInteger(pack.punctuation.consecutive_le.max) || pack.punctuation.consecutive_le.max < 0) {
    invalid('punctuation.consecutive_le.max must be a non-negative integer')
  }
  if (Array.from(pack.punctuation.consecutive_le.char).length !== 1) {
    invalid('punctuation.consecutive_le.char must be one character')
  }
  ratio(pack.punctuation.dialogue_dominant_ratio, 'punctuation.dialogue_dominant_ratio')
  nonNegative(pack.semantics.adjective_density.max, 'semantics.adjective_density.max')
  textList(pack.semantics.adjective_density.adjectives, 'semantics.adjective_density.adjectives')
  nonNegative(pack.semantics.pleasure_density.min, 'semantics.pleasure_density.min')
  positiveInt(pack.semantics.pleasure_density.window, 'semantics.pleasure_density.window')
  textList(pack.semantics.pleasure_density.keywords, 'semantics.pleasure_density.keywords')
  nonNegative(pack.semantics.sensory_density.min, 'semantics.sensory_density.min')
  positiveInt(pack.semantics.sensory_density.window, 'semantics.sensory_density.window')
  textList(pack.semantics.sensory_density.senses, 'semantics.sensory_density.senses')
  positiveInt(pack.semantics.water_words.window, 'semantics.water_words.window')
  ratio(pack.semantics.water_words.threshold, 'semantics.water_words.threshold')
  textList(pack.semantics.water_words.terms, 'semantics.water_words.terms')
  for (const [scene, value] of Object.entries(pack.semantics.water_words.scene_thresholds ?? {})) {
    ratio(value as number, `semantics.water_words.scene_thresholds.${scene}`)
  }
  for (const platform of PLATFORMS) {
    const profile = pack.platform[platform]
    if (!Array.isArray(profile?.words_per_chapter) || !Array.isArray(profile.dialogue_ratio)) {
      invalid(`platform.${platform} must declare words_per_chapter and dialogue_ratio`)
    }
    positiveInt(profile.words_per_chapter[0], `platform.${platform}.words_per_chapter[0]`)
    positiveInt(profile.words_per_chapter[1], `platform.${platform}.words_per_chapter[1]`)
    if (profile.words_per_chapter[0] > profile.words_per_chapter[1]) {
      invalid(`platform.${platform}.words_per_chapter min must not exceed max`)
    }
    ratio(profile.dialogue_ratio[0], `platform.${platform}.dialogue_ratio[0]`)
    ratio(profile.dialogue_ratio[1], `platform.${platform}.dialogue_ratio[1]`)
    if (profile.dialogue_ratio[0] > profile.dialogue_ratio[1]) {
      invalid(`platform.${platform}.dialogue_ratio min must not exceed max`)
    }
  }
  ratio(pack.crosschapter.duplicate_similarity, 'crosschapter.duplicate_similarity')
  ratio(pack.crosschapter.duplicate_advisory, 'crosschapter.duplicate_advisory')
  if (pack.crosschapter.duplicate_advisory > pack.crosschapter.duplicate_similarity) {
    invalid('crosschapter.duplicate_advisory must not exceed duplicate_similarity')
  }
  positiveInt(pack.crosschapter.duplicate_min_chars, 'crosschapter.duplicate_min_chars')
  for (const key of ['foreshadow_min_dormancy', 'foreshadow_dormant_after'] as const) {
    if (!Number.isInteger(pack.crosschapter[key]) || pack.crosschapter[key] < 0) {
      invalid(`crosschapter.${key} must be a non-negative integer`)
    }
  }
  ratio(pack.crosschapter.lock_similarity, 'crosschapter.lock_similarity')

  // 3. duplicate ownership: one term may appear once per list.
  const seen = new Map<string, string>()
  const checkUnique = (list: readonly { term: string }[], listName: string): void => {
    for (const entry of list) {
      const owner = seen.get(entry.term)
      if (owner !== undefined) invalid(`term "${entry.term}" appears in both ${owner} and ${listName}`)
      seen.set(entry.term, listName)
    }
  }
  checkUnique(pack.lexicon.zero_tolerance, 'zero_tolerance')
  checkUnique(pack.lexicon.soft, 'soft')
  checkUnique(pack.lexicon.contextual, 'contextual')
  checkUnique(pack.lexicon.meta_narration, 'meta_narration')

  // 4. dangling references: exclusions and exemptions must name real codes.
  const known = new Set<string>(ALL_RULE_CODES)
  for (const [index, raw] of pack.exclusions.entries()) {
    const path = `exclusions[${index}]`
    const exclusion = object(raw, path)
    knownKeys(exclusion, ['pair', 'family'], path)
    const pair = array(exclusion.pair, `${path}.pair`)
    if (pair.length !== 2) invalid(`${path}.pair must contain exactly two rule codes`)
    for (const code of pair) {
      if (typeof code !== 'string' || !known.has(code)) {
        invalid(`exclusion references unknown rule ${String(code)}`)
      }
    }
    if (pair[0] === pair[1]) invalid(`exclusion pairs "${String(pair[0])}" with itself`)
    if (typeof exclusion.family !== 'string' || exclusion.family.trim() === '') {
      invalid('exclusion family is empty')
    }
  }
  for (const [index, code] of pack.exemptions.entries()) {
    if (typeof code !== 'string' || !known.has(code)) {
      invalid(`exemption references unknown rule ${String(code)} at index ${index}`)
    }
  }

  // 5. threshold bounds: values that would silently disable a check are refused.
  if (pack.format.paragraph_max_words < 20 || pack.format.paragraph_max_words > 500) {
    invalid('format.paragraph_max_words must be within 20..500')
  }

  // 6. title pattern must compile; a broken regex must fail at load, not at draft time.
  try {
    void new RegExp(pack.format.title.pattern)
  } catch {
    invalid('format.title.pattern is not a valid regular expression')
  }
  for (const pattern of [...pack.lexicon.reader_intrusion, ...pack.lexicon.god_view]) {
    try {
      void new RegExp(pattern.pattern)
    } catch {
      invalid(`lexicon pattern "${pattern.pattern}" is not a valid regular expression`)
    }
  }

  return freeze(pack)
}

const merge = <T extends Unknown>(base: T, override: unknown, path: string): T => {
  if (override === undefined) return base
  const over = object(override, path)
  const result: Unknown = { ...base }
  for (const [key, value] of Object.entries(over)) {
    const current = (base as Unknown)[key]
    if (current === undefined) {
      result[key] = structuredClone(value)
      continue
    }
    if (
      typeof current === 'object' &&
      current !== null &&
      !Array.isArray(current) &&
      typeof value === 'object'
    ) {
      result[key] = merge(current as Unknown, value, `${path}.${key}`)
      continue
    }
    result[key] = structuredClone(value)
  }
  return result as T
}

/** Fill optional blocks from defaults and check scalar types of the result. */
export function normalize(raw: Partial<Rulepack>): Rulepack {
  const merged = merge(
    structuredClone(DEFAULT_RULEPACK) as unknown as Unknown,
    raw,
    'root',
  ) as unknown as Rulepack
  merged.name = string(merged.name, 'name')
  merged.version = string(merged.version, 'version')
  merged.format.paragraph_max_words = num(merged.format.paragraph_max_words, 'format.paragraph_max_words')
  merged.format.title.pattern = string(merged.format.title.pattern, 'format.title.pattern')
  merged.format.title.min_chars = num(merged.format.title.min_chars, 'format.title.min_chars')
  merged.format.title.max_chars = num(merged.format.title.max_chars, 'format.title.max_chars')
  merged.punctuation.dash.scale_words = num(
    merged.punctuation.dash.scale_words,
    'punctuation.dash.scale_words',
  )
  merged.crosschapter.duplicate_similarity = num(
    merged.crosschapter.duplicate_similarity,
    'crosschapter.duplicate_similarity',
  )
  merged.crosschapter.duplicate_advisory = num(
    merged.crosschapter.duplicate_advisory,
    'crosschapter.duplicate_advisory',
  )
  merged.crosschapter.duplicate_min_chars = num(
    merged.crosschapter.duplicate_min_chars,
    'crosschapter.duplicate_min_chars',
  )
  merged.crosschapter.foreshadow_min_dormancy = num(
    merged.crosschapter.foreshadow_min_dormancy,
    'crosschapter.foreshadow_min_dormancy',
  )
  merged.crosschapter.foreshadow_dormant_after = num(
    merged.crosschapter.foreshadow_dormant_after,
    'crosschapter.foreshadow_dormant_after',
  )
  merged.format.forbid_markdown = bool(merged.format.forbid_markdown, 'format.forbid_markdown')
  merged.format.forbid_semicolon = bool(merged.format.forbid_semicolon, 'format.forbid_semicolon')
  merged.format.forbid_english_ellipsis = bool(
    merged.format.forbid_english_ellipsis,
    'format.forbid_english_ellipsis',
  )
  merged.punctuation.dialogue_dominant_ratio = num(
    merged.punctuation.dialogue_dominant_ratio,
    'punctuation.dialogue_dominant_ratio',
  )
  for (const key of ['zero_tolerance', 'soft', 'contextual', 'meta_narration'] as const) {
    array(merged.lexicon[key], `lexicon.${key}`)
  }
  array(merged.quality.dimensions, 'quality.dimensions')
  for (const [index, raw] of merged.quality.dimensions.entries()) {
    const dimension = object(raw, `quality.dimensions[${index}]`)
    num(dimension.max, `quality.dimensions[${index}].max`)
    string(dimension.id, `quality.dimensions[${index}].id`)
  }
  array(merged.exclusions, 'exclusions')
  array(merged.exemptions, 'exemptions')
  return merged
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value as Unknown)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** Freeze the compiled pack so no adapter can mutate taste at runtime. */
export function freeze(pack: Rulepack): Rulepack {
  return deepFreeze(pack)
}

export type { Exclusion }
