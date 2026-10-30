import { ERROR_CODES, EngineInputError } from '../types.js'

/** The three `summary.new_elements` groups that may carry anchors. */
export const NEW_ELEMENT_GROUPS = ['locations', 'abilities', 'artifacts'] as const
export type NewElementGroup = (typeof NEW_ELEMENT_GROUPS)[number]

export const ANCHOR_MIN_CHARS = 2
export const ANCHOR_MAX_CHARS = 120
export const ANCHOR_MAX_COUNT = 8

export type AnchorMap = Record<NewElementGroup, Record<string, string[]>>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const invalid = (detail: string): never => {
  throw new EngineInputError(
    ERROR_CODES.SCHEMA_INVALID,
    detail,
    'new_element_anchors maps each new entity name to 1..8 verbatim anchors of 2..120 characters',
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
