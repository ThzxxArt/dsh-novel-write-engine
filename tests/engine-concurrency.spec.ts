import { describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { EngineService } from '../src/engine/service.js'
import { loadRulepack } from '../src/rulepack.js'
import { FileLock } from '../src/store/lock.js'
import { FIXED_NOW, TEST_CONFIG, bootstrapToDraft, harness, readProjectFile } from './helpers.js'

type LoadAt = (selection: { root: string }, retries?: number, allowLock?: boolean) => Promise<unknown>

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
      const original = (engine as unknown as { loadAt: LoadAt }).loadAt.bind(engine)
      ;(engine as unknown as { loadAt: LoadAt }).loadAt = async (...args) => {
        const snapshot = await original(...args)
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
      // Instrument the lock attempt instead of sleeping: the second writer must
      // reach acquire() while the first still holds the lock, and must not have
      // loaded a snapshot before that.
      let secondTriedLock = false
      let secondLoaded = false
      const originalAcquire = FileLock.prototype.acquire
      const spy = vi.spyOn(FileLock.prototype, 'acquire').mockImplementation(async function (this: FileLock) {
        secondTriedLock = true
        return originalAcquire.call(this)
      })
      const originalSecond = (second as unknown as { loadAt: LoadAt }).loadAt.bind(second)
      ;(second as unknown as { loadAt: LoadAt }).loadAt = async (...args) => {
        secondLoaded = true
        return originalSecond(...args)
      }
      const secondWrite = second.amend({
        path: 'state/world.yaml',
        content: emptyWorld('B 的能力'),
        reason: 'B 的修改',
        root,
      })
      await vi.waitFor(() => {
        expect(secondTriedLock).toBe(true)
      })
      expect(secondLoaded).toBe(false)
      spy.mockRestore()
      releaseFirst()
      const results = await Promise.allSettled([first, secondWrite])
      const rejected = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => String(result.reason))
      expect(rejected).toEqual([])
      const pipeline = parseYaml((await readProjectFile(root, 'state/pipeline.yaml'))!) as {
        revision: number
      }
      expect(pipeline.revision).toBe(before + 2)
    } finally {
      await cleanup()
    }
  }, 20_000)
})
