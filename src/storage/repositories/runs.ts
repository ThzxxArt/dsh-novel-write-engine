import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { StudioOrm } from '../db.js'
import { assignment, event, humanGate, modelUsage, project, run, task } from '../schema.js'
import type { RunKind, RunStatus, TaskStatus } from '../../contracts/stages.js'
import type { RoleId } from '../../contracts/artifacts.js'

const nowIso = (): string => new Date().toISOString()

export interface ProjectRow {
  id: string
  root: string
  title: string
  author: string
  formatVersion: number
  createdAt: string
  updatedAt: string
}

export function upsertProject(
  orm: StudioOrm,
  input: { id?: string; root: string; title: string; author?: string; formatVersion?: number },
): string {
  const existing = orm.select().from(project).where(eq(project.root, input.root)).get()
  const now = nowIso()
  if (existing !== undefined) {
    orm
      .update(project)
      .set({ title: input.title, author: input.author ?? existing.author, updatedAt: now })
      .where(eq(project.id, existing.id))
      .run()
    return existing.id
  }
  const id = input.id ?? ulid()
  orm
    .insert(project)
    .values({
      id,
      root: input.root,
      title: input.title,
      author: input.author ?? '',
      formatVersion: input.formatVersion ?? 2,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return id
}

export function getProjectByRoot(orm: StudioOrm, root: string): ProjectRow | undefined {
  return orm.select().from(project).where(eq(project.root, root)).get()
}

export interface CreateRunInput {
  projectId: string
  kind: RunKind
  targetChapter?: number | null
  input: Record<string, unknown>
}

export function createRun(orm: StudioOrm, input: CreateRunInput): string {
  const id = ulid()
  orm
    .insert(run)
    .values({
      id,
      projectId: input.projectId,
      kind: input.kind,
      status: 'queued',
      targetChapter: input.targetChapter ?? null,
      inputJson: JSON.stringify(input.input),
      createdAt: nowIso(),
    })
    .run()
  return id
}

export type RunRow = typeof run.$inferSelect

export function getRun(orm: StudioOrm, id: string): RunRow | undefined {
  return orm.select().from(run).where(eq(run.id, id)).get()
}

export function listRuns(orm: StudioOrm, projectId: string, limit = 50): RunRow[] {
  return orm
    .select()
    .from(run)
    .where(eq(run.projectId, projectId))
    .orderBy(desc(run.createdAt))
    .limit(limit)
    .all()
}

export function updateRun(
  orm: StudioOrm,
  id: string,
  patch: {
    status?: RunStatus
    output?: Record<string, unknown>
    error?: string | null
    startedAt?: string
    endedAt?: string
  },
): void {
  const values = {
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.output === undefined ? {} : { outputJson: JSON.stringify(patch.output) }),
    ...(patch.error === undefined ? {} : { error: patch.error }),
    ...(patch.startedAt === undefined ? {} : { startedAt: patch.startedAt }),
    ...(patch.endedAt === undefined ? {} : { endedAt: patch.endedAt }),
  }
  // Drizzle throws "No values to set" on an empty SET; an empty patch is a
  // valid no-op from callers that update conditionally.
  if (Object.keys(values).length === 0) return
  orm.update(run).set(values).where(eq(run.id, id)).run()
}

export interface NewTask {
  runId: string
  role: RoleId
  kind: string
  dependsOn: string[]
  input: Record<string, unknown>
  priority?: number
  maxAttempts?: number
  status?: TaskStatus
}

export type TaskRow = typeof task.$inferSelect

export function createTasks(orm: StudioOrm, inputs: readonly NewTask[]): string[] {
  const now = nowIso()
  const ids: string[] = []
  return orm.transaction((tx) => {
    for (const input of inputs) {
      const id = ulid()
      ids.push(id)
      tx.insert(task)
        .values({
          id,
          runId: input.runId,
          role: input.role,
          kind: input.kind,
          status: input.status ?? (input.dependsOn.length === 0 ? 'ready' : 'pending'),
          dependsOnJson: JSON.stringify(input.dependsOn),
          priority: input.priority ?? 0,
          attempt: 0,
          maxAttempts: input.maxAttempts ?? 3,
          inputJson: JSON.stringify(input.input),
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }
    return ids
  })
}

export function getTask(orm: StudioOrm, id: string): TaskRow | undefined {
  return orm.select().from(task).where(eq(task.id, id)).get()
}

export function listTasks(orm: StudioOrm, runId: string): TaskRow[] {
  return orm.select().from(task).where(eq(task.runId, runId)).orderBy(asc(task.createdAt)).all()
}

/** Promote pending tasks whose dependencies are all completed. */
/**
 * Requeue tasks whose worker died without clearing its lease. A task that
 * already burned its attempts fails closed instead of looping forever.
 */
export function reclaimExpiredLeases(orm: StudioOrm, runId: string, now = new Date()): number {
  const nowText = now.toISOString()
  return orm.transaction((tx) => {
    const rows = tx
      .select()
      .from(task)
      .where(
        and(
          eq(task.runId, runId),
          inArray(task.status, ['leased', 'running', 'validating']),
          lte(task.leaseUntil, nowText),
        ),
      )
      .all()
    let changed = 0
    for (const row of rows) {
      if (row.attempt >= row.maxAttempts) {
        settleTask(tx, row.id, 'failed', row.error ?? 'lease expired; max attempts reached')
      } else {
        tx.update(task)
          .set({
            status: 'ready',
            leaseOwner: null,
            leaseUntil: null,
            error: 'lease expired; requeued',
            updatedAt: nowText,
          })
          .where(eq(task.id, row.id))
          .run()
      }
      changed += 1
    }
    return changed
  })
}

export function refreshReadyTasks(orm: StudioOrm, runId: string): number {
  const rows = listTasks(orm, runId)
  const completed = new Set(
    rows.filter((row) => row.status === 'completed' || row.status === 'skipped').map((row) => row.id),
  )
  const now = nowIso()
  let promoted = 0
  for (const row of rows) {
    if (row.status !== 'pending') continue
    const deps = JSON.parse(row.dependsOnJson) as string[]
    if (!deps.every((dep) => completed.has(dep))) continue
    orm.update(task).set({ status: 'ready', updatedAt: now }).where(eq(task.id, row.id)).run()
    promoted += 1
  }
  return promoted
}

/** Atomically claim one ready task. The conditional update is the lease. */
export function claimTask(
  orm: StudioOrm,
  input: { runId: string; owner: string; leaseMs?: number },
): TaskRow | undefined {
  const now = new Date()
  const nowText = now.toISOString()
  const until = new Date(now.getTime() + (input.leaseMs ?? 300_000)).toISOString()
  return orm.transaction((tx) => {
    const candidate = tx
      .select()
      .from(task)
      .where(
        and(
          eq(task.runId, input.runId),
          eq(task.status, 'ready'),
          or(isNull(task.leaseUntil), lte(task.leaseUntil, nowText)),
        ),
      )
      .orderBy(desc(task.priority), asc(task.createdAt))
      .limit(1)
      .get()
    if (candidate === undefined) return undefined
    const changed = tx
      .update(task)
      .set({
        status: 'leased',
        leaseOwner: input.owner,
        leaseUntil: until,
        attempt: candidate.attempt + 1,
        updatedAt: nowText,
      })
      .where(and(eq(task.id, candidate.id), eq(task.status, 'ready')))
      .run()
    if (changed.changes !== 1) return undefined
    return {
      ...candidate,
      status: 'leased' as const,
      leaseOwner: input.owner,
      leaseUntil: until,
      attempt: candidate.attempt + 1,
      updatedAt: nowText,
    }
  })
}

export function markTaskRunning(orm: StudioOrm, id: string): void {
  orm.update(task).set({ status: 'running', updatedAt: nowIso() }).where(eq(task.id, id)).run()
}

/** Claim one specific ready task; used for parallel critic fan-out. */
export function claimTaskById(
  orm: StudioOrm,
  input: { id: string; owner: string; leaseMs?: number },
): TaskRow | undefined {
  const now = new Date()
  const nowText = now.toISOString()
  const until = new Date(now.getTime() + (input.leaseMs ?? 300_000)).toISOString()
  return orm.transaction((tx) => {
    const candidate = tx
      .select()
      .from(task)
      .where(
        and(
          eq(task.id, input.id),
          eq(task.status, 'ready'),
          or(isNull(task.leaseUntil), lte(task.leaseUntil, nowText)),
        ),
      )
      .get()
    if (candidate === undefined) return undefined
    const changed = tx
      .update(task)
      .set({
        status: 'leased',
        leaseOwner: input.owner,
        leaseUntil: until,
        attempt: candidate.attempt + 1,
        updatedAt: nowText,
      })
      .where(and(eq(task.id, candidate.id), eq(task.status, 'ready')))
      .run()
    if (changed.changes !== 1) return undefined
    return {
      ...candidate,
      status: 'leased' as const,
      leaseOwner: input.owner,
      leaseUntil: until,
      attempt: candidate.attempt + 1,
      updatedAt: nowText,
    }
  })
}

export function markTaskValidating(orm: StudioOrm, id: string): void {
  orm.update(task).set({ status: 'validating', updatedAt: nowIso() }).where(eq(task.id, id)).run()
}

export function heartbeatTask(orm: StudioOrm, id: string, owner: string, leaseMs = 300_000): boolean {
  const until = new Date(Date.now() + leaseMs).toISOString()
  const result = orm
    .update(task)
    .set({ leaseUntil: until, updatedAt: nowIso() })
    .where(and(eq(task.id, id), eq(task.leaseOwner, owner)))
    .run()
  return result.changes === 1
}

export function completeTask(orm: StudioOrm, id: string, artifactId: string | null): void {
  orm
    .update(task)
    .set({
      status: 'completed',
      outputArtifactId: artifactId,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: nowIso(),
    })
    .where(eq(task.id, id))
    .run()
}

export function settleTask(
  orm: StudioOrm,
  id: string,
  outcome: 'retry_wait' | 'failed' | 'awaiting_human' | 'cancelled' | 'skipped',
  error?: string,
): void {
  orm
    .update(task)
    .set({
      status: outcome,
      error: error ?? null,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: nowIso(),
    })
    .where(eq(task.id, id))
    .run()
}

export function retryTask(orm: StudioOrm, id: string): void {
  const row = getTask(orm, id)
  if (row === undefined) return
  if (row.attempt >= row.maxAttempts) {
    settleTask(orm, id, 'failed', row.error ?? 'max attempts reached')
    return
  }
  orm
    .update(task)
    .set({ status: 'ready', leaseOwner: null, leaseUntil: null, updatedAt: nowIso() })
    .where(eq(task.id, id))
    .run()
}

export function cancelRun(orm: StudioOrm, runId: string): void {
  const now = nowIso()
  orm.transaction((tx) => {
    tx.update(task)
      .set({ status: 'cancelled', leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(
        and(
          eq(task.runId, runId),
          inArray(task.status, [
            'pending',
            'ready',
            'leased',
            'running',
            'validating',
            'retry_wait',
            'awaiting_human',
          ]),
        ),
      )
      .run()
    tx.update(run).set({ status: 'cancelled', endedAt: now }).where(eq(run.id, runId)).run()
  })
}

export interface NewAssignment {
  taskId: string
  provider: string
  preset: string
  model?: string
  agentSessionId?: string
}

export type AssignmentRow = typeof assignment.$inferSelect

export function createAssignment(orm: StudioOrm, input: NewAssignment): string {
  const id = ulid()
  orm
    .insert(assignment)
    .values({
      id,
      taskId: input.taskId,
      provider: input.provider,
      preset: input.preset,
      model: input.model ?? null,
      agentSessionId: input.agentSessionId ?? null,
      status: 'created',
      startedAt: nowIso(),
    })
    .run()
  return id
}

export function updateAssignment(
  orm: StudioOrm,
  id: string,
  patch: {
    status?: string
    stopReason?: string | null
    usage?: Record<string, unknown>
    agentSessionId?: string
    endedAt?: string
  },
): void {
  const values = {
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.stopReason === undefined ? {} : { stopReason: patch.stopReason }),
    ...(patch.usage === undefined ? {} : { usageJson: JSON.stringify(patch.usage) }),
    ...(patch.agentSessionId === undefined ? {} : { agentSessionId: patch.agentSessionId }),
    ...(patch.endedAt === undefined ? {} : { endedAt: patch.endedAt }),
  }
  if (Object.keys(values).length === 0) return
  orm.update(assignment).set(values).where(eq(assignment.id, id)).run()
}

export function listAssignments(orm: StudioOrm, taskIds: readonly string[]): AssignmentRow[] {
  if (taskIds.length === 0) return []
  return orm
    .select()
    .from(assignment)
    .where(inArray(assignment.taskId, [...taskIds]))
    .all()
}

export function findAssignmentByAgent(
  orm: StudioOrm,
  agentSessionId: string,
): { assignment: AssignmentRow; task: TaskRow; run: RunRow } | undefined {
  const row = orm.select().from(assignment).where(eq(assignment.agentSessionId, agentSessionId)).all().at(-1)
  if (row === undefined) return undefined
  const taskRow = getTask(orm, row.taskId)
  if (taskRow === undefined) return undefined
  const runRow = getRun(orm, taskRow.runId)
  if (runRow === undefined) return undefined
  return { assignment: row, task: taskRow, run: runRow }
}

export function appendEvent(
  orm: StudioOrm,
  input: {
    projectId: string
    runId?: string | null
    taskId?: string | null
    type: string
    payload?: Record<string, unknown>
  },
): number {
  const result = orm
    .insert(event)
    .values({
      projectId: input.projectId,
      runId: input.runId ?? null,
      taskId: input.taskId ?? null,
      type: input.type,
      payloadJson: JSON.stringify(input.payload ?? {}),
      at: nowIso(),
    })
    .run()
  return Number(result.lastInsertRowid)
}

export type EventRow = typeof event.$inferSelect

export function listEvents(orm: StudioOrm, projectId: string, afterSeq = 0, limit = 500): EventRow[] {
  return orm
    .select()
    .from(event)
    .where(and(eq(event.projectId, projectId), sql`${event.seq} > ${afterSeq}`))
    .orderBy(asc(event.seq))
    .limit(limit)
    .all()
}

export function maxEventSeq(orm: StudioOrm, projectId: string): number {
  const row = orm
    .select({ value: sql<number>`COALESCE(MAX(${event.seq}), 0)` })
    .from(event)
    .where(eq(event.projectId, projectId))
    .get()
  return row?.value ?? 0
}

export interface NewHumanGate {
  projectId: string
  runId: string
  taskId?: string | null
  gate: 'bible' | 'outline' | 'chapter' | 'publish'
  chapter?: number | null
  artifactId?: string | null
  approvalTokenHash: string
}

export type HumanGateRow = typeof humanGate.$inferSelect

export function createHumanGate(orm: StudioOrm, input: NewHumanGate): string {
  const id = ulid()
  orm
    .insert(humanGate)
    .values({
      id,
      projectId: input.projectId,
      runId: input.runId,
      taskId: input.taskId ?? null,
      gate: input.gate,
      chapter: input.chapter ?? null,
      artifactId: input.artifactId ?? null,
      status: 'awaiting_human',
      requestedAt: nowIso(),
      approvalTokenHash: input.approvalTokenHash,
    })
    .run()
  return id
}

export function listHumanGates(orm: StudioOrm, projectId: string): HumanGateRow[] {
  return orm
    .select()
    .from(humanGate)
    .where(and(eq(humanGate.projectId, projectId), eq(humanGate.status, 'awaiting_human')))
    .all()
}

export function getHumanGate(orm: StudioOrm, id: string): HumanGateRow | undefined {
  return orm.select().from(humanGate).where(eq(humanGate.id, id)).get()
}

export function decideHumanGate(
  orm: StudioOrm,
  id: string,
  input: { status: 'approved' | 'rejected'; actor: string; reason: string },
): boolean {
  const result = orm
    .update(humanGate)
    .set({
      status: input.status,
      decidedAt: nowIso(),
      actor: input.actor,
      reason: input.reason,
    })
    .where(and(eq(humanGate.id, id), eq(humanGate.status, 'awaiting_human')))
    .run()
  return result.changes === 1
}

export function setHumanGateToken(orm: StudioOrm, id: string, hash: string): boolean {
  const result = orm
    .update(humanGate)
    .set({ approvalTokenHash: hash })
    .where(and(eq(humanGate.id, id), eq(humanGate.status, 'awaiting_human')))
    .run()
  return result.changes === 1
}

export function recordUsage(
  orm: StudioOrm,
  input: {
    runId: string
    taskId: string
    role: string
    model: string
    promptTokens: number
    completionTokens: number
    costUsd: number
  },
): void {
  orm
    .insert(modelUsage)
    .values({
      id: ulid(),
      runId: input.runId,
      taskId: input.taskId,
      role: input.role,
      model: input.model,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      costUsd: input.costUsd,
      at: nowIso(),
    })
    .run()
}

export function usageForRun(
  orm: StudioOrm,
  runId: string,
): { promptTokens: number; completionTokens: number; costUsd: number } {
  const row = orm
    .select({
      promptTokens: sql<number>`COALESCE(SUM(${modelUsage.promptTokens}), 0)`,
      completionTokens: sql<number>`COALESCE(SUM(${modelUsage.completionTokens}), 0)`,
      costUsd: sql<number>`COALESCE(SUM(${modelUsage.costUsd}), 0)`,
    })
    .from(modelUsage)
    .where(eq(modelUsage.runId, runId))
    .get()
  return row ?? { promptTokens: 0, completionTokens: 0, costUsd: 0 }
}
