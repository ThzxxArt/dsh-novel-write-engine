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
import { createHostTools, createStudioTools } from '../src/adapters/tools/studio.js'
import {
  claimTaskById,
  createAssignment,
  createRun,
  createTasks,
  markTaskRunning,
} from '../src/storage/repositories/runs.js'

const roots: string[] = []

const makeRuntime = async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-tools-extra-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: '工具边界',
    genre: {
      major: 'mystery',
      sub: 'mystery.detective',
      tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
    },
    audience: 'general',
    platform: 'fanqie',
    targets: { total_chapters: 3 },
  })
  const project = await loadProjectV2(root)
  const db = openStudioDb(join(root, '.studio', 'studio.db'))
  const artifacts = new ArtifactStore(project, db)
  const runtime = new StudioRuntime({
    projectRoot: root,
    bridge: new FakeAgentBridge(project, artifacts),
  })
  const tools = new Map(createStudioTools(runtime).map((tool) => [tool.name, tool]))
  const host = new Map(createHostTools({ runtime }).map((tool) => [tool.name, tool]))
  const execute = (name: string, args: Record<string, unknown>, tool = tools) => {
    const definition = tool.get(name)
    if (definition === undefined) throw new Error(`missing tool ${name}`)
    return (definition as { execute: (args: unknown, exec: unknown) => Promise<unknown> }).execute(args, {
      agent: { id: 'host-agent' } as Agent,
      signal: new AbortController().signal,
    })
  }
  return { root, project, db, artifacts, runtime, tools, host, execute }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('studio tools deep paths', () => {
  it('reads every state ledger and rejects malformed proposals', async () => {
    const ctx = await makeRuntime()
    try {
      for (const kind of [
        'canon',
        'characters',
        'locations',
        'factions',
        'items',
        'concepts',
        'relationships',
        'timeline',
        'foreshadows',
        'resources',
        'handoff',
      ]) {
        expect(await ctx.execute('novel_state', { kind })).toBeDefined()
      }
      await expect(ctx.execute('novel_bible', { action: 'propose', patch: {} })).rejects.toThrow(
        /schema|ARTIFACT_INVALID/u,
      )
      await expect(ctx.execute('novel_outline', { action: 'propose', content: {} })).rejects.toThrow(
        /schema|ARTIFACT_INVALID/u,
      )
      const status = (await ctx.execute('novel_status', { chapter: 2 })) as { chapter: number }
      expect(status.chapter).toBe(2)
      const hits = (await ctx.execute('novel_search', {
        query: '契纸',
        scope: ['canon'],
        chapter: 1,
        limit: 5,
      })) as { hits: unknown[] }
      expect(Array.isArray(hits.hits)).toBe(true)
    } finally {
      ctx.runtime.close()
      ctx.db.close()
    }
  })

  it('proposes a bible and outline, opens their gates, and reads them back', async () => {
    const ctx = await makeRuntime()
    try {
      const bible = (await ctx.execute('novel_bible', {
        action: 'propose',
        patch: {
          schema_version: 2,
          kind: 'BiblePlan',
          premise: '前提',
          themes: ['主题'],
          style: { guide: '短句。', fingerprint: {} },
          world: { rules: [], factions: [], locations: [], glossary: {} },
          characters: [],
          citations: [],
          open_questions: [],
        },
      })) as { ok: boolean; artifact: { id: string } }
      expect(bible.ok).toBe(true)
      const readBible = (await ctx.execute('novel_bible', { action: 'read' })) as { premise: string }
      expect(readBible.premise).toBeDefined()
      const outline = (await ctx.execute('novel_outline', {
        action: 'propose',
        content: {
          schema_version: 2,
          kind: 'OutlinePlan',
          logline: '一句话',
          acts: [{ id: 'a', title: '第一幕', summary: '开始' }],
          volumes: [{ id: 'v1', title: '第一卷', start_chapter: 1, end_chapter: 1, arc: '弧' }],
          chapters: [
            {
              chapter: 1,
              title: '第1章 开始',
              summary: '开始',
              scene_type: '日常过渡章',
              hook: '门外有人',
            },
          ],
          citations: [],
          open_questions: [],
        },
      })) as { ok: boolean; artifact: { id: string } }
      expect(outline.ok).toBe(true)
      const gates = ctx.runtime.directorAgent()
      expect(gates).toBeUndefined()
      const handle = await ctx.runtime.open()
      expect(handle.director.gates.pending(ctx.project.config.id)).toHaveLength(2)
      const artifact = (await ctx.execute('novel_artifact', {
        action: 'get',
        id: bible.artifact.id,
      })) as { kind: string }
      expect(artifact.kind).toBe('BiblePlan')
      await expect(
        ctx.execute('novel_artifact', { action: 'diff', left: bible.artifact.id }),
      ).rejects.toThrow(/left and right/u)

      expect(
        ((await ctx.execute('novel_artifact', { action: 'list', kind: 'BiblePlan', limit: 1 })) as unknown[])
          .length,
      ).toBe(1)
    } finally {
      ctx.runtime.close()
      ctx.db.close()
    }
  })

  it('starts, controls and interrupts runs through the model tool', async () => {
    const ctx = await makeRuntime()
    try {
      const started = (await ctx.execute('novel_run', {
        action: 'start',
        kind: 'chapter',
        chapter: 1,
      })) as { ok: boolean; run?: { id: string; status: string }; board?: { tasks: unknown[] } }
      expect(started.ok).toBe(true)
      const runId = started.run?.id ?? ''
      expect(runId).toBeTruthy()
      expect(['awaiting_human', 'running', 'completed']).toContain(started.run?.status)
      expect(
        ((await ctx.execute('novel_run', { action: 'cancel', run_id: runId })) as { ok: boolean }).ok,
      ).toBe(true)
      const handle = await ctx.runtime.open()
      const queued = handle.director.createChapterRun({ chapter: 2 })
      expect(
        ((await ctx.execute('novel_run', { action: 'pause', run_id: queued })) as { ok: boolean }).ok,
      ).toBe(true)
      expect(
        ((await ctx.execute('novel_run', { action: 'resume', run_id: queued })) as { ok: boolean }).ok,
      ).toBe(true)
      expect(
        ((await ctx.execute('novel_run', { action: 'tick', run_id: queued })) as { ok: boolean }).ok,
      ).toBe(true)
      expect(
        ((await ctx.execute('novel_run', { action: 'cancel', run_id: queued })) as { ok: boolean }).ok,
      ).toBe(true)
      expect(
        ((await ctx.execute('novel_run', { action: 'status' })) as { runs: unknown[] }).runs,
      ).toBeDefined()
      await expect(ctx.execute('novel_run', { action: 'pause' })).rejects.toThrow(/run_id/u)
      await expect(
        ctx.execute('novel_run', { action: 'start', kind: 'rewrite', chapter: 9 }),
      ).rejects.toThrow(/no draft/u)
    } finally {
      ctx.runtime.close()
      ctx.db.close()
    }
  })

  it('covers artifact, export and agent error paths', async () => {
    const ctx = await makeRuntime()
    try {
      await expect(ctx.execute('novel_artifact', { action: 'get' })).rejects.toThrow(/id is required/u)
      await expect(ctx.execute('novel_artifact', { action: 'get', id: 'missing' })).rejects.toThrow(
        /no artifact/u,
      )
      await expect(ctx.execute('novel_artifact', { action: 'restore' })).rejects.toThrow(/id is required/u)
      await expect(ctx.execute('novel_export', { kind: 'markdown' })).rejects.toThrow(/nothing to export/u)
      await expect(ctx.execute('novel_export', { kind: 'publish' })).rejects.toThrow(
        /nothing to export|no archived/u,
      )
      await expect(ctx.execute('novel_agent', { action: 'interrupt' })).rejects.toThrow(/run_id/u)
      await expect(
        ctx.execute('novel_agent', {
          action: 'message',
          run_id: 'r',
          role: 'drafter',
          message: 'hi',
        }),
      ).rejects.toThrow(/no live assignment|run_id/u)
      expect(
        ((await ctx.execute('novel_agent', { action: 'status' })) as { assignments: unknown[] }).assignments,
      ).toEqual([])
    } finally {
      ctx.runtime.close()
      ctx.db.close()
    }
  })

  it('drives a full archive/publish flow and all artifact/agent branches', async () => {
    const ctx = await makeRuntime()
    try {
      const started = (await ctx.execute('novel_run', {
        action: 'start',
        kind: 'chapter',
        chapter: 1,
      })) as { ok: boolean }
      expect(started.ok).toBe(true)
      const handle = await ctx.runtime.open()
      const gate = handle.director.gates.pending(ctx.project.config.id)[0]!
      const approved = (await ctx.execute(
        'novel_approve',
        { gate_id: gate.id, decision: 'approve', actor: 'host', reason: 'ok' },
        ctx.host,
      )) as { decisionArtifactId: string }
      expect(approved.decisionArtifactId).toBeTruthy()
      const ticked = (await ctx.execute('novel_run', { action: 'tick' })) as { ok: boolean }
      expect(ticked.ok).toBe(true)

      const publish = (await ctx.execute('novel_export', { kind: 'publish' })) as {
        ok: boolean
        gateId: string
      }
      expect(publish.ok).toBe(true)
      const publishApprove = (await ctx.execute(
        'novel_approve',
        { gate_id: publish.gateId, decision: 'approve', actor: 'host', reason: 'publish' },
        ctx.host,
      )) as { decisionArtifactId: string }
      expect(publishApprove.decisionArtifactId).toBeTruthy()
      const markdown = (await ctx.execute('novel_export', { kind: 'markdown' })) as { path: string }
      expect(markdown.path).toContain('exports/')

      const artifactRows = ctx.artifacts.list({ chapter: 1, limit: 100 })
      const drafts = artifactRows.filter((row) => row.kind === 'Draft')
      const decision = artifactRows.find((row) => row.kind === 'Decision')!
      expect(drafts.length).toBeGreaterThan(0)
      const diff = (await ctx.execute('novel_artifact', {
        action: 'diff',
        left: drafts[0]!.id,
        right: drafts[drafts.length - 1]!.id,
      })) as { diff: string }
      expect(diff.diff).toContain('---')
      const restored = (await ctx.execute('novel_artifact', {
        action: 'restore',
        id: drafts[0]!.id,
        reason: 'test',
      })) as { artifact: { id: string } }
      expect(restored.artifact.id).toBeTruthy()
      await expect(ctx.execute('novel_artifact', { action: 'restore', id: decision.id })).rejects.toThrow(
        /append-only/u,
      )

      const status = (await ctx.execute('novel_agent', { action: 'status' })) as {
        assignments: unknown[]
      }
      expect(status.assignments.length).toBeGreaterThan(0)
      const queued = handle.director.createChapterRun({ chapter: 2 })
      const interrupted = (await ctx.execute('novel_agent', {
        action: 'interrupt',
        run_id: queued,
      })) as { ok: boolean }
      expect(interrupted.ok).toBe(true)

      const book = (await ctx.execute('novel_run', { action: 'start', kind: 'book' })) as {
        ok: boolean
      }
      expect(book.ok).toBe(true)
      const bookRun = handle.director.board().runs.find((run) => run.kind === 'book')!
      handle.director.cancel(bookRun.id)
      const market = (await ctx.execute('novel_run', { action: 'start', kind: 'market' })) as {
        ok: boolean
      }
      expect(market.ok).toBe(true)
      const review = (await ctx.execute('novel_run', {
        action: 'start',
        kind: 'review',
        chapter: 1,
      })) as { ok: boolean }
      expect(review.ok).toBe(true)
      const rewrite = (await ctx.execute('novel_run', {
        action: 'start',
        kind: 'rewrite',
        chapter: 1,
      })) as { ok: boolean }
      expect(rewrite.ok).toBe(true)
    } finally {
      ctx.runtime.close()
      ctx.db.close()
    }
  })

  it('rejects duplicate proposal gates and duplicate init', async () => {
    const ctx = await makeRuntime()
    try {
      const bible = {
        schema_version: 2,
        kind: 'BiblePlan',
        premise: '前提',
        themes: ['主题'],
        style: { guide: '短句。', fingerprint: {} },
        world: { rules: [], factions: [], locations: [], glossary: {} },
        characters: [],
        citations: [],
        open_questions: [],
      }
      await ctx.execute('novel_bible', { action: 'propose', patch: bible })
      await expect(ctx.execute('novel_bible', { action: 'propose', patch: bible })).rejects.toThrow(
        /already awaiting/u,
      )
      const outline = {
        schema_version: 2,
        kind: 'OutlinePlan',
        logline: '一句话',
        acts: [{ id: 'a', title: '第一幕', summary: '开始' }],
        volumes: [{ id: 'v1', title: '第一卷', start_chapter: 1, end_chapter: 1, arc: '弧' }],
        chapters: [
          {
            chapter: 1,
            title: '第1章 开始',
            summary: '开始',
            scene_type: '日常过渡章',
            hook: '门外有人',
          },
        ],
        citations: [],
        open_questions: [],
      }
      await ctx.execute('novel_outline', { action: 'propose', content: outline })
      await expect(ctx.execute('novel_outline', { action: 'propose', content: outline })).rejects.toThrow(
        /already awaiting/u,
      )
      await expect(
        ctx.execute('novel_init', {
          title: '重复',
          genre: {
            major: 'mystery',
            sub: 'mystery.detective',
            tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
          },
          audience: 'general',
          platform: 'fanqie',
        }),
      ).rejects.toThrow(/exist|PROJECT_EXISTS/u)
    } finally {
      ctx.runtime.close()
      ctx.db.close()
    }
  })

  it('covers output rendering, missing agent, empty run and admin edge branches', async () => {
    const ctx = await makeRuntime()
    try {
      const statusTool = ctx.tools.get('novel_status') as unknown as {
        output: { render: (args: unknown, raw: unknown) => unknown }
      }
      expect(statusTool.output.render({}, 'plain')).toEqual([{ type: 'text', text: 'plain' }])
      expect(statusTool.output.render({}, { ok: true })).toEqual([
        { type: 'text', text: JSON.stringify({ ok: true }, null, 2) },
      ])
      await expect(ctx.execute('novel_run', { action: 'tick' })).rejects.toThrow(/no run exists/u)
      const runTool = ctx.tools.get('novel_run') as unknown as {
        execute: (args: unknown, exec: unknown) => Promise<unknown>
      }
      await expect(
        runTool.execute({ action: 'start', kind: 'chapter', chapter: 1 }, { agent: undefined }),
      ).rejects.toThrow(/live parent Agent/u)
      await expect(
        ctx.execute('novel_init', {
          title: '坏类型',
          project_root: join(ctx.root, 'bad-genre'),
          genre: { major: 'mystery', sub: 'mystery.detective', tags: ['no.such.tag'] },
          audience: 'general',
          platform: 'fanqie',
        }),
      ).rejects.toThrow(/tag|genre/u)
      await expect(ctx.execute('novel_agent', { action: 'message', run_id: 'r' })).rejects.toThrow(
        /run_id, role and message/u,
      )
      await expect(
        ctx.execute('novel_admin', { action: 'rewind', args: { target: 'nope' } }, ctx.host),
      ).rejects.toThrow(/artifact\/chapter\/run/u)
      await expect(
        (async () => {
          const { createHostActions } = await import('../src/adapters/tools/studio.js')
          return createHostActions({ runtime: ctx.runtime }).admin({ action: 'nope' as never })
        })(),
      ).rejects.toThrow(/unknown admin action/u)

      await ctx.project.store.ensureDir('.studio/backups')
      await ctx.project.store.writeText('.studio/backups/a.db', 'a')
      await ctx.project.store.writeText('.studio/backups/b.db', 'b')
      const pruned = (await ctx.execute('novel_admin', { action: 'prune', args: { keep: 1 } }, ctx.host)) as {
        removed: string[]
      }
      expect(pruned.removed.length).toBeGreaterThan(0)

      const draft = await ctx.artifacts.saveHumanEdit({
        kind: 'Draft',
        chapter: 1,
        content: {
          schema_version: 2,
          kind: 'Draft',
          chapter: 1,
          title: '第1章 工具',
          scene_type: '日常过渡章',
          narrator: '第三人称',
          content: '林砚把契纸合上，灯芯暗了一寸。',
          summary: {
            events: ['合上契纸'],
            characters_appeared: ['林砚'],
            foreshadows: { planted: [], advanced: [], resolved: [] },
            new_elements: { locations: [], abilities: [], artifacts: [] },
            resource_changes: [],
            opening: '林砚把契纸合上，灯芯暗了一寸。',
            continuity: { opens_from: '', ends_with: '' },
            hook_strength: 3,
            pleasure_points: [],
            plot_advancement: 'mid',
          },
          self_check: {
            word_count: 16,
            cjk_chars: 15,
            scene_contract: { goal: 'g', conflict: 'c', turn: 't', outcome: 'o' },
          },
          citations: [],
          open_questions: [],
          base_artifact_id: null,
          expected_hash: null,
        },
        baseHash: null,
        actor: 'test',
      })
      const row = ctx.artifacts.list({ kind: 'Draft', chapter: 1 })[0]!
      await ctx.project.store.remove(row.path)
      const doctor = (await ctx.execute('novel_admin', { action: 'doctor' }, ctx.host)) as {
        orphaned: string[]
      }
      expect(doctor.orphaned).toContain(draft.id)

      const runId = createRun(ctx.db.orm, {
        projectId: ctx.project.config.id,
        kind: 'chapter',
        targetChapter: 2,
        input: {},
      })
      const taskId = createTasks(ctx.db.orm, [
        { runId, role: 'drafter', kind: 'draft', dependsOn: [], input: { chapter: 2 } },
      ])[0]!
      claimTaskById(ctx.db.orm, { id: taskId, owner: 'test' })
      markTaskRunning(ctx.db.orm, taskId)
      createAssignment(ctx.db.orm, {
        taskId,
        provider: 'fake',
        preset: 'novel-role-drafter',
        agentSessionId: 'live-agent',
      })
      ctx.db.raw
        .prepare('UPDATE task SET lease_until = ? WHERE id = ?')
        .run('2000-01-01T00:00:00.000Z', taskId)
      const doctorLease = (await ctx.execute('novel_admin', { action: 'doctor' }, ctx.host)) as {
        expiredLeases: string[]
      }
      expect(doctorLease.expiredLeases).toContain(taskId)
      await expect(
        ctx.execute('novel_agent', {
          action: 'message',
          run_id: runId,
          role: 'drafter',
          message: 'hello',
        }),
      ).rejects.toThrow(/sendMessage|provider/u)
    } finally {
      ctx.runtime.close()
      ctx.db.close()
    }
  })

  it('covers host approval and admin actions', async () => {
    const ctx = await makeRuntime()
    try {
      await expect(
        ctx.execute(
          'novel_approve',
          {
            gate_id: 'missing',
            decision: 'approve',
            actor: 'host',
          },
          ctx.host,
        ),
      ).rejects.toThrow(/not awaiting a decision/u)
      const doctor = (await ctx.execute('novel_admin', { action: 'doctor' }, ctx.host)) as {
        integrity: string
      }
      expect(doctor.integrity).toBe('ok')
      const repaired = (await ctx.execute('novel_admin', { action: 'repair' }, ctx.host)) as {
        ok: boolean
      }
      expect(repaired.ok).toBe(true)
      const pruned = (await ctx.execute('novel_admin', { action: 'prune', args: { keep: 1 } }, ctx.host)) as {
        ok: boolean
      }
      expect(pruned.ok).toBe(true)
      const snapshot = (await ctx.execute('novel_admin', { action: 'snapshot' }, ctx.host)) as {
        path: string
      }
      expect(snapshot.path).toContain('.studio/snapshots/')
      const handle = await ctx.runtime.open()
      const { buildHumanDraft } = await import('../src/kernel/book/draft.js')
      const draft = buildHumanDraft({
        existing: null,
        chapter: 1,
        title: '第1章 工具',
        content: '林砚把契纸合上，灯芯暗了一寸。这一次他没有再翻页。',
        baseArtifactId: null,
        baseHash: null,
      })
      await handle.artifacts.saveHumanEdit({
        kind: 'Draft',
        chapter: 1,
        content: draft,
        baseHash: null,
        actor: 'test',
      })
      const rewound = (await ctx.execute(
        'novel_admin',
        { action: 'rewind', args: { target: 'chapter', chapter: 1 } },
        ctx.host,
      )) as { ok?: boolean; code?: string; runId?: string }
      expect(rewound.runId ?? rewound.ok ?? rewound.code).toBeDefined()
      await expect(ctx.execute('novel_admin', { action: 'import' }, ctx.host)).rejects.toThrow(
        /needs from and to/u,
      )
      await expect(ctx.execute('novel_admin', { action: 'nope' }, ctx.host)).rejects.toThrow(
        /invalid arguments|one of/u,
      )
    } finally {
      ctx.runtime.close()
      ctx.db.close()
    }
  })
})
