import { STATE_FILES, STATE_DIR } from '../constants.js'
import type { AuditRow } from '../types.js'
import { ERROR_CODES, EngineFaultError } from '../types.js'
import type { FsStore } from './fs.js'
import { joinRel } from './fs.js'

/** One JSONL line of the append-only journal. */
export interface JournalRecord {
  txid: string
  at: string
  op: string
  chapter: number
  revision: number
  files: string[]
  status: 'committed' | 'aborted'
  reason?: string
}

const JOURNAL_PATH = joinRel(STATE_DIR, STATE_FILES.journal)

/** Append one record. The journal is the only append-only file in the engine. */
export async function appendJournal(store: FsStore, record: JournalRecord): Promise<void> {
  await store.appendText(JOURNAL_PATH, `${JSON.stringify(record)}\n`)
}

/** Read every parsable record; malformed lines are counted, never rewritten. */
export async function readJournal(store: FsStore): Promise<{ rows: AuditRow[]; malformed: number }> {
  const text = await store.readText(JOURNAL_PATH)
  if (text === null) return { rows: [], malformed: 0 }
  const rows: AuditRow[] = []
  let malformed = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const raw = JSON.parse(line) as Partial<JournalRecord>
      if (typeof raw.txid !== 'string' || typeof raw.op !== 'string') throw new Error('shape')
      rows.push({
        at: String(raw.at ?? ''),
        op: raw.op,
        chapter: Number(raw.chapter ?? 0),
        revision: Number(raw.revision ?? 0),
        txid: raw.txid,
        status: raw.status === 'aborted' ? 'aborted' : 'committed',
        files: Array.isArray(raw.files) ? raw.files.map(String) : [],
      })
    } catch {
      malformed += 1
    }
  }
  return { rows, malformed }
}

/** Fail with a diagnostic (never a mutation) when the journal is truncated. */
export function assertJournalHealthy(malformed: number): void {
  if (malformed > 0) {
    throw new EngineFaultError(
      ERROR_CODES.SCHEMA_INVALID,
      `journal has ${malformed} malformed line(s)`,
      'keep a copy of state/journal.jsonl; the engine never rewrites it automatically',
    )
  }
}
