import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FsStore } from '../src/store/fs.js'
import { listBackups } from '../src/store/backup.js'
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
