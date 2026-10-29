import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { describe, expect, it, vi } from 'vitest'
import { EngineService } from '../src/engine/service.js'
import { FsStore } from '../src/store/fs.js'
import { ProjectRegistry } from '../src/store/registry.js'
import {
  ambiguousError,
  describeCandidates,
  discoverWorkspace,
  identityMismatchError,
  inspectProject,
  missingProjectError,
  scanWorkspace,
} from '../src/engine/project-selection.js'
import { loadRulepack } from '../src/rulepack.js'
import { TEST_CONFIG, harness } from './helpers.js'

const init = async (engine: EngineService, root: string, title: string): Promise<void> => {
  await engine.initProject({ title, genre: '都市现代', platform: 'fanqie', root })
}

describe('project inspection and bounded workspace scan', () => {
  it('classifies missing, not-project, damaged and healthy projects without a full load', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-scan-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-scan-workspace-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '健康书')
      expect(await inspectProject(root)).toMatchObject({ state: 'ok', title: '健康书' })
      expect(await inspectProject(join(workspace, 'missing'))).toMatchObject({ state: 'missing' })
      expect(await inspectProject(workspace)).toMatchObject({ state: 'not-project' })

      const damaged = join(workspace, 'damaged')
      await mkdir(damaged, { recursive: true })
      await init(engine, damaged, '受损书')
      await rm(join(damaged, 'novel.yaml'))
      expect(await inspectProject(damaged)).toMatchObject({ state: 'damaged' })

      const corrupt = join(workspace, 'corrupt')
      await mkdir(corrupt, { recursive: true })
      await writeFile(join(corrupt, 'novel.yaml'), 'not: [valid')
      expect(await inspectProject(corrupt)).toMatchObject({ state: 'damaged' })
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('reports unreadable probes and a disappearing project file without throwing', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-scan-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-scan-workspace-'))
    const { engine, cleanup } = await harness({ stateDir })
    const book = join(workspace, 'book')
    const empty = join(workspace, 'empty')
    try {
      await mkdir(book, { recursive: true })
      await mkdir(empty, { recursive: true })
      await init(engine, book, '探针之书')

      const statRoot = vi.spyOn(FsStore.prototype, 'statRoot').mockRejectedValueOnce(new Error('EACCES'))
      try {
        expect(await inspectProject(book)).toMatchObject({ state: 'unreadable' })
      } finally {
        statRoot.mockRestore()
      }

      const exists = vi.spyOn(FsStore.prototype, 'exists').mockRejectedValueOnce(new Error('EACCES'))
      try {
        expect(await inspectProject(book)).toMatchObject({ state: 'unreadable' })
      } finally {
        exists.mockRestore()
      }

      const readDoc = vi.spyOn(FsStore.prototype, 'readDoc').mockResolvedValueOnce(null)
      try {
        expect(await inspectProject(book)).toMatchObject({ state: 'damaged' })
      } finally {
        readDoc.mockRestore()
      }

      const readText = vi
        .spyOn(FsStore.prototype, 'readText')
        .mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
      try {
        expect(await inspectProject(book)).toMatchObject({ state: 'unreadable' })
      } finally {
        readText.mockRestore()
      }

      const list = vi.spyOn(FsStore.prototype, 'list').mockRejectedValueOnce(new Error('EACCES'))
      try {
        expect(await inspectProject(empty)).toMatchObject({ state: 'unreadable' })
      } finally {
        list.mockRestore()
      }

      const scanProbe = vi.spyOn(FsStore.prototype, 'lstat').mockRejectedValueOnce(new Error('EACCES'))
      try {
        expect(await scanWorkspace(workspace)).toEqual({ candidates: [], truncated: false })
      } finally {
        scanProbe.mockRestore()
      }
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('surfaces a scan inspection failure and treats discovery probe failures as none', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'novel-scan-workspace-'))
    try {
      const book = join(workspace, 'book')
      await mkdir(book, { recursive: true })
      const statRoot = vi.spyOn(FsStore.prototype, 'statRoot').mockRejectedValueOnce(new Error('EACCES'))
      try {
        const scan = await scanWorkspace(workspace)
        expect(scan.candidates.some((candidate) => candidate.state === 'unreadable')).toBe(true)
      } finally {
        statRoot.mockRestore()
      }

      const lstat = vi.spyOn(FsStore.prototype, 'lstat').mockRejectedValueOnce(new Error('EACCES'))
      try {
        expect(await discoverWorkspace(workspace)).toEqual({ kind: 'none' })
      } finally {
        lstat.mockRestore()
      }

      const entries = vi.spyOn(FsStore.prototype, 'entries').mockRejectedValueOnce(new Error('EACCES'))
      try {
        expect(await discoverWorkspace(workspace)).toEqual({ kind: 'none' })
      } finally {
        entries.mockRestore()
      }
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('scans cwd, cwd/novel and direct child directories only', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'novel-scan-workspace-'))
    try {
      const a = join(workspace, 'a')
      const b = join(workspace, 'b')
      await mkdir(a, { recursive: true })
      await mkdir(b, { recursive: true })
      const make = async (root: string, title: string): Promise<void> => {
        await writeFile(
          join(root, 'novel.yaml'),
          stringifyYaml({
            schema_version: 1,
            title,
            genre: '都市现代',
            platform: 'fanqie',
            author: '',
            description: '',
            created_at: '2026-10-01T00:00:00.000Z',
            targets: { words_per_chapter: [80, 400], total_chapters: null, dialogue_ratio: [0.2, 0.5] },
          }),
        )
      }
      await make(a, 'A')
      await make(b, 'B')
      const nested = join(a, 'nested')
      await mkdir(nested, { recursive: true })
      await make(nested, 'NESTED')

      const result = await scanWorkspace(workspace)
      expect(result.candidates.map((candidate) => candidate.root).sort()).toEqual([a, b])
      expect((await discoverWorkspace(workspace)).kind).toBe('many')
      expect(await discoverWorkspace(join(workspace, 'single'))).toEqual({ kind: 'none' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('short-circuits cwd, cwd/novel and one readable child; damaged is not a candidate', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-scan-state-'))
    const rootWorkspace = await mkdtemp(join(tmpdir(), 'novel-scan-root-'))
    const nestedWorkspace = await mkdtemp(join(tmpdir(), 'novel-scan-nested-'))
    const mixedWorkspace = await mkdtemp(join(tmpdir(), 'novel-scan-mixed-'))
    const { engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, rootWorkspace, '根项目')
      await mkdir(join(rootWorkspace, 'child'), { recursive: true })
      await init(engine, join(rootWorkspace, 'child'), '子项目')
      expect(await discoverWorkspace(rootWorkspace)).toEqual({
        kind: 'one',
        root: rootWorkspace,
      })

      const nested = join(nestedWorkspace, 'novel')
      const other = join(nestedWorkspace, 'other')
      await mkdir(nested, { recursive: true })
      await mkdir(other, { recursive: true })
      await init(engine, nested, '嵌套项目')
      await init(engine, other, '其他项目')
      expect(await discoverWorkspace(nestedWorkspace)).toEqual({ kind: 'one', root: nested })

      const a = join(mixedWorkspace, 'a')
      const damaged = join(mixedWorkspace, 'damaged')
      await mkdir(a, { recursive: true })
      await mkdir(damaged, { recursive: true })
      await init(engine, a, '健康项目')
      await init(engine, damaged, '受损项目')
      await rm(join(damaged, 'novel.yaml'))
      expect(await discoverWorkspace(mixedWorkspace)).toEqual({ kind: 'one', root: a })
    } finally {
      await cleanup()
      for (const directory of [rootWorkspace, nestedWorkspace, mixedWorkspace]) {
        await rm(directory, { recursive: true, force: true })
      }
    }
  })

  it('handles missing cwd, a file path, and the cwd/novel shorthand', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-scan-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-scan-workspace-'))
    const nested = join(workspace, 'novel')
    const file = join(workspace, 'not-a-directory')
    const { engine, cleanup } = await harness({ stateDir })
    try {
      await mkdir(nested, { recursive: true })
      await init(engine, nested, '子项目')
      await writeFile(file, 'x')
      expect(await inspectProject(file)).toMatchObject({ state: 'not-project' })
      expect(await scanWorkspace(join(workspace, 'missing'))).toEqual({
        candidates: [],
        truncated: false,
      })
      const found = await scanWorkspace(workspace)
      expect(found.candidates.map((candidate) => candidate.root)).toContain(nested)
      expect(await discoverWorkspace(workspace)).toEqual({ kind: 'one', root: nested })
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('does not follow symlink directories and exposes an explicit truncation flag', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'novel-scan-workspace-'))
    const outside = await mkdtemp(join(tmpdir(), 'novel-scan-outside-'))
    try {
      for (const name of ['a', 'b', 'c']) {
        const root = join(workspace, name)
        await mkdir(root, { recursive: true })
        await writeFile(
          join(root, 'novel.yaml'),
          stringifyYaml({
            schema_version: 1,
            title: name,
            genre: '都市现代',
            platform: 'fanqie',
            author: '',
            description: '',
            created_at: '2026-10-01T00:00:00.000Z',
            targets: { words_per_chapter: [80, 400], total_chapters: null, dialogue_ratio: [0.2, 0.5] },
          }),
        )
      }
      await writeFile(
        join(outside, 'novel.yaml'),
        stringifyYaml({
          schema_version: 1,
          title: '外部',
          genre: '都市现代',
          platform: 'fanqie',
          author: '',
          description: '',
          created_at: '2026-10-01T00:00:00.000Z',
          targets: { words_per_chapter: [80, 400], total_chapters: null, dialogue_ratio: [0.2, 0.5] },
        }),
      )
      await symlink(outside, join(workspace, 'linked'), 'dir')
      const full = await scanWorkspace(workspace)
      expect(full.candidates.some((candidate) => candidate.root.includes('linked'))).toBe(false)
      const bounded = await scanWorkspace(workspace, 2)
      expect(bounded.candidates).toHaveLength(2)
      expect(bounded.truncated).toBe(true)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('selection error descriptions', () => {
  it('describes empty titles and missing states, and builds fail-closed errors', () => {
    const text = describeCandidates([{ root: '/a' }, { root: '/b', title: 'B', state: 'damaged' }])
    expect(text).toContain('（无标题）: /a')
    expect(text).toContain('[damaged]')
    expect(ambiguousError([{ root: '/a' }]).code).toBe('ENGINE_PROJECT_AMBIGUOUS')

    const missing = missingProjectError({
      selection: { root: '/gone', source: 'session' },
    })
    expect(missing.code).toBe('ENGINE_PROJECT_MISSING')
    expect(missing.message).toContain('/gone')
    const mismatch = identityMismatchError({
      selection: { root: '/gone', source: 'session' },
    })
    expect(mismatch.code).toBe('ENGINE_PROJECT_IDENTITY_MISMATCH')
    expect(mismatch.message).toContain('unknown')
  })
})

describe('scan --register semantics', () => {
  it('normal scan is read-only; --register only adds healthy rows and never changes active or bindings', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-scan-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-scan-workspace-'))
    const a = join(workspace, 'a')
    const b = join(workspace, 'b')
    const damaged = join(workspace, 'damaged')
    const { engine, cleanup } = await harness({ stateDir })
    try {
      await mkdir(a, { recursive: true })
      await mkdir(b, { recursive: true })
      await mkdir(damaged, { recursive: true })
      await init(engine, a, 'A 书')
      await init(engine, b, 'B 书')
      await init(engine, damaged, '坏书')
      await rm(join(damaged, 'novel.yaml'))
      await engine.setActiveProject({ root: a })
      await engine.withCaller({ sessionId: 'session-a' }, () => engine.getStatus({ root: b }))
      for (const root of [b, damaged]) await engine.forgetProject({ root })

      const beforeRegistry = await readFile(join(stateDir, 'projects.yaml'), 'utf8')
      const readonly = await engine.scanProjects({ cwd: workspace })
      expect(readonly.added).toEqual([])
      expect(readonly.already).toEqual([])
      expect(readonly.skipped).toEqual([])
      expect(await readFile(join(stateDir, 'projects.yaml'), 'utf8')).toBe(beforeRegistry)

      const registered = await engine.scanProjects({ cwd: workspace, register: true })
      expect(registered.added).toEqual([b])
      expect(registered.already).toContain(a)
      expect(registered.skipped.map((row) => row.root)).toContain(damaged)
      const after = await engine.listProjects()
      expect(after.active).toBe(a)
      expect(after.projects.filter((project) => project.root === damaged)).toHaveLength(0)
      const current = await engine.withCaller({ sessionId: 'session-a' }, () => engine.currentProject())
      expect(current.selection?.root).toBe(b)
      expect(current.bound).toBe(true)
      const bindings = await readFile(join(stateDir, 'session-bindings.yaml'), 'utf8')
      expect(bindings).toContain('session-a')
      expect(bindings).not.toContain(a)
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('does not register a new candidate whose snapshot reports damage', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-scan-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-scan-workspace-'))
    const damaged = join(workspace, 'damaged-after-scan')
    const { engine, cleanup } = await harness({ stateDir })
    try {
      await mkdir(damaged, { recursive: true })
      await init(engine, damaged, '扫描后损坏')
      await engine.forgetProject({ root: damaged })
      vi.spyOn(engine as unknown as { loadAt: () => Promise<unknown> }, 'loadAt').mockResolvedValueOnce({
        root: damaged,
        projectError: 'novel.yaml became unreadable',
        project: { title: '（项目文件不可读）', created_at: '' },
      })
      const result = await engine.scanProjects({ cwd: workspace, register: true })
      expect(result.skipped.map((row) => row.root)).toContain(damaged)
      expect(result.added).not.toContain(damaged)
      expect((await engine.listProjects()).projects.some((row) => row.root === damaged)).toBe(false)
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('does not build full snapshots for already-registered candidates', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-scan-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-scan-workspace-'))
    const registered = join(workspace, 'registered')
    const fresh = join(workspace, 'fresh')
    const { engine, cleanup } = await harness({ stateDir })
    try {
      await mkdir(registered, { recursive: true })
      await mkdir(fresh, { recursive: true })
      await init(engine, registered, '已登记')
      await init(engine, fresh, '新书')
      await engine.forgetProject({ root: fresh })
      const loadAt = vi.spyOn(
        engine as unknown as { loadAt: (...args: never[]) => Promise<unknown> },
        'loadAt',
      )
      const result = await engine.scanProjects({ cwd: workspace, register: true })
      expect(result.added).toContain(fresh)
      expect(result.already).toContain(registered)
      expect(loadAt).toHaveBeenCalledTimes(1)
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('skips a healthy-looking project whose snapshot cannot load', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-scan-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-scan-workspace-'))
    const broken = join(workspace, 'broken')
    const { engine, cleanup } = await harness({ stateDir })
    try {
      await mkdir(broken, { recursive: true })
      await init(engine, broken, '快照坏了')
      await rm(join(broken, 'state', 'pipeline.yaml'))
      await engine.forgetProject({ root: broken })
      const result = await engine.scanProjects({ cwd: workspace, register: true })
      expect(result.skipped.map((row) => row.root)).toContain(broken)
      expect(result.added).not.toContain(broken)
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('refreshes a changed title but does not overwrite an identity-changed row', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-scan-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-scan-workspace-'))
    const a = join(workspace, 'a')
    const b = join(workspace, 'b')
    const { engine, cleanup } = await harness({ stateDir })
    try {
      await mkdir(a, { recursive: true })
      await mkdir(b, { recursive: true })
      await init(engine, a, '旧标题')
      await init(engine, b, 'B 书')
      await engine.forgetProject({ root: b })
      const projectPath = join(a, 'novel.yaml')
      const project = parseYaml(await readFile(projectPath, 'utf8')) as Record<string, unknown>
      await writeFile(projectPath, stringifyYaml({ ...project, title: '新标题' }))

      const renamed = await engine.scanProjects({ cwd: workspace, register: true })
      expect(renamed.already).toContain(a)
      expect(renamed.added).toContain(b)
      const rows = await engine.listProjects()
      expect(rows.projects.find((row) => row.root === a)?.title).toBe('新标题')

      await rm(a, { recursive: true, force: true })
      const replacement = new EngineService(
        { ...TEST_CONFIG, projectRoot: a, stateDir },
        () => loadRulepack(),
        { now: () => new Date('2026-10-28T10:00:00.000Z') },
      )
      try {
        await init(replacement, a, '另一本书')
      } finally {
        replacement.dispose()
      }
      const identity = await engine.scanProjects({ cwd: workspace, register: true })
      expect(identity.already).toContain(a)
      expect(identity.identity_changed).toContain(a)
      const after = await engine.listProjects()
      expect(after.projects.find((row) => row.root === a)?.title).toBe('新标题')
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('stops inspecting after the first candidate beyond the 50-project cap', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'novel-scan-workspace-'))
    try {
      const make = async (root: string, title: string): Promise<void> => {
        await mkdir(root, { recursive: true })
        await writeFile(
          join(root, 'novel.yaml'),
          stringifyYaml({
            schema_version: 1,
            title,
            genre: '都市现代',
            platform: 'fanqie',
            author: '',
            description: '',
            created_at: '2026-10-01T00:00:00.000Z',
            targets: { words_per_chapter: [80, 400], total_chapters: null, dialogue_ratio: [0.2, 0.5] },
          }),
        )
      }
      for (let index = 0; index < 60; index += 1) {
        await make(join(workspace, `p${String(index).padStart(2, '0')}`), `P${index}`)
      }
      const original = FsStore.prototype.statRoot
      let inspections = 0
      const spy = vi.spyOn(FsStore.prototype, 'statRoot').mockImplementation(async function (this: FsStore) {
        inspections += 1
        return original.call(this)
      })
      try {
        const result = await scanWorkspace(workspace)
        expect(result.candidates).toHaveLength(50)
        expect(result.truncated).toBe(true)
        // The cwd probe plus at most 51 project inspections (50 kept + the one
        // that proves truncation). Before the cap short-circuit this was 62.
        expect(inspections).toBeLessThanOrEqual(52)
      } finally {
        spy.mockRestore()
      }
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('continues a --register batch when one registry write fails', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-scan-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-scan-workspace-'))
    const a = join(workspace, 'a')
    const b = join(workspace, 'b')
    const { engine, cleanup } = await harness({ stateDir })
    try {
      await mkdir(a, { recursive: true })
      await mkdir(b, { recursive: true })
      await init(engine, a, '写入失败书')
      await init(engine, b, '继续登记书')
      await engine.forgetProject({ root: a })
      await engine.forgetProject({ root: b })
      const original = ProjectRegistry.prototype.register
      const spy = vi.spyOn(ProjectRegistry.prototype, 'register').mockImplementation(async function (
        this: ProjectRegistry,
        entry,
      ) {
        if (entry.root === a) throw new Error('simulated registry write failure')
        return original.call(this, entry)
      })
      try {
        const result = await engine.scanProjects({ cwd: workspace, register: true })
        expect(result.added).toContain(b)
        expect(result.skipped.some((row) => row.root === a)).toBe(true)
        const rows = await engine.listProjects()
        expect(rows.projects.some((row) => row.root === b)).toBe(true)
        expect(rows.projects.some((row) => row.root === a)).toBe(false)
      } finally {
        spy.mockRestore()
      }
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
