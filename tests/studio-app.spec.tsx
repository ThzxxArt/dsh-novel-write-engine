/// <reference lib="dom" />
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { StudioApp } from '../src/client/studio/App.js'
import { useStudio } from '../src/client/studio/store.js'

const renderApp = (props: { t?: (key: string) => string } = {}) =>
  render(
    <StudioApp
      {...props}
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false } },
        })
      }
    />,
  )

const project = {
  id: 'p1',
  root: '/tmp/p1',
  title: '工作台测试',
  author: '作者',
  genre: {
    major: 'mystery',
    sub: 'mystery.detective',
    tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
    audience: 'general',
    platform: 'fanqie',
  },
  genre_path: '悬疑 / 推理',
  tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
  format_version: 2,
  created_at: '',
  updated_at: '',
}

const payloads: Record<string, unknown> = {
  '/bootstrap': {
    version: 8,
    project,
    roles: [
      { id: 'drafter', label: '执笔', preset: 'novel-role-drafter', canWrite: ['Draft'] },
      { id: 'critic-prose', label: '文笔审', preset: 'novel-role-critic-prose', canWrite: ['ReviewReport'] },
    ],
    capabilities: { subagents: true, sqlite: true, fts5: true, network: true },
    taxonomy: { majors: [{ id: 'mystery', label: '悬疑', subCount: 10 }], facets: [], tagCount: 137 },
  },
  '/status': {
    project,
    stage: 'awaiting_human',
    chapter: 1,
    words: 2480,
    score: 132,
    blocking: 0,
    run: { id: 'run-1', kind: 'chapter', status: 'awaiting_human', targetChapter: 1 },
    next: { action: 'human.approve', label: '等待批准', args: {} },
    counts: { chapters: 1, archived: 0, artifacts: 4, openFindings: 1 },
    cost_usd: 0.1,
  },
  '/chapters': {
    rows: [
      { chapter: 1, title: '第1章', stage: 'draft', words: 2480, score: 132, blockers: 0, updated_at: '' },
    ],
  },
  '/manuscript': {
    chapter: 1,
    title: '第1章',
    text: '门外传来三声敲击。\n\n林砚把伞收在门边。',
    draft: { id: 'a1', version: 1, status: 'draft', hash: 'sha256:x' },
  },
  '/outline': {
    book: {
      schema_version: 2,
      logline: '旧案',
      acts: [{ id: 'act-1', title: '第一幕', summary: '入局' }],
      volumes: [{ id: 'v1', title: '第一卷', start_chapter: 1, end_chapter: 2, arc: '查账' }],
      updated_at: '',
    },
    chapters: [
      {
        chapter: 1,
        title: '第1章',
        scene_type: '日常过渡章',
        cast: ['林砚'],
        goal: '查账',
        hook: '敲门',
      },
    ],
    foreshadows: [{ key: 'fs-1', title: '缺角契纸', status: 'open', planned_chapter: 3 }],
  },
  '/bible': {
    bible: {
      premise: '旧铺查账。',
      themes: '成长',
      styleGuide: '短句。',
      world: { rules: ['契纸有落款'], factions: [], locations: ['旧铺'], glossary: {} },
      characters: [{ slug: 'lin', name: '林砚', role: '主角' }],
    },
    canon: {
      relationships: [],
      timeline: [{ id: 't1', chapter: 1, title: '契纸入铺', time: '黄昏' }],
      foreshadows: [{ key: 'fs-1', title: '缺角契纸', status: 'open', planned_chapter: 3 }],
    },
    backlinks: { 林砚: { chapters: [1], foreshadows: ['缺角契纸'], reviews: [] } },
  },
  '/board': {
    runs: [
      {
        id: 'run-1',
        kind: 'chapter',
        status: 'awaiting_human',
        targetChapter: 1,
        error: null,
      },
    ],
    tasks: [
      {
        id: 'task-1',
        runId: 'run-1',
        role: 'drafter',
        kind: 'draft',
        status: 'completed',
        attempt: 1,
        maxAttempts: 3,
        outputArtifactId: 'a1',
        error: null,
      },
    ],
    assignments: [],
    gates: [
      {
        id: 'gate-1',
        gate: 'chapter',
        runId: 'run-1',
        taskId: 'task-1',
        chapter: 1,
        artifactId: 'a1',
        requestedAt: '',
      },
    ],
    artifacts: [{ id: 'a1', kind: 'Draft', chapter: 1, version: 1 }],
  },
  '/reviews': {
    reports: [
      {
        id: 'r1',
        role: 'critic-prose',
        version: 1,
        total: 120,
        dimensions: [{ id: 'R-W-07', max: 15, deductions: [{ rule: 'R-W-07', delta: 2 }] }],
        findings: [],
      },
      {
        id: 'r2',
        role: 'critic-prose',
        version: 2,
        total: 130,
        dimensions: [{ id: 'R-W-07', max: 15, deductions: [{ rule: 'R-W-07', delta: 1 }] }],
        findings: [],
      },
    ],
    findings: [
      {
        id: 'f1',
        role: 'critic-prose',
        dimension: 'R-W-07',
        severity: 'advisory',
        location: '第 1 段',
        evidence: '林砚把伞收在门边。',
        problem: '解释过多',
        fix: '删掉解释',
        status: 'open',
      },
    ],
    gates: [],
  },
  '/versions': { versions: [{ id: 'a1', kind: 'Draft', version: 1, status: 'draft', createdAt: '' }] },
  '/comments': {
    comments: [{ id: 'c1', chapter: 1, paragraph: 1, author: 'a', body: '评论', status: 'open' }],
  },
  '/taxonomy': { majors: [{ id: 'mystery', label: '悬疑', subs: [] }], tags: [] },
  '/analytics': {
    chapters: [{ chapter: 1, words: 2480, score: 132, blockers: 0 }],
    cost: [
      {
        run: 'run-1',
        kind: 'chapter',
        status: 'completed',
        costUsd: 0.1,
        promptTokens: 1,
        completionTokens: 1,
      },
    ],
    totals: { chapters: 1, words: 2480, cost: 0.1 },
  },
  '/settings': {
    project: {
      budgets: { per_chapter_usd: 0.6 },
      models: { drafter: { provider: 'deepseek', model: 'chat' } },
    },
    taxonomy: { majors: [{ id: 'mystery', label: '悬疑', subs: [] }], tags: [] },
  },
  '/publish': {
    exports: [],
    chapters: [1],
    gates: [],
    profile: { title: '工作台测试', author: '作者', platform: 'fanqie', audience: 'general' },
    exportsDir: 'exports',
  },
  '/projects': {
    projects: [{ root: '/tmp/p1', title: '工作台测试', projectId: 'p1' }],
  },
  '/foreshadows': {
    foreshadows: [{ key: 'fs-1', title: '缺角契纸', status: 'open', planned_chapter: 3 }],
  },
  '/artifacts': { rows: [{ id: 'a1', kind: 'Draft', chapter: 1, version: 1 }] },
  '/backups': { backups: [{ name: 'studio-1.db', bytes: 1024, mtimeMs: 0 }] },
  '/import-report': { text: '# 导入报告\n- 旧类型：玄幻修仙' },
  '/doctor': { ok: true, integrity: 'ok', artifacts: 1, orphaned: [] },
  '/context': {
    stage: 'draft',
    query: 'q',
    budgetTokens: 100,
    usedTokens: 10,
    omitted: 0,
    items: [
      {
        id: 'c',
        kind: 'canon',
        sourcePath: 'state/canon.yaml',
        sourceHash: 'sha256:x',
        text: '规则',
        score: 100,
        reason: ['world-rules'],
        protected: true,
        tokens: 10,
      },
    ],
  },
}

const originalFetch = globalThis.fetch
let requested: string[] = []

class FakeEventSource {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: (() => void) | null = null
  close(): void {}
}

beforeEach(() => {
  requested = []
  const state = useStudio.getState()
  state.setWorkspace('overview')
  state.setChapter(1)
  state.setInspector('')
  state.setRoot('')
  state.setPaletteOpen(false)
  state.selectArtifact(null)
  state.selectFinding(null)
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://studio.test')
    requested.push(url.pathname)
    const key = url.pathname.replace('/api/novel-write-engine/v8', '')
    const body = key === '/events' ? '' : JSON.stringify(payloads[key] ?? {})
    return new Response(body, {
      status: key in payloads ? 200 : 404,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  vi.unstubAllGlobals()
})

describe('studio workbench app', () => {
  it('renders all ten workspaces from the v8 contract', async () => {
    renderApp()
    await waitFor(() => expect(screen.getByRole('heading', { name: '总览' })).toBeTruthy())
    const workspaces: Array<[string, string]> = [
      ['稿件', '稿件'],
      ['大纲', '大纲'],
      ['设定', '设定 / Codex'],
      ['创作室', '创作室'],
      ['评审', '评审中心'],
      ['记忆', '记忆 / 检索'],
      ['分析', '分析'],
      ['发布', '发布'],
      ['设置', '设置 / 健康'],
    ]
    for (const [nav, heading] of workspaces) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${nav}`) }))
      await waitFor(() => expect(screen.getByRole('heading', { name: heading })).toBeTruthy())
    }
    expect(requested.some((path) => path.endsWith('/bootstrap'))).toBe(true)
    expect(screen.getByText('角色路由')).toBeTruthy()
    expect(screen.getByText('旧项目导入报告')).toBeTruthy()
  })

  it('exercises interactive controls across all workspaces', async () => {
    vi.stubGlobal(
      'prompt',
      vi.fn(() => '证据句子证据句子'),
    )
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    )
    renderApp()
    await waitFor(() => expect(screen.getByRole('heading', { name: '总览' })).toBeTruthy())
    const workspaces = ['总览', '稿件', '大纲', '设定', '创作室', '评审', '记忆', '分析', '发布', '设置']
    for (const workspace of workspaces) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${workspace}`) }))
      await waitFor(() =>
        expect(
          screen.getByRole('heading', { name: new RegExp(workspace === '设定' ? '设定' : workspace) }),
        ).toBeTruthy(),
      )
      const main = document.querySelector('.nwe-center')!
      const buttons = within(main as HTMLElement).queryAllByRole('button')
      for (const button of buttons.slice(0, 24)) {
        if ((button as HTMLButtonElement).disabled) continue
        fireEvent.click(button)
        await Promise.resolve()
      }
    }
    expect(requested.some((path) => path.endsWith('/action'))).toBe(true)
  })

  it('supports the command palette, keyboard shortcuts and project/inspector chrome', async () => {
    renderApp()
    await waitFor(() => expect(screen.getByRole('heading', { name: '总览' })).toBeTruthy())
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await waitFor(() => expect(screen.getByPlaceholderText('输入命令或搜索…')).toBeTruthy())
    useStudio.getState().setPaletteOpen(false)
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'j' })
    fireEvent.keyDown(window, { key: 'k' })
    const projectSwitch = screen.getByLabelText('切换项目') as HTMLSelectElement
    fireEvent.change(projectSwitch, { target: { value: '/tmp/p1' } })
    fireEvent.click(screen.getByRole('button', { name: '切换检查器' }))
    await waitFor(() => expect(screen.getByRole('complementary', { name: '检查器' })).toBeTruthy())
  })

  it('renders the empty and error states', async () => {
    const empty = { ...payloads, '/bootstrap': { ...(payloads['/bootstrap'] as object), project: null } }
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), 'http://studio.test')
      const key = url.pathname.replace('/api/novel-write-engine/v8', '')
      return new Response(JSON.stringify(empty[key] ?? {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    renderApp()
    await waitFor(() => expect(screen.getByText('创建项目')).toBeTruthy())
    cleanup()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 'X', message: '炸了' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch
    renderApp()
    await waitFor(() => expect(screen.getByText('重试')).toBeTruthy())
    // A failed bootstrap must not render the normal workbench or the create form.
    expect(screen.queryByText('创建项目')).toBeNull()
    expect(screen.queryByRole('heading', { name: '总览' })).toBeNull()
  })

  it('translates the workbench chrome through the injected translator', async () => {
    const dictionary: Record<string, string> = {
      'nav.overview': 'Overview',
      'nav.manuscript': 'Manuscript',
      'title.overview': 'Overview',
      'title.manuscript': 'Manuscript',
      'rail.workspaces': 'Workspaces',
      'rail.actions': 'Actions',
      'palette.studio': 'Open studio',
      'palette.review': 'Open review',
      'palette.publish': 'Open publish',
    }
    const t = (key: string): string => dictionary[key] ?? key
    renderApp({ t })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Overview' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Manuscript' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Manuscript' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Manuscript' })).toBeTruthy())
  })
})
