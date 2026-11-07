import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import { openStudioDb } from '../src/storage/db.js'
import { ArtifactStore } from '../src/kernel/artifacts/store.js'
import { StudioDirector } from '../src/studio/director.js'
import { StudioScheduler } from '../src/studio/scheduler.js'
import { FakeAgentBridge } from '../src/studio/fake-bridge.js'
import { createRun, createTasks, getRun, listTasks } from '../src/storage/repositories/runs.js'
import { loadBible, loadCanon } from '../src/kernel/book/store.js'
import { sha256Hex } from '../src/domain/hash.js'

const roots: string[] = []

const makeProject = async (
  bridgeFactory?: (
    project: Awaited<ReturnType<typeof loadProjectV2>>,
    artifacts: ArtifactStore,
  ) => import('../src/studio/agent-bridge.js').AgentBridge,
) => {
  const root = mkdtempSync(join(tmpdir(), 'director-deep-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: '导演边界',
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
  const db = openStudioDb(join(root, '.studio', 'studio.db'))
  const artifacts = new ArtifactStore(project, db)
  const director = new StudioDirector(project, db, artifacts)
  const scheduler = new StudioScheduler({
    project,
    db,
    artifacts,
    director,
    bridge: bridgeFactory?.(project, artifacts) ?? new FakeAgentBridge(project, artifacts),
  })
  return { root, project, db, artifacts, director, scheduler }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const toGate = async (ctx: Awaited<ReturnType<typeof makeProject>>) => {
  const runId = ctx.director.createChapterRun({ chapter: 1 })
  const signal = new AbortController().signal
  await ctx.scheduler.run(runId, {} as Agent, signal)
  const gate = ctx.director.gates.pending(ctx.project.config.id)[0]!
  return { runId, gate, signal }
}

const archive = async (ctx: Awaited<ReturnType<typeof makeProject>>) => {
  const { runId, gate, signal } = await toGate(ctx)
  const token = ctx.director.gates.authorize(gate.id)
  await ctx.director.decide({ gateId: gate.id, token, decision: 'approve', actor: '作者', reason: 'ok' })
  await ctx.scheduler.run(runId, {} as Agent, signal)
  return { runId, gate }
}

describe('director projection and control', () => {
  it('projects chapter stage and legal next actions across the lifecycle', async () => {
    const ctx = await makeProject()
    try {
      const { runId, gate, signal } = await toGate(ctx)
      const waiting = await ctx.director.status()
      expect(waiting.stage).toMatch(/polished|continuity/u)
      expect(waiting.next.action).toBe('human.approve')
      expect(waiting.blocking).toBeGreaterThanOrEqual(0)
      const token = ctx.director.gates.authorize(gate.id)
      await ctx.director.decide({ gateId: gate.id, token, decision: 'approve', actor: '作者', reason: 'ok' })
      await ctx.scheduler.run(runId, {} as Agent, signal)
      const archived = await ctx.director.status()
      expect(archived.stage).toBe('archived')
      expect(archived.next.action).toBe('run.start')
      expect(archived.counts.archived).toBe(1)
      const board = ctx.director.board()
      expect(board.tasks.every((task) => Array.isArray(task.dependsOn))).toBe(true)
      expect(board.gates).toHaveLength(0)
      expect(board.seq).toBeGreaterThan(0)
    } finally {
      ctx.db.close()
    }
  })

  it('rejects illegal pause/resume/cancel transitions', async () => {
    const ctx = await makeProject()
    try {
      const { runId, gate } = await toGate(ctx)
      expect(() => ctx.director.pause(runId)).toThrow(/not legal/u)
      expect(() => ctx.director.resume(runId)).toThrow(/human gate/u)
      const token = ctx.director.gates.authorize(gate.id)
      await ctx.director.decide({ gateId: gate.id, token, decision: 'approve', actor: '作者', reason: 'ok' })
      await ctx.scheduler.run(runId, {} as Agent, new AbortController().signal)
      expect(() => ctx.director.cancel(runId)).toThrow(/not legal/u)
      expect(() => ctx.director.pause('missing')).toThrow(/no run/u)
      expect(() => ctx.director.resume('missing')).toThrow(/no run/u)
      expect(() => ctx.director.cancel('missing')).toThrow(/no run/u)
    } finally {
      ctx.db.close()
    }
  })

  it('keeps book and prose runs mutually exclusive', async () => {
    const ctx = await makeProject()
    try {
      const book = ctx.director.createBookRun()
      expect(book).toBeTruthy()
      expect(() => ctx.director.createChapterRun({ chapter: 1 })).toThrow(/book run is active/u)
      expect(() => ctx.director.createBookRun()).toThrow(/structured run is active/u)
      ctx.director.cancel(book)
      const chapter = ctx.director.createChapterRun({ chapter: 1 })
      expect(chapter).toBeTruthy()
      expect(() => ctx.director.createBookRun()).toThrow(/structured run is active/u)
      ctx.director.cancel(chapter)
    } finally {
      ctx.db.close()
    }
  })

  it('refuses a fresh full run on an archived chapter but allows review/rewrite', async () => {
    const ctx = await makeProject()
    try {
      await archive(ctx)
      expect(() => ctx.director.createChapterRun({ chapter: 1 })).toThrow(/already archived/u)
      const review = ctx.director.createChapterRun({ chapter: 1, mode: 'review' })
      expect(getRun(ctx.db.orm, review)?.kind).toBe('review')
      ctx.director.cancel(review)
      const rewrite = ctx.director.createChapterRun({ chapter: 1, mode: 'rewrite' })
      expect(getRun(ctx.db.orm, rewrite)?.kind).toBe('rewrite')
      ctx.director.cancel(rewrite)
    } finally {
      ctx.db.close()
    }
  })

  it('rejects a bad approval token and a stale gate artifact', async () => {
    const ctx = await makeProject()
    try {
      const { gate } = await toGate(ctx)
      await expect(
        ctx.director.decide({
          gateId: gate.id,
          token: 'wrong',
          decision: 'approve',
          actor: '作者',
          reason: 'ok',
        }),
      ).rejects.toMatchObject({ code: 'STUDIO_APPROVAL_INVALID' })
      const draft = (await ctx.artifacts.latest('Draft', 1))!
      await ctx.artifacts.saveHumanEdit({
        kind: 'Draft',
        chapter: 1,
        content: {
          ...(draft.content as object),
          content: `${(draft.content as { content: string }).content}另加一段。`,
        },
        baseHash: draft.contentHash,
        actor: '作者',
      })
      const token = ctx.director.gates.authorize(gate.id)
      await expect(
        ctx.director.decide({
          gateId: gate.id,
          token,
          decision: 'approve',
          actor: '作者',
          reason: 'ok',
        }),
      ).rejects.toMatchObject({ code: 'STUDIO_HUMAN_GATE_REQUIRED' })
    } finally {
      ctx.db.close()
    }
  })

  it('applies a human edit only with content and closes the gate', async () => {
    const ctx = await makeProject()
    try {
      const { gate, runId } = await toGate(ctx)
      const token = ctx.director.gates.authorize(gate.id)
      await expect(
        ctx.director.decide({ gateId: gate.id, token, decision: 'edit', actor: '作者', reason: 'edit' }),
      ).rejects.toMatchObject({ code: 'STUDIO_APPROVAL_INVALID' })
      const edited = '林砚把契纸压回灯下，铜锁没有扣上。他听见门外第三级石阶响了一声。'
      const decided = await ctx.director.decide({
        gateId: gate.id,
        token,
        decision: 'edit',
        actor: '作者',
        reason: '人工改写',
        editedContent: edited,
      })
      const latest = (await ctx.artifacts.latest('Draft', 1))!
      expect((latest.content as { content: string }).content).toBe(edited)
      expect(latest.baseArtifactId).toBeTruthy()
      // The old run is closed; a review run re-reads the edited hash.
      expect(getRun(ctx.db.orm, runId)?.status).toBe('cancelled')
      expect(decided.nextRunId).toBeDefined()
      expect(getRun(ctx.db.orm, decided.nextRunId!)?.kind).toBe('review')
      expect(ctx.director.gates.pending(ctx.project.config.id)).toHaveLength(0)
    } finally {
      ctx.db.close()
    }
  })

  it('fails merge and archive cleanly when prerequisites are missing', async () => {
    const ctx = await makeProject()
    try {
      const runId = createRun(ctx.db.orm, {
        projectId: ctx.project.config.id,
        kind: 'chapter',
        targetChapter: 1,
        input: { chapter: 1 },
      })
      const [merge] = createTasks(ctx.db.orm, [
        {
          runId,
          role: 'showrunner',
          kind: 'review.merge',
          dependsOn: [],
          input: { chapter: 1, round: 1 },
        },
      ])
      await ctx.director.onTaskSettled(listTasks(ctx.db.orm, runId).find((task) => task.id === merge)!)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('failed')

      const archiveRun = createRun(ctx.db.orm, {
        projectId: ctx.project.config.id,
        kind: 'chapter',
        targetChapter: 2,
        input: { chapter: 2 },
      })
      const [archiveTask] = createTasks(ctx.db.orm, [
        {
          runId: archiveRun,
          role: 'archivist',
          kind: 'archive',
          dependsOn: [],
          input: { chapter: 2 },
        },
      ])
      await ctx.director.onTaskSettled(
        listTasks(ctx.db.orm, archiveRun).find((task) => task.id === archiveTask)!,
      )
      expect(getRun(ctx.db.orm, archiveRun)?.status).toBe('failed')
    } finally {
      ctx.db.close()
    }
  })

  it('rewinds a run by id into a rewrite run', async () => {
    const ctx = await makeProject()
    try {
      const { runId } = await archive(ctx)
      const rewound = await ctx.director.rewind({
        target: 'run',
        runId,
        actor: '作者',
        reason: 'run rewind',
      })
      expect(rewound.runId).toBeDefined()
      expect(getRun(ctx.db.orm, rewound.runId!)?.kind).toBe('rewrite')
      await expect(ctx.director.rewind({ target: 'run', actor: '作者', reason: 'x' })).rejects.toThrow(
        /runId/u,
      )
    } finally {
      ctx.db.close()
    }
  })
})

describe('director edge receipts and archive recovery', () => {
  it('fails book gates without an artifact and approve tasks without a draft', async () => {
    const ctx = await makeProject()
    try {
      const runId = createRun(ctx.db.orm, {
        projectId: ctx.project.config.id,
        kind: 'book',
        input: {},
      })
      const [bible] = createTasks(ctx.db.orm, [
        { runId, role: 'architect', kind: 'bible', dependsOn: [], input: {} },
      ])
      await ctx.director.onTaskSettled(listTasks(ctx.db.orm, runId).find((task) => task.id === bible)!)
      expect(listTasks(ctx.db.orm, runId)[0]!.status).toBe('failed')

      const approveRun = createRun(ctx.db.orm, {
        projectId: ctx.project.config.id,
        kind: 'chapter',
        targetChapter: 1,
        input: { chapter: 1 },
      })
      const [approve] = createTasks(ctx.db.orm, [
        { runId: approveRun, role: 'showrunner', kind: 'approve', dependsOn: [], input: { chapter: 1 } },
      ])
      await ctx.director.onTaskSettled(listTasks(ctx.db.orm, approveRun).find((task) => task.id === approve)!)
      expect(listTasks(ctx.db.orm, approveRun)[0]!.status).toBe('failed')
    } finally {
      ctx.db.close()
    }
  })

  it('rejects a gate whose artifact disappeared and bible edit decisions', async () => {
    const ctx = await makeProject()
    try {
      const { gate } = await toGate(ctx)
      const token = ctx.director.gates.authorize(gate.id)
      const row = ctx.artifacts.list({ kind: 'Draft', chapter: 1 })[0]!
      await ctx.project.store.remove(row.path)
      await expect(
        ctx.director.decide({ gateId: gate.id, token, decision: 'approve', actor: '作者', reason: 'ok' }),
      ).rejects.toMatchObject({ code: 'STUDIO_ARTIFACT_NOT_FOUND' })

      const bible = await ctx.artifacts.submit({
        kind: 'BiblePlan',
        chapter: null,
        content: {
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
        provenance: { runId: 'r', taskId: 'b1', role: 'architect', preset: 'novel-role-architect' },
      })
      const bibleGate = ctx.director.gates.open({
        projectId: ctx.project.config.id,
        runId: 'proposal',
        gate: 'bible',
        artifactId: bible.id,
      })
      const bibleToken = ctx.director.gates.authorize(bibleGate.id)
      await expect(
        ctx.director.decide({
          gateId: bibleGate.id,
          token: bibleToken,
          decision: 'edit',
          actor: '作者',
          reason: 'edit',
          editedContent: '正文。',
        }),
      ).rejects.toMatchObject({ code: 'STUDIO_APPROVAL_INVALID' })
    } finally {
      ctx.db.close()
    }
  })

  it('rejects an edit that fails the deterministic format gate', async () => {
    const ctx = await makeProject()
    try {
      const { gate } = await toGate(ctx)
      const token = ctx.director.gates.authorize(gate.id)
      await expect(
        ctx.director.decide({
          gateId: gate.id,
          token,
          decision: 'edit',
          actor: '作者',
          reason: 'edit',
          editedContent: '# 标题\n\n**加粗**',
        }),
      ).rejects.toMatchObject({ code: 'STUDIO_ARTIFACT_INVALID' })
    } finally {
      ctx.db.close()
    }
  })

  it('reports missing run/chapter/artifact targets for rewind', async () => {
    const ctx = await makeProject()
    try {
      await expect(
        ctx.director.rewind({ target: 'run', runId: 'missing', actor: 'a', reason: 'r' }),
      ).rejects.toMatchObject({ code: 'STUDIO_RUN_NOT_FOUND' })
      await expect(ctx.director.rewind({ target: 'chapter', actor: 'a', reason: 'r' })).rejects.toMatchObject(
        { code: 'STUDIO_RUN_STATE_INVALID' },
      )
      await expect(
        ctx.director.rewind({ target: 'artifact', artifactId: 'missing', actor: 'a', reason: 'r' }),
      ).rejects.toMatchObject({ code: 'STUDIO_ARTIFACT_NOT_FOUND' })
      await expect(
        ctx.director.rewind({ target: 'chapter', chapter: 2, actor: 'a', reason: 'r' }),
      ).rejects.toMatchObject({ code: 'STUDIO_ARTIFACT_NOT_FOUND' })
    } finally {
      ctx.db.close()
    }
  })

  it('survives a corrupt PG-07 details row and clamps chapter 0', async () => {
    const ctx = await makeProject()
    try {
      await toGate(ctx)
      ctx.db.raw.prepare("UPDATE gate_result SET details_json = '{broken' WHERE gate = 'PG-07'").run()
      const status = await ctx.director.status(0)
      expect(status.chapter).toBe(1)
      expect(status.score).toBeNull()
    } finally {
      ctx.db.close()
    }
  })
})

describe('director gate idempotency and pause projection', () => {
  it('does not reopen an existing book gate and fails approval without a plan', async () => {
    const ctx = await makeProject()
    try {
      const book = ctx.director.createBookRun()
      await ctx.scheduler.run(book, {} as Agent, new AbortController().signal)
      const bibleTask = listTasks(ctx.db.orm, book).find((task) => task.kind === 'bible')!
      expect(ctx.director.gates.pending(ctx.project.config.id).some((gate) => gate.gate === 'bible')).toBe(
        true,
      )
      await ctx.director.onTaskSettled(bibleTask)
      expect(
        ctx.director.gates.pending(ctx.project.config.id).filter((gate) => gate.gate === 'bible'),
      ).toHaveLength(1)
      ctx.director.cancel(book)

      const runId = createRun(ctx.db.orm, {
        projectId: ctx.project.config.id,
        kind: 'chapter',
        targetChapter: 3,
        input: { chapter: 3 },
      })
      const approve = createTasks(ctx.db.orm, [
        { runId, role: 'showrunner', kind: 'approve', dependsOn: [], input: { chapter: 3, round: 1 } },
      ])[0]!
      await ctx.director.onTaskSettled(listTasks(ctx.db.orm, runId).find((task) => task.id === approve)!)
      expect(listTasks(ctx.db.orm, runId)[0]!.status).toBe('failed')
    } finally {
      ctx.db.close()
    }
  })

  it('passes a review run and continues to the human gate', async () => {
    const ctx = await makeProject()
    try {
      await archive(ctx)
      const review = ctx.director.createChapterRun({ chapter: 1, mode: 'review' })
      await ctx.scheduler.run(review, {} as Agent, new AbortController().signal)
      expect(getRun(ctx.db.orm, review)?.status).toBe('awaiting_human')
      expect(listTasks(ctx.db.orm, review).some((task) => task.kind === 'polish')).toBe(true)
      expect(ctx.director.gates.pending(ctx.project.config.id).some((gate) => gate.gate === 'chapter')).toBe(
        true,
      )
    } finally {
      ctx.db.close()
    }
  })

  it('projects a paused run as resume in status.next', async () => {
    const ctx = await makeProject()
    try {
      const runId = ctx.director.createChapterRun({ chapter: 1 })
      ctx.director.pause(runId)
      expect((await ctx.director.status(1)).next.action).toBe('run.resume')
      ctx.director.cancel(runId)
      expect((await ctx.director.status(1)).next.action).toBe('run.start')
    } finally {
      ctx.db.close()
    }
  })
})

describe('human edit and rewind side effects', () => {
  it('edits a bible artifact and persists the edited version', async () => {
    const ctx = await makeProject()
    try {
      const bible = await ctx.artifacts.submit({
        kind: 'BiblePlan',
        chapter: null,
        content: {
          schema_version: 2,
          kind: 'BiblePlan',
          premise: '原前提',
          themes: ['主题'],
          style: { guide: '短句。', fingerprint: {} },
          world: { rules: [], factions: [], locations: [], glossary: {} },
          characters: [],
          citations: [],
          open_questions: [],
        },
        provenance: {
          runId: 'book-run',
          taskId: 'bible-edit',
          role: 'architect',
          preset: 'novel-role-architect',
        },
      })
      const gate = ctx.director.gates.open({
        projectId: ctx.project.config.id,
        runId: 'book-run',
        gate: 'bible',
        artifactId: bible.id,
      })
      const token = ctx.director.gates.authorize(gate.id)
      await expect(
        ctx.director.decide({ gateId: gate.id, token, decision: 'edit', actor: '作者', reason: 'edit' }),
      ).rejects.toMatchObject({ code: 'STUDIO_APPROVAL_INVALID' })
      await expect(
        ctx.director.decide({
          gateId: gate.id,
          token,
          decision: 'edit',
          actor: '作者',
          reason: 'edit',
          editedArtifact: { schema_version: 2, kind: 'BiblePlan' },
        }),
      ).rejects.toMatchObject({ code: 'STUDIO_ARTIFACT_INVALID' })
      const decided = await ctx.director.decide({
        gateId: gate.id,
        token,
        decision: 'edit',
        actor: '作者',
        reason: 'edit',
        editedArtifact: {
          schema_version: 2,
          kind: 'BiblePlan',
          premise: '人工改写的前提',
          themes: ['主题'],
          style: { guide: '短句。', fingerprint: {} },
          world: { rules: [], factions: [], locations: [], glossary: {} },
          characters: [],
          citations: [],
          open_questions: [],
        },
      })
      expect(decided.decisionArtifactId).toBeTruthy()
      expect((await loadBible(ctx.project.store)).premise.trim()).toBe('人工改写的前提')
      expect(ctx.director.gates.pending(ctx.project.config.id)).toHaveLength(0)
    } finally {
      ctx.db.close()
    }
  })

  it('refuses to edit a publish gate', async () => {
    const ctx = await makeProject()
    try {
      const gate = ctx.director.gates.open({
        projectId: ctx.project.config.id,
        runId: 'publish',
        gate: 'publish',
      })
      const token = ctx.director.gates.authorize(gate.id)
      await expect(
        ctx.director.decide({
          gateId: gate.id,
          token,
          decision: 'edit',
          actor: '作者',
          reason: 'edit',
          editedContent: '正文。',
        }),
      ).rejects.toMatchObject({ code: 'STUDIO_APPROVAL_INVALID' })
      expect(ctx.director.gates.pending(ctx.project.config.id)).toHaveLength(1)
    } finally {
      ctx.db.close()
    }
  })

  it('rejects a corrupt archive recovery marker', async () => {
    const ctx = await makeProject()
    try {
      const { gate, runId, signal } = await toGate(ctx)
      const token = ctx.director.gates.authorize(gate.id)
      await ctx.director.decide({ gateId: gate.id, token, decision: 'approve', actor: '作者', reason: 'ok' })
      const draft = (await ctx.artifacts.latest('Draft', 1))!
      const body = `${(draft.content as { content: string }).content.trim()}\n`
      await ctx.project.store.ensureDir('manuscript')
      await ctx.project.store.writeText('manuscript/ch-0001.md', body)
      await ctx.project.store.ensureDir('.studio/archive')
      await ctx.project.store.writeText('.studio/archive/ch-0001.json', '{broken')
      await ctx.scheduler.run(runId, {} as Agent, signal)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('awaiting_human')
      expect(getRun(ctx.db.orm, runId)?.error).toMatch(/corrupt|not valid JSON/u)
    } finally {
      ctx.db.close()
    }
  })

  it('rejects a marker that belongs to another draft and recovers a matching one', async () => {
    const ctx = await makeProject()
    try {
      const { gate, runId, signal } = await toGate(ctx)
      const token = ctx.director.gates.authorize(gate.id)
      await ctx.director.decide({ gateId: gate.id, token, decision: 'approve', actor: '作者', reason: 'ok' })
      const draft = (await ctx.artifacts.latest('Draft', 1))!
      const body = `${(draft.content as { content: string }).content.trim()}\n`
      const hash = sha256Hex(body)
      await ctx.project.store.ensureDir('manuscript')
      await ctx.project.store.writeText('manuscript/ch-0001.md', body)
      await ctx.project.store.ensureDir('.studio/archive')
      await ctx.project.store.writeText(
        '.studio/archive/ch-0001.json',
        JSON.stringify({ chapter: 1, draftHash: 'stale-hash', canon: await loadCanon(ctx.project.store) }),
      )
      await ctx.scheduler.run(runId, {} as Agent, signal)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('awaiting_human')
      expect(getRun(ctx.db.orm, runId)?.error).toMatch(/does not belong/u)

      // A matching marker is the crash-recovery path: canon is restored and
      // the archive task completes without rewriting the manuscript.
      await ctx.project.store.writeText(
        '.studio/archive/ch-0001.json',
        JSON.stringify({ chapter: 1, draftHash: hash, canon: await loadCanon(ctx.project.store) }),
      )
      const archiveTask = listTasks(ctx.db.orm, runId).find((task) => task.kind === 'archive')!
      await ctx.director.onTaskSettled(archiveTask)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('completed')
      expect(await ctx.project.store.readText('.studio/archive/ch-0001.json')).toBeNull()
    } finally {
      ctx.db.close()
    }
  })

  it('retires archived prose into history before a chapter rewind', async () => {
    const ctx = await makeProject()
    try {
      await archive(ctx)
      expect(await ctx.project.store.readText('manuscript/ch-0001.md')).not.toBeNull()
      const rewound = await ctx.director.rewind({
        target: 'chapter',
        chapter: 1,
        actor: '作者',
        reason: 'rewrite',
      })
      expect(rewound.runId).toBeDefined()
      expect(await ctx.project.store.readText('manuscript/ch-0001.md')).toBeNull()
      expect((await ctx.project.store.list('.studio/history/manuscript')).length).toBeGreaterThan(0)
      expect((await ctx.director.status(1)).stage).not.toBe('archived')
      ctx.director.cancel(rewound.runId!)
    } finally {
      ctx.db.close()
    }
  })
})
