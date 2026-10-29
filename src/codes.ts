/** Stable rule codes. One owner per code: the rules registry refuses duplicates. */
export const FORMAT_RULES = {
  MD_CONTAMINATION: 'MD_CONTAMINATION',
  ILLEGAL_QUOTE: 'ILLEGAL_QUOTE',
  SEMICOLON: 'SEMICOLON',
  ENGLISH_ELLIPSIS: 'ENGLISH_ELLIPSIS',
  SCENE_SEPARATOR: 'SCENE_SEPARATOR',
  LONG_PARAGRAPH: 'LONG_PARAGRAPH',
  TITLE_FORMAT: 'TITLE_FORMAT',
  SYSTEM_LABEL: 'SYSTEM_LABEL',
} as const

/** Lexicon families. */
export const LEXICON_RULES = {
  ZERO_TOLERANCE: 'LEX_ZERO_TOLERANCE',
  SOFT_LIMIT: 'LEX_SOFT_LIMIT',
  META_NARRATION: 'META_NARRATION',
  READER_INTRUSION: 'READER_INTRUSION',
  GOD_VIEW: 'GOD_VIEW',
  CONCLUSION_FIRST: 'CONCLUSION_FIRST',
} as const

/** Punctuation / rhythm families. */
export const PUNCTUATION_RULES = {
  DASH_BUDGET: 'DASH_BUDGET',
  PERIOD_DENSITY: 'PERIOD_DENSITY',
  ELLIPSIS_RUN: 'ELLIPSIS_RUN',
  UNIFORM_SENTENCE: 'UNIFORM_SENTENCE',
  CONSECUTIVE_LE: 'CONSECUTIVE_LE',
} as const

/** Semantic (heuristic) families. */
export const SEMANTIC_RULES = {
  ADJECTIVE_DENSITY: 'ADJECTIVE_DENSITY',
  PLEASURE_DENSITY: 'PLEASURE_DENSITY',
  SENSORY_DENSITY: 'SENSORY_DENSITY',
  WATER_WORDS: 'WATER_WORDS',
  DIALOGUE_RATIO: 'DIALOGUE_RATIO',
  NUMERIC_CONTRADICTION: 'NUMERIC_CONTRADICTION',
  NUMERIC_FACT_MISMATCH: 'NUMERIC_FACT_MISMATCH',
} as const

/** Cross-chapter families. */
export const CROSS_RULES = {
  DUPLICATE_PARAGRAPH: 'DUPLICATE_PARAGRAPH',
  FORESHADOW_DORMANT: 'FORESHADOW_DORMANT',
  FS_REVISITED_TOO_SOON: 'FS_REVISITED_TOO_SOON',
  RESOURCE_MISMATCH: 'RESOURCE_MISMATCH',
  TIME_REGRESSION: 'TIME_REGRESSION',
  RELATION_UNKNOWN: 'RELATION_UNKNOWN',
  LOCKED_DETAIL_DRIFT: 'LOCKED_DETAIL_DRIFT',
} as const

export const ALL_RULE_CODES: readonly string[] = [
  ...Object.values(FORMAT_RULES),
  ...Object.values(LEXICON_RULES),
  ...Object.values(PUNCTUATION_RULES),
  ...Object.values(SEMANTIC_RULES),
  ...Object.values(CROSS_RULES),
]

/** Gate identifiers in fixed evaluation order. */
export const GATES = {
  'PG-01': 'BRIEF_REQUIRED',
  'PG-02': 'STAGE_ORDER',
  'PG-03': 'WORD_COUNT',
  'PG-04': 'FORMAT',
  'PG-05': 'SUMMARY_SCHEMA',
  'PG-06': 'SCENE_TYPE',
  'PG-07': 'SCORE',
  'PG-08': 'ISSUES_CLEARED',
  'PG-09': 'READING_PROOF',
  'PG-10': 'CONSISTENCY',
  'PG-11': 'ROUNDS',
  'PG-12': 'ARCHIVE_ATOMIC',
  'PG-13': 'OUTLINE_ALIGNMENT',
} as const
export type GateId = keyof typeof GATES

/**
 * Fixed evaluation order: format before word count because curly quotes and
 * dashes both count as words and as violations; judging length first inverts
 * the author's incentive.
 */
export const GATE_ORDER: readonly GateId[] = [
  'PG-01',
  'PG-02',
  'PG-04',
  'PG-03',
  'PG-05',
  'PG-06',
  'PG-13',
  'PG-09',
  'PG-07',
  'PG-08',
  'PG-10',
  'PG-11',
  'PG-12',
]
