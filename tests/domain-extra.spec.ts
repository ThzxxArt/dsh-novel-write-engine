import { describe, expect, it } from 'vitest'
import { countCharacters } from '../src/domain/wordcount.js'
import { simhash, similarity } from '../src/domain/simhash.js'
import { SCORE_DIMENSIONS, reviewArithmeticProblems } from '../src/domain/scoring.js'
import { nextStage } from '../src/domain/transitions.js'
import type { ScoreDimension } from '../src/types.js'

describe('domain edge cases', () => {
  it('counts characters independently of the word rule', () => {
    expect(countCharacters('你好，world')).toBe(8)
    expect(countCharacters('')).toBe(0)
  })

  it('fingerprints very short text deterministically', () => {
    expect(simhash('甲')).toBe(simhash('甲'))
    expect(similarity(simhash('甲'), simhash('乙'))).toBeLessThanOrEqual(1)
  })

  it('reports a dimension maximum that does not match the spec', () => {
    const dimensions: ScoreDimension[] = SCORE_DIMENSIONS.map(({ id, max }) => ({ id, max, deductions: [] }))
    dimensions[0] = { id: 'R-W-01', max: 14, deductions: [] }
    expect(reviewArithmeticProblems(dimensions, 150)).toEqual(
      expect.arrayContaining([expect.stringContaining('does not match spec')]),
    )
  })

  it('names the legal operations in the stage error hint', () => {
    try {
      nextStage('P3', 'archiveChapter', 0)
      throw new Error('expected a failure')
    } catch (error) {
      expect((error as { hint?: string }).hint).toContain('allowed here: submitDraft')
    }
  })
})
