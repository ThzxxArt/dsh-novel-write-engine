import { describe, expect, it } from 'vitest'
import { countCharacters } from '../src/domain/wordcount.js'
import { dialogueCharacterRatio } from '../src/domain/text.js'
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

  it('rejects an illegal stage operation and names the legal ones', () => {
    try {
      nextStage('P3', 'archiveChapter', 0)
      throw new Error('expected nextStage to reject archiveChapter at P3')
    } catch (error) {
      expect((error as Error).message).toMatch(/not allowed/u)
      expect((error as Error).message).not.toBe('')
      expect((error as { hint?: string }).hint).toContain('submitDraft')
    }
  })

  it('measures the quoted share of a paragraph, including the empty case', () => {
    expect(dialogueCharacterRatio('')).toBe(0)
    expect(dialogueCharacterRatio('"甲乙"')).toBeCloseTo(2 / 4)
    expect(dialogueCharacterRatio('叙述"一句话"结束')).toBeCloseTo(3 / 9)
  })
})
