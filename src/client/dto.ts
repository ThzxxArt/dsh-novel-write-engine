/** Wire DTOs of the panel route. Versioned so a stale tab can say "refresh". */
export interface PhaseDto {
  id: string
  done: boolean
  active: boolean
}

export interface BlockingDto {
  code: string
  scope?: string
  detail: string
  hint?: string
}

export interface SummaryDto {
  schemaVersion: number
  panelId: string
  /** Absolute project root, so a stale title cannot hide a wrong book. */
  root: string
  title: string
  genre: string
  platform: string
  chapter: number
  stage: string
  revision: number
  totalWords: number
  totalChapters: number
  /** Book-wide archived average; absent on older payloads. */
  averageScore?: number
  volume?: number
  volume_name?: string
  act?: string
  act_progress?: string
  phases: PhaseDto[]
  blocking: BlockingDto[]
  next?: { tool: string; reason: string }
  /** True only when the book target is reached; done alone means the chapter is archived. */
  finished?: boolean
  book?: {
    premise: string
    logline: string
    strict: boolean
    target: number | null
    outline: {
      present: boolean
      total: number
      planned: number
      archived: number
      target?: number | null
      missing_cards?: number
      planned_coverage?: number | null
      archived_coverage?: number | null
      coverage: number
      card_coverage?: number
      volumes: Array<{ title: string; start: number; end: number; planned: number; archived: number }>
    }
    worldbook: {
      present: boolean
      characters: number
      locations: number
      factions: number
      rules: number
      glossary: number
      backstory: number
      facts?: number
    }
  }
  quality?: { averageScore: number; scores: number[]; trend: number }
  health?: { ok: boolean; blocking: number; stateErrors: number }
  activity?: Array<{ at: string; op: string; chapter: number; status: string }>
}

export interface ChapterRowDto {
  num: number
  title: string
  wordCount: number
  score: number
  stage: string
  status: 'passed' | 'blocked' | 'draft'
  details?: string
}

export interface ChaptersDto {
  schemaVersion: number
  panelId: string
  rows: ChapterRowDto[]
}

export interface GatesDto {
  schemaVersion: number
  panelId: string
  stage: string
  blocking: BlockingDto[]
  explanations: string[]
}

export interface ProjectOptionDto {
  root: string
  title: string
  active: boolean
  registered: boolean
  state: 'ok' | 'damaged' | 'missing' | 'unreadable'
}

export interface PanelSelectionDto {
  root: string | null
  source: 'query' | 'active' | 'single' | 'config' | 'none'
}

export interface PanelMissingDto {
  root: string
  title: string
  code: 'ENGINE_PROJECT_MISSING' | 'ENGINE_PROJECT_NOT_FOUND'
  reason: 'missing' | 'not-project' | 'damaged' | 'not_registered' | 'unreadable'
  hint: string
}

export interface PanelPayloadDto {
  schemaVersion: number
  projects: ProjectOptionDto[]
  selection: PanelSelectionDto
  summary?: SummaryDto
  chapters?: ChaptersDto
  gates?: GatesDto
  resume?: { text: string }
  missing?: PanelMissingDto
  error?: string
  empty?: true
}
