import { parse as parseYaml, stringify } from 'yaml'
import { REGISTRY_FILE } from '../constants.js'
import { ERROR_CODES, EngineFaultError } from '../types.js'
import { FsStore } from './fs.js'

/** One project row in the cross-project registry. */
export interface RegistryEntry {
  root: string
  title: string
  updated_at: string
}

interface RegistryDocument {
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
    return {
      schema_version: 1,
      active: typeof record.active === 'string' ? record.active : null,
      projects: Array.isArray(record.projects)
        ? record.projects.filter(
            (entry): entry is RegistryEntry =>
              typeof entry === 'object' &&
              entry !== null &&
              typeof (entry as RegistryEntry).root === 'string' &&
              typeof (entry as RegistryEntry).title === 'string',
          )
        : [],
    }
  }

  /** Insert or update one project row. */
  async register(entry: Omit<RegistryEntry, 'updated_at'>): Promise<RegistryDocument> {
    const document = await this.read()
    const row: RegistryEntry = { ...entry, updated_at: new Date().toISOString() }
    const rows = document.projects.filter((candidate) => candidate.root !== entry.root)
    rows.push(row)
    const next: RegistryDocument = {
      ...document,
      projects: rows.sort((a, b) => a.root.localeCompare(b.root)),
    }
    await this.write(next)
    return next
  }

  /** Mark a project as the default one; an unregistered root is still accepted. */
  async setActive(root: string): Promise<RegistryDocument> {
    const document = await this.read()
    const next: RegistryDocument = { ...document, active: root }
    await this.write(next)
    return next
  }

  /** Drop a row; the project on disk is untouched. */
  async forget(root: string): Promise<RegistryDocument> {
    const document = await this.read()
    const next: RegistryDocument = {
      ...document,
      projects: document.projects.filter((entry) => entry.root !== root),
      active: document.active === root ? null : document.active,
    }
    await this.write(next)
    return next
  }

  private async write(document: RegistryDocument): Promise<void> {
    await this.store.writeText(REGISTRY_FILE, stringify(document, { lineWidth: 0 }))
  }
}
