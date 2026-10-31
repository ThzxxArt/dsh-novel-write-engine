import { mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FsStore } from '../src/store/fs.js'
import { readJournal } from '../src/store/journal.js'
import { runTransaction, snapshotFiles, type TransactionInput } from '../src/store/txn.js'
import { harness } from './helpers.js'

const FILES = ['state/chapters.yaml', 'state/world.yaml', 'state/foreshadows.yaml'] as const

const files = (): TransactionInput['files'] => [
  { path: 'state/chapters.yaml', text: 'schema_version: 1\nchapters: []\n# tx\n' },
  {
    path: 'state/world.yaml',
    text: 'schema_version: 1\nlocations: []\nabilities: []\nartifacts: []\nfactions: []\nrules: []\n# tx\n',
  },
  { path: 'state/foreshadows.yaml', text: 'schema_version: 1\nnext_seq: 1\nitems: []\n# tx\n' },
]

const rowsFor = async (store: FsStore, txid: string): Promise<string[]> => {
  const { rows } = await readJournal(store)
  return rows.filter((row) => row.txid === txid).map((row) => row.status)
}

describe('transaction compensation', () => {
  it('restores already-renamed files when a later rename fails', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '事务之书',
        genre: '都市现代',
        platform: 'fanqie',
        root,
      })
      const store = new FsStore(root)
      const before = await snapshotFiles(store, FILES)
      const input = {
        txid: 'tx-rename-fail',
        op: 'amend',
        chapter: 1,
        revision: 2,
        files: files(),
        backup: true,
        afterRename: async (_path: string, index: number) => {
          if (index === 1) throw new Error('simulated rename failure')
        },
      } as TransactionInput
      await expect(runTransaction(store, input)).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      expect(await snapshotFiles(store, FILES)).toEqual(before)
      expect(await rowsFor(store, 'tx-rename-fail')).toEqual(['aborted'])
    } finally {
      await cleanup()
    }
  })

  it('repairs a torn pending append before writing the aborted row', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '事务之书',
        genre: '都市现代',
        platform: 'fanqie',
        root,
      })
      const store = new FsStore(root)
      const original = store.appendText.bind(store)
      let torn = false
      store.appendText = async (path, text) => {
        if (!torn && path.endsWith('journal.jsonl') && text.includes('"status":"pending"')) {
          torn = true
          await original(path, text.slice(0, -8))
          throw new Error('simulated torn pending append')
        }
        return original(path, text)
      }
      await expect(
        runTransaction(store, {
          txid: 'tx-torn-pending',
          op: 'amend',
          chapter: 1,
          revision: 2,
          files: files(),
          backup: true,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      const journal = await readJournal(store)
      expect(journal.malformed).toBe(0)
      expect(journal.rows.find((row) => row.txid === 'tx-torn-pending')?.status).toBe('aborted')
    } finally {
      await cleanup()
    }
  })

  it('removes a partially written marked backup when the pre-image write fails', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '事务之书',
        genre: '都市现代',
        platform: 'fanqie',
        root,
      })
      const store = new FsStore(root)
      const original = store.writeBytes.bind(store)
      store.writeBytes = async (path, bytes) => {
        if (path.includes('/backup/')) throw new Error('simulated backup write failure')
        return original(path, bytes)
      }
      await expect(
        runTransaction(store, {
          txid: 'tx-backup-fail',
          op: 'amend',
          chapter: 1,
          revision: 2,
          files: files(),
          backup: true,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      expect(await store.exists('backups/tx-backup-fail')).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('fails closed instead of recreating a root deleted before backups are created', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '目录在备份前删除',
        genre: '都市现代',
        platform: 'fanqie',
        root,
      })
      const store = new FsStore(root)
      const original = store.ensureDir.bind(store)
      let removed = false
      store.ensureDir = async (path) => {
        if (!removed) {
          removed = true
          await rm(root, { recursive: true, force: true })
        }
        return original(path)
      }
      await expect(
        runTransaction(store, {
          txid: 'tx-root-deleted-before-backup-dir',
          op: 'amend',
          chapter: 1,
          revision: 2,
          files: files(),
          backup: true,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await cleanup()
    }
  })

  it('refuses a symlinked backups directory and writes nothing outside the project', async () => {
    const { root, engine, cleanup } = await harness()
    const outside = await mkdtemp(join(tmpdir(), 'nwe-backup-outside-'))
    try {
      await engine.initProject({
        title: '事务之书',
        genre: '都市现代',
        platform: 'fanqie',
        root,
      })
      await rm(join(root, 'backups'), { recursive: true, force: true })
      await symlink(outside, join(root, 'backups'), 'dir')
      await expect(
        runTransaction(new FsStore(root), {
          txid: 'tx-backup-symlink',
          op: 'amend',
          chapter: 1,
          revision: 2,
          files: files(),
          backup: true,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_PATH_ESCAPE' })
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
      await cleanup()
    }
  })

  it('leaves targets untouched when the abort signal fires or afterVerify throws', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '事务之书',
        genre: '都市现代',
        platform: 'fanqie',
        root,
      })
      const store = new FsStore(root)
      const before = await snapshotFiles(store, FILES)
      const controller = new AbortController()
      controller.abort()
      await expect(
        runTransaction(store, {
          txid: 'tx-signal',
          op: 'amend',
          chapter: 1,
          revision: 2,
          files: files(),
          backup: true,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      await expect(
        runTransaction(store, {
          txid: 'tx-after-verify',
          op: 'amend',
          chapter: 1,
          revision: 2,
          files: files(),
          backup: true,
          afterVerify: async () => {
            throw new Error('verify hook failed')
          },
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      expect(await snapshotFiles(store, FILES)).toEqual(before)
      expect(await rowsFor(store, 'tx-signal')).toEqual(['aborted'])
      expect(await rowsFor(store, 'tx-after-verify')).toEqual(['aborted'])
    } finally {
      await cleanup()
    }
  })

  it('restores files and records only an abort when readback detects corruption', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '事务之书',
        genre: '都市现代',
        platform: 'fanqie',
        root,
      })
      const store = new FsStore(root)
      const before = await snapshotFiles(store, FILES)
      const input = {
        txid: 'tx-readback-fail',
        op: 'amend',
        chapter: 1,
        revision: 2,
        files: files(),
        backup: true,
        afterRename: async (path: string, index: number) => {
          if (index === FILES.length - 1) await store.writeText(path, 'corrupted after rename\n')
        },
      } as TransactionInput
      await expect(runTransaction(store, input)).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      expect(await snapshotFiles(store, FILES)).toEqual(before)
      expect(await rowsFor(store, 'tx-readback-fail')).toEqual(['aborted'])
    } finally {
      await cleanup()
    }
  })

  it('fails closed without recreating a root deleted after the first rename', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '目录在提交中删除',
        genre: '都市现代',
        platform: 'fanqie',
        root,
      })
      const store = new FsStore(root)
      let removed = false
      await expect(
        runTransaction(store, {
          txid: 'tx-root-deleted-after-rename',
          op: 'amend',
          chapter: 1,
          revision: 2,
          files: files(),
          backup: true,
          afterRename: async () => {
            if (removed) return
            removed = true
            await rm(root, { recursive: true, force: true })
          },
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await cleanup()
    }
  })

  it('fails closed without recreating a root deleted while staging', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '目录在暂存中删除',
        genre: '都市现代',
        platform: 'fanqie',
        root,
      })
      const store = new FsStore(root)
      const original = store.writeText.bind(store)
      let removed = false
      store.writeText = async (path, text) => {
        const result = await original(path, text)
        if (!removed && path.startsWith('.staging/')) {
          removed = true
          await rm(root, { recursive: true, force: true })
        }
        return result
      }
      await expect(
        runTransaction(store, {
          txid: 'tx-root-deleted-while-staging',
          op: 'amend',
          chapter: 1,
          revision: 2,
          files: files(),
          backup: true,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await cleanup()
    }
  })

  it('fails closed when the root is replaced during staging', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '目录在暂存中替换',
        genre: '都市现代',
        platform: 'fanqie',
        root,
      })
      const store = new FsStore(root)
      const original = store.writeText.bind(store)
      let replaced = false
      store.writeText = async (path, text) => {
        const result = await original(path, text)
        if (!replaced && path.startsWith('.staging/')) {
          replaced = true
          await rm(root, { recursive: true, force: true })
          await mkdir(root, { recursive: true })
        }
        return result
      }
      await expect(
        runTransaction(store, {
          txid: 'tx-root-replaced-while-staging',
          op: 'amend',
          chapter: 1,
          revision: 2,
          files: files(),
          backup: true,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      expect(await new FsStore(root).list('state')).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('fails closed instead of writing into a replacement root', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '目录在提交中替换',
        genre: '都市现代',
        platform: 'fanqie',
        root,
      })
      const store = new FsStore(root)
      let replaced = false
      await expect(
        runTransaction(store, {
          txid: 'tx-root-replaced-after-rename',
          op: 'amend',
          chapter: 1,
          revision: 2,
          files: files(),
          backup: true,
          afterRename: async () => {
            if (replaced) return
            replaced = true
            await rm(root, { recursive: true, force: true })
            await mkdir(root, { recursive: true })
          },
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      const replacement = new FsStore(root)
      expect(await replacement.list('state')).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('rejects duplicate targets and mixed representations before touching the project', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '事务输入校验',
        genre: '都市现代',
        platform: 'fanqie',
        root,
      })
      const store = new FsStore(root)
      const base = {
        txid: 'tx-invalid-input',
        op: 'amend',
        chapter: 1,
        revision: 2,
        backup: false,
      }
      await expect(
        runTransaction(store, {
          ...base,
          files: [
            { path: 'state/chapters.yaml', text: 'one' },
            { path: 'state/chapters.yaml', text: 'two' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      await expect(
        runTransaction(store, {
          ...base,
          files: [{ path: 'state/chapters.yaml', text: 'one', bytes: new Uint8Array([1]) }],
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
    } finally {
      await cleanup()
    }
  })

  it('fails closed at the first root probe when the root is already gone', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'novel-txn-missing-'))
    const root = join(parent, 'gone')
    try {
      await expect(
        runTransaction(new FsStore(root), {
          txid: 'tx-root-missing',
          op: 'amend',
          chapter: 1,
          revision: 2,
          files: files(),
          backup: false,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('fails closed without recreating a project root deleted after staging', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '目录删除了',
        genre: '都市现代',
        platform: 'fanqie',
        root,
      })
      const store = new FsStore(root)
      const input = {
        txid: 'tx-root-deleted',
        op: 'amend',
        chapter: 1,
        revision: 2,
        files: files(),
        backup: true,
        afterVerify: async () => {
          await rm(root, { recursive: true, force: true })
        },
      } as TransactionInput
      await expect(runTransaction(store, input)).rejects.toMatchObject({
        code: 'ENGINE_TXN_ABORTED',
      })
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await cleanup()
    }
  })
})
