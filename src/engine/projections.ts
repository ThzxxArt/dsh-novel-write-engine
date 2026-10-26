import { PANEL_ID, PHASE_STRIP, REMOTE_VERSION } from '../constants.js'
import type { BlockingItem, ChapterRecord, Stage, StatusReport } from '../types.js'

/** The shared read model: everything the panel, status and commands render. */
export interface PanelSnapshot {
  root: string
  title: string
  genre: string
  platform: string
  chapter: number
  stage: Stage
  revision: number
  rounds: { review: number; revise: number; check: number }
  blocking: BlockingItem[]
  chapters: ChapterRecord[]
  /** Total words across the index, for the header. */
  totalWords: number
  /** The nine-phase strip state, derived from the pipeline stage. */
  phases: Array<{ id: string; done: boolean; active: boolean }>
}

export interface PanelSummaryDto {
  schemaVersion: number
  panelId: string
  title: string
  genre: string
  platform: string
  chapter: number
  stage: Stage
  revision: number
  totalWords: number
  totalChapters: number
  phases: Array<{ id: string; done: boolean; active: boolean }>
  blocking: BlockingItem[]
}

export interface PanelChapterRow {
  num: number
  title: string
  wordCount: number
  score: number
  stage: Stage
  status: 'passed' | 'blocked' | 'draft'
}

export interface PanelChaptersDto {
  schemaVersion: number
  panelId: string
  rows: PanelChapterRow[]
}

export interface PanelGatesDto {
  schemaVersion: number
  panelId: string
  stage: Stage
  blocking: BlockingItem[]
  /** Human-facing one-liner per blocking item. */
  explanations: string[]
}

const STAGE_TO_PHASE: Record<Stage, string> = {
  idle: 'P1',
  P2: 'P2',
  P3: 'P3',
  P4: 'P4',
  P5: 'P5',
  P6: 'P6',
  ready_to_archive: 'P8',
  done: 'P9',
}

/** The nine-phase progress strip: phases before the active one are done. */
export function phaseStrip(stage: Stage): Array<{ id: string; done: boolean; active: boolean }> {
  const active = STAGE_TO_PHASE[stage]
  const activeIndex = PHASE_STRIP.indexOf(active as (typeof PHASE_STRIP)[number])
  return PHASE_STRIP.map((id, index) => ({
    id,
    done: index < activeIndex,
    active: id === active,
  }))
}

/** Project a chapter row for the table; a reviewed chapter without blockers reads as passed. */
export function projectChapter(record: ChapterRecord): PanelChapterRow {
  return {
    num: record.num,
    title: record.title,
    wordCount: record.word_count,
    score: record.score,
    stage: record.status === 'reviewed' ? 'done' : 'P3',
    status: record.status === 'reviewed' ? 'passed' : 'draft',
  }
}

/** Status report used by the tool and by commands; one function, three callers. */
export function projectStatus(snapshot: PanelSnapshot, next: StatusReport['next']): StatusReport {
  return {
    project: {
      title: snapshot.title,
      genre: snapshot.genre as StatusReport['project']['genre'],
      platform: snapshot.platform as StatusReport['project']['platform'],
      root: snapshot.root,
    },
    chapter: snapshot.chapter,
    stage: snapshot.stage,
    rounds: { ...snapshot.rounds },
    blocking: snapshot.blocking,
    metrics: null,
    next,
  }
}

export function projectSummary(snapshot: PanelSnapshot): PanelSummaryDto {
  return {
    schemaVersion: REMOTE_VERSION,
    panelId: PANEL_ID,
    title: snapshot.title,
    genre: snapshot.genre,
    platform: snapshot.platform,
    chapter: snapshot.chapter,
    stage: snapshot.stage,
    revision: snapshot.revision,
    totalWords: snapshot.totalWords,
    totalChapters: snapshot.chapters.length,
    phases: snapshot.phases,
    blocking: snapshot.blocking,
  }
}

export function projectChapters(snapshot: PanelSnapshot): PanelChaptersDto {
  return {
    schemaVersion: REMOTE_VERSION,
    panelId: PANEL_ID,
    rows: snapshot.chapters.map(projectChapter),
  }
}

export function projectGates(snapshot: PanelSnapshot): PanelGatesDto {
  return {
    schemaVersion: REMOTE_VERSION,
    panelId: PANEL_ID,
    stage: snapshot.stage,
    blocking: snapshot.blocking,
    explanations: snapshot.blocking.map(
      (item) => `${item.code}${item.scope === undefined ? '' : ` (${item.scope})`}: ${item.detail}`,
    ),
  }
}
