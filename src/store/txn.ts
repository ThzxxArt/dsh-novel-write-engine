import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { BACKUP_DIR, STAGING_DIR } from '../constants.js'
import { ERROR_CODES, EngineFaultError } from '../types.js'
import { FsStore, joinRel, sha256 } from './fs.js'
import { appendJournal } from './journal.js'
import { pruneBackups } from './backup.js'

/** One file scheduled inside a transaction: text or binary, exactly one. */
export interface StagedFile {
  path: string
  text?: string
  bytes?: Uint8Array
}

/** Hash a staged payload the same way on stage, verify and readback. */
export function stagedHash(file: StagedFile): string {
  const bytes = file.bytes ?? Buffer.from(file.text ?? '', 'utf8')
  return sha256(Buffer.from(bytes).toString('base64'))
}

/** Everything the transaction needs to commit a logical operation. */
export interface TransactionInput {
  txid: string
  op: string
  chapter: number
  revision: number
  files: StagedFile[]
  backup: boolean
  /** How many backup directories to keep after a successful commit. */
  backupRetention?: number
  /** Optional abort signal; checked before any target file is touched. */
  signal?: AbortSignal
  /** Test seam: runs after staging is verified, before commit. */
  afterVerify?: () => Promise<void>
  /** Test seam: runs after each rename; throwing triggers compensation. */
  afterRename?: (path: string, index: number) => Promise<void>
}

const stagingDir = (txid: string): string => joinRel(STAGING_DIR, txid)
const backupDir = (txid: string): string => joinRel(BACKUP_DIR, txid)

/** Restore every already-renamed target from its pre-commit bytes. */
async function restoreTargets(
  store: FsStore,
  renamed: readonly string[],
  before: ReadonlyMap<string, Uint8Array | null>,
): Promise<string | null> {
  const problems: string[] = []
  for (const path of [...renamed].reverse()) {
    try {
      const previous = before.get(path)
      if (previous === undefined) {
        problems.push(`${path}: no pre-commit image was captured`)
        continue
      }
      if (previous === null) await fs.rm(store.path(path), { force: true })
      else await store.writeBytes(path, previous)
    } catch (error) {
      problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return problems.length === 0 ? null : problems.join('; ')
}

/**
 * The seven-step transaction: stage → verify → backup → commit → journal →
 * readback → cleanup. A failure at any point leaves target files untouched:
 * already-renamed targets are restored from their pre-commit images, and the
 * journal records exactly one terminal row (`committed` only after readback).
 */
export async function runTransaction(store: FsStore, input: TransactionInput): Promise<void> {
  const staging = stagingDir(input.txid)
  const expected = new Map<string, string>()
  const before = new Map<string, Uint8Array | null>()
  const renamed: string[] = []
  let journaledCommitted = false

  try {
    for (const file of input.files) {
      const target = joinRel(staging, file.path)
      if (file.bytes !== undefined) await store.writeBytes(target, file.bytes)
      else await store.writeText(target, file.text ?? '')
      expected.set(file.path, stagedHash(file))
    }

    if (input.signal?.aborted === true) {
      throw new EngineFaultError(
        ERROR_CODES.TXN_ABORTED,
        'transaction aborted before commit',
        'retry the call',
      )
    }

    for (const file of input.files) {
      const stagedBytes = await store.readBytes(joinRel(staging, file.path))
      if (stagedBytes === null) {
        throw new EngineFaultError(ERROR_CODES.TXN_ABORTED, `staged copy of ${file.path} is missing`)
      }
      const actual = sha256(stagedBytes.toString('base64'))
      if (actual !== expected.get(file.path)) {
        throw new EngineFaultError(ERROR_CODES.TXN_ABORTED, `staged copy of ${file.path} failed verification`)
      }
    }

    if (input.afterVerify !== undefined) await input.afterVerify()

    // Capture every target's pre-commit bytes before the first rename. This is
    // the compensation log; it exists even when the user-facing backup is off.
    for (const file of input.files) before.set(file.path, await store.readBytes(file.path))

    if (input.backup) {
      for (const file of input.files) {
        const existing = before.get(file.path)
        if (existing === null || existing === undefined) continue
        await store.writeBytes(joinRel(backupDir(input.txid), file.path), existing)
      }
    }

    for (const [index, file] of input.files.entries()) {
      const from = store.path(joinRel(staging, file.path))
      const to = store.path(file.path)
      await fs.mkdir(dirname(to), { recursive: true })
      await fs.rename(from, to)
      renamed.push(file.path)
      if (input.afterRename !== undefined) await input.afterRename(file.path, index)
    }

    for (const file of input.files) {
      const written = await store.hashBytes(file.path)
      if (written !== expected.get(file.path)) {
        throw new EngineFaultError(
          ERROR_CODES.TXN_ABORTED,
          `readback of ${file.path} does not match what was staged`,
          'the file on disk was modified by another process during the commit',
        )
      }
    }

    // The committed row is written only after readback, so a transaction can
    // never be both committed and aborted in the journal.
    await appendJournal(store, {
      txid: input.txid,
      at: new Date().toISOString(),
      op: input.op,
      chapter: input.chapter,
      revision: input.revision,
      files: input.files.map((file) => file.path),
      status: 'committed',
      hashes: Object.fromEntries(expected),
    })
    journaledCommitted = true

    if (input.backup) {
      await pruneBackups(store, input.backupRetention ?? 5).catch(() => undefined)
    }
    await fs.rm(store.path(staging), { recursive: true, force: true }).catch(() => undefined)
  } catch (error) {
    const rollbackProblem = await restoreTargets(store, renamed, before)
    await fs.rm(store.path(staging), { recursive: true, force: true }).catch(() => undefined)
    if (!journaledCommitted) {
      await appendJournal(store, {
        txid: input.txid,
        at: new Date().toISOString(),
        op: input.op,
        chapter: input.chapter,
        revision: input.revision,
        files: input.files.map((file) => file.path),
        status: 'aborted',
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined)
    }
    const suffix =
      rollbackProblem === null
        ? ''
        : `; compensation was incomplete: ${rollbackProblem}; do not retry until the files are restored`
    if (error instanceof EngineFaultError) {
      if (rollbackProblem === null) throw error
      throw new EngineFaultError(
        ERROR_CODES.TXN_ABORTED,
        `${error.message}${suffix}`,
        'inspect state/journal.jsonl and the project files before retrying',
        { cause: error },
      )
    }
    throw new EngineFaultError(
      ERROR_CODES.TXN_ABORTED,
      `transaction ${input.txid} aborted: ${error instanceof Error ? error.message : String(error)}${suffix}`,
      undefined,
      { cause: error },
    )
  }
}

/** Snapshot helper used by tests and `rollback`: path → hash, for every given file. */
export async function snapshotFiles(
  store: FsStore,
  paths: readonly string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>()
  for (const path of paths) result.set(path, await store.hashOf(path))
  return result
}
