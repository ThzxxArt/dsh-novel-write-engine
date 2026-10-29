import { BACKUP_DIR } from '../constants.js'
import { joinRel, type FsStore } from './fs.js'

export interface BackupManifest {
  schema_version: 1
  txid: string
  op: string
  chapter: number
  revision: number
  at: string
  reason?: string
  files: string[]
}

export interface BackupEntry {
  name: string
  mtimeMs: number
  txid: string
  op: string | null
  chapter: number | null
  revision: number | null
  at: string | null
  reason: string | null
  files: string[]
}

/** Marks a directory this engine owns; user files under backups/ are never pruned. */
export const BACKUP_MARKER = '.engine-backup'
export const BACKUP_MANIFEST = 'manifest.json'

/** Backup transaction directories, newest first by filesystem mtime. */
export async function listBackups(store: FsStore): Promise<BackupEntry[]> {
  const entries: BackupEntry[] = []
  for (const name of await store.list(BACKUP_DIR)) {
    const info = await store.stat(joinRel(BACKUP_DIR, name))
    if (info === null || !info.isDirectory) continue
    if (!(await store.exists(joinRel(BACKUP_DIR, name, BACKUP_MARKER)))) continue
    const raw = await store.readText(joinRel(BACKUP_DIR, name, BACKUP_MANIFEST))
    let manifest: Partial<BackupManifest> | null = null
    if (raw !== null) {
      try {
        manifest = JSON.parse(raw) as Partial<BackupManifest>
      } catch {
        manifest = null
      }
    }
    const fileNames = Array.isArray(manifest?.files)
      ? manifest.files.filter((file): file is string => typeof file === 'string')
      : []
    entries.push({
      name,
      mtimeMs: info.mtimeMs,
      txid: typeof manifest?.txid === 'string' ? manifest.txid : name,
      op: typeof manifest?.op === 'string' ? manifest.op : null,
      chapter: typeof manifest?.chapter === 'number' ? manifest.chapter : null,
      revision: typeof manifest?.revision === 'number' ? manifest.revision : null,
      at: typeof manifest?.at === 'string' ? manifest.at : null,
      reason: typeof manifest?.reason === 'string' ? manifest.reason : null,
      files: fileNames,
    })
  }
  return entries.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

/** Read one manifest, refusing a directory this engine did not create. */
export async function readBackupManifest(store: FsStore, name: string): Promise<BackupManifest | null> {
  if (!/^[0-9a-f-]{36}$/i.test(name)) return null
  if (!(await store.exists(joinRel(BACKUP_DIR, name, BACKUP_MARKER)))) return null
  const raw = await store.readText(joinRel(BACKUP_DIR, name, BACKUP_MANIFEST))
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<BackupManifest>
    if (
      value.schema_version !== 1 ||
      typeof value.txid !== 'string' ||
      typeof value.op !== 'string' ||
      typeof value.chapter !== 'number' ||
      typeof value.revision !== 'number' ||
      typeof value.at !== 'string' ||
      !Array.isArray(value.files)
    ) {
      return null
    }
    return {
      schema_version: 1,
      txid: value.txid,
      op: value.op,
      chapter: value.chapter,
      revision: value.revision,
      at: value.at,
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
      files: value.files.filter((file): file is string => typeof file === 'string'),
    }
  } catch {
    return null
  }
}

/**
 * Keep the newest `keep` backup directories. Only directories directly under
 * `backups/` are considered, and only directories this engine created are
 * removed; nothing outside `backups/` is touched.
 */
export async function pruneBackups(store: FsStore, keep: number): Promise<string[]> {
  const retention = Math.max(1, Math.floor(keep))
  const entries = await listBackups(store)
  if (entries.length <= retention) return []
  const removed: string[] = []
  for (const entry of entries.slice(retention)) {
    await store.removeTree(joinRel(BACKUP_DIR, entry.name))
    removed.push(entry.name)
  }
  return removed
}
