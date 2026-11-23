import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { CORE_TOOLS, PANEL_ID, type ToolName } from './constants.js'
import { EngineService } from './engine/service.js'
import type { EngineConfig, EngineEvent } from './engine/state.js'
import { createNovelTools, type UserQuestionsLike, type WorkingDirectoryLike } from './tools/index.js'
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
  ctx.effect(() => () => engine.dispose(), `${name}: engine dispose`)

  const provider = ctx as unknown as { provide?: (name: string, value: unknown) => void }
  provider.provide?.('novelEngine', engine)

  // Resolve the host service on every call instead of capturing one snapshot
  // during load. A provider that is still LOADING when this plugin applies makes
  // the snapshot permanently `undefined`, which silently disabled every cwd
  // lookup: `/novel scan` then answered "请在项目工作区中执行" from inside the
  // very workspace it was run in.
  const resolveWorkingDirectory = (): WorkingDirectoryLike | undefined => {
    const get = (ctx as unknown as { get?: (name: string) => unknown }).get
    if (typeof get !== 'function') return undefined
    try {
      return get.call(ctx, 'workingDirectory') as WorkingDirectoryLike | undefined
    } catch {
      return undefined
    }
  }

  /**
   * 0.2.17: resolve `ctx.userQuestions` per call, exactly like the cwd service.
   *
   * Deliberately NOT `optional.inject(['userQuestions'])`: injection skips the
   * callback entirely when the service is absent, which would make `novel_init`
   * silently vanish from the tool list in a host without a question UI. A
   * missing service must degrade the confirmation, not the tool.
   */
  const resolveUserQuestions = (): UserQuestionsLike | undefined => {
    const get = (ctx as unknown as { get?: (name: string) => unknown }).get
    if (typeof get !== 'function') return undefined
    try {
      return get.call(ctx, 'userQuestions') as UserQuestionsLike | undefined
    } catch {
      return undefined
    }
  }

  for (const tool of createNovelTools(engine, { resolveWorkingDirectory, resolveUserQuestions })) {
    if (toolsMode === 'core' && !CORE_TOOLS.includes(tool.name as ToolName)) continue
    ctx.tools.register(tool)
  }

  const optional = ctx as unknown as {
    inject: (services: string[], body: (scoped: any) => void) => void
  }

  optional.inject(['commands'], (commandsCtx) => {
    for (const command of createCommands(engine, { resolveWorkingDirectory })) {
      commandsCtx.effect(() => commandsCtx.commands.register(command), `${name}: command ${command.name}`)
    }
  })

  optional.inject(['skills'], (skillsCtx) => {
    skillsCtx.effect(() => skillsCtx.skills.register(createSkill()), `${name}: entry skill`)
  })

  optional.inject(['webServer'], (webCtx) => {
    // The host authenticates a registered route before its handler runs (the
    // descriptor declares `auth: 'required'`). Older hosts authenticate
    // nothing at the route layer and instead expose
    // `connection.requestRejection`; newer hosts removed that method, isolate
    // Connection behind Cordis injection, and answer a bare 400 when a plugin
    // calls `connection.admit()` from outside. So: use the narrow rejection
    // probe when the host has it, and otherwise let the host's own admission
    // stand rather than inventing a fence the host has already applied.
    const guard: PanelGuard = (request) => {
      const connection = connectionFence(webCtx) ?? connectionFence(ctx)
      if (connection === undefined) return 503
      // Call through the service: hosts before the auth refactor expose this as
      // a prototype method whose `this` is the Connection instance, so a
      // detached reference throws instead of answering.
      if (typeof connection.requestRejection !== 'function') return undefined
      return connection.requestRejection(request)
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
export * from './constants.js'
export * from './types.js'
export * from './engine/projections.js'
export * from './engine/gates.js'
export * from './engine/brief.js'
export * from './export/render.js'
export * from './codes.js'
export * from './rules/style.js'
export {
  bundledStyleIndexPath,
  loadStyleCatalogue,
  loadStyleIndex,
  readBundledStylepackText,
  resetStylePackCache,
  stylePackById,
  stylePackIds,
  stylePackMap,
  stylePackSummaries,
} from './stylepack.js'
// 0.2.19: the thirteen-item submission checklist is a public contract — the docs
// gate compares docs/selfcheck.md against it row by row.
export { SELF_CHECK_SPEC, buildSelfCheck, selfCheckSpec } from './rules/selfcheck.js'
export type { SelfCheckAnswer, SelfCheckSpecEntry } from './rules/selfcheck.js'
export {
  MACHINE_DIMENSIONS,
  MACHINE_SCORING,
  DIMENSION_BASIS,
  basisOf,
  machineDimensionScores,
} from './domain/scoring.js'
