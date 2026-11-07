import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../src/index.js'
import { fakeHost } from './harness/context.js'

const config = (init: Record<string, unknown> = {}) =>
  (Config as unknown as (value: Record<string, unknown>) => never)({
    stateDir: join(tmpdir(), 'plugin-deep-state'),
    ...init,
  })

describe('plugin assembly deep paths', () => {
  it('validates every positive numeric config field', () => {
    const invalid = (value: Record<string, unknown>): void => {
      apply(fakeHost().ctx as never, config(value))
    }
    for (const field of [
      'maxActiveSubagents',
      'maxWritersPerProject',
      'maxConcurrentRuns',
      'reviewRounds',
      'perChapterUsd',
      'perRunUsd',
      'perTaskTokens',
    ]) {
      expect(() => invalid({ [field]: 0 }), field).toThrow(/positive|exceed/u)
    }
    expect(() => invalid({ reviewRounds: 4 })).toThrow(/exceed/u)
  })

  it('wires role presets to scoped tools and adopts a non-role director session', async () => {
    const host = fakeHost()
    const mainAgent = { id: 'main' }
    let handler: ((payload: { agent?: unknown }) => Promise<void>) | undefined
    const preset = vi.fn((scope: { role?: string }) =>
      scope.role === 'role' ? 'novel-role-drafter' : undefined,
    )
    const agents = {
      get: (id: string) => (id === 'main' ? (mainAgent as never) : undefined),
    }
    host.ctx.get = vi.fn((name: string) => {
      if (name === 'agentPresets') return { composedPreset: preset }
      if (name === 'agents') return agents
      return undefined
    })
    host.ctx.on = vi.fn((event: string, fn: (payload: { agent?: unknown }) => Promise<void>) => {
      if (event === 'agent/created') handler = fn
    })
    apply(host.ctx as never, config())
    expect(handler).toBeDefined()

    const registered: string[] = []
    const dispose = vi.fn(async () => undefined)
    const live = {
      id: 'role-1',
      ctx: {
        role: 'role',
        inject: vi.fn((_services: string[], body: (scope: unknown) => void) => {
          body({
            tools: {
              register: (tool: { name: string }) => registered.push(tool.name),
              restrict: vi.fn(),
            },
            systemPrompt: { section: vi.fn() },
          })
          return { dispose }
        }),
      },
    }
    await handler!({ agent: live })
    expect(preset).toHaveBeenCalled()
    expect(registered).toContain('novel_task_read')
    expect(registered).toContain('novel_draft_submit')
    host.dispose()
    expect(dispose).toHaveBeenCalled()

    await handler!({ agent: { id: 'main', ctx: { role: 'director', inject: vi.fn() } } })
    const runtime = host.provided.novelStudio as {
      directorAgent(): { id: string } | undefined
    }
    expect(runtime.directorAgent()?.id).toBe('main')

    await handler!({ agent: { id: 'no-ctx' } })
    await handler!({ agent: { id: 'bad', ctx: {} } })
  })

  it('reads commands through a working-directory service and covers admit-only connections', async () => {
    const host = fakeHost(undefined, 'get')
    const workingDirectory = { root: '/tmp/work' }
    host.ctx.get = vi.fn((name: string) => {
      if (name === 'connection') {
        return {
          admit: (request: { headers?: Record<string, string> }) =>
            request.headers?.host === 'evil.example' ? { rejection: 403 } : { peer: { id: 'x' } },
        }
      }
      if (name === 'workingDirectory') return workingDirectory
      return undefined
    })
    apply(host.ctx as never, config())
    expect(host.commands.length).toBeGreaterThan(0)
    const route = host.routes[0]!
    const denied = { statusCode: 0, setHeader: () => undefined, end: () => undefined }
    await (route.handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'GET', headers: { host: 'evil.example' } },
      denied,
    )
    expect(denied.statusCode).toBe(403)
    const admitted = { statusCode: 0, setHeader: () => undefined, end: () => undefined }
    await (route.handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'GET', headers: { host: '127.0.0.1' } },
      admitted,
    )
    expect(admitted.statusCode).toBe(200)
  })

  it('omits role wiring when the host has no agent event or preset service', () => {
    const host = fakeHost(['tools', 'commands', 'skills', 'webServer'])
    apply(host.ctx as never, config())
    expect(host.commands.length).toBeGreaterThan(0)
    expect(host.routes).toHaveLength(2)
  })
})
