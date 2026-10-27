import { describe, expect, it } from 'vitest'
import { archiveDelta, harness, sampleReview, sampleSemantic, sampleSummary } from './helpers.js'
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

const summaryFor = (text: string): ChapterSummary =>
  sampleSummary({
    opening: text.split('\n\n')[0]!.slice(0, 20),
    continuity: { opens_from: '上一章结尾', ends_with: '——' },
  })

const SCENES: Record<number, SceneType> = { 1: '日常过渡章', 2: '纯叙事章', 3: '情感爆发章' }
const TITLES: Record<number, string> = { 1: '开端之雨', 2: '旧城之影', 3: '灯下之言' }

describe('three-chapter end to end', () => {
  it('runs a P4 → P5 → P4 revision round with evidence', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '修订之书',
        genre: '都市现代',
        platform: 'fanqie',
        root,
        words_per_chapter: [80, 400],
      })
      await engine.getBrief({ stage: 'P1', root })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: '收到信',
        constraints: [],
        characters: [],
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
        beats: ['起', '承'],
        opening: '开场',
        ending: '断章',
        target_words: [80, 400],
        root,
      })
      const text = [
        '风从窗缝里挤进来，把桌上的纸吹得翻了一页。他伸手压住，指腹沾了一点灰。',
        '走廊尽头传来脚步声，不快不慢，在门口停了两秒。他没有抬头，只把笔帽扣紧。',
        '门被推开时带进一股凉气，来人把一只旧信封放在桌角，指尖敲了两下。',
        '信封没有署名，封口处压着一枚暗红的蜡印，边缘已经磨得发白。',
      ].join('\n\n')
      await engine.getBrief({ stage: 'P3', root })
      await engine.submitDraft({
        chapter: 1,
        content: text,
        chapter_title: '开端之雨',
        scene_type: '日常过渡章',
        narrator: '他',
        summary: summaryFor(text),
        root,
      })
      await engine.getBrief({ stage: 'P4', root })
      const review = sampleReview(1, text)
      const blocker = {
        id: 'REV-001',
        severity: 'blocker' as const,
        dimension: 'R-W-04',
        location: '第 2 段',
        problem: '动机缺失',
        fix: '补一句动作动机',
        status: 'open' as const,
      }
      const first = await engine.submitReview({
        chapter: 1,
        ...review,
        issues: [blocker],
        root,
      })
      expect(first.data.next_stage).toBe('P5')

      await engine.getBrief({ stage: 'P5', root })
      const revised = `${text}\n\n他把信翻过来，背面有一行被水晕开的字。`
      await engine.submitRevision({
        chapter: 1,
        content: revised,
        issues: [{ ...blocker, status: 'fixed', evidence: '风从窗缝里挤进来' }],
        proof: sampleReview(1, revised).proof,
        root,
      })
      const status = await engine.getStatus({ root })
      expect(status.data.stage).toBe('P4')

      await engine.getBrief({ stage: 'P4', root })
      const second = await engine.submitReview({ chapter: 1, ...sampleReview(1, revised), root })
      expect(second.data.next_stage).toBe('P6')
    } finally {
      await cleanup()
    }
  })

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
          summary: summaryFor(text),
          root,
        })
        await engine.getBrief({ stage: 'P4', root })
        await engine.submitReview({ chapter, ...sampleReview(chapter, text), root })
        await engine.getBrief({ stage: 'P6', root })
        await engine.runCheck({ chapter, semantic: sampleSemantic(text), root })
        await engine.getBrief({ stage: 'P8', root })
        const archived = await engine.archiveChapter({
          chapter,
          state_delta: archiveDelta(summaryFor(text), { existing: chapter > 1 ? ['他'] : [] }),
          root,
        })
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
      expect(oneChapter.data.files).toContain('exports/book-ch001.md')
      const markdown = await engine.diff({ chapter: 1, root })
      expect(markdown.data.before.length).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })
})
