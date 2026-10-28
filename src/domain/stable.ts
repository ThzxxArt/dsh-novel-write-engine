/**
 * Locale-independent ordering and hashing primitives.
 *
 * A digest must not depend on the process locale. `localeCompare` can reorder
 * CJK keys differently under different ICU collations, so every persisted sort
 * and every digest uses UTF-16 code-unit order instead.
 */
export const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const normalize = (input: unknown): unknown => {
  if (Array.isArray(input)) return input.map(normalize)
  if (input instanceof Date) return input
  if (
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { toJSON?: unknown }).toJSON === 'function'
  ) {
    // Let JSON.stringify invoke toJSON; rebuilding it as a plain object would
    // erase the value and make every Date-bearing digest collide on `{}`.
    return input
  }
  if (typeof input === 'object' && input !== null) {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, value]) => [key, normalize(value)]),
    )
  }
  return input
}

/** Deterministic JSON used by every replay key and digest. */
export const stableJson = (value: unknown): string => JSON.stringify(normalize(value)) ?? 'null'
