import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FsStore } from '../../src/store/fs.js'

/** T-07 / INV-09: every path escape shape is refused before any write. */
it('T-07 rejects traversal, absolute paths, NUL and Windows device names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'novel-path-'))
  try {
    const store = new FsStore(root)
    for (const path of ['../x', '/etc/passwd', 'C:\\x', 'a\0b', 'CON', 'com1.txt', '..\\x']) {
      expect(() => store.path(path), path).toThrowError(
        expect.objectContaining({ code: 'ENGINE_PATH_ESCAPE' }),
      )
    }
    expect(store.path('state/pipeline.yaml')).toContain(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
