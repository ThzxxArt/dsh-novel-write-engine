import { eq } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ensureDirAt } from '../assets.js'
import { StudioError, STUDIO_ERROR_CODES } from '../contracts/errors.js'

export const projectRegistry = sqliteTable('project_registry', {
  root: text('root').primaryKey(),
  projectId: text('project_id').notNull(),
  title: text('title').notNull(),
  lastOpenedAt: text('last_opened_at').notNull(),
})

export const sessionBinding = sqliteTable('session_binding', {
  sessionId: text('session_id').primaryKey(),
  root: text('root').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const GLOBAL_SCHEMA = { projectRegistry, sessionBinding }

export const dshHome = (): string => {
  const configured = process.env.DSH_HOME
  return configured === undefined || configured.trim() === '' ? join(homedir(), '.dsh') : resolve(configured)
}

export const defaultStateDir = (): string => join(dshHome(), 'novel-write-engine')

export const globalDbPath = (stateDir?: string): string =>
  join(resolve(stateDir === undefined || stateDir.trim() === '' ? defaultStateDir() : stateDir), 'studio.db')

export interface RegistryRow {
  root: string
  projectId: string
  title: string
  lastOpenedAt: string
}

/** Cross-project registry and session bindings; only project DBs own prose. */
export class GlobalRegistry {
  readonly path: string
  readonly raw: Database.Database
  readonly orm: BetterSQLite3Database<typeof GLOBAL_SCHEMA>

  constructor(path = globalDbPath()) {
    this.path = path
    ensureDirAt(dirname(path))
    this.raw = new Database(path)
    this.raw.pragma('journal_mode = WAL')
    this.raw.pragma('busy_timeout = 5000')
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS project_registry (
        root TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_binding (
        session_id TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    this.orm = drizzle(this.raw, { schema: GLOBAL_SCHEMA })
  }

  register(input: { root: string; projectId: string; title: string }): void {
    const now = new Date().toISOString()
    this.orm
      .insert(projectRegistry)
      .values({
        root: resolve(input.root),
        projectId: input.projectId,
        title: input.title,
        lastOpenedAt: now,
      })
      .onConflictDoUpdate({
        target: projectRegistry.root,
        set: { projectId: input.projectId, title: input.title, lastOpenedAt: now },
      })
      .run()
  }

  list(): RegistryRow[] {
    return this.orm
      .select()
      .from(projectRegistry)
      .all()
      .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))
  }

  recent(): RegistryRow | undefined {
    return this.list()[0]
  }

  bind(sessionId: string, root: string): void {
    const now = new Date().toISOString()
    this.orm
      .insert(sessionBinding)
      .values({ sessionId, root: resolve(root), updatedAt: now })
      .onConflictDoUpdate({ target: sessionBinding.sessionId, set: { root: resolve(root), updatedAt: now } })
      .run()
  }

  binding(sessionId: string): string | undefined {
    return this.orm.select().from(sessionBinding).where(eq(sessionBinding.sessionId, sessionId)).get()?.root
  }

  unbind(sessionId: string): void {
    this.orm.delete(sessionBinding).where(eq(sessionBinding.sessionId, sessionId)).run()
  }

  close(): void {
    if (this.raw.open) this.raw.close()
  }
}

/** `stateDir` is a directory; the DB always lives at `<stateDir>/studio.db`. */
export function openGlobalRegistry(stateDir?: string): GlobalRegistry {
  const path = globalDbPath(stateDir)
  try {
    return new GlobalRegistry(path)
  } catch (error) {
    throw new StudioError(
      STUDIO_ERROR_CODES.DB_INVALID,
      `cannot open global registry: ${error instanceof Error ? error.message : String(error)}`,
      'verify ~/.dsh permissions or set DSH_HOME/stateDir',
      { path: path ?? globalDbPath() },
      { cause: error },
    )
  }
}
