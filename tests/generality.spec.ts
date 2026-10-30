import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  archiveDelta,
  harness,
  readProjectFile,
  sampleReview,
  sampleSemantic,
  sampleSummary,
} from './helpers.js'
import type { Genre } from '../src/types.js'

interface Scenario {
  genre: Genre
  title: string
  objective: string
  text: string
}

/**
 * The same pipeline must accept unrelated genres without borrowing the vocabulary
 * of any one book. Each text is original, contains five distinct sentences, and
 * carries no entities that need archive reconciliation.
 */
const SCENARIOS: Scenario[] = [
  {
    genre: '玄幻修仙',
    title: '山门夜雨',
    objective: '把裂纹玉牌交到长老手中',
    text: [
      '山门外的石阶被夜雨洗得发亮，他提着灯笼一步步往上走。',
      '守门弟子拦在牌坊下，问他为何深夜回山。',
      '他从袖中取出一枚裂纹玉牌，弟子看了一眼便侧身让路。',
      '殿内灯火昏黄，长老正对着一卷旧册出神。',
      '他把玉牌放在案上，长老的手忽然停住了。',
    ].join('\n\n'),
  },
  {
    genre: '都市现代',
    title: '凌晨的便利店',
    objective: '确认旧车里的来客身份',
    text: [
      '凌晨的便利店只剩冷柜的嗡嗡声，他站在货架前挑了一瓶水。',
      '收银员抬头看了一眼墙上的钟，又低头继续整理小票。',
      '门外忽然传来急刹车的声响，玻璃门被风推得晃了两下。',
      '他付了钱走到路边，看见一辆旧车停在禁停线内。',
      '车窗降下来，里面的人叫出了他多年不用的名字。',
    ].join('\n\n'),
  },
  {
    genre: '西方奇幻',
    title: '北塔的灰烬',
    objective: '查清塔底灰烬里的铜币来历',
    text: [
      '北塔的钟声穿过雾，他沿着石墙摸到那扇生锈的小门。',
      '守夜人把钥匙藏在第三块砖后面，这是他昨夜发现的。',
      '门后是一条向下的螺旋梯，墙上挂着褪色的家族纹章。',
      '他点亮火把，看见地上有一圈新鲜的灰烬。',
      '灰烬中央压着一枚铜币，边缘刻着陌生的字母。',
    ].join('\n\n'),
  },
]

describe('genre-neutral acceptance', () => {
  for (const scenario of SCENARIOS) {
    it(`runs init to archive for ${scenario.genre}`, async () => {
      const { root, engine, cleanup } = await harness()
      try {
        await engine.initProject({
          title: scenario.title,
          genre: scenario.genre,
          platform: 'fanqie',
          root,
          words_per_chapter: [80, 400],
        })
        await engine.getBrief({ stage: 'P1', root })
        await engine.submitWorldPlan({
          chapter: 0,
          objective: scenario.objective,
          constraints: [],
          characters: [],
          locations: [],
          continuity_notes: [],
          root,
        })
        await engine.getBrief({ stage: 'P2', root })
        await engine.submitChapterPlan({
          chapter: 0,
          title: scenario.title,
          scene_type: '日常过渡章',
          narrator: '他',
          beats: ['起', '承', '转', '合', '收'],
          opening: scenario.text.split('\n\n')[0]!.slice(0, 18),
          ending: '停住了',
          target_words: [80, 400],
          root,
        })
        await engine.getBrief({ stage: 'P3', root })
        const summary = sampleSummary({
          events: [scenario.objective],
          characters_appeared: ['他'],
          opening: scenario.text.split('\n\n')[0]!.slice(0, 18),
          continuity: { opens_from: '上一章结尾', ends_with: '本章收束' },
        })
        await engine.submitDraft({
          chapter: 1,
          content: scenario.text,
          chapter_title: scenario.title,
          scene_type: '日常过渡章',
          narrator: '他',
          summary,
          root,
        })
        await engine.getBrief({ stage: 'P4', root })
        await engine.submitReview({ chapter: 1, ...sampleReview(1, scenario.text), root })
        await engine.getBrief({ stage: 'P6', root })
        await engine.runCheck({ chapter: 1, semantic: sampleSemantic(scenario.text), root })
        await engine.getBrief({ stage: 'P8', root })
        const archived = await engine.archiveChapter({
          chapter: 1,
          state_delta: archiveDelta(summary),
          root,
        })

        expect(archived.data.chapter).toBe(1)
        expect(archived.data.score).toBe(145)
        const persisted = parseYaml((await readProjectFile(root, 'novel.yaml'))!) as { genre: string }
        expect(persisted.genre).toBe(scenario.genre)
        expect((await engine.getStatus({ root })).data.chapter).toBe(2)
      } finally {
        await cleanup()
      }
    })
  }
})
