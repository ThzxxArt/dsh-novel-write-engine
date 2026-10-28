import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'
import { archiveDelta, harness, sampleReview, sampleSemantic, sampleSummary } from './helpers.js'
import { appendJournal } from '../src/store/journal.js'
import { FsStore } from '../src/store/fs.js'
import type { ChapterSummary, SceneType } from '../src/types.js'

const SCENES: SceneType[] = ['日常过渡章', '战斗/动作章', '情感爆发章', '纯叙事章']

const LEXICON = Array.from('雨灯信箱门风窗纸墨钟影街伞夜泥水雾云石阶旧楼长巷冷光尘火舟岸潮声')
const chapterText = (chapter: number): string => {
  let seed = chapter * 9301 + 49297
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const paragraphs: string[] = []
  for (let paragraph = 0; paragraph < 4; paragraph += 1) {
    const sentences: string[] = []
    for (let sentence = 0; sentence < 4; sentence += 1) {
      const length = 8 + Math.floor(next() * 12)
      let line = ''
      for (let index = 0; index < length; index += 1) {
        line += LEXICON[Math.floor(next() * LEXICON.length)] ?? '雨'
      }
      sentences.push(`${line}。`)
    }
    paragraphs.push(sentences.join(''))
  }
  return paragraphs.join('\n\n')
}

const summaryFor = (chapter: number, text: string): ChapterSummary =>
  sampleSummary({
    events: [`第${chapter}章收到新线索`],
    characters_appeared: [],
    opening: text.split('\n\n')[0]!.slice(0, 14),
    continuity: { opens_from: chapter === 1 ? '故事开始' : `第${chapter - 1}章结尾`, ends_with: '雨声' },
  })

const oneChapter = async (input: {
  root: string
  engine: Awaited<ReturnType<typeof harness>>['engine']
  chapter: number
}): Promise<void> => {
  const { root, engine, chapter } = input
  const text = chapterText(chapter)
  const scene = SCENES[(chapter - 1) % SCENES.length]!
  await engine.getBrief({ stage: 'P1', root })
  await engine.submitWorldPlan({
    chapter: 0,
    objective: `第${chapter}章：让主角在雨夜追查线索 ${chapter}`,
    constraints: ['没有超能力'],
    characters: [{ name: '他', role: '主角', current_state: '警惕' }],
    locations: [{ name: `旧楼${chapter}`, layout: '一层两户', capacity: 20 }],
    continuity_notes: ['雨夜'],
    root,
  })
  await engine.getBrief({ stage: 'P2', root })
  await engine.submitChapterPlan({
    chapter: 0,
    title: '长夜来信',
    scene_type: scene,
    narrator: '他',
    beats: ['雨落', '信到', '拆封', '读信', '决定'],
    opening: text.split('\n\n')[0]!.slice(0, 14),
    ending: '雨声',
    target_words: [80, 400],
    cast: [{ name: '他', goal: '查清来信', entry_state: '警惕' }],
    root,
  })
  await engine.getBrief({ stage: 'P3', root })
  const summary = summaryFor(chapter, text)
  await engine.submitDraft({
    chapter,
    content: text,
    chapter_title: '长夜来信',
    scene_type: scene,
    narrator: '他',
    summary,
    root,
  })
  await engine.getBrief({ stage: 'P4', root })
  await engine.submitReview({ chapter, ...sampleReview(chapter, text), root })
  await engine.getBrief({ stage: 'P6', root })
  await engine.runCheck({ chapter, semantic: sampleSemantic(text), root })
  await engine.getBrief({ stage: 'P8', root })
  await engine.archiveChapter({
    chapter,
    state_delta: archiveDelta(summary, { existing: chapter === 1 ? [] : ['他'] }),
    root,
  })
  expect((await engine.queryState({ kind: 'pipeline', root })).data).toMatchObject({
    stage: 'done',
    chapter: chapter + 1,
  })
}

describe('0.1.3 scale and handoff', () => {
  it('runs 30 chapters through the public engine and keeps volume/act inherited', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '三十章长夜',
        genre: '悬疑推理',
        platform: 'fanqie',
        words_per_chapter: [80, 400],
        total_chapters: 30,
        root,
      })
      for (let chapter = 1; chapter <= 30; chapter += 1) {
        await oneChapter({ root, engine, chapter })
        if (chapter === 6) {
          const handoff = (await engine.queryState({ kind: 'handoff', root })).data as {
            volume: number
            act: string
            act_progress: string
          }
          expect(handoff.volume).toBe(1)
          expect(handoff.act).toBe('第二幕')
          expect(handoff.act_progress).toBe('1/5')
          const active = await engine.getStatus({ root })
          expect(active.data.act).toBe('第二幕')
          expect(active.data.act_progress).toBe('2/5')
        }
        if (chapter === 21) {
          const handoff = (await engine.queryState({ kind: 'handoff', root })).data as {
            volume: number
            volume_name: string
            act: string
            act_progress: string
          }
          expect(handoff.volume).toBe(1)
          expect(handoff.volume_name).toBe('第一卷')
          expect(handoff.act).toBe('第五幕')
          expect(handoff.act_progress).toBe('1/5')
        }
      }
      const handoff = (await engine.queryState({ kind: 'handoff', root })).data as {
        current_chapter: number
        next_chapter: number
        volume: number
      }
      expect(handoff).toMatchObject({ current_chapter: 30, next_chapter: 31, volume: 1 })
      const panel = await engine.panelBundle({ root })
      expect(panel.summary.finished).toBe(true)
      expect(panel.chapters.rows).toHaveLength(30)
      expect(panel.chapters.rows.at(-1)).toMatchObject({ num: 30, status: 'passed' })
      const scores = panel.chapters.rows.map((row) => row.score)
      expect(panel.summary.averageScore).toBeCloseTo(
        scores.reduce((sum, score) => sum + score, 0) / scores.length,
      )
      await expect(
        engine.amend({
          path: 'novel.yaml',
          content: { total_chapters: 29 },
          reason: 'set a target below the archived count',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  }, 120_000)

  it('amends a project with a 1000-row journal without rescanning per row', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '长日志', genre: '都市现代', platform: 'fanqie', root })
      for (let index = 0; index < 1000; index += 1) {
        await appendJournal(new FsStore(root), {
          txid: `bench-${index}`,
          at: new Date(index * 1000).toISOString(),
          op: 'bench',
          chapter: 0,
          revision: index,
          files: [],
          status: 'committed',
        })
      }
      const readText = vi.spyOn(FsStore.prototype, 'readText')
      const started = performance.now()
      try {
        await engine.amend({
          path: 'state/handoff.yaml',
          content: {
            schema_version: 1,
            current_chapter: 0,
            volume: 1,
            volume_name: '第一卷',
            act: '第一幕',
            act_progress: '0/5',
            next_chapter: 1,
            last_summary: '',
            open_hooks: [],
            updated_at: new Date(0).toISOString(),
          },
          reason: 'benchmark amend with a long journal',
          root,
        })
      } finally {
        readText.mockRestore()
      }
      const journalReads = readText.mock.calls.filter(([path]) => path === 'state/journal.jsonl').length
      expect(journalReads).toBeLessThan(10)
      expect(performance.now() - started).toBeLessThan(5_000)
    } finally {
      await cleanup()
    }
  }, 120_000)
})
