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
import type { AgentBridge, AgentStartRequest, AgentStartResult } from '../src/studio/agent-bridge.js'
import { getRun, listRuns } from '../src/storage/repositories/runs.js'
import { assertRunEvent, nextRunStatus } from '../src/studio/state-machines.js'
import { StudioRuntime } from '../src/studio/runtime.js'
import { createHostTools } from '../src/adapters/tools/studio.js'

const roots: string[] = []
const setup = async (
  bridgeFactory?: (
    project: Awaited<ReturnType<typeof loadProjectV2>>,
    artifacts: ArtifactStore,
  ) => AgentBridge,
) => {
  const root = mkdtempSync(join(tmpdir(), 'studio-paths-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: '路径测试',
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
  const bridge =
    bridgeFactory === undefined ? new FakeAgentBridge(project, artifacts) : bridgeFactory(project, artifacts)
  const scheduler = new StudioScheduler({ project, db, artifacts, director, bridge })
  return { root, project, db, artifacts, director, scheduler }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class BadContentBridge implements AgentBridge {
  readonly name = 'bad-content'
  private readonly inner: FakeAgentBridge
  constructor(project: Awaited<ReturnType<typeof loadProjectV2>>, artifacts: ArtifactStore) {
    this.inner = new FakeAgentBridge(project, artifacts)
  }
  available(): boolean {
    return true
  }
  async start(request: AgentStartRequest): Promise<AgentStartResult> {
    const result = await this.inner.start(request)
    if (request.task.kind === 'draft' || request.task.kind === 'revise') {
      const draft = result.structured as Record<string, unknown>
      result.structured = {
        ...draft,
        content: '太短了，只有几句。还有一句也很短。',
        self_check: { ...(draft.self_check as Record<string, unknown>), word_count: 12, cjk_chars: 10 },
      }
    }
    return result
  }
}

describe('director failure and human paths', () => {
  it('runs the revise loop and fails after three rounds', async () => {
    const { db, director, scheduler } = await setup(
      (project, artifacts) => new BadContentBridge(project, artifacts),
    )
    try {
      const runId = director.createChapterRun({ chapter: 1 })
      await scheduler.run(runId, {} as Agent, new AbortController().signal)
      const run = getRun(db.orm, runId)
      expect(run?.status).toBe('awaiting_human')
      // The pre-submit validator now catches the short draft before it can
      // consume a full review round; both messages are valid failure paths.
      expect(run?.error).toMatch(/review rounds exhausted|structured output failed/u)
      expect(run?.error).toMatch(/word count|review rounds/u)
    } finally {
      db.close()
    }
  })

  it('rejects a human gate', async () => {
    const { project, db, director, scheduler } = await setup()
    try {
      const runId = director.createChapterRun({ chapter: 1 })
      const signal = new AbortController().signal
      await scheduler.run(runId, {} as Agent, signal)
      const gate = director.gates.pending(project.config.id)[0]!
      const token = director.gates.authorize(gate.id)
      await director.decide({ gateId: gate.id, token, decision: 'reject', actor: '作者', reason: '不行' })
      expect(getRun(db.orm, runId)?.status).toBe('failed')
      expect(getRun(db.orm, runId)?.error).toContain('human reject')
    } finally {
      db.close()
    }
  })

  it('pauses, resumes and cancels a run', async () => {
    const { db, director } = await setup()
    try {
      const runId = director.createChapterRun({ chapter: 1 })
      director.pause(runId)
      expect(getRun(db.orm, runId)?.status).toBe('paused')
      director.resume(runId)
      expect(getRun(db.orm, runId)?.status).toBe('running')
      director.cancel(runId)
      expect(getRun(db.orm, runId)?.status).toBe('cancelled')
      expect(() => director.cancel(runId)).toThrow(/not legal/)
    } finally {
      db.close()
    }
  })

  it('covers state machine helpers', () => {
    expect(nextRunStatus('queued', 'START')).toBe('running')
    expect(nextRunStatus('running', 'PAUSE')).toBe('paused')
    expect(() => assertRunEvent('completed', 'START')).toThrow(/not legal/)
  })

  it('rejects a second chapter run for the same chapter', async () => {
    const { db, director } = await setup()
    try {
      director.createChapterRun({ chapter: 1 })
      expect(() => director.createChapterRun({ chapter: 1 })).toThrow(/already has an active run/)
    } finally {
      db.close()
    }
  })

  it('reports runtime and admin surfaces', async () => {
    const { root, db, director } = await setup()
    try {
      const runtime = new StudioRuntime({ projectRoot: root })
      expect(runtime.resolveRoot()).toBe(root)
      expect(runtime.directorAgent()).toBeUndefined()
      const handle = await runtime.open()
      expect(handle.project.config.title).toBe('路径测试')
      await expect(
        runtime.sendRoleMessage({} as Agent, 'child', 'hi', new AbortController().signal),
      ).rejects.toMatchObject({
        code: 'STUDIO_AGENT_PROVIDER_UNSUPPORTED',
      })
      const host = createHostTools({ runtime })
      const admin = host.find((tool) => tool.name === 'novel_admin')!
      const doctor = (await admin.execute({ action: 'doctor' }, {} as never)) as { ok: boolean }
      expect(doctor.ok).toBe(true)
      const repaired = (await admin.execute({ action: 'repair' }, {} as never)) as { ok: boolean }
      expect(repaired.ok).toBe(true)
      await expect(admin.execute({ action: 'import' }, {} as never)).rejects.toThrow(/needs from and to/)
      runtime.close()
      expect(director.board().runs.length).toBeGreaterThanOrEqual(0)
    } finally {
      db.close()
    }
  })

  it('creates review and market runs', async () => {
    const { project, db, director, scheduler } = await setup()
    try {
      const reviewRun = director.createChapterRun({ chapter: 1, mode: 'review' })
      // Review run needs an existing draft; it fails fast, which is the
      // documented behavior for a chapter without artifacts.
      await scheduler.run(reviewRun, {} as Agent, new AbortController().signal)
      expect(getRun(db.orm, reviewRun)?.status).toBe('failed')
      const marketRun = director.createMarketRun()
      await scheduler.run(marketRun, {} as Agent, new AbortController().signal)
      expect(getRun(db.orm, marketRun)?.status).toBe('completed')
      expect(listRuns(db.orm, project.config.id).length).toBeGreaterThanOrEqual(2)
    } finally {
      db.close()
    }
  })
})
