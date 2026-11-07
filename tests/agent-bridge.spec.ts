import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DshAgentBridge, sanitizeOutputSchema } from '../src/studio/agent-bridge.js'
import type { TaskRow } from '../src/storage/repositories/runs.js'
import { ROLES } from '../src/contracts/roles.js'

const task = { inputJson: JSON.stringify({ chapter: 2 }) } as unknown as TaskRow
const parent = {} as Agent

const bridgeWith = (
  overrides: {
    capabilities?: Partial<{
      agentPreset: boolean
      outputSchema: boolean
      depthLimit: boolean
      agentOptions: boolean
    }>
    startActivation?: (spec: Record<string, unknown>) => Promise<{
      childId: string
      result: Promise<{
        output?: unknown
        structured?: unknown
        stopReason: string
        usage?: Record<string, unknown>
        diagnostic?: string
      }>
      dispose(): Promise<void>
    }>
  } = {},
) => {
  const dispose = vi.fn(async () => undefined)
  const provider = {
    capabilities: {
      agentPreset: true,
      outputSchema: true,
      depthLimit: true,
      agentOptions: true,
      ...overrides.capabilities,
    },
  }
  const subagents = {
    getProvider: (name: string) => (name === 'spawn' ? provider : undefined),
    startActivation:
      overrides.startActivation ??
      (async () => ({
        childId: 'child-1',
        result: Promise.resolve({ structured: { ok: true }, stopReason: 'completed' }),
        dispose,
      })),
  }
  return { bridge: new DshAgentBridge({ subagents }), dispose }
}

const start = (bridge: DshAgentBridge, overrides: Record<string, unknown> = {}) =>
  bridge.start({
    role: ROLES.drafter,
    task,
    prompt: 'write',
    outputSchema: { type: 'object' },
    parent,
    cwd: '/tmp',
    signal: new AbortController().signal,
    ...overrides,
  })

describe('DshAgentBridge', () => {
  it('sanitizes JSON schema markers recursively and rejects non-objects', () => {
    expect(
      sanitizeOutputSchema({
        $schema: 'x',
        $id: 'y',
        type: 'object',
        properties: { a: { $schema: 'z', type: 'string' } },
        items: [{ $id: 'nested', type: 'number' }],
      }),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      items: [{ type: 'number' }],
    })
    expect(() => sanitizeOutputSchema(null)).toThrow(/must be an object/u)
    expect(() => sanitizeOutputSchema([])).toThrow(/must be an object/u)
  })

  it('reports unavailable without a spawn provider', () => {
    const bridge = new DshAgentBridge({})
    expect(bridge.available()).toBe(false)
  })

  it('fails fast when provider capabilities are missing', async () => {
    for (const capability of ['agentPreset', 'outputSchema', 'depthLimit'] as const) {
      const { bridge } = bridgeWith({ capabilities: { [capability]: false } })
      bridge.available()
      await expect(start(bridge)).rejects.toMatchObject({
        code: 'STUDIO_AGENT_PROVIDER_UNSUPPORTED',
      })
    }
    const { bridge } = bridgeWith({
      startActivation: async () => {
        throw new Error('spawn failed')
      },
    })
    await expect(start(bridge)).rejects.toMatchObject({ code: 'STUDIO_AGENT_FAILED' })
  })

  it('passes model routing and returns structured output plus usage', async () => {
    let spec: Record<string, unknown> | undefined
    const { bridge, dispose } = bridgeWith({
      startActivation: async (input) => {
        spec = input
        return {
          childId: 'child-42',
          result: Promise.resolve({
            structured: { kind: 'Draft' },
            stopReason: 'completed',
            usage: { promptTokens: 10, completionTokens: 20, costUsd: 0.1 },
          }),
          dispose,
        }
      },
    })
    const result = await start(bridge, {
      model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    })
    expect(result.structured).toEqual({ kind: 'Draft' })
    expect(result.usage.costUsd).toBe(0.1)
    expect(spec?.label).toContain('chapter-2')
    expect((spec?.request as { agentOptions: unknown }).agentOptions).toEqual({
      model: 'm',
      provider: 'p',
    })
    await result.dispose()
    await result.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('parses JSON text when the provider omits structured output', async () => {
    const { bridge } = bridgeWith({
      startActivation: async () => ({
        childId: 'child-2',
        result: Promise.resolve({
          output: '```json\n{"kind":"Draft","content":"x"}\n```',
          stopReason: 'completed',
        }),
        dispose: async () => undefined,
      }),
    })
    const result = await start(bridge)
    expect(result.structured).toEqual({ kind: 'Draft', content: 'x' })
  })

  it('fails and disposes on empty or non-completed results', async () => {
    const emptyDispose = vi.fn(async () => undefined)
    const empty = bridgeWith({
      startActivation: async () => ({
        childId: 'child-3',
        result: Promise.resolve({ output: 'not json', stopReason: 'completed' }),
        dispose: emptyDispose,
      }),
    })
    await expect(start(empty.bridge)).rejects.toMatchObject({ code: 'STUDIO_AGENT_FAILED' })
    expect(emptyDispose).toHaveBeenCalled()

    const refusedDispose = vi.fn(async () => undefined)
    const refused = bridgeWith({
      startActivation: async () => ({
        childId: 'child-4',
        result: Promise.resolve({ stopReason: 'refusal', diagnostic: 'no' }),
        dispose: refusedDispose,
      }),
    })
    await expect(start(refused.bridge)).rejects.toMatchObject({ code: 'STUDIO_AGENT_FAILED' })
    expect(refusedDispose).toHaveBeenCalled()
  })
})
