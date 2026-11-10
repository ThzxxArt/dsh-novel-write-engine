import { parse } from 'yaml'
import { readBundledText } from './assets.js'
import { ERROR_CODES, EngineFaultError } from './types.js'
import { compileStyleCatalogue, type StyleProblem } from './rules/style.js'
import type { StylePack } from './rules/types.js'

/**
 * 0.2.17 bundled style catalogue.
 *
 * The index is the source of truth for *which* packs exist. Reading only what it
 * names means a stray YAML file cannot become an option the user can pick, and
 * the `check:docs` assertion (`builtin packs == 8`) has one number to compare.
 */

/** Path of the bundled index, for diagnostics and CLI validation. */
export function bundledStyleIndexPath(): string {
  return 'stylepacks/index.yaml'
}

/**
 * Injection point for the bundled reader.
 *
 * The index's failure modes (missing file, bad YAML, no entries, repeats) are
 * packaging faults that must be rejected, and they are unreachable if the only
 * reader is the real filesystem. A test passes a stub here.
 */
export interface StyleIndexOptions {
  read?: (relativePath: string) => string
}

/** Read and validate the index. A broken index is a packaging fault. */
export function loadStyleIndex(options: StyleIndexOptions = {}): string[] {
  const read = options.read ?? readBundledText
  let text: string
  try {
    text = read(bundledStyleIndexPath())
  } catch (error) {
    throw new EngineFaultError(
      ERROR_CODES.CONFIG_INVALID,
      'cannot read the bundled style-pack index',
      'reinstall the plugin',
      { cause: error },
    )
  }
  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    throw new EngineFaultError(ERROR_CODES.CONFIG_INVALID, 'cannot parse stylepacks/index.yaml', undefined, {
      cause: error,
    })
  }
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const packs = Array.isArray(record.packs) ? record.packs : []
  const ids = packs.filter((id): id is string => typeof id === 'string' && id !== '')
  if (ids.length === 0) {
    throw new EngineFaultError(ERROR_CODES.CONFIG_INVALID, 'stylepacks/index.yaml names no packs')
  }
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
  if (duplicate !== undefined) {
    throw new EngineFaultError(ERROR_CODES.CONFIG_INVALID, `stylepacks/index.yaml repeats "${duplicate}"`)
  }
  return ids
}

/** Read one bundled pack source; a missing file is a packaging fault. */
export function readBundledStylepackText(id: string): string {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) {
    throw new EngineFaultError(ERROR_CODES.CONFIG_INVALID, `invalid style pack id "${id}"`)
  }
  return readBundledText(`stylepacks/${id}.yaml`)
}

/**
 * Compile every pack the index names.
 *
 * `zeroTolerance` comes from the compiled rulepack: C3 gives a word exactly one
 * owner, so the overlap is removed from the style side at compile time.
 */
export function loadStyleCatalogue(options: { zeroTolerance?: readonly string[] } & StyleIndexOptions = {}): {
  packs: StylePack[]
  warnings: StyleProblem[]
} {
  const read = options.read
  const ids = loadStyleIndex(options)
  const entries = ids.map((fileId) => {
    let raw: unknown
    try {
      raw = parse(read === undefined ? readBundledStylepackText(fileId) : read(`stylepacks/${fileId}.yaml`))
    } catch (error) {
      throw new EngineFaultError(
        ERROR_CODES.CONFIG_INVALID,
        `cannot parse style pack "${fileId}"`,
        undefined,
        {
          cause: error,
        },
      )
    }
    return { fileId, raw }
  })
  try {
    return compileStyleCatalogue(entries, options)
  } catch (error) {
    if (error instanceof Error && 'problems' in error) {
      const problems = (error as { problems: StyleProblem[] }).problems
      throw new EngineFaultError(
        ERROR_CODES.CONFIG_INVALID,
        `bundled style packs are invalid: ${problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ')}`,
        'this is a packaging fault; reinstall the plugin',
        { cause: error },
      )
    }
    throw error
  }
}

/**
 * Compiled catalogues, keyed by the zero-tolerance set.
 *
 * The key is not cosmetic: C3 removes every zero-tolerance word from the style
 * side at compile time, so two callers passing different sets must not share a
 * result. A single unkeyed cache let whichever caller ran first decide what
 * every later caller saw — the engine and `validate:stylepacks` could then
 * disagree about which words a pack owns.
 */
const catalogueCache = new Map<string, Map<string, StylePack>>()

/** Stable signature of a zero-tolerance set; order and repeats do not matter. */
const catalogueKey = (zeroTolerance?: readonly string[]): string =>
  zeroTolerance === undefined ? '' : [...new Set(zeroTolerance)].sort().join('\u0000')

/** Compiled packs by id. Compiled once per distinct zero-tolerance set. */
export function stylePackMap(options: { zeroTolerance?: readonly string[] } = {}): Map<string, StylePack> {
  const key = catalogueKey(options.zeroTolerance)
  const hit = catalogueCache.get(key)
  if (hit !== undefined) return hit
  const compiled = new Map(loadStyleCatalogue(options).packs.map((pack) => [pack.id, pack]))
  catalogueCache.set(key, compiled)
  return compiled
}

/** Resolve one pack; `null` means "no such bundled pack", never a throw. */
export function stylePackById(
  id: string,
  options: { zeroTolerance?: readonly string[] } = {},
): StylePack | null {
  return stylePackMap(options).get(id) ?? null
}

/**
 * Ids in index order, which is the order the CLI and the tool describe.
 *
 * `compileStyleCatalogue` sorts its output by id so digests and ETags are
 * stable; the catalogue a human reads must keep the index's grouping instead,
 * which is why this reorders rather than trusting the map's key order.
 */
export function stylePackIds(): string[] {
  const packs = stylePackMap()
  return loadStyleIndex().filter((id) => packs.has(id))
}

/** One-line summaries for `/novel style list` and the `novel_init` parameter text. */
export function stylePackSummaries(): Array<{
  id: string
  name: string
  genres: string
  description: string
}> {
  const order = loadStyleIndex()
  const packs = stylePackMap()
  return order
    .map((id) => packs.get(id))
    .filter((pack): pack is StylePack => pack !== undefined)
    .map((pack) => ({
      id: pack.id,
      name: pack.name,
      genres: pack.genres.join('/'),
      description: pack.description,
    }))
}

/** Reset the process cache. Tests and CLI validation call this between fixtures. */
export function resetStylePackCache(): void {
  catalogueCache.clear()
}
