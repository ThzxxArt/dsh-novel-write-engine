import { describe, expect, it } from 'vitest'
import { compareText, stableJson } from '../src/domain/stable.js'

describe('locale-independent ordering and digests', () => {
  it('sorts object keys by UTF-16 code unit, not locale collation', () => {
    expect(stableJson({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}')
    expect(compareText('一', '二')).toBe(-1)
    expect(compareText('二', '一')).toBe(1)
    expect(compareText('同', '同')).toBe(0)
    // Locale collation disagrees with code-unit order on this pair; without
    // these assertions swapping in localeCompare keeps the suite green.
    expect(compareText('a', 'A')).toBe(1)
    expect(stableJson({ a: 1, A: 2 })).toBe('{"A":2,"a":1}')
  })

  it('drops undefined fields exactly like the persisted digest contract', () => {
    expect(stableJson({ a: undefined, b: null, c: [1, undefined, 2] })).toBe('{"b":null,"c":[1,null,2]}')
    expect(stableJson(undefined)).toBe('null')
    expect(stableJson({ at: new Date('2026-10-26T10:00:00.000Z') })).toBe('{"at":"2026-10-26T10:00:00.000Z"}')
    expect(stableJson({ custom: { toJSON: () => 'ok' } })).toBe('{"custom":"ok"}')
  })
})
