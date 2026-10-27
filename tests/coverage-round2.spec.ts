import { describe, expect, it } from 'vitest'
import { createCommands } from '../src/commands/index.js'
import { briefContext } from '../src/engine/context.js'
import {
  bootstrapToDraft,
  cleanText,
  harness,
  sampleReview,
  sampleSemantic,
  sampleSummary,
  writeDraft,
} from './helpers.js'
import type { EngineService } from '../src/engine/service.js'

const invocation = (rawInput: string, signal = new AbortController().signal) => ({ rawInput, signal })

describe('configuration and maintenance edges', () => {
  it('rejects every malformed init input before writing', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const calls: Array<Promise<unknown>> = [
        engine.initProject({ title: '   ', genre: '都市现代', platform: 'fanqie', root }),
        engine.initProject({ title: '书', genre: '未知' as never, platform: 'fanqie', root }),
        engine.initProject({ title: '书', genre: '都市现代', platform: '未知' as never, root }),
        engine.initProject({
          title: '书',
          genre: '都市现代',
          platform: 'fanqie',
          words_per_chapter: [0, 1],
          root,
        }),
        engine.initProject({
          title: '书',
          genre: '都市现代',
          platform: 'fanqie',
          total_chapters: 0,
          root,
        }),
        engine.initProject({
          title: '书',
          genre: '都市现代',
          platform: 'fanqie',
          dialogue_ratio: [0.8, 0.2],
          root,
        }),
      ]
      for (const call of calls) await expect(call).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await expect(
        engine.initProject({ title: '重来', genre: '都市现代', platform: 'fanqie', root }),
      ).rejects.toMatchObject({ code: 'ENGINE_PROJECT_EXISTS' })
    } finally {
      await cleanup()
    }
  })

  it('validates export arguments and treats an empty audit limit as empty', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await expect(engine.export({ kind: 'pdf' as never, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.export({ kind: 'md', chapter: 0, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      expect((await engine.auditHistory({ limit: -3, root })).data).toEqual([])
      expect((await engine.auditHistory({ limit: Number.NaN, root })).data.length).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })

  it('counts arbitrary text without requiring a project', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      expect((await engine.countWords({ text: '你好 world 123' })).data.total_word_count).toBe(4)
      expect(root).toBeTruthy()
    } finally {
      await cleanup()
    }
  })
})

describe('context stages and panel draft projection', () => {
  it('builds every stage pack, including absent handoff and text branches', () => {
    const input = (stage: string, patch: Record<string, unknown> = {}): never =>
      ({
        stage,
        chapter: 1,
        project: { title: '书', genre: '都市现代', platform: 'fanqie', targets: {} },
        pipeline: { stage: 'P6' },
        chapters: { chapters: [] },
        characters: { characters: [] },
        world: {},
        locks: {},
        foreshadows: { items: [] },
        timeline: { items: [] },
        relationships: { items: [] },
        plan: null,
        review: null,
        check: null,
        text: null,
        previousText: null,
        handoff: null,
        ...patch,
      }) as never

    expect(briefContext(input('unknown'))).toMatchObject({ chapter: 1, previous_ending: '' })
    expect(briefContext(input('P1'))).toMatchObject({ volume: 1, volume_name: '', act: '' })
    expect(
      briefContext(
        input('P1', {
          handoff: { volume: 2, volume_name: '第二卷', act: '第二幕' },
        }),
      ),
    ).toMatchObject({ volume: 2, volume_name: '第二卷', act: '第二幕' })
    expect(briefContext(input('P2'))).toHaveProperty('plan', null)
    expect(briefContext(input('P3'))).toHaveProperty('locks')
    expect(briefContext(input('P4'))).toMatchObject({ text: '', machine: null, summary: null })
    expect(briefContext(input('P5'))).toMatchObject({ text: '', machine: null, review: null, issues: [] })
    expect(briefContext(input('P6'))).toHaveProperty('timeline')
    expect(briefContext(input('P8'))).toMatchObject({ summary: null, review: null })
  })

  it('delivers P1, P2, P5 and P8 context packs', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '上下文之书',
        genre: '都市现代',
        platform: 'fanqie',
        words_per_chapter: [80, 400],
        root,
      })
      const p1 = await engine.getBrief({ stage: 'P1', root })
      expect(p1.data.context).toMatchObject({ recent_summaries: [], open_foreshadows: [] })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: '目标',
        constraints: [],
        characters: [],
        locations: [],
        continuity_notes: [],
        root,
      })
      const p2 = await engine.getBrief({ stage: 'P2', root })
      expect(p2.data.context).toHaveProperty('plan')
      await engine.submitChapterPlan({
        chapter: 0,
        title: '开端之雨',
        scene_type: '日常过渡章',
        narrator: '他',
        beats: ['起', '承', '转', '合', '收'],
        opening: '开场',
        ending: '断章',
        target_words: [80, 400],
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
      await engine.submitReview({
        chapter: 1,
        ...sampleReview(1, text),
        issues: [
          {
            id: 'REV-1',
            severity: 'blocker',
            dimension: 'R-W-01',
            location: '第 1 段',
            problem: 'p',
            fix: 'f',
            status: 'open',
          },
        ],
        root,
      })
      const p5 = await engine.getBrief({ stage: 'P5', root })
      expect(p5.data.context).toMatchObject({ text, issues: [expect.objectContaining({ id: 'REV-1' })] })

      await engine.submitRevision({
        chapter: 1,
        content: text,
        issues: [
          {
            id: 'REV-1',
            severity: 'blocker',
            dimension: 'R-W-01',
            location: '第 1 段',
            problem: 'p',
            fix: 'f',
            status: 'fixed',
            evidence: '风从窗缝里挤进来',
          },
        ],
        proof: sampleReview(1, text).proof,
        root,
      })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({ chapter: 1, semantic: sampleSemantic(text), root })
      const p8 = await engine.getBrief({ stage: 'P8', root })
      expect(p8.data.context).toMatchObject({
        check: expect.objectContaining({ verdict: 'pass' }),
        summary: expect.objectContaining({ events: ['收到无名信封'] }),
      })
    } finally {
      await cleanup()
    }
  })

  it('shows the active chapter as a draft row in the panel', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await writeDraft({ root, engine })
      const rows = (await engine.panelChapters({ root })).rows
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ num: 1, status: 'draft', stage: 'P4' })
      expect(rows[0]!.details).toContain('收到无名信封')
      const summary = await engine.panelSummary({ root })
      expect(summary.totalWords).toBeGreaterThan(0)
      expect(summary.next).toMatchObject({ tool: 'novel_brief' })
      await engine.getBrief({ stage: 'P4', root })
      expect((await engine.panelSummary({ root })).next).toMatchObject({ tool: 'novel_review' })
    } finally {
      await cleanup()
    }
  })
})

describe('P5 summary validation and P6 semantic completeness', () => {
  it('rejects a malformed summary supplied to revise', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({
        chapter: 1,
        ...sampleReview(1, text),
        issues: [
          {
            id: 'REV-1',
            severity: 'blocker',
            dimension: 'R-W-01',
            location: '第 1 段',
            problem: 'p',
            fix: 'f',
            status: 'open',
          },
        ],
        root,
      })
      await engine.getBrief({ stage: 'P5', root })
      await expect(
        engine.submitRevision({
          chapter: 1,
          content: text,
          summary: { events: 'bad' } as never,
          proof: sampleReview(1, text).proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_GATE_BLOCKED' })
    } finally {
      await cleanup()
    }
  })

  it('fails P6 when the four semantic items are missing', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      await engine.getBrief({ stage: 'P6', root })
      const result = await engine.runCheck({ chapter: 1, semantic: [], root })
      expect(result.data.verdict).toBe('fail')
      expect((await engine.queryState({ kind: 'pipeline', root })).data).toMatchObject({
        blocking: expect.arrayContaining([expect.objectContaining({ code: 'SEMANTIC_MISSING' })]),
      })
    } finally {
      await cleanup()
    }
  })
})

describe('command branches', () => {
  it('handles help, malformed admin JSON, unknown operations and cancellation', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '命令之书', genre: '都市现代', platform: 'fanqie', root })
      const commands = createCommands(engine as EngineService)
      const novel = commands.find((command) => command.name === 'novel')!
      const admin = commands.find((command) => command.name === 'novel-admin')!
      expect((await novel.handler(invocation('admin'))).text).toContain('隐藏操作')
      expect((await novel.handler(invocation('admin novel_state {oops}'))).kind).toBe('error')
      expect((await admin.handler(invocation(''))).text).toContain('隐藏操作')
      expect((await admin.handler(invocation('novel_missing {}'))).kind).toBe('error')
      expect((await admin.handler(invocation('novel_state {"kind":"pipeline"}'))).kind).toBe('success')
      expect((await novel.handler(invocation('export pdf'))).kind).toBe('error')
      expect((await novel.handler(invocation('bogus'))).kind).toBe('error')
      const aborted = new AbortController()
      aborted.abort()
      for (const name of ['novel', 'novel-next', 'novel-stats', 'novel-export', 'novel-admin']) {
        const command = commands.find((candidate) => candidate.name === name)!
        expect(
          (await command.handler(invocation(name === 'novel-export' ? 'md' : '', aborted.signal))).kind,
          name,
        ).toBe('error')
      }
    } finally {
      await cleanup()
    }
  })
})
