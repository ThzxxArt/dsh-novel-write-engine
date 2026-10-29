import { describe, expect, it } from 'vitest'
import { emptyOutline, emptyWorldbook, outlineSummary } from '../src/engine/book.js'
import { buildBookReport, buildGuide, scoreOf, searchSnapshot } from '../src/engine/insight.js'
import type {
  ChapterRecord,
  CharactersDocument,
  ForeshadowsDocument,
  HandoffDocument,
  LocksDocument,
  NovelProject,
  RelationshipsDocument,
  ReviewDocument,
  TimelineDocument,
  WorldDocument,
} from '../src/types.js'

const project: NovelProject = {
  schema_version: 1,
  title: '测试之书',
  genre: '都市现代',
  platform: 'fanqie',
  author: '',
  description: '',
  created_at: '2026-01-01',
  targets: { words_per_chapter: [80, 400], total_chapters: 4, dialogue_ratio: [0.4, 0.6] },
}

const record = (num: number, score: number, patch: Partial<ChapterRecord> = {}): ChapterRecord => ({
  num,
  title: `标题${num}`,
  file: `chapters/chapter-${String(num).padStart(3, '0')}.md`,
  word_count: 100 + num * 10,
  dialogue_lines: 5,
  dialogue_ratio: 0.4,
  scene_type: num % 2 === 0 ? '纯叙事章' : '日常过渡章',
  narrator: '他',
  score,
  status: 'reviewed',
  content_hash: `hash-${num}`,
  summary: {
    events: [`事件${num}`],
    characters_appeared: ['他', num === 2 ? '配角A' : '他'],
    foreshadows: { planted: [], advanced: [], resolved: [] },
    new_elements: { locations: [], abilities: [], artifacts: [] },
    resource_changes: [],
    opening: '开头',
    continuity: { opens_from: '上章', ends_with: '钩子' },
    hook_strength: num,
    pleasure_points: [],
    plot_advancement: num === 1 ? 'high' : 'low',
  },
  ...patch,
})

const review = (num: number, score: number): ReviewDocument => ({
  schema_version: 1,
  chapter: num,
  round: 1,
  content_hash: `hash-${num}`,
  dimensions: [
    {
      id: 'R-W-01',
      max: 15,
      deductions: [{ rule: 'X', location: '第 1 段', delta: 15 - (score - 100), note: '' }],
    },
    { id: 'R-W-04', max: 20, deductions: [] },
  ],
  issues: [],
  total: score,
})

const characters: CharactersDocument = {
  schema_version: 1,
  characters: [
    {
      name: '他',
      role: 'protagonist',
      first_appearance: 1,
      profile: {},
      current_state: {},
      growth: [],
      updated_at: 2,
    },
    {
      name: '配角A',
      role: 'supporting',
      first_appearance: 2,
      profile: {},
      current_state: {},
      growth: [],
      updated_at: 2,
    },
  ],
}

const timeline: TimelineDocument = {
  schema_version: 1,
  next_seq: 2,
  items: [
    {
      id: 'TE-001',
      chapter: 1,
      story_time: '第一天',
      description: '开场',
      location: '旧办公室',
      characters: ['他'],
    },
    {
      id: 'TE-002',
      chapter: 2,
      story_time: '第二天',
      description: '推进',
      location: '旧城',
      characters: ['他'],
    },
  ],
}

const foreshadows: ForeshadowsDocument = {
  schema_version: 1,
  next_seq: 4,
  items: [
    {
      id: 'FS-001',
      title: '旧信',
      planted: 1,
      last_touched: 1,
      status: 'planted',
      resolved_at: null,
      description: '',
      advance_log: [],
    },
    {
      id: 'FS-002',
      title: '蜡印',
      planted: 1,
      last_touched: 2,
      status: 'dormant',
      resolved_at: null,
      description: '',
      advance_log: [],
    },
    {
      id: 'FS-003',
      title: '档案',
      planted: 1,
      last_touched: 2,
      status: 'resolved',
      resolved_at: 2,
      description: '',
      advance_log: [],
    },
  ],
}

const relationships: RelationshipsDocument = {
  schema_version: 1,
  next_seq: 2,
  items: [{ id: 'RL-001', a: '他', b: '配角A', type: '旧识', since: 2, description: '', evolution: [] }],
}

const reportInput = (patch: Partial<Parameters<typeof buildBookReport>[0]> = {}) => ({
  project,
  outline: emptyOutline('2026-01-01'),
  outlinePresent: false,
  worldbook: emptyWorldbook('2026-01-01'),
  worldbookPresent: false,
  chapters: [record(1, 100), record(2, 140)],
  characters,
  timeline,
  foreshadows,
  relationships,
  reviews: [review(1, 100), review(2, 140)],
  activity: [
    {
      at: '2026-01-01',
      op: 'archiveChapter',
      chapter: 1,
      revision: 2,
      txid: 't',
      status: 'committed' as const,
      files: [],
    },
  ],
  targetChapters: 4,
  minScore: 121,
  foreshadowDormantAfter: 1,
  ...patch,
})

describe('book report', () => {
  it('computes progress, quality, pacing, cast, foreshadows and warnings', () => {
    const report = buildBookReport(reportInput())
    expect(report.progress).toMatchObject({ archived: 2, target: 4, words: 230, percent: 50 })
    expect(report.quality.average).toBe(120)
    expect(report.quality.median).toBe(120)
    expect(report.quality.min).toBe(100)
    expect(report.quality.max).toBe(140)
    expect(report.quality.last_five).toEqual([100, 140])
    expect(report.quality.dimensions).toContainEqual(expect.objectContaining({ id: 'R-W-01', samples: 2 }))
    expect(report.pacing.scene_types).toMatchObject({ 日常过渡章: 1, 纯叙事章: 1 })
    expect(report.pacing.hook_strength).toMatchObject({ '1': 1, '2': 1 })
    expect(report.pacing.longest).toMatchObject({ chapter: 2 })
    expect(report.pacing.shortest).toMatchObject({ chapter: 1 })
    expect(report.cast.top[0]).toMatchObject({ name: '他', appearances: 2 })
    expect(report.foreshadows).toMatchObject({ open: 2, dormant: 1, resolved: 1 })
    expect(report.foreshadows.overdue).toBe(1)
    expect(report.foreshadows.oldest[0]).toMatchObject({ id: 'FS-001', age: 1 })
    expect(report.timeline).toMatchObject({ events: 2, first_chapter: 1, last_chapter: 2 })
    expect(report.relationships).toMatchObject({ total: 1, types: { 旧识: 1 } })
    expect(report.activity).toHaveLength(1)
    expect(report.warnings).toContainEqual(expect.stringContaining('书级大纲'))
    expect(report.warnings).toContainEqual(expect.stringContaining('世界观'))
    expect(report.warnings).toContainEqual(expect.stringContaining('平均分'))
  })

  it('handles an empty book without inventing values', () => {
    const report = buildBookReport(
      reportInput({
        chapters: [],
        characters: { schema_version: 1, characters: [] },
        reviews: [],
        foreshadows: { schema_version: 1, next_seq: 1, items: [] },
        relationships: { schema_version: 1, next_seq: 1, items: [] },
        timeline: { schema_version: 1, next_seq: 1, items: [] },
        targetChapters: null,
      }),
    )
    expect(report.progress).toMatchObject({ archived: 0, words: 0, percent: 0, remaining_words: null })
    expect(report.quality).toMatchObject({ average: 0, median: 0, min: 0, max: 0 })
    expect(report.pacing.longest).toBeNull()
    expect(report.pacing.shortest).toBeNull()
    expect(report.timeline).toMatchObject({ events: 0, first_chapter: null, last_chapter: null })
    expect(report.warnings).toContainEqual(expect.stringContaining('还没有已归档章节'))
  })

  it('reports outline drift and strict mode', () => {
    const outline = emptyOutline('2026-01-01')
    outline.book.strict = true
    outline.chapters.push({
      num: 1,
      volume: null,
      title: '不同标题',
      scene_type: '日常过渡章',
      goal: '目标',
      conflict: '冲突',
      hook: '钩子',
      cast: [],
      target_words: [80, 400],
      notes: '',
      status: 'archived',
      archived_at: '2026-01-01',
      word_count: 110,
      score: 100,
    })
    const report = buildBookReport(reportInput({ outline, outlinePresent: true, chapters: [record(1, 100)] }))
    expect(report.outline).toMatchObject({ present: true, strict: true, archived: 1, planned: 0 })
    expect(report.outline.drift).toEqual(
      expect.arrayContaining([expect.objectContaining({ chapter: 1, field: 'title' })]),
    )
    expect(report.warnings).toContainEqual(expect.stringContaining('漂移'))
  })
})

describe('book guide', () => {
  const guideInput = (patch: Partial<Parameters<typeof buildGuide>[0]> = {}) => ({
    projectPresent: true,
    chapter: 2,
    stage: 'P3' as const,
    archived: 1,
    target: 4,
    finished: false,
    outline: emptyOutline('2026-01-01'),
    outlinePresent: true,
    worldbook: emptyWorldbook('2026-01-01'),
    worldbookPresent: false,
    next: { tool: 'novel_write_draft', args: { chapter: 2 }, reason: '写' },
    blocking: 0,
    stateErrors: 0,
    ...patch,
  })

  it('reports a no-project guide with a usable init call', () => {
    const guide = buildGuide(guideInput({ projectPresent: false }))
    expect(guide.state).toBe('no-project')
    expect(guide.next).toMatchObject({
      tool: 'novel_init',
      args: expect.objectContaining({ title: expect.any(String) }),
    })
    expect(guide.steps.find((step) => step.id === 'init')?.done).toBe(false)
  })

  it('distinguishes new, planning, writing, blocked and finished states', () => {
    expect(buildGuide(guideInput({ archived: 0, chapter: 1, stage: 'idle' })).state).toBe('new')
    const blueprint = emptyOutline('2026-01-01')
    blueprint.book.logline = '已写梗概'
    expect(buildGuide(guideInput({ archived: 0, chapter: 1, stage: 'idle', outline: blueprint })).state).toBe(
      'planning',
    )
    expect(buildGuide(guideInput()).state).toBe('writing')
    expect(buildGuide(guideInput({ stateErrors: 1 })).state).toBe('blocked')
    expect(buildGuide(guideInput({ finished: true })).state).toBe('finished')
    expect(buildGuide(guideInput({ finished: true })).commands).toContain('/novel export epub')
  })
})

describe('outline summary', () => {
  it('derives coverage and presence from cards', () => {
    const outline = emptyOutline('2026-01-01')
    expect(outlineSummary(outline, 0)).toMatchObject({ present: false, total: 0, coverage: 0 })
    outline.chapters.push({
      num: 1,
      volume: null,
      title: '开端之雨',
      scene_type: '日常过渡章',
      goal: '收信',
      conflict: '拆不拆',
      hook: '日期',
      cast: [],
      target_words: [80, 400],
      notes: '',
      status: 'archived',
      archived_at: '2026-01-01',
      word_count: 100,
      score: 130,
    })
    expect(outlineSummary(outline, 1)).toMatchObject({ present: true, total: 1, archived: 1, coverage: 1 })
  })
})

describe('insight edge branches', () => {
  const guide = (patch: Partial<Parameters<typeof buildGuide>[0]> = {}) =>
    buildGuide({
      projectPresent: true,
      chapter: 2,
      stage: 'P3',
      archived: 1,
      target: 4,
      finished: false,
      outline: emptyOutline('2026-01-01'),
      outlinePresent: true,
      worldbook: emptyWorldbook('2026-01-01'),
      worldbookPresent: false,
      next: { tool: 'novel_write_draft', args: { chapter: 2 }, reason: '写' },
      blocking: 0,
      stateErrors: 0,
      ...patch,
    })

  it('scores dimensions and reports partial worldbooks and blocking guides', () => {
    const reviewDoc = review(1, 100)
    expect(scoreOf(reviewDoc)).toBe(20)
    const outline = emptyOutline('2026-01-01')
    outline.book.themes = ['记忆']
    const worldbook = emptyWorldbook('2026-01-01')
    worldbook.factions = [{ name: '巡夜司', description: '维持秩序', goal: '稳定' }]
    const report = buildBookReport(
      reportInput({ outline, outlinePresent: true, worldbook, worldbookPresent: true }),
    )
    expect(report.outline.present).toBe(true)
    expect(report.worldbook).toMatchObject({ present: true, factions: 1 })
    expect(report.warnings).not.toContainEqual(expect.stringContaining('还没有世界观'))
    expect(guide({ blocking: 1 }).state).toBe('blocked')
    const worldbookOnly = guide({
      archived: 0,
      chapter: 1,
      stage: 'idle',
      worldbook,
      worldbookPresent: true,
    })
    expect(worldbookOnly.state).toBe('planning')
  })

  it('searches worldbook, locks and handoff ledgers', () => {
    const worldbook = emptyWorldbook('2026-01-01')
    worldbook.rules = [{ name: '灵气不能离体', description: '离体即溃散' }]
    worldbook.factions = [{ name: '巡夜司', description: '维持秩序', goal: '稳定' }]
    worldbook.locations = [{ name: '旧城区', description: '被遗忘', layout: '窄巷', capacity: 10 }]
    worldbook.characters = [{ name: '陈默', role: '主角', description: '档案员', arc: '入局' }]
    worldbook.glossary = [{ term: '蜡印', definition: '封缄' }]
    worldbook.backstory = [{ time: '十年前', event: '旧案' }]
    const world: WorldDocument = {
      schema_version: 1,
      locations: [],
      abilities: [],
      artifacts: [],
      factions: [{ name: '巡夜司' }],
      rules: [],
    }
    const locks: LocksDocument = {
      schema_version: 1,
      locked_at_chapter: 1,
      characters: { 他: { first_appearance: 1, locked_at: 1, appearance: '旧大衣' } },
      locations: {},
    }
    const handoff: HandoffDocument = {
      schema_version: 1,
      current_chapter: 1,
      volume: 1,
      volume_name: '第一卷',
      act: '第一幕',
      act_progress: '1/1',
      next_chapter: 2,
      last_summary: '他走进旧城',
      open_hooks: [{ id: 'FS-001', title: '旧信' }],
      updated_at: '2026-01-01',
    }
    const input = {
      query: '旧',
      scope: 'ledgers' as const,
      limit: 10,
      chapterTexts: new Map<number, string>(),
      chapters: [record(1, 100)],
      outline: emptyOutline('2026-01-01'),
      worldbook,
      characters,
      world,
      timeline,
      foreshadows,
      relationships,
      locks,
      handoff,
    }
    const result = searchSnapshot(input)
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'ledgers', title: '他' }),
        expect.objectContaining({ kind: 'ledgers', title: 'handoff' }),
      ]),
    )
    const worldbookResult = searchSnapshot({ ...input, query: '灵气', scope: 'worldbook' })
    expect(worldbookResult.results[0]).toMatchObject({ kind: 'worldbook', title: '灵气不能离体' })
  })

  it('covers search scopes, truncation and tolerant score dimensions', () => {
    expect(
      scoreOf({
        ...review(1, 100),
        dimensions: [{ id: 'x', max: 10 } as never],
      }),
    ).toBe(10)
    const tolerant = buildBookReport(
      reportInput({
        reviews: [
          {
            ...review(1, 100),
            dimensions: [
              { id: 'x', max: 10, deductions: [] },
              { id: 'y', max: undefined, deductions: [] } as never,
            ],
          },
        ],
      }),
    )
    expect(tolerant.quality.dimensions).toContainEqual(expect.objectContaining({ id: 'x', samples: 1 }))
    const strictOutline = emptyOutline('2026-01-01')
    strictOutline.book.strict = true
    expect(guide({ outline: strictOutline, outlinePresent: true }).tips[0]).toContain('严格模式')
    const outline = emptyOutline('2026-01-01')
    outline.chapters = [
      {
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
      },
    ]
    const input = {
      query: '收信',
      scope: 'all' as const,
      limit: 1,
      chapterTexts: new Map([[1, '他收到一封信。收信之后他沉默了。']]),
      chapters: [record(1, 100)],
      outline,
      worldbook: emptyWorldbook('2026-01-01'),
      characters,
      world: {
        schema_version: 1 as const,
        locations: [],
        abilities: [],
        artifacts: [],
        factions: [],
        rules: [],
      },
      timeline,
      foreshadows,
      relationships,
      locks: {
        schema_version: 1 as const,
        locked_at_chapter: 1,
        characters: {},
        locations: {},
      },
      handoff: null,
    }
    const all = searchSnapshot(input)
    expect(all.results).toHaveLength(1)
    expect(all.truncated).toBe(true)
    expect(searchSnapshot({ ...input, scope: 'summaries', query: '事件1' }).total).toBe(1)
    expect(searchSnapshot({ ...input, scope: 'outline' }).results[0]).toMatchObject({ kind: 'outline' })
    expect(() => searchSnapshot({ ...input, query: '   ' })).toThrow('search query must not be empty')
    const report = buildBookReport(reportInput({ targetChapters: 1 }))
    expect(report.warnings).toContainEqual(expect.stringContaining('超过目标'))
  })
})
