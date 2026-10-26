import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { BACKUP_DIR, STAGING_DIR } from '../constants.js'
import { ERROR_CODES, EngineFaultError } from '../types.js'
import { FsStore, joinRel, sha256 } from './fs.js'
import { appendJournal } from './journal.js'

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
  /** Optional abort signal; checked before any target file is touched. */
  signal?: AbortSignal
  /** Test seam: runs after staging is verified, before commit. */
  afterVerify?: () => Promise<void>
}

const stagingDir = (txid: string): string => joinRel(STAGING_DIR, txid)
const backupDir = (txid: string): string => joinRel(BACKUP_DIR, txid)

/**
 * The seven-step transaction: stage → verify → backup → commit → journal →
 * readback → cleanup. A failure at any point leaves target files untouched and
 * records an `aborted` journal row.
 */
export async function runTransaction(store: FsStore, input: TransactionInput): Promise<void> {
  const staging = stagingDir(input.txid)
  const expected = new Map<string, string>()
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

    if (input.backup) {
      for (const file of input.files) {
        const existing = await store.readBytes(file.path)
        if (existing === null) continue
        await store.writeBytes(joinRel(backupDir(input.txid), file.path), existing)
      }
    }

    for (const file of input.files) {
      const from = store.path(joinRel(staging, file.path))
      const to = store.path(file.path)
      await fs.mkdir(dirname(to), { recursive: true })
      await fs.rename(from, to)
    }

    await appendJournal(store, {
      txid: input.txid,
      at: new Date().toISOString(),
      op: input.op,
      chapter: input.chapter,
      revision: input.revision,
      files: input.files.map((file) => file.path),
      status: 'committed',
    })

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

    await fs.rm(store.path(staging), { recursive: true, force: true })
  } catch (error) {
    await fs.rm(store.path(staging), { recursive: true, force: true }).catch(() => undefined)
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
    if (error instanceof EngineFaultError) throw error
    throw new EngineFaultError(
      ERROR_CODES.TXN_ABORTED,
      `transaction ${input.txid} aborted: ${error instanceof Error ? error.message : String(error)}`,
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
