import { parse } from 'yaml'
import { readBundledText, readTextAt } from './assets.js'
import { compileTaxonomy, type Taxonomy } from './domain/taxonomy.js'
import { EngineFaultError, ERROR_CODES } from './types.js'

/** Path of the bundled taxonomy, for diagnostics and CLI validation. */
export function bundledTaxonomyPath(): string {
  return 'taxonomy/taxonomy.yaml'
}

let bundled: Taxonomy | undefined

/** Read, compile and cache the bundled taxonomy. */
export function loadTaxonomy(path?: string): Taxonomy {
  if (path === undefined && bundled !== undefined) return bundled
  let text: string
  try {
    text = path === undefined ? readBundledText(bundledTaxonomyPath()) : readTextAt(path)
  } catch (error) {
    throw new EngineFaultError(
      ERROR_CODES.TAXONOMY_INVALID,
      `cannot read taxonomy at ${path ?? 'bundled default'}`,
      undefined,
      { cause: error },
    )
  }
  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    throw new EngineFaultError(
      ERROR_CODES.TAXONOMY_INVALID,
      `cannot parse taxonomy at ${path ?? 'bundled default'}`,
      undefined,
      { cause: error },
    )
  }
  const compiled = compileTaxonomy(raw)
  if (path === undefined) bundled = compiled
  return compiled
}

/** Drop the process cache; tests that swap the bundled asset use this. */
export function resetTaxonomyCache(): void {
  bundled = undefined
}
