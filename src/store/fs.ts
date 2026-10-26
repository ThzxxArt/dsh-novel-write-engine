import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { SCHEMA_VERSION, ERROR_CODES, EngineFaultError } from '../types.js'
import { resolveInside } from './path.js'
import { narrow, type DocKind } from './schema.js'

/** Hash used by journals, dedupe keys and content bindings. */
export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/** Short hash for last-action digests (16 hex chars is plenty). */
export function shortDigest(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}`
}

/**
 * The only IO surface of the engine. Every path is resolved inside the project
 * root by `resolveInside`; no caller touches `node:fs` directly.
 */
export class FsStore {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  /** Resolve a project-relative path, refusing escapes. */
  path(relativePath: string): string {
    return resolveInside(this.root, relativePath)
  }

  /** Absolute path of an internal file outside the project root (locks live at root). */
  async ensureDir(relativePath: string): Promise<string> {
    const absolute = this.path(relativePath)
    await fs.mkdir(absolute, { recursive: true })
    return absolute
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(this.path(relativePath))
      return true
    } catch {
      return false
    }
  }

  async stat(relativePath: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const stat = await fs.stat(this.path(relativePath))
      return { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      return null
    }
  }

  async list(relativeDir: string): Promise<string[]> {
    try {
      return (await fs.readdir(this.path(relativeDir))).sort()
    } catch {
      return []
    }
  }

  async readText(relativePath: string): Promise<string | null> {
    try {
      return await fs.readFile(this.path(relativePath), 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  /** Read and narrow one of the twelve engine documents. */
  async readDoc<K extends DocKind>(
    relativePath: string,
    kind: K,
  ): Promise<ReturnType<typeof narrow<K>> | null> {
    const text = await this.readText(relativePath)
    if (text === null) return null
    return narrow(kind, parseYaml(text) as unknown) as ReturnType<typeof narrow<K>>
  }

  /** Write text atomically: temp file, fsync, rename, directory fsync. */
  async writeText(relativePath: string, text: string): Promise<void> {
    const absolute = this.path(relativePath)
    await fs.mkdir(dirname(absolute), { recursive: true })
    const temp = `${absolute}.${randomUUID()}.tmp`
    const handle = await fs.open(temp, 'w')
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temp, absolute)
    await syncDirectory(dirname(absolute))
  }

  async writeDoc(relativePath: string, document: { schema_version?: number }): Promise<void> {
    const withVersion = { ...document, schema_version: SCHEMA_VERSION }
    await this.writeText(relativePath, stringifyYaml(withVersion, { lineWidth: 0 }))
  }

  async remove(relativePath: string): Promise<void> {
    await fs.rm(this.path(relativePath), { force: true })
  }

  /** Raw append used only by the journal (JSONL is append-only by design). */
  async appendText(relativePath: string, text: string): Promise<void> {
    const absolute = this.path(relativePath)
    await fs.mkdir(dirname(absolute), { recursive: true })
    await fs.appendFile(absolute, text, 'utf8')
  }

  /** Read raw bytes, used by export and integrity checks. */
  async readBytes(relativePath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.path(relativePath))
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async writeBytes(relativePath: string, bytes: Uint8Array): Promise<void> {
    const absolute = this.path(relativePath)
    await fs.mkdir(dirname(absolute), { recursive: true })
    const temp = `${absolute}.${randomUUID()}.tmp`
    await fs.writeFile(temp, bytes)
    await fs.rename(temp, absolute)
    await syncDirectory(dirname(absolute))
  }

  /** Content hash of a file, or null when missing. */
  async hashOf(relativePath: string): Promise<string | null> {
    const text = await this.readText(relativePath)
    return text === null ? null : sha256(text)
  }

  /** Byte-exact content hash, used by transactions (text and binary alike). */
  async hashBytes(relativePath: string): Promise<string | null> {
    const bytes = await this.readBytes(relativePath)
    return bytes === null ? null : sha256(bytes.toString('base64'))
  }
}

/** Best-effort directory fsync; Windows filesystems reject it and that is fine. */
export async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is advisory on platforms that cannot open a directory handle.
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  )
}

/** Join project-relative segments with forward slashes. */
export function joinRel(...parts: string[]): string {
  return parts.filter((part) => part !== '').join('/')
}

/** A temp path next to the target, used by the transaction stage. */
export function siblingTemp(absolutePath: string): string {
  return join(dirname(absolutePath), `.${randomUUID()}.tmp`)
}

/** Re-export the engine fault type so callers do not import types directly. */
export { EngineFaultError, ERROR_CODES }
