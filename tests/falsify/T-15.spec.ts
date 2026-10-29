import { describe, expect, it } from 'vitest'
import { EngineBlockedError } from '../../src/types.js'
import { harness } from '../helpers.js'

/** T-15: strict mode cannot be bypassed by an empty outline. */
describe('T-15 strict outline is a real gate', () => {
  it('blocks P2 until a card exists, then accepts the matching plan', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: 'T15',
        genre: '都市现代',
        platform: 'fanqie',
        root,
        words_per_chapter: [80, 400],
        strict_outline: true,
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
      await expect(
        (async () => {
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
        })(),
      ).rejects.toBeInstanceOf(EngineBlockedError)

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
      await engine.getBrief({ stage: 'P2', root })
      const plan = await engine.submitChapterPlan({
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
      expect(plan.data.stage).toBe('P3')
    } finally {
      await cleanup()
    }
  })
})
