import type { EngineService } from '../engine/service.js'
import { ERROR_CODES, EngineInputError } from '../types.js'

type Handler = (engine: EngineService, args: Record<string, unknown>) => Promise<unknown>

/** Registry commands need an explicit root; do not pass undefined into path.resolve. */
const rootArg = (args: Record<string, unknown>): string => {
  if (typeof args.root !== 'string' || args.root.trim() === '') {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      'registry operation requires a non-empty root',
      'pass {"root":"/absolute/project/path"}',
    )
  }
  return args.root
}

/**
 * The eighteen tools hidden when `tools.mode=core`, plus the explicit
 * registry/settings-pack operations that are command-only by design (§6.8).
 * They stay reachable through `/novel admin <operation> <json>`; the caller
 * supplies the same arguments the tool schema would have accepted.
 */
const OPERATIONS: Record<string, Handler> = {
  novel_plan_world: (engine, args) => engine.submitWorldPlan(args as never),
  novel_plan_chapter: (engine, args) => engine.submitChapterPlan(args as never),
  novel_word_count: (engine, args) => engine.countWords(args as never),
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
  novel_blueprint: (engine, args) => engine.submitBookPlan(args as never),
  novel_outline: (engine, args) => engine.submitOutline(args as never),
  novel_outline_import: (engine, args) => engine.importOutline(args as never),
  novel_worldbook: (engine, args) => engine.submitWorldbook(args as never),
  novel_search: (engine, args) => engine.search(args as never),
  novel_doctor: (engine, args) => engine.doctor(args as never),
  novel_report: (engine, args) => engine.report(args as never),
  novel_guide: (engine, args) => engine.guide(args as never),
  novel_reopen: (engine, args) => engine.reopenChapter(args as never),
  novel_restore: (engine, args) => engine.restoreBackup(args as never),
  novel_registry_list: (engine) => engine.listProjects(),
  novel_registry_register: (engine, args) => engine.registerProject({ root: rootArg(args) }),
  novel_registry_activate: (engine, args) => engine.setActiveProject({ root: rootArg(args) }),
  novel_registry_forget: (engine, args) => engine.forgetProject({ root: rootArg(args) }),
  novel_import: (engine, args) => engine.importPack(args as never),
}

export const ADMIN_OPERATION_NAMES = Object.keys(OPERATIONS)

export const adminHelp = (): string =>
  [
    '隐藏操作/运维操作（tools.mode=core 时经本命令可达；registry/import 仅命令入口）：',
    ...ADMIN_OPERATION_NAMES.map((name) => `  ${name}`),
    '',
    '用法：/novel admin <operation> <json>',
    '示例：/novel admin novel_word_count {"text":"一段正文"}',
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
  const handler = Object.hasOwn(OPERATIONS, operation) ? OPERATIONS[operation] : undefined
  if (handler === undefined) {
    throw new EngineInputError(
      ERROR_CODES.CONFIG_INVALID,
      `未知子命令 "${operation}"`,
      `available: ${ADMIN_OPERATION_NAMES.join(', ')}`,
    )
  }
  const parsed = parseAdminArguments(rawArguments, operation)
  const args =
    parsed.root === undefined && typeof parsed.project_root === 'string'
      ? { ...parsed, root: parsed.project_root }
      : parsed
  const result = await handler(engine, args)
  const payload =
    typeof result === 'object' && result !== null && 'data' in result
      ? (result as { data: unknown }).data
      : result
  let text = `${operation} 完成\n${JSON.stringify(payload, null, 2)}`
  if (typeof result === 'object' && result !== null) {
    const warnings = (result as { warnings?: unknown }).warnings
    if (Array.isArray(warnings) && warnings.length > 0) {
      const lines = warnings.map((warning) => {
        if (typeof warning !== 'object' || warning === null) return String(warning)
        const entry = warning as { code?: unknown; message?: unknown }
        return `${String(entry.code ?? 'WARNING')}: ${String(entry.message ?? '')}`
      })
      text += `\n\n引擎警告：\n${lines.map((line) => `- ${line}`).join('\n')}`
    }
    if ((result as { replayed?: unknown }).replayed === true) {
      text += '\n\n（replayed: true — 本次未再次写盘）'
    }
  }
  return text
}
