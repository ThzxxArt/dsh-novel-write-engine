import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import { openStudioDb } from '../src/storage/db.js'
import { ArtifactStore } from '../src/kernel/artifacts/store.js'
import { FakeAgentBridge } from '../src/studio/fake-bridge.js'
import { StudioRuntime } from '../src/studio/runtime.js'
import { createStudioApi } from '../src/adapters/remote/studio-api.js'
import { loadCanon, saveBiblePlan, saveCanon } from '../src/kernel/book/store.js'

const roots: string[] = []

const init = async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-api-success-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: 'API 成功链路',
    genre: {
      major: 'mystery',
      sub: 'mystery.detective',
      tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
    },
    audience: 'general',
    platform: 'fanqie',
    targets: { total_chapters: 3, words_per_chapter: [2200, 3200] },
  })
  const project = await loadProjectV2(root)
  await saveBiblePlan(project.store, {
    schema_version: 2,
    kind: 'BiblePlan',
    premise: '一个替人查账的年轻人。',
    themes: ['选择与代价'],
    style: { guide: '短句。', fingerprint: { average_sentence_length: 14 } },
    world: { rules: [], factions: [], locations: [], glossary: {} },
    characters: [
      {
        slug: 'lin-yan',
        name: '林砚',
        role: '主角',
        profile: {},
        voice: { signature_phrases: [], register: '克制' },
      },
    ],
    citations: [],
    open_questions: [],
  })
  const db = openStudioDb(join(root, '.studio', 'studio.db'))
  const artifacts = new ArtifactStore(project, db)
  const runtime = new StudioRuntime({
    projectRoot: root,
    bridge: new FakeAgentBridge(project, artifacts),
    agents: { get: (id: string) => (id === 'main' ? ({} as Agent) : undefined) },
    directorSessionId: 'main',
  })
  const app = createStudioApi(runtime)
  const post = (body: Record<string, unknown>) =>
    app.request('/api/novel-write-engine/v8/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const mcp = async (name: string, args: Record<string, unknown>) =>
    (await (
      await app.request('/api/novel-write-engine/v8/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      })
    ).json()) as { result?: unknown; error?: { code: number; message: string } }
  return { root, project, db, artifacts, runtime, app, post, mcp }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const API = '/api/novel-write-engine/v8'

describe('studio API success paths', () => {
  it('runs chapter, approves via MCP and archives, then exports and publishes', async () => {
    const ctx = await init()
    try {
      const started = (await (
        await ctx.post({ action: 'run.start', kind: 'chapter', chapter: 1 })
      ).json()) as { runId: string }
      const ticked = (await (await ctx.post({ action: 'run.tick', runId: started.runId })).json()) as {
        board: { tasks: Array<{ kind: string; status: string }> }
      }
      expect(ticked.board.tasks.some((task) => task.status === 'awaiting_human')).toBe(true)
      const handle = await ctx.runtime.open()
      const gate = handle.director.gates.pending(ctx.project.config.id)[0]!
      const token = handle.director.gates.authorize(gate.id)
      const approved = await ctx.mcp('novel_approve', {
        gate_id: gate.id,
        token,
        decision: 'approve',
        actor: 'mcp',
        reason: 'ok',
      })
      expect(approved.error).toBeUndefined()
      const advanced = await ctx.mcp('novel_run', {
        action: 'tick',
        run_id: started.runId,
        human_approved: true,
      })
      expect(advanced.error).toBeUndefined()
      const status = (await (await ctx.app.request(`${API}/status`)).json()) as { stage: string }
      expect(status.stage).toBe('archived')

      for (const kind of ['markdown', 'txt', 'epub', 'outline', 'worldbook', 'proposal'] as const) {
        const response = await ctx.post({ action: 'export.run', kind })
        expect(response.status, kind).toBe(200)
      }
      const mcpExport = await ctx.mcp('novel_export', { kind: 'markdown', human_approved: true })
      expect(mcpExport.error).toBeUndefined()
      const publish = (await (await ctx.post({ action: 'export.run', kind: 'publish' })).json()) as {
        gateId: string
      }
      expect(publish.gateId).toBeTruthy()
      const mcpPending = (await ctx.mcp('novel_export', {
        kind: 'publish',
        human_approved: true,
      })) as { result?: { content: Array<{ text: string }> } }
      expect(mcpPending.result?.content[0]?.text).toContain(publish.gateId)
      const publishApproved = await ctx.post({
        action: 'human.approve',
        gateId: publish.gateId,
        decision: 'approve',
        actor: '作者',
      })
      expect(publishApproved.status).toBe(200)
      const publishPage = (await (await ctx.app.request(`${API}/publish`)).json()) as {
        exports: Array<{ format: string }>
      }
      expect(publishPage.exports.some((row) => row.format === 'publish')).toBe(true)

      await ctx.project.store.ensureDir('manuscript')
      const canon = await loadCanon(ctx.project.store)
      canon.foreshadows.push({ key: 'fs1', title: '缺角木匣', status: 'open' })
      await saveCanon(ctx.project.store, canon)
      const foreshadow = await ctx.post({
        action: 'foreshadow.status',
        key: 'fs1',
        status: 'resolved',
        anchor: '木匣的锁扣缺了一角',
      })
      expect(foreshadow.status).toBe(200)
    } finally {
      ctx.runtime.close()
      ctx.db.close()
    }
  })

  it('starts and ticks book/market runs, then rejects a stale published state', async () => {
    const ctx = await init()
    try {
      const book = (await (await ctx.post({ action: 'run.start', kind: 'book' })).json()) as {
        runId: string
      }
      expect(book.runId).toBeTruthy()
      const bookTick = (await (await ctx.post({ action: 'run.tick', runId: book.runId })).json()) as {
        board: { gates: Array<{ gate: string }> }
      }
      expect(bookTick.board.gates.some((gate) => gate.gate === 'bible')).toBe(true)
      expect((await ctx.post({ action: 'run.cancel', runId: book.runId })).status).toBe(200)

      const market = (await (await ctx.post({ action: 'run.start', kind: 'market' })).json()) as {
        runId: string
      }
      const marketTick = (await (await ctx.post({ action: 'run.tick', runId: market.runId })).json()) as {
        board: { runs: Array<{ id: string; status: string }> }
      }
      expect(marketTick.board.runs.find((run) => run.id === market.runId)?.status).toBe('completed')
      expect((await ctx.post({ action: 'export.run', kind: 'markdown', chapter: 1 })).status).toBe(400)
    } finally {
      ctx.runtime.close()
      ctx.db.close()
    }
  })

  it('serves deep read models, settings, controls and revision branches', async () => {
    const ctx = await init()
    try {
      const started = (await (
        await ctx.post({ action: 'run.start', kind: 'chapter', chapter: 1 })
      ).json()) as { runId: string }
      await ctx.post({ action: 'run.tick', runId: started.runId })
      const handle = await ctx.runtime.open()
      const board = handle.director.board()
      const task = board.tasks.find((row) => row.kind === 'plan')!
      const context = await ctx.app.request(`${API}/context?runId=${started.runId}&taskId=${task.id}`)
      expect(context.status).toBe(200)
      const reviews = (await (await ctx.app.request(`${API}/reviews?chapter=1`)).json()) as {
        reports: unknown[]
        findings: unknown[]
        gates: unknown[]
      }
      expect(reviews.reports.length).toBeGreaterThanOrEqual(3)
      expect(reviews.gates.length).toBeGreaterThan(0)

      const artifacts = (await (
        await ctx.app.request(`${API}/artifacts?kind=Draft&chapter=1&limit=10`)
      ).json()) as { rows: Array<{ id: string }> }
      expect(artifacts.rows.length).toBeGreaterThan(0)
      const drafts = handle.artifacts.list({ kind: 'Draft', chapter: 1, limit: 10 })
      const diff = await ctx.app.request(
        `${API}/diff?left=${drafts[0]!.id}&right=${drafts[drafts.length - 1]!.id}`,
      )
      expect(diff.status).toBe(200)

      const bible = (await (await ctx.app.request(`${API}/bible`)).json()) as {
        backlinks: Record<string, { chapters: number[]; reviews: unknown[] }>
      }
      expect(bible.backlinks['林砚']?.chapters).toContain(1)
      expect(bible.backlinks['林砚']?.reviews.length).toBeGreaterThan(0)
      const analytics = (await (await ctx.app.request(`${API}/analytics`)).json()) as {
        chapters: unknown[]
        cost: unknown[]
      }
      expect(analytics.chapters.length).toBeGreaterThan(0)
      expect(analytics.cost.length).toBeGreaterThan(0)

      expect((await ctx.post({ action: 'memory.reindex' })).status).toBe(200)
      expect((await ctx.post({ action: 'memory.rebuild' })).status).toBe(200)
      const settingsResponse = await ctx.post({
        action: 'settings.save',
        models: {},
        budgets: { per_chapter_usd: 1, per_run_usd: 10, per_task_tokens: 1000 },
        targets: {
          words_per_chapter: [2200, 3200],
          total_chapters: 3,
          dialogue_ratio: [0.3, 0.5],
          min_cjk_chars: 2000,
        },
        quality: { min_score: 120, review_rounds: 3 },
      })
      expect(settingsResponse.status, await settingsResponse.clone().text()).toBe(200)
      expect((await ctx.post({ action: 'comment.create', chapter: 1, paragraph: 0, body: 'x' })).status).toBe(
        400,
      )

      const gate = handle.director.gates.pending(ctx.project.config.id)[0]!
      const approve = await ctx.post({
        action: 'human.approve',
        gateId: gate.id,
        decision: 'approve',
        actor: '作者',
      })
      expect(approve.status).toBe(200)
      const archived = (await (await ctx.app.request(`${API}/status`)).json()) as { stage: string }
      expect(archived.stage).toBe('archived')

      const chapterTwo = (await (
        await ctx.post({ action: 'run.start', kind: 'chapter', chapter: 2 })
      ).json()) as { runId: string }
      await ctx.post({ action: 'run.tick', runId: chapterTwo.runId })
      const revision = await ctx.post({ action: 'revision.request', chapter: 2, actor: '作者' })
      expect(revision.status).toBe(200)
      const revisionBody = (await revision.json()) as { runId: string }
      handle.director.cancel(revisionBody.runId)

      const queued = (await (
        await ctx.post({ action: 'run.start', kind: 'chapter', chapter: 3 })
      ).json()) as { runId: string }
      expect((await ctx.post({ action: 'run.pause', runId: queued.runId })).status).toBe(200)
      expect((await ctx.post({ action: 'run.resume', runId: queued.runId })).status).toBe(200)
      expect((await ctx.post({ action: 'run.cancel', runId: queued.runId })).status).toBe(200)

      const artifact = (await ctx.mcp('novel_artifact', { action: 'get', id: drafts[0]!.id })) as {
        error?: unknown
      }
      expect(artifact.error).toBeUndefined()
      const mcpDiff = await ctx.mcp('novel_artifact', {
        action: 'diff',
        left: drafts[0]!.id,
        right: drafts[drafts.length - 1]!.id,
      })
      expect(mcpDiff.error).toBeUndefined()
      const mcpBook = await ctx.mcp('novel_run', {
        action: 'start',
        kind: 'book',
        human_approved: true,
      })
      expect(mcpBook.error).toBeUndefined()
      const bookRun = handle.director.board().runs.find((run) => run.kind === 'book')!
      handle.director.cancel(bookRun.id)
      const mcpMarket = await ctx.mcp('novel_run', {
        action: 'start',
        kind: 'market',
        human_approved: true,
      })
      expect(mcpMarket.error).toBeUndefined()
      const marketRun = handle.director.board().runs.find((run) => run.kind === 'market')!
      expect(
        (
          await ctx.mcp('novel_run', {
            action: 'tick',
            run_id: marketRun.id,
            human_approved: true,
          })
        ).error,
      ).toBeUndefined()
      const mcpPublish = await ctx.mcp('novel_export', { kind: 'publish', human_approved: true })
      expect(mcpPublish.error).toBeUndefined()
      const queuedTwo = handle.director.createChapterRun({ chapter: 4 })
      expect(
        (await ctx.mcp('novel_run', { action: 'pause', run_id: queuedTwo, human_approved: true })).error,
      ).toBeUndefined()
      expect(
        (await ctx.mcp('novel_run', { action: 'resume', run_id: queuedTwo, human_approved: true })).error,
      ).toBeUndefined()
      expect(
        (await ctx.mcp('novel_run', { action: 'cancel', run_id: queuedTwo, human_approved: true })).error,
      ).toBeUndefined()
    } finally {
      ctx.runtime.close()
      ctx.db.close()
    }
  })

  it('rewinds, restores a backup, reports an orphan and exposes capabilities', async () => {
    const ctx = await init()
    try {
      const saved = (await (
        await ctx.post({
          action: 'chapter.save',
          chapter: 1,
          content: '林砚把契纸合上，灯芯暗了一寸。这一次他没有再翻页，只把铜锁扣回原位。',
        })
      ).json()) as { artifact: { id: string } }
      const backup = (await (await ctx.post({ action: 'backup.create' })).json()) as { name: string }
      expect(backup.name).toBeTruthy()
      const rewound = await ctx.post({
        action: 'rewind',
        target: 'artifact',
        artifactId: saved.artifact.id,
        actor: '作者',
        reason: 'test',
      })
      expect(rewound.status).toBe(200)
      const chapterRewind = (await (
        await ctx.post({ action: 'rewind', target: 'chapter', chapter: 1, actor: '作者' })
      ).json()) as { runId: string }
      expect(chapterRewind.runId).toBeTruthy()
      const handle = await ctx.runtime.open()
      handle.director.cancel(chapterRewind.runId)
      const restored = await ctx.post({ action: 'backup.restore', name: backup.name })
      expect(restored.status).toBe(200)

      const fresh = await ctx.runtime.open()
      const draft = fresh.artifacts.list({ kind: 'Draft', chapter: 1, limit: 1 })[0]!
      await fresh.project.store.remove(draft.path)
      const doctor = (await (await ctx.app.request(`${API}/doctor`)).json()) as {
        ok: boolean
        orphaned: string[]
      }
      expect(doctor.ok).toBe(false)
      expect(doctor.orphaned).toContain(draft.id)

      const bootstrap = (await (await ctx.app.request(`${API}/bootstrap`)).json()) as {
        capabilities: { subagents: boolean }
      }
      expect(bootstrap.capabilities.subagents).toBe(true)
    } finally {
      ctx.runtime.close()
      ctx.db.close()
    }
  })
})
