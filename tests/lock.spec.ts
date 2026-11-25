import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { FileLock } from '../src/store/lock.js'
import { harness } from './helpers.js'

describe('file lock reclaim', () => {
  it('does not delete a fresh lock whose record is still being written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      await writeFile(path, '')
      const lock = new FileLock(path, 1_000, 120)
      await expect(lock.acquire()).rejects.toMatchObject({ code: 'ENGINE_LOCK_TIMEOUT' })
      expect(await readFile(path, 'utf8')).toBe('')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('waits for a lock actually held by a child process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    const script = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(path)}, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); setInterval(() => {}, 1000)`
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
    try {
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline) {
        try {
          await readFile(path, 'utf8')
          break
        } catch {
          await delay(20)
        }
      }
      await expect(new FileLock(path, 1_000, 120).acquire()).rejects.toMatchObject({
        code: 'ENGINE_LOCK_TIMEOUT',
      })
    } finally {
      child.kill()
      await once(child, 'exit').catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not steal a fresh lock owned by a live foreign pid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      const record = JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() })
      await writeFile(path, record)
      const lock = new FileLock(path, 1_000, 120)
      await expect(lock.acquire()).rejects.toMatchObject({ code: 'ENGINE_LOCK_TIMEOUT' })
      expect(await readFile(path, 'utf8')).toBe(record)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reclaims a live foreign pid whose lock is older than the maximum transaction age', async () => {
    // 0.2.20 WP3: `processAlive` cannot tell the lock's owner from a process
    // that inherited the pid (containers, restarts), so an abandoned lock looked
    // alive forever and made the project unwritable. A transaction here takes
    // milliseconds; a lock stamped 1999 is reused-pid evidence, not contention.
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      await writeFile(path, JSON.stringify({ pid: process.ppid, startedAt: '1999-01-01T00:00:00.000Z' }))
      const reclaimed: Array<{ pid: number }> = []
      const lock = new FileLock(path, 10, 200, async (record) => {
        if (record !== null) reclaimed.push({ pid: record.pid })
      })
      await lock.acquire()
      expect(reclaimed).toEqual([{ pid: process.ppid }])
      await lock.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not steal a fresh lock from a live foreign process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      await writeFile(path, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }))
      const lock = new FileLock(path, 10_000, 80)
      await expect(lock.acquire()).rejects.toMatchObject({ code: 'ENGINE_LOCK_TIMEOUT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reclaims a same-pid lock whose nonce is not live', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      await writeFile(
        path,
        JSON.stringify({ pid: process.pid, startedAt: '1999-01-01T00:00:00.000Z', nonce: 'dead' }),
      )
      const lock = new FileLock(path, 1_000, 500)
      await lock.acquire()
      await lock.release()
      expect(await readFile(path, 'utf8').catch(() => null)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not reclaim a live process lock just because startedAt is unparsable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      await writeFile(path, JSON.stringify({ pid: process.ppid, startedAt: 'not-a-date' }))
      await expect(new FileLock(path, 1_000, 200).acquire()).rejects.toMatchObject({
        code: 'ENGINE_LOCK_TIMEOUT',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reclaims an unparsable timestamp only after the owner is dead', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      await writeFile(path, JSON.stringify({ pid: 999_999, startedAt: 'not-a-date' }))
      const lock = new FileLock(path, 1_000, 200)
      await lock.acquire()
      await lock.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not delete a lock file another writer replaced during release', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      const lock = new FileLock(path, 1_000, 500)
      await lock.acquire()
      const replacement = JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        nonce: 'replacement',
      })
      await writeFile(path, replacement)
      await lock.release()
      expect(await readFile(path, 'utf8')).toBe(replacement)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('notifies the audit hook when a dead owner lock is reclaimed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      await writeFile(path, JSON.stringify({ pid: 999_999, startedAt: 'not-a-date' }))
      let reclaimed: { pid: number } | null = null
      const lock = new FileLock(path, 1_000, 200, async (record) => {
        reclaimed = record
      })
      await lock.acquire()
      expect(reclaimed).toMatchObject({ pid: 999_999 })
      await lock.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('audits a stale lock reclaimed by the engine before a write', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '锁审计', genre: '都市现代', platform: 'fanqie', root })
      await writeFile(join(root, '.engine.lock'), JSON.stringify({ pid: 999_999, startedAt: 'not-a-date' }))
      await engine.amend({
        path: 'state/world.yaml',
        content: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
        reason: '触发锁回收',
        root,
      })
      const audit = await engine.auditHistory({ root, limit: 10 })
      expect(audit.data).toContainEqual(expect.objectContaining({ op: 'lock_reclaimed' }))
    } finally {
      await cleanup()
    }
  })

  it('retries a transient EPERM while opening a contended lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    const busy = Object.assign(new Error('sharing violation'), { code: 'EPERM' })
    const open = vi.spyOn(fs, 'open').mockRejectedValueOnce(busy as never)
    try {
      const lock = new FileLock(path, 1_000, 1_000)
      await lock.acquire()
      expect(await readFile(path, 'utf8')).toContain('"pid"')
      await lock.release()
    } finally {
      open.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('retries a transient EPERM while linking a stale lock claim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    const busy = Object.assign(new Error('sharing violation'), { code: 'EPERM' })
    const link = vi.spyOn(fs, 'link').mockRejectedValueOnce(busy as never)
    try {
      await writeFile(
        path,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), nonce: 'stale' }),
      )
      const lock = new FileLock(path, 1_000, 1_000)
      await lock.acquire()
      await lock.release()
    } finally {
      link.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ignores a release when the lock file is already gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    try {
      const lock = new FileLock(join(dir, '.engine.lock'))
      await lock.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not treat a hard-linked fresh claim as expired by the lock mtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      await writeFile(
        path,
        JSON.stringify({ pid: 999_999, startedAt: '1999-01-01T00:00:00.000Z', nonce: 'stale' }),
      )
      const old = new Date(Date.now() - 10_000)
      await fs.utimes(path, old, old)
      await fs.link(path, `${path}.reclaim`)
      await expect(new FileLock(path, 1_000, 120).acquire()).rejects.toMatchObject({
        code: 'ENGINE_LOCK_TIMEOUT',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not steal a stale lock while a fresh reclaim claim exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      await writeFile(
        path,
        JSON.stringify({ pid: 999_999, startedAt: '1999-01-01T00:00:00.000Z', nonce: 'stale' }),
      )
      await writeFile(`${path}.reclaim`, 'claim')
      await expect(new FileLock(path, 1_000, 120).acquire()).rejects.toMatchObject({
        code: 'ENGINE_LOCK_TIMEOUT',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('clears an expired reclaim claim before retrying', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      await writeFile(
        path,
        JSON.stringify({ pid: 999_999, startedAt: '1999-01-01T00:00:00.000Z', nonce: 'stale' }),
      )
      const claim = `${path}.reclaim`
      await writeFile(claim, 'old claim')
      const old = new Date(Date.now() - 10_000)
      await fs.utimes(claim, old, old)
      const lock = new FileLock(path, 1_000, 500)
      await lock.acquire()
      await lock.release()
      expect(await readFile(path, 'utf8').catch(() => null)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/**
 * 0.2.20 review: a release tombstone must speak only for the lock it released.
 *
 * `release()` writes `<lock>.dead` when the unlink fails (Windows AV/EPERM).
 * The tombstone was consulted by age alone, so one left behind by an earlier
 * release made the *next* live lock reclaimable: a second acquirer hard-linked
 * the live lock, deleted it and installed its own record while the first writer
 * still believed it held the lock — two writers, one project.
 */
describe('file lock tombstone ownership', () => {
  it('does not let an orphan tombstone reclaim a live lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      const first = new FileLock(path, 1_000, 500)
      await first.acquire()
      const owned = JSON.parse(await readFile(path, 'utf8')) as {
        pid: number
        startedAt: string
        nonce: string
      }
      await writeFile(
        `${path}.dead`,
        JSON.stringify({
          pid: owned.pid,
          startedAt: owned.startedAt,
          nonce: 'a-previous-releases-nonce',
          released_at: new Date(Date.now() - 10_000).toISOString(),
        }),
      )
      const second = new FileLock(path, 1_000, 120)
      await expect(second.acquire()).rejects.toMatchObject({ code: 'ENGINE_LOCK_TIMEOUT' })
      expect(JSON.parse(await readFile(path, 'utf8')).nonce).toBe(owned.nonce)
      await first.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('still reclaims a dead lock whose own tombstone is old', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      const dead = { pid: 999_999, startedAt: '1999-01-01T00:00:00.000Z', nonce: 'dead-nonce' }
      await writeFile(path, JSON.stringify(dead))
      await writeFile(
        `${path}.dead`,
        JSON.stringify({ ...dead, released_at: new Date(Date.now() - 10_000).toISOString() }),
      )
      const lock = new FileLock(path, 1_000, 500)
      await lock.acquire()
      expect(JSON.parse(await readFile(path, 'utf8')).nonce).not.toBe('dead-nonce')
      await lock.release()
      expect(await readFile(`${path}.dead`, 'utf8').catch(() => null)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
