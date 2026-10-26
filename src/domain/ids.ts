import { ERROR_CODES, EngineFaultError } from '../types.js'

/** Prefixes used by the ledgers. IDs are engine-owned; models submit keys. */
export const ID_PREFIXES = ['FS', 'TE', 'RL', 'WS', 'IT', 'REV'] as const
export type IdPrefix = (typeof ID_PREFIXES)[number]

/** Render an id like `FS-007`. */
export function formatId(prefix: IdPrefix, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new EngineFaultError(ERROR_CODES.ID_EXHAUSTED, `invalid id sequence ${String(seq)} for ${prefix}`)
  }
  return `${prefix}-${String(seq).padStart(3, '0')}`
}

/** Parse the trailing number of an id, or `null` when it does not match the prefix. */
export function parseId(prefix: IdPrefix, id: string): number | null {
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id)
  if (match === null) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value > 0 ? value : null
}

/** Allocate `count` sequential ids and return both the ids and the next counter. */
export function allocateIds(
  prefix: IdPrefix,
  nextSeq: number,
  count: number,
): { ids: string[]; nextSeq: number } {
  if (!Number.isInteger(count) || count < 0) {
    throw new EngineFaultError(ERROR_CODES.ID_EXHAUSTED, `invalid allocation count ${String(count)}`)
  }
  const ids: string[] = []
  for (let offset = 0; offset < count; offset += 1) ids.push(formatId(prefix, nextSeq + offset))
  return { ids, nextSeq: nextSeq + count }
}
