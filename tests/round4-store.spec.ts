import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FsStore, joinRel, sha256 } from '../src/store/fs.js'
import { FileLock } from '../src/store/lock.js'
import { appendJournal, assertJournalConsistent } from '../src/store/journal.js'
import { BACKUP_MARKER, listBackups, pruneBackups } from '../src/store/backup.js'
import { runTransaction } from '../src/store/txn.js'

const hash = (text: string): string => sha256(Buffer.from(text, 'utf8').toString('base64'))

it('keeps a recovery pre-image in staging for a crashed pending transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novel-recovery-'))
  try {
    const store = new FsStore(root)
    await store.writeText('state/world.yaml', 'old: true\n')
    await store.writeText('.staging/crash/before/state/world.yaml', 'old: true\n')
    await store.writeText('state/world.yaml', 'partial: true\n')
    await appendJournal(store, {
      txid: 'crash',
      at: new Date().toISOString(),
      op: 'amend',
      chapter: 1,
      revision: 2,
      files: ['state/world.yaml'],
      status: 'pending',
      hashes: { 'state/world.yaml': hash('new: true\n') },
      before: { 'state/world.yaml': hash('old: true\n') },
    })
    await expect(assertJournalConsistent(store)).rejects.toMatchObject({ code: 'ENGINE_PENDING_PARTIAL' })
    expect(await store.readText('.staging/crash/before/state/world.yaml')).toBe('old: true\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('only one concurrent lock holder reclaims the same stale record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'novel-lock-race-'))
  const path = join(dir, '.engine.lock')
  try {
    await writeFile(
      path,
      JSON.stringify({ pid: 999_999, startedAt: '1999-01-01T00:00:00.000Z', nonce: 'stale' }),
    )
    const first = new FileLock(path, 500, 300)
    const second = new FileLock(path, 500, 300)
    const results = await Promise.allSettled([first.acquire(), second.acquire()])
    const held = results.filter((result) => result.status === 'fulfilled')
    expect(held).toHaveLength(1)
    await first.release()
    await second.release()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('never prunes an unmarked user file under backups/', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novel-backup-'))
  try {
    const store = new FsStore(root)
    await store.writeText(joinRel('backups', 'README.md'), '用户文件')
    await runTransaction(store, {
      txid: 'tx-one',
      op: 'amend',
      chapter: 1,
      revision: 1,
      files: [{ path: 'state/world.yaml', text: 'a: 1\n' }],
      backup: true,
      backupRetention: 1,
    })
    await store.writeText(joinRel('backups', 'tx-one', BACKUP_MARKER), '1')
    await store.writeText(joinRel('backups', 'migrations', 'v1', 'before.yaml'), 'old: true\n')
    expect(await store.readText(joinRel('backups', 'README.md'))).toBe('用户文件')
    expect((await listBackups(store)).length).toBeGreaterThanOrEqual(1)
    await pruneBackups(store, 1)
    expect(await store.readText(joinRel('backups', 'README.md'))).toBe('用户文件')
    expect(await store.readText(joinRel('backups', 'migrations', 'v1', 'before.yaml'))).toBe('old: true\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
