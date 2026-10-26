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
  title: string
  genre: string
  platform: string
  chapter: number
  stage: string
  revision: number
  totalWords: number
  totalChapters: number
  phases: PhaseDto[]
  blocking: BlockingDto[]
}

export interface ChapterRowDto {
  num: number
  title: string
  wordCount: number
  score: number
  stage: string
  status: 'passed' | 'blocked' | 'draft'
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

export interface PanelPayloadDto {
  schemaVersion: number
  summary: SummaryDto
  chapters: ChaptersDto
  gates: GatesDto
  error?: string
  empty?: true
}
