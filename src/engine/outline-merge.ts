import {
  ERROR_CODES,
  EngineInputError,
  type ChapterRecord,
  type OutlineChapter,
  type OutlineVolume,
} from '../types.js'
import { stableJson } from '../domain/stable.js'
import { normalizeOutlineChapters, normalizeVolumes, type TitleRule } from './book.js'

export type OutlineArraySemantics = 'upsert' | 'replace' | 'append' | 'remove'

export interface OutlineMergeOptions {
  chapters: unknown
  remove?: unknown
  volumes?: unknown
  remove_volumes?: unknown
  existing: readonly OutlineChapter[]
  archivedChapters: readonly ChapterRecord[]
  existingVolumes: readonly OutlineVolume[]
  titleRule: TitleRule
  totalChapters: number | null
  defaultTargetWords: [number, number]
  now: string
  activeChapter: number
}

export interface OutlineMergeResult {
  chapters: OutlineChapter[]
  volumes: OutlineVolume[]
  added: number[]
  updated: number[]
  removed: number[]
  volumes_added: string[]
  volumes_updated: string[]
  volumes_removed: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, where: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${where} must be a non-empty string`)
  }
  return value.trim()
}

const positiveInteger = (value: unknown, where: string): number => {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${where} must be a positive integer`)
  }
  return value as number
}

const parseChapterNumbers = (value: unknown, field: string): Set<number> => {
  if (value === undefined) return new Set()
  if (!Array.isArray(value)) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${field} must be an array of chapter numbers`)
  }
  const result = new Set<number>()
  for (const [index, raw] of value.entries()) {
    const num = positiveInteger(raw, `${field}[${index}]`)
    if (result.has(num)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${field} contains duplicate chapter ${num}`)
    }
    result.add(num)
  }
  return result
}

const parseVolumeTitles = (value: unknown, field: string): Set<string> => {
  if (value === undefined) return new Set()
  if (!Array.isArray(value)) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${field} must be an array of volume titles`)
  }
  const result = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const title = text(raw, `${field}[${index}]`)
    if (result.has(title)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${field} contains duplicate "${title}"`)
    }
    result.add(title)
  }
  return result
}

const submittedNumbers = (input: unknown): Set<number> => {
  const result = new Set<number>()
  if (!Array.isArray(input)) return result
  for (const raw of input) {
    if (!isRecord(raw) || !Number.isInteger(raw.num) || (raw.num as number) < 1) continue
    result.add(raw.num as number)
  }
  return result
}

const volumeByTitle = (volumes: readonly OutlineVolume[]): Map<string, OutlineVolume> =>
  new Map(volumes.map((volume) => [volume.title, volume]))

/**
 * `volumes` is an upsert keyed by title: omitted volumes survive, and removal
 * requires naming the volume in `remove_volumes`. This deliberately does not
 * accept a positional or full-list replacement.
 */
const mergeVolumes = (
  options: OutlineMergeOptions,
): {
  volumes: OutlineVolume[]
  added: string[]
  updated: string[]
  removed: string[]
} => {
  const removed = parseVolumeTitles(options.remove_volumes, 'remove_volumes')
  if (options.volumes === undefined && removed.size === 0) {
    return { volumes: [...options.existingVolumes], added: [], updated: [], removed: [] }
  }
  if (options.volumes !== undefined && !Array.isArray(options.volumes)) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'volumes must be an array')
  }
  if (options.volumes !== undefined || removed.size > 0) {
    const existingTitles = new Set<string>()
    for (const volume of options.existingVolumes) {
      if (existingTitles.has(volume.title)) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `outline has duplicate volume title "${volume.title}"`,
          'repair the volume titles with novel_amend before submitting volumes',
        )
      }
      existingTitles.add(volume.title)
    }
  }
  const byTitle = volumeByTitle(options.existingVolumes)
  const usedIds = new Set(options.existingVolumes.map((volume) => volume.id))
  let nextGeneratedId = 1
  const generatedId = (): string => {
    while (usedIds.has(`V${nextGeneratedId}`)) nextGeneratedId += 1
    const id = `V${nextGeneratedId}`
    usedIds.add(id)
    nextGeneratedId += 1
    return id
  }
  const submitted = new Set<string>()
  for (const [index, raw] of (options.volumes ?? []).entries()) {
    if (!isRecord(raw)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `volumes[${index}] must be an object`)
    }
    const title = text(raw.title, `volumes[${index}].title`)
    if (submitted.has(title)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `volumes contains duplicate title "${title}"`)
    }
    submitted.add(title)
    const base = byTitle.get(title)
    const explicitId = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : undefined
    const id = base?.id ?? explicitId ?? generatedId()
    if (!usedIds.has(id)) usedIds.add(id)
    byTitle.set(title, { ...(base ?? {}), ...raw, id, title } as unknown as OutlineVolume)
  }
  for (const title of removed) {
    if (submitted.has(title)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `volume "${title}" cannot be both submitted and removed`,
      )
    }
    const existing = byTitle.get(title)
    if (existing === undefined) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `cannot remove volume "${title}": it is not in the plan`,
      )
    }
    if (existing.status === 'done') {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `cannot remove volume "${title}": its status is done`,
        'a completed volume is archive evidence; remove only planned/writing volumes',
      )
    }
    byTitle.delete(title)
  }
  const raw = [...byTitle.values()]
  const volumes = normalizeVolumes(raw, { totalChapters: options.totalChapters })
  const before = volumeByTitle(options.existingVolumes)
  const after = volumeByTitle(volumes)
  return {
    volumes,
    added: [...after.keys()].filter((title) => !before.has(title)),
    updated: [...after.keys()].filter(
      (title) => before.has(title) && stableJson(before.get(title)) !== stableJson(after.get(title)),
    ),
    removed: [...removed],
  }
}

const remapVolume = (
  card: OutlineChapter,
  oldVolumes: readonly OutlineVolume[],
  newVolumes: readonly OutlineVolume[],
): OutlineChapter => {
  if (card.volume === null || card.volume === undefined) return card
  const previous = oldVolumes[card.volume - 1]
  if (previous === undefined) return { ...card, volume: null }
  const nextIndex = newVolumes.findIndex((volume) => volume.title === previous.title)
  if (nextIndex < 0) return { ...card, volume: null }
  const next = newVolumes[nextIndex]!
  return {
    ...card,
    volume: card.num >= next.start_chapter && card.num <= next.end_chapter ? nextIndex + 1 : null,
  }
}

const assertArchivedVolumes = (
  options: OutlineMergeOptions,
  volumes: readonly OutlineVolume[],
  removedTitles: readonly string[],
): void => {
  const removed = new Set(removedTitles)
  const oldByTitle = volumeByTitle(options.existingVolumes)
  const newByTitle = volumeByTitle(volumes)
  for (const record of options.archivedChapters) {
    const card = options.existing.find((entry) => entry.num === record.num)
    if (card === undefined || card.volume === null) continue
    const previous = options.existingVolumes[card.volume - 1]
    if (previous === undefined) continue
    if (removed.has(previous.title) || !oldByTitle.has(previous.title)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `cannot remove volume "${previous.title}": archived chapter ${record.num} belongs to it`,
        'archived cards are evidence; keep the volume or reopen the chapter first',
      )
    }
    const next = newByTitle.get(previous.title)
    if (next === undefined || record.num < next.start_chapter || record.num > next.end_chapter) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `volume "${previous.title}" no longer covers archived chapter ${record.num}`,
        'keep archived chapter ranges inside their existing volume',
      )
    }
  }
}

/**
 * Merge chapter cards by num. Existing planned cards are appended back when
 * omitted; removal is name-only (`remove`), and archived cards are always
 * backfilled from the chapter index.
 */
export const mergeOutline = (options: OutlineMergeOptions): OutlineMergeResult => {
  const submitted = submittedNumbers(options.chapters)
  const removed = parseChapterNumbers(options.remove, 'remove')
  const volumeChanges = mergeVolumes(options)
  assertArchivedVolumes(options, volumeChanges.volumes, volumeChanges.removed)

  const existingByNum = new Map(options.existing.map((card) => [card.num, card]))
  const archivedByNum = new Map(options.archivedChapters.map((record) => [record.num, record]))
  const archivedNums = new Set(archivedByNum.keys())
  for (const num of removed) {
    if (submitted.has(num)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `chapter ${num} cannot be both submitted and removed`,
      )
    }
    if (num === options.activeChapter) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `cannot remove the active chapter ${num} card`,
        'archive or move the active chapter first; the card is required while the chapter is in flight',
      )
    }
    if (archivedByNum.has(num)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `cannot remove chapter ${num}: it is archived`,
        'archived cards are evidence; call novel_reopen first',
      )
    }
    if (existingByNum.get(num)?.status !== 'planned') {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `cannot remove chapter ${num}: it is not a planned card`,
      )
    }
  }

  const normalized = normalizeOutlineChapters(options.chapters, {
    volumes: volumeChanges.volumes,
    existing: options.existing,
    archived: options.archivedChapters,
    titleRule: options.titleRule,
    totalChapters: options.totalChapters,
    defaultTargetWords: options.defaultTargetWords,
    now: options.now,
  })
  const byNum = new Map(normalized.map((card) => [card.num, card]))
  const updated = new Set<number>()
  const added = new Set<number>()

  for (const card of normalized) {
    if (!submitted.has(card.num)) continue
    const before = existingByNum.get(card.num)
    if (before === undefined) added.add(card.num)
    else if (stableJson(before) !== stableJson(card)) updated.add(card.num)
  }

  // Keep every planned card the request did not mention. Archived cards were
  // already backfilled by normalizeOutlineChapters.
  for (const card of options.existing) {
    if (submitted.has(card.num) || removed.has(card.num)) continue
    if (card.status === 'archived' && !archivedNums.has(card.num)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `chapter ${card.num} has an archived outline card but is not in the chapter index`,
        'repair the outline or reopen/archive the chapter so the card status matches the index',
      )
    }
    if (archivedNums.has(card.num)) {
      // normalizeOutlineChapters already rebuilt this card from the chapter
      // index. A stale planned copy must never overwrite that archive evidence.
      if (!byNum.has(card.num)) byNum.set(card.num, { ...card, status: 'archived' })
      continue
    }
    const remapped = remapVolume(card, options.existingVolumes, volumeChanges.volumes)
    if (byNum.has(card.num)) {
      const current = byNum.get(card.num)!
      if (stableJson(current) !== stableJson(remapped)) {
        byNum.set(card.num, remapped)
        if (card.status === 'planned') updated.add(card.num)
      }
    } else {
      byNum.set(card.num, remapped)
      if (card.status === 'planned' && stableJson(card) !== stableJson(remapped)) updated.add(card.num)
    }
  }
  for (const num of removed) byNum.delete(num)

  const chapters = [...byNum.values()].sort((left, right) => left.num - right.num)
  return {
    chapters,
    volumes: volumeChanges.volumes,
    added: [...added].sort((left, right) => left - right),
    updated: [...updated].sort((left, right) => left - right),
    removed: [...removed].sort((left, right) => left - right),
    volumes_added: volumeChanges.added,
    volumes_updated: volumeChanges.updated,
    volumes_removed: volumeChanges.removed,
  }
}
