import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { LIMITS } from '../constants.js'
import { ERROR_CODES, EngineFaultError } from '../types.js'

/** Per-key serialization: same project waits, different projects proceed. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  /** Run `task` after every earlier task holding the same key finished. */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    this.tails.set(key, tail)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  /** Number of keys currently tracked; exposed for tests and diagnostics. */
  get size(): number {
    return this.tails.size
  }
}

export interface LockRecord {
  pid: number
  startedAt: string
  /** Distinguishes two locks acquired by the same pid in the same millisecond. */
  nonce?: string
}

/** Nonces this process currently holds; same-pid locks not in this set are stale. */
const liveNonces = new Set<string>()

const isLockRecord = (value: unknown): value is LockRecord =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as LockRecord).pid === 'number' &&
  typeof (value as LockRecord).startedAt === 'string' &&
  ((value as LockRecord).nonce === undefined || typeof (value as LockRecord).nonce === 'string')

export { isLockRecord }

const processAlive = (pid: number): boolean => {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Whether a parsed lock record still belongs to a live holder. This is the
 * read-side rule used by FileLock.tryReclaim: a same-pid record is live only
 * while this process still tracks its nonce; a foreign record is live while
 * its pid exists. A same-pid leftover from a failed unlink or pid reuse is
 * stale, not an indefinitely held writer.
 */
export function lockRecordIsLive(record: LockRecord): boolean {
  if (record.pid === process.pid) {
    return record.nonce !== undefined && liveNonces.has(record.nonce)
  }
  return processAlive(record.pid)
}

/** Cross-process write lock: `O_EXCL` create, pid + timestamp, stale reclaim. */
export class FileLock {
  private held: LockRecord | null = null

  constructor(
    private readonly absolutePath: string,
    private readonly staleMs: number = LIMITS.lockStaleMs,
    private readonly waitMs: number = LIMITS.lockWaitMs,
    /** Optional audit hook; the engine records `lock_reclaimed` in the journal. */
    private readonly onReclaim?: (record: LockRecord | null) => Promise<void>,
  ) {}

  /** Try to take the lock; records the nonce this instance owns. */
  async acquire(): Promise<void> {
    const deadline = Date.now() + this.waitMs
    for (;;) {
      try {
        const handle = await fs.open(this.absolutePath, 'wx')
        const record: LockRecord = {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          nonce: randomUUID(),
        }
        // Register the nonce before the bytes become visible. A concurrent read
        // in this process then cannot mistake a freshly written lock for a
        // same-pid leftover.
        if (record.nonce !== undefined) liveNonces.add(record.nonce)
        try {
          await handle.writeFile(JSON.stringify(record))
          await handle.close()
        } catch (error) {
          await handle.close().catch(() => undefined)
          if (record.nonce !== undefined) liveNonces.delete(record.nonce)
          await fs.rm(this.absolutePath, { force: true }).catch(() => undefined)
          throw error
        }
        this.held = record
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // Windows can report EPERM/EACCES instead of EEXIST while another
        // process is deleting or antivirus is scanning the lock file. Treat
        // those as lock contention and let the normal deadline decide.
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error
        if (await this.tryReclaim()) continue
        if (Date.now() >= deadline) {
          throw new EngineFaultError(
            ERROR_CODES.LOCK_TIMEOUT,
            `timed out waiting for ${this.absolutePath}`,
            'another DSH instance is writing this project; close it or wait',
          )
        }
        await delay(25)
      }
    }
  }

  /** Release only if the bytes on disk are still the lock this instance took. */
  async release(): Promise<void> {
    const record = await this.read()
    const held = this.held
    this.held = null
    if (held?.nonce !== undefined) liveNonces.delete(held.nonce)
    if (record !== null && held !== null && record.pid === held.pid && record.nonce === held.nonce) {
      // A failed unlink (Windows AV/EPERM) must not turn into a permanent
      // same-pid lock: the nonce is no longer live, so the next acquire can
      // reclaim the file instead of waiting forever.
      await fs.rm(this.absolutePath, { force: true }).catch(() => undefined)
    }
  }

  /** Read the current lock record, or null when absent/held by a foreign process. */
  private async read(): Promise<LockRecord | null> {
    return this.readAt(this.absolutePath)
  }

  private async readAt(path: string): Promise<LockRecord | null> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(path, 'utf8'))
      return isLockRecord(raw) ? raw : null
    } catch {
      return null
    }
  }

  /** Stale locks are reclaimed once; a live, fresh, or half-written lock is not touched. */
  private async tryReclaim(): Promise<boolean> {
    let mtimeMs: number
    try {
      mtimeMs = (await fs.stat(this.absolutePath)).mtimeMs
    } catch {
      // The lock disappeared between the failed create and this check.
      return true
    }
    let record: LockRecord | null = null
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.absolutePath, 'utf8'))
      if (isLockRecord(raw)) record = raw
    } catch {
      record = null
    }
    // A lock file is created with O_EXCL and then written. During that window
    // the reader sees an empty or partial file; it must not be mistaken for a
    // stale lock, or two processes would both believe they hold it.
    if (record === null) {
      if (Date.now() - mtimeMs <= this.staleMs) return false
    } else {
      // A foreign live pid keeps the lock even if the transaction is long or
      // its timestamp is corrupt. A lock owned by this pid is live only while
      // its nonce is in the process-local set; otherwise it is a leftover from
      // a crashed/restarted instance (pid reuse, container PID 1, or a release
      // that failed to unlink).
      if (lockRecordIsLive(record)) return false
    }

    // Claim with a hard link instead of rename: the live lock is never moved
    // away from its owner. Compare the linked record before unlinking, and
    // only unlink if the original path still carries the same record; a newer
    // lock created in the meantime is left alone.
    const claimPath = `${this.absolutePath}.reclaim-${randomUUID()}`
    try {
      await fs.link(this.absolutePath, claimPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return true
      // A Windows sharing/AV window can make link fail while the owner is
      // still releasing. Do not fail the writer; retry until the deadline.
      if (code === 'EPERM' || code === 'EACCES') return false
      throw error
    }
    const moved = await this.readAt(claimPath)
    const claimMtime = await fs
      .stat(claimPath)
      .then((info) => info.mtimeMs)
      .catch(() => Date.now())
    const same =
      record === null
        ? moved === null && Date.now() - claimMtime > this.staleMs
        : moved !== null &&
          moved.pid === record.pid &&
          moved.startedAt === record.startedAt &&
          moved.nonce === record.nonce
    if (!same) {
      await fs.rm(claimPath, { force: true }).catch(() => undefined)
      return false
    }
    const current = await this.readAt(this.absolutePath)
    const currentMatches =
      record === null
        ? current === null
        : current !== null &&
          current.pid === record.pid &&
          current.startedAt === record.startedAt &&
          current.nonce === record.nonce
    if (!currentMatches) {
      await fs.rm(claimPath, { force: true }).catch(() => undefined)
      return false
    }
    await fs.rm(this.absolutePath, { force: true }).catch(() => undefined)
    await fs.rm(claimPath, { force: true }).catch(() => undefined)
    await this.onReclaim?.(record)
    return true
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
