import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { ERROR_CODES, EngineFaultError } from './types.js'
import { compileRulepack } from './rules/compiler.js'
import type { Rulepack } from './rules/types.js'

/** Candidate locations of the bundled pack, from lib/ and from src/. */
export function bundledRulepackPath(): string {
  const candidates = [
    fileURLToPath(new URL('../rulepacks/default.yaml', import.meta.url)),
    fileURLToPath(new URL('../../rulepacks/default.yaml', import.meta.url)),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

/** Read, compile and freeze a pack. Throws `ENGINE_RULEPACK_INVALID` on defects. */
export function loadRulepack(path?: string): Rulepack {
  const target = path ?? bundledRulepackPath()
  let text: string
  try {
    text = readFileSync(target, 'utf8')
  } catch (error) {
    throw new EngineFaultError(
      ERROR_CODES.RULEPACK_INVALID,
      `cannot read rule pack at ${target}`,
      undefined,
      {
        cause: error,
      },
    )
  }
  const raw: unknown = parse(text)
  return compileRulepack(raw)
}
