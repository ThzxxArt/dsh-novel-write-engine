import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import { harness, archiveDelta, cleanText, readyToArchive, sampleSummary } from './helpers.js'
import { sha256 } from '../src/store/fs.js'
import type { ChapterRecord } from '../src/types.js'

const chapterRow = (num: number, text = `第${num}章正文`): ChapterRecord => ({
  num,
  title: `第${num}章`,
  file: `chapters/chapter-${String(num).padStart(3, '0')}.md`,
  word_count: 200,
  dialogue_lines: 2,
  dialogue_ratio: 0.2,
  scene_type: '日常过渡章',
  narrator: '他',
  score: 140,
  status: 'reviewed',
  content_hash: sha256(text),
  summary: sampleSummary({
    opening: '风从窗缝里挤进来，把桌上',
    continuity: { opens_from: '上一章', ends_with: '信封' },
  }),
})

const worldPlan = {
  chapter: 1,
  objective: '让主角在雨夜收到一封信',
  constraints: ['没有超能力'],
  characters: [{ name: '他', role: '主角', current_state: '警惕' }],
  locations: [{ name: '旧楼', layout: '一层两户', capacity: 20 }],
  continuity_notes: ['雨夜'],
}

describe('0.1.3 state repair and context truth', () => {
  it('reports a damaged ledger, exposes its raw text, and repairs it through amend', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '坏台账', genre: '都市现代', platform: 'fanqie', root })
      await mkdir(join(root, 'state'), { recursive: true })
      await writeFile(join(root, 'state', 'characters.yaml'), 'characters: [unclosed\n', 'utf8')
      const damaged = await engine.getStatus({ root })
      expect(damaged.data.state_errors).toEqual([
        expect.objectContaining({ code: 'CHARACTERS_UNREADABLE', path: 'state/characters.yaml' }),
      ])
      expect(damaged.data.next).toMatchObject({ tool: 'novel_amend' })
      const raw = await engine.queryState({ kind: 'characters', root })
      expect(raw.data).toMatchObject({
        error: 'CHARACTERS_UNREADABLE',
        raw: 'characters: [unclosed\n',
      })
      await engine.amend({
        path: 'state/characters.yaml',
        content: { schema_version: 1, characters: [] },
        reason: 'repair the damaged ledger',
        root,
      })
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('repairs two damaged ledgers sequentially without the second blocking the first', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '双坏台账', genre: '都市现代', platform: 'fanqie', root })
      await mkdir(join(root, 'state'), { recursive: true })
      await writeFile(join(root, 'state', 'characters.yaml'), 'characters: [unclosed\n', 'utf8')
      await writeFile(join(root, 'state', 'world.yaml'), 'locations: [unclosed\n', 'utf8')
      expect((await engine.getStatus({ root })).data.state_errors).toHaveLength(2)
      await engine.amend({
        path: 'state/characters.yaml',
        content: { schema_version: 1, characters: [] },
        reason: 'repair characters first',
        root,
      })
      await engine.amend({
        path: 'state/world.yaml',
        content: {
          schema_version: 1,
          locations: [],
          abilities: [],
          artifacts: [],
          factions: [],
          rules: [],
        },
        reason: 'repair world second',
        root,
      })
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('repairs a corrupt handoff through raw state and amend', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '坏交接', genre: '都市现代', platform: 'fanqie', root })
      await mkdir(join(root, 'state'), { recursive: true })
      await writeFile(join(root, 'state', 'handoff.yaml'), 'volume: [unclosed\n', 'utf8')
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([
        expect.objectContaining({ code: 'HANDOFF_UNREADABLE' }),
      ])
      const raw = await engine.queryState({ kind: 'handoff', root })
      expect(raw.data).toMatchObject({ error: 'HANDOFF_UNREADABLE', raw: 'volume: [unclosed\n' })
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
        reason: 'repair the handoff',
        root,
      })
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('refuses to erase an archived chapter index and keeps chapter numbers contiguous', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = sampleSummary()
      await readyToArchive({ root, engine, summary })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root })
      await expect(
        engine.amend({
          path: 'state/chapters.yaml',
          content: { schema_version: 1, chapters: [] },
          reason: 'try to delete the archived chapter',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const saved = await engine.queryState({ kind: 'chapters', include_summary: true, root })
      await writeFile(join(root, 'state', 'chapters.yaml'), 'chapters: [unclosed\n', 'utf8')
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([
        expect.objectContaining({ code: 'CHAPTERS_UNREADABLE' }),
      ])
      await engine.amend({
        path: 'state/chapters.yaml',
        content: saved.data as never,
        reason: 'repair the index',
        root,
      })
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('allows project metadata edits but refuses genre, created_at and a target below the index', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '元数据', genre: '都市现代', platform: 'fanqie', root })
      await engine.amend({
        path: 'novel.yaml',
        content: { title: '改名之后', total_chapters: 3 },
        reason: 'author changed the title and plan',
        root,
      })
      const project = (await engine.queryState({ kind: 'novel', root })).data as {
        title: string
        targets: { total_chapters: number | null }
      }
      expect(project.title).toBe('改名之后')
      expect(project.targets.total_chapters).toBe(3)
      await expect(
        engine.amend({
          path: 'novel.yaml',
          content: { genre: '悬疑推理' },
          reason: 'try to change genre',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({
          path: 'novel.yaml',
          content: { total_chapters: 0 },
          reason: 'try to erase the target',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('delivers the P1 world plan to P2, P3 and P4 and keeps the planned cast', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '计划上下文',
        genre: '都市现代',
        platform: 'fanqie',
        words_per_chapter: [80, 400],
        root,
      })
      await engine.getBrief({ stage: 'P1', root })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: worldPlan.objective,
        constraints: worldPlan.constraints,
        characters: worldPlan.characters,
        locations: worldPlan.locations,
        continuity_notes: worldPlan.continuity_notes,
        root,
      })
      await engine.getBrief({ stage: 'P2', root })
      const p2 = await engine.getBrief({ stage: 'P2', root })
      expect((p2.data.context as { world_plan: { objective: string } }).world_plan.objective).toBe(
        worldPlan.objective,
      )
      await engine.submitChapterPlan({
        chapter: 0,
        title: '雨夜来信',
        scene_type: '日常过渡章',
        narrator: '他',
        beats: ['风起', '信到', '拆封', '读信', '决定'],
        opening: '风从窗缝里挤进来',
        ending: '蜡印',
        target_words: [80, 400],
        cast: [{ name: '他', goal: '拆开信封', entry_state: '警惕' }],
        root,
      })
      await engine.getBrief({ stage: 'P3', root })
      const p3 = await engine.getBrief({ stage: 'P3', root })
      expect((p3.data.context as { world_plan: { objective: string } }).world_plan.objective).toBe(
        worldPlan.objective,
      )
      expect((p3.data.context as { characters: Array<{ name: string }> }).characters).toEqual([
        expect.objectContaining({ name: '他' }),
      ])
      await engine.submitDraft({
        chapter: 1,
        content: cleanText(),
        chapter_title: '雨夜来信',
        scene_type: '日常过渡章',
        narrator: '他',
        summary: sampleSummary({ characters_appeared: ['他'] }),
        root,
      })
      await engine.getBrief({ stage: 'P4', root })
      const p4 = await engine.getBrief({ stage: 'P4', root })
      expect((p4.data.context as { world_plan: { objective: string } }).world_plan.objective).toBe(
        worldPlan.objective,
      )
      expect((p4.data.context as { characters: Array<{ name: string }> }).characters).toEqual([
        expect.objectContaining({ name: '他' }),
      ])
    } finally {
      await cleanup()
    }
  })

  it('rejects a cast name that was never planned and writes nothing', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '演员校验', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: worldPlan.objective,
        constraints: worldPlan.constraints,
        characters: worldPlan.characters,
        locations: worldPlan.locations,
        continuity_notes: worldPlan.continuity_notes,
        root,
      })
      await engine.getBrief({ stage: 'P2', root })
      await expect(
        engine.submitChapterPlan({
          chapter: 0,
          title: '雨夜来信',
          scene_type: '日常过渡章',
          narrator: '他',
          beats: ['风起', '信到', '拆封', '读信', '决定'],
          opening: '风从窗缝里挤进来',
          ending: '蜡印',
          target_words: [80, 400],
          cast: [{ name: '陌生人', goal: '闯入' }],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      expect((await engine.getStatus({ root })).data.stage).toBe('P2')
    } finally {
      await cleanup()
    }
  })

  it('enforces the cast size and uniqueness limits before writing', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '演员上限', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: '写一章',
        constraints: [],
        characters: Array.from({ length: 9 }, (_, index) => ({
          name: `演员${index + 1}`,
          role: '配角',
          current_state: '在场',
        })),
        locations: [],
        continuity_notes: [],
        root,
      })
      await engine.getBrief({ stage: 'P2', root })
      const base = {
        chapter: 0,
        title: '雨夜来信',
        scene_type: '日常过渡章' as const,
        narrator: '他',
        beats: ['风起', '信到', '拆封', '读信', '决定'],
        opening: '风从窗缝里挤进来',
        ending: '蜡印',
        target_words: [80, 400] as [number, number],
        root,
      }
      await expect(
        engine.submitChapterPlan({
          ...base,
          cast: Array.from({ length: 9 }, (_, index) => ({ name: `演员${index + 1}` })),
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitChapterPlan({
          ...base,
          cast: [{ name: '演员1' }, { name: '演员1' }],
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      expect((await engine.getStatus({ root })).data.stage).toBe('P2')
    } finally {
      await cleanup()
    }
  })

  it('delivers an eight-actor cast from a 120-character world plan through the engine', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '百人计划', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: '让八个人在雨夜碰头',
        constraints: ['没有超能力'],
        characters: Array.from({ length: 120 }, (_, index) => ({
          name: `角色${index + 1}`,
          role: '配角',
          current_state: '在场',
        })),
        locations: [],
        continuity_notes: ['雨夜'],
        root,
      })
      await engine.getBrief({ stage: 'P2', root })
      const p2 = await engine.getBrief({ stage: 'P2', root })
      expect(JSON.stringify(p2.data.context).length).toBeLessThanOrEqual(8_000)
      await engine.submitChapterPlan({
        chapter: 0,
        title: '雨夜碰头',
        scene_type: '日常过渡章',
        narrator: '他',
        beats: ['风起', '人来', '对质', '交换', '决定'],
        opening: '风从窗缝里挤进来',
        ending: '蜡印',
        target_words: [80, 400],
        cast: Array.from({ length: 8 }, (_, index) => ({ name: `角色${index + 1}` })),
        root,
      })
      const p3 = await engine.getBrief({ stage: 'P3', root })
      const characters = (p3.data.context as { characters: Array<{ name: string }> }).characters
      expect(characters.map((row) => row.name)).toEqual(
        Array.from({ length: 8 }, (_, index) => `角色${index + 1}`),
      )
      expect((p3.data.context as { context_meta: { used: number } }).context_meta.used).toBeLessThanOrEqual(
        16_000,
      )
    } finally {
      await cleanup()
    }
  })

  it('reports a corrupt world plan, blocks P2, and lets rollback plus P1 replace it', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '坏世界计划', genre: '都市现代', platform: 'fanqie', root })
      await mkdir(join(root, 'plans'), { recursive: true })
      await writeFile(join(root, 'plans', 'ch001.world.yaml'), 'objective: [unclosed\n', 'utf8')
      const damaged = await engine.getStatus({ root })
      expect(damaged.data.state_errors).toEqual([
        expect.objectContaining({ code: 'WORLD_PLAN_UNREADABLE', path: 'plans/ch001.world.yaml' }),
      ])
      await engine.getBrief({ stage: 'P1', root })
      expect((await engine.getStatus({ root })).data.next).toMatchObject({
        tool: 'novel_plan_world',
      })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: '替换掉坏计划',
        constraints: [],
        characters: [],
        locations: [],
        continuity_notes: [],
        root,
      })
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('keeps the five least-recently-touched open hooks in the handoff', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = sampleSummary()
      await readyToArchive({ root, engine, summary })
      await engine.amend({
        path: 'state/foreshadows.yaml',
        content: {
          schema_version: 1,
          next_seq: 7,
          items: Array.from({ length: 6 }, (_, index) => ({
            id: `FS-${String(index + 1).padStart(3, '0')}`,
            title: `伏笔${index + 1}`,
            planted: 1,
            last_touched: index + 1,
            status: 'planted',
            resolved_at: null,
            description: `伏笔描述${index + 1}`,
            advance_log: [],
          })),
        },
        reason: 'seed six open hooks',
        root,
      })
      await engine.getBrief({ stage: 'P8', root })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root })
      const handoff = (await engine.queryState({ kind: 'handoff', root })).data as {
        open_hooks: Array<{ id: string }>
      }
      expect(handoff.open_hooks.map((hook) => hook.id)).toEqual([
        'FS-001',
        'FS-002',
        'FS-003',
        'FS-004',
        'FS-005',
      ])
    } finally {
      await cleanup()
    }
  })

  it('rejects invalid handoff overrides before staging an archive', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = sampleSummary()
      await readyToArchive({ root, engine, summary })
      for (const handoff of [
        { volume: 0 },
        { volume_name: ' ' },
        { act: ' ' },
        { act_progress: 'not-progress' },
        { act_progress: '6/5' },
      ]) {
        await expect(
          engine.archiveChapter({
            chapter: 1,
            state_delta: archiveDelta(summary),
            handoff: handoff as never,
            root,
          }),
        ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      }
      expect((await engine.getStatus({ root })).data.stage).toBe('ready_to_archive')
    } finally {
      await cleanup()
    }
  })

  it('reads a 300-chapter index compactly by default and supports ranges and full summaries', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '长索引', genre: '都市现代', platform: 'fanqie', root })
      // This is a read-shape fixture, not an amend path: the index may contain
      // only archived chapters, so write a completed-book pipeline directly.
      await writeFile(
        join(root, 'state', 'chapters.yaml'),
        stringify({
          schema_version: 1,
          chapters: Array.from({ length: 300 }, (_, index) => chapterRow(index + 1)),
        }),
        'utf8',
      )
      await writeFile(
        join(root, 'state', 'pipeline.yaml'),
        stringify({
          schema_version: 1,
          revision: 2,
          chapter: 301,
          stage: 'done',
          rounds: { review: 0, revise: 0, check: 0 },
          briefs: {},
          blocking: [],
          last_action: null,
        }),
        'utf8',
      )
      const compact = await engine.queryState({ kind: 'chapters', root })
      expect(Buffer.byteLength(JSON.stringify(compact.data), 'utf8')).toBeLessThanOrEqual(64 * 1024)
      const compactRows = (compact.data as { chapters: Array<Record<string, unknown>> }).chapters
      expect(compactRows).toHaveLength(300)
      expect(compactRows[0]).not.toHaveProperty('summary')
      const ranged = await engine.queryState({ kind: 'chapters', chapter_range: [299, 300], root })
      expect((ranged.data as { chapters: Array<{ num: number }> }).chapters.map((row) => row.num)).toEqual([
        299, 300,
      ])
      const full = await engine.queryState({ kind: 'chapters', include_summary: true, root })
      expect((full.data as { chapters: Array<Record<string, unknown>> }).chapters[0]).toHaveProperty(
        'summary',
      )
      expect((await engine.panelChapters({ root })).rows).toHaveLength(30)
    } finally {
      await cleanup()
    }
  })
})
