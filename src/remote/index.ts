import { PANEL_ROUTE, REMOTE_VERSION } from '../constants.js'
import { EngineError, ERROR_CODES } from '../types.js'
import type { EngineService } from '../engine/service.js'

/** The read-only payload the browser panel fetches. */
export interface PanelPayload {
  schemaVersion: number
  projects: unknown
  selection: unknown
  summary?: unknown
  chapters?: unknown
  gates?: unknown
  resume?: unknown
  missing?: unknown
  empty?: true
  error?: string
}

/** Build the payload for one optional panel query root. */
export async function panelPayload(engine: EngineService, root?: string): Promise<PanelPayload> {
  const bundle = await engine.panelBundle(root === undefined ? {} : { root })
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
      const payload = await panelPayload(engine, queryRoot(request.url))
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
