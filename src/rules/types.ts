import type { Genre, Platform, SceneType } from '../types.js'

/** One blacklisted word. */
export interface TermEntry {
  term: string
  note?: string
  /** Allow the term inside a dialogue-dominant paragraph (character voice). */
  dialogueExempt?: boolean
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
}

/** A rule implementation. Each code has exactly one owner. */
export type Rule = (context: RuleContext) => import('../types.js').Violation[]
