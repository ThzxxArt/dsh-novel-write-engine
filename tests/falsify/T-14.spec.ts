import { describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineService } from '../../src/engine/service.js'
import {
  archiveDelta,
  cleanText,
  harness,
  readProjectFile,
  sampleReview,
  sampleSemantic,
  sampleSummary,
} from '../helpers.js'

const archiveOne = async (engine: EngineService, root: string): Promise<void> => {
  await engine.initProject({
    title: 'T14',
    genre: '都市现代',
    platform: 'fanqie',
    root,
    words_per_chapter: [80, 400],
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
}

const archiveTxid = async (root: string): Promise<string> => {
  const journal = (await readProjectFile(root, 'state/journal.jsonl'))!
  return journal
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { op: string; status: string; txid: string })
    .filter((row) => row.op === 'archiveChapter' && row.status === 'committed')
    .at(-1)!.txid
}

describe('T-14 reopen is a restore, not a rewrite', () => {
  it('restores the pre-archive index and pipeline', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await archiveOne(engine, root)
      await engine.reopenChapter({ chapter: 1, reason: '改结尾', root })
      const status = await engine.getStatus({ root })
      expect(status.data).toMatchObject({ stage: 'P3', chapter: 1 })
      const chapters = await engine.queryState({ kind: 'chapters', root })
      expect(chapters.data).toMatchObject({ chapters: [] })
    } finally {
      await cleanup()
    }
  })

  it('refuses when the archive backup is gone', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await archiveOne(engine, root)
      const txid = await archiveTxid(root)
      await rm(join(root, 'backups', txid), { recursive: true, force: true })
      await expect(engine.reopenChapter({ chapter: 1, reason: '改结尾', root })).rejects.toMatchObject({
        code: 'ENGINE_TXN_ABORTED',
      })
    } finally {
      await cleanup()
    }
  })
})
