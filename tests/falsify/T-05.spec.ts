import { expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  archiveDelta,
  cleanText,
  harness,
  readProjectFile,
  readyToArchive,
  sampleSummary,
} from '../helpers.js'

/** T-05 / PG-12: a new character in the summary must be declared in state_delta. */
it('T-05 an undeclared appeared character aborts the archive with no ledger write', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    const summary = sampleSummary({
      characters_appeared: ['他', '新角色'],
    })
    await readyToArchive({
      root,
      engine,
      summary,
      text: `${cleanText()}\n\n新角色站在门口，把一封旧信封放在桌角，指尖敲了两下。`,
    })
    const delta = archiveDelta(summary)
    delete delta.characters['新角色']
    await expect(engine.archiveChapter({ chapter: 1, state_delta: delta, root })).rejects.toMatchObject({
      code: 'ENGINE_DELTA_UNVERIFIED',
    })
    const characters = parseYaml((await readProjectFile(root, 'state/characters.yaml'))!) as {
      characters: unknown[]
    }
    expect(characters.characters).toHaveLength(0)
    const chapters = parseYaml((await readProjectFile(root, 'state/chapters.yaml'))!) as {
      chapters: unknown[]
    }
    expect(chapters.chapters).toHaveLength(0)
  } finally {
    await cleanup()
  }
})
