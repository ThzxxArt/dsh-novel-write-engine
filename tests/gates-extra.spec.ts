import { describe, expect, it } from 'vitest'
import {
  archiveDelta,
  bootstrapToDraft,
  cleanText,
  harness,
  sampleReview,
  sampleSemantic,
  sampleSummary,
  writeDraft,
} from './helpers.js'
import { EngineBlockedError } from '../src/types.js'

describe('summary and proof consistency', () => {
  it('rejects an opening that is not quoted from the first two paragraphs', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await engine.getBrief({ stage: 'P3', root })
      const error = await engine
        .submitDraft({
          chapter: 1,
          content: cleanText(),
          chapter_title: '开端之雨',
          scene_type: '日常过渡章',
          narrator: '他',
          summary: sampleSummary({ opening: '这句话不在开头' }),
          root,
        })
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(EngineBlockedError)
      expect((error as EngineBlockedError).blocking.some((item) => item.code === 'PG-05')).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('rejects three reading proofs from the same paragraph', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await writeDraft({ root, engine })
      await engine.getBrief({ stage: 'P4', root })
      const review = sampleReview(1, cleanText())
      const proof = {
        opening: review.proof.opening,
        middle: review.proof.opening,
        ending: review.proof.opening,
      }
      const error = await engine
        .submitReview({ chapter: 1, ...review, proof, root })
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(EngineBlockedError)
      expect((error as EngineBlockedError).blocking.some((item) => item.code === 'PG-09')).toBe(true)
    } finally {
      await cleanup()
    }
  })
})

describe('archive consistency', () => {
  it('stores the title the draft was validated with, not the stale plan title', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await engine.getBrief({ stage: 'P3', root })
      await engine.submitDraft({
        chapter: 1,
        content: cleanText(),
        chapter_title: '雨夜来客',
        scene_type: '日常过渡章',
        narrator: '他',
        summary: sampleSummary(),
        root,
      })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, cleanText()), root })
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({ chapter: 1, semantic: sampleSemantic(cleanText()), root })
      await engine.getBrief({ stage: 'P8', root })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const chapters = await engine.panelChapters({ root })
      expect(chapters.rows[0]!.title).toBe('雨夜来客')
      const handoff = await engine.queryState({ kind: 'handoff', root })
      expect((handoff.data as { act_progress: string }).act_progress).not.toContain('?')
      expect((handoff.data as { last_summary: string }).last_summary).toBe('收到无名信封')
    } finally {
      await cleanup()
    }
  })
})
