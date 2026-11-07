import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { openMemoryDb } from '../src/storage/db.js'
import { upsertProject } from '../src/storage/repositories/runs.js'
import {
  insertArtifact,
  insertComment,
  insertFindings,
  insertGateResult,
  latestApproved,
  latestArtifact,
  listArtifacts,
  listComments,
  listFindings,
  listGateResults,
  resolveFinding,
  setArtifactStatus,
  supersedeOlder,
} from '../src/storage/repositories/artifacts.js'
import { HumanGateService } from '../src/studio/human-gate.js'
import { DshAgentBridge, sanitizeOutputSchema } from '../src/studio/agent-bridge.js'
import { ROLES } from '../src/contracts/roles.js'
import type { TaskRow } from '../src/storage/repositories/runs.js'

const provenance = {
  runId: 'r',
  taskId: 't',
  role: 'drafter' as const,
  preset: 'p',
  agentSessionId: 's',
  model: 'm',
  promptHash: 'h',
  createdAt: new Date().toISOString(),
}

describe('artifact and gate repositories', () => {
  it('keeps versions immutable and supports gates, findings and comments', () => {
    const db = openMemoryDb()
    try {
      const projectId = upsertProject(db.orm, { root: '/tmp/repo', title: 'Repo' })
      const one = insertArtifact(db.orm, {
        projectId,
        kind: 'Draft',
        chapter: 1,
        path: 'a',
        contentHash: 'h1',
        schemaVersion: 2,
        provenance,
      })
      const two = insertArtifact(db.orm, {
        projectId,
        kind: 'Draft',
        chapter: 1,
        path: 'b',
        contentHash: 'h2',
        schemaVersion: 2,
        provenance,
      })
      expect(latestArtifact(db.orm, projectId, 'Draft', 1)?.version).toBe(2)
      setArtifactStatus(db.orm, two.id, 'approved')
      expect(latestApproved(db.orm, projectId, 'Draft', 1)?.id).toBe(two.id)
      expect(supersedeOlder(db.orm, two.id)).toBe(1)
      expect(listArtifacts(db.orm, projectId, { kind: 'Draft', chapter: 1 })).toHaveLength(2)
      insertGateResult(db.orm, {
        artifactId: two.id,
        gate: 'PG-07',
        verdict: 'pass',
        details: { score: 150 },
      })
      expect(listGateResults(db.orm, two.id)).toHaveLength(1)
      const ids = insertFindings(db.orm, [
        {
          artifactId: two.id,
          role: 'critic-prose',
          dimension: 'R-W-07',
          severity: 'blocker',
          location: 'p1',
          evidence: '一段正文证据。',
          problem: 'p',
          fix: 'f',
        },
      ])
      expect(listFindings(db.orm, two.id, 'blocker')).toHaveLength(1)
      expect(resolveFinding(db.orm, ids[0]!, 'fixed')).toBe(true)
      expect(listFindings(db.orm, two.id)[0]?.status).toBe('fixed')
      insertComment(db.orm, { projectId, chapter: 1, author: '作者', body: '评论' })
      expect(listComments(db.orm, projectId, 1)).toHaveLength(1)
      void one
    } finally {
      db.close()
    }
  })
})

describe('human gate service', () => {
  it('opens one gate, rotates a token and rejects a wrong token', () => {
    const db = openMemoryDb()
    try {
      const projectId = upsertProject(db.orm, { root: '/tmp/gate', title: 'Gate' })
      const service = new HumanGateService(db.orm)
      const opened = service.open({ projectId, runId: 'r', gate: 'chapter', chapter: 1 })
      expect(service.pending(projectId)).toHaveLength(1)
      expect(() => service.open({ projectId, runId: 'r', gate: 'chapter', chapter: 1 })).toThrow(
        /already awaiting/,
      )
      const token = service.authorize(opened.id)
      expect(() =>
        service.decide({ gateId: opened.id, token: 'wrong', decision: 'approve', actor: 'a', reason: 'r' }),
      ).toThrow(/token/)
      service.decide({ gateId: opened.id, token, decision: 'approve', actor: 'a', reason: 'r' })
      expect(service.pending(projectId)).toHaveLength(0)
      expect(() =>
        service.decide({ gateId: opened.id, token, decision: 'approve', actor: 'a', reason: 'r' }),
      ).toThrow(/already/)
    } finally {
      db.close()
    }
  })

  it('rejects a gate', () => {
    const db = openMemoryDb()
    try {
      const projectId = upsertProject(db.orm, { root: '/tmp/gate2', title: 'Gate2' })
      const service = new HumanGateService(db.orm)
      const opened = service.open({ projectId, runId: 'r', gate: 'bible' })
      const token = service.authorize(opened.id)
      service.decide({ gateId: opened.id, token, decision: 'reject', actor: 'a', reason: 'no' })
      expect(service.pending(projectId)).toHaveLength(0)
    } finally {
      db.close()
    }
  })
})

describe('agent bridge', () => {
  const task = { id: 't', inputJson: '{"chapter":1}' } as TaskRow
  const role = ROLES.planner

  it('sanitizes output schemas and fails without a provider', async () => {
    expect(
      sanitizeOutputSchema({
        $schema: 'x',
        type: 'object',
        properties: { a: { $schema: 'x', type: 'string' } },
      }),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
    })
    const bridge = new DshAgentBridge({})
    expect(bridge.available()).toBe(false)
    await expect(
      bridge.start({
        role,
        task,
        prompt: 'p',
        outputSchema: { type: 'object' },
        parent: {} as Agent,
        cwd: '/tmp',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'STUDIO_AGENT_PROVIDER_UNSUPPORTED' })
  })

  it('starts a capable provider and rejects a non-completed result', async () => {
    let disposed = false
    const provider = {
      capabilities: { agentPreset: true, outputSchema: true, depthLimit: true, agentOptions: true },
      startActivation: async () => ({
        childId: 'child',
        result: Promise.resolve({
          output: [{ type: 'text', text: 'ok' }],
          structured: { ok: true },
          stopReason: 'completed',
          usage: { promptTokens: 1 },
        }),
        dispose: async () => {
          disposed = true
        },
      }),
    }
    const bridge = new DshAgentBridge({
      subagents: { getProvider: () => provider, startActivation: provider.startActivation } as never,
    })
    const result = await bridge.start({
      role,
      task,
      prompt: 'p',
      outputSchema: { type: 'object' },
      parent: {} as Agent,
      cwd: '/tmp',
      signal: new AbortController().signal,
    })
    expect(result.structured).toEqual({ ok: true })
    await result.dispose()
    expect(disposed).toBe(true)

    const failing = new DshAgentBridge({
      subagents: {
        getProvider: () => ({
          ...provider,
          startActivation: async () => ({
            childId: 'child-2',
            result: Promise.resolve({
              output: [],
              structured: undefined,
              stopReason: 'error',
              diagnostic: 'boom',
            }),
            dispose: async () => undefined,
          }),
        }),
        startActivation: async () => ({
          childId: 'child-2',
          result: Promise.resolve({
            output: [],
            structured: undefined,
            stopReason: 'error',
            diagnostic: 'boom',
          }),
          dispose: async () => undefined,
        }),
      } as never,
    })
    await expect(
      failing.start({
        role,
        task,
        prompt: 'p',
        outputSchema: { type: 'object' },
        parent: {} as Agent,
        cwd: '/tmp',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'STUDIO_AGENT_FAILED' })
  })
})
