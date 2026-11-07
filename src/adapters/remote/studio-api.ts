import { Hono } from 'hono'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { StudioRuntime } from '../../studio/runtime.js'
import type { PanelGuard } from '../../remote/index.js'
import { STUDIO_API_PREFIX } from '../../constants.js'
import { loadTaxonomy } from '../../taxonomy.js'
import { ROLES } from '../../contracts/roles.js'
import { listEvents, listHumanGates, listRuns, usageForRun } from '../../storage/repositories/runs.js'
import {
  latestGateResults,
  listArtifacts,
  listComments,
  listFindings,
  listGateResults,
} from '../../storage/repositories/artifacts.js'
import { searchMemory } from '../../storage/repositories/memory.js'
import { loadBible, loadBookOutline, listChapterPlans, loadCanon } from '../../kernel/book/store.js'
import { exportProject, assertExportReady, type ExportKind } from '../../kernel/export/index.js'
import { createSnapshot, verifySnapshot } from '../../kernel/export/snapshot.js'
import { countWordMetrics } from '../../domain/wordcount.js'
import { genrePath } from '../../domain/taxonomy.js'
import { saveProjectConfig } from '../../kernel/project/layout.js'
import { BACKUP_DIR, EXPORTS_DIR } from '../../kernel/project/layout.js'
import { StudioError } from '../../contracts/errors.js'
import { ArtifactKindSchema, type Draft } from '../../contracts/artifacts.js'

interface RequestLike {
  method?: string
  url?: string
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>
  body?: unknown
  on?: (event: string, handler: (...args: unknown[]) => void) => void
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>
}

interface ResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
  write?: (chunk: string) => void
  flushHeaders?: () => void
}

const json = (
  c: { json: (value: unknown, status?: number) => Response },
  value: unknown,
  status = 200,
): Response => c.json(value, status as never)

const readBody = async (request: RequestLike): Promise<string> => {
  if (typeof request.body === 'string') return request.body
  if (request.body !== undefined && request.body !== null) {
    if (typeof (request.body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
      let text = ''
      for await (const chunk of request.body as AsyncIterable<Uint8Array | string>) {
        text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
      }
      return text
    }
  }
  if (typeof request.on === 'function') {
    return new Promise((resolve, reject) => {
      let text = ''
      request.on?.('data', (chunk: unknown) => {
        text += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as Uint8Array)
      })
      request.on?.('end', () => resolve(text))
      request.on?.('error', reject)
    })
  }
  return ''
}

const toWebRequest = async (request: RequestLike): Promise<Request> => {
  const url = new URL(request.url ?? '/', 'http://studio.local')
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (value === undefined) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value))
  }
  const method = (request.method ?? 'GET').toUpperCase()
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(request)
  return new Request(url, { method, headers, ...(body === undefined ? {} : { body }) })
}

const writeWebResponse = async (response: Response, res: ResponseLike): Promise<void> => {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  if (response.body !== null && response.headers.get('content-type')?.includes('text/event-stream')) {
    res.flushHeaders?.()
    const reader = response.body.getReader()
    const pump = async (): Promise<void> => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write?.(new TextDecoder().decode(value))
      }
    }
    await pump()
    res.end('')
    return
  }
  res.end(await response.text())
}

const runEvents = async (request: RequestLike, res: ResponseLike, runtime: StudioRuntime): Promise<void> => {
  const url = new URL(request.url ?? '/', 'http://studio.local')
  const root = url.searchParams.get('root') ?? undefined
  const lastEventId = request.headers?.['last-event-id']
  const headerAfter = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId
  const parsedAfter = Number(url.searchParams.get('after') ?? headerAfter ?? '0')
  const after = Number.isFinite(parsedAfter) && parsedAfter >= 0 ? Math.floor(parsedAfter) : 0
  const handle = await runtime.open(root)
  res.statusCode = 200
  res.setHeader('content-type', 'text/event-stream; charset=utf-8')
  res.setHeader('cache-control', 'no-cache')
  res.setHeader('connection', 'keep-alive')
  res.flushHeaders?.()
  let seq = after
  let closed = false
  const close = (): void => {
    closed = true
  }
  // The host's response object may expose a close hook; polling stops on the
  // next tick when it does not.
  ;(res as unknown as { on?: (name: string, cb: () => void) => void }).on?.('close', close)
  while (!closed) {
    const rows = listEvents(handle.db.orm, handle.project.config.id, seq, 100)
    for (const row of rows) {
      seq = row.seq
      let payload: unknown = {}
      try {
        payload = JSON.parse(row.payloadJson)
      } catch {
        payload = { raw: row.payloadJson }
      }
      res.write?.(
        `id: ${row.seq}\ndata: ${JSON.stringify({ seq: row.seq, type: row.type, runId: row.runId, taskId: row.taskId, payload, at: row.at })}\n\n`,
      )
    }
    if (rows.length === 0) res.write?.(': keepalive\n\n')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    if (
      typeof (res as unknown as { writableEnded?: boolean }).writableEnded === 'boolean' &&
      (res as unknown as { writableEnded: boolean }).writableEnded
    )
      break
  }
  res.end('')
}

const chapterRows = async (handle: Awaited<ReturnType<StudioRuntime['open']>>) => {
  const plans = await listChapterPlans(handle.project.store)
  const files = (await handle.project.store.list('manuscript')).filter((name) => /^ch-\d{4}\.md$/u.test(name))
  const rows: Array<Record<string, unknown>> = []
  const max = Math.max(
    1,
    ...plans.map((plan) => plan.chapter),
    ...files.map((name) => Number(name.slice(3, 7))),
  )
  for (let chapter = 1; chapter <= max; chapter += 1) {
    const plan = plans.find((row) => row.chapter === chapter)
    const draft = await handle.artifacts.latest('Draft', chapter)
    const content = draft === null ? '' : (draft.content as Draft).content
    const metrics = countWordMetrics(content)
    const gateRows = draft === null ? [] : [...latestGateResults(handle.db.orm, draft.id).values()]
    const scoreGate = gateRows.find((row) => row.gate === 'PG-07')
    let score: number | null = null
    if (scoreGate !== undefined) {
      try {
        score = Number((JSON.parse(scoreGate.detailsJson) as { score?: number }).score ?? 0)
      } catch {
        score = null
      }
    }
    const archived = files.includes(`ch-${String(chapter).padStart(4, '0')}.md`)
    const findingBlockers =
      draft === null
        ? 0
        : listFindings(handle.db.orm, draft.id).filter(
            (finding) => finding.severity === 'blocker' && finding.status === 'open',
          ).length
    rows.push({
      chapter,
      title: plan?.title ?? (archived ? `第${chapter}章` : ''),
      stage: archived ? 'archived' : draft !== null ? draft.status : plan !== undefined ? 'planned' : 'empty',
      words: metrics.total_word_count,
      score,
      blockers: Math.max(gateRows.filter((row) => row.verdict === 'fail').length, findingBlockers),
      updated_at: draft?.provenance.createdAt ?? null,
    })
  }
  return rows
}

export function createStudioApi(runtime: StudioRuntime): Hono {
  const app = new Hono()

  app.get(`${STUDIO_API_PREFIX}/bootstrap`, async (c) => {
    const root = c.req.query('root')
    const taxonomy = loadTaxonomy()
    try {
      const handle = await runtime.open(root)
      return json(c, {
        version: 8,
        project: {
          id: handle.project.config.id,
          root: handle.project.root,
          title: handle.project.config.title,
          author: handle.project.config.author,
          genre: {
            ...handle.project.config.genre,
            audience: handle.project.config.audience,
            platform: handle.project.config.platform,
          },
          genre_path: genrePath(handle.project.config.genre, taxonomy),
          tags: handle.project.config.genre.tags,
          format_version: 2,
          created_at: handle.project.config.created_at,
          updated_at: handle.project.config.updated_at,
        },
        roles: Object.values(ROLES).map((role) => ({
          id: role.id,
          label: role.label,
          preset: role.preset,
          canWrite: role.canWrite,
        })),
        capabilities: {
          subagents: runtime.directorAgent() !== undefined,
          sqlite: true,
          fts5: true,
          network: true,
        },
        taxonomy: {
          majors: taxonomy.majors.map((major) => ({
            id: major.id,
            label: major.label,
            subCount: major.subs.length,
          })),
          facets: ['world', 'prot', 'plot', 'tone', 'theme', 'set', 'struct', 'pov', 'emo', 'pace', 'market'],
          tagCount: taxonomy.tags.length,
        },
      })
    } catch (error) {
      return json(c, {
        version: 8,
        project: null,
        roles: Object.values(ROLES).map((role) => ({
          id: role.id,
          label: role.label,
          preset: role.preset,
          canWrite: role.canWrite,
        })),
        capabilities: { subagents: false, sqlite: true, fts5: true, network: true },
        taxonomy: {
          majors: taxonomy.majors.map((major) => ({
            id: major.id,
            label: major.label,
            subCount: major.subs.length,
          })),
          facets: ['world', 'prot', 'plot', 'tone', 'theme', 'set', 'struct', 'pov', 'emo', 'pace', 'market'],
          tagCount: taxonomy.tags.length,
        },
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  app.get(`${STUDIO_API_PREFIX}/projects`, (c) => {
    return json(c, { projects: runtime.projects() })
  })

  app.get(`${STUDIO_API_PREFIX}/status`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const chapter = c.req.query('chapter')
    if (chapter !== undefined && (!/^\d+$/u.test(chapter) || Number(chapter) < 1)) {
      return json(
        c,
        { error: { code: 'CHAPTER_INVALID', message: 'chapter must be a positive integer' } },
        400,
      )
    }
    return json(c, await handle.director.status(chapter === undefined ? undefined : Number(chapter)))
  })

  app.get(`${STUDIO_API_PREFIX}/chapters`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    return json(c, { rows: await chapterRows(handle) })
  })

  app.get(`${STUDIO_API_PREFIX}/manuscript`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const chapter = Number(c.req.query('chapter') ?? '1')
    if (!Number.isInteger(chapter) || chapter < 1)
      return json(
        c,
        { error: { code: 'CHAPTER_INVALID', message: 'chapter must be a positive integer' } },
        400,
      )
    const archived = await handle.project.store.readText(
      `manuscript/ch-${String(chapter).padStart(4, '0')}.md`,
    )
    const plan = (await listChapterPlans(handle.project.store)).find((row) => row.chapter === chapter)
    const draft = await handle.artifacts.latest('Draft', chapter)
    const draftContent = draft === null ? '' : (draft.content as Draft).content
    return json(c, {
      chapter,
      title: plan?.title ?? '',
      // A human edit creates a newer working draft; showing the archived file
      // would silently hide it on reload.
      text: draft === null ? (archived ?? '') : draftContent,
      archived: archived !== null,
      draft:
        draft === null
          ? null
          : { id: draft.id, version: draft.version, status: draft.status, hash: draft.contentHash },
    })
  })

  app.get(`${STUDIO_API_PREFIX}/outline`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const [book, chapters, canon] = await Promise.all([
      loadBookOutline(handle.project.store),
      listChapterPlans(handle.project.store),
      loadCanon(handle.project.store),
    ])
    return json(c, { book, chapters, foreshadows: canon.foreshadows })
  })

  app.get(`${STUDIO_API_PREFIX}/bible`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const [bible, canon, plans] = await Promise.all([
      loadBible(handle.project.store),
      loadCanon(handle.project.store),
      listChapterPlans(handle.project.store),
    ])
    const drafts = listArtifacts(handle.db.orm, handle.project.config.id, { kind: 'Draft', limit: 2000 })
    const reviews = listArtifacts(handle.db.orm, handle.project.config.id, {
      kind: 'ReviewReport',
      limit: 2000,
    })
    const backlinks: Record<
      string,
      { chapters: number[]; foreshadows: string[]; reviews: Array<{ chapter: number | null; role: string }> }
    > = {}
    for (const character of bible.characters) {
      const name = String(character.name ?? character.slug ?? '')
      if (name === '') continue
      const chapters = plans
        .filter((plan) => plan.cast.includes(name))
        .map((plan) => plan.chapter)
        .sort((left, right) => left - right)
      const foreshadows = canon.foreshadows
        .filter((row) => JSON.stringify(row).includes(name))
        .map((row) => String(row.title ?? row.key ?? row.id ?? '未命名伏笔'))
      const reviewRefs = reviews
        .filter((row) => row.chapter !== null && chapters.includes(row.chapter))
        .map((row) => {
          let role = 'review'
          try {
            role = String((JSON.parse(row.provenanceJson) as { role?: unknown }).role ?? 'review')
          } catch {
            // A malformed provenance row must not break the Bible view.
          }
          return { chapter: row.chapter, role }
        })
      backlinks[name] = { chapters, foreshadows, reviews: reviewRefs }
    }
    return json(c, { bible, canon, backlinks, drafts: drafts.length })
  })

  app.get(`${STUDIO_API_PREFIX}/board`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    return json(c, handle.director.board())
  })

  app.get(`${STUDIO_API_PREFIX}/reviews`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const chapterRaw = c.req.query('chapter') ?? '1'
    if (!/^\d+$/u.test(chapterRaw) || Number(chapterRaw) < 1)
      return json(
        c,
        { error: { code: 'CHAPTER_INVALID', message: 'chapter must be a positive integer' } },
        400,
      )
    const chapter = Number(chapterRaw)
    const rows = handle.artifacts.list({ kind: 'ReviewReport', chapter, limit: 12 })
    const reports = []
    for (const row of rows) {
      const artifact = await handle.artifacts.read(row.id)
      if (artifact !== null) reports.push({ id: artifact.id, version: artifact.version, ...artifact.content })
    }
    const latestByRole = new Map<string, string>()
    for (const row of rows) {
      let role: string | undefined
      try {
        role = (JSON.parse(row.provenanceJson) as { role?: string }).role
      } catch {
        role = undefined
      }
      if (role !== undefined && !latestByRole.has(role)) latestByRole.set(role, row.id)
    }
    const continuityRows = handle.artifacts.list({ kind: 'ContinuityReport', chapter, limit: 12 })
    if (continuityRows[0] !== undefined) latestByRole.set('continuity', continuityRows[0].id)
    const findings = [...latestByRole.values()].flatMap((artifactId) =>
      listFindings(handle.db.orm, artifactId).map((finding) => ({
        id: finding.id,
        role: finding.role,
        dimension: finding.dimension,
        severity: finding.severity,
        location: finding.location,
        evidence: finding.evidence,
        problem: finding.problem,
        fix: finding.fix,
        status: finding.status,
        resolution: finding.resolution,
      })),
    )
    const draft = await handle.artifacts.latest('Draft', chapter)
    return json(c, {
      reports,
      findings,
      gates: draft === null ? [] : listGateResults(handle.db.orm, draft.id),
    })
  })

  app.get(`${STUDIO_API_PREFIX}/artifact`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const id = c.req.query('id')
    if (id === undefined || id.length > 64)
      return json(c, { error: { code: 'ARTIFACT_ID_REQUIRED', message: 'a valid id is required' } }, 400)
    const artifact = await handle.artifacts.read(id)
    return artifact === null
      ? json(c, { error: { code: 'ARTIFACT_NOT_FOUND', message: 'artifact not found' } }, 404)
      : json(c, artifact)
  })

  app.get(`${STUDIO_API_PREFIX}/artifacts`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const kindRaw = c.req.query('kind')
    const kind = kindRaw === undefined ? undefined : ArtifactKindSchema.safeParse(kindRaw)
    if (kind !== undefined && !kind.success) {
      return json(
        c,
        { error: { code: 'ARTIFACT_KIND_INVALID', message: `unknown artifact kind ${kindRaw}` } },
        400,
      )
    }
    const chapterRaw = c.req.query('chapter')
    if (chapterRaw !== undefined && (!/^\d+$/u.test(chapterRaw) || Number(chapterRaw) < 1)) {
      return json(
        c,
        { error: { code: 'CHAPTER_INVALID', message: 'chapter must be a positive integer' } },
        400,
      )
    }
    const limitRaw = c.req.query('limit') ?? '100'
    const limit = /^\d+$/u.test(limitRaw) ? Number(limitRaw) : Number.NaN
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return json(c, { error: { code: 'LIMIT_INVALID', message: 'limit must be 1..1000' } }, 400)
    }
    return json(c, {
      rows: listArtifacts(handle.db.orm, handle.project.config.id, {
        ...(kind === undefined || !kind.success ? {} : { kind: kind.data }),
        ...(chapterRaw === undefined ? {} : { chapter: Number(chapterRaw) }),
        limit,
      }),
    })
  })

  app.get(`${STUDIO_API_PREFIX}/diff`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const left = c.req.query('left')
    const right = c.req.query('right')
    if (left === undefined || right === undefined || left.length > 64 || right.length > 64)
      return json(c, { error: { code: 'DIFF_INPUT_REQUIRED', message: 'left and right are required' } }, 400)
    return json(c, { diff: await handle.artifacts.diffContent(left, right) })
  })

  app.get(`${STUDIO_API_PREFIX}/comments`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const chapterRaw = c.req.query('chapter')
    if (chapterRaw !== undefined && (!/^\d+$/u.test(chapterRaw) || Number(chapterRaw) < 1)) {
      return json(
        c,
        { error: { code: 'CHAPTER_INVALID', message: 'chapter must be a positive integer' } },
        400,
      )
    }
    const chapter = chapterRaw === undefined ? undefined : Number(chapterRaw)
    return json(c, { comments: listComments(handle.db.orm, handle.project.config.id, chapter) })
  })

  app.get(`${STUDIO_API_PREFIX}/versions`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const chapterRaw = c.req.query('chapter') ?? '1'
    if (!/^\d+$/u.test(chapterRaw) || Number(chapterRaw) < 1)
      return json(
        c,
        { error: { code: 'CHAPTER_INVALID', message: 'chapter must be a positive integer' } },
        400,
      )
    const chapter = Number(chapterRaw)
    const rows = listArtifacts(handle.db.orm, handle.project.config.id, { chapter, limit: 200 })
    return json(c, {
      versions: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        version: row.version,
        status: row.status,
        createdAt: row.createdAt,
        contentHash: row.contentHash,
        taskId: row.taskId,
      })),
    })
  })

  app.get(`${STUDIO_API_PREFIX}/foreshadows`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    return json(c, { foreshadows: (await loadCanon(handle.project.store)).foreshadows })
  })

  app.get(`${STUDIO_API_PREFIX}/publish`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const projectId = handle.project.config.id
    const exports = []
    for (const row of listArtifacts(handle.db.orm, projectId, { kind: 'Export', limit: 100 })) {
      const stored = await handle.artifacts.read(row.id)
      if (stored !== null) exports.push({ id: stored.id, version: stored.version, ...stored.content })
    }
    const manuscripts = (await handle.project.store.list('manuscript'))
      .filter((name) => /^ch-\d{4}\.md$/u.test(name))
      .map((name) => Number(name.slice(3, 7)))
      .sort((left, right) => left - right)
    const gates = listHumanGates(handle.db.orm, projectId).filter((gate) => gate.gate === 'publish')
    return json(c, {
      exports,
      chapters: manuscripts,
      gates,
      profile: {
        title: handle.project.config.title,
        author: handle.project.config.author,
        platform: handle.project.config.platform,
        genre: handle.project.config.genre,
        audience: handle.project.config.audience,
        export_profile: handle.project.config.export_profile ?? null,
      },
      exportsDir: EXPORTS_DIR,
    })
  })

  app.get(`${STUDIO_API_PREFIX}/import-report`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    return json(c, { text: await handle.project.store.readText('IMPORT_REPORT.md') })
  })

  app.get(`${STUDIO_API_PREFIX}/backups`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const names = (await handle.project.store.list(BACKUP_DIR)).filter((name) => name.endsWith('.db'))
    const rows = []
    for (const name of names) {
      const stat = await handle.project.store.stat(`${BACKUP_DIR}/${name}`)
      rows.push({ name, bytes: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 })
    }
    return json(c, { backups: rows.sort((left, right) => right.mtimeMs - left.mtimeMs) })
  })

  app.get(`${STUDIO_API_PREFIX}/context`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const runId = c.req.query('runId')
    const taskId = c.req.query('taskId')
    if (runId === undefined || taskId === undefined)
      return json(
        c,
        { error: { code: 'CONTEXT_ID_REQUIRED', message: 'runId and taskId are required' } },
        400,
      )
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(runId) || !/^[A-Za-z0-9_-]{1,64}$/u.test(taskId))
      return json(c, { error: { code: 'CONTEXT_ID_INVALID', message: 'invalid runId/taskId' } }, 400)
    const text = await handle.project.store.readText(`runs/${runId}/context/${taskId}.json`)
    if (text === null)
      return json(c, { error: { code: 'CONTEXT_NOT_FOUND', message: 'context not found' } }, 404)
    return json(c, JSON.parse(text) as Record<string, unknown>)
  })

  app.get(`${STUDIO_API_PREFIX}/search`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const query = (c.req.query('q') ?? '').trim()
    if (query.length > 200) {
      return json(c, { error: { code: 'QUERY_TOO_LONG', message: 'query must be <= 200 chars' } }, 400)
    }
    const chapterRaw = c.req.query('chapter')
    if (chapterRaw !== undefined && (!/^\d+$/u.test(chapterRaw) || Number(chapterRaw) < 1)) {
      return json(
        c,
        { error: { code: 'CHAPTER_INVALID', message: 'chapter must be a positive integer' } },
        400,
      )
    }
    const limitRaw = c.req.query('limit') ?? '20'
    const limit = /^\d+$/u.test(limitRaw) ? Number(limitRaw) : Number.NaN
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return json(c, { error: { code: 'LIMIT_INVALID', message: 'limit must be 1..100' } }, 400)
    }
    return json(c, {
      hits: searchMemory(handle.db.orm, {
        projectId: handle.project.config.id,
        query,
        ...(chapterRaw === undefined ? {} : { chapter: Number(chapterRaw) }),
        limit,
      }),
    })
  })

  app.get(`${STUDIO_API_PREFIX}/analytics`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const rows = await chapterRows(handle)
    const runs = listRuns(handle.db.orm, handle.project.config.id, 100)
    return json(c, {
      chapters: rows.map((row) => ({
        chapter: row.chapter,
        words: row.words,
        score: row.score,
        blockers: row.blockers,
      })),
      cost: runs.map((run) => ({
        run: run.id,
        kind: run.kind,
        status: run.status,
        ...usageForRun(handle.db.orm, run.id),
      })),
      totals: {
        chapters: rows.length,
        words: rows.reduce((total, row) => total + Number(row.words ?? 0), 0),
        cost: runs.reduce((total, run) => total + usageForRun(handle.db.orm, run.id).costUsd, 0),
      },
    })
  })

  app.get(`${STUDIO_API_PREFIX}/doctor`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    const integrity = handle.db.integrity()
    const artifacts = listArtifacts(handle.db.orm, handle.project.config.id, { limit: 100_000 })
    const orphaned: string[] = []
    for (const row of artifacts) {
      try {
        if ((await handle.artifacts.read(row.id)) === null) orphaned.push(row.id)
      } catch {
        orphaned.push(row.id)
      }
    }
    return json(c, {
      ok: integrity === 'ok' && orphaned.length === 0,
      integrity,
      artifacts: artifacts.length,
      orphaned,
      gates: listHumanGates(handle.db.orm, handle.project.config.id),
      runs: listRuns(handle.db.orm, handle.project.config.id, 10).length,
    })
  })
  app.get(`${STUDIO_API_PREFIX}/settings`, async (c) => {
    const handle = await runtime.open(c.req.query('root'))
    return json(c, {
      project: handle.project.config,
      taxonomy: {
        majors: handle.project.taxonomy.majors.map((major) => ({
          id: major.id,
          label: major.label,
          subs: major.subs.map((sub) => ({ id: sub.id, label: sub.label, audience: sub.audienceDefault })),
        })),
        tags: handle.project.taxonomy.tags.map((tag) => ({
          id: tag.id,
          label: tag.label,
          facet: tag.facet,
          conflicts: tag.conflicts,
          requires: tag.requires,
        })),
      },
    })
  })

  app.get(`${STUDIO_API_PREFIX}/taxonomy`, (c) => {
    const taxonomy = loadTaxonomy()
    return json(c, {
      version: taxonomy.taxonomyVersion,
      majors: taxonomy.majors,
      tags: taxonomy.tags,
    })
  })

  app.get(`${STUDIO_API_PREFIX}/events`, async (c) => {
    // Hono cannot hand a Node response back to the SSE writer; the route wrapper
    // intercepts this path before app.fetch.
    return json(c, { events: [] })
  })

  app.post(`${STUDIO_API_PREFIX}/mcp`, async (c) => {
    const rpc = (await c.req.json()) as {
      id?: string | number
      method?: string
      params?: Record<string, unknown>
    }
    const reply = (result: unknown): Response => json(c, { jsonrpc: '2.0', id: rpc.id ?? null, result })
    const error = (code: number, message: string): Response =>
      json(c, { jsonrpc: '2.0', id: rpc.id ?? null, error: { code, message } })
    if (rpc.method === 'initialize') {
      return reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-novel-write-engine', version: '0.3.0' },
      })
    }
    if (rpc.method === 'tools/list') {
      return reply({
        tools: [
          {
            name: 'novel_status',
            description: 'Read project status',
            inputSchema: { type: 'object', properties: { project_root: { type: 'string' } } },
          },
          {
            name: 'novel_run',
            description: 'Start/pause/resume/cancel/tick a run (human_approved required for writes)',
            inputSchema: {
              type: 'object',
              properties: {
                action: { type: 'string' },
                kind: { type: 'string' },
                chapter: { type: 'number' },
                run_id: { type: 'string' },
                human_approved: { type: 'boolean' },
              },
            },
          },
          {
            name: 'novel_artifact',
            description: 'List/get/diff artifacts',
            inputSchema: {
              type: 'object',
              properties: {
                action: { type: 'string' },
                id: { type: 'string' },
                left: { type: 'string' },
                right: { type: 'string' },
              },
            },
          },
          {
            name: 'novel_search',
            description: 'FTS5 search',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' }, limit: { type: 'number' } },
            },
          },
          {
            name: 'novel_export',
            description: 'Export a publishable package',
            inputSchema: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                chapter: { type: 'integer' },
                human_approved: { type: 'boolean' },
              },
            },
          },
          {
            name: 'novel_approve',
            description: 'Human gate decision; requires approval_token',
            inputSchema: {
              type: 'object',
              properties: {
                gate_id: { type: 'string' },
                token: { type: 'string' },
                decision: { type: 'string' },
                actor: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
        ],
      })
    }
    if (rpc.method !== 'tools/call') return error(-32601, `unknown method ${String(rpc.method)}`)
    const params = rpc.params ?? {}
    const name = String(params.name ?? '')
    const args = (params.arguments ?? {}) as Record<string, unknown>
    const root = typeof args.project_root === 'string' ? args.project_root : undefined
    const handle = await runtime.open(root)
    const content = (value: unknown) =>
      reply({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
    try {
      if (name === 'novel_status') return content(await handle.director.status())
      if (name === 'novel_artifact') {
        if (args.action === 'get') {
          if (typeof args.id !== 'string') return error(-32602, 'id is required')
          return content(await handle.artifacts.read(args.id))
        }
        if (args.action === 'diff') {
          if (typeof args.left !== 'string' || typeof args.right !== 'string')
            return error(-32602, 'left and right are required')
          return content({ diff: await handle.artifacts.diffContent(args.left, args.right) })
        }
        return content(handle.artifacts.list({ limit: 100 }))
      }
      if (name === 'novel_search') {
        return content(
          searchMemory(handle.db.orm, {
            projectId: handle.project.config.id,
            query: String(args.query ?? ''),
            limit: Number(args.limit ?? 20),
          }),
        )
      }
      if (name === 'novel_run') {
        if (args.human_approved !== true) return error(-32001, 'human_approved is required for write actions')
        const action = String(args.action ?? '')
        if (!['start', 'pause', 'resume', 'cancel', 'tick', 'status'].includes(action)) {
          return error(-32602, `unknown run action ${action}`)
        }
        if (action === 'start') {
          const kind = String(args.kind ?? 'chapter')
          if (!['book', 'chapter', 'review', 'market', 'rewrite'].includes(kind)) {
            return error(-32602, `unknown run kind ${kind}`)
          }
          const chapter = Number(args.chapter ?? 1)
          if (!Number.isInteger(chapter) || chapter < 1) {
            return error(-32602, 'chapter must be a positive integer')
          }
          const runId =
            kind === 'book'
              ? handle.director.createBookRun()
              : kind === 'market'
                ? handle.director.createMarketRun()
                : handle.director.createChapterRun({
                    chapter,
                    mode: kind === 'review' ? 'review' : kind === 'rewrite' ? 'rewrite' : 'full',
                  })
          return content({ runId })
        }
        const runId = String(args.run_id ?? '')
        if (runId === '') return error(-32602, 'run_id is required')
        if (action === 'pause') handle.director.pause(runId)
        else if (action === 'resume') handle.director.resume(runId)
        else if (action === 'cancel') {
          handle.scheduler.abort(runId)
          handle.director.cancel(runId)
        } else if (action === 'tick') {
          const agent = runtime.directorAgent()
          if (agent === undefined) return error(-32002, 'director agent is not configured')
          await handle.scheduler.run(runId, agent, new AbortController().signal)
        }
        return content(handle.director.board())
      }
      if (name === 'novel_export') {
        if (args.human_approved !== true) return error(-32001, 'human_approved is required for export')
        const kind = String(args.kind ?? 'markdown')
        if (!['markdown', 'txt', 'epub', 'outline', 'worldbook', 'proposal', 'publish'].includes(kind)) {
          return error(-32602, `unknown export kind ${kind}`)
        }
        if (kind === 'publish') {
          const files = (await handle.project.store.list('manuscript')).filter((name) =>
            /^ch-\d{4}\.md$/u.test(name),
          )
          await assertExportReady(
            handle.project,
            handle.db,
            handle.artifacts,
            files.map((name) => Number(name.slice(3, 7))),
          )
          const pending = handle.director.gates
            .pending(handle.project.config.id)
            .find((gate) => gate.gate === 'publish')
          const gate =
            pending === undefined
              ? handle.director.gates.open({
                  projectId: handle.project.config.id,
                  runId: 'publish',
                  gate: 'publish',
                })
              : { id: pending.id }
          return content({ ok: true, gateId: gate.id, next: 'host novel_approve gate=publish' })
        }
        return content(
          await exportProject(
            handle.project,
            handle.db,
            handle.artifacts,
            kind as ExportKind,
            args.chapter === undefined ? undefined : [Number(args.chapter)],
          ),
        )
      }
      if (name === 'novel_approve') {
        const gateId = String(args.gate_id ?? '')
        if (typeof args.token !== 'string' || args.token.trim() === '') {
          return error(-32001, 'a one-time approval token issued by the host is required')
        }
        const decision = String(args.decision ?? 'approve')
        if (!['approve', 'reject', 'edit', 'regenerate'].includes(decision)) {
          return error(-32602, `unknown decision ${decision}`)
        }
        const decided = await handle.director.decide({
          gateId,
          token: args.token,
          decision: decision as 'approve' | 'reject' | 'edit' | 'regenerate',
          actor: String(args.actor ?? 'mcp-human'),
          reason: String(args.reason ?? ''),
          ...(typeof args.editedContent === 'string' ? { editedContent: args.editedContent } : {}),
          ...(args.editedArtifact === undefined ? {} : { editedArtifact: args.editedArtifact }),
        })
        return content(decided)
      }
      return error(-32602, `unknown tool ${name}`)
    } catch (caught) {
      return error(-32000, caught instanceof Error ? caught.message : String(caught))
    }
  })

  app.post(`${STUDIO_API_PREFIX}/action`, async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>
    const root = typeof body.root === 'string' ? body.root : undefined
    const action = String(body.action ?? '')
    if (action === 'project.init') {
      const genre = body.genre as { major: string; sub: string; tags: string[] } | undefined
      if (genre === undefined)
        return json(c, { ok: false, error: { code: 'INIT_INVALID', message: 'genre is required' } }, 400)
      const title = String(body.title ?? '').trim()
      if (title === '' || Array.from(title).length > 100) {
        return json(
          c,
          { ok: false, error: { code: 'INIT_INVALID', message: 'title must be 1..100 chars' } },
          400,
        )
      }
      const audience = String(body.audience ?? 'general')
      if (!['male', 'female', 'general', 'teen', 'adult'].includes(audience)) {
        return json(c, { ok: false, error: { code: 'INIT_INVALID', message: 'invalid audience' } }, 400)
      }
      const platform = String(body.platform ?? 'fanqie')
      if (!['fanqie', 'qidian', 'qimao', 'jinjiang'].includes(platform)) {
        return json(c, { ok: false, error: { code: 'INIT_INVALID', message: 'invalid platform' } }, 400)
      }
      const totalChapters = Number(body.total_chapters ?? 120)
      if (!Number.isInteger(totalChapters) || totalChapters < 1) {
        return json(
          c,
          {
            ok: false,
            error: { code: 'INIT_INVALID', message: 'total_chapters must be a positive integer' },
          },
          400,
        )
      }
      try {
        const initialized = await runtime.init({
          root,
          title,
          author: String(body.author ?? ''),
          genre,
          audience: audience as 'male' | 'female' | 'general' | 'teen' | 'adult',
          platform: platform as 'fanqie' | 'qidian' | 'qimao' | 'jinjiang',
          premise: typeof body.premise === 'string' ? body.premise : undefined,
          targets: { total_chapters: totalChapters },
        })
        return json(c, { ok: true, project: initialized.project.config })
      } catch (error) {
        if (error instanceof StudioError)
          return json(
            c,
            { ok: false, error: { code: error.code, message: error.message, hint: error.hint } },
            400,
          )
        if (typeof error === 'object' && error !== null && 'issues' in error) {
          return json(
            c,
            {
              ok: false,
              error: {
                code: 'INIT_INVALID',
                message: 'project config failed validation',
                details: { issues: (error as { issues: unknown }).issues },
              },
            },
            400,
          )
        }
        return json(
          c,
          {
            ok: false,
            error: { code: 'INIT_FAILED', message: error instanceof Error ? error.message : String(error) },
          },
          500,
        )
      }
    }
    const handle = await runtime.open(root)
    try {
      if (action === 'run.start') {
        const kind = String(body.kind ?? 'chapter')
        if (!['book', 'chapter', 'review', 'market', 'rewrite'].includes(kind)) {
          return json(
            c,
            { ok: false, error: { code: 'RUN_KIND_INVALID', message: `unknown run kind ${kind}` } },
            400,
          )
        }
        const chapter = Number(body.chapter ?? 1)
        if (!Number.isInteger(chapter) || chapter < 1) {
          return json(
            c,
            { ok: false, error: { code: 'CHAPTER_INVALID', message: 'chapter must be a positive integer' } },
            400,
          )
        }
        const runId =
          kind === 'book'
            ? handle.director.createBookRun()
            : kind === 'market'
              ? handle.director.createMarketRun()
              : handle.director.createChapterRun({
                  chapter,
                  mode: kind === 'review' ? 'review' : kind === 'rewrite' ? 'rewrite' : 'full',
                })
        return json(c, { ok: true, runId })
      }
      if (action === 'run.tick') {
        const runId = String(body.runId ?? '')
        if (runId === '') {
          return json(c, { ok: false, error: { code: 'RUN_NOT_FOUND', message: 'runId is required' } }, 400)
        }
        const agent = runtime.directorAgent()
        if (agent === undefined) {
          return json(
            c,
            {
              ok: false,
              error: {
                code: 'DIRECTOR_AGENT_REQUIRED',
                message:
                  'run.tick requires a persistent director session agent; set directorSessionId or call novel_run from chat',
              },
            },
            409,
          )
        }
        await handle.scheduler.run(runId, agent, new AbortController().signal)
        return json(c, { ok: true, board: handle.director.board() })
      }
      if (action === 'run.pause' || action === 'run.resume' || action === 'run.cancel') {
        const runId = String(body.runId ?? '')
        if (runId === '') {
          return json(c, { ok: false, error: { code: 'RUN_NOT_FOUND', message: 'runId is required' } }, 400)
        }
        if (action === 'run.pause') handle.director.pause(runId)
        else if (action === 'run.resume') handle.director.resume(runId)
        else {
          handle.scheduler.abort(runId)
          handle.director.cancel(runId)
        }
        return json(c, { ok: true })
      }
      if (action === 'human.approve') {
        const gateId = String(body.gateId ?? '')
        const decision = String(body.decision ?? 'approve')
        if (!['approve', 'reject', 'edit', 'regenerate'].includes(decision)) {
          return json(
            c,
            { ok: false, error: { code: 'DECISION_INVALID', message: `unknown decision ${decision}` } },
            400,
          )
        }
        const gate = handle.director.gates.pending(handle.project.config.id).find((row) => row.id === gateId)
        if (gate === undefined) {
          return json(
            c,
            { ok: false, error: { code: 'HUMAN_GATE_REQUIRED', message: `no open gate ${gateId}` } },
            400,
          )
        }
        const token = typeof body.token === 'string' ? body.token : handle.director.gates.authorize(gateId)
        const decided = await handle.director.decide({
          gateId,
          token,
          decision: decision as 'approve' | 'reject' | 'edit' | 'regenerate',
          actor: String(body.actor ?? 'author'),
          reason: String(body.reason ?? ''),
          ...(typeof body.editedContent === 'string' ? { editedContent: body.editedContent } : {}),
          ...(body.editedArtifact === undefined ? {} : { editedArtifact: body.editedArtifact }),
        })
        // Approval resumes the run in the same host turn; a chapter edit
        // branches a review run instead. Both must be advanced here or the
        // workbench dead-ends until a second manual "tick".
        const runToAdvance =
          decided.nextRunId ??
          ((decision === 'approve' || decision === 'edit') && gate.gate !== 'publish'
            ? gate.runId
            : undefined)
        if (runToAdvance !== undefined) {
          const agent = runtime.directorAgent()
          if (agent !== undefined) {
            await handle.scheduler.run(runToAdvance, agent, new AbortController().signal)
          }
        }
        return json(c, { ok: true, ...decided })
      }
      if (action === 'chapter.save') {
        const chapter = Number(body.chapter ?? 1)
        if (!Number.isInteger(chapter) || chapter < 1) {
          return json(
            c,
            { ok: false, error: { code: 'CHAPTER_INVALID', message: 'chapter must be a positive integer' } },
            400,
          )
        }
        const content = String(body.content ?? '')
        if (content.trim() === '') {
          return json(
            c,
            { ok: false, error: { code: 'DRAFT_EMPTY', message: 'draft content must not be empty' } },
            400,
          )
        }
        const plan = (await listChapterPlans(handle.project.store)).find((row) => row.chapter === chapter)
        const current = await handle.artifacts.latest('Draft', chapter)
        const { buildHumanDraft } = await import('../../kernel/book/draft.js')
        const draft: Draft = buildHumanDraft({
          existing: (current?.content as Draft | undefined) ?? null,
          chapter,
          title: current === null ? (plan?.title ?? '') : (current.content as Draft).title,
          content,
          ...(plan === undefined ? {} : { plan }),
          baseArtifactId: current?.id ?? null,
          baseHash: current?.contentHash ?? null,
        })
        const { evaluateDraftFormat } = await import('../../kernel/gates/index.js')
        const formatBlockers = evaluateDraftFormat(handle.project, chapter, draft.title, content)
        if (formatBlockers.length > 0) {
          return json(
            c,
            {
              ok: false,
              error: {
                code: 'FORMAT_BLOCKED',
                message: 'human edit failed the deterministic format gate',
                hint: 'fix Markdown/quotes/ellipsis/paragraph length before saving',
                details: formatBlockers,
              },
            },
            422,
          )
        }
        const artifact = await handle.artifacts.saveHumanEdit({
          kind: 'Draft',
          chapter,
          content: draft,
          baseHash: typeof body.baseHash === 'string' ? body.baseHash : null,
          actor: String(body.actor ?? 'author'),
        })
        return json(c, {
          ok: true,
          artifact: { id: artifact.id, version: artifact.version, hash: artifact.contentHash },
        })
      }
      if (action === 'memory.reindex' || action === 'memory.rebuild') {
        const { rebuildProjectIndex } = await import('../../kernel/read/index.js')
        return json(c, { ok: true, ...(await rebuildProjectIndex(handle.project, handle.db)) })
      }
      if (action === 'export.run') {
        const kind = String(body.kind ?? 'markdown')
        if (!['markdown', 'txt', 'epub', 'outline', 'worldbook', 'proposal', 'publish'].includes(kind)) {
          return json(
            c,
            { ok: false, error: { code: 'EXPORT_KIND_INVALID', message: `unknown export kind ${kind}` } },
            400,
          )
        }
        if (kind === 'publish') {
          const files = (await handle.project.store.list('manuscript')).filter((name) =>
            /^ch-\d{4}\.md$/u.test(name),
          )
          await assertExportReady(
            handle.project,
            handle.db,
            handle.artifacts,
            files.map((name) => Number(name.slice(3, 7))),
          )
          const pending = handle.director.gates
            .pending(handle.project.config.id)
            .find((gate) => gate.gate === 'publish')
          const gate =
            pending === undefined
              ? handle.director.gates.open({
                  projectId: handle.project.config.id,
                  runId: 'publish',
                  gate: 'publish',
                })
              : { id: pending.id }
          return json(c, { ok: true, gateId: gate.id, next: 'host novel_approve gate=publish' })
        }
        let onlyChapters: number[] | undefined
        if (body.chapter !== undefined) {
          const chapter = Number(body.chapter)
          if (!Number.isInteger(chapter) || chapter < 1) {
            return json(
              c,
              {
                ok: false,
                error: { code: 'CHAPTER_INVALID', message: 'chapter must be a positive integer' },
              },
              400,
            )
          }
          onlyChapters = [chapter]
        }
        return json(c, {
          ok: true,
          result: await exportProject(
            handle.project,
            handle.db,
            handle.artifacts,
            kind as ExportKind,
            onlyChapters,
          ),
        })
      }
      if (action === 'settings.save') {
        const patch: Record<string, unknown> = {}
        // Partial model/budget edits merge with the current config; replacing
        // them would force the UI to resend all twelve role routes.
        if (body.models !== undefined && typeof body.models === 'object' && body.models !== null) {
          patch.models = { ...handle.project.config.models, ...body.models }
        }
        if (body.budgets !== undefined && typeof body.budgets === 'object' && body.budgets !== null) {
          patch.budgets = { ...handle.project.config.budgets, ...body.budgets }
        }
        if (body.targets !== undefined) patch.targets = body.targets
        if (body.quality !== undefined) patch.quality = body.quality
        if (body.export_profile !== undefined) patch.export_profile = body.export_profile
        const config = await saveProjectConfig(handle.project, patch as never)
        handle.project.config = config
        return json(c, { ok: true, project: config })
      }
      if (action === 'outline.move') {
        const from = Number(body.from ?? 0)
        const to = Number(body.to ?? 0)
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from === to) {
          return json(
            c,
            {
              ok: false,
              error: { code: 'CHAPTER_INVALID', message: 'from/to must be distinct positive integers' },
            },
            400,
          )
        }
        const { moveChapterPlan } = await import('../../kernel/book/store.js')
        const chapters = await moveChapterPlan(handle.project.store, from, to)
        return json(c, { ok: true, chapters })
      }
      if (action === 'foreshadow.status') {
        const status = String(body.status ?? 'open')
        if (!['open', 'advanced', 'resolved'].includes(status)) {
          return json(
            c,
            { ok: false, error: { code: 'FORESHADOW_STATUS_INVALID', message: 'invalid foreshadow status' } },
            400,
          )
        }
        const { setForeshadowStatus } = await import('../../kernel/book/store.js')
        const canon = await setForeshadowStatus(
          handle.project.store,
          String(body.key ?? ''),
          status as 'open' | 'advanced' | 'resolved',
          typeof body.anchor === 'string' ? body.anchor : undefined,
        )
        return json(c, { ok: true, foreshadows: canon.foreshadows })
      }
      if (action === 'revision.request') {
        const chapter = Number(body.chapter ?? 1)
        if (!Number.isInteger(chapter) || chapter < 1) {
          return json(
            c,
            { ok: false, error: { code: 'CHAPTER_INVALID', message: 'chapter must be a positive integer' } },
            400,
          )
        }
        const pendingChapterGate = handle.director.gates
          .pending(handle.project.config.id)
          .find((gate) => gate.gate === 'chapter' && gate.chapter === chapter)
        if (pendingChapterGate !== undefined) {
          const token = handle.director.gates.authorize(pendingChapterGate.id)
          await handle.director.decide({
            gateId: pendingChapterGate.id,
            token,
            decision: 'regenerate',
            actor: String(body.actor ?? 'author'),
            reason: String(body.reason ?? '转修订'),
          })
        }
        const runId = handle.director.createChapterRun({ chapter, mode: 'rewrite' })
        return json(c, { ok: true, runId })
      }
      if (action === 'artifact.restore') {
        const id = String(body.id ?? '')
        if (id === '') {
          return json(c, { ok: false, error: { code: 'ARTIFACT_NOT_FOUND', message: 'id is required' } }, 400)
        }
        const artifact = await handle.artifacts.restore(
          id,
          String(body.actor ?? 'author'),
          String(body.reason ?? ''),
        )
        return json(c, { ok: true, artifact: { id: artifact.id, version: artifact.version } })
      }
      if (action === 'comment.create') {
        const { insertComment } = await import('../../storage/repositories/artifacts.js')
        const commentBody = String(body.body ?? '').trim()
        const chapter = Number(body.chapter ?? 1)
        const paragraph =
          body.paragraph === undefined || body.paragraph === null ? null : Number(body.paragraph)
        if (!Number.isInteger(chapter) || chapter < 1) {
          return json(
            c,
            { ok: false, error: { code: 'CHAPTER_INVALID', message: 'chapter must be a positive integer' } },
            400,
          )
        }
        if (paragraph !== null && (!Number.isInteger(paragraph) || paragraph < 1)) {
          return json(
            c,
            {
              ok: false,
              error: { code: 'PARAGRAPH_INVALID', message: 'paragraph must be a positive integer' },
            },
            400,
          )
        }
        if (commentBody === '' || Array.from(commentBody).length > 5_000) {
          return json(
            c,
            { ok: false, error: { code: 'COMMENT_INVALID', message: 'comment body must be 1..5000 chars' } },
            400,
          )
        }
        return json(c, {
          ok: true,
          id: insertComment(handle.db.orm, {
            projectId: handle.project.config.id,
            chapter,
            paragraph,
            author: String(body.actor ?? 'author'),
            body: commentBody,
          }),
        })
      }
      if (action === 'comment.resolve') {
        const status = String(body.status ?? 'resolved')
        if (status !== 'open' && status !== 'resolved') {
          return json(
            c,
            { ok: false, error: { code: 'COMMENT_STATUS_INVALID', message: 'invalid status' } },
            400,
          )
        }
        const { resolveComment } = await import('../../storage/repositories/artifacts.js')
        return json(c, {
          ok: resolveComment(handle.db.orm, String(body.id ?? ''), status),
        })
      }
      if (action === 'finding.resolve') {
        const status = String(body.status ?? 'fixed') as 'fixed' | 'waived'
        if (status !== 'fixed' && status !== 'waived') {
          return json(c, { ok: false, error: { code: 'ACTION_INVALID', message: 'invalid status' } }, 400)
        }
        const { getFinding, resolveFinding } = await import('../../storage/repositories/artifacts.js')
        const finding = getFinding(handle.db.orm, String(body.id ?? ''))
        if (finding === undefined) {
          return json(
            c,
            { ok: false, error: { code: 'FINDING_NOT_FOUND', message: 'finding not found' } },
            404,
          )
        }
        if (status === 'waived' && finding.severity === 'blocker') {
          return json(
            c,
            {
              ok: false,
              error: { code: 'FINDING_WAIVE_FORBIDDEN', message: 'blockers must be fixed, not waived' },
            },
            400,
          )
        }
        let resolution: string | null = null
        if (status === 'fixed' && finding.severity === 'blocker') {
          resolution = String(body.resolution ?? '').trim()
          if (Array.from(resolution).length < 8) {
            return json(
              c,
              {
                ok: false,
                error: {
                  code: 'FINDING_EVIDENCE_REQUIRED',
                  message: 'fixing a blocker requires the current draft sentence that closes it',
                },
              },
              400,
            )
          }
          const { getArtifact } = await import('../../storage/repositories/artifacts.js')
          const reviewArtifact = getArtifact(handle.db.orm, finding.artifactId)
          const chapter = reviewArtifact?.chapter ?? 1
          const draft = await handle.artifacts.latest('Draft', chapter)
          const content = draft === null ? '' : String((draft.content as Draft).content)
          const normalize = (value: string): string => value.replace(/\s+/gu, '')
          if (!normalize(content).includes(normalize(resolution))) {
            return json(
              c,
              {
                ok: false,
                error: {
                  code: 'FINDING_EVIDENCE_NOT_FOUND',
                  message: 'resolution evidence is not present in the current draft',
                },
              },
              400,
            )
          }
        }
        return json(c, { ok: resolveFinding(handle.db.orm, finding.id, status, resolution) })
      }
      if (action === 'finding.bulk') {
        const { getFinding, resolveFinding } = await import('../../storage/repositories/artifacts.js')
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
        const status = String(body.status ?? 'fixed') as 'fixed' | 'waived'
        if (status === 'waived') {
          return json(
            c,
            {
              ok: false,
              error: { code: 'FINDING_WAIVE_FORBIDDEN', message: 'bulk waive is not allowed' },
            },
            400,
          )
        }
        let changed = 0
        for (const id of ids) {
          const finding = getFinding(handle.db.orm, id)
          if (finding === undefined || finding.severity === 'blocker') continue
          if (resolveFinding(handle.db.orm, id, status)) changed += 1
        }
        return json(c, { ok: true, changed, skippedBlockers: ids.length - changed })
      }
      if (action === 'backup.create') {
        await handle.project.store.ensureDir(BACKUP_DIR)
        const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
        const name = `studio-${stamp}-${Math.random().toString(36).slice(2, 8)}.db`
        handle.db.checkpoint()
        handle.db.backupTo(handle.project.store.path(`${BACKUP_DIR}/${name}`))
        const snapshot = await createSnapshot(handle.project)
        return json(c, { ok: true, name, snapshot: snapshot.path })
      }
      if (action === 'snapshot.create') {
        const snapshot = await createSnapshot(handle.project)
        return json(c, { ok: true, path: snapshot.path, manifest: snapshot.manifest })
      }
      if (action === 'snapshot.verify') {
        const path = String(body.path ?? '')
        if (path === '' || !path.startsWith('.studio/snapshots/')) {
          return json(
            c,
            { ok: false, error: { code: 'SNAPSHOT_INVALID', message: 'path must be a snapshot manifest' } },
            400,
          )
        }
        return json(c, await verifySnapshot(handle.project, path))
      }
      if (action === 'rewind') {
        const target = String(body.target ?? '')
        if (!['artifact', 'chapter', 'run'].includes(target)) {
          return json(
            c,
            {
              ok: false,
              error: { code: 'REWIND_TARGET_INVALID', message: 'target must be artifact/chapter/run' },
            },
            400,
          )
        }
        const chapter = body.chapter === undefined ? undefined : Number(body.chapter)
        if (chapter !== undefined && (!Number.isInteger(chapter) || chapter < 1)) {
          return json(
            c,
            { ok: false, error: { code: 'CHAPTER_INVALID', message: 'chapter must be a positive integer' } },
            400,
          )
        }
        return json(
          c,
          await handle.director.rewind({
            target: target as 'artifact' | 'chapter' | 'run',
            ...(typeof body.artifactId === 'string' ? { artifactId: body.artifactId } : {}),
            ...(chapter === undefined ? {} : { chapter }),
            ...(typeof body.runId === 'string' ? { runId: body.runId } : {}),
            actor: String(body.actor ?? 'author'),
            reason: String(body.reason ?? 'rewind'),
          }),
        )
      }
      if (action === 'backup.restore') {
        return json(c, {
          ok: true,
          ...(await runtime.restoreBackup(handle.project.root, String(body.name ?? ''))),
        })
      }
      return json(
        c,
        { ok: false, error: { code: 'ACTION_UNKNOWN', message: `unknown action ${action}` } },
        400,
      )
    } catch (error) {
      if (error instanceof StudioError)
        return json(
          c,
          { ok: false, error: { code: error.code, message: error.message, hint: error.hint } },
          400,
        )
      if (typeof error === 'object' && error !== null && 'issues' in error) {
        return json(
          c,
          {
            ok: false,
            error: {
              code: 'ACTION_INVALID',
              message: 'request failed schema validation',
              details: { issues: (error as { issues: unknown }).issues },
            },
          },
          400,
        )
      }
      return json(
        c,
        {
          ok: false,
          error: { code: 'ACTION_FAILED', message: error instanceof Error ? error.message : String(error) },
        },
        500,
      )
    }
  })

  return app
}

/** Route descriptor for the 0.3.0 workbench API. */
export function studioRoute(runtime: StudioRuntime, guard: PanelGuard = () => undefined) {
  const app = createStudioApi(runtime)
  return {
    kind: 'prefix' as const,
    path: STUDIO_API_PREFIX,
    handler: async (request: RequestLike, response: ResponseLike): Promise<void> => {
      const rejection = guard(request)
      if (rejection !== undefined) {
        response.statusCode = rejection
        response.setHeader('content-type', 'text/plain; charset=utf-8')
        response.end('denied')
        return
      }
      const url = new URL(request.url ?? '/', 'http://studio.local')
      if (url.pathname === `${STUDIO_API_PREFIX}/events`) {
        try {
          await runEvents(request, response, runtime)
        } catch (error) {
          response.statusCode = 500
          response.setHeader('content-type', 'application/json; charset=utf-8')
          response.end(
            JSON.stringify({
              ok: false,
              error: {
                code: 'SSE_FAILED',
                message: error instanceof Error ? error.message : String(error),
              },
            }),
          )
        }
        return
      }
      try {
        const webRequest = await toWebRequest(request)
        const webResponse = await app.fetch(webRequest)
        await writeWebResponse(webResponse, response)
      } catch (error) {
        response.statusCode = 500
        response.setHeader('content-type', 'application/json; charset=utf-8')
        response.end(
          JSON.stringify({
            ok: false,
            error: {
              code: 'API_FAILED',
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        )
      }
    },
  }
}

export type { Agent }
