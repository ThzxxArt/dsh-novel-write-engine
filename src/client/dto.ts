import type { PanelBookData } from '../panel-contract.js'

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

/** Chapter-boundary projection; absent on older payloads. */
export interface ProgressDto {
  active_chapter: number
  stage: string
  current: { chapter: number; stage: string } | null
  last_archived: number | null
  next: { chapter: number; stage: 'P1' } | null
  finished: boolean
  label: string
  resume: string
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
  progress?: ProgressDto
  revision: number
  totalWords: number
  archivedWords?: number
  draftWords?: number
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
  quality?: {
    averageScore: number
    scores: number[]
    trend: number | null
    trend_basis?: 'last_five_vs_previous_five' | 'insufficient_samples' | 'insufficient_history'
    samples?: number
    attempts?: number
  }
  health?: { ok: boolean; blocking: number; stateErrors: number; pending?: boolean }
  activity?: Array<{ at: string; op: string; chapter: number; status: string }>
  advisories?: Array<{ code: string; detail: string; hint?: string }>
  /** Advisory codes the author has already acknowledged in the current check. */
  acknowledgedAdvisories?: number
  legacy?: Array<{ code: string; detail: string }>
  /** Crash-left pending transaction; read-only diagnostics. */
  pending?: { state: string; txid: string; detail: string }
  /** v6 read-only book data; v5 payloads omit it and are rejected by the client. */
  bookData?: PanelBookData
}

export interface ChapterRowDto {
  num: number
  title: string
  wordCount: number
  score: number
  stage: string
  status: 'passed' | 'blocked' | 'draft'
  details?: string
  sceneType?: string
  dialogueRatio?: number
  hookStrength?: number
  finalCheck?: 'pass' | 'fail' | null
  reviews?: number
  revisions?: number
  checks?: number
  rollbacks?: number
  archivedAt?: string | null
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
  state: 'ok' | 'damaged' | 'missing' | 'not-project' | 'unreadable'
  identity_changed?: boolean
}

export interface PanelSelectionDto {
  root: string | null
  source: 'query' | 'active' | 'single' | 'config' | 'none'
}

export interface PanelMissingDto {
  root: string
  title: string
  code: 'ENGINE_PROJECT_MISSING' | 'ENGINE_PROJECT_NOT_FOUND' | 'ENGINE_TXN_IN_PROGRESS'
  reason: 'missing' | 'not-project' | 'damaged' | 'not_registered' | 'unreadable' | 'busy'
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
