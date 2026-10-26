import { expect, it } from 'vitest'
import { bootstrapToDraft, cleanText, harness, sampleSummary, snapshotTree } from '../helpers.js'

/**
 * T-01 / INV-03: a submission that fails a gate must not write a single byte.
 * Snapshots include a content hash, not only size/mtime.
 */
it('T-01 gate failure leaves the project tree byte-identical', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await bootstrapToDraft({ root, engine })
    await engine.getBrief({ stage: 'P3', root })
    const before = await snapshotTree(root)
    await expect(
      engine.submitDraft({
        chapter: 1,
        content: cleanText(),
        chapter_title: '开端之雨',
        scene_type: '日常过渡章',
        narrator: '他',
        summary: sampleSummary({ opening: '这句话不在前两段里' }),
        root,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_GATE_BLOCKED' })
    const after = await snapshotTree(root)
    expect([...after.entries()]).toEqual([...before.entries()])
  } finally {
    await cleanup()
  }
})
