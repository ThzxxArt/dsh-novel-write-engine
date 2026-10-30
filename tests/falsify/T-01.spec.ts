import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { bootstrapToDraft, cleanText, harness, sampleSummary, snapshotTree } from '../helpers.js'

/**
 * T-01 / INV-03: a submission that fails a gate must not change content state.
 * The append-only journal intentionally records the refused attempt; it is
 * excluded from the content snapshot and asserted separately below.
 */
it('T-01 gate failure leaves the content tree byte-identical', async () => {
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
    const journal = await readFile(join(root, 'state/journal.jsonl'), 'utf8')
    expect(journal).toContain('"status":"aborted"')
  } finally {
    await cleanup()
  }
})
