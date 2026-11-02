import { createHash } from 'node:crypto'
import { allocateIds } from '../domain/ids.js'
import { isNarratorAlias, narratorAliasesFor, narratorName as narratorNameOf } from '../domain/narrator.js'
import { matchEvidence, splitParagraphs } from '../domain/text.js'
import {
  anchorsForGroup,
  anchorsFromSummary,
  entityMatchHint,
  matchEntityText,
  mergeEntityAnchors,
  type AnchorMap,
} from './entity-anchors.js'
import {
  ERROR_CODES,
  EngineInputError,
  type ChapterSummary,
  type ErrorDetails,
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
  type RelationshipTypeCode,
  RELATIONSHIP_TYPE_CODES,
  type WorldDelta,
  type WorldDocument,
  type Warning,
} from '../types.js'

const SECTIONS = ['characters', 'foreshadows', 'timeline', 'world', 'relationships'] as const
const ACTIONS: readonly DeltaAction[] = ['created', 'updated', 'no_change']

/** Every key a delta entry may carry; anything else is refused, not ignored. */
const DELTA_KEYS: Readonly<Record<(typeof SECTIONS)[number], readonly string[]>> = {
  characters: ['action', 'reason', 'role', 'profile', 'current_state', 'unset', 'growth'],
  foreshadows: [
    'action',
    'reason',
    'title',
    'anchor',
    'description',
    'note',
    'new_info',
    'planned_resolve',
    'resolved_anchor',
    'kind',
  ],
  timeline: ['action', 'reason', 'story_time', 'description', 'location', 'characters'],
  world: ['action', 'reason', 'kind', 'description', 'layout', 'capacity', 'detail'],
  relationships: ['action', 'reason', 'a', 'b', 'type', 'type_code', 'description', 'note'],
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Stable event key shared by new writes and read-time compatibility. */
export const eventKeyFor = (chapter: number, index: number, event: string): string =>
  `E${chapter}-${index + 1}-${createHash('sha256').update(event).digest('hex').slice(0, 8)}`

/** Define an own property even for names such as `__proto__` or `constructor`. */
const setOwn = <T>(record: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true })
}

/** Validate resource balances without accepting numeric strings or fractions. */
const validateResources = (
  state: Record<string, unknown>,
  who: string,
  allowNegative: boolean,
  // The balance before this patch. Without it the set channel could only say
  // "original 0" for a character that already held a balance (M4).
  base?: Record<string, unknown>,
): void => {
  if (state.resources === undefined) return
  if (!isRecord(state.resources)) {
    fail(`${who}.current_state.resources must be an object`, {
      field: `${who}.current_state.resources`,
      expected: 'object',
      received: state.resources,
      received_type: Array.isArray(state.resources) ? 'array' : typeof state.resources,
      example: { resources: { 资源名: 3 } },
    })
  }
  const previous = isRecord(base?.resources) ? base.resources : {}
  for (const [name, value] of Object.entries(state.resources)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      fail(`${who}.current_state.resources.${name} must be an integer`, {
        field: `${who}.current_state.resources.${name}`,
        expected: 'integer',
        received: value,
        received_type: typeof value,
      })
    }
    const original = typeof previous[name] === 'number' ? (previous[name] as number) : 0
    if (value < 0 && !allowNegative) {
      throw new EngineInputError(
        ERROR_CODES.RESOURCE_NEGATIVE_BALANCE,
        `resource ${name} would be ${value}: original ${original}, set ${value}, result ${value} (absolute set in current_state.resources)`,
        `a negative balance is refused unless novel.yaml targets.allow_negative_balances is true; set a non-negative balance, or let summary.resource_changes apply an increment`,
        {
          details: {
            field: `${who}.current_state.resources.${name}`,
            expected: 'non-negative integer (or allow_negative_balances: true)',
            received: { original, set: value, result: value },
            allowed: ['0 or positive integer'],
            example: { resources: { [name]: 0 } },
          },
        },
      )
    }
  }
}

/**
 * Current state is a patch; resources are a nested map, not a whole replacement.
 * `unset` is the only way to remove a top-level key; a null value is still a value.
 */
const mergeCurrentState = (
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
  unset: readonly string[] = [],
): Record<string, unknown> => {
  const merged = { ...base, ...patch }
  if (patch.resources !== undefined && !isRecord(patch.resources)) {
    fail('current_state.resources must be an object')
  }
  if (patch.resources !== undefined) {
    const baseResources = isRecord(base.resources) ? base.resources : {}
    merged.resources = { ...baseResources, ...(patch.resources as Record<string, unknown>) }
  }
  for (const key of unset) {
    delete merged[key]
  }
  return merged
}

/**
 * U4: a delta rejection without `details` gives the author a sentence and no
 * field to fix. Call sites that know the exact shape pass their own object;
 * the rest still get the leading field path and the requirement sentence, so
 * no rejection reaches the tool layer bare. `derived: true` marks the ones
 * whose `received` value the message did not carry.
 */
function deriveDeltaDetails(detail: string): ErrorDetails {
  const head = /^(\S+)\s/.exec(detail)
  const token = head?.[1] ?? ''
  const path = token.includes('.') || /^[A-Za-z_][\w-]*$/.test(token) ? token : 'state_delta'
  return { field: path, expected: detail, derived: true }
}

function fail(detail: string, details?: ErrorDetails): never {
  throw new EngineInputError(
    ERROR_CODES.DELTA_UNVERIFIED,
    `state_delta is incomplete: ${detail}`,
    'declare every entity the chapter touched as created, updated, or no_change with a reason',
    { details: details ?? deriveDeltaDetails(detail) },
  )
}

/** Refuse unknown keys instead of silently dropping them (0.2.14). */
const assertDeltaKeys = (
  value: unknown,
  section: (typeof SECTIONS)[number],
  where: string,
  entryKey?: string,
): void => {
  // Shape errors (null, array, scalar) are reported by entry(), with a better
  // message than an unknown-key scan.
  if (!isRecord(value)) return
  const allowed = DELTA_KEYS[section]
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue
    // Echoing the map key as `name` is harmless and common; a different name
    // is a silent rename, which is not harmless.
    if ((section === 'characters' || section === 'world') && key === 'name') {
      if (entryKey === undefined || value.name === entryKey) continue
      fail(`${where}.name "${String(value.name)}" does not match its key "${entryKey}"`, {
        field: `${where}.name`,
        expected: entryKey,
        received: value.name,
        received_type: typeof value.name,
      })
    }
    fail(`${where} has unknown key "${key}"`, {
      field: `${where}.${key}`,
      expected: `one of ${allowed.join('|')}`,
      received: value[key],
      allowed: [...allowed],
      example:
        section === 'foreshadows'
          ? { action: 'updated', note: 'chapter resolved it', resolved_anchor: '正文原句' }
          : { action: 'updated', reason: '...' },
    })
  }
}

const entry = <T extends { action?: unknown }>(
  value: T | undefined,
  where: string,
): T & { action: DeltaAction } => {
  if (value === undefined) {
    fail(`${where} is not declared`, {
      field: where,
      expected: 'a declared entry',
      received: 'missing',
      received_type: 'undefined',
      allowed: [...ACTIONS],
      example: { action: 'updated', reason: '...' },
    })
  }
  if (!isRecord(value)) {
    fail(`${where} must be an object`, {
      field: where,
      expected: 'object',
      received: value,
      received_type: Array.isArray(value) ? 'array' : typeof value,
      example: { action: 'updated', reason: '...' },
    })
  }
  if (!ACTIONS.includes(value.action as DeltaAction)) {
    fail(`${where} must declare action created|updated|no_change`, {
      field: `${where}.action`,
      expected: 'created|updated|no_change',
      received: value.action,
      received_type: typeof value.action,
      allowed: [...ACTIONS],
      example: { action: 'updated', reason: '...' },
    })
  }
  return value as T & { action: DeltaAction }
}

const requireReason = (value: { action: DeltaAction; reason?: string }, where: string): void => {
  if (value.action !== 'no_change') return
  if (typeof value.reason !== 'string' || value.reason.trim() === '') {
    fail(`${where} is no_change but has no reason`, {
      field: `${where}.reason`,
      expected: 'a non-empty string',
      received: value.reason ?? 'missing',
      received_type: typeof value.reason,
      example: { action: 'no_change', reason: '本章没有出现' },
    })
  }
}

/** A one-character anchor is indistinguishable from a substring accident. */
const ANCHOR_MIN_CHARS = 8
const anchorIsStrong = (value: unknown): value is string =>
  typeof value === 'string' && Array.from(value.trim()).length >= ANCHOR_MIN_CHARS

const requireForeshadowFields = (value: ForeshadowDelta, where: string): void => {
  if (value.title !== undefined && typeof value.title !== 'string') fail(`${where}.title must be a string`)
  if (value.anchor !== undefined && !anchorIsStrong(value.anchor)) {
    fail(`${where}.anchor must be a verbatim quote of at least ${ANCHOR_MIN_CHARS} characters`)
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    fail(`${where}.description must be a string`)
  }
  if (value.note !== undefined && typeof value.note !== 'string') fail(`${where}.note must be a string`)
  if (value.new_info !== undefined && typeof value.new_info !== 'boolean') {
    fail(`${where}.new_info must be a boolean`)
  }
  if (value.planned_resolve !== undefined && value.planned_resolve !== null) {
    if (!Number.isInteger(value.planned_resolve) || value.planned_resolve < 1) {
      fail(`${where}.planned_resolve must be a positive integer or null`)
    }
  }
  if (value.resolved_anchor !== undefined && !anchorIsStrong(value.resolved_anchor)) {
    fail(`${where}.resolved_anchor must be a verbatim quote of at least ${ANCHOR_MIN_CHARS} characters`)
  }
  if (value.kind !== undefined && value.kind !== 'plot' && value.kind !== 'motif') {
    fail(`${where}.kind must be plot|motif`)
  }
}

/** Nearest paragraph hint for a failed verbatim match. */
const nearestParagraph = (
  text: string,
  quote: string,
): { paragraph: number; text: string; offset: number } | undefined => {
  const match = matchEvidence(text, quote)
  return match.nearest === undefined
    ? undefined
    : { paragraph: match.nearest.paragraph, text: match.nearest.text, offset: match.nearest.offset }
}

const withoutQuotedSpeech = (text: string): string =>
  text.replace(/"[^"]*"|“[^”]*”|「[^」]*」|『[^』]*』/g, '')

const appearanceOf = (text: string, name: string, aliases: readonly string[] = []): string => {
  const paragraphs = splitParagraphs(text)
  // Prefer plain narration over dialogue. A pronoun inside another character's
  // quoted line must not become the narrator's locked appearance.
  const source =
    paragraphs.find((paragraph) => withoutQuotedSpeech(paragraph).includes(name)) ??
    paragraphs.find((paragraph) => paragraph.includes(name)) ??
    paragraphs.find((paragraph) =>
      aliases.some((alias) => alias !== '' && withoutQuotedSpeech(paragraph).includes(alias)),
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
  warnings: Warning[]
  normalized_world: Record<
    string,
    {
      from: DeltaAction
      to: DeltaAction
      reason: 'existing-created-as-updated' | 'missing-updated-as-created' | 'missing-no-change-as-created'
    }
  >
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
  /** Role hints from P1 / the worldbook, keyed by character name. */
  roleHints?: Readonly<Record<string, string>>
  /** Project target: a negative balance is debt, not a typo. */
  allowNegativeBalances?: boolean
  /** strict outline: a plot foreshadow must name its planned payoff chapter. */
  strict?: boolean
}

const ROLE_ALIASES: Readonly<Record<string, string>> = {
  主角: 'protagonist',
  男主角: 'protagonist',
  女主: 'protagonist',
  女主角: 'protagonist',
  男主: 'protagonist',
  主人公: 'protagonist',
  protagonist: 'protagonist',
  配角: 'supporting',
  重要配角: 'supporting',
  男二: 'supporting',
  女二: 'supporting',
  supporting: 'supporting',
  反派: 'antagonist',
  antagonist: 'antagonist',
  龙套: 'extra',
  路人: 'extra',
  extra: 'extra',
}

/** Keep one canonical role vocabulary instead of letting free text reach reports. */
export const normalizeRole = (value: string | undefined, fallback: string): string => {
  const canonicalFallback = ROLE_ALIASES[fallback] ?? 'extra'
  const trimmed = value?.trim() ?? ''
  if (trimmed === '') return canonicalFallback
  return ROLE_ALIASES[trimmed] ?? canonicalFallback
}

/** A hint is authoritative only when it is a known role, not arbitrary prose. */
const canonicalRole = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? ''
  if (trimmed === '') return null
  return ROLE_ALIASES[trimmed] ?? null
}

/**
 * Apply the archive reconciliation sheet. Every ledger entity the summary
 * mentions must be declared; unknown keys are refused instead of being
 * redirected to an arbitrary row. This is the only writer of the five
 * derived ledgers.
 */
export function applyStateDelta(input: DeltaInput): DeltaResult {
  const { chapter, summary, delta } = input
  const allowNegative = input.allowNegativeBalances === true
  if (!isRecord(delta)) {
    fail('the delta must be an object', {
      field: 'state_delta',
      expected: 'object',
      received: delta,
      received_type: Array.isArray(delta) ? 'array' : typeof delta,
      example: { characters: {}, foreshadows: {}, timeline: {}, world: {}, relationships: {} },
    })
  }
  for (const key of Object.keys(delta)) {
    if (!(SECTIONS as readonly string[]).includes(key)) {
      fail(`unknown section "${key}"`, {
        field: `state_delta.${key}`,
        expected: `one of ${SECTIONS.join('|')}`,
        received: key,
        received_type: 'string',
        allowed: [...SECTIONS],
      })
    }
  }
  for (const section of SECTIONS) {
    if (!isRecord(delta[section])) {
      fail(`missing section "${section}"`, {
        field: `state_delta.${section}`,
        expected: 'object',
        received: delta[section] ?? 'missing',
        received_type: delta[section] === undefined ? 'undefined' : typeof delta[section],
        allowed: [...SECTIONS],
        example: { [section]: {} },
      })
    }
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
  let anchors: AnchorMap
  try {
    anchors = anchorsFromSummary(summary)
  } catch (error) {
    fail(error instanceof Error ? error.message : 'summary.new_element_anchors is invalid')
  }

  const characters = structuredClone(input.characters)
  const world = structuredClone(input.world)
  const locks = structuredClone(input.locks)
  const foreshadows = structuredClone(input.foreshadows)
  const timeline = structuredClone(input.timeline)
  const relationships = structuredClone(input.relationships)
  const assigned: Record<string, string> = Object.create(null) as Record<string, string>
  const warnings: Warning[] = []
  const normalizedWorld: DeltaResult['normalized_world'] = Object.create(
    null,
  ) as DeltaResult['normalized_world']

  const warnReclass = (
    name: string,
    from: DeltaAction,
    to: DeltaAction,
    reason: DeltaResult['normalized_world'][string]['reason'],
  ): void => {
    normalizedWorld[name] = { from, to, reason }
    const code =
      reason === 'existing-created-as-updated'
        ? 'WORLD_ELEMENT_RECLASSIFIED_CREATED_TO_UPDATED'
        : reason === 'missing-updated-as-created'
          ? 'WORLD_ELEMENT_RECLASSIFIED_UPDATED_TO_CREATED'
          : 'WORLD_ELEMENT_RECLASSIFIED_NO_CHANGE_TO_CREATED'
    warnings.push({
      code,
      message: `world.${name}: ${from} normalized to ${to} against state/world.yaml (${reason})`,
    })
  }

  const appeared = [...new Set(summary.characters_appeared)]
  const byName = new Map(characters.characters.map((character) => [character.name, character]))
  // Balances before this delta, so a set/add collision can name the original
  // instead of claiming it was zero (M4/U1).
  const originalBalances = new Map<string, number>()
  for (const record of characters.characters) {
    const state = isRecord(record.current_state) ? record.current_state : {}
    const resources = isRecord(state.resources) ? state.resources : {}
    for (const [resource, value] of Object.entries(resources)) {
      if (typeof value === 'number') originalBalances.set(`${record.name}\u0000${resource}`, value)
    }
  }
  const narrator = input.narrator ?? ''
  const narratorName = narratorNameOf(narrator)
  // A first-person plan names the protagonist in `narrator`, while the
  // manuscript itself says 「我」. The helper owns that alias so PG-05, the
  // delta and lock capture cannot disagree.
  const appearsInManuscript = (name: string): boolean => isNarratorAlias(name, narrator, input.text)

  for (const name of appeared) {
    if (!appearsInManuscript(name)) {
      fail(`character "${name}" is listed in characters_appeared but does not appear in the manuscript`, {
        field: `summary.characters_appeared`,
        expected: 'names that appear verbatim in the manuscript',
        received: name,
        received_type: 'string',
        allowed: [...appeared],
      })
    }
    if (!Object.hasOwn(delta.characters, name)) {
      fail(`character "${name}" appeared in the chapter but is not declared in characters`, {
        field: `characters.${name}`,
        expected: 'a declared entry',
        received: 'missing',
        received_type: 'undefined',
        allowed: [...ACTIONS],
        example: { [name]: { action: 'updated', reason: '出场了但状态不变' } },
      })
    }
  }

  for (const [name, raw] of Object.entries(delta.characters)) {
    assertDeltaKeys(raw, 'characters', `characters.${name}`, name)
    const declared = entry<CharacterDelta>(raw, `characters.${name}`)
    requireReason(declared, `characters.${name}`)
    if (declared.action === 'no_change') {
      const ignored = (['current_state', 'profile', 'growth'] as const).filter(
        (field) => declared[field] !== undefined,
      )
      if (ignored.length > 0 || (declared.unset?.length ?? 0) > 0) {
        fail(
          `characters.${name} is no_change but also declares ${[...ignored, ...(declared.unset === undefined ? [] : ['unset'])].join(', ')}; no_change accepts only role`,
          {
            field: `characters.${name}.action`,
            expected: 'updated',
            received: 'no_change',
            allowed: [...ACTIONS],
            example: { action: 'updated', current_state: { status: '...' } },
          },
        )
      }
    }
    if (declared.role !== undefined && typeof declared.role !== 'string') {
      fail(`characters.${name}.role must be a string`, {
        field: `characters.${name}.role`,
        expected: 'string',
        received: declared.role,
        received_type: Array.isArray(declared.role) ? 'array' : typeof declared.role,
        example: 'protagonist',
      })
    }
    if (declared.unset !== undefined) {
      if (!Array.isArray(declared.unset) || declared.unset.some((key) => typeof key !== 'string')) {
        fail(`characters.${name}.unset must be a string array`, {
          field: `characters.${name}.unset`,
          expected: 'string[]',
          received: declared.unset,
          received_type: Array.isArray(declared.unset) ? 'array' : typeof declared.unset,
          example: { unset: ['deadline'] },
        })
      }
      if (declared.unset.includes('resources')) {
        fail(`characters.${name}.unset cannot remove resources; set an explicit balance instead`, {
          field: `characters.${name}.unset`,
          expected: 'top-level scalar keys, not resources',
          received: declared.unset,
          allowed: Object.keys(declared.current_state ?? {}).filter((key) => key !== 'resources'),
        })
      }
      if (declared.action !== 'updated') {
        fail(`characters.${name}.unset requires action updated`, {
          field: `characters.${name}.action`,
          expected: 'updated',
          received: declared.action,
          allowed: ['updated'],
        })
      }
    }
    for (const field of ['profile', 'current_state', 'growth'] as const) {
      if (declared[field] !== undefined && !isRecord(declared[field])) {
        const value = declared[field]
        const shape =
          field === 'current_state'
            ? { resources: { 资源名: 3 }, status: '...' }
            : field === 'profile'
              ? { age: 31, occupation: '...' }
              : { change: '...', status_change: '...' }
        fail(`characters.${name}.${field} must be an object; expected ${JSON.stringify(shape)}`, {
          field: `characters.${name}.${field}`,
          expected: 'object',
          received: value,
          received_type: Array.isArray(value) ? 'array' : typeof value,
          example: { [field]: shape },
        })
      }
    }
    if (declared.growth !== undefined) {
      const growth = declared.growth as Record<string, unknown>
      for (const field of ['change', 'status_change'] as const) {
        if (typeof growth[field] !== 'string' || growth[field].trim() === '') {
          fail(`characters.${name}.growth.${field} must be a non-empty string`)
        }
      }
    }
    const existing = byName.get(name)
    if (declared.action === 'created') {
      if (existing !== undefined) fail(`character "${name}" already exists; use updated or no_change`)
      if (!appeared.includes(name)) {
        fail(`character "${name}" is created but does not appear in characters_appeared`)
      }
      const rawHint = input.roleHints?.[name]
      const hinted =
        canonicalRole(rawHint) ??
        (rawHint === undefined && (name === narratorName || name === narrator) ? 'protagonist' : 'extra')
      const currentState = (declared.current_state ?? {}) as Record<string, unknown>
      validateResources(currentState, `characters.${name}`, allowNegative)
      const growth =
        declared.growth === undefined
          ? []
          : [{ ...(declared.growth as { change: string; status_change: string }), chapter }]
      const created = {
        name,
        role: normalizeRole(declared.role, hinted),
        first_appearance: chapter,
        profile: declared.profile ?? {},
        current_state: currentState,
        growth,
        updated_at: chapter,
      }
      characters.characters.push(created)
      byName.set(name, created)
      continue
    }
    if (existing === undefined) fail(`character "${name}" does not exist; created must be used first`)
    // Role is metadata, not manuscript state. Repair a legacy `extra` from a
    // known worldbook/P1 role or, only when no hint exists at all, from the
    // narrator. An unknown hint must not silently become protagonist.
    if (existing.role === 'extra' && declared.role === undefined) {
      const rawHint = input.roleHints?.[name]
      const hinted = canonicalRole(rawHint)
      if (hinted !== null && hinted !== 'extra') {
        existing.role = hinted
      } else if (rawHint === undefined && (name === narratorName || name === narrator)) {
        existing.role = 'protagonist'
      }
    }
    // A role is metadata and may be corrected even on a no_change declaration.
    if (declared.role !== undefined) {
      existing.role = normalizeRole(declared.role, existing.role)
    }
    if (declared.action === 'updated') {
      if (declared.profile !== undefined) existing.profile = { ...existing.profile, ...declared.profile }
      if (declared.current_state !== undefined || declared.unset !== undefined) {
        const before = existing.current_state
        const merged = mergeCurrentState(before, declared.current_state ?? {}, declared.unset ?? [])
        validateResources(merged, `characters.${name}`, allowNegative, before)
        existing.current_state = merged
      }
      if (declared.growth !== undefined) {
        existing.growth.push({ ...declared.growth, chapter })
      }
      existing.updated_at = chapter
    }
  }

  const resourceSeen = new Map<string, number>()
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
    if (!Object.hasOwn(delta.characters, change.character)) {
      fail(`resource change for "${change.character}" has no character declaration`)
    }
    if (delta.characters[change.character]!.action === 'no_change') {
      fail(`resource change for "${change.character}" conflicts with a no_change declaration`)
    }
    const character = byName.get(change.character)
    if (character === undefined) fail(`resource change names unknown character "${change.character}"`)
    if (!Number.isInteger(change.delta) || change.delta === 0) {
      fail(`resource change for "${change.character}" must have a non-zero integer delta`, {
        field: `summary.resource_changes[${change.character}.${change.resource}].delta`,
        expected: 'non-zero integer',
        received: change.delta,
        received_type: typeof change.delta,
      })
    }
    const pair = `${change.character}\u0000${change.resource}`
    const previousDelta = resourceSeen.get(pair)
    if (previousDelta === change.delta) {
      throw new EngineInputError(
        ERROR_CODES.RESOURCE_DOUBLE_COUNT,
        `${change.character} ${change.resource} appears twice with the same delta ${change.delta}`,
        'each resource change must appear once; merge the duplicate rows (resource_changes is the only incremental channel)',
        {
          details: {
            field: 'summary.resource_changes',
            expected: 'one row per character+resource+delta',
            received: { character: change.character, resource: change.resource, delta: change.delta },
          },
        },
      )
    }
    resourceSeen.set(pair, change.delta)
    // The absolute channel is current_state.resources; the incremental channel
    // is summary.resource_changes. Writing both is the silent double count this
    // version refuses instead of guessing which one the author meant.
    const declaredResources = delta.characters[change.character]?.current_state?.resources
    if (isRecord(declaredResources) && Object.hasOwn(declaredResources, change.resource)) {
      const absolute = declaredResources[change.resource]
      const original = originalBalances.get(pair) ?? 0
      throw new EngineInputError(
        ERROR_CODES.RESOURCE_DOUBLE_COUNT,
        `${change.character} ${change.resource}: set ${String(absolute)} (absolute) and ${change.delta} (increment) in one delta; original ${original}, set result ${String(absolute)}, add result ${original + change.delta}`,
        'pick one channel: current_state.resources is an absolute set, summary.resource_changes[].delta is an increment',
        {
          details: {
            field: `characters.${change.character}.current_state.resources.${change.resource}`,
            expected: 'exactly one of set or add',
            received: {
              original,
              set: absolute,
              delta: change.delta,
              set_result: absolute,
              add_result: original + change.delta,
            },
            allowed: ['current_state.resources (set)', 'summary.resource_changes (add)'],
          },
        },
      )
    }
    const state = isRecord(character.current_state) ? character.current_state : {}
    const resources: Record<string, unknown> = isRecord(state.resources) ? { ...state.resources } : {}
    const current =
      typeof resources[change.resource] === 'number' ? (resources[change.resource] as number) : 0
    const next = current + change.delta
    if (next < 0 && !allowNegative) {
      throw new EngineInputError(
        ERROR_CODES.RESOURCE_NEGATIVE_BALANCE,
        `${change.character} ${change.resource}: original ${current}, change ${change.delta}, result ${next}`,
        'set novel.yaml targets.allow_negative_balances=true for debt, or earn the balance before spending it',
        {
          details: {
            field: `summary.resource_changes[${change.character}.${change.resource}].delta`,
            expected: 'result >= 0',
            received: { original: current, delta: change.delta, result: next },
            allowed: ['reduce the delta', 'raise the balance first', 'allow_negative_balances: true'],
          },
        },
      )
    }
    resources[change.resource] = next
    character.current_state = { ...state, resources }
    validateResources(character.current_state, `characters.${change.character}`, allowNegative, state)
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

  const anchorsForKind = (
    kind: 'location' | 'ability' | 'artifact' | 'faction' | 'rule' | null,
    name: string,
  ): string[] => {
    if (kind === 'location') return anchorsForGroup(anchors, 'locations', name)
    if (kind === 'ability') return anchorsForGroup(anchors, 'abilities', name)
    if (kind === 'artifact') return anchorsForGroup(anchors, 'artifacts', name)
    return []
  }

  const requireText = (
    name: string,
    kind: 'location' | 'ability' | 'artifact' | 'faction' | 'rule' | null,
    context: string,
  ): string[] => {
    const candidates = anchorsForKind(kind, name)
    const match = matchEntityText(input.text, name, candidates)
    if (!match.ok) fail(`${context} ${entityMatchHint(name, candidates)}`)
    return candidates
  }

  // `summary.new_elements` is a narrative intent declaration, not a second
  // write action. Validate its names against the text/kind, but let the world
  // ledger decide whether the actual write is created or updated.
  for (const [kind, names] of [
    ['location', summary.new_elements.locations],
    ['ability', summary.new_elements.abilities],
    ['artifact', summary.new_elements.artifacts],
  ] as const) {
    for (const name of names) {
      requireText(name, kind, `summary lists new ${kind} "${name}" but the manuscript never mentions it;`)
      if (!Object.hasOwn(delta.world, name)) {
        fail(`summary lists new ${kind} "${name}" but world.${name} is not declared`)
      }
      const declared = delta.world[name]!
      if (declared.kind !== undefined && declared.kind !== kind) {
        fail(`world.${name} is declared as ${declared.kind} but the summary lists it as ${kind}`)
      }
      if (findWorld(name) !== null) {
        warnings.push({
          code: 'WORLD_ELEMENT_ALREADY_IN_LEDGER',
          message: `summary.new_elements lists "${name}", but state/world.yaml already has it; ledger existence wins`,
        })
      }
    }
  }

  for (const [name, raw] of Object.entries(delta.world)) {
    assertDeltaKeys(raw, 'world', `world.${name}`, name)
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
    if (expected !== null && declared.kind !== undefined && declared.kind !== expected) {
      fail(`world.${name} is declared as ${declared.kind} but the summary lists it as ${expected}`)
    }
    const existing = findWorld(name)
    let entityAnchors = anchorsForKind(declared.kind ?? expected, name)
    let action: DeltaAction = declared.action
    if (action === 'created' && existing !== null) {
      if (declared.kind !== undefined && declared.kind !== existing.kind) {
        fail(
          `world.${name} is declared as ${declared.kind} but the ledger has ${existing.kind}; kind cannot change`,
        )
      }
      if (expected !== null && expected !== existing.kind) {
        fail(`world.${name} is listed as ${expected} but the ledger has ${existing.kind}`)
      }
      action = 'updated'
      warnReclass(name, 'created', 'updated', 'existing-created-as-updated')
    } else if (action === 'updated' && existing === null) {
      const kind = declared.kind ?? expected
      if (kind === null) {
        fail(
          `world.${name} does not exist; declare kind (location|ability|artifact|faction|rule) or list it in summary.new_elements`,
        )
      }
      entityAnchors = requireText(
        name,
        kind,
        `world entity "${name}" is new but does not appear in the manuscript;`,
      )
      action = 'created'
      warnReclass(name, 'updated', 'created', 'missing-updated-as-created')
    } else if (action === 'no_change' && existing === null && expected !== null) {
      entityAnchors = requireText(
        name,
        expected,
        `world entity "${name}" is new but does not appear in the manuscript;`,
      )
      action = 'created'
      warnReclass(name, 'no_change', 'created', 'missing-no-change-as-created')
    }
    if (declared.detail !== undefined && action !== 'created') {
      for (const reserved of ['name', 'first_appearance', 'description'] as const) {
        if (Object.hasOwn(declared.detail, reserved)) {
          fail(`world.${name}.detail cannot rewrite the reserved field "${reserved}"`)
        }
      }
    }
    if (action === 'created') {
      if (name.trim() === '') fail('a created world entity has an empty name')
      if (existing !== null) fail(`world entity "${name}" already exists; use updated or no_change`)
      const kind = declared.kind ?? expected
      if (kind === null) fail(`world.${name} must declare kind (location|ability|artifact|faction|rule)`)
      entityAnchors = requireText(
        name,
        kind,
        `world entity "${name}" is created but does not appear in the manuscript;`,
      )
      if (!['location', 'ability', 'artifact', 'faction', 'rule'].includes(kind)) {
        fail(`world.${name} has unknown kind "${String(kind)}"`)
      }
      if (
        declared.action === 'created' &&
        expected === null &&
        (kind === 'location' || kind === 'ability' || kind === 'artifact')
      ) {
        fail(`world.${name} is created but is not listed in summary.new_elements`)
      }
      if (kind === 'location') {
        world.locations.push({
          name,
          first_appearance: chapter,
          locked: true,
          description: declared.description ?? '',
          layout: declared.layout ?? '',
          capacity: declared.capacity ?? 0,
          ...(entityAnchors.length === 0 ? {} : { anchors: entityAnchors }),
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
          ...(declared.detail ?? {}),
          name,
          first_appearance: chapter,
          description: declared.description ?? '',
          ...(entityAnchors.length === 0 ? {} : { anchors: entityAnchors }),
        })
      }
      continue
    }
    if (existing === null) fail(`world entity "${name}" does not exist; created must be used first`)
    if (declared.kind !== undefined && existing.kind !== declared.kind) {
      fail(
        `world.${name} is declared as ${declared.kind} but the ledger has ${existing.kind}; kind cannot change`,
      )
    }
    if (action === 'updated') {
      if (existing.kind === 'location') {
        const location = existing.value as WorldDocument['locations'][number]
        if (declared.description !== undefined) location.description = declared.description
        if (declared.layout !== undefined) location.layout = declared.layout
        if (declared.capacity !== undefined) location.capacity = declared.capacity
        if (entityAnchors.length > 0) location.anchors = mergeEntityAnchors(location.anchors, entityAnchors)
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
        if (entityAnchors.length > 0) {
          existing.value.anchors = mergeEntityAnchors(existing.value.anchors, entityAnchors)
        }
      }
    }
  }

  for (const name of appeared) {
    if (!Object.hasOwn(locks.characters, name)) {
      const character = byName.get(name)!
      setOwn(locks.characters, name, {
        first_appearance: character.first_appearance,
        locked_at: chapter,
        appearance: appearanceOf(input.text, name, narratorAliasesFor(name, narrator)),
      })
    }
  }
  for (const location of world.locations) {
    if (!Object.hasOwn(locks.locations, location.name)) {
      setOwn(locks.locations, location.name, {
        first_appearance: location.first_appearance,
        locked_at: chapter,
        layout: location.layout,
        capacity: location.capacity,
      })
    }
  }
  locks.locked_at_chapter = Math.max(locks.locked_at_chapter, chapter)

  const byId = new Map(foreshadows.items.map((item) => [item.id, item]))
  const plantedKeys = new Set<string>()
  for (const plant of summary.foreshadows.planted) {
    if (plant.key.trim() === '') fail('a planted foreshadow has an empty key')
    if (byId.has(plant.key)) fail(`foreshadow key "${plant.key}" collides with an existing id`)
    if (plantedKeys.has(plant.key)) fail(`foreshadow key "${plant.key}" is planted twice`)
    plantedKeys.add(plant.key)
    if (!Object.hasOwn(delta.foreshadows, plant.key)) {
      fail(`foreshadows.${plant.key} is not declared`)
    }
    assertDeltaKeys(delta.foreshadows[plant.key], 'foreshadows', `foreshadows.${plant.key}`)
    const declared = entry<ForeshadowDelta>(delta.foreshadows[plant.key], `foreshadows.${plant.key}`)
    requireReason(declared, `foreshadows.${plant.key}`)
    requireForeshadowFields(declared, `foreshadows.${plant.key}`)
    if (declared.action !== 'created') fail(`foreshadows.${plant.key} is planted; its action must be created`)
    if (typeof plant.title !== 'string' || plant.title.trim() === '') {
      fail(`foreshadow "${plant.key}" has an empty summary title`)
    }
    if (plant.anchor !== undefined && !anchorIsStrong(plant.anchor)) {
      fail(
        `foreshadow "${plant.key}" anchor must be a verbatim quote of at least ${ANCHOR_MIN_CHARS} characters`,
      )
    }
    if (
      plant.planned_resolve !== undefined &&
      plant.planned_resolve !== null &&
      (!Number.isInteger(plant.planned_resolve) || plant.planned_resolve < 1)
    ) {
      fail(`foreshadow "${plant.key}" planned_resolve must be a positive integer or null`)
    }
    if (plant.kind !== undefined && plant.kind !== 'plot' && plant.kind !== 'motif') {
      fail(`foreshadow "${plant.key}" kind must be plot|motif`)
    }
    if (declared.title !== undefined && typeof declared.title !== 'string') {
      fail(`foreshadows.${plant.key}.title must be a string`)
    }
    const plantedKind = declared.kind ?? plant.kind ?? 'plot'
    const plannedResolve =
      declared.planned_resolve !== undefined ? declared.planned_resolve : plant.planned_resolve
    if (plantedKind === 'plot' && (plannedResolve === undefined || plannedResolve === null)) {
      if (input.strict === true) {
        throw new EngineInputError(
          ERROR_CODES.FORESHADOW_UNPLANNED,
          `strict mode: plot foreshadow "${plant.key}" has no planned_resolve chapter`,
          'add planned_resolve (the chapter that pays it off) or declare kind:"motif"; a plot thread without a plan is not tracking, it is a note',
          {
            details: {
              field: `summary.foreshadows.planted[${plant.key}].planned_resolve`,
              expected: 'a positive chapter number',
              received: plannedResolve ?? null,
              example: { planned_resolve: chapter + 3 },
            },
          },
        )
      }
      warnings.push({
        code: 'FORESHADOW_UNPLANNED',
        message: `plot foreshadow ${plant.key} "${plant.title}" has no planned_resolve; strict mode would refuse it`,
      })
    }
    const title = declared.title ?? plant.title
    if (title.trim() === '') fail(`foreshadow "${plant.key}" has an empty title`)
    if (Array.from(title.trim()).length < 2 || Array.from(title.trim()).length > 16) {
      fail(`foreshadow "${plant.key}" title must contain 2..16 characters`)
    }
    // `title` is the human-readable ledger label. Verification uses the
    // explicit anchor when supplied; old chapters without anchors keep the
    // previous "title must appear" rule, so both formats stay valid.
    const anchor = declared.anchor ?? plant.anchor
    if (anchor === undefined) {
      if (!input.text.includes(plant.title)) {
        fail(
          `planted foreshadow summary title "${plant.title}" has no anchor and does not appear verbatim in the manuscript`,
        )
      }
      if (!input.text.includes(title)) {
        fail(
          `planted foreshadow "${title}" has no anchor and does not appear verbatim in the manuscript; add a verbatim anchor or keep the title as text`,
        )
      }
    } else if (!matchEvidence(input.text, anchor).found) {
      fail(`planted foreshadow "${title}" anchor "${anchor}" does not appear verbatim in the manuscript`, {
        field: `foreshadows.${plant.key}.anchor`,
        expected: 'a verbatim quote from this chapter',
        received: anchor,
        nearest: nearestParagraph(input.text, anchor),
      })
    }
    const allocated = allocateIds('FS', foreshadows.next_seq, 1)
    const id = allocated.ids[0]!
    if (byId.has(id)) fail(`foreshadows.next_seq is behind the ledger; ${id} already exists`)
    foreshadows.next_seq = allocated.nextSeq
    const item = {
      id,
      title,
      planted: chapter,
      last_touched: chapter,
      status: 'planted' as const,
      resolved_at: null,
      description: declared.description ?? plant.description,
      ...(anchor === undefined ? {} : { anchor }),
      ...(Object.hasOwn(declared, 'planned_resolve') || Object.hasOwn(plant, 'planned_resolve')
        ? {
            planned_resolve: Object.hasOwn(declared, 'planned_resolve')
              ? (declared.planned_resolve ?? null)
              : (plant.planned_resolve ?? null),
          }
        : {}),
      ...(declared.kind === undefined && plant.kind === undefined
        ? {}
        : { kind: declared.kind ?? plant.kind }),
      // Read-model compatibility marker: old rows keep working, while a new
      // anchorless title verified against the manuscript is not legacy data.
      format_version: 1 as const,
      advance_log: [] as Array<{ chapter: number; note: string; new_info: boolean; anchor?: string }>,
    }
    foreshadows.items.push(item)
    byId.set(item.id, item)
    assigned[plant.key] = item.id
  }

  const advancedKeys = new Set<string>()
  for (const advance of summary.foreshadows.advanced) {
    if (advancedKeys.has(advance.key)) fail(`foreshadow "${advance.key}" is advanced twice`)
    advancedKeys.add(advance.key)
    if (!Object.hasOwn(delta.foreshadows, advance.key)) {
      fail(`foreshadows.${advance.key} is not declared`)
    }
    assertDeltaKeys(delta.foreshadows[advance.key], 'foreshadows', `foreshadows.${advance.key}`)
    const declared = entry<ForeshadowDelta>(delta.foreshadows[advance.key], `foreshadows.${advance.key}`)
    requireReason(declared, `foreshadows.${advance.key}`)
    requireForeshadowFields(declared, `foreshadows.${advance.key}`)
    if (declared.anchor !== undefined && !matchEvidence(input.text, declared.anchor).found) {
      fail(`foreshadows.${advance.key}.anchor does not appear verbatim in the manuscript`, {
        field: `foreshadows.${advance.key}.anchor`,
        expected: 'a verbatim quote from this chapter',
        received: declared.anchor,
        nearest: nearestParagraph(input.text, declared.anchor),
      })
    }
    if (declared.action !== 'updated') {
      fail(`foreshadows.${advance.key} is advanced; its action must be updated`)
    }
    const id = assigned[advance.key] ?? advance.key
    const item = byId.get(id)
    if (item === undefined) fail(`foreshadow "${advance.key}" does not exist; no fallback is allowed`)
    if (item.status === 'resolved') fail(`foreshadow "${advance.key}" is already resolved`)
    item.last_touched = chapter
    item.status = 'advanced'
    if (Object.hasOwn(declared, 'planned_resolve')) {
      item.planned_resolve = declared.planned_resolve ?? null
    }
    if (declared.kind !== undefined) item.kind = declared.kind
    item.advance_log.push({
      chapter,
      note: declared.note ?? advance.note,
      new_info: declared.new_info ?? advance.new_info,
      ...(declared.anchor === undefined ? {} : { anchor: declared.anchor }),
    })
    assigned[advance.key] = item.id
  }

  for (const key of summary.foreshadows.resolved) {
    if (!Object.hasOwn(delta.foreshadows, key)) {
      fail(`foreshadows.${key} is not declared`)
    }
    assertDeltaKeys(delta.foreshadows[key], 'foreshadows', `foreshadows.${key}`)
    const declared = entry<ForeshadowDelta>(delta.foreshadows[key], `foreshadows.${key}`)
    requireReason(declared, `foreshadows.${key}`)
    requireForeshadowFields(declared, `foreshadows.${key}`)
    if (declared.action !== 'updated') {
      fail(`foreshadows.${key} is resolved; its action must be updated`)
    }
    const id = assigned[key] ?? key
    const item = byId.get(id)
    if (item === undefined) fail(`foreshadow "${key}" does not exist; no fallback is allowed`)
    if (item.status === 'resolved') fail(`foreshadow "${key}" is already resolved`)
    if (declared.resolved_anchor === undefined) {
      fail(`foreshadow "${key}" resolved without resolved_anchor; a note cannot replace manuscript evidence`)
    }
    if (!matchEvidence(input.text, declared.resolved_anchor).found) {
      fail(`foreshadow "${key}" resolved_anchor does not appear verbatim in the manuscript`, {
        field: `foreshadows.${key}.resolved_anchor`,
        expected: 'a verbatim quote from this chapter',
        received: declared.resolved_anchor,
        nearest: nearestParagraph(input.text, declared.resolved_anchor),
      })
    }
    item.status = 'resolved'
    item.last_touched = chapter
    item.resolved_at = chapter
    item.resolved_anchor = declared.resolved_anchor
    if (Object.hasOwn(declared, 'planned_resolve')) {
      item.planned_resolve = declared.planned_resolve ?? null
    }
    if (declared.kind !== undefined) item.kind = declared.kind
    item.advance_log.push({
      chapter,
      note: declared.note?.trim() === '' || declared.note === undefined ? 'resolved' : declared.note,
      new_info: declared.new_info ?? true,
      anchor: declared.resolved_anchor,
    })
    assigned[key] = item.id
  }

  const consumed = new Set([
    ...plantedKeys,
    ...summary.foreshadows.advanced.map((advance) => advance.key),
    ...summary.foreshadows.resolved,
  ])
  for (const [key, raw] of Object.entries(delta.foreshadows)) {
    if (consumed.has(key)) continue
    assertDeltaKeys(raw, 'foreshadows', `foreshadows.${key}`)
    const declared = entry<ForeshadowDelta>(raw, `foreshadows.${key}`)
    requireReason(declared, `foreshadows.${key}`)
    requireForeshadowFields(declared, `foreshadows.${key}`)
    if (declared.anchor !== undefined && !matchEvidence(input.text, declared.anchor).found) {
      fail(`foreshadows.${key}.anchor does not appear verbatim in the manuscript`, {
        field: `foreshadows.${key}.anchor`,
        expected: 'a verbatim quote from this chapter',
        received: declared.anchor,
        nearest: nearestParagraph(input.text, declared.anchor),
      })
    }
    const item = byId.get(key)
    if (item === undefined) fail(`foreshadow "${key}" is not in the ledger`)
    if (declared.action === 'created') fail(`foreshadow "${key}" already exists`)
    if (declared.action === 'updated') {
      item.last_touched = chapter
      if (declared.planned_resolve !== undefined) item.planned_resolve = declared.planned_resolve
      if (declared.kind !== undefined) item.kind = declared.kind
      if (declared.note !== undefined) {
        item.advance_log.push({
          chapter,
          note: declared.note,
          new_info: declared.new_info ?? false,
          ...(declared.anchor === undefined ? {} : { anchor: declared.anchor }),
        })
      }
    }
  }

  const eventKeys = summary.events.map((event, index) => eventKeyFor(chapter, index, event))
  for (const [index, event] of summary.events.entries()) {
    const key = String(index)
    const stableKey = eventKeys[index]!
    const rawTimeline = delta.timeline[stableKey] ?? delta.timeline[key]
    if (rawTimeline !== undefined) {
      assertDeltaKeys(rawTimeline, 'timeline', `timeline.${stableKey}`)
    }
    const declared = entry<TimelineDelta>(rawTimeline, `timeline.${stableKey}`)
    if (declared.action !== 'created') {
      fail(`timeline.${stableKey} is a new event; its action must be created`)
    }
    if (
      declared.characters !== undefined &&
      (!Array.isArray(declared.characters) ||
        declared.characters.some((character) => typeof character !== 'string'))
    ) {
      fail(`timeline.${stableKey}.characters must be a string array`)
    }
    for (const character of declared.characters ?? []) {
      if (byName.get(character) === undefined) {
        fail(`timeline.${stableKey} names unknown character "${character}"`)
      }
    }
    const allocated = allocateIds('TE', timeline.next_seq, 1)
    const id = allocated.ids[0]!
    if (timeline.items.some((item) => item.id === id)) {
      fail(`timeline.next_seq is behind the ledger; ${id} already exists`)
    }
    timeline.next_seq = allocated.nextSeq
    timeline.items.push({
      id,
      chapter,
      story_time: declared.story_time ?? '未记录',
      description: declared.description ?? event,
      location: declared.location ?? '',
      characters: declared.characters ?? appeared,
      event_key: stableKey,
    })
    assigned[`timeline:${index}`] = id
    assigned[`timeline:${stableKey}`] = id
  }
  const validTimelineKeys = new Set([...summary.events.map((_event, index) => String(index)), ...eventKeys])
  for (const key of Object.keys(delta.timeline)) {
    if (!validTimelineKeys.has(key)) {
      fail(`timeline.${key} does not match any event in summary.events`)
    }
  }

  const pairKey = (a: string, b: string): string => `${a}|${b}`
  const findRelationship = (a: string, b: string): RelationshipsDocument['items'][number] | undefined =>
    relationships.items.find((item) => (item.a === a && item.b === b) || (item.a === b && item.b === a))
  for (const [key, raw] of Object.entries(delta.relationships)) {
    assertDeltaKeys(raw, 'relationships', `relationships.${key}`)
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
    if (
      declared.type_code !== undefined &&
      !RELATIONSHIP_TYPE_CODES.includes(declared.type_code as RelationshipTypeCode)
    ) {
      fail(`relationships.${key}.type_code must be one of ${RELATIONSHIP_TYPE_CODES.join('|')}`)
    }
    const existing = findRelationship(a, b)
    if (declared.action === 'created') {
      if (existing !== undefined) fail(`relationship ${pairKey(a, b)} already exists`)
      if (typeof declared.type !== 'string' || declared.type.trim() === '') {
        fail(`relationships.${key} is created but has no type`)
      }
      if (declared.type_code === undefined) {
        fail(
          `relationships.${key} is created but has no type_code; use one of ${RELATIONSHIP_TYPE_CODES.join('|')}`,
        )
      }
      const allocated = allocateIds('RL', relationships.next_seq, 1)
      const id = allocated.ids[0]!
      if (relationships.items.some((item) => item.id === id)) {
        fail(`relationships.next_seq is behind the ledger; ${id} already exists`)
      }
      relationships.next_seq = allocated.nextSeq
      relationships.items.push({
        id,
        a,
        b,
        type: declared.type!,
        type_code: declared.type_code!,
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
      if (declared.type_code !== undefined) existing.type_code = declared.type_code
      if (declared.description !== undefined) existing.description = declared.description
      if (declared.note !== undefined) existing.evolution.push({ chapter, note: declared.note })
    }
    assigned[key] = existing.id
  }

  return {
    characters,
    world,
    locks,
    foreshadows,
    timeline,
    relationships,
    assigned,
    warnings,
    normalized_world: normalizedWorld,
  }
}
