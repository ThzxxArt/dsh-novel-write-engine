import { and, desc, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { StudioOrm } from '../db.js'
import { artifact, comment, gateResult, reviewFinding } from '../schema.js'
import type { ArtifactKind, ArtifactStatus, RoleId } from '../../contracts/artifacts.js'

export type ArtifactRow = typeof artifact.$inferSelect

export function nextArtifactVersion(
  orm: StudioOrm,
  projectId: string,
  kind: ArtifactKind,
  chapter: number | null,
): number {
  const row = orm
    .select({ value: sql<number>`COALESCE(MAX(${artifact.version}), 0)` })
    .from(artifact)
    .where(
      and(
        eq(artifact.projectId, projectId),
        eq(artifact.kind, kind),
        chapter === null ? sql`${artifact.chapter} IS NULL` : eq(artifact.chapter, chapter),
      ),
    )
    .get()
  return (row?.value ?? 0) + 1
}

export interface InsertArtifactInput {
  id?: string
  projectId: string
  kind: ArtifactKind
  chapter: number | null
  status?: ArtifactStatus
  path: string
  contentHash: string
  schemaVersion: number
  baseArtifactId?: string | null
  provenance: {
    runId: string
    taskId: string
    role: RoleId
    preset: string
    agentSessionId: string
    model: string
    promptHash: string
    createdAt: string
  }
}

export function insertArtifact(orm: StudioOrm, input: InsertArtifactInput): { id: string; version: number } {
  return orm.transaction((tx) => {
    const version = nextArtifactVersion(
      tx as unknown as StudioOrm,
      input.projectId,
      input.kind,
      input.chapter,
    )
    const id = input.id ?? ulid()
    tx.insert(artifact)
      .values({
        id,
        projectId: input.projectId,
        kind: input.kind,
        chapter: input.chapter,
        version,
        status: input.status ?? 'draft',
        path: input.path,
        contentHash: input.contentHash,
        schemaVersion: input.schemaVersion,
        baseArtifactId: input.baseArtifactId ?? null,
        taskId: input.provenance.taskId,
        provenanceJson: JSON.stringify(input.provenance),
        createdAt: input.provenance.createdAt,
      })
      .run()
    return { id, version }
  })
}

export function findArtifactByTask(orm: StudioOrm, taskId: string): ArtifactRow | undefined {
  return orm.select().from(artifact).where(eq(artifact.taskId, taskId)).get()
}

export function getArtifact(orm: StudioOrm, id: string): ArtifactRow | undefined {
  return orm.select().from(artifact).where(eq(artifact.id, id)).get()
}

export function listArtifacts(
  orm: StudioOrm,
  projectId: string,
  filter: { kind?: ArtifactKind; chapter?: number | null; limit?: number } = {},
): ArtifactRow[] {
  const conditions = [eq(artifact.projectId, projectId)]
  if (filter.kind !== undefined) conditions.push(eq(artifact.kind, filter.kind))
  if (filter.chapter !== undefined) {
    conditions.push(
      filter.chapter === null ? sql`${artifact.chapter} IS NULL` : eq(artifact.chapter, filter.chapter),
    )
  }
  return orm
    .select()
    .from(artifact)
    .where(and(...conditions))
    .orderBy(desc(artifact.createdAt))
    .limit(filter.limit ?? 200)
    .all()
}

export function latestArtifact(
  orm: StudioOrm,
  projectId: string,
  kind: ArtifactKind,
  chapter: number | null,
): ArtifactRow | undefined {
  return orm
    .select()
    .from(artifact)
    .where(
      and(
        eq(artifact.projectId, projectId),
        eq(artifact.kind, kind),
        chapter === null ? sql`${artifact.chapter} IS NULL` : eq(artifact.chapter, chapter),
      ),
    )
    .orderBy(desc(artifact.version))
    .limit(1)
    .get()
}

export function latestApproved(
  orm: StudioOrm,
  projectId: string,
  kind: ArtifactKind,
  chapter: number | null,
): ArtifactRow | undefined {
  return orm
    .select()
    .from(artifact)
    .where(
      and(
        eq(artifact.projectId, projectId),
        eq(artifact.kind, kind),
        eq(artifact.status, 'approved'),
        chapter === null ? sql`${artifact.chapter} IS NULL` : eq(artifact.chapter, chapter),
      ),
    )
    .orderBy(desc(artifact.version))
    .limit(1)
    .get()
}

export function setArtifactStatus(orm: StudioOrm, id: string, status: ArtifactStatus): void {
  orm.update(artifact).set({ status }).where(eq(artifact.id, id)).run()
}

/** Mark every older version of the same slot superseded; history remains. */
export function supersedeOlder(orm: StudioOrm, keepId: string): number {
  const keep = getArtifact(orm, keepId)
  if (keep === undefined) return 0
  const result = orm
    .update(artifact)
    .set({ status: 'superseded' })
    .where(
      and(
        eq(artifact.projectId, keep.projectId),
        eq(artifact.kind, keep.kind),
        keep.chapter === null ? sql`${artifact.chapter} IS NULL` : eq(artifact.chapter, keep.chapter),
        sql`${artifact.version} < ${keep.version}`,
        sql`${artifact.status} <> 'superseded'`,
      ),
    )
    .run()
  return result.changes
}

export interface NewGateResult {
  artifactId: string
  gate: string
  verdict: 'pass' | 'fail' | 'advisory'
  details: Record<string, unknown>
}

export function insertGateResult(orm: StudioOrm, input: NewGateResult): void {
  orm
    .insert(gateResult)
    .values({
      id: ulid(),
      artifactId: input.artifactId,
      gate: input.gate,
      verdict: input.verdict,
      detailsJson: JSON.stringify(input.details),
      at: new Date().toISOString(),
    })
    .run()
}

export function listGateResults(orm: StudioOrm, artifactId: string): Array<typeof gateResult.$inferSelect> {
  return orm.select().from(gateResult).where(eq(gateResult.artifactId, artifactId)).all()
}

/**
 * Gate results are append-only audit rows. A re-evaluation appends a new set,
 * so consumers must read the latest verdict per gate instead of treating an
 * old failure as permanently blocking.
 */
export function latestGateResults(
  orm: StudioOrm,
  artifactId: string,
): Map<string, typeof gateResult.$inferSelect> {
  const latest = new Map<string, typeof gateResult.$inferSelect>()
  for (const row of listGateResults(orm, artifactId)) latest.set(row.gate, row)
  return latest
}

export interface NewFinding {
  artifactId: string
  role: string
  dimension: string
  severity: 'blocker' | 'advisory'
  location: string
  evidence: string
  problem: string
  fix: string
  status?: 'open' | 'fixed' | 'waived'
  resolution?: string | null
}

export function insertFindings(orm: StudioOrm, findings: readonly NewFinding[]): string[] {
  const ids: string[] = []
  orm.transaction((tx) => {
    for (const finding of findings) {
      const id = ulid()
      ids.push(id)
      tx.insert(reviewFinding)
        .values({
          id,
          artifactId: finding.artifactId,
          role: finding.role,
          dimension: finding.dimension,
          severity: finding.severity,
          location: finding.location,
          evidence: finding.evidence,
          problem: finding.problem,
          fix: finding.fix,
          status: finding.status ?? 'open',
          resolution: finding.resolution ?? null,
        })
        .run()
    }
  })
  return ids
}

export function listFindings(
  orm: StudioOrm,
  artifactId: string,
  severity?: 'blocker' | 'advisory',
): Array<typeof reviewFinding.$inferSelect> {
  return orm
    .select()
    .from(reviewFinding)
    .where(
      severity === undefined
        ? eq(reviewFinding.artifactId, artifactId)
        : and(eq(reviewFinding.artifactId, artifactId), eq(reviewFinding.severity, severity)),
    )
    .all()
}

export function getFinding(orm: StudioOrm, id: string): typeof reviewFinding.$inferSelect | undefined {
  return orm.select().from(reviewFinding).where(eq(reviewFinding.id, id)).get()
}

export function resolveFinding(
  orm: StudioOrm,
  id: string,
  status: 'fixed' | 'waived',
  resolution?: string | null,
): boolean {
  const result = orm
    .update(reviewFinding)
    .set({ status, resolution: resolution ?? null })
    .where(eq(reviewFinding.id, id))
    .run()
  return result.changes === 1
}

export function insertComment(
  orm: StudioOrm,
  input: {
    projectId: string
    artifactId?: string | null
    chapter?: number | null
    paragraph?: number | null
    author: string
    body: string
  },
): string {
  const id = ulid()
  orm
    .insert(comment)
    .values({
      id,
      projectId: input.projectId,
      artifactId: input.artifactId ?? null,
      chapter: input.chapter ?? null,
      paragraph: input.paragraph ?? null,
      author: input.author,
      body: input.body,
      status: 'open',
      createdAt: new Date().toISOString(),
    })
    .run()
  return id
}

export function resolveComment(orm: StudioOrm, id: string, status: 'open' | 'resolved'): boolean {
  const result = orm.update(comment).set({ status }).where(eq(comment.id, id)).run()
  return result.changes === 1
}

export function listComments(
  orm: StudioOrm,
  projectId: string,
  chapter?: number,
): Array<typeof comment.$inferSelect> {
  return orm
    .select()
    .from(comment)
    .where(
      chapter === undefined
        ? eq(comment.projectId, projectId)
        : and(eq(comment.projectId, projectId), eq(comment.chapter, chapter)),
    )
    .all()
}
