import { describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsStore, joinRel, sha256 } from '../src/store/fs.js'
import { assertSafeRelative, isInside, resolveInside, toProjectPath } from '../src/store/path.js'
import { narrow, DOC_KINDS } from '../src/store/schema.js'
import { runTransaction } from '../src/store/txn.js'
import { FileLock, KeyedMutex } from '../src/store/lock.js'
import { appendJournal, readJournal } from '../src/store/journal.js'
import { migrateDocument } from '../src/store/migrate.js'

const temp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'novel-store-'))

describe('path guard', () => {
  it('rejects every escape vector', () => {
    for (const bad of [
      '../x',
      '/etc/passwd',
      'C:\\x',
      'a\\b',
      'a\0b',
      'CON',
      'com1.txt',
      '',
      'a/../../b',
      './a',
    ]) {
      expect(() => assertSafeRelative(bad), bad).toThrow(/refusing path/)
    }
    expect(() => assertSafeRelative('state/pipeline.yaml')).not.toThrow()
    expect(() => assertSafeRelative('..foo')).not.toThrow()
    expect(() => resolveInside('/tmp/root', '../x')).toThrow(/refusing path|escapes/)
    expect(resolveInside('/tmp/root', 'a/b.yaml')).toContain(join('a', 'b.yaml'))
    expect(resolveInside('/tmp/root', '..foo/a.yaml')).toContain(join('..foo', 'a.yaml'))
    expect(isInside('/tmp/root', '/tmp/root/..foo/a.yaml')).toBe(true)
    expect(isInside('/tmp/root', '/tmp/root/../outside.yaml')).toBe(false)
  })

  it('recognises project-relative paths', () => {
    expect(toProjectPath('/tmp/root', '/tmp/root/state/a.yaml')).toBe('state/a.yaml')
    expect(() => assertSafeRelative('a//b')).toThrow()
  })
})

describe('schema narrowing', () => {
  it('covers every document kind and rejects defects', () => {
    expect(DOC_KINDS).toHaveLength(16)
    const pipeline = {
      schema_version: 1,
      revision: 1,
      chapter: 1,
      stage: 'idle',
      rounds: { review: 0, revise: 0, check: 0 },
      briefs: {},
      blocking: [],
      last_action: null,
    }
    expect(() => narrow('pipeline', pipeline)).not.toThrow()
    expect(() => narrow('pipeline', null)).toThrow(/not an object/)
    expect(() => narrow('pipeline', { ...pipeline, extra: true })).toThrow(/unknown key/)
    expect(() => narrow('pipeline', { ...pipeline, schema_version: 2 })).toThrow(/newer than supported/)
    expect(() => narrow('pipeline', {})).toThrow(/schema_version/)
    expect(() => narrow('project', { schema_version: 1 })).toThrow(/missing required key/)
    expect(() =>
      narrow('project', {
        schema_version: 1,
        title: 'x',
        genre: '未知',
        platform: 'fanqie',
        author: '',
        description: '',
        created_at: '',
        targets: {},
      }),
    ).toThrow(/must be one of/)
    expect(() => narrow('pipeline', { ...pipeline, revision: 'x' })).toThrow(/must be integer/)
  })
})

describe('FsStore', () => {
  it('never recreates a missing store root on write or append', async () => {
    const parent = await temp()
    const root = join(parent, 'gone')
    try {
      const store = new FsStore(root)
      await expect(store.writeText('state/a.yaml', 'x')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(store.writeBytes('state/b.bin', Buffer.from([1]))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(store.appendText('state/journal.jsonl', 'x\n')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('cleans up temp files when a parent path is not a directory', async () => {
    const root = await temp()
    try {
      const store = new FsStore(root)
      await writeFile(join(root, 'blocked'), 'x')
      // Windows reports ENOENT when a child is opened beneath a regular file;
      // POSIX reports ENOTDIR. Both mean the parent is not a directory.
      const notDirectoryCode = process.platform === 'win32' ? 'ENOENT' : 'ENOTDIR'
      await expect(store.writeText('blocked/child', 'x')).rejects.toMatchObject({
        code: notDirectoryCode,
      })
      await expect(store.writeBytes('blocked/child', Buffer.from([1]))).rejects.toMatchObject({
        code: notDirectoryCode,
      })
      await expect(store.appendText('blocked/journal', 'x')).rejects.toMatchObject({
        code: notDirectoryCode,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes atomically, reads back and hashes', async () => {
    const root = await temp()
    try {
      const store = new FsStore(root)
      await store.writeText('state/a.yaml', 'hello')
      expect(await store.readText('state/a.yaml')).toBe('hello')
      expect(await store.readText('state/missing.yaml')).toBeNull()
      expect(await store.exists('state/a.yaml')).toBe(true)
      expect(await store.hashOf('state/a.yaml')).toBe(sha256('hello'))
      expect(await store.hashBytes('state/a.yaml')).not.toBeNull()
      expect(await store.stat('state/a.yaml')).toMatchObject({ size: 5 })
      expect(await store.stat('state/missing')).toBeNull()
      await store.writeBytes('state/b.bin', Buffer.from([1, 2, 3]))
      expect((await store.readBytes('state/b.bin'))?.length).toBe(3)
      expect(await store.list('state')).toEqual(['a.yaml', 'b.bin'])
      expect(await store.list('nope')).toEqual([])
      const leftovers = (await readdir(join(root, 'state'))).filter((name) => name.endsWith('.tmp'))
      expect(leftovers).toEqual([])
      await store.remove('state/a.yaml')
      expect(await store.exists('state/a.yaml')).toBe(false)
      await expect(store.writeText('../escape', 'x')).rejects.toThrow()
      await store.ensureDir('chapters')
      expect(await store.exists('chapters')).toBe(true)
      await writeFile(join(root, 'state', 'bad.yaml'), 'a: [')
      await expect(store.readDoc('state/bad.yaml', 'world')).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(store.readDoc('state/bad.yaml', 'world')).rejects.toThrow(/state\/bad\.yaml/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('wraps raw permission failures as ENGINE_IO_PERMISSION', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const root = await temp()
    try {
      const store = new FsStore(root)
      await store.writeText('state/a.yaml', 'hello')
      await chmod(join(root, 'state/a.yaml'), 0o000)
      try {
        await expect(store.readText('state/a.yaml')).rejects.toMatchObject({
          code: 'ENGINE_IO_PERMISSION',
        })
      } finally {
        await chmod(join(root, 'state/a.yaml'), 0o600)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('transactions', () => {
  it('commits text and binary files and journals the txid', async () => {
    const root = await temp()
    try {
      const store = new FsStore(root)
      await store.writeText('chapters/chapter-001.md', '旧稿')
      await runTransaction(store, {
        txid: 'tx-1',
        op: 'archiveChapter',
        chapter: 1,
        revision: 2,
        files: [
          { path: 'novel.yaml', text: 'live: true' },
          { path: 'bin', bytes: Buffer.from([0, 255]) },
        ],
        backup: true,
      })
      expect(await store.readText('novel.yaml')).toBe('live: true')
      expect((await store.readBytes('bin'))?.length).toBe(2)
      const journal = await readJournal(store)
      expect(journal.rows).toEqual([
        expect.objectContaining({ txid: 'tx-1', status: 'committed', op: 'archiveChapter' }),
      ])
      expect(await store.readBytes(joinRel('backups', 'tx-1', 'chapters/chapter-001.md'))).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('aborts with zero target changes and an aborted journal row', async () => {
    const root = await temp()
    try {
      const store = new FsStore(root)
      await store.writeText('chapters/chapter-001.md', '旧稿')
      const before = await store.readText('chapters/chapter-001.md')
      await expect(
        runTransaction(store, {
          txid: 'tx-2',
          op: 'submitDraft',
          chapter: 1,
          revision: 3,
          backup: true,
          files: [
            { path: 'chapters/chapter-001.md', text: '新稿' },
            { path: 'state/a.yaml', text: 'x' },
            { path: 'state/b.yaml', text: 'y' },
          ],
          afterVerify: async () => {
            throw new Error('injected failure')
          },
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      expect(await store.readText('chapters/chapter-001.md')).toBe(before)
      expect(await store.exists('state/a.yaml')).toBe(false)
      const journal = await readJournal(store)
      expect(journal.rows.at(-1)).toMatchObject({ status: 'aborted', txid: 'tx-2' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects duplicate staging paths before writing any target', async () => {
    const root = await temp()
    try {
      const store = new FsStore(root)
      await expect(
        runTransaction(store, {
          txid: 'tx-duplicate',
          op: 'submitDraft',
          chapter: 1,
          revision: 1,
          files: [
            { path: 'state/pipeline.yaml', text: 'first' },
            { path: 'state/pipeline.yaml', text: 'second' },
          ],
          backup: false,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      expect(await store.exists('state/pipeline.yaml')).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('honours a pre-aborted signal before touching targets', async () => {
    const root = await temp()
    try {
      const store = new FsStore(root)
      const controller = new AbortController()
      controller.abort()
      await expect(
        runTransaction(store, {
          txid: 'tx-3',
          op: 'submitDraft',
          chapter: 1,
          revision: 1,
          files: [{ path: 'x.yaml', text: 'x' }],
          backup: false,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      expect(await store.exists('x.yaml')).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('locks and mutex', () => {
  it('serializes by key and keeps different keys independent', async () => {
    const mutex = new KeyedMutex()
    const order: string[] = []
    const first = mutex.run('a', async () => {
      order.push('a1-start')
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('a1-end')
    })
    const second = mutex.run('a', async () => {
      order.push('a2')
    })
    const other = mutex.run('b', async () => {
      order.push('b')
    })
    await Promise.all([first, second, other])
    expect(order.indexOf('a2')).toBeGreaterThan(order.indexOf('a1-end'))
    expect(mutex.size).toBe(0)
  })

  it('acquires, releases, and reclaims a stale lock', async () => {
    const root = await temp()
    const path = join(root, '.engine.lock')
    try {
      const lock = new FileLock(path, 50, 100)
      await lock.acquire()
      await expect(new FileLock(path, 50, 20).acquire()).rejects.toMatchObject({
        code: 'ENGINE_LOCK_TIMEOUT',
      })
      await lock.release()
      await writeFile(path, JSON.stringify({ pid: 999_999, startedAt: new Date(0).toISOString() }))
      const reclaimed = new FileLock(path, 1_000, 200)
      await reclaimed.acquire()
      await reclaimed.release()
      expect(await readdir(root)).not.toContain('.engine.lock')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reclaims corrupt lock content only after the stale window', async () => {
    const root = await temp()
    const path = join(root, '.engine.lock')
    try {
      await writeFile(path, 'not json')
      const fresh = new FileLock(path, 1000, 80)
      await expect(fresh.acquire()).rejects.toMatchObject({ code: 'ENGINE_LOCK_TIMEOUT' })
      const old = new Date(Date.now() - 5_000)
      await utimes(path, old, old)
      const stale = new FileLock(path, 1000, 200)
      await stale.acquire()
      await stale.release()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('journal and migrations', () => {
  it('reads records and counts malformed lines without rewriting', async () => {
    const root = await temp()
    try {
      const store = new FsStore(root)
      await appendJournal(store, {
        txid: 't1',
        at: '2026-01-01',
        op: 'x',
        chapter: 1,
        revision: 1,
        files: [],
        status: 'committed',
      })
      await store.appendText('state/journal.jsonl', 'broken\n{"txid":2}\n')
      const result = await readJournal(store)
      expect(result.rows).toHaveLength(1)
      expect(result.malformed).toBe(2)
      expect((await readJournal(new FsStore(join(root, 'empty')))).rows).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('migrates through a synthetic chain and refuses unknown versions', () => {
    const chain = [{ from: 1, to: 2, migrate: (doc: Record<string, unknown>) => ({ ...doc, added: true }) }]
    expect(migrateDocument({ schema_version: 1 }, chain, 1)).toEqual({ schema_version: 1 })
    expect(() => migrateDocument({ schema_version: 3 }, chain, 2)).toThrow(/newer than supported/)
    expect(() => migrateDocument({ schema_version: 1 }, [], 2)).toThrow(/no migration/)
  })

  it('T-09: a failing migration step leaves the source document untouched', () => {
    const original = { schema_version: 1, value: 'kept' }
    const chain = [
      {
        from: 1,
        to: 2,
        migrate: (doc: Record<string, unknown>) => {
          doc.value = 'partially-mutated'
          throw new Error('migration failed')
        },
      },
    ]
    expect(() => migrateDocument(original, chain, 2)).toThrow(/migration failed/)
    expect(original).toEqual({ schema_version: 1, value: 'kept' })
  })
})
