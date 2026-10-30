import { describe, expect, it } from 'vitest'
import { FsStore } from '../src/store/fs.js'
import {
  archiveDelta,
  harness,
  bootstrapToDraft,
  cleanText,
  readProjectFile,
  readyToArchive,
  sampleReview,
  sampleSemantic,
  sampleSummary,
  writeDraft,
} from './helpers.js'
import { EngineBlockedError, EngineInputError } from '../src/types.js'
import type { ChapterSummary } from '../src/types.js'

const summaryWith = (patch: Partial<ChapterSummary>): ChapterSummary => sampleSummary(patch)

describe('query operations', () => {
  it('serves every state kind and rejects an unknown one', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await writeDraft({ root, engine })
      for (const kind of [
        'pipeline',
        'chapters',
        'characters',
        'world',
        'locks',
        'timeline',
        'foreshadows',
        'relationships',
        'handoff',
        'novel',
        'planWorld',
        'planChapter',
      ] as const) {
        const result = await engine.queryState({ kind, root })
        expect(result.data, kind).not.toBeNull()
      }
      expect((await engine.queryState({ kind: 'review', root })).data).toBeNull()
      await expect(engine.queryState({ kind: 'nope' as never, root })).rejects.toMatchObject({
        code: 'ENGINE_CONFIG_INVALID',
      })
      expect((await engine.queryState({ kind: 'planChapter', root })).data).toMatchObject({
        title: '开端之雨',
      })
    } finally {
      await cleanup()
    }
  })

  it('reports status and falls back when a chapter has no file', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      expect((await engine.getStatus({ root })).data.next.tool).toBe('novel_brief')
      await engine.getBrief({ stage: 'P3', root })
      const plain = await engine.getStatus({ root })
      const markdown = await engine.getStatus({ root, chapter: 99 })
      expect(markdown.data.metrics).toBeNull()
      expect(markdown.data.chapter).toBe(99)
      expect(markdown.data.active_chapter).toBe(1)
      expect(plain.data.next.tool).toBe('novel_write_draft')
      const blocked = await engine.getStatus({ root })
      expect(blocked.data.blocking).toEqual([])
      const count = await engine.countWords({ chapter: 1, root })
      expect(count.data.total_word_count).toBe(0)
    } finally {
      await cleanup()
    }
  })
})

describe('maintenance operations', () => {
  it('amends an allowlisted state document and records the reason', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const before = await engine.queryState({ kind: 'characters', root })
      const changed = (before.data as { characters: unknown[] }).characters
      changed.push({
        name: '他',
        role: 'protagonist',
        first_appearance: 1,
        profile: {},
        current_state: {},
        growth: [],
        updated_at: 1,
      })
      const result = await engine.amend({
        path: 'state/characters.yaml',
        content: before.data as Record<string, unknown>,
        reason: '补录主角',
        root,
      })
      expect(result.data.path).toBe('state/characters.yaml')
      const after = await engine.queryState({ kind: 'characters', root })
      expect((after.data as { characters: unknown[] }).characters).toHaveLength(1)
      const duplicated = {
        ...(after.data as Record<string, unknown>),
        characters: [
          ...(after.data as { characters: unknown[] }).characters,
          (after.data as { characters: unknown[] }).characters[0],
        ],
      }
      await expect(
        engine.amend({
          path: 'state/characters.yaml',
          content: duplicated,
          reason: '重复姓名应被拒绝',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const audit = await engine.auditHistory({ root, limit: 5 })
      expect(audit.data.at(-1)?.op).toBe('amend')
    } finally {
      await cleanup()
    }
  })

  it('refuses to amend the manuscript, the pipeline, or without a reason', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await expect(
        engine.amend({ path: 'chapters/chapter-001.md', content: {}, reason: 'x', root }),
      ).rejects.toBeInstanceOf(EngineInputError)
      await expect(
        engine.amend({ path: 'state/pipeline.yaml', content: { schema_version: 1 }, reason: 'x', root }),
      ).rejects.toBeInstanceOf(EngineInputError)
      await expect(
        engine.amend({
          path: 'state/world.yaml',
          content: {
            schema_version: 1,
            locations: [],
            abilities: [],
            artifacts: [],
            factions: [],
            rules: [],
          },
          reason: '   ',
          root,
        }),
      ).rejects.toBeInstanceOf(EngineInputError)
    } finally {
      await cleanup()
    }
  })

  it('rolls back to an earlier stage, resets rounds and keeps the discarded draft', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await writeDraft({ root, engine })
      await expect(engine.rollback({ chapter: 1, toStage: 'P9' as never, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      const result = await engine.rollback({ chapter: 1, toStage: 'P3', reason: '重排', root })
      expect(result.data.stage).toBe('P3')
      const status = await engine.getStatus({ root })
      expect(status.data.rounds).toEqual({ review: 0, revise: 0, check: 0 })
      expect((await engine.advise({ root })).data.tool).toBe('novel_brief')
      const brief = await engine.getBrief({ stage: 'P3', root })
      expect(brief.replayed).toBeUndefined()
      expect((await engine.advise({ root })).data.tool).toBe('novel_write_draft')
      expect(await readProjectFile(root, 'chapters/chapter-001.deprecated.md')).toBe(cleanText())
    } finally {
      await cleanup()
    }
  })

  it('diffs against the supplied texts and against the last archive backup', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const explicit = await engine.diff({ chapter: 1, before: 'a\nb', after: 'a\nc', root })
      expect(explicit.data).toMatchObject({ added: 1, removed: 1 })
      const archivedText = cleanText()
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const fromBackup = await engine.diff({ chapter: 1, after: archivedText, root })
      expect(fromBackup.data.before.length).toBeGreaterThan(0)
      const empty = await engine.diff({ chapter: 1, before: '', after: '', root })
      expect(empty.data.hunks).toEqual([])
      const missing = await engine.diff({ chapter: 9, root })
      expect(missing.data.hunks).toEqual([])
      await expect(engine.diff({ chapter: 0, root })).rejects.toBeInstanceOf(EngineInputError)
    } finally {
      await cleanup()
    }
  })

  it('audits with a limit and reports malformed journals as warnings', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const audit = await engine.auditHistory({ root, limit: 1 })
      expect(audit.data).toHaveLength(1)
      await engine.stats({ root })
    } finally {
      await cleanup()
    }
  })
})

describe('revision paths', () => {
  it('review with an open blocker moves to P5, then a fixed issue moves back to P4', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      const review = sampleReview(1, text, {
        issues: [
          {
            id: 'REV-001',
            severity: 'blocker',
            dimension: 'R-W-01',
            location: '第 2 段',
            problem: '缺动机',
            fix: '补一句理由',
            status: 'open',
          },
        ],
      })
      const result = await engine.submitReview({ chapter: 1, ...review, root })
      expect(result.data.next_stage).toBe('P5')

      await engine.getBrief({ stage: 'P5', root })
      const revised = text.replace('他伸手压住', '他因为怕纸飞走，伸手压住')
      const evidence = '他因为怕纸飞走，伸手压住'
      const fixed = await engine.submitRevision({
        chapter: 1,
        content: revised,
        issues: [
          {
            id: 'REV-001',
            severity: 'blocker',
            dimension: 'R-W-01',
            location: '第 2 段',
            problem: '缺动机',
            fix: '补一句理由',
            status: 'fixed',
            evidence,
          },
        ],
        proof: sampleReview(1, revised).proof,
        root,
      })
      expect(fixed.data.stage).toBe('P4')
      const repeated = await engine.submitRevision({
        chapter: 1,
        content: revised,
        issues: [
          {
            id: 'REV-001',
            severity: 'blocker',
            dimension: 'R-W-01',
            location: '第 2 段',
            problem: '缺动机',
            fix: '补一句理由',
            status: 'fixed',
            evidence,
          },
        ],
        proof: sampleReview(1, revised).proof,
        root,
      })
      expect(repeated.replayed).toBe(true)
      const reviewFile = await engine.queryState({ kind: 'review', root })
      expect((reviewFile.data as { issues: Array<{ status: string }> }).issues[0]!.status).toBe('fixed')
    } finally {
      await cleanup()
    }
  })

  it('rejects an omitted summary when the revised opening no longer matches it', async () => {
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
        fix: '补一句理由',
        status: 'open' as const,
      }
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text, { issues: [blocker] }), root })
      await engine.getBrief({ stage: 'P5', root })
      const revised = text.replace(/^风从窗缝里挤进来，/, '夜色从窗缝里挤进来，')
      const evidence = '夜色从窗缝里挤进来'
      await expect(
        engine.submitRevision({
          chapter: 1,
          content: revised,
          issues: [{ ...blocker, status: 'fixed', evidence }],
          proof: sampleReview(1, revised).proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('a failed semantic check moves to P6 and a revision returns to P4', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      const review = sampleReview(1, text)
      const submitted = await engine.submitReview({ chapter: 1, ...review, root })
      expect(submitted.replayed).not.toBe(true)
      const repeatedReview = await engine.submitReview({ chapter: 1, ...review, root })
      expect(repeatedReview.replayed).toBe(true)
      await engine.getBrief({ stage: 'P6', root })
      const checked = await engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(text, {
          'L2-VOICE': { verdict: 'fail', evidence: '没有抬头，只把笔', note: '声音无区分' },
        }),
        root,
      })
      expect(checked.data.verdict).toBe('fail')
      expect(checked.data.stage).toBe('P6')
      expect((await engine.getStatus({ root })).data.next).toMatchObject({
        tool: 'novel_brief',
        args: { stage: 'P6', chapter: 1 },
      })
      await engine.getBrief({ stage: 'P6', root })
      expect((await engine.getStatus({ root })).data.next.tool).toBe('novel_revise')
      const revised = await engine.submitRevision({
        chapter: 1,
        content: text,
        proof: sampleReview(1, text).proof,
        root,
      })
      expect(revised.data.stage).toBe('P4')
    } finally {
      await cleanup()
    }
  })

  it('a revision without changes still advances, keeping the previous summary', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await writeDraft({ root, engine })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, cleanText()), root })
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(cleanText(), {
          'L2-VOICE': { verdict: 'fail', evidence: '没有抬头，只把笔', note: '声音无区分' },
        }),
        root,
      })
      await engine.getBrief({ stage: 'P6', root })
      await engine.submitRevision({
        chapter: 1,
        content: cleanText(),
        proof: sampleReview(1, cleanText()).proof,
        root,
      })
      expect((await engine.queryState({ kind: 'planChapter', root })).data).toMatchObject({
        summary: { events: ['收到无名信封'] },
      })
    } finally {
      await cleanup()
    }
  })
})

describe('archive ledger effects', () => {
  it('reuses a still-current brief after rollback instead of replaying stale state', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await writeDraft({ root, engine })
      await engine.rollback({ chapter: 1, toStage: 'P3', reason: '重写', root })
      await engine.getBrief({ stage: 'P3', root })
      const repeat = await engine.getBrief({ stage: 'P3', root })
      expect(repeat.replayed).toBe(true)
      const receipts = await engine.queryState({ kind: 'briefs', root })
      expect(
        (receipts.data as { receipts: Array<{ stage: string }> }).receipts.some(
          (receipt) => receipt.stage === 'P3',
        ),
      ).toBe(true)
      await engine.submitDraft({
        chapter: 1,
        content: cleanText(),
        chapter_title: '开端之雨',
        scene_type: '日常过渡章',
        narrator: '他',
        summary: sampleSummary(),
        root,
      })
    } finally {
      await cleanup()
    }
  })

  it('allocates, advances and resolves foreshadows across chapters', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '伏笔之书',
        genre: '都市现代',
        platform: 'fanqie',
        root,
        words_per_chapter: [80, 400],
      })
      const plant = summaryWith({
        foreshadows: {
          planted: [{ key: 'letter', title: '旧信封', description: '无名信' }],
          advanced: [],
          resolved: [],
        },
      })
      const chapterOne = await archiveOne({
        root,
        engine,
        chapter: 1,
        title: '开端之雨',
        text: textFor(1),
        summary: plant,
      })
      expect(chapterOne.assigned_ids.letter).toBe('FS-001')

      const advanced = summaryWith({
        foreshadows: {
          planted: [],
          advanced: [{ key: 'FS-001', note: '日期被改', new_info: true }],
          resolved: [],
        },
      })
      const chapterTwo = await archiveOne({
        root,
        engine,
        chapter: 2,
        title: '旧城之影',
        text: textFor(2),
        summary: advanced,
        scene: '纯叙事章',
      })
      expect(chapterTwo.assigned_ids['FS-001']).toBe('FS-001')
      const afterAdvance = await engine.queryState({ kind: 'foreshadows', root })
      expect((afterAdvance.data as { items: Array<{ status: string }> }).items[0]!.status).toBe('advanced')

      const resolved = summaryWith({
        foreshadows: { planted: [], advanced: [], resolved: ['FS-001'] },
      })
      await archiveOne({
        root,
        engine,
        chapter: 3,
        title: '灯下之言',
        text: textFor(3),
        summary: resolved,
        scene: '情感爆发章',
      })
      const afterResolve = await engine.queryState({ kind: 'foreshadows', root })
      expect(
        (afterResolve.data as { items: Array<{ status: string; resolved_at: number }> }).items[0],
      ).toMatchObject({ status: 'resolved', resolved_at: 3 })
      const timeline = await engine.queryState({ kind: 'timeline', root })
      expect((timeline.data as { items: unknown[] }).items).toHaveLength(3)
      const handoff = await engine.queryState({ kind: 'handoff', root })
      expect((handoff.data as { current_chapter: number }).current_chapter).toBe(3)
    } finally {
      await cleanup()
    }
  }, 30_000)
})

describe('error families', () => {
  it('rejects empty plan/draft fields before touching the project', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '输入校验', genre: '都市现代', platform: 'fanqie', root })
      expect(engine.defaultRoot()).toContain(root)
      await expect(
        engine.submitWorldPlan({
          objective: ' ',
          constraints: [],
          characters: [],
          locations: [],
          root,
        } as never),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitChapterPlan({
          title: '',
          scene_type: '日常过渡章',
          narrator: '他',
          beats: [],
          opening: '',
          ending: '',
          target_words: [2000, 3000],
          root,
        } as never),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitChapterPlan({
          title: '开端',
          scene_type: '未知场景',
          narrator: '他',
          beats: [],
          opening: '',
          ending: '',
          target_words: [2000, 3000],
          root,
        } as never),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitChapterPlan({
          title: '开端',
          scene_type: '日常过渡章',
          narrator: '他',
          beats: [],
          opening: '',
          ending: '',
          target_words: [3000, 2000],
          root,
        } as never),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitDraft({
          chapter: 1,
          content: ' ',
          chapter_title: '开端',
          scene_type: '日常过渡章',
          narrator: '他',
          summary: sampleSummary(),
          root,
        } as never),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitDraft({
          chapter: 1,
          content: cleanText(),
          chapter_title: '',
          scene_type: '日常过渡章',
          narrator: '他',
          summary: sampleSummary(),
          root,
        } as never),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitDraft({
          chapter: 1,
          content: cleanText(),
          chapter_title: '开端',
          scene_type: '未知场景',
          narrator: '他',
          summary: sampleSummary(),
          root,
        } as never),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(engine.export({ kind: 'epub', root })).rejects.toMatchObject({
        code: 'ENGINE_STAGE_ORDER',
      })
    } finally {
      await cleanup()
    }
  })

  it('reports a missing project with a hint', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const error = await engine.getStatus({ root }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(EngineInputError)
      expect((error as EngineInputError).code).toBe('ENGINE_PROJECT_NOT_FOUND')
      expect((error as EngineInputError).hint).toContain('novel_init')
    } finally {
      await cleanup()
    }
  })

  it('rejects a chapter that is not active and a non-positive chapter', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await expect(
        engine.submitDraft({
          chapter: 2,
          content: cleanText(),
          chapter_title: '开端之雨',
          scene_type: '日常过渡章',
          narrator: '他',
          summary: sampleSummary(),
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_STAGE_ORDER' })
      await expect(
        engine.submitDraft({
          chapter: 0,
          content: cleanText(),
          chapter_title: '开端之雨',
          scene_type: '日常过渡章',
          narrator: '他',
          summary: sampleSummary(),
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('surfaces gate details in the blocked error', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await engine.getBrief({ stage: 'P3', root })
      const error = await engine
        .submitDraft({
          chapter: 1,
          content: '太短。',
          chapter_title: '开端之雨',
          scene_type: '日常过渡章',
          narrator: '他',
          summary: sampleSummary(),
          root,
        })
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(EngineBlockedError)
      expect((error as EngineBlockedError).blocking.length).toBeGreaterThan(0)
      expect((error as EngineBlockedError).hint).toBeTruthy()
    } finally {
      await cleanup()
    }
  })
})

describe('branch coverage exercises', () => {
  it('serves a repeated brief request without another write', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '书',
        genre: '都市现代',
        platform: 'fanqie',
        root,
        words_per_chapter: [80, 400],
      })
      const first = await engine.getBrief({ stage: 'P1', root })
      const second = await engine.getBrief({ stage: 'P1', root })
      expect(second.revision).toBe(first.revision)
      expect(second.data.content).toBe(first.data.content)
      expect((await engine.queryState({ kind: 'planWorld', root })).data).toBeNull()
      expect((await engine.queryState({ kind: 'planChapter', root })).data).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('exports the current draft before the first archive', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await writeDraft({ root, engine })
      const result = await engine.export({ kind: 'txt', root })
      expect(result.data.files).toContain('exports/book.txt')
      const store = new FsStore(root)
      expect(await store.readText('exports/book.txt')).toContain('第1章 开端之雨')
    } finally {
      await cleanup()
    }
  })

  it('warns when mutually exclusive deductions are dropped', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      const base = sampleReview(1, text).dimensions
      const dims = base.map((dimension) => {
        if (dimension.id === 'R-W-11') {
          return {
            ...dimension,
            deductions: [{ rule: 'META_NARRATION', location: '第 1 段', delta: 6, note: 'a' }],
          }
        }
        if (dimension.id === 'R-W-07') {
          return {
            ...dimension,
            deductions: [{ rule: 'LEX_ZERO_TOLERANCE', location: '第 1 段', delta: 2, note: 'b' }],
          }
        }
        return { ...dimension, deductions: [] }
      })
      const result = await engine.submitReview({
        chapter: 1,
        dimensions: dims,
        issues: [],
        total: 144,
        proof: sampleReview(1, text).proof,
        root,
      })
      expect(result.warnings.some((warning) => warning.code === 'SCORE_EXCLUSIONS')).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('diffs a project that has no backups yet', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '书',
        genre: '都市现代',
        platform: 'fanqie',
        root,
        words_per_chapter: [80, 400],
      })
      const report = await engine.diff({ chapter: 1, after: '新内容', root })
      expect(report.data.before).toBe('')
      expect(report.data.added).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('refuses a revision when the plan file has been removed', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      const review = sampleReview(1, text)
      const submitted = await engine.submitReview({ chapter: 1, ...review, root })
      expect(submitted.replayed).not.toBe(true)
      const repeatedReview = await engine.submitReview({ chapter: 1, ...review, root })
      expect(repeatedReview.replayed).toBe(true)
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(cleanText(), {
          'L2-VOICE': { verdict: 'fail', evidence: '没有抬头，只把笔', note: '声音无区分' },
        }),
        root,
      })
      await engine.getBrief({ stage: 'P6', root })
      await new FsStore(root).remove('plans/ch001.chapter.yaml')
      // The plan is part of the P6 context and a required state document. The
      // read surface must report damage; a revision must not silently proceed
      // with a plan-less state.
      await engine.getBrief({ stage: 'P6', root })
      await expect(
        engine.submitRevision({
          chapter: 1,
          content: text,
          proof: sampleReview(1, text).proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_GATE_BLOCKED' })
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toEqual([
        expect.objectContaining({ code: 'PLAN_UNREADABLE', path: 'plans/ch001.chapter.yaml' }),
      ])
    } finally {
      await cleanup()
    }
  })

  it('reports blocking issues through status and advice', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({
        chapter: 1,
        ...sampleReview(1, text, {
          issues: [
            {
              id: 'REV-9',
              severity: 'blocker',
              dimension: 'R-W-01',
              location: '第 1 段',
              problem: 'p',
              fix: 'f',
              status: 'open',
            },
          ],
        }),
        root,
      })
      const status = await engine.getStatus({ root })
      expect(status.data.blocking).toHaveLength(1)
      expect(status.data.next).toMatchObject({
        tool: 'novel_brief',
        args: { stage: 'P5', chapter: 1 },
      })
      const advice = await engine.advise({ root })
      expect(advice.data.tool).toBe('novel_brief')
      expect(advice.data.reason).toContain('ISSUE-REV-9')

      await engine.getBrief({ stage: 'P5', root })
      const ready = await engine.getStatus({ root })
      expect(ready.data.next).toMatchObject({
        tool: 'novel_revise',
        args: { chapter: 1 },
      })
      expect((await engine.advise({ root })).data.tool).toBe('novel_revise')
    } finally {
      await cleanup()
    }
  })
})

/* helpers local to this file */

function textFor(chapter: number): string {
  const lines = [
    [
      '一月的风穿过走廊，卷起墙边旧纸箱的角。他弯腰把它压稳，指尖沾了一层灰。',
      '走廊尽头传来钥匙碰撞的声音，不快不慢，在门口停了两秒。他没有回头。',
      '门开时带进一股冷气，来人把一只旧信封放在桌角，敲了两下桌面。',
      '信封封口压着暗红蜡印，边缘磨得发白。他翻到背面，看见一行极小的字。',
    ],
    [
      '旧城的午后闷得发沉，墙皮一块块往下掉。他沿着窄巷往里走，鞋底踩碎了几片瓦。',
      '巷子拐角有一扇铁门，门环锈成暗褐色。他伸手试了试，门从里面锁着。',
      '铁门旁边的墙上钉着一块木牌，字迹被雨冲淡，只剩一个模糊的姓氏。',
      '他记下门牌号，转身时听见门后有人轻轻咳嗽了一声，随后又安静下去。',
    ],
    [
      '灯下那张纸被风掀起一角，他伸手按住，指节因为用力而发白。',
      '纸上只有三行字，每一行都写着同一个日期，墨迹却深浅不同。',
      '他忽然明白那封信为什么没有署名，喉咙里像堵着一团旧棉花。',
      '窗外有车灯扫过墙面，影子晃了一下。他把纸折好，放进贴身的口袋。',
    ],
  ]
  return lines[chapter - 1]!.join('\n\n')
}

async function archiveOne(input: {
  root: string
  engine: Awaited<ReturnType<typeof harness>>['engine']
  chapter: number
  title: string
  text: string
  summary: ChapterSummary
  scene?: import('../src/types.js').SceneType
}): Promise<{ assigned_ids: Record<string, string> }> {
  const { root, engine, chapter, title, text } = input
  const scene = input.scene ?? '日常过渡章'
  await engine.getBrief({ stage: 'P1', root })
  await engine.submitWorldPlan({
    chapter: 0,
    objective: '目标',
    constraints: [],
    characters: [],
    locations: [],
    continuity_notes: [],
    root,
  })
  await engine.getBrief({ stage: 'P2', root })
  await engine.submitChapterPlan({
    chapter: 0,
    title,
    scene_type: scene,
    narrator: '他',
    beats: ['起', '承', '转', '合', '收'],
    opening: '开场',
    ending: '断章',
    target_words: [80, 400],
    root,
  })
  await engine.getBrief({ stage: 'P3', root })
  const summary: ChapterSummary = {
    ...input.summary,
    opening: text.split('\n\n')[0]!.slice(0, 20),
  }
  await engine.submitDraft({
    chapter,
    content: text,
    chapter_title: title,
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
  const archived = await engine.archiveChapter({
    chapter,
    state_delta: archiveDelta(summary, { existing: chapter > 1 ? ['他'] : [] }),
    root,
  })
  return { assigned_ids: archived.data.assigned_ids }
}
