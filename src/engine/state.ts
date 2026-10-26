import type { ChaptersDocument, HandoffDocument, NovelProject, PipelineState } from '../types.js'

/** Plugin configuration, mapped from `Config` in `src/index.ts`. */
export interface EngineConfig {
  projectRoot: string
  /** Where the multi-project registry lives; never inside a project. */
  stateDir: string
  tools: { mode: 'all' | 'core' }
  quality: { minScore: number }
  briefs: { locale: 'zh' | 'en' }
}

/** Events other plugins may subscribe to; payloads never contain manuscript text. */
export type EngineEvent =
  | {
      name: 'novel/archived'
      payload: { schemaVersion: 1; projectRoot: string; chapter: number; score: number; words: number }
    }
  | {
      name: 'novel/blocked'
      payload: { schemaVersion: 1; projectRoot: string; operation: string; blocking: number }
    }
  | {
      name: 'novel/amended'
      payload: { schemaVersion: 1; projectRoot: string; path: string; reason: string }
    }

/** A pipeline document for a brand-new project. */
export function emptyPipeline(
  patch: Partial<PipelineState> & { revision: number; chapter: number; stage: PipelineState['stage'] },
): PipelineState {
  return {
    schema_version: 1,
    revision: patch.revision,
    chapter: patch.chapter,
    stage: patch.stage,
    rounds: patch.rounds ?? { review: 0, revise: 0, check: 0 },
    briefs: patch.briefs ?? {},
    blocking: patch.blocking ?? [],
    last_action: patch.last_action ?? null,
  }
}

/** Every state document a project starts with, keyed by file base name. */
export function emptyDocuments(): Record<string, unknown> {
  const chapters: ChaptersDocument = { schema_version: 1, chapters: [] }
  const handoff: HandoffDocument = {
    schema_version: 1,
    current_chapter: 0,
    volume: 1,
    volume_name: '第一卷',
    act: '第一幕',
    act_progress: '0/0',
    next_chapter: 1,
    last_summary: '',
    open_hooks: [],
    updated_at: new Date(0).toISOString(),
  }
  return {
    'chapters.yaml': chapters,
    'characters.yaml': { schema_version: 1, characters: [] },
    'world.yaml': { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
    'locks.yaml': { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
    'timeline.yaml': { schema_version: 1, next_seq: 1, items: [] },
    'foreshadows.yaml': { schema_version: 1, next_seq: 1, items: [] },
    'relationships.yaml': { schema_version: 1, next_seq: 1, items: [] },
    'handoff.yaml': handoff,
  }
}

/** Placeholder project used only to create the first document set. */
export const ENGINE_PROJECT_INITIAL: NovelProject = {
  schema_version: 1,
  title: '',
  genre: '都市现代',
  platform: 'fanqie',
  author: '',
  description: '',
  created_at: new Date(0).toISOString(),
  targets: { words_per_chapter: [2000, 3000], total_chapters: null, dialogue_ratio: [0.4, 0.6] },
}
