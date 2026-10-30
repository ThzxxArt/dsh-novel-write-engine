import { describe, expect, it } from 'vitest'
import { applyStateDelta, type DeltaInput } from '../src/engine/state-delta.js'
import { sampleSummary } from './helpers.js'
import type { ChapterSummary } from '../src/types.js'

const base = (): Record<string, unknown> => ({
  characters: { schema_version: 1, characters: [] },
  world: {
    schema_version: 1,
    locations: [],
    abilities: [],
    artifacts: [],
    factions: [],
    rules: [],
  },
  locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
  foreshadows: { schema_version: 1, next_seq: 1, items: [] },
  timeline: { schema_version: 1, next_seq: 1, items: [] },
  relationships: { schema_version: 1, next_seq: 1, items: [] },
})

const empty = (): Record<string, Record<string, unknown>> => ({
  characters: {},
  world: {},
  foreshadows: {},
  timeline: {},
  relationships: {},
})

const run = (
  summary: ChapterSummary,
  delta: Record<string, unknown>,
  docs: Record<string, unknown> = base(),
  chapter = 1,
): ReturnType<typeof applyStateDelta> =>
  applyStateDelta({
    chapter,
    text: '甲和乙站在屋前，术法还没散。风从窗缝里挤进来。他伸手压住。t',
    summary,
    delta: delta as never,
    ...(docs as Omit<DeltaInput, 'chapter' | 'text' | 'summary' | 'delta'>),
  })

const fails = (summary: ChapterSummary, delta: Record<string, unknown>, docs = base()): void => {
  expect(() => run(summary, delta, docs)).toThrowError(
    expect.objectContaining({ code: 'ENGINE_DELTA_UNVERIFIED' }),
  )
}

const character = (name: string, patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: 'created',
  role: 'supporting',
  ...patch,
  name,
})

describe('state_delta shape and character reconciliation', () => {
  it('accepts the plan narrator alias for a first-person manuscript', () => {
    const summary = sampleSummary({ characters_appeared: ['陈默'], events: [] })
    const delta = empty()
    delta.characters['陈默'] = character('陈默')
    const result = applyStateDelta({
      chapter: 1,
      text: '我站在雨里，手里捏着一封旧信。',
      summary,
      delta: delta as never,
      narrator: '陈默（第一人称「我」）',
      ...(base() as Omit<DeltaInput, 'chapter' | 'text' | 'summary' | 'delta'>),
    })
    expect(result.locks.characters['陈默']!.appearance).toContain('我站在雨里')
  })

  it('requires all five sections and valid actions', () => {
    expect(() => run(sampleSummary(), {})).toThrowError(/missing section/)
    const unknownSection = { ...empty(), extra: {} }
    expect(() => run(sampleSummary(), unknownSection)).toThrowError(/unknown section/)
    const noAction = empty()
    noAction.characters['他'] = { action: 'maybe' }
    expect(() => run(sampleSummary(), noAction)).toThrowError(/created\|updated\|no_change/)
    const noReason = empty()
    noReason.characters['他'] = { action: 'no_change' }
    expect(() => run(sampleSummary(), noReason)).toThrowError(/no reason/)
  })

  it('refuses undeclared, duplicate, and unknown characters', () => {
    fails(sampleSummary({ characters_appeared: ['甲', '乙'] }), empty())
    const notAppeared = empty()
    notAppeared.characters['甲'] = character('甲')
    fails(sampleSummary({ characters_appeared: [] }), notAppeared)
    const docs = base() as { characters: { characters: Array<Record<string, unknown>> } }
    docs.characters.characters.push({ name: '甲', role: 'extra' })
    const duplicate = empty()
    duplicate.characters['甲'] = character('甲')
    fails(sampleSummary({ characters_appeared: ['甲'] }), duplicate, docs)
    const updated = empty()
    updated.characters['甲'] = { action: 'updated' }
    fails(sampleSummary({ characters_appeared: [] }), updated)
  })

  it('applies created/updated/no_change and accumulates resources', () => {
    const summary = sampleSummary({
      characters_appeared: ['甲'],
      resource_changes: [{ character: '甲', resource: '钱', delta: -2, reason: '买' }],
    })
    const delta = empty()
    delta.characters['甲'] = character('甲', {
      role: 'protagonist',
      profile: { identity: 'A' },
      current_state: { emotion: '平静', resources: { 钱: 10 } },
    })
    delta.timeline['0'] = { action: 'created' }
    const first = run(summary, delta)
    expect(first.characters.characters[0]).toMatchObject({
      name: '甲',
      first_appearance: 1,
      current_state: { resources: { 钱: 8 } },
    })
    expect(Object.keys(first.locks.characters)).toContain('甲')
    const secondSummary = sampleSummary({
      characters_appeared: ['甲'],
      events: ['第二天'],
    })
    const secondDelta = empty()
    secondDelta.characters['甲'] = {
      action: 'updated',
      growth: { chapter: 99, change: '成长', status_change: 'S' },
    }
    secondDelta.timeline['0'] = { action: 'created' }
    const second = run(secondSummary, secondDelta, first as unknown as Record<string, unknown>, 2)
    expect(second.characters.characters[0]!.growth[0]).toMatchObject({ chapter: 2, change: '成长' })
    expect(second.characters.characters[0]!.updated_at).toBe(2)
  })

  it('rejects malformed nested character and resource fields', () => {
    const summary = sampleSummary({ characters_appeared: ['甲'] })
    const badProfile = empty()
    badProfile.characters['甲'] = character('甲', { profile: 'not-an-object' })
    fails(summary, badProfile)
    const badGrowth = empty()
    badGrowth.characters['甲'] = character('甲', { growth: 'not-an-object' })
    fails(summary, badGrowth)
    const badResourceSummary = sampleSummary({
      characters_appeared: ['甲'],
      resource_changes: [{ character: '甲', resource: '钱', delta: 1, reason: '' }],
    })
    const badResource = empty()
    badResource.characters['甲'] = character('甲')
    fails(badResourceSummary, badResource)
    const badWorld = empty()
    badWorld.world['屋'] = { action: 'created', kind: 'location', capacity: -1 }
    fails(
      sampleSummary({
        characters_appeared: [],
        new_elements: { locations: ['屋'], abilities: [], artifacts: [] },
      }),
      badWorld,
    )
  })

  it('refuses a resource change that would leave a negative balance', () => {
    const summary = sampleSummary({
      characters_appeared: ['甲'],
      resource_changes: [{ character: '甲', resource: '钱', delta: -2, reason: '买' }],
    })
    const delta = empty()
    delta.characters['甲'] = character('甲')
    delta.timeline['0'] = { action: 'created' }
    expect(() => run(summary, delta)).toThrowError(
      expect.objectContaining({ code: 'ENGINE_RESOURCE_NEGATIVE_BALANCE' }),
    )
  })
})

describe('state_delta world and timeline reconciliation', () => {
  it('requires every new world element to be declared with the right kind', () => {
    const summary = sampleSummary({
      characters_appeared: [],
      new_elements: { locations: ['屋'], abilities: ['术'], artifacts: [] },
    })
    fails(summary, empty())
    const wrongKind = empty()
    wrongKind.world['屋'] = { action: 'created', kind: 'ability' }
    fails(summary, wrongKind)
    const noKind = empty()
    noKind.world['术'] = { action: 'created' }
    fails(summary, noKind)
    const existing = base() as { world: { locations: Array<Record<string, unknown>> } }
    existing.world.locations.push({ name: '屋' })
    const duplicate = empty()
    duplicate.world['屋'] = { action: 'created', kind: 'location' }
    fails(summary, duplicate, existing)
    const updated = empty()
    updated.world['未知'] = { action: 'updated' }
    fails(sampleSummary({ characters_appeared: [] }), updated)
  })

  it('refuses a created world entity that is absent from the manuscript or summary', () => {
    const emptyElements = sampleSummary({
      characters_appeared: [],
      new_elements: { locations: [], abilities: [], artifacts: [] },
    })
    const ghost = empty()
    ghost.world['幽灵城'] = { action: 'created', kind: 'location' }
    expect(() => run(emptyElements, ghost)).toThrowError(
      expect.objectContaining({ code: 'ENGINE_DELTA_UNVERIFIED' }),
    )
    const unannounced = empty()
    unannounced.world['屋'] = { action: 'created', kind: 'location' }
    expect(() => run(emptyElements, unannounced)).toThrowError(
      expect.objectContaining({ code: 'ENGINE_DELTA_UNVERIFIED' }),
    )
  })

  it('checks both the summary and declared foreshadow titles', () => {
    const summary = sampleSummary({
      characters_appeared: [],
      events: [],
      foreshadows: {
        planted: [{ key: 'fs1', title: '并不存在的旧信', description: '旧信' }],
        advanced: [],
        resolved: [],
      },
    })
    const mismatch = empty()
    mismatch.foreshadows['fs1'] = { action: 'created', title: '风', description: '风' }
    fails(summary, mismatch)

    const nonString = sampleSummary({
      characters_appeared: [],
      events: [],
      foreshadows: {
        planted: [{ key: 'fs2', title: '风', description: '风' }],
        advanced: [],
        resolved: [],
      },
    })
    const badType = empty()
    badType.foreshadows['fs2'] = { action: 'created', title: 123, description: '风' }
    fails(nonString, badType)
  })

  it('rejects an unknown world kind and protects reserved fields from detail', () => {
    const unknown = sampleSummary({
      characters_appeared: [],
      events: [],
      new_elements: { locations: [], abilities: [], artifacts: [] },
    })
    const badKind = empty()
    badKind.world['风'] = { action: 'created', kind: 'potion' }
    fails(unknown, badKind)

    const summary = sampleSummary({
      characters_appeared: [],
      events: [],
      new_elements: { locations: [], abilities: ['术'], artifacts: [] },
    })
    const delta = empty()
    delta.world['术'] = { action: 'created', kind: 'ability', detail: { name: 123 } }
    const result = run(summary, delta)
    expect(result.world.abilities[0]).toMatchObject({ name: '术' })
  })

  it('refuses a next_seq that would reissue an existing id', () => {
    const docs = base() as {
      foreshadows: {
        schema_version: 1
        next_seq: number
        items: Array<Record<string, unknown>>
      }
    }
    docs.foreshadows = {
      schema_version: 1,
      next_seq: 1,
      items: [
        {
          id: 'FS-001',
          title: '旧信',
          planted: 1,
          last_touched: 1,
          status: 'planted',
          resolved_at: null,
          description: '旧信',
          advance_log: [],
        },
      ],
    }
    const summary = sampleSummary({
      characters_appeared: [],
      events: [],
      foreshadows: {
        planted: [{ key: 'fs2', title: '风', description: '风' }],
        advanced: [],
        resolved: [],
      },
    })
    const delta = empty()
    delta.foreshadows['fs2'] = { action: 'created', title: '风', description: '风' }
    fails(summary, delta, docs)
  })

  it('refuses to advance or resolve a foreshadow twice', () => {
    const docs = base() as {
      foreshadows: {
        schema_version: 1
        next_seq: number
        items: Array<Record<string, unknown>>
      }
    }
    docs.foreshadows = {
      schema_version: 1,
      next_seq: 2,
      items: [
        {
          id: 'FS-001',
          title: '旧信',
          planted: 1,
          last_touched: 1,
          status: 'resolved',
          resolved_at: 1,
          description: '旧信',
          advance_log: [],
        },
      ],
    }
    const advance = sampleSummary({
      characters_appeared: [],
      events: [],
      foreshadows: {
        planted: [],
        advanced: [{ key: 'FS-001', note: '旧线索', new_info: false }],
        resolved: [],
      },
    })
    const delta = empty()
    delta.foreshadows['FS-001'] = { action: 'updated', note: '旧线索', new_info: false }
    fails(advance, delta, docs)

    const resolve = sampleSummary({
      characters_appeared: [],
      events: [],
      foreshadows: { planted: [], advanced: [], resolved: ['FS-001'] },
    })
    const resolveDelta = empty()
    resolveDelta.foreshadows['FS-001'] = { action: 'updated', note: '再次解决', new_info: false }
    fails(resolve, resolveDelta, docs)
  })

  it('refuses a planted key that collides with an existing foreshadow id', () => {
    const docs = base() as {
      foreshadows: {
        schema_version: 1
        next_seq: number
        items: Array<Record<string, unknown>>
      }
    }
    docs.foreshadows = {
      schema_version: 1,
      next_seq: 2,
      items: [
        {
          id: 'FS-001',
          title: '旧信',
          planted: 1,
          last_touched: 1,
          status: 'planted',
          resolved_at: null,
          description: '旧信',
          advance_log: [],
        },
      ],
    }
    const summary = sampleSummary({
      characters_appeared: [],
      events: [],
      foreshadows: {
        planted: [{ key: 'FS-001', title: '风', description: '风' }],
        advanced: [],
        resolved: [],
      },
    })
    const delta = empty()
    delta.foreshadows['FS-001'] = { action: 'created', title: '风', description: '风' }
    fails(summary, delta, docs)
  })

  it('declares every event and refuses unknown timeline keys', () => {
    const summary = sampleSummary({ characters_appeared: [], events: ['一', '二'] })
    fails(summary, empty())
    const wrongAction = empty()
    wrongAction.timeline['0'] = { action: 'updated' }
    fails(summary, wrongAction)
    const extra = empty()
    extra.timeline['0'] = { action: 'created' }
    extra.timeline['9'] = { action: 'created' }
    fails(summary, extra)
    const unknownCharacter = empty()
    unknownCharacter.timeline['0'] = { action: 'created', characters: ['幽灵'] }
    fails(summary, unknownCharacter)
    const delta = empty()
    delta.timeline['0'] = { action: 'created', story_time: 'Day 1' }
    delta.timeline['1'] = { action: 'created', description: '二' }
    const result = run(summary, delta)
    expect(result.timeline.items.map((item) => item.id)).toEqual(['TE-001', 'TE-002'])
  })
})

describe('state_delta foreshadow and relationship reconciliation', () => {
  it('refuses unknown or misdeclared foreshadows without redirecting them', () => {
    const planted = sampleSummary({
      characters_appeared: [],
      foreshadows: {
        planted: [{ key: 'fs1', title: 't', description: 'd' }],
        advanced: [],
        resolved: [],
      },
    })
    fails(planted, empty())
    const wrongPlant = empty()
    wrongPlant.foreshadows['fs1'] = { action: 'updated' }
    fails(planted, wrongPlant)
    const unknownAdvance = sampleSummary({
      characters_appeared: [],
      foreshadows: { planted: [], advanced: [{ key: 'FS-999', note: 'n', new_info: true }], resolved: [] },
    })
    const advance = empty()
    advance.foreshadows['FS-999'] = { action: 'updated' }
    fails(unknownAdvance, advance)
    const unknownResolve = sampleSummary({
      characters_appeared: [],
      foreshadows: { planted: [], advanced: [], resolved: ['FS-999'] },
    })
    const resolved = empty()
    resolved.foreshadows['FS-999'] = { action: 'updated' }
    fails(unknownResolve, resolved)
    const extra = empty()
    extra.foreshadows['FS-999'] = { action: 'updated' }
    fails(sampleSummary({ characters_appeared: [] }), extra)
  })

  it('requires a newly planted foreshadow title to appear in the manuscript', () => {
    const summary = sampleSummary({
      characters_appeared: [],
      events: [],
      foreshadows: {
        planted: [{ key: 'fs1', title: '并不存在的旧信', description: 'd' }],
        advanced: [],
        resolved: [],
      },
    })
    const delta = empty()
    delta.foreshadows['fs1'] = {
      action: 'created',
      title: '并不存在的旧信',
      description: 'd',
    }
    fails(summary, delta)
    expect(() => run(summary, delta)).toThrowError(/foreshadow.*旧信|旧信.*manuscript/)
  })

  it('appends an explicit note update and refuses creating an existing key', () => {
    const plantSummary = sampleSummary({
      characters_appeared: [],
      events: [],
      foreshadows: { planted: [{ key: 'fs1', title: 't', description: 'd' }], advanced: [], resolved: [] },
    })
    const plantDelta = empty()
    plantDelta.foreshadows['fs1'] = { action: 'created', title: 't', description: 'd' }
    const first = run(plantSummary, plantDelta)

    const note = empty()
    note.foreshadows['FS-001'] = { action: 'updated', note: '补充线索', new_info: true }
    const second = run(
      sampleSummary({ characters_appeared: [], events: [] }),
      note,
      first as unknown as Record<string, unknown>,
      2,
    )
    expect(second.foreshadows.items[0]!.advance_log).toEqual([
      { chapter: 2, note: '补充线索', new_info: true },
    ])

    const duplicate = empty()
    duplicate.foreshadows['FS-001'] = { action: 'created' }
    fails(
      sampleSummary({ characters_appeared: [], events: [] }),
      duplicate,
      first as unknown as Record<string, unknown>,
    )
  })

  it('allocates foreshadow ids and resolves them later', () => {
    const plantSummary = sampleSummary({
      characters_appeared: [],
      foreshadows: { planted: [{ key: 'fs1', title: 't', description: 'd' }], advanced: [], resolved: [] },
    })
    const plantDelta = empty()
    plantDelta.foreshadows['fs1'] = { action: 'created', title: 't', description: 'd' }
    plantDelta.timeline['0'] = { action: 'created' }
    const first = run(plantSummary, plantDelta)
    expect(first.foreshadows.items[0]!.id).toBe('FS-001')
    const resolveSummary = sampleSummary({
      characters_appeared: [],
      foreshadows: { planted: [], advanced: [], resolved: ['FS-001'] },
    })
    const resolveDelta = empty()
    resolveDelta.foreshadows['FS-001'] = { action: 'updated' }
    resolveDelta.timeline['0'] = { action: 'created' }
    const second = run(resolveSummary, resolveDelta, first as unknown as Record<string, unknown>, 2)
    expect(second.foreshadows.items[0]).toMatchObject({ status: 'resolved', resolved_at: 2 })
    expect(second.foreshadows.items[0]!.advance_log).toEqual([
      { chapter: 2, note: 'resolved', new_info: true },
    ])
  })

  it('validates relationships against the character ledger', () => {
    const summary = sampleSummary({ characters_appeared: ['甲', '乙'], events: [] })
    const chars = empty()
    chars.characters['甲'] = character('甲')
    chars.characters['乙'] = character('乙')
    const badPair = { ...chars, relationships: { '甲|甲': { action: 'created', type: 'x' } } }
    fails(summary, badPair)
    const unknown = { ...chars, relationships: { '甲|丙': { action: 'created', type: 'x' } } }
    fails(summary, unknown)
    const missingType = { ...chars, relationships: { '甲|乙': { action: 'created' } } }
    fails(summary, missingType)
    const nonStringType = { ...chars, relationships: { '甲|乙': { action: 'created', type: 1 } } }
    fails(summary, nonStringType)
    const delta: Record<string, Record<string, unknown>> = {
      ...chars,
      relationships: { '甲|乙': { action: 'created', type: '同事' } },
    }
    const result = run(summary, delta)
    expect(result.relationships.items[0]).toMatchObject({ id: 'RL-001', a: '甲', b: '乙' })
  })

  it('updates a relationship and refuses an update before creation', () => {
    const docs = base() as {
      characters: { characters: Array<Record<string, unknown>> }
      relationships: { items: Array<Record<string, unknown>> }
    }
    docs.characters.characters.push({ name: '甲' }, { name: '乙' })
    const create = empty()
    create.relationships['甲|乙'] = { action: 'created', type: '朋友' }
    const first = run(
      sampleSummary({ events: [], characters_appeared: [] }),
      create,
      docs as unknown as Record<string, unknown>,
    )
    expect(first.relationships.items[0]).toMatchObject({ id: 'RL-001', type: '朋友' })

    const update = empty()
    update.relationships['甲|乙'] = {
      action: 'updated',
      type: '同事',
      description: '一起办案',
      note: '关系变化',
    }
    const second = run(
      sampleSummary({ events: [], characters_appeared: [] }),
      update,
      first as unknown as Record<string, unknown>,
      2,
    )
    expect(second.relationships.items[0]).toMatchObject({
      type: '同事',
      description: '一起办案',
      evolution: [{ chapter: 2, note: '关系变化' }],
    })

    const blankType = empty()
    blankType.relationships['甲|乙'] = { action: 'updated', type: '' }
    fails(
      sampleSummary({ events: [], characters_appeared: [] }),
      blankType,
      first as unknown as Record<string, unknown>,
    )

    const missing = empty()
    missing.relationships['甲|乙'] = { action: 'updated' }
    fails(sampleSummary({ events: [], characters_appeared: [] }), missing)
  })

  it('rejects malformed summary and delta containers before dereferencing them', () => {
    const noElements = sampleSummary() as unknown as Record<string, unknown>
    delete noElements.new_elements
    fails(noElements as never, empty())
    const badLocations = sampleSummary()
    badLocations.new_elements = { locations: 'x' as never, abilities: [], artifacts: [] }
    fails(badLocations, empty())
    const badResources = sampleSummary()
    badResources.resource_changes = 'x' as never
    fails(badResources, empty())
    const badEvents = sampleSummary()
    badEvents.events = 'x' as never
    fails(badEvents, empty())
    const badForeshadows = sampleSummary()
    badForeshadows.foreshadows = { planted: 'x' as never, advanced: [], resolved: [] }
    fails(badForeshadows, empty())
    const badDelta = empty()
    badDelta.characters['甲'] = null as never
    fails(sampleSummary({ characters_appeared: ['甲'] }), badDelta)
  })

  it('rejects malformed character and resource declarations', () => {
    const badProfile = empty()
    badProfile.characters['甲'] = character('甲', { profile: [] })
    fails(sampleSummary({ characters_appeared: ['甲'] }), badProfile)
    const badGrowth = empty()
    badGrowth.characters['甲'] = { action: 'updated', growth: 'x' }
    const docs = base() as { characters: { characters: Array<Record<string, unknown>> } }
    docs.characters.characters.push({ name: '甲', role: 'extra', updated_at: 1, growth: [] })
    fails(sampleSummary({ characters_appeared: ['甲'] }), badGrowth, docs)
    const badResource = sampleSummary({
      characters_appeared: ['甲'],
      resource_changes: [{ character: '', resource: '钱', delta: 1, reason: 'x' }],
    })
    const created = empty()
    created.characters['甲'] = character('甲')
    fails(badResource, created)
    const zero = sampleSummary({
      characters_appeared: ['甲'],
      resource_changes: [{ character: '甲', resource: '钱', delta: 0, reason: 'x' }],
    })
    fails(zero, created)
    const noChange = sampleSummary({
      characters_appeared: ['甲'],
      resource_changes: [{ character: '甲', resource: '钱', delta: 1, reason: 'x' }],
    })
    const noChangeDelta = empty()
    noChangeDelta.characters['甲'] = { action: 'no_change', reason: '没有变化' }
    fails(noChange, noChangeDelta, docs)
  })

  it('rejects malformed world declarations and applies a location update', () => {
    const summary = sampleSummary({
      characters_appeared: [],
      new_elements: { locations: ['屋'], abilities: [], artifacts: [] },
    })
    const wrongKind = empty()
    wrongKind.world['屋'] = { action: 'created', kind: 'ability' }
    fails(summary, wrongKind)
    const unknownKind = empty()
    unknownKind.world['屋'] = { action: 'created', kind: 'unknown' }
    fails(
      sampleSummary({
        characters_appeared: [],
        new_elements: { locations: [], abilities: [], artifacts: [] },
      }),
      unknownKind,
    )
    const notInText = empty()
    notInText.world['桥'] = { action: 'created', kind: 'location' }
    fails(summary, notInText)
    const emptyName = empty()
    emptyName.world[''] = { action: 'created', kind: 'location' }
    fails(summary, emptyName)
    const malformed = empty()
    malformed.world['屋'] = { action: 'created', kind: 'location', capacity: -1, detail: [] as never }
    fails(summary, malformed)

    const createdSummary = sampleSummary({
      characters_appeared: [],
      events: [],
      new_elements: { locations: ['屋'], abilities: [], artifacts: [] },
    })
    const first = run(
      createdSummary,
      (() => {
        const delta = empty()
        delta.world['屋'] = { action: 'created', kind: 'location', description: '旧屋', capacity: 3 }
        return delta
      })(),
    )
    const update = empty()
    update.world['屋'] = { action: 'updated', description: '新屋', layout: '院子', capacity: 5 }
    const updated = run(
      sampleSummary({ characters_appeared: [], events: [] }),
      update,
      first as unknown as Record<string, unknown>,
      2,
    )
    expect(updated.world.locations[0]).toMatchObject({
      description: '新屋',
      layout: '院子',
      capacity: 5,
    })
  })

  it('rejects malformed timeline keys and foreshadow transitions', () => {
    const missingTimeline = empty()
    fails(sampleSummary({ characters_appeared: [], events: ['事件'] }), missingTimeline)
    const wrongTimeline = empty()
    wrongTimeline.timeline['0'] = { action: 'updated' }
    fails(sampleSummary({ characters_appeared: [], events: ['事件'] }), wrongTimeline)
    const badKey = empty()
    badKey.timeline.extra = { action: 'created' }
    fails(sampleSummary({ characters_appeared: [], events: [] }), badKey)

    const emptyKey = empty()
    emptyKey.foreshadows[''] = { action: 'created' }
    fails(
      sampleSummary({
        characters_appeared: [],
        events: [],
        foreshadows: { planted: [{ key: '', title: '旧信', description: '' }], advanced: [], resolved: [] },
      }),
      emptyKey,
    )
    const missingForeshadow = empty()
    missingForeshadow.foreshadows['FS-001'] = { action: 'updated' }
    fails(
      sampleSummary({
        characters_appeared: [],
        events: [],
        foreshadows: { planted: [], advanced: [{ key: 'FS-999', note: 'x', new_info: true }], resolved: [] },
      }),
      missingForeshadow,
    )
    const resolvedMissing = empty()
    resolvedMissing.foreshadows['FS-001'] = { action: 'updated' }
    fails(
      sampleSummary({
        characters_appeared: [],
        events: [],
        foreshadows: { planted: [], advanced: [], resolved: ['FS-999'] },
      }),
      resolvedMissing,
    )
  })

  it('rejects malformed relationship declarations while accepting updates', () => {
    const missing = empty()
    missing.relationships['甲|甲'] = { action: 'created', type: '友' }
    fails(sampleSummary({ characters_appeared: [], events: [] }), missing)
    const unknown = empty()
    unknown.relationships['甲|乙'] = { action: 'created', type: '友' }
    fails(sampleSummary({ characters_appeared: [], events: [] }), unknown)
    const noType = empty()
    noType.relationships['甲|乙'] = { action: 'created' }
    fails(
      sampleSummary({ characters_appeared: ['甲', '乙'], events: [] }),
      noType,
      (() => {
        const docs = base() as { characters: { characters: Array<Record<string, unknown>> } }
        docs.characters.characters.push({ name: '甲', role: 'extra', updated_at: 1, growth: [] })
        docs.characters.characters.push({ name: '乙', role: 'extra', updated_at: 1, growth: [] })
        return docs
      })(),
    )
  })

  it('creates and updates ability, artifact, faction and rule entities', () => {
    const summary = sampleSummary({
      characters_appeared: [],
      events: [],
      new_elements: { locations: [], abilities: ['术'], artifacts: ['风'] },
    })
    const delta = empty()
    delta.world['术'] = { action: 'created', kind: 'ability', description: '术法' }
    delta.world['风'] = { action: 'created', kind: 'artifact', description: '风器' }
    delta.world['甲'] = { action: 'created', kind: 'faction', description: '势力' }
    delta.world['乙'] = { action: 'created', kind: 'rule', description: '规则' }
    const first = run(summary, delta)
    expect(first.world.abilities).toHaveLength(1)
    expect(first.world.artifacts).toHaveLength(1)
    expect(first.world.factions).toHaveLength(1)
    expect(first.world.rules).toHaveLength(1)

    const update = empty()
    update.world['术'] = { action: 'updated', description: '新术', detail: { level: 2 } }
    update.world['风'] = { action: 'updated', detail: { level: 3 } }
    update.world['甲'] = { action: 'updated', description: '新势力' }
    update.world['乙'] = { action: 'updated', description: '新规则' }
    const second = run(
      sampleSummary({ characters_appeared: [], events: [] }),
      update,
      first as unknown as Record<string, unknown>,
      2,
    )
    expect(second.world.abilities[0]).toMatchObject({ description: '新术', level: 2 })
    expect(second.world.artifacts[0]).toMatchObject({ level: 3 })
  })

  it('plants, advances and resolves a foreshadow through the ledger', () => {
    const plantSummary = sampleSummary({
      characters_appeared: [],
      events: [],
      foreshadows: {
        planted: [{ key: '旧信', title: '风', description: '旧信' }],
        advanced: [],
        resolved: [],
      },
    })
    const plant = empty()
    plant.foreshadows['旧信'] = { action: 'created', title: '风' }
    const first = run(plantSummary, plant)
    expect(first.foreshadows.items[0]).toMatchObject({ id: 'FS-001', title: '风' })

    const advance = empty()
    advance.foreshadows['FS-001'] = { action: 'updated', note: '推进' }
    const second = run(
      sampleSummary({
        characters_appeared: [],
        events: [],
        foreshadows: {
          planted: [],
          advanced: [{ key: 'FS-001', note: '推进', new_info: true }],
          resolved: [],
        },
      }),
      advance,
      first as unknown as Record<string, unknown>,
      2,
    )
    expect(second.foreshadows.items[0]).toMatchObject({ status: 'advanced' })

    const resolve = empty()
    resolve.foreshadows['FS-001'] = { action: 'updated' }
    const third = run(
      sampleSummary({
        characters_appeared: [],
        events: [],
        foreshadows: { planted: [], advanced: [], resolved: ['FS-001'] },
      }),
      resolve,
      second as unknown as Record<string, unknown>,
      3,
    )
    expect(third.foreshadows.items[0]).toMatchObject({ status: 'resolved' })
  })

  it('creates and updates a relationship', () => {
    const docs = base() as { characters: { characters: Array<Record<string, unknown>> } }
    docs.characters.characters.push({ name: '甲', role: 'extra', updated_at: 1, growth: [] })
    docs.characters.characters.push({ name: '乙', role: 'extra', updated_at: 1, growth: [] })
    const create = empty()
    create.relationships['甲|乙'] = {
      action: 'created',
      type: '旧识',
      description: '认识',
    }
    const first = run(sampleSummary({ characters_appeared: [], events: [] }), create, docs)
    expect(first.relationships.items[0]).toMatchObject({ type: '旧识' })
    const update = empty()
    update.relationships['甲|乙'] = { action: 'updated', type: '盟友', note: '结盟' }
    const second = run(
      sampleSummary({ characters_appeared: [], events: [] }),
      update,
      first as unknown as Record<string, unknown>,
      2,
    )
    expect(second.relationships.items[0]).toMatchObject({ type: '盟友' })
    expect(second.relationships.items[0]!.evolution[0]).toMatchObject({ chapter: 2 })
  })

  it('rejects malformed element arrays and resource details', () => {
    const badAbility = sampleSummary()
    badAbility.new_elements.abilities = 'x' as never
    fails(badAbility, empty())
    const badArtifact = sampleSummary()
    badArtifact.new_elements.artifacts = [1] as never
    fails(badArtifact, empty())
    const badArtifactArray = sampleSummary()
    badArtifactArray.new_elements.artifacts = 'x' as never
    fails(badArtifactArray, empty())
    const noKind = empty()
    noKind.world['风'] = { action: 'created' }
    fails(
      sampleSummary({
        characters_appeared: [],
        new_elements: { locations: [], abilities: [], artifacts: [] },
      }),
      noKind,
    )
    const implicitLocation = empty()
    implicitLocation.world['风'] = { action: 'created', kind: 'location' }
    fails(
      sampleSummary({
        characters_appeared: [],
        new_elements: { locations: [], abilities: [], artifacts: [] },
      }),
      implicitLocation,
    )
    const nonInteger = sampleSummary({
      characters_appeared: ['甲'],
      resource_changes: [{ character: '甲', resource: '钱', delta: 1.5, reason: 'x' }],
    })
    const created = empty()
    created.characters['甲'] = character('甲')
    fails(nonInteger, created)
    const noReason = sampleSummary({
      characters_appeared: ['甲'],
      resource_changes: [{ character: '甲', resource: '钱', delta: 1, reason: '' }],
    })
    fails(noReason, created)
    const badDescription = empty()
    badDescription.world['屋'] = { action: 'created', kind: 'location', description: 1 }
    fails(
      sampleSummary({
        characters_appeared: [],
        new_elements: { locations: ['屋'], abilities: [], artifacts: [] },
      }),
      badDescription,
    )
    const badLayout = empty()
    badLayout.world['屋'] = { action: 'created', kind: 'location', layout: 1 }
    fails(
      sampleSummary({
        characters_appeared: [],
        new_elements: { locations: ['屋'], abilities: [], artifacts: [] },
      }),
      badLayout,
    )
  })

  it('does not turn an unknown role hint into protagonist and honors an explicit no_change role', () => {
    const docs = base()
    ;(docs.characters as { characters: Array<Record<string, unknown>> }).characters = [
      {
        name: '他',
        role: 'extra',
        first_appearance: 1,
        profile: {},
        current_state: {},
        growth: [],
        updated_at: 1,
      },
    ]
    const summary = sampleSummary({ characters_appeared: ['他'], events: [] })
    const delta = empty()
    delta.characters['他'] = { action: 'no_change', reason: 'already on stage' }
    const unknown = applyStateDelta({
      chapter: 2,
      text: '他站在门口。',
      summary,
      delta: delta as never,
      ...(docs as Omit<DeltaInput, 'chapter' | 'text' | 'summary' | 'delta'>),
      narrator: '他',
      roleHints: { 他: '幕后黑手' },
    })
    expect(unknown.characters.characters[0]!.role).toBe('extra')

    const explicit = empty()
    explicit.characters['他'] = {
      action: 'no_change',
      reason: 'role correction',
      role: 'protagonist',
    }
    const corrected = applyStateDelta({
      chapter: 2,
      text: '他站在门口。',
      summary,
      delta: explicit as never,
      ...(docs as Omit<DeltaInput, 'chapter' | 'text' | 'summary' | 'delta'>),
      narrator: '别人',
      roleHints: { 他: '主角' },
    })
    expect(corrected.characters.characters[0]!.role).toBe('protagonist')
  })

  it('does not turn an unknown role hint into protagonist on a newly created character', () => {
    const docs = base()
    const summary = sampleSummary({ characters_appeared: ['他'], events: [] })
    const delta = empty()
    delta.characters['他'] = { action: 'created' }
    const result = applyStateDelta({
      chapter: 1,
      text: '他站在门口。',
      summary,
      delta: delta as never,
      ...(docs as Omit<DeltaInput, 'chapter' | 'text' | 'summary' | 'delta'>),
      narrator: '他',
      roleHints: { 他: '幕后黑手' },
    })
    expect(result.characters.characters[0]!.role).toBe('extra')
  })

  it('reconciles world actions against the ledger instead of summary intent', () => {
    const docs = base()
    ;(docs.world as { locations: Array<Record<string, unknown>> }).locations.push({
      name: '屋',
      first_appearance: 1,
      locked: true,
      description: '',
      layout: '',
      capacity: 0,
      changes: [],
    })
    const summary = sampleSummary({
      characters_appeared: [],
      events: [],
      new_elements: { locations: ['屋'], abilities: [], artifacts: [] },
    })
    const delta = empty()
    delta.world['屋'] = { action: 'created', kind: 'location' }
    const result = run(summary, delta, docs)
    expect(result.normalized_world['屋']).toMatchObject({
      from: 'created',
      to: 'updated',
      reason: 'existing-created-as-updated',
    })
    expect(result.warnings.map((warning) => warning.code)).toContain(
      'WORLD_ELEMENT_RECLASSIFIED_CREATED_TO_UPDATED',
    )

    const fresh = empty()
    fresh.world['屋'] = { action: 'updated', kind: 'location' }
    const created = run(
      sampleSummary({
        characters_appeared: [],
        events: [],
        new_elements: { locations: [], abilities: [], artifacts: [] },
      }),
      fresh,
    )
    expect(created.normalized_world['屋']).toMatchObject({
      from: 'updated',
      to: 'created',
      reason: 'missing-updated-as-created',
    })

    const noKind = empty()
    noKind.world['屋'] = { action: 'updated' }
    expect(() =>
      run(
        sampleSummary({
          characters_appeared: [],
          events: [],
          new_elements: { locations: [], abilities: [], artifacts: [] },
        }),
        noKind,
      ),
    ).toThrowError(/declare kind/)
  })

  it('deep-merges current_state resources and rejects invalid balances', () => {
    const docs = base() as {
      characters: { characters: Array<Record<string, unknown>> }
    }
    docs.characters.characters.push({
      name: '他',
      role: 'extra',
      first_appearance: 1,
      profile: {},
      current_state: { resources: { 港币: 5, 银元: 2 } },
      growth: [],
      updated_at: 0,
    })
    const summary = sampleSummary({ characters_appeared: [], events: [] })
    const delta = empty()
    delta.characters['他'] = {
      action: 'updated',
      current_state: { resources: { 港币: 7 } },
    }
    const result = run(summary, delta, docs)
    expect(result.characters.characters[0]!.current_state).toMatchObject({
      resources: { 港币: 7, 银元: 2 },
    })

    const negative = empty()
    negative.characters['他'] = {
      action: 'updated',
      current_state: { resources: { 港币: -1 } },
    }
    expect(() => run(summary, negative, docs)).toThrowError(
      expect.objectContaining({ code: 'ENGINE_RESOURCE_NEGATIVE_BALANCE' }),
    )

    const stringBalance = empty()
    stringBalance.characters['他'] = {
      action: 'updated',
      current_state: { resources: { 港币: '7' } },
    }
    expect(() => run(summary, stringBalance, docs)).toThrowError(/must be an integer/)
    const nullResources = empty()
    nullResources.characters['他'] = {
      action: 'updated',
      current_state: { resources: null },
    }
    expect(() => run(summary, nullResources, docs)).toThrowError(/resources must be an object/)
  })
})
