import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { SCHEMA_VERSION, ERROR_CODES, EngineFaultError } from '../types.js'
import { resolveInside } from './path.js'
import { MIGRATIONS, migrateDocument, normalizeLegacyCheck } from './migrate.js'
import { narrow, type DocKind } from './schema.js'

/** Hash used by journals, dedupe keys and content bindings. */
export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/** Short hash for last-action digests (16 hex chars is plenty). */
export function shortDigest(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}`
}

/** Construction options. Only performance knobs live here. */
export interface FsStoreOptions {
  /**
   * How long a parsed document may be reused before it is re-read even when
   * every stat field matches. 0 disables reuse. 0.2.21 review: stat equality
   * alone is not proof the bytes are unchanged (FAT/exFAT/SMB round mtimes to
   * 1–2 s, `cp -p`/`rsync -a` restore them), so the TTL bounds how long a
   * stale parse can live on a filesystem that also hides ctime.
   */
  docCacheTtlMs?: number
}

/**
 * The only IO surface of the engine. Every path is resolved inside the project
 * root by `resolveInside`; no caller touches `node:fs` directly.
 */
export class FsStore {
  readonly root: string

  /**
   * 0.2.20 WP4: parsed document cache, keyed by path and validated by the
   * file's size + mtime + ctime + inode, with a short TTL.
   *
   * Parsing `state/timeline.yaml` at 600 chapters costs 183 ms — more than
   * every read the panel makes put together — and a single `getStatus` parses
   * the same ledgers once and every panel section parses them again. The cache
   * stores the parse and hands out a structured clone (3.7 ms for the same
   * document), so a read model can never mutate cached state.
   *
   * 0.2.21 review: (size, mtime) is not a content identity. An external edit
   * that lands within the filesystem's mtime granularity, or that restores the
   * mtime (`cp -p`, `rsync -a`, an editor), matched the old key and the stale
   * parse was served forever. ctime changes even when mtime is restored, ino
   * catches a replaced file, and the TTL caps the window on filesystems that
   * only expose coarse timestamps.
   */
  private readonly docCache = new Map<
    string,
    { size: number; mtimeMs: number; ctimeMs: number; ino: number; cachedAt: number; document: unknown }
  >()

  private readonly docCacheTtlMs: number

  constructor(root: string, options: FsStoreOptions = {}) {
    this.root = root
    this.docCacheTtlMs = options.docCacheTtlMs ?? 5_000
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
    // Do not use recursive mkdir here. If the project root was deleted between
    // safePath and this call, recursive mkdir would recreate the whole root.
    // Walk the existing parents one segment at a time; the first missing root
    // then fails with ENOENT and the deleted project stays deleted.
    await this.ensureParent(absolute)
    try {
      await fs.mkdir(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw ioFailure(error)
      const info = await fs.lstat(absolute)
      if (!info.isDirectory()) {
        throw new EngineFaultError(
          ERROR_CODES.IO_PERMISSION,
          `refusing to use "${relativePath}": it exists but is not a directory`,
          'remove or rename the conflicting file, then retry',
        )
      }
    }
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

  async stat(
    relativePath: string,
  ): Promise<{ size: number; mtimeMs: number; ctimeMs: number; ino: number; isDirectory: boolean } | null> {
    try {
      const stat = await fs.stat(await this.safePath(relativePath))
      return {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        ino: stat.ino,
        isDirectory: stat.isDirectory(),
      }
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
    const info = await this.stat(relativePath)
    if (info === null) return null
    const cached = this.docCache.get(relativePath)
    let parsed: unknown
    if (
      cached !== undefined &&
      cached.size === info.size &&
      cached.mtimeMs === info.mtimeMs &&
      cached.ctimeMs === info.ctimeMs &&
      cached.ino === info.ino &&
      Date.now() - cached.cachedAt < this.docCacheTtlMs
    ) {
      parsed = structuredClone(cached.document)
    } else {
      const text = await this.readText(relativePath)
      if (text === null) return null
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
      const migrated: unknown =
        version < SCHEMA_VERSION
          ? migrateDocument(parsed as Record<string, unknown>, MIGRATIONS, SCHEMA_VERSION)
          : parsed
      // A hand-written legacy document may omit `schema_version`. Either fill it
      // or reject it; filling it here keeps readDoc and narrow consistent instead
      // of defaulting to 1 for the migration decision and then refusing the same
      // document as "missing schema_version" (X4).
      if (typeof migrated === 'object' && migrated !== null && !Array.isArray(migrated)) {
        const record = migrated as Record<string, unknown>
        if (record.schema_version === undefined) record.schema_version = SCHEMA_VERSION
      }
      // Cache a copy: the caller owns the graph it receives, so an in-place
      // normalization downstream must not leak into the next reader.
      this.docCache.set(relativePath, {
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        ino: info.ino,
        cachedAt: Date.now(),
        document: structuredClone(migrated),
      })
      // Bound the cache generously: a 600-chapter book has 1,200 review/check
      // documents plus ten ledgers, and a cap below that thrashed — every report
      // re-parsed every document it had just cached.
      if (this.docCache.size > 4096) {
        const oldest = this.docCache.keys().next().value
        if (oldest !== undefined) this.docCache.delete(oldest)
      }
      parsed = migrated
    }
    // A 0.2.0 check has no `scope` and mixes advisories into `violations`.
    // Normalize the in-memory view so the audit file stays untouched and the
    // document remains readable instead of failing `narrow` (U16). This runs
    // after the version fill: a legacy check that omits schema_version must not
    // be rejected by the branch that exists to accept legacy checks.
    if (kind === 'check' && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return narrow(kind, normalizeLegacyCheck(parsed as Record<string, unknown>)) as ReturnType<
        typeof narrow<K>
      >
    }
    return narrow(kind, parsed) as ReturnType<typeof narrow<K>>
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
        // Windows answers a too-long component here with ENOENT; the path is
        // what tells the two apart.
        throw ioFailure(error, current)
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
      // Same-millisecond rewrites of equal length would defeat the stat check.
      this.docCache.delete(relativePath)
      await syncDirectory(dirname(absolute))
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined)
      throw ioFailure(error, absolute)
    }
  }

  async writeDoc(relativePath: string, document: { schema_version?: number }): Promise<void> {
    const withVersion = { ...document, schema_version: SCHEMA_VERSION }
    await this.writeText(relativePath, stringifyYaml(withVersion, { lineWidth: 0 }))
  }

  async remove(relativePath: string): Promise<void> {
    await fs.rm(await this.safePath(relativePath), { force: true })
    this.docCache.delete(relativePath)
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
      // Same-millisecond rewrites of equal length would defeat the stat check.
      this.docCache.delete(relativePath)
      await syncDirectory(dirname(absolute))
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined)
      throw ioFailure(error, absolute)
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

/**
 * 0.2.20 release: Windows reports a path past MAX_PATH as `ENOENT`, not
 * `ENAMETOOLONG`, so the mapping below never fired there and the caller got a
 * bare libuv message for a problem whose fix ("shorten the root") is completely
 * different from a missing file. A component longer than 255 characters, or an
 * absolute path past 259 on `win32`, is a path problem on every platform.
 */
export function pathLooksTooLong(path: string | undefined): boolean {
  if (path === undefined || path === '') return false
  if (process.platform === 'win32' && path.length > 255) return true
  return path.split(/[\\/]/).some((segment) => segment.length > 255)
}

export function ioFailure(error: unknown, path?: string): unknown {
  if (error instanceof EngineFaultError) return error
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
  if ((code === 'ENOENT' || code === 'EINVAL') && pathLooksTooLong(path)) {
    return new EngineFaultError(
      ERROR_CODES.IO_PATH_TOO_LONG,
      `the path is longer than the filesystem allows (${code}): ${path ?? ''}`,
      'shorten the project root path, or move the project closer to the filesystem root',
      { cause: error },
    )
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'EISDIR') {
    return new EngineFaultError(
      ERROR_CODES.IO_PERMISSION,
      `filesystem permission denied (${code}): ${error instanceof Error ? error.message : String(error)}`,
      'fix the project directory permissions, or restore a readable copy before retrying',
      { cause: error },
    )
  }
  // 0.2.20 WP3: three failures that used to surface as a bare errno string in an
  // English libuv message, with no hint about what the author can do.
  if (code === 'ENOSPC') {
    return new EngineFaultError(
      ERROR_CODES.IO_DISK_FULL,
      `the disk is full (ENOSPC): ${error instanceof Error ? error.message : String(error)}`,
      'free space on the filesystem that holds the project (or move the project to a bigger one), then retry; the transaction was rolled back and the project is intact',
      { cause: error },
    )
  }
  if (code === 'ENAMETOOLONG') {
    return new EngineFaultError(
      ERROR_CODES.IO_PATH_TOO_LONG,
      `the path is longer than the filesystem allows (ENAMETOOLONG): ${error instanceof Error ? error.message : String(error)}`,
      'shorten the project root path, or move the project closer to the filesystem root',
      { cause: error },
    )
  }
  if (code === 'EIO') {
    return new EngineFaultError(
      ERROR_CODES.IO_DEVICE,
      `the device reported an I/O error (EIO): ${error instanceof Error ? error.message : String(error)}`,
      'check the disk and its cables, or restore the project from backups/ on a healthy device before retrying',
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
