/// <reference lib="dom" />
// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildView } from '../src/client/viewmodel.js'
import { NovelPanel, panelElement } from '../src/client/panel.js'
import type { PanelPayloadDto } from '../src/client/dto.js'

type ReadyPayload = PanelPayloadDto & { summary: NonNullable<PanelPayloadDto['summary']> }

interface ResponseLike {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

const basePayload = (root = '/novels/a', title = '甲书'): ReadyPayload => ({
  schemaVersion: 6,
  projects: [
    { root: '/novels/a', title: '甲书', active: true, registered: true, state: 'ok' },
    { root: '/novels/b', title: '乙书', active: false, registered: true, state: 'ok' },
  ],
  selection: { root, source: 'active' },
  summary: {
    schemaVersion: 6,
    panelId: 'novel-workshop',
    root,
    title,
    genre: '都市现代',
    platform: 'fanqie',
    chapter: 2,
    stage: 'P4',
    revision: 7,
    totalWords: 5000,
    totalChapters: 2,
    phases: [],
    blocking: [],
    next: { tool: 'novel_revise', reason: '继续' },
  },
  chapters: {
    schemaVersion: 6,
    panelId: 'novel-workshop',
    rows: [{ num: 1, title: '开端之雨', wordCount: 2000, score: 145, stage: 'done', status: 'passed' }],
  },
})

const bPayload = (): ReadyPayload => {
  const value = basePayload('/novels/b', '乙书')
  value.selection = { root: '/novels/b', source: 'query' }
  return value
}

const choosePayload = (): PanelPayloadDto => {
  const value: PanelPayloadDto = basePayload()
  value.selection = { root: null, source: 'none' }
  delete value.summary
  delete value.chapters
  return value
}

const ok = (body: unknown): ResponseLike => ({ ok: true, status: 200, json: async () => body })
const fail = (error: string): ResponseLike => ({ ok: false, status: 500, json: async () => ({ error }) })
const notModified = (): ResponseLike => ({ ok: false, status: 304, json: async () => ({}) })

const urlOf = (input: unknown): URL => new URL(String(input), 'http://panel.test')
const sectionOf = (input: unknown): string | null => urlOf(input).searchParams.get('section')
const rootOf = (input: unknown): string | null => urlOf(input).searchParams.get('root')
const headerOf = (init: RequestInit | undefined, name: string): string | undefined => {
  const headers = init?.headers as Record<string, string> | undefined
  return headers?.[name.toLowerCase()]
}

const chapterSection = (titles: string[], extra: Partial<PanelPayloadDto> = {}): PanelPayloadDto => ({
  ...basePayload(),
  payload_version: 7,
  section: 'chapters',
  total: titles.length,
  returned: titles.length,
  truncated: false,
  next_cursor: null,
  items: titles.map((title, index) => ({
    num: index + 1,
    title,
    status: 'archived',
    word_count: 2000,
    score: 140,
  })),
  ...extra,
})

const charactersSection = (names: string[]): PanelPayloadDto => ({
  ...basePayload(),
  payload_version: 7,
  section: 'characters',
  total: names.length,
  returned: names.length,
  truncated: false,
  items: names.map((name) => ({ name, role: 'protagonist' })),
  etag: 'W/"characters"',
})

const mountPanel = async (): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(NovelPanel))
  })
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

const flush = async (turns = 6): Promise<void> => {
  await act(async () => {
    for (let index = 0; index < turns; index += 1) await Promise.resolve()
  })
}

const click = async (node: Element | null | undefined): Promise<void> => {
  expect(node).not.toBeNull()
  await act(async () => {
    node!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

const tabButton = (container: HTMLElement, label: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
    (button) => button.textContent === label,
  )

const selectProject = async (container: HTMLElement, root: string): Promise<void> => {
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="切换项目"]')
  expect(select).not.toBeNull()
  await act(async () => {
    select!.value = root
    select!.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
  })
}

const setInputValue = async (input: HTMLInputElement, value: string): Promise<void> => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

const tableSection = (): PanelPayloadDto => chapterSection(['开端之雨', '旧城之影'])

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.removeItem('nwe.panel-root.v1')
})

const bookData = (): NonNullable<NonNullable<PanelPayloadDto['summary']>['bookData']> => ({
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

const panelMarkup = (
  tab: 'overview' | 'chapters' | 'characters' | 'foreshadows' | 'worldbook' | 'quality' | 'health',
  section: { loading: boolean; error: string | null; payload: PanelPayloadDto | null } | null,
  view = buildView(basePayload()),
  narrow = false,
): string =>
  renderToStaticMarkup(
    panelElement(
      view,
      false,
      () => undefined,
      () => undefined,
      tab,
      () => undefined,
      section as never,
      undefined,
      () => undefined,
      '',
      () => undefined,
      null,
      () => undefined,
      null,
      () => undefined,
      '',
      () => undefined,
      narrow,
    ),
  )

describe('0221 P1: narrow breakpoint', () => {
  it('renders exactly one chapter surface and matches the 760px CSS breakpoint', async () => {
    const source = await readFile(join(import.meta.dirname, '../src/client/panel.ts'), 'utf8')
    expect(source).toContain("const NARROW_QUERY = '(max-width: 760px)'")
    expect(source).toContain('@media (max-width: 760px)')
    expect(source).toContain('.nwe-chapters-section .nwe-table-wrap { display: none; }')
    expect(source).toContain('.nwe-chapter-cards-mobile { display: grid;')

    const section = {
      loading: false,
      error: null,
      payload: tableSection(),
    }
    const wide = withoutCss(panelMarkup('chapters', section))
    const narrow = withoutCss(panelMarkup('chapters', section, buildView(basePayload()), true))
    expect(wide).toContain('nwe-table-wrap')
    expect(wide).not.toContain('nwe-chapter-cards-mobile')
    expect(narrow).toContain('nwe-chapter-cards-mobile')
    expect(narrow).not.toContain('nwe-table-wrap')
  })
})

describe('0221 P1: failed project switch', () => {
  it('restores the last ready root refs so the refresh does not query the failed book', async () => {
    localStorage.removeItem('nwe.panel-root.v1')
    let failB = true
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: string) => {
      calls.push(String(input))
      if (failB && sectionOf(input) === null && rootOf(input) === '/novels/b') {
        return fail('乙书打不开')
      }
      return ok(rootOf(input) === '/novels/b' ? bPayload() : basePayload())
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container, unmount } = await mountPanel()
    try {
      expect(container.querySelector('.nwe-title')?.textContent).toBe('《甲书》')
      await selectProject(container, '/novels/b')
      await flush()

      expect(container.querySelector('.nwe-title')?.textContent).toBe('《甲书》')
      expect(container.textContent).toContain('/novels/a')
      expect(localStorage.getItem('nwe.panel-root.v1')).toBe('/novels/a')

      failB = false
      await click(container.querySelector('button[aria-label="刷新项目状态"]'))
      await flush()
      expect(container.querySelector('.nwe-title')?.textContent).toBe('《甲书》')
      const last = calls.at(-1)
      expect(rootOf(last)).toBe('/novels/a')
    } finally {
      await unmount()
    }
  })
})

describe('0221 P2: failed refresh keeps the current screen', () => {
  it('does not replace the choose screen with the last ready book', async () => {
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      if (call === 1) return ok(basePayload())
      if (call === 2) return ok(choosePayload())
      return fail('宿主挂了')
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container, unmount } = await mountPanel()
    try {
      await click(container.querySelector('button[aria-label="刷新项目状态"]'))
      await flush()
      expect(container.textContent).toContain('发现多本书，先选一本')

      await click(container.querySelector('button[aria-label="刷新项目状态"]'))
      await flush()
      expect(container.querySelector('.nwe-title')?.textContent).toBe('选择一本项目')
      expect(container.textContent).toContain('宿主挂了')
      expect(container.querySelector<HTMLSelectElement>('select[aria-label="切换项目"]')?.value).toBe('')
    } finally {
      await unmount()
    }
  })
})

describe('0221 P2: section refresh failures', () => {
  it('stops sending the old ETag after a failed section refresh', async () => {
    let sectionMode: 'ok' | 'fail' = 'ok'
    let conditionalNotModified = false
    const sectionHeaders: Array<Record<string, string> | undefined> = []
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (sectionOf(input) !== 'characters') return ok(basePayload())
      const headers = init?.headers as Record<string, string> | undefined
      sectionHeaders.push(headers)
      if (conditionalNotModified && headerOf(init, 'if-none-match') !== undefined) return notModified()
      if (sectionMode === 'fail') return fail('人物栏目挂了')
      return ok(charactersSection(['角色甲']))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container, unmount } = await mountPanel()
    try {
      await click(tabButton(container, '人物'))
      await flush()
      expect(container.textContent).toContain('角色甲')
      expect(sectionHeaders[0]?.['if-none-match']).toBeUndefined()

      sectionMode = 'fail'
      await click(container.querySelector('button[aria-label="刷新项目状态"]'))
      await flush()
      expect(sectionHeaders[1]?.['if-none-match']).toBe('W/"characters"')

      sectionMode = 'ok'
      conditionalNotModified = true
      await click(container.querySelector('button[aria-label="刷新项目状态"]'))
      await flush(8)
      expect(sectionHeaders[2]?.['if-none-match']).toBeUndefined()
      expect(container.textContent).toContain('角色甲')
      expect(container.textContent).not.toContain('暂无数据')
    } finally {
      await unmount()
    }
  })

  it('keeps the chapter table and shows a retry banner after a failed section refresh', async () => {
    let sectionCalls = 0
    const fetchMock = vi.fn(async (input: string) => {
      if (sectionOf(input) !== 'chapters') return ok(basePayload())
      sectionCalls += 1
      if (sectionCalls === 2) return fail('章节栏目挂了')
      return ok(chapterSection(['筛选命中章']))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container, unmount } = await mountPanel()
    try {
      await click(tabButton(container, '章节'))
      await flush()
      expect(container.textContent).toContain('筛选命中章')

      await click(container.querySelector('button[aria-label="刷新项目状态"]'))
      await flush(8)
      const banner = container.querySelector('.nwe-stale-banner')
      expect(banner).not.toBeNull()
      expect(banner?.textContent).toContain('章节栏目挂了')
      expect(container.querySelector('.nwe-table-wrap')).not.toBeNull()
      expect(container.textContent).toContain('筛选命中章')

      const retry = banner?.querySelector('button')
      expect(retry?.textContent).toBe('重试')
      await click(retry!)
      await flush(8)
      expect(sectionCalls).toBeGreaterThanOrEqual(3)
      expect(container.querySelector('.nwe-stale-banner')).toBeNull()
      expect(container.textContent).toContain('筛选命中章')
    } finally {
      await unmount()
    }
  })
})

describe('0221 P2: tab intro count', () => {
  it('reports the filtered total, not the current page size', () => {
    const many = Array.from({ length: 50 }, (_, index) => `第 ${index + 1} 章`)
    const markup = panelMarkup(
      'chapters',
      {
        loading: false,
        error: null,
        payload: {
          ...chapterSection(many),
          total: 120,
          truncated: true,
          next_cursor: '50',
        },
      },
      buildView({ ...basePayload(), summary: { ...basePayload().summary, totalChapters: 120 } }),
    )
    const chip = /nwe-tab-intro-count[^>]*>([^<]+)</.exec(markup)
    expect(chip?.[1]).toBe('120 章')
    expect(markup).toContain('显示 50 / 共 120')
  })

  it('prefers the payload total to counting object-page scalars', () => {
    const payload = basePayload()
    const fragment = {
      ...payload,
      payload_version: 7 as const,
      section: 'foreshadows',
      total: 90,
      returned: 50,
      truncated: true,
      items: {
        foreshadows: Array.from({ length: 50 }, (_, index) => ({
          id: `FS-${index + 1}`,
          title: `伏笔${index + 1}`,
          status: 'planted',
        })),
        timeline: [{ id: 'TE-1', chapter: 1, story_time: '夜', description: '事件' }],
        relationships: [],
      },
      counts: {
        foreshadows: { total: 90, shown: 50 },
        timeline: { total: 1, shown: 1 },
        relationships: { total: 0, shown: 0 },
      },
    }
    const markup = panelMarkup('foreshadows', {
      loading: false,
      error: null,
      payload: fragment as unknown as PanelPayloadDto,
    })
    const chip = /nwe-tab-intro-count[^>]*>([^<]+)</.exec(markup)
    expect(chip?.[1]).toBe('90 条记录')
  })
})

describe('0221 P2: project switches reset filters', () => {
  it('clears chapter search, status and cursor when another book is selected', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (sectionOf(input) === 'chapters') {
        return ok({ ...tableSection(), truncated: true, next_cursor: '2' })
      }
      return ok(rootOf(input) === '/novels/b' ? bPayload() : basePayload())
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container, unmount } = await mountPanel()
    try {
      await click(tabButton(container, '章节'))
      await flush()
      const search = container.querySelector<HTMLInputElement>('input[placeholder="输入章节标题"]')!
      await setInputValue(search, '开端')
      await flush()
      const status = container.querySelectorAll<HTMLSelectElement>('.nwe-chapter-toolbar select')[0]!
      await act(async () => {
        status.value = 'archived'
        status.dispatchEvent(new Event('change', { bubbles: true }))
        await Promise.resolve()
      })
      await flush()
      const next = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === '下一页',
      )
      await click(next ?? null)
      await flush()

      await selectProject(container, '/novels/b')
      await flush(8)

      const chapterCalls = fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((url) => sectionOf(url) === 'chapters')
      const last = chapterCalls.at(-1)!
      expect(urlOf(last).searchParams.get('search')).toBeNull()
      expect(urlOf(last).searchParams.get('status')).toBeNull()
      expect(urlOf(last).searchParams.get('cursor')).toBeNull()
      expect(container.querySelector<HTMLInputElement>('input[placeholder="输入章节标题"]')?.value).toBe('')
    } finally {
      await unmount()
    }
  })

  it('clears the ledger search box when another book is selected', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (sectionOf(input) === 'characters') return ok(charactersSection(['角色甲']))
      return ok(rootOf(input) === '/novels/b' ? bPayload() : basePayload())
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container, unmount } = await mountPanel()
    try {
      await click(tabButton(container, '人物'))
      await flush()
      const search = container.querySelector<HTMLInputElement>('.nwe-section-search input')!
      await setInputValue(search, '角色')
      await flush()

      await selectProject(container, '/novels/b')
      await flush(8)

      const characterCalls = fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((url) => sectionOf(url) === 'characters')
      const last = characterCalls.at(-1)!
      expect(urlOf(last).searchParams.get('search')).toBeNull()
      expect(container.querySelector<HTMLInputElement>('.nwe-section-search input')?.value).toBe('')
    } finally {
      await unmount()
    }
  })
})

describe('0221 P2: not_registered recovery', () => {
  it('runs the same reset as a project switch and never paints the old book', async () => {
    localStorage.setItem('nwe.panel-root.v1', '/novels/a')
    let stale = false
    let recovering = false
    let resolveRecovery: ((response: ResponseLike) => void) | null = null
    const fetchMock = vi.fn(async (input: string) => {
      if (sectionOf(input) === 'characters') {
        // A request without a query root is the recovery read; answer it with a
        // different row so an old payload left on screen is visible.
        return ok(charactersSection([rootOf(input) === null && recovering ? '角色乙' : '角色甲']))
      }
      if (rootOf(input) === '/novels/a' && stale) {
        const missing: PanelPayloadDto = {
          ...basePayload(),
          selection: { root: '/novels/a', source: 'query' },
        }
        delete missing.summary
        delete missing.chapters
        missing.missing = {
          root: '/novels/a',
          title: '甲书',
          code: 'ENGINE_PROJECT_NOT_FOUND',
          reason: 'not_registered',
          hint: 'register the project',
        }
        recovering = true
        return ok(missing)
      }
      if (rootOf(input) === null) {
        return new Promise<ResponseLike>((resolve) => {
          resolveRecovery = resolve
        })
      }
      return ok(basePayload())
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container, unmount } = await mountPanel()
    try {
      await click(tabButton(container, '人物'))
      await flush()
      const search = container.querySelector<HTMLInputElement>('.nwe-section-search input')!
      await setInputValue(search, '角色')
      await flush()
      expect(container.textContent).toContain('角色甲')

      stale = true
      await click(container.querySelector('button[aria-label="刷新项目状态"]'))
      const recoveryStarted = (): boolean => fetchMock.mock.calls.some(([input]) => rootOf(input) === null)
      for (let attempt = 0; attempt < 25 && !recoveryStarted(); attempt += 1) await flush(2)
      expect(recoveryStarted()).toBe(true)
      // The retry without a root is still in flight; the old book's rows must be gone.
      expect(container.textContent).not.toContain('角色甲')

      recovering = false
      await act(async () => {
        resolveRecovery?.(ok(basePayload()))
        await Promise.resolve()
        await Promise.resolve()
      })
      await flush(8)
      expect(container.querySelector<HTMLInputElement>('.nwe-section-search input')?.value).toBe('')
      const characterCalls = fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((url) => sectionOf(url) === 'characters')
      const last = characterCalls.at(-1)!
      expect(urlOf(last).searchParams.get('search')).toBeNull()
      expect(container.textContent).toContain('角色甲')
    } finally {
      await unmount()
    }
  })
})

describe('0221 P2: section deadline', () => {
  it('turns a stalled section request into the retryable timeout message', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (sectionOf(input) !== 'characters') return ok(basePayload())
      return new Promise<ResponseLike>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container, unmount } = await mountPanel()
    try {
      await click(tabButton(container, '人物'))
      await flush()
      expect(container.textContent).toContain('正在读取栏目')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      await flush()
      expect(container.textContent).toContain('请求超时')
      expect(container.textContent).toContain('可以重试')
    } finally {
      await unmount()
    }
  })
})

describe('0221 P2: detail panels', () => {
  it('does not leave the first detail panel spinning when the other opens', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const section = sectionOf(input)
      if (section === 'chapter_detail') {
        return new Promise<ResponseLike>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      if (section === 'quality_detail') {
        return ok({
          ...basePayload(),
          payload_version: 7,
          section: 'quality_detail',
          items: { chapter: 2, review: '评审内容', check: '检查内容' },
        })
      }
      if (section === 'quality') {
        return ok({
          ...basePayload(),
          payload_version: 7,
          section: 'quality',
          items: {
            quality: { average: 140, samples: 1, median: 140, min: 140, max: 140 },
            dimensions: [],
          },
        })
      }
      if (section === 'chapters') return ok(tableSection())
      return ok(basePayload())
    })
    vi.stubGlobal('fetch', fetchMock)
    const { container, unmount } = await mountPanel()
    try {
      await click(tabButton(container, '章节'))
      await flush()
      const detail = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === '详情',
      )
      await click(detail ?? null)
      await flush()
      expect(container.textContent).toContain('正在读取章节详情')

      await click(tabButton(container, '质量'))
      await flush()
      const qualityDetail = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === '查看本章质量详情',
      )
      await click(qualityDetail ?? null)
      await flush()
      expect(container.textContent).toContain('第 2 章质量详情')
      expect(container.textContent).toContain('评审内容')

      await click(tabButton(container, '章节'))
      await flush()
      expect(container.textContent).not.toContain('正在读取章节详情')
    } finally {
      await unmount()
    }
  })
})

describe('0221 P2: lazy folds', () => {
  it('does not evaluate a closed fold body', () => {
    const data = bookData()
    // A closed fold must never touch its body: `.map` does not exist on this
    // array-like stand-in, so an eager call site throws while a lazy one does not.
    data.effort = {
      reviews: 0,
      revisions: 0,
      checks: 0,
      rollbacks: 0,
      chapters: { length: 0 } as never,
    }
    const payload = basePayload()
    payload.summary.bookData = data
    const view = buildView(payload)

    let markup = ''
    expect(() => {
      markup = withoutCss(panelMarkup('overview', null, view))
    }).not.toThrow()
    expect(markup).toContain('逐章 effort')
    expect(markup).not.toContain('nwe-fold-body')
  })
})

describe('0221 P2: foreshadow advance count', () => {
  it('renders the server advance_count instead of a dead advance_log row', () => {
    const payload = {
      ...basePayload(),
      payload_version: 7,
      section: 'foreshadows',
      total: 1,
      returned: 1,
      truncated: false,
      items: {
        foreshadows: [{ id: 'FS-1', title: '无名旧信', status: 'planted', advance_count: 3 }],
        timeline: [],
        relationships: [],
      },
      counts: {
        foreshadows: { total: 1, shown: 1 },
        timeline: { total: 0, shown: 0 },
        relationships: { total: 0, shown: 0 },
      },
    }
    const markup = panelMarkup('foreshadows', {
      loading: false,
      error: null,
      payload: payload as unknown as PanelPayloadDto,
    })
    expect(markup).toContain('推进次数')
    expect(markup).toContain('>3<')
    expect(markup).not.toContain('推进记录')
  })
})
