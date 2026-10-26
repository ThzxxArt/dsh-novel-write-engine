import { expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { archiveDelta, harness, readProjectFile, readyToArchive, sampleSummary } from '../helpers.js'

/** T-02 / INV-06: two archives of one chapter cannot both commit. */
it('T-02 concurrent archives produce one winner and one refusal', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await readyToArchive({ root, engine })
    const delta = archiveDelta(sampleSummary())
    const results = await Promise.allSettled([
      engine.archiveChapter({ chapter: 1, state_delta: delta, root }),
      engine.archiveChapter({ chapter: 1, state_delta: delta, root }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)

    const chapters = parseYaml((await readProjectFile(root, 'state/chapters.yaml'))!) as {
      chapters: unknown[]
    }
    expect(chapters.chapters).toHaveLength(1)
    const pipeline = parseYaml((await readProjectFile(root, 'state/pipeline.yaml'))!) as {
      stage: string
    }
    expect(pipeline.stage).toBe('done')
  } finally {
    await cleanup()
  }
})
