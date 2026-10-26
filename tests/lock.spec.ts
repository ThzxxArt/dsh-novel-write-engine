import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileLock } from '../src/store/lock.js'

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
