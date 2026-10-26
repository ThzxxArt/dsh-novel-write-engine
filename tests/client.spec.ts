// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildView, fetchPanel } from '../src/client/viewmodel.js'
import { apply as applyClient, NovelIcon, NovelPanel } from '../src/client/index.js'
import { panelElement } from '../src/client/panel.js'
import type { PanelPayloadDto } from '../src/client/dto.js'

const payload = (): PanelPayloadDto => ({
  schemaVersion: 1,
  summary: {
    schemaVersion: 1,
    panelId: 'novel-workshop',
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
  },
  chapters: {
    schemaVersion: 1,
    panelId: 'novel-workshop',
    rows: [
      { num: 1, title: '开端之雨', wordCount: 2400, score: 145, stage: 'done', status: 'passed' },
      { num: 2, title: '旧城之影', wordCount: 2100, score: 0, stage: 'P3', status: 'draft' },
      { num: 3, title: '灯下之言', wordCount: 0, score: 0, stage: 'P3', status: 'blocked' },
    ],
  },
  gates: { schemaVersion: 1, panelId: 'novel-workshop', stage: 'P4', blocking: [], explanations: [] },
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
    expect(view.blockingTitle).toBe('阻塞 1 项')
    expect(view.blocking[0]!.hint).toBe('再写一点')
    expect(view.next).toContain('novel_revise')
  })

  it('renders loading, error, outdated and empty states', () => {
    expect(buildView(null).state).toBe('loading')
    expect(buildView(null, 'offline').state).toBe('error')
    expect(buildView({ ...payload(), schemaVersion: 9 }).state).toBe('outdated')
    expect(buildView({ ...payload(), empty: true }).subtitle).toContain('novel_init')
    const noBlockers = payload()
    noBlockers.summary.blocking = []
    expect(buildView(noBlockers).blockingTitle).toBe('没有阻塞项')
    const noHint = payload()
    noHint.summary.blocking = [{ code: 'X', detail: 'd' }]
    expect(buildView(noHint).blocking[0]!.hint).toBe('')
  })

  it('fetches and degrades without throwing', async () => {
    const ok = vi.fn(async () => ({ ok: true, json: async () => payload() }))
    expect((await fetchPanel(ok as unknown as typeof fetch, '/api')).payload?.summary.chapter).toBe(2)
    const notOk = vi.fn(async () => ({ ok: false, status: 503 }))
    expect((await fetchPanel(notOk as unknown as typeof fetch, '/api')).error).toContain('503')
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
    expect(ready).toContain('阻塞 1 项')
    expect(ready).toContain('少了 200 字')
    const empty = renderToStaticMarkup(
      panelElement(buildView({ ...payload(), empty: true }), false, () => undefined),
    )
    expect(empty).toContain('novel_init')

    const icon = renderToStaticMarkup(NovelIcon({ size: 20 }))
    expect(icon).toContain('<svg')
    expect(icon).toContain('width="20"')
    expect(renderToStaticMarkup(NovelIcon({}))).toContain('width="18"')
  })
})
