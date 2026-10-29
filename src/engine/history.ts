import { HISTORY_DIR, HISTORY_KINDS, type HistoryKind } from '../constants.js'
import { compareText } from '../domain/stable.js'
import { joinRel, type FsStore } from '../store/fs.js'

export interface HistoryEntry {
  kind: HistoryKind
  chapter: number
  revision: number
  path: string
  chars: number
}

const PATTERN =
  /^ch(?<chapter>\d{3,})\.r(?<revision>\d+)\.(?<suffix>review\.yaml|check\.yaml|chapter\.yaml|md)$/

const kindOf = (directory: HistoryKind, suffix: string): boolean => {
  if (directory === 'reviews') return suffix === 'review.yaml'
  if (directory === 'checks') return suffix === 'check.yaml'
  if (directory === 'plans') return suffix === 'chapter.yaml'
  return suffix === 'md'
}

/**
 * List prior versions, newest revision first. Files beyond the visible cap are
 * still on disk: history is evidence, not a cache, and this function never
 * deletes it.
 */
export async function listHistory(store: FsStore, chapter?: number): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = []
  for (const kind of HISTORY_KINDS) {
    const names = await store.list(joinRel(HISTORY_DIR, kind))
    for (const name of names) {
      const match = PATTERN.exec(name)
      if (match === null) continue
      const suffix = match.groups!.suffix
      if (!kindOf(kind, suffix)) continue
      const num = Number(match.groups!.chapter)
      const revision = Number(match.groups!.revision)
      if (chapter !== undefined && num !== chapter) continue
      const path = joinRel(HISTORY_DIR, kind, name)
      const text = await store.readText(path)
      entries.push({ kind, chapter: num, revision, path, chars: text?.length ?? 0 })
    }
  }
  return entries.sort(
    (left, right) =>
      left.chapter - right.chapter || right.revision - left.revision || compareText(left.kind, right.kind),
  )
}

/** Read every prior version of one kind for a chapter, oldest first. */
export async function historyTexts(
  store: FsStore,
  kind: HistoryKind,
  chapter: number,
  entries?: readonly HistoryEntry[],
): Promise<Array<{ path: string; revision: number; text: string }>> {
  const source = entries ?? (await listHistory(store, chapter))
  const entriesForChapter = source.filter((entry) => entry.kind === kind && entry.chapter === chapter)
  const result: Array<{ path: string; revision: number; text: string }> = []
  for (const entry of entriesForChapter) {
    const text = await store.readText(entry.path)
    if (text !== null) result.push({ path: entry.path, revision: entry.revision, text })
  }
  return result.sort((left, right) => left.revision - right.revision)
}
