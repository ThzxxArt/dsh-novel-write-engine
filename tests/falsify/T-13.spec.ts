import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  archiveDelta,
  cleanText,
  harness,
  readProjectFile,
  sampleReview,
  sampleSemantic,
  sampleSummary,
} from '../helpers.js'

/** T-13: archive writes the outline card, and no later outline write can rewrite it. */
describe('T-13 archived cards are evidence', () => {
  it('archives into the card and refuses a later rewrite', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: 'T13',
        genre: '都市现代',
        platform: 'fanqie',
        root,
        words_per_chapter: [80, 400],
      })
      await engine.submitOutline({
        strict: true,
        chapters: [
          {
            num: 1,
            title: '开端之雨',
            scene_type: '日常过渡章',
            goal: '收信',
            conflict: '拆不拆',
            hook: '日期',
            cast: ['他'],
            target_words: [80, 400],
          },
        ],
        root,
      })
      await engine.getBrief({ stage: 'P1', root })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: '收信',
        constraints: [],
        characters: [{ name: '他', role: 'protagonist', current_state: '值夜' }],
        locations: [],
        continuity_notes: [],
        root,
      })
      await engine.getBrief({ stage: 'P2', root })
      await engine.submitChapterPlan({
        chapter: 0,
        title: '开端之雨',
        scene_type: '日常过渡章',
        narrator: '他',
        beats: ['起', '承', '转', '合', '收'],
        opening: '风从窗缝里挤进来',
        ending: '日期',
        target_words: [80, 400],
        cast: [{ name: '他' }],
        root,
      })
      const text = cleanText()
      await engine.getBrief({ stage: 'P3', root })
      await engine.submitDraft({
        chapter: 1,
        content: text,
        chapter_title: '开端之雨',
        scene_type: '日常过渡章',
        narrator: '他',
        summary: sampleSummary(),
        root,
      })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({ chapter: 1, semantic: sampleSemantic(text), root })
      await engine.getBrief({ stage: 'P8', root })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })

      const outline = parseYaml((await readProjectFile(root, 'outline/outline.yaml'))!) as {
        chapters: Array<Record<string, unknown>>
      }
      expect(outline.chapters[0]).toMatchObject({ status: 'archived', score: 145 })
      await expect(
        engine.submitOutline({
          strict: true,
          chapters: [{ ...(outline.chapters[0] as Record<string, unknown>), title: '伪造标题' } as never],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      expect((await engine.getStatus({ root })).data.book?.outline.archived).toBe(1)
    } finally {
      await cleanup()
    }
  })
})
