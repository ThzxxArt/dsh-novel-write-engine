import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FsStore } from '../src/store/fs.js'
import { inspectPending, readJournal, recoverPending } from '../src/store/journal.js'
import { runTransaction, type TransactionInput } from '../src/store/txn.js'
import { harness } from './helpers.js'

/**
 * 0.2.20 review: a transaction whose compensation failed must not claim it did.
 *
 * `runTransaction` wrote `aborted` whenever `rollbackProblem !== null`, so a
 * half-restored project looked like an untouched one: `inspectPending` returned
 * `none` and the next write went ahead over targets left at the new content.
 */
describe('0.2.20 review: incomplete compensation keeps the pending row', () => {
  it('leaves the pending row so the next write is refused', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '回滚之书', genre: '都市现代', platform: 'fanqie', root })
      const store = new FsStore(root)
      const files = [
        { path: 'state/chapters.yaml', text: 'schema_version: 1\nchapters: []\n# new\n' },
        { path: 'state/world.yaml', text: 'schema_version: 1\nlocations: []\n# new\n' },
      ]
      await expect(
        runTransaction(store, {
          txid: 'tx-partial-compensation',
          op: 'amend',
          chapter: 1,
          revision: 2,
          files,
          afterRename: async (path: string, index: number) => {
            if (index !== 1) return
            // The new content is in place; make the compensating write-back
            // impossible by replacing the target with a directory.
            await fs.rm(join(root, path), { recursive: true, force: true })
            await fs.mkdir(join(root, path), { recursive: true })
          },
        } as TransactionInput),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })

      const { records } = await readJournal(store)
      const statuses = records
        .filter((row) => row.txid === 'tx-partial-compensation')
        .map((row) => row.status)
      expect(statuses, 'no terminal row may claim the project is back at the pre-image').toEqual(['pending'])
      expect((await inspectPending(store)).state).toBe('partial')
      await expect(recoverPending(store)).rejects.toMatchObject({ code: 'ENGINE_PENDING_PARTIAL' })
      // The pre-image is still on disk: it is the only source for a manual
      // restore, so it must not be deleted with the staging directory.
      expect(
        await fs
          .stat(join(root, '.staging', 'tx-partial-compensation', 'before', 'state', 'world.yaml'))
          .then(
            () => true,
            () => false,
          ),
      ).toBe(true)
    } finally {
      await cleanup()
    }
  })
})
