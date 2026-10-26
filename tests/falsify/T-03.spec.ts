import { expect, it } from 'vitest'
import {
  bootstrapToDraft,
  cleanText,
  harness,
  readProjectFile,
  sampleReview,
  writeDraft,
} from '../helpers.js'
import { verifyReference } from '../../src/engine/gates.js'

/** T-03 / PG-09: a proof may not cite text that is absent, short, or misplaced. */
it('T-03 fabricated, short and misplaced reading proofs are refused', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await bootstrapToDraft({ root, engine })
    const text = cleanText()
    await writeDraft({ root, engine, text })
    await engine.getBrief({ stage: 'P4', root })
    const review = sampleReview(1, text)

    const missingText = text.split('\n\n')[0]!
    expect(
      verifyReference(missingText, { paragraph: 1, quote: '这句话根本不在正文里面而且足够长' }),
    ).toContain('does not appear')
    expect(verifyReference(missingText, { paragraph: 1, quote: '风从' })).toContain('shorter than')

    const wrongParagraph = {
      ...review,
      proof: { ...review.proof, opening: { ...review.proof.opening, paragraph: 99 } },
    }
    await expect(engine.submitReview({ chapter: 1, ...wrongParagraph, root })).rejects.toMatchObject({
      code: 'ENGINE_READING_PROOF_INVALID',
    })
    const after = await readProjectFile(root, 'state/pipeline.yaml')
    expect(after).not.toContain('ready_to_archive')
  } finally {
    await cleanup()
  }
})
