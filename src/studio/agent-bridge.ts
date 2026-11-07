import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TaskRow } from '../storage/repositories/runs.js'
import type { RoleDefinition } from '../contracts/roles.js'
import { StudioError, STUDIO_ERROR_CODES } from '../contracts/errors.js'

export interface AgentUsage {
  promptTokens?: number
  completionTokens?: number
  costUsd?: number
  [key: string]: unknown
}

export interface AgentStartRequest {
  role: RoleDefinition
  task: TaskRow
  prompt: string
  outputSchema: Record<string, unknown>
  parent: Agent
  cwd: string
  model?: { provider: string; model: string; reasoningEffort?: string }
  signal: AbortSignal
}

export interface AgentStartResult {
  structured: unknown
  outputText: string
  usage: AgentUsage
  stopReason: string
  agentSessionId: string
  childId: string
  dispose(): Promise<void>
}

export interface AgentBridge {
  readonly name: string
  available(): boolean
  start(request: AgentStartRequest): Promise<AgentStartResult>
}

interface ProviderLike {
  capabilities: { agentPreset: boolean; outputSchema: boolean; depthLimit: boolean; agentOptions: boolean }
  inheritsParentContext?: boolean
}

interface ActivationLike {
  childId: string
  result: Promise<{
    output?: unknown
    structured?: unknown
    stopReason: string
    usage?: AgentUsage
    diagnostic?: string
  }>
  dispose(): Promise<void>
}

interface SubagentsLike {
  getProvider(name: string): ProviderLike | undefined
  startActivation(spec: Record<string, unknown>): Promise<ActivationLike>
  sendMessage?(
    sender: Agent,
    targetId: string,
    content: Array<{ type: 'text'; text: string }>,
    options: { signal: AbortSignal },
  ): Promise<unknown>
}

interface PresetsLike {
  resolve(id?: string): Promise<unknown>
}

/** Structural subset of Cordis the bridge needs; kept free of deep imports. */
export interface BridgeContext {
  subagents?: SubagentsLike
  agentPresets?: PresetsLike
}

const textOf = (output: unknown): string => {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map((block) => {
        if (typeof block === 'string') return block
        if (typeof block === 'object' && block !== null && 'text' in block)
          return String((block as { text: unknown }).text)
        return ''
      })
      .join('')
  }
  if (typeof output === 'object' && output !== null && 'text' in output)
    return String((output as { text: unknown }).text)
  return ''
}

/** One fallback parse for providers that return the object as final text. */
const parseStructuredText = (text: string): unknown => {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

/** Remove Zod's `$schema` and unsupported top-level markers from a JSON schema. */
export function sanitizeOutputSchema(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StudioError(STUDIO_ERROR_CODES.AGENT_PROVIDER_UNSUPPORTED, 'output schema must be an object')
  }
  const clone = structuredClone(value) as Record<string, unknown>
  delete clone.$schema
  delete clone.$id
  delete clone.$defs
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const row = node as Record<string, unknown>
    delete row.$schema
    delete row.$id
    for (const value of Object.values(row)) walk(value)
  }
  walk(clone)
  return clone
}

/** DSH 0.2.2 spawn provider adapter. Fails loudly when capabilities are absent. */
export class DshAgentBridge implements AgentBridge {
  readonly name = 'dsh-spawn'
  private readonly ctx: BridgeContext

  constructor(ctx: BridgeContext) {
    this.ctx = ctx
  }

  available(): boolean {
    return this.provider() !== undefined
  }

  private provider(): ProviderLike | undefined {
    return this.ctx.subagents?.getProvider('spawn')
  }

  private assertCapabilities(): ProviderLike {
    const provider = this.provider()
    if (provider === undefined) {
      throw new StudioError(
        STUDIO_ERROR_CODES.AGENT_PROVIDER_UNSUPPORTED,
        'novel-studio requires the spawn subagent provider',
        'mount @deepseek-ai/dsh-subagent-spawn-in-process in the host',
      )
    }
    if (!provider.capabilities.agentPreset) {
      throw new StudioError(
        STUDIO_ERROR_CODES.AGENT_PROVIDER_UNSUPPORTED,
        'spawn provider must support agentPreset',
      )
    }
    if (!provider.capabilities.outputSchema) {
      throw new StudioError(
        STUDIO_ERROR_CODES.AGENT_PROVIDER_UNSUPPORTED,
        'spawn provider must support outputSchema',
      )
    }
    if (!provider.capabilities.depthLimit) {
      throw new StudioError(
        STUDIO_ERROR_CODES.AGENT_PROVIDER_UNSUPPORTED,
        'spawn provider must support depthLimit',
      )
    }
    return provider
  }

  async start(request: AgentStartRequest): Promise<AgentStartResult> {
    this.assertCapabilities()
    const subagents = this.ctx.subagents!
    const spec: Record<string, unknown> = {
      provider: 'spawn',
      label: `chapter-${request.task.inputJson.match(/"chapter":(\d+)/u)?.[1] ?? 'x'}-${request.role.id}`,
      request: {
        parent: request.parent,
        agentPreset: request.role.preset,
        cwd: request.cwd,
        prompt: [{ type: 'text', text: request.prompt }],
        outputSchema: request.outputSchema,
        maxDepth: 0,
        ...(request.model === undefined
          ? {}
          : { agentOptions: { model: request.model.model, provider: request.model.provider } }),
      },
      signal: request.signal,
      delivery: 'caller',
    }
    let activation: ActivationLike
    try {
      activation = await subagents.startActivation(spec)
    } catch (error) {
      throw new StudioError(
        STUDIO_ERROR_CODES.AGENT_FAILED,
        `failed to start ${request.role.preset}: ${error instanceof Error ? error.message : String(error)}`,
        'check the preset is registered and the spawn provider is mounted',
        { preset: request.role.preset },
        { cause: error },
      )
    }
    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      await activation.dispose()
    }
    try {
      const result = await activation.result
      if (result.stopReason !== 'completed') {
        throw new StudioError(
          STUDIO_ERROR_CODES.AGENT_FAILED,
          `${request.role.preset} stopped with ${result.stopReason}${result.diagnostic ? `: ${result.diagnostic}` : ''}`,
          'transient failures are retried; content failures return to the writer',
          { stopReason: result.stopReason, preset: request.role.preset },
        )
      }
      const structured = result.structured ?? parseStructuredText(textOf(result.output))
      if (structured === undefined) {
        throw new StudioError(
          STUDIO_ERROR_CODES.AGENT_FAILED,
          `${request.role.preset} returned no structured output`,
          'the provider must support outputSchema; one repair attempt is allowed only when structured output is absent',
          { preset: request.role.preset },
        )
      }
      return {
        structured,
        outputText: textOf(result.output),
        usage: result.usage ?? {},
        stopReason: result.stopReason,
        agentSessionId: activation.childId,
        childId: activation.childId,
        dispose,
      }
    } catch (error) {
      await dispose().catch(() => undefined)
      throw error
    }
  }
}

export type { TaskRow }
