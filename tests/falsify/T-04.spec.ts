import { expect, it } from 'vitest'
import { bootstrapToDraft, cleanText, harness, sampleReview, writeDraft } from '../helpers.js'

/** T-04 / PG-07: the headline total must equal 150 - Σdelta exactly. */
it('T-04 a one-point score discrepancy is rejected', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await bootstrapToDraft({ root, engine })
    const text = cleanText()
    await writeDraft({ root, engine, text })
    await engine.getBrief({ stage: 'P4', root })
    const review = sampleReview(1, text, { deductions: 5 })
    await expect(
      engine.submitReview({ chapter: 1, ...review, total: review.total + 1, root }),
    ).rejects.toMatchObject({ code: 'ENGINE_SCORE_MISMATCH' })
  } finally {
    await cleanup()
  }
})
