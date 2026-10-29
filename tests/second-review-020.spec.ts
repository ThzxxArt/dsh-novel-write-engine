import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { EngineService } from '../src/engine/service.js'
import { FileLock } from '../src/store/lock.js'
import { searchSnapshot } from '../src/engine/insight.js'
import {
  emptyOutline,
  emptyWorldbook,
  markOutlineArchived,
  normalizeOutlineChapters,
  parseOutlineMarkdown,
  renderOutlineMarkdown,
  validateOutlineDocument,
  validateWorldbookDocument,
} from '../src/engine/book.js'
import { loadRulepack } from '../src/rulepack.js'
import type { ChapterRecord, ChapterSummary } from '../src/types.js'
import {
  archiveDelta,
  cleanText,
  harness,
  readProjectFile,
  readyToArchive,
  sampleSummary,
  TEST_CONFIG,
} from './helpers.js'

const autoRecord = (overrides: Partial<ChapterRecord> = {}): ChapterRecord => ({
  num: 1,
  title: '开端之雨',
  file: 'chapters/chapter-001.md',
  word_count: 120,
  dialogue_lines: 2,
  dialogue_ratio: 0.4,
  scene_type: '日常过渡章',
  narrator: '他',
  score: 130,
  status: 'reviewed',
  content_hash: 'hash-1',
  summary: {
    events: ['收信'],
    characters_appeared: ['他'],
    foreshadows: { planted: [], advanced: [], resolved: [] },
    new_elements: { locations: [], abilities: [], artifacts: [] },
    resource_changes: [],
    opening: '开头',
    continuity: { opens_from: '上章', ends_with: '钩子' },
    hook_strength: 4,
    pleasure_points: [],
    plot_advancement: 'mid',
  },
  ...overrides,
})

describe('second full review regressions', () => {
  it('keeps an archive-created card readable when the summary cast is wider than a card', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const names = ['他', '甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '甲']
      const summary = sampleSummary({ characters_appeared: names })
      const text = `${cleanText()}\n\n甲、乙、丙、丁、戊、己、庚、辛、壬都在场。`
      await readyToArchive({ root, engine, text, summary })
      await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(summary),
        root,
      })
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toEqual([])
      const outline = parseYaml((await readProjectFile(root, 'outline/outline.yaml'))!) as {
        chapters: Array<{ cast: string[]; status: string }>
      }
      expect(outline.chapters[0]).toMatchObject({
        status: 'archived',
        cast: ['他', '甲', '乙', '丙', '丁', '戊', '己', '庚'],
      })
    } finally {
      await cleanup()
    }
  })

  it('derives bounded fields for every auto-created archived card', () => {
    const longEvent = '事'.repeat(2_100)
    const summary = {
      ...autoRecord().summary,
      events: [longEvent],
      characters_appeared: ['他', '甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '辛'],
    } satisfies ChapterSummary
    const record = autoRecord({ summary })
    const outline = markOutlineArchived(emptyOutline('2026-01-01'), record, '2026-02-01', [80, 400])
    expect(outline.chapters[0]).toMatchObject({
      cast: ['他', '甲', '乙', '丙', '丁', '戊', '己', '庚'],
    })
    expect(Array.from(outline.chapters[0]!.goal).length).toBe(400)
    expect(() =>
      validateOutlineDocument(outline, {
        titleRule: { pattern: '^', min_chars: 4, max_chars: 8 },
        totalChapters: null,
      }),
    ).not.toThrow()

    const normalized = normalizeOutlineChapters([], {
      volumes: [],
      existing: [],
      archived: [record],
      titleRule: { pattern: '^', min_chars: 4, max_chars: 8 },
      totalChapters: null,
      defaultTargetWords: [80, 400],
      now: '2026-01-01',
    })
    expect(normalized[0]).toMatchObject({
      cast: ['他', '甲', '乙', '丙', '丁', '戊', '己', '庚'],
    })
  })

  it('defaults the first outline to strict even after a content-only blueprint', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '书',
        genre: '都市现代',
        platform: 'fanqie',
        premise: '一段前提',
        root,
      })
      await engine.submitOutline({
        chapters: [
          {
            num: 1,
            title: '开端之雨',
            scene_type: '日常过渡章',
            goal: '收信',
            conflict: '拆不拆',
            hook: '日期',
            cast: ['他'],
            target_words: [80, 400],
          },
        ],
        root,
      })
      expect((await engine.getStatus({ root })).data.book?.strict).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('fails closed when the chapter target would be exceeded', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root,
      })
      const project = (await engine.queryState({ kind: 'novel', root })).data as Record<string, unknown>
      await engine.amend({
        path: 'novel.yaml',
        content: {
          targets: { ...(project.targets as Record<string, unknown>), total_chapters: 1 },
        },
        reason: 'cap the book at one chapter',
        root,
      })
      await expect(
        engine.submitWorldPlan({
          chapter: 0,
          objective: '继续写下一章',
          constraints: [],
          characters: [],
          locations: [],
          continuity_notes: [],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_STAGE_ORDER' })
      expect((await engine.getStatus({ root })).data.next).toMatchObject({ tool: 'novel_export' })
    } finally {
      await cleanup()
    }
  })

  it('surfaces unreadable planning in search warnings', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await writeFile(join(root, 'outline/outline.yaml'), 'book: [bad]\n', 'utf8')
      const search = await engine.search({ query: '书', scope: 'outline', root })
      expect(search.warnings).toContainEqual(expect.objectContaining({ code: 'OUTLINE_UNREADABLE' }))
    } finally {
      await cleanup()
    }
  })

  it('can repair a corrupt outline after an auto-created archive card', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root,
      })
      const good = parseYaml((await readProjectFile(root, 'outline/outline.yaml'))!) as Record<
        string,
        unknown
      >
      await writeFile(join(root, 'outline/outline.yaml'), 'book: [broken\n', 'utf8')
      await engine.amend({
        path: 'outline/outline.yaml',
        content: good,
        reason: 'repair corrupted outline',
        root,
      })
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('preserves a volume title through the Markdown export/import round-trip', () => {
    const outline = emptyOutline('2026-01-01')
    outline.volumes = [
      {
        title: '第一卷 雨夜来信',
        start_chapter: 1,
        end_chapter: 3,
        goal: '入局',
        arc: '旁观到承担',
        climax: '对质',
        id: 'VOL-A',
        status: 'done',
      },
    ]
    outline.chapters = [
      {
        num: 1,
        volume: 1,
        title: '开端之雨',
        scene_type: '日常过渡章',
        goal: '收信',
        conflict: '拆不拆',
        hook: '日期',
        cast: ['他'],
        target_words: [80, 400],
        notes: '',
        status: 'planned',
        archived_at: null,
        word_count: null,
        score: null,
      },
    ]
    const markdown = renderOutlineMarkdown(
      { title: '书', genre: '都市现代', platform: 'fanqie' },
      outline,
      [],
    )
    expect(parseOutlineMarkdown(markdown).volumes[0]).toMatchObject({
      id: 'VOL-A',
      title: '第一卷 雨夜来信',
      start_chapter: 1,
      end_chapter: 3,
      status: 'done',
    })
  })

  it('rebuilds a corrupt derived archive-digest mirror instead of wedging writes', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await writeFile(join(root, 'state/archive-digests.json'), '{not json\n', 'utf8')
      await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root,
      })
      const raw = await readProjectFile(root, 'state/archive-digests.json')
      expect(raw).not.toBeNull()
      expect(() => JSON.parse(raw!)).not.toThrow()
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('does not replay a cached write from another process after the revision moved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'novel-r2-root-'))
    const state = await mkdtemp(join(tmpdir(), 'novel-r2-state-'))
    const make = (): EngineService =>
      new EngineService({ ...TEST_CONFIG, projectRoot: root, stateDir: state }, () => loadRulepack(), {
        now: () => new Date('2026-10-28T10:00:00.000Z'),
      })
    const a = make()
    const b = make()
    try {
      await a.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      const card = (num: number, title: string) => ({
        num,
        title,
        scene_type: '日常过渡章' as const,
        goal: '目标',
        conflict: '冲突',
        hook: '钩子',
        cast: ['他'],
        target_words: [80, 400] as [number, number],
      })
      await a.submitOutline({ chapters: [card(1, '开端之雨')], root })
      await b.submitOutline({ chapters: [card(1, '旧城之影')], root })
      const repeated = await a.submitOutline({ chapters: [card(1, '开端之雨')], root })
      expect(repeated.replayed).not.toBe(true)
      const outline = parseYaml((await readProjectFile(root, 'outline/outline.yaml'))!) as {
        chapters: Array<{ title: string }>
      }
      expect(outline.chapters[0]?.title).toBe('开端之雨')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(state, { recursive: true, force: true })
    }
  })

  it('records an explicit strict:false on a direct outline call', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitOutline({ chapters: [], strict: false, root })
      await engine.submitOutline({
        chapters: [
          {
            num: 1,
            title: '开端之雨',
            scene_type: '日常过渡章',
            goal: '收信',
            conflict: '拆不拆',
            hook: '日期',
            cast: ['他'],
            target_words: [80, 400],
          },
        ],
        root,
      })
      expect((await engine.getStatus({ root })).data.book?.strict).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('refuses to drop the active strict card through a later replacement', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitBookPlan({ strict: true, root })
      await engine.submitOutline({
        chapters: [
          {
            num: 1,
            title: '开端之雨',
            scene_type: '日常过渡章',
            goal: '收信',
            conflict: '拆不拆',
            hook: '日期',
            cast: ['他'],
            target_words: [80, 400],
          },
        ],
        root,
      })
      await expect(engine.submitOutline({ chapters: [], root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
    } finally {
      await cleanup()
    }
  })

  it('searches the active unarchived manuscript and uses gate paragraph numbering', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const active = await engine.search({ query: '蜡印', scope: 'chapters', root })
      expect(active.data.results[0]).toMatchObject({ chapter: 1, kind: 'chapters' })
      const leading = searchSnapshot({
        query: '蜡印',
        scope: 'chapters',
        limit: 20,
        chapterTexts: new Map([[1, '   \n\n蜡印出现了。\n下一段。']]),
        chapters: [],
        outline: emptyOutline('2026-01-01'),
        worldbook: emptyWorldbook('2026-01-01'),
        characters: { schema_version: 1, characters: [] },
        world: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
        timeline: { schema_version: 1, next_seq: 1, items: [] },
        foreshadows: { schema_version: 1, next_seq: 1, items: [] },
        relationships: { schema_version: 1, next_seq: 1, items: [] },
        locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
        handoff: null,
      })
      expect(leading.results[0]).toMatchObject({ paragraph: 1 })
    } finally {
      await cleanup()
    }
  })

  it('preserves worldbook updated_at instead of moving it on every read', () => {
    const document = emptyWorldbook('2026-01-01T00:00:00.000Z')
    document.premise = '旧案'
    document.updated_at = '2026-02-02T00:00:00.000Z'
    const loaded = validateWorldbookDocument(document, '2030-01-01T00:00:00.000Z')
    expect(loaded.updated_at).toBe('2026-02-02T00:00:00.000Z')
  })

  it('fails closed when the project journal is missing', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await rm(join(root, 'state/journal.jsonl'))
      await expect(engine.submitWorldbook({ themes: ['记忆'], root })).rejects.toMatchObject({
        code: 'ENGINE_JOURNAL_MISSING',
      })
      const status = await engine.getStatus({ root })
      expect(status.data.blocking).toContainEqual(expect.objectContaining({ code: 'JOURNAL_MISSING' }))
      const doctor = await engine.doctor({ root })
      expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id: 'journal', severity: 'error' }))
    } finally {
      await cleanup()
    }
  })

  it('refuses to reopen over amendments made after the archive', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root,
      })
      const characters = (await engine.queryState({ kind: 'characters', root })).data as {
        characters: Array<Record<string, unknown>>
      }
      const repaired = structuredClone(characters)
      repaired.characters[0]!.role = 'changed-after-archive'
      await engine.amend({
        path: 'state/characters.yaml',
        content: repaired,
        reason: 'amend after archive',
        root,
      })
      await expect(engine.reopenChapter({ chapter: 1, reason: '改稿', root })).rejects.toMatchObject({
        code: 'ENGINE_TXN_ABORTED',
      })
    } finally {
      await cleanup()
    }
  })

  it('derives a moved archived card volume instead of throwing', () => {
    const record = autoRecord({ num: 7 })
    const normalized = normalizeOutlineChapters([], {
      volumes: [
        {
          id: 'V1',
          title: '上',
          start_chapter: 1,
          end_chapter: 5,
          goal: '',
          arc: '',
          climax: '',
          status: 'planned',
        },
        {
          id: 'V2',
          title: '下',
          start_chapter: 6,
          end_chapter: 30,
          goal: '',
          arc: '',
          climax: '',
          status: 'planned',
        },
      ],
      existing: [],
      archived: [record],
      titleRule: { pattern: '^', min_chars: 4, max_chars: 8 },
      totalChapters: null,
      defaultTargetWords: [80, 400],
      now: '2026-01-01',
    })
    expect(normalized[0]).toMatchObject({ num: 7, volume: 2 })
  })

  it('diffs supplied texts without requiring a project', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const result = await engine.diff({ before: 'a\nb', after: 'a\nc', root })
      expect(result.data).toMatchObject({ chapter: 0, added: 1, removed: 1 })
    } finally {
      await cleanup()
    }
  })

  it('blocks archive when strict mode has no active card', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.submitBookPlan({ strict: true, root })
      await expect(
        engine.archiveChapter({
          chapter: 1,
          state_delta: archiveDelta(sampleSummary()),
          root,
        }),
      ).rejects.toMatchObject({
        blocking: expect.arrayContaining([expect.objectContaining({ code: 'PG-13' })]),
      })
    } finally {
      await cleanup()
    }
  })

  it('rejects non-string timeline characters at archive', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const delta = archiveDelta(sampleSummary())
      delta.timeline = { '0': { action: 'created', characters: [123 as never] } }
      await expect(engine.archiveChapter({ chapter: 1, state_delta: delta, root })).rejects.toMatchObject({
        code: 'ENGINE_DELTA_UNVERIFIED',
      })
    } finally {
      await cleanup()
    }
  })

  it('blocks planning writes while the project definition is damaged', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await writeFile(join(root, 'novel.yaml'), 'title: [broken\n', 'utf8')
      await expect(
        engine.submitBookPlan({
          volumes: [{ title: '长卷', start_chapter: 1, end_chapter: 100 }],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('warns when an archived manuscript is missing from search', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root,
      })
      await rm(join(root, 'chapters/chapter-001.md'))
      const result = await engine.search({ query: '蜡印', scope: 'chapters', root })
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'CHAPTER_MANUSCRIPT_MISSING' }))
    } finally {
      await cleanup()
    }
  })

  it('recommends an executable outline repair for a P4 card mismatch', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.submitBookPlan({ strict: true, root })
      await engine.submitOutline({
        chapters: [
          {
            num: 1,
            title: '另一个标题',
            scene_type: '日常过渡章',
            goal: '收信',
            conflict: '拆不拆',
            hook: '日期',
            cast: ['他'],
            target_words: [80, 400],
          },
        ],
        root,
      })
      const status = await engine.getStatus({ root })
      expect(status.data.blocking).toContainEqual(expect.objectContaining({ code: 'PG-13' }))
      expect(status.data.next).toMatchObject({ tool: 'novel_outline' })
    } finally {
      await cleanup()
    }
  })

  it('rebuilds a non-object archive-digest mirror from the chapter index', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await writeFile(join(root, 'state/archive-digests.json'), '[]\n', 'utf8')
      await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root,
      })
      expect((await engine.getStatus({ root })).data.state_errors).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('refuses a read-only snapshot while a live writer lock is held', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      const lock = new FileLock(join(root, '.engine.lock'))
      await lock.acquire()
      try {
        await expect(engine.getStatus({ root })).rejects.toMatchObject({ code: 'ENGINE_TXN_IN_PROGRESS' })
      } finally {
        await lock.release()
      }
    } finally {
      await cleanup()
    }
  })

  it('reads through a stale lock whose owner is dead', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await writeFile(
        join(root, '.engine.lock'),
        JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() }),
        'utf8',
      )
      await expect(engine.getStatus({ root })).resolves.toMatchObject({ data: { chapter: 1 } })
    } finally {
      await cleanup()
    }
  })

  it('refuses a fresh half-written lock after its grace window', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await writeFile(join(root, '.engine.lock'), '{', 'utf8')
      await expect(engine.getStatus({ root })).rejects.toMatchObject({ code: 'ENGINE_TXN_IN_PROGRESS' })
    } finally {
      await cleanup()
    }
  })

  it('waits for a lock owned by another live process', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await writeFile(
        join(root, '.engine.lock'),
        JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }),
        'utf8',
      )
      await expect(engine.getStatus({ root })).rejects.toMatchObject({ code: 'ENGINE_TXN_IN_PROGRESS' })
    } finally {
      await cleanup()
    }
  })

  it('reports and diagnoses a damaged historical review', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root,
      })
      await writeFile(join(root, 'reviews/ch001.review.yaml'), 'dimensions: [broken\n', 'utf8')
      const report = await engine.report({ root })
      expect(report.data.warnings.join('\n')).toContain('评审文档不可读')
      const doctor = await engine.doctor({ root })
      expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id: 'reviews', severity: 'error' }))
    } finally {
      await cleanup()
    }
  })
})
