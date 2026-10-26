import { expect, it } from 'vitest'
import { ALL_RULE_CODES, assertUniqueRuleCodes } from '../../src/codes.js'
import { BUILTIN_RULES } from '../../src/rules/checks.js'

/** T-06 / INV-07: one code, one implementation; a duplicate is a pack error. */
it('T-06 duplicate rule codes are refused and the built-in registry is complete', () => {
  expect(() => assertUniqueRuleCodes(['A', 'A'])).toThrowError(
    expect.objectContaining({ code: 'ENGINE_RULEPACK_INVALID' }),
  )
  expect(new Set(ALL_RULE_CODES).size).toBe(ALL_RULE_CODES.length)
  expect(new Set(Object.keys(BUILTIN_RULES)).size).toBe(Object.keys(BUILTIN_RULES).length)
  expect([...ALL_RULE_CODES].sort()).toEqual(Object.keys(BUILTIN_RULES).sort())
})
