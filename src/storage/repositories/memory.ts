import { and, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { StudioOrm } from '../db.js'
import { memoryChunk, memorySearch } from '../schema.js'

export interface MemoryInput {
  projectId: string
  kind: string
  chapter?: number | null
  sourcePath: string
  sourceHash: string
  text: string
  meta?: Record<string, unknown>
}

export interface MemoryHit {
  id: string
  kind: string
  chapter: number | null
  sourcePath: string
  sourceHash: string
  text: string
  score: number
  reasons: string[]
  meta: Record<string, unknown>
}

const ftsQuery = (query: string): string =>
  spacedForFts(query)
    .trim()
    .split(/\s+/u)
    .filter((token) => token !== '')
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' AND ')

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

/**
 * SQLite's unicode61 tokenizer treats a whole CJK run as one token. The
 * indexing shadow separates CJK characters so a two-character name remains
 * searchable; the original text is never altered for display.
 */
export function spacedForFts(text: string): string {
  let out = ''
  let previousWasCjk = false
  for (const char of text) {
    const isCjk = CJK.test(char)
    if (isCjk) {
      if (out !== '' && !out.endsWith(' ')) out += ' '
      out += char
      out += ' '
      previousWasCjk = true
      continue
    }
    if (previousWasCjk && /\S/u.test(char)) out += char
    else out += char
    previousWasCjk = false
  }
  return out.replace(/\s+/gu, ' ').trim()
}

export function upsertMemoryChunk(orm: StudioOrm, input: MemoryInput): string {
  const existing = orm
    .select()
    .from(memoryChunk)
    .where(
      and(
        eq(memoryChunk.projectId, input.projectId),
        eq(memoryChunk.sourcePath, input.sourcePath),
        eq(memoryChunk.sourceHash, input.sourceHash),
      ),
    )
    .get()
  if (existing !== undefined) return existing.id
  const id = ulid()
  orm.transaction((tx) => {
    tx.insert(memoryChunk)
      .values({
        id,
        projectId: input.projectId,
        kind: input.kind,
        chapter: input.chapter ?? null,
        sourcePath: input.sourcePath,
        sourceHash: input.sourceHash,
        text: input.text,
        metaJson: JSON.stringify(input.meta ?? {}),
      })
      .run()
    tx.insert(memorySearch)
      .values({ id, text: spacedForFts(input.text) })
      .run()
  })
  return id
}

export function deleteMemoryBySource(orm: StudioOrm, projectId: string, sourcePath: string): number {
  return orm.transaction((tx) => {
    const rows = tx
      .select({ id: memoryChunk.id })
      .from(memoryChunk)
      .where(and(eq(memoryChunk.projectId, projectId), eq(memoryChunk.sourcePath, sourcePath)))
      .all()
    for (const row of rows) tx.delete(memorySearch).where(eq(memorySearch.id, row.id)).run()
    const result = tx
      .delete(memoryChunk)
      .where(and(eq(memoryChunk.projectId, projectId), eq(memoryChunk.sourcePath, sourcePath)))
      .run()
    return result.changes
  })
}

export function memoryCount(orm: StudioOrm, projectId: string): number {
  const row = orm
    .select({ value: sql<number>`COUNT(*)` })
    .from(memoryChunk)
    .where(eq(memoryChunk.projectId, projectId))
    .get()
  return row?.value ?? 0
}

/**
 * FTS5 search with deterministic post-ranking. `bm25` is negative (lower is
 * better), so the raw score is negated. Entity/chapter boosts are additive.
 */
export function searchMemory(
  orm: StudioOrm,
  input: {
    projectId: string
    query: string
    scope?: string[]
    chapter?: number
    limit?: number
    activeCast?: string[]
  },
): MemoryHit[] {
  const query = ftsQuery(input.query)
  if (query === '') return []
  const limit = Math.max(1, Math.min(100, input.limit ?? 20))
  const rows = orm.all<{
    id: string
    kind: string
    chapter: number | null
    source_path: string
    source_hash: string
    text: string
    meta_json: string
    rank: number
  }>(sql`
    SELECT mc.id, mc.kind, mc.chapter, mc.source_path, mc.source_hash, mc.text, mc.meta_json,
           bm25(memory_fts) AS rank
    FROM memory_fts
    JOIN memory_search ms ON ms.rowid = memory_fts.rowid
    JOIN memory_chunk mc ON mc.id = ms.id
    WHERE memory_fts MATCH ${query} AND mc.project_id = ${input.projectId}
    ORDER BY rank
    LIMIT ${limit * 4}
  `)
  const activeCast = new Set((input.activeCast ?? []).map((name) => name.toLowerCase()))
  const scope = input.scope === undefined ? null : new Set(input.scope)
  const hits: MemoryHit[] = []
  for (const row of rows) {
    if (scope !== null && !scope.has(row.kind)) continue
    const meta = JSON.parse(row.meta_json) as Record<string, unknown>
    const reasons: string[] = [`bm25:${(-row.rank).toFixed(3)}`]
    let score = -row.rank
    const entities = Array.isArray(meta.entities)
      ? meta.entities.filter((item): item is string => typeof item === 'string')
      : []
    if (entities.some((entity) => activeCast.has(entity.toLowerCase()))) {
      score += 3
      reasons.push('active-cast')
    }
    if (input.chapter !== undefined && row.chapter !== null && row.chapter < input.chapter) {
      score += 1 / Math.max(1, input.chapter - row.chapter)
      reasons.push(`recency:${input.chapter - row.chapter}`)
    }
    if (row.kind === 'canon' || row.kind === 'bible') {
      score += 1.5
      reasons.push('protected-source')
    }
    hits.push({
      id: row.id,
      kind: row.kind,
      chapter: row.chapter,
      sourcePath: row.source_path,
      sourceHash: row.source_hash,
      text: row.text,
      score,
      reasons,
      meta,
    })
  }
  hits.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  return hits.slice(0, limit)
}

/** Delete every memory row for one project; used by a full rebuild. */
export function clearMemory(orm: StudioOrm, projectId: string): number {
  return orm.transaction((tx) => {
    const rows = tx
      .select({ id: memoryChunk.id })
      .from(memoryChunk)
      .where(eq(memoryChunk.projectId, projectId))
      .all()
    for (const row of rows) tx.delete(memorySearch).where(eq(memorySearch.id, row.id)).run()
    return tx.delete(memoryChunk).where(eq(memoryChunk.projectId, projectId)).run().changes
  })
}

export function listMemory(
  orm: StudioOrm,
  projectId: string,
  kind?: string,
): Array<typeof memoryChunk.$inferSelect> {
  return orm
    .select()
    .from(memoryChunk)
    .where(
      kind === undefined
        ? eq(memoryChunk.projectId, projectId)
        : and(eq(memoryChunk.projectId, projectId), eq(memoryChunk.kind, kind)),
    )
    .all()
}

/** Bulk import for legacy chapters; each source path is de-duplicated by hash. */
export function importMemoryChunks(
  orm: StudioOrm,
  projectId: string,
  rows: ReadonlyArray<{
    sourcePath: string
    text: string
    chapter?: number | null
    kind?: string
    sourceHash?: string
    meta?: Record<string, unknown>
  }>,
): number {
  let imported = 0
  for (const row of rows) {
    const id = upsertMemoryChunk(orm, {
      projectId,
      kind: row.kind ?? 'chapter',
      chapter: row.chapter ?? null,
      sourcePath: row.sourcePath,
      sourceHash: row.sourceHash ?? `legacy:${row.text.length}:${row.text.slice(0, 12)}`,
      text: row.text,
      meta: row.meta ?? {},
    })
    if (id !== '') imported += 1
  }
  return imported
}

/** Rebuild FTS after bulk deletes/updates. */
export function rebuildFts(orm: StudioOrm): void {
  orm.run(sql`INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')`)
}
