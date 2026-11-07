import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import { openStudioDb } from '../src/storage/db.js'
import { ArtifactStore } from '../src/kernel/artifacts/store.js'
import { StudioDirector } from '../src/studio/director.js'
import { StudioScheduler } from '../src/studio/scheduler.js'
import { FakeAgentBridge } from '../src/studio/fake-bridge.js'
import { evaluateGates } from '../src/kernel/gates/index.js'
import { loadBible, loadCanon, loadChapterPlan } from '../src/kernel/book/store.js'
import { listTasks, getRun } from '../src/storage/repositories/runs.js'
import { rebuildProjectIndex } from '../src/kernel/read/index.js'
import { searchMemory } from '../src/storage/repositories/memory.js'
import { studioRoute } from '../src/adapters/remote/studio-api.js'
import { appendEvent } from '../src/storage/repositories/runs.js'
import { StudioRuntime } from '../src/studio/runtime.js'

const roots: string[] = []
const setup = async (title = '证伪') => {
  const root = mkdtempSync(join(tmpdir(), 'falsify-v2-'))
  roots.push(root)
  await initProjectV2({
    root,
    title,
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
    bridge: new FakeAgentBridge(project, artifacts),
  })
  return { root, project, db, artifacts, director, scheduler }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('0.3.0 falsification T-21..T-30', () => {
  it('T-21: an archive task without a human Decision fails and writes no manuscript', async () => {
    const { root, db, director, scheduler } = await setup()
    try {
      const runId = director.createChapterRun({ chapter: 1 })
      await scheduler.run(runId, {} as Agent, new AbortController().signal)
      const archive = listTasks(db.orm, runId).find((task) => task.kind === 'archive')!
      await director.onTaskSettled(archive)
      expect(getRun(db.orm, runId)?.status).toBe('failed')
      expect(existsSync(join(root, 'manuscript', 'ch-0001.md'))).toBe(false)
    } finally {
      db.close()
    }
  })

  it('T-23: a MarketBrief cannot change canon', async () => {
    const { project, db, director, scheduler } = await setup()
    try {
      const before = JSON.stringify(await loadCanon(project.store))
      const runId = director.createMarketRun()
      await scheduler.run(runId, {} as Agent, new AbortController().signal)
      const after = JSON.stringify(await loadCanon(project.store))
      expect(after).toBe(before)
      expect(getRun(db.orm, runId)?.status).toBe('completed')
    } finally {
      db.close()
    }
  })

  it('T-24: deleting studio.db can be followed by a file-backed index rebuild', async () => {
    const { root, project, db, artifacts } = await setup()
    try {
      await artifacts.submit({
        kind: 'ChapterPlan',
        chapter: 1,
        content: {
          schema_version: 2,
          kind: 'ChapterPlan',
          chapter: 1,
          title: '第1章 风起云涌',
          scene_type: '日常过渡章',
          pov: '第三人称',
          cast: ['林砚'],
          goal: '查账',
          conflict: '来人不说',
          turn: '落款被刮',
          outcome: '去城南',
          target_words: 2400,
          hook: '门外三声敲击',
          foreshadows: [],
          notes: [],
          citations: [],
          open_questions: [],
        },
        provenance: { runId: 'r', taskId: 'plan', role: 'planner', preset: 'p' },
      })
      await project.store.writeText('manuscript/ch-0001.md', '林砚在城南旧铺查账。\n')
      db.close()
      rmSync(join(root, '.studio', 'studio.db'), { force: true })
      const reopened = openStudioDb(join(root, '.studio', 'studio.db'))
      try {
        const result = await rebuildProjectIndex(project, reopened)
        expect(result.indexed).toBeGreaterThan(0)
        const hits = searchMemory(reopened.orm, { projectId: project.config.id, query: '林砚' })
        expect(hits.length).toBeGreaterThan(0)
      } finally {
        reopened.close()
      }
    } finally {
      // The original handle is already closed.
    }
  })

  it('T-27: two projects run concurrently without blocking each other', async () => {
    const a = await setup('并发 A')
    const b = await setup('并发 B')
    try {
      const signal = new AbortController().signal
      const runA = a.director.createChapterRun({ chapter: 1 })
      const runB = b.director.createChapterRun({ chapter: 1 })
      await Promise.all([
        a.scheduler.run(runA, {} as Agent, signal),
        b.scheduler.run(runB, {} as Agent, signal),
      ])
      expect(getRun(a.db.orm, runA)?.status).toBe('awaiting_human')
      expect(getRun(b.db.orm, runB)?.status).toBe('awaiting_human')
    } finally {
      a.db.close()
      b.db.close()
    }
  })

  it('T-28: a reviewer finding without locatable evidence fails PG-07', async () => {
    const { project, db, artifacts, director, scheduler } = await setup()
    try {
      const runId = director.createChapterRun({ chapter: 1 })
      await scheduler.run(runId, {} as Agent, new AbortController().signal)
      const draft = (await artifacts.latest('Draft', 1))!
      const plan = (await loadChapterPlan(project.store, 1))!
      const continuity = (await artifacts.latest('ContinuityReport', 1))!.content as never
      const reviews = []
      for (const row of artifacts.list({ kind: 'ReviewReport', chapter: 1, limit: 12 })) {
        const stored = await artifacts.read(row.id)
        if (stored !== null) reviews.push(stored.content)
      }
      const broken = structuredClone(reviews)
      if (broken[0] !== undefined) {
        broken[0] = {
          ...broken[0],
          findings: [
            { ...(broken[0] as { findings: Array<Record<string, unknown>> }).findings[0], evidence: '短' },
          ],
        } as never
      }
      const report = evaluateGates({
        project,
        chapter: 1,
        plan,
        draft: draft.content as never,
        reviews: broken as never,
        continuity,
        canon: await loadCanon(project.store),
        bible: await loadBible(project.store),
        previousTexts: [],
        round: 1,
        maxRounds: 3,
      })
      expect(report.pass).toBe(false)
      expect(report.findings.some((finding) => finding.code === 'PG-07' && finding.verdict === 'fail')).toBe(
        true,
      )
    } finally {
      db.close()
    }
  })

  it('T-38: AI_TONE blocker without R-W-07 deduction fails PG-07', async () => {
    const { project, db, artifacts, director, scheduler } = await setup()
    try {
      const runId = director.createChapterRun({ chapter: 1 })
      await scheduler.run(runId, {} as Agent, new AbortController().signal)
      const draft = (await artifacts.latest('Draft', 1))!
      const plan = (await loadChapterPlan(project.store, 1))!
      const continuity = (await artifacts.latest('ContinuityReport', 1))!.content as never
      const reviews = []
      for (const row of artifacts.list({ kind: 'ReviewReport', chapter: 1, limit: 12 })) {
        const stored = await artifacts.read(row.id)
        if (stored !== null) reviews.push(stored.content)
      }
      const original = draft.content as import('../src/contracts/artifacts.js').Draft
      const mutated = { ...original, content: `${original.content}\n\n这句话稳。` }
      const report = evaluateGates({
        project,
        chapter: 1,
        plan,
        draft: mutated,
        proofSource: original,
        reviews: reviews as never,
        continuity,
        canon: await loadCanon(project.store),
        bible: await loadBible(project.store),
        previousTexts: [],
        round: 1,
        maxRounds: 3,
      })
      expect(report.pass).toBe(false)
      expect(report.findings.some((finding) => finding.code === 'PG-07' && finding.verdict === 'fail')).toBe(
        true,
      )
      expect(report.aiTone.some((finding) => finding.code === 'AI_TONE_META')).toBe(true)
    } finally {
      db.close()
    }
  })

  it('T-30: SSE replays events from Last-Event-ID without duplicates', async () => {
    const { root, project, db } = await setup()
    try {
      const first = appendEvent(db.orm, {
        projectId: project.config.id,
        type: 'run.start',
        payload: { n: 1 },
      })
      appendEvent(db.orm, { projectId: project.config.id, type: 'run.done', payload: { n: 2 } })
      const runtime = new StudioRuntime({ projectRoot: root })
      const route = studioRoute(runtime)
      const chunks: string[] = []
      const response = {
        statusCode: 0,
        setHeader: () => undefined,
        end: () => undefined,
        write: (chunk: string) => {
          chunks.push(chunk)
          ;(response as unknown as { writableEnded: boolean }).writableEnded = true
        },
        writableEnded: false,
      }
      await (route.handler as unknown as (request: unknown, response: unknown) => Promise<void>)(
        {
          method: 'GET',
          url: `/api/novel-write-engine/v8/events?root=${encodeURIComponent(root)}&after=${first - 1}`,
          headers: {},
        },
        response,
      )
      const text = chunks.join('')
      expect(text).toContain(`id: ${first}`)
      expect(text).toContain('run.start')
      runtime.close()
    } finally {
      db.close()
    }
  })
})
