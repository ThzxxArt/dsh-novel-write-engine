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

const isLockRecord = (value: unknown): value is LockRecord =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as LockRecord).pid === 'number' &&
  typeof (value as LockRecord).startedAt === 'string' &&
  ((value as LockRecord).nonce === undefined || typeof (value as LockRecord).nonce === 'string')

const processAlive = (pid: number): boolean => {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
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
        try {
          await handle.writeFile(JSON.stringify(record))
        } catch (error) {
          await handle.close().catch(() => undefined)
          await fs.rm(this.absolutePath, { force: true }).catch(() => undefined)
          throw error
        }
        await handle.close()
        this.held = record
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
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
    if (record !== null && held !== null && record.pid === held.pid && record.nonce === held.nonce) {
      await fs.rm(this.absolutePath, { force: true })
    }
  }

  /** Read the current lock record, or null when absent/held by a foreign process. */
  private async read(): Promise<LockRecord | null> {
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.absolutePath, 'utf8'))
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
      await fs.rm(this.absolutePath, { force: true })
      await this.onReclaim?.(null)
      return true
    }
    const age = Date.now() - Date.parse(record.startedAt)
    const stale = !Number.isFinite(age) || age > this.staleMs || !processAlive(record.pid)
    if (!stale) return false
    await fs.rm(this.absolutePath, { force: true })
    await this.onReclaim?.(record)
    return true
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
