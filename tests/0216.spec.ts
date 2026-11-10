import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config, type Config as ConfigShape } from '../src/index.js'
import { fakeHost } from './harness/context.js'
import { createNovelTools, type WorkingDirectoryLike } from '../src/tools/index.js'
import type { EngineService } from '../src/engine/service.js'

const config = (stateDir: string): ConfigShape =>
  (Config as unknown as (init: Record<string, unknown>) => ConfigShape)({ stateDir })

const signal = (): AbortSignal => new AbortController().signal

const init = async (engine: EngineService, root: string, title: string): Promise<void> => {
  await engine.initProject({ title, genre: '都市现代', platform: 'fanqie', root })
}

const novel = (host: ReturnType<typeof fakeHost>) => {
  const command = host.commands.find((entry) => entry.name === 'novel')
  if (command === undefined) throw new Error('novel command was not registered')
  return command
}

type Handler = (invocation: {
  rawInput: string
  signal: AbortSignal
  agent?: { id: string }
}) => Promise<{ kind: 'success' | 'error'; text?: string }>

/**
 * The reported failure: `/novel scan --register` refused with "请在项目工作区中
 * 执行" while the user was in a project workspace. The host registers
 * `workingDirectory` after this plugin applies, and the plugin used to capture
 * that service once during load — permanently `undefined`.
 */
describe('0.2.16 working-directory resolution', () => {
  it('finds a workingDirectory service registered after the plugin applies', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-0216-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-0216-workspace-'))
    const host = fakeHost()
    try {
      apply(host.ctx as never, config(stateDir))
      const engine = host.provided.novelEngine as EngineService
      await init(engine, join(workspace, 'book'), '工作区里的书')

      // No service at apply time, exactly like a provider that is still LOADING.
      expect(host.services.workingDirectory).toBeUndefined()
      host.services.workingDirectory = { ensure: async () => workspace } satisfies WorkingDirectoryLike

      const result = (await (novel(host).handler as unknown as Handler)({
        rawInput: 'scan --register',
        signal: signal(),
        agent: { id: 'session-0216' },
      })) as { kind: string; text: string }
      expect(result.kind).toBe('success')
      expect(result.text).toContain(`扫描根：${workspace}`)
      expect(result.text).toContain('工作区里的书')
      expect(result.text).toContain('登记结果')
    } finally {
      host.dispose()
      await rm(stateDir, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('falls back to the session binding when the host supplies no directory', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-0216-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-0216-workspace-'))
    const host = fakeHost()
    try {
      apply(host.ctx as never, config(stateDir))
      const engine = host.provided.novelEngine as EngineService
      const root = join(workspace, 'book')
      await init(engine, root, '已绑定的书')
      await engine.withCaller({ sessionId: 'session-0216' }, () => engine.getStatus({ root }))

      const result = (await (novel(host).handler as unknown as Handler)({
        rawInput: 'scan',
        signal: signal(),
        agent: { id: 'session-0216' },
      })) as { kind: string; text: string }
      expect(result.kind).toBe('success')
      expect(result.text).toContain(`扫描根：${root}（来源：会话绑定）`)
      expect(result.text).toContain('已绑定的书')
    } finally {
      host.dispose()
      await rm(stateDir, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('names the concrete reason instead of blaming the workspace', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-0216-state-'))
    const host = fakeHost()
    try {
      apply(host.ctx as never, config(stateDir))
      const result = (await (novel(host).handler as unknown as Handler)({
        rawInput: 'scan',
        signal: signal(),
        agent: { id: 'session-0216' },
      })) as { kind: string; text: string }
      expect(result.kind).toBe('error')
      expect(result.text).toContain('无法确定扫描根')
      expect(result.text).toContain('宿主没有提供 workingDirectory 服务')
      expect(result.text).not.toContain('请在项目工作区中执行')
    } finally {
      host.dispose()
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('resolves the directory per tool call, not once at construction', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-0216-state-'))
    const workspace = await mkdtemp(join(tmpdir(), 'novel-0216-workspace-'))
    const host = fakeHost()
    try {
      apply(host.ctx as never, config(stateDir))
      const engine = host.provided.novelEngine as EngineService
      const root = join(workspace, 'book')
      await init(engine, root, '工具用的书')

      const ensure = vi.fn(async () => workspace)
      const tools = createNovelTools(engine, {
        resolveWorkingDirectory: () => ({ ensure }),
      })
      const status = tools.find((tool) => tool.name === 'novel_status')!
      await status.execute({}, { agent: { id: 'session-0216' } } as never)
      expect(ensure).toHaveBeenCalledTimes(1)

      await status.execute({}, { agent: { id: 'session-0216' } } as never)
      expect(ensure).toHaveBeenCalledTimes(2)
    } finally {
      host.dispose()
      await rm(stateDir, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
