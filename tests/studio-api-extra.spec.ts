import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initProjectV2 } from '../src/kernel/project/layout.js'
import { StudioRuntime } from '../src/studio/runtime.js'
import { createStudioApi } from '../src/adapters/remote/studio-api.js'
import { saveChapterPlan } from '../src/kernel/book/store.js'

const roots: string[] = []

const init = async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-api-extra-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: 'API 边界',
    genre: {
      major: 'mystery',
      sub: 'mystery.detective',
      tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
    },
    audience: 'general',
    platform: 'fanqie',
    targets: { total_chapters: 3 },
  })
  const runtime = new StudioRuntime({ projectRoot: root })
  const app = createStudioApi(runtime)
  const post = (body: Record<string, unknown>) =>
    app.request('/api/novel-write-engine/v8/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { root, runtime, app, post }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const API = '/api/novel-write-engine/v8'

describe('studio API input boundaries', () => {
  it('validates every read route instead of passing NaN into SQL', async () => {
    const { runtime, app } = await init()
    try {
      const cases: Array<[string, number]> = [
        [`${API}/status?chapter=0`, 400],
        [`${API}/manuscript?chapter=x`, 400],
        [`${API}/reviews?chapter=0`, 400],
        [`${API}/versions?chapter=0`, 400],
        [`${API}/comments?chapter=x`, 400],
        [`${API}/artifacts?kind=Nope`, 400],
        [`${API}/artifacts?limit=0`, 400],
        [`${API}/artifacts?chapter=0`, 400],
        [`${API}/diff`, 400],
        [`${API}/context`, 400],
        [`${API}/context?runId=../x&taskId=y`, 400],
        [`${API}/context?runId=run&taskId=task`, 404],
        [`${API}/artifact`, 400],
        [`${API}/artifact?id=missing`, 404],
        [`${API}/search?limit=0`, 400],
        [`${API}/search?q=${'x'.repeat(201)}`, 400],
      ]
      for (const [path, status] of cases) {
        const response = await app.request(path)
        expect(response.status, path).toBe(status)
      }
      for (const path of [
        `${API}/bootstrap`,
        `${API}/projects`,
        `${API}/chapters`,
        `${API}/outline`,
        `${API}/bible`,
        `${API}/board`,
        `${API}/foreshadows`,
        `${API}/publish`,
        `${API}/import-report`,
        `${API}/backups`,
        `${API}/analytics`,
        `${API}/settings`,
        `${API}/taxonomy`,
        `${API}/events`,
        `${API}/search?q=契纸`,
      ]) {
        const response = await app.request(path)
        expect(response.status, path).toBe(200)
      }
    } finally {
      runtime.close()
    }
  })

  it('reports bootstrap without a project instead of throwing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-api-empty-'))
    roots.push(root)
    const runtime = new StudioRuntime({ projectRoot: join(root, 'missing') })
    try {
      const app = createStudioApi(runtime)
      const response = await app.request(`${API}/bootstrap`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { project: null; error: string }
      expect(body.project).toBeNull()
      expect(body.error).toBeTruthy()
    } finally {
      runtime.close()
    }
  })

  it('validates MCP calls and never lets a model self-approve', async () => {
    const { runtime, app } = await init()
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await app.request(`${API}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        })
        expect(response.status).toBe(200)
        return (await response.json()) as { result?: unknown; error?: { code: number; message: string } }
      }
      const unknown = await app.request(`${API}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope' }),
      })
      expect(((await unknown.json()) as { error: { code: number } }).error.code).toBe(-32601)
      const status = await call('novel_status', {})
      expect(status.result).toBeDefined()
      expect((await call('novel_artifact', { action: 'get' })).error?.code).toBe(-32602)
      expect((await call('novel_artifact', { action: 'diff', left: 'a' })).error?.code).toBe(-32602)
      expect((await call('novel_artifact', { action: 'list' })).result).toBeDefined()
      expect((await call('novel_search', { query: '契纸' })).result).toBeDefined()
      expect((await call('novel_run', { action: 'start' })).error?.code).toBe(-32001)
      expect((await call('novel_run', { action: 'nope', human_approved: true })).error?.code).toBe(-32602)
      expect(
        (await call('novel_run', { action: 'start', kind: 'nope', human_approved: true })).error?.code,
      ).toBe(-32602)
      expect(
        (await call('novel_run', { action: 'start', kind: 'chapter', chapter: 0, human_approved: true }))
          .error?.code,
      ).toBe(-32602)
      expect((await call('novel_run', { action: 'pause', human_approved: true })).error?.code).toBe(-32602)
      expect(
        (await call('novel_run', { action: 'tick', run_id: 'r', human_approved: true })).error?.code,
      ).toBe(-32002)
      expect((await call('novel_export', { kind: 'markdown' })).error?.code).toBe(-32001)
      expect((await call('novel_export', { kind: 'nope', human_approved: true })).error?.code).toBe(-32602)
      expect((await call('novel_export', { kind: 'publish', human_approved: true })).error?.code).toBe(-32000)
      expect((await call('novel_approve', { gate_id: 'x' })).error?.code).toBe(-32001)
      expect((await call('novel_approve', { gate_id: 'x', token: 't', decision: 'nope' })).error?.code).toBe(
        -32602,
      )
      expect(
        (await call('novel_approve', { gate_id: 'x', token: 't', decision: 'approve' })).error?.code,
      ).toBe(-32000)
      expect((await call('unknown', {})).error?.code).toBe(-32602)
    } finally {
      runtime.close()
    }
  })

  it('validates project init and action enums', async () => {
    const { root, runtime, post } = await init()
    try {
      for (const body of [
        { action: 'project.init' },
        { action: 'project.init', genre: {}, title: '' },
        {
          action: 'project.init',
          genre: { major: 'mystery', sub: 'mystery.detective', tags: [] },
          title: 'x',
          audience: 'nope',
        },
        {
          action: 'project.init',
          genre: { major: 'mystery', sub: 'mystery.detective', tags: [] },
          title: 'x',
          platform: 'nope',
        },
        {
          action: 'project.init',
          genre: { major: 'mystery', sub: 'mystery.detective', tags: [] },
          title: 'x',
          total_chapters: 0,
        },
      ]) {
        expect((await post(body)).status).toBe(400)
      }
      const good = await post({
        action: 'project.init',
        root: join(root, 'new-project'),
        title: '新项目',
        genre: {
          major: 'mystery',
          sub: 'mystery.detective',
          tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
        },
        audience: 'general',
        platform: 'fanqie',
        total_chapters: 3,
      })
      expect(good.status).toBe(200)
      expect((await post({ action: 'nope' })).status).toBe(400)
      expect((await post({ action: 'run.start', kind: 'nope', chapter: 1 })).status).toBe(400)
      expect((await post({ action: 'run.start', kind: 'chapter', chapter: 0 })).status).toBe(400)
      expect((await post({ action: 'run.tick' })).status).toBe(400)
      expect((await post({ action: 'run.pause' })).status).toBe(400)
      expect((await post({ action: 'run.pause', runId: 'missing' })).status).toBe(400)
      expect((await post({ action: 'human.approve', gateId: 'x', decision: 'nope' })).status).toBe(400)
      expect((await post({ action: 'human.approve', gateId: 'x', decision: 'approve' })).status).toBe(400)
      expect((await post({ action: 'chapter.save', chapter: 0, content: 'x' })).status).toBe(400)
      expect((await post({ action: 'chapter.save', chapter: 1, content: '   ' })).status).toBe(400)
      expect((await post({ action: 'chapter.save', chapter: 1, content: '# 标题\n\n**加粗**' })).status).toBe(
        422,
      )
      expect((await post({ action: 'export.run', kind: 'nope' })).status).toBe(400)
      expect((await post({ action: 'export.run', kind: 'markdown', chapter: 0 })).status).toBe(400)
      expect((await post({ action: 'outline.move', from: 0, to: 1 })).status).toBe(400)
      expect((await post({ action: 'foreshadow.status', status: 'nope' })).status).toBe(400)
      expect((await post({ action: 'revision.request', chapter: 0 })).status).toBe(400)
      expect((await post({ action: 'artifact.restore' })).status).toBe(400)
      expect((await post({ action: 'artifact.restore', id: 'missing' })).status).toBe(400)
      expect((await post({ action: 'comment.create', chapter: 0, body: 'x' })).status).toBe(400)
      expect((await post({ action: 'comment.create', chapter: 1, body: '   ' })).status).toBe(400)
      expect((await post({ action: 'comment.resolve', id: 'x', status: 'nope' })).status).toBe(400)
      expect((await post({ action: 'finding.resolve', status: 'nope' })).status).toBe(400)
      expect((await post({ action: 'finding.resolve', id: 'missing', status: 'fixed' })).status).toBe(404)
      expect((await post({ action: 'finding.bulk', ids: ['x'], status: 'waived' })).status).toBe(400)
      expect((await post({ action: 'snapshot.verify', path: '/etc/passwd' })).status).toBe(400)
      expect((await post({ action: 'rewind', target: 'nope' })).status).toBe(400)
      expect((await post({ action: 'rewind', target: 'chapter', chapter: 0 })).status).toBe(400)
      expect((await post({ action: 'rewind', target: 'artifact' })).status).toBe(400)
    } finally {
      runtime.close()
    }
  })

  it('persists comments, snapshots and a human draft with correct version pointers', async () => {
    const { runtime, app, post } = await init()
    try {
      const saved = await post({
        action: 'chapter.save',
        chapter: 1,
        content: '林砚把契纸合上，灯芯暗了一寸。这一次他没有再翻页，只把铜锁扣回原位。',
      })
      expect(saved.status).toBe(200)
      const artifact = ((await saved.json()) as { artifact: { id: string; version: number; hash: string } })
        .artifact
      const comment = await post({ action: 'comment.create', chapter: 1, paragraph: 1, body: '收紧这一句。' })
      expect(comment.status).toBe(200)
      const commentId = ((await comment.json()) as { id: string }).id
      expect((await post({ action: 'comment.resolve', id: commentId, status: 'resolved' })).status).toBe(200)
      const snapshot = await post({ action: 'snapshot.create' })
      expect(snapshot.status).toBe(200)
      const snapshotBody = (await snapshot.json()) as { path: string }
      expect((await post({ action: 'snapshot.verify', path: snapshotBody.path })).status).toBe(200)
      expect((await post({ action: 'backup.create' })).status).toBe(200)
      const conflict = await post({
        action: 'chapter.save',
        chapter: 1,
        content: '另一段正文，林砚没有把铜锁扣回去。',
        baseHash: 'wrong',
      })
      expect(conflict.status).toBe(400)
      const ok = await post({
        action: 'chapter.save',
        chapter: 1,
        content: '林砚没有把铜锁扣回去，只把契纸压在灯下。',
        baseHash: artifact.hash,
      })
      expect(ok.status).toBe(200)
      const versions = await app.request(`${API}/versions?chapter=1`)
      expect(versions.status).toBe(200)
    } finally {
      runtime.close()
    }
  })

  it('moves chapter cards and rejects invalid movement', async () => {
    const { runtime, post } = await init()
    try {
      const handle = await runtime.open()
      for (const chapter of [1, 2, 3]) {
        await saveChapterPlan(handle.project.store, {
          schema_version: 2,
          kind: 'ChapterPlan',
          chapter,
          title: `第${chapter}章 测试`,
          scene_type: '日常过渡章',
          pov: '第三人称',
          cast: ['林砚'],
          goal: '查账',
          conflict: '来人不肯交底',
          turn: '契纸落款被刮',
          outcome: '去城南',
          target_words: 2400,
          hook: '门外三声敲击',
          foreshadows: [],
          notes: [],
          citations: [],
          open_questions: [],
        })
      }
      const moved = await post({ action: 'outline.move', from: 1, to: 2 })
      expect(moved.status).toBe(200)
      expect(((await moved.json()) as { chapters: unknown[] }).chapters.length).toBeGreaterThan(0)
      expect((await post({ action: 'outline.move', from: 2, to: 2 })).status).toBe(400)
    } finally {
      runtime.close()
    }
  })
})
