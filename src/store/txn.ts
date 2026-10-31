import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { BACKUP_DIR, STAGING_DIR } from '../constants.js'
import { ERROR_CODES, EngineError, EngineFaultError } from '../types.js'
import { FsStore, joinRel, sha256, syncDirectory } from './fs.js'
import { appendJournal } from './journal.js'
import { BACKUP_MARKER, BACKUP_MANIFEST, pruneBackups } from './backup.js'

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
  /** Human reason for a maintenance transaction; persisted in the journal. */
  reason?: string
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
 * The transaction: stage → verify → backup → pending journal → rename →
 * readback → committed journal → cleanup. A failure at any point leaves target
 * files untouched: already-renamed targets are restored from their pre-commit
 * images, and the journal records exactly one terminal row (`committed` only
 * after readback; a pending row lets startup recover a crash between rename and
 * that terminal row).
 */
export async function runTransaction(store: FsStore, input: TransactionInput): Promise<void> {
  const staged = new Set<string>()
  for (const file of input.files) {
    if (staged.has(file.path)) {
      throw new EngineFaultError(
        ERROR_CODES.TXN_ABORTED,
        `transaction ${input.txid} stages ${file.path} more than once`,
        'each target may appear once per transaction; merge the writes before staging',
      )
    }
    if (file.text !== undefined && file.bytes !== undefined) {
      throw new EngineFaultError(
        ERROR_CODES.TXN_ABORTED,
        `transaction ${input.txid} stages both text and bytes for ${file.path}`,
        'choose one representation per staged file',
      )
    }
    staged.add(file.path)
  }
  const staging = stagingDir(input.txid)
  const expected = new Map<string, string>()
  const before = new Map<string, Uint8Array | null>()
  const renamed: string[] = []
  const targetDirectories = new Set<string>()
  let journaledCommitted = false
  let backupMarked = false
  let backupComplete = false
  let rootDisappeared = false
  let rootIdentity: string | null = null

  const rootKey = (info: { dev: number; ino: number; birthtimeMs: number }): string =>
    `${info.dev}:${info.ino}:${info.birthtimeMs}`

  const rootUnavailable = async (): Promise<boolean> => {
    try {
      const info = await store.statRoot()
      return info === null || !info.directory || (rootIdentity !== null && rootKey(info) !== rootIdentity)
    } catch {
      // An unreadable root is not proof it was replaced; keep the normal
      // failure/compensation path.
      return false
    }
  }

  const assertRootPresent = async (): Promise<void> => {
    const info = await store.statRoot()
    if (info === null || !info.directory) {
      rootDisappeared = true
      throw new EngineFaultError(
        ERROR_CODES.TXN_ABORTED,
        'the project root disappeared during the transaction',
        'restore the directory/mount and retry; the engine will not recreate a deleted project',
      )
    }
    const key = rootKey(info)
    if (rootIdentity === null) {
      rootIdentity = key
      return
    }
    if (key !== rootIdentity) {
      rootDisappeared = true
      throw new EngineFaultError(
        ERROR_CODES.TXN_ABORTED,
        'the project root was replaced during the transaction',
        'restore the original directory/mount and retry; the engine will not write into a replacement project',
      )
    }
  }

  try {
    await assertRootPresent()
    for (const file of input.files) {
      // Staging writes create parent directories; re-check identity before each
      // one so a root replaced between writes is never populated.
      await assertRootPresent()
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
    await assertRootPresent()

    // Capture every target's pre-commit bytes before the first rename. This is
    // the compensation log; it exists even when the user-facing backup is off.
    for (const file of input.files) before.set(file.path, await store.readBytes(file.path))

    // Persist the recovery images next to the staged payload. A normal failure
    // can restore from memory and remove staging; a process kill leaves this
    // directory behind, so the documented refuse-and-restore path has source.
    for (const file of input.files) {
      const existing = before.get(file.path)
      if (existing === null || existing === undefined) continue
      await assertRootPresent()
      await store.writeBytes(joinRel(staging, 'before', file.path), existing)
    }

    if (input.backup) {
      // Build the backup inside staging and move the completed directory into
      // backups/ only after every pre-image and the marker are durable. A crash
      // during this window leaves an ordinary staging orphan, not an unmarked
      // directory that retention can never see.
      const stagingBackup = joinRel(staging, 'backup')
      for (const file of input.files) {
        const existing = before.get(file.path)
        if (existing === null || existing === undefined) continue
        await assertRootPresent()
        await store.writeBytes(joinRel(stagingBackup, file.path), existing)
      }
      await assertRootPresent()
      await store.writeText(joinRel(stagingBackup, BACKUP_MARKER), '1')
      await store.writeText(
        joinRel(stagingBackup, BACKUP_MANIFEST),
        `${JSON.stringify(
          {
            schema_version: 1,
            txid: input.txid,
            op: input.op,
            chapter: input.chapter,
            revision: input.revision,
            at: new Date().toISOString(),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            files: input.files
              .filter((file) => before.get(file.path) !== null && before.get(file.path) !== undefined)
              .map((file) => file.path),
          },
          null,
          2,
        )}\n`,
      )
      // `backups/` is project data. Create and resolve it through the store so a
      // symlinked directory cannot redirect the rename outside the project.
      await assertRootPresent()
      await store.ensureDir(BACKUP_DIR)
      await assertRootPresent()
      const targetBackup = await store.safePath(backupDir(input.txid))
      await fs.rename(await store.safePath(stagingBackup), targetBackup)
      await syncDirectory(dirname(targetBackup))
      backupMarked = true
      backupComplete = true
    }
    await assertRootPresent()

    // A crash after this row but before the committed row is recoverable: the
    // pending hashes tell startup whether every rename landed. Without it, the
    // previous committed row would look externally corrupted and block every
    // later write forever.
    const beforeHashes = Object.fromEntries(
      input.files.map((file) => {
        const bytes = before.get(file.path)
        return [
          file.path,
          bytes === null || bytes === undefined ? null : sha256(Buffer.from(bytes).toString('base64')),
        ]
      }),
    )
    await appendJournal(store, {
      txid: input.txid,
      at: new Date().toISOString(),
      op: input.op,
      chapter: input.chapter,
      revision: input.revision,
      files: input.files.map((file) => file.path),
      status: 'pending',
      hashes: Object.fromEntries(expected),
      before: beforeHashes,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    })

    for (const [index, file] of input.files.entries()) {
      // A disappeared root must be caught before mkdir: fs.mkdir(...,
      // {recursive:true}) would silently recreate it and turn a deleted
      // project into a new empty directory.
      await assertRootPresent()
      const from = await store.safePath(joinRel(staging, file.path))
      const to = await store.safePath(file.path)
      await fs.mkdir(dirname(to), { recursive: true })
      targetDirectories.add(dirname(to))
      await fs.rename(from, to)
      renamed.push(file.path)
      if (input.afterRename !== undefined) await input.afterRename(file.path, index)
    }
    await assertRootPresent()
    for (const directory of targetDirectories) await syncDirectory(directory)

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
      // Keep the pre-image hashes on the terminal row too: `novel_reopen`
      // needs them to distinguish "new file" from "backup was pruned".
      before: beforeHashes,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    })
    journaledCommitted = true

    if (input.backup) {
      await pruneBackups(store, input.backupRetention ?? 5).catch(() => undefined)
    }
    await fs.rm(store.path(staging), { recursive: true, force: true }).catch(() => undefined)
  } catch (error) {
    // A root can disappear or be replaced after the last explicit assert (for
    // example between the final rename and readback). Re-check before
    // compensation: restoring through FsStore would otherwise recreate the
    // deleted directory tree or write into a replacement project.
    if (!rootDisappeared) rootDisappeared = await rootUnavailable()
    const rollbackProblem = rootDisappeared ? null : await restoreTargets(store, renamed, before)
    // If compensation was incomplete, keep the staging before/ images: they are
    // the only remaining source for manual recovery.
    if (!rootDisappeared && rollbackProblem === null) {
      await fs.rm(store.path(staging), { recursive: true, force: true }).catch(() => undefined)
    }
    if (!rootDisappeared && input.backup && (!backupMarked || (!backupComplete && renamed.length === 0))) {
      // An unmarked directory, or a marked copy that failed before any rename,
      // is not a recovery source; remove our own partial copy.
      await store.removeTree(backupDir(input.txid)).catch(() => undefined)
    }
    if (!journaledCommitted && !rootDisappeared) {
      await appendJournal(
        store,
        {
          txid: input.txid,
          at: new Date().toISOString(),
          op: input.op,
          chapter: input.chapter,
          revision: input.revision,
          files: input.files.map((file) => file.path),
          status: 'aborted',
          code: error instanceof EngineError ? error.code : ERROR_CODES.TXN_ABORTED,
          reason: error instanceof Error ? error.message : String(error),
        },
        // The pending append that just failed may have left a torn line. If the
        // abort row is appended without repairing it, appendText inserts a
        // newline and turns the fragment into a permanent malformed row.
        { repairTrailing: true },
      ).catch(() => undefined)
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
