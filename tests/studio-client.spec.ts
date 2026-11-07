import { afterEach, describe, expect, it, vi } from 'vitest'
import { getJson, postAction, StudioApiError } from '../src/client/studio/api.js'
import { useStudio, WORKSPACES } from '../src/client/studio/store.js'
import { STUDIO_DICTIONARIES } from '../src/client/studio/locale.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('client API', () => {
  it('builds query strings and returns JSON', async () => {
    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ url }),
    }))
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch
    const result = (await getJson<{ url: string }>('/status', {
      root: '/tmp/a',
      chapter: 2,
      empty: undefined,
    })) as { url: string }
    expect(result.url).toContain('/status?root=%2Ftmp%2Fa&chapter=2')
  })

  it('throws StudioApiError on HTTP and logical errors', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 'BAD', message: 'bad', hint: 'fix' } }),
    })) as unknown as typeof globalThis.fetch
    await expect(getJson('/status')).rejects.toBeInstanceOf(StudioApiError)
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: { code: 'BAD', message: 'bad' } }),
    })) as unknown as typeof globalThis.fetch
    await expect(postAction({ action: 'x' })).rejects.toMatchObject({ code: 'BAD' })
  })

  it('posts actions and returns the payload', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, runId: 'r1' }),
    }))
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch
    await expect(postAction<{ runId: string }>({ action: 'run.start' })).resolves.toMatchObject({
      runId: 'r1',
    })
    expect(fetch).toHaveBeenCalledWith(
      '/api/novel-write-engine/v8/action',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})

describe('client store', () => {
  it('navigates workspaces and selection state', () => {
    const state = useStudio.getState()
    expect(WORKSPACES).toContain(state.workspace)
    state.setWorkspace('review')
    state.setChapter(3)
    state.selectArtifact('a1')
    state.selectFinding('f1')
    state.setInspector('query')
    state.setPaletteOpen(true)
    state.setRoot('/tmp/p')
    state.setSse(true, 7)
    const next = useStudio.getState()
    expect(next.workspace).toBe('review')
    expect(next.chapter).toBe(3)
    expect(next.selectedArtifactId).toBe('a1')
    expect(next.selectedFindingId).toBe('f1')
    expect(next.inspector).toBe('query')
    expect(next.paletteOpen).toBe(true)
    expect(next.root).toBe('/tmp/p')
    expect(next.sseConnected).toBe(true)
    expect(next.sseSeq).toBe(7)
  })
})

describe('workbench locale', () => {
  it('ships zh/en dictionaries with identical keys for every workspace', () => {
    const zh = STUDIO_DICTIONARIES.zh
    const en = STUDIO_DICTIONARIES.en
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const workspace of WORKSPACES) {
      expect(zh[`nav.${workspace}`]).toBeTruthy()
      expect(en[`nav.${workspace}`]).toBeTruthy()
      expect(en[`title.${workspace}`]).toBeTruthy()
    }
    expect(en['nav.manuscript']).toBe('Manuscript')
    expect(zh['nav.manuscript']).toBe('稿件')
  })
})
