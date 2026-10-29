/// <reference lib="dom" />
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildView, fetchPanel } from '../src/client/viewmodel.js'
import { apply as applyClient, NovelIcon, NovelPanel } from '../src/client/index.js'
import { panelElement } from '../src/client/panel.js'
import type { PanelPayloadDto } from '../src/client/dto.js'

const payload = (): PanelPayloadDto & {
  summary: NonNullable<PanelPayloadDto['summary']>
  chapters: NonNullable<PanelPayloadDto['chapters']>
} => ({
  schemaVersion: 4,
  projects: [{ root: '/novels/test', title: '测试之书', active: true, registered: true, state: 'ok' }],
  selection: { root: '/novels/test', source: 'active' },
  resume: { text: '请继续《测试之书》。\n项目根：/novels/test' },
  summary: {
    schemaVersion: 4,
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
    schemaVersion: 4,
    panelId: 'novel-workshop',
    rows: [
      { num: 1, title: '开端之雨', wordCount: 2400, score: 145, stage: 'done', status: 'passed' },
      { num: 2, title: '旧城之影', wordCount: 2100, score: 0, stage: 'P3', status: 'draft' },
      { num: 3, title: '灯下之言', wordCount: 0, score: 0, stage: 'P3', status: 'blocked' },
    ],
  },
  gates: { schemaVersion: 4, panelId: 'novel-workshop', stage: 'P4', blocking: [], explanations: [] },
})

describe('panel view model', () => {
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
    expect(html).toContain('committed')
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

describe('panel v4 project selection', () => {
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
    delete choose.gates
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
    delete missing.gates
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
    delete blank.gates
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
    delete rootless.gates
    const view = buildView(rootless)
    expect(view.projects[0]!.label).toContain('— /')
  })

  it('falls back to empty when a v4 payload has no projects and no summary', () => {
    const blank: PanelPayloadDto = payload()
    blank.projects = []
    blank.selection = { root: null, source: 'none' }
    delete blank.summary
    delete blank.chapters
    delete blank.gates
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
    delete duplicate.gates
    const view = buildView(duplicate)
    expect(view.state).toBe('choose')
    expect(view.projects[0]!.label).toContain('— a')
    expect(view.projects[0]!.label).toContain('目录不存在')
    expect(view.projects[1]!.label).toContain('不可读')
    const html = renderToStaticMarkup(panelElement(view, false, () => undefined))
    expect(html).toContain('目录不存在')
    expect(html).toContain('不可读')
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
    delete stale.gates
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
      expect(fetchMock).toHaveBeenCalledTimes(3)
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => payload() })
      await act(async () => {
        vi.advanceTimersByTime(15_000)
        await Promise.resolve()
      })
      expect(fetchMock).toHaveBeenCalledTimes(4)
      expect(container.textContent).toContain('测试之书')
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
        await Promise.resolve()
      })
      expect(fetchMock).toHaveBeenCalledTimes(4)
    } finally {
      await act(async () => {
        root.unmount()
      })
      vi.useRealTimers()
      vi.unstubAllGlobals()
      container.remove()
    }
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
    expect(ready).toContain('overflow-y: auto')
    expect(ready).toContain('height: 100%')
    expect(ready).toContain('overscroll-behavior: contain')
    expect(ready).toContain('平均评分')
    expect(ready).toContain('NEXT MOVE')
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
})
