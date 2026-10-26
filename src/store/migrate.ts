import { parse as parseYaml, stringify } from 'yaml'
import { SCHEMA_VERSION, ERROR_CODES, EngineFaultError } from '../types.js'
import type { FsStore } from './fs.js'

/** One migration step: take a v(n) document and return the v(n+1) document. */
export interface MigrationStep {
  from: number
  to: number
  migrate: (document: Record<string, unknown>) => Record<string, unknown>
}

/**
 * The migration chain owned by the store. 0.1.0 ships an empty chain: there is
 * no released v1 predecessor, but the runner and its rollback contract are
 * tested with synthetic steps so a real migration cannot be written ad hoc.
 */
export const MIGRATIONS: readonly MigrationStep[] = []

/** Raised when a document is newer than this build; the caller must upgrade. */
export function assertNotTooNew(version: number): void {
  if (version > SCHEMA_VERSION) {
    throw new EngineFaultError(
      ERROR_CODES.SCHEMA_TOO_NEW,
      `schema_version ${version} is newer than supported ${SCHEMA_VERSION}`,
      'upgrade the plugin; the document was not modified',
    )
  }
}

/** Apply every step from the document version up to `target`. */
export function migrateDocument(
  document: Record<string, unknown>,
  chain: readonly MigrationStep[] = MIGRATIONS,
  target: number = SCHEMA_VERSION,
): Record<string, unknown> {
  const start = typeof document.schema_version === 'number' ? document.schema_version : 1
  assertNotTooNew(start)
  // Migrate a copy: a failing step must not partially mutate the caller's value.
  let current = structuredClone(document)
  let version = start
  while (version < target) {
    const step = chain.find((candidate) => candidate.from === version)
    if (step === undefined) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_INVALID,
        `no migration from schema_version ${version} to ${target}`,
      )
    }
    current = step.migrate(current)
    version = step.to
    current = { ...current, schema_version: version }
  }
  return current
}

/**
 * Migrate one YAML document in place with a pre-image rollback. A failing step
 * restores the exact bytes, so a project never remains half-migrated. The
 * engine has no v1 predecessor yet, but the contract is ready for the first
 * real chain and is exercised by T-09.
 */
export async function migrateProjectFile(
  store: FsStore,
  path: string,
  chain: readonly MigrationStep[] = MIGRATIONS,
  target: number = SCHEMA_VERSION,
): Promise<boolean> {
  const before = await store.readBytes(path)
  if (before === null) {
    throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, `cannot migrate missing ${path}`)
  }
  try {
    const document = parseYaml(before.toString('utf8')) as Record<string, unknown>
    const migrated = migrateDocument(document, chain, target)
    const next = stringify(migrated, { lineWidth: 0 })
    await store.writeText(path, next)
    return next !== before.toString('utf8')
  } catch (error) {
    await store.writeBytes(path, before)
    throw error
  }
}
