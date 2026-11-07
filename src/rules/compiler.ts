import { SCORE_DIMENSIONS, FULL_SCORE, type Exclusion } from '../domain/scoring.js'
import { AI_TONE_RULES, ALL_RULE_CODES } from '../codes.js'
import { ERROR_CODES, GENRES, PLATFORMS, SCENE_TYPES, SCHEMA_VERSION, EngineFaultError } from '../types.js'
import type { AiToneCategory, AiToneEntry, AiToneLexicon, Rulepack } from './types.js'
import { assertAiToneTemplate, CANONICAL_AI_TONE_PHRASES, scanAiTone } from './ai-tone.js'

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
    period_density: { min: 1.5, max: 10 },
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
    motif_min_dormancy: 1,
    foreshadow_dormant_after: 20,
    check_time: true,
    lock_similarity: 0.75,
  },
  quality: { dimensions: SCORE_DIMENSIONS.map(({ id, max }) => ({ id, max })) },
  exclusions: [],
  exemptions: [],
}

type Unknown = Record<string, unknown>

function invalid(message: string): never {
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

const PROFILE_KEYS = [
  'period_density',
  'water_words',
  'pleasure_density',
  'pleasure_keywords',
  'foreshadow_min_dormancy',
  'motif_min_dormancy',
  'foreshadow_dormant_after',
  'dialogue_ratio',
  'paragraph_max_words',
  'lexicon_add',
  'lexicon_remove',
] as const

const stringArray = (value: unknown, path: string): string[] => {
  const rows = array(value, path)
  for (const [index, item] of rows.entries()) {
    if (typeof item !== 'string' || item.trim() === '')
      invalid(`${path}[${index}] must be a non-empty string`)
  }
  return rows as string[]
}

/** Shared profile validation for legacy genres, taxonomy subs, majors and tags. */
const validateGenreProfile = (value: unknown, path: string, id: string): void => {
  const profile = object(value, path)
  knownKeys(profile, PROFILE_KEYS, path)
  if (profile.period_density !== undefined) {
    const density = object(profile.period_density, `${path}.period_density`)
    knownKeys(density, ['min', 'max'], `${path}.period_density`)
    const min = num(density.min, `${path}.period_density.min`)
    const max = num(density.max, `${path}.period_density.max`)
    if (min < 0 || max < 0) invalid(`${path}.period_density must be non-negative`)
    if (max > 100) invalid(`${path}.period_density.max must not exceed 100 per 100 chars`)
    if (min > max) invalid(`${path}.period_density.min must not exceed max`)
  }
  for (const key of ['foreshadow_min_dormancy', 'motif_min_dormancy', 'foreshadow_dormant_after'] as const) {
    const current = profile[key]
    if (current !== undefined && (!Number.isInteger(current) || (current as number) <= 0)) {
      invalid(`${path}.${key} must be a positive integer`)
    }
  }
  if (profile.water_words !== undefined) {
    const current = num(profile.water_words, `${path}.water_words`)
    if (current < 0 || current > 1) invalid(`${path}.water_words must be 0..1`)
  }
  if (profile.pleasure_density !== undefined) {
    const current = num(profile.pleasure_density, `${path}.pleasure_density`)
    if (current <= 0) invalid(`${path}.pleasure_density must be > 0`)
  }
  if (profile.pleasure_keywords !== undefined)
    stringArray(profile.pleasure_keywords, `${path}.pleasure_keywords`)
  for (const key of ['lexicon_add', 'lexicon_remove'] as const) {
    if (profile[key] !== undefined) stringArray(profile[key], `${path}.${key}`)
  }
  if (profile.dialogue_ratio !== undefined) {
    const pair = array(profile.dialogue_ratio, `${path}.dialogue_ratio`)
    if (pair.length !== 2) invalid(`${path}.dialogue_ratio must contain two numbers`)
    const low = num(pair[0], `${path}.dialogue_ratio[0]`)
    const high = num(pair[1], `${path}.dialogue_ratio[1]`)
    if (low < 0 || high > 1 || low > high) invalid(`${path}.dialogue_ratio must be 0<=low<=high<=1`)
  }
  if (profile.paragraph_max_words !== undefined) {
    const current = num(profile.paragraph_max_words, `${path}.paragraph_max_words`)
    if (!Number.isInteger(current) || current < 20 || current > 500) {
      invalid(`${path}.paragraph_max_words must be an integer within 20..500`)
    }
  }
  void id
}

const AI_TONE_CATEGORY_CODES: Record<string, string> = {
  meta_commentary: AI_TONE_RULES.META,
  ack_loop: AI_TONE_RULES.ACK,
  empty_comparative: AI_TONE_RULES.COMPARATIVE,
  protective_cliche: AI_TONE_RULES.PROTECTIVE,
  socratic_trope: AI_TONE_RULES.SOCRATIC,
  template_phrase: AI_TONE_RULES.TEMPLATE,
  short_judgment: AI_TONE_RULES.JUDGMENT,
}

const AI_TONE_CANONICAL_SAMPLES: Record<string, string> = {
  '行，xxx': '行，认了。',
  什么心思都写着xx上: '什么心思都写在脸上。',
  xx比xx沉: '这句比那句沉。',
  xx比xx重: '这句比那句重。',
  xx比xx稳: '这句比那句稳。',
  xx比xx轻: '这句比那句轻。',
  没接你的xxx: '没接你的话。',
  没接你那句xx: '没接你那句话。',
  '这话是ta告诉你的，还是你自己想明白的': '这话是他告诉你的，还是你自己想明白的。',
  xx就是认了: '他就是认了。',
}

const regexSafety = (pattern: string): void => {
  try {
    void new RegExp(pattern, 'u')
  } catch {
    invalid(`ai_tone regex does not compile: ${pattern}`)
  }
  if (pattern.length > 200) invalid(`ai_tone regex is longer than 200 characters: ${pattern}`)
  // Reject the common catastrophic-backtracking shape `(x+)+` and similar.
  if (/\((?:[^()]*[+*][^()]*)\)[+*{]/.test(pattern) || /(?:\.\*){2,}/.test(pattern)) {
    invalid(`ai_tone regex has a nested quantifier: ${pattern}`)
  }
}

const parseAiTone = (value: unknown, path: string): AiToneLexicon => {
  const root = object(value, path)
  knownKeys(root, ['version', 'categories', 'entries'], path)
  const version = root.version === undefined ? 1 : root.version
  if (!Number.isInteger(version) || (version as number) < 1)
    invalid(`${path}.version must be a positive integer`)

  const categoriesRaw = object(root.categories, `${path}.categories`)
  const expected = Object.keys(AI_TONE_CATEGORY_CODES)
  for (const key of Object.keys(categoriesRaw)) {
    if (!expected.includes(key)) invalid(`${path}.categories.${key} is not a recognised category`)
  }
  const categories: Record<string, AiToneCategory> = {}
  const seenCodes = new Set<string>()
  for (const id of expected) {
    const rawCategory = categoriesRaw[id]
    if (rawCategory === undefined) invalid(`${path}.categories.${id} is missing`)
    const row = object(rawCategory, `${path}.categories.${id}`)
    knownKeys(
      row,
      [
        'code',
        'default_severity',
        'defaultSeverity',
        'default_scope',
        'defaultScope',
        'limit',
        'window',
        'escalation',
        'note',
      ],
      `${path}.categories.${id}`,
    )
    const code = string(row.code, `${path}.categories.${id}.code`)
    if (code !== AI_TONE_CATEGORY_CODES[id]) {
      invalid(`${path}.categories.${id}.code must be ${AI_TONE_CATEGORY_CODES[id]}, got ${code}`)
    }
    if (!ALL_RULE_CODES.includes(code)) invalid(`${path}.categories.${id}.code is not a registered rule`)
    if (seenCodes.has(code)) invalid(`ai_tone code ${code} is owned by two categories`)
    seenCodes.add(code)
    const severity = row.default_severity ?? row.defaultSeverity
    if (severity !== 'blocker' && severity !== 'advisory')
      invalid(`${path}.categories.${id}.default_severity is invalid`)
    const scope = row.default_scope ?? row.defaultScope
    if (scope !== 'any' && scope !== 'narration' && scope !== 'dialogue') {
      invalid(`${path}.categories.${id}.default_scope is invalid`)
    }
    const limit = row.limit === undefined ? 0 : num(row.limit, `${path}.categories.${id}.limit`)
    if (!Number.isInteger(limit) || limit < 0)
      invalid(`${path}.categories.${id}.limit must be a non-negative integer`)
    const window = row.window === undefined ? 0 : num(row.window, `${path}.categories.${id}.window`)
    if (!Number.isInteger(window) || window < 0)
      invalid(`${path}.categories.${id}.window must be a non-negative integer`)
    if (limit > 0 && window <= 0)
      invalid(`${path}.categories.${id}.window must be positive when limit is positive`)
    const escalation = row.escalation === undefined ? 'none' : row.escalation
    if (escalation !== 'none' && escalation !== 'one_level' && escalation !== 'blocker') {
      invalid(`${path}.categories.${id}.escalation is invalid`)
    }
    categories[id] = {
      code,
      defaultSeverity: severity,
      defaultScope: scope,
      limit,
      window,
      escalation,
      note: row.note === undefined ? '' : string(row.note, `${path}.categories.${id}.note`),
    }
  }

  const entriesRaw = array(root.entries, `${path}.entries`)
  const entries: AiToneEntry[] = []
  const ids = new Set<string>()
  const terms = new Set<string>()
  for (const [index, rawEntry] of entriesRaw.entries()) {
    const entryPath = `${path}.entries[${index}]`
    const row = object(rawEntry, entryPath)
    knownKeys(
      row,
      [
        'id',
        'category',
        'match',
        'terms',
        'pattern',
        'template',
        'severity',
        'severity_in_dialogue',
        'severityInDialogue',
        'scope',
        'limit',
        'window',
        'cooldown_chapters',
        'cooldownChapters',
        'standalone',
        'exclude_if_matches',
        'excludeIfMatches',
        'note',
        'replacement',
        'examples',
        'false_positives',
        'falsePositives',
      ],
      entryPath,
    )
    const id = string(row.id, `${entryPath}.id`)
    if (!/^AI-[A-Z]+-\d{3}$/.test(id)) invalid(`${entryPath}.id must match AI-<CAT>-NNN`)
    if (ids.has(id)) invalid(`ai_tone repeats entry id ${id}`)
    ids.add(id)
    const category = string(row.category, `${entryPath}.category`)
    if (!expected.includes(category)) invalid(`${entryPath}.category ${category} does not exist`)
    const match = row.match
    if (match !== 'exact' && match !== 'regex' && match !== 'template') {
      invalid(`${entryPath}.match must be exact, regex or template`)
    }
    const entryTerms = row.terms === undefined ? [] : stringArray(row.terms, `${entryPath}.terms`)
    let pattern: string | undefined
    let template: string | undefined
    if (match === 'exact') {
      if (entryTerms.length === 0) invalid(`${entryPath}.terms must not be empty for exact`)
      const local = new Set<string>()
      for (const term of entryTerms) {
        const normalized = term.replace(/[\s\u3000]/gu, '')
        if (local.has(normalized)) invalid(`${entryPath}.terms repeats ${term}`)
        local.add(normalized)
        if (terms.has(normalized)) invalid(`ai_tone term "${term}" is owned by two entries`)
        terms.add(normalized)
      }
    } else if (match === 'regex') {
      if (row.pattern === undefined) invalid(`${entryPath}.pattern is required for regex`)
      pattern = string(row.pattern, `${entryPath}.pattern`)
      regexSafety(pattern)
      if (entryTerms.length > 0) invalid(`${entryPath}.terms is only valid for exact`)
    } else {
      if (row.template === undefined) invalid(`${entryPath}.template is required for template`)
      template = string(row.template, `${entryPath}.template`)
      try {
        assertAiToneTemplate(template)
        void new RegExp(template.replace(/\{(?:xx|xxx|ta)\}/gu, 'x'))
      } catch (error) {
        invalid(`${entryPath}.template is invalid: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (entryTerms.length > 0) invalid(`${entryPath}.terms is only valid for exact`)
    }
    const severity = row.severity === undefined ? categories[category]!.defaultSeverity : row.severity
    if (severity !== 'blocker' && severity !== 'advisory') invalid(`${entryPath}.severity is invalid`)
    const severityInDialogue = row.severity_in_dialogue ?? row.severityInDialogue
    if (
      severityInDialogue !== undefined &&
      severityInDialogue !== 'blocker' &&
      severityInDialogue !== 'advisory'
    ) {
      invalid(`${entryPath}.severity_in_dialogue is invalid`)
    }
    const scope = row.scope
    if (scope !== undefined && scope !== 'any' && scope !== 'narration' && scope !== 'dialogue') {
      invalid(`${entryPath}.scope is invalid`)
    }
    if (severityInDialogue !== undefined && scope !== undefined && scope !== 'any') {
      invalid(`${entryPath}.severity_in_dialogue is only valid when scope is any`)
    }
    let limit: number | undefined
    if (row.limit !== undefined) {
      limit = num(row.limit, `${entryPath}.limit`)
      if (!Number.isInteger(limit) || limit < 0) invalid(`${entryPath}.limit must be a non-negative integer`)
    }
    let window: number | undefined
    if (row.window !== undefined) {
      window = num(row.window, `${entryPath}.window`)
      if (!Number.isInteger(window) || window < 0)
        invalid(`${entryPath}.window must be a non-negative integer`)
    }
    const cooldown =
      (row.cooldown_chapters ?? row.cooldownChapters) === undefined
        ? 0
        : num(row.cooldown_chapters ?? row.cooldownChapters, `${entryPath}.cooldown_chapters`)
    if (!Number.isInteger(cooldown) || cooldown < 0)
      invalid(`${entryPath}.cooldown_chapters must be non-negative`)
    const standalone = row.standalone === undefined ? false : bool(row.standalone, `${entryPath}.standalone`)
    if (standalone && category !== 'short_judgment')
      invalid(`${entryPath}.standalone is only valid for short_judgment`)
    const excludes =
      (row.exclude_if_matches ?? row.excludeIfMatches) === undefined
        ? []
        : stringArray(row.exclude_if_matches ?? row.excludeIfMatches, `${entryPath}.exclude_if_matches`)
    for (const exclusion of excludes) regexSafety(exclusion)
    const note = row.note === undefined ? '' : string(row.note, `${entryPath}.note`)
    const replacement = string(row.replacement, `${entryPath}.replacement`)
    const examples = row.examples === undefined ? [] : stringArray(row.examples, `${entryPath}.examples`)
    const falsePositives =
      (row.false_positives ?? row.falsePositives) === undefined
        ? []
        : stringArray(row.false_positives ?? row.falsePositives, `${entryPath}.false_positives`)
    entries.push({
      id,
      category,
      match,
      terms: entryTerms,
      ...(pattern === undefined ? {} : { pattern }),
      ...(template === undefined ? {} : { template }),
      severity,
      ...(severityInDialogue === undefined ? {} : { severityInDialogue }),
      ...(scope === undefined ? {} : { scope }),
      ...(limit === undefined ? {} : { limit }),
      ...(window === undefined ? {} : { window }),
      cooldownChapters: cooldown,
      standalone,
      excludeIfMatches: excludes,
      note,
      replacement,
      examples,
      falsePositives,
    })
  }
  const lexicon: AiToneLexicon = { version: version as number, categories, entries }
  for (const phrase of CANONICAL_AI_TONE_PHRASES) {
    const sample = AI_TONE_CANONICAL_SAMPLES[phrase] ?? `${phrase}。`
    const result = scanAiTone(sample, lexicon)
    if (result.entryIds.length === 0) invalid(`ai_tone does not cover canonical phrase "${phrase}"`)
  }
  return lexicon
}

/**
 * Six assertions, each mapping to one class of pack defect:
 * completeness, shape, duplicate ownership, dangling references, threshold
 * bounds, and the 150-point arithmetic.
 */
export function compileRulepack(raw: unknown): Rulepack {
  const root = object(raw, 'root')
  if (root.schema_version !== 1 && root.schema_version !== 2) {
    invalid('schema_version must be 1 (legacy) or 2 (0.3.0)')
  }
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
      'genre_majors',
      'tag_profiles',
      'crosschapter',
      'quality',
      'exclusions',
      'exemptions',
    ],
    'root',
  )
  const section = (name: string, keys: readonly string[]): Unknown | null => {
    const value = root[name]
    if (value === undefined) return null
    const objectValue = object(value, name)
    knownKeys(objectValue, keys, name)
    return objectValue
  }
  const nested = (value: Unknown | null, key: string, keys: readonly string[]): Unknown | null => {
    if (value === null || value[key] === undefined) return null
    const objectValue = object(value[key], key)
    knownKeys(objectValue, keys, key)
    return objectValue
  }
  const format = section('format', [
    'paragraph_max_words',
    'forbid_markdown',
    'forbid_semicolon',
    'forbid_english_ellipsis',
    'title',
    'system_labels',
    'scene_separators',
    'markdown_markers',
  ])
  nested(format, 'title', ['pattern', 'min_chars', 'max_chars'])
  const punctuation = section('punctuation', [
    'dash',
    'period_density',
    'ellipsis_run',
    'uniform_sentence',
    'consecutive_le',
    'dialogue_dominant_ratio',
  ])
  const dash = nested(punctuation, 'dash', ['base', 'scale_words', 'token'])
  if (dash !== null && dash.base !== undefined) {
    const base = object(dash.base, 'punctuation.dash.base')
    knownKeys(base, SCENE_TYPES, 'punctuation.dash.base')
  }
  nested(punctuation, 'period_density', ['min', 'max'])
  nested(punctuation, 'ellipsis_run', ['max', 'token'])
  nested(punctuation, 'uniform_sentence', ['min_sentences', 'ratio'])
  nested(punctuation, 'consecutive_le', ['max', 'char'])
  const semantics = section('semantics', [
    'adjective_density',
    'pleasure_density',
    'sensory_density',
    'water_words',
  ])
  nested(semantics, 'adjective_density', ['max', 'adjectives'])
  nested(semantics, 'pleasure_density', ['min', 'keywords', 'window'])
  nested(semantics, 'sensory_density', ['min', 'senses', 'window'])
  const waterWords = nested(semantics, 'water_words', ['window', 'threshold', 'scene_thresholds', 'terms'])
  if (waterWords !== null && waterWords.scene_thresholds !== undefined) {
    knownKeys(
      object(waterWords.scene_thresholds, 'semantics.water_words.scene_thresholds'),
      SCENE_TYPES,
      'semantics.water_words.scene_thresholds',
    )
  }
  const lexicon = section('lexicon', [
    'zero_tolerance',
    'soft',
    'contextual',
    'meta_narration',
    'reader_intrusion',
    'god_view',
    'conclusion_first',
    'ai_tone',
  ])
  nested(lexicon, 'conclusion_first', ['verbs', 'causals'])
  for (const key of ['reader_intrusion', 'god_view'] as const) {
    if (lexicon === null || lexicon[key] === undefined) continue
    for (const [index, raw] of array(lexicon[key], `lexicon.${key}`).entries()) {
      knownKeys(object(raw, `lexicon.${key}[${index}]`), ['pattern'], `lexicon.${key}[${index}]`)
    }
  }
  const platform = object(root.platform, 'platform')
  knownKeys(platform, PLATFORMS, 'platform')
  for (const name of PLATFORMS) {
    const profile = object(platform[name], `platform.${name}`)
    knownKeys(profile, ['words_per_chapter', 'dialogue_ratio'], `platform.${name}`)
  }
  const genres = object(root.genres, 'genres')
  const subGenrePattern = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
  for (const key of Object.keys(genres)) {
    if (!(GENRES as readonly string[]).includes(key) && !subGenrePattern.test(key)) {
      invalid(`genres.${key} is not a legacy genre or a taxonomy sub id`)
    }
  }
  for (const [name, rawEntry] of Object.entries(genres)) {
    const entry = object(rawEntry, `genres.${name}`)
    knownKeys(entry, ['note', 'profile'], `genres.${name}`)
    if (entry.profile !== undefined) validateGenreProfile(entry.profile, `genres.${name}.profile`, name)
  }
  for (const key of ['genre_majors', 'tag_profiles'] as const) {
    if (root[key] === undefined) continue
    const rows = object(root[key], key)
    for (const [id, rawEntry] of Object.entries(rows)) {
      if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/.test(id)) invalid(`${key}.${id} is not a stable ASCII id`)
      const entry = object(rawEntry, `${key}.${id}`)
      knownKeys(entry, ['profile'], `${key}.${id}`)
      if (entry.profile !== undefined) validateGenreProfile(entry.profile, `${key}.${id}.profile`, id)
    }
  }
  const crosschapter = section('crosschapter', [
    'duplicate_similarity',
    'duplicate_advisory',
    'duplicate_min_chars',
    'foreshadow_min_dormancy',
    'motif_min_dormancy',
    'foreshadow_dormant_after',
    'check_time',
    'lock_similarity',
  ])
  void crosschapter
  const quality = section('quality', ['dimensions'])
  if (quality?.dimensions !== undefined) {
    for (const [index, rawDimension] of array(quality.dimensions, 'quality.dimensions').entries()) {
      const dimension = object(rawDimension, `quality.dimensions[${index}]`)
      knownKeys(dimension, ['id', 'max'], `quality.dimensions[${index}]`)
    }
  }
  if (root.exclusions !== undefined) {
    for (const [index, rawEntry] of array(root.exclusions, 'exclusions').entries()) {
      const entry = object(rawEntry, `exclusions[${index}]`)
      knownKeys(entry, ['pair', 'family'], `exclusions[${index}]`)
    }
  }
  const pack = normalize(raw as Partial<Rulepack>)
  if (pack.schema_version !== 1 && pack.schema_version !== 2) {
    invalid('schema_version must be 1 or 2 after normalisation')
  }
  const rawLexicon = root.lexicon === undefined ? undefined : object(root.lexicon, 'lexicon')
  const rawAiTone = rawLexicon?.ai_tone
  if (rawAiTone === undefined) {
    if (pack.schema_version === 2) invalid('lexicon.ai_tone is required for schema_version 2')
  } else {
    ;(pack.lexicon as { ai_tone?: AiToneLexicon }).ai_tone = parseAiTone(rawAiTone, 'lexicon.ai_tone')
  }
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
  for (const genre of GENRES) {
    const profile = pack.genres[genre].profile
    if (profile === undefined) continue
    if (profile.pleasure_keywords !== undefined) {
      if (
        !Array.isArray(profile.pleasure_keywords) ||
        profile.pleasure_keywords.some((item) => typeof item !== 'string' || item.trim() === '')
      ) {
        invalid(`genres.${genre}.profile.pleasure_keywords must be a string array`)
      }
    }
    for (const key of [
      'foreshadow_min_dormancy',
      'motif_min_dormancy',
      'foreshadow_dormant_after',
    ] as const) {
      const value = profile[key]
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        invalid(`genres.${genre}.profile.${key} must be a positive integer`)
      }
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
    knownKeys(guide, ['note', 'profile'], `genres.${genre}`)
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
  for (const label of pack.format.system_labels) {
    try {
      void new RegExp(label)
    } catch {
      invalid(`format.system_labels contains an invalid pattern: ${label}`)
    }
  }
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
  if (pack.punctuation.period_density.max > 100) {
    invalid('punctuation.period_density.max must not exceed 100 per 100 chars')
  }
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
  if (pack.punctuation.dialogue_dominant_ratio <= 0) {
    invalid('punctuation.dialogue_dominant_ratio must be > 0; 0 disables every dialogue exemption')
  }
  nonNegative(pack.semantics.adjective_density.max, 'semantics.adjective_density.max')
  textList(pack.semantics.adjective_density.adjectives, 'semantics.adjective_density.adjectives')
  nonNegative(pack.semantics.pleasure_density.min, 'semantics.pleasure_density.min')
  if (pack.semantics.pleasure_density.min <= 0) {
    invalid('semantics.pleasure_density.min must be > 0; 0 disables the check')
  }
  positiveInt(pack.semantics.pleasure_density.window, 'semantics.pleasure_density.window')
  textList(pack.semantics.pleasure_density.keywords, 'semantics.pleasure_density.keywords')
  nonNegative(pack.semantics.sensory_density.min, 'semantics.sensory_density.min')
  if (pack.semantics.sensory_density.min <= 0) {
    invalid('semantics.sensory_density.min must be > 0; 0 disables the check')
  }
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
  for (const key of ['foreshadow_min_dormancy', 'motif_min_dormancy', 'foreshadow_dormant_after'] as const) {
    const value = pack.crosschapter[key]
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      invalid(`crosschapter.${key} must be a positive integer; 0 silently disables the check`)
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
  merged.crosschapter.motif_min_dormancy = num(
    merged.crosschapter.motif_min_dormancy,
    'crosschapter.motif_min_dormancy',
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
