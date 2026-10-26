import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FsStore } from '../../src/store/fs.js'
import { migrateProjectFile, type MigrationStep } from '../../src/store/migrate.js'

/**
 * T-09 / §6.9: a migration failure restores the exact file bytes. This is the
 * file-level rollback the project migration will use once a v1 predecessor
 * exists; the runner's in-memory contract is pinned separately.
 */
it('T-09 a successful file migration writes the target version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novel-migrate-'))
  try {
    const store = new FsStore(root)
    await writeFile(join(root, 'novel.yaml'), 'schema_version: 1\ntitle: 原稿\n', 'utf8')
    const chain: MigrationStep[] = [
      { from: 1, to: 2, migrate: (document) => ({ ...document, title: '迁移后' }) },
    ]
    await expect(migrateProjectFile(store, 'novel.yaml', chain, 2)).resolves.toBe(true)
    const after = await readFile(join(root, 'novel.yaml'), 'utf8')
    expect(after).toContain('schema_version: 2')
    expect(after).toContain('迁移后')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('T-09 refuses a missing target file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novel-migrate-'))
  try {
    const store = new FsStore(root)
    await expect(migrateProjectFile(store, 'missing.yaml')).rejects.toMatchObject({
      code: 'ENGINE_SCHEMA_INVALID',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('T-09 a failing file migration restores the pre-image', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novel-migrate-'))
  try {
    const store = new FsStore(root)
    const before = 'schema_version: 1\ntitle: 原稿\nnested:\n  value: 7\n'
    await writeFile(join(root, 'novel.yaml'), before, 'utf8')
    const chain: MigrationStep[] = [
      {
        from: 1,
        to: 2,
        migrate: (document) => {
          document.title = '被改坏'
          throw new Error('migration injected failure')
        },
      },
    ]
    await expect(migrateProjectFile(store, 'novel.yaml', chain, 2)).rejects.toThrow(
      'migration injected failure',
    )
    expect(await readFile(join(root, 'novel.yaml'), 'utf8')).toBe(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('T-09 is a no-op at the target version and rejects a non-monotonic chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novel-migrate-'))
  try {
    const store = new FsStore(root)
    const before = 'schema_version: 2\ntitle: 原稿\n'
    await writeFile(join(root, 'novel.yaml'), before, 'utf8')
    await expect(migrateProjectFile(store, 'novel.yaml', [], 2)).resolves.toBe(false)
    const chain: MigrationStep[] = [{ from: 1, to: 1, migrate: (document) => document }]
    await writeFile(join(root, 'novel.yaml'), 'schema_version: 1\ntitle: 原稿\n', 'utf8')
    await expect(migrateProjectFile(store, 'novel.yaml', chain, 2)).rejects.toMatchObject({
      code: 'ENGINE_SCHEMA_INVALID',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('T-09 restores the pre-image when the write itself fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novel-migrate-'))
  try {
    class FailingStore extends FsStore {
      override async writeText(): Promise<void> {
        throw new Error('disk full')
      }
    }
    const store = new FailingStore(root)
    const before = 'schema_version: 1\ntitle: 原稿\n'
    await writeFile(join(root, 'novel.yaml'), before, 'utf8')
    const chain: MigrationStep[] = [
      { from: 1, to: 2, migrate: (document) => ({ ...document, title: '新的' }) },
    ]
    await expect(migrateProjectFile(store, 'novel.yaml', chain, 2)).rejects.toThrow('disk full')
    expect(await readFile(join(root, 'novel.yaml'), 'utf8')).toBe(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
