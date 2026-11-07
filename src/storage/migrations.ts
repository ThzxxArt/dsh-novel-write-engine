/**
 * Migration SQL is inlined deliberately: the plugin ships only `lib/`, so a
 * runtime file read would break the packaged artifact. `migrations/0000_initial.sql`
 * is the human-review copy and must stay byte-identical in intent.
 */
export interface Migration {
  version: number
  sql: string
}

const INITIAL_SQL = `
CREATE TABLE IF NOT EXISTS schema_migration (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  format_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('book','chapter','rewrite','review','market')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','awaiting_human','paused','completed','failed','cancelled')),
  target_chapter INTEGER,
  input_json TEXT NOT NULL,
  output_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS run_project_status_idx ON run(project_id, status);

CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','ready','leased','running','validating','awaiting_human','retry_wait','completed','failed','cancelled','skipped')),
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_until TEXT,
  input_json TEXT NOT NULL,
  output_artifact_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_run_status_idx ON task(run_id, status);
CREATE INDEX IF NOT EXISTS task_output_artifact_idx ON task(output_artifact_id);
CREATE INDEX IF NOT EXISTS task_lease_idx ON task(status, lease_until);

CREATE TABLE IF NOT EXISTS assignment (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  agent_session_id TEXT,
  provider TEXT NOT NULL,
  preset TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('created','started','completed','failed','aborted','max_tokens','refusal')),
  stop_reason TEXT,
  usage_json TEXT,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS assignment_task_idx ON assignment(task_id);

CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  chapter INTEGER,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','reviewed','approved','superseded','rejected')),
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  base_artifact_id TEXT,
  task_id TEXT,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, kind, chapter, version)
);
CREATE INDEX IF NOT EXISTS artifact_lookup_idx ON artifact(project_id, kind, chapter, status);
CREATE INDEX IF NOT EXISTS artifact_task_idx ON artifact(task_id);

CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  run_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_project_seq_idx ON event(project_id, seq);

CREATE TABLE IF NOT EXISTS gate_result (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  gate TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail','advisory')),
  details_json TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gate_artifact_idx ON gate_result(artifact_id, gate);

CREATE TABLE IF NOT EXISTS review_finding (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  dimension TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('blocker','advisory')),
  location TEXT NOT NULL,
  evidence TEXT NOT NULL,
  problem TEXT NOT NULL,
  fix TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','fixed','waived'))
);
CREATE INDEX IF NOT EXISTS finding_artifact_idx ON review_finding(artifact_id, severity);

CREATE TABLE IF NOT EXISTS memory_chunk (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  chapter INTEGER,
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  meta_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_project_kind_idx ON memory_chunk(project_id, kind);

CREATE TABLE IF NOT EXISTS memory_search (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  text,
  content='memory_search',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS memory_search_ai AFTER INSERT ON memory_search BEGIN
  INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_search_ad AFTER DELETE ON memory_search BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_search_au AFTER UPDATE ON memory_search BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS model_usage (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_run_idx ON model_usage(run_id, role);

CREATE TABLE IF NOT EXISTS human_gate (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT,
  gate TEXT NOT NULL,
  chapter INTEGER,
  artifact_id TEXT,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decided_actor TEXT,
  decision_reason TEXT,
  approval_token_hash TEXT
);
CREATE INDEX IF NOT EXISTS human_gate_project_idx ON human_gate(project_id, status);

CREATE TABLE IF NOT EXISTS comment (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  artifact_id TEXT,
  chapter INTEGER,
  paragraph INTEGER,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comment_project_idx ON comment(project_id, chapter);

CREATE TABLE IF NOT EXISTS settings (
  project_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

export const MIGRATIONS: readonly Migration[] = [
  { version: 0, sql: INITIAL_SQL },
  {
    version: 1,
    sql: `ALTER TABLE review_finding ADD COLUMN resolution TEXT;`,
  },
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version
