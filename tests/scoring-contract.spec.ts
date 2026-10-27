import { describe, expect, it } from 'vitest'
import { applyExclusions } from '../src/domain/scoring.js'
import { bootstrapToDraft, harness, readProjectFile, sampleReview, writeDraft } from './helpers.js'

const atP4 = async (): Promise<{
  root: string
  engine: Awaited<ReturnType<typeof harness>>['engine']
  cleanup: () => Promise<void>
  text: string
}> => {
  const { root, engine, cleanup } = await harness()
  await bootstrapToDraft({ root, engine })
  await writeDraft({ root, engine })
  await engine.getBrief({ stage: 'P4', root })
  const text = (await readProjectFile(root, 'chapters/chapter-001.md'))!
  return { root, engine, cleanup, text }
}

describe('review score contract', () => {
  it('canonicalizes zero-padded paragraph numbers before applying exclusions', () => {
    const dimensions = [
      {
        id: 'R-W-11',
        max: 10,
        deductions: [{ rule: 'META_NARRATION', location: '第 01 段', delta: 6, note: '元叙述' }],
      },
      {
        id: 'R-W-07',
        max: 4,
        deductions: [{ rule: 'LEX_ZERO_TOLERANCE', location: '第 1 段', delta: 2, note: '套话' }],
      },
    ]
    const result = applyExclusions(dimensions, [
      { pair: ['META_NARRATION', 'LEX_ZERO_TOLERANCE'], family: 'meta' },
    ])
    expect(result.dropped).toBe(1)
    expect(result.dimensions[1]!.deductions).toHaveLength(0)
  })

  it('rejects a claimed total that does not equal 150 - Σdelta', async () => {
    const { root, engine, cleanup, text } = await atP4()
    try {
      const review = sampleReview(1, text)
      await expect(
        engine.submitReview({ chapter: 1, ...review, total: review.total + 1, root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCORE_MISMATCH' })
    } finally {
      await cleanup()
    }
  })

  it('rejects unknown dimension ids even when the count is fifteen', async () => {
    const { root, engine, cleanup, text } = await atP4()
    try {
      const review = sampleReview(1, text)
      const dimensions = review.dimensions.map((dimension, index) =>
        index === 0 ? { id: 'R-W-99', max: 0, deductions: [] } : dimension,
      )
      await expect(
        engine.submitReview({ chapter: 1, ...review, dimensions, total: 150, root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCORE_MISMATCH' })
    } finally {
      await cleanup()
    }
  })

  it('accepts a review whose total matches the deductions', async () => {
    const { root, engine, cleanup, text } = await atP4()
    try {
      const review = sampleReview(1, text)
      const result = await engine.submitReview({ chapter: 1, ...review, root })
      expect(result.data.total).toBe(145)
      expect(result.data.next_stage).toBe('P6')
    } finally {
      await cleanup()
    }
  })
})
