import { describe, expect, it } from 'vitest'
import {
  archiveDelta,
  bootstrapToDraft,
  cleanText,
  harness,
  readProjectFile,
  sampleReview,
  sampleSemantic,
  sampleSummary,
  writeDraft,
} from './helpers.js'

describe('summary-only brief scope', () => {
  it('lets the immediate P6 check continue but still requires a fresh P8 brief before archive', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = cleanText()
      await bootstrapToDraft({ root, engine })
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      await engine.getBrief({ stage: 'P6', root })
      await engine.submitRevision({ chapter: 1, summary: sampleSummary(), root })
      await engine.runCheck({ chapter: 1, semantic: sampleSemantic(text), root })
      await expect(
        engine.archiveChapter({
          chapter: 1,
          state_delta: archiveDelta(sampleSummary()),
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_GATE_BLOCKED' })
      expect(await readProjectFile(root, 'chapters/chapter-001.md')).toBe(text)
      await engine.getBrief({ stage: 'P8', root })
      const archived = await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root,
      })
      expect(archived.data.score).toBeGreaterThanOrEqual(120)
    } finally {
      await cleanup()
    }
  })
})
