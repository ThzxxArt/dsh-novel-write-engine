import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initProjectV2 } from '../src/kernel/project/layout.js'
import { StudioRuntime } from '../src/studio/runtime.js'
import { studioRoute } from '../src/adapters/remote/studio-api.js'
import { appendEvent } from '../src/storage/repositories/runs.js'

const roots: string[] = []

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-route-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: '路由适配',
    genre: {
      major: 'mystery',
      sub: 'mystery.detective',
      tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
    },
    audience: 'general',
    platform: 'fanqie',
    targets: { total_chapters: 1 },
  })
  return { root, runtime: new StudioRuntime({ projectRoot: root }) }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const responseMock = () => {
  const record = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    ended: false,
  }
  const res = {
    get statusCode() {
      return record.statusCode
    },
    set statusCode(value: number) {
      record.statusCode = value
    },
    setHeader(name: string, value: string) {
      record.headers[name] = value
    },
    flushHeaders() {
      record.headers.flushed = 'yes'
    },
    write(chunk: string) {
      record.body += chunk
      if (chunk.includes('data:')) (res as unknown as { writableEnded: boolean }).writableEnded = true
    },
    end(chunk?: string) {
      record.body += chunk ?? ''
      record.ended = true
    },
    writableEnded: false,
  }
  return { res, record }
}

describe('studio Node route adapter', () => {
  it('guards the prefix and serves JSON through the web handler', async () => {
    const { runtime } = await setup()
    try {
      const denied = studioRoute(runtime, () => 403)
      const deniedResponse = responseMock()
      await denied.handler(
        { method: 'GET', url: '/api/novel-write-engine/v8/status', headers: { host: 'x' } },
        deniedResponse.res,
      )
      expect(deniedResponse.record.statusCode).toBe(403)
      expect(deniedResponse.record.statusCode).not.toBe(200)
      expect(deniedResponse.record.body).toBe('denied')

      const route = studioRoute(runtime)
      const accepted = responseMock()
      await route.handler(
        {
          method: 'GET',
          url: '/api/novel-write-engine/v8/status',
          headers: { host: '127.0.0.1', 'x-test': ['a', 'b'] },
        },
        accepted.res,
      )
      expect(accepted.record.statusCode).toBe(200)
      expect(accepted.record.body).toContain('路由适配')
      expect(accepted.record.ended).toBe(true)
    } finally {
      runtime.close()
    }
  })

  it('reads POST bodies from both Node events and async iterables', async () => {
    const { runtime } = await setup()
    try {
      const route = studioRoute(runtime)
      const nodeStyle = responseMock()
      const payload = JSON.stringify({ action: 'memory.reindex' })
      await route.handler(
        {
          method: 'POST',
          url: '/api/novel-write-engine/v8/action',
          headers: { host: '127.0.0.1', 'content-type': 'application/json' },
          on(event: string, handler: (...args: unknown[]) => void) {
            if (event === 'data') handler(payload.slice(0, 5))
            if (event === 'data') handler(payload.slice(5))
            if (event === 'end') handler()
          },
        },
        nodeStyle.res,
      )
      expect(nodeStyle.record.statusCode, nodeStyle.record.body).toBe(200)
      expect(nodeStyle.record.body).toContain('indexed')

      const iterableStyle = responseMock()
      await route.handler(
        {
          method: 'POST',
          url: '/api/novel-write-engine/v8/action',
          headers: { host: '127.0.0.1', 'content-type': 'application/json' },
          body: {
            async *[Symbol.asyncIterator]() {
              yield payload.slice(0, 8)
              yield payload.slice(8)
            },
          },
        },
        iterableStyle.res,
      )
      expect(iterableStyle.record.statusCode).toBe(200)
    } finally {
      runtime.close()
    }
  })

  it('streams SSE events and reports stream failures', async () => {
    const { runtime } = await setup()
    try {
      const handle = await runtime.open()
      appendEvent(handle.db.orm, {
        projectId: handle.project.config.id,
        type: 'run.start',
        payload: { hello: 'world' },
      })
      handle.db.raw
        .prepare('UPDATE event SET payload_json = ? WHERE project_id = ?')
        .run('{broken', handle.project.config.id)
      const route = studioRoute(runtime)
      const stream = responseMock()
      await route.handler(
        {
          method: 'GET',
          url: `/api/novel-write-engine/v8/events?root=${encodeURIComponent(handle.project.root)}&after=0`,
          headers: { host: '127.0.0.1', 'last-event-id': '0' },
        },
        stream.res,
      )
      expect(stream.record.statusCode).toBe(200)
      expect(stream.record.body).toContain('data:')
      expect(stream.record.body).toContain('raw')

      const failed = responseMock()
      await route.handler(
        {
          method: 'GET',
          url: '/api/novel-write-engine/v8/events?root=/definitely/missing',
          headers: { host: '127.0.0.1' },
        },
        failed.res,
      )
      expect(failed.record.statusCode).toBe(500)
      expect(failed.record.body).toContain('SSE_FAILED')
    } finally {
      runtime.close()
    }
  }, 10_000)
})
