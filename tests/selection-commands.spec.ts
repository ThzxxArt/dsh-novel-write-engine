import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCommands } from '../src/commands/index.js'
import { runAdminOperation } from '../src/commands/admin.js'
import { createNovelTools } from '../src/tools/index.js'
import { EngineService } from '../src/engine/service.js'
import { loadRulepack } from '../src/rulepack.js'
import { TEST_CONFIG, harness } from './helpers.js'

const invocation = (
  rawInput: string,
  agent?: { id: string },
  cwd?: string,
): {
  rawInput: string
  signal: AbortSignal
  agent?: { id: string }
  cwd?: string
} => ({
  rawInput,
  signal: new AbortController().signal,
  ...(agent === undefined ? {} : { agent }),
  ...(cwd === undefined ? {} : { cwd }),
})

const novel = (engine: EngineService) => createCommands(engine).find((command) => command.name === 'novel')!

const init = async (engine: EngineService, root: string, title: string): Promise<void> => {
  await engine.initProject({ title, genre: '都市现代', platform: 'fanqie', root })
}

describe('selection commands', () => {
  it('use/current/unbind switch only the current session and leave active alone', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-command-state-'))
    const other = await mkdtemp(join(tmpdir(), 'novel-command-b-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '甲书')
      await init(engine, other, '乙书')
      await engine.setActiveProject({ root })
      const command = novel(engine)

      const use = await command.handler(invocation(`use ${other}`, { id: 'session-a' }))
      expect(use.kind).toBe('success')
      expect(use.text).toContain('乙书')
      expect((await engine.listProjects()).active).toBe(root)

      const byTitle = await command.handler(invocation('use 甲书', { id: 'session-a' }))
      expect(byTitle.kind).toBe('success')
      expect(byTitle.text).toContain('甲书')
      const byPathAgain = await command.handler(invocation(`use ${other}`, { id: 'session-a' }))
      expect(byPathAgain.kind).toBe('success')

      const current = await command.handler(invocation('current', { id: 'session-a' }))
      expect(current.text).toContain('当前会话绑定')
      expect(current.text).toContain(other)

      const projects = await command.handler(invocation('projects', { id: 'session-a' }))
      expect(projects.text).toContain('* 《乙书》')
      expect(projects.text).toContain('P 《甲书》')

      const failed = await command.handler(invocation(`use ${join(other, 'missing')}`, { id: 'session-a' }))
      expect(failed.kind).toBe('error')
      expect((await command.handler(invocation('current', { id: 'session-a' }))).text).toContain(other)

      const unbound = await command.handler(invocation('unbind', { id: 'session-a' }))
      expect(unbound.text).toContain('已清除')
      const after = await command.handler(invocation('current', { id: 'session-a' }))
      expect(after.text).toContain('未绑定')
      expect(after.text).toContain('乙书')
    } finally {
      await cleanup()
      await rm(other, { recursive: true, force: true })
    }
  })

  it('reports a dead current binding instead of pretending the project is healthy', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-command-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '会消失的书')
      const command = novel(engine)
      expect((await command.handler(invocation(`use ${root}`, { id: 'session-a' }))).kind).toBe('success')
      await rm(root, { recursive: true, force: true })
      const current = await command.handler(invocation('current', { id: 'session-a' }))
      expect(current.text).toContain('[missing]')
      expect(current.text).toContain('项目目录不在了')
      const state = await engine.withCaller({ sessionId: 'session-a' }, () => engine.currentProject())
      expect(state.state).toBe('missing')
    } finally {
      await cleanup()
    }
  })

  it('uses . through the host working directory and reports title ambiguity', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-command-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-command-workspace-'))
    const a = join(workspace, 'a')
    const b = join(workspace, 'b')
    const { engine, cleanup } = await harness({ stateDir })
    try {
      await mkdir(a, { recursive: true })
      await mkdir(b, { recursive: true })
      await init(engine, a, '同名书')
      await init(engine, b, '同名书')
      const commands = createCommands(engine, {
        workingDirectory: { ensure: async () => b },
      })
      const command = commands.find((entry) => entry.name === 'novel')!
      const dot = await command.handler(invocation('use .', { id: 'session-a' }))
      expect(dot.kind).toBe('success')
      expect(dot.text).toContain(b)
      const ambiguous = await command.handler(invocation('use 同名书', { id: 'session-b' }))
      expect(ambiguous.kind).toBe('error')
      expect(ambiguous.text).toContain('ENGINE_PROJECT_AMBIGUOUS')
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('scans read-only and --register never changes active or the session binding', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-command-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-command-workspace-'))
    const a = join(workspace, 'a')
    const b = join(workspace, 'b')
    const { engine, cleanup } = await harness({ stateDir })
    try {
      await mkdir(a, { recursive: true })
      await mkdir(b, { recursive: true })
      await init(engine, a, 'A 书')
      await init(engine, b, 'B 书')
      await engine.setActiveProject({ root: a })
      await engine.withCaller({ sessionId: 'session-a' }, () => engine.getStatus({ root: b }))
      await engine.forgetProject({ root: b })
      const commands = createCommands(engine, {
        workingDirectory: { ensure: async () => workspace },
      })
      const command = commands.find((entry) => entry.name === 'novel')!
      const before = await readFile(join(stateDir, 'projects.yaml'), 'utf8')
      const readonly = await command.handler(invocation('scan', { id: 'session-a' }))
      expect(readonly.kind).toBe('success')
      expect(readonly.text).toContain('A 书')
      expect(readonly.text).toContain('B 书')
      expect(await readFile(join(stateDir, 'projects.yaml'), 'utf8')).toBe(before)

      const registered = await command.handler(invocation('scan --register', { id: 'session-a' }))
      expect(registered.text).toContain('登记结果')
      expect(registered.text).toContain('登记不等于选择')
      expect((await engine.listProjects()).active).toBe(a)
      const current = await engine.withCaller({ sessionId: 'session-a' }, () => engine.currentProject())
      expect(current.selection?.root).toBe(b)
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('resume is read-only and contains root, chapter, stage and next tool', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-command-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '续写之书')
      const command = novel(engine)
      await command.handler(invocation(`use ${root}`, { id: 'session-a' }))
      const before = await readFile(join(stateDir, 'session-bindings.yaml'), 'utf8')
      const resume = await command.handler(invocation('resume', { id: 'session-a' }))
      expect(resume.kind).toBe('success')
      expect(resume.text).toContain('《续写之书》')
      expect(resume.text).toContain(root)
      expect(resume.text).toContain('当前第 1 章')
      expect(resume.text).toContain('阶段 idle')
      expect(resume.text).toContain('novel_brief')
      expect(resume.text!.length).toBeGreaterThan(21)
      expect((await engine.panelBundle({ root })).resume?.text).toBe(resume.text)
      expect(await readFile(join(stateDir, 'session-bindings.yaml'), 'utf8')).toBe(before)
    } finally {
      await cleanup()
    }
  })

  it('resume never registers or binds the project it reads', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-command-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-command-workspace-'))
    const book = join(workspace, 'book')
    const { engine, cleanup } = await harness({ stateDir })
    try {
      await mkdir(book, { recursive: true })
      await init(engine, book, '只读续写')
      await engine.forgetProject({ root: book })
      const commands = createCommands(engine, {
        workingDirectory: { ensure: async () => workspace },
      })
      const command = commands.find((entry) => entry.name === 'novel')!
      const registryPath = join(stateDir, 'projects.yaml')
      const bindingsPath = join(stateDir, 'session-bindings.yaml')
      const beforeRegistry = await readFile(registryPath, 'utf8')
      const beforeBindings = await readFile(bindingsPath, 'utf8').catch(() => null)
      const resume = await command.handler(invocation('resume', { id: 'session-a' }))
      expect(resume.kind).toBe('success')
      expect(resume.text).toContain('只读续写')
      expect(await readFile(registryPath, 'utf8')).toBe(beforeRegistry)
      expect(await readFile(bindingsPath, 'utf8').catch(() => null)).toBe(beforeBindings)

      // The public method has the same read-only contract even when the caller
      // supplies an explicit root.
      const direct = await engine.withCaller({ sessionId: 'session-a' }, () =>
        engine.resumePrompt({ root: book }),
      )
      expect(direct.data.text).toContain('只读续写')
      expect(await readFile(registryPath, 'utf8')).toBe(beforeRegistry)
      expect(await readFile(bindingsPath, 'utf8').catch(() => null)).toBe(beforeBindings)
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('registers a project selected with /novel use for the panel and projects list', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-command-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '用后可见')
      await engine.forgetProject({ root })
      const command = novel(engine)
      const used = await command.handler(invocation(`use ${root}`, { id: 'session-a' }))
      expect(used.kind).toBe('success')
      expect((await engine.listProjects()).projects.some((row) => row.root === root)).toBe(true)
      expect((await engine.panelBundle()).projects.some((row) => row.root === root)).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('admin activate changes active but not the current session binding', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-command-state-'))
    const other = await mkdtemp(join(tmpdir(), 'novel-command-b-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '甲书')
      await init(engine, other, '乙书')
      await engine.withCaller({ sessionId: 'session-a' }, () => engine.getStatus({ root }))
      const activated = await runAdminOperation(
        engine,
        'novel_registry_activate',
        JSON.stringify({ root: other }),
      )
      expect(activated).toContain('active')
      expect(activated).toContain('当前会话没有切换')
      const current = await engine.withCaller({ sessionId: 'session-a' }, () => engine.currentProject())
      expect(current.selection?.root).toBe(root)
      expect((await engine.listProjects()).active).toBe(other)
    } finally {
      await cleanup()
      await rm(other, { recursive: true, force: true })
    }
  })
})

describe('init root isolation', () => {
  it('does not create a rootless novel_init in the session binding', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-command-state-'))
    const configRoot = await mkdtemp(join(tmpdir(), 'novel-command-config-'))
    const { root, engine, cleanup } = await harness({ stateDir, projectRoot: configRoot })
    try {
      await init(engine, root, '已绑定的书')
      await engine.withCaller({ sessionId: 'session-a' }, () => engine.getStatus({ root }))
      await engine.withCaller({ sessionId: 'session-a' }, () =>
        engine.initProject({ title: '配置根的新书', genre: '都市现代', platform: 'fanqie' }),
      )
      expect(await readFile(join(configRoot, 'novel.yaml'), 'utf8')).toContain('配置根的新书')
      const current = await engine.withCaller({ sessionId: 'session-a' }, () => engine.currentProject())
      expect(current.selection?.root).toBe(configRoot)
      expect((await engine.getStatus({ root })).data.project.title).toBe('已绑定的书')
    } finally {
      await cleanup()
      await rm(configRoot, { recursive: true, force: true })
    }
  })
})

describe('command boundary errors', () => {
  it('requires an Agent for session commands and a cwd for scan', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-command-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '边界书')
      const command = novel(engine)
      for (const line of ['use .', 'current', 'unbind', 'resume']) {
        const result = await command.handler(invocation(line))
        expect(result.kind, line).toBe('error')
        expect(result.text).toContain('Agent')
      }
      const scan = await command.handler(invocation('scan'))
      expect(scan.kind).toBe('error')
      expect(scan.text).toContain('请在项目工作区中执行')
      const pathArg = await command.handler(
        invocation('scan /tmp/other', { id: 'session-a' }, '/tmp/project-workspace'),
      )
      expect(pathArg.kind).toBe('error')
      expect(pathArg.text).toContain('不接受路径参数')
    } finally {
      await cleanup()
    }
  })
})

describe('tool caller context', () => {
  it('binds a session from an explicit tool root and reuses it for later tools', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-tool-state-'))
    const other = await mkdtemp(join(tmpdir(), 'novel-tool-b-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '甲书')
      await init(engine, other, '乙书')
      const tools = new Map(
        createNovelTools(engine, { workingDirectory: { ensure: async () => root } }).map((tool) => [
          tool.name,
          tool,
        ]),
      )
      const statusTool = tools.get('novel_status') as unknown as {
        execute: (args: unknown, exec: unknown) => Promise<unknown>
        output: { render: (args: unknown, raw: unknown) => Array<{ text: string }> }
      }
      await statusTool.execute(
        { project_root: other },
        { agent: { id: 'session-a' }, signal: new AbortController().signal },
      )
      const rootless = (await statusTool.execute({}, { agent: { id: 'session-a' } })) as {
        data: { project: { title: string }; selection?: { source: string } }
      }
      expect(rootless.data.project.title).toBe('乙书')
      expect(rootless.data.selection?.source).toBe('session')
      const rendered = statusTool.output.render({}, rootless)
      expect(rendered[0]!.text).toContain(`项目根 ${other}`)
      expect(rendered[0]!.text).toContain('选择来源 session')
      expect(tools.has('novel_scan')).toBe(false)
      expect(tools.has('novel_resume')).toBe(false)
    } finally {
      await cleanup()
      await rm(other, { recursive: true, force: true })
    }
  })

  it('keeps text-only word_count and diff independent of a project', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-tool-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '工具书')
      const tools = new Map(createNovelTools(engine).map((tool) => [tool.name, tool]))
      const word = tools.get('novel_word_count') as unknown as {
        execute: (args: unknown, exec: unknown) => Promise<unknown>
      }
      await word.execute({ text: '一段文字', project_root: root }, { agent: { id: 'session-word' } })
      const diff = tools.get('novel_diff') as unknown as {
        execute: (args: unknown, exec: unknown) => Promise<unknown>
      }
      await diff.execute({ before: '甲', after: '乙', project_root: root }, { agent: { id: 'session-diff' } })
      expect(
        await engine.withCaller({ sessionId: 'session-word' }, () => engine.currentProject()),
      ).toMatchObject({ bound: false })
      expect(
        await engine.withCaller({ sessionId: 'session-diff' }, () => engine.currentProject()),
      ).toMatchObject({ bound: false })
    } finally {
      await cleanup()
    }
  })
})

describe('command edge branches', () => {
  it('rejects empty use and an unbind with no binding', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-command-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await init(engine, root, '边界之书')
      const command = novel(engine)
      expect((await command.handler(invocation('use ', { id: 'session-a' }))).kind).toBe('error')
      const unbound = await command.handler(invocation('unbind', { id: 'session-a' }))
      expect(unbound.kind).toBe('success')
      expect(unbound.text).toContain('没有绑定')
    } finally {
      await cleanup()
    }
  })

  it('reports an empty scan and a scan that finds an identity change', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-command-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-command-workspace-'))
    const empty = await mkdtemp(join(tmpdir(), 'novel-command-empty-'))
    const { engine, cleanup } = await harness({ stateDir })
    try {
      const commands = createCommands(engine, {
        workingDirectory: { ensure: async () => empty },
      })
      const command = commands.find((entry) => entry.name === 'novel')!
      const none = await command.handler(invocation('scan', { id: 'session-a' }))
      expect(none.text).toContain('未发现项目')

      const root = join(workspace, 'book')
      await mkdir(root, { recursive: true })
      await init(engine, root, '旧书')
      await rm(root, { recursive: true, force: true })
      const replacement = new EngineService(
        { ...TEST_CONFIG, projectRoot: root, stateDir },
        () => loadRulepack(),
        { now: () => new Date('2026-10-30T10:00:00.000Z') },
      )
      try {
        await init(replacement, root, '新书')
      } finally {
        replacement.dispose()
      }
      const changed = createCommands(engine, {
        workingDirectory: { ensure: async () => workspace },
      }).find((entry) => entry.name === 'novel')!
      const output = await changed.handler(invocation('scan --register', { id: 'session-a' }))
      expect(output.text).toContain('identity_changed')
      expect(output.text).toContain('没有被覆盖')
    } finally {
      await cleanup()
      await rm(workspace, { recursive: true, force: true })
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('returns a clear error when resume has no next step', async () => {
    const fake = {
      resumePrompt: async () => ({
        data: { text: null, selection: { root: null, source: 'none' } },
        revision: 1,
        warnings: [],
      }),
    } as unknown as EngineService
    const command = createCommands(fake).find((entry) => entry.name === 'novel')!
    const result = await command.handler(invocation('resume', { id: 'session-a' }))
    expect(result.kind).toBe('error')
    expect(result.text).toContain('没有可续写')
  })

  it('reports a committed init with a binding warning instead of failing the create', async () => {
    const stateBase = await mkdtemp(join(tmpdir(), 'novel-command-state-'))
    const stateDir = join(stateBase, 'not-a-directory')
    await writeFile(stateDir, 'x')
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      const result = await engine.withCaller({ sessionId: 'session-a' }, () =>
        engine.initProject({ title: '已提交', genre: '都市现代', platform: 'fanqie', root }),
      )
      expect(result.data.title).toBe('已提交')
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'SESSION_BINDING_FAILED' }))
    } finally {
      await cleanup()
      await rm(stateBase, { recursive: true, force: true })
    }
  })

  it('survives a broken working-directory lookup and lists projects without an agent', async () => {
    const fake = {
      listProjects: async () => ({
        active: null,
        projects: [{ root: '/a', title: 'A', state: 'ok' as const, updated_at: '' }],
      }),
      currentProject: async () => {
        throw new Error('no caller')
      },
    } as unknown as EngineService
    const commands = createCommands(fake, {
      workingDirectory: {
        ensure: async () => {
          throw new Error('cwd disappeared')
        },
      },
    })
    const command = commands.find((entry) => entry.name === 'novel')!
    const projects = await command.handler(invocation('projects', { id: 'session-a' }))
    expect(projects.text).toContain('项目 1 个')
    const scan = await command.handler(invocation('scan', { id: 'session-a' }))
    expect(scan.kind).toBe('error')
    expect(scan.text).toContain('请在项目工作区中执行')
  })
})
