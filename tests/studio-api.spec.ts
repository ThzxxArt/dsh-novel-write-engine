import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initProjectV2 } from '../src/kernel/project/layout.js'
import { StudioRuntime } from '../src/studio/runtime.js'
import { createStudioApi } from '../src/adapters/remote/studio-api.js'
import { emptyCanon, saveCanon, saveChapterPlan, loadCanon } from '../src/kernel/book/store.js'
import { appendEvent } from '../src/storage/repositories/runs.js'
import { getFinding, insertFindings } from '../src/storage/repositories/artifacts.js'

const roots: string[] = []

const init = async (): Promise<{
  root: string
  runtime: StudioRuntime
  app: ReturnType<typeof createStudioApi>
}> => {
  const root = mkdtempSync(join(tmpdir(), 'studio-api-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: 'API 测试',
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
  return { root, runtime, app: createStudioApi(runtime) }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const read = async <T>(app: ReturnType<typeof createStudioApi>, path: string): Promise<T> => {
  const response = await app.request(path)
  expect(response.status).toBe(200)
  return (await response.json()) as T
}

describe('studio API v8', () => {
  it('serves bootstrap, status, chapters, outline, bible, board and settings', async () => {
    const { runtime, app } = await init()
    try {
      const bootstrap = await read<{
        version: number
        project: { title: string }
        roles: unknown[]
        taxonomy: { tagCount: number }
      }>(app, '/api/novel-write-engine/v8/bootstrap')
      expect(bootstrap.version).toBe(8)
      expect(bootstrap.project.title).toBe('API 测试')
      expect(bootstrap.roles).toHaveLength(12)
      expect(bootstrap.taxonomy.tagCount).toBe(137)
      const status = await read<{ chapter: number; project: { title: string } }>(
        app,
        '/api/novel-write-engine/v8/status',
      )
      expect(status.project.title).toBe('API 测试')
      const chapters = await read<{ rows: unknown[] }>(app, '/api/novel-write-engine/v8/chapters')
      expect(chapters.rows.length).toBeGreaterThanOrEqual(1)
      const outline = await read<{ book: { schema_version: number }; chapters: unknown[] }>(
        app,
        '/api/novel-write-engine/v8/outline',
      )
      expect(outline.book.schema_version).toBe(2)
      const bible = await read<{ bible: { premise: string } }>(app, '/api/novel-write-engine/v8/bible')
      expect(bible.bible.premise).toBeDefined()
      const board = await read<{ runs: unknown[]; gates: unknown[] }>(app, '/api/novel-write-engine/v8/board')
      expect(board.runs).toHaveLength(0)
      const settings = await read<{ project: { title: string }; taxonomy: { majors: unknown[] } }>(
        app,
        '/api/novel-write-engine/v8/settings',
      )
      expect(settings.project.title).toBe('API 测试')
      expect(settings.taxonomy.majors).toHaveLength(12)
      const doctor = await read<{ integrity: string; ok: boolean }>(app, '/api/novel-write-engine/v8/doctor')
      expect(doctor.integrity).toBe('ok')
      expect(doctor.ok).toBe(true)
    } finally {
      runtime.close()
    }
  })

  it('serves an MCP initialize/tools/list handshake', async () => {
    const { runtime, app } = await init()
    try {
      const initialize = await app.request('/api/novel-write-engine/v8/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      })
      expect(initialize.status).toBe(200)
      const initialized = (await initialize.json()) as {
        result: { protocolVersion: string; serverInfo: { name: string } }
      }
      expect(initialized.result.protocolVersion).toBeTruthy()
      expect(initialized.result.serverInfo.name).toBe('dsh-novel-write-engine')
      const list = await app.request('/api/novel-write-engine/v8/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      })
      const tools = (await list.json()) as { result: { tools: Array<{ name: string }> } }
      expect(tools.result.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'novel_status',
          'novel_run',
          'novel_artifact',
          'novel_search',
          'novel_export',
          'novel_approve',
        ]),
      )
    } finally {
      runtime.close()
    }
  })

  it('creates a run, saves a human manuscript version and rejects unknown actions', async () => {
    const { runtime, app } = await init()
    try {
      const start = await app.request('/api/novel-write-engine/v8/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'run.start', kind: 'chapter', chapter: 1 }),
      })
      expect(start.status).toBe(200)
      const started = (await start.json()) as { runId: string }
      expect(started.runId).toBeTruthy()
      const save = await app.request('/api/novel-write-engine/v8/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'chapter.save',
          chapter: 1,
          content: '第一段正文。\\n\\n第二段正文。',
          actor: 'tester',
        }),
      })
      expect(save.status).toBe(200)
      const saved = (await save.json()) as { artifact: { id: string; version: number } }
      expect(saved.artifact.version).toBe(1)
      const manuscript = await read<{ text: string; draft: { id: string } }>(
        app,
        '/api/novel-write-engine/v8/manuscript?chapter=1',
      )
      expect(manuscript.text).toContain('第一段正文')
      expect(manuscript.draft.id).toBe(saved.artifact.id)
      const unknown = await app.request('/api/novel-write-engine/v8/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'nope' }),
      })
      expect(unknown.status).toBe(400)
    } finally {
      runtime.close()
    }
  })

  it('initializes a project through the action endpoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-init-'))
    roots.push(root)
    const runtime = new StudioRuntime({ projectRoot: root })
    try {
      const app = createStudioApi(runtime)
      const response = await app.request('/api/novel-write-engine/v8/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'project.init',
          title: '工作台新建',
          genre: {
            major: 'fantasy',
            sub: 'fantasy.xianxia',
            tags: ['world.eastern_cultivation', 'plot.progression', 'tone.hot_blooded'],
          },
          audience: 'male',
          platform: 'qidian',
        }),
      })
      expect(response.status).toBe(200)
      const boot = await read<{ project: { title: string } }>(app, '/api/novel-write-engine/v8/bootstrap')
      expect(boot.project.title).toBe('工作台新建')
    } finally {
      runtime.close()
    }
  })

  it('supports outline reorder, foreshadow status, comments, backups and publish history', async () => {
    const { root, runtime, app } = await init()
    try {
      const handle = await runtime.open(root)
      const plan = (chapter: number, title: string): import('../src/contracts/artifacts.js').ChapterPlan => ({
        schema_version: 2,
        kind: 'ChapterPlan',
        chapter,
        title,
        scene_type: '日常过渡章',
        pov: '第三人称',
        cast: ['林砚'],
        goal: '目标',
        conflict: '冲突',
        turn: '转折',
        outcome: '结果',
        target_words: 2400,
        hook: '钩子',
        foreshadows: [],
        notes: [],
        citations: [],
        open_questions: [],
      })
      await saveChapterPlan(handle.project.store, plan(1, '第1章 第一张'))
      await saveChapterPlan(handle.project.store, plan(2, '第2章 第二张'))
      const move = await app.request('/api/novel-write-engine/v8/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'outline.move', from: 1, to: 2 }),
      })
      expect(move.status).toBe(200)
      const outline = await read<{ chapters: Array<{ chapter: number; title: string }> }>(
        app,
        '/api/novel-write-engine/v8/outline',
      )
      expect(outline.chapters.map((row) => row.title)).toEqual(['第2章 第二张', '第1章 第一张'])

      await saveCanon(handle.project.store, {
        ...emptyCanon(),
        foreshadows: [{ key: 'fs-api', title: '缺口契纸', status: 'open' }],
      })
      const noAnchor = await app.request('/api/novel-write-engine/v8/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'foreshadow.status', key: 'fs-api', status: 'resolved' }),
      })
      expect(noAnchor.status).toBe(400)
      const withAnchor = await app.request('/api/novel-write-engine/v8/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'foreshadow.status',
          key: 'fs-api',
          status: 'resolved',
          anchor: '缺口契纸在灯下合上了。',
        }),
      })
      expect(withAnchor.status).toBe(200)
      expect((await loadCanon(handle.project.store)).foreshadows[0]?.status).toBe('resolved')

      const create = await app.request('/api/novel-write-engine/v8/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'comment.create', chapter: 1, paragraph: 2, body: '第一段评论' }),
      })
      const created = (await create.json()) as { id: string }
      const backup = await app.request('/api/novel-write-engine/v8/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'backup.create' }),
      })
      const backupBody = (await backup.json()) as { name: string }
      expect(backupBody.name.endsWith('.db')).toBe(true)
      await app.request('/api/novel-write-engine/v8/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'comment.create', chapter: 1, paragraph: 3, body: '回滚后应消失' }),
      })
      const listed = await read<{ comments: Array<{ id: string; body: string }> }>(
        app,
        '/api/novel-write-engine/v8/comments?chapter=1',
      )
      expect(listed.comments).toHaveLength(2)
      const restore = await app.request('/api/novel-write-engine/v8/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'backup.restore', name: backupBody.name }),
      })
      expect(restore.status).toBe(200)
      const afterRestore = await read<{ comments: Array<{ id: string; body: string }> }>(
        app,
        '/api/novel-write-engine/v8/comments?chapter=1',
      )
      expect(afterRestore.comments.map((row) => row.body)).toEqual(['第一段评论'])
      const resolved = await app.request('/api/novel-write-engine/v8/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'comment.resolve', id: created.id, status: 'resolved' }),
      })
      expect(resolved.status).toBe(200)

      const backups = await read<{ backups: Array<{ name: string }> }>(
        app,
        '/api/novel-write-engine/v8/backups',
      )
      expect(backups.backups.some((row) => row.name === backupBody.name)).toBe(true)
      const publish = await read<{ chapters: number[]; exportsDir: string }>(
        app,
        '/api/novel-write-engine/v8/publish',
      )
      expect(publish.exportsDir).toBe('exports')
      expect(Array.isArray(publish.chapters)).toBe(true)
    } finally {
      runtime.close()
    }
  })

  it('prefers a newer human draft over the archived file and reports max event seq', async () => {
    const { root, runtime, app } = await init()
    try {
      const handle = await runtime.open(root)
      const saved = await app.request('/api/novel-write-engine/v8/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'chapter.save',
          chapter: 1,
          content: '新的工作草稿，林砚把契纸合上，灯芯暗了一寸。',
        }),
      })
      expect(saved.status).toBe(200)
      await handle.project.store.writeText('manuscript/ch-0001.md', '旧的归档正文。\n')
      const manuscript = await read<{ text: string; archived: boolean; draft: { status: string } }>(
        app,
        '/api/novel-write-engine/v8/manuscript?chapter=1',
      )
      expect(manuscript.text).toContain('新的工作草稿')
      expect(manuscript.archived).toBe(true)
      const chapters = await read<{ rows: Array<{ chapter: number; stage: string }> }>(
        app,
        '/api/novel-write-engine/v8/chapters',
      )
      expect(chapters.rows.find((row) => row.chapter === 1)?.stage).toBe('archived')
      const first = appendEvent(handle.db.orm, {
        projectId: handle.project.config.id,
        type: 'test.one',
        payload: {},
      })
      const second = appendEvent(handle.db.orm, {
        projectId: handle.project.config.id,
        type: 'test.two',
        payload: {},
      })
      expect(second).toBeGreaterThan(first)
      const board = await read<{ seq: number }>(app, '/api/novel-write-engine/v8/board')
      expect(board.seq).toBe(second)
    } finally {
      runtime.close()
    }
  })

  it('validates action enums and requires draft evidence before closing a blocker', async () => {
    const { root, runtime, app } = await init()
    try {
      const handle = await runtime.open(root)
      const post = (body: Record<string, unknown>) =>
        app.request('/api/novel-write-engine/v8/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      expect((await post({ action: 'run.start', kind: 'nope', chapter: 1 })).status).toBe(400)
      expect((await post({ action: 'run.start', kind: 'chapter', chapter: 0 })).status).toBe(400)
      expect((await post({ action: 'export.run', kind: 'nope' })).status).toBe(400)
      const invalidStatus = await app.request('/api/novel-write-engine/v8/status?chapter=0')
      expect(invalidStatus.status).toBe(400)

      const draftResponse = await post({
        action: 'chapter.save',
        chapter: 1,
        content: '林砚把契纸合上，灯芯暗了一寸。这一次他没有再翻页，只把铜锁扣回原位。',
      })
      expect(draftResponse.status).toBe(200)
      const draft = (await handle.artifacts.latest('Draft', 1))!
      const badFormat = await post({
        action: 'chapter.save',
        chapter: 1,
        content: '# 标题\n\n**这一行不该通过格式门。**',
      })
      expect(badFormat.status).toBe(422)
      const [blockerId, advisoryId] = insertFindings(handle.db.orm, [
        {
          artifactId: draft.id,
          role: 'critic-prose',
          dimension: 'R-W-07',
          severity: 'blocker',
          location: '第 1 段',
          evidence: '林砚把契纸合上',
          problem: 'blocker',
          fix: 'fix',
          status: 'open',
        },
        {
          artifactId: draft.id,
          role: 'critic-prose',
          dimension: 'R-W-06',
          severity: 'advisory',
          location: '第 1 段',
          evidence: '灯芯暗了一寸',
          problem: 'advisory',
          fix: 'fix',
          status: 'open',
        },
      ])
      expect((await post({ action: 'finding.resolve', id: blockerId, status: 'waived' })).status).toBe(400)
      expect((await post({ action: 'finding.resolve', id: blockerId, status: 'fixed' })).status).toBe(400)
      expect(
        (
          await post({
            action: 'finding.resolve',
            id: blockerId,
            status: 'fixed',
            resolution: '正文里不存在的证据句子',
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await post({
            action: 'finding.resolve',
            id: blockerId,
            status: 'fixed',
            resolution: '林砚把契纸合上，灯芯暗了一寸。',
          })
        ).status,
      ).toBe(200)
      expect(getFinding(handle.db.orm, blockerId)?.resolution).toContain('灯芯')
      const bulk = await post({ action: 'finding.bulk', ids: [blockerId, advisoryId], status: 'fixed' })
      expect(await bulk.json()).toMatchObject({ ok: true, changed: 1 })
      expect(getFinding(handle.db.orm, advisoryId)?.status).toBe('fixed')
      expect((await post({ action: 'finding.bulk', ids: [blockerId], status: 'waived' })).status).toBe(400)
      expect((await post({ action: 'comment.create', chapter: 1, body: '   ' })).status).toBe(400)
      const comment = await post({
        action: 'comment.create',
        chapter: 1,
        paragraph: 1,
        body: '这一句要收紧。',
      })
      expect(comment.status).toBe(200)
      const commentId = ((await comment.json()) as { id: string }).id
      expect((await post({ action: 'comment.resolve', id: commentId, status: 'resolved' })).status).toBe(200)
      expect(
        (
          await post({
            action: 'settings.save',
            export_profile: {
              author_note: '感谢',
              blurb: '简介',
              tags: ['tone.cold'],
              cover_path: null,
              title_rule: '第{n}章',
            },
          })
        ).status,
      ).toBe(200)
    } finally {
      runtime.close()
    }
  })

  it('restores artifact versions, validates settings/status enums and starts a rewrite run', async () => {
    const { runtime, app } = await init()
    try {
      const post = (body: Record<string, unknown>) =>
        app.request('/api/novel-write-engine/v8/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      const first = await post({
        action: 'chapter.save',
        chapter: 1,
        content: '林砚把契纸合上，灯芯暗了一寸。这一次他没有再翻页。',
      })
      const firstBody = (await first.json()) as { artifact: { id: string; version: number; hash: string } }
      expect(first.status).toBe(200)
      const second = await post({
        action: 'chapter.save',
        chapter: 1,
        content: '林砚把契纸合上，灯芯暗了一寸。这一次他没有再翻页，只把铜锁扣回原位。',
        baseHash: firstBody.artifact.hash,
      })
      expect(second.status).toBe(200)
      const restored = await post({
        action: 'artifact.restore',
        id: firstBody.artifact.id,
        actor: 'author',
        reason: 'test',
      })
      expect(restored.status).toBe(200)
      const restoredBody = (await restored.json()) as { artifact: { version: number } }
      expect(restoredBody.artifact.version).toBeGreaterThan(firstBody.artifact.version)

      expect((await post({ action: 'comment.resolve', id: 'x', status: 'nope' })).status).toBe(400)
      expect((await post({ action: 'foreshadow.status', key: 'x', status: 'nope' })).status).toBe(400)
      expect(
        (
          await post({
            action: 'settings.save',
            targets: {
              total_chapters: 2,
              words_per_chapter: [2200, 3200],
              min_cjk_chars: 2000,
              dialogue_ratio: [0.3, 0.5],
            },
            quality: { min_score: 120, review_rounds: 3 },
          })
        ).status,
      ).toBe(200)
      const revision = await post({ action: 'revision.request', chapter: 1, actor: 'author' })
      expect(revision.status).toBe(200)
      const revisionBody = (await revision.json()) as { runId: string }
      const board = await read<{ runs: Array<{ id: string; kind: string }> }>(
        app,
        '/api/novel-write-engine/v8/board',
      )
      expect(board.runs.find((run) => run.id === revisionBody.runId)?.kind).toBe('rewrite')
      expect((await post({ action: 'run.cancel', runId: revisionBody.runId })).status).toBe(200)
    } finally {
      runtime.close()
    }
  })
})
