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
    text: '风从窗缝里挤进来。他伸手压住。',
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
      current_state: { emotion: '平静' },
    })
    delta.timeline['0'] = { action: 'created' }
    const first = run(summary, delta)
    expect(first.characters.characters[0]).toMatchObject({
      name: '甲',
      first_appearance: 1,
      current_state: { resources: { 钱: -2 } },
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
    const delta: Record<string, Record<string, unknown>> = {
      ...chars,
      relationships: { '甲|乙': { action: 'created', type: '同事' } },
    }
    const result = run(summary, delta)
    expect(result.relationships.items[0]).toMatchObject({ id: 'RL-001', a: '甲', b: '乙' })
  })
})
