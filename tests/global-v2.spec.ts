import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GlobalRegistry, openGlobalRegistry } from '../src/storage/global.js'
import { StudioRuntime } from '../src/studio/runtime.js'
import { writeFileSync } from 'node:fs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('global registry', () => {
  it('registers projects and session bindings', () => {
    const root = mkdtempSync(join(tmpdir(), 'global-reg-'))
    roots.push(root)
    const registry = new GlobalRegistry(join(root, 'studio.db'))
    try {
      registry.register({ root: join(root, 'a'), projectId: 'p1', title: 'A' })
      registry.register({ root: join(root, 'b'), projectId: 'p2', title: 'B' })
      expect(registry.list()).toHaveLength(2)
      expect(registry.recent()?.projectId).toBe('p2')
      registry.bind('session-1', join(root, 'a'))
      expect(registry.binding('session-1')).toBe(join(root, 'a'))
      registry.unbind('session-1')
      expect(registry.binding('session-1')).toBeUndefined()
    } finally {
      registry.close()
    }
  })

  it('lets a runtime discover the most recent project without a root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'global-runtime-'))
    roots.push(root)
    const registry = new GlobalRegistry(join(root, 'global.db'))
    const runtime = new StudioRuntime({
      projectRoot: join(root, 'default'),
      stateDir: root,
      globalRegistry: registry,
    })
    try {
      const handle = await runtime.init({
        title: '全局项目',
        genre: {
          major: 'fantasy',
          sub: 'fantasy.xianxia',
          tags: ['world.eastern_cultivation', 'plot.progression', 'tone.hot_blooded'],
        },
        audience: 'male',
        platform: 'qidian',
      })
      expect(runtime.projects().some((project) => project.title === '全局项目')).toBe(true)
      const reopened = await runtime.open()
      expect(reopened.project.config.title).toBe('全局项目')
      runtime.bind('session-2', handle.project.root)
      expect(runtime.binding('session-2')).toBe(handle.project.root)
      expect(runtime.directorAgent()).toBeUndefined()
      await expect(runtime.openForAgent('missing-agent')).resolves.toBeUndefined()
      await expect(runtime.restoreBackup(handle.project.root, '../escape.db')).rejects.toThrow(
        /invalid backup/u,
      )
      const runId = handle.director.createChapterRun({ chapter: 1 })
      await handle.scheduler.run(runId, {} as never, new AbortController().signal)
      expect(handle.director.board().runs.find((run) => run.id === runId)?.status).toBe('awaiting_human')
    } finally {
      runtime.close()
    }
  })

  it('fails loudly when the state directory cannot become a database', () => {
    const root = mkdtempSync(join(tmpdir(), 'global-bad-'))
    roots.push(root)
    const stateDir = join(root, 'not-a-dir')
    writeFileSync(stateDir, 'file')
    expect(() => openGlobalRegistry(stateDir)).toThrow(/cannot open global registry/u)
  })

  it('adopts the first host session as the workbench director agent', () => {
    const runtime = new StudioRuntime({
      projectRoot: '/tmp/adopt',
      agents: { get: (id) => (id === 'session-main' ? ({ id: 'session-main' } as never) : undefined) },
    })
    runtime.adoptDirectorSession('session-main')
    expect(runtime.directorAgent()?.id).toBe('session-main')
    runtime.adoptDirectorSession('session-role')
    expect(runtime.directorAgent()?.id).toBe('session-main')
  })

  it('refuses to restore a backup while a writer run is active', async () => {
    const { runtime } = await (async () => {
      const root = mkdtempSync(join(tmpdir(), 'global-restore-'))
      roots.push(root)
      return { root, runtime: new StudioRuntime({ projectRoot: join(root, 'default'), stateDir: root }) }
    })()
    try {
      const handle = await runtime.init({
        title: '恢复守卫',
        genre: {
          major: 'urban',
          sub: 'urban.daily',
          tags: ['world.modern_city', 'plot.farming', 'tone.light'],
        },
        audience: 'general',
        platform: 'fanqie',
      })
      await handle.project.store.ensureDir('.studio/backups')
      handle.db.backupTo(handle.project.store.path('.studio/backups/safety.db'))
      handle.director.createChapterRun({ chapter: 1 })
      await expect(runtime.restoreBackup(handle.project.root, 'safety.db')).rejects.toThrow(
        /cannot restore a backup while run/u,
      )
      const runId = handle.director.board().runs[0]!.id
      handle.director.cancel(runId)
      const restored = await runtime.restoreBackup(handle.project.root, 'safety.db')
      expect(restored.safetyBackup.endsWith('.db')).toBe(true)
    } finally {
      runtime.close()
    }
  })
})
