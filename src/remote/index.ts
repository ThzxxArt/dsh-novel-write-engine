import { PANEL_ROUTE, REMOTE_VERSION } from '../constants.js'
import { EngineError, ERROR_CODES } from '../types.js'
import type { EngineService, PanelSectionQuery } from '../engine/service.js'
import type { PanelSectionName } from '../engine/projections.js'

/** The read-only payload the browser panel fetches. */
export interface PanelPayload {
  schemaVersion: number
  projects?: unknown
  selection?: unknown
  summary?: unknown
  chapters?: unknown
  resume?: unknown
  missing?: unknown
  empty?: true
  error?: string
  payload_version?: 7
  section?: PanelSectionName
  items?: unknown
  total?: number
  returned?: number
  truncated?: boolean
  next_cursor?: string | null
  updated_at?: string
  etag?: string
}

const SECTION_NAMES: ReadonlySet<string> = new Set([
  'overview',
  'chapters',
  'characters',
  'foreshadows',
  'timeline',
  'relationships',
  'worldbook',
  'quality',
  'quality_detail',
  'health',
  'chapter_detail',
])

/** Build the payload for one optional panel query root; section is additive. */
export async function panelPayload(
  engine: EngineService,
  root?: string,
  section?: string,
  query: PanelSectionQuery = {},
  lean = false,
): Promise<PanelPayload> {
  if (section !== undefined && SECTION_NAMES.has(section)) {
    const payload = await engine.panelSection({
      ...(root === undefined ? {} : { root }),
      section: section as PanelSectionName,
      query,
    })
    return { ...payload, schemaVersion: REMOTE_VERSION }
  }
  const bundle = await engine.panelBundle({ ...(root === undefined ? {} : { root }), lean })
  return { ...bundle, schemaVersion: REMOTE_VERSION }
}

interface ServerResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body: string): void
}

interface RequestLike {
  method?: string
  url?: string
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>
}

const queryRoot = (url: string | undefined): string | undefined => {
  if (url === undefined || url === '') return undefined
  try {
    const parsed = new URL(url, 'http://panel.local')
    const value = parsed.searchParams.get('root')
    return value === null || value.trim() === '' ? undefined : value
  } catch {
    return undefined
  }
}

const queryPanel = (url: string | undefined): { section?: string; query: PanelSectionQuery } => {
  if (url === undefined || url === '') return { query: {} }
  try {
    const parsed = new URL(url, 'http://panel.local')
    const section = parsed.searchParams.get('section') ?? undefined
    const query: PanelSectionQuery = {}
    for (const key of ['search', 'status', 'scene', 'sort', 'cursor'] as const) {
      const value = parsed.searchParams.get(key)
      if (value !== null && value !== '') query[key] = value
    }
    const limit = parsed.searchParams.get('limit')
    if (limit !== null && /^\d+$/.test(limit)) query.limit = Number(limit)
    const chapter = parsed.searchParams.get('chapter')
    if (chapter !== null && /^\d+$/.test(chapter)) query.chapter = Number(chapter)
    return section === undefined ? { query } : { section, query }
  } catch {
    return { query: {} }
  }
}

/** Admission outcome for a panel request; `undefined` means admitted. */
export type PanelRejection = 401 | 403 | 503 | undefined

/**
 * The panel route is exact, so it runs before the `/api` prefix admission in
 * the host. It must therefore apply the same trust/authentication fence
 * itself. The default is deny: forgetting to wire a guard cannot expose state.
 */
export type PanelGuard = (request: RequestLike) => PanelRejection

const denyAll: PanelGuard = () => 503

const rejectionText: Record<Exclude<PanelRejection, undefined>, string> = {
  401: 'unauthorized',
  403: 'forbidden',
  503: 'panel admission is unavailable',
}

/** Handler for the panel route: admission, then GET/HEAD only, no write surface. */
export function panelHandler(engine: EngineService, guard: PanelGuard = denyAll) {
  return async (request: RequestLike, response: ServerResponseLike): Promise<void> => {
    const rejection = guard(request)
    if (rejection !== undefined) {
      response.statusCode = rejection
      response.setHeader('content-type', 'text/plain; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(rejectionText[rejection])
      return
    }
    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      response.statusCode = 405
      response.setHeader('allow', 'GET, HEAD')
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ error: 'read-only endpoint' }))
      return
    }
    try {
      const { section, query } = queryPanel(request.url)
      let lean = false
      try {
        lean = new URL(request.url ?? '', 'http://panel.local').searchParams.get('lean') === '1'
      } catch {
        // Invalid URLs fall through to the normal lookup and its typed error.
      }
      const payload = await panelPayload(engine, queryRoot(request.url), section, query, lean)
      const etag = typeof payload.etag === 'string' ? payload.etag : null
      if (etag !== null) {
        response.setHeader('etag', `"${etag}"`)
        const ifNoneMatch = request.headers?.['if-none-match']
        const candidate = Array.isArray(ifNoneMatch) ? ifNoneMatch[0] : ifNoneMatch
        if (candidate === `"${etag}"` || candidate === etag) {
          response.statusCode = 304
          response.setHeader('cache-control', 'no-store')
          response.end('')
          return
        }
      }
      const body = method === 'HEAD' ? '' : JSON.stringify(payload)
      response.statusCode = 200
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(body)
    } catch (error) {
      if (error instanceof EngineError && error.code === ERROR_CODES.PROJECT_NOT_FOUND) {
        response.statusCode = 200
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.setHeader('cache-control', 'no-store')
        response.end(
          JSON.stringify({
            schemaVersion: REMOTE_VERSION,
            projects: [],
            selection: { root: null, source: 'none' },
            error: '还没有项目：调用 novel_init 创建。',
            empty: true,
          }),
        )
        return
      }
      response.statusCode = 500
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(
        JSON.stringify({
          schemaVersion: REMOTE_VERSION,
          projects: [],
          selection: { root: null, source: 'none' },
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }
}

/** The route descriptor passed to `webServer.register`. */
export function panelRoute(engine: EngineService, guard: PanelGuard = denyAll) {
  return { kind: 'exact' as const, path: PANEL_ROUTE, handler: panelHandler(engine, guard) }
}
