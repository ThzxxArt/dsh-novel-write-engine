import { allocateIds } from '../domain/ids.js'
import { splitParagraphs } from '../domain/text.js'
import {
  ERROR_CODES,
  EngineInputError,
  type ChapterSummary,
  type CharactersDocument,
  type CharacterDelta,
  type DeltaAction,
  type ForeshadowDelta,
  type ForeshadowsDocument,
  type LocksDocument,
  type RelationshipDelta,
  type RelationshipsDocument,
  type StateDelta,
  type TimelineDelta,
  type TimelineDocument,
  type WorldDelta,
  type WorldDocument,
} from '../types.js'

const SECTIONS = ['characters', 'foreshadows', 'timeline', 'world', 'relationships'] as const
const ACTIONS: readonly DeltaAction[] = ['created', 'updated', 'no_change']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function fail(detail: string): never {
  throw new EngineInputError(
    ERROR_CODES.DELTA_UNVERIFIED,
    `state_delta is incomplete: ${detail}`,
    'declare every entity the chapter touched as created, updated, or no_change with a reason',
  )
}

const entry = <T extends { action?: unknown }>(
  value: T | undefined,
  where: string,
): T & { action: DeltaAction } => {
  if (value === undefined) fail(`${where} is not declared`)
  if (!isRecord(value)) fail(`${where} must be an object`)
  if (!ACTIONS.includes(value.action as DeltaAction)) {
    fail(`${where} must declare action created|updated|no_change`)
  }
  return value as T & { action: DeltaAction }
}

const requireReason = (value: { action: DeltaAction; reason?: string }, where: string): void => {
  if (value.action !== 'no_change') return
  if (typeof value.reason !== 'string' || value.reason.trim() === '') {
    fail(`${where} is no_change but has no reason`)
  }
}

const appearanceOf = (text: string, name: string, aliases: readonly string[] = []): string => {
  const paragraphs = splitParagraphs(text)
  const source =
    paragraphs.find(
      (paragraph) =>
        paragraph.includes(name) || aliases.some((alias) => alias !== '' && paragraph.includes(alias)),
    ) ??
    paragraphs[0] ??
    ''
  return Array.from(source).slice(0, 120).join('')
}

const named = (value: unknown): value is { name: string } => isRecord(value) && typeof value.name === 'string'

/** The six ledgers after one chapter's delta has been applied. */
export interface DeltaResult {
  characters: CharactersDocument
  world: WorldDocument
  locks: LocksDocument
  foreshadows: ForeshadowsDocument
  timeline: TimelineDocument
  relationships: RelationshipsDocument
  assigned: Record<string, string>
}

export interface DeltaInput {
  chapter: number
  text: string
  summary: ChapterSummary
  delta: StateDelta
  characters: CharactersDocument
  world: WorldDocument
  locks: LocksDocument
  foreshadows: ForeshadowsDocument
  timeline: TimelineDocument
  relationships: RelationshipsDocument
  /** Plan narrator, used to resolve a first-person alias such as 「我」. */
  narrator?: string | null
}

/**
 * Apply the archive reconciliation sheet. Every ledger entity the summary
 * mentions must be declared; unknown keys are refused instead of being
 * redirected to an arbitrary row. This is the only writer of the five
 * derived ledgers.
 */
export function applyStateDelta(input: DeltaInput): DeltaResult {
  const { chapter, summary, delta } = input
  if (!isRecord(delta)) fail('the delta must be an object')
  for (const key of Object.keys(delta)) {
    if (!(SECTIONS as readonly string[]).includes(key)) fail(`unknown section "${key}"`)
  }
  for (const section of SECTIONS) {
    if (!isRecord(delta[section])) fail(`missing section "${section}"`)
  }

  if (!isRecord(summary.new_elements)) fail('summary.new_elements must be an object')
  for (const key of ['locations', 'abilities', 'artifacts'] as const) {
    if (!Array.isArray(summary.new_elements[key])) {
      fail(`summary.new_elements.${key} must be an array`)
    }
  }
  if (!Array.isArray(summary.resource_changes)) fail('summary.resource_changes must be an array')
  if (!Array.isArray(summary.events)) fail('summary.events must be an array')
  if (!isRecord(summary.foreshadows)) fail('summary.foreshadows must be an object')
  for (const key of ['planted', 'advanced', 'resolved'] as const) {
    if (!Array.isArray(summary.foreshadows[key])) {
      fail(`summary.foreshadows.${key} must be an array`)
    }
  }

  const characters = structuredClone(input.characters)
  const world = structuredClone(input.world)
  const locks = structuredClone(input.locks)
  const foreshadows = structuredClone(input.foreshadows)
  const timeline = structuredClone(input.timeline)
  const relationships = structuredClone(input.relationships)
  const assigned: Record<string, string> = {}

  const appeared = [...new Set(summary.characters_appeared)]
  const byName = new Map(characters.characters.map((character) => [character.name, character]))
  const narrator = input.narrator ?? ''
  const narratorName = narrator.split(/[（(]/, 1)[0]!.trim()
  const narratorAliases = [...narrator.matchAll(/[「『"]([^」』"]+)[」』"]/g)].map((match) =>
    match[1]!.trim(),
  )
  const appearsInManuscript = (name: string): boolean => {
    if (input.text.includes(name)) return true
    // A first-person plan names the protagonist in `narrator`, while the
    // manuscript itself says 「我」. Accept that declared alias.
    return (
      name === narratorName && narratorAliases.some((alias) => alias !== '' && input.text.includes(alias))
    )
  }

  for (const name of appeared) {
    if (!appearsInManuscript(name)) {
      fail(`character "${name}" is listed in characters_appeared but does not appear in the manuscript`)
    }
    if (delta.characters[name] === undefined) {
      fail(`character "${name}" appeared in the chapter but is not declared in characters`)
    }
  }

  for (const [name, raw] of Object.entries(delta.characters)) {
    const declared = entry<CharacterDelta>(raw, `characters.${name}`)
    requireReason(declared, `characters.${name}`)
    for (const field of ['profile', 'current_state', 'growth'] as const) {
      if (declared[field] !== undefined && !isRecord(declared[field])) {
        fail(`characters.${name}.${field} must be an object`)
      }
    }
    const existing = byName.get(name)
    if (declared.action === 'created') {
      if (existing !== undefined) fail(`character "${name}" already exists; use updated or no_change`)
      if (!appeared.includes(name)) {
        fail(`character "${name}" is created but does not appear in characters_appeared`)
      }
      const created = {
        name,
        role: declared.role ?? 'extra',
        first_appearance: chapter,
        profile: declared.profile ?? {},
        current_state: declared.current_state ?? {},
        growth: [] as Array<{ chapter: number; change: string; status_change: string }>,
        updated_at: chapter,
      }
      characters.characters.push(created)
      byName.set(name, created)
      continue
    }
    if (existing === undefined) fail(`character "${name}" does not exist; created must be used first`)
    if (declared.action === 'updated') {
      if (declared.role !== undefined) existing.role = declared.role
      if (declared.profile !== undefined) existing.profile = { ...existing.profile, ...declared.profile }
      if (declared.current_state !== undefined) {
        existing.current_state = { ...existing.current_state, ...declared.current_state }
      }
      if (declared.growth !== undefined) {
        existing.growth.push({ ...declared.growth, chapter })
      }
      existing.updated_at = chapter
    }
  }

  for (const change of summary.resource_changes) {
    if (
      !isRecord(change) ||
      typeof change.character !== 'string' ||
      change.character.trim() === '' ||
      typeof change.resource !== 'string' ||
      change.resource.trim() === '' ||
      !Number.isInteger(change.delta) ||
      typeof change.reason !== 'string' ||
      change.reason.trim() === ''
    ) {
      fail('every resource_changes entry must declare character/resource/delta/reason')
    }
    if (delta.characters[change.character] === undefined) {
      fail(`resource change for "${change.character}" has no character declaration`)
    }
    if (delta.characters[change.character]!.action === 'no_change') {
      fail(`resource change for "${change.character}" conflicts with a no_change declaration`)
    }
    const character = byName.get(change.character)
    if (character === undefined) fail(`resource change names unknown character "${change.character}"`)
    if (!Number.isInteger(change.delta) || change.delta === 0) {
      fail(`resource change for "${change.character}" must have a non-zero integer delta`)
    }
    const state = isRecord(character.current_state) ? character.current_state : {}
    const resources: Record<string, unknown> = isRecord(state.resources) ? { ...state.resources } : {}
    const current =
      typeof resources[change.resource] === 'number' ? (resources[change.resource] as number) : 0
    const next = current + change.delta
    if (next < 0) {
      throw new EngineInputError(
        ERROR_CODES.RESOURCE_NEGATIVE_BALANCE,
        `${change.character}'s ${change.resource} would drop to ${next}`,
        'state the resource cap or earn the balance before spending it',
      )
    }
    resources[change.resource] = next
    character.current_state = { ...state, resources }
  }

  const findWorld = (
    name: string,
  ): { kind: 'location' | 'ability' | 'artifact' | 'faction' | 'rule'; value: unknown } | null => {
    const location = world.locations.find((candidate) => candidate.name === name)
    if (location !== undefined) return { kind: 'location', value: location }
    for (const [kind, values] of [
      ['ability', world.abilities],
      ['artifact', world.artifacts],
      ['faction', world.factions],
      ['rule', world.rules],
    ] as const) {
      const found = values.find((value) => named(value) && value.name === name)
      if (found !== undefined) return { kind, value: found }
    }
    return null
  }

  const expectedKind = (name: string): 'location' | 'ability' | 'artifact' | null => {
    if (summary.new_elements.locations.includes(name)) return 'location'
    if (summary.new_elements.abilities.includes(name)) return 'ability'
    if (summary.new_elements.artifacts.includes(name)) return 'artifact'
    return null
  }

  // The inverse direction matters as much as the lookup above: every element
  // the summary announces must be declared as created. Otherwise a chapter can
  // announce a new location and never write it into the world ledger.
  for (const [kind, names] of [
    ['location', summary.new_elements.locations],
    ['ability', summary.new_elements.abilities],
    ['artifact', summary.new_elements.artifacts],
  ] as const) {
    for (const name of names) {
      if (!input.text.includes(name)) {
        fail(`summary lists new ${kind} "${name}" but the manuscript never mentions it`)
      }
      const declared = delta.world[name]
      if (declared === undefined) {
        fail(`summary lists new ${kind} "${name}" but world.${name} is not declared`)
      }
      if (declared.action !== 'created') {
        fail(`world.${name} is new in this chapter; its action must be created`)
      }
      if (declared.kind !== undefined && declared.kind !== kind) {
        fail(`world.${name} is declared as ${declared.kind} but the summary lists it as ${kind}`)
      }
    }
  }

  for (const [name, raw] of Object.entries(delta.world)) {
    const declared = entry<WorldDelta>(raw, `world.${name}`)
    requireReason(declared, `world.${name}`)
    if (declared.description !== undefined && typeof declared.description !== 'string') {
      fail(`world.${name}.description must be a string`)
    }
    if (declared.layout !== undefined && typeof declared.layout !== 'string') {
      fail(`world.${name}.layout must be a string`)
    }
    if (declared.capacity !== undefined && (!Number.isInteger(declared.capacity) || declared.capacity < 0)) {
      fail(`world.${name}.capacity must be a non-negative integer`)
    }
    if (declared.detail !== undefined && !isRecord(declared.detail)) {
      fail(`world.${name}.detail must be an object`)
    }
    const expected = expectedKind(name)
    if (expected !== null) {
      if (declared.action !== 'created') {
        fail(`world.${name} is new in this chapter; its action must be created`)
      }
      if (declared.kind !== undefined && declared.kind !== expected) {
        fail(`world.${name} is declared as ${declared.kind} but the summary lists it as ${expected}`)
      }
    }
    const existing = findWorld(name)
    if (declared.action === 'created') {
      if (existing !== null) fail(`world entity "${name}" already exists; use updated or no_change`)
      const kind = declared.kind ?? expected
      if (kind === null) fail(`world.${name} must declare kind (location|ability|artifact|faction|rule)`)
      if (kind === 'location') {
        world.locations.push({
          name,
          first_appearance: chapter,
          locked: true,
          description: declared.description ?? '',
          layout: declared.layout ?? '',
          capacity: declared.capacity ?? 0,
          changes: [],
        })
      } else {
        const target =
          world[
            kind === 'ability'
              ? 'abilities'
              : kind === 'artifact'
                ? 'artifacts'
                : kind === 'faction'
                  ? 'factions'
                  : 'rules'
          ]
        target.push({
          name,
          first_appearance: chapter,
          description: declared.description ?? '',
          ...(declared.detail ?? {}),
        })
      }
      continue
    }
    if (existing === null) fail(`world entity "${name}" does not exist; created must be used first`)
    if (declared.action === 'updated') {
      if (existing.kind === 'location') {
        const location = existing.value as WorldDocument['locations'][number]
        if (declared.description !== undefined) location.description = declared.description
        if (declared.layout !== undefined) location.layout = declared.layout
        if (declared.capacity !== undefined) location.capacity = declared.capacity
        location.changes.push({
          chapter,
          change: declared.reason ?? declared.description ?? 'updated',
          reason: declared.reason ?? '',
        })
      } else if (isRecord(existing.value)) {
        if (declared.description !== undefined && 'description' in existing.value) {
          existing.value.description = declared.description
        }
        if (declared.detail !== undefined) Object.assign(existing.value, declared.detail)
      }
    }
  }

  for (const name of appeared) {
    if (locks.characters[name] === undefined) {
      const character = byName.get(name)!
      locks.characters[name] = {
        first_appearance: character.first_appearance,
        locked_at: chapter,
        appearance: appearanceOf(input.text, name, name === narratorName ? narratorAliases : []),
      }
    }
  }
  for (const location of world.locations) {
    if (locks.locations[location.name] === undefined) {
      locks.locations[location.name] = {
        first_appearance: location.first_appearance,
        locked_at: chapter,
        layout: location.layout,
        capacity: location.capacity,
      }
    }
  }
  locks.locked_at_chapter = Math.max(locks.locked_at_chapter, chapter)

  const byId = new Map(foreshadows.items.map((item) => [item.id, item]))
  const plantedKeys = new Set<string>()
  for (const plant of summary.foreshadows.planted) {
    if (plant.key.trim() === '') fail('a planted foreshadow has an empty key')
    if (plantedKeys.has(plant.key)) fail(`foreshadow key "${plant.key}" is planted twice`)
    plantedKeys.add(plant.key)
    const declared = entry<ForeshadowDelta>(delta.foreshadows[plant.key], `foreshadows.${plant.key}`)
    requireReason(declared, `foreshadows.${plant.key}`)
    if (declared.action !== 'created') fail(`foreshadows.${plant.key} is planted; its action must be created`)
    const allocated = allocateIds('FS', foreshadows.next_seq, 1)
    foreshadows.next_seq = allocated.nextSeq
    const item = {
      id: allocated.ids[0]!,
      title: declared.title ?? plant.title,
      planted: chapter,
      last_touched: chapter,
      status: 'planted' as const,
      resolved_at: null,
      description: declared.description ?? plant.description,
      advance_log: [] as Array<{ chapter: number; note: string; new_info: boolean }>,
    }
    foreshadows.items.push(item)
    byId.set(item.id, item)
    assigned[plant.key] = item.id
  }

  for (const advance of summary.foreshadows.advanced) {
    const declared = entry<ForeshadowDelta>(delta.foreshadows[advance.key], `foreshadows.${advance.key}`)
    requireReason(declared, `foreshadows.${advance.key}`)
    if (declared.action !== 'updated') {
      fail(`foreshadows.${advance.key} is advanced; its action must be updated`)
    }
    const id = assigned[advance.key] ?? advance.key
    const item = byId.get(id)
    if (item === undefined) fail(`foreshadow "${advance.key}" does not exist; no fallback is allowed`)
    item.last_touched = chapter
    item.status = 'advanced'
    item.advance_log.push({
      chapter,
      note: declared.note ?? advance.note,
      new_info: declared.new_info ?? advance.new_info,
    })
    assigned[advance.key] = item.id
  }

  for (const key of summary.foreshadows.resolved) {
    const declared = entry<ForeshadowDelta>(delta.foreshadows[key], `foreshadows.${key}`)
    requireReason(declared, `foreshadows.${key}`)
    if (declared.action !== 'updated') {
      fail(`foreshadows.${key} is resolved; its action must be updated`)
    }
    const id = assigned[key] ?? key
    const item = byId.get(id)
    if (item === undefined) fail(`foreshadow "${key}" does not exist; no fallback is allowed`)
    item.status = 'resolved'
    item.last_touched = chapter
    item.resolved_at = chapter
    assigned[key] = item.id
  }

  const consumed = new Set([
    ...plantedKeys,
    ...summary.foreshadows.advanced.map((advance) => advance.key),
    ...summary.foreshadows.resolved,
  ])
  for (const [key, raw] of Object.entries(delta.foreshadows)) {
    if (consumed.has(key)) continue
    const declared = entry<ForeshadowDelta>(raw, `foreshadows.${key}`)
    requireReason(declared, `foreshadows.${key}`)
    const item = byId.get(key)
    if (item === undefined) fail(`foreshadow "${key}" is not in the ledger`)
    if (declared.action === 'created') fail(`foreshadow "${key}" already exists`)
    if (declared.action === 'updated') {
      item.last_touched = chapter
      if (declared.note !== undefined) {
        item.advance_log.push({ chapter, note: declared.note, new_info: declared.new_info ?? false })
      }
    }
  }

  for (const [index, event] of summary.events.entries()) {
    const key = String(index)
    const declared = entry<TimelineDelta>(delta.timeline[key], `timeline.${key}`)
    if (declared.action !== 'created') {
      fail(`timeline.${key} is a new event; its action must be created`)
    }
    const allocated = allocateIds('TE', timeline.next_seq, 1)
    timeline.next_seq = allocated.nextSeq
    const id = allocated.ids[0]!
    timeline.items.push({
      id,
      chapter,
      story_time: declared.story_time ?? '未记录',
      description: declared.description ?? event,
      location: declared.location ?? '',
      characters: declared.characters ?? appeared,
    })
    assigned[`timeline:${index}`] = id
  }
  for (const key of Object.keys(delta.timeline)) {
    if (!/^\d+$/.test(key) || Number(key) >= summary.events.length) {
      fail(`timeline.${key} does not match any event in summary.events`)
    }
  }

  const pairKey = (a: string, b: string): string => `${a}|${b}`
  const findRelationship = (a: string, b: string): RelationshipsDocument['items'][number] | undefined =>
    relationships.items.find((item) => (item.a === a && item.b === b) || (item.a === b && item.b === a))
  for (const [key, raw] of Object.entries(delta.relationships)) {
    const declared = entry<RelationshipDelta>(raw, `relationships.${key}`)
    requireReason(declared, `relationships.${key}`)
    const [left, right] = key.split('|')
    const a = declared.a ?? left
    const b = declared.b ?? right
    if (a === undefined || b === undefined || a.trim() === '' || b.trim() === '' || a === b) {
      fail(`relationships.${key} must name two different characters as "a|b"`)
    }
    if (byName.get(a) === undefined || byName.get(b) === undefined) {
      fail(`relationships.${key} names a character that is not declared in characters`)
    }
    const existing = findRelationship(a, b)
    if (declared.action === 'created') {
      if (existing !== undefined) fail(`relationship ${pairKey(a, b)} already exists`)
      if (typeof declared.type !== 'string' || declared.type.trim() === '') {
        fail(`relationships.${key} is created but has no type`)
      }
      const allocated = allocateIds('RL', relationships.next_seq, 1)
      relationships.next_seq = allocated.nextSeq
      const id = allocated.ids[0]!
      relationships.items.push({
        id,
        a,
        b,
        type: declared.type!,
        since: chapter,
        description: declared.description ?? '',
        evolution: [],
      })
      assigned[key] = id
      continue
    }
    if (existing === undefined) fail(`relationship ${key} does not exist; created must be used first`)
    if (declared.action === 'updated') {
      if (declared.type !== undefined) {
        if (typeof declared.type !== 'string' || declared.type.trim() === '') {
          fail(`relationships.${key} type must be a non-empty string`)
        }
        existing.type = declared.type
      }
      if (declared.description !== undefined) existing.description = declared.description
      if (declared.note !== undefined) existing.evolution.push({ chapter, note: declared.note })
    }
    assigned[key] = existing.id
  }

  return { characters, world, locks, foreshadows, timeline, relationships, assigned }
}
