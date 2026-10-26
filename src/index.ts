import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { PANEL_ID } from './constants.js'
import { EngineService } from './engine/service.js'
import type { EngineConfig, EngineEvent } from './engine/state.js'
import { createNovelTools } from './tools/index.js'
import { createCommands } from './commands/index.js'
import { createSkill } from './skills/index.js'
import { panelRoute } from './remote/index.js'
import { loadRulepack } from './rulepack.js'
import { EngineError } from './types.js'

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
  projectRoot: Schema.string().default('.'),
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
  const toolsMode = config.toolsMode === 'core' ? 'core' : 'all'
  const minScore = Number.isFinite(config.minScore) ? Math.max(0, Math.min(150, config.minScore)) : 120
  const engineConfig: EngineConfig = {
    projectRoot: config.projectRoot === '' ? '.' : config.projectRoot,
    stateDir: config.stateDir,
    tools: { mode: toolsMode },
    quality: { minScore },
    briefs: { overrides: config.briefsOverrides },
    storage: { backupRetention: Math.max(1, Math.floor(config.backupRetention || 5)) },
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
    if (toolsMode === 'core' && !isCoreTool(tool.name)) continue
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
    webCtx.effect(() => webCtx.webServer.register(panelRoute(engine)), `${name}: panel route ${PANEL_ID}`)
  })
}

/** Core mode keeps the eight highest-frequency tools; the rest stay reachable by name. */
const CORE = new Set([
  'novel_status',
  'novel_brief',
  'novel_write_draft',
  'novel_review',
  'novel_revise',
  'novel_check',
  'novel_archive',
  'novel_word_count',
])

function isCoreTool(toolName: string): boolean {
  return CORE.has(toolName)
}

export { EngineService, EngineError, loadRulepack }
export * from './types.js'
export * from './engine/projections.js'
export * from './engine/gates.js'
export * from './engine/brief.js'
export * from './export/render.js'
