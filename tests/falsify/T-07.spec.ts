import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FsStore } from '../../src/store/fs.js'

/** T-07 / INV-09: every path escape shape is refused before any write. */
it('T-07 rejects traversal, absolute paths, NUL, Windows device names and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novel-path-'))
  try {
    const store = new FsStore(root)
    for (const path of ['../x', '/etc/passwd', 'C:\\x', 'a\0b', 'CON', 'com1.txt', '..\\x']) {
      expect(() => store.path(path), path).toThrowError(
        expect.objectContaining({ code: 'ENGINE_PATH_ESCAPE' }),
      )
    }
    expect(store.path('state/pipeline.yaml')).toContain(root)
    const outside = await mkdtemp(join(tmpdir(), 'novel-path-outside-'))
    try {
      await symlink(outside, join(root, 'escape'), 'dir')
      await expect(store.writeText('escape/leak.txt', 'x')).rejects.toMatchObject({
        code: 'ENGINE_PATH_ESCAPE',
      })
      for (const operation of [
        () => store.exists('escape/leak.txt'),
        () => store.stat('escape/leak.txt'),
        () => store.list('escape'),
        () => store.readBytes('escape/leak.txt'),
      ]) {
        await expect(operation()).rejects.toMatchObject({ code: 'ENGINE_PATH_ESCAPE' })
      }
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
