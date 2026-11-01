/// <reference lib="dom" />
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildView, fetchPanel } from '../src/client/viewmodel.js'
import { apply as applyClient, NovelIcon, NovelPanel } from '../src/client/index.js'
import { panelElement } from '../src/client/panel.js'
import { ADMIN_OPERATION_GROUPS, COMMAND_ENTRY, COMMAND_GROUPS } from '../src/command-reference.js'
import type { PanelPayloadDto } from '../src/client/dto.js'

const payload = (): PanelPayloadDto & {
  summary: NonNullable<PanelPayloadDto['summary']>
  chapters: NonNullable<PanelPayloadDto['chapters']>
} => ({
  schemaVersion: 6,
  projects: [{ root: '/novels/test', title: '测试之书', active: true, registered: true, state: 'ok' }],
  selection: { root: '/novels/test', source: 'active' },
  resume: { text: '请继续《测试之书》。\n项目根：/novels/test' },
  summary: {
    schemaVersion: 6,
    panelId: 'novel-workshop',
    root: '/novels/test',
    title: '测试之书',
    genre: '都市现代',
    platform: 'fanqie',
    chapter: 2,
    stage: 'P4',
    revision: 7,
    totalWords: 5000,
    totalChapters: 2,
    phases: [
      { id: 'P1', done: true, active: false },
      { id: 'P2', done: true, active: true },
    ],
    blocking: [{ code: 'PG-03', detail: '少了 200 字', hint: '再写一点' }],
    next: { tool: 'novel_revise', reason: '补足字数' },
    book: {
      premise: '旧案重启',
      logline: '档案员入局',
      strict: true,
      target: 4,
      outline: {
        present: true,
        total: 3,
        planned: 2,
        archived: 1,
        target: 4,
        missing_cards: 1,
        planned_coverage: 0.75,
        archived_coverage: 0.25,
        coverage: 0.75,
        card_coverage: 1,
        volumes: [{ title: '第一卷 雨夜来信', start: 1, end: 3, planned: 2, archived: 1 }],
      },
      worldbook: {
        present: true,
        characters: 2,
        locations: 1,
        factions: 1,
        rules: 1,
        glossary: 0,
        backstory: 0,
      },
    },
    quality: { averageScore: 145, scores: [140, 145], trend: 5 },
    health: { ok: false, blocking: 1, stateErrors: 0 },
    activity: [{ at: '2026-10-28T10:00:00.000Z', op: 'archiveChapter', chapter: 1, status: 'committed' }],
  },
  chapters: {
    schemaVersion: 6,
    panelId: 'novel-workshop',
    rows: [
      { num: 1, title: '开端之雨', wordCount: 2400, score: 145, stage: 'done', status: 'passed' },
      { num: 2, title: '旧城之影', wordCount: 2100, score: 0, stage: 'P3', status: 'draft' },
      { num: 3, title: '灯下之言', wordCount: 0, score: 0, stage: 'P3', status: 'blocked' },
    ],
  },
})

const panelBookData = (): NonNullable<NonNullable<PanelPayloadDto['summary']>['bookData']> => ({
  identity: {
    author: '苏浅玥',
    description: '一座旧城，所有来信都从同一场雨开始。',
    created_at: '2026-10-01T08:00:00.000Z',
    targets: { words_per_chapter: [2200, 2800], total_chapters: 120, dialogue_ratio: [0.3, 0.6] },
  },
  blueprint: {
    premise: '旧案重启',
    logline: '档案员入局',
    themes: ['记忆', '失踪'],
    tone: '冷峻',
    pov: '第三人称限知',
    audience: '悬疑读者',
    selling_points: ['旧城雨夜', '档案谜案'],
    ending: '信被寄回。',
  },
  progress: {
    archived: 12,
    target: 120,
    words_archived: 286000,
    words_with_draft: 292400,
    average_words: 23833,
    remaining_words: 2576000,
    remaining_words_basis: 'actual_average',
    percent: 10,
  },
  current: {
    card: {
      num: 13,
      title: '雨停之前',
      scene_type: '情感爆发章',
      goal: '找到最后一封旧信。',
      conflict: '档案馆封楼。',
      hook: '钥匙断在锁里。',
      cast: ['林砚', '沈墨'],
      target_words: [2200, 2800],
      status: 'planned',
    },
    chapter: 13,
    stage: 'P4',
    rounds: { review: 1, revise: 0, check: 0 },
    manuscript_hash: 'hash-13',
    metrics: null,
  },
  worldbook: {
    counts: {
      present: true,
      characters: 2,
      locations: 2,
      factions: 1,
      rules: 1,
      glossary: 1,
      backstory: 1,
      facts: 1,
    },
    locations: [{ name: '旧书店', description: '临街两层，木门，靠墙书架到顶。' }],
    factions: [{ name: '港务会', description: '控制旧城航运与档案。' }],
    rules: [{ name: '信不能过海', description: '未署名的信会在港口被退回。' }],
    facts: [{ alias: '灯塔高度', value: 42, unit: '米' }],
  },
  cast: {
    total: 2,
    top: [
      { name: '林砚', role: '主角', appearances: 12, last_seen: 12 },
      { name: '沈墨', role: '配角', appearances: 8, last_seen: 11 },
    ],
  },
  relationships: { total: 1, types: { 盟友: 1 } },
  foreshadows: {
    open: 1,
    dormant: 0,
    overdue: 0,
    resolved: 0,
    oldest: [{ id: 'FS-001', title: '无名旧信', last_touched: 1, age: 11 }],
  },
  timeline: { events: 4, first_chapter: 1, last_chapter: 12 },
  outline: { drift: [] },
  quality: {
    average: 132,
    median: 134,
    min: 118,
    max: 145,
    last_ten_average: 136,
    trend: 2.5,
    trend_basis: 'last_five_vs_previous_five',
    samples: 12,
    attempts: 15,
    dimensions: [{ id: 'R-W-04', average: 17, samples: 12, max: 20 }],
  },
  pacing: {
    scene_types: { 日常过渡章: 6, 情感爆发章: 4 },
    hook_strength: { '4': 8, '5': 4 },
    plot_advancement: { mid: 9, high: 3 },
    longest: { chapter: 6, words: 2680 },
    shortest: { chapter: 3, words: 1980 },
  },
  effort: {
    reviews: 15,
    revisions: 4,
    checks: 12,
    rollbacks: 1,
    chapters: [
      {
        num: 12,
        reviews: 2,
        revisions: 1,
        checks: 1,
        rollbacks: 0,
        final_check: 'pass',
        archived_at: '2026-10-28T10:00:00.000Z',
      },
    ],
  },
  health: {
    state_errors: [],
    outline: { present: true, error: null },
    worldbook: { present: true, error: null },
    pending: null,
  },
})

const withoutCss = (markup: string): string => markup.replace(/<style>[\s\S]*?<\/style>/, '')

describe('panel view model', () => {
  it('sends the section ETag and treats 304 as unchanged', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: false,
      status: 304,
      json: async () => ({}),
      headers: { get: () => null },
      init,
    }))
    const result = await fetchPanel(
      fetchMock as unknown as typeof fetch,
      '/panel?section=characters',
      undefined,
      'W/"section"',
    )
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'if-none-match': 'W/"section"',
    })
    expect(result).toMatchObject({ notModified: true, error: null, payload: null })
  })

  it('projects the ready state', () => {
    const view = buildView(payload())
    expect(view.state).toBe('ready')
    expect(view.title).toBe('《测试之书》')
    expect(view.subtitle).toContain('第 2 章')
    expect(view.rows[0]).toMatchObject({ num: '1', badge: '已归档', tone: 'ok' })
    expect(view.rows[1]!.tone).toBe('muted')
    expect(view.rows[2]!.tone).toBe('bad')
    expect(view.blockingTitle).toBe('待处理 1 项')
    expect(view.stats).toMatchObject({ chapters: 2, words: 5000, averageScore: 145, blocking: 1 })
    expect(view.stageLabel).toBe('评审')
    expect(view.phases[0]!.label).toBe('世界观')
    expect(view.rows[0]).toMatchObject({ scoreValue: 145, scorePercent: 97, stageLabel: '已完成' })
    expect(view.nextTitle).toBe('修订本章')
    expect(view.nextDetail).toBe('处理评审意见后提交修订。')
    expect(view.blocking[0]!.hint).toBe('再写一点')
    expect(view.next).toContain('novel_revise')
    expect(view.book).toMatchObject({
      strict: true,
      planned: 2,
      archivedCards: 1,
      coverage: 0.75,
      missingCards: 1,
    })
    expect(view.book.volumes[0]).toMatchObject({ title: '第一卷 雨夜来信', range: '第1-3章' })
    expect(view.quality).toMatchObject({ averageScore: 145, scores: [140, 145] })
    expect(view.health).toMatchObject({ ok: false, blocking: 1 })
    expect(view.activity).toHaveLength(1)
  })

  it('renders the planning, worldbook, quality and activity sections', () => {
    const view = buildView(payload())
    const html = renderToStaticMarkup(panelElement(view, false, () => undefined))
    expect(html).toContain('全书规划')
    expect(html).toContain('世界观')
    expect(html).toContain('质量趋势')
    expect(html).toContain('第一卷 雨夜来信')
    expect(html).toContain('最近活动')
    expect(html).toContain('archiveChapter')
  })

  it('renders a help entry and opens the complete tutorial dialog accessibly', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    document.body.style.overflow = ''
    const container = document.createElement('div')
    document.body.append(container)
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload(),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(NovelPanel))
      })
      const help = container.querySelector<HTMLButtonElement>('button[aria-label="打开插件使用教程"]')
      expect(help).not.toBeNull()
      expect(help!.getAttribute('aria-expanded')).toBe('false')
      await act(async () => {
        help!.click()
      })
      const dialog = container.querySelector('[role="dialog"]')
      expect(dialog).not.toBeNull()
      expect(dialog!.getAttribute('aria-modal')).toBe('true')
      expect(dialog!.closest('[inert]')).toBeNull()
      expect(container.textContent).toContain('一本书的完整流程')
      expect(container.textContent).toContain('novel_archive')
      expect(container.textContent).toContain('L2-POV')
      expect(container.textContent).toContain('可以直接复制给模型的起手话术')
      expect(container.textContent).toContain('续写下一章时，直接复制这段给 Agent')
      expect(container.textContent).toContain('novel_pipeline')
      expect(container.textContent).toContain('targets.total_chapters')
      expect(container.textContent).toContain('完整的 state_delta')
      expect(container.textContent).toContain('项目不可读')
      expect(container.textContent).toContain('choose')
      expect(container.textContent).toContain('/novel current')
      expect(container.textContent).toContain('/novel unbind')
      expect(container.textContent).toContain('scan --register')
      expect(container.textContent).toContain('全部命令：入口、子命令与组合')
      expect(container.textContent).toContain('25 种带名写法')
      expect(container.textContent).toContain('25 个 admin 操作')
      for (const command of COMMAND_ENTRY) {
        expect(container.textContent, command.form).toContain(command.form)
      }
      for (const group of COMMAND_GROUPS) {
        for (const command of group.items) {
          expect(container.textContent, command.form).toContain(command.form)
        }
      }
      for (const group of ADMIN_OPERATION_GROUPS) {
        for (const operation of group.items) {
          expect(container.textContent, operation.name).toContain(operation.name)
        }
      }
      expect(help!.getAttribute('aria-expanded')).toBe('true')
      expect(document.body.style.overflow).toBe('hidden')
      expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭使用教程')
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(container.querySelector('[role="dialog"]')).toBeNull()
      expect(document.body.style.overflow).toBe('')
      expect(help!.getAttribute('aria-expanded')).toBe('false')
      expect(document.activeElement).toBe(help)
    } finally {
      await act(async () => {
        root.unmount()
      })
      vi.unstubAllGlobals()
      container.remove()
    }
  })

  it('renders an unset target without pretending the card count is the target', () => {
    const bare = payload()
    bare.summary.book!.target = null
    bare.summary.book!.outline!.total = 0
    bare.summary.book!.outline!.planned = 0
    bare.summary.book!.outline!.archived = 0
    bare.summary.book!.outline!.volumes = []
    const view = buildView(bare)
    const html = renderToStaticMarkup(panelElement(view, false, () => undefined))
    expect(html).toContain('目标未设置')
    expect(html).not.toContain('目标 0 章')
  })

  it('falls back to empty planning and quality blocks for older payloads', () => {
    const bare = payload()
    delete (bare.summary as { book?: unknown }).book
    delete (bare.summary as { quality?: unknown }).quality
    delete (bare.summary as { health?: unknown }).health
    delete (bare.summary as { activity?: unknown }).activity
    const view = buildView(bare)
    expect(view.book).toMatchObject({
      present: false,
      planned: 0,
      worldbook: { characters: 0, locations: 0, factions: 0, rules: 0, glossary: 0, backstory: 0 },
    })
    expect(view.quality).toMatchObject({ averageScore: 145, scores: [] })
    expect(view.health).toMatchObject({ ok: false, blocking: 1 })
    expect(view.activity).toEqual([])
    const html = renderToStaticMarkup(panelElement(view, false, () => undefined))
    expect(html).toContain('全书规划')
    expect(html).not.toContain('最近活动')
  })

  it('renders unhealthy activity without a chapter and an empty blocking hint', () => {
    const odd = payload()
    odd.summary.health = { ok: false, blocking: 2, stateErrors: 1 }
    odd.summary.blocking = [{ code: 'PG-13', detail: '缺卡', hint: '' }]
    odd.summary.activity = [
      { at: '2026-10-28T10:00:00.000Z', op: 'novel_doctor', chapter: 0, status: 'committed' },
    ]
    const view = buildView(odd)
    const html = renderToStaticMarkup(panelElement(view, false, () => undefined))
    expect(html).toContain('需要处理：2 条门控')
    expect(html).toContain('novel_doctor')
    expect(html).toContain('已提交')
  })

  it('labels stage done as chapter archived unless the book target is finished', () => {
    const archived = payload()
    archived.summary.stage = 'done'
    archived.summary.finished = false
    const view = buildView(archived)
    expect(view.stageLabel).toBe('本章已归档')
    expect(view.finished).toBe(false)
    archived.summary.finished = true
    const finishedView = buildView(archived)
    expect(finishedView.stageLabel).toBe('全书完成')
    expect(finishedView.nextTitle).toBe('')
  })

  it('degrades unknown labels, odd scores and a missing next action', () => {
    const odd = payload()
    odd.summary.platform = 'unknown-platform'
    odd.summary.stage = 'unknown-stage' as never
    odd.summary.phases = [{ id: 'PX', done: false, active: true }]
    odd.summary.next = undefined
    odd.chapters.rows = [
      { num: 1, title: '异常分', wordCount: 10, score: Number.NaN, stage: 'done', status: 'passed' },
      { num: 2, title: '越界分', wordCount: 10, score: 200, stage: 'done', status: 'passed' },
      { num: 3, title: '零分', wordCount: 10, score: 0, stage: 'done', status: 'passed' },
    ]
    const view = buildView(odd)
    expect(view.subtitle).toContain('unknown-platform')
    expect(view.stageLabel).toBe('unknown-stage')
    expect(view.phases[0]!.label).toBe('PX')
    expect(view.rows[1]!.scoreValue).toBe(150)
    expect(view.rows[0]!.scorePercent).toBe(0)
    expect(view.stats.averageScore).toBe(50)
    expect(view.nextTitle).toBe('状态已同步')
    expect(view.nextDetail).toContain('没有待执行')
    expect(view.next).toBe('')
  })

  it('uses the book-wide average instead of the capped rows', () => {
    const capped = payload()
    capped.summary.averageScore = 135
    capped.chapters.rows = [
      { num: 271, title: '末章', wordCount: 100, score: 90, stage: 'done', status: 'passed' },
    ]
    expect(buildView(capped).stats.averageScore).toBe(135)
  })

  it('renders act progress in the volume label', () => {
    const labelled = payload()
    labelled.summary.volume = 1
    labelled.summary.volume_name = '第一卷'
    labelled.summary.act = '第二幕'
    labelled.summary.act_progress = '3/5'
    const subtitle = buildView(labelled).subtitle
    expect(subtitle).toContain('第二幕 3/5')
  })

  it('shows inherited volume/act labels and falls back for unknown next tools', () => {
    const labelled = payload()
    labelled.summary.volume = 1
    labelled.summary.volume_name = '第一卷'
    labelled.summary.act = '第一幕'
    expect(buildView(labelled).subtitle).toContain('第一卷')
    expect(buildView(labelled).subtitle).toContain('第一幕')

    const volumeOnly = payload()
    volumeOnly.summary.volume = 2
    expect(buildView(volumeOnly).subtitle).toContain('第2卷')

    const unknown = payload()
    unknown.summary.next = { tool: 'weird_tool', reason: '自定义下一步' }
    const view = buildView(unknown)
    expect(view.nextTitle).toBe('继续')
    expect(view.nextDetail).toBe('自定义下一步')

    const noScores = payload()
    noScores.chapters.rows = noScores.chapters.rows.map((row) => ({ ...row, status: 'draft' }))
    expect(buildView(noScores).stats.averageScore).toBe(0)
  })

  it('renders loading, error, outdated and empty states', () => {
    expect(buildView(null).state).toBe('loading')
    expect(buildView(null, 'offline').state).toBe('error')
    expect(buildView({ ...payload(), schemaVersion: 9 }).state).toBe('outdated')
    expect(buildView({ ...payload(), schemaVersion: 3 }).state).toBe('outdated')
    expect(buildView({ ...payload(), empty: true }).subtitle).toContain('novel_init')
    const noBlockers = payload()
    noBlockers.summary.blocking = []
    expect(buildView(noBlockers).blockingTitle).toBe('门控已通过')
    const noHint = payload()
    noHint.summary.blocking = [{ code: 'X', detail: 'd' }]
    expect(buildView(noHint).blocking[0]!.hint).toBe('')
  })

  it('fetches and degrades without throwing', async () => {
    const ok = vi.fn(async () => ({ ok: true, json: async () => payload() }))
    expect((await fetchPanel(ok as unknown as typeof fetch, '/api')).payload?.summary?.chapter).toBe(2)
    const notOk = vi.fn(async () => ({ ok: false, status: 503 }))
    expect((await fetchPanel(notOk as unknown as typeof fetch, '/api')).error).toContain('503')
    const explained = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'database unavailable' }),
    }))
    expect((await fetchPanel(explained as unknown as typeof fetch, '/api')).error).toContain(
      'database unavailable',
    )
    const broken = vi.fn(async () => {
      throw new Error('offline')
    })
    expect((await fetchPanel(broken as unknown as typeof fetch, '/api')).error).toBe('offline')
    const nonError = vi.fn(async () => {
      throw 'x'
    })
    expect((await fetchPanel(nonError as unknown as typeof fetch, '/api')).error).toBe('无法连接宿主')
  })
})

describe('panel v6 project selection', () => {
  const twoProjects = (): PanelPayloadDto => {
    const value = payload()
    value.projects = [
      { root: '/novels/a', title: '甲书', active: true, registered: true, state: 'ok' },
      { root: '/novels/b', title: '乙书', active: false, registered: true, state: 'ok' },
    ]
    value.selection = { root: '/novels/a', source: 'active' }
    value.summary!.root = '/novels/a'
    value.summary!.title = '甲书'
    return value
  }

  const bPayload = (): PanelPayloadDto => {
    const value = twoProjects()
    value.selection = { root: '/novels/b', source: 'query' }
    value.summary!.root = '/novels/b'
    value.summary!.title = '乙书'
    return value
  }

  it('renders choose and missing states without rendering another book', () => {
    const choose: PanelPayloadDto = twoProjects()
    choose.selection = { root: null, source: 'none' }
    delete choose.summary
    delete choose.chapters
    const chooseView = buildView(choose)
    expect(chooseView.state).toBe('choose')
    const chooseHtml = renderToStaticMarkup(panelElement(chooseView, false, () => undefined))
    expect(chooseHtml).toContain('发现多本书，先选一本')
    expect(chooseHtml).toContain('甲书')
    expect(chooseHtml).toContain('乙书')
    expect(chooseHtml).toContain('aria-label="切换项目"')
    expect(chooseHtml).not.toContain('开端之雨')

    const missing: PanelPayloadDto = twoProjects()
    missing.selection = { root: '/novels/b', source: 'query' }
    delete missing.summary
    delete missing.chapters
    missing.missing = {
      root: '/novels/b',
      title: '乙书',
      code: 'ENGINE_PROJECT_MISSING',
      reason: 'missing',
      hint: 'restore the directory or mount, then refresh',
    }
    const missingView = buildView(missing)
    expect(missingView.state).toBe('missing')
    const missingHtml = renderToStaticMarkup(panelElement(missingView, false, () => undefined))
    expect(missingHtml).toContain('项目不在了')
    expect(missingHtml).toContain('ENGINE_PROJECT_MISSING')
    expect(missingHtml).toContain('restore the directory')
    expect(missingHtml).toContain('aria-label="切换项目"')
    expect(missingHtml).toContain('甲书')

    const unreadable: PanelPayloadDto = { ...missing }
    unreadable.missing = {
      root: '/novels/b',
      title: '乙书',
      code: 'ENGINE_PROJECT_MISSING',
      reason: 'unreadable',
      hint: 'fix directory permissions',
    }
    const unreadableView = buildView(unreadable)
    expect(unreadableView.title).toBe('项目不可读')
    expect(renderToStaticMarkup(panelElement(unreadableView, false, () => undefined))).toContain('项目不可读')
  })

  it('labels busy, not-project and identity-changed selector entries', () => {
    const busy = twoProjects()
    busy.selection = { root: '/novels/b', source: 'query' }
    delete busy.summary
    delete busy.chapters
    busy.missing = {
      root: '/novels/b',
      title: '乙书',
      code: 'ENGINE_TXN_IN_PROGRESS',
      reason: 'busy',
      hint: 'wait for the writer',
    }
    const busyView = buildView(busy)
    expect(busyView.title).toBe('正在写入')
    expect(busyView.stageLabel).toBe('稍后刷新')
    expect(renderToStaticMarkup(panelElement(busyView, false, () => undefined))).toContain('稍后刷新')

    const notProject = twoProjects()
    notProject.projects[1] = { ...notProject.projects[1]!, state: 'not-project' }
    notProject.selection = { root: '/novels/b', source: 'query' }
    delete notProject.summary
    delete notProject.chapters
    notProject.missing = {
      root: '/novels/b',
      title: '乙书',
      code: 'ENGINE_PROJECT_NOT_FOUND',
      reason: 'not-project',
      hint: 'the directory is not a project',
    }
    const notProjectView = buildView(notProject)
    expect(notProjectView.title).toBe('不是项目目录')
    expect(notProjectView.projects.find((project) => project.root === '/novels/b')?.label).toContain(
      '（不是项目）',
    )

    const identity = twoProjects()
    identity.projects[0] = { ...identity.projects[0]!, identity_changed: true }
    const identityView = buildView(identity)
    const changed = identityView.projects.find((project) => project.root === '/novels/a')
    expect(changed?.label).toContain('（路径已换书）')
    expect(changed?.group).toBe('damaged')
  })

  it('labels an insufficient quality history without a fake trend', () => {
    const value = payload()
    value.summary!.quality = {
      averageScore: 145,
      scores: [140, 145],
      trend: null,
      trend_basis: 'insufficient_history',
      samples: 2,
      attempts: 3,
    }
    expect(buildView(value).quality.trendText).toBe('历史不足')
  })

  it('renders a sparse ready payload without chapters, resume, root or next tool', () => {
    const sparse: PanelPayloadDto = payload()
    sparse.summary!.root = ''
    sparse.summary!.next = { tool: '', reason: '' }
    sparse.summary!.health = { ok: true, blocking: 0, stateErrors: 0 }
    sparse.chapters!.rows[0]!.details = ''
    delete sparse.chapters
    delete sparse.resume
    const view = buildView(sparse)
    expect(view.state).toBe('ready')
    expect(view.root).toBe('/novels/test')
    expect(view.rows).toHaveLength(0)
    expect(view.resumeText).toBe('')
    const html = renderToStaticMarkup(panelElement(view, false, () => undefined))
    expect(html).toContain('书架还是空的')
    expect(html).toContain('项目健康')
    expect(html).not.toContain('复制续写指令')
  })

  it('renders the empty shelf and row without details', () => {
    const rows = payload()
    rows.chapters!.rows = []
    const emptyShelf = renderToStaticMarkup(panelElement(buildView(rows), false, () => undefined))
    expect(emptyShelf).toContain('书架还是空的')

    const detail = payload()
    detail.chapters!.rows[0]!.details = ''
    const detailHtml = renderToStaticMarkup(panelElement(buildView(detail), false, () => undefined))
    expect(detailHtml).not.toContain('class="nwe-chapter-detail"')
  })

  it('renders empty without a selector when there are no projects', () => {
    const blank: PanelPayloadDto = payload()
    blank.projects = []
    blank.selection = { root: null, source: 'none' }
    delete blank.summary
    delete blank.chapters
    delete blank.resume
    blank.empty = true
    blank.error = '没有项目'
    const html = renderToStaticMarkup(panelElement(buildView(blank), false, () => undefined))
    expect(html).not.toContain('aria-label="切换项目"')
    expect(html).toContain('没有项目')
  })

  it('handles a duplicate title whose root has no path segments', () => {
    const rootless = twoProjects()
    rootless.projects[0]!.root = '/'
    rootless.projects[1]!.title = '甲书'
    rootless.selection = { root: null, source: 'none' }
    delete rootless.summary
    delete rootless.chapters
    const view = buildView(rootless)
    expect(view.projects[0]!.label).toContain('— /')
  })

  it('falls back to empty when a v6 payload has no projects and no summary', () => {
    const blank: PanelPayloadDto = payload()
    blank.projects = []
    blank.selection = { root: null, source: 'none' }
    delete blank.summary
    delete blank.chapters
    delete blank.resume
    const view = buildView(blank)
    expect(view.state).toBe('empty')
    expect(view.emptyCommand).toContain('novel_init')
  })

  it('disambiguates duplicate titles and labels missing/unreadable options', () => {
    const duplicate = twoProjects()
    duplicate.projects[1]!.title = '甲书'
    duplicate.projects[0]!.state = 'missing'
    duplicate.projects[1]!.state = 'unreadable'
    duplicate.selection = { root: null, source: 'none' }
    delete duplicate.summary
    delete duplicate.chapters
    const view = buildView(duplicate)
    expect(view.state).toBe('choose')
    expect(view.projects[0]!.label).toContain('— a')
    expect(view.projects[0]!.label).toContain('目录不存在')
    expect(view.projects[1]!.label).toContain('不可读')
    const html = renderToStaticMarkup(panelElement(view, false, () => undefined))
    expect(html).toContain('目录不存在')
    expect(html).toContain('不可读')
  })

  it('groups and disambiguates host-smoke projects and renders advisories separately', () => {
    const noisy = payload()
    noisy.projects = [
      { root: '/novels/a', title: '正常书', active: true, registered: true, state: 'ok' },
      ...Array.from({ length: 7 }, (_, index) => ({
        root: `/tmp/nwe-host-${index}/host-smoke-project`,
        title: 'Host Smoke',
        active: false,
        registered: true,
        state: 'missing' as const,
      })),
    ]
    noisy.selection = { root: '/novels/a', source: 'active' }
    noisy.summary!.root = '/novels/a'
    noisy.summary!.advisories = [
      { code: 'LOCKED_DETAIL_DRIFT', detail: 'expected "灰长衫", actual "鲜红铠甲"', hint: '第 1 段' },
    ]
    noisy.summary!.legacy = [{ code: 'LEGACY_EFFORT', detail: '1 章缺少 rounds/archived_at' }]
    const view = buildView(noisy)
    const hostLabels = view.projects.filter((project) => project.title === 'Host Smoke').map((p) => p.label)
    expect(new Set(hostLabels).size).toBe(7)
    expect(hostLabels[0]).toContain('nwe-host-0/host-smoke-project')
    expect(view.advisories[0]).toMatchObject({ code: 'LOCKED_DETAIL_DRIFT' })
    expect(view.legacy[0]).toMatchObject({ code: 'LEGACY_EFFORT' })
    const html = renderToStaticMarkup(panelElement(view, false, () => undefined))
    expect(html).toContain('提示')
    expect(html).toContain('旧数据')
    expect(html).toContain('expected &quot;灰长衫&quot;')
    expect(html).not.toContain('nwe-host-0/host-smoke-project')
  })

  it('renders acknowledged advice counts and the all-acknowledged state', () => {
    const noisy = payload()
    noisy.summary!.advisories = [
      { code: 'LOCKED_DETAIL_DRIFT', detail: 'expected "灰长衫", actual "鲜红铠甲"', hint: '第 1 段' },
    ]
    noisy.summary!.acknowledgedAdvisories = 0
    const open = renderToStaticMarkup(panelElement(buildView(noisy), false, () => undefined))
    expect(open).toContain('可 acknowledge')
    noisy.summary!.advisories = []
    noisy.summary!.acknowledgedAdvisories = 2
    const closed = renderToStaticMarkup(panelElement(buildView(noisy), false, () => undefined))
    expect(closed).toContain('已确认 2 条')
    expect(closed).toContain('本轮提示已全部确认')
  })

  it('uses the shortest unique path suffix when duplicate titles share their last two segments', () => {
    const noisy = payload()
    noisy.projects = [
      { root: '/mnt/d/books/novel', title: '同名书', active: true, registered: true, state: 'ok' },
      { root: '/home/me/books/novel', title: '同名书', active: false, registered: true, state: 'ok' },
    ]
    noisy.selection = { root: '/mnt/d/books/novel', source: 'active' }
    noisy.summary!.root = '/mnt/d/books/novel'
    const labels = buildView(noisy).projects.map((project) => project.label)
    expect(new Set(labels).size).toBe(2)
    expect(labels[0]).toContain('d/books/novel')
    expect(labels[1]).toContain('me/books/novel')
  })

  it('reveals hidden missing projects and filters by search', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const noisy = payload()
    noisy.projects = [
      { root: '/novels/a', title: '正常书', active: true, registered: true, state: 'ok' },
      ...Array.from({ length: 7 }, (_, index) => ({
        root: `/tmp/nwe-host-${index}/host-smoke-project`,
        title: 'Host Smoke',
        active: false,
        registered: true,
        state: 'missing' as const,
      })),
    ]
    noisy.selection = { root: '/novels/a', source: 'active' }
    noisy.summary!.root = '/novels/a'
    const view = buildView(noisy)
    try {
      await act(async () => {
        root.render(panelElement(view, false, () => undefined))
      })
      const select = (): HTMLSelectElement =>
        container.querySelector<HTMLSelectElement>('select[aria-label="切换项目"]')!
      expect(Array.from(select().options)).toHaveLength(2)
      const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
      await act(async () => {
        toggle.click()
      })
      expect(Array.from(select().options)).toHaveLength(9)
      const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索项目"]')!
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      await act(async () => {
        setValue.call(search, '正常')
        search.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(Array.from(select().options)).toHaveLength(2)
      expect(Array.from(select().options)[1]!.text).toContain('正常书')

      // The search box unmounts when the project list shrinks. A retained query
      // must not silently keep filtering the select.
      await act(async () => {
        setValue.call(search, '不存在')
        search.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const smaller = payload()
      smaller.projects = [
        { root: '/novels/a', title: '正常书', active: false, registered: true, state: 'ok' },
      ]
      smaller.selection = { root: null, source: 'none' }
      smaller.summary!.root = '/novels/a'
      await act(async () => {
        root.render(panelElement(buildView(smaller), false, () => undefined))
      })
      expect(container.querySelector('input[aria-label="搜索项目"]')).toBeNull()
      expect(Array.from(select().options)).toHaveLength(2)
      expect(Array.from(select().options).some((option) => option.text.includes('正常书'))).toBe(true)
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('keeps a damaged project readable but shows the repair notice', () => {
    const damaged = twoProjects()
    damaged.projects[0]!.state = 'damaged'
    const view = buildView(damaged)
    expect(view.state).toBe('ready')
    expect(view.damaged).toBe(true)
    const html = renderToStaticMarkup(panelElement(view, false, () => undefined))
    expect(html).toContain('项目定义不可读')
    expect(html).toContain('novel_amend')
  })

  it('renders every volume and highlights the current one without a hidden remainder', () => {
    const many = payload()
    many.summary!.volume = 9
    many.summary!.book!.outline.volumes = Array.from({ length: 9 }, (_, index) => ({
      title: `第${index + 1}卷`,
      start: index * 10 + 1,
      end: (index + 1) * 10,
      planned: 10,
      archived: index,
    }))
    const view = buildView(many)
    expect(view.book.volumes).toHaveLength(9)
    expect(view.volumeNumber).toBe(9)
    const html = renderToStaticMarkup(panelElement(view, false, () => undefined))
    expect(html).toContain('第9卷')
    expect(html).toContain('nwe-volume is-current')
    expect(html).not.toContain('还有 1 卷')
    expect(html).toContain('aria-label="卷列表"')
  })

  it('copies the resume text and falls back to selectable text when the clipboard fails', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    const container = document.createElement('div')
    document.body.append(container)
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload(),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(NovelPanel))
      })
      const copy = container.querySelector<HTMLButtonElement>('button[aria-label="复制当前项目的续写指令"]')
      expect(copy).not.toBeNull()
      await act(async () => {
        copy!.click()
        await Promise.resolve()
      })
      expect(writeText).toHaveBeenCalledWith(payload().resume!.text)
      expect(container.textContent).toContain('已复制')
      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      expect(container.textContent).not.toContain('已复制')
      expect(fetchMock).toHaveBeenCalledTimes(1)

      writeText.mockRejectedValueOnce(new Error('denied'))
      await act(async () => {
        copy!.click()
        await Promise.resolve()
      })
      expect(container.querySelector('.nwe-resume-fallback')?.textContent).toContain('项目根')
    } finally {
      await act(async () => {
        root.unmount()
      })
      vi.useRealTimers()
      vi.unstubAllGlobals()
      delete (navigator as { clipboard?: unknown }).clipboard
      container.remove()
    }
  })

  it('switches through the selector, requests the chosen root and stores it locally', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.removeItem('nwe.panel-root.v1')
    const container = document.createElement('div')
    document.body.append(container)
    const calls: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url)
      return {
        ok: true,
        status: 200,
        json: async () => (url.includes('root=%2Fnovels%2Fb') ? bPayload() : twoProjects()),
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(NovelPanel))
      })
      expect(container.textContent).toContain('甲书')
      const select = container.querySelector<HTMLSelectElement>('select[aria-label="切换项目"]')!
      await act(async () => {
        select.value = '/novels/b'
        select.dispatchEvent(new Event('change', { bubbles: true }))
        await Promise.resolve()
      })
      expect(container.textContent).toContain('乙书')
      expect(calls.some((url) => url.includes('root=%2Fnovels%2Fb'))).toBe(true)
      expect(localStorage.getItem('nwe.panel-root.v1')).toBe('/novels/b')
    } finally {
      await act(async () => {
        root.unmount()
      })
      vi.unstubAllGlobals()
      localStorage.removeItem('nwe.panel-root.v1')
      container.remove()
    }
  })

  it('clears an unregistered localStorage preference and retries without a query root', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.setItem('nwe.panel-root.v1', '/novels/removed')
    const container = document.createElement('div')
    document.body.append(container)
    const stale = twoProjects()
    stale.selection = { root: '/novels/removed', source: 'query' }
    delete stale.summary
    delete stale.chapters
    stale.missing = {
      root: '/novels/removed',
      title: '已移除',
      code: 'ENGINE_PROJECT_NOT_FOUND',
      reason: 'not_registered',
      hint: 'register or scan',
    }
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      return { ok: true, status: 200, json: async () => (call === 1 ? stale : twoProjects()) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(NovelPanel))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(container.querySelector('.nwe-title')?.textContent).toBe('《甲书》')
      expect(localStorage.getItem('nwe.panel-root.v1')).toBeNull()
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally {
      await act(async () => {
        root.unmount()
      })
      vi.unstubAllGlobals()
      localStorage.removeItem('nwe.panel-root.v1')
      container.remove()
    }
  })

  it('shows a switching skeleton and hides the old book until the new payload arrives', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.removeItem('nwe.panel-root.v1')
    const container = document.createElement('div')
    document.body.append(container)
    let resolveB: (value: {
      ok: boolean
      status: number
      json: () => Promise<PanelPayloadDto>
    }) => void = () => undefined
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('root=%2Fnovels%2Fb')) {
        return new Promise((resolve) => {
          resolveB = resolve
        })
      }
      return { ok: true, status: 200, json: async () => twoProjects() }
    })
    vi.stubGlobal('fetch', fetchMock)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(NovelPanel))
      })
      const select = container.querySelector<HTMLSelectElement>('select[aria-label="切换项目"]')!
      await act(async () => {
        select.value = '/novels/b'
        select.dispatchEvent(new Event('change', { bubbles: true }))
        await Promise.resolve()
      })
      expect(container.querySelector('.nwe-title')?.textContent).toBe('切换项目…')
      expect(container.querySelector('.nwe-skeleton')).not.toBeNull()
      expect(container.querySelector('.nwe-next')).toBeNull()
      expect(container.querySelector('button[aria-label="复制当前项目的续写指令"]')).toBeNull()
      expect(container.querySelector<HTMLSelectElement>('select[aria-label="切换项目"]')?.value).toBe(
        '/novels/b',
      )
      await act(async () => {
        resolveB({ ok: true, status: 200, json: async () => bPayload() })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(container.querySelector('.nwe-title')?.textContent).toBe('《乙书》')
      expect(container.querySelector('.nwe-skeleton')).toBeNull()
    } finally {
      await act(async () => {
        root.unmount()
      })
      vi.unstubAllGlobals()
      localStorage.removeItem('nwe.panel-root.v1')
      container.remove()
    }
  })

  it('discards a stale response after the user switches again', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.removeItem('nwe.panel-root.v1')
    const container = document.createElement('div')
    document.body.append(container)
    let resolveB: (value: {
      ok: boolean
      status: number
      json: () => Promise<PanelPayloadDto>
    }) => void = () => undefined
    let call = 0
    const fetchMock = vi.fn(async (url: string) => {
      call += 1
      if (call === 1) return { ok: true, status: 200, json: async () => twoProjects() }
      if (url.includes('root=%2Fnovels%2Fb')) {
        return new Promise((resolve) => {
          resolveB = resolve
        })
      }
      return { ok: true, status: 200, json: async () => twoProjects() }
    })
    vi.stubGlobal('fetch', fetchMock)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(NovelPanel))
      })
      const select = container.querySelector<HTMLSelectElement>('select[aria-label="切换项目"]')!
      await act(async () => {
        select.value = '/novels/b'
        select.dispatchEvent(new Event('change', { bubbles: true }))
        await Promise.resolve()
      })
      await act(async () => {
        select.value = '/novels/a'
        select.dispatchEvent(new Event('change', { bubbles: true }))
        await Promise.resolve()
      })
      expect(container.textContent).toContain('甲书')
      await act(async () => {
        resolveB({ ok: true, status: 200, json: async () => bPayload() })
        await Promise.resolve()
      })
      expect(container.querySelector('.nwe-title')?.textContent).toBe('《甲书》')
      expect(container.querySelector('.nwe-title')?.textContent).not.toBe('《乙书》')
    } finally {
      await act(async () => {
        root.unmount()
      })
      vi.unstubAllGlobals()
      localStorage.removeItem('nwe.panel-root.v1')
      container.remove()
    }
  })
})

describe('client registration and rendering', () => {
  it('registers main and sidebar entries with the same id', () => {
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const ctx = {
      slots: {
        inject: (_name: string, body: () => unknown) => body(),
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
          return { dispose: () => undefined }
        },
      },
    }
    applyClient(ctx as never)
    expect(registrations).toHaveLength(2)
    const main = registrations.find((entry) => entry.options.name === 'main')!
    const sidebar = registrations.find((entry) => entry.options.name === 'sidebar.panellist')!
    expect(main.options.key).toBe('novel-workshop')
    expect(sidebar.options.id).toBe('novel-workshop')
    expect((sidebar.options.label as () => string)()).toBe('网文工坊')
  })

  it('mounts, fetches, refreshes and cleans up without a host adapter', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload(),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(NovelPanel))
      })
      expect(container.textContent).toContain('测试之书')
      expect(container.textContent).toContain('待处理 1 项')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const button = container.querySelector('button[aria-label="刷新项目状态"]')
      expect(button).not.toBeNull()
      await act(async () => {
        button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
    } finally {
      await act(async () => {
        root.unmount()
      })
      vi.unstubAllGlobals()
      container.remove()
    }
  })

  it('refreshes the active section when the bundle is refreshed', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const sectionPayload = {
      ...payload(),
      payload_version: 7,
      section: 'characters',
      items: [{ name: '角色甲', role: 'protagonist' }],
      total: 1,
      returned: 1,
      truncated: false,
      etag: 'W/"characters"',
    }
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (
        String(input).includes('section=characters') &&
        init?.headers &&
        new Headers(init.headers).get('if-none-match')
      ) {
        return { ok: false, status: 304, json: async () => ({}) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => (String(input).includes('section=characters') ? sectionPayload : payload()),
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    const sectionCalls = (): number =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes('section=characters')).length
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(NovelPanel))
      })
      const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
        (button) => button.textContent === '人物',
      )!
      await act(async () => {
        tab.click()
        await Promise.resolve()
      })
      expect(sectionCalls()).toBe(1)
      const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="刷新项目状态"]')!
      await act(async () => {
        refresh.click()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(sectionCalls()).toBe(2)
      const sectionHeaders = fetchMock.mock.calls
        .filter(([url]) => String(url).includes('section=characters'))
        .map(([, init]) => init?.headers)
      expect(sectionHeaders[1]).toMatchObject({ 'if-none-match': 'W/"characters"' })
      expect(container.textContent).toContain('角色甲')
    } finally {
      await act(async () => {
        root.unmount()
      })
      vi.unstubAllGlobals()
      container.remove()
    }
  })

  it('handles a search change with the default section handler', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const base = payload()
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(
          panelElement(
            buildView(base),
            false,
            () => undefined,
            () => undefined,
            'characters',
            () => undefined,
            {
              loading: false,
              error: null,
              payload: {
                ...base,
                payload_version: 7,
                section: 'characters',
                items: [{ name: '角色甲', role: 'protagonist', first_appearance: 1 }],
              },
            },
            { search: '', status: 'all', scene: '', sort: 'num_desc', cursor: '' },
            () => undefined,
            '',
          ),
        )
      })
      const input = container.querySelector<HTMLInputElement>('input')!
      await act(async () => {
        input.value = '甲'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(container.textContent).toContain('角色甲')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('renders loading and error states inside a chapter detail', () => {
    const base = payload()
    const withDetail = (state: { loading: boolean; error: string | null }): string =>
      renderToStaticMarkup(
        panelElement(
          buildView(base),
          false,
          () => undefined,
          () => undefined,
          'chapters',
          () => undefined,
          {
            loading: false,
            error: null,
            payload: {
              ...base,
              payload_version: 7,
              section: 'chapters',
              total: 1,
              returned: 1,
              truncated: false,
              next_cursor: null,
              items: [{ num: 1, title: '开端之雨', status: 'archived', word_count: 20 }],
            },
          },
          { search: '', status: 'all', scene: '', sort: 'num_desc', cursor: '' },
          () => undefined,
          '',
          () => undefined,
          { chapter: 1, section: { ...state, payload: null } },
        ),
      )
    expect(withDetail({ loading: true, error: null })).toContain('正在读取章节详情')
    expect(withDetail({ loading: false, error: '读取失败' })).toContain('章节详情读取失败')
  })

  it('opens the lazy chapter detail from the chapter table', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const base = payload()
    const fetchMock = vi.fn(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => {
        const url = String(input)
        if (url.includes('section=chapters')) {
          return {
            ...base,
            payload_version: 7,
            section: 'chapters',
            total: 1,
            returned: 1,
            truncated: false,
            next_cursor: null,
            items: [{ num: 1, title: '开端之雨', status: 'archived', word_count: 20 }],
          }
        }
        if (url.includes('section=chapter_detail')) {
          return {
            ...base,
            payload_version: 7,
            section: 'chapter_detail',
            items: { chapter: 1, manuscript: '雨夜的正文。' },
          }
        }
        return base
      },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(NovelPanel))
      })
      const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
        (button) => button.textContent === '章节',
      )!
      await act(async () => {
        tab.click()
        await Promise.resolve()
      })
      const detailButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === '详情',
      )!
      await act(async () => {
        detailButton.click()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(container.textContent).toContain('第 1 章详情')
      expect(container.textContent).toContain('雨夜的正文。')
      const close = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === '收起',
      )!
      await act(async () => {
        close.click()
      })
      expect(container.textContent).not.toContain('第 1 章详情')
    } finally {
      await act(async () => {
        root.unmount()
      })
      vi.unstubAllGlobals()
      container.remove()
    }
  })

  it('does not let a silent focus refresh abort a visible loading request', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.removeItem('nwe.panel-root.v1')
    const container = document.createElement('div')
    document.body.append(container)
    let resolveRefresh: (value: {
      ok: boolean
      status: number
      json: () => Promise<PanelPayloadDto>
    }) => void = () => undefined
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      if (call === 1) return { ok: true, status: 200, json: async () => payload() }
      return new Promise((resolve) => {
        resolveRefresh = resolve
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(NovelPanel))
      })
      const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="刷新项目状态"]')!
      await act(async () => {
        refresh.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })
      expect(refresh.disabled).toBe(true)
      const callsWhileLoading = fetchMock.mock.calls.length
      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        await Promise.resolve()
      })
      expect(fetchMock.mock.calls.length).toBe(callsWhileLoading)
      await act(async () => {
        resolveRefresh({ ok: true, status: 200, json: async () => payload() })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(refresh.disabled).toBe(false)
    } finally {
      await act(async () => {
        root.unmount()
      })
      vi.unstubAllGlobals()
      localStorage.removeItem('nwe.panel-root.v1')
      container.remove()
    }
  })

  it('refreshes silently on the 15s interval, focus and visible tab', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    const container = document.createElement('div')
    document.body.append(container)
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload() }))
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(NovelPanel))
        await Promise.resolve()
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await act(async () => {
        vi.advanceTimersByTime(15_000)
        await Promise.resolve()
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('测试之书')
      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        await Promise.resolve()
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => payload() })
      await act(async () => {
        vi.advanceTimersByTime(15_000)
        await Promise.resolve()
      })
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(container.textContent).toContain('测试之书')
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
        await Promise.resolve()
      })
      expect(fetchMock).toHaveBeenCalledTimes(3)
    } finally {
      await act(async () => {
        root.unmount()
      })
      vi.useRealTimers()
      vi.unstubAllGlobals()
      container.remove()
    }
  })

  it('keeps the previous view when the bundle answers 304', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    const container = document.createElement('div')
    document.body.append(container)
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.headers && new Headers(init.headers).get('if-none-match') === 'bundle-1') {
        return { ok: false, status: 304, json: async () => ({}) }
      }
      return { ok: true, status: 200, json: async () => ({ ...payload(), etag: 'bundle-1' }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(NovelPanel))
        await Promise.resolve()
      })
      expect(container.textContent).toContain('测试之书')
      await act(async () => {
        vi.advanceTimersByTime(15_000)
        await Promise.resolve()
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('测试之书')
    } finally {
      await act(async () => {
        root.unmount()
      })
      vi.useRealTimers()
      vi.unstubAllGlobals()
      container.remove()
    }
  })

  it('renders overview trend and word charts with accessible summaries', () => {
    const base = payload()
    const markup = renderToStaticMarkup(panelElement(buildView(base), false, () => undefined))
    expect(markup).toContain('评分趋势')
    expect(markup).toContain('章节字数')
    expect(markup).toContain('aria-label="章节评分趋势"')
    expect(markup).toContain('aria-label="章节字数分布"')
    expect(markup).toContain('nwe-trend-chart')
    expect(markup).toContain('nwe-word-chart')
    expect(markup).toContain('最近')
  })

  it('renders empty and single-point chart states', () => {
    const empty = payload()
    empty.summary.quality = { averageScore: 0, scores: [], trend: null }
    empty.chapters.rows = []
    const emptyMarkup = renderToStaticMarkup(panelElement(buildView(empty), false, () => undefined))
    expect(emptyMarkup).toContain('还没有评审')
    expect(emptyMarkup).toContain('还没有章节')

    const single = payload()
    single.summary.quality = { averageScore: 145, scores: [145], trend: 0 }
    const singleMarkup = renderToStaticMarkup(panelElement(buildView(single), false, () => undefined))
    expect(singleMarkup).toContain('最近 1 章')
    expect(singleMarkup).toContain('aria-label="最近 1 章评分趋势')
  })

  it('renders the loading panel and the icon without a DOM', () => {
    expect(typeof NovelPanel).toBe('function')
    const loading = buildView(null)
    const markup = renderToStaticMarkup(panelElement(loading, true, () => undefined))
    expect(markup).toContain('网文工坊')
    expect(markup).toContain('刷新中…')
    expect(markup).toContain('data-plugin="dsh-novel-write-engine"')

    const ready = renderToStaticMarkup(panelElement(buildView(payload()), false, () => undefined))
    expect(ready).toContain('《测试之书》')
    expect(ready).toContain('开端之雨')
    expect(ready).toContain('待处理 1 项')
    expect(ready).toContain('规划 75%')
    expect(ready).toContain('缺卡 1')
    expect(ready).toContain('nwe-root')
    expect(ready).toContain('网文工坊 · NOVEL WORKBENCH')
    expect(ready).toContain('nwe-brand-mark')
    expect(ready).toContain('全书概览')
    expect(ready).toContain('全书资料')
    expect(ready).toContain('overflow-y: auto')
    expect(ready).toContain('height: 100%')
    expect(ready).toContain('overscroll-behavior: contain')
    expect(ready).toContain('全书均分')
    expect(ready).toContain('近十均分')
    expect(ready).toContain('当前阶段 · 下一步')
    expect(ready).toContain('role="progressbar"')
    expect(ready).toContain('aria-label="开端之雨 评分"')
    expect(ready).toContain('@media (max-width: 760px)')
    expect(ready).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))')
    expect(ready).toContain('少了 200 字')
    const empty = renderToStaticMarkup(
      panelElement(buildView({ ...payload(), empty: true }), false, () => undefined),
    )
    expect(empty).toContain('novel_init')
    expect(empty).toContain('还没有开局')

    const failed = renderToStaticMarkup(panelElement(buildView(null, 'host offline'), false, () => undefined))
    expect(failed).toContain('host offline')
    expect(failed).toContain('role="alert"')

    const completed = payload()
    completed.summary.finished = true
    completed.summary.phases = completed.summary.phases.map((phase) => ({
      ...phase,
      done: true,
      active: false,
    }))
    completed.summary.blocking = []
    completed.summary.stage = 'done'
    completed.summary.finished = true
    const completedMarkup = renderToStaticMarkup(panelElement(buildView(completed), false, () => undefined))
    expect(completedMarkup).not.toContain('nwe-phase is-active')
    expect(completedMarkup).toContain('门控已通过')
    expect(completedMarkup).toContain('nwe-stage is-done')
    expect(completedMarkup).toContain('全书完成')

    const icon = renderToStaticMarkup(NovelIcon({ size: 20 }))
    expect(icon).toContain('<svg')
    expect(icon).toContain('width="20"')
    expect(renderToStaticMarkup(NovelIcon({}))).toContain('width="18"')
  })

  it('does not define a custom property in terms of itself', () => {
    const markup = renderToStaticMarkup(panelElement(buildView(payload()), false, () => undefined))
    const css = /<style>([\s\S]*)<\/style>/.exec(markup)?.[1] ?? ''
    const declarations = [...css.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)]
    expect(declarations.length).toBeGreaterThan(0)
    for (const [, name, value] of declarations) {
      expect(value).not.toContain(`var(--${name})`)
    }
    expect(css).not.toContain('#b08a1e')
    expect(css).not.toContain('#c9a227')
  })

  it('owns one page scroller inside the fixed host while card lists scroll locally', () => {
    const markup = renderToStaticMarkup(panelElement(buildView(payload()), false, () => undefined))
    const css = /<style>([\s\S]*)<\/style>/.exec(markup)?.[1] ?? ''
    const plain = css.replaceAll('&gt;', '>')
    expect(markup).toMatch(/class="nwe-root"[^>]*aria-label="网文工坊页面"/)
    expect(markup).toMatch(/class="nwe-root"[^>]*tabindex="0"/)
    expect(markup).toContain('class="nwe-workbench"')
    expect(markup).toContain('aria-label="网文工坊内容"')
    expect(markup).not.toMatch(/class="nwe-workbench"[^>]*tabindex=/)
    const workbench = /\.nwe-workbench\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(workbench).toContain('overflow: visible')
    expect(workbench).not.toContain('overflow-y: auto')
    const rootBlocks = [...css.matchAll(/\.nwe-root\s*\{([^}]*)\}/g)].map((match) => match[1] ?? '')
    const page = rootBlocks.at(-1) ?? ''
    expect(page).toContain('display: block')
    expect(page).toContain('height: 100%')
    expect(page).toContain('overflow-y: auto')
    expect(page).toContain('scrollbar-width: none')
    expect(css).toContain('.nwe-root::-webkit-scrollbar { width: 0; height: 0; display: none; }')
    expect(css).not.toMatch(/\.nwe-hero[^}]*position:\s*sticky/s)
    expect(css).toMatch(/\.nwe-card-grid\s*\{[^}]*max-height:[^}]*overflow-y: auto;/s)
    expect(css).toMatch(/#nwe-panel-characters \.nwe-card-grid\s*\{[^}]*max-height:/s)
    expect(plain).toMatch(/\.nwe-leads-layout > \.nwe-subsection \.nwe-card-grid\s*\{[^}]*max-height:/s)
    expect(plain).toContain('.nwe-worldbook-layout > .nwe-subsection:has(.nwe-data-card[open])')
    expect(plain).toContain('.nwe-leads-layout > .nwe-subsection:has(.nwe-data-card[open])')
    expect(css).toMatch(/\.nwe-table-wrap\s*\{[^}]*max-height: min\(58vh, 560px\);[^}]*overflow: auto;/s)
    expect(css).toMatch(/\.nwe-info-card-body\s*\{[^}]*max-height:/s)
    expect(css).toMatch(/\.nwe-fold-body\s*\{[^}]*max-height:/s)
    expect(css).toMatch(/\.nwe-dossier-body\s*\{[^}]*max-height:/s)
    expect(css).toMatch(/\.nwe-data-card-body\s*\{[^}]*max-height:/s)
    expect(css).toContain('.nwe-root details')
    expect(css).toContain('::-webkit-details-marker')
    expect(css).toContain('::-webkit-scrollbar-thumb')
    expect(css).toContain('.nwe-info-card')
    expect(css).toContain('.nwe-fold')
  })

  it('keeps the dossier summary a three-track grid in every open state', () => {
    const markup = renderToStaticMarkup(panelElement(buildView(payload()), false, () => undefined))
    const css = /<style>([\s\S]*)<\/style>/.exec(markup)?.[1] ?? ''
    const plain = css.replaceAll('&gt;', '>')
    expect(plain).toMatch(
      /\.nwe-dossier > summary\s*\{[^}]*display: grid;[^}]*grid-template-columns: 30px minmax\(0, 1fr\) 14px;/s,
    )
    expect(plain).toContain('.nwe-dossier > summary::before { content: none; }')
    // A generated marker would become a fourth grid item and push the copy
    // into the 14px caret track on the far right.
    expect(plain).not.toMatch(/\.nwe-dossier(?:\[open\])? > summary::before\s*\{[^}]*content:\s*["']?[+−]/)
  })

  it('gives every disclosure a scoped class and custom summary treatment', () => {
    const markup = withoutCss(
      renderToStaticMarkup(panelElement(buildView(payload()), false, () => undefined)),
    )
    const tags = [...markup.matchAll(/<details\b([^>]*)>/g)].map((match) => match[1] ?? '')
    expect(tags.length).toBeGreaterThan(0)
    for (const attrs of tags) expect(attrs).toMatch(/class="nwe-/)
    expect(markup).toContain('nwe-dossier-body')
  })

  it('renders book data with the unified info-card and dossier surfaces', () => {
    const base = payload()
    base.summary.bookData = panelBookData()
    const markup = withoutCss(renderToStaticMarkup(panelElement(buildView(base), false, () => undefined)))
    expect(markup.match(/nwe-info-card-head/g)).toHaveLength(8)
    expect(markup).toContain('nwe-info-card-body')
    expect(markup).toContain('nwe-info-card-icon')
    expect(markup).toContain('nwe-dossier-body')
    expect(markup).toContain('nwe-fold-head')
    expect(markup).toContain('逐章 effort')
    expect(markup).not.toContain('nwe-v6-card')
  })

  it('renders readable cards, dimension bars and localized enums', () => {
    const base = payload()
    base.chapters.rows[0]!.finalCheck = 'pass'
    const section = (tab: Parameters<typeof panelElement>[4], items: unknown): string =>
      renderToStaticMarkup(
        panelElement(
          buildView(base),
          false,
          () => undefined,
          () => undefined,
          tab,
          () => undefined,
          {
            loading: false,
            error: null,
            payload: { ...base, payload_version: 7, section: tab, items },
          },
        ),
      )
    const characters = section('characters', [
      { name: '角色甲', role: 'protagonist', first_appearance: 1, last: 3, appearances: 2 },
      { name: '角色乙', role: 'antagonist', first_appearance: 2, last: 4, appearances: 1 },
    ])
    expect(characters).toContain('角色甲')
    expect(characters).toContain('搜索人物')
    expect(characters).toContain('主角')
    expect(characters).toContain('反派')
    expect(characters).not.toContain('antagonist')
    expect(characters).toContain('aria-label="人物列表，可滚动"')
    expect(characters).toMatch(/class="nwe-card-grid"[^>]*tabindex="0"/)
    expect(characters).not.toContain('&quot;role&quot;')
    const quality = section('quality', {
      quality: { average: 12, median: 12, min: 10, max: 20, samples: 2 },
      dimensions: [
        { id: 'R-W-10', average: 0.5, samples: 2, max: 1 },
        { id: 'R-W-04', average: 12, samples: 2, max: 20 },
      ],
    })
    expect(quality).toContain('aria-valuemax="20"')
    expect(quality).toContain('12 / 20')
    expect(quality).toContain('0.5 / 1')
    const worldbook = section('worldbook', {
      premise: '旧城的前提',
      setting: '旧城的设定',
      locations: [{ name: '旧城', description: '城墙很高' }],
      glossary: [{ term: '旧印', definition: '城门上的印记' }],
      backstory: [{ event: '十年前', description: '城门第一次关闭' }],
      rules: [],
      ledger: { locations: [{ name: '旧城' }] },
      outline_cards: [{ num: 1, title: '章一', status: 'planned', scene_type: '日常过渡章', goal: '目标' }],
    })
    expect(worldbook).toContain('地点（1）')
    expect(worldbook).toContain('搜索设定')
    expect(worldbook).toContain('旧城')
    expect(worldbook).toContain('旧印')
    expect(worldbook).toContain('十年前')
    expect(worldbook).toContain('旧城的前提')
    expect(worldbook).toContain('计划')
    expect(worldbook).toContain('场景')
    expect(worldbook).not.toContain('scene_type')
    const health = section('health', {
      outline: { present: false, file_existed: true, error: '坏' },
      worldbook: { present: true, error: null },
      state_errors: [{ path: 'state/chapters.yaml', code: 'E', message: '坏了' }],
      drift: [{ chapter: 1, field: 'title', planned: '甲', actual: '乙' }],
      pending: null,
    })
    expect(health).toContain('大纲：损坏')
    expect(health).toContain('状态错误（1）')
    const leads = section('foreshadows', {
      foreshadows: [
        { id: 'FS-001', title: '旧信封', status: 'planted' },
        { id: 'FS-002', title: '旧钥匙', status: 'dormant' },
      ],
      timeline: [{ chapter: 1, description: '收到信', location: '旧城' }],
      relationships: [{ a: '甲', b: '乙', type: '盟友' }],
    })
    expect(leads).toContain('伏笔（2）')
    expect(leads).toContain('休眠')
    expect(leads).not.toContain('dormant')
    expect(leads).toContain('时间线（1）')
    expect(leads).toContain('aria-label="时间线列表，可滚动"')
    expect(leads).toContain('关系（1）')
    const overview = renderToStaticMarkup(panelElement(buildView(base), false, () => undefined))
    expect(overview).toContain('终检 通过')
    expect(overview).not.toContain('终检 pass')
  })

  it('owns the pending transaction once and localizes its state', () => {
    const base = payload()
    ;(base.summary as unknown as { pending: unknown }).pending = {
      state: 'partial',
      txid: 'TX-001',
      detail: '请检查备份',
    }
    const markup = renderToStaticMarkup(
      panelElement(
        buildView(base),
        false,
        () => undefined,
        () => undefined,
        'health',
      ),
    )
    expect(markup.match(/事务部分完成/g)).toHaveLength(1)
    expect(markup).toContain('部分完成')
    expect(markup).not.toContain('>partial<')
  })

  it('renders a filterable chapter table with pagination metadata', () => {
    const base = payload()
    const markup = renderToStaticMarkup(
      panelElement(
        buildView(base),
        false,
        () => undefined,
        () => undefined,
        'chapters',
        () => undefined,
        {
          loading: false,
          error: null,
          payload: {
            ...base,
            payload_version: 7,
            section: 'chapters',
            total: 2,
            returned: 1,
            truncated: true,
            next_cursor: '1',
            items: [
              {
                num: 1,
                title: '开端之雨',
                status: 'archived',
                word_count: 2000,
                score: 145,
                scene_type: '日常过渡章',
                final_check: 'pass',
                archived_at: '2026-10-31T00:00:00.000Z',
              },
            ],
          },
        },
        { search: '开端', status: 'archived', scene: '', sort: 'num_desc', cursor: '' },
        () => undefined,
      ),
    )
    expect(markup).toContain('搜索标题')
    expect(markup).toContain('<table')
    expect(markup).toContain('第 1 章')
    expect(markup).toContain('显示 1 / 共 2')
    expect(markup).toContain('通过')
    expect(markup).toContain('下一页')
  })

  it('renders sparse chapter rows and omitted section totals', () => {
    const base = payload()
    const markup = renderToStaticMarkup(
      panelElement(
        buildView(base),
        false,
        () => undefined,
        () => undefined,
        'chapters',
        () => undefined,
        {
          loading: false,
          error: null,
          payload: {
            ...base,
            payload_version: 7,
            section: 'chapters',
            items: [{ num: 'x', status: 'draft', title: '草稿章', final_check: 'unknown' }],
          },
        },
      ),
    )
    expect(markup).toContain('草稿章')
    expect(markup).toContain('草稿')
    expect(markup).toContain('已显示全部')
    expect(markup).not.toContain('共 undefined')
  })

  it('falls back to the row position when a chapter number is unreadable', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const base = payload()
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(
          panelElement(
            buildView(base),
            false,
            () => undefined,
            () => undefined,
            'chapters',
            () => undefined,
            {
              loading: false,
              error: null,
              payload: {
                ...base,
                payload_version: 7,
                section: 'chapters',
                total: 1,
                returned: 1,
                truncated: false,
                next_cursor: null,
                items: [{ num: 'x', title: '无编号', status: 'archived', word_count: 20 }],
              },
            },
            { search: '', status: 'all', scene: '', sort: 'num_desc', cursor: '' },
            () => undefined,
          ),
        )
      })
      const detail = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === '详情',
      )!
      await act(async () => {
        detail.click()
      })
      expect(container.textContent).toContain('无编号')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('labels a clipped-only chapter payload as text truncation', () => {
    const base = payload()
    const markup = renderToStaticMarkup(
      panelElement(
        buildView(base),
        false,
        () => undefined,
        () => undefined,
        'chapters',
        () => undefined,
        {
          loading: false,
          error: null,
          payload: {
            ...base,
            payload_version: 7,
            section: 'chapters',
            total: 1,
            returned: 1,
            truncated: true,
            next_cursor: null,
            items: [{ num: 1, title: '开端之雨', status: 'archived', word_count: 20 }],
          },
        },
      ),
    )
    expect(markup).toContain('部分文本已截断')
    expect(markup).not.toContain('可继续翻页')
  })

  it('opens a lazy chapter detail manuscript', () => {
    const base = payload()
    const markup = renderToStaticMarkup(
      panelElement(
        buildView(base),
        false,
        () => undefined,
        () => undefined,
        'chapters',
        () => undefined,
        {
          loading: false,
          error: null,
          payload: {
            ...base,
            payload_version: 7,
            section: 'chapters',
            total: 1,
            returned: 1,
            truncated: false,
            next_cursor: null,
            items: [{ num: 1, title: '开端之雨', status: 'archived', word_count: 20 }],
          },
        },
        { search: '', status: 'all', scene: '', sort: 'num_desc', cursor: '' },
        () => undefined,
        '',
        () => undefined,
        {
          chapter: 1,
          section: {
            loading: false,
            error: null,
            payload: {
              ...base,
              payload_version: 7,
              section: 'chapter_detail',
              items: {
                chapter: 1,
                row: { summary_events: ['摘要事件'] },
                manuscript: '雨夜的正文。',
                plan: '归档 plan',
                world_plan: '世界计划内容',
              },
            },
          },
        },
      ),
    )
    expect(markup).toContain('第 1 章详情')
    expect(markup).toContain('雨夜的正文。')
    expect(markup).toContain('归档 plan')
    expect(markup).toContain('世界计划内容')
    expect(markup).toContain('摘要事件')
    expect(markup).toContain('nwe-fold-head')
    expect(markup).toContain('nwe-fold-body')
    expect(markup).toContain('nwe-detail-fold')
    expect(markup).toContain('aria-label="正文 内容"')
  })

  it('closes the lazy chapter detail from its close button', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const base = payload()
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(
          panelElement(
            buildView(base),
            false,
            () => undefined,
            () => undefined,
            'chapters',
            () => undefined,
            {
              loading: false,
              error: null,
              payload: {
                ...base,
                payload_version: 7,
                section: 'chapters',
                total: 1,
                returned: 1,
                truncated: false,
                next_cursor: null,
                items: [{ num: 1, title: '开端之雨', status: 'archived', word_count: 20 }],
              },
            },
            { search: '', status: 'all', scene: '', sort: 'num_desc', cursor: '' },
            () => undefined,
            '',
            () => undefined,
            {
              chapter: 1,
              section: {
                loading: false,
                error: null,
                payload: {
                  ...base,
                  payload_version: 7,
                  section: 'chapter_detail',
                  items: { chapter: 1, manuscript: '雨夜的正文。', plan: '归档 plan' },
                },
              },
            },
          ),
        )
      })
      const close = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === '收起',
      )!
      await act(async () => {
        close.click()
      })
      expect(container.textContent).toContain('第 1 章详情')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('drives chapter filters and pagination controls', async () => {
    const base = payload()
    const onQuery = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(
          panelElement(
            buildView(base),
            false,
            () => undefined,
            () => undefined,
            'chapters',
            () => undefined,
            {
              loading: false,
              error: null,
              payload: {
                ...base,
                payload_version: 7,
                section: 'chapters',
                total: 2,
                returned: 1,
                truncated: true,
                next_cursor: '1',
                items: [{ num: 1, title: '开端之雨', status: 'archived', word_count: 20 }],
              },
            },
            { search: '', status: 'all', scene: '', sort: 'num_desc', cursor: '' },
            onQuery,
          ),
        )
      })
      const input = container.querySelector('input[type="search"]') as HTMLInputElement
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      await act(async () => {
        setValue.call(input, '旧城')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(onQuery).toHaveBeenCalledWith({ search: '旧城', cursor: '' })
      const status = container.querySelectorAll('.nwe-chapter-toolbar select')[0] as HTMLSelectElement
      const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      await act(async () => {
        setSelect.call(status, 'archived')
        status.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(onQuery).toHaveBeenCalledWith({ status: 'archived', cursor: '' })
      const next = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === '下一页',
      ) as HTMLButtonElement
      await act(async () => {
        next.click()
      })
      expect(onQuery).toHaveBeenCalledWith({ cursor: '1' })
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('degrades chapter and section panels without throwing', () => {
    const base = payload()
    const view = buildView(base)
    const fallback = (
      tab: Parameters<typeof panelElement>[4],
      section: Parameters<typeof panelElement>[6],
    ): string =>
      renderToStaticMarkup(
        panelElement(
          view,
          false,
          () => undefined,
          () => undefined,
          tab,
          () => undefined,
          section,
        ),
      )
    expect(fallback('chapters', { loading: true, error: null, payload: null })).toContain('章节')
    expect(fallback('chapters', { loading: false, error: 'boom', payload: null })).toContain('章节读取失败')
    expect(
      fallback('chapters', {
        loading: false,
        error: null,
        payload: { ...base, payload_version: 7, section: 'chapters', items: 'bad' },
      }),
    ).toContain('章节')
    expect(
      fallback('chapters', {
        loading: false,
        error: null,
        payload: { ...base, payload_version: 7, section: 'chapters', items: [] },
      }),
    ).toContain('没有匹配的章节')
    expect(
      fallback('characters', { loading: false, error: null, payload: { ...base, items: [] } }),
    ).toContain('人物：暂无数据')
    expect(
      fallback('worldbook', { loading: false, error: null, payload: { ...base, items: ['旧城'] } }),
    ).toContain('设定')
    expect(fallback('worldbook', { loading: false, error: null, payload: { ...base, items: {} } })).toContain(
      '设定：暂无数据',
    )
    expect(
      fallback('quality', { loading: false, error: null, payload: { ...base, items: ['质量'] } }),
    ).toContain('质量')
    expect(
      fallback('health', { loading: false, error: null, payload: { ...base, items: ['健康'] } }),
    ).toContain('健康')
    expect(
      fallback('foreshadows', { loading: false, error: null, payload: { ...base, items: [] } }),
    ).toContain('线索：暂无数据')
    expect(
      fallback('foreshadows', {
        loading: false,
        error: null,
        payload: { ...base, items: { foreshadows: [], timeline: [], relationships: [] } },
      }),
    ).toContain('线索：暂无数据')
  })

  it('shows the section window and keeps every returned row', () => {
    const base = payload()
    const items = Array.from({ length: 120 }, (_, index) => ({ name: `角色${index + 1}` }))
    const markup = renderToStaticMarkup(
      panelElement(
        buildView(base),
        false,
        () => undefined,
        () => undefined,
        'characters',
        () => undefined,
        {
          loading: false,
          error: null,
          payload: {
            ...base,
            payload_version: 7,
            section: 'characters',
            items,
            total: 180,
            returned: 120,
            truncated: true,
          },
        },
      ),
    )
    expect(markup).toContain('显示 120 / 共 180')
    expect(markup).toContain('角色120')
  })

  it('defaults a missing returned count to zero', () => {
    const base = payload()
    const markup = renderToStaticMarkup(
      panelElement(
        buildView(base),
        false,
        () => undefined,
        () => undefined,
        'characters',
        () => undefined,
        {
          loading: false,
          error: null,
          payload: {
            ...base,
            payload_version: 7,
            section: 'characters',
            items: [],
            total: 3,
            truncated: true,
          },
        },
      ),
    )
    expect(markup).toContain('显示 0 / 共 3')
  })

  it('opens a lazy quality detail from the quality tab', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const base = payload()
    const fetchMock = vi.fn(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => {
        const url = String(input)
        if (url.includes('section=quality_detail')) {
          return {
            ...base,
            payload_version: 7,
            section: 'quality_detail',
            items: { chapter: 2, review: '评审内容', check: '检查内容' },
          }
        }
        if (url.includes('section=quality')) {
          return {
            ...base,
            payload_version: 7,
            section: 'quality',
            items: { quality: { average: 1, samples: 1, median: 1, min: 1, max: 1 }, dimensions: [] },
          }
        }
        return base
      },
    }))
    vi.stubGlobal('fetch', fetchMock)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(NovelPanel))
      })
      const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
        (button) => button.textContent === '质量',
      )!
      await act(async () => {
        tab.click()
        await Promise.resolve()
      })
      const detailButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === '查看本章质量详情',
      )!
      await act(async () => {
        detailButton.click()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(container.textContent).toContain('第 2 章质量详情')
      expect(container.textContent).toContain('评审内容')
    } finally {
      await act(async () => {
        root.unmount()
      })
      vi.unstubAllGlobals()
      container.remove()
    }
  })

  it('opens a lazy quality detail for the active chapter', () => {
    const markup = renderToStaticMarkup(
      panelElement(
        buildView(payload()),
        false,
        () => undefined,
        () => undefined,
        'quality',
        () => undefined,
        {
          loading: false,
          error: null,
          payload: {
            ...payload(),
            payload_version: 7,
            section: 'quality',
            items: { quality: { average: 1, samples: 1, median: 1, min: 1, max: 1 }, dimensions: [] },
          },
        },
        { search: '', status: 'all', scene: '', sort: 'num_desc', cursor: '' },
        () => undefined,
        '',
        () => undefined,
        null,
        () => undefined,
        {
          chapter: 2,
          section: {
            loading: false,
            error: null,
            payload: {
              ...payload(),
              payload_version: 7,
              section: 'quality_detail',
              items: { chapter: 2, review: '评审内容', check: '检查内容' },
            },
          },
        },
      ),
    )
    expect(markup).toContain('第 2 章质量详情')
    expect(markup).toContain('评审内容')
    expect(markup).toContain('检查内容')
  })

  it('keeps omitted panel callbacks safe', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const base = payload()
    const nop = undefined as unknown as () => void
    try {
      await act(async () => {
        root.render(panelElement(buildView(base), false, nop))
      })
      const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
        (button) => button.textContent === '章节',
      )!
      await act(async () => {
        tab.click()
      })
      await act(async () => {
        root.render(
          panelElement(buildView(base), false, nop, nop, 'chapters', nop, {
            loading: false,
            error: null,
            payload: {
              ...base,
              payload_version: 7,
              section: 'chapters',
              total: 1,
              returned: 1,
              truncated: false,
              next_cursor: null,
              items: [{ num: 1, title: '开端之雨', status: 'archived', word_count: 20 }],
            },
          }),
        )
      })
      const detail = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === '详情',
      )!
      await act(async () => {
        detail.click()
      })
      await act(async () => {
        root.render(
          panelElement(
            buildView(base),
            false,
            nop,
            nop,
            'quality',
            nop,
            {
              loading: false,
              error: null,
              payload: {
                ...base,
                payload_version: 7,
                section: 'quality',
                items: { quality: { average: 1, samples: 1, median: 1, min: 1, max: 1 }, dimensions: [] },
              },
            },
            { search: '', status: 'all', scene: '', sort: 'num_desc', cursor: '' },
            nop,
            '',
            nop,
            null,
            nop,
            {
              chapter: 1,
              section: {
                loading: false,
                error: null,
                payload: {
                  ...base,
                  payload_version: 7,
                  section: 'quality_detail',
                  items: { chapter: 1, review: '评审内容', check: '检查内容' },
                },
              },
            },
          ),
        )
      })
      const close = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === '收起',
      )!
      await act(async () => {
        close.click()
      })
      expect(container.textContent).toContain('评审内容')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('renders an unreviewed chapter card without a score bar', () => {
    const view = buildView(payload())
    view.rows = [
      {
        ...view.rows[0]!,
        score: '—',
        scoreValue: null,
        scorePercent: null,
        badge: '草稿',
        tone: 'muted',
      },
    ]
    const markup = renderToStaticMarkup(panelElement(view, false, () => undefined))
    expect(markup).toContain('未评审')
  })

  it('links every tab control to a labelled tabpanel', () => {
    const tabs = [
      'overview',
      'chapters',
      'characters',
      'foreshadows',
      'worldbook',
      'quality',
      'health',
    ] as const
    for (const tab of tabs) {
      const markup = renderToStaticMarkup(
        panelElement(
          buildView(payload()),
          false,
          () => undefined,
          () => undefined,
          tab,
        ),
      )
      expect(markup).toContain(`id="nwe-panel-${tab}"`)
      expect(markup).toContain(`aria-labelledby="nwe-tab-${tab}"`)
    }
  })

  it('renders seven tabs, a section panel and an explicit sync failure', async () => {
    const view = buildView(payload())
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(
          panelElement(
            { ...view, syncError: '宿主返回 503' },
            false,
            () => undefined,
            () => undefined,
            'characters',
            () => undefined,
            {
              loading: false,
              error: null,
              payload: {
                ...payload(),
                payload_version: 7,
                section: 'characters',
                items: [{ name: '角色甲', role: 'protagonist' }],
              },
            },
          ),
        )
      })
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(7)
      expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain('角色甲')
      expect(container.textContent).toContain('同步失败：宿主返回 503')
    } finally {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('labels insufficient quality history without inventing a trend', () => {
    const sparse = payload()
    sparse.summary.quality = { averageScore: 0, scores: [], trend: null, trend_basis: 'insufficient_history' }
    sparse.summary.bookData = {
      current: { rounds: { review: 0, revise: 0, check: 0 } },
      quality: {
        average: 0,
        median: 0,
        min: 0,
        max: 0,
        last_ten_average: null,
        trend: null,
        trend_basis: 'insufficient_history',
        dimensions: [],
        samples: 0,
        attempts: 0,
      },
      health: { pending: null },
    } as unknown as NonNullable<NonNullable<PanelPayloadDto['summary']>['bookData']>
    expect(buildView(sparse).quality.trendText).toBe('历史不足')
  })

  it('renders every section tab and its empty/error/loading states', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const mount = createRoot(host)
    const view = buildView(payload())
    const tabs = ['characters', 'foreshadows', 'worldbook', 'quality', 'health'] as const
    try {
      for (const tab of tabs) {
        await act(async () => {
          mount.render(
            panelElement(
              view,
              false,
              () => undefined,
              () => undefined,
              tab,
              () => undefined,
              {
                loading: false,
                error: null,
                payload: {
                  ...payload(),
                  payload_version: 7,
                  section: tab,
                  items:
                    tab === 'worldbook'
                      ? { locations: [{ name: '地点' }], rules: [] }
                      : tab === 'quality'
                        ? { quality: null, dimensions: [] }
                        : tab === 'health'
                          ? { health: null, blocking: [] }
                          : [{ name: '角色甲' }, 'plain'],
                },
              },
            ),
          )
        })
        expect(host.querySelector(`#nwe-panel-${tab}`)).not.toBeNull()
      }
      await act(async () => {
        mount.render(
          panelElement(
            view,
            false,
            () => undefined,
            () => undefined,
            'characters',
            () => undefined,
            {
              loading: true,
              error: null,
              payload: null,
            },
          ),
        )
      })
      expect(host.textContent).toContain('正在读取栏目')
      await act(async () => {
        mount.render(
          panelElement(
            view,
            false,
            () => undefined,
            () => undefined,
            'characters',
            () => undefined,
            {
              loading: false,
              error: 'boom',
              payload: null,
            },
          ),
        )
      })
      expect(host.textContent).toContain('栏目读取失败')
    } finally {
      await act(async () => {
        mount.unmount()
      })
      host.remove()
    }
  })

  it('formats a positive quality trend with a plus sign', () => {
    const positive = payload()
    positive.summary.bookData = positive.summary.bookData
      ? { ...positive.summary.bookData, quality: { ...positive.summary.bookData.quality, trend: 2.5 } }
      : undefined
    if (positive.summary.quality !== undefined) positive.summary.quality.trend = 2.5
    expect(buildView(positive).quality.trendText).toBe('+2.5')
  })

  it('reads insufficient history from bookData when the flat quality has no basis', () => {
    const sparse = payload()
    const flat = { ...sparse.summary.quality!, trend: null }
    delete (flat as { trend_basis?: string }).trend_basis
    sparse.summary.quality = flat
    sparse.summary.bookData = {
      current: { rounds: { review: 0, revise: 0, check: 0 } },
      quality: {
        average: 0,
        median: 0,
        min: 0,
        max: 0,
        last_ten_average: null,
        trend: null,
        trend_basis: 'insufficient_history',
        dimensions: [],
        samples: 0,
        attempts: 0,
      },
      health: { pending: null },
    } as unknown as NonNullable<NonNullable<PanelPayloadDto['summary']>['bookData']>
    expect(buildView(sparse).quality.trendText).toBe('历史不足')
  })

  it('renders full-width card walls with icons on every read-model tab', () => {
    const base = payload()
    const sectionFor = (
      tab: 'chapters' | 'characters' | 'foreshadows' | 'worldbook' | 'quality' | 'health',
      items: unknown,
    ): string =>
      renderToStaticMarkup(
        panelElement(
          buildView(base),
          false,
          () => undefined,
          () => undefined,
          tab,
          () => undefined,
          {
            loading: false,
            error: null,
            payload: {
              ...base,
              payload_version: 7,
              section: tab,
              items,
              total: Array.isArray(items) ? items.length : 1,
              returned: Array.isArray(items) ? items.length : 1,
              truncated: false,
              next_cursor: null,
            } as unknown as PanelPayloadDto,
          },
        ),
      )
    const pages: Record<string, string> = {
      overview: renderToStaticMarkup(
        panelElement(
          buildView(base),
          false,
          () => undefined,
          () => undefined,
        ),
      ),
      chapters: sectionFor('chapters', base.chapters.rows),
      characters: sectionFor('characters', [
        {
          name: '林砚',
          role: 'protagonist',
          status: 'active',
          first_appearance: 1,
          last: 3,
          appearances: 7,
          current_state: '守着旧书店，等待下一封来信。',
          profile: '沉默、克制，习惯把线索写在书脊内侧。',
        },
        {
          name: '沈墨',
          role: 'supporting',
          status: 'active',
          first_appearance: 2,
          last: 3,
          appearances: 3,
          current_state: '在旧城档案馆查一封被退回的信。',
          profile: '说话很快，擅长从旧报纸里找矛盾。',
        },
        {
          name: '顾姨',
          role: 'extra',
          status: 'dormant',
          first_appearance: 1,
          last: 1,
          appearances: 1,
          current_state: '只在雨夜出现，知道书店旧主人的事。',
        },
      ]),
      foreshadows: sectionFor('foreshadows', {
        foreshadows: [
          { id: 'FS-001', title: '无名旧信', status: 'planted', chapter: 1, note: '信封背面有半个地址。' },
          {
            id: 'FS-002',
            title: '黄铜钥匙',
            status: 'dormant',
            chapter: 2,
            note: '钥匙齿形对应旧城档案馆。',
          },
          {
            id: 'FS-003',
            title: '失踪者笔迹',
            status: 'advanced',
            chapter: 3,
            note: '与三年前最后一封信一致。',
          },
        ],
        timeline: [
          { chapter: 1, time: '雨夜', description: '旧信被塞进门缝。', location: '旧书店' },
          { chapter: 2, time: '次日', description: '钥匙打开档案馆后门。', location: '旧城档案馆' },
        ],
        relationships: [
          { a: '林砚', b: '沈墨', type: '盟友', note: '共同查旧信。' },
          { a: '林砚', b: '顾姨', type: '旧识', note: '顾姨知道旧书店的过去。' },
        ],
      }),
      worldbook: sectionFor('worldbook', {
        premise: '一座旧城，所有来信都从同一场雨开始。',
        setting: '旧城临海，档案馆与书店隔着一条被填平的河。',
        blueprint: { themes: ['记忆', '失踪'], tone: '冷峻', pov: '第三人称限知', ending: '信被寄回。' },
        locations: [
          { name: '旧书店', description: '临街两层，木门，靠墙书架到顶。' },
          { name: '旧城档案馆', description: '灰石立面，地下一层存旧报纸。' },
        ],
        factions: [{ name: '港务会', description: '控制旧城航运与档案。', goal: '封锁旧案。' }],
        rules: [{ name: '信不能过海', description: '所有未署名的信都会在港口被退回。' }],
        glossary: [{ term: '旧印', definition: '档案馆书脊内侧的暗记。' }],
        backstory: [{ time: '三年前', event: '第一封无名信出现。' }],
        facts: [{ alias: '灯塔高度', value: 42, unit: '米' }],
        outline_cards: [
          { num: 1, title: '雨夜来信', status: 'archived', scene_type: '日常过渡章', goal: '找到钥匙。' },
        ],
        volumes: [{ title: '第一卷 雨与旧信', start_chapter: 1, end_chapter: 12 }],
        ledger: {
          locations: [{ name: '旧书店', layout: '木门与书架', anchors: ['门缝'] }],
          abilities: [{ name: '辨字', description: '能从笔迹判断写信时的情绪。' }],
          artifacts: [{ name: '黄铜钥匙', description: '齿形像旧城档案馆。' }],
        },
      }),
      quality: sectionFor('quality', {
        quality: { average: 132, samples: 6, median: 134, min: 118, max: 145 },
        dimensions: [
          { id: 'R-W-04', average: 17, samples: 6, max: 20 },
          { id: 'R-W-10', average: 0.8, samples: 6, max: 1 },
          { id: 'R-W-01', average: 13, samples: 6, max: 15 },
          { id: 'R-W-07', average: 8, samples: 6, max: 10 },
        ],
        pacing: {
          scene_types: { 日常过渡章: 3, 情感爆发章: 2, 战斗动作章: 1 },
          hook_strength: { '4': 4, '5': 2 },
          plot_advancement: { mid: 5, high: 1 },
          longest: { chapter: 6, words: 1234 },
          shortest: { chapter: 3, words: 519 },
        },
        effort: { reviews: 6, revisions: 2, checks: 3, rollbacks: 0, chapters: [] },
      }),
      health: sectionFor('health', {
        outline: { present: true, error: null },
        worldbook: { present: true, error: null },
        state_errors: [],
        drift: [],
        pending: null,
      }),
    }
    for (const [name, markup] of Object.entries(pages)) {
      expect(markup, name).toContain('nwe-tab-intro')
      expect(markup, name).toContain('nwe-workbench')
      const details = [...markup.matchAll(/<details\b([^>]*)>/g)].map((match) => match[1] ?? '')
      for (const attrs of details) expect(attrs, name).toMatch(/class="nwe-/)
    }
    expect(pages.overview).toContain('nwe-dossier-body')
    expect(pages.characters).toContain('nwe-data-card-icon')
    expect(pages.characters).toContain('nwe-data-card-body')
    expect(pages.chapters).toContain('aria-label="章节表，可滚动"')
    expect(pages.worldbook).toContain('nwe-group-head')
    expect(pages.quality).toContain('nwe-quality-kpis')
    expect(pages.quality).toContain('nwe-effort-grid')
    expect(pages.chapters).toContain('nwe-chapter-cards-mobile')
    expect(pages.health).toContain('nwe-health-grid')
  })
})
