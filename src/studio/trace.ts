import type { LoadedProject } from '../kernel/project/layout.js'

/** Human-readable trace backup; the DB event table remains the query source. */
export async function appendTrace(
  project: LoadedProject,
  runId: string,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const line = `${JSON.stringify({ at: new Date().toISOString(), type, payload })}\n`
  try {
    await project.store.appendText(`runs/${runId}/trace.jsonl`, line)
  } catch {
    // The DB event table is the audit source; trace.jsonl is a best-effort
    // human-readable mirror. A project removed mid-run must not crash a test or
    // a background worker.
  }
}
