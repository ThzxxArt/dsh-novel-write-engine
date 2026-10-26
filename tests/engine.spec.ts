import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  harness,
  readyToArchive,
  readProjectFile,
  snapshotTree,
  cleanText,
  sampleReview,
  sampleSummary,
  archiveDelta,
  bootstrapToDraft,
  writeDraft,
} from './helpers.js'
import { EngineBlockedError, EngineInputError } from '../src/types.js'

describe('engine lifecycle', () => {
  it('runs init → plans → draft → review → check → archive with zero manual file edits', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = await readyToArchive({ root, engine })
      const result = await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root,
      })
      expect(result.data.chapter).toBe(1)
      expect(result.data.score).toBe(145)
      expect(result.data.metrics.total_word_count).toBeGreaterThan(80)

      const pipeline = parseYaml((await readProjectFile(root, 'state/pipeline.yaml'))!) as {
        stage: string
        chapter: number
      }
      expect(pipeline.stage).toBe('done')
      expect(pipeline.chapter).toBe(2)

      const chapters = await engine.panelChapters({ root })
      expect(chapters.rows).toHaveLength(1)
      expect(chapters.rows[0]).toMatchObject({ num: 1, title: '开端之雨', score: 145, status: 'passed' })

      const journal = await engine.auditHistory({ root, limit: 100 })
      expect(journal.data.some((row) => row.op === 'archiveChapter' && row.status === 'committed')).toBe(true)
      expect(journal.data.some((row) => row.status === 'aborted')).toBe(false)
      void text
    } finally {
      await cleanup()
    }
  })

  it('refuses to init over an existing project', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await expect(
        engine.initProject({ title: '第二本', genre: '都市现代', platform: 'fanqie', root }),
      ).rejects.toMatchObject({ code: 'ENGINE_PROJECT_EXISTS' })
    } finally {
      await cleanup()
    }
  })

  it('blocks on a gate without writing a single file (T-01)', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await engine.getBrief({ stage: 'P3', root })
      const before = await snapshotTree(root)
      await expect(
        engine.submitDraft({
          chapter: 1,
          content: '他推开门，看见桌上放着「一封信」。\n\n他坐下来。',
          chapter_title: '开端之雨',
          scene_type: '日常过渡章',
          narrator: '他',
          summary: sampleSummary(),
          root,
        }),
      ).rejects.toBeInstanceOf(EngineBlockedError)
      const after = await snapshotTree(root)
      expect(after).toEqual(before)
    } finally {
      await cleanup()
    }
  })

  it('replays an idempotent submission instead of writing twice', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await writeDraft({ root, engine })
      const first = await engine
        .submitDraft({
          chapter: 1,
          content: cleanText(),
          chapter_title: '开端之雨',
          scene_type: '日常过渡章',
          narrator: '他',
          summary: sampleSummary(),
          root,
        })
        .catch((error: unknown) => error)
      // The stage is already P4, so a second identical submission is answered from the replay cache.
      expect(first).toBeDefined()
      await engine.getBrief({ stage: 'P4', root })
      const review = sampleReview(1, cleanText())
      await engine.submitReview({ chapter: 1, ...review, root })
      const journal = await engine.auditHistory({ root, limit: 100 })
      const drafts = journal.data.filter((row) => row.op === 'submitDraft')
      expect(drafts).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })

  it('serializes concurrent archives: one commits, the other fails cleanly (T-02)', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const results = await Promise.allSettled([
        engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root }),
        engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root }),
      ])
      const fulfilled = results.filter((result) => result.status === 'fulfilled')
      const rejected = results.filter((result) => result.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      const rows = (await engine.panelChapters({ root })).rows
      expect(rows).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })

  it('rejects an out-of-order operation with the stage in the message', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const error = await engine
        .submitReview({ chapter: 1, ...sampleReview(1, cleanText()), root })
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(EngineInputError)
      expect((error as EngineInputError).code).toBe('ENGINE_STAGE_ORDER')
      expect((error as Error).message).toContain('not allowed')
    } finally {
      await cleanup()
    }
  })

  it('counts words with the engine rule and answers state queries', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const metrics = await engine.countWords({ text: '你好，world 123。', root })
      expect(metrics.data).toMatchObject({ cjk_chars: 2, english_words: 1, numbers: 1 })
      expect(metrics.data.total_word_count).toBe(
        metrics.data.cjk_chars +
          metrics.data.english_words +
          metrics.data.numbers +
          metrics.data.chinese_punct +
          metrics.data.english_punct,
      )
      const pipeline = await engine.queryState({ kind: 'pipeline', root })
      expect((pipeline.data as { stage: string }).stage).toBe('P3')
      const missing = await engine.queryState({ kind: 'handoff', root })
      expect(missing.data).not.toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('advises the next operation and projects a consistent panel', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const advice = await engine.advise({ root })
      expect(advice.data.tool).toBe('novel_write_draft')
      const summary = await engine.panelSummary({ root })
      const gates = await engine.panelGates({ root })
      expect(summary.stage).toBe(gates.stage)
      expect(summary.chapter).toBe(3 - 2)
      expect(summary.phases.find((phase) => phase.active)?.id).toBe('P3')
    } finally {
      await cleanup()
    }
  })
})
