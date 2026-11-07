import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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
import { createRun, createTasks, getRun, listTasks, recordUsage } from '../src/storage/repositories/runs.js'
import { countWordMetrics } from '../src/domain/wordcount.js'
import type { Draft } from '../src/contracts/artifacts.js'

const roots: string[] = []

const makeProject = async (
  bridge: (project: Awaited<ReturnType<typeof loadProjectV2>>, artifacts: ArtifactStore) => AgentBridge,
) => {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-deep-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: '调度边界',
    genre: {
      major: 'mystery',
      sub: 'mystery.detective',
      tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
    },
    audience: 'general',
    platform: 'fanqie',
    targets: { total_chapters: 2, words_per_chapter: [2200, 3200] },
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
    bridge: bridge(project, artifacts),
  })
  return { root, project, db, artifacts, director, scheduler }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('scheduler failure and budget paths', () => {
  it('fails a run after max attempts when no bridge is available', async () => {
    const ctx = await makeProject(() => ({
      name: 'none',
      available: () => false,
      start: async () => {
        throw new Error('unreachable')
      },
    }))
    try {
      const runId = ctx.director.createChapterRun({ chapter: 1 })
      await ctx.scheduler.run(runId, {} as Agent, new AbortController().signal)
      const run = getRun(ctx.db.orm, runId)!
      expect(run.status).toBe('awaiting_human')
      expect(run.error).toMatch(/bridge|provider|structured|available/u)
      expect(listTasks(ctx.db.orm, runId).some((task) => task.attempt >= 3)).toBe(true)
      // Without a pending gate, the next action is a human cleanup step rather
      // than an ineffective tick.
      expect((await ctx.director.status()).next.action).toBe('run.cancel')
    } finally {
      ctx.db.close()
    }
  })

  it('repairs one malformed structured output instead of failing the task', async () => {
    class RepairBridge extends FakeAgentBridge {
      calls = 0
      override async start(request: Parameters<FakeAgentBridge['start']>[0]) {
        this.calls += 1
        const result = await super.start(request)
        if (request.task.kind === 'plan' && this.calls === 1) {
          return { ...result, structured: { broken: true } }
        }
        return result
      }
    }
    let bridge: RepairBridge | undefined
    const ctx = await makeProject((project, artifacts) => {
      bridge = new RepairBridge(project, artifacts)
      return bridge
    })
    try {
      const runId = ctx.director.createChapterRun({ chapter: 1 })
      await ctx.scheduler.run(runId, {} as Agent, new AbortController().signal)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('awaiting_human')
      expect(bridge?.calls).toBeGreaterThan(1)
      expect(listTasks(ctx.db.orm, runId).find((task) => task.kind === 'plan')?.status).toBe('completed')
    } finally {
      ctx.db.close()
    }
  })

  it('pauses before starting a new assignment when the run budget is exhausted', async () => {
    const ctx = await makeProject((project, artifacts) => new FakeAgentBridge(project, artifacts))
    try {
      ctx.project.config = await saveProjectConfig(ctx.project, {
        budgets: { per_chapter_usd: 0.001, per_run_usd: 0.001, per_task_tokens: 10 },
      })
      const runId = ctx.director.createChapterRun({ chapter: 1 })
      recordUsage(ctx.db.orm, {
        runId,
        taskId: 'seed',
        role: 'planner',
        model: 'fake',
        promptTokens: 100,
        completionTokens: 100,
        costUsd: 1,
      })
      await ctx.scheduler.run(runId, {} as Agent, new AbortController().signal)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('paused')
      expect(listTasks(ctx.db.orm, runId).some((task) => task.status === 'retry_wait')).toBe(true)
    } finally {
      ctx.db.close()
    }
  })

  it('marks a running run failed when its task DAG is corrupt', async () => {
    const ctx = await makeProject((project, artifacts) => new FakeAgentBridge(project, artifacts))
    try {
      const runId = createRun(ctx.db.orm, {
        projectId: ctx.project.config.id,
        kind: 'chapter',
        targetChapter: 1,
        input: { chapter: 1 },
      })
      createTasks(ctx.db.orm, [
        {
          runId,
          role: 'planner',
          kind: 'plan',
          dependsOn: ['missing-task'],
          input: { chapter: 1 },
        },
      ])
      await expect(ctx.scheduler.run(runId, {} as Agent, new AbortController().signal)).rejects.toMatchObject(
        { code: 'STUDIO_TASK_STATE_INVALID' },
      )
      expect(getRun(ctx.db.orm, runId)?.status).toBe('failed')
    } finally {
      ctx.db.close()
    }
  })

  it('maps max-token and refusal stop reasons to assignment states', async () => {
    const ctx = await makeProject((project, artifacts) => {
      const base = new FakeAgentBridge(project, artifacts)
      return {
        name: 'stop-reason',
        available: () => true,
        start: async (request) => {
          const result = await base.start(request)
          return {
            ...result,
            stopReason: request.task.kind === 'plan' ? 'max-tokens' : 'refusal',
          }
        },
      }
    })
    try {
      const runId = ctx.director.createChapterRun({ chapter: 1 })
      await ctx.scheduler.run(runId, {} as Agent, new AbortController().signal)
      const assignments = ctx.director.board().assignments
      expect(assignments.some((row) => row.status === 'max_tokens')).toBe(true)
      expect(assignments.some((row) => row.status === 'refusal')).toBe(true)
    } finally {
      ctx.db.close()
    }
  })

  it('cancels immediately when the caller signal is already aborted', async () => {
    const ctx = await makeProject((project, artifacts) => new FakeAgentBridge(project, artifacts))
    try {
      const runId = ctx.director.createChapterRun({ chapter: 1 })
      const controller = new AbortController()
      controller.abort()
      await ctx.scheduler.run(runId, {} as Agent, controller.signal)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('cancelled')
    } finally {
      ctx.db.close()
    }
  })

  it('records an aborted stop reason and rejects an unknown role', async () => {
    class AbortedBridge extends FakeAgentBridge {
      override async start(request: Parameters<FakeAgentBridge['start']>[0]) {
        const result = await super.start(request)
        return { ...result, stopReason: 'aborted' }
      }
    }
    const ctx = await makeProject((project, artifacts) => new AbortedBridge(project, artifacts))
    try {
      const runId = ctx.director.createChapterRun({ chapter: 1 })
      await ctx.scheduler.run(runId, {} as Agent, new AbortController().signal)
      expect(ctx.director.board().assignments.some((row) => row.status === 'aborted')).toBe(true)

      const bad = createRun(ctx.db.orm, {
        projectId: ctx.project.config.id,
        kind: 'chapter',
        targetChapter: 2,
        input: { chapter: 2 },
      })
      createTasks(ctx.db.orm, [
        { runId: bad, role: 'nope' as never, kind: 'plan', dependsOn: [], input: { chapter: 2 } },
      ])
      await ctx.scheduler.run(bad, {} as Agent, new AbortController().signal)
      expect(getRun(ctx.db.orm, bad)?.status).toBe('awaiting_human')
    } finally {
      ctx.db.close()
    }
  })

  it('falls back to chapter 1 when a task input JSON is corrupt', async () => {
    const ctx = await makeProject((project, artifacts) => new FakeAgentBridge(project, artifacts))
    try {
      const runId = createRun(ctx.db.orm, {
        projectId: ctx.project.config.id,
        kind: 'chapter',
        targetChapter: 1,
        input: { chapter: 1 },
      })
      const taskId = createTasks(ctx.db.orm, [
        { runId, role: 'planner', kind: 'plan', dependsOn: [], input: { chapter: 1 } },
      ])[0]!
      ctx.db.raw.prepare('UPDATE task SET input_json = ? WHERE id = ?').run('{broken', taskId)
      await ctx.scheduler.run(runId, {} as Agent, new AbortController().signal)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('completed')
      expect(listTasks(ctx.db.orm, runId)[0]!.status).toBe('completed')
    } finally {
      ctx.db.close()
    }
  })

  it('creates a revision round when a critic reports a blocker, then passes', async () => {
    class OneBlockerBridge extends FakeAgentBridge {
      first = true
      override async start(request: Parameters<FakeAgentBridge['start']>[0]) {
        const result = await super.start(request)
        if (request.task.kind === 'review.story' && this.first) {
          this.first = false
          const data = structuredClone(result.structured) as {
            findings: unknown[]
            proof: { opening: { quote: string } }
          }
          data.findings = [
            {
              id: 'blocker-1',
              dimension: 'R-W-04',
              severity: 'blocker',
              location: '开头',
              evidence: data.proof.opening.quote,
              problem: '开局拖沓',
              fix: '加快',
              status: 'open',
            },
          ]
          return { ...result, structured: data }
        }
        return result
      }
    }
    const ctx = await makeProject((project, artifacts) => new OneBlockerBridge(project, artifacts))
    try {
      const runId = ctx.director.createChapterRun({ chapter: 1 })
      await ctx.scheduler.run(runId, {} as Agent, new AbortController().signal)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('awaiting_human')
      const tasks = listTasks(ctx.db.orm, runId)
      expect(tasks.filter((task) => task.kind === 'revise')).toHaveLength(1)
      expect(tasks.filter((task) => task.kind === 'review.story')).toHaveLength(2)
      expect(tasks.every((task) => task.status !== 'failed')).toBe(true)
      // Replaying a merge task is idempotent: the revision round already exists
      // and must not be duplicated.
      const merge = tasks.find((task) => task.kind === 'review.merge')!
      const before = tasks.length
      await ctx.director.onTaskSettled(merge)
      expect(listTasks(ctx.db.orm, runId)).toHaveLength(before)
    } finally {
      ctx.db.close()
    }
  })

  it('expands a short real quote to its full sentence instead of repairing', async () => {
    class ShortEvidenceBridge extends FakeAgentBridge {
      first = true
      override async start(request: Parameters<FakeAgentBridge['start']>[0]) {
        const result = await super.start(request)
        if (request.task.kind === 'continuity.precheck' && this.first) {
          this.first = false
          const data = structuredClone(result.structured) as { findings: unknown[] }
          data.findings = [
            {
              id: 'short-quote',
              kind: 'canon',
              severity: 'advisory',
              location: '开头',
              evidence: '雨',
              problem: '证据太短',
              fix: '扩展引用',
              status: 'open',
            },
          ]
          return { ...result, structured: data }
        }
        return result
      }
    }
    const ctx = await makeProject((project, artifacts) => new ShortEvidenceBridge(project, artifacts))
    try {
      const runId = ctx.director.createChapterRun({ chapter: 1 })
      await ctx.scheduler.run(runId, {} as Agent, new AbortController().signal)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('awaiting_human')
      const reports = ctx.artifacts.list({ kind: 'ContinuityReport', chapter: 1, limit: 10 })
      const findings = await Promise.all(reports.map((row) => ctx.artifacts.read(row.id)))
      const short = findings
        .filter((row): row is NonNullable<typeof row> => row !== null)
        .flatMap((row) => (row.content as { findings: Array<{ id: string; evidence: string }> }).findings)
        .find((finding) => finding.id === 'short-quote')
      expect(short).toBeDefined()
      expect(Array.from(short!.evidence).length).toBeGreaterThanOrEqual(8)
    } finally {
      ctx.db.close()
    }
  })

  it('normalizes ASCII quotes and over-long paragraphs without a repair round', async () => {
    class MessyProseBridge extends FakeAgentBridge {
      override async start(request: Parameters<FakeAgentBridge['start']>[0]) {
        const result = await super.start(request)
        if (request.task.kind !== 'draft') return result
        const data = structuredClone(result.structured) as {
          content: string
          self_check: Record<string, unknown>
        }
        data.content = `他说"你好"。${'长句。'.repeat(40)}\n\n${data.content}`
        data.self_check = { ...data.self_check, word_count: 999, cjk_chars: 999 }
        return { ...result, structured: data }
      }
    }
    const ctx = await makeProject((project, artifacts) => new MessyProseBridge(project, artifacts))
    try {
      const runId = ctx.director.createChapterRun({ chapter: 1 })
      await ctx.scheduler.run(runId, {} as Agent, new AbortController().signal)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('awaiting_human')
      const draft = (await ctx.artifacts.latest('Draft', 1))!
      const content = (draft.content as Draft).content
      expect(content).toContain('“你好”')
      expect(content).not.toContain('"')
      expect(
        Math.max(...content.split(/\n{2,}/u).map((row) => countWordMetrics(row).total_word_count)),
      ).toBeLessThanOrEqual(90)
      expect((draft.content as Draft).self_check.word_count).toBeGreaterThan(0)
    } finally {
      ctx.db.close()
    }
  })

  it('repairs a chapter-card title whose body is shorter than four characters', async () => {
    class ShortTitleBridge extends FakeAgentBridge {
      first = true
      override async start(request: Parameters<FakeAgentBridge['start']>[0]) {
        const result = await super.start(request)
        if (request.task.kind === 'plan' && this.first) {
          this.first = false
          const data = structuredClone(result.structured) as { title: string }
          data.title = '第1章 短'
          return { ...result, structured: data }
        }
        return result
      }
    }
    const ctx = await makeProject((project, artifacts) => new ShortTitleBridge(project, artifacts))
    try {
      const runId = ctx.director.createChapterRun({ chapter: 1 })
      await ctx.scheduler.run(runId, {} as Agent, new AbortController().signal)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('awaiting_human')
      const plan = (await ctx.artifacts.latest('ChapterPlan', 1))!
      expect((plan.content as { title: string }).title).toMatch(/^第1章\s+\S{4,8}$/u)
    } finally {
      ctx.db.close()
    }
  })

  it('repairs wrong dimension maxima, totals and non-AI R-W-07 rules', async () => {
    class BadScoreBridge extends FakeAgentBridge {
      first = true
      override async start(request: Parameters<FakeAgentBridge['start']>[0]) {
        const result = await super.start(request)
        if (request.task.kind === 'review.prose' && this.first) {
          this.first = false
          const data = structuredClone(result.structured) as {
            dimensions: Array<{ id: string; max: number; deductions: unknown[] }>
            total: number
          }
          const prose = data.dimensions.find((row) => row.id === 'R-W-07')
          if (prose !== undefined) {
            prose.max = 99
            prose.deductions = [{ rule: 'NOT_AI_TONE', location: '开头', delta: 1, note: 'x' }]
          }
          data.total = 1
          return { ...result, structured: data }
        }
        return result
      }
    }
    let bridge: BadScoreBridge | undefined
    const ctx = await makeProject((project, artifacts) => {
      bridge = new BadScoreBridge(project, artifacts)
      return bridge
    })
    try {
      const runId = ctx.director.createChapterRun({ chapter: 1 })
      await ctx.scheduler.run(runId, {} as Agent, new AbortController().signal)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('awaiting_human')
      expect(bridge?.first).toBe(false)
    } finally {
      ctx.db.close()
    }
  })

  it('repairs schema-valid but gate-invalid outputs before spending a review round', async () => {
    class ValidationRepairBridge extends FakeAgentBridge {
      calls = new Map<string, number>()
      override async start(request: Parameters<FakeAgentBridge['start']>[0]) {
        const count = (this.calls.get(request.task.kind) ?? 0) + 1
        this.calls.set(request.task.kind, count)
        const result = await super.start(request)
        if (count > 1) return result
        const data = structuredClone(result.structured) as Record<string, unknown>
        if (request.task.kind === 'draft') {
          data.content = '短。'
        } else if (request.task.kind === 'review.story') {
          data.dimensions = []
          data.total = 0
        } else if (request.task.kind === 'continuity.precheck') {
          data.findings = [
            {
              id: 'bad-evidence',
              kind: 'canon',
              severity: 'blocker',
              location: '开头',
              evidence: '这句证据不在正文里面',
              problem: '证据不存在',
              fix: '重新引用',
              status: 'open',
            },
          ]
        } else if (request.task.kind === 'polish') {
          data.patches = [{ anchor: '不存在的锚点', before: '不存在的锚点', after: '替换', reason: 'test' }]
        }
        return { ...result, structured: data }
      }
    }
    let bridge: ValidationRepairBridge | undefined
    const ctx = await makeProject((project, artifacts) => {
      bridge = new ValidationRepairBridge(project, artifacts)
      return bridge
    })
    try {
      const runId = ctx.director.createChapterRun({ chapter: 1 })
      await ctx.scheduler.run(runId, {} as Agent, new AbortController().signal)
      expect(getRun(ctx.db.orm, runId)?.status).toBe('awaiting_human')
      for (const kind of ['draft', 'review.story', 'continuity.precheck', 'polish']) {
        expect(bridge?.calls.get(kind), kind).toBeGreaterThanOrEqual(2)
      }
      expect(ctx.director.gates.pending(ctx.project.config.id).some((gate) => gate.gate === 'chapter')).toBe(
        true,
      )
    } finally {
      ctx.db.close()
    }
  })

  it('aborts the in-flight bridge call when the run is cancelled', async () => {
    let started = false
    const bridge: AgentBridge = {
      name: 'hanging',
      available: () => true,
      start: async (request) =>
        new Promise((_, reject) => {
          started = true
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    }
    const ctx = await makeProject(() => bridge)
    try {
      const runId = ctx.director.createChapterRun({ chapter: 1 })
      const running = ctx.scheduler.run(runId, {} as Agent, new AbortController().signal)
      for (let attempt = 0; attempt < 200 && !started; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(started).toBe(true)
      expect(ctx.scheduler.abort(runId)).toBe(true)
      await running
      expect(getRun(ctx.db.orm, runId)?.status).toBe('cancelled')
      expect(ctx.scheduler.abort('missing-run')).toBe(false)
      const assignment = ctx.director.board().assignments[0]
      expect(assignment?.status).toBe('aborted')
    } finally {
      ctx.db.close()
    }
  })
})
