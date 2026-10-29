import { resolve } from 'node:path'
import { parse as parseYaml, stringify } from 'yaml'
import { SESSION_BINDINGS_FILE } from '../constants.js'
import { ERROR_CODES, EngineFaultError } from '../types.js'
import { FsStore } from './fs.js'

/** Why a session was bound; diagnostic only, never a precedence input. */
export type BindingSource = 'explicit' | 'init' | 'command'

/** One session's explicit project choice. */
export interface SessionBinding {
  session_id: string
  root: string
  title: string
  project_created_at: string
  bound_at: string
  source: BindingSource
}

export interface SessionBindingsDocument {
  schema_version: 1
  bindings: SessionBinding[]
}

export interface BindSessionInput {
  session_id: string
  root: string
  title: string
  project_created_at: string
  source: BindingSource
}

const empty = (): SessionBindingsDocument => ({ schema_version: 1, bindings: [] })
const sources = new Set<BindingSource>(['explicit', 'init', 'command'])

const row = (value: unknown): SessionBinding | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.session_id !== 'string' || record.session_id === '') return null
  if (typeof record.root !== 'string' || record.root === '') return null
  const source =
    typeof record.source === 'string' && sources.has(record.source as BindingSource)
      ? (record.source as BindingSource)
      : 'explicit'
  return {
    session_id: record.session_id,
    root: resolve(record.root),
    title: typeof record.title === 'string' ? record.title : '',
    project_created_at: typeof record.project_created_at === 'string' ? record.project_created_at : '',
    bound_at: typeof record.bound_at === 'string' ? record.bound_at : '',
    source,
  }
}

/**
 * Session-scoped project choices. This file is convenience state, never project
 * truth: deleting it loses no book, and a corrupt file is a hard read error
 * rather than a silent "no bindings" that could write into another project.
 */
export class SessionBindings {
  constructor(
    private readonly store: FsStore,
    private readonly options: { now?: () => Date } = {},
  ) {}

  async read(): Promise<SessionBindingsDocument> {
    const text = await this.store.readText(SESSION_BINDINGS_FILE)
    if (text === null) return empty()
    let raw: unknown
    try {
      raw = parseYaml(text) as unknown
    } catch (error) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_INVALID,
        `${SESSION_BINDINGS_FILE} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
        'fix or delete the session binding file; projects on disk are unaffected',
        { cause: error },
      )
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, `${SESSION_BINDINGS_FILE} is not an object`)
    }
    const record = raw as Partial<SessionBindingsDocument>
    if (record.schema_version !== 1) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_INVALID,
        `${SESSION_BINDINGS_FILE} has an unsupported schema_version`,
      )
    }
    if (record.bindings !== undefined && !Array.isArray(record.bindings)) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_INVALID,
        `${SESSION_BINDINGS_FILE}.bindings must be an array`,
        'fix or delete the session binding file; projects on disk are unaffected',
      )
    }
    const bindings: SessionBinding[] = []
    const indexes = new Map<string, number>()
    for (const candidate of record.bindings ?? []) {
      const parsed = row(candidate)
      if (parsed === null) continue
      const existing = indexes.get(parsed.session_id)
      if (existing === undefined) {
        indexes.set(parsed.session_id, bindings.length)
        bindings.push(parsed)
      } else {
        // One row per session is the contract. A duplicated line is repaired
        // in memory by "last write wins"; the next bind rewrites one row.
        bindings[existing] = parsed
      }
    }
    return { schema_version: 1, bindings }
  }

  async get(sessionId: string): Promise<SessionBinding | undefined> {
    return (await this.read()).bindings.find((entry) => entry.session_id === sessionId)
  }

  async list(): Promise<SessionBinding[]> {
    return (await this.read()).bindings
  }

  /**
   * Insert or update one session's choice. A byte-for-byte equivalent binding
   * does not touch the file, so a read-only operation can call this safely.
   */
  async bind(
    input: BindSessionInput,
  ): Promise<{ binding: SessionBinding; document: SessionBindingsDocument; changed: boolean }> {
    const document = await this.read()
    const root = resolve(input.root)
    const existing = document.bindings.find((entry) => entry.session_id === input.session_id)
    if (
      existing !== undefined &&
      existing.root === root &&
      existing.title === input.title &&
      existing.project_created_at === input.project_created_at
    ) {
      return { binding: existing, document, changed: false }
    }
    const binding: SessionBinding = {
      session_id: input.session_id,
      root,
      title: input.title,
      project_created_at: input.project_created_at,
      bound_at: (this.options.now ?? (() => new Date()))().toISOString(),
      source: input.source,
    }
    const bindings =
      existing === undefined
        ? [...document.bindings, binding]
        : document.bindings.map((entry) => (entry.session_id === input.session_id ? binding : entry))
    const next: SessionBindingsDocument = { schema_version: 1, bindings }
    await this.write(next)
    return { binding, document: next, changed: true }
  }

  /** Remove one session binding; a missing row is a no-op. */
  async clear(sessionId: string): Promise<{ document: SessionBindingsDocument; changed: boolean }> {
    const document = await this.read()
    const bindings = document.bindings.filter((entry) => entry.session_id !== sessionId)
    if (bindings.length === document.bindings.length) return { document, changed: false }
    const next: SessionBindingsDocument = { schema_version: 1, bindings }
    await this.write(next)
    return { document: next, changed: true }
  }

  private async write(document: SessionBindingsDocument): Promise<void> {
    await this.store.writeText(SESSION_BINDINGS_FILE, stringify(document, { lineWidth: 0 }))
  }
}
