import { resolve } from 'node:path'
import { parse as parseYaml, stringify } from 'yaml'
import { REGISTRY_FILE } from '../constants.js'
import { compareText } from '../domain/stable.js'
import { ERROR_CODES, EngineFaultError } from '../types.js'
import { FsStore } from './fs.js'

/** One project row in the cross-project registry. */
export interface RegistryEntry {
  root: string
  title: string
  /** Project identity; absent on registries written by 0.2.1 and earlier. */
  created_at?: string
  updated_at: string
}

export interface RegistryDocument {
  schema_version: 1
  active: string | null
  projects: RegistryEntry[]
}

const empty = (): RegistryDocument => ({ schema_version: 1, active: null, projects: [] })

/**
 * Convenience bookkeeping across projects. It is never authoritative: deleting
 * the file loses no project, and a project opens fine without a row here.
 */
export class ProjectRegistry {
  constructor(private readonly store: FsStore) {}

  /** Read the registry; a missing file is an empty registry, a corrupt one is a fault. */
  async read(): Promise<RegistryDocument> {
    const text = await this.store.readText(REGISTRY_FILE)
    if (text === null) return empty()
    let raw: unknown
    try {
      raw = parseYaml(text) as unknown
    } catch (error) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_INVALID,
        `${REGISTRY_FILE} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
        'fix or delete the registry file; projects on disk are unaffected',
        { cause: error },
      )
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, `${REGISTRY_FILE} is not an object`)
    }
    const record = raw as Partial<RegistryDocument>
    if (record.schema_version !== 1) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_INVALID,
        `${REGISTRY_FILE} has an unsupported schema_version`,
      )
    }
    const projects: RegistryEntry[] = []
    const indexes = new Map<string, number>()
    if (record.projects !== undefined && !Array.isArray(record.projects)) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_INVALID,
        `${REGISTRY_FILE}.projects must be an array`,
        'fix or delete the registry file; projects on disk are unaffected',
      )
    }
    if (Array.isArray(record.projects)) {
      for (const value of record.projects) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
        const entry = value as unknown as Record<string, unknown>
        if (typeof entry.root !== 'string' || entry.root === '') continue
        if (typeof entry.title !== 'string') continue
        const normalized: RegistryEntry = {
          root: resolve(entry.root),
          title: entry.title,
          ...(typeof entry.created_at === 'string' && entry.created_at !== ''
            ? { created_at: entry.created_at }
            : {}),
          updated_at: typeof entry.updated_at === 'string' ? entry.updated_at : '',
        }
        const existing = indexes.get(normalized.root)
        if (existing === undefined) {
          indexes.set(normalized.root, projects.length)
          projects.push(normalized)
        } else {
          projects[existing] = normalized
        }
      }
    }
    return {
      schema_version: 1,
      active:
        typeof record.active === 'string' && record.active.trim() !== '' ? resolve(record.active) : null,
      projects,
    }
  }

  /** Insert or update one project row. */
  async register(entry: Omit<RegistryEntry, 'updated_at'>): Promise<RegistryDocument> {
    const document = await this.read()
    const root = resolve(entry.root)
    const previous = document.projects.find((candidate) => candidate.root === root)
    const created_at = entry.created_at ?? previous?.created_at
    const row: RegistryEntry = {
      root,
      title: entry.title,
      ...(created_at === undefined || created_at === '' ? {} : { created_at }),
      updated_at: new Date().toISOString(),
    }
    const rows = document.projects.filter((candidate) => candidate.root !== root)
    rows.push(row)
    const next: RegistryDocument = {
      ...document,
      projects: rows.sort((a, b) => compareText(a.root, b.root)),
    }
    await this.write(next)
    return next
  }

  /** Mark a project as the default one; an unregistered root is still accepted. */
  async setActive(root: string): Promise<RegistryDocument> {
    const document = await this.read()
    const next: RegistryDocument = { ...document, active: resolve(root) }
    await this.write(next)
    return next
  }

  /** Drop a row; the project on disk is untouched. */
  async forget(root: string): Promise<RegistryDocument> {
    const document = await this.read()
    const target = resolve(root)
    const next: RegistryDocument = {
      ...document,
      projects: document.projects.filter((entry) => entry.root !== target),
      active: document.active === target ? null : document.active,
    }
    await this.write(next)
    return next
  }

  private async write(document: RegistryDocument): Promise<void> {
    await this.store.writeText(REGISTRY_FILE, stringify(document, { lineWidth: 0 }))
  }
}
