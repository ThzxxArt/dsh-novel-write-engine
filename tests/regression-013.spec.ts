import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectChapters, type PanelSnapshot } from '../src/engine/projections.js'
import { briefContext, type BriefContextInput } from '../src/engine/context.js'
import { emptyPipeline } from '../src/engine/state.js'
import type { ChapterRecord, ChapterSummary } from '../src/types.js'
import {
  archiveDelta,
  bootstrapToDraft,
  harness,
  cleanText,
  sampleSummary,
  readyToArchive,
} from './helpers.js'
import { FsStore } from '../src/store/fs.js'

const panelSnapshot = (): PanelSnapshot => ({
  root: '/tmp/probe',
  title: '探针',
  genre: '都市现代',
  platform: 'fanqie',
  chapter: 31,
  stage: 'P2',
  revision: 1,
  rounds: { review: 0, revise: 0, check: 0 },
  blocking: [],
  chapters: Array.from({ length: 30 }, (_, index) => ({
    num: index + 1,
    title: `第${index + 1}章`,
    file: `chapters/chapter-${String(index + 1).padStart(3, '0')}.md`,
    word_count: 100,
    dialogue_lines: 1,
    dialogue_ratio: 0.1,
    scene_type: '日常过渡章',
    narrator: '他',
    score: 140,
    status: 'reviewed',
    content_hash: 'h',
    summary: sampleSummary(),
  })),
  draft: { num: 31, title: '第31章', wordCount: 0, score: 0, status: 'draft', details: '' },
  totalWords: 3000,
  phases: [],
})

describe('review probes', () => {
  it('caps the panel at thirty rows while keeping the active draft', () => {
    const rows = projectChapters(panelSnapshot()).rows
    expect(rows).toHaveLength(30)
    expect(rows.at(-1)).toMatchObject({ num: 31, status: 'draft' })
  })

  it('reports and repairs a missing ledger', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '缺失台账', genre: '都市现代', platform: 'fanqie', root })
      await rm(join(root, 'state', 'characters.yaml'))
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toEqual([
        expect.objectContaining({ code: 'CHARACTERS_UNREADABLE', path: 'state/characters.yaml' }),
      ])
      await engine.amend({
        path: 'state/characters.yaml',
        content: { schema_version: 1, characters: [] },
        reason: 'restore the missing ledger',
        root,
      })
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('rejects an index that adds the active chapter', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '活动章', genre: '都市现代', platform: 'fanqie', root })
      await expect(
        engine.amend({
          path: 'state/chapters.yaml',
          content: {
            schema_version: 1,
            chapters: [
              {
                num: 1,
                title: '第1章',
                file: 'chapters/chapter-001.md',
                word_count: 100,
                dialogue_lines: 1,
                dialogue_ratio: 0.1,
                scene_type: '日常过渡章',
                narrator: '他',
                score: 140,
                status: 'reviewed',
                content_hash: 'h',
                summary: sampleSummary(),
              },
            ],
          },
          reason: 'seed the active chapter',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('rejects unknown project target fields', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '目标字段', genre: '都市现代', platform: 'fanqie', root })
      await expect(
        engine.amend({
          path: 'novel.yaml',
          content: { targets: { total_chapters: 3, sneaky: true } },
          reason: 'add an unknown target field',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('refuses a draft when the chapter plan is missing', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '缺计划',
        genre: '都市现代',
        platform: 'fanqie',
        words_per_chapter: [80, 400],
        root,
      })
      await engine.getBrief({ stage: 'P1', root })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: '写一章',
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
        beats: ['起', '承', '转', '合', '收'],
        opening: '风从窗缝里挤进来',
        ending: '蜡印',
        target_words: [80, 400],
        root,
      })
      await rm(join(root, 'plans', 'ch001.chapter.yaml'))
      await engine.getBrief({ stage: 'P3', root })
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
    } finally {
      await cleanup()
    }
  })

  it('keeps a P2 world-plan candidate pack inside the budget', () => {
    const summary = sampleSummary()
    const record = (num: number): ChapterRecord => ({
      num,
      title: `第${num}章`,
      file: `chapters/chapter-${String(num).padStart(3, '0')}.md`,
      word_count: 2000,
      dialogue_lines: 10,
      dialogue_ratio: 0.4,
      scene_type: '日常过渡章',
      narrator: '他',
      score: 130,
      status: 'reviewed',
      content_hash: 'h',
      summary: summary as ChapterSummary,
    })
    const input: BriefContextInput = {
      stage: 'P2',
      chapter: 2,
      project: {
        schema_version: 1,
        title: '长书',
        genre: '都市现代',
        platform: 'fanqie',
        author: '',
        description: '',
        created_at: new Date(0).toISOString(),
        targets: { words_per_chapter: [2000, 3000], total_chapters: 200, dialogue_ratio: [0.4, 0.6] },
      },
      pipeline: emptyPipeline({ revision: 1, chapter: 2, stage: 'P2' }),
      chapters: { schema_version: 1, chapters: [record(1)] },
      characters: { schema_version: 1, characters: [] },
      world: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
      locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
      worldPlan: {
        chapter: 2,
        objective: '继续追查',
        constraints: [],
        characters: Array.from({ length: 120 }, (_, index) => ({
          name: `角色${index + 1}`,
          role: '配角',
          current_state: '观望',
        })),
        locations: [],
        continuity_notes: [],
      },
      plan: null,
      review: null,
      check: null,
      text: null,
      previousText: null,
      handoff: null,
    }
    const context = briefContext(input)
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(8_000)
  })

  it('surfaces a readable journal mismatch before recommending a write', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '外部改动', genre: '都市现代', platform: 'fanqie', root })
      await writeFile(
        join(root, 'state', 'characters.yaml'),
        'schema_version: 1\ncharacters:\n  - name: 外部角色\n    role: supporting\n    first_appearance: 1\n    profile: {}\n    current_state: {}\n    growth: []\n    updated_at: 1\n',
        'utf8',
      )
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toEqual([])
      expect(status.data.blocking).toContainEqual(
        expect.objectContaining({ code: 'JOURNAL_HASH_MISMATCH', scope: 'journal' }),
      )
      expect(status.data.next.tool).toBe('novel_audit')
    } finally {
      await cleanup()
    }
  })

  it('surfaces a malformed journal before recommending a write', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '坏日志', genre: '都市现代', platform: 'fanqie', root })
      await new FsStore(root).appendText('state/journal.jsonl', 'not-json\n')
      const status = await engine.getStatus({ root })
      expect(status.data.blocking).toContainEqual(
        expect.objectContaining({ code: 'JOURNAL_MALFORMED', scope: 'journal' }),
      )
      expect(status.data.next.tool).toBe('novel_audit')
    } finally {
      await cleanup()
    }
  })

  it('does not recommend archive after the manuscript changes at ready_to_archive', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const text = (await engine.queryState({ kind: 'check', root })).data as { content_hash: string }
      expect(text.content_hash).toContain('sha256:')
      await writeFile(join(root, 'chapters', 'chapter-001.md'), `${cleanText()} appended`, 'utf8')
      const status = await engine.getStatus({ root })
      // Changing the manuscript invalidates both the review and the check.
      // The review is the earlier binding, so the honest repair starts at P4
      // rather than asking for a fresh check that can never satisfy PG-07.
      expect(status.data.blocking).toContainEqual(expect.objectContaining({ code: 'PG-07' }))
      expect(status.data.next).toMatchObject({ tool: 'novel_rollback', args: { to_stage: 'P4' } })
    } finally {
      await cleanup()
    }
  })

  it('rejects a draft with an empty narrator before it can corrupt the stored plan', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await engine.getBrief({ stage: 'P3', root })
      await expect(
        engine.submitDraft({
          chapter: 1,
          content: cleanText(),
          chapter_title: '开端之雨',
          scene_type: '日常过渡章',
          narrator: ' ',
          summary: sampleSummary(),
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const status = await engine.getStatus({ root })
      expect(status.data.stage).toBe('P3')
      expect(status.data.state_errors).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('blocks the chapter-plan writer while a world plan is unreadable', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '坏世界计划阻断', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: '写一章',
        constraints: [],
        characters: [],
        locations: [],
        continuity_notes: [],
        root,
      })
      await writeFile(join(root, 'plans', 'ch001.world.yaml'), 'objective: [unclosed\n', 'utf8')
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toEqual([
        expect.objectContaining({ code: 'WORLD_PLAN_UNREADABLE', path: 'plans/ch001.world.yaml' }),
      ])
      expect(status.data.next).toMatchObject({ tool: 'novel_rollback', args: { to_stage: 'P1' } })
      await expect(
        engine.submitChapterPlan({
          chapter: 0,
          title: '开端之雨',
          scene_type: '日常过渡章',
          narrator: '他',
          beats: ['起', '承', '转', '合', '收'],
          opening: '风从窗缝里挤进来',
          ending: '蜡印',
          target_words: [80, 400],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_GATE_BLOCKED' })
      expect((await engine.queryState({ kind: 'planChapter', root })).data).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('rejects a world plan whose protected notes exceed the context bound', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '超长世界计划', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      await expect(
        engine.submitWorldPlan({
          chapter: 0,
          objective: '写一章',
          constraints: [],
          characters: [],
          locations: [],
          continuity_notes: Array.from({ length: 65 }, (_, index) => `约束 ${index}`),
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      expect((await engine.getStatus({ root })).data.stage).toBe('idle')
    } finally {
      await cleanup()
    }
  })

  it('refuses a chapters repair whose row points at a missing manuscript', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = sampleSummary()
      await readyToArchive({ root, engine, summary })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root })
      const saved = await engine.queryState({ kind: 'chapters', include_summary: true, root })
      await rm(join(root, 'chapters', 'chapter-001.md'))
      await expect(
        engine.amend({
          path: 'state/chapters.yaml',
          content: saved.data as never,
          reason: 'repair the chapter index without its manuscript',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('refuses next_seq that would reuse an id assigned by an archived chapter', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = sampleSummary({
        foreshadows: {
          planted: [{ key: 'hookA', title: '蜡印', description: '蜡印' }],
          advanced: [],
          resolved: [],
        },
      })
      await readyToArchive({ root, engine, summary })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root })
      const saved = await engine.queryState({ kind: 'chapters', include_summary: true, root })
      const document = saved.data as {
        chapters: Array<{ assigned_ids?: Record<string, string> }>
      }
      expect(document.chapters[0]!.assigned_ids).toMatchObject({ hookA: 'FS-001' })
      await writeFile(join(root, 'state', 'foreshadows.yaml'), 'items: [unclosed\n', 'utf8')
      await expect(
        engine.amend({
          path: 'state/foreshadows.yaml',
          content: { schema_version: 1, next_seq: 1, items: [] },
          reason: 'reuse FS-001',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('keeps panel readable and repairs every damaged ledger', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '八台账', genre: '都市现代', platform: 'fanqie', root })
      const cases = [
        ['characters', 'CHARACTERS_UNREADABLE', { schema_version: 1, characters: [] }],
        [
          'world',
          'WORLD_UNREADABLE',
          {
            schema_version: 1,
            locations: [],
            abilities: [],
            artifacts: [],
            factions: [],
            rules: [],
          },
        ],
        [
          'locks',
          'LOCKS_UNREADABLE',
          {
            schema_version: 1,
            locked_at_chapter: 0,
            characters: {},
            locations: {},
          },
        ],
        ['timeline', 'TIMELINE_UNREADABLE', { schema_version: 1, next_seq: 1, items: [] }],
        ['foreshadows', 'FORESHADOWS_UNREADABLE', { schema_version: 1, next_seq: 1, items: [] }],
        ['relationships', 'RELATIONSHIPS_UNREADABLE', { schema_version: 1, next_seq: 1, items: [] }],
        ['chapters', 'CHAPTERS_UNREADABLE', { schema_version: 1, chapters: [] }],
        [
          'handoff',
          'HANDOFF_UNREADABLE',
          {
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
        ],
      ] as const
      for (const [name, code, replacement] of cases) {
        await writeFile(join(root, 'state', `${name}.yaml`), 'broken: [unclosed\n', 'utf8')
        const status = await engine.getStatus({ root })
        expect(status.data.state_errors).toContainEqual(
          expect.objectContaining({ code, path: `state/${name}.yaml` }),
        )
        const raw = await engine.queryState({ kind: name, root })
        expect(raw.data).toMatchObject({ error: code, raw: 'broken: [unclosed\n' })
        expect((await engine.panelBundle({ root })).summary.title).toBe('八台账')
        await engine.amend({
          path: `state/${name}.yaml`,
          content: replacement as never,
          reason: `repair ${name}`,
          root,
        })
      }
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('refuses a chapters repair that forges the recorded archive digest', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = sampleSummary()
      await readyToArchive({ root, engine, summary })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root })
      const saved = await engine.queryState({ kind: 'chapters', include_summary: true, root })
      const document = saved.data as { chapters: Array<Record<string, unknown>> }
      const forged = structuredClone(document)
      forged.chapters[0]!.archive_digest = 'v2:deadbeef'
      await expect(
        engine.amend({
          path: 'state/chapters.yaml',
          content: forged as never,
          reason: 'forge the archived digest',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await engine.amend({
        path: 'state/chapters.yaml',
        content: saved.data as never,
        reason: 'restore the exact archived index',
        root,
      })
    } finally {
      await cleanup()
    }
  })

  it('exposes raw review/check documents when they are unreadable', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await writeFile(join(root, 'reviews', 'ch001.review.yaml'), 'dimensions: [unclosed\n', 'utf8')
      await writeFile(join(root, 'checks', 'ch001.check.yaml'), 'verdict: [unclosed\n', 'utf8')
      const review = await engine.queryState({ kind: 'review', root })
      expect(review.data).toMatchObject({
        error: 'REVIEW_UNREADABLE',
        path: 'reviews/ch001.review.yaml',
        raw: 'dimensions: [unclosed\n',
      })
      const check = await engine.queryState({ kind: 'check', root })
      expect(check.data).toMatchObject({
        error: 'CHECK_UNREADABLE',
        path: 'checks/ch001.check.yaml',
        raw: 'verdict: [unclosed\n',
      })
      expect((await engine.panelBundle({ root })).summary.blocking.length).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })

  it('recovers a missing novel.yaml when the rest of the project is still present', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '失落的项目文件', genre: '都市现代', platform: 'fanqie', root })
      const project = (await engine.queryState({ kind: 'novel', root })).data
      await rm(join(root, 'novel.yaml'))
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toEqual([
        expect.objectContaining({ code: 'PROJECT_UNREADABLE', path: 'novel.yaml' }),
      ])
      expect(status.data.next.tool).toBe('novel_amend')
      expect((await engine.queryState({ kind: 'novel', root })).data).toMatchObject({
        error: 'PROJECT_UNREADABLE',
        path: 'novel.yaml',
      })
      await engine.amend({
        path: 'novel.yaml',
        content: project as never,
        reason: 'restore the missing project document',
        root,
      })
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('refuses a handoff whose resume point and hooks are impossible', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '坏交接', genre: '都市现代', platform: 'fanqie', root })
      const current = (await engine.queryState({ kind: 'handoff', root })).data as Record<string, unknown>
      await expect(
        engine.amend({
          path: 'state/handoff.yaml',
          content: { ...current, current_chapter: 999, next_chapter: 0 },
          reason: 'break resume',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({
          path: 'state/handoff.yaml',
          content: {
            ...current,
            open_hooks: [{ id: 'FS-999', title: '不存在' }],
          },
          reason: 'invent a hook',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('rejects a chapter-plan title that already carries the 第N章 prefix', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '标题', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: '写一章',
        constraints: [],
        characters: [],
        locations: [],
        continuity_notes: [],
        root,
      })
      await engine.getBrief({ stage: 'P2', root })
      await expect(
        engine.submitChapterPlan({
          chapter: 0,
          title: '第1章 开端之雨',
          scene_type: '日常过渡章',
          narrator: '他',
          beats: ['起', '承', '转', '合', '收'],
          opening: '风从窗缝里挤进来',
          ending: '蜡印',
          target_words: [80, 400],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('reports malformed nested plan data instead of crashing status', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '坏计划', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: '写一章',
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
        beats: ['起', '承', '转', '合', '收'],
        opening: '风从窗缝里挤进来',
        ending: '蜡印',
        target_words: [80, 400],
        root,
      })
      await writeFile(
        join(root, 'plans', 'ch001.chapter.yaml'),
        'schema_version: 1\nchapter: 1\ntitle: 开端之雨\nscene_type: 日常过渡章\nnarrator: 他\nbeats: [起, 承, 转, 合, 收]\nopening: 风从窗缝里挤进来\nending: 蜡印\ntarget_words: [80, 400]\nsummary:\n  characters_appeared: 5\n',
        'utf8',
      )
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toEqual([
        expect.objectContaining({ code: 'PLAN_UNREADABLE', path: 'plans/ch001.chapter.yaml' }),
      ])
      expect(status.data.next.tool).toBe('novel_rollback')
    } finally {
      await cleanup()
    }
  })

  it('reports malformed nested world-plan data instead of crashing status', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '坏世界计划', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: '写一章',
        constraints: [],
        characters: [],
        locations: [],
        continuity_notes: [],
        root,
      })
      await engine.getBrief({ stage: 'P2', root })
      await writeFile(
        join(root, 'plans', 'ch001.world.yaml'),
        'schema_version: 1\nchapter: 1\nobjective: 写一章\nconstraints: []\ncharacters:\n  - null\nlocations: []\ncontinuity_notes: []\n',
        'utf8',
      )
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toEqual([
        expect.objectContaining({ code: 'WORLD_PLAN_UNREADABLE', path: 'plans/ch001.world.yaml' }),
      ])
      expect(status.data.next.tool).toBe('novel_rollback')
    } finally {
      await cleanup()
    }
  })

  it('recovers a corrupt novel.yaml through status and amend', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '坏项目', genre: '都市现代', platform: 'fanqie', root })
      const project = (await engine.queryState({ kind: 'novel', root })).data
      await writeFile(join(root, 'novel.yaml'), 'title: [unclosed\n', 'utf8')
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toEqual([
        expect.objectContaining({ code: 'PROJECT_UNREADABLE', path: 'novel.yaml' }),
      ])
      expect(status.data.next.tool).toBe('novel_amend')
      expect((await engine.queryState({ kind: 'novel', root })).data).toMatchObject({
        error: 'PROJECT_UNREADABLE',
        path: 'novel.yaml',
      })
      await engine.amend({
        path: 'novel.yaml',
        content: project as never,
        reason: 'restore the project document',
        root,
      })
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('reports a missing check before recommending archive', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await rm(join(root, 'checks', 'ch001.check.yaml'))
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toEqual([
        expect.objectContaining({ code: 'CHECK_UNREADABLE', path: 'checks/ch001.check.yaml' }),
      ])
      expect(status.data.next.tool).not.toBe('novel_archive')
    } finally {
      await cleanup()
    }
  })

  it('reports missing review/check after a ready archive stage', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await rm(join(root, 'reviews', 'ch001.review.yaml'))
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toEqual([
        expect.objectContaining({ code: 'REVIEW_UNREADABLE', path: 'reviews/ch001.review.yaml' }),
      ])
      expect(status.data.next.tool).not.toBe('novel_archive')
    } finally {
      await cleanup()
    }
  })
})
