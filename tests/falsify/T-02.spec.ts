import { expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { EngineService } from '../../src/engine/service.js'
import { loadRulepack } from '../../src/rulepack.js'
import {
  FIXED_NOW,
  TEST_CONFIG,
  archiveDelta,
  harness,
  readProjectFile,
  readyToArchive,
  sampleSummary,
} from '../helpers.js'

/**
 * T-02 / INV-06: two independent engine instances archiving one chapter produce
 * one commit and one idempotent replay (or the documented lock timeout), never
 * two writes. A real child-process lock holder is covered in tests/lock.spec.ts.
 */
it('T-02 concurrent archives produce one commit and one replay', async () => {
  const { root, engine, cleanup } = await harness()
  const second = new EngineService({ ...TEST_CONFIG, projectRoot: root }, () => loadRulepack(), {
    now: FIXED_NOW,
  })
  try {
    await readyToArchive({ root, engine })
    const delta = archiveDelta(sampleSummary())
    const results = await Promise.allSettled([
      engine.archiveChapter({ chapter: 1, state_delta: delta, root }),
      second.archiveChapter({ chapter: 1, state_delta: delta, root }),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const timedOut = results.filter(
      (result) =>
        result.status === 'rejected' &&
        typeof result.reason === 'object' &&
        result.reason !== null &&
        (result.reason as { code?: string }).code === 'ENGINE_LOCK_TIMEOUT',
    )
    expect(fulfilled.length + timedOut.length).toBe(2)
    expect(
      fulfilled.filter((result) => result.status === 'fulfilled' && result.value.replayed === true),
    ).toHaveLength(1)
    expect(
      fulfilled.filter((result) => result.status === 'fulfilled' && result.value.replayed !== true),
    ).toHaveLength(1)

    for (const name of [
      'chapters',
      'characters',
      'world',
      'locks',
      'timeline',
      'foreshadows',
      'relationships',
    ]) {
      expect(parseYaml((await readProjectFile(root, `state/${name}.yaml`))!)).toBeTypeOf('object')
    }
    const chapters = parseYaml((await readProjectFile(root, 'state/chapters.yaml'))!) as {
      chapters: unknown[]
    }
    expect(chapters.chapters).toHaveLength(1)
    const pipeline = parseYaml((await readProjectFile(root, 'state/pipeline.yaml'))!) as {
      stage: string
    }
    expect(pipeline.stage).toBe('done')
    const audit = await engine.auditHistory({ root, limit: 100 })
    expect(
      audit.data.filter((row) => row.op === 'archiveChapter' && row.status === 'committed'),
    ).toHaveLength(1)
  } finally {
    await cleanup()
  }
})
