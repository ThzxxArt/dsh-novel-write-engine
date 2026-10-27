import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { harness, readProjectFile } from '../helpers.js'

/** T-08 / INV-12: a newer schema is refused and the file is never rewritten. */
it('T-08 refuses schema_version 2 without touching the document', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await engine.initProject({ title: '未来之书', genre: '都市现代', platform: 'fanqie', root })
    const path = join(root, 'novel.yaml')
    const original = (await readProjectFile(root, 'novel.yaml'))!.replace(
      'schema_version: 1',
      'schema_version: 2',
    )
    await writeFile(path, original, 'utf8')
    await expect(engine.getStatus({ root })).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_TOO_NEW' })
    await expect(engine.getBrief({ stage: 'P1', root })).rejects.toMatchObject({
      code: 'ENGINE_SCHEMA_TOO_NEW',
    })
    expect(await readFile(path, 'utf8')).toBe(original)
  } finally {
    await cleanup()
  }
})
