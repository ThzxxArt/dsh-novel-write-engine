import { describe, expect, it, vi } from 'vitest'
import { createNovelTools, emptySummary, toolNames } from '../src/tools/index.js'
import type { EngineService } from '../src/engine/service.js'

const result = <T>(data: T): { data: T; revision: number; warnings: never[] } => ({
  data,
  revision: 2,
  warnings: [],
})

const engine = () => ({
  initProject: vi.fn(async () => result({ root: '/tmp/x', title: 't', chapter: 1, stage: 'idle' })),
  getStatus: vi.fn(async () =>
    result({
      project: { title: 't', genre: '都市现代', platform: 'fanqie', root: '/tmp/x' },
      chapter: 1,
      stage: 'idle',
      rounds: { review: 0, revise: 0, check: 0 },
      blocking: [],
      metrics: null,
      next: { tool: 'novel_plan_world', args: {}, reason: 'start' },
    }),
  ),
  getBrief: vi.fn(async () =>
    result({
      stage: 'P1',
      chapter: 1,
      digest: 'D',
      title: 'P1',
      content: '任务书',
      content_hash: 'h',
      fields: {},
    }),
  ),
  submitWorldPlan: vi.fn(async () => result({ chapter: 1, stage: 'P2', plan_file: 'a' })),
  submitChapterPlan: vi.fn(async () => result({ chapter: 1, stage: 'P3', plan_file: 'b' })),
  submitDraft: vi.fn(async () =>
    result({ chapter: 1, stage: 'P4', metrics: { total_word_count: 100 }, warnings: [] }),
  ),
  submitReview: vi.fn(async () =>
    result({ chapter: 1, round: 1, total: 145, open_blockers: 0, next_stage: 'P6' }),
  ),
  submitRevision: vi.fn(async () => result({ chapter: 1, stage: 'P4', metrics: { total_word_count: 100 } })),
  runCheck: vi.fn(async () =>
    result({ chapter: 1, verdict: 'pass', violations: 0, metrics: {}, stage: 'ready_to_archive' }),
  ),
  archiveChapter: vi.fn(async () =>
    result({ chapter: 1, assigned_ids: { a: 'FS-001' }, metrics: { total_word_count: 100 }, score: 145 }),
  ),
  countWords: vi.fn(async () => result({ total_word_count: 10 })),
  queryState: vi.fn(async () => result({ ok: true })),
  amend: vi.fn(async () => result({ path: 'state/world.yaml', revision: 2 })),
  rollback: vi.fn(async () => result({ chapter: 1, stage: 'P3' })),
  diff: vi.fn(async () => result({ chapter: 1, before: 'a', after: 'b', added: 1, removed: 0, hunks: [] })),
  auditHistory: vi.fn(async () => result([])),
  export: vi.fn(async () => result({ kind: 'md', files: ['exports/book.md'] })),
  advise: vi.fn(async () =>
    result({ stage: 'P3', chapter: 1, tool: 'novel_write_draft', args: {}, reason: 'write', blocking: [] }),
  ),
})

type Tool = {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
  output: { render: (args: unknown, value: never) => Array<{ text: string }> }
}

const tools = (fake: ReturnType<typeof engine>): Map<string, Tool> =>
  new Map(
    createNovelTools(fake as unknown as EngineService).map((tool) => [tool.name, tool as unknown as Tool]),
  )

describe('every tool executes one operation', () => {
  it('passes arguments through for all eighteen tools', async () => {
    const fake = engine()
    const map = tools(fake)
    await map.get('novel_brief')!.execute({ stage: 'P1', chapter: 2 }, {})
    expect(fake.getBrief).toHaveBeenCalledWith({ stage: 'P1', chapter: 2 })
    await map.get('novel_plan_world')!.execute(
      {
        objective: 'o',
        constraints: ['c'],
        characters: [{ name: '他' }],
        locations: [],
        continuity_notes: [],
        project_root: '/tmp/x',
      },
      {},
    )
    expect(fake.submitWorldPlan).toHaveBeenCalledWith(expect.objectContaining({ chapter: 0, root: '/tmp/x' }))
    await map.get('novel_plan_chapter')!.execute(
      {
        title: 't',
        scene_type: '日常过渡章',
        narrator: '他',
        beats: ['b'],
        opening: 'o',
        ending: 'e',
        target_words: [100, 200],
      },
      {},
    )
    expect(fake.submitChapterPlan).toHaveBeenCalledWith(
      expect.objectContaining({ chapter: 0, target_words: [100, 200] }),
    )
    await map.get('novel_review')!.execute({ chapter: 1, dimensions: [], total: 150, proof: {} }, {})
    expect(fake.submitReview).toHaveBeenCalledWith(expect.objectContaining({ chapter: 1, issues: [] }))
    await map.get('novel_revise')!.execute({ chapter: 1, content: 'x', issues: [], proof: {} }, {})
    expect(fake.submitRevision).toHaveBeenCalledWith(expect.objectContaining({ issues: [], proof: {} }))
    await map.get('novel_check')!.execute({ chapter: 1, semantic: [], scope: ['content'] }, {})
    expect(fake.runCheck).toHaveBeenCalledWith(expect.objectContaining({ chapter: 1 }))
    await map.get('novel_archive')!.execute(
      {
        chapter: 1,
        state_delta: { characters: {}, foreshadows: {}, timeline: {}, world: {}, relationships: {} },
      },
      {},
    )
    expect(fake.archiveChapter).toHaveBeenCalled()
    await map.get('novel_state')!.execute({ kind: 'chapters', chapter: 1 }, {})
    expect(fake.queryState).toHaveBeenCalledWith({ kind: 'chapters', chapter: 1 })
    await map.get('novel_amend')!.execute({ path: 'state/world.yaml', content: {}, reason: 'r' }, {})
    expect(fake.amend).toHaveBeenCalled()
    await map.get('novel_rollback')!.execute({ chapter: 1, to_stage: 'P3', reason: 'r' }, {})
    expect(fake.rollback).toHaveBeenCalledWith({ chapter: 1, toStage: 'P3', reason: 'r' })
    await map.get('novel_diff')!.execute({ chapter: 1, before: 'a', after: 'b' }, {})
    expect(fake.diff).toHaveBeenCalled()
    await map.get('novel_export')!.execute({ kind: 'epub' }, {})
    expect(fake.export).toHaveBeenCalledWith({ kind: 'epub' })
    await map.get('novel_audit')!.execute({ limit: 5 }, {})
    expect(fake.auditHistory).toHaveBeenCalledWith({ limit: 5 })
    await map.get('novel_pipeline')!.execute({}, {})
    expect(fake.advise).toHaveBeenCalled()
    await map.get('novel_word_count')!.execute({ text: 'x' }, {})
    expect(fake.countWords).toHaveBeenCalledWith({ text: 'x' })
    await map.get('novel_init')!.execute(
      {
        title: '书',
        genre: '玄幻仙侠',
        platform: 'qidian',
        author: 'a',
        description: 'd',
        words_per_chapter: [1000, 2000],
        total_chapters: 10,
        project_root: '/tmp/x',
      },
      {},
    )
    expect(fake.initProject).toHaveBeenCalledWith(
      expect.objectContaining({ author: 'a', words_per_chapter: [1000, 2000], total_chapters: 10 }),
    )
  })

  it('renders the brief and archive cards', () => {
    const map = tools(engine())
    const brief = map.get('novel_brief')!.output.render({}, { content: '任务书', digest: 'D' } as never)
    expect(brief[0]!.text).toContain('任务书')
    expect(brief[0]!.text).toContain('brief digest: D')
    const archive = map.get('novel_archive')!.output.render({}, {
      chapter: 1,
      score: 145,
      metrics: { total_word_count: 100 },
      assigned_ids: { k: 'FS-001' },
    } as never)
    expect(archive[0]!.text).toContain('FS-001')
  })

  it('exposes tool names by mode and an empty revision summary', () => {
    expect(toolNames('core')).toHaveLength(8)
    expect(emptySummary()).toMatchObject({ hook_strength: 3, plot_advancement: 'mid', events: [] })
  })
})
