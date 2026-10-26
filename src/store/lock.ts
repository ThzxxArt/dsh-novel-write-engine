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

interface LockRecord {
  pid: number
  startedAt: string
}

const isLockRecord = (value: unknown): value is LockRecord =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as LockRecord).pid === 'number' &&
  typeof (value as LockRecord).startedAt === 'string'

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
  constructor(
    private readonly absolutePath: string,
    private readonly staleMs: number = LIMITS.lockStaleMs,
    private readonly waitMs: number = LIMITS.lockWaitMs,
  ) {}

  /** Try to take the lock; returns the record needed by `release`. */
  async acquire(): Promise<void> {
    const deadline = Date.now() + this.waitMs
    for (;;) {
      try {
        const handle = await fs.open(this.absolutePath, 'wx')
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
        } finally {
          await handle.close()
        }
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

  /** Release only if we still own the lock. */
  async release(): Promise<void> {
    const record = await this.read()
    if (record !== null && record.pid === process.pid) await fs.rm(this.absolutePath, { force: true })
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

  /** Stale locks are reclaimed once; a live or fresh lock is not touched. */
  private async tryReclaim(): Promise<boolean> {
    let record: LockRecord | null
    try {
      record = JSON.parse(await fs.readFile(this.absolutePath, 'utf8')) as LockRecord
    } catch {
      // A lock file whose content is unreadable is treated as stale.
      await fs.rm(this.absolutePath, { force: true })
      return true
    }
    if (!isLockRecord(record)) {
      await fs.rm(this.absolutePath, { force: true })
      return true
    }
    const age = Date.now() - Date.parse(record.startedAt)
    const stale = !Number.isFinite(age) || age > this.staleMs || !processAlive(record.pid)
    if (!stale) return false
    await fs.rm(this.absolutePath, { force: true })
    return true
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
