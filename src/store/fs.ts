import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { SCHEMA_VERSION, ERROR_CODES, EngineFaultError } from '../types.js'
import { resolveInside } from './path.js'
import { MIGRATIONS, migrateDocument } from './migrate.js'
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

  /**
   * Resolve and prove that no existing path component is a symlink. The
   * lexical check in `resolveInside` cannot see a link inside the project that
   * points at `/etc` or a sibling checkout; every read and write goes through
   * this async check so the filesystem's own redirection cannot escape.
   */
  async safePath(relativePath: string): Promise<string> {
    const absolute = this.path(relativePath)
    const root = resolve(this.root)
    let current = root
    for (const segment of relative(root, absolute).split(sep)) {
      if (segment === '') continue
      current = join(current, segment)
      try {
        const stat = await fs.lstat(current)
        if (stat.isSymbolicLink()) {
          throw new EngineFaultError(
            ERROR_CODES.PATH_ESCAPE,
            `refusing path "${relativePath}": "${segment}" is a symlink`,
          )
        }
      } catch (error) {
        if (isMissing(error)) break
        throw error
      }
    }
    return absolute
  }

  /** Absolute path of an internal file outside the project root (locks live at root). */
  async ensureDir(relativePath: string): Promise<string> {
    const absolute = await this.safePath(relativePath)
    await fs.mkdir(absolute, { recursive: true })
    return absolute
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(await this.safePath(relativePath))
      return true
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
  }

  async stat(relativePath: string): Promise<{ size: number; mtimeMs: number; isDirectory: boolean } | null> {
    try {
      const stat = await fs.stat(await this.safePath(relativePath))
      return { size: stat.size, mtimeMs: stat.mtimeMs, isDirectory: stat.isDirectory() }
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async list(relativeDir: string): Promise<string[]> {
    try {
      return (await fs.readdir(await this.safePath(relativeDir))).sort()
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }

  async readText(relativePath: string): Promise<string | null> {
    try {
      return await fs.readFile(await this.safePath(relativePath), 'utf8')
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
    let parsed: unknown
    try {
      parsed = parseYaml(text) as unknown
    } catch (error) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_INVALID,
        `${relativePath} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
        'fix the YAML syntax; the engine will not rewrite a document it cannot parse',
        { cause: error },
      )
    }
    const version =
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).schema_version === 'number'
        ? ((parsed as Record<string, unknown>).schema_version as number)
        : 1
    const document =
      version < SCHEMA_VERSION
        ? migrateDocument(parsed as Record<string, unknown>, MIGRATIONS, SCHEMA_VERSION)
        : parsed
    return narrow(kind, document) as ReturnType<typeof narrow<K>>
  }

  /** Write text atomically: temp file, fsync, rename, directory fsync. */
  async writeText(relativePath: string, text: string): Promise<void> {
    const absolute = await this.safePath(relativePath)
    await fs.mkdir(dirname(absolute), { recursive: true })
    const temp = `${absolute}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temp, 'w')
      try {
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temp, absolute)
      await syncDirectory(dirname(absolute))
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async writeDoc(relativePath: string, document: { schema_version?: number }): Promise<void> {
    const withVersion = { ...document, schema_version: SCHEMA_VERSION }
    await this.writeText(relativePath, stringifyYaml(withVersion, { lineWidth: 0 }))
  }

  async remove(relativePath: string): Promise<void> {
    await fs.rm(await this.safePath(relativePath), { force: true })
  }

  /** Remove a directory tree inside the project root (backup GC only). */
  async removeTree(relativePath: string): Promise<void> {
    await fs.rm(await this.safePath(relativePath), { recursive: true, force: true })
  }

  /** Raw append used only by the journal (JSONL is append-only by design). */
  async appendText(relativePath: string, text: string): Promise<void> {
    const absolute = await this.safePath(relativePath)
    await fs.mkdir(dirname(absolute), { recursive: true })
    const handle = await fs.open(absolute, 'a+')
    try {
      const info = await handle.stat()
      if (info.size > 0) {
        const last = Buffer.alloc(1)
        await handle.read(last, 0, 1, info.size - 1)
        if (last[0] !== 0x0a) await handle.write('\n')
      }
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await syncDirectory(dirname(absolute))
  }

  /** Read raw bytes, used by export and integrity checks. */
  async readBytes(relativePath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(await this.safePath(relativePath))
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async writeBytes(relativePath: string, bytes: Uint8Array): Promise<void> {
    const absolute = await this.safePath(relativePath)
    await fs.mkdir(dirname(absolute), { recursive: true })
    const temp = `${absolute}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temp, 'w')
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temp, absolute)
      await syncDirectory(dirname(absolute))
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
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
    ((error as { code?: string }).code === 'ENOENT' || (error as { code?: string }).code === 'ENOTDIR')
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
