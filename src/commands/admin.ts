import type { EngineService } from '../engine/service.js'
import { ERROR_CODES, EngineInputError } from '../types.js'

type Handler = (engine: EngineService, args: Record<string, unknown>) => Promise<unknown>

/**
 * The ten tools hidden when `tools.mode=core`. They stay reachable through
 * `/novel admin <operation> <json>`; the caller supplies the same arguments the
 * tool schema would have accepted.
 */
const OPERATIONS: Record<string, Handler> = {
  novel_init: (engine, args) => engine.initProject(args as never),
  novel_plan_world: (engine, args) => engine.submitWorldPlan({ chapter: 0, ...args } as never),
  novel_plan_chapter: (engine, args) => engine.submitChapterPlan({ chapter: 0, ...args } as never),
  novel_amend: (engine, args) => engine.amend(args as never),
  novel_rollback: (engine, args) =>
    engine.rollback({
      ...args,
      toStage: (args.toStage ?? args.to_stage) as never,
    } as never),
  novel_diff: (engine, args) => engine.diff(args as never),
  novel_export: (engine, args) => engine.export(args as never),
  novel_audit: (engine, args) => engine.auditHistory(args as never),
  novel_pipeline: (engine, args) => engine.advise(args as never),
  novel_state: (engine, args) => engine.queryState(args as never),
}

export const ADMIN_OPERATION_NAMES = Object.keys(OPERATIONS)

export const adminHelp = (): string =>
  [
    '隐藏操作（tools.mode=core 时通过本命令可达）：',
    ...ADMIN_OPERATION_NAMES.map((name) => `  ${name}`),
    '',
    '用法：/novel admin <operation> <json>',
    '示例：/novel admin novel_init {"title":"新书","genre":"都市现代","platform":"fanqie"}',
    '      /novel admin novel_state {"kind":"pipeline"}',
  ].join('\n')

/** Parse the JSON object argument of an admin invocation. */
export function parseAdminArguments(raw: string, operation: string): Record<string, unknown> {
  const text = raw.trim()
  if (text === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new EngineInputError(
      ERROR_CODES.CONFIG_INVALID,
      `${operation} expects a JSON object argument: ${error instanceof Error ? error.message : String(error)}`,
      'quote the object, for example: {"kind":"pipeline"}',
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EngineInputError(
      ERROR_CODES.CONFIG_INVALID,
      `${operation} expects a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
    )
  }
  return parsed as Record<string, unknown>
}

/** Run one hidden operation and render its payload for the command result. */
export async function runAdminOperation(
  engine: EngineService,
  operation: string,
  rawArguments: string,
): Promise<string> {
  const handler = OPERATIONS[operation]
  if (handler === undefined) {
    throw new EngineInputError(
      ERROR_CODES.CONFIG_INVALID,
      `未知子命令 "${operation}"`,
      `available: ${ADMIN_OPERATION_NAMES.join(', ')}`,
    )
  }
  const args = parseAdminArguments(rawArguments, operation)
  const result = await handler(engine, args)
  const payload =
    typeof result === 'object' && result !== null && 'data' in result
      ? (result as { data: unknown }).data
      : result
  return `${operation} 完成\n${JSON.stringify(payload, null, 2)}`
}
