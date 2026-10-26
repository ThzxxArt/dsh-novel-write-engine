import { PANEL_ROUTE, REMOTE_VERSION } from '../constants.js'
import type { EngineService } from '../engine/service.js'

/** The read-only payload the browser panel fetches. */
export interface PanelPayload {
  schemaVersion: number
  summary: unknown
  chapters: unknown
  gates: unknown
}

/** Build the payload from one synchronized snapshot of the project. */
export async function panelPayload(engine: EngineService): Promise<PanelPayload> {
  const bundle = await engine.panelBundle()
  return { schemaVersion: REMOTE_VERSION, ...bundle }
}

interface ServerResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body: string): void
}

interface RequestLike {
  method?: string
}

/** Handler for the panel route: GET/HEAD only, no write surface exists. */
export function panelHandler(engine: EngineService) {
  return async (request: RequestLike, response: ServerResponseLike): Promise<void> => {
    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      response.statusCode = 405
      response.setHeader('allow', 'GET, HEAD')
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ error: 'read-only endpoint' }))
      return
    }
    try {
      const payload = await panelPayload(engine)
      const body = method === 'HEAD' ? '' : JSON.stringify(payload)
      response.statusCode = 200
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.end(body)
    } catch (error) {
      response.statusCode = 200
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(
        JSON.stringify({
          schemaVersion: REMOTE_VERSION,
          error: error instanceof Error ? error.message : String(error),
          empty: true,
        }),
      )
    }
  }
}

/** The route descriptor passed to `webServer.register`. */
export function panelRoute(engine: EngineService) {
  return { kind: 'exact' as const, path: PANEL_ROUTE, handler: panelHandler(engine) }
}
