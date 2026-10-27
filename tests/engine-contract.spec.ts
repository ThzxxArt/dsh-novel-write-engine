import { describe, expect, it } from 'vitest'
import { bootstrapToDraft, cleanText, harness, sampleReview, snapshotTree, writeDraft } from './helpers.js'

describe('0.1.2 input contracts', () => {
  it('rejects non-string author and description before creating a project', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const before = await snapshotTree(root)
      await expect(
        engine.initProject({
          title: '坏输入',
          genre: '都市现代',
          platform: 'fanqie',
          author: 42 as never,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.initProject({
          title: '坏输入',
          genre: '都市现代',
          platform: 'fanqie',
          description: [] as never,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      expect([...(await snapshotTree(root)).entries()]).toEqual([...before.entries()])
    } finally {
      await cleanup()
    }
  })

  it('rejects malformed world plans without writing', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '世界契约', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      const before = await snapshotTree(root)
      await expect(
        engine.submitWorldPlan({
          chapter: 0,
          objective: '收到信',
          constraints: '没有超能力' as never,
          characters: [],
          locations: [],
          continuity_notes: [],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitWorldPlan({
          chapter: 0,
          objective: '收到信',
          constraints: [],
          characters: [{ name: '他' }] as never,
          locations: [],
          continuity_notes: [],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitWorldPlan({
          chapter: 0,
          objective: '收到信',
          constraints: [],
          characters: [],
          locations: [{ name: '旧办公室', layout: '三排工位', capacity: '很多' }] as never,
          continuity_notes: [],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      expect([...(await snapshotTree(root)).entries()]).toEqual([...before.entries()])
    } finally {
      await cleanup()
    }
  })

  it('rejects malformed chapter plans without writing', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '计划契约', genre: '都市现代', platform: 'fanqie', root })
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
      const before = await snapshotTree(root)
      const base = {
        chapter: 0,
        scene_type: '日常过渡章' as const,
        narrator: '他',
        opening: '风从窗缝里挤进来',
        ending: '蜡印',
        target_words: [80, 400] as [number, number],
        root,
      }
      await expect(
        engine.submitChapterPlan({ ...base, title: '开端之雨', beats: ['起', '承'] }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitChapterPlan({ ...base, title: '开端', beats: ['起', '承', '转', '合', '收'] }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitChapterPlan({
          ...base,
          title: '开端之雨',
          narrator: ' ',
          beats: ['起', '承', '转', '合', '收'],
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitChapterPlan({
          ...base,
          title: '开端之雨',
          beats: ['起', '承', '转', '合', '收'],
          opening: ' ',
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitChapterPlan({
          ...base,
          title: '开端之雨',
          beats: ['起', '承', '转', '合', '收'],
          target_words: [0, 400],
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      expect([...(await snapshotTree(root)).entries()]).toEqual([...before.entries()])
    } finally {
      await cleanup()
    }
  })

  it('rejects review issues with an unknown dimension, a bad location, or a waived blocker', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      const before = await snapshotTree(root)
      const review = sampleReview(1, text)
      const issue = {
        id: 'REV-001',
        severity: 'blocker' as const,
        dimension: 'R-W-99',
        location: '第 2 段',
        problem: '缺动机',
        fix: '补理由',
        status: 'open' as const,
      }
      await expect(
        engine.submitReview({ chapter: 1, ...review, issues: [issue], root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitReview({
          chapter: 1,
          ...review,
          issues: [{ ...issue, dimension: 'R-W-01', location: '第 99 段' }],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitReview({
          chapter: 1,
          ...review,
          issues: [{ ...issue, dimension: 'R-W-01', status: 'waived' }],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      expect([...(await snapshotTree(root)).entries()]).toEqual([...before.entries()])
    } finally {
      await cleanup()
    }
  })

  it('rejects duplicate issue ids before writing a review', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      const issue = {
        id: 'REV-DUP',
        severity: 'blocker' as const,
        dimension: 'R-W-01',
        location: '第 2 段',
        problem: '缺动机',
        fix: '补理由',
        status: 'open' as const,
      }
      const before = await snapshotTree(root)
      await expect(
        engine.submitReview({
          chapter: 1,
          ...sampleReview(1, text, { issues: [issue, { ...issue }] }),
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      expect([...(await snapshotTree(root)).entries()]).toEqual([...before.entries()])
    } finally {
      await cleanup()
    }
  })

  it('does not let a revision rewrite an issue definition', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      const issue = {
        id: 'REV-IMMUTABLE',
        severity: 'blocker' as const,
        dimension: 'R-W-01',
        location: '第 2 段',
        problem: '缺动机',
        fix: '补理由',
        status: 'open' as const,
      }
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text, { issues: [issue] }), root })
      await engine.getBrief({ stage: 'P5', root })
      const before = await snapshotTree(root)
      await expect(
        engine.submitRevision({
          chapter: 1,
          content: text,
          issues: [
            {
              ...issue,
              status: 'fixed',
              evidence: '风从窗缝里挤进来',
              problem: '把问题描述改掉',
            },
          ],
          proof: sampleReview(1, text).proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      expect([...(await snapshotTree(root)).entries()]).toEqual([...before.entries()])
    } finally {
      await cleanup()
    }
  })

  it('accepts a revision that submits only the changed status and evidence', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      const issue = {
        id: 'REV-MIN',
        severity: 'blocker' as const,
        dimension: 'R-W-01',
        location: '第 2 段',
        problem: '缺动机',
        fix: '补理由',
        status: 'open' as const,
      }
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text, { issues: [issue] }), root })
      await engine.getBrief({ stage: 'P5', root })
      const revised = await engine.submitRevision({
        chapter: 1,
        content: text,
        issues: [{ id: issue.id, status: 'fixed', evidence: '风从窗缝里挤进来' }] as never,
        proof: sampleReview(1, text).proof,
        root,
      })
      expect(revised.data.stage).toBe('P4')
    } finally {
      await cleanup()
    }
  })

  it('refuses a rollback to a later stage', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const before = await snapshotTree(root)
      await expect(engine.rollback({ chapter: 1, toStage: 'P6', root })).rejects.toMatchObject({
        code: 'ENGINE_STAGE_ORDER',
      })
      expect([...(await snapshotTree(root)).entries()]).toEqual([...before.entries()])
      expect((await engine.getStatus({ root })).data.stage).toBe('P3')
    } finally {
      await cleanup()
    }
  })
})
