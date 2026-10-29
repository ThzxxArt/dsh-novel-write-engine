import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { EngineService } from '../src/engine/service.js'
import { inspectProject } from '../src/engine/project-selection.js'
import { FsStore } from '../src/store/fs.js'
import { FileLock } from '../src/store/lock.js'
import { SessionBindings } from '../src/store/bindings.js'
import { loadRulepack } from '../src/rulepack.js'
import { FIXED_NOW, TEST_CONFIG, harness, readProjectFile } from './helpers.js'

const init = async (engine: EngineService, root: string, title: string): Promise<void> => {
  await engine.initProject({ title, genre: '都市现代', platform: 'fanqie', root })
}

const status = async (engine: EngineService, root?: string, caller?: { sessionId: string; cwd?: string }) =>
  caller === undefined
    ? engine.getStatus(root === undefined ? {} : { root })
    : engine.withCaller(caller, () => engine.getStatus(root === undefined ? {} : { root }))

describe('session-level project selection', () => {
  it('keeps A and B isolated and persists both across an engine restart', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const other = await mkdtemp(join(tmpdir(), 'novel-selection-b-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, 'A 书')
      await init(engine, other, 'B 书')
      await status(engine, root, { sessionId: 'session-a' })
      await status(engine, other, { sessionId: 'session-b' })
      const [a, b] = await Promise.all([
        status(engine, undefined, { sessionId: 'session-a' }),
        status(engine, undefined, { sessionId: 'session-b' }),
      ])
      expect(a.data.project.title).toBe('A 书')
      expect(b.data.project.title).toBe('B 书')
      expect(a.data.selection?.source).toBe('session')
      expect(b.data.selection?.source).toBe('session')

      const reopened = new EngineService(
        { ...TEST_CONFIG, projectRoot: root, stateDir },
        () => loadRulepack(),
        { now: FIXED_NOW },
      )
      try {
        const again = await status(reopened, undefined, { sessionId: 'session-b' })
        expect(again.data.project.title).toBe('B 书')
      } finally {
        reopened.dispose()
      }
    } finally {
      await cleanup()
      await rm(other, { recursive: true, force: true })
    }
  })

  it('serializes concurrent bindings from two engine instances without losing a row', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const other = await mkdtemp(join(tmpdir(), 'novel-selection-b-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    const second = new EngineService({ ...TEST_CONFIG, projectRoot: root, stateDir }, () => loadRulepack(), {
      now: FIXED_NOW,
    })
    try {
      await init(engine, root, 'A 书')
      await init(engine, other, 'B 书')
      await Promise.all([
        status(engine, root, { sessionId: 'session-a' }),
        status(second, other, { sessionId: 'session-b' }),
      ])
      const bindings = new SessionBindings(new FsStore(stateDir))
      const rows = await bindings.list()
      expect(rows.map((row) => row.session_id).sort()).toEqual(['session-a', 'session-b'])
      expect(rows.find((row) => row.session_id === 'session-a')?.root).toBe(root)
      expect(rows.find((row) => row.session_id === 'session-b')?.root).toBe(other)
    } finally {
      second.dispose()
      await cleanup()
      await rm(other, { recursive: true, force: true })
    }
  })

  it('requires a cwd for use . and rejects a non-project path without rebinding', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '路径之书')
      await expect(
        engine.withCaller({ sessionId: 'session-a' }, () => engine.useProject({ target: '.' })),
      ).rejects.toMatchObject({ code: 'ENGINE_CONFIG_INVALID' })
      await expect(
        engine.withCaller({ sessionId: 'session-a' }, () =>
          engine.useProject({ target: join(root, 'novel.yaml') }),
        ),
      ).rejects.toMatchObject({ code: 'ENGINE_PROJECT_NOT_FOUND' })
      const current = await engine.withCaller({ sessionId: 'session-a' }, () => engine.currentProject())
      expect(current.bound).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('does not let a failed explicit root replace the existing binding', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const other = await mkdtemp(join(tmpdir(), 'novel-selection-b-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, 'A 书')
      await init(engine, other, 'B 书')
      await status(engine, other, { sessionId: 'session-a' })
      await expect(status(engine, join(other, 'typo'), { sessionId: 'session-a' })).rejects.toMatchObject({
        code: 'ENGINE_PROJECT_NOT_FOUND',
      })
      const after = await status(engine, undefined, { sessionId: 'session-a' })
      expect(after.data.project.title).toBe('B 书')
    } finally {
      await cleanup()
      await rm(other, { recursive: true, force: true })
    }
  })

  it('marks missing registry candidates in an ambiguity error', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const other = await mkdtemp(join(tmpdir(), 'novel-selection-b-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, 'A 书')
      await init(engine, other, 'B 书')
      await rm(other, { recursive: true, force: true })
      const error = await status(engine, undefined, { sessionId: 'fresh' }).catch(
        (failure: unknown) => failure,
      )
      expect(error).toMatchObject({ code: 'ENGINE_PROJECT_AMBIGUOUS' })
      expect((error as { message: string }).message).toContain(other)
      expect((error as { message: string }).message).toContain('[missing]')
    } finally {
      await cleanup()
    }
  })

  it('refreshes the session binding title after an explicit project amendment', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '旧标题')
      await status(engine, root, { sessionId: 'session-a' })
      await engine.withCaller({ sessionId: 'session-a' }, () =>
        engine.amend({
          path: 'novel.yaml',
          content: { title: '新标题' },
          reason: '重命名项目',
          root,
        }),
      )
      const current = await engine.withCaller({ sessionId: 'session-a' }, () => engine.currentProject())
      expect(current.selection?.title).toBe('新标题')
      const listed = await engine.listProjects()
      expect(listed.projects.find((row) => row.root === root)?.title).toBe('新标题')
      const panel = await engine.panelBundle()
      expect(panel.projects.find((row) => row.root === root)?.title).toBe('新标题')
      expect(panel.summary?.title).toBe('新标题')
    } finally {
      await cleanup()
    }
  })

  it('reports ambiguity instead of active when an Agent session has no binding or workspace', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const other = await mkdtemp(join(tmpdir(), 'novel-selection-b-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, 'A 书')
      await init(engine, other, 'B 书')
      await engine.setActiveProject({ root })
      await expect(status(engine, undefined, { sessionId: 'fresh' })).rejects.toMatchObject({
        code: 'ENGINE_PROJECT_AMBIGUOUS',
      })
      const noAgent = await status(engine)
      expect(noAgent.data.project.title).toBe('A 书')
    } finally {
      await cleanup()
      await rm(other, { recursive: true, force: true })
    }
  })

  it('reports ambiguity without a caller when config is absent and no active is set', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const other = await mkdtemp(join(tmpdir(), 'novel-selection-b-'))
    const missingConfig = join(await mkdtemp(join(tmpdir(), 'novel-selection-config-')), 'absent')
    const { root, engine, cleanup } = await harness({ stateDir, projectRoot: missingConfig })
    try {
      await init(engine, root, 'A 书')
      await init(engine, other, 'B 书')
      await expect(engine.getStatus({})).rejects.toMatchObject({
        code: 'ENGINE_PROJECT_AMBIGUOUS',
      })
    } finally {
      await cleanup()
      await rm(other, { recursive: true, force: true })
    }
  })

  it('uses a unique workspace project but reports many candidates as ambiguous', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-workspace-'))
    const a = join(workspace, 'a')
    const b = join(workspace, 'b')
    const { engine, cleanup } = await harness({ stateDir })
    try {
      await mkdir(a, { recursive: true })
      await mkdir(b, { recursive: true })
      await init(engine, a, '工作区 A')
      await init(engine, b, '工作区 B')
      await expect(
        status(engine, undefined, { sessionId: 'workspace', cwd: workspace }),
      ).rejects.toMatchObject({ code: 'ENGINE_PROJECT_AMBIGUOUS' })
      const direct = await status(engine, undefined, { sessionId: 'direct', cwd: b })
      expect(direct.data.project.title).toBe('工作区 B')
      expect(direct.data.selection?.source).toBe('workspace')
      // Workspace discovery is not a persistent binding: a later cwd-free call
      // with several registered projects is ambiguous again.
      await expect(status(engine, undefined, { sessionId: 'direct' })).rejects.toMatchObject({
        code: 'ENGINE_PROJECT_AMBIGUOUS',
      })
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('fails closed when a bound directory disappears, and suggests a moved project without switching', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const moved = await mkdtemp(join(tmpdir(), 'novel-selection-moved-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '会移动的书')
      await status(engine, root, { sessionId: 'session-a' })
      await rename(root, join(moved, 'book'))
      const movedRoot = join(moved, 'book')
      await engine.registerProject({ root: movedRoot })
      const missing = await status(engine, undefined, { sessionId: 'session-a' }).catch(
        (error: unknown) => error,
      )
      expect(missing).toMatchObject({ code: 'ENGINE_PROJECT_MISSING' })
      expect((missing as { hint?: string }).hint).toContain(movedRoot)
      const list = await engine.listProjects()
      expect(list.projects.some((entry) => entry.root === root)).toBe(true)
      expect(list.projects.some((entry) => entry.root === movedRoot)).toBe(true)
    } finally {
      await cleanup()
      await rm(moved, { recursive: true, force: true })
    }
  })

  it('registers the current session project when root is omitted', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '会话登记')
      await status(engine, root, { sessionId: 'session-a' })
      const registered = await engine.withCaller({ sessionId: 'session-a' }, () => engine.registerProject())
      expect(registered.projects.some((row) => row.root === root)).toBe(true)
      expect(registered.replaced).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('reports replaced on explicit registration while leaving session bindings alone', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '旧书')
      await engine.setActiveProject({ root })
      await status(engine, root, { sessionId: 'session-a' })
      await rm(root, { recursive: true, force: true })
      const replacement = new EngineService(
        { ...TEST_CONFIG, projectRoot: root, stateDir },
        () => loadRulepack(),
        { now: () => new Date('2026-10-29T10:00:00.000Z') },
      )
      try {
        await init(replacement, root, '新书')
      } finally {
        replacement.dispose()
      }
      const registered = await engine.registerProject({ root })
      expect(registered.replaced).toBe(true)
      expect(registered.projects.find((row) => row.root === root)?.title).toBe('新书')
      expect(registered.active).toBe(root)
      const current = await engine.withCaller({ sessionId: 'session-a' }, () => engine.currentProject())
      expect(current.selection?.title).toBe('旧书')
    } finally {
      await cleanup()
    }
  })

  it('does not poison a binding with a damaged placeholder and repairs without mismatch', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '修复绑定书')
      await status(engine, root, { sessionId: 'session-a' })
      const bindings = new SessionBindings(new FsStore(stateDir))
      const before = await bindings.get('session-a')
      expect(before?.project_created_at).toBeTruthy()
      const project = parseYaml((await readProjectFile(root, 'novel.yaml'))!) as Record<string, unknown>

      await rm(join(root, 'novel.yaml'))
      const damaged = await status(engine, root, { sessionId: 'session-a' })
      expect(damaged.data.project.title).toBe('（项目文件不可读）')
      expect((await bindings.get('session-a'))?.project_created_at).toBe(before?.project_created_at)
      await expect(engine.registerProject({ root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })

      await engine.amend({
        path: 'novel.yaml',
        content: project,
        reason: '恢复项目定义',
        root,
      })
      const repaired = await status(engine, undefined, { sessionId: 'session-a' })
      expect(repaired.data.project.title).toBe('修复绑定书')
      expect(repaired.data.selection?.source).toBe('session')
    } finally {
      await cleanup()
    }
  })

  it('treats a symlinked project root as a project for status, use and binding reuse', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-selection-link-'))
    const { engine, cleanup } = await harness({ stateDir })
    const real = join(workspace, 'real')
    const link = join(workspace, 'link')
    try {
      await mkdir(real, { recursive: true })
      await init(engine, real, '链接书')
      await symlink(real, link, 'dir')
      expect(await inspectProject(link)).toMatchObject({ state: 'ok', title: '链接书' })

      await status(engine, link, { sessionId: 'session-a' })
      const reused = await status(engine, undefined, { sessionId: 'session-a' })
      expect(reused.data.project.root).toBe(link)
      expect(reused.data.project.title).toBe('链接书')

      const used = await engine.withCaller({ sessionId: 'session-b' }, () =>
        engine.useProject({ target: link }),
      )
      expect(used.selection.root).toBe(link)
      expect((await engine.listProjects()).projects.some((row) => row.root === link)).toBe(true)
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('makes the same binding usable again when the directory returns', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const parked = await mkdtemp(join(tmpdir(), 'novel-selection-parked-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '会恢复的书')
      await status(engine, root, { sessionId: 'session-a' })
      await rename(root, join(parked, 'book'))
      await expect(status(engine, undefined, { sessionId: 'session-a' })).rejects.toMatchObject({
        code: 'ENGINE_PROJECT_MISSING',
      })
      await rename(join(parked, 'book'), root)
      const recovered = await status(engine, undefined, { sessionId: 'session-a' })
      expect(recovered.data.project.title).toBe('会恢复的书')
      expect(recovered.data.selection?.source).toBe('session')
      expect((await engine.listProjects()).projects.some((row) => row.root === root)).toBe(true)
    } finally {
      await cleanup()
      await rm(parked, { recursive: true, force: true })
    }
  })

  it('loads a damaged project and allows novel_amend to repair its definition', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '待修复的书')
      const project = parseYaml((await readProjectFile(root, 'novel.yaml'))!) as Record<string, unknown>
      await rm(join(root, 'novel.yaml'))
      const damaged = await status(engine, root, { sessionId: 'session-a' })
      expect(damaged.data.project.title).toBe('（项目文件不可读）')
      expect(damaged.data.state_errors).toContainEqual(
        expect.objectContaining({ code: 'PROJECT_UNREADABLE' }),
      )
      await engine.amend({
        path: 'novel.yaml',
        content: project,
        reason: '恢复项目定义',
        root,
      })
      const repaired = await status(engine, root, { sessionId: 'session-a' })
      expect(repaired.data.project.title).toBe('待修复的书')
    } finally {
      await cleanup()
    }
  })

  it('refuses a session-bound repair when a damaged replacement cannot prove identity', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '原来的书')
      await status(engine, root, { sessionId: 'session-a' })
      await rm(root, { recursive: true, force: true })
      const replacement = new EngineService(
        { ...TEST_CONFIG, projectRoot: root, stateDir },
        () => loadRulepack(),
        { now: () => new Date('2026-10-30T10:00:00.000Z') },
      )
      try {
        await init(replacement, root, '替换的书')
      } finally {
        replacement.dispose()
      }
      await rm(join(root, 'novel.yaml'))
      const damagedRead = await status(engine, undefined, { sessionId: 'session-a' })
      expect(damagedRead.data.project.title).toBe('（项目文件不可读）')
      await expect(
        engine.withCaller({ sessionId: 'session-a' }, () =>
          engine.amend({
            path: 'novel.yaml',
            content: { schema_version: 1, title: '不应写入' },
            reason: '损坏替换书',
          }),
        ),
      ).rejects.toMatchObject({ code: 'ENGINE_PROJECT_IDENTITY_MISMATCH' })
      expect(await readProjectFile(root, 'novel.yaml')).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('fails a write closed when the project directory is removed and never recreates it', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '消失的书')
      await rm(root, { recursive: true, force: true })
      await expect(
        engine.amend({
          path: 'novel.yaml',
          content: { schema_version: 1 },
          reason: 'write after delete',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_PROJECT_NOT_FOUND' })
      await expect(status(engine, root, { sessionId: 'session-a' })).rejects.toBeDefined()
      await expect(import('node:fs/promises').then(({ stat }) => stat(root))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await cleanup()
    }
  })

  it('refuses a replaced project at the bound path and keeps the old binding', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '原来的书')
      await status(engine, root, { sessionId: 'session-a' })
      await rm(root, { recursive: true, force: true })
      const replacement = new EngineService(
        { ...TEST_CONFIG, projectRoot: root, stateDir },
        () => loadRulepack(),
        { now: () => new Date('2026-10-27T10:00:00.000Z') },
      )
      try {
        await init(replacement, root, '替换的书')
      } finally {
        replacement.dispose()
      }
      await engine.withCaller({ sessionId: 'session-b' }, () => engine.getStatus({ root }))
      const replaced = await status(engine, undefined, { sessionId: 'session-a' }).catch(
        (error: unknown) => error,
      )
      expect(replaced).toMatchObject({ code: 'ENGINE_PROJECT_IDENTITY_MISMATCH' })
      expect((replaced as { hint?: string }).hint).toContain('/novel use')
    } finally {
      await cleanup()
    }
  })

  it('does not take the metadata write lock for an unchanged explicit read', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '锁外读取')
      await status(engine, root, { sessionId: 'session-a' })
      const lock = new FileLock(join(stateDir, '.metadata.lock'))
      await lock.acquire()
      try {
        const again = await status(engine, root, { sessionId: 'session-a' })
        expect(again.data.project.title).toBe('锁外读取')
      } finally {
        await lock.release()
      }
    } finally {
      await cleanup()
    }
  })

  it('keeps explicit-root reads available when binding metadata is corrupt', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '只读不受元数据影响')
      await status(engine, root, { sessionId: 'session-a' })
      await writeFile(join(stateDir, 'session-bindings.yaml'), 'bindings: [\n')
      const read = await status(engine, root, { sessionId: 'session-a' })
      expect(read.data.project.title).toBe('只读不受元数据影响')
      expect(read.data.selection?.source).toBe('explicit')
      // Resolution without an explicit root still fails closed.
      await expect(status(engine, undefined, { sessionId: 'session-a' })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
    } finally {
      await cleanup()
    }
  })

  it('resolves a relative explicit root against the session cwd', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-selection-workspace-'))
    const book = join(workspace, 'book')
    const { engine, cleanup } = await harness({ stateDir })
    try {
      await mkdir(book, { recursive: true })
      await init(engine, book, '相对路径之书')
      const selected = await engine.withCaller({ sessionId: 'session-a', cwd: workspace }, () =>
        engine.getStatus({ root: 'book' }),
      )
      expect(selected.data.project.title).toBe('相对路径之书')
      const current = await engine.withCaller({ sessionId: 'session-a' }, () => engine.currentProject())
      expect(current.selection?.root).toBe(book)
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('reports MISSING from doctor and guide for a deleted bound project', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '体检缺失书')
      await status(engine, root, { sessionId: 'session-a' })
      await rm(root, { recursive: true, force: true })
      await expect(
        engine.withCaller({ sessionId: 'session-a' }, () => engine.doctor({})),
      ).rejects.toMatchObject({ code: 'ENGINE_PROJECT_MISSING' })
      await expect(
        engine.withCaller({ sessionId: 'session-a' }, () => engine.guide({})),
      ).rejects.toMatchObject({ code: 'ENGINE_PROJECT_MISSING' })
    } finally {
      await cleanup()
    }
  })

  it('reports MISSING from a write when the bound directory is gone', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '会消失的写书')
      await status(engine, root, { sessionId: 'session-a' })
      await rm(root, { recursive: true, force: true })
      await expect(
        engine.withCaller({ sessionId: 'session-a' }, () =>
          engine.amend({
            path: 'state/world.yaml',
            content: {
              schema_version: 1,
              locations: [],
              abilities: [],
              artifacts: [],
              factions: [],
              rules: [],
            },
            reason: '缺失项目写入',
          }),
        ),
      ).rejects.toMatchObject({ code: 'ENGINE_PROJECT_MISSING' })
      await expect(import('node:fs/promises').then(({ stat }) => stat(root))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await cleanup()
    }
  })

  it('refuses an amend through a binding whose path was replaced', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '原来的书')
      await status(engine, root, { sessionId: 'session-a' })
      await rm(root, { recursive: true, force: true })
      const replacement = new EngineService(
        { ...TEST_CONFIG, projectRoot: root, stateDir },
        () => loadRulepack(),
        { now: () => new Date('2026-10-30T10:00:00.000Z') },
      )
      try {
        await replacement.initProject({ title: '替换的书', genre: '都市现代', platform: 'fanqie', root })
      } finally {
        replacement.dispose()
      }
      await expect(
        engine.withCaller({ sessionId: 'session-a' }, () =>
          engine.amend({
            path: 'novel.yaml',
            content: { title: '不应写入' },
            reason: '绑定校验',
          }),
        ),
      ).rejects.toMatchObject({ code: 'ENGINE_PROJECT_IDENTITY_MISMATCH' })
      const statusAfter = await engine.getStatus({ root })
      expect(statusAfter.data.project.title).toBe('替换的书')
    } finally {
      await cleanup()
    }
  })

  it('does not turn a workspace amend into a persistent session binding', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '工作区修复')
      await engine.withCaller({ sessionId: 'session-a', cwd: root }, () =>
        engine.amend({
          path: 'state/world.yaml',
          content: {
            schema_version: 1,
            locations: [],
            abilities: [],
            artifacts: [],
            factions: [],
            rules: [],
          },
          reason: '工作区修复',
        }),
      )
      const bindings = new SessionBindings(new FsStore(stateDir))
      expect(await bindings.get('session-a')).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it('fails closed when a bound project loses its created_at identity', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '有身份的书')
      await status(engine, root, { sessionId: 'session-a' })
      const project = parseYaml((await readProjectFile(root, 'novel.yaml'))!) as Record<string, unknown>
      await rm(join(root, 'novel.yaml'))
      await engine.amend({
        path: 'novel.yaml',
        content: { ...project, title: '无身份的书', created_at: '' },
        reason: '模拟修复后身份丢失',
        root,
      })
      await expect(status(engine, undefined, { sessionId: 'session-a' })).rejects.toMatchObject({
        code: 'ENGINE_PROJECT_IDENTITY_MISMATCH',
      })
    } finally {
      await cleanup()
    }
  })

  it('binds a newly initialized project to the initiating session, not to the previous book', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const other = await mkdtemp(join(tmpdir(), 'novel-selection-b-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '甲')
      await status(engine, root, { sessionId: 'session-a' })
      await engine.withCaller({ sessionId: 'session-b' }, () =>
        engine.initProject({ title: '乙', genre: '都市现代', platform: 'fanqie', root: other }),
      )
      const a = await status(engine, undefined, { sessionId: 'session-a' })
      const b = await status(engine, undefined, { sessionId: 'session-b' })
      expect(a.data.project.title).toBe('甲')
      expect(b.data.project.title).toBe('乙')
    } finally {
      await cleanup()
      await rm(other, { recursive: true, force: true })
    }
  })

  it('uses the single registered project only as a fallback and reports its source', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-selection-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '唯一之书')
      const result = await status(engine, undefined, { sessionId: 'session-a' })
      expect(result.data.project.title).toBe('唯一之书')
      expect(result.data.selection?.source).toBe('single')
    } finally {
      await cleanup()
    }
  })
})
