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
        throw ioFailure(error)
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
      throw ioFailure(error)
    }
  }

  async stat(relativePath: string): Promise<{ size: number; mtimeMs: number; isDirectory: boolean } | null> {
    try {
      const stat = await fs.stat(await this.safePath(relativePath))
      return { size: stat.size, mtimeMs: stat.mtimeMs, isDirectory: stat.isDirectory() }
    } catch (error) {
      if (isMissing(error)) return null
      throw ioFailure(error)
    }
  }

  async list(relativeDir: string): Promise<string[]> {
    try {
      return (await fs.readdir(await this.safePath(relativeDir))).sort()
    } catch (error) {
      if (isMissing(error)) return []
      throw ioFailure(error)
    }
  }

  /**
   * Directory entries without following symlinks. Used by bounded workspace
   * discovery so a symlinked child is never mistaken for a project.
   */
  async entries(
    relativeDir: string,
  ): Promise<Array<{ name: string; directory: boolean; symbolicLink: boolean }>> {
    try {
      const absolute = relativeDir === '.' ? resolve(this.root) : await this.safePath(relativeDir)
      const entries = await fs.readdir(absolute, { withFileTypes: true })
      return entries
        .map((entry) => ({
          name: entry.name,
          directory: entry.isDirectory(),
          symbolicLink: entry.isSymbolicLink(),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    } catch (error) {
      if (isMissing(error)) return []
      throw ioFailure(error)
    }
  }

  /**
   * Metadata for a path without following the final symlink. A scandir probe
   * only needs to know that a candidate is a real directory; it must not read
   * through a link to decide that.
   */
  async lstat(
    relativePath: string,
  ): Promise<{ directory: boolean; symbolicLink: boolean; file: boolean } | null> {
    try {
      const info = await fs.lstat(relativePath === '.' ? resolve(this.root) : this.path(relativePath))
      return {
        directory: info.isDirectory(),
        symbolicLink: info.isSymbolicLink(),
        file: info.isFile(),
      }
    } catch (error) {
      if (isMissing(error)) return null
      throw ioFailure(error)
    }
  }

  /**
   * Follow a project-root symlink when classifying the root itself. Child
   * discovery still uses lstat/entries, so a symlinked *subdirectory* remains
   * out of workspace scans. The device/inode pair lets a transaction detect a
   * root that was deleted and recreated under the same path.
   */
  async statRoot(): Promise<{
    directory: boolean
    dev: number
    ino: number
    birthtimeMs: number
  } | null> {
    try {
      const info = await fs.stat(resolve(this.root))
      return {
        directory: info.isDirectory(),
        dev: info.dev,
        ino: info.ino,
        birthtimeMs: info.birthtimeMs,
      }
    } catch (error) {
      if (isMissing(error)) return null
      throw ioFailure(error)
    }
  }

  async readText(relativePath: string): Promise<string | null> {
    try {
      return await fs.readFile(await this.safePath(relativePath), 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw ioFailure(error)
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

  /**
   * Create missing directories below the store root without ever recreating the
   * root itself. `mkdir(..., {recursive:true})` silently recreates a deleted
   * project directory; walking one segment at a time makes the first missing
   * root fail with ENOENT and keeps deleted projects deleted.
   */
  private async ensureParent(absolutePath: string): Promise<void> {
    const root = resolve(this.root)
    const parent = dirname(absolutePath)
    const rel = relative(root, parent)
    if (rel === '' || rel === '.') return
    let current = root
    for (const segment of rel.split(sep)) {
      if (segment === '') continue
      current = join(current, segment)
      try {
        await fs.mkdir(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw ioFailure(error)
      }
    }
  }

  /** Write text atomically: temp file, fsync, rename, directory fsync. */
  async writeText(relativePath: string, text: string): Promise<void> {
    const absolute = await this.safePath(relativePath)
    await this.ensureParent(absolute)
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
      throw ioFailure(error)
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
    await this.ensureParent(absolute)
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
      throw ioFailure(error)
    }
  }

  async writeBytes(relativePath: string, bytes: Uint8Array): Promise<void> {
    const absolute = await this.safePath(relativePath)
    await this.ensureParent(absolute)
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
      throw ioFailure(error)
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

function ioFailure(error: unknown): unknown {
  if (error instanceof EngineFaultError) return error
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new EngineFaultError(
      ERROR_CODES.IO_PERMISSION,
      `filesystem permission denied (${code}): ${error instanceof Error ? error.message : String(error)}`,
      'fix the project directory permissions, or restore a readable copy before retrying',
      { cause: error },
    )
  }
  return error
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
