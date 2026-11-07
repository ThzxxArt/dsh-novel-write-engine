import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { PANEL_ID } from './constants.js'
import { EngineService } from './engine/service.js'
import type { EngineConfig, EngineEvent } from './engine/state.js'
import type { WorkingDirectoryLike } from './tools/index.js'
import { createCommands } from './commands/index.js'
import { createSkill } from './skills/index.js'
import { panelRoute, type PanelGuard } from './remote/index.js'
import { studioRoute } from './adapters/remote/studio-api.js'
import { loadRulepack } from './rulepack.js'
import { EngineError, EngineInputError, ERROR_CODES } from './types.js'
import { StudioRuntime } from './studio/runtime.js'
import { defaultStateDir } from './storage/global.js'
import { createStudioTools } from './adapters/tools/studio.js'
import { createRoleToolDefinitions } from './agents/role-tools.js'
import { roleOfPreset } from './contracts/roles.js'
import { readBundledText } from './assets.js'

export const name = 'dsh-novel-write-engine'
export const inject = ['tools']

/** Plugin configuration. Project files hold per-book models and budgets. */
export interface Config {
  projectRoot: string
  minScore: number
  /** Kept for compatibility with 0.2.x configs; 0.3.0 always registers the studio surface. */
  toolsMode: string
  briefsOverrides: string
  backupRetention: number
  stateDir: string
  maxActiveSubagents: number
  maxWritersPerProject: number
  maxConcurrentRuns: number
  reviewRounds: number
  perChapterUsd: number
  perRunUsd: number
  perTaskTokens: number
  directorSessionId: string
}

export const Config: Schema<Config> = Schema.object({
  projectRoot: Schema.string().default('./novel'),
  minScore: Schema.number().default(120),
  toolsMode: Schema.string().default('studio'),
  briefsOverrides: Schema.string().default(''),
  backupRetention: Schema.number().default(10),
  stateDir: Schema.string().default(''),
  maxActiveSubagents: Schema.number().default(6),
  maxWritersPerProject: Schema.number().default(1),
  maxConcurrentRuns: Schema.number().default(2),
  reviewRounds: Schema.number().default(3),
  perChapterUsd: Schema.number().default(0.6),
  perRunUsd: Schema.number().default(30),
  perTaskTokens: Schema.number().default(32000),
  directorSessionId: Schema.string().default(''),
})

const positive = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new EngineInputError(ERROR_CODES.CONFIG_INVALID, `${name} must be positive, got ${String(value)}`)
  }
}

/**
 * Assemble the deterministic kernel, the studio director and the thin adapters.
 * No project IO happens here: the rule pack compiles on first use and each
 * project handle opens lazily.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.toolsMode !== 'all' && config.toolsMode !== 'core' && config.toolsMode !== 'studio') {
    throw new EngineInputError(
      ERROR_CODES.CONFIG_INVALID,
      `toolsMode must be "studio", "all" or "core", got ${JSON.stringify(config.toolsMode)}`,
    )
  }
  if (!Number.isInteger(config.minScore) || config.minScore < 0 || config.minScore > 150) {
    throw new EngineInputError(
      ERROR_CODES.CONFIG_INVALID,
      `minScore must be an integer in 0..150, got ${String(config.minScore)}`,
    )
  }
  if (!Number.isInteger(config.backupRetention) || config.backupRetention < 1) {
    throw new EngineInputError(
      ERROR_CODES.CONFIG_INVALID,
      `backupRetention must be a positive integer, got ${String(config.backupRetention)}`,
    )
  }
  for (const [name, value] of [
    ['maxActiveSubagents', config.maxActiveSubagents],
    ['maxWritersPerProject', config.maxWritersPerProject],
    ['maxConcurrentRuns', config.maxConcurrentRuns],
    ['reviewRounds', config.reviewRounds],
    ['perChapterUsd', config.perChapterUsd],
    ['perRunUsd', config.perRunUsd],
    ['perTaskTokens', config.perTaskTokens],
  ] as const)
    positive(name, value)
  if (config.reviewRounds > 3) {
    throw new EngineInputError(ERROR_CODES.CONFIG_INVALID, 'reviewRounds cannot exceed 3')
  }

  const projectRoot = config.projectRoot === '' ? './novel' : config.projectRoot
  const engineConfig: EngineConfig = {
    projectRoot,
    stateDir: config.stateDir,
    tools: { mode: 'all' },
    quality: { minScore: config.minScore },
    briefs: { overrides: config.briefsOverrides },
    storage: { backupRetention: config.backupRetention },
  }

  const emit = (event: EngineEvent): void => {
    const emitter = ctx as unknown as { emit?: (name: string, payload: unknown) => void }
    emitter.emit?.(event.name, event.payload)
  }

  // The legacy engine remains the importer/read compatibility surface; 0.3.0
  // tools and runs use the StudioRuntime below.
  const engine = new EngineService(engineConfig, () => loadRulepack(), { onEvent: emit })
  ctx.effect(() => () => engine.dispose(), `${name}: engine dispose`)

  const serviceOf = (ctx as unknown as { get?: (name: string) => unknown }).get
  const service = (name: string): unknown =>
    typeof serviceOf === 'function' ? serviceOf.call(ctx, name) : undefined
  const runtime = new StudioRuntime({
    projectRoot,
    context: {
      subagents: service('subagents') as never,
      agentPresets: service('agentPresets') as never,
    },
    agents: service('agents') as
      { get(id: string): import('@deepseek-ai/dsh-agent').Agent | undefined } | undefined,
    directorSessionId: config.directorSessionId === '' ? undefined : config.directorSessionId,
    stateDir: config.stateDir === '' ? defaultStateDir() : config.stateDir,
  })
  ctx.effect(() => () => runtime.close(), `${name}: studio dispose`)

  // Role agents get a scoped tool allowlist and their playbook. The Director
  // still owns ordering and submission; these tools are the role-side seam.
  const presets = service('agentPresets') as
    { composedPreset: (scope: unknown) => string | undefined } | undefined
  const eventOn = (
    ctx as unknown as { on?: (event: string, handler: (payload: { agent?: unknown }) => unknown) => unknown }
  ).on
  if (typeof eventOn === 'function' && presets !== undefined) {
    eventOn.call(ctx, 'agent/created', async ({ agent }: { agent?: unknown }) => {
      const live = agent as {
        id: string
        ctx?: {
          inject?: (services: string[], body: (scope: any) => void) => { dispose: () => Promise<void> }
        }
      }
      if (live.ctx?.inject === undefined) return
      const preset = presets.composedPreset(live.ctx)
      const role = roleOfPreset(preset)
      if (role === undefined) {
        runtime.adoptDirectorSession(live.id)
        return
      }
      const playbook = readBundledText(`skills/roles/${role.id}.md`)
      const fiber = live.ctx.inject(['tools', 'systemPrompt'], (scope) => {
        const definitions = createRoleToolDefinitions(runtime, role.id)
        for (const definition of definitions) scope.tools.register(definition)
        scope.tools.restrict({ allow: definitions.map((definition) => definition.name) })
        scope.systemPrompt.section({
          name: `novel-role-${role.id}`,
          order: 100,
          text: () => playbook,
        })
      })
      ctx.effect(() => () => fiber.dispose(), `${name}: role tooling ${role.id}`)
    })
  }

  const provider = ctx as unknown as { provide?: (name: string, value: unknown) => void }
  provider.provide?.('novelEngine', engine)
  provider.provide?.('novelStudio', runtime)

  for (const tool of createStudioTools(runtime)) {
    const when =
      tool.name === 'novel_run' || tool.name === 'novel_artifact'
        ? async (): Promise<boolean> => {
            try {
              await runtime.open()
              return true
            } catch {
              return false
            }
          }
        : undefined
    ctx.tools.register(tool, when === undefined ? undefined : { when })
  }

  const optional = ctx as unknown as {
    inject: (services: string[], body: (scoped: any) => void) => void
  }

  optional.inject(['commands'], (commandsCtx) => {
    const commands = createCommands(engine, {
      workingDirectory: workingDirectoryOf(ctx),
      studio: runtime,
      agentFor: (id) =>
        service('agents') === undefined
          ? undefined
          : (
              service('agents') as { get(id: string): import('@deepseek-ai/dsh-agent').Agent | undefined }
            ).get(id),
      importLegacy: async (from, to) => {
        const { importLegacyProject } = await import('./kernel/project/import.js')
        return importLegacyProject(from, to)
      },
    })
    for (const command of commands) {
      commandsCtx.effect(() => commandsCtx.commands.register(command), `${name}: command ${command.name}`)
    }
  })

  optional.inject(['skills'], (skillsCtx) => {
    skillsCtx.effect(() => skillsCtx.skills.register(createSkill()), `${name}: entry skill`)
  })

  optional.inject(['webServer'], (webCtx) => {
    const guard: PanelGuard = (request) => {
      const connection = connectionFence(webCtx) ?? connectionFence(ctx)
      if (connection === undefined) return 503
      if (connection.requestRejection !== undefined) return connection.requestRejection(request)
      if (connection.admit !== undefined) {
        const admission = connection.admit(request) as { rejection?: 401 | 403 } | { peer?: unknown }
        return 'rejection' in admission ? admission.rejection : undefined
      }
      return 503
    }
    webCtx.effect(
      () => webCtx.webServer.register(panelRoute(engine, guard)),
      `${name}: panel route ${PANEL_ID}`,
    )
    webCtx.effect(() => webCtx.webServer.register(studioRoute(runtime, guard)), `${name}: studio API v8`)
  })
}

function workingDirectoryOf(ctx: Context): WorkingDirectoryLike | undefined {
  const serviceOf = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof serviceOf !== 'function') return undefined
  return serviceOf.call(ctx, 'workingDirectory') as WorkingDirectoryLike | undefined
}

/** The slice of Connection the exact panel route needs. */
interface ConnectionFence {
  requestRejection?: (request: unknown) => 401 | 403 | undefined
  admit?: (request: unknown) => unknown
}

function connectionFence(scope: unknown): ConnectionFence | undefined {
  const candidate = scope as {
    get?: (name: string) => unknown
    connection?: unknown
  }
  if (typeof candidate.get === 'function') {
    const service = candidate.get('connection')
    return service === undefined || service === null ? undefined : (service as ConnectionFence)
  }
  if (Object.prototype.hasOwnProperty.call(candidate, 'connection')) {
    return candidate.connection as ConnectionFence
  }
  return undefined
}

export { EngineService, EngineError, loadRulepack }
export * from './constants.js'
export * from './types.js'
export * from './engine/projections.js'
export * from './engine/gates.js'
export * from './engine/brief.js'
export * from './export/render.js'
export * as contracts from './contracts/index.js'
export * from './domain/taxonomy.js'
export * from './taxonomy.js'
export * from './studio/runtime.js'
export * from './adapters/tools/studio.js'
