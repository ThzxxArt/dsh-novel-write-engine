import { BACKUP_DIR } from '../constants.js'
import { joinRel, type FsStore } from './fs.js'

export interface BackupEntry {
  name: string
  mtimeMs: number
}

/** Marks a directory this engine owns; user files under backups/ are never pruned. */
export const BACKUP_MARKER = '.engine-backup'

/** Backup transaction directories, newest first by filesystem mtime. */
export async function listBackups(store: FsStore): Promise<BackupEntry[]> {
  const entries: BackupEntry[] = []
  for (const name of await store.list(BACKUP_DIR)) {
    const info = await store.stat(joinRel(BACKUP_DIR, name))
    if (info === null || !info.isDirectory) continue
    if (!(await store.exists(joinRel(BACKUP_DIR, name, BACKUP_MARKER)))) continue
    entries.push({ name, mtimeMs: info.mtimeMs })
  }
  return entries.sort((left, right) => right.mtimeMs - left.mtimeMs)
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
