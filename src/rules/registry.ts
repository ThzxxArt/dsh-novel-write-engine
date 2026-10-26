import { ERROR_CODES, EngineFaultError } from '../types.js'
import type { Rule } from './types.js'

/**
 * Code → implementation registry. A second registration for the same code is a
 * programming error, not a merge: it means two owners for one decision.
 */
export class RuleRegistry {
  private readonly rules = new Map<string, Rule>()

  register(code: string, rule: Rule): void {
    if (this.rules.has(code)) {
      throw new EngineFaultError(
        ERROR_CODES.RULEPACK_INVALID,
        `rule ${code} is already registered`,
        'one code, one implementation; pick a new code instead of overriding',
      )
    }
    this.rules.set(code, rule)
  }

  has(code: string): boolean {
    return this.rules.has(code)
  }

  get(code: string): Rule | undefined {
    return this.rules.get(code)
  }

  codes(): string[] {
    return [...this.rules.keys()].sort()
  }

  size(): number {
    return this.rules.size
  }
}
