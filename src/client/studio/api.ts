const BASE = '/api/novel-write-engine/v8'

export interface ApiError {
  code: string
  message: string
  hint?: string
}

export class StudioApiError extends Error {
  readonly code: string
  readonly hint: string | undefined

  constructor(error: ApiError) {
    super(error.message)
    this.name = 'StudioApiError'
    this.code = error.code
    this.hint = error.hint
  }
}

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== '') search.set(key, String(value))
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

export async function getJson<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${BASE}${path}${query(params)}`, {
    signal,
    headers: { accept: 'application/json' },
  })
  const body = (await response.json()) as T & { error?: ApiError }
  if (!response.ok)
    throw new StudioApiError(body.error ?? { code: 'HTTP_ERROR', message: `HTTP ${response.status}` })
  if (body.error !== undefined && (body as { ok?: boolean }).ok === false)
    throw new StudioApiError(body.error)
  return body
}

export async function postAction<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${BASE}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = (await response.json()) as { ok?: boolean; error?: ApiError } & T
  if (!response.ok || parsed.ok === false)
    throw new StudioApiError(parsed.error ?? { code: 'ACTION_FAILED', message: `HTTP ${response.status}` })
  return parsed
}

export const api = { getJson, postAction }

export interface Bootstrap {
  version: number
  project: {
    id: string
    root: string
    title: string
    author: string
    genre: { major: string; sub: string; tags: string[]; audience: string; platform: string }
    genre_path: string
    tags: string[]
    format_version: number
    created_at: string
    updated_at: string
  } | null
  roles: Array<{ id: string; label: string; preset: string; canWrite: string[] }>
  capabilities: { subagents: boolean; sqlite: boolean; fts5: boolean; network: boolean }
  taxonomy: {
    majors: Array<{ id: string; label: string; subCount: number }>
    facets: string[]
    tagCount: number
  }
  error?: string
}

export interface Status {
  project: Bootstrap['project']
  stage: string
  chapter: number
  words: number
  score: number | null
  min_score?: number
  blocking: number
  run: { id: string; kind: string; status: string; targetChapter: number | null } | null
  next: { action: string; label: string; args: Record<string, unknown> }
  counts: { chapters: number; archived: number; artifacts: number; openFindings: number }
  cost_usd: number
}

export interface ChapterRow {
  chapter: number
  title: string
  stage: string
  words: number
  score: number | null
  blockers: number
  updated_at: string | null
}

export interface Board {
  runs: Array<{
    id: string
    kind: string
    status: string
    targetChapter: number | null
    error: string | null
  }>
  tasks: Array<{
    id: string
    runId: string
    role: string
    kind: string
    status: string
    attempt: number
    maxAttempts: number
    dependsOn?: string[]
    outputArtifactId?: string | null
    error: string | null
  }>
  assignments: Array<{
    id: string
    taskId: string
    role?: string
    provider?: string
    preset?: string
    model: string | null
    status: string
    stopReason: string | null
    usage?: Record<string, unknown> | null
  }>
  gates: Array<{
    id: string
    gate: string
    runId: string
    taskId: string | null
    chapter: number | null
    artifactId: string | null
    requestedAt: string
  }>
  artifacts: Array<{ id: string; kind: string; chapter: number | null; version: number }>
  seq: number
}

export interface ReviewPayload {
  reports: Array<{
    id: string
    role: string
    version?: number
    total?: number
    dimensions?: Array<{
      id: string
      max: number
      deductions: Array<{ rule: string; delta: number }>
    }>
    findings: Array<Finding>
  }>
  findings: Finding[]
  gates: Array<{ id: string; artifactId: string; gate: string; verdict: string; detailsJson: string }>
}

export interface Finding {
  id: string
  role: string
  dimension: string
  severity: 'blocker' | 'advisory'
  location: string
  evidence: string
  problem: string
  fix: string
  status: 'open' | 'fixed' | 'waived'
}
