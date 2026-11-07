import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { getJson, postAction } from '../src/client/studio/api.js'

/**
 * Contract tests at the browser/API seam. MSW intercepts the real fetch calls
 * made by the client module, so a payload rename on either side fails here
 * without booting a host.
 */
const BASE = 'http://studio.test'

const server = setupServer(
  http.get(`${BASE}/api/novel-write-engine/v8/bootstrap`, () =>
    HttpResponse.json({
      version: 8,
      project: { id: 'p', root: '/tmp/p', title: '契约' },
      roles: [{ id: 'drafter', label: '执笔', preset: 'novel-role-drafter', canWrite: ['Draft'] }],
      capabilities: { subagents: true, sqlite: true, fts5: true, network: false },
      taxonomy: { majors: [], facets: [], tagCount: 137 },
    }),
  ),
  http.get(`${BASE}/api/novel-write-engine/v8/context`, ({ request }) => {
    const url = new URL(request.url)
    return HttpResponse.json({
      chapter: 1,
      stage: 'draft',
      query: '契纸',
      budgetTokens: 100,
      usedTokens: 10,
      omitted: 0,
      items: [
        {
          id: 'ctx',
          kind: 'canon',
          sourcePath: 'state/canon.yaml',
          sourceHash: 'sha256:x',
          text: '契纸必须有落款',
          score: 100,
          reason: ['world-rules'],
          protected: true,
          tokens: 10,
          runId: url.searchParams.get('runId'),
        },
      ],
    })
  }),
  http.post(`${BASE}/api/novel-write-engine/v8/action`, async ({ request }) => {
    const body = (await request.json()) as { action: string }
    return HttpResponse.json({ ok: true, echo: body.action })
  }),
)

const originalFetch = globalThis.fetch
let interceptedFetch: typeof globalThis.fetch = originalFetch

beforeAll(() => {
  server.listen()
  // The client intentionally uses app-relative URLs; Node fetch needs an
  // absolute base, and MSW then matches the same path the host serves.
  interceptedFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    interceptedFetch(new URL(String(input), BASE), init)) as typeof globalThis.fetch
})

afterEach(() => server.resetHandlers())

afterAll(() => {
  globalThis.fetch = originalFetch
  server.close()
})

describe('MSW API contract', () => {
  it('reads bootstrap through the real client module', async () => {
    const bootstrap = await getJson<{ version: number; roles: Array<{ preset: string }> }>('/bootstrap')
    expect(bootstrap.version).toBe(8)
    expect(bootstrap.roles[0]?.preset).toBe('novel-role-drafter')
  })

  it('passes query parameters unchanged and returns context items', async () => {
    const context = await getJson<{
      items: Array<{ runId: string; protected: boolean }>
      usedTokens: number
    }>('/context', { runId: 'run-1', taskId: 'task-1' })
    expect(context.usedTokens).toBe(10)
    expect(context.items[0]).toMatchObject({ runId: 'run-1', protected: true })
  })

  it('posts actions and reads the ok envelope', async () => {
    const response = await postAction<{ echo: string }>({ action: 'comment.create', body: 'x' })
    expect(response.echo).toBe('comment.create')
  })

  it('rejects an error envelope instead of returning it as data', async () => {
    server.use(
      http.post(`${BASE}/api/novel-write-engine/v8/action`, () =>
        HttpResponse.json(
          { ok: false, error: { code: 'STUDIO_ARTIFACT_INVALID', message: '坏输入' } },
          { status: 400 },
        ),
      ),
    )
    await expect(postAction({ action: 'nope' })).rejects.toMatchObject({
      code: 'STUDIO_ARTIFACT_INVALID',
    })
  })
})
