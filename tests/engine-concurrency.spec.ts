import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { EngineService } from '../src/engine/service.js'
import { loadRulepack } from '../src/rulepack.js'
import { FIXED_NOW, TEST_CONFIG, bootstrapToDraft, harness, readProjectFile } from './helpers.js'

type Load = (root?: string) => Promise<unknown>

const emptyWorld = (marker: string): Record<string, unknown> => ({
  schema_version: 1,
  locations: [],
  abilities: [{ name: marker }],
  artifacts: [],
  factions: [],
  rules: [],
})

describe('cross-process write lock', () => {
  it('loads the snapshot only after the file lock is held', async () => {
    const { root, engine, cleanup } = await harness()
    const second = new EngineService({ ...TEST_CONFIG, projectRoot: root }, () => loadRulepack(), {
      now: FIXED_NOW,
    })
    try {
      await bootstrapToDraft({ root, engine })
      const before = (
        parseYaml((await readProjectFile(root, 'state/pipeline.yaml'))!) as {
          revision: number
        }
      ).revision

      let releaseFirst!: () => void
      const holdFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      let firstLoaded!: () => void
      const firstLoadSignal = new Promise<void>((resolve) => {
        firstLoaded = resolve
      })
      const original = (engine as unknown as { load: Load }).load.bind(engine)
      ;(engine as unknown as { load: Load }).load = async (projectRoot?: string) => {
        const snapshot = await original(projectRoot)
        firstLoaded()
        await holdFirst
        return snapshot
      }

      const first = engine.amend({
        path: 'state/world.yaml',
        content: emptyWorld('A 的能力'),
        reason: 'A 的修改',
        root,
      })
      await firstLoadSignal
      const secondWrite = second.amend({
        path: 'state/world.yaml',
        content: emptyWorld('B 的能力'),
        reason: 'B 的修改',
        root,
      })
      // Give the second writer time to reach the lock. With the old ordering it
      // reads and commits while the first writer is still holding its snapshot.
      await new Promise((resolve) => setTimeout(resolve, 80))
      releaseFirst()
      const results = await Promise.allSettled([first, secondWrite])
      expect(results.every((result) => result.status === 'fulfilled')).toBe(true)
      const pipeline = parseYaml((await readProjectFile(root, 'state/pipeline.yaml'))!) as {
        revision: number
      }
      expect(pipeline.revision).toBe(before + 2)
    } finally {
      await cleanup()
    }
  }, 20_000)
})
