import { ERROR_CODES, EngineInputError } from '../types.js'

/** The three `summary.new_elements` groups that may carry anchors. */
export const NEW_ELEMENT_GROUPS = ['locations', 'abilities', 'artifacts'] as const
export type NewElementGroup = (typeof NEW_ELEMENT_GROUPS)[number]

/**
 * Entity anchors are verbatim evidence, not just locators: a two-character
 * anchor such as 门口 matches half the book. The floor is the same 8 characters
 * used by foreshadow and resolved anchors; a short entity name still matches
 * through the name fallback in `matchEntityText`.
 */
export const ANCHOR_MIN_CHARS = 8
export const ANCHOR_MAX_CHARS = 120
export const ANCHOR_MAX_COUNT = 8

export type AnchorMap = Record<NewElementGroup, Record<string, string[]>>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const invalid = (detail: string): never => {
  throw new EngineInputError(
    ERROR_CODES.SCHEMA_INVALID,
    detail,
    'new_element_anchors maps each new entity name to 1..8 verbatim anchors of 8..120 characters',
  )
}

export const emptyAnchorMap = (): AnchorMap => ({
  locations: {},
  abilities: {},
  artifacts: {},
})

/** Trim, de-duplicate and validate one explicit anchor list. */
export function normalizeAnchors(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) invalid(`${where} must be an array of strings`)
  const list = value as unknown[]
  const result: string[] = []
  const seen = new Set<string>()
  for (const [index, raw] of list.entries()) {
    if (typeof raw !== 'string') invalid(`${where}[${index}] must be a string`)
    const anchor = (raw as string).trim()
    const length = Array.from(anchor).length
    if (length < ANCHOR_MIN_CHARS || length > ANCHOR_MAX_CHARS) {
      invalid(`${where}[${index}] must contain ${ANCHOR_MIN_CHARS}..${ANCHOR_MAX_CHARS} characters`)
    }
    if (seen.has(anchor)) continue
    seen.add(anchor)
    result.push(anchor)
  }
  if (result.length > ANCHOR_MAX_COUNT) {
    invalid(`${where} contains ${result.length} unique anchors; limit is ${ANCHOR_MAX_COUNT}`)
  }
  return result
}

/**
 * Parse the optional chapter-level anchor map. Keys must name an entity in the
 * matching `new_elements` group; an unknown key is a schema error, not a
 * silently ignored instruction.
 */
export function normalizeNewElementAnchors(
  value: unknown,
  namesByGroup: Record<NewElementGroup, readonly string[]>,
): AnchorMap {
  const result = emptyAnchorMap()
  if (value === undefined) return result
  if (!isRecord(value)) invalid('new_element_anchors must be an object')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(NEW_ELEMENT_GROUPS as readonly string[]).includes(key)) {
      invalid(`new_element_anchors has unknown group "${key}"`)
    }
  }
  for (const group of NEW_ELEMENT_GROUPS) {
    const rawGroup = record[group]
    if (rawGroup === undefined) continue
    if (!isRecord(rawGroup)) invalid(`new_element_anchors.${group} must be an object`)
    const groupRecord = rawGroup as Record<string, unknown>
    for (const [name, rawAnchors] of Object.entries(groupRecord)) {
      if (!namesByGroup[group].includes(name)) {
        invalid(`new_element_anchors.${group} names "${name}", but new_elements.${group} has no such entity`)
      }
      const anchors = normalizeAnchors(rawAnchors, `new_element_anchors.${group}.${name}`)
      if (anchors.length > 0) result[group][name] = anchors
    }
  }
  return result
}

/** Read the declared new-element names from a summary without trusting its shape. */
export const newElementNames = (summary: unknown): Record<NewElementGroup, string[]> => {
  const record = isRecord(summary) ? summary : {}
  const elements = (isRecord(record.new_elements) ? record.new_elements : {}) as Record<string, unknown>
  const names = (group: NewElementGroup): string[] =>
    Array.isArray(elements[group])
      ? elements[group].filter((name): name is string => typeof name === 'string')
      : []
  return {
    locations: names('locations'),
    abilities: names('abilities'),
    artifacts: names('artifacts'),
  }
}

/** Normalize anchors for one summary; returns an empty map when omitted. */
export function anchorsFromSummary(summary: unknown): AnchorMap {
  if (!isRecord(summary)) return emptyAnchorMap()
  return normalizeNewElementAnchors(summary.new_element_anchors, newElementNames(summary))
}

export function anchorsForGroup(anchors: AnchorMap, group: NewElementGroup, name: string): string[] {
  return anchors[group][name] ?? []
}

export interface EntityMatch {
  ok: boolean
  matched: string | null
  attempted: string[]
  usedFallback: boolean
}

/**
 * The single name/anchor matcher used by PG-05 and state-delta. Explicit
 * anchors win; only an entity with no anchors falls back to its readable name.
 */
export function matchEntityText(text: string, name: string, anchors: readonly string[] = []): EntityMatch {
  const attempted = anchors.length > 0 ? [...anchors] : [name]
  const matched = attempted.find((anchor) => anchor !== '' && text.includes(anchor)) ?? null
  return { ok: matched !== null, matched, attempted, usedFallback: anchors.length === 0 }
}

export function entityMatchHint(name: string, anchors: readonly string[]): string {
  if (anchors.length === 0) {
    return `provide summary.new_element_anchors for "${name}", or write the name verbatim in the manuscript`
  }
  return `none of the anchors for "${name}" appears verbatim (${anchors.join(' / ')}); add a matching anchor or use a scene name that is actually in the manuscript`
}

/** Persist anchors on a world row without overwriting old anchors that are not repeated. */
export function mergeEntityAnchors(existing: unknown, incoming: readonly string[]): string[] {
  const old = Array.isArray(existing)
    ? existing.filter((anchor): anchor is string => typeof anchor === 'string')
    : []
  const merged: string[] = []
  const seen = new Set<string>()
  for (const anchor of [...old, ...incoming]) {
    const value = anchor.trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    merged.push(value)
    if (merged.length === ANCHOR_MAX_COUNT) break
  }
  return merged
}

/** A shape-safe name reader for world rows; `[null]` must never crash a gate. */
export function worldEntityName(row: unknown): string | null {
  if (!isRecord(row) || typeof row.name !== 'string' || row.name.trim() === '') return null
  return row.name.trim()
}

export interface LockBaseline {
  source: 'worldbook' | 'world_anchors' | 'locks'
  texts: string[]
}

const shortAnchors = (text: string): string[] =>
  text
    .split(/[。！？；;\n]/)
    .map((part) => part.trim())
    .filter((part) => Array.from(part).length >= 8 && Array.from(part).length <= 60)
    .slice(0, 3)

/**
 * 0.2.13 canonical lock baseline: the worldbook description first, then
 * readable short anchors. A raw first-appearance paragraph is evidence, not
 * the standard every later chapter must repeat verbatim.
 */
export function resolveLockBaseline(
  name: string,
  kind: 'character' | 'location',
  input: {
    worldbook?: import('../types.js').WorldbookDocument | null
    world?: import('../types.js').WorldDocument | null
    locks?: import('../types.js').LocksDocument | null
  },
): LockBaseline | null {
  const texts: string[] = []
  let source: LockBaseline['source'] = 'locks'
  const add = (value: string | undefined): void => {
    if (value === undefined) return
    const trimmed = value.trim()
    if (trimmed !== '' && !texts.includes(trimmed)) texts.push(trimmed)
  }
  if (kind === 'character') {
    const fromBook = input.worldbook?.characters.find((entry) => entry.name === name)
    if (fromBook !== undefined) {
      // `description` is a biography in real worldbooks; comparing prose to it
      // is exactly the false positive 0.2.13 retires. Only an explicit
      // appearance is a canonical visual baseline. When a worldbook row exists
      // without appearance, do not fall back to the first-appearance paragraph:
      // that re-creates the same three false positives. Doctor reports the
      // missing baseline instead.
      add(fromBook.appearance)
      if (texts.length > 0) source = 'worldbook'
      return texts.length === 0 ? null : { source, texts }
    }
  } else {
    const fromBook = input.worldbook?.locations.find((entry) => entry.name === name)
    add(fromBook?.description)
    add(fromBook?.layout)
    if (texts.length > 0) source = 'worldbook'
    const fromWorld = input.world?.locations.find((entry) => entry.name === name)
    if ((fromWorld?.anchors?.length ?? 0) > 0) {
      const hadWorldbookText = texts.length > 0
      for (const anchor of fromWorld!.anchors!) add(anchor)
      // The worldbook remains the canonical owner when it supplied text;
      // world anchors are only the fallback source when it did not.
      if (!hadWorldbookText) source = 'world_anchors'
    }
  }
  if (texts.length === 0) {
    const lock = kind === 'character' ? input.locks?.characters[name] : input.locks?.locations[name]
    const raw =
      kind === 'character'
        ? (lock as { appearance?: string } | undefined)?.appearance
        : (lock as { layout?: string } | undefined)?.layout
    if (raw !== undefined) {
      for (const anchor of shortAnchors(raw)) add(anchor)
      if (texts.length > 0) source = 'locks'
    }
  }
  return texts.length === 0 ? null : { source, texts }
}
