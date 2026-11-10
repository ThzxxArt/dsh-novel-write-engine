import type { Genre, Platform, SceneType } from '../types.js'

/** One blacklisted word. */
export interface TermEntry {
  term: string
  note?: string
  /** Allow the term inside a dialogue-dominant paragraph (character voice). */
  dialogueExempt?: boolean
  /**
   * 0.2.17: how the term must appear to count. `substring` (default) flags the
   * term anywhere, `standalone` requires punctuation or an edge on both sides,
   * `line_start` requires the term to open a paragraph. Ordinary Chinese uses
   * 话说/读者/仿佛 inside sentences, so substring matching rejected legal prose.
   */
  match?: 'substring' | 'standalone' | 'line_start'
}

/** A soft-limit word, optionally relaxed for some genres. */
export interface LimitEntry {
  term: string
  limit: number
  genres?: Genre[]
}

/** Structured rule pack: all taste lives here, never in code. */
export interface Rulepack {
  schema_version: 1
  name: string
  version: string
  lexicon: {
    zero_tolerance: TermEntry[]
    soft: LimitEntry[]
    contextual: LimitEntry[]
    meta_narration: TermEntry[]
    reader_intrusion: Array<{ pattern: string }>
    god_view: Array<{ pattern: string }>
    conclusion_first: { verbs: string[]; causals: string[] }
    /** 0.2.17: optional; an old pack without it compiles to an empty block. */
    ai_tone?: AiToneBlock
  }
  format: {
    paragraph_max_words: number
    forbid_markdown: boolean
    forbid_semicolon: boolean
    forbid_english_ellipsis: boolean
    title: { pattern: string; min_chars: number; max_chars: number }
    system_labels: string[]
    scene_separators: string[]
    markdown_markers: string[]
  }
  punctuation: {
    dash: { base: Record<SceneType, number>; scale_words: number; token: string }
    period_density: { min: number; max: number }
    ellipsis_run: { max: number; token: string }
    uniform_sentence: { min_sentences: number; ratio: number }
    consecutive_le: { max: number; char: string }
    /** Paragraphs at or above this quoted-character share skip rhythm checks. */
    dialogue_dominant_ratio: number
  }
  semantics: {
    adjective_density: { max: number; adjectives: string[] }
    pleasure_density: { min: number; keywords: string[]; window: number }
    sensory_density: { min: number; senses: string[]; window: number }
    water_words: {
      window: number
      threshold: number
      scene_thresholds?: Partial<Record<SceneType, number>>
      terms: string[]
    }
    /**
     * 0.2.17 style vocabulary. The pack owns targets; the rulepack owns words
     * (C10), so all three lists are optional and default to empty. An old pack
     * without them compiles to empty and simply makes the density rules silent.
     */
    abstract_emotion?: { terms: string[] }
    metaphor?: { markers: string[] }
    emotion_cues?: { terms: string[] }
  }
  /** Platform style profiles; `initProject` uses these when the caller omits targets. */
  platform: Record<
    Platform,
    {
      words_per_chapter: [number, number]
      dialogue_ratio: [number, number]
    }
  >
  /** Genre guides plus optional advisory-only threshold profiles. */
  genres: Record<
    Genre,
    {
      note: string
      profile?: {
        period_density?: { min: number; max: number }
        water_words?: number
        pleasure_density?: number
        pleasure_keywords?: string[]
        foreshadow_min_dormancy?: number
        motif_min_dormancy?: number
        foreshadow_dormant_after?: number
      }
    }
  >
  crosschapter: {
    duplicate_similarity: number
    duplicate_advisory: number
    /** Paragraphs shorter than this many non-whitespace chars are not duplicate candidates. */
    duplicate_min_chars: number
    foreshadow_min_dormancy: number
    motif_min_dormancy?: number
    foreshadow_dormant_after: number
    check_time: boolean
    lock_similarity: number
  }
  quality: { dimensions: Array<{ id: string; max: number }> }
  exclusions: Array<{ pair: [string, string]; family: string }>
  exemptions: string[]
}

/** Context every rule receives. Rules are pure: no IO, no clock, no randomness. */
export interface RuleContext {
  text: string
  chapter: number
  title: string | null
  genre: Genre
  sceneType: SceneType
  rulepack: Rulepack
  summary: import('../types.js').ChapterSummary | null
  evidence: {
    characters: import('../types.js').CharactersDocument | null
    previousText: string | null
    /** Three preceding chapters, newest first, for the duplicate rule. */
    previousTexts: string[]
    /** Chapter numbers matching `previousTexts`, so evidence names the real chapter. */
    previousChapterNums?: number[]
    foreshadows: import('../types.js').ForeshadowsDocument | null
    timeline: import('../types.js').TimelineDocument | null
    relationships: import('../types.js').RelationshipsDocument | null
    world: import('../types.js').WorldDocument | null
    locks: import('../types.js').LocksDocument | null
    /** 0.2.13 canonical lock descriptions and readable names. */
    worldbook?: import('../types.js').WorldbookDocument | null
  }
  /** Project targets are optional so pre-0.2.1 tests that build a RuleContext still typecheck. */
  targets?: {
    words_per_chapter: [number, number]
    dialogue_ratio: [number, number]
    min_cjk_chars?: number | null
    dialogue_ratio_metric?: 'lines' | 'chars' | 'both'
  }
  /** Declared numeric canon from the worldbook; empty means no fact check. */
  facts?: Array<{ alias: string; value: number; unit: string; tolerance?: number }>
  /** Book-level strict mode; enables numeric facts-empty advisory, never a blocker. */
  strict?: boolean
  /** 0.2.13: P6 no longer owns RELATION_UNKNOWN; archive runs it after delta merge. */
  disableRelationUnknown?: boolean
  /**
   * 0.2.17: the project's compiled style pack. Absent means "this book has no
   * style", in which case every `STYLE_*` rule is silent and the output is
   * byte-identical to 0.2.16.
   */
  style?: StylePack
  /** Measured once per chapter by the pipeline; the rules only read it. */
  styleMetrics?: import('../domain/style.js').StyleMetrics
  /**
   * 0.2.17: the shared AI-tone evaluation, computed once per chapter. The seven
   * `AI_TONE_*` rules read this instead of each re-scanning the text.
   */
  toneHits?: import('./ai-tone.js').ToneHit[]
  /**
   * C8: how many occurrences of each zero-tolerance term an AI-tone entry has
   * already claimed. Counts rather than a set, because only the overlapping
   * spans step aside — the rest of the term's occurrences still block.
   */
  toneCoveredTerms?: ReadonlyMap<string, number>
}

/** One `ai_tone` entry: a category, a matcher and the advice to give back. */
export interface AiToneEntry {
  id: string
  category: string
  match: 'exact' | 'regex' | 'template'
  terms?: string[]
  pattern?: string
  template?: string
  severity: 'blocker' | 'advisory'
  severity_in_dialogue?: 'blocker' | 'advisory'
  scope: 'any' | 'narration' | 'dialogue'
  limit?: number
  window?: number
  escalation?: 'none' | 'one_level'
  exclude_if_matches?: string[]
  standalone?: boolean
  note?: string
  replacement?: string
  false_positives?: string[]
}

/** The `lexicon.ai_tone` block: category defaults plus the entries themselves. */
export interface AiToneBlock {
  version: 1
  categories: Record<
    string,
    {
      code: string
      default_severity: 'blocker' | 'advisory'
      default_scope: 'any' | 'narration' | 'dialogue'
      limit: number
      window: number
      escalation: 'none' | 'one_level'
      note?: string
    }
  >
  entries: AiToneEntry[]
}

/** A rule implementation. Each code has exactly one owner. */
export type Rule = (context: RuleContext) => import('../types.js').Violation[]

/** 0.2.17: sentence-length buckets. `≤12` CJK chars is short, `≥32` is long. */
export type StyleLevel = 'low' | 'medium' | 'high'
export type StyleAudience = 'general' | 'male' | 'female'
export type StylePov = 'first' | 'third-limited' | 'third-omniscient'
export type StyleTense = 'past' | 'present'
export type StyleRegister = 'restrained' | 'neutral' | 'colloquial'
export type StyleDistance = 'close' | 'medium' | 'far'
export type StyleTagStyle = 'sparse' | 'balanced' | 'rich'
export type StyleTransition = 'hard_cut' | 'time_skip' | 'soft'
export type StyleExpression = 'concrete' | 'restrained' | 'direct'
export type SensoryChannel = 'sight' | 'sound' | 'smell' | 'taste' | 'touch' | 'cold' | 'heat'
export type EmotionBeat = 'body_reaction' | 'relationship_stake' | 'cost' | 'vulnerability' | 'choice'
export type OpeningMove =
  | 'action'
  | 'anomaly'
  | 'ceremony'
  | 'countdown'
  | 'dialogue'
  | 'object'
  | 'routine'
  | 'rule'
  | 'silence'
  | 'small_anomaly'
export type HookMove =
  | 'alliance_shift'
  | 'cost'
  | 'death_toll'
  | 'joke'
  | 'misunderstanding'
  | 'new_clue'
  | 'new_resource'
  | 'new_rule'
  | 'new_threat'
  | 'relationship'
  | 'relationship_shift'
  | 'reversal'
  | 'sanity_cost'
  | 'small_crisis'
  | 'unresolved_question'

/**
 * A compiled style pack. `genres` is the engine enum (C1); `genre_tags` keeps the
 * author-facing English labels so `/novel style show` can echo them back.
 */
export interface StylePack {
  schema_version: 1
  id: string
  name: string
  description: string
  audience: StyleAudience
  genre_tags: string[]
  genres: Genre[]
  pov: StylePov
  tense: StyleTense
  register: StyleRegister
  narrative_distance: StyleDistance
  sentence: {
    short_ratio: number
    medium_ratio: number
    long_ratio: number
    burstiness: StyleLevel
    max_consecutive_same_length: number
  }
  paragraph: {
    max_chars: number
    one_action_per_paragraph: boolean
    max_sentences: number
    max_actions: number
  }
  dialogue: {
    ratio: number
    tag_style: StyleTagStyle
    allow_interruptions: boolean
    allow_fragments: boolean
  }
  diction: {
    abstract_emotion_density: StyleLevel
    metaphor_density: StyleLevel
    adjective_density: StyleLevel
    slang: StyleLevel
    idiom: StyleLevel
    sensory_channels: SensoryChannel[]
  }
  structure: {
    opening_moves: OpeningMove[]
    scene_transition: StyleTransition
    hook_moves: HookMove[]
    cool_point_every_chars: number
  }
  emotion: {
    intensity: StyleLevel
    expression: StyleExpression
    required_beats: EmotionBeat[]
    min_cues_per_1000: number
  }
  banned_patterns: string[]
  exemplars: string[]
  critic_rubric: string[]
  thresholds: {
    burstiness_min?: number
    dialogue_ratio_min?: number
    dialogue_ratio_max?: number
    banned_patterns_max?: number
    abstract_emotion_max?: number
    metaphor_per_1000_max?: number
    /** C6/§附录C-26: how far a bucket share may drift from the target. */
    sentence_mix_tolerance?: number
    /** C6/§附录C-27: how far the actual ratio may drift from the target. */
    dialogue_target_tolerance?: number
    /** §附录C-28: the cool-point gap is allowed to stretch this much. */
    cool_point_gap_factor?: number
  }
}

/** Defaults for the three tolerances the assets never set. */
export const STYLE_THRESHOLD_DEFAULTS = {
  sentence_mix_tolerance: 0.15,
  dialogue_target_tolerance: 0.15,
  cool_point_gap_factor: 1.5,
} as const
