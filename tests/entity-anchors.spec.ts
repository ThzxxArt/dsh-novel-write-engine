import { describe, expect, it } from 'vitest'
import {
  anchorsForGroup,
  anchorsFromSummary,
  emptyAnchorMap,
  entityMatchHint,
  matchEntityText,
  mergeEntityAnchors,
  normalizeAnchors,
  normalizeNewElementAnchors,
  worldEntityName,
} from '../src/engine/entity-anchors.js'
import { EngineInputError } from '../src/types.js'

describe('entity anchors', () => {
  it('normalizes, de-duplicates and limits explicit anchors', () => {
    expect(normalizeAnchors([' 三楼尾房 ', '三楼尾房', '楼梯底'], 'x')).toEqual(['三楼尾房', '楼梯底'])
    expect(() => normalizeAnchors('x', 'x')).toThrow(EngineInputError)
    expect(() => normalizeAnchors(['一'], 'x')).toThrow(/2..120/)
    expect(() => normalizeAnchors([1], 'x')).toThrow(/must be a string/)
    expect(() => normalizeAnchors([xLong()], 'x')).toThrow(/2..120/)
    expect(() =>
      normalizeAnchors(
        Array.from({ length: 9 }, (_, index) => `a${index}`),
        'x',
      ),
    ).toThrow(/limit is 8/)
  })

  it('validates the chapter anchor map shape and entity names', () => {
    const names = { locations: ['屋'], abilities: [], artifacts: [] }
    expect(normalizeNewElementAnchors(undefined, names)).toEqual(emptyAnchorMap())
    expect(normalizeNewElementAnchors({ locations: { 屋: ['门口'] } }, names)).toEqual({
      locations: { 屋: ['门口'] },
      abilities: {},
      artifacts: {},
    })
    expect(() => normalizeNewElementAnchors([], names)).toThrow(/must be an object/)
    expect(() => normalizeNewElementAnchors({ other: {} }, names)).toThrow(/unknown group/)
    expect(() => normalizeNewElementAnchors({ locations: [] }, names)).toThrow(/must be an object/)
    expect(() => normalizeNewElementAnchors({ locations: { 不存在: ['门口'] } }, names)).toThrow(
      /has no such entity/,
    )
    expect(anchorsFromSummary(null)).toEqual(emptyAnchorMap())
    expect(anchorsFromSummary({ new_elements: { locations: ['屋'], abilities: [], artifacts: [] } })).toEqual(
      emptyAnchorMap(),
    )
    expect(
      anchorsForGroup(normalizeNewElementAnchors({ locations: { 屋: ['门口'] } }, names), 'locations', '屋'),
    ).toEqual(['门口'])
    expect(
      anchorsForGroup(normalizeNewElementAnchors({ locations: { 屋: ['门口'] } }, names), 'locations', '无'),
    ).toEqual([])
  })

  it('matches explicit anchors first and falls back to the readable name', () => {
    expect(matchEntityText('他站在三楼尾房。', '城寨六婶家', ['三楼尾房'])).toMatchObject({
      ok: true,
      matched: '三楼尾房',
      usedFallback: false,
    })
    expect(matchEntityText('他站在屋里。', '屋')).toMatchObject({
      ok: true,
      matched: '屋',
      usedFallback: true,
    })
    expect(matchEntityText('无关正文。', '屋', ['门口'])).toMatchObject({
      ok: false,
      usedFallback: false,
      attempted: ['门口'],
    })
    expect(entityMatchHint('屋', [])).toContain('new_element_anchors')
    expect(entityMatchHint('屋', ['门口'])).toContain('门口')
  })

  it('merges persisted anchors and reads world names safely', () => {
    expect(mergeEntityAnchors(undefined, ['门口'])).toEqual(['门口'])
    expect(mergeEntityAnchors(['门口', '旧'], ['门口', '楼梯'])).toEqual(['门口', '旧', '楼梯'])
    expect(mergeEntityAnchors(['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['h', 'i'])).toHaveLength(8)
    expect(worldEntityName(null)).toBeNull()
    expect(worldEntityName({ name: ' ' })).toBeNull()
    expect(worldEntityName({ name: ' 屋 ' })).toBe('屋')
  })
})

const xLong = (): string => '长'.repeat(121)
