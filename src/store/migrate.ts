import { randomUUID } from 'node:crypto'
import { parse as parseYaml, stringify } from 'yaml'
import { BACKUP_DIR } from '../constants.js'
import { SCHEMA_VERSION, ERROR_CODES, EngineFaultError } from '../types.js'
import { joinRel, type FsStore } from './fs.js'

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

/**
 * Read-time normalization for a 0.2.0 check: it had no `scope` and stored
 * advisories inside `violations`. Returning a normalized copy keeps the stored
 * audit byte-identical, lets `narrow` accept the document, and stops restore
 * from replaying an advisory as a blocker (U16/X5).
 */
export function normalizeLegacyCheck(document: Record<string, unknown>): Record<string, unknown> {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  const record = structuredClone(document)
  let legacy = false
  if (!Array.isArray(record.scope)) {
    record.scope = ['content', 'integrity']
    legacy = true
  }
  if (isRecord(record.machine)) {
    const machine = record.machine
    if (Array.isArray(machine.violations)) {
      const advisories = Array.isArray(machine.advisories) ? [...machine.advisories] : []
      const blockers: unknown[] = []
      for (const entry of machine.violations) {
        if (isRecord(entry) && entry.severity === 'advisory') {
          advisories.push(entry)
          legacy = true
        } else {
          blockers.push(entry)
        }
      }
      machine.violations = blockers
      if (advisories.length > 0) machine.advisories = advisories
    }
  }
  if (legacy) record.legacy_format = true
  return record
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
    if (!Number.isInteger(step.to) || step.to <= version || step.to > target) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_INVALID,
        `migration step ${version}->${step.to} does not advance monotonically to ${target}`,
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
  const beforeText = before.toString('utf8')
  let parsed: unknown
  try {
    parsed = parseYaml(beforeText)
  } catch (error) {
    throw new EngineFaultError(
      ERROR_CODES.SCHEMA_INVALID,
      `cannot migrate ${path}: invalid YAML`,
      undefined,
      { cause: error },
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EngineFaultError(
      ERROR_CODES.SCHEMA_INVALID,
      `cannot migrate ${path}: document is not a mapping`,
    )
  }
  const document = parsed as Record<string, unknown>
  const version = typeof document.schema_version === 'number' ? document.schema_version : 1
  if (version >= target) return false
  const migrated = migrateDocument(document, chain, target)
  const next = stringify(migrated, { lineWidth: 0 })
  if (next === beforeText) return false
  // Persist the pre-image before touching the document. In-memory rollback is
  // enough for an ordinary error, but a process kill needs a recovery source.
  const backupPath = joinRel(BACKUP_DIR, 'migrations', `${randomUUID()}-${path.replace(/[\\/]/g, '__')}`)
  await store.writeBytes(backupPath, before)
  try {
    await store.writeText(path, next)
    return true
  } catch (error) {
    const current = await store.readBytes(path)
    if (current === null || !Buffer.from(current).equals(before)) {
      await store.writeBytes(path, before)
    }
    throw error
  }
}

/**
 * Migrate a set of related documents as one unit. A failure on a later file
 * restores every earlier file, so a project is never left half-migrated.
 */
export async function migrateProjectFiles(
  store: FsStore,
  paths: readonly string[],
  chain: readonly MigrationStep[] = MIGRATIONS,
  target: number = SCHEMA_VERSION,
): Promise<boolean[]> {
  const before = new Map<string, Uint8Array | null>()
  for (const path of paths) before.set(path, await store.readBytes(path))
  const results: boolean[] = []
  try {
    for (const path of paths) results.push(await migrateProjectFile(store, path, chain, target))
    return results
  } catch (error) {
    for (const [path, bytes] of before) {
      if (bytes === null) await store.remove(path)
      else await store.writeBytes(path, bytes)
    }
    throw error
  }
}
