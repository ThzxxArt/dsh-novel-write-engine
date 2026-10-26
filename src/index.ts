import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { CORE_TOOLS, PANEL_ID, type ToolName } from './constants.js'
import { EngineService } from './engine/service.js'
import type { EngineConfig, EngineEvent } from './engine/state.js'
import { createNovelTools } from './tools/index.js'
import { createCommands } from './commands/index.js'
import { createSkill } from './skills/index.js'
import { panelRoute, type PanelGuard } from './remote/index.js'
import { loadRulepack } from './rulepack.js'
import { EngineError, EngineInputError, ERROR_CODES } from './types.js'

export const name = 'dsh-novel-write-engine'
export const inject = ['tools']

/** Plugin configuration. Every value is also readable in `--dump-config`. */
export interface Config {
  projectRoot: string
  minScore: number
  /** `all` or `core`; validated in `apply`, so the schema stays a plain string. */
  toolsMode: string
  /** Optional directory with user task-book overrides; empty uses the bundled set. */
  briefsOverrides: string
  /** How many archived-chapter backups to keep. */
  backupRetention: number
  /** Directory for cross-project bookkeeping; never inside a project. */
  stateDir: string
}

export const Config: Schema<Config> = Schema.object({
  projectRoot: Schema.string().default('./novel'),
  minScore: Schema.number().default(120),
  toolsMode: Schema.string().default('all'),
  briefsOverrides: Schema.string().default(''),
  backupRetention: Schema.number().default(5),
  stateDir: Schema.string().default(''),
})

/**
 * Assemble the engine and its four thin adapters. No IO happens here: the rule
 * pack compiles on first use, task books load on demand, and the store is
 * created lazily per project root.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.toolsMode !== 'all' && config.toolsMode !== 'core') {
    throw new EngineInputError(
      ERROR_CODES.CONFIG_INVALID,
      `toolsMode must be "all" or "core", got ${JSON.stringify(config.toolsMode)}`,
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
  const toolsMode = config.toolsMode
  const minScore = config.minScore
  const engineConfig: EngineConfig = {
    projectRoot: config.projectRoot === '' ? './novel' : config.projectRoot,
    stateDir: config.stateDir,
    tools: { mode: toolsMode },
    quality: { minScore },
    briefs: { overrides: config.briefsOverrides },
    storage: { backupRetention: config.backupRetention },
  }

  const emit = (event: EngineEvent): void => {
    const emitter = ctx as unknown as { emit?: (name: string, payload: unknown) => void }
    emitter.emit?.(event.name, event.payload)
  }

  const engine = new EngineService(engineConfig, () => loadRulepack(), {
    onEvent: emit,
  })

  const provider = ctx as unknown as { provide?: (name: string, value: unknown) => void }
  provider.provide?.('novelEngine', engine)

  for (const tool of createNovelTools(engine)) {
    if (toolsMode === 'core' && !CORE_TOOLS.includes(tool.name as ToolName)) continue
    ctx.tools.register(tool)
  }

  const optional = ctx as unknown as {
    inject: (services: string[], body: (scoped: any) => void) => void
  }

  optional.inject(['commands'], (commandsCtx) => {
    for (const command of createCommands(engine)) {
      commandsCtx.effect(() => commandsCtx.commands.register(command), `${name}: command ${command.name}`)
    }
  })

  optional.inject(['skills'], (skillsCtx) => {
    skillsCtx.effect(() => skillsCtx.skills.register(createSkill()), `${name}: entry skill`)
  })

  optional.inject(['webServer'], (webCtx) => {
    // The panel is an exact route, so it wins before the host's `/api` prefix
    // admission. Reuse the connection service's trust/authentication fence here.
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
  })
}

/** The slice of Connection the exact panel route needs. */
interface ConnectionFence {
  requestRejection?: (request: unknown) => 401 | 403 | undefined
  admit?: (request: unknown) => unknown
}

/**
 * Resolve `connection` without touching the property directly. Cordis throws
 * when an injected service is read as a plain property, and the panel setup is
 * intentionally allowed to run without Connection mounted (the route then
 * denies every request). Test harnesses may expose the service as an own
 * property; that fallback never fires on a real Context.
 */
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
export * from './types.js'
export * from './engine/projections.js'
export * from './engine/gates.js'
export * from './engine/brief.js'
export * from './export/render.js'
