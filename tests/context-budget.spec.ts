import { describe, expect, it } from 'vitest'
import { briefContext, type BriefContextInput } from '../src/engine/context.js'
import { emptyPipeline } from '../src/engine/state.js'
import type { ChapterRecord, ChapterSummary, ReviewDocument, CheckDocument } from '../src/types.js'

const summary = (index: number): ChapterSummary => ({
  events: [`事件 ${index}`],
  characters_appeared: [`角色${index}`],
  foreshadows: { planted: [], advanced: [], resolved: [] },
  new_elements: { locations: [], abilities: [], artifacts: [] },
  resource_changes: [],
  opening: `开头 ${index} 足够长`,
  continuity: { opens_from: '上一章', ends_with: `结尾 ${index}` },
  hook_strength: 3,
  pleasure_points: ['线索'],
  plot_advancement: 'mid',
})

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
  summary: summary(num),
})

const review: ReviewDocument = {
  schema_version: 1,
  chapter: 100,
  round: 1,
  content_hash: 'h',
  dimensions: [{ id: 'R-W-01', max: 15, deductions: [] }],
  issues: [],
  total: 150,
}

const check: CheckDocument = {
  schema_version: 1,
  chapter: 100,
  scope: ['content', 'integrity'],
  content_hash: 'h',
  machine: { violations: [], metrics: {} as never },
  semantic: { items: [] },
  verdict: 'pass',
}

const largeInput = (): BriefContextInput => ({
  stage: 'P6',
  chapter: 100,
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
  pipeline: emptyPipeline({ revision: 1, chapter: 100, stage: 'P6' }),
  chapters: { schema_version: 1, chapters: Array.from({ length: 100 }, (_, index) => record(index + 1)) },
  characters: {
    schema_version: 1,
    characters: Array.from({ length: 100 }, (_, index) => ({
      name: `角色${index + 1}`,
      role: 'supporting',
      first_appearance: index + 1,
      profile: { bio: `人物小传 ${index + 1}`.repeat(8) },
      current_state: { mood: '平静' },
      growth: [],
      updated_at: index,
    })),
  },
  world: {
    schema_version: 1,
    locations: Array.from({ length: 100 }, (_, index) => ({
      name: `地点${index + 1}`,
      first_appearance: index + 1,
      locked: false,
      description: `地点描述 ${index + 1}`.repeat(5),
      layout: '三排工位',
      capacity: 30,
      changes: [],
    })),
    abilities: Array.from({ length: 100 }, (_, index) => ({ name: `能力${index + 1}` })),
    artifacts: [],
    factions: [],
    rules: [],
  },
  locks: {
    schema_version: 1,
    locked_at_chapter: 100,
    characters: Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `角色${index + 1}`,
        { first_appearance: index + 1, locked_at: index + 1, appearance: `外貌 ${index + 1}` },
      ]),
    ),
    locations: Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `地点${index + 1}`,
        { first_appearance: index + 1, locked_at: index + 1, layout: '三排工位', capacity: 30 },
      ]),
    ),
  },
  foreshadows: {
    schema_version: 1,
    next_seq: 101,
    items: Array.from({ length: 100 }, (_, index) => ({
      id: `FS-${String(index + 1).padStart(3, '0')}`,
      title: `伏笔${index + 1}`,
      planted: index + 1,
      last_touched: index + 1,
      status: 'planted' as const,
      resolved_at: null,
      description: `伏笔描述 ${index + 1}`,
      advance_log: [],
    })),
  },
  timeline: {
    schema_version: 1,
    next_seq: 101,
    items: Array.from({ length: 100 }, (_, index) => ({
      id: `TE-${String(index + 1).padStart(3, '0')}`,
      chapter: index + 1,
      story_time: `Day ${index + 1}`,
      description: `事件 ${index + 1}`,
      location: `地点${index + 1}`,
      characters: [`角色${index + 1}`],
    })),
  },
  relationships: {
    schema_version: 1,
    next_seq: 101,
    items: Array.from({ length: 100 }, (_, index) => ({
      id: `RL-${String(index + 1).padStart(3, '0')}`,
      a: `角色${index + 1}`,
      b: `角色${((index + 1) % 100) + 1}`,
      type: '同僚',
      since: index + 1,
      description: `关系 ${index + 1}`,
      evolution: [],
    })),
  },
  plan: {
    chapter: 100,
    title: '终局之雨',
    scene_type: '情感爆发章',
    narrator: '他',
    beats: ['起', '承', '转', '合', '收'],
    opening: '风从窗缝里挤进来',
    ending: '蜡印',
    target_words: [2000, 3000],
    summary: summary(100),
  },
  review,
  check,
  text: `正文${'雨'.repeat(400)}`,
  machine: { violations: [], metrics: {} },
  previousText: `上一章结尾${'风'.repeat(100)}`,
  handoff: null,
})

describe('0.1.2 context budget', () => {
  it('adds context_meta and keeps a small project intact', () => {
    const input = largeInput()
    input.characters.characters = input.characters.characters.slice(0, 2)
    input.world.locations = input.world.locations.slice(0, 2)
    input.foreshadows.items = input.foreshadows.items.slice(0, 2)
    input.timeline.items = input.timeline.items.slice(0, 2)
    input.relationships.items = input.relationships.items.slice(0, 2)
    input.locks.characters = { 角色1: input.locks.characters['角色1']! }
    input.locks.locations = { 地点1: input.locks.locations['地点1']! }
    const context = briefContext(input)
    const meta = context.context_meta as {
      budget: number
      used: number
      over_budget: boolean
      truncated: string[]
      omitted: Record<string, number>
    }
    expect(meta.budget).toBe(32_000)
    expect(meta.used).toBeLessThanOrEqual(meta.budget)
    expect(meta.over_budget).toBe(false)
    expect(meta.truncated).toEqual([])
    expect(meta.omitted).toEqual({})
    expect(context.text).toBe(input.text)
    expect(context.plan).toEqual(input.plan)
  })

  it('trims optional ledgers before a 100-chapter P6 brief can overflow', () => {
    const context = briefContext(largeInput())
    const meta = context.context_meta as {
      budget: number
      used: number
      over_budget: boolean
      truncated: string[]
      omitted: Record<string, number>
    }
    expect(meta.used).toBeLessThanOrEqual(meta.budget)
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(meta.budget)
    expect(meta.over_budget).toBe(false)
    expect(meta.truncated).toEqual(expect.arrayContaining(['characters', 'foreshadows']))
    expect(meta.omitted.characters).toBeGreaterThan(0)
    expect(meta.omitted.foreshadows).toBeGreaterThan(0)
    expect(context.text).toBe(largeInput().text)
    expect(context.plan).toEqual(largeInput().plan)
    expect(context.review).toEqual(review)
    expect(context.check).toEqual(check)
  })

  it('keeps every stage inside its own budget', () => {
    for (const stage of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P8']) {
      const context = briefContext({ ...largeInput(), stage })
      const meta = context.context_meta as { stage: string; budget: number }
      expect(meta.stage).toBe(stage)
      expect(JSON.stringify(context).length).toBeLessThanOrEqual(meta.budget)
    }
  })

  it('reports over_budget instead of truncating protected manuscript text', () => {
    const input = largeInput()
    input.text = `正文${'雨'.repeat(40_000)}`
    const context = briefContext(input)
    const meta = context.context_meta as { over_budget: boolean; used: number; budget: number }
    expect(meta.over_budget).toBe(true)
    expect(meta.used).toBeGreaterThan(meta.budget)
    expect(context.text).toBe(input.text)
  })

  it('is deterministic for equal input', () => {
    const first = JSON.stringify(briefContext(largeInput()))
    const second = JSON.stringify(briefContext(largeInput()))
    expect(second).toBe(first)
  })

  it('sorts equal-priority ledgers by stable key so input order cannot change the pack', () => {
    const input = largeInput()
    const character = (name: string) => ({
      name,
      role: 'supporting',
      first_appearance: 1,
      profile: { bio: '同分角色' },
      current_state: { mood: '平静' },
      growth: [],
      updated_at: 1,
    })
    input.text = '正文甲和乙'
    input.characters.characters = [character('乙'), character('甲')]
    input.world.locations = []
    input.world.abilities = []
    input.world.artifacts = []
    input.world.factions = []
    input.world.rules = []
    input.locks.characters = {
      乙: { first_appearance: 1, locked_at: 1, appearance: '乙的外貌' },
      甲: { first_appearance: 1, locked_at: 1, appearance: '甲的外貌' },
    }
    input.locks.locations = {}
    input.foreshadows.items = []
    input.timeline.items = []
    input.relationships.items = []
    const normal = briefContext(input)

    const reversed = structuredClone(input)
    reversed.characters.characters.reverse()
    reversed.locks.characters = Object.fromEntries(Object.entries(reversed.locks.characters).reverse())

    expect(briefContext(reversed)).toEqual(normal)
  })

  it('keeps every planned actor in the P3/P4 cast even when 120 characters exist', () => {
    const input = largeInput()
    input.stage = 'P3'
    input.characters.characters = Array.from({ length: 120 }, (_, index) => ({
      name: `角色${index + 1}`,
      role: 'supporting',
      first_appearance: index + 1,
      profile: { bio: `人物小传 ${index + 1}`.repeat(12) },
      current_state: { mood: '平静' },
      growth: [],
      updated_at: index + 1,
    }))
    input.plan = {
      ...input.plan!,
      cast: Array.from({ length: 8 }, (_, index) => ({
        name: `角色${index + 1}`,
        goal: `目标 ${index + 1}`,
        entry_state: '登场',
        knowledge: ['知道来信'],
        exit_change: '决定赴约',
      })),
    }
    const context = briefContext(input)
    const meta = context.context_meta as { budget: number; used: number }
    expect(meta.used).toBeLessThanOrEqual(meta.budget)
    const cast = context.characters as Array<{ name: string; goal?: string }>
    expect(cast.map((character) => character.name)).toEqual([
      ...Array.from({ length: 8 }, (_, index) => `角色${index + 1}`),
      '角色100',
    ])
    expect(cast.slice(0, 8).every((character) => character.goal !== undefined)).toBe(true)
    expect(cast.at(-1)).toMatchObject({ name: '角色100', role: 'supporting' })
  })

  it('delivers the P1 world plan to P2 and preserves the active cast at P6', () => {
    const input = largeInput()
    input.stage = 'P2'
    input.plan = null
    input.worldPlan = {
      chapter: 100,
      objective: '让主角在雨夜找到旧信',
      constraints: ['没有超能力'],
      characters: [
        { name: '角色1', role: '主角', current_state: '警惕' },
        { name: '角色2', role: '同伴', current_state: '受伤' },
      ],
      locations: [{ name: '旧楼', layout: '一层两户', capacity: 20 }],
      continuity_notes: ['雨夜'],
    }
    const p2 = briefContext(input)
    expect((p2.world_plan as { objective: string }).objective).toContain('旧信')
    expect((p2.characters as Array<{ name: string }>).map((row) => row.name)).toEqual(['角色1', '角色2'])

    const p6 = briefContext({
      ...input,
      stage: 'P6',
      plan: {
        ...largeInput().plan!,
        cast: [
          { name: '角色9', goal: '找到出口' },
          { name: '角色10', goal: '守住门' },
        ],
      },
    })
    expect((p6.context_meta as { used: number }).used).toBeLessThanOrEqual(32_000)
    // The plan cast plus the characters the summary says appeared are all active.
    expect((p6.active_cast as Array<{ name: string }>).map((row) => row.name)).toEqual([
      '角色9',
      '角色10',
      '角色100',
    ])
    expect(p6.world_plan).toMatchObject({ objective: expect.stringContaining('旧信') })
  })

  it('orders non-cast characters by last seen, not first appearance', () => {
    const input = largeInput()
    input.stage = 'P3'
    input.plan = {
      ...input.plan!,
      cast: [{ name: '角色1', goal: '留在舞台中央' }],
    }
    input.characters.characters = [
      { ...input.characters.characters[0]!, name: '角色1', updated_at: 1 },
      { ...input.characters.characters[1]!, name: '角色2', first_appearance: 1, updated_at: 90 },
      { ...input.characters.characters[2]!, name: '角色3', first_appearance: 80, updated_at: 2 },
    ]
    input.chapters.chapters = []
    input.world.locations = []
    input.world.abilities = []
    input.world.artifacts = []
    input.world.factions = []
    input.world.rules = []
    input.foreshadows.items = []
    input.timeline.items = []
    input.relationships.items = []
    input.locks.characters = {}
    input.locks.locations = {}
    const context = briefContext(input)
    expect((context.other_characters as Array<{ name: string }>).map((row) => row.name)).toEqual([
      '角色2',
      '角色3',
    ])
  })

  it('does not throw on empty ledgers or partial optional rows at any stage', () => {
    const input = largeInput()
    input.chapters.chapters = []
    input.characters.characters = [{ name: '他' } as never]
    input.world = {
      schema_version: 1,
      locations: [],
      abilities: [{} as never],
      artifacts: [],
      factions: [],
      rules: [],
    }
    input.locks = { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} }
    input.foreshadows = { schema_version: 1, next_seq: 1, items: [{} as never] }
    input.timeline = { schema_version: 1, next_seq: 1, items: [{} as never] }
    input.relationships = { schema_version: 1, next_seq: 1, items: [{} as never] }
    input.plan = null
    input.review = null
    input.check = null
    input.text = null
    input.previousText = null
    input.handoff = null
    input.worldPlan = null
    for (const stage of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P8']) {
      const context = briefContext({ ...input, stage })
      expect((context.context_meta as { stage: string }).stage).toBe(stage)
    }
  })

  it('keeps a 300-chapter index from turning the P6 brief into a full-book payload', () => {
    const input = largeInput()
    input.chapters.chapters = Array.from({ length: 300 }, (_, index) => record(index + 1))
    const context = briefContext(input)
    const meta = context.context_meta as { budget: number; used: number; truncated: string[] }
    expect(meta.used).toBeLessThanOrEqual(meta.budget)
    expect(meta.truncated).toEqual(expect.arrayContaining(['characters']))
    expect((context.score_history as unknown[]).length).toBeLessThanOrEqual(5)
  })

  it('does not activate a shorter ledger name when only a longer name is mentioned', () => {
    const input = largeInput()
    input.stage = 'P3'
    input.plan = null
    input.chapters.chapters = []
    input.world = { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] }
    input.locks = { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} }
    input.foreshadows.items = []
    input.timeline.items = []
    input.relationships.items = []
    input.characters.characters = [
      {
        name: '阿',
        role: 'supporting',
        first_appearance: 1,
        profile: {},
        current_state: {},
        growth: [],
        updated_at: 1,
      },
      {
        name: '阿甲',
        role: 'supporting',
        first_appearance: 1,
        profile: {},
        current_state: {},
        growth: [],
        updated_at: 2,
      },
    ]
    input.text = '阿甲推门进来。'
    const context = briefContext(input)
    expect((context.characters as Array<{ name: string }>).map((row) => row.name)).toEqual(['阿甲'])
  })

  it('orders the fallback active cast by recency', () => {
    const input = largeInput()
    input.stage = 'P3'
    input.plan = null
    input.chapters.chapters = []
    input.world = { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] }
    input.locks = { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} }
    input.foreshadows.items = []
    input.timeline.items = []
    input.relationships.items = []
    input.characters.characters = Array.from({ length: 10 }, (_, index) => ({
      name: index === 0 ? '阿甲' : `角色${index + 1}`,
      role: 'supporting',
      first_appearance: 1,
      profile: { bio: `人物 ${index + 1}` },
      current_state: { mood: '平静' },
      growth: [],
      updated_at: index + 1,
    }))
    input.text = `阿甲和${input.characters.characters
      .slice(1)
      .map((character) => character.name)
      .join('、')}都在场。`
    const context = briefContext(input)
    expect((context.characters as Array<{ name: string }>).map((row) => row.name)).toEqual([
      '角色10',
      '角色9',
      '角色8',
      '角色7',
      '角色6',
      '角色5',
      '角色4',
      '角色3',
    ])
  })

  it('keeps independent shorter names when a longer name also appears', () => {
    const input = largeInput()
    input.stage = 'P3'
    input.plan = null
    input.chapters.chapters = []
    input.world = { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] }
    input.locks = { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} }
    input.foreshadows.items = []
    input.timeline.items = []
    input.relationships.items = []
    input.characters.characters = [
      {
        name: '阿',
        role: 'supporting',
        first_appearance: 1,
        profile: {},
        current_state: {},
        growth: [],
        updated_at: 1,
      },
      {
        name: '阿甲',
        role: 'supporting',
        first_appearance: 1,
        profile: {},
        current_state: {},
        growth: [],
        updated_at: 2,
      },
      {
        name: '角色1',
        role: 'supporting',
        first_appearance: 1,
        profile: {},
        current_state: {},
        growth: [],
        updated_at: 100,
      },
      {
        name: '角色10',
        role: 'supporting',
        first_appearance: 1,
        profile: {},
        current_state: {},
        growth: [],
        updated_at: 3,
      },
    ]
    input.text = '阿甲提起角色1，又在门口遇见角色10。'
    const context = briefContext(input)
    expect((context.characters as Array<{ name: string }>).map((row) => row.name)).toEqual([
      '角色1',
      '角色10',
      '阿甲',
      // "阿" only occurs inside "阿甲"; it must not be promoted separately.
    ])
  })

  it('adds a manuscript-mentioned actor to an explicit cast after a revision', () => {
    const input = largeInput()
    input.stage = 'P5'
    input.plan = {
      ...input.plan!,
      cast: [{ name: '角色1', goal: '守住门' }],
      summary: summary(100),
    }
    input.plan.summary!.characters_appeared = ['角色1']
    input.characters.characters = [
      {
        name: '角色1',
        role: 'supporting',
        first_appearance: 1,
        profile: { bio: '角色1' },
        current_state: {},
        growth: [],
        updated_at: 1,
      },
      {
        name: '角色2',
        role: 'supporting',
        first_appearance: 1,
        profile: { bio: '角色2' },
        current_state: {},
        growth: [],
        updated_at: 2,
      },
    ]
    input.text = '角色1回头时，角色2已经站在门外。'
    input.chapters.chapters = []
    input.world = { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] }
    input.locks = { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} }
    input.foreshadows.items = []
    input.timeline.items = []
    input.relationships.items = []
    const context = briefContext(input)
    expect((context.characters as Array<{ name: string }>).map((row) => row.name)).toEqual(['角色1', '角色2'])
  })

  it('keeps a summary-only ninth actor as a full active card', () => {
    const input = largeInput()
    input.stage = 'P4'
    input.plan = {
      ...input.plan!,
      cast: Array.from({ length: 8 }, (_, index) => ({ name: `角色${index + 1}`, goal: '在场' })),
      summary: summary(100),
    }
    input.characters.characters = Array.from({ length: 20 }, (_, index) => ({
      name: `角色${index + 1}`,
      role: 'supporting',
      first_appearance: index + 1,
      profile: { bio: '人物' },
      current_state: { mood: '平静' },
      growth: [],
      updated_at: index + 1,
    }))
    input.plan.summary!.characters_appeared = ['角色1', '角色9']
    input.chapters.chapters = []
    input.world = { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] }
    input.locks = { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} }
    input.foreshadows.items = []
    input.timeline.items = []
    input.relationships.items = []
    const context = briefContext(input)
    expect((context.characters as Array<{ name: string }>).map((row) => row.name)).toEqual([
      ...Array.from({ length: 8 }, (_, index) => `角色${index + 1}`),
      '角色9',
    ])
  })
})
