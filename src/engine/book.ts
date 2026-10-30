import { parse as parseYaml } from 'yaml'
import { LIMITS } from '../constants.js'
import { ERROR_CODES, EngineFaultError, EngineInputError } from '../types.js'
import type {
  BookPlan,
  ChapterRecord,
  Genre,
  OutlineChapter,
  OutlineDocument,
  OutlineProgress,
  OutlineVolume,
  Platform,
  SceneType,
  WorldbookBackstory,
  WorldbookCharacter,
  WorldbookDocument,
  WorldbookFact,
  WorldbookFaction,
  WorldbookGlossary,
  WorldbookLocation,
  WorldbookRule,
} from '../types.js'

/** Title constraints come from the compiled rulepack; no second copy lives here. */
export interface TitleRule {
  pattern: string
  min_chars: number
  max_chars: number
}

export interface BookPatch {
  premise?: string
  logline?: string
  themes?: string[]
  tone?: string
  pov?: string
  audience?: string
  selling_points?: string[]
  ending?: string
  strict?: boolean
  /** Internal provenance for an explicit strict choice. */
  strict_explicit?: boolean
}

export interface VolumeInput {
  id?: string
  title: string
  start_chapter: number
  end_chapter: number
  goal?: string
  arc?: string
  climax?: string
  status?: OutlineVolume['status']
}

export interface OutlineChapterInput {
  num: number
  volume?: number | null
  title: string
  scene_type: SceneType
  goal: string
  conflict: string
  hook: string
  cast?: string[]
  target_words: [number, number]
  notes?: string
}

export interface OutlineInput {
  book?: BookPatch
  volumes?: VolumeInput[]
  chapters?: OutlineChapterInput[]
  strict?: boolean
  /** Explicit deletion list; omitted cards are preserved. */
  remove?: number[]
  /** Explicit volume deletion list, keyed by title. */
  remove_volumes?: string[]
  /** Preview changes without writing or journaling. */
  dry_run?: boolean
}

export interface WorldbookPatch {
  premise?: string
  setting?: string
  rules?: WorldbookRule[]
  factions?: WorldbookFaction[]
  locations?: WorldbookLocation[]
  characters?: WorldbookCharacter[]
  glossary?: WorldbookGlossary[]
  backstory?: WorldbookBackstory[]
  facts?: WorldbookFact[]
  themes?: string[]
}

export interface OutlineParseResult {
  book: BookPatch
  volumes: VolumeInput[]
  chapters: OutlineChapterInput[]
  warnings: string[]
}

export interface ParsedOutlineInput {
  format: 'markdown' | 'yaml' | 'json'
  book: BookPatch
  volumes: VolumeInput[]
  chapters: OutlineChapterInput[]
  warnings: string[]
}

const LENIENT_TITLE_PREFIX = /^第\s*\d+\s*章\s*/

const text = (value: unknown, where: string, max = LIMITS.maxOutlineTextFieldChars): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${where} must be a non-empty string`)
  }
  const trimmed = value.trim()
  if (Array.from(trimmed).length > max) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `${where} is ${Array.from(trimmed).length} characters; limit is ${max}`,
    )
  }
  return trimmed
}

const optionalText = (value: unknown, where: string, max = LIMITS.maxOutlineTextFieldChars): string => {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${where} must be a string`)
  }
  const trimmed = value.trim()
  if (Array.from(trimmed).length > max) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `${where} is ${Array.from(trimmed).length} characters; limit is ${max}`,
    )
  }
  return trimmed
}

const stringArray = (value: unknown, where: string, maxItems = 20): string[] => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${where} must be an array of strings`)
  }
  if (value.length > maxItems) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `${where} contains ${value.length} items; limit is ${maxItems}`,
    )
  }
  const seen = new Set<string>()
  return value.map((item, index) => {
    const entry = text(item, `${where}[${index}]`, 200)
    if (seen.has(entry)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${where} contains duplicate "${entry}"`)
    }
    seen.add(entry)
    return entry
  })
}

const positiveInteger = (value: unknown, where: string): number => {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${where} must be a positive integer`)
  }
  return value as number
}

const wordPair = (value: unknown, where: string): [number, number] => {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `${where} must be [min, max] positive integers with min <= max`,
    )
  }
  const [min, max] = value
  if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max < min) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `${where} must be [min, max] positive integers with min <= max`,
    )
  }
  return [min, max]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Remove a leading 第N章 prefix; stored titles are bodies. */
export function stripChapterPrefix(title: string): string {
  return title.replace(LENIENT_TITLE_PREFIX, '').trim()
}

/** Validate a chapter title body against the same rule P2/P3 use. */
export function chapterTitleBody(title: unknown, rule: TitleRule, where = 'title'): string {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${where} must not be empty`)
  }
  const body = stripChapterPrefix(title)
  const length = Array.from(body).length
  if (length < rule.min_chars || length > rule.max_chars) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `${where} body must be ${rule.min_chars}..${rule.max_chars} characters, got ${length}`,
      'use the title body only; the engine adds the 第N章 prefix',
    )
  }
  return body
}

/** The default empty outline. New projects start here. */
export function emptyBookPlan(): BookPlan {
  return {
    premise: '',
    logline: '',
    themes: [],
    tone: '',
    pov: '',
    audience: '',
    selling_points: [],
    ending: '',
    strict: false,
    strict_explicit: false,
  }
}

/** True when the blueprint has any human-authored planning content. */
export function bookPlanPresent(book: BookPlan): boolean {
  return (
    book.premise !== '' ||
    book.logline !== '' ||
    book.themes.length > 0 ||
    book.tone !== '' ||
    book.pov !== '' ||
    book.audience !== '' ||
    book.selling_points.length > 0 ||
    book.ending !== ''
  )
}

export function emptyOutline(now: string): OutlineDocument {
  return {
    schema_version: 1,
    updated_at: now,
    book: emptyBookPlan(),
    volumes: [],
    chapters: [],
  }
}

export function emptyWorldbook(now: string): WorldbookDocument {
  return {
    schema_version: 1,
    updated_at: now,
    premise: '',
    setting: '',
    rules: [],
    factions: [],
    locations: [],
    characters: [],
    glossary: [],
    backstory: [],
    facts: [],
    themes: [],
  }
}

/** One card by chapter number, or null. */
export function outlineCard(document: OutlineDocument, chapter: number): OutlineChapter | null {
  return document.chapters.find((card) => card.num === chapter) ?? null
}

/** A compact progress view used by status, the panel and the report. */
export function outlineSummary(
  document: OutlineDocument,
  archivedCount: number,
  target: number | null = null,
  /** Archived chapter numbers, so cardCoverage measures per-chapter matching. */
  archivedNumbers?: readonly number[],
): OutlineProgress {
  const planned = document.chapters.filter((card) => card.status === 'planned').length
  const archived = document.chapters.filter((card) => card.status === 'archived').length
  const total = document.chapters.length
  const missingCards = target === null ? 0 : Math.max(0, target - total)
  const plannedCoverage = target === null || target === 0 ? null : Math.min(1, total / target)
  const archivedCoverage = target === null || target === 0 ? null : Math.min(1, archived / target)
  const archivedSet = archivedNumbers === undefined ? null : new Set(archivedNumbers)
  const matchedCards =
    archivedSet === null
      ? archived
      : document.chapters.filter((card) => card.status === 'archived' && archivedSet.has(card.num)).length
  const archivedDenominator = archivedSet === null ? archivedCount : archivedSet.size
  const cardCoverage = archivedDenominator === 0 ? 1 : Math.min(1, matchedCards / archivedDenominator)
  return {
    present: bookPlanPresent(document.book) || document.volumes.length > 0 || total > 0,
    target,
    total,
    planned,
    archived,
    missingCards,
    plannedCoverage,
    archivedCoverage,
    coverage: plannedCoverage ?? (archivedDenominator === 0 ? 0 : cardCoverage),
    cardCoverage,
    volumes: document.volumes.length,
  }
}

const BOOK_PATCH_KEYS = new Set([
  'premise',
  'logline',
  'themes',
  'tone',
  'pov',
  'audience',
  'selling_points',
  'ending',
  'strict',
  'strict_explicit',
])

/** Apply a partial book patch; omitted fields keep their existing value. */
export function mergeBookPlan(existing: BookPlan, patch: BookPatch | undefined): BookPlan {
  if (patch === undefined) return { ...existing }
  if (!isRecord(patch)) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'book must be an object')
  }
  for (const key of Object.keys(patch)) {
    if (!BOOK_PATCH_KEYS.has(key)) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `book has unknown field "${key}"`,
        `allowed: ${[...BOOK_PATCH_KEYS].join(', ')}`,
      )
    }
  }
  const result: BookPlan = { ...existing }
  for (const key of ['premise', 'logline', 'tone', 'pov', 'audience', 'ending'] as const) {
    if (patch[key] !== undefined) result[key] = optionalText(patch[key], `book.${key}`, 2_000)
  }
  for (const key of ['themes', 'selling_points'] as const) {
    if (patch[key] !== undefined) result[key] = stringArray(patch[key], `book.${key}`)
  }
  if (patch.strict !== undefined) {
    if (typeof patch.strict !== 'boolean') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'book.strict must be a boolean')
    }
    result.strict = patch.strict
    result.strict_explicit = true
  }
  if (patch.strict_explicit !== undefined) {
    if (typeof patch.strict_explicit !== 'boolean') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'book.strict_explicit must be a boolean')
    }
    result.strict_explicit = patch.strict_explicit
  }
  return result
}

/** Validate and normalize the volume structure. */
export function normalizeVolumes(
  input: unknown,
  options: { totalChapters: number | null; rejectDuplicateTitles?: boolean } = {
    totalChapters: null,
  },
): OutlineVolume[] {
  if (!Array.isArray(input)) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'volumes must be an array')
  }
  if (input.length > LIMITS.maxOutlineVolumes) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `volumes contains ${input.length} items; limit is ${LIMITS.maxOutlineVolumes}`,
    )
  }
  const volumes: OutlineVolume[] = input.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `volumes[${index}] must be an object`)
    }
    const start = positiveInteger(raw.start_chapter, `volumes[${index}].start_chapter`)
    const end = positiveInteger(raw.end_chapter, `volumes[${index}].end_chapter`)
    if (end < start) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `volumes[${index}] end_chapter ${end} is before start_chapter ${start}`,
      )
    }
    const status = raw.status ?? 'planned'
    if (status !== 'planned' && status !== 'writing' && status !== 'done') {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `volumes[${index}].status must be planned|writing|done`,
      )
    }
    return {
      id: typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : '',
      title: text(raw.title, `volumes[${index}].title`, 120),
      start_chapter: start,
      end_chapter: end,
      goal: optionalText(raw.goal, `volumes[${index}].goal`),
      arc: optionalText(raw.arc, `volumes[${index}].arc`),
      climax: optionalText(raw.climax, `volumes[${index}].climax`),
      status,
    }
  })
  // Preserve explicit ids, then fill missing ids from the lowest free Vn. A
  // positional default would collide when an existing V2 is submitted before
  // a new first volume (remove V1 + add a new V1 in a later call).
  const usedIds = new Set<string>()
  const usedTitles = new Set<string>()
  for (const volume of volumes) {
    if (usedTitles.has(volume.title) && options.rejectDuplicateTitles !== false) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `duplicate volume title "${volume.title}"`)
    }
    usedTitles.add(volume.title)
    if (volume.id === '') continue
    if (usedIds.has(volume.id)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `duplicate volume id "${volume.id}"`)
    }
    usedIds.add(volume.id)
  }
  let nextId = 1
  for (const volume of volumes) {
    if (volume.id !== '') continue
    while (usedIds.has(`V${nextId}`)) nextId += 1
    volume.id = `V${nextId}`
    usedIds.add(volume.id)
    nextId += 1
  }
  volumes.sort(
    (left, right) => left.start_chapter - right.start_chapter || left.end_chapter - right.end_chapter,
  )
  const ids = new Set<string>()
  for (const [index, volume] of volumes.entries()) {
    if (ids.has(volume.id)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `duplicate volume id "${volume.id}"`)
    }
    ids.add(volume.id)
    const previous = volumes[index - 1]
    if (previous !== undefined && volume.start_chapter <= previous.end_chapter) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `volume "${volume.title}" overlaps the previous volume (${volume.start_chapter} <= ${previous.end_chapter})`,
        'volume ranges must be disjoint',
      )
    }
    if (previous !== undefined && volume.start_chapter !== previous.end_chapter + 1) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `volume "${volume.title}" starts at ${volume.start_chapter}, but the previous volume ends at ${previous.end_chapter}; volume ranges must be contiguous`,
        'adjacent volumes must touch; leave unassigned chapters outside the volume list',
      )
    }
    if (options.totalChapters !== null && volume.end_chapter > options.totalChapters) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `volume "${volume.title}" ends at ${volume.end_chapter}, beyond total_chapters ${options.totalChapters}`,
        'extend total_chapters first if the book is longer than planned',
      )
    }
  }
  return volumes
}

/** Recompute a card's volume after volume ranges change; never invents one. */
export function volumeForChapter(
  volumes: readonly OutlineVolume[],
  chapter: number,
  explicit: number | null | undefined,
): number | null {
  if (explicit !== null && explicit !== undefined) {
    const volume = volumes[explicit - 1]
    if (volume !== undefined && chapter >= volume.start_chapter && chapter <= volume.end_chapter) {
      return explicit
    }
  }
  const index = volumes.findIndex(
    (volume) => chapter >= volume.start_chapter && chapter <= volume.end_chapter,
  )
  return index === -1 ? null : index + 1
}

const volumeNumberFor = (
  volumes: readonly OutlineVolume[],
  chapter: number,
  explicit: number | null | undefined,
): number | null => {
  if (explicit !== undefined && explicit !== null) {
    if (!Number.isInteger(explicit) || explicit < 1 || explicit > volumes.length) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `chapter ${chapter} volume ${String(explicit)} does not exist (1..${volumes.length})`,
      )
    }
    const volume = volumes[explicit - 1]!
    if (chapter < volume.start_chapter || chapter > volume.end_chapter) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `chapter ${chapter} is outside volume ${explicit} (${volume.start_chapter}..${volume.end_chapter})`,
      )
    }
    return explicit
  }
  const match = volumes.findIndex(
    (volume) => chapter >= volume.start_chapter && chapter <= volume.end_chapter,
  )
  return match === -1 ? null : match + 1
}

const AUTO_CARD_CAST_LIMIT = 8
const AUTO_CARD_CAST_CHARS = 200
const AUTO_CARD_GOAL_CHARS = LIMITS.maxOutlineTextFieldChars

/**
 * A card the engine creates from an archived record is a derived view, not a
 * new source of truth. The record may carry a wider cast or a longer event than
 * the outline grammar allows, so normalize that data here instead of writing a
 * document that the next load will reject. Explicit cards are still validated
 * strictly; this helper is only for cards the archive/reopen operation creates.
 */
export const autoCardCast = (record: ChapterRecord): string[] => {
  const seen = new Set<string>()
  const names: string[] = []
  for (const value of record.summary.characters_appeared) {
    const name = value.trim()
    if (name === '' || Array.from(name).length > AUTO_CARD_CAST_CHARS || seen.has(name)) continue
    seen.add(name)
    names.push(name)
    if (names.length === AUTO_CARD_CAST_LIMIT) break
  }
  return names
}

const autoCardGoal = (record: ChapterRecord): string => {
  const raw = (record.summary.events[0] ?? '').trim()
  const source = raw === '' ? '已归档章节' : raw
  const chars = Array.from(source)
  return chars.length <= AUTO_CARD_GOAL_CHARS ? source : chars.slice(0, AUTO_CARD_GOAL_CHARS).join('')
}

const defaultCardForRecord = (record: ChapterRecord, targetWords: [number, number]): OutlineChapter => ({
  num: record.num,
  volume: null,
  title: stripChapterPrefix(record.title),
  scene_type: record.scene_type,
  goal: autoCardGoal(record),
  conflict: '归档时自动补卡：待补充冲突',
  hook: '归档时自动补卡：待补充钩子',
  cast: autoCardCast(record),
  target_words: targetWords,
  notes: '',
  status: 'archived',
  archived_at: null,
  word_count: record.word_count,
  score: record.score,
})

/** Validate and normalize cards, preserving every archived chapter. */
export function normalizeOutlineChapters(
  input: unknown,
  options: {
    volumes: readonly OutlineVolume[]
    existing: readonly OutlineChapter[]
    archived: readonly ChapterRecord[]
    titleRule: TitleRule
    totalChapters: number | null
    defaultTargetWords: [number, number]
    now: string
  },
): OutlineChapter[] {
  if (!Array.isArray(input)) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'chapters must be an array')
  }
  if (input.length > LIMITS.maxOutlineChapters) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `chapters contains ${input.length} items; limit is ${LIMITS.maxOutlineChapters}`,
    )
  }
  const existing = new Map(options.existing.map((card) => [card.num, card]))
  const archived = new Map(options.archived.map((record) => [record.num, record]))
  const normalized = new Map<number, OutlineChapter>()
  for (const [index, raw] of input.entries()) {
    if (!isRecord(raw)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `chapters[${index}] must be an object`)
    }
    const num = positiveInteger(raw.num, `chapters[${index}].num`)
    if (options.totalChapters !== null && num > options.totalChapters) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `chapter ${num} exceeds total_chapters ${options.totalChapters}`,
        'raise total_chapters with novel_blueprint before planning a longer book',
      )
    }
    if (normalized.has(num)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `chapter ${num} appears more than once`)
    }
    const record = archived.get(num)
    const before = existing.get(num)
    if (record !== undefined) {
      // Archived cards are evidence, not plans. The request may repeat them,
      // but it may not rewrite history.
      if (raw.status !== undefined && raw.status !== 'archived') {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `chapter ${num} is archived; its status cannot change`,
          'call novel_reopen first if the manuscript must be revised',
        )
      }
      const base = before ?? defaultCardForRecord(record, options.defaultTargetWords)
      const title = chapterTitleBody(raw.title ?? base.title, options.titleRule, `chapter ${num} title`)
      if (title !== base.title) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `chapter ${num} is archived; its title cannot change (${base.title} -> ${title})`,
          'call novel_reopen first if the manuscript must be revised',
        )
      }
      if (raw.scene_type !== undefined && raw.scene_type !== base.scene_type) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `chapter ${num} is archived; its scene_type cannot change`,
          'call novel_reopen first if the manuscript must be revised',
        )
      }
      const target =
        raw.target_words === undefined
          ? base.target_words
          : wordPair(raw.target_words, `chapters[${index}].target_words`)
      if (target[0] !== base.target_words[0] || target[1] !== base.target_words[1]) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `chapter ${num} is archived; its target_words cannot change`,
          'call novel_reopen first if the manuscript must be revised',
        )
      }
      const cast = raw.cast === undefined ? base.cast : stringArray(raw.cast, `chapters[${index}].cast`, 8)
      if (cast.length !== base.cast.length || cast.some((name) => !base.cast.includes(name))) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `chapter ${num} is archived; its cast cannot change`,
          'call novel_reopen first if the manuscript must be revised',
        )
      }
      normalized.set(num, {
        ...base,
        goal:
          raw.goal === undefined || raw.goal === base.goal
            ? base.goal
            : text(raw.goal, `chapter ${num} goal`),
        conflict:
          raw.conflict === undefined || raw.conflict === base.conflict
            ? base.conflict
            : text(raw.conflict, `chapter ${num} conflict`),
        hook:
          raw.hook === undefined || raw.hook === base.hook
            ? base.hook
            : text(raw.hook, `chapter ${num} hook`),
        notes:
          raw.notes === undefined || raw.notes === base.notes
            ? base.notes
            : optionalText(raw.notes, `chapter ${num} notes`, LIMITS.maxOutlineNotesChars),
        volume: volumeForChapter(
          options.volumes,
          num,
          raw.volume === undefined ? base.volume : (raw.volume as number | null),
        ),
        status: 'archived',
        archived_at: base.archived_at ?? record.archived_at ?? null,
        word_count: record.word_count,
        score: record.score,
      })
      continue
    }
    if (raw.status === 'archived') {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `chapter ${num} claims status archived but it is not in the chapter index`,
      )
    }
    if (raw.status !== undefined && raw.status !== 'planned') {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `chapter ${num} has status ${String(raw.status)}; new cards must be planned|archived`,
      )
    }
    const title = chapterTitleBody(raw.title, options.titleRule, `chapters[${index}].title`)
    if (!['战斗/动作章', '日常过渡章', '情感爆发章', '纯叙事章'].includes(raw.scene_type as string)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `chapters[${index}].scene_type is invalid`)
    }
    const previousCard = existing.get(num)
    const cast =
      raw.cast == null && previousCard?.status === 'planned'
        ? previousCard.cast
        : stringArray(raw.cast, `chapters[${index}].cast`, 8)
    normalized.set(num, {
      num,
      volume:
        raw.volume !== undefined
          ? volumeNumberFor(options.volumes, num, raw.volume as number | null)
          : previousCard?.status === 'planned'
            ? volumeForChapter(options.volumes, num, previousCard.volume)
            : volumeNumberFor(options.volumes, num, undefined),
      title,
      scene_type: raw.scene_type as SceneType,
      goal: text(raw.goal, `chapters[${index}].goal`),
      conflict: text(raw.conflict, `chapters[${index}].conflict`),
      hook: text(raw.hook, `chapters[${index}].hook`),
      cast,
      target_words: wordPair(raw.target_words, `chapters[${index}].target_words`),
      notes:
        raw.notes == null && previousCard?.status === 'planned'
          ? previousCard.notes
          : optionalText(raw.notes, `chapters[${index}].notes`, LIMITS.maxOutlineNotesChars),
      status: 'planned',
      archived_at: null,
      word_count: null,
      score: null,
    })
  }
  // Every archived chapter must appear, even when the request forgot it. A
  // deleted archive card would make the book progress lie.
  for (const record of options.archived) {
    if (normalized.has(record.num)) continue
    const base = existing.get(record.num) ?? defaultCardForRecord(record, options.defaultTargetWords)
    normalized.set(record.num, {
      ...base,
      volume: volumeForChapter(options.volumes, record.num, base.volume),
      status: 'archived',
      archived_at: base.archived_at ?? options.now,
      word_count: record.word_count,
      score: record.score,
    })
  }
  return [...normalized.values()].sort((left, right) => left.num - right.num)
}

/** Validate a document loaded from disk. Throws a fault, not an input error. */
export function validateOutlineDocument(
  value: unknown,
  options: { titleRule: TitleRule; totalChapters: number | null },
): OutlineDocument {
  if (!isRecord(value)) {
    throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, 'outline/outline.yaml must be a mapping')
  }
  try {
    if (value.schema_version !== 1) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `outline/outline.yaml schema_version must be 1, got ${String(value.schema_version)}`,
      )
    }
    const allowedTopLevel = new Set(['schema_version', 'updated_at', 'book', 'volumes', 'chapters'])
    for (const key of Object.keys(value)) {
      if (!allowedTopLevel.has(key)) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `outline/outline.yaml has unknown key "${key}"`,
        )
      }
    }
    if (typeof value.updated_at !== 'string' || value.updated_at.trim() === '') {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'outline/outline.yaml updated_at must be a string',
      )
    }
    if (!isRecord(value.book)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'outline/outline.yaml book must be a mapping')
    }
    const allowedBook = new Set([
      'premise',
      'logline',
      'themes',
      'tone',
      'pov',
      'audience',
      'selling_points',
      'ending',
      'strict',
      'strict_explicit',
    ])
    for (const key of Object.keys(value.book)) {
      if (!allowedBook.has(key)) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `outline/outline.yaml book has unknown key "${key}"`,
        )
      }
    }
    const book = mergeBookPlan(emptyBookPlan(), value.book as BookPatch)
    const volumes = normalizeVolumes(value.volumes, {
      totalChapters: options.totalChapters,
      rejectDuplicateTitles: false,
    })
    if (!Array.isArray(value.chapters)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'chapters must be an array')
    }
    if (value.chapters.length > LIMITS.maxOutlineChapters) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `chapters contains ${value.chapters.length} items; limit is ${LIMITS.maxOutlineChapters}`,
      )
    }
    const chapters: OutlineChapter[] = []
    const seen = new Set<number>()
    for (const [index, raw] of value.chapters.entries()) {
      if (!isRecord(raw)) {
        throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `chapters[${index}] must be an object`)
      }
      const num = positiveInteger(raw.num, `chapters[${index}].num`)
      if (options.totalChapters !== null && num > options.totalChapters) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `chapter ${num} exceeds total_chapters ${options.totalChapters}`,
        )
      }
      if (seen.has(num)) {
        throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `chapter ${num} appears more than once`)
      }
      seen.add(num)
      const status = raw.status
      if (status !== 'planned' && status !== 'archived') {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `chapters[${index}].status must be planned|archived`,
        )
      }
      const scene = raw.scene_type
      if (!['战斗/动作章', '日常过渡章', '情感爆发章', '纯叙事章'].includes(scene as string)) {
        throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `chapters[${index}].scene_type is invalid`)
      }
      const planned = status === 'planned'
      const archivedAt = raw.archived_at ?? null
      const wordCount = raw.word_count ?? null
      const score = raw.score ?? null
      if (planned && (archivedAt !== null || wordCount !== null || score !== null)) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `chapter ${num} is planned but carries archived_at/word_count/score`,
        )
      }
      if (archivedAt !== null && typeof archivedAt !== 'string') {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `chapter ${num} archived_at must be a string or null`,
        )
      }
      if (wordCount !== null && typeof wordCount !== 'number') {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `chapter ${num} word_count must be a number or null`,
        )
      }
      if (score !== null && typeof score !== 'number') {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `chapter ${num} score must be a number or null`,
        )
      }
      chapters.push({
        num,
        volume: volumeNumberFor(volumes, num, raw.volume as number | null | undefined),
        title: chapterTitleBody(raw.title, options.titleRule, `chapters[${index}].title`),
        scene_type: scene as SceneType,
        goal: planned
          ? text(raw.goal, `chapters[${index}].goal`)
          : optionalText(raw.goal, `chapters[${index}].goal`),
        conflict: planned
          ? text(raw.conflict, `chapters[${index}].conflict`)
          : optionalText(raw.conflict, `chapters[${index}].conflict`),
        hook: planned
          ? text(raw.hook, `chapters[${index}].hook`)
          : optionalText(raw.hook, `chapters[${index}].hook`),
        cast: stringArray(raw.cast, `chapters[${index}].cast`, 8),
        target_words: wordPair(raw.target_words, `chapters[${index}].target_words`),
        notes: optionalText(raw.notes, `chapters[${index}].notes`, LIMITS.maxOutlineNotesChars),
        status,
        archived_at: archivedAt as string | null,
        word_count: wordCount as number | null,
        score: score as number | null,
      })
    }
    chapters.sort((left, right) => left.num - right.num)
    return {
      schema_version: 1,
      updated_at: value.updated_at,
      book,
      volumes,
      chapters,
    }
  } catch (error) {
    if (error instanceof EngineInputError) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_INVALID,
        `outline/outline.yaml: ${error.message}`,
        error.hint,
        {
          cause: error,
        },
      )
    }
    throw error
  }
}

const uniqueNames = (values: readonly { name?: string }[], where: string): void => {
  const seen = new Set<string>()
  for (const value of values) {
    const name = value.name ?? ''
    if (seen.has(name)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${where} contains duplicate "${name}"`)
    }
    seen.add(name)
  }
}

/** Validate and replace the requested worldbook sections. */
export function mergeWorldbook(
  existing: WorldbookDocument,
  patch: WorldbookPatch | undefined,
  now: string,
): WorldbookDocument {
  if (patch === undefined) return { ...existing, updated_at: now }
  if (!isRecord(patch)) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'worldbook must be an object')
  }
  const result: WorldbookDocument = {
    ...existing,
    updated_at: now,
    rules: [...existing.rules],
    factions: [...existing.factions],
    locations: [...existing.locations],
    characters: [...existing.characters],
    glossary: [...existing.glossary],
    backstory: [...existing.backstory],
    facts: [...(existing.facts ?? [])],
    themes: [...existing.themes],
  }
  if (patch.premise !== undefined)
    result.premise = optionalText(patch.premise, 'premise', LIMITS.maxWorldbookTextChars)
  if (patch.setting !== undefined)
    result.setting = optionalText(patch.setting, 'setting', LIMITS.maxWorldbookTextChars)
  if (patch.themes !== undefined) result.themes = stringArray(patch.themes, 'themes')

  const records = (value: unknown, key: string): Record<string, unknown>[] => {
    if (!Array.isArray(value)) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${key} must be an array`)
    }
    if (value.length > LIMITS.maxWorldbookEntries) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `${key} contains ${value.length} items; limit is ${LIMITS.maxWorldbookEntries}`,
      )
    }
    return value.map((raw, index) => {
      if (!isRecord(raw)) {
        throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `${key}[${index}] must be an object`)
      }
      return raw
    })
  }

  if (patch.rules !== undefined) {
    result.rules = records(patch.rules, 'rules').map((raw, index) => ({
      name: text(raw.name, `rules[${index}].name`, 120),
      description: text(raw.description, `rules[${index}].description`, LIMITS.maxWorldbookTextChars),
    }))
    uniqueNames(result.rules, 'rules')
  }
  if (patch.factions !== undefined) {
    result.factions = records(patch.factions, 'factions').map((raw, index) => ({
      name: text(raw.name, `factions[${index}].name`, 120),
      description: text(raw.description, `factions[${index}].description`, LIMITS.maxWorldbookTextChars),
      goal: optionalText(raw.goal, `factions[${index}].goal`),
    }))
    uniqueNames(result.factions, 'factions')
  }
  if (patch.locations !== undefined) {
    result.locations = records(patch.locations, 'locations').map((raw, index) => {
      const capacity = raw.capacity ?? 0
      if (!Number.isInteger(capacity) || (capacity as number) < 0) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `locations[${index}].capacity must be a non-negative integer`,
        )
      }
      return {
        name: text(raw.name, `locations[${index}].name`, 120),
        description: text(raw.description, `locations[${index}].description`, LIMITS.maxWorldbookTextChars),
        layout: optionalText(raw.layout, `locations[${index}].layout`),
        capacity: capacity as number,
      }
    })
    uniqueNames(result.locations, 'locations')
  }
  if (patch.characters !== undefined) {
    result.characters = records(patch.characters, 'characters').map((raw, index) => ({
      name: text(raw.name, `characters[${index}].name`, 120),
      role: text(raw.role, `characters[${index}].role`, 60),
      description: text(raw.description, `characters[${index}].description`, LIMITS.maxWorldbookTextChars),
      arc: optionalText(raw.arc, `characters[${index}].arc`),
    }))
    uniqueNames(result.characters, 'characters')
  }
  if (patch.glossary !== undefined) {
    result.glossary = records(patch.glossary, 'glossary').map((raw, index) => ({
      term: text(raw.term, `glossary[${index}].term`, 120),
      definition: text(raw.definition, `glossary[${index}].definition`, LIMITS.maxWorldbookTextChars),
    }))
    const seen = new Set<string>()
    for (const entry of result.glossary) {
      if (seen.has(entry.term)) {
        throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `glossary contains duplicate "${entry.term}"`)
      }
      seen.add(entry.term)
    }
  }
  if (patch.backstory !== undefined) {
    result.backstory = records(patch.backstory, 'backstory').map((raw, index) => ({
      time: text(raw.time, `backstory[${index}].time`, 120),
      event: text(raw.event, `backstory[${index}].event`, LIMITS.maxWorldbookTextChars),
    }))
  }
  if (patch.facts !== undefined) {
    result.facts = records(patch.facts, 'facts').map((raw, index) => {
      const value = raw.value
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `facts[${index}].value must be a finite number`,
        )
      }
      const tolerance = raw.tolerance ?? 0
      if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `facts[${index}].tolerance must be a non-negative number`,
        )
      }
      return {
        alias: text(raw.alias, `facts[${index}].alias`, 120),
        value,
        unit: text(raw.unit, `facts[${index}].unit`, 40),
        tolerance,
        ...(raw.note === undefined ? {} : { note: optionalText(raw.note, `facts[${index}].note`) }),
      }
    })
    const seenFacts = new Set<string>()
    for (const fact of result.facts) {
      if (seenFacts.has(fact.alias)) {
        throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `facts contains duplicate "${fact.alias}"`)
      }
      seenFacts.add(fact.alias)
    }
  }
  return result
}

/** Validate a worldbook loaded from disk. */
export function validateWorldbookDocument(value: unknown, now: string): WorldbookDocument {
  if (!isRecord(value)) {
    throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, 'outline/worldbook.yaml must be a mapping')
  }
  try {
    if (value.schema_version !== 1) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `outline/worldbook.yaml schema_version must be 1, got ${String(value.schema_version)}`,
      )
    }
    const allowedTopLevel = new Set([
      'schema_version',
      'updated_at',
      'premise',
      'setting',
      'rules',
      'factions',
      'locations',
      'characters',
      'glossary',
      'backstory',
      'facts',
      'themes',
    ])
    for (const key of Object.keys(value)) {
      if (!allowedTopLevel.has(key)) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `outline/worldbook.yaml has unknown key "${key}"`,
        )
      }
    }
    if (typeof value.updated_at !== 'string' || value.updated_at.trim() === '') {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        'outline/worldbook.yaml updated_at must be a string',
      )
    }
    return {
      ...mergeWorldbook(emptyWorldbook(now), value as WorldbookPatch, now),
      updated_at: value.updated_at,
    }
  } catch (error) {
    if (error instanceof EngineInputError) {
      throw new EngineFaultError(
        ERROR_CODES.SCHEMA_INVALID,
        `outline/worldbook.yaml: ${error.message}`,
        error.hint,
        { cause: error },
      )
    }
    throw error
  }
}

/** Mark one chapter's card archived after the archive transaction commits. */
export function markOutlineArchived(
  document: OutlineDocument,
  record: ChapterRecord,
  now: string,
  targetWords: [number, number] = [record.word_count, record.word_count],
): OutlineDocument {
  const chapters = document.chapters.map((card) =>
    card.num === record.num
      ? {
          ...card,
          title: stripChapterPrefix(record.title),
          scene_type: record.scene_type,
          status: 'archived' as const,
          archived_at: now,
          word_count: record.word_count,
          score: record.score,
        }
      : card,
  )
  if (!chapters.some((card) => card.num === record.num)) {
    const volume =
      document.volumes.findIndex(
        (candidate) => record.num >= candidate.start_chapter && record.num <= candidate.end_chapter,
      ) + 1
    chapters.push({
      num: record.num,
      volume: volume === 0 ? null : volume,
      title: stripChapterPrefix(record.title),
      scene_type: record.scene_type,
      goal: autoCardGoal(record),
      conflict: '归档时自动补卡：待补充冲突',
      hook: '归档时自动补卡：待补充钩子',
      cast: autoCardCast(record),
      target_words: targetWords,
      notes: '',
      status: 'archived',
      archived_at: now,
      word_count: record.word_count,
      score: record.score,
    })
    chapters.sort((left, right) => left.num - right.num)
  }
  return { ...document, updated_at: now, chapters }
}

/** Return one archived card to planned after its backup was restored. */
export function markOutlineReopened(
  document: OutlineDocument,
  chapter: number,
  now: string,
  record?: ChapterRecord,
  targetWords: [number, number] = record === undefined
    ? [80, 400]
    : [Math.max(1, record.word_count), Math.max(1, record.word_count)],
): OutlineDocument {
  const chapters = document.chapters.map((card) =>
    card.num === chapter
      ? {
          ...card,
          // A non-strict archive may have created a card with empty
          // conflict/hook. Reopening turns it into a planned card, which the
          // validator requires to carry all three planning fields.
          goal:
            card.goal === ''
              ? record === undefined
                ? '重开章节：待补充目标'
                : autoCardGoal(record)
              : card.goal,
          conflict: card.conflict === '' ? '重开章节：待补充冲突' : card.conflict,
          hook: card.hook === '' ? '重开章节：待补充钩子' : card.hook,
          status: 'planned' as const,
          archived_at: null,
          word_count: null,
          score: null,
        }
      : card,
  )
  if (record !== undefined && !chapters.some((card) => card.num === chapter)) {
    const volume =
      document.volumes.findIndex(
        (candidate) => chapter >= candidate.start_chapter && chapter <= candidate.end_chapter,
      ) + 1
    chapters.push({
      num: chapter,
      volume: volume === 0 ? null : volume,
      title: stripChapterPrefix(record.title),
      scene_type: record.scene_type,
      goal: autoCardGoal(record),
      conflict: '重开章节：待补充冲突',
      hook: '重开章节：待补充钩子',
      cast: autoCardCast(record),
      target_words: targetWords,
      notes: '',
      status: 'planned',
      archived_at: null,
      word_count: null,
      score: null,
    })
    chapters.sort((left, right) => left.num - right.num)
  }
  return { ...document, updated_at: now, chapters }
}

/** Compare archived records with their cards. */
export function outlineDrift(
  document: OutlineDocument,
  records: readonly ChapterRecord[],
): Array<{ chapter: number; field: string; planned: string; actual: string }> {
  const byNum = new Map(document.chapters.map((card) => [card.num, card]))
  const drift: Array<{ chapter: number; field: string; planned: string; actual: string }> = []
  for (const record of records) {
    const card = byNum.get(record.num)
    if (card === undefined) {
      drift.push({ chapter: record.num, field: 'card', planned: '(none)', actual: record.title })
      continue
    }
    if (card.title !== stripChapterPrefix(record.title)) {
      drift.push({ chapter: record.num, field: 'title', planned: card.title, actual: record.title })
    }
    if (card.scene_type !== record.scene_type) {
      drift.push({
        chapter: record.num,
        field: 'scene_type',
        planned: card.scene_type,
        actual: record.scene_type,
      })
    }
  }
  return drift
}

/** Counts for status/panel/report; no IO. */
export function worldbookCounts(document: WorldbookDocument): {
  present: boolean
  characters: number
  locations: number
  factions: number
  rules: number
  glossary: number
  backstory: number
  facts: number
} {
  const facts = document.facts?.length ?? 0
  return {
    present:
      document.premise !== '' ||
      document.setting !== '' ||
      document.themes.length > 0 ||
      document.characters.length > 0 ||
      document.locations.length > 0 ||
      document.factions.length > 0 ||
      document.rules.length > 0 ||
      document.glossary.length > 0 ||
      document.backstory.length > 0 ||
      facts > 0,
    characters: document.characters.length,
    locations: document.locations.length,
    factions: document.factions.length,
    rules: document.rules.length,
    glossary: document.glossary.length,
    backstory: document.backstory.length,
    facts,
  }
}

const pick = <T>(values: readonly T[], mentioned: string, key: (value: T) => string, limit: number): T[] => {
  const matched = values.filter((value) => mentioned.includes(key(value)))
  const rest = values.filter((value) => !matched.includes(value))
  return [...matched, ...rest].slice(0, limit)
}

/** Protect the brief budget from a legal-but-huge planning document. */
const clip = (value: string, limit: number): string => {
  const chars = Array.from(value)
  return chars.length <= limit ? value : `${chars.slice(0, limit).join('')}…`
}

/** A bounded, relevant slice of the world bible for one stage's context pack. */
export function worldbookBrief(
  document: WorldbookDocument,
  mentioned: string,
  names: readonly string[],
): Record<string, unknown> {
  const named = names.join('\n')
  const characters = pick(document.characters, named === '' ? mentioned : named, (entry) => entry.name, 8)
  return {
    premise: clip(document.premise, 600),
    setting: clip(document.setting, 600),
    themes: document.themes.slice(0, 12).map((theme) => clip(theme, 80)),
    characters: characters.map((entry) => ({
      name: entry.name,
      role: entry.role,
      description: clip(entry.description, 240),
      arc: clip(entry.arc, 160),
    })),
    locations: pick(document.locations, mentioned, (entry) => entry.name, 6).map((entry) => ({
      name: entry.name,
      description: clip(entry.description, 240),
      layout: clip(entry.layout, 120),
      capacity: entry.capacity,
    })),
    factions: pick(document.factions, mentioned, (entry) => entry.name, 6).map((entry) => ({
      name: entry.name,
      description: clip(entry.description, 240),
      goal: clip(entry.goal, 120),
    })),
    rules: pick(document.rules, mentioned, (entry) => entry.name, 6).map((entry) => ({
      name: entry.name,
      description: clip(entry.description, 240),
    })),
    glossary: pick(document.glossary, mentioned, (entry) => entry.term, 6).map((entry) => ({
      term: entry.term,
      definition: clip(entry.definition, 160),
    })),
    backstory: document.backstory.slice(0, 3).map((entry) => ({
      time: entry.time,
      event: clip(entry.event, 160),
    })),
    facts: (document.facts ?? []).slice(0, 20).map((fact) => ({
      alias: clip(fact.alias, 120),
      value: fact.value,
      unit: clip(fact.unit, 40),
      tolerance: fact.tolerance ?? 0,
      ...(fact.note === undefined ? {} : { note: clip(fact.note, 160) }),
    })),
  }
}

/** The book/volume/card fragment every stage context pack may use. */
export function bookBrief(document: OutlineDocument, chapter: number): Record<string, unknown> {
  const volume =
    document.volumes.find(
      (candidate) => chapter >= candidate.start_chapter && chapter <= candidate.end_chapter,
    ) ?? null
  return {
    premise: clip(document.book.premise, 600),
    logline: clip(document.book.logline, 600),
    themes: document.book.themes.slice(0, 12).map((theme) => clip(theme, 80)),
    tone: clip(document.book.tone, 200),
    pov: clip(document.book.pov, 200),
    audience: clip(document.book.audience, 200),
    selling_points: document.book.selling_points.slice(0, 12).map((point) => clip(point, 120)),
    ending: clip(document.book.ending, 400),
    strict: document.book.strict,
    volume,
    card: outlineCard(document, chapter),
  }
}

/* ------------------------------------------------------------------ import */

const bookKeys: Record<string, keyof BookPatch> = {
  前提: 'premise',
  梗概: 'logline',
  主题: 'themes',
  基调: 'tone',
  视角: 'pov',
  读者: 'audience',
  卖点: 'selling_points',
  结局: 'ending',
  严格: 'strict',
}

const chapterKeys: Record<string, string> = {
  场景: 'scene_type',
  字数: 'target_words',
  角色: 'cast',
  目标: 'goal',
  冲突: 'conflict',
  钩子: 'hook',
  备注: 'notes',
  归档: 'archived',
}

const volumeKeys: Record<string, string> = {
  目标: 'goal',
  弧线: 'arc',
  高潮: 'climax',
  编号: 'id',
  状态: 'status',
}

const splitList = (value: string): string[] =>
  value
    .split(/[、,，;；]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')

/** Parse the documented Markdown outline template into the same input shape. */
export function parseOutlineMarkdown(content: string): OutlineParseResult {
  if (typeof content !== 'string' || content.trim() === '') {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, 'outline content must not be empty')
  }
  const warnings: string[] = []
  const book: BookPatch = {}
  const volumeInputs: Array<
    VolumeInput & { line: number; order: number; headingChapters: number[]; explicitRange: boolean }
  > = []
  const chapterInputs: OutlineChapterInput[] = []
  let nextVolumeOrder = 1
  let currentVolume: (typeof volumeInputs)[number] | null = null
  let currentChapter: (Partial<OutlineChapterInput> & { line: number }) | null = null

  const closeChapter = (): void => {
    if (currentChapter === null) return
    const line = currentChapter.line
    if (currentChapter.num === undefined) {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `Markdown line ${line}: missing chapter number`)
    }
    if (currentChapter.title === undefined || currentChapter.title.trim() === '') {
      throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `Markdown line ${line}: missing chapter title`)
    }
    if (currentChapter.scene_type === undefined) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `Markdown line ${line}: chapter ${currentChapter.num} has no 场景`,
      )
    }
    if (currentChapter.target_words === undefined) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `Markdown line ${line}: chapter ${currentChapter.num} has no 字数`,
      )
    }
    if (currentChapter.goal === undefined) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `Markdown line ${line}: chapter ${currentChapter.num} has no 目标`,
      )
    }
    if (currentChapter.conflict === undefined) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `Markdown line ${line}: chapter ${currentChapter.num} has no 冲突`,
      )
    }
    if (currentChapter.hook === undefined) {
      throw new EngineInputError(
        ERROR_CODES.SCHEMA_INVALID,
        `Markdown line ${line}: chapter ${currentChapter.num} has no 钩子`,
      )
    }
    const volume = currentVolume === null ? null : currentVolume.order
    chapterInputs.push({
      num: currentChapter.num,
      volume,
      title: currentChapter.title,
      scene_type: currentChapter.scene_type as SceneType,
      goal: currentChapter.goal,
      conflict: currentChapter.conflict,
      hook: currentChapter.hook,
      cast: currentChapter.cast ?? [],
      target_words: currentChapter.target_words,
      notes: currentChapter.notes ?? '',
    })
    currentChapter = null
  }

  const closeVolume = (): void => {
    if (currentVolume === null) return
    const volume = currentVolume
    const chapters = chapterInputs.filter((card) => card.volume === volume.order)
    if (chapters.length > 0) {
      volume.start_chapter = Math.min(volume.start_chapter, ...chapters.map((card) => card.num))
      volume.end_chapter = Math.max(volume.end_chapter, ...chapters.map((card) => card.num))
    } else if (!volume.explicitRange) {
      warnings.push(`volume "${volume.title}" has neither a chapter range nor chapter cards; it was ignored`)
      volumeInputs.pop()
    }
    if (volume.end_chapter < volume.start_chapter) {
      warnings.push(`volume "${volume.title}" has no chapter range; it was ignored`)
      volumeInputs.pop()
    }
    currentVolume = null
  }

  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  for (const [index, rawLine] of lines.entries()) {
    const lineNo = index + 1
    const line = rawLine.trim()
    if (line === '' || line.startsWith('<!--')) continue
    if (line.startsWith('# ')) {
      // The project title already lives in novel.yaml; a Markdown H1 is a hint.
      continue
    }
    if (line.startsWith('## ')) {
      closeChapter()
      closeVolume()
      const heading = line.slice(3).trim()
      const volumeMatch = /^第\s*([0-9一二三四五六七八九十百]+)\s*卷\s*(.*)$/.exec(heading)
      const rangeMatch = /[（(]\s*第?\s*(\d+)\s*[-–~至]\s*(\d+)\s*章?\s*[）)]/.exec(heading)
      const titleBody = heading.replace(/[（(]\s*第?\s*\d+\s*[-–~至]\s*\d+\s*章?\s*[）)]/g, '').trim()
      if (volumeMatch === null && titleBody === '') {
        warnings.push(`line ${lineNo}: ignored heading "${heading}"`)
        continue
      }
      const previousEnd = volumeInputs.length === 0 ? 0 : volumeInputs[volumeInputs.length - 1]!.end_chapter
      const start = rangeMatch === null ? previousEnd + 1 : Number(rangeMatch[1])
      const end = rangeMatch === null ? start : Number(rangeMatch[2])
      currentVolume = {
        line: lineNo,
        order: nextVolumeOrder,
        title: titleBody === '' ? `第${nextVolumeOrder}卷` : titleBody,
        start_chapter: start,
        end_chapter: end,
        headingChapters: [],
        explicitRange: rangeMatch !== null,
      }
      nextVolumeOrder += 1
      volumeInputs.push(currentVolume)
      continue
    }
    if (line.startsWith('### ')) {
      closeChapter()
      const heading = line.slice(4).trim()
      const match = /^第\s*(\d+)\s*章\s*(.*)$/.exec(heading)
      if (match === null) {
        throw new EngineInputError(
          ERROR_CODES.SCHEMA_INVALID,
          `Markdown line ${lineNo}: chapter heading must be "### 第N章 标题"`,
        )
      }
      currentChapter = {
        line: lineNo,
        num: Number(match[1]),
        title: match[2]!.trim(),
        cast: [],
      }
      continue
    }
    if (line.startsWith('>')) {
      book.logline = line.slice(1).trim()
      continue
    }
    const kv = /^[-*]?\s*([^：:]+?)\s*[：:]\s*(.*)$/.exec(line)
    if (kv === null) {
      warnings.push(`line ${lineNo}: ignored "${line}"`)
      continue
    }
    const key = kv[1]!.trim()
    const value = kv[2]!.trim()
    if (currentChapter !== null) {
      const mapped = chapterKeys[key]
      if (mapped === undefined) {
        warnings.push(`line ${lineNo}: unknown chapter field "${key}"`)
        continue
      }
      if (mapped === 'scene_type') {
        currentChapter.scene_type = value as SceneType
      } else if (mapped === 'target_words') {
        const range = /^(\d+)\s*[-–~至]\s*(\d+)$/.exec(value)
        if (range === null) {
          throw new EngineInputError(
            ERROR_CODES.SCHEMA_INVALID,
            `Markdown line ${lineNo}: 字数 must be "min-max", got "${value}"`,
          )
        }
        currentChapter.target_words = [Number(range[1]), Number(range[2])]
      } else if (mapped === 'cast') {
        currentChapter.cast = splitList(value)
      } else if (mapped === 'archived') {
        // Archive status is owned by state/chapters.yaml. Keeping the exported
        // line as a silent no-op would make a round-trip look successful while
        // losing the status, so say it out loud.
        warnings.push(
          `line ${lineNo}: 归档 metadata is informational; archive status comes from state/chapters.yaml`,
        )
      } else {
        ;(currentChapter as Record<string, unknown>)[mapped] = value
      }
      continue
    }
    if (currentVolume !== null) {
      const mapped = volumeKeys[key]
      if (mapped !== undefined) {
        ;(currentVolume as unknown as Record<string, unknown>)[mapped] = value
        continue
      }
    }
    const bookKey = bookKeys[key]
    if (bookKey !== undefined) {
      if (bookKey === 'themes' || bookKey === 'selling_points') {
        ;(book as Record<string, unknown>)[bookKey] = splitList(value)
      } else if (bookKey === 'strict') {
        ;(book as Record<string, unknown>).strict = /^(true|yes|1|是|严格)$/i.test(value)
      } else {
        ;(book as Record<string, unknown>)[bookKey] = value
      }
      continue
    }
    warnings.push(`line ${lineNo}: ignored "${line}"`)
  }
  closeChapter()
  closeVolume()
  if (chapterInputs.length === 0 && volumeInputs.length === 0) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      'outline Markdown contains neither chapter cards nor volume sections',
    )
  }
  // Volume headings may appear out of chapter order. Normalize assigns volume
  // indexes after sorting the ranges, so the chapter references must be
  // translated from parser order to sorted-order before validation.
  const orderedVolumes = [...volumeInputs].sort(
    (left, right) => left.start_chapter - right.start_chapter || left.end_chapter - right.end_chapter,
  )
  const volumeRank = new Map(orderedVolumes.map((volume, index) => [volume.order, index + 1]))
  for (const chapter of chapterInputs) {
    if (chapter.volume !== null && chapter.volume !== undefined) {
      chapter.volume = volumeRank.get(chapter.volume) ?? null
    }
  }
  return {
    book,
    volumes: volumeInputs.map(
      ({ line: _line, order: _order, headingChapters: _chapters, explicitRange: _explicit, ...volume }) =>
        volume,
    ),
    chapters: chapterInputs,
    warnings,
  }
}

/** Parse YAML/JSON outline payloads into the shared import shape. */
export function parseOutlineData(content: string, format: 'yaml' | 'json'): OutlineParseResult {
  let parsed: unknown
  try {
    parsed = format === 'json' ? JSON.parse(content) : parseYaml(content)
  } catch (error) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `outline ${format} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isRecord(parsed)) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `outline ${format} must be a mapping`)
  }
  if (parsed.schema_version !== undefined && parsed.schema_version !== 1) {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `outline ${format} schema_version must be 1, got ${String(parsed.schema_version)}`,
    )
  }
  const warnings: string[] = []
  const allowed = new Set(['schema_version', 'updated_at', 'book', 'volumes', 'chapters'])
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) warnings.push(`unknown top-level outline field "${key}" was ignored`)
  }
  const book = (parsed.book ?? {}) as BookPatch
  const volumes = (parsed.volumes ?? []) as VolumeInput[]
  const chapters = parsed.chapters
  if (!Array.isArray(chapters)) {
    throw new EngineInputError(ERROR_CODES.SCHEMA_INVALID, `outline ${format} must contain a chapters array`)
  }
  return { book, volumes, chapters: chapters as OutlineChapterInput[], warnings }
}

/** One entry point for both human import formats. */
export function parseOutlineInput(content: string, format: 'markdown' | 'yaml' | 'json'): ParsedOutlineInput {
  if (format !== 'markdown' && format !== 'yaml' && format !== 'json') {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `unknown outline format "${String(format)}"`,
      'allowed: markdown, yaml, json',
    )
  }
  const parsed = format === 'markdown' ? parseOutlineMarkdown(content) : parseOutlineData(content, format)
  return { format, ...parsed }
}

/** One-line Markdown field; a newline would turn into an unknown import line. */
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()

/** Export helper: a human-readable outline in the import template's shape. */
export function renderOutlineMarkdown(
  project: { title: string; genre: Genre; platform: Platform },
  document: OutlineDocument,
  chapters: readonly ChapterRecord[],
): string {
  const parts: string[] = [`# ${oneLine(project.title)}`, '']
  if (document.book.logline !== '') parts.push(`> ${oneLine(document.book.logline)}`, '')
  const fields: Array<[string, string]> = [
    ['前提', oneLine(document.book.premise)],
    ['主题', document.book.themes.map(oneLine).join('、')],
    ['基调', oneLine(document.book.tone)],
    ['视角', oneLine(document.book.pov)],
    ['读者', oneLine(document.book.audience)],
    ['卖点', document.book.selling_points.map(oneLine).join('、')],
    ['结局', oneLine(document.book.ending)],
    ['严格', document.book.strict ? 'true' : 'false'],
  ]
  for (const [key, value] of fields) if (value !== '') parts.push(`${key}：${value}`)
  if (parts[parts.length - 1] !== '') parts.push('')
  const archived = new Map(chapters.map((record) => [record.num, record]))
  // Cards outside every volume must be emitted before the first `##` heading:
  // the Markdown parser attaches cards to the current volume, so emitting them
  // after the last volume would silently move them into that volume.
  const outside = document.chapters.filter(
    (card) =>
      !document.volumes.some((volume) => card.num >= volume.start_chapter && card.num <= volume.end_chapter),
  )
  for (const card of outside) parts.push(...renderCard(card, archived.get(card.num)))
  for (const volume of document.volumes) {
    parts.push(`## ${oneLine(volume.title)}（第${volume.start_chapter}-${volume.end_chapter}章）`)
    parts.push(`编号：${oneLine(volume.id)}`)
    parts.push(`状态：${volume.status}`)
    if (volume.goal !== '') parts.push(`目标：${oneLine(volume.goal)}`)
    if (volume.arc !== '') parts.push(`弧线：${oneLine(volume.arc)}`)
    if (volume.climax !== '') parts.push(`高潮：${oneLine(volume.climax)}`)
    parts.push('')
    const cards = document.chapters.filter(
      (card) => card.num >= volume.start_chapter && card.num <= volume.end_chapter,
    )
    for (const card of cards) parts.push(...renderCard(card, archived.get(card.num)))
  }
  return parts.join('\n')
}

const renderCard = (card: OutlineChapter, record: ChapterRecord | undefined): string[] => {
  const lines = [
    `### 第${card.num}章 ${oneLine(card.title)}`,
    `场景：${card.scene_type}`,
    `字数：${card.target_words[0]}-${card.target_words[1]}`,
    `角色：${card.cast.map(oneLine).join('、')}`,
    `目标：${oneLine(card.goal)}`,
    `冲突：${oneLine(card.conflict)}`,
    `钩子：${oneLine(card.hook)}`,
  ]
  if (card.notes !== '') lines.push(`备注：${oneLine(card.notes)}`)
  if (card.status === 'archived' && record !== undefined) {
    lines.push(`归档：${record.word_count} 字 / ${record.score} 分`)
  }
  lines.push('')
  return lines
}

/** Export helper for the world bible. */
export function renderWorldbookMarkdown(project: { title: string }, document: WorldbookDocument): string {
  const parts: string[] = [`# ${project.title} · 世界观设定集`, '']
  const section = (title: string, lines: string[]): void => {
    if (lines.length === 0) return
    parts.push(`## ${title}`, '', ...lines, '')
  }
  if (document.premise !== '') section('一句话', [oneLine(document.premise)])
  if (document.setting !== '') section('世界设定', [oneLine(document.setting)])
  if (document.themes.length > 0) section('主题', [document.themes.map(oneLine).join('、')])
  section(
    '规则',
    document.rules.map((entry) => `- **${oneLine(entry.name)}**：${oneLine(entry.description)}`),
  )
  section(
    '势力',
    document.factions.map((entry) =>
      entry.goal === ''
        ? `- **${oneLine(entry.name)}**：${oneLine(entry.description)}`
        : `- **${oneLine(entry.name)}**：${oneLine(entry.description)}（目标：${oneLine(entry.goal)}）`,
    ),
  )
  section(
    '地点',
    document.locations.map(
      (entry) =>
        `- **${oneLine(entry.name)}**：${oneLine(entry.description)}${
          entry.layout === '' ? '' : `；布局：${oneLine(entry.layout)}`
        }${entry.capacity === 0 ? '' : `；容量：${entry.capacity}`}`,
    ),
  )
  section(
    '角色',
    document.characters.map(
      (entry) =>
        `- **${oneLine(entry.name)}**（${oneLine(entry.role)}）：${oneLine(entry.description)}${entry.arc === '' ? '' : `；弧线：${oneLine(entry.arc)}`}`,
    ),
  )
  section(
    '术语',
    document.glossary.map((entry) => `- **${oneLine(entry.term)}**：${oneLine(entry.definition)}`),
  )
  section(
    '前史',
    document.backstory.map((entry) => `- ${oneLine(entry.time)}：${oneLine(entry.event)}`),
  )
  section(
    '数值事实',
    (document.facts ?? []).map(
      (fact) =>
        `- **${oneLine(fact.alias)}**：${fact.value}${oneLine(fact.unit)}${
          fact.tolerance === undefined ? '' : `（容差 ${fact.tolerance}）`
        }${fact.note === undefined || fact.note === '' ? '' : `；${oneLine(fact.note)}`}`,
    ),
  )
  return parts.join('\n')
}
