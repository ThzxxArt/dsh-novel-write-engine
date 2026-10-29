import { describe, expect, it } from 'vitest'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { buildBookReport, searchSnapshot } from '../src/engine/insight.js'
import {
  emptyOutline,
  emptyWorldbook,
  markOutlineReopened,
  parseOutlineMarkdown,
  renderOutlineMarkdown,
  validateOutlineDocument,
} from '../src/engine/book.js'
import type { ChapterRecord, OutlineChapter, ReviewDocument } from '../src/types.js'
import {
  archiveDelta,
  cleanText,
  harness,
  readProjectFile,
  readyToArchive,
  sampleSummary,
} from './helpers.js'

const chapterCard: OutlineChapter = {
  num: 1,
  volume: null,
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
}

const record: ChapterRecord = {
  num: 1,
  title: '开端之雨',
  file: 'chapters/chapter-001.md',
  word_count: 120,
  dialogue_lines: 2,
  dialogue_ratio: 0.4,
  scene_type: '日常过渡章',
  narrator: '他',
  score: 140,
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
}

const review: ReviewDocument = {
  schema_version: 1,
  chapter: 1,
  round: 1,
  content_hash: 'hash-1',
  dimensions: [
    {
      id: 'R-W-01',
      max: 150,
      deductions: [],
    },
  ],
  issues: [],
  total: 150,
  proof: {
    opening: { paragraph: 1, quote: '开头开头' },
    middle: { paragraph: 1, quote: '中间中间' },
    ending: { paragraph: 1, quote: '结尾结尾' },
  },
}

describe('0.2.0 review probes', () => {
  it('reports zero quality trend when there is no previous window', () => {
    const report = buildBookReport({
      project: {
        schema_version: 1,
        title: '书',
        genre: '都市现代',
        platform: 'fanqie',
        author: '',
        description: '',
        created_at: '2026-01-01',
        targets: { words_per_chapter: [80, 400], total_chapters: 1, dialogue_ratio: [0, 1] },
      },
      outline: emptyOutline('2026-01-01'),
      outlinePresent: false,
      worldbook: emptyWorldbook('2026-01-01'),
      worldbookPresent: false,
      chapters: [record],
      characters: { schema_version: 1, characters: [] },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
      reviews: [review],
      activity: [],
      targetChapters: 1,
      minScore: 120,
      foreshadowDormantAfter: 10,
    })
    expect(report.quality.trend).toBe(0)
  })

  it('searches blueprint fields under the outline scope', () => {
    const outline = emptyOutline('2026-01-01')
    outline.book.premise = '旧案重启'
    outline.chapters = [chapterCard]
    const report = searchSnapshot({
      query: '旧案',
      scope: 'outline',
      limit: 20,
      chapterTexts: new Map(),
      chapters: [],
      outline,
      worldbook: emptyWorldbook('2026-01-01'),
      characters: { schema_version: 1, characters: [] },
      world: {
        schema_version: 1,
        locations: [],
        abilities: [],
        artifacts: [],
        factions: [],
        rules: [],
      },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
      locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
      handoff: null,
    })
    expect(report.total).toBeGreaterThan(0)
    expect(report.results[0]).toMatchObject({ kind: 'outline' })
  })

  it('renders the blueprint premise in the outline Markdown export', () => {
    const outline = emptyOutline('2026-01-01')
    outline.book.premise = '一封无名信把档案员拖回旧案。'
    const text = renderOutlineMarkdown({ title: '书', genre: '都市现代', platform: 'fanqie' }, outline, [])
    expect(text).toContain(outline.book.premise)
  })

  it('refuses to overwrite a damaged outline with a normal planning write', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitOutline({ chapters: [chapterCard], root })
      await writeFile(join(root, 'outline/outline.yaml'), 'book: [bad]\n', 'utf8')
      await expect(engine.submitBookPlan({ premise: '新前提', root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
    } finally {
      await cleanup()
    }
  })

  it('refuses to overwrite a damaged worldbook with a normal section write', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitWorldbook({
        premise: '旧案之城',
        rules: [{ name: '规则', description: '说明' }],
        root,
      })
      await writeFile(join(root, 'outline/worldbook.yaml'), 'premise: [bad]\n', 'utf8')
      await expect(engine.submitWorldbook({ setting: '新设定', root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
    } finally {
      await cleanup()
    }
  })

  it('round-trips the blueprint premise through Markdown import', () => {
    const outline = emptyOutline('2026-01-01')
    outline.book.premise = '一封无名信把档案员拖回旧案。'
    const rendered = renderOutlineMarkdown(
      { title: '书', genre: '都市现代', platform: 'fanqie' },
      { ...outline, chapters: [chapterCard] },
      [],
    )
    expect(parseOutlineMarkdown(rendered).book.premise).toBe(outline.book.premise)
  })

  it('maps Markdown chapters to the sorted volume ranges, even when headings are out of order', () => {
    const parsed = parseOutlineMarkdown(
      [
        '## 第二卷 后卷（第4-6章）',
        '### 第4章 开端之雨',
        '场景：日常过渡章',
        '字数：80-400',
        '目标：a',
        '冲突：b',
        '钩子：c',
        '## 第一卷 前卷（第1-3章）',
        '### 第1章 开端之雨',
        '场景：日常过渡章',
        '字数：80-400',
        '目标：a',
        '冲突：b',
        '钩子：c',
      ].join('\n'),
    )
    expect(parsed.chapters.find((card) => card.num === 4)?.volume).toBe(2)
    expect(parsed.chapters.find((card) => card.num === 1)?.volume).toBe(1)
  })

  it('rejects unknown nested book fields instead of silently ignoring them', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await expect(
        engine.submitOutline({
          book: { stric: true } as never,
          chapters: [chapterCard],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('refuses a planning write when the outline is damaged', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitOutline({ chapters: [chapterCard], root })
      await writeFile(join(root, 'outline/outline.yaml'), 'book: [bad]\n', 'utf8')
      await expect(engine.submitOutline({ chapters: [chapterCard], root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(
        engine.importOutline({ format: 'json', content: '{"chapters":[]}', root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('refuses to export an outline or proposal while the outline is damaged', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitOutline({ chapters: [chapterCard], root })
      await writeFile(join(root, 'outline/outline.yaml'), 'book: [bad]\n', 'utf8')
      await expect(engine.export({ kind: 'outline', root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.export({ kind: 'proposal', root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
    } finally {
      await cleanup()
    }
  })

  it('reopens an auto-created card without leaving the chapter unwritable', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      await engine.reopenChapter({ chapter: 1, reason: '重写结尾', root })
      const journal = (await readProjectFile(root, 'state/journal.jsonl'))!
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(journal.find((row) => row.op === 'reopenChapter' && row.status === 'committed')).toMatchObject({
        reason: '重写结尾',
      })
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toEqual([])
      await engine.getBrief({ stage: 'P3', root })
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

  it('refuses an outline amend that deletes archived cards while chapters is unreadable', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const outlineText = (await readProjectFile(root, 'outline/outline.yaml'))!
      const outline = parseYaml(outlineText) as Record<string, unknown>
      await writeFile(join(root, 'state/chapters.yaml'), 'chapters: [bad]\n', 'utf8')
      await expect(
        engine.amend({
          path: 'outline/outline.yaml',
          content: { ...outline, chapters: [] },
          reason: 'delete archived cards',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(engine.submitOutline({ chapters: [chapterCard], root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
    } finally {
      await cleanup()
    }
  })

  it('refuses to lower total_chapters below an existing volume or card', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '书',
        genre: '都市现代',
        platform: 'fanqie',
        total_chapters: 5,
        root,
      })
      await engine.submitBookPlan({
        volumes: [{ title: '卷一', start_chapter: 1, end_chapter: 5 }],
        root,
      })
      const project = (await engine.queryState({ kind: 'novel', root })).data as Record<string, unknown>
      await expect(
        engine.amend({
          path: 'novel.yaml',
          content: {
            ...project,
            targets: { ...(project.targets as Record<string, unknown>), total_chapters: 3 },
          },
          reason: 'shorten book',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('honours an explicit strict:false opt-out on the first outline', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitBookPlan({ strict: false, root })
      await engine.submitOutline({ chapters: [chapterCard], root })
      expect((await engine.getStatus({ root })).data.book?.strict).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('returns executable chapters in the strict-mode missing-card next step', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitBookPlan({ strict: true, root })
      const status = await engine.getStatus({ root })
      expect(status.data.next.tool).toBe('novel_outline')
      const args = status.data.next.args as { chapters: Array<Record<string, unknown>> }
      expect(args.chapters).toHaveLength(1)
      expect(args.chapters[0]).toMatchObject({ num: 1, status: 'planned' })
      await engine.submitOutline({ chapters: args.chapters as never, root })
      expect((await engine.getStatus({ root })).data.book?.outline.planned).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('does not recommend novel_init when novel.yaml is missing but state survives', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await rm(join(root, 'novel.yaml'))
      const doctor = await engine.doctor({ root })
      expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id: 'project', severity: 'error' }))
      expect(doctor.data.checks.map((check) => check.hint)).not.toContain(
        'call novel_init, or pass the correct project root',
      )
      const guide = await engine.guide({ root })
      expect(guide.data.next.tool).not.toBe('novel_init')
      expect(guide.data.state).toBe('blocked')
    } finally {
      await cleanup()
    }
  })

  it('reports the last appearance chapter, not a stale ledger update', () => {
    const second: ChapterRecord = {
      ...record,
      num: 2,
      title: '旧城之影',
      content_hash: 'hash-2',
      summary: { ...record.summary, characters_appeared: ['他'] },
    }
    const report = buildBookReport({
      project: {
        schema_version: 1,
        title: '书',
        genre: '都市现代',
        platform: 'fanqie',
        author: '',
        description: '',
        created_at: '2026-01-01',
        targets: { words_per_chapter: [80, 400], total_chapters: 2, dialogue_ratio: [0, 1] },
      },
      outline: emptyOutline('2026-01-01'),
      outlinePresent: false,
      worldbook: emptyWorldbook('2026-01-01'),
      worldbookPresent: false,
      chapters: [record, second],
      characters: {
        schema_version: 1,
        characters: [
          {
            name: '他',
            role: 'protagonist',
            first_appearance: 1,
            profile: {},
            current_state: {},
            growth: [],
            updated_at: 1,
          },
        ],
      },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
      reviews: [],
      activity: [],
      targetChapters: 2,
      minScore: 120,
      foreshadowDormantAfter: 10,
    })
    expect(report.cast.top[0]?.last_seen).toBe(2)
  })

  it('round-trips a volume-less card without moving it into a volume', () => {
    const outline = emptyOutline('2026-01-01')
    outline.volumes = [
      {
        id: 'V1',
        title: '卷一',
        start_chapter: 1,
        end_chapter: 5,
        goal: '',
        arc: '',
        climax: '',
        status: 'planned',
      },
    ]
    outline.chapters = [chapterCard, { ...chapterCard, num: 7, volume: null }]
    const rendered = renderOutlineMarkdown(
      { title: '书', genre: '都市现代', platform: 'fanqie' },
      outline,
      [],
    )
    const parsed = parseOutlineMarkdown(rendered)
    expect(parsed.volumes[0]).toMatchObject({ start_chapter: 1, end_chapter: 5 })
    expect(parsed.chapters.find((card) => card.num === 7)?.volume).toBeNull()
  })

  it('supports a text-only diff without a chapter argument', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      const result = await engine.diff({ before: 'a\nb', after: 'a\nc', root })
      expect(result.data.chapter).toBe(1)
      expect(result.data.added).toBe(1)
      expect(result.data.removed).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('returns per-section worldbook counts', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      const result = await engine.submitWorldbook({
        rules: [{ name: '规则', description: '说明' }],
        characters: [{ name: '他', role: '主角', description: '档案员', arc: '' }],
        root,
      })
      expect(result.data.counts).toMatchObject({ rules: 1, characters: 1, themes: 0 })
    } finally {
      await cleanup()
    }
  })

  it('refuses to reopen when the archive digest backup was pruned', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = await readyToArchive({ root, engine })
      await writeFile(join(root, 'state/archive-digests.json'), '{}\n', 'utf8')
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const journal = (await readProjectFile(root, 'state/journal.jsonl'))!
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const archive = journal.find((row) => row.op === 'archiveChapter' && row.status === 'committed') as
        { txid?: string } | undefined
      expect(archive?.txid).toBeTruthy()
      await rm(join(root, 'backups', archive!.txid!, 'state/archive-digests.json'), { force: true })
      await expect(engine.reopenChapter({ chapter: 1, reason: '改结尾', root })).rejects.toMatchObject({
        code: 'ENGINE_TXN_ABORTED',
      })
      expect(text.length).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })

  it('refuses an outline amend that cannot verify archived target/cast after backup pruning', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const outlineText = (await readProjectFile(root, 'outline/outline.yaml'))!
      const outline = parseYaml(outlineText) as Record<string, unknown>
      const cards = outline.chapters as Array<Record<string, unknown>>
      const forged = {
        ...outline,
        chapters: [{ ...cards[0]!, target_words: [200, 400], cast: ['她'] }],
      }
      await rm(join(root, 'outline/outline.yaml'))
      for (const entry of await readdir(join(root, 'backups'), { withFileTypes: true })) {
        if (entry.isDirectory()) {
          await rm(join(root, 'backups', entry.name, 'outline/outline.yaml'), { force: true })
        }
      }
      await expect(
        engine.amend({
          path: 'outline/outline.yaml',
          content: forged,
          reason: 'repair missing outline',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.0 review probes: coverage edges', () => {
  it('rejects outline cards beyond the target or the card limit', () => {
    const outline = emptyOutline('2026-01-01')
    outline.chapters = [{ ...chapterCard, num: 5 }]
    expect(() =>
      validateOutlineDocument(outline, {
        titleRule: { pattern: '^', min_chars: 1, max_chars: 20 },
        totalChapters: 3,
      }),
    ).toThrow(/total_chapters 3/)
    outline.chapters = Array.from({ length: 2001 }, (_, index) => ({
      ...chapterCard,
      num: index + 1,
    }))
    expect(() =>
      validateOutlineDocument(outline, {
        titleRule: { pattern: '^', min_chars: 1, max_chars: 20 },
        totalChapters: null,
      }),
    ).toThrow(/limit is 2000/)
  })

  it('recreates a missing card when reopening a record that has no card', () => {
    const outline = emptyOutline('2026-01-01')
    const reopened = markOutlineReopened(outline, 1, '2026-01-01', record)
    expect(reopened.chapters[0]).toMatchObject({
      num: 1,
      title: '开端之雨',
      status: 'planned',
      cast: ['他'],
    })
  })

  it('warns when a full outline replacement drops planned cards', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitOutline({
        chapters: [chapterCard, { ...chapterCard, num: 2, title: '旧城之影' }],
        root,
      })
      const result = await engine.submitOutline({ chapters: [chapterCard], root })
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'OUTLINE_PLANNED_DROPPED' }))
    } finally {
      await cleanup()
    }
  })

  it('refuses to export a damaged worldbook', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitWorldbook({ premise: '旧案之城', root })
      await writeFile(join(root, 'outline/worldbook.yaml'), 'premise: [bad]\n', 'utf8')
      await expect(engine.export({ kind: 'worldbook', root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
    } finally {
      await cleanup()
    }
  })

  it('refuses to reopen when the archived chapter plan is gone', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      await rm(join(root, 'plans/ch001.chapter.yaml'))
      // The archive now records the plan hash, so a missing/changed plan is
      // caught as an archive-tamper abort before reopen can rebuild the card.
      await expect(engine.reopenChapter({ chapter: 1, reason: '重写', root })).rejects.toMatchObject({
        code: 'ENGINE_TXN_ABORTED',
      })
    } finally {
      await cleanup()
    }
  })

  it('surfaces a damaged planning document in report warnings and guide steps', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitOutline({ chapters: [chapterCard], root })
      await writeFile(join(root, 'outline/outline.yaml'), 'book: [bad]\n', 'utf8')
      const report = await engine.report({ root })
      expect(report.data.warnings.join('\n')).toContain('书级大纲不可读')
      const guide = await engine.guide({ root })
      expect(guide.data.steps.find((step) => step.id === 'outline')?.detail).toContain('大纲不可读')
    } finally {
      await cleanup()
    }
  })
})
