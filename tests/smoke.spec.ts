import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../src/index.js'
import { fakeHost } from './harness/context.js'
import { CORE_TOOLS, TOOL_NAMES } from '../src/constants.js'

const config = (Config as unknown as (init: Record<string, unknown>) => never)({
  stateDir: join(tmpdir(), 'dsh-novel-smoke-state'),
})

describe('plugin assembly', () => {
  it('defaults projectRoot to ./novel', () => {
    const resolved = (Config as unknown as (init: Record<string, unknown>) => { projectRoot: string })({})
    expect(resolved.projectRoot).toBe('./novel')
  })

  it('registers all twenty-seven tools, five commands, the skill and the panel route', () => {
    const host = fakeHost()
    apply(host.ctx as never, config)
    expect(host.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort())
    expect(host.commands.map((command) => command.name).sort()).toEqual([
      'novel',
      'novel-admin',
      'novel-export',
      'novel-next',
      'novel-stats',
    ])
    expect(host.skills).toHaveLength(1)
    expect(host.skills[0]!.name).toBe('novel-write-engine')
    expect(host.skills[0]!.content).toContain('六条铁律')
    expect(host.skills[0]!.content).toContain('name: novel-write-engine')
    expect(host.skills[0]!.content).toContain('正文只有两个写入口')
    expect(host.skills[0]!.content).not.toContain('旧技能套件')
    expect(host.routes).toHaveLength(1)
    expect(host.routes[0]!.path).toBe('/api/novel-write-engine/panel')
    expect(host.provided.novelEngine).toBeDefined()
  })

  it('resolves the connection service through ctx.get without property access', async () => {
    const host = fakeHost(undefined, 'get')
    apply(host.ctx as never, config)
    const route = host.routes[0]!
    let status = 0
    let body = ''
    await (route.handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'GET', headers: { host: '127.0.0.1:3080' } },
      {
        set statusCode(value: number) {
          status = value
        },
        setHeader: () => undefined,
        end: (value: string) => {
          body = value
        },
      },
    )
    expect(status).toBe(200)
    expect(JSON.parse(body)).toMatchObject({ empty: true })
  })

  it('guards the exact panel route through the connection service', async () => {
    const host = fakeHost()
    apply(host.ctx as never, config)
    const route = host.routes[0]!
    const response = () => {
      const record = { statusCode: 0, body: '' }
      const res = {
        statusCode: 0,
        setHeader: () => undefined,
        end: (body: string) => {
          record.body = body
        },
      }
      Object.defineProperty(res, 'statusCode', {
        get: () => record.statusCode,
        set: (value: number) => {
          record.statusCode = value
        },
      })
      Object.defineProperty(res, 'body', { get: () => record.body })
      return res
    }
    const denied = response()
    await (route.handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'GET', headers: { host: 'evil.example' } },
      denied,
    )
    expect(denied.statusCode).toBe(403)

    const admitted = response()
    await (route.handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'GET', headers: { host: '127.0.0.1:3080' } },
      admitted,
    )
    expect(admitted.statusCode).toBe(200)
    expect(JSON.parse((admitted as unknown as { body: string }).body)).toMatchObject({ empty: true })
  })

  it('uses the host requestRejection 401 result on the panel route', async () => {
    const host = fakeHost()
    apply(host.ctx as never, config)
    const route = host.routes[0]!
    const response = { statusCode: 0, setHeader: () => undefined, end: () => undefined }
    await (route.handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'GET', headers: { host: 'unauth.example' } },
      response,
    )
    expect(response.statusCode).toBe(401)
  })

  it('denies with 503 when the connection service is absent', async () => {
    const host = fakeHost(undefined, 'none')
    apply(host.ctx as never, config)
    const route = host.routes[0]!
    const denied = { statusCode: 0, setHeader: () => undefined, end: () => undefined }
    await (route.handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'GET', headers: { host: '127.0.0.1:3080' } },
      denied,
    )
    expect(denied.statusCode).toBe(503)
  })

  it('registers only ten tools in core mode', () => {
    const host = fakeHost()
    apply(
      host.ctx as never,
      (Config as unknown as (init: Record<string, unknown>) => never)({ toolsMode: 'core' }),
    )
    expect(host.tools.map((tool) => tool.name).sort()).toEqual([...CORE_TOOLS].sort())
  })

  it('disposes the engine through ctx.effect and is idempotent', () => {
    const host = fakeHost()
    apply(host.ctx as never, config)
    const engine = host.provided.novelEngine as { dispose: () => void }
    const dispose = vi.spyOn(engine, 'dispose')
    host.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(() => engine.dispose()).not.toThrow()
    expect(() => engine.dispose()).not.toThrow()
  })

  it('registers nothing when optional services are absent, and disposes cleanly', () => {
    const host = fakeHost(['tools'])
    apply(host.ctx as never, config)
    expect(host.tools).toHaveLength(27)
    expect(host.commands).toHaveLength(0)
    expect(host.skills).toHaveLength(0)
    expect(host.routes).toHaveLength(0)
    expect(() => host.dispose()).not.toThrow()
  })

  it('rejects invalid configuration instead of silently clamping it', () => {
    const invalid = (value: Record<string, unknown>): void => {
      const host = fakeHost()
      apply(host.ctx as never, (Config as unknown as (init: Record<string, unknown>) => never)(value))
    }
    expect(() => invalid({ minScore: 999 })).toThrowError(/minScore/)
    expect(() => invalid({ toolsMode: 'weird' })).toThrowError(/toolsMode/)
    expect(() => invalid({ backupRetention: 0 })).toThrowError(/backupRetention/)
    const host = fakeHost()
    apply(
      host.ctx as never,
      (Config as unknown as (init: Record<string, unknown>) => never)({ projectRoot: '' }),
    )
    expect(host.tools).toHaveLength(27)
  })
})
