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
})
