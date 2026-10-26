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

type Tool = { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }

const tools = (engine: ReturnType<typeof fakeEngine>): Map<string, Tool> =>
  new Map(
    createNovelTools(engine as unknown as EngineService).map((tool) => [tool.name, tool as unknown as Tool]),
  )

describe('tool adapters', () => {
  it('registers exactly eighteen tools and eight in core mode', () => {
    expect(toolNames('all')).toHaveLength(18)
    expect(toolNames('core')).toHaveLength(8)
    const map = tools(fakeEngine())
    expect(map.size).toBe(18)
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
    expect(engine.export).toHaveBeenCalledWith({ kind: 'epub' })
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
      (await commands.find((command) => command.name === 'novel-export')!.handler(invocation('txt'))).kind,
    ).toBe('success')
    expect(
      (await commands.find((command) => command.name === 'novel-export')!.handler(invocation('pdf'))).kind,
    ).toBe('error')
    expect(
      (await commands.find((command) => command.name === 'novel-admin')!.handler(invocation(''))).text,
    ).toContain('novel_init')
  })

  it('executes hidden operations through /novel admin', async () => {
    const engine = fakeEngine()
    const commands = createCommands(engine as unknown as EngineService)
    const novel = commands.find((command) => command.name === 'novel')!
    const state = await novel.handler(invocation('admin novel_state {"kind":"pipeline"}'))
    expect(state.kind).toBe('success')
    expect(engine.queryState).toHaveBeenCalledWith({ kind: 'pipeline' })

    const init = await novel.handler(
      invocation('admin novel_init {"title":"新书","genre":"都市现代","platform":"fanqie"}'),
    )
    expect(init.kind).toBe('success')
    expect(engine.initProject).toHaveBeenCalledWith(
      expect.objectContaining({ title: '新书', genre: '都市现代', platform: 'fanqie' }),
    )

    const rollback = await commands
      .find((command) => command.name === 'novel-admin')!
      .handler(invocation('novel_rollback {"chapter":1,"to_stage":"P3"}'))
    expect(rollback.kind).toBe('success')
    expect(engine.rollback).toHaveBeenCalledWith(expect.objectContaining({ chapter: 1, toStage: 'P3' }))

    const unknown = await novel.handler(invocation('admin novel_missing {}'))
    expect(unknown.kind).toBe('error')
    expect(unknown.text).toContain('未知')

    for (const [operation, args] of [
      ['novel_plan_world', '{"objective":"o"}'],
      ['novel_plan_chapter', '{"title":"t"}'],
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

  it('rejects malformed admin arguments and supports the short command form', async () => {
    const engine = fakeEngine()
    const commands = createCommands(engine as unknown as EngineService)
    const novel = commands.find((command) => command.name === 'novel')!
    expect((await novel.handler(invocation('admin novel_state {oops}'))).kind).toBe('error')
    expect((await novel.handler(invocation('admin novel_state []'))).kind).toBe('error')
    expect((await novel.handler(invocation('admin novel_state null'))).kind).toBe('error')
    const short = commands.find((command) => command.name === 'novel-admin')!
    expect((await short.handler(invocation('novel_init'))).kind).toBe('success')
    expect((await short.handler(invocation('novel_state {"kind":"pipeline"}'))).kind).toBe('success')
    const controller = new AbortController()
    controller.abort()
    expect((await short.handler(invocation('', controller.signal))).kind).toBe('error')

    const plain = { advise: async () => 'plain' } as unknown as EngineService
    expect(await runAdminOperation(plain, 'novel_pipeline', '')).toContain('plain')
  })
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

  it('serves GET/HEAD and refuses writes', async () => {
    const engine = fakeEngine()
    const handler = panelHandler(engine as unknown as EngineService)
    const get = response()
    await handler({ method: 'GET' }, get)
    expect(get.record.statusCode).toBe(200)
    expect(JSON.parse(get.record.body)).toMatchObject({ schemaVersion: 1 })
    expect((await panelPayload(engine as unknown as EngineService)).schemaVersion).toBe(1)

    const head = response()
    await handler({ method: 'HEAD' }, head)
    expect(head.record.body).toBe('')

    const post = response()
    await handler({ method: 'POST' }, post)
    expect(post.record.statusCode).toBe(405)
    expect(post.record.headers.allow).toBe('GET, HEAD')
  })

  it('degrades to an empty payload when the project cannot be read', async () => {
    const engine = fakeEngine()
    engine.panelBundle = vi.fn(async () => {
      throw new Error('no project')
    })
    const handler = panelHandler(engine as unknown as EngineService)
    const res = response()
    await handler({ method: 'GET' }, res)
    expect(JSON.parse(res.record.body)).toMatchObject({ empty: true, error: 'no project' })
    expect(panelRoute(engine as unknown as EngineService).path).toBe('/api/novel-write-engine/panel')
  })
})
