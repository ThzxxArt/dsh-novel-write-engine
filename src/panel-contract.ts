import type { BookReport, Stage, WordMetrics } from './types.js'

/** v6 read-only book data. All windows are explicit in the field names. */
export interface PanelCardData {
  num: number
  title: string
  scene_type: string
  goal: string
  conflict: string
  hook: string
  cast: string[]
  target_words: [number, number]
  status: 'planned' | 'archived'
}

export interface PanelWorldEntry {
  name: string
  description: string
  anchors?: string[]
}

export interface PanelBookData {
  identity: {
    author: string
    description: string
    created_at: string
    /** 0.2.17: the bound style pack, or null when the book has none. */
    style?: { id: string; name: string } | null
    targets: {
      words_per_chapter: [number, number]
      total_chapters: number | null
      dialogue_ratio: [number, number]
    }
  }
  blueprint: {
    premise: string
    logline: string
    themes: string[]
    tone: string
    pov: string
    audience: string
    selling_points: string[]
    ending: string
  }
  progress: {
    archived: number
    target: number | null
    words_archived: number
    words_with_draft: number
    average_words: number
    remaining_words: number | null
    remaining_words_basis: 'actual_average' | 'minimum_target' | 'none'
    percent: number | null
  }
  current: {
    card: PanelCardData | null
    chapter: number
    stage: Stage
    rounds: { review: number; revise: number; check: number }
    manuscript_hash: string | null
    metrics: WordMetrics | null
  }
  worldbook: {
    counts: Omit<BookReport['worldbook'], 'anchors'>
    locations: PanelWorldEntry[]
    factions: PanelWorldEntry[]
    rules: PanelWorldEntry[]
    facts: Array<{ alias: string; value: number; unit: string }>
  }
  cast: {
    total: number
    top: Array<{ name: string; role: string; appearances: number; last_seen: number }>
  }
  relationships: { total: number; types: Record<string, number>; type_codes?: Record<string, number> }
  foreshadows: BookReport['foreshadows']
  timeline: BookReport['timeline']
  outline: { drift: BookReport['outline']['drift'] }
  quality: {
    average: number
    median: number
    min: number
    max: number
    last_ten_average: number | null
    trend: number | null
    trend_basis: BookReport['quality']['trend_basis']
    samples: number
    sample_basis?: BookReport['quality']['sample_basis']
    attempts: number
    attempt_basis?: BookReport['quality']['attempt_basis']
    dimensions: BookReport['quality']['dimensions']
  }
  pacing: BookReport['pacing']
  effort: BookReport['effort']
  /** 0.2.17: this chapter's nine style measurements; absent without a pack. */
  style_metrics?: import('./domain/style.js').StyleMetrics | null
  /**
   * 0.2.17: the pack's targets travel with the measurements. The panel cannot
   * colour a deviation without knowing what the pack asked for, and it must
   * judge the same dialogue reading the rule judged (`dialogue_metric`).
   */
  style_targets?: {
    id: string
    name: string
    sentence: { short_ratio: number; medium_ratio: number; long_ratio: number }
    dialogue: number
    dialogue_metric: 'lines' | 'chars' | 'both'
    thresholds: Record<string, number>
    /** The cool-point budget the gap is judged against. */
    cool_point_every_chars: number
  } | null
  /**
   * 0.2.17: whether the active chapter still reads like the book. Present only
   * when a pack is bound, so an old project's payload keeps the 0.2.16 shape.
   */
  style_verdict?: { verdict: 'pass' | 'attention' | 'no-draft'; findings: string[] } | null
  health: {
    state_errors: Array<{ path: string; code: string; message: string }>
    outline: { present: boolean; error: string | null }
    worldbook: { present: boolean; error: string | null }
    pending: { state: string; txid: string; detail: string } | null
  }
}
