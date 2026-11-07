import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { dirname } from 'node:path'
import { ensureDirAt } from '../assets.js'
import { STUDIO_SCHEMA } from './schema.js'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations.js'
import { StudioError, STUDIO_ERROR_CODES } from '../contracts/errors.js'

export type StudioOrm = BetterSQLite3Database<typeof STUDIO_SCHEMA>

export interface OpenOptions {
  readonly?: boolean
  busyTimeoutMs?: number
}

/** One process-local SQLite handle with Drizzle attached. */
export class StudioDb {
  readonly raw: Database.Database
  readonly orm: StudioOrm
  readonly path: string

  constructor(path: string, options: OpenOptions = {}) {
    this.path = path
    ensureDirAt(dirname(path))
    this.raw = new Database(path, { readonly: options.readonly ?? false })
    this.raw.pragma('journal_mode = WAL')
    this.raw.pragma('foreign_keys = ON')
    this.raw.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`)
    if (options.readonly !== true) migrate(this.raw)
    this.orm = drizzle(this.raw, { schema: STUDIO_SCHEMA })
  }

  get schemaVersion(): number {
    const row = this.raw.prepare('SELECT MAX(version) AS version FROM schema_migration').get() as
      { version: number | null } | undefined
    return row?.version ?? -1
  }

  integrity(): string {
    const rows = this.raw.pragma('integrity_check') as Array<{ integrity_check: string }>
    return rows.map((row) => row.integrity_check).join('; ')
  }

  checkpoint(): void {
    this.raw.pragma('wal_checkpoint(TRUNCATE)')
  }

  backupTo(path: string): void {
    ensureDirAt(dirname(path))
    this.raw.prepare('VACUUM INTO ?').run(path)
  }

  close(): void {
    if (this.raw.open) this.raw.close()
  }
}

function migrate(raw: Database.Database): void {
  raw.exec(
    'CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  )
  const applied = new Set(
    (raw.prepare('SELECT version FROM schema_migration').all() as Array<{ version: number }>).map(
      (row) => row.version,
    ),
  )
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    const run = raw.transaction(() => {
      raw.exec(migration.sql)
      raw
        .prepare('INSERT INTO schema_migration(version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString())
    })
    try {
      run()
    } catch (error) {
      throw new StudioError(
        STUDIO_ERROR_CODES.DB_INVALID,
        `migration ${migration.version} failed: ${error instanceof Error ? error.message : String(error)}`,
        'delete the new database or restore .studio/backups; 0.3.0 does not patch a failed migration',
        { path: 'studio.db', version: migration.version },
        { cause: error },
      )
    }
  }
  if (raw.pragma('user_version', { simple: true }) !== LATEST_SCHEMA_VERSION) {
    raw.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`)
  }
}

export function openStudioDb(path: string, options: OpenOptions = {}): StudioDb {
  try {
    return new StudioDb(path, options)
  } catch (error) {
    if (error instanceof StudioError) throw error
    throw new StudioError(
      STUDIO_ERROR_CODES.DB_INVALID,
      `cannot open studio database at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'verify Node >=24.9 and that better-sqlite3 has a prebuilt binary for this platform',
      { path },
      { cause: error },
    )
  }
}

/** In-memory database for tests and ephemeral market runs. */
export function openMemoryDb(): StudioDb {
  return new StudioDb(':memory:')
}
