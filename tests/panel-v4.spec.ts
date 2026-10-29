import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { panelHandler } from '../src/remote/index.js'
import type { EngineService } from '../src/engine/service.js'
import { ERROR_CODES, EngineFaultError } from '../src/types.js'
import { formatResumePrompt } from '../src/engine/projections.js'
import { FsStore } from '../src/store/fs.js'
import { SessionBindings } from '../src/store/bindings.js'
import { harness } from './helpers.js'

const init = async (engine: EngineService, root: string, title: string): Promise<void> => {
  await engine.initProject({ title, genre: '都市现代', platform: 'fanqie', root })
}

const response = () => {
  const record = { statusCode: 0, headers: {} as Record<string, string>, body: '' }
  return {
    record,
    get statusCode(): number {
      return record.statusCode
    },
    set statusCode(value: number) {
      record.statusCode = value
    },
    setHeader: (name: string, value: string) => {
      record.headers[name] = value
    },
    end: (body: string) => {
      record.body = body
    },
  }
}

describe('panel bundle v4', () => {
  it('offers every project and chooses active or an explicit query root', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-panel-state-'))
    const other = await mkdtemp(join(tmpdir(), 'novel-panel-b-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '甲书')
      await init(engine, other, '乙书')
      await engine.setActiveProject({ root })
      const active = await engine.panelBundle()
      expect(active.selection).toEqual({ root, source: 'active' })
      expect(active.summary?.root).toBe(root)
      expect(active.projects.map((project) => project.root).sort()).toEqual([root, other].sort())
      expect(active.projects.find((project) => project.root === root)?.active).toBe(true)
      expect(active.resume?.text).toContain(root)

      const queried = await engine.panelBundle({ root: other })
      expect(queried.selection).toEqual({ root: other, source: 'query' })
      expect(queried.summary?.root).toBe(other)
      expect(queried.resume?.text).toBe(
        formatResumePrompt({
          title: queried.summary!.title,
          root: queried.summary!.root,
          chapter: queried.summary!.chapter,
          stage: queried.summary!.stage,
          nextTool: queried.summary!.next!.tool,
        }),
      )
    } finally {
      await cleanup()
      await rm(other, { recursive: true, force: true })
    }
  })

  it('covers empty, single, config and stale-active selections', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-panel-state-'))
    const missingConfig = join(await mkdtemp(join(tmpdir(), 'novel-panel-config-')), 'absent')
    const fresh = await harness({ stateDir, projectRoot: missingConfig })
    try {
      const empty = await fresh.engine.panelBundle()
      expect(empty.empty).toBe(true)
      expect(empty.selection).toEqual({ root: null, source: 'none' })
      expect(empty.error).toContain('novel_init')
    } finally {
      await fresh.cleanup()
    }

    const { root, engine, cleanup } = await harness({
      stateDir: await mkdtemp(join(tmpdir(), 'novel-panel-state-')),
    })
    try {
      await init(engine, root, '单本')
      const single = await engine.panelBundle()
      expect(single.selection).toEqual({ root, source: 'single' })
      await engine.forgetProject({ root })
      const config = await engine.panelBundle()
      expect(config.selection).toEqual({ root, source: 'config' })
      await engine.setActiveProject({ root })
      await rm(root, { recursive: true, force: true })
      const stale = await engine.panelBundle()
      expect(stale.selection).toEqual({ root, source: 'active' })
      expect(stale.missing?.reason).toBe('missing')
    } finally {
      await cleanup()
    }
  })

  it('returns choose instead of defaulting one of several projects without active', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-panel-state-'))
    const other = await mkdtemp(join(tmpdir(), 'novel-panel-b-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '甲书')
      await init(engine, other, '乙书')
      await engine.forgetProject({ root })
      await engine.forgetProject({ root: other })
      await engine.registerProject({ root })
      await engine.registerProject({ root: other })
      const bundle = await engine.panelBundle()
      expect(bundle.selection).toEqual({ root: null, source: 'none' })
      expect(bundle.summary).toBeUndefined()
      expect(bundle.projects).toHaveLength(2)
      expect(bundle.empty).toBeUndefined()
    } finally {
      await cleanup()
      await rm(other, { recursive: true, force: true })
    }
  })

  it('rejects an unregistered query root and reports a registered missing root without falling back', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-panel-state-'))
    const other = await mkdtemp(join(tmpdir(), 'novel-panel-b-'))
    const outside = join(other, 'outside')
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '甲书')
      await init(engine, other, '乙书')
      const rejected = await engine.panelBundle({ root: outside })
      expect(rejected.missing?.reason).toBe('not_registered')
      expect(rejected.selection.root).toBe(outside)
      expect(rejected.summary).toBeUndefined()
      expect(rejected.projects).toHaveLength(2)
      expect(rejected.missing?.hint).toContain('/novel scan --register')

      await rm(other, { recursive: true, force: true })
      const missing = await engine.panelBundle({ root: other })
      expect(missing.missing?.reason).toBe('missing')
      expect(missing.missing?.code).toBe('ENGINE_PROJECT_MISSING')
      expect(missing.missing?.hint).toContain('恢复目录')
      expect(missing.summary).toBeUndefined()
      expect(missing.projects.some((project) => project.root === root)).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('keeps the selector when the project disappears between inspection and load', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-panel-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '竞态面板书')
      const snapshot = vi.spyOn(
        engine as unknown as { panelSnapshot: (...args: never[]) => Promise<unknown> },
        'panelSnapshot',
      )
      snapshot.mockRejectedValueOnce(
        new EngineFaultError(ERROR_CODES.PROJECT_MISSING, 'project vanished', 'restore it'),
      )
      const bundle = await engine.panelBundle({ root })
      expect(bundle.missing).toMatchObject({
        root,
        code: 'ENGINE_PROJECT_MISSING',
        reason: 'missing',
      })
      expect(bundle.projects.some((project) => project.root === root)).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('keeps a damaged project loadable and never writes panel selection into bindings', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-panel-state-'))
    const other = await mkdtemp(join(tmpdir(), 'novel-panel-b-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '甲书')
      await init(engine, other, '乙书')
      await engine.withCaller({ sessionId: 'session-a' }, () => engine.getStatus({ root }))
      const bindings = new SessionBindings(new FsStore(stateDir))
      const before = (await bindings.get('session-a'))?.root
      const ready = await engine.panelBundle({ root: other })
      expect(ready.summary?.root).toBe(other)
      expect((await bindings.get('session-a'))?.root).toBe(before)
      expect((await engine.listProjects()).active).toBeNull()

      await rm(join(other, 'novel.yaml'))
      const damaged = await engine.panelBundle({ root: other })
      expect(damaged.missing).toBeUndefined()
      expect(damaged.projects.find((project) => project.root === other)?.state).toBe('damaged')
      expect(damaged.summary).toBeDefined()
    } finally {
      await cleanup()
      await rm(other, { recursive: true, force: true })
    }
  })

  it('labels an unreadable project definition instead of saying it is missing', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-panel-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '不可读的书')
      await rm(join(root, 'novel.yaml'))
      await mkdir(join(root, 'novel.yaml'))
      const bundle = await engine.panelBundle({ root })
      expect(bundle.projects.find((project) => project.root === root)?.state).toBe('unreadable')
      expect(bundle.missing).toMatchObject({
        root,
        code: 'ENGINE_PROJECT_MISSING',
        reason: 'unreadable',
      })
    } finally {
      await cleanup()
    }
  })

  it('does not bind or register a project when a caller reads the panel', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-panel-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '面板只读书')
      const bindings = new SessionBindings(new FsStore(stateDir))
      const bundle = await engine.withCaller({ sessionId: 'panel-reader' }, () =>
        engine.panelBundle({ root }),
      )
      expect(bundle.summary?.root).toBe(root)
      expect(await bindings.get('panel-reader')).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it('accepts a configured query root that is currently missing', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-panel-state-'))
    const missingConfig = join(await mkdtemp(join(tmpdir(), 'novel-panel-config-')), 'absent')
    const fresh = await harness({ stateDir, projectRoot: missingConfig })
    try {
      const bundle = await fresh.engine.panelBundle({ root: missingConfig })
      expect(bundle.selection).toEqual({ root: missingConfig, source: 'query' })
      expect(bundle.projects.some((project) => project.root === missingConfig)).toBe(true)
      expect(bundle.missing?.root).toBe(missingConfig)
      expect(bundle.missing?.reason).toBe('missing')
    } finally {
      await fresh.cleanup()
    }
  })

  it('parses ?root= in the remote handler and serves v4', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-panel-state-'))
    const other = await mkdtemp(join(tmpdir(), 'novel-panel-b-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '甲书')
      await init(engine, other, '乙书')
      const res = response()
      await panelHandler(engine, () => undefined)(
        { method: 'GET', url: `/api/novel-write-engine/panel?root=${encodeURIComponent(other)}` },
        res,
      )
      expect(res.record.statusCode).toBe(200)
      const body = JSON.parse(res.record.body) as {
        schemaVersion: number
        selection: { root: string; source: string }
        summary: { root: string }
      }
      expect(body.schemaVersion).toBe(4)
      expect(body.selection).toEqual({ root: other, source: 'query' })
      expect(body.summary.root).toBe(other)
    } finally {
      await cleanup()
      await rm(other, { recursive: true, force: true })
    }
  })
})
