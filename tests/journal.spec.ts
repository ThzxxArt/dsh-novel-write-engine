import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FsStore } from '../src/store/fs.js'
import { listBackups } from '../src/store/backup.js'
import { appendJournal, assertJournalConsistent, readJournal } from '../src/store/journal.js'
import { runTransaction } from '../src/store/txn.js'
import { harness } from './helpers.js'

const world = (marker: string): string =>
  [
    'schema_version: 1',
    'locations: []',
    `abilities: [{ name: ${marker} }]`,
    'artifacts: []',
    'factions: []',
    'rules: []',
    '',
  ].join('\n')

describe('journal reconciliation', () => {
  it('blocks the next write when the last committed file was changed externally', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '对账之书', genre: '都市现代', platform: 'fanqie', root })
      await engine.amend({
        path: 'state/world.yaml',
        content: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
        reason: '初始',
        root,
      })
      await writeFile(join(root, 'state/world.yaml'), world('EXTERNAL'), 'utf8')
      await expect(
        engine.amend({
          path: 'state/world.yaml',
          content: {
            schema_version: 1,
            locations: [],
            abilities: [],
            artifacts: [],
            factions: [],
            rules: [],
          },
          reason: '再次',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      const audit = await engine.auditHistory({ root, limit: 20 })
      expect(audit.warnings).toEqual([expect.objectContaining({ code: 'JOURNAL_HASH_MISMATCH' })])
    } finally {
      await cleanup()
    }
  })
})

describe('pending journal recovery', () => {
  it('promotes a pending transaction when every target already landed', async () => {
    const { root, cleanup } = await harness()
    try {
      const store = new FsStore(root)
      await store.writeText('state/world.yaml', world('LANDED'))
      const hash = await store.hashBytes('state/world.yaml')
      expect(hash).not.toBeNull()
      await appendJournal(store, {
        txid: 'crash-after-rename',
        at: new Date().toISOString(),
        op: 'amend',
        chapter: 1,
        revision: 2,
        files: ['state/world.yaml'],
        status: 'pending',
        hashes: { 'state/world.yaml': hash! },
        before: { 'state/world.yaml': null },
      })
      await expect(assertJournalConsistent(store)).resolves.toBeUndefined()
      const journal = await readJournal(store)
      expect(journal.records.at(-1)).toMatchObject({ txid: 'crash-after-rename', status: 'committed' })
      expect(journal.rows.at(-1)).toMatchObject({ status: 'committed' })
    } finally {
      await cleanup()
    }
  })

  it('refuses to guess when a pending transaction partially renamed targets', async () => {
    const { root, cleanup } = await harness()
    try {
      const store = new FsStore(root)
      await store.writeText('state/world.yaml', world('OLD'))
      const before = await store.hashBytes('state/world.yaml')
      expect(before).not.toBeNull()
      await appendJournal(store, {
        txid: 'baseline',
        at: new Date().toISOString(),
        op: 'amend',
        chapter: 1,
        revision: 1,
        files: ['state/world.yaml'],
        status: 'committed',
        hashes: { 'state/world.yaml': before! },
      })
      await store.writeText('state/world.yaml', world('PARTIAL'))
      await appendJournal(store, {
        txid: 'crash-mid-rename',
        at: new Date().toISOString(),
        op: 'amend',
        chapter: 1,
        revision: 2,
        files: ['state/world.yaml'],
        status: 'pending',
        hashes: { 'state/world.yaml': `${before!}-expected` },
        before: { 'state/world.yaml': before! },
      })
      await expect(assertJournalConsistent(store)).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
    } finally {
      await cleanup()
    }
  })

  it('closes a pending transaction as aborted when the old bytes are intact', async () => {
    const { root, cleanup } = await harness()
    try {
      const store = new FsStore(root)
      await store.writeText('state/world.yaml', world('OLD'))
      const oldHash = await store.hashBytes('state/world.yaml')
      expect(oldHash).not.toBeNull()
      await appendJournal(store, {
        txid: 'baseline',
        at: new Date().toISOString(),
        op: 'amend',
        chapter: 1,
        revision: 1,
        files: ['state/world.yaml'],
        status: 'committed',
        hashes: { 'state/world.yaml': oldHash! },
      })
      await appendJournal(store, {
        txid: 'crash-before-rename',
        at: new Date().toISOString(),
        op: 'amend',
        chapter: 1,
        revision: 2,
        files: ['state/world.yaml'],
        status: 'pending',
        hashes: { 'state/world.yaml': `${oldHash!}-different` },
        before: { 'state/world.yaml': oldHash! },
      })
      await expect(assertJournalConsistent(store)).resolves.toBeUndefined()
      const journal = await readJournal(store)
      expect(journal.records.at(-1)).toMatchObject({ txid: 'crash-before-rename', status: 'aborted' })
    } finally {
      await cleanup()
    }
  })
  it('counts an unknown journal status as malformed instead of trusting it', async () => {
    const { root, cleanup } = await harness()
    try {
      const store = new FsStore(root)
      await store.appendText(
        'state/journal.jsonl',
        `${JSON.stringify({ txid: 'bad', op: 'amend', status: 'future' })}\n`,
      )
      const journal = await readJournal(store)
      expect(journal.malformed).toBe(1)
      expect(journal.records).toHaveLength(0)
      await expect(assertJournalConsistent(store)).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
    } finally {
      await cleanup()
    }
  })
})

describe('backup retention', () => {
  it('keeps only the newest configured number of backup directories', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '备份之书', genre: '都市现代', platform: 'fanqie', root })
      const store = new FsStore(root)
      for (const marker of ['ONE', 'TWO', 'THREE']) {
        await runTransaction(store, {
          txid: `tx-${marker}`,
          op: 'amend',
          chapter: 1,
          revision: 2,
          files: [{ path: 'state/world.yaml', text: world(marker) }],
          backup: true,
          backupRetention: 1,
        })
      }
      expect(await listBackups(store)).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })
})
