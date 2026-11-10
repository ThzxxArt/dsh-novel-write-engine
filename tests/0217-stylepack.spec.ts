import { describe, expect, it } from 'vitest'
import { EngineFaultError, ERROR_CODES } from '../src/types.js'
import {
  bundledStyleIndexPath,
  loadStyleCatalogue,
  loadStyleIndex,
  readBundledStylepackText,
  resetStylePackCache,
  stylePackById,
  stylePackIds,
} from '../src/stylepack.js'

/**
 * `stylepack.ts` is the loader, and a loader's value is its rejection behaviour:
 * a broken bundled asset must fail loudly at load, never at chapter 40. These
 * cases inject a stub reader so each packaging fault is reachable.
 */

const fault = (fn: () => unknown, code: string = ERROR_CODES.CONFIG_INVALID): EngineFaultError => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(EngineFaultError)
    expect((error as EngineFaultError).code).toBe(code)
    return error as EngineFaultError
  }
  throw new Error('expected a throw')
}

describe('0.2.17 style catalogue loader', () => {
  it('names the index path the pack ships with', () => {
    expect(bundledStyleIndexPath()).toBe('stylepacks/index.yaml')
  })

  it('rejects a missing index as a packaging fault', () => {
    const error = fault(() =>
      loadStyleIndex({
        read: () => {
          throw new Error('ENOENT')
        },
      }),
    )
    expect(error.message).toContain('cannot read the bundled style-pack index')
  })

  it('rejects an index that is not valid YAML', () => {
    const error = fault(() => loadStyleIndex({ read: () => 'packs: [unclosed' }))
    expect(error.message).toContain('cannot parse stylepacks/index.yaml')
  })

  it('rejects an index that names no packs', () => {
    for (const body of ['schema_version: 1', 'packs: []', 'packs: [1, ""]', '[1, 2]']) {
      expect(fault(() => loadStyleIndex({ read: () => body })).message).toContain('names no packs')
    }
  })

  it('rejects an index that repeats an id', () => {
    const error = fault(() => loadStyleIndex({ read: () => 'packs: [cold-suspense, cold-suspense]' }))
    expect(error.message).toContain('repeats "cold-suspense"')
  })

  it('rejects an id that could escape the stylepacks directory', () => {
    for (const id of ['../secret', 'Cold-Suspense', 'a', '', 'x'.repeat(40)]) {
      const error = fault(() => readBundledStylepackText(id))
      expect(error.message).toContain('invalid style pack id')
    }
  })

  it('wraps a malformed pack body as a packaging fault naming the problems', () => {
    const body = 'schema_version: 1\nid: cold-suspense\nname: ""\n'
    const error = fault(() =>
      loadStyleCatalogue({
        read: (path) => (path === 'stylepacks/index.yaml' ? 'packs: [cold-suspense]' : body),
      }),
    )
    expect(error.message).toContain('bundled style packs are invalid')
    expect(error.message).toContain('name')
  })

  it('wraps a pack body that is not YAML at all', () => {
    const error = fault(() =>
      loadStyleCatalogue({
        read: (path) => (path === 'stylepacks/index.yaml' ? 'packs: [cold-suspense]' : 'a: [b'),
      }),
    )
    expect(error.message).toContain('cannot parse style pack "cold-suspense"')
  })

  it('returns null for an unknown id and keeps the real catalogue intact', () => {
    resetStylePackCache()
    expect(stylePackById('no-such-pack')).toBeNull()
    expect(stylePackById('cold-suspense')?.name).toBe('冷峻悬疑')
  })

  it('lists ids in index order, not alphabetical order', () => {
    resetStylePackCache()
    // The index is grouped by reader expectation; sorting it would reorder the
    // catalogue the user picks from.
    expect(stylePackIds()).toEqual([
      'cold-suspense',
      'hot-blooded-fast',
      'ensemble-power',
      'infinite-flow',
      'light-daily',
      'romance-push-pull',
      'steady-farming',
      'weird-horror',
    ])
  })

  it('compiles each pack once per zero-tolerance signature', () => {
    resetStylePackCache()
    const first = stylePackById('cold-suspense')
    const second = stylePackById('cold-suspense')
    // Same signature returns the same frozen object, not a recompile.
    expect(first).toBe(second)
    const collapsed = stylePackById('cold-suspense', { zeroTolerance: ['眸中'] })
    expect(collapsed).not.toBe(first)
    expect(collapsed?.banned_patterns).not.toContain('眸中')
    // The original is untouched.
    expect(first?.banned_patterns).toContain('眸中')
  })
})
