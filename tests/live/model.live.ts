import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { initProjectV2, loadProjectV2 } from '../../src/kernel/project/layout.js'
import { openStudioDb } from '../../src/storage/db.js'
import { ArtifactStore } from '../../src/kernel/artifacts/store.js'
import { StudioDirector } from '../../src/studio/director.js'
import { StudioScheduler } from '../../src/studio/scheduler.js'
import type { AgentBridge, AgentStartRequest, AgentStartResult } from '../../src/studio/agent-bridge.js'
import { FakeAgentBridge } from '../../src/studio/fake-bridge.js'
import { getRun, listTasks } from '../../src/storage/repositories/runs.js'
import { countWordMetrics } from '../../src/domain/wordcount.js'
import type { Draft } from '../../src/contracts/artifacts.js'

/**
 * Opt-in acceptance against the real Agnes OpenAI-compatible endpoint.
 *
 *   AGNES_API_KEY=... AGNES_BASE_URL=... AGNES_MODEL=agnes-2.5-flash pnpm test:live-model
 *
 * Plan §14.2 asks for fake-LLM E2E plus one live smoke. Only the two content
 * roles (planner/drafter) call the real endpoint; reviews/polish reuse the
 * deterministic fake so the suite measures prompt + schema + prose quality
 * without depending on five more network round-trips.
 */
const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required to run the live model suite`)
  }
  return value
}

class LiveSmokeBridge implements AgentBridge {
  readonly name = 'agnes-live-smoke'
  readonly liveCalls: Array<{ task: string; role: string; promptTokens: number; completionTokens: number }> =
    []
  private readonly fake: FakeAgentBridge

  constructor(fake: FakeAgentBridge) {
    this.fake = fake
  }

  available(): boolean {
    return true
  }

  async start(request: AgentStartRequest): Promise<AgentStartResult> {
    if (request.task.kind !== 'plan' && request.task.kind !== 'draft') {
      return this.fake.start(request)
    }
    const startedAt = Date.now()
    const baseUrl = required('AGNES_BASE_URL').replace(/\/$/u, '')
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${required('AGNES_API_KEY')}`,
      },
      body: JSON.stringify({
        model: required('AGNES_MODEL'),
        messages: [
          {
            role: 'system',
            content:
              '你是中文网文创作室的专业角色。只输出一个合法 JSON 对象，必须严格符合用户给出的 JSON Schema；不要输出 Markdown 围栏、解释或前后缀。所有引文必须逐字来自给定正文。',
          },
          {
            role: 'user',
            content: `${request.prompt}\n\nJSON Schema（必须满足）:\n${JSON.stringify(request.outputSchema)}`,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 65_536,
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`agnes ${response.status}: ${text.slice(0, 500)}`)
    const body = JSON.parse(text) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const content = body.choices[0]?.message.content ?? ''
    const usage = body.usage ?? {}
    this.liveCalls.push({
      task: request.task.kind,
      role: request.role.id,
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
    })
    console.log(`live call ${request.task.kind}/${request.role.id} in ${Date.now() - startedAt}ms`)
    return {
      structured: JSON.parse(content) as unknown,
      outputText: content,
      usage: {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        costUsd: 0,
      },
      stopReason: 'completed',
      agentSessionId: `agnes-${request.task.id}`,
      childId: `agnes-${request.task.id}`,
      dispose: async () => undefined,
    }
  }
}

describe('live model acceptance', () => {
  it('runs a real planner/drafter through the full chapter pipeline to the human gate', async () => {
    required('AGNES_API_KEY')
    required('AGNES_BASE_URL')
    required('AGNES_MODEL')
    const root = mkdtempSync(join(tmpdir(), 'agnes-live-'))
    const db = openStudioDb(join(root, '.studio', 'studio.db'))
    try {
      await initProjectV2({
        root,
        title: '城南旧铺',
        author: '测试',
        genre: {
          major: 'mystery',
          sub: 'mystery.detective',
          tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
        },
        audience: 'general',
        platform: 'fanqie',
        targets: { total_chapters: 3, words_per_chapter: [350, 600], min_cjk_chars: 250 },
        quality: { min_score: 100, review_rounds: 2 },
      })
      const project = await loadProjectV2(root)
      const artifacts = new ArtifactStore(project, db)
      const director = new StudioDirector(project, db, artifacts)
      const bridge = new LiveSmokeBridge(new FakeAgentBridge(project, artifacts))
      const scheduler = new StudioScheduler({ project, db, artifacts, director, bridge })
      const runId = director.createChapterRun({ chapter: 1 })
      await scheduler.run(runId, {} as Agent, new AbortController().signal)
      const run = getRun(db.orm, runId)!
      const tasks = listTasks(db.orm, runId)
      const failed = tasks.filter((task) => task.status === 'failed')
      expect(
        run.status,
        `run failed: ${run.error ?? ''}\ntasks: ${JSON.stringify(
          failed.map((task) => ({ kind: task.kind, error: task.error })),
        )}`,
      ).toBe('awaiting_human')
      expect(failed).toEqual([])

      const draft = await artifacts.latest('Draft', 1)
      expect(draft).not.toBeNull()
      expect(draft?.status).toBe('draft')
      const body = (draft?.content as Draft).content
      expect(countWordMetrics(body).cjk_chars).toBeGreaterThanOrEqual(250)
      expect(body).not.toContain('```')
      expect((draft?.content as Draft).title).toMatch(/^第1章\s+\S{4,8}$/u)
      expect(bridge.liveCalls.map((call) => call.task)).toEqual(expect.arrayContaining(['plan', 'draft']))
      expect(bridge.liveCalls.every((call) => call.promptTokens > 0 && call.completionTokens > 0)).toBe(true)
      const gates = director.gates.pending(project.config.id)
      expect(gates.some((gate) => gate.gate === 'chapter')).toBe(true)
      const total = bridge.liveCalls.reduce((sum, call) => sum + call.promptTokens + call.completionTokens, 0)
      console.log(
        `live model ok: ${bridge.liveCalls.length} live calls, ${total} tokens, ${body.length} chars`,
      )
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 600_000)
})
