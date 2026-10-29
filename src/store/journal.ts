import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import {
  OUTLINE_FILE,
  PROJECT_FILE,
  STAGING_DIR,
  STATE_FILES,
  STATE_DIR,
  WORLDBOOK_FILE,
} from '../constants.js'
import type { AuditRow } from '../types.js'
import { ERROR_CODES, EngineFaultError } from '../types.js'
import type { FsStore } from './fs.js'
import { joinRel, syncDirectory } from './fs.js'

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

/** A journal that only contains lock-reclaim rows is not a project history. */
export function hasCommittedJournal(records: readonly JournalRecord[]): boolean {
  return records.some((record) => record.status === 'committed' && record.op !== 'lock_reclaimed')
}

const JOURNAL_PATH = joinRel(STATE_DIR, STATE_FILES.journal)

/** Append one record. The journal is the only append-only file in the engine. */
export async function appendJournal(
  store: FsStore,
  record: JournalRecord,
  options: { repairTrailing?: boolean } = {},
): Promise<void> {
  // Lock reclamation runs before assertJournalConsistent; trim there first or
  // the appended audit row would turn a torn tail into malformed middle text.
  if (options.repairTrailing === true) await trimTrailingFragment(store)
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
  // Track the latest committed hash for every path, not just the last
  // transaction. A pipeline-only brief transaction would otherwise reset the
  // external-edit detector for every ledger written earlier.
  const expected = new Map<string, { txid: string; hash: string }>()
  // The authoritative ledgers and planning documents are checked here.
  // Manuscripts, plans, reviews and checks have their own content-hash gates
  // (PG-07/PG-09/PG-12); exports are derived artifacts, so an external edit
  // there must not wedge project writes. `archive-digests.json` is a derived
  // mirror of `chapters[].archive_digest`; a corrupt mirror must be rebuildable
  // by the next archive instead of making every write unreachable.
  const tracked = (path: string): boolean =>
    (path === 'novel.yaml' ||
      path.startsWith('state/') ||
      path === OUTLINE_FILE ||
      path === WORLDBOOK_FILE) &&
    path !== 'state/archive-digests.json'
  for (const record of records) {
    if (record.status !== 'committed' || record.hashes === undefined) continue
    for (const [path, hash] of Object.entries(record.hashes)) {
      if (!tracked(path)) continue
      expected.set(path, { txid: record.txid, hash })
    }
  }
  if (expected.size === 0) return { malformed, mismatches: [] }
  const mismatches: JournalMismatch[] = []
  for (const [path, entry] of expected) {
    const actual = await store.hashBytes(path)
    if (actual !== entry.hash) {
      mismatches.push({ txid: entry.txid, path, expected: entry.hash, actual })
    }
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
  // Lock reclaim is an audit row, not a transaction. A crashed writer leaves
  // its pending row behind, then the next writer appends lock_reclaimed; looking
  // only at the physical last row would hide the pending transaction and make
  // reconciliation compare the wrong committed hashes.
  const last = [...records].reverse().find((record) => record.op !== 'lock_reclaimed')
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
    await store.removeTree(joinRel(STAGING_DIR, last.txid)).catch(() => undefined)
    return
  }
  if (await matchesBefore()) {
    await appendJournal(store, {
      ...last,
      status: 'aborted',
      reason: 'recovered: the process stopped before the transaction renamed a target',
    })
    await store.removeTree(joinRel(STAGING_DIR, last.txid)).catch(() => undefined)
    return
  }
  throw new EngineFaultError(
    ERROR_CODES.TXN_ABORTED,
    `pending transaction ${last.txid} partially changed the project; automatic recovery is unsafe`,
    `restore from backups/ or ${STAGING_DIR}/${last.txid}/before/ before retrying`,
  )
}

/**
 * A crash during append can leave one JSONL fragment without a newline. Since
 * the pending row is appended before any target rename, such a fragment cannot
 * describe renamed data; trim only that final incomplete line and let
 * recoverPending handle the complete pending row before it. Malformed lines
 * followed by more lines are historical corruption and stay fail-closed.
 */
async function trimTrailingFragment(store: FsStore): Promise<void> {
  const text = await store.readText(JOURNAL_PATH)
  if (text === null || text.endsWith('\n')) return
  const cut = text.lastIndexOf('\n') + 1
  const fragment = text.slice(cut)
  if (fragment.trim() === '') return
  try {
    JSON.parse(fragment)
    return
  } catch {
    // Incomplete final append; trim below.
  }
  const absolute = store.path(JOURNAL_PATH)
  const handle = await fs.open(absolute, 'r+')
  try {
    await handle.truncate(Buffer.byteLength(text.slice(0, cut), 'utf8'))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(dirname(absolute))
}

/**
 * Throw before a write when the journal or the last commit is inconsistent.
 *
 * `repairPaths` is used only by an explicit amend: a damaged ledger is by
 * definition a file whose bytes no longer match the last committed hash, and
 * refusing every write would make the documented repair path unreachable. All
 * other mismatches still fail closed.
 */
export async function assertJournalConsistent(
  store: FsStore,
  repairPaths: readonly string[] = [],
): Promise<void> {
  if ((await store.exists(PROJECT_FILE)) && !(await store.exists(JOURNAL_PATH))) {
    throw new EngineFaultError(
      ERROR_CODES.JOURNAL_MISSING,
      'state/journal.jsonl is missing; journal integrity and crash recovery are unavailable',
      'restore state/journal.jsonl from a backup before writing; a project with novel.yaml must have its audit journal',
    )
  }
  await trimTrailingFragment(store)
  await recoverPending(store)
  // A crash after the committed row but before staging cleanup leaves an
  // orphan. The transaction is terminal, so its before-images are no longer a
  // recovery source; aborted/partial staging is deliberately kept.
  const { records, malformed } = await readJournal(store)
  if ((await store.exists(PROJECT_FILE)) && !hasCommittedJournal(records)) {
    throw new EngineFaultError(
      ERROR_CODES.JOURNAL_MISSING,
      'state/journal.jsonl has no committed project transaction; the audit history was truncated or replaced',
      'restore state/journal.jsonl from a backup before writing; a project with novel.yaml must have its committed history',
    )
  }
  const committed = new Set(
    records
      .filter((record) => record.status === 'committed' && record.op !== 'lock_reclaimed')
      .map((record) => record.txid),
  )
  const knownTransactions = new Set(records.map((record) => record.txid))
  for (const entry of await store.list(STAGING_DIR)) {
    if (committed.has(entry)) {
      await store.removeTree(joinRel(STAGING_DIR, entry)).catch(() => undefined)
      continue
    }
    // A crash before the pending row was appended leaves a staging directory
    // with no transaction record and no renamed target. It is safe to remove
    // only when every journal line parsed; a malformed line could be the
    // missing pending record for a partially committed staging directory.
    if (malformed === 0 && !knownTransactions.has(entry)) {
      await store.removeTree(joinRel(STAGING_DIR, entry)).catch(() => undefined)
    }
  }
  const { malformed: malformedAfter, mismatches } = await reconcileJournal(store)
  assertJournalHealthy(malformedAfter)
  const allowed = new Set(repairPaths)
  const fatal = mismatches.filter((mismatch) => !allowed.has(mismatch.path))
  if (fatal.length > 0) {
    const first = fatal[0]!
    throw new EngineFaultError(
      ERROR_CODES.TXN_ABORTED,
      `journal hash mismatch for ${first.path} (txid ${first.txid}); expected ${first.expected}, found ${first.actual ?? 'missing'}`,
      'restore the file from backups/ or fix the external change before retrying',
    )
  }
}
