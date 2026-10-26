import { describe, expect, it } from 'vitest'
import { harness, sampleReview, sampleSummary } from './helpers.js'
import type { ChapterSummary, SceneType } from '../src/types.js'

const TEXTS: Record<number, string> = {
  1: [
    '一月的风穿过走廊，卷起墙边那只旧纸箱的角。他弯腰把它压稳，指尖沾了一层灰。',
    '走廊尽头传来钥匙碰撞的声音，不快不慢，在门口停了两秒。他没有回头。',
    '门开时带进一股冷气，来人把一封没有署名的信放在桌角，敲了两下桌面。',
    '信封封口压着暗红蜡印，边缘磨得发白。他翻到背面，看见一行极小的字。',
  ].join('\n\n'),
  2: [
    '旧城的午后闷得发闷，墙皮一块块往下掉。他沿着窄巷往里走，鞋底踩碎了几片瓦。',
    '巷子拐角有一扇铁门，门环锈成暗褐色。他伸手试了试，门从里面锁着。',
    '铁门旁边的墙上钉着一块木牌，字迹被雨冲淡，只剩一个模糊的姓氏。',
    '他记下门牌号，转身时听见门后有人轻轻咳嗽了一声，随后又安静下去。',
  ].join('\n\n'),
  3: [
    '灯下那张纸被风掀起一角，他伸手按住，指节因为用力而发白。',
    '纸上只有三行字，每一行都写着同一个日期，墨迹却深浅不同。',
    '他忽然明白那封信为什么没有署名，喉咙里像堵着一团旧棉花。',
    '窗外有车灯扫过墙面，影子晃了一下。他把纸折好，放进贴身的口袋。',
  ].join('\n\n'),
}

const SUMMARY: ChapterSummary = sampleSummary()

const SCENES: Record<number, SceneType> = { 1: '日常过渡章', 2: '纯叙事章', 3: '情感爆发章' }
const TITLES: Record<number, string> = { 1: '开端之雨', 2: '旧城之影', 3: '灯下之言' }

describe('three-chapter end to end', () => {
  it('archives three chapters with no manual file edits', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '三章之书',
        genre: '都市现代',
        platform: 'fanqie',
        root,
        words_per_chapter: [80, 400],
      })
      for (const chapter of [1, 2, 3]) {
        const text = TEXTS[chapter]!
        await engine.getBrief({ stage: 'P1', root })
        await engine.submitWorldPlan({
          chapter: 0,
          objective: `第${chapter}章目标`,
          constraints: [],
          characters: [],
          locations: [],
          continuity_notes: [],
          root,
        })
        await engine.getBrief({ stage: 'P2', root })
        await engine.submitChapterPlan({
          chapter: 0,
          title: TITLES[chapter]!,
          scene_type: SCENES[chapter]!,
          narrator: '他',
          beats: ['起', '承', '转', '合'],
          opening: '开场',
          ending: '断章',
          target_words: [80, 400],
          root,
        })
        await engine.getBrief({ stage: 'P3', root })
        await engine.submitDraft({
          chapter,
          content: text,
          chapter_title: TITLES[chapter]!,
          scene_type: SCENES[chapter]!,
          narrator: '他',
          summary: SUMMARY,
          root,
        })
        await engine.getBrief({ stage: 'P4', root })
        await engine.submitReview({ chapter, ...sampleReview(chapter, text), root })
        await engine.getBrief({ stage: 'P6', root })
        await engine.runCheck({ chapter, root })
        await engine.getBrief({ stage: 'P8', root })
        const archived = await engine.archiveChapter({ chapter, root })
        expect(archived.data.chapter).toBe(chapter)
      }

      const summary = await engine.panelSummary({ root })
      expect(summary.totalChapters).toBe(3)
      expect(summary.chapter).toBe(4)
      expect(summary.stage).toBe('done')
      const rows = (await engine.panelChapters({ root })).rows
      expect(rows.map((row) => row.num)).toEqual([1, 2, 3])
      expect(rows.every((row) => row.status === 'passed')).toBe(true)
      const stats = await engine.stats({ root })
      expect(stats.chapters).toBe(3)
      expect(stats.totalWords).toBeGreaterThan(300)
      const journal = await engine.auditHistory({ root, limit: 200 })
      expect(journal.data.filter((row) => row.op === 'archiveChapter')).toHaveLength(3)
      const epub = await engine.export({ kind: 'epub', root })
      expect(epub.data.files).toContain('exports/book.epub')
      const oneChapter = await engine.export({ kind: 'md', chapter: 1, root })
      expect(oneChapter.data.files).toContain('exports/book.md')
      const markdown = await engine.diff({ chapter: 1, root })
      expect(markdown.data.before.length).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })
})
