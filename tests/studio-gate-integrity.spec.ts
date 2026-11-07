import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { initProjectV2, loadProjectV2, saveProjectConfig } from '../src/kernel/project/layout.js'
import { openStudioDb } from '../src/storage/db.js'
import { ArtifactStore } from '../src/kernel/artifacts/store.js'
import { StudioDirector } from '../src/studio/director.js'
import { StudioScheduler } from '../src/studio/scheduler.js'
import { FakeAgentBridge } from '../src/studio/fake-bridge.js'
import type { AgentBridge } from '../src/studio/agent-bridge.js'
import { getRun, listTasks } from '../src/storage/repositories/runs.js'
import { insertGateResult } from '../src/storage/repositories/artifacts.js'
import { assertExportReady } from '../src/kernel/export/index.js'
import { DecisionSchema, StateDeltaSchema } from '../src/contracts/artifacts.js'

const roots: string[] = []

const makeProject = async (
  bridgeFactory?: (
    project: Awaited<ReturnType<typeof loadProjectV2>>,
    artifacts: ArtifactStore,
  ) => AgentBridge,
) => {
  const root = mkdtempSync(join(tmpdir(), 'studio-integrity-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: '门禁完整性',
    author: '测试',
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

const runToGate = async (ctx: Awaited<ReturnType<typeof makeProject>>) => {
  const runId = ctx.director.createChapterRun({ chapter: 1 })
  const signal = new AbortController().signal
  await ctx.scheduler.run(runId, {} as Agent, signal)
  const gate = ctx.director.gates.pending(ctx.project.config.id)[0]!
  return { runId, gate, signal }
}

const approveAndArchive = async (ctx: Awaited<ReturnType<typeof makeProject>>) => {
  const { runId, gate, signal } = await runToGate(ctx)
  const token = ctx.director.gates.authorize(gate.id)
  await ctx.director.decide({ gateId: gate.id, token, decision: 'approve', actor: '作者', reason: 'ok' })
  await ctx.scheduler.run(runId, {} as Agent, signal)
  expect(getRun(ctx.db.orm, runId)?.status).toBe('completed')
  return { runId }
}

describe('human gate receipts', () => {
  it('rejects archive when the draft changed after the human approved it', async () => {
    const ctx = await makeProject()
    try {
      const { runId, gate, signal } = await runToGate(ctx)
      const approvedDraft = (await ctx.artifacts.latest('Draft', 1))!
      const token = ctx.director.gates.authorize(gate.id)
      await ctx.director.decide({ gateId: gate.id, token, decision: 'approve', actor: '作者', reason: 'ok' })
      await ctx.artifacts.saveHumanEdit({
        kind: 'Draft',
        chapter: 1,
        content: {
          ...(approvedDraft.content as Record<string, unknown>),
          content: '门批准后另写的一段正文，新的草稿不在旧收据里。',
        },
        baseHash: approvedDraft.contentHash,
        actor: '作者',
      })
      await ctx.scheduler.run(runId, {} as Agent, signal)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('failed')
      expect(getRun(ctx.db.orm, runId)?.error).toMatch(/human approval|receipt|bind|approval|approve/u)
      expect(existsSync(join(ctx.root, 'manuscript', 'ch-0001.md'))).toBe(false)
    } finally {
      ctx.db.close()
    }
  })

  it('does not accept a role-submitted Decision as a human receipt', async () => {
    const ctx = await makeProject()
    try {
      const { runId, gate } = await runToGate(ctx)
      const draft = (await ctx.artifacts.latest('Draft', 1))!
      await ctx.artifacts.submit({
        kind: 'Decision',
        chapter: 1,
        content: DecisionSchema.parse({
          schema_version: 2,
          kind: 'Decision',
          gate: 'chapter',
          action: 'approve',
          target_artifact_id: draft.id,
          target_version: draft.version,
          actor: 'showrunner',
          reason: 'agent advice',
          approval_token: 'fake',
          at: new Date().toISOString(),
        }),
        provenance: {
          runId,
          taskId: 'role-decision',
          role: 'showrunner',
          preset: 'novel-role-showrunner',
          model: 'fake',
        },
        status: 'approved',
      })
      await ctx.artifacts.submit({
        kind: 'StateDelta',
        chapter: 1,
        content: StateDeltaSchema.parse({
          schema_version: 2,
          kind: 'StateDelta',
          chapter: 1,
          entities: [],
          relationships: [],
          timeline: [],
          foreshadows: [],
          resources: [],
          handoff: {},
        }),
        provenance: {
          runId,
          taskId: 'manual-delta',
          role: 'archivist',
          preset: 'novel-role-archivist',
        },
      })
      const archive = listTasks(ctx.db.orm, runId).find((task) => task.kind === 'archive')!
      await ctx.director.onTaskSettled(archive)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('failed')
      expect(getRun(ctx.db.orm, runId)?.error).toMatch(/receipt/u)
      expect(ctx.director.gates.pending(ctx.project.config.id)).toHaveLength(1)
      expect(gate.gate).toBe('chapter')
    } finally {
      ctx.db.close()
    }
  })

  it('keeps the publish gate open when the package fails and allows retry', async () => {
    const ctx = await makeProject()
    try {
      await approveAndArchive(ctx)
      ctx.project.config = await saveProjectConfig(ctx.project, {
        export_profile: {
          author_note: '',
          blurb: '',
          tags: [],
          cover_path: 'missing-cover.jpg',
          title_rule: '',
        },
      })
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
          decision: 'approve',
          actor: '作者',
          reason: 'publish',
        }),
      ).rejects.toMatchObject({ code: 'STUDIO_EXPORT_BLOCKED' })
      expect(ctx.director.gates.pending(ctx.project.config.id).some((row) => row.id === gate.id)).toBe(true)

      ctx.project.config = await saveProjectConfig(ctx.project, {
        export_profile: {
          author_note: '',
          blurb: '',
          tags: [],
          cover_path: null,
          title_rule: '',
        },
      })
      await ctx.director.decide({
        gateId: gate.id,
        token,
        decision: 'approve',
        actor: '作者',
        reason: 'retry',
      })
      expect(ctx.director.gates.pending(ctx.project.config.id).some((row) => row.id === gate.id)).toBe(false)
      expect((await ctx.artifacts.latest('Export', null))?.content).toMatchObject({ format: 'publish' })
    } finally {
      ctx.db.close()
    }
  })
})

describe('artifact version safety', () => {
  it('refuses to restore an audit Decision but restores a Draft', async () => {
    const ctx = await makeProject()
    try {
      await approveAndArchive(ctx)
      const decision = (await ctx.artifacts.latest('Decision', 1))!
      await expect(ctx.artifacts.restore(decision.id, '作者', 'forge')).rejects.toMatchObject({
        code: 'STUDIO_ARTIFACT_RESTORE_FORBIDDEN',
      })
      const draft = (await ctx.artifacts.latest('Draft', 1))!
      const restored = await ctx.artifacts.restore(draft.id, '作者', 'rewind')
      expect(restored.version).toBeGreaterThan(draft.version)
      expect(restored.baseArtifactId).toBe(draft.id)
    } finally {
      ctx.db.close()
    }
  })

  it('returns the stored bytes when the same task submits twice', async () => {
    const ctx = await makeProject()
    try {
      const draft = (await ctx.artifacts.latest('Draft', 1)) ?? null
      expect(draft).toBeNull()
      await approveAndArchive(ctx)
      const stored = (await ctx.artifacts.latest('Draft', 1))!
      const again = await ctx.artifacts.submit({
        kind: 'Draft',
        chapter: 1,
        content: stored.content,
        provenance: stored.provenance,
      })
      expect(again.id).toBe(stored.id)
      expect(again.content).toMatchObject({ content: (stored.content as { content: string }).content })
    } finally {
      ctx.db.close()
    }
  })

  it('rejects a revise draft that quotes a stale expected_hash', async () => {
    const ctx = await makeProject((project, artifacts) => new StaleReviseBridge(project, artifacts))
    try {
      await approveAndArchive(ctx)
      const rewrite = ctx.director.createChapterRun({ chapter: 1, mode: 'rewrite' })
      await ctx.scheduler.run(rewrite, {} as Agent, new AbortController().signal)
      expect(getRun(ctx.db.orm, rewrite)?.status).toBe('awaiting_human')
      expect(getRun(ctx.db.orm, rewrite)?.error).toMatch(/not based on the current draft/u)
    } finally {
      ctx.db.close()
    }
  })
})

describe('gate history', () => {
  it('lets the latest gate verdict supersede an older failure for export', async () => {
    const ctx = await makeProject()
    try {
      await approveAndArchive(ctx)
      const draft = (await ctx.artifacts.latest('Draft', 1))!
      insertGateResult(ctx.db.orm, {
        artifactId: draft.id,
        gate: 'PG-07',
        verdict: 'fail',
        details: { score: 10 },
      })
      insertGateResult(ctx.db.orm, {
        artifactId: draft.id,
        gate: 'PG-07',
        verdict: 'pass',
        details: { score: 130 },
      })
      await expect(assertExportReady(ctx.project, ctx.db, ctx.artifacts, [1])).resolves.toBeUndefined()
      insertGateResult(ctx.db.orm, {
        artifactId: draft.id,
        gate: 'PG-07',
        verdict: 'fail',
        details: { score: 10 },
      })
      await expect(assertExportReady(ctx.project, ctx.db, ctx.artifacts, [1])).rejects.toMatchObject({
        code: 'STUDIO_EXPORT_BLOCKED',
      })
    } finally {
      ctx.db.close()
    }
  })
})

describe('snapshot and rewind', () => {
  it('writes a manifest and detects later file mutation', async () => {
    const ctx = await makeProject()
    try {
      await ctx.project.store.ensureDir('manuscript')
      await ctx.project.store.writeText('manuscript/ch-0001.md', '原始正文。\n')
      const { createSnapshot, verifySnapshot } = await import('../src/kernel/export/snapshot.js')
      const snapshot = await createSnapshot(ctx.project)
      expect(snapshot.manifest.files.some((row) => row.path === 'manuscript/ch-0001.md')).toBe(true)
      expect((await verifySnapshot(ctx.project, snapshot.path)).ok).toBe(true)
      await ctx.project.store.writeText('manuscript/ch-0001.md', '被改写。\n')
      const verified = await verifySnapshot(ctx.project, snapshot.path)
      expect(verified.ok).toBe(false)
      expect(verified.problems.join('\n')).toMatch(/hash/u)
    } finally {
      ctx.db.close()
    }
  })

  it('rewinds an artifact into a new version and branches a rewrite run', async () => {
    const ctx = await makeProject()
    try {
      await approveAndArchive(ctx)
      const draft = (await ctx.artifacts.latest('Draft', 1))!
      const artifactRewind = await ctx.director.rewind({
        target: 'artifact',
        artifactId: draft.id,
        actor: '作者',
        reason: 'test',
      })
      expect(artifactRewind.artifact?.version).toBeGreaterThan(draft.version)
      const chapterRewind = await ctx.director.rewind({
        target: 'chapter',
        chapter: 1,
        actor: '作者',
        reason: 'test',
      })
      expect(chapterRewind.runId).toBeDefined()
      expect(getRun(ctx.db.orm, chapterRewind.runId!)?.kind).toBe('rewrite')
    } finally {
      ctx.db.close()
    }
  })
})

class StaleReviseBridge extends FakeAgentBridge {
  override async start(request: Parameters<FakeAgentBridge['start']>[0]) {
    const result = await super.start(request)
    if (request.role.id === 'drafter' && request.task.kind === 'revise') {
      const structured = structuredClone(result.structured) as Record<string, unknown>
      structured.expected_hash = 'stale-hash'
      return { ...result, structured }
    }
    return result
  }
}
