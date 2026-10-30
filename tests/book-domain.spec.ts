import { describe, expect, it } from 'vitest'
import {
  bookBrief,
  bookPlanPresent,
  chapterTitleBody,
  emptyBookPlan,
  emptyOutline,
  emptyWorldbook,
  markOutlineArchived,
  markOutlineReopened,
  mergeBookPlan,
  mergeWorldbook,
  normalizeOutlineChapters,
  normalizeVolumes,
  outlineCard,
  outlineDrift,
  outlineSummary,
  parseOutlineData,
  parseOutlineInput,
  parseOutlineMarkdown,
  renderOutlineMarkdown,
  renderWorldbookMarkdown,
  stripChapterPrefix,
  validateOutlineDocument,
  validateWorldbookDocument,
  volumeForChapter,
  worldbookBrief,
  worldbookCounts,
} from '../src/engine/book.js'
import { EngineFaultError, EngineInputError } from '../src/types.js'
import { assertArchivedCardVolumes, assertArchivedCardsInVolumes } from '../src/engine/outline-merge.js'
import type { ChapterRecord, OutlineChapter, OutlineVolume } from '../src/types.js'

const titleRule = { pattern: '^', min_chars: 4, max_chars: 8 }
const card = (patch: Partial<OutlineChapter> = {}): OutlineChapter => ({
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
  ...patch,
})
const record = (num = 1): ChapterRecord => ({
  num,
  title: '开端之雨',
  file: `chapters/chapter-${String(num).padStart(3, '0')}.md`,
  word_count: 120,
  dialogue_lines: 2,
  dialogue_ratio: 0.4,
  scene_type: '日常过渡章',
  narrator: '他',
  score: 130,
  status: 'reviewed',
  content_hash: `hash-${num}`,
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
})
const volume = (patch: Partial<OutlineVolume> = {}): OutlineVolume => ({
  id: 'V1',
  title: '第一卷',
  start_chapter: 1,
  end_chapter: 3,
  goal: '',
  arc: '',
  climax: '',
  status: 'planned',
  ...patch,
})

describe('book plan and titles', () => {
  it('normalizes titles and rejects empty or out-of-range bodies', () => {
    expect(stripChapterPrefix('第 12 章 开端之雨')).toBe('开端之雨')
    expect(chapterTitleBody('第1章 开端之雨', titleRule)).toBe('开端之雨')
    expect(() => chapterTitleBody('   ', titleRule)).toThrow(EngineInputError)
    expect(() => chapterTitleBody('短', titleRule)).toThrow(EngineInputError)
    expect(() => chapterTitleBody('这是一个超过八个字的标题', titleRule)).toThrow(EngineInputError)
  })

  it('merges partial book patches and validates types', () => {
    const merged = mergeBookPlan(emptyBookPlan(), {
      premise: 'p',
      themes: ['a', 'b'],
      strict: true,
    })
    expect(merged).toMatchObject({ premise: 'p', themes: ['a', 'b'], strict: true })
    expect(() => mergeBookPlan(emptyBookPlan(), { themes: 'x' as never })).toThrow(EngineInputError)
    expect(() => mergeBookPlan(emptyBookPlan(), { themes: ['a', 'a'] })).toThrow(EngineInputError)
    expect(() => mergeBookPlan(emptyBookPlan(), { strict: 'yes' as never })).toThrow(EngineInputError)
    expect(() => mergeBookPlan(emptyBookPlan(), { strict_explicit: 'yes' as never })).toThrow(
      EngineInputError,
    )
    expect(() => mergeBookPlan(emptyBookPlan(), [] as never)).toThrow(/book must be an object/)
    expect(() => mergeBookPlan(emptyBookPlan(), { premise: 'x'.repeat(2001) })).toThrow(EngineInputError)
  })
})

describe('volumes', () => {
  it('sorts, derives ids and rejects overlaps or bad ranges', () => {
    const volumes = normalizeVolumes(
      [
        { title: '第二卷', start_chapter: 4, end_chapter: 6 },
        { title: '第一卷', start_chapter: 1, end_chapter: 3 },
      ],
      { totalChapters: 6 },
    )
    expect(volumes.map((entry) => entry.id)).toEqual(['V2', 'V1'])
    expect(volumes.map((entry) => entry.title)).toEqual(['第一卷', '第二卷'])
    expect(() => normalizeVolumes({}, { totalChapters: null })).toThrow(EngineInputError)
    expect(() => normalizeVolumes([{ title: '', start_chapter: 1, end_chapter: 1 }])).toThrow()
    expect(() =>
      normalizeVolumes([{ title: '卷', start_chapter: 3, end_chapter: 2 }], { totalChapters: null }),
    ).toThrow(EngineInputError)
    expect(() =>
      normalizeVolumes([{ title: '卷', start_chapter: 1, end_chapter: 1, status: 'x' as never }]),
    ).toThrow(EngineInputError)
    expect(() =>
      normalizeVolumes(
        [
          { id: 'V1', title: 'a', start_chapter: 1, end_chapter: 1 },
          { id: 'V1', title: 'b', start_chapter: 2, end_chapter: 2 },
        ],
        { totalChapters: null },
      ),
    ).toThrow(EngineInputError)
    expect(() =>
      normalizeVolumes(
        [
          { title: 'a', start_chapter: 1, end_chapter: 2 },
          { title: 'b', start_chapter: 2, end_chapter: 3 },
        ],
        { totalChapters: null },
      ),
    ).toThrow(EngineInputError)
    expect(() =>
      normalizeVolumes(
        [
          { title: 'a', start_chapter: 1, end_chapter: 2 },
          { title: 'b', start_chapter: 4, end_chapter: 5 },
        ],
        { totalChapters: null },
      ),
    ).toThrow(/contiguous/)
    expect(() =>
      normalizeVolumes([{ title: 'a', start_chapter: 1, end_chapter: 5 }], { totalChapters: 4 }),
    ).toThrow(EngineInputError)
  })

  it('assigns cards without inventing a volume', () => {
    const volumes = [volume()]
    expect(volumeForChapter(volumes, 2, null)).toBe(1)
    expect(volumeForChapter(volumes, 9, null)).toBeNull()
    expect(volumeForChapter(volumes, 2, 1)).toBe(1)
    expect(volumeForChapter(volumes, 9, 1)).toBeNull()
  })
})

describe('chapter cards', () => {
  it('normalizes planned cards and preserves archived history', () => {
    const normalized = normalizeOutlineChapters([{ ...card(), volume: 1, cast: ['他'] }], {
      volumes: [volume()],
      existing: [],
      archived: [],
      titleRule,
      totalChapters: 3,
      defaultTargetWords: [80, 400],
      now: '2026-01-01',
    })
    expect(normalized[0]).toMatchObject({ volume: 1, status: 'planned', notes: '' })
    const archived = normalizeOutlineChapters([card({ status: 'archived' })], {
      volumes: [],
      existing: [card({ status: 'archived', word_count: 100, score: 120 })],
      archived: [record()],
      titleRule,
      totalChapters: 3,
      defaultTargetWords: [80, 400],
      now: '2026-01-01',
    })
    expect(archived[0]).toMatchObject({ status: 'archived', word_count: 120, archived_at: null })
  })

  it('rejects malformed planned cards', () => {
    const options = {
      volumes: [],
      existing: [],
      archived: [],
      titleRule,
      totalChapters: 3,
      defaultTargetWords: [80, 400] as [number, number],
      now: '2026-01-01',
    }
    expect(() => normalizeOutlineChapters({}, options)).toThrow(EngineInputError)
    expect(() => normalizeOutlineChapters([null], options)).toThrow(EngineInputError)
    expect(() => normalizeOutlineChapters([{ ...card(), num: 0 }], options)).toThrow(EngineInputError)
    expect(() => normalizeOutlineChapters([{ ...card(), num: 9 }], options)).toThrow(EngineInputError)
    expect(() => normalizeOutlineChapters([card(), card()], options)).toThrow(EngineInputError)
    expect(() => normalizeOutlineChapters([{ ...card(), scene_type: 'nope' }], options)).toThrow(
      EngineInputError,
    )
    expect(() => normalizeOutlineChapters([{ ...card(), cast: ['a', 'a'] }], options)).toThrow(
      EngineInputError,
    )
    expect(() => normalizeOutlineChapters([{ ...card(), target_words: [4, 2] }], options)).toThrow(
      EngineInputError,
    )
    expect(() => normalizeOutlineChapters([{ ...card(), status: 'archived' }], options)).toThrow(
      EngineInputError,
    )
  })

  it('does not fabricate archived_at for an omitted archived card and protects its volume', () => {
    const archived = normalizeOutlineChapters([], {
      volumes: [volume()],
      existing: [],
      archived: [record()],
      titleRule,
      totalChapters: 3,
      defaultTargetWords: [80, 400],
      now: '2026-01-01',
    })
    expect(archived[0]).toMatchObject({ status: 'archived', archived_at: null })
    expect(() =>
      assertArchivedCardVolumes(
        [record()],
        [],
        [volume()],
        [volume({ title: '第二卷', start_chapter: 2, end_chapter: 3 })],
        'test',
      ),
    ).toThrow(/outside its volume/)
    expect(() =>
      assertArchivedCardsInVolumes([record()], [{ ...archived[0]!, volume: null }], [volume()], 'test'),
    ).toThrow(/without a covering volume/)
  })

  it('protects every archived field', () => {
    const options = {
      volumes: [],
      existing: [card({ status: 'archived', word_count: 120, score: 130 })],
      archived: [record()],
      titleRule,
      totalChapters: 3,
      defaultTargetWords: [80, 400] as [number, number],
      now: '2026-01-01',
    }
    const archivedCard = { ...card(), status: 'archived' as const }
    expect(() => normalizeOutlineChapters([{ ...archivedCard, title: '另一个标题' }], options)).toThrow(
      EngineInputError,
    )
    expect(() => normalizeOutlineChapters([{ ...archivedCard, scene_type: '纯叙事章' }], options)).toThrow(
      EngineInputError,
    )
    expect(() =>
      normalizeOutlineChapters([{ ...archivedCard, target_words: [2000, 3000] }], options),
    ).toThrow(EngineInputError)
    expect(() => normalizeOutlineChapters([{ ...archivedCard, cast: ['她'] }], options)).toThrow(
      EngineInputError,
    )
    expect(() => normalizeOutlineChapters([{ ...archivedCard, status: 'planned' }], options)).toThrow(
      EngineInputError,
    )
  })

  it('rejects a new card that claims a non-planning status', () => {
    const options = {
      volumes: [],
      existing: [],
      archived: [],
      titleRule,
      totalChapters: 3,
      defaultTargetWords: [80, 400] as [number, number],
      now: '2026-01-01',
    }
    expect(() => normalizeOutlineChapters([{ ...card(), status: 'writing' as never }], options)).toThrow(
      EngineInputError,
    )
    expect(() => normalizeOutlineChapters([{ ...card(), status: 'archived' }], options)).toThrow(
      EngineInputError,
    )
  })

  it('validates a stored outline document and reports faults', () => {
    const outline = emptyOutline('2026-01-01')
    outline.book.strict = true
    outline.volumes = [volume()]
    outline.chapters = [card({ volume: 1 })]
    expect(validateOutlineDocument(outline, { titleRule, totalChapters: 3 })).toMatchObject({
      book: { strict: true },
      chapters: [{ num: 1, volume: 1 }],
    })
    expect(() => validateOutlineDocument(null, { titleRule, totalChapters: 3 })).toThrow(EngineFaultError)
    expect(() =>
      validateOutlineDocument({ ...outline, chapters: 'x' }, { titleRule, totalChapters: 3 }),
    ).toThrow(EngineFaultError)
    expect(() =>
      validateOutlineDocument({ ...outline, chapters: [null] }, { titleRule, totalChapters: 3 }),
    ).toThrow(EngineFaultError)
    expect(() =>
      validateOutlineDocument(
        { ...outline, chapters: [card({ volume: 1 }), card({ volume: 1 })] },
        { titleRule, totalChapters: 3 },
      ),
    ).toThrow(EngineFaultError)
    expect(() =>
      validateOutlineDocument(
        { ...outline, chapters: [card({ volume: 9 })] },
        { titleRule, totalChapters: 3 },
      ),
    ).toThrow(EngineFaultError)
    expect(() =>
      validateOutlineDocument({ ...outline, schema_version: 2 }, { titleRule, totalChapters: 3 }),
    ).toThrow(EngineFaultError)
    expect(() =>
      validateOutlineDocument({ ...outline, extra: true }, { titleRule, totalChapters: 3 }),
    ).toThrow(EngineFaultError)
    expect(() =>
      validateOutlineDocument(
        { ...outline, book: { ...outline.book, unknown: true } },
        { titleRule, totalChapters: 3 },
      ),
    ).toThrow(EngineFaultError)
    expect(() =>
      validateOutlineDocument(
        { ...outline, chapters: [card({ goal: '' })] },
        { titleRule, totalChapters: 3 },
      ),
    ).toThrow(EngineFaultError)
    expect(() =>
      validateOutlineDocument(
        { ...outline, chapters: [card({ status: 'planned', word_count: 10 })] },
        { titleRule, totalChapters: 3 },
      ),
    ).toThrow(EngineFaultError)
  })

  it('marks archive state, drift and reopen state', () => {
    const outline = { ...emptyOutline('2026-01-01'), chapters: [card()] }
    const archived = markOutlineArchived(outline, record(), '2026-02-01', [80, 400])
    expect(archived.chapters[0]).toMatchObject({ status: 'archived', archived_at: '2026-02-01', score: 130 })
    const created = markOutlineArchived(emptyOutline('2026-01-01'), record(2), '2026-02-01', [80, 400])
    expect(created.chapters[0]).toMatchObject({ num: 2, target_words: [80, 400] })
    expect(outlineDrift(outline, [record()])).toEqual([])
    expect(outlineDrift(emptyOutline('2026-01-01'), [record()])).toContainEqual(
      expect.objectContaining({ field: 'card' }),
    )
    expect(
      outlineDrift({ ...outline, chapters: [card({ title: '不同', scene_type: '纯叙事章' })] }, [record()]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'title' }),
        expect.objectContaining({ field: 'scene_type' }),
      ]),
    )
    expect(markOutlineReopened(archived, 1, '2026-03-01').chapters[0]).toMatchObject({
      status: 'planned',
      word_count: null,
      score: null,
    })
  })

  it('rejects malformed archived fields and tolerates explicit nulls and volume', () => {
    const outline = emptyOutline('2026-01-01')
    outline.volumes = [volume()]
    outline.chapters = [
      card({ volume: 1, status: 'archived', archived_at: 123 as never, word_count: null, score: null }),
    ]
    expect(() => validateOutlineDocument(outline, { titleRule, totalChapters: 3 })).toThrow(EngineFaultError)
    outline.chapters = [
      card({ volume: 1, status: 'archived', archived_at: null, word_count: null, score: null }),
    ]
    const validated = validateOutlineDocument(outline, { titleRule, totalChapters: 3 })
    expect(validated.chapters[0]).toMatchObject({ archived_at: null, word_count: null, score: null })
    const normalized = normalizeOutlineChapters([{ ...card({ status: 'archived' }), volume: null }], {
      volumes: [volume()],
      existing: [card({ status: 'archived', word_count: 120, score: 130 })],
      archived: [record()],
      titleRule,
      totalChapters: 3,
      defaultTargetWords: [80, 400],
      now: '2026-01-01',
    })
    expect(normalized[0]).toMatchObject({ status: 'archived', volume: 1 })
  })

  it('summarizes cards and cards by chapter', () => {
    const outline = emptyOutline('2026-01-01')
    outline.chapters = [card(), card({ num: 2, status: 'archived' })]
    expect(outlineCard(outline, 2)).toMatchObject({ num: 2 })
    expect(outlineCard(outline, 9)).toBeNull()
    expect(outlineSummary(outline, 2)).toMatchObject({
      present: true,
      total: 2,
      planned: 1,
      archived: 1,
      coverage: 0.5,
    })
    expect(bookBrief(outline, 1)).toMatchObject({ volume: null, card: { num: 1 } })
  })

  it('treats a blueprint-only outline as present and detects partial worldbooks', () => {
    const blueprintOnly = emptyOutline('2026-01-01')
    blueprintOnly.book.themes = ['记忆']
    expect(bookPlanPresent(emptyBookPlan())).toBe(false)
    expect(bookPlanPresent(blueprintOnly.book)).toBe(true)
    expect(outlineSummary(blueprintOnly, 0)).toMatchObject({ present: true, total: 0, coverage: 0 })

    const partial = emptyWorldbook('2026-01-01')
    partial.themes = ['记忆']
    partial.factions = [{ name: '巡夜司', description: '', goal: '' }]
    expect(worldbookCounts(partial).present).toBe(true)
    const clipped = emptyWorldbook('2026-01-01')
    clipped.premise = 'p'.repeat(1_000)
    clipped.characters = [
      {
        name: '他',
        role: '主角',
        description: 'd'.repeat(1_000),
        arc: 'a'.repeat(1_000),
      },
    ]
    const brief = worldbookBrief(clipped, '他', ['他'])
    expect((brief.premise as string).length).toBeLessThanOrEqual(601)
    expect((brief.characters as Array<{ description: string }>)[0]!.description.length).toBeLessThanOrEqual(
      241,
    )
  })
})

describe('worldbook', () => {
  it('merges sections and validates names, capacity and glossary duplicates', () => {
    const base = emptyWorldbook('2026-01-01')
    const merged = mergeWorldbook(
      base,
      {
        premise: '前提',
        setting: '设定',
        themes: ['主题'],
        rules: [{ name: '规则', description: '说明' }],
        factions: [{ name: '势力', description: '说明', goal: '目标' }],
        locations: [{ name: '地点', description: '说明', layout: '', capacity: 0 }],
        characters: [{ name: '角色', role: '主角', description: '说明', arc: '' }],
        glossary: [{ term: '术语', definition: '定义' }],
        backstory: [{ time: '十年前', event: '旧事' }],
        facts: [{ alias: '车费', value: 300, unit: '元', note: '旧账' }],
      },
      '2026-01-02',
    )
    expect(worldbookCounts(merged)).toMatchObject({
      present: true,
      characters: 1,
      locations: 1,
      factions: 1,
      rules: 1,
      glossary: 1,
      backstory: 1,
    })
    expect(worldbookBrief(merged, '角色', ['角色'])).toMatchObject({ characters: [{ name: '角色' }] })
    expect(renderWorldbookMarkdown({ title: '书' }, merged)).toContain('世界观设定集')
    expect(() => mergeWorldbook(base, { rules: 'x' as never }, 'now')).toThrow(EngineInputError)
    expect(() => mergeWorldbook(base, { rules: [null as never] }, 'now')).toThrow(EngineInputError)
    expect(() =>
      mergeWorldbook(
        base,
        {
          rules: [
            { name: 'a', description: 'b' },
            { name: 'a', description: 'c' },
          ],
        },
        'now',
      ),
    ).toThrow(EngineInputError)
    expect(() =>
      mergeWorldbook(base, { locations: [{ name: 'a', description: 'b', layout: '', capacity: -1 }] }, 'now'),
    ).toThrow(EngineInputError)
    expect(() =>
      mergeWorldbook(
        base,
        {
          glossary: [
            { term: 'a', definition: 'b' },
            { term: 'a', definition: 'c' },
          ],
        },
        'now',
      ),
    ).toThrow(EngineInputError)
    expect(() => validateWorldbookDocument(null, 'now')).toThrow(EngineFaultError)
    const valid = emptyWorldbook('2026-01-01')
    expect(validateWorldbookDocument(valid, 'now')).toMatchObject({ premise: '', rules: [] })
    expect(() => validateWorldbookDocument({ ...valid, schema_version: 2 }, 'now')).toThrow(EngineFaultError)
    expect(() => validateWorldbookDocument({ ...valid, extra: true }, 'now')).toThrow(EngineFaultError)
    expect(() =>
      validateWorldbookDocument(
        {
          ...valid,
          locations: [{ name: 'a', description: 'b', layout: '', capacity: -1 }],
        },
        'now',
      ),
    ).toThrow(EngineFaultError)
    expect(() => validateWorldbookDocument({ ...valid, themes: [1] as never }, 'now')).toThrow(
      EngineFaultError,
    )
    expect(() => validateWorldbookDocument({ ...valid, locations: [null] as never }, 'now')).toThrow(
      EngineFaultError,
    )
  })
})

describe('outline import and render', () => {
  const markdown = [
    '# 书',
    '> 梗概',
    '主题：成长、选择',
    '基调：冷',
    '视角：三',
    '读者：男频',
    '卖点：甲、乙',
    '结局：胜',
    '严格：true',
    '',
    '## 第一卷 卷名（第1-3章）',
    '目标：卷目标',
    '弧线：卷弧',
    '高潮：卷高潮',
    '',
    '### 第1章 开端之雨',
    '场景：日常过渡章',
    '字数：80-400',
    '角色：他、她',
    '目标：收信',
    '冲突：拆不拆',
    '钩子：日期',
    '备注：备注',
  ].join('\n')

  it('parses the documented Markdown template', () => {
    const parsed = parseOutlineMarkdown(markdown)
    expect(parsed.book).toMatchObject({ logline: '梗概', themes: ['成长', '选择'], strict: true })
    expect(parsed.volumes[0]).toMatchObject({ title: '第一卷 卷名', start_chapter: 1, end_chapter: 3 })
    expect(parsed.chapters[0]).toMatchObject({ num: 1, title: '开端之雨', cast: ['他', '她'], notes: '备注' })
    expect(parsed.warnings).toEqual([])
  })

  it('rejects missing chapter fields and malformed values', () => {
    expect(() => parseOutlineMarkdown('')).toThrow(EngineInputError)
    expect(() => parseOutlineMarkdown('### no number')).toThrow(EngineInputError)
    expect(() =>
      parseOutlineMarkdown('### 第1章 标题\n场景：日常过渡章\n字数：80-400\n目标：a\n冲突：b'),
    ).toThrow(EngineInputError)
    expect(() =>
      parseOutlineMarkdown('### 第1章 标题\n场景：日常过渡章\n字数：x\n目标：a\n冲突：b\n钩子：c'),
    ).toThrow(EngineInputError)
    expect(() =>
      parseOutlineMarkdown(
        '### 第1章 标题\n场景：日常过渡章\n字数：80-400\n角色：他\n目标：a\n冲突：b\n钩子：c',
      ),
    ).not.toThrow()
    expect(() => parseOutlineMarkdown('## 空卷\n')).toThrow(EngineInputError)
  })

  it('reports unknown lines and volume range warnings', () => {
    const parsed = parseOutlineMarkdown(
      [
        '# 书',
        '未知行',
        '## 第一卷 无范围',
        '未知字段：x',
        '### 第1章 开端之雨',
        '场景：日常过渡章',
        '字数：80-400',
        '目标：a',
        '冲突：b',
        '钩子：c',
        '未知章节字段：x',
      ].join('\n'),
    )
    expect(parsed.warnings.length).toBeGreaterThan(0)
    expect(parsed.volumes[0]).toMatchObject({ start_chapter: 1, end_chapter: 1 })
  })

  it('drops an empty un-ranged volume and accepts exported archive metadata', () => {
    const parsed = parseOutlineMarkdown(
      [
        '## 第一卷 空卷',
        '## 第二卷 有范围（第1-1章）',
        '### 第1章 开端之雨',
        '场景：日常过渡章',
        '字数：80-400',
        '目标：a',
        '冲突：b',
        '钩子：c',
      ].join('\n'),
    )
    expect(parsed.volumes).toHaveLength(1)
    expect(parsed.volumes[0]).toMatchObject({ title: '第二卷 有范围', start_chapter: 1, end_chapter: 1 })
    expect(parsed.warnings).toContainEqual(expect.stringContaining('空卷'))

    const outline = emptyOutline('2026-01-01')
    outline.book.logline = '梗概'
    outline.volumes = [volume()]
    outline.chapters = [
      card({ volume: 1, status: 'archived', archived_at: '2026-01-01', word_count: 120, score: 130 }),
    ]
    const rendered = renderOutlineMarkdown({ title: '书', genre: '都市现代', platform: 'fanqie' }, outline, [
      record(),
    ])
    const roundTrip = parseOutlineMarkdown(rendered)
    expect(roundTrip.warnings).toContainEqual(expect.stringContaining('归档 metadata'))
    expect(roundTrip.chapters[0]).toMatchObject({ num: 1, title: '开端之雨' })
  })

  it('parses YAML/JSON and rejects malformed payloads', () => {
    expect(parseOutlineData('chapters:\n  - num: 1', 'yaml').chapters).toHaveLength(1)
    expect(parseOutlineData('{"chapters":[]}', 'json').chapters).toHaveLength(0)
    expect(() => parseOutlineData('{', 'json')).toThrow(EngineInputError)
    expect(() => parseOutlineData('[]', 'yaml')).toThrow(EngineInputError)
    expect(() => parseOutlineData('{}', 'yaml')).toThrow(EngineInputError)
    expect(() => parseOutlineData('{"schema_version":2,"chapters":[]}', 'json')).toThrow(EngineInputError)
    expect(() => parseOutlineInput('x', 'xml' as never)).toThrow(EngineInputError)
  })

  it('covers merge defaults, no-card reopen and outside-volume render', () => {
    const now = '2026-01-01'
    expect(mergeWorldbook(emptyWorldbook(now), undefined, '2026-02-01').updated_at).toBe('2026-02-01')
    expect(markOutlineReopened(emptyOutline(now), 1, now).chapters).toEqual([])
    const outline = emptyOutline(now)
    outline.book.strict = false
    outline.chapters = [card({ num: 2 })]
    const rendered = renderOutlineMarkdown(
      { title: '书', genre: '都市现代', platform: 'fanqie' },
      outline,
      [],
    )
    expect(rendered).toContain('### 第2章')
    const parsed = parseOutlineMarkdown(
      [
        '# 书名',
        '<!-- 注释 -->',
        '严格：false',
        '## 无范围卷',
        '### 第1章 开端之雨',
        '场景：日常过渡章',
        '字数：80-400',
        '目标：a',
        '冲突：b',
        '钩子：c',
      ].join('\n'),
    )
    expect(parsed.book.strict).toBe(false)
    expect(parsed.volumes[0]).toMatchObject({ start_chapter: 1, end_chapter: 1 })
    const archivedWithoutStatus = normalizeOutlineChapters([{ ...card(), status: undefined }], {
      volumes: [],
      existing: [card({ status: 'archived', word_count: 120, score: 130 })],
      archived: [record()],
      titleRule,
      totalChapters: 3,
      defaultTargetWords: [80, 400],
      now,
    })
    expect(archivedWithoutStatus[0]?.status).toBe('archived')
  })

  it('renders the outline and worldbook in the import template shape', () => {
    const outline = emptyOutline('2026-01-01')
    outline.book.logline = '梗概'
    outline.volumes = [volume()]
    outline.chapters = [
      card({ volume: 1, status: 'archived', archived_at: '2026-01-01', word_count: 120, score: 130 }),
      card({ num: 4, volume: null }),
    ]
    const rendered = renderOutlineMarkdown({ title: '书', genre: '都市现代', platform: 'fanqie' }, outline, [
      record(),
    ])
    expect(rendered).toContain('## 第一卷')
    expect(rendered).toContain('### 第1章 开端之雨')
    expect(rendered).toContain('归档：120 字 / 130 分')
    expect(rendered).toContain('### 第4章')
  })

  it('renders every optional worldbook section and parses a full JSON document', () => {
    const worldbook = mergeWorldbook(
      emptyWorldbook('2026-01-01'),
      {
        premise: '前提',
        setting: '设定',
        themes: ['主题'],
        rules: [{ name: '规则', description: '说明' }],
        factions: [{ name: '势力', description: '说明', goal: '目标' }],
        locations: [{ name: '地点', description: '说明', layout: '布局', capacity: 10 }],
        characters: [{ name: '角色', role: '主角', description: '说明', arc: '弧线' }],
        glossary: [{ term: '术语', definition: '定义' }],
        backstory: [{ time: '十年前', event: '旧事' }],
        facts: [{ alias: '车费', value: 300, unit: '元', note: '旧账' }],
      },
      '2026-01-02',
    )
    const rendered = renderWorldbookMarkdown({ title: '书' }, worldbook)
    expect(rendered).toContain('势力')
    expect(rendered).toContain('布局')
    expect(rendered).toContain('弧线')
    expect(rendered).toContain('术语')
    expect(rendered).toContain('旧事')
    expect(rendered).toContain('数值事实')
    expect(rendered).toContain('车费')
    expect(rendered).toContain('300元')
    const parsed = parseOutlineData(
      JSON.stringify({
        book: { logline: 'JSON 梗概' },
        volumes: [{ title: '卷', start_chapter: 1, end_chapter: 1 }],
        chapters: [],
      }),
      'json',
    )
    expect(parsed.book.logline).toBe('JSON 梗概')
    expect(parsed.volumes).toHaveLength(1)
    const brief = worldbookBrief(worldbook, '不存在的名字', [])
    expect(brief.characters).toHaveLength(1)
  })
})

describe('outline and worldbook validation edges', () => {
  it('rejects malformed field shapes before they reach disk', () => {
    expect(() => chapterTitleBody(42 as never, titleRule)).toThrow(EngineInputError)
    expect(() => chapterTitleBody('这是一个超过八个字的标题', titleRule)).toThrow(EngineInputError)
    expect(() => mergeBookPlan(emptyBookPlan(), { logline: 42 as never })).toThrow(EngineInputError)
    expect(() => mergeBookPlan(emptyBookPlan(), { logline: 'x'.repeat(2_001) })).toThrow(EngineInputError)
    expect(() =>
      mergeBookPlan(emptyBookPlan(), { themes: Array.from({ length: 21 }, (_, i) => `t${i}`) }),
    ).toThrow(EngineInputError)
    expect(() => mergeBookPlan(emptyBookPlan(), { themes: [1] as never })).toThrow(EngineInputError)
    expect(() => normalizeVolumes([null as never], { totalChapters: null })).toThrow(EngineInputError)
    expect(() =>
      normalizeVolumes(
        Array.from({ length: 51 }, (_, i) => ({
          title: `卷${i}`,
          start_chapter: i * 2 + 1,
          end_chapter: i * 2 + 1,
        })),
      ),
    ).toThrow(EngineInputError)
    expect(() => normalizeVolumes([{ title: '卷', start_chapter: 0, end_chapter: 1 }])).toThrow(
      EngineInputError,
    )
    expect(() =>
      normalizeOutlineChapters([null as never], {
        volumes: [],
        existing: [],
        archived: [],
        titleRule,
        totalChapters: 3,
        defaultTargetWords: [80, 400],
        now: '2026-01-01',
      }),
    ).toThrow(EngineInputError)
    expect(() =>
      normalizeOutlineChapters(
        Array.from({ length: 2_001 }, (_, i) => ({ ...card(), num: i + 1 })),
        {
          volumes: [],
          existing: [],
          archived: [],
          titleRule,
          totalChapters: null,
          defaultTargetWords: [80, 400],
          now: '2026-01-01',
        },
      ),
    ).toThrow(EngineInputError)
  })

  it('rejects scalar field, cast, target, num and volume errors', () => {
    const options = {
      volumes: [],
      existing: [],
      archived: [],
      titleRule,
      totalChapters: null,
      defaultTargetWords: [80, 400] as [number, number],
      now: '2026-01-01',
    }
    expect(mergeBookPlan(emptyBookPlan(), undefined)).toEqual(emptyBookPlan())
    expect(mergeBookPlan(emptyBookPlan(), { premise: null as never, themes: null as never })).toEqual(
      emptyBookPlan(),
    )
    expect(() => normalizeOutlineChapters([{ ...card(), goal: '' }], options)).toThrow(EngineInputError)
    expect(() => normalizeOutlineChapters([{ ...card(), goal: 42 as never }], options)).toThrow(
      EngineInputError,
    )
    expect(() => normalizeOutlineChapters([{ ...card(), cast: 'x' as never }], options)).toThrow(
      EngineInputError,
    )
    expect(() => normalizeOutlineChapters([{ ...card(), cast: ['他', '他'] }], options)).toThrow(
      EngineInputError,
    )
    expect(() => normalizeOutlineChapters([{ ...card(), target_words: [80] as never }], options)).toThrow(
      EngineInputError,
    )
    expect(() => normalizeOutlineChapters([{ ...card(), num: 0 }], options)).toThrow(EngineInputError)
    expect(() => normalizeOutlineChapters([{ ...card(), volume: 9 }], options)).toThrow(EngineInputError)
    const archiveOptions = {
      volumes: [volume()],
      existing: [card({ status: 'archived', word_count: 120, score: 130 })],
      archived: [record()],
      titleRule,
      totalChapters: 3,
      defaultTargetWords: [80, 400] as [number, number],
      now: '2026-01-01',
    }
    expect(() =>
      normalizeOutlineChapters([{ ...card({ status: 'archived' }), scene_type: '纯叙事章' }], archiveOptions),
    ).toThrow(EngineInputError)
  })

  it('rejects malformed stored documents and import payloads', () => {
    const outline = emptyOutline('2026-01-01')
    outline.chapters = [card()]
    expect(() =>
      validateOutlineDocument({ ...outline, updated_at: 1 }, { titleRule, totalChapters: 3 }),
    ).toThrow(EngineFaultError)
    expect(() =>
      validateOutlineDocument({ ...outline, book: null }, { titleRule, totalChapters: 3 }),
    ).toThrow(EngineFaultError)
    expect(() =>
      validateOutlineDocument({ ...outline, book: undefined }, { titleRule, totalChapters: 3 }),
    ).toThrow(EngineFaultError)
    expect(() =>
      validateOutlineDocument({ ...outline, volumes: 'x' }, { titleRule, totalChapters: 3 }),
    ).toThrow(EngineFaultError)
    expect(() =>
      validateOutlineDocument(
        { ...outline, chapters: [{ ...card(), status: 'weird' }] },
        { titleRule, totalChapters: 3 },
      ),
    ).toThrow(EngineFaultError)
    expect(() =>
      validateOutlineDocument(
        { ...outline, chapters: [{ ...card(), scene_type: 'weird' }] },
        { titleRule, totalChapters: 3 },
      ),
    ).toThrow(EngineFaultError)
    expect(() =>
      validateOutlineDocument({ ...outline, chapters: [card(), card()] }, { titleRule, totalChapters: 3 }),
    ).toThrow(EngineFaultError)

    const worldbook = emptyWorldbook('2026-01-01')
    expect(() => validateWorldbookDocument({ ...worldbook, rules: [null] }, 'now')).toThrow(EngineFaultError)
    expect(() => validateWorldbookDocument({ ...worldbook, updated_at: 1 }, 'now')).toThrow(EngineFaultError)

    const parsed = parseOutlineData('chapters:\n  - num: 1\nextra: true', 'yaml')
    expect(parsed.warnings).toContainEqual(expect.stringContaining('unknown top-level'))
  })

  it('rejects each missing Markdown chapter field with a line-numbered error', () => {
    for (const missing of ['场景', '字数', '目标', '冲突', '钩子']) {
      const lines = [
        '### 第1章 开端之雨',
        '场景：日常过渡章',
        '字数：80-400',
        '目标：a',
        '冲突：b',
        '钩子：c',
      ].filter((line) => !line.startsWith(`${missing}：`))
      expect(() => parseOutlineMarkdown(lines.join('\n'))).toThrow(/line 1/)
    }
  })

  it('fills every empty planning field when reopening an archived card', () => {
    const outline = emptyOutline('2026-01-01')
    outline.chapters = [
      card({ goal: '', conflict: '', hook: '', status: 'archived', word_count: 100, score: 130 }),
    ]
    const reopened = markOutlineReopened(outline, 1, '2026-01-01')
    expect(reopened.chapters[0]).toMatchObject({
      goal: '重开章节：待补充目标',
      conflict: '重开章节：待补充冲突',
      hook: '重开章节：待补充钩子',
    })
    expect(markOutlineReopened(emptyOutline('2026-01-01'), 2, '2026-01-01').chapters).toEqual([])
  })

  it('ignores an empty volume heading and keeps a plain title as a volume', () => {
    const markdown = [
      '## （第1-2章）',
      '## 引子',
      '### 第1章 开端之雨',
      '场景：日常过渡章',
      '字数：80-400',
      '目标：a',
      '冲突：b',
      '钩子：c',
    ].join('\n')
    const parsed = parseOutlineMarkdown(markdown)
    expect(parsed.warnings.some((warning) => warning.includes('ignored heading'))).toBe(true)
    expect(parsed.chapters[0]).toMatchObject({ volume: 1 })
  })
})
