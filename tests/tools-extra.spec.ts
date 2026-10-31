import { describe, expect, it, vi } from 'vitest'
import { createNovelTools, emptySummary, toolNames } from '../src/tools/index.js'
import type { EngineService } from '../src/engine/service.js'
import { EngineBlockedError, EngineInputError } from '../src/types.js'
import { TOOL_NAMES } from '../src/constants.js'

const result = <T>(data: T): { data: T; revision: number; warnings: never[] } => ({
  data,
  revision: 2,
  warnings: [],
})

const engine = () => ({
  withSignal: async (_signal: unknown, task: () => Promise<unknown>) => task(),
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
  parameters?: unknown
  execute: (args: unknown, exec: unknown) => Promise<unknown>
  output: { render: (args: unknown, value: never) => Array<{ text: string }> }
}

const tools = (fake: ReturnType<typeof engine>): Map<string, Tool> =>
  new Map(
    createNovelTools(fake as unknown as EngineService).map((tool) => [tool.name, tool as unknown as Tool]),
  )

describe('every tool executes one operation', () => {
  it('passes arguments through for all twenty-eight tools', async () => {
    const fake = engine()
    const map = tools(fake)
    expect([...map.keys()].sort()).toEqual([...TOOL_NAMES].sort())
    expect(JSON.stringify(map.get('novel_restore')!.parameters)).toContain('state/pipeline.yaml')
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
    await expect(
      map.get('novel_plan_chapter')!.execute(
        {
          title: 't',
          scene_type: '日常过渡章',
          narrator: '他',
          beats: ['a', 'b', 'c', 'd', 'e'],
          opening: 'o',
          ending: 'e',
        },
        {},
      ),
    ).rejects.toThrow(/missing required property "target_words"/)
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
        genre: '玄幻修仙',
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
    const brief = map.get('novel_brief')!.output.render({}, {
      content: '任务书',
      digest: 'D',
      fields: { score_exclusions: [{ pair: ['A', 'B'], family: 'x' }] },
    } as never)
    expect(brief[0]!.text).toContain('任务书')
    expect(brief[0]!.text).toContain('brief digest: D')
    expect(brief[0]!.text).toContain('score_exclusions')
    const archive = map.get('novel_archive')!.output.render({}, {
      chapter: 1,
      score: 145,
      metrics: { total_word_count: 100 },
      assigned_ids: { k: 'FS-001' },
    } as never)
    expect(archive[0]!.text).toContain('FS-001')
    const replay = map.get('novel_archive')!.output.render({}, {
      data: { chapter: 1, score: 145, metrics: { total_word_count: 100 }, assigned_ids: {} },
      revision: 2,
      warnings: [],
      replayed: true,
    } as never)
    expect(replay[0]!.text).toContain('replayed')
    const status = map.get('novel_status')!.output.render({}, {
      data: {
        project: { title: '状态书', genre: '都市现代', platform: 'fanqie', root: '/tmp/x' },
        chapter: 1,
        active_chapter: 1,
        stage: 'P6',
        rounds: { review: 2, revise: 1, check: 3 },
        blocking: [{ code: 'PG-11', detail: 'round limit' }],
        next: { tool: 'novel_rollback', reason: 'restart' },
      },
      revision: 3,
      warnings: [],
    } as never)
    expect(status[0]!.text).toContain('轮次：评审 2 / 修订 1 / 校验 3')
    expect(status[0]!.text).toContain('PG-11')
  })

  it('keeps structured blocking items in the tool error', async () => {
    const fake = engine()
    fake.archiveChapter = vi.fn(async () => {
      throw new EngineBlockedError(
        'ENGINE_GATE_BLOCKED',
        'archive blocked',
        [{ code: 'PG-04', detail: 'bad format', hint: 'fix it' }],
        'fix the blockers',
      )
    }) as never
    const map = tools(fake)
    await expect(map.get('novel_archive')!.execute({ chapter: 1, state_delta: {} }, {})).rejects.toThrowError(
      /blocking: .*PG-04/,
    )
  })

  it('renders engine warnings for json tools', () => {
    const map = tools(engine())
    const rendered = map.get('novel_review')!.output.render({}, {
      data: { chapter: 1, round: 1, total: 145, open_blockers: 0, next_stage: 'P6' },
      revision: 2,
      warnings: [{ code: 'SCORE_EXCLUSIONS', message: '2 deductions were dropped' }],
    } as never)
    expect(rendered[0]!.text).toContain('SCORE_EXCLUSIONS')
    expect(rendered[0]!.text).toContain('2 deductions')
  })

  it('renders optional status, brief and warning branches', async () => {
    const fake = engine()
    const map = tools(fake)
    const status = map.get('novel_status')!.output.render({}, {
      data: {
        project: { title: '状态书', genre: '都市现代', platform: 'fanqie', root: '/tmp/x' },
        chapter: 2,
        active_chapter: 1,
        stage: 'P3',
        blocking: [],
        next: { tool: 'novel_write_draft', reason: 'write' },
        book: {
          outline: { total: 3, archived: 1, coverage: 0.5, current: null },
          worldbook: { characters: 1, locations: 1, factions: 0, rules: 0 },
        },
      },
      revision: 2,
      warnings: [],
    } as never)
    expect(status[0]!.text).toContain('字数查询：第 2 章')
    expect(status[0]!.text).toContain('当前章卡：（无）')
    expect(map.get('novel_review')!.output.render({}, 'plain' as never)).toBeTruthy()

    const brief = map.get('novel_brief')!.output.render({}, {
      data: { content: '任务书', digest: 'D', fields: { a: 1 }, context: { b: 2 } },
      revision: 2,
      warnings: [],
    } as never)
    expect(brief[0]!.text).toContain('fields:')
    expect(brief[0]!.text).toContain('context:')
    const bareBrief = map.get('novel_brief')!.output.render({}, {
      data: { content: '任务书', digest: 'D' },
      revision: 2,
      warnings: [],
    } as never)
    expect(bareBrief[0]!.text).not.toContain('fields:')

    const warnings = map.get('novel_review')!.output.render({}, {
      data: { chapter: 1, round: 1, total: 145, open_blockers: 0, next_stage: 'P6' },
      revision: 2,
      warnings: ['plain warning', { message: 'missing code' }],
    } as never)
    expect(warnings[0]!.text).toContain('plain warning')
    expect(warnings[0]!.text).toContain('WARNING')

    fake.archiveChapter = vi.fn(async () => {
      throw new EngineInputError('ENGINE_SCHEMA_INVALID', 'bad input')
    }) as never
    await expect(map.get('novel_archive')!.execute({ chapter: 1, state_delta: {} }, {})).rejects.toThrow(
      /ENGINE_SCHEMA_INVALID/,
    )
    await expect(
      map.get('novel_plan_world')!.execute({ objective: 'o', characters: '{' }, {}),
    ).rejects.toThrow(/malformed JSON|JSON/)
    await map.get('novel_plan_chapter')!.execute(
      {
        title: 't',
        scene_type: '日常过渡章',
        narrator: 'n',
        beats: ['a', 'b', 'c', 'd', 'e'],
        opening: 'o',
        ending: 'e',
        target_words: [100, 200],
      },
      {},
    )
    await map
      .get('novel_state')!
      .execute({ kind: 'chapters', include_summary: true, chapter_range: [1, 2] }, {})
    await map.get('novel_state')!.execute({ kind: 'chapters' }, {})
  })

  it('exposes tool names by mode and an empty revision summary', () => {
    expect(toolNames('core')).toHaveLength(10)
    expect(emptySummary()).toMatchObject({ hook_strength: 3, plot_advancement: 'mid', events: [] })
  })
})
