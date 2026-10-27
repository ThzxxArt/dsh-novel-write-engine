import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
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

  it('does not steal a long-held lock from a live process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: '1999-01-01T00:00:00.000Z' }))
      const lock = new FileLock(path, 10, 80)
      await expect(lock.acquire()).rejects.toMatchObject({ code: 'ENGINE_LOCK_TIMEOUT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reclaims a lock whose startedAt cannot be parsed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: 'not-a-date' }))
      const lock = new FileLock(path, 1_000, 200)
      await lock.acquire()
      await lock.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('notifies the audit hook when a stale lock is reclaimed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: 'not-a-date' }))
      let reclaimed: { pid: number } | null = null
      const lock = new FileLock(path, 1_000, 200, async (record) => {
        reclaimed = record
      })
      await lock.acquire()
      expect(reclaimed).toMatchObject({ pid: process.pid })
      await lock.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('audits a stale lock reclaimed by the engine before a write', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '锁审计', genre: '都市现代', platform: 'fanqie', root })
      await writeFile(
        join(root, '.engine.lock'),
        JSON.stringify({ pid: process.pid, startedAt: 'not-a-date' }),
      )
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

  it('ignores a release when the lock file is already gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    try {
      const lock = new FileLock(join(dir, '.engine.lock'))
      await lock.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
