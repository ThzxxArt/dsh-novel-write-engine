import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/** Project identity. Prose/settings truth stays in files. */
export const project = sqliteTable(
  'project',
  {
    id: text('id').primaryKey(),
    root: text('root').notNull(),
    title: text('title').notNull(),
    author: text('author').notNull().default(''),
    formatVersion: integer('format_version').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('project_root_uq').on(table.root)],
)

export const run = sqliteTable(
  'run',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    targetChapter: integer('target_chapter'),
    inputJson: text('input_json').notNull(),
    outputJson: text('output_json'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
  },
  (table) => [index('run_project_status_idx').on(table.projectId, table.status)],
)

export const task = sqliteTable(
  'task',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    dependsOnJson: text('depends_on_json').notNull().default('[]'),
    priority: integer('priority').notNull().default(0),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    leaseOwner: text('lease_owner'),
    leaseUntil: text('lease_until'),
    inputJson: text('input_json').notNull(),
    outputArtifactId: text('output_artifact_id'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('task_run_status_idx').on(table.runId, table.status),
    index('task_output_artifact_idx').on(table.outputArtifactId),
    index('task_lease_idx').on(table.status, table.leaseUntil),
  ],
)

export const assignment = sqliteTable(
  'assignment',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    agentSessionId: text('agent_session_id'),
    provider: text('provider').notNull(),
    preset: text('preset').notNull(),
    model: text('model'),
    status: text('status').notNull(),
    stopReason: text('stop_reason'),
    usageJson: text('usage_json'),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
  },
  (table) => [index('assignment_task_idx').on(table.taskId)],
)

export const artifact = sqliteTable(
  'artifact',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    chapter: integer('chapter'),
    version: integer('version').notNull(),
    status: text('status').notNull(),
    path: text('path').notNull(),
    contentHash: text('content_hash').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    baseArtifactId: text('base_artifact_id'),
    taskId: text('task_id'),
    provenanceJson: text('provenance_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('artifact_version_uq').on(table.projectId, table.kind, table.chapter, table.version),
    index('artifact_lookup_idx').on(table.projectId, table.kind, table.chapter, table.status),
    index('artifact_task_idx').on(table.taskId),
  ],
)

export const event = sqliteTable(
  'event',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    projectId: text('project_id').notNull(),
    runId: text('run_id'),
    taskId: text('task_id'),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
    at: text('at').notNull(),
  },
  (table) => [index('event_project_seq_idx').on(table.projectId, table.seq)],
)

export const gateResult = sqliteTable(
  'gate_result',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifact.id, { onDelete: 'cascade' }),
    gate: text('gate').notNull(),
    verdict: text('verdict').notNull(),
    detailsJson: text('details_json').notNull(),
    at: text('at').notNull(),
  },
  (table) => [index('gate_artifact_idx').on(table.artifactId, table.gate)],
)

export const reviewFinding = sqliteTable(
  'review_finding',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifact.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    dimension: text('dimension').notNull(),
    severity: text('severity').notNull(),
    location: text('location').notNull(),
    evidence: text('evidence').notNull(),
    problem: text('problem').notNull(),
    fix: text('fix').notNull(),
    status: text('status').notNull(),
    resolution: text('resolution'),
  },
  (table) => [index('finding_artifact_idx').on(table.artifactId, table.severity)],
)

export const memoryChunk = sqliteTable(
  'memory_chunk',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    kind: text('kind').notNull(),
    chapter: integer('chapter'),
    sourcePath: text('source_path').notNull(),
    sourceHash: text('source_hash').notNull(),
    text: text('text').notNull(),
    metaJson: text('meta_json').notNull(),
  },
  (table) => [index('memory_project_kind_idx').on(table.projectId, table.kind)],
)

/** Tokenisation shadow: CJK characters are space-separated for FTS5 unicode61. */
export const memorySearch = sqliteTable('memory_search', {
  id: text('id').primaryKey(),
  text: text('text').notNull(),
})

export const modelUsage = sqliteTable(
  'model_usage',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    taskId: text('task_id').notNull(),
    role: text('role').notNull(),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull(),
    completionTokens: integer('completion_tokens').notNull(),
    costUsd: real('cost_usd').notNull().default(0),
    at: text('at').notNull(),
  },
  (table) => [index('usage_run_idx').on(table.runId, table.role)],
)

export const humanGate = sqliteTable(
  'human_gate',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    runId: text('run_id').notNull(),
    taskId: text('task_id'),
    gate: text('gate').notNull(),
    chapter: integer('chapter'),
    artifactId: text('artifact_id'),
    status: text('status').notNull(),
    requestedAt: text('requested_at').notNull(),
    decidedAt: text('decided_at'),
    actor: text('decided_actor'),
    reason: text('decision_reason'),
    approvalTokenHash: text('approval_token_hash'),
  },
  (table) => [index('human_gate_project_idx').on(table.projectId, table.status)],
)

export const comment = sqliteTable(
  'comment',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    artifactId: text('artifact_id'),
    chapter: integer('chapter'),
    paragraph: integer('paragraph'),
    author: text('author').notNull(),
    body: text('body').notNull(),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('comment_project_idx').on(table.projectId, table.chapter)],
)

export const settings = sqliteTable('settings', {
  projectId: text('project_id').primaryKey(),
  json: text('json').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** Drizzle schema is the single table source; migrations carry the FTS5 extras. */
export const STUDIO_SCHEMA = {
  project,
  run,
  task,
  assignment,
  artifact,
  event,
  gateResult,
  reviewFinding,
  memoryChunk,
  memorySearch,
  modelUsage,
  humanGate,
  comment,
  settings,
}
