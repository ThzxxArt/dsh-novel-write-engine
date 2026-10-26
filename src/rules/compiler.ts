import { SCORE_DIMENSIONS, FULL_SCORE, type Exclusion } from '../domain/scoring.js'
import { ALL_RULE_CODES } from '../codes.js'
import { ERROR_CODES, SCHEMA_VERSION, EngineFaultError } from '../types.js'
import type { Rulepack } from './types.js'

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
    legal_quote: '"',
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
  },
  rhythm: { min_sentences: 8, uniform_ratio: 0.6, short_ratio: 0.25 },
  semantics: {
    adjective_density: { max: 4, adjectives: [] },
    pleasure_density: { min: 1, keywords: [], window: 600 },
    sensory_density: { min: 2, senses: [], window: 800 },
    water_words: { window: 150, threshold: 0.35, terms: [] },
  },
  crosschapter: {
    duplicate_similarity: 0.9,
    foreshadow_min_dormancy: 3,
    resource_tolerance: 0,
    check_time: true,
    lock_similarity: 0.75,
  },
  quality: { min_score: 120, dimensions: SCORE_DIMENSIONS.map(({ id, max }) => ({ id, max })) },
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
      'rhythm',
      'semantics',
      'crosschapter',
      'quality',
      'exclusions',
      'exemptions',
    ],
    'root',
  )
  const pack = normalize(raw as Partial<Rulepack>)

  // 1. completeness: the fifteen dimensions must sum to exactly 150.
  const sum = pack.quality.dimensions.reduce((total, dimension) => total + dimension.max, 0)
  if (sum !== FULL_SCORE) invalid(`dimension maxima sum to ${sum}, expected ${FULL_SCORE}`)
  const ids = new Set(pack.quality.dimensions.map((dimension) => dimension.id))
  for (const dimension of SCORE_DIMENSIONS) {
    if (!ids.has(dimension.id)) invalid(`quality.dimensions is missing ${dimension.id}`)
  }

  // 2. shape: lexicon entries and their limits.
  const terms = [
    ...pack.lexicon.zero_tolerance,
    ...pack.lexicon.soft,
    ...pack.lexicon.contextual,
    ...pack.lexicon.meta_narration,
  ]
  for (const entry of terms) {
    if (entry.term.trim() === '') invalid('lexicon contains an empty term')
    if ('limit' in entry && entry.limit !== undefined && entry.limit < 0)
      invalid(`limit for "${entry.term}" is negative`)
  }

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
  for (const exclusion of pack.exclusions) {
    if (exclusion.pair[0] === exclusion.pair[1]) invalid(`exclusion pairs "${exclusion.pair[0]}" with itself`)
    for (const code of exclusion.pair)
      if (!known.has(code)) invalid(`exclusion references unknown rule ${code}`)
    if (exclusion.family.trim() === '') invalid('exclusion family is empty')
  }
  for (const code of pack.exemptions) {
    if (!known.has(code)) invalid(`exemption references unknown rule ${code}`)
  }

  // 5. threshold bounds: values that would silently disable a check are refused.
  if (pack.format.paragraph_max_words < 20 || pack.format.paragraph_max_words > 500) {
    invalid('format.paragraph_max_words must be within 20..500')
  }
  if (pack.quality.min_score < 0 || pack.quality.min_score > FULL_SCORE) {
    invalid('quality.min_score must be within 0..150')
  }
  if (pack.punctuation.period_density.min > pack.punctuation.period_density.max) {
    invalid('punctuation.period_density.min must not exceed max')
  }
  if (pack.crosschapter.duplicate_similarity < 0 || pack.crosschapter.duplicate_similarity > 1) {
    invalid('crosschapter.duplicate_similarity must be within 0..1')
  }
  for (const [scene, budget] of Object.entries(pack.punctuation.dash.base)) {
    if (budget < 0) invalid(`dash budget for ${scene} is negative`)
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
      result[key] = value
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
    result[key] = value
  }
  return result as T
}

/** Fill optional blocks from defaults and check scalar types of the result. */
export function normalize(raw: Partial<Rulepack>): Rulepack {
  const merged = merge(DEFAULT_RULEPACK as unknown as Unknown, raw, 'root') as unknown as Rulepack
  merged.name = string(merged.name, 'name')
  merged.version = string(merged.version, 'version')
  merged.format.paragraph_max_words = num(merged.format.paragraph_max_words, 'format.paragraph_max_words')
  merged.format.title.pattern = string(merged.format.title.pattern, 'format.title.pattern')
  merged.format.title.min_chars = num(merged.format.title.min_chars, 'format.title.min_chars')
  merged.format.title.max_chars = num(merged.format.title.max_chars, 'format.title.max_chars')
  merged.quality.min_score = num(merged.quality.min_score, 'quality.min_score')
  merged.punctuation.dash.scale_words = num(
    merged.punctuation.dash.scale_words,
    'punctuation.dash.scale_words',
  )
  merged.crosschapter.duplicate_similarity = num(
    merged.crosschapter.duplicate_similarity,
    'crosschapter.duplicate_similarity',
  )
  merged.format.forbid_markdown = bool(merged.format.forbid_markdown, 'format.forbid_markdown')
  merged.format.forbid_semicolon = bool(merged.format.forbid_semicolon, 'format.forbid_semicolon')
  merged.format.forbid_english_ellipsis = bool(
    merged.format.forbid_english_ellipsis,
    'format.forbid_english_ellipsis',
  )
  for (const key of ['zero_tolerance', 'soft', 'contextual', 'meta_narration'] as const) {
    array(merged.lexicon[key], `lexicon.${key}`)
  }
  array(merged.quality.dimensions, 'quality.dimensions')
  for (const dimension of merged.quality.dimensions) {
    num(dimension.max, 'quality.dimensions[].max')
    string(dimension.id, 'quality.dimensions[].id')
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
