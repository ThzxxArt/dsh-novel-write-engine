import { describe, expect, it, vi } from 'vitest'
import { createNovelTools, toolNames } from '../src/tools/index.js'
import { createCommands } from '../src/commands/index.js'
import { runAdminOperation } from '../src/commands/admin.js'
import { panelHandler, panelPayload, panelRoute } from '../src/remote/index.js'
import { EngineInputError } from '../src/types.js'
import type { EngineService } from '../src/engine/service.js'

const result = <T>(data: T): { data: T; revision: number; warnings: never[] } => ({
  data,
  revision: 1,
  warnings: [],
})

const fakeEngine = () => {
  const engine = {
    withSignal: vi.fn(async (_signal: unknown, task: () => Promise<unknown>) => task()),
    initProject: vi.fn(async () => result({ root: '/tmp/x', title: 't', chapter: 1, stage: 'idle' })),
    getStatus: vi.fn(async () =>
      result({
        project: { title: 't', genre: '都市现代', platform: 'fanqie', root: '/tmp/x' },
        chapter: 1,
        stage: 'idle',
        rounds: { review: 0, revise: 0, check: 0 },
        blocking: [],
        metrics: null,
        book: {
          premise: 'p',
          logline: 'l',
          strict: true,
          outline: {
            present: true,
            total: 1,
            planned: 1,
            archived: 0,
            coverage: 0,
            volumes: 0,
            current: null,
          },
          worldbook: {
            present: true,
            characters: 1,
            locations: 1,
            factions: 0,
            rules: 0,
            glossary: 0,
            backstory: 0,
          },
        },
        next: { tool: 'novel_plan_world', args: {}, reason: 'start' },
      }),
    ),
    getBrief: vi.fn(async () =>
      result({
        stage: 'P1',
        chapter: 1,
        digest: 'D',
        title: 'P1',
        content: '正文',
        content_hash: 'h',
        fields: {},
      }),
    ),
    submitWorldPlan: vi.fn(async () =>
      result({ chapter: 1, stage: 'P2', plan_file: 'plans/ch001.world.yaml' }),
    ),
    submitChapterPlan: vi.fn(async () =>
      result({ chapter: 1, stage: 'P3', plan_file: 'plans/ch001.chapter.yaml' }),
    ),
    submitDraft: vi.fn(async () => result({ chapter: 1, stage: 'P4', metrics: {}, warnings: [] })),
    submitReview: vi.fn(async () =>
      result({ chapter: 1, round: 1, total: 150, open_blockers: 0, next_stage: 'P6' }),
    ),
    submitRevision: vi.fn(async () => result({ chapter: 1, stage: 'P4', metrics: {} })),
    runCheck: vi.fn(async () =>
      result({ chapter: 1, verdict: 'pass', violations: 0, metrics: {}, stage: 'ready_to_archive' }),
    ),
    archiveChapter: vi.fn(async () =>
      result({ chapter: 1, assigned_ids: { k: 'FS-001' }, metrics: { total_word_count: 120 }, score: 145 }),
    ),
    countWords: vi.fn(async () => result({ total_word_count: 10 })),
    queryState: vi.fn(async () => result({ ok: true })),
    amend: vi.fn(async () => result({ path: 'state/characters.yaml', revision: 2 })),
    rollback: vi.fn(async () => result({ chapter: 1, stage: 'P3' })),
    diff: vi.fn(async () => result({ chapter: 1, before: '', after: '', added: 0, removed: 0, hunks: [] })),
    auditHistory: vi.fn(async () => result([])),
    export: vi.fn(async () => result({ kind: 'md', files: ['exports/book.md'] })),
    advise: vi.fn(async () =>
      result({ stage: 'P3', chapter: 1, tool: 'novel_write_draft', args: {}, reason: 'write', blocking: [] }),
    ),
    submitBookPlan: vi.fn(async () =>
      result({ premise: '', logline: '', strict: true, volumes: 1, chapters: 1 }),
    ),
    submitOutline: vi.fn(async () => result({ planned: 1, archived: 0, total: 1, strict: true, volumes: 1 })),
    importOutline: vi.fn(async () =>
      result({
        format: 'markdown',
        planned: 1,
        archived: 0,
        total: 1,
        warnings: [],
        preview: '',
        applied: true,
      }),
    ),
    submitWorldbook: vi.fn(async () => result({ sections: ['rules'], entries: 1 })),
    search: vi.fn(async (): Promise<any> =>
      result({ query: 'x', scope: 'all', total: 0, truncated: false, results: [] }),
    ),
    doctor: vi.fn(async (): Promise<any> =>
      result({ ok: true, root: '/tmp/x', checks: [], summary: { errors: 0, warnings: 0, infos: 0 } }),
    ),
    report: vi.fn(async (): Promise<any> =>
      result({
        progress: { archived: 1, target: 3, words: 100, percent: 33 },
        outline: { planned: 1, archived: 1, drift: [] },
        worldbook: { characters: 1 },
        quality: { average: 145, median: 145, trend: 0 },
        pacing: {},
        cast: {},
        foreshadows: { open: 0, overdue: 0 },
        timeline: {},
        relationships: {},
        activity: [],
        warnings: [],
      }),
    ),
    guide: vi.fn(async () =>
      result({
        state: 'new',
        title: 't',
        steps: [],
        next: { tool: 'novel_brief', args: {}, reason: 'r' },
        commands: [],
        tips: [],
      }),
    ),
    reopenChapter: vi.fn(async () => result({ chapter: 1, stage: 'P3', restore_txid: 'tx' })),
    listProjects: vi.fn(async () => ({ active: null, projects: [] })),
    registerProject: vi.fn(async () => ({ active: '/tmp/x', projects: [] })),
    setActiveProject: vi.fn(async () => ({ active: '/tmp/x' })),
    forgetProject: vi.fn(async () => ({ active: null, projects: [] })),
    stats: vi.fn(async () => ({
      totalWords: 100,
      chapters: 1,
      revision: 2,
      rulepack: 'default@1.0.0',
      averageScore: 0,
      lastScore: 0,
      openForeshadows: 0,
    })),
    panelSummary: vi.fn(async () => ({
      schemaVersion: 1,
      panelId: 'novel-workshop',
      title: 't',
      genre: '都市现代',
      platform: 'fanqie',
      chapter: 1,
      stage: 'P3',
      revision: 2,
      totalWords: 100,
      totalChapters: 1,
      phases: [],
      blocking: [],
    })),
    panelChapters: vi.fn(async () => ({ schemaVersion: 1, panelId: 'novel-workshop', rows: [] })),
    panelGates: vi.fn(async () => ({
      schemaVersion: 1,
      panelId: 'novel-workshop',
      stage: 'P3',
      blocking: [],
      explanations: [],
    })),
    panelBundle: vi.fn(async () => ({
      summary: {
        schemaVersion: 1,
        panelId: 'novel-workshop',
        title: 't',
        genre: '都市现代',
        platform: 'fanqie',
        chapter: 1,
        stage: 'P3',
        revision: 2,
        totalWords: 100,
        totalChapters: 1,
        phases: [],
        blocking: [],
      },
      chapters: { schemaVersion: 1, panelId: 'novel-workshop', rows: [] },
      gates: { schemaVersion: 1, panelId: 'novel-workshop', stage: 'P3', blocking: [], explanations: [] },
    })),
  }
  return engine
}

type Tool = {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
  output?: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
}

const tools = (engine: ReturnType<typeof fakeEngine>): Map<string, Tool> =>
  new Map(
    createNovelTools(engine as unknown as EngineService).map((tool) => [tool.name, tool as unknown as Tool]),
  )

describe('tool adapters', () => {
  it('registers exactly twenty-eight tools and ten in core mode', () => {
    expect(toolNames('all')).toHaveLength(28)
    expect(toolNames('core')).toHaveLength(10)
    const map = tools(fakeEngine())
    expect(map.size).toBe(28)
  })

  it('renders the payload after the host passes execute() straight to output.render', async () => {
    const map = tools(fakeEngine())
    const cases: Array<[string, unknown]> = [
      ['novel_status', { chapter: 1 }],
      ['novel_brief', { stage: 'P1' }],
      ['novel_archive', { chapter: 1, state_delta: {} }],
    ]
    for (const [name, args] of cases) {
      const tool = map.get(name)!
      const returned = await tool.execute(args, {})
      const rendered = tool.output!.render(args, returned)
      expect(rendered[0]!.text, name).not.toContain('undefined')
      expect(rendered[0]!.text, name).not.toContain('"data"')
    }
  })

  it('does not invent planning coverage when total_chapters is unset', async () => {
    const map = tools(fakeEngine())
    const tool = map.get('novel_status')!
    const value = await tool.execute({ chapter: 1 }, {})
    const rendered = tool.output!.render({ chapter: 1 }, value)
    expect(rendered[0]!.text).toContain('规划覆盖 —')
    expect(rendered[0]!.text).not.toContain('规划覆盖 100%')
  })

  it('forwards the host cancellation signal into the engine work', async () => {
    const engine = fakeEngine()
    const map = tools(engine)
    const signal = new AbortController().signal
    await map.get('novel_status')!.execute({ chapter: 1 }, { signal })
    expect(engine.withSignal).toHaveBeenCalledWith(signal, expect.any(Function))
  })

  it('parses a provider-serialized JSON string for free-form parameters', async () => {
    const engine = fakeEngine()
    const map = tools(engine)
    await map.get('novel_write_draft')!.execute(
      {
        chapter: 1,
        content: '正文',
        chapter_title: '标题',
        scene_type: '日常过渡章',
        narrator: '他',
        summary: JSON.stringify({ events: ['事件'] }),
      },
      {},
    )
    expect(engine.submitDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ summary: { events: ['事件'] } }),
    )
    await map
      .get('novel_archive')!
      .execute({ chapter: 1, state_delta: JSON.stringify({ characters: {} }) }, {})
    expect(engine.archiveChapter).toHaveBeenLastCalledWith(
      expect.objectContaining({ state_delta: { characters: {} } }),
    )
  })

  it('narrows arguments and calls exactly one operation', async () => {
    const engine = fakeEngine()
    const map = tools(engine)
    const value = (await map.get('novel_status')!.execute({ chapter: 1 }, {})) as {
      data: { chapter: number }
    }
    expect(value.data.chapter).toBe(1)
    expect(engine.getStatus).toHaveBeenCalledWith({ chapter: 1 })

    await map.get('novel_init')!.execute({ title: '书', genre: '都市现代', platform: 'fanqie' }, {})
    expect(engine.initProject).toHaveBeenCalledWith({ title: '书', genre: '都市现代', platform: 'fanqie' })

    await map.get('novel_write_draft')!.execute(
      {
        chapter: 1,
        content: '正文',
        chapter_title: '标题',
        scene_type: '日常过渡章',
        narrator: '他',
        summary: {},
      },
      {},
    )
    expect(engine.submitDraft).toHaveBeenCalled()
    expect(engine.submitReview).not.toHaveBeenCalled()
  })

  it('maps the three error families into a single message shape', async () => {
    const engine = fakeEngine()
    engine.countWords = vi.fn(async () => {
      throw new EngineInputError('ENGINE_STAGE_ORDER', 'stage wrong', 'call status')
    })
    const map = tools(engine)
    await expect(map.get('novel_word_count')!.execute({}, {})).rejects.toThrow(
      '[ENGINE_STAGE_ORDER] stage wrong — call status',
    )
    engine.countWords = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(map.get('novel_word_count')!.execute({}, {})).rejects.toThrow('boom')
  })

  it('renders human-facing text for status and archive', async () => {
    const map = tools(fakeEngine())
    const tool = map.get('novel_status') as unknown as {
      output: { render: (args: unknown, value: never) => Array<{ text: string }> }
    }
    const rendered = tool.output.render({}, {
      project: { title: '书' },
      chapter: 1,
      stage: 'P3',
      blocking: [],
      next: { tool: 'novel_write_draft', reason: '写' },
    } as never)
    expect(rendered[0]!.text).toContain('《书》')
    const coverage = tool.output.render({}, {
      project: { title: '覆盖之书' },
      chapter: 1,
      stage: 'P2',
      blocking: [],
      next: { tool: 'novel_plan_chapter', reason: 'plan' },
      book: {
        strict: false,
        outline: {
          total: 10,
          planned_coverage: 0.2,
          archived_coverage: 0,
          current: null,
        },
        worldbook: { characters: 1, locations: 1, factions: 0, rules: 1 },
      },
    } as never)
    expect(coverage[0]!.text).toContain('规划覆盖 20%')
    expect(coverage[0]!.text).toContain('归档覆盖 0%')
    const archive = map.get('novel_archive') as unknown as {
      output: { render: (args: unknown, value: never) => Array<{ text: string }> }
    }
    const archived = archive.output.render({}, {
      chapter: 1,
      score: 145,
      metrics: { total_word_count: 120 },
      assigned_ids: {},
    } as never)
    expect(archived[0]!.text).toContain('已归档')
  })
})

it('routes the 0.2.0 book tools to their service operations', async () => {
  const engine = fakeEngine()
  const map = tools(engine)
  await map.get('novel_blueprint')!.execute({ premise: 'p', volumes: [] }, {})
  expect(engine.submitBookPlan).toHaveBeenCalledWith(expect.objectContaining({ premise: 'p', volumes: [] }))
  await map.get('novel_outline')!.execute({ chapters: [] }, {})
  expect(engine.submitOutline).toHaveBeenCalledWith(expect.objectContaining({ chapters: [] }))
  await map.get('novel_outline_import')!.execute({ format: 'markdown', content: 'x' }, {})
  expect(engine.importOutline).toHaveBeenCalledWith(
    expect.objectContaining({ format: 'markdown', content: 'x' }),
  )
  await map.get('novel_worldbook')!.execute({ rules: [] }, {})
  expect(engine.submitWorldbook).toHaveBeenCalledWith(expect.objectContaining({ rules: [] }))
  await map.get('novel_search')!.execute({ query: 'x' }, {})
  expect(engine.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'x' }))
  await map.get('novel_doctor')!.execute({}, {})
  await map.get('novel_report')!.execute({}, {})
  await map.get('novel_guide')!.execute({}, {})
  expect(engine.doctor).toHaveBeenCalled()
  expect(engine.report).toHaveBeenCalled()
  expect(engine.guide).toHaveBeenCalled()
  await map.get('novel_reopen')!.execute({ chapter: 1, reason: 'rewrite the ending' }, {})
  expect(engine.reopenChapter).toHaveBeenCalledWith(
    expect.objectContaining({ chapter: 1, reason: 'rewrite the ending' }),
  )
})

describe('command adapters', () => {
  const invocation = (rawInput: string, signal = new AbortController().signal) => ({ rawInput, signal })

  it('routes every subcommand through the engine', async () => {
    const engine = fakeEngine()
    const commands = createCommands(engine as unknown as EngineService)
    const novel = commands.find((command) => command.name === 'novel')!
    expect((await novel.handler(invocation(''))).kind).toBe('success')
    expect((await novel.handler(invocation('status'))).kind).toBe('success')
    expect((await novel.handler(invocation('next'))).text).toContain('novel_write_draft')
    expect((await novel.handler(invocation('stats'))).text).toContain('章节 1')
    expect((await novel.handler(invocation('export epub'))).kind).toBe('success')
    expect((await novel.handler(invocation('export pdf'))).kind).toBe('error')
    expect((await novel.handler(invocation('admin'))).text).toContain('隐藏操作')
    expect((await novel.handler(invocation('nope'))).kind).toBe('error')
    expect((await novel.handler(invocation('outline'))).kind).toBe('success')
    expect((await novel.handler(invocation('guide'))).kind).toBe('success')
    expect((await novel.handler(invocation('report'))).kind).toBe('success')
    expect((await novel.handler(invocation('doctor'))).kind).toBe('success')
    expect((await novel.handler(invocation('search 信封'))).kind).toBe('success')
    expect((await novel.handler(invocation('search'))).kind).toBe('error')
    expect((await novel.handler(invocation('export'))).kind).toBe('error')
    expect((await novel.handler(invocation('admin novel_word_count {"text":"x"}'))).kind).toBe('success')
    expect((await novel.handler(invocation('admin nope {}'))).kind).toBe('error')
    expect((await novel.handler(invocation('export outline'))).kind).toBe('success')
    expect(engine.export).toHaveBeenCalledWith({ kind: 'epub' })
  })

  it('renders a status with no book and with null coverage', async () => {
    const engine = fakeEngine()
    const commands = createCommands(engine as unknown as EngineService)
    const novel = commands.find((command) => command.name === 'novel')!
    engine.getStatus.mockResolvedValueOnce(
      result({
        project: { title: '空书', genre: '都市现代', platform: 'fanqie', root: '/tmp/x' },
        chapter: 1,
        stage: 'idle',
        rounds: { review: 0, revise: 0, check: 0 },
        blocking: [],
        metrics: null,
        next: { tool: 'novel_init', args: {}, reason: 'start' },
      }) as never,
    )
    const noBook = await novel.handler(invocation('status'))
    expect(noBook.text).toContain('字数 —')
    expect(noBook.text).not.toContain('全书：')
    engine.getStatus.mockResolvedValueOnce(
      result({
        project: { title: '未知目标', genre: '都市现代', platform: 'fanqie', root: '/tmp/x' },
        chapter: 1,
        stage: 'idle',
        rounds: { review: 0, revise: 0, check: 0 },
        blocking: [],
        metrics: { total_word_count: 1, cjk_chars: 1, punctuation_chars: 0 },
        book: {
          premise: '',
          logline: '',
          strict: false,
          outline: {
            present: true,
            total: 0,
            planned: 0,
            archived: 0,
            target: null,
            missing_cards: 0,
            planned_coverage: null,
            archived_coverage: null,
            coverage: 0,
            card_coverage: 1,
            volumes: 0,
            current: null,
          },
          worldbook: {
            present: false,
            characters: 0,
            locations: 0,
            factions: 0,
            rules: 0,
            glossary: 0,
            backstory: 0,
          },
        },
        next: { tool: 'novel_outline', args: {}, reason: 'plan' },
      }) as never,
    )
    const noTarget = await novel.handler(invocation('status'))
    expect(noTarget.text).toContain('规划覆盖 —')
    expect(noTarget.text).toContain('归档覆盖 —')
    engine.getStatus.mockResolvedValueOnce(
      result({
        project: { title: '已规划', genre: '都市现代', platform: 'fanqie', root: '/tmp/x' },
        chapter: 1,
        stage: 'P2',
        rounds: { review: 0, revise: 0, check: 0 },
        blocking: [],
        metrics: { total_word_count: 8, cjk_chars: 6, punctuation_chars: 2 },
        book: {
          premise: 'p',
          logline: 'l',
          strict: false,
          outline: {
            present: true,
            total: 2,
            planned: 2,
            archived: 0,
            target: 10,
            missing_cards: 8,
            planned_coverage: 0.2,
            archived_coverage: 0,
            coverage: 0.2,
            card_coverage: 0,
            volumes: 1,
            current: {
              num: 1,
              title: '开端',
              scene_type: '日常过渡章',
              target_words: [600, 800],
            },
          },
          worldbook: {
            present: true,
            characters: 1,
            locations: 1,
            factions: 0,
            rules: 1,
            glossary: 0,
            backstory: 0,
          },
        },
        next: { tool: 'novel_plan_chapter', args: {}, reason: 'plan' },
      }) as never,
    )
    const withCard = await novel.handler(invocation('status'))
    expect(withCard.text).toContain('当前章卡：第1章 开端')
    expect(withCard.text).toContain('缺卡 8')
  })

  it('reports unreadable planning documents instead of claiming an empty outline', async () => {
    const engine = fakeEngine()
    const novel = createCommands(engine as unknown as EngineService).find(
      (command) => command.name === 'novel',
    )!
    engine.getStatus.mockResolvedValueOnce(
      result({
        project: { title: '坏规划', genre: '都市现代', platform: 'fanqie', root: '/tmp/x' },
        chapter: 1,
        stage: 'idle',
        rounds: { review: 0, revise: 0, check: 0 },
        blocking: [],
        state_errors: [
          {
            code: 'OUTLINE_UNREADABLE',
            path: 'outline/outline.yaml',
            message: 'invalid outline',
          },
          {
            code: 'WORLDBOOK_UNREADABLE',
            path: 'outline/worldbook.yaml',
            message: 'invalid worldbook',
          },
          {
            code: 'PROJECT_UNREADABLE',
            path: 'novel.yaml',
            message: 'invalid project',
          },
        ],
        next: { tool: 'novel_init', args: {}, reason: 'repair' },
      }) as never,
    )
    const reply = await novel.handler(invocation('outline'))
    expect(reply.kind).toBe('error')
    expect(reply.text).toContain('OUTLINE_UNREADABLE')
  })

  it('reports cancellation and failures', async () => {
    const engine = fakeEngine()
    const controller = new AbortController()
    controller.abort()
    const commands = createCommands(engine as unknown as EngineService)
    expect((await commands[0]!.handler(invocation('', controller.signal))).kind).toBe('error')
    engine.getStatus = vi.fn(async () => {
      throw new EngineInputError('X', 'bad', 'hint')
    })
    const reply = await commands[0]!.handler(invocation('status'))
    expect(reply.text).toContain('[X] bad — hint')
  })

  it('renders admin warnings and replay markers', async () => {
    const engine = fakeEngine()
    const novel = createCommands(engine as unknown as EngineService).find(
      (command) => command.name === 'novel',
    )!
    engine.search.mockResolvedValueOnce({
      data: { query: 'x', scope: 'all', total: 0, truncated: false, results: [] },
      revision: 1,
      warnings: [{ code: 'OUTLINE_UNREADABLE', message: 'outline is corrupt' }],
    } as never)
    const searched = await novel.handler(invocation('admin novel_search {"query":"x"}'))
    expect(searched.text).toContain('引擎警告')
    expect(searched.text).toContain('OUTLINE_UNREADABLE')
    engine.export.mockResolvedValueOnce({
      data: { kind: 'md', files: ['exports/book.md'] },
      revision: 1,
      warnings: [],
      replayed: true,
    } as never)
    const exported = await novel.handler(invocation('admin novel_export {"kind":"md"}'))
    expect(exported.text).toContain('replayed: true')
  })

  it('serves the four short commands', async () => {
    const engine = fakeEngine()
    const commands = createCommands(engine as unknown as EngineService)
    expect(
      (await commands.find((command) => command.name === 'novel-next')!.handler(invocation(''))).kind,
    ).toBe('success')
    expect(
      (await commands.find((command) => command.name === 'novel-stats')!.handler(invocation(''))).text,
    ).toContain('default@1.0.0')
    expect(
      (await commands.find((command) => command.name === 'novel-stats')!.handler(invocation(''))).text,
    ).toContain('revision 2')
    engine.advise.mockResolvedValueOnce(
      result({
        stage: 'P2',
        chapter: 1,
        tool: 'novel_brief',
        args: {},
        reason: 'fetch the P2 brief before novel_plan_chapter',
        blocking: [],
      }),
    )
    expect(
      (await commands.find((command) => command.name === 'novel-next')!.handler(invocation(''))).text,
    ).toContain('先领取当前阶段的任务书')
    expect(
      (await commands.find((command) => command.name === 'novel-export')!.handler(invocation('txt'))).kind,
    ).toBe('success')
    expect(
      (await commands.find((command) => command.name === 'novel-export')!.handler(invocation('pdf'))).kind,
    ).toBe('error')
    expect(
      (await commands.find((command) => command.name === 'novel-admin')!.handler(invocation(''))).text,
    ).toContain('novel_word_count')
  })

  it('executes hidden operations through /novel admin', async () => {
    const engine = fakeEngine()
    const commands = createCommands(engine as unknown as EngineService)
    const novel = commands.find((command) => command.name === 'novel')!
    const state = await novel.handler(invocation('admin novel_state {"kind":"pipeline"}'))
    expect(state.kind).toBe('success')
    expect(engine.queryState).toHaveBeenCalledWith({ kind: 'pipeline' })

    const wordCount = await novel.handler(invocation('admin novel_word_count {"text":"一段正文"}'))
    expect(wordCount.kind).toBe('success')
    expect(engine.countWords).toHaveBeenCalledWith({ text: '一段正文' })

    const rollback = await commands
      .find((command) => command.name === 'novel-admin')!
      .handler(invocation('novel_rollback {"chapter":1,"to_stage":"P3"}'))
    expect(rollback.kind).toBe('success')
    expect(engine.rollback).toHaveBeenCalledWith(expect.objectContaining({ chapter: 1, toStage: 'P3' }))

    const unknown = await novel.handler(invocation('admin novel_missing {}'))
    expect(unknown.kind).toBe('error')
    expect(unknown.text).toContain('未知')

    await novel.handler(invocation('admin novel_plan_chapter {"title":"t"}'))
    expect(engine.submitChapterPlan).toHaveBeenLastCalledWith(expect.objectContaining({ title: 't' }))
    await novel.handler(
      invocation('admin novel_amend {"path":"state/world.yaml","content":{"note":"a  b"},"reason":"r"}'),
    )
    expect(engine.amend).toHaveBeenLastCalledWith(expect.objectContaining({ content: { note: 'a  b' } }))
    await novel.handler(invocation('admin novel_export {"kind":"md","project_root":"/other"}'))
    expect(engine.export).toHaveBeenLastCalledWith(expect.objectContaining({ root: '/other' }))

    for (const [operation, args] of [
      ['novel_plan_world', '{"objective":"o"}'],
      [
        'novel_plan_chapter',
        '{"title":"t","scene_type":"日常过渡章","narrator":"n","beats":["a","b","c","d","e"],"opening":"o","ending":"e","target_words":[100,200]}',
      ],
      ['novel_word_count', '{"text":"x"}'],
      ['novel_amend', '{"path":"state/world.yaml","content":{},"reason":"r"}'],
      ['novel_diff', '{"chapter":1}'],
      ['novel_export', '{"kind":"md"}'],
      ['novel_audit', '{"limit":1}'],
      ['novel_pipeline', '{}'],
    ] as const) {
      const result = await novel.handler(invocation(`admin ${operation} ${args}`))
      expect(result.kind, operation).toBe('success')
    }
  })

  it('exposes every 0.2.0 admin operation and the registry helpers', async () => {
    const engine = fakeEngine()
    const novel = createCommands(engine as unknown as EngineService).find(
      (command) => command.name === 'novel',
    )!
    for (const [operation, args] of [
      ['novel_blueprint', '{}'],
      ['novel_outline', '{"chapters":[]}'],
      ['novel_outline_import', '{"format":"markdown","content":"x"}'],
      ['novel_worldbook', '{"premise":"x"}'],
      ['novel_search', '{"query":"x"}'],
      ['novel_doctor', '{}'],
      ['novel_report', '{}'],
      ['novel_guide', '{}'],
      ['novel_reopen', '{"chapter":1,"reason":"test"}'],
    ] as const) {
      const result = await novel.handler(invocation(`admin ${operation} ${args}`))
      expect(result.kind, operation).toBe('success')
    }
    expect((await novel.handler(invocation('admin novel_registry_list {}'))).kind).toBe('success')
    expect((await novel.handler(invocation('admin novel_registry_register {"root":"/tmp/x"}'))).kind).toBe(
      'success',
    )
    expect((await novel.handler(invocation('admin novel_registry_activate {"root":"/tmp/x"}'))).kind).toBe(
      'success',
    )
    expect((await novel.handler(invocation('admin novel_registry_forget {"root":"/tmp/x"}'))).kind).toBe(
      'success',
    )
    expect((await novel.handler(invocation('admin novel_registry_register {}'))).kind).toBe('error')
  })

  it('covers the no-book fallback and non-empty report/doctor output', async () => {
    const invocation = (rawInput: string) => ({ rawInput, signal: new AbortController().signal })
    const engine = fakeEngine()
    engine.getStatus = vi.fn(async () =>
      result({
        project: { title: 't', genre: '都市现代', platform: 'fanqie', root: '/tmp/x' },
        chapter: 1,
        stage: 'idle',
        rounds: { review: 0, revise: 0, check: 0 },
        blocking: [],
        metrics: null,
        next: { tool: 'novel_plan_world', args: {}, reason: 'start' },
      }),
    )
    engine.report = vi.fn(async () =>
      result({
        progress: { archived: 0, target: null, words: 0, percent: 0 },
        outline: { planned: 0, archived: 0, drift: [] },
        worldbook: { characters: 0 },
        quality: { average: 0, median: 0, trend: 0 },
        pacing: {},
        cast: {},
        foreshadows: { open: 0, overdue: 0 },
        timeline: {},
        relationships: {},
        activity: [],
        warnings: ['一条警告'],
      }),
    )
    engine.doctor = vi.fn(async () =>
      result({
        ok: false,
        root: '/tmp/x',
        checks: [
          { id: 'a', severity: 'ok', title: 'ok', detail: 'fine' },
          { id: 'b', severity: 'error', title: 'bad', detail: 'broken' },
        ],
        summary: { errors: 1, warnings: 0, infos: 0 },
      }),
    ) as never
    const novel = createCommands(engine as unknown as EngineService).find(
      (command) => command.name === 'novel',
    )!
    const status = await novel.handler(invocation('status'))
    expect(status.kind).toBe('success')
    expect(status.text).not.toContain('全书：')
    const outline = await novel.handler(invocation('outline'))
    expect(outline.text).toContain('还没有书级规划数据')
    const report = await novel.handler(invocation('report'))
    expect(report.text).toContain('一条警告')
    const doctor = await novel.handler(invocation('doctor'))
    expect(doctor.text).toContain('[error] bad')
    expect(doctor.text).not.toContain('[ok]')
  })

  it('rejects malformed admin arguments and supports the short command form', async () => {
    const engine = fakeEngine()
    const commands = createCommands(engine as unknown as EngineService)
    const novel = commands.find((command) => command.name === 'novel')!
    expect((await novel.handler(invocation('admin novel_state {oops}'))).kind).toBe('error')
    expect((await novel.handler(invocation('admin novel_state []'))).kind).toBe('error')
    expect((await novel.handler(invocation('admin novel_state null'))).kind).toBe('error')
    const short = commands.find((command) => command.name === 'novel-admin')!
    expect((await short.handler(invocation('novel_word_count {"text":"x"}'))).kind).toBe('success')
    expect((await short.handler(invocation('novel_state {"kind":"pipeline"}'))).kind).toBe('success')
    const controller = new AbortController()
    controller.abort()
    expect((await short.handler(invocation('', controller.signal))).kind).toBe('error')

    const plain = { advise: async () => 'plain' } as unknown as EngineService
    expect(await runAdminOperation(plain, 'novel_pipeline', '')).toContain('plain')
  })
})

it('surfaces non-engine command errors and search hits', async () => {
  const invocation = (rawInput: string) => ({ rawInput, signal: new AbortController().signal })
  const engine = fakeEngine()
  const commands = createCommands(engine as unknown as EngineService)
  const next = commands.find((command) => command.name === 'novel-next')!
  engine.advise = vi.fn(async () => {
    throw new Error('advise boom')
  })
  expect((await next.handler(invocation(''))).text).toContain('advise boom')
  const stats = commands.find((command) => command.name === 'novel-stats')!
  engine.stats = vi.fn(async () => {
    throw new Error('stats boom')
  })
  expect((await stats.handler(invocation(''))).text).toContain('stats boom')
  const exp = commands.find((command) => command.name === 'novel-export')!
  engine.export = vi.fn(async () => {
    throw new Error('export boom')
  })
  expect((await exp.handler(invocation('md'))).text).toContain('export boom')
  const view = fakeEngine()
  view.search = vi.fn(async () =>
    result({
      query: 'x',
      scope: 'all',
      total: 1,
      truncated: false,
      results: [{ kind: 'chapters', chapter: 1, snippet: 'hit' }],
    }),
  ) as never
  const novel = createCommands(view as unknown as EngineService).find((command) => command.name === 'novel')!
  const search = await novel.handler(invocation('search x'))
  expect(search.kind).toBe('success')
  expect(search.text).toContain('找到 1 条')
  const empty = await novel.handler(invocation('search'))
  expect(empty.kind).toBe('error')
})

describe('panel route', () => {
  const response = () => {
    const record = { statusCode: 0, headers: {} as Record<string, string>, body: '' }
    const res = {
      statusCode: 0,
      record,
      setHeader: (name: string, value: string) => {
        record.headers[name] = value
      },
      end: (body: string) => {
        record.body = body
      },
    }
    Object.defineProperty(res, 'statusCode', {
      get: () => record.statusCode,
      set: (value: number) => {
        record.statusCode = value
      },
    })
    return res
  }

  it('serves GET/HEAD and refuses writes after admission', async () => {
    const engine = fakeEngine()
    const handler = panelHandler(engine as unknown as EngineService, () => undefined)
    const get = response()
    await handler({ method: 'GET' }, get)
    expect(get.record.statusCode).toBe(200)
    expect(JSON.parse(get.record.body)).toMatchObject({ schemaVersion: 4 })
    expect((await panelPayload(engine as unknown as EngineService)).schemaVersion).toBe(4)

    const head = response()
    await handler({ method: 'HEAD' }, head)
    expect(head.record.body).toBe('')

    const post = response()
    await handler({ method: 'POST' }, post)
    expect(post.record.statusCode).toBe(405)
    expect(post.record.headers.allow).toBe('GET, HEAD')
  })

  it('denies access unless the connection guard admits the request', async () => {
    const engine = fakeEngine()
    const denied = panelHandler(engine as unknown as EngineService, () => 401)
    const res = response()
    await denied({ method: 'GET' }, res)
    expect(res.record.statusCode).toBe(401)
    expect(res.record.body).toBe('unauthorized')

    const defaultDeny = panelHandler(engine as unknown as EngineService)
    const closed = response()
    await defaultDeny({ method: 'GET' }, closed)
    expect(closed.record.statusCode).toBe(503)

    const forbidden = response()
    await panelHandler(engine as unknown as EngineService, () => 403)(
      { method: 'GET', headers: { host: 'evil.example' } },
      forbidden,
    )
    expect(forbidden.record.statusCode).toBe(403)
    expect(panelRoute(engine as unknown as EngineService, () => undefined).path).toBe(
      '/api/novel-write-engine/panel',
    )
  })

  it('returns the project-not-found envelope as empty, and other failures as 500', async () => {
    const engine = fakeEngine()
    engine.panelBundle = vi.fn(async () => {
      throw new EngineInputError('ENGINE_PROJECT_NOT_FOUND', 'no project')
    })
    const empty = response()
    await panelHandler(engine as unknown as EngineService, () => undefined)({ method: 'GET' }, empty)
    expect(empty.record.statusCode).toBe(200)
    expect(JSON.parse(empty.record.body)).toMatchObject({ empty: true })

    engine.panelBundle = vi.fn(async () => {
      throw new Error('disk failed')
    })
    const failed = response()
    await panelHandler(engine as unknown as EngineService, () => undefined)({ method: 'GET' }, failed)
    expect(failed.record.statusCode).toBe(500)
    expect(JSON.parse(failed.record.body)).toMatchObject({ error: 'disk failed' })
  })
})
