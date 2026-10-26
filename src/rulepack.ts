import { parse } from 'yaml'
import { readBundledText, readTextAt } from './assets.js'
import { ERROR_CODES, EngineFaultError } from './types.js'
import { compileRulepack } from './rules/compiler.js'
import type { Rulepack } from './rules/types.js'

/** Path of the bundled pack, for diagnostics and CLI validation. */
export function bundledRulepackPath(): string {
  return 'rulepacks/default.yaml'
}

/** Read, compile and freeze a pack. Runtime callers always use the bundled default. */
export function loadRulepack(path?: string): Rulepack {
  let text: string
  try {
    text = path === undefined ? readBundledText('rulepacks/default.yaml') : readTextAt(path)
  } catch (error) {
    if (error instanceof EngineFaultError && path === undefined) throw error
    throw new EngineFaultError(
      ERROR_CODES.RULEPACK_INVALID,
      `cannot read rule pack at ${path ?? 'bundled default'}`,
      undefined,
      { cause: error },
    )
  }
  const raw: unknown = parse(text)
  return compileRulepack(raw)
}
