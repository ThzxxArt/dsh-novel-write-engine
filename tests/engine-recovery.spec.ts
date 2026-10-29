import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import { FsStore, appendJournal } from '../src/store/index.js'
import {
  archiveDelta,
  bootstrapToDraft,
  cleanText,
  harness,
  readProjectFile,
  readyToArchive,
  sampleReview,
  sampleSemantic,
  sampleSummary,
  writeDraft,
} from './helpers.js'

describe('0.1.2 recoverable state', () => {
  it('reports a corrupt review and recovers through rollback plus a new review', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      const blocker = {
        id: 'REV-001',
        severity: 'blocker' as const,
        dimension: 'R-W-01',
        location: '第 2 段',
        problem: '缺动机',
        fix: '补理由',
        status: 'open' as const,
      }
      await engine.submitReview({
        chapter: 1,
        ...sampleReview(1, text, { issues: [blocker] }),
        root,
      })
      expect((await engine.getStatus({ root })).data.stage).toBe('P5')
      await writeFile(join(root, 'reviews/ch001.review.yaml'), 'dimensions: [unclosed\n', 'utf8')

      const damaged = await engine.getStatus({ root })
      expect(damaged.data.state_errors).toEqual([
        expect.objectContaining({
          path: 'reviews/ch001.review.yaml',
          code: 'REVIEW_UNREADABLE',
          message: expect.stringContaining('reviews/ch001.review.yaml'),
        }),
      ])
      expect(damaged.data.next).toMatchObject({
        tool: 'novel_rollback',
        args: { chapter: 1, to_stage: 'P4' },
      })
      expect(damaged.data.blocking).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'STATE_UNREADABLE' })]),
      )
      const advice = await engine.advise({ root })
      expect(advice.data.state_errors).toHaveLength(1)
      expect(advice.data.tool).toBe('novel_rollback')
      await expect(
        engine.submitRevision({
          chapter: 1,
          content: text,
          issues: [{ ...blocker, status: 'fixed', evidence: '风从窗缝里挤进来' }],
          proof: sampleReview(1, text).proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_GATE_BLOCKED' })

      const brief = await engine.getBrief({ stage: 'P5', root })
      expect(brief.data.fields.review_error).toContain('reviews/ch001.review.yaml')
      expect((brief.data.context as { review_error: string }).review_error).toContain(
        'reviews/ch001.review.yaml',
      )

      const rolled = await engine.rollback({ chapter: 1, toStage: 'P4', reason: '重建评审', root })
      expect(rolled.data.stage).toBe('P4')
      expect((await engine.getStatus({ root })).data.next).toMatchObject({
        tool: 'novel_brief',
        args: { stage: 'P4', chapter: 1 },
      })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({
        chapter: 1,
        ...sampleReview(1, text, { issues: [{ ...blocker, status: 'fixed', evidence: '风从窗缝里挤进来' }] }),
        root,
      })
      const recovered = await engine.getStatus({ root })
      expect(recovered.data.state_errors).toEqual([])
      expect(recovered.data.stage).toBe('P6')
    } finally {
      await cleanup()
    }
  })

  it('reports a corrupt check and recovers by rollback plus a new check', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = await readyToArchive({ root, engine })
      await writeFile(join(root, 'checks/ch001.check.yaml'), 'verdict: [unclosed\n', 'utf8')

      const damaged = await engine.getStatus({ root })
      expect(damaged.data.state_errors).toEqual([
        expect.objectContaining({
          path: 'checks/ch001.check.yaml',
          code: 'CHECK_UNREADABLE',
        }),
      ])
      expect(damaged.data.next).toMatchObject({
        tool: 'novel_rollback',
        args: { chapter: 1, to_stage: 'P6' },
      })
      await expect(
        engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root }),
      ).rejects.toMatchObject({ code: 'ENGINE_GATE_BLOCKED' })

      const rolled = await engine.rollback({ chapter: 1, toStage: 'P6', reason: '重建校验', root })
      expect(rolled.data.stage).toBe('P6')
      expect((await engine.getStatus({ root })).data.next).toMatchObject({
        tool: 'novel_brief',
        args: { stage: 'P6', chapter: 1 },
      })
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({ chapter: 1, semantic: sampleSemantic(text), root })
      await engine.getBrief({ stage: 'P8', root })
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([])
      const archived = await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root,
      })
      expect(archived.data.chapter).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('reports a corrupt chapter plan and points at rollback before forward writes', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '坏计划', genre: '都市现代', platform: 'fanqie', root })
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
      await writeFile(join(root, 'plans/ch001.chapter.yaml'), 'title: [unclosed\n', 'utf8')
      const damaged = await engine.getStatus({ root })
      expect(damaged.data.state_errors).toEqual([
        expect.objectContaining({
          path: 'plans/ch001.chapter.yaml',
          code: 'PLAN_UNREADABLE',
        }),
      ])
      expect(damaged.data.next).toMatchObject({
        tool: 'novel_brief',
        args: { stage: 'P2', chapter: 1 },
      })
      await engine.getBrief({ stage: 'P2', root })
      expect((await engine.getStatus({ root })).data.next).toMatchObject({
        tool: 'novel_plan_chapter',
      })
      await engine.submitChapterPlan({
        chapter: 0,
        title: '修复后的计划',
        scene_type: '日常过渡章',
        narrator: '他',
        beats: ['起', '承', '转', '合', '收'],
        opening: '风从窗缝里挤进来',
        ending: '蜡印',
        target_words: [80, 400],
        root,
      })
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('blocks a draft when the plan becomes unreadable after P2', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await writeFile(join(root, 'plans/ch001.chapter.yaml'), 'title: [unclosed\n', 'utf8')
      await expect(
        engine.submitDraft({
          chapter: 1,
          content: cleanText(),
          chapter_title: '开端之雨',
          scene_type: '日常过渡章',
          narrator: '他',
          summary: sampleSummary(),
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_GATE_BLOCKED' })
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([
        expect.objectContaining({ code: 'PLAN_UNREADABLE' }),
      ])
      expect((await engine.getStatus({ root })).data.next).toMatchObject({
        tool: 'novel_rollback',
        args: { chapter: 1, to_stage: 'P2' },
      })
      const panel = await engine.panelBundle({ root })
      expect(panel.chapters!.rows.find((row) => row.num === 1)?.status).toBe('blocked')
    } finally {
      await cleanup()
    }
  })

  it('refuses to treat a newer review schema as recoverable damage', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const raw = await readProjectFile(root, 'reviews/ch001.review.yaml')
      const review = parse(raw!) as Record<string, unknown>
      review.schema_version = 2
      await writeFile(join(root, 'reviews/ch001.review.yaml'), stringify(review), 'utf8')
      await expect(engine.getStatus({ root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_TOO_NEW',
      })
    } finally {
      await cleanup()
    }
  })

  it('refuses to treat a newer plan schema as recoverable damage', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const raw = await readProjectFile(root, 'plans/ch001.chapter.yaml')
      const plan = parse(raw!) as Record<string, unknown>
      plan.schema_version = 2
      await writeFile(join(root, 'plans/ch001.chapter.yaml'), stringify(plan), 'utf8')
      await expect(engine.getStatus({ root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_TOO_NEW',
      })
    } finally {
      await cleanup()
    }
  })

  it('reports a review edited after submission and points at rollback', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const raw = await readProjectFile(root, 'reviews/ch001.review.yaml')
      const review = parse(raw!) as Record<string, unknown>
      review.total = 149
      await writeFile(join(root, 'reviews/ch001.review.yaml'), stringify(review), 'utf8')
      const status = await engine.getStatus({ root })
      expect(status.data.blocking).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'REVIEW_DIGEST_MISMATCH' })]),
      )
      expect(status.data.next).toMatchObject({
        tool: 'novel_rollback',
        args: { chapter: 1, to_stage: 'P4' },
      })
      await expect(
        engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID', message: /digest/ })
    } finally {
      await cleanup()
    }
  })

  it('fails closed when a 0.1.1 review has no stored digest', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const raw = await readProjectFile(root, 'state/pipeline.yaml')
      expect(raw).not.toBeNull()
      const pipeline = parse(raw!) as Record<string, unknown>
      delete pipeline.review_digest
      await writeFile(join(root, 'state/pipeline.yaml'), stringify(pipeline), 'utf8')
      const store = new FsStore(root)
      await appendJournal(store, {
        txid: 'legacy-review-digest-test',
        at: new Date(0).toISOString(),
        op: 'test-legacy-pipeline',
        chapter: 1,
        revision: Number(pipeline.revision),
        files: ['state/pipeline.yaml'],
        status: 'committed',
        hashes: { 'state/pipeline.yaml': (await store.hashBytes('state/pipeline.yaml'))! },
      })
      const status = await engine.getStatus({ root })
      expect(status.data.stage).toBe('ready_to_archive')
      expect(status.data.blocking).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'REVIEW_DIGEST_MISSING' })]),
      )
      expect(status.data.next).toMatchObject({
        tool: 'novel_rollback',
        args: { chapter: 1, to_stage: 'P4' },
      })
      await expect(
        engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root }),
      ).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
        message: expect.stringMatching(/review_digest|digest/),
      })
      expect((await engine.getStatus({ root })).data.stage).toBe('ready_to_archive')
    } finally {
      await cleanup()
    }
  })
})
