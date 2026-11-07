import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import { openStudioDb } from '../src/storage/db.js'
import { ArtifactStore } from '../src/kernel/artifacts/store.js'
import { StudioDirector } from '../src/studio/director.js'
import { StudioScheduler } from '../src/studio/scheduler.js'
import { FakeAgentBridge } from '../src/studio/fake-bridge.js'
import type { AgentBridge } from '../src/studio/agent-bridge.js'
import { getRun, listTasks, claimTaskById, refreshReadyTasks } from '../src/storage/repositories/runs.js'
import { listGateResults } from '../src/storage/repositories/artifacts.js'

const roots: string[] = []

const makeProject = async (
  bridgeFactory?: (
    project: Awaited<ReturnType<typeof loadProjectV2>>,
    artifacts: ArtifactStore,
  ) => AgentBridge,
) => {
  const root = mkdtempSync(join(tmpdir(), 'studio-e2e-'))
  roots.push(root)
  const { config } = await initProjectV2({
    root,
    title: '城南旧铺',
    author: '测试',
    genre: {
      major: 'mystery',
      sub: 'mystery.detective',
      tags: ['theme.mystery', 'plot.investigation', 'tone.cold', 'pace.fast', 'world.modern_city'],
    },
    audience: 'general',
    platform: 'fanqie',
    premise: '一个替人查账的年轻人在城南旧铺发现一叠契纸。',
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
  return { root, config, project, db, artifacts, director, scheduler }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('0.3.0 chapter pipeline', () => {
  it('runs plan -> draft -> 3 reviews -> continuity -> polish -> human gate -> archive', async () => {
    const { root, project, db, artifacts, director, scheduler } = await makeProject()
    try {
      const runId = director.createChapterRun({ chapter: 1 })
      const signal = new AbortController().signal
      await scheduler.run(runId, {} as Agent, signal)
      const waiting = getRun(db.orm, runId)
      if (waiting?.status === 'failed') {
        console.log('RUN ERROR', waiting.error)
        console.log(
          'TASKS',
          listTasks(db.orm, runId).map((row) => [row.kind, row.status, row.error]),
        )
      }
      expect(waiting?.status).toBe('awaiting_human')
      const pending = director.gates.pending(project.config.id)
      expect(pending).toHaveLength(1)
      expect(pending[0]!.gate).toBe('chapter')

      const draft = await artifacts.latest('Draft', 1)
      expect(draft).not.toBeNull()
      const gates = listGateResults(db.orm, draft!.id)
      expect(gates.some((row) => row.gate === 'PG-07' && row.verdict === 'pass')).toBe(true)
      expect(gates.some((row) => row.gate === 'EG-07' && row.verdict !== 'fail')).toBe(true)

      const token = director.gates.authorize(pending[0]!.id)
      await director.decide({
        gateId: pending[0]!.id,
        token,
        decision: 'approve',
        actor: '作者',
        reason: '通过',
      })
      await scheduler.run(runId, {} as Agent, signal)
      const done = getRun(db.orm, runId)
      expect(done?.status).toBe('completed')
      const manuscript = readFileSync(join(root, 'manuscript', 'ch-0001.md'), 'utf8')
      expect(manuscript.length).toBeGreaterThan(2000)
      expect(existsSync(join(root, 'state', 'canon.yaml'))).toBe(true)
      expect(existsSync(join(root, '.studio', 'studio.db'))).toBe(true)

      const tasks = listTasks(db.orm, runId)
      expect(tasks.filter((row) => row.status === 'completed').length).toBeGreaterThanOrEqual(9)
      const status = await director.status(1)
      expect(status.counts.archived).toBe(1)
      expect(status.run?.status).toBe('completed')
    } finally {
      db.close()
    }
  })

  it('runs ten chapters through four human gates without duplicate archives and publishes a package', async () => {
    const { root, project, db, artifacts, director, scheduler } = await makeProject()
    try {
      const signal = new AbortController().signal
      for (let chapter = 1; chapter <= 10; chapter += 1) {
        const runId = director.createChapterRun({ chapter })
        await scheduler.run(runId, {} as Agent, signal)
        expect(getRun(db.orm, runId)?.status).toBe('awaiting_human')
        const pending = director.gates.pending(project.config.id).filter((gate) => gate.gate === 'chapter')
        expect(pending).toHaveLength(1)
        const token = director.gates.authorize(pending[0]!.id)
        await director.decide({
          gateId: pending[0]!.id,
          token,
          decision: 'approve',
          actor: '作者',
          reason: `第 ${chapter} 章通过`,
        })
        await scheduler.run(runId, {} as Agent, signal)
        expect(getRun(db.orm, runId)?.status).toBe('completed')
        expect(existsSync(join(root, 'manuscript', `ch-${String(chapter).padStart(4, '0')}.md`))).toBe(true)
      }
      expect((await director.status(10)).counts.archived).toBe(10)

      const publishGate = director.gates.open({
        projectId: project.config.id,
        runId: 'publish',
        gate: 'publish',
      })
      const token = director.gates.authorize(publishGate.id)
      await director.decide({
        gateId: publishGate.id,
        token,
        decision: 'approve',
        actor: '作者',
        reason: '发布',
      })
      const exported = await artifacts.latest('Export', null)
      expect(exported).not.toBeNull()
      const content = exported!.content as { format: string; chapters: number[]; path: string }
      expect(content.format).toBe('publish')
      expect(content.chapters).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(existsSync(join(root, content.path, 'book.epub'))).toBe(true)
      expect(existsSync(join(root, content.path, 'metadata.yaml'))).toBe(true)
    } finally {
      db.close()
    }
  }, 120_000)

  it('recovers expired leases at plan and archive without duplicate chapters', async () => {
    const { root, project, db, director, scheduler } = await makeProject()
    try {
      const signal = new AbortController().signal
      const runId = director.createChapterRun({ chapter: 1 })
      refreshReadyTasks(db.orm, runId)
      const planTask = listTasks(db.orm, runId).find((row) => row.kind === 'plan')!
      const claimed = claimTaskById(db.orm, { id: planTask.id, owner: 'killed-worker', leaseMs: -1000 })
      expect(claimed?.status).toBe('leased')
      await scheduler.run(runId, {} as Agent, signal)
      expect(getRun(db.orm, runId)?.status).toBe('awaiting_human')

      const pending = director.gates.pending(project.config.id)[0]!
      const token = director.gates.authorize(pending.id)
      await director.decide({
        gateId: pending.id,
        token,
        decision: 'approve',
        actor: '作者',
        reason: '恢复测试',
      })
      const archive = listTasks(db.orm, runId).find((row) => row.kind === 'archive')!
      const claimedArchive = claimTaskById(db.orm, {
        id: archive.id,
        owner: 'killed-worker',
        leaseMs: -1000,
      })
      expect(claimedArchive?.status).toBe('leased')
      await scheduler.run(runId, {} as Agent, signal)
      expect(getRun(db.orm, runId)?.status).toBe('completed')
      const manuscript = readFileSync(join(root, 'manuscript', 'ch-0001.md'), 'utf8')
      await scheduler.run(runId, {} as Agent, signal)
      expect(readFileSync(join(root, 'manuscript', 'ch-0001.md'), 'utf8')).toBe(manuscript)
    } finally {
      db.close()
    }
  })

  it('runs a book bible/outline gate and a market run', async () => {
    const { project, db, artifacts, director, scheduler } = await makeProject()
    try {
      const runId = director.createBookRun()
      const signal = new AbortController().signal
      await scheduler.run(runId, {} as Agent, signal)
      const gate = director.gates.pending(project.config.id)[0]
      expect(gate?.gate).toBe('bible')
      const token = director.gates.authorize(gate!.id)
      await director.decide({ gateId: gate!.id, token, decision: 'approve', actor: '作者', reason: 'ok' })
      await scheduler.run(runId, {} as Agent, signal)
      const outlineGate = director.gates.pending(project.config.id)[0]
      expect(outlineGate?.gate).toBe('outline')
      const outlineToken = director.gates.authorize(outlineGate!.id)
      await director.decide({
        gateId: outlineGate!.id,
        token: outlineToken,
        decision: 'approve',
        actor: '作者',
        reason: 'ok',
      })
      await scheduler.run(runId, {} as Agent, signal)
      expect(getRun(db.orm, runId)?.status).toBe('completed')
      expect(existsSync(join(project.root, 'outline', 'chapters', 'ch-0001.yaml'))).toBe(true)
      expect(existsSync(join(project.root, 'bible', 'world', 'codex.yaml'))).toBe(true)

      const marketRun = director.createMarketRun()
      await scheduler.run(marketRun, {} as Agent, signal)
      expect(getRun(db.orm, marketRun)?.status).toBe('completed')
      const brief = await artifacts.latest('MarketBrief', null)
      expect(brief).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it('disposes a successful child agent after the task settles', async () => {
    let counted: CountingBridge | undefined
    const { db, director, scheduler } = await makeProject((project, artifacts) => {
      counted = new CountingBridge(project, artifacts)
      return counted
    })
    try {
      const runId = director.createChapterRun({ chapter: 1 })
      await scheduler.run(runId, {} as Agent, new AbortController().signal)
      expect(getRun(db.orm, runId)?.status).toBe('awaiting_human')
      expect(counted?.disposed).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('rejects stale review base_hash instead of trusting the reviewer', async () => {
    const { db, director, scheduler } = await makeProject(
      (project, artifacts) => new StaleHashBridge(project, artifacts),
    )
    try {
      const runId = director.createChapterRun({ chapter: 1 })
      await scheduler.run(runId, {} as Agent, new AbortController().signal)
      expect(getRun(db.orm, runId)?.status).toBe('awaiting_human')
      expect(listTasks(db.orm, runId).some((task) => task.kind.startsWith('review.'))).toBe(true)
    } finally {
      db.close()
    }
  })

  it('uses a real RewriteRun that starts from revise and blocks a second writer', async () => {
    const { project, db, director, scheduler } = await makeProject()
    try {
      const signal = new AbortController().signal
      const first = director.createChapterRun({ chapter: 1 })
      expect(() => director.createChapterRun({ chapter: 2 })).toThrow(/another writer run is active/u)
      await scheduler.run(first, {} as Agent, signal)
      const gate = director.gates.pending(project.config.id)[0]!
      const token = director.gates.authorize(gate.id)
      await director.decide({ gateId: gate.id, token, decision: 'approve', actor: '作者', reason: 'ok' })
      await scheduler.run(first, {} as Agent, signal)
      expect(getRun(db.orm, first)?.status).toBe('completed')

      const rewrite = director.createChapterRun({ chapter: 1, mode: 'rewrite' })
      expect(getRun(db.orm, rewrite)?.kind).toBe('rewrite')
      await scheduler.run(rewrite, {} as Agent, signal)
      expect(getRun(db.orm, rewrite)?.status).toBe('awaiting_human')
      expect(listTasks(db.orm, rewrite).some((task) => task.kind === 'revise')).toBe(true)
    } finally {
      db.close()
    }
  })

  it('turns an aborted run into cancelled instead of retrying the task', async () => {
    const { root, db, director, scheduler } = await makeProject(
      (project, artifacts) => new BlockingBridge(project, artifacts),
    )
    try {
      const runId = director.createChapterRun({ chapter: 1 })
      const controller = new AbortController()
      const running = scheduler.run(runId, {} as Agent, controller.signal)
      setTimeout(() => controller.abort(), 20)
      await running
      expect(getRun(db.orm, runId)?.status).toBe('cancelled')
      expect(existsSync(join(root, 'manuscript', 'ch-0001.md'))).toBe(false)
    } finally {
      db.close()
    }
  }, 60_000)
})

class CountingBridge extends FakeAgentBridge {
  disposed = 0
  override async start(request: Parameters<FakeAgentBridge['start']>[0]) {
    const result = await super.start(request)
    return {
      ...result,
      dispose: async () => {
        this.disposed += 1
        await result.dispose()
      },
    }
  }
}

class StaleHashBridge extends FakeAgentBridge {
  override async start(request: Parameters<FakeAgentBridge['start']>[0]) {
    const result = await super.start(request)
    if (request.role.id.startsWith('critic-') || request.role.id === 'continuity') {
      const structured = structuredClone(result.structured) as Record<string, unknown>
      structured.base_hash = 'stale-hash'
      return { ...result, structured }
    }
    return result
  }
}

class BlockingBridge extends FakeAgentBridge {
  override start(request: Parameters<FakeAgentBridge['start']>[0]) {
    return new Promise<never>((_resolve, reject) => {
      if (request.signal.aborted) {
        reject(new Error('aborted by test'))
        return
      }
      request.signal.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true })
    })
  }
}
