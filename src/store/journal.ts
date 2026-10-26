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
  status: 'pending' | 'committed' | 'aborted'
  reason?: string
  /** Content hash per target, written before rename and again on commit. */
  hashes?: Record<string, string>
  /** Pre-commit hash per target; null means the target did not exist. */
  before?: Record<string, string | null>
}

export interface JournalRead {
  rows: AuditRow[]
  malformed: number
  records: JournalRecord[]
}

const JOURNAL_PATH = joinRel(STATE_DIR, STATE_FILES.journal)

/** Append one record. The journal is the only append-only file in the engine. */
export async function appendJournal(store: FsStore, record: JournalRecord): Promise<void> {
  await store.appendText(JOURNAL_PATH, `${JSON.stringify(record)}\n`)
}

/** Read every parsable record; malformed lines are counted, never rewritten. */
export async function readJournal(store: FsStore): Promise<JournalRead> {
  const text = await store.readText(JOURNAL_PATH)
  if (text === null) return { rows: [], malformed: 0, records: [] }
  const rows: AuditRow[] = []
  const records: JournalRecord[] = []
  let malformed = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const raw = JSON.parse(line) as Partial<JournalRecord>
      if (typeof raw.txid !== 'string' || typeof raw.op !== 'string') throw new Error('shape')
      if (raw.status !== 'pending' && raw.status !== 'committed' && raw.status !== 'aborted') {
        throw new Error('status')
      }
      const record: JournalRecord = {
        txid: raw.txid,
        at: String(raw.at ?? ''),
        op: raw.op,
        chapter: Number(raw.chapter ?? 0),
        revision: Number(raw.revision ?? 0),
        files: Array.isArray(raw.files) ? raw.files.map(String) : [],
        status: raw.status,
      }
      if (typeof raw.reason === 'string') record.reason = raw.reason
      if (typeof raw.hashes === 'object' && raw.hashes !== null && !Array.isArray(raw.hashes)) {
        record.hashes = Object.fromEntries(
          Object.entries(raw.hashes as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      }
      if (typeof raw.before === 'object' && raw.before !== null && !Array.isArray(raw.before)) {
        record.before = Object.fromEntries(
          Object.entries(raw.before as Record<string, unknown>).filter(
            (entry): entry is [string, string | null] => entry[1] === null || typeof entry[1] === 'string',
          ),
        )
      }
      records.push(record)
      // Pending rows are recovery metadata, not user-visible audit entries.
      if (record.status !== 'pending') {
        rows.push({
          at: record.at,
          op: record.op,
          chapter: record.chapter,
          revision: record.revision,
          txid: record.txid,
          status: record.status,
          files: record.files,
        })
      }
    } catch {
      malformed += 1
    }
  }
  return { rows, malformed, records }
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

export interface JournalMismatch {
  txid: string
  path: string
  expected: string
  actual: string | null
}

/**
 * Compare the last committed transaction's recorded hashes with the files on
 * disk. A mismatch means an external writer changed the project after commit;
 * the engine reports it instead of silently building on the altered state.
 */
export async function reconcileJournal(store: FsStore): Promise<{
  malformed: number
  mismatches: JournalMismatch[]
}> {
  const { records, malformed } = await readJournal(store)
  const last = [...records]
    .reverse()
    .find((record) => record.status === 'committed' && record.hashes !== undefined)
  if (last?.hashes === undefined) return { malformed, mismatches: [] }
  const mismatches: JournalMismatch[] = []
  for (const [path, expected] of Object.entries(last.hashes)) {
    const actual = await store.hashBytes(path)
    if (actual !== expected) mismatches.push({ txid: last.txid, path, expected, actual })
  }
  return { malformed, mismatches }
}

/**
 * Resolve a pending transaction left by a crash. The pending row is written
 * after the pre-images are captured and before the first rename, so it is the
 * only record that can distinguish "renamed but not journaled" from "crashed
 * before touching a target". A fully matching pending transaction is promoted
 * to committed; a transaction whose targets all still match their pre-images
 * is closed as aborted; any mixture is refused as a partial commit.
 */
export async function recoverPending(store: FsStore): Promise<void> {
  const { records } = await readJournal(store)
  const last = records[records.length - 1]
  if (last?.status !== 'pending') return
  const matchesExpected = async (): Promise<boolean> => {
    if (last.hashes === undefined) return false
    for (const [path, expected] of Object.entries(last.hashes)) {
      if ((await store.hashBytes(path)) !== expected) return false
    }
    return true
  }
  const matchesBefore = async (): Promise<boolean> => {
    if (last.before === undefined) return false
    for (const [path, expected] of Object.entries(last.before)) {
      const actual = await store.hashBytes(path)
      if (expected === null ? actual !== null : actual !== expected) return false
    }
    return true
  }
  if (await matchesExpected()) {
    await appendJournal(store, { ...last, status: 'committed' })
    return
  }
  if (await matchesBefore()) {
    await appendJournal(store, {
      ...last,
      status: 'aborted',
      reason: 'recovered: the process stopped before the transaction renamed a target',
    })
    return
  }
  throw new EngineFaultError(
    ERROR_CODES.TXN_ABORTED,
    `pending transaction ${last.txid} partially changed the project; automatic recovery is unsafe`,
    'restore the project from backups/ or state/journal.jsonl before retrying',
  )
}

/** Throw before a write when the journal or the last commit is inconsistent. */
export async function assertJournalConsistent(store: FsStore): Promise<void> {
  await recoverPending(store)
  const { malformed, mismatches } = await reconcileJournal(store)
  assertJournalHealthy(malformed)
  if (mismatches.length > 0) {
    const first = mismatches[0]!
    throw new EngineFaultError(
      ERROR_CODES.TXN_ABORTED,
      `journal hash mismatch for ${first.path} (txid ${first.txid}); expected ${first.expected}, found ${first.actual ?? 'missing'}`,
      'restore the file from backups/ or fix the external change before retrying',
    )
  }
}
