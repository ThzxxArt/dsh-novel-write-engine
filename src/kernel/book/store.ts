import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import type { FsStore } from '../../store/fs.js'
import { StudioError, STUDIO_ERROR_CODES } from '../../contracts/errors.js'
import { BookOutlineSchema, CanonSchema, type BookOutline, type Canon } from '../../contracts/project.js'
import {
  ChapterPlanSchema,
  StateDeltaSchema,
  type BiblePlan,
  type ChapterPlan,
  type OutlinePlan,
  type StateDelta,
} from '../../contracts/artifacts.js'
import { BIBLE_DIR, OUTLINE_DIR, STATE_DIR, chapterPlanFile, volumeFile } from '../project/layout.js'

const readYaml = async <T>(
  store: FsStore,
  path: string,
  schema: z.ZodType<T>,
  fallback: () => T,
): Promise<T> => {
  const text = await store.readText(path)
  if (text === null) return fallback()
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error) {
    throw new StudioError(
      STUDIO_ERROR_CODES.PROJECT_INVALID,
      `${path} is not valid YAML`,
      'fix the file or restore from backup',
      { path },
      { cause: error },
    )
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new StudioError(
      STUDIO_ERROR_CODES.PROJECT_INVALID,
      `${path} does not match its schema`,
      '0.3.0 has one schema per file',
      { path, issues: parsed.error.issues },
    )
  }
  return parsed.data
}

const writeYaml = async (store: FsStore, path: string, value: unknown): Promise<void> => {
  await store.writeText(path, stringifyYaml(value, { lineWidth: 0 }))
}

export const emptyBookOutline = (): BookOutline => ({
  schema_version: 2,
  logline: '',
  acts: [],
  volumes: [],
  updated_at: new Date().toISOString(),
})

export const emptyCanon = (): Canon => ({
  schema_version: 2,
  entities: { characters: [], locations: [], factions: [], items: [], concepts: [] },
  relationships: [],
  timeline: [],
  foreshadows: [],
  resources: [],
  handoff: {},
  next_seq: 1,
  updated_at: new Date().toISOString(),
})

export async function loadBookOutline(store: FsStore): Promise<BookOutline> {
  return readYaml(store, `${OUTLINE_DIR}/book.yaml`, BookOutlineSchema, emptyBookOutline)
}

export async function saveBookOutline(store: FsStore, outline: BookOutline): Promise<void> {
  await writeYaml(store, `${OUTLINE_DIR}/book.yaml`, { ...outline, updated_at: new Date().toISOString() })
}

export async function loadCanon(store: FsStore): Promise<Canon> {
  return readYaml(store, `${STATE_DIR}/canon.yaml`, CanonSchema, emptyCanon)
}

export async function saveCanon(store: FsStore, canon: Canon): Promise<void> {
  await writeYaml(store, `${STATE_DIR}/canon.yaml`, { ...canon, updated_at: new Date().toISOString() })
}

export async function loadChapterPlan(store: FsStore, chapter: number): Promise<ChapterPlan | null> {
  const text = await store.readText(chapterPlanFile(chapter))
  if (text === null) return null
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error) {
    throw new StudioError(
      STUDIO_ERROR_CODES.PROJECT_INVALID,
      `chapter plan ${chapter} is not valid YAML`,
      undefined,
      { chapter },
      { cause: error },
    )
  }
  const parsed = ChapterPlanSchema.safeParse(raw)
  if (!parsed.success) {
    throw new StudioError(
      STUDIO_ERROR_CODES.PROJECT_INVALID,
      `chapter plan ${chapter} does not match ChapterPlan`,
      undefined,
      { chapter, issues: parsed.error.issues },
    )
  }
  return parsed.data
}

export async function saveChapterPlan(store: FsStore, plan: ChapterPlan): Promise<void> {
  await writeYaml(store, chapterPlanFile(plan.chapter), plan)
}

export async function saveOutlinePlan(store: FsStore, plan: OutlinePlan): Promise<void> {
  const now = new Date().toISOString()
  const outline: BookOutline = {
    schema_version: 2,
    logline: plan.logline,
    acts: plan.acts,
    volumes: plan.volumes,
    updated_at: now,
  }
  await saveBookOutline(store, outline)
  const keepVolumes = new Set(plan.volumes.map((volume) => `${volume.id}.yaml`))
  for (const volume of plan.volumes) {
    await writeYaml(store, `${OUTLINE_DIR}/volumes/${volume.id}.yaml`, {
      schema_version: 2,
      ...volume,
      updated_at: now,
    })
  }
  for (const file of await store.list(`${OUTLINE_DIR}/volumes`)) {
    if (file.endsWith('.yaml') && !keepVolumes.has(file)) {
      await store.remove(`${OUTLINE_DIR}/volumes/${file}`)
    }
  }
  for (const chapter of plan.chapters) {
    const existing = await loadChapterPlan(store, chapter.chapter)
    const card: ChapterPlan = {
      schema_version: 2,
      kind: 'ChapterPlan',
      chapter: chapter.chapter,
      title: chapter.title,
      scene_type: chapter.scene_type,
      pov: existing?.pov ?? '第三人称',
      cast: existing?.cast ?? ['主角'],
      goal: existing?.goal ?? chapter.summary,
      conflict: existing?.conflict ?? chapter.hook,
      turn: existing?.turn ?? chapter.hook,
      outcome: existing?.outcome ?? chapter.summary,
      target_words: existing?.target_words ?? 2400,
      hook: chapter.hook,
      foreshadows: existing?.foreshadows ?? [],
      notes: existing?.notes ?? [],
      citations: [],
      open_questions: [],
    }
    await saveChapterPlan(store, card)
  }
}

const readWorldRows = async (store: FsStore, name: string, key: string): Promise<unknown[]> => {
  const text = await store.readText(`${BIBLE_DIR}/world/${name}.yaml`)
  if (text === null) return []
  const raw = parseYaml(text)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Array.isArray((raw as Record<string, unknown>)[key]) ? (raw as Record<string, unknown[]>)[key]! : []
}

/** Apply a WorldbookPatch to the file-backed Codex; called by the kernel only. */
export async function applyWorldbookPatch(
  store: FsStore,
  patch: import('../../contracts/artifacts.js').WorldbookPatch,
): Promise<void> {
  const now = new Date().toISOString()
  const locations = await readWorldRows(store, 'locations', 'locations')
  const factions = await readWorldRows(store, 'factions', 'factions')
  const rules = (await readWorldRows(store, 'rules', 'rules')).map(String)
  const glossaryText = await store.readText(`${BIBLE_DIR}/world/glossary.yaml`)
  const glossaryRaw =
    glossaryText === null ? {} : ((parseYaml(glossaryText) as { terms?: unknown }).terms ?? {})
  const glossary: Record<string, string> =
    glossaryRaw !== null && typeof glossaryRaw === 'object' && !Array.isArray(glossaryRaw)
      ? (glossaryRaw as Record<string, string>)
      : {}
  const codexText = await store.readText(`${BIBLE_DIR}/world/codex.yaml`)
  const codexRaw = codexText === null ? null : parseYaml(codexText)
  const codex =
    codexRaw !== null && typeof codexRaw === 'object' && !Array.isArray(codexRaw)
      ? ((codexRaw as { entries?: unknown[] }).entries ?? [])
      : []
  const upsertNamed = (rows: unknown[], name: string, value: Record<string, unknown>): void => {
    const index = rows.findIndex((row) =>
      typeof row === 'string' ? row === name : (row as { name?: unknown }).name === name,
    )
    if (index === -1) rows.push(value)
    else rows[index] = value
  }
  for (const entity of patch.entities) {
    const record = {
      key: entity.key,
      name: entity.name,
      summary: entity.summary,
      facts: entity.facts,
      evidence: entity.evidence,
      updated_at: now,
    }
    if (entity.entity_kind === 'character') {
      const slug = entity.key.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'character'
      await writeYaml(store, `${BIBLE_DIR}/characters/${slug}.yaml`, {
        schema_version: 2,
        slug,
        ...record,
      })
    } else if (entity.entity_kind === 'location') {
      upsertNamed(locations, entity.name, record)
    } else if (entity.entity_kind === 'faction') {
      upsertNamed(factions, entity.name, record)
    } else if (entity.entity_kind === 'rule') {
      if (!rules.includes(entity.summary)) rules.push(entity.summary)
    } else if (entity.entity_kind === 'term') {
      glossary[entity.name] = entity.summary
    } else {
      upsertNamed(codex, entity.name, { ...record, entity_kind: entity.entity_kind })
    }
  }
  await writeYaml(store, `${BIBLE_DIR}/world/locations.yaml`, {
    schema_version: 2,
    locations,
    updated_at: now,
  })
  await writeYaml(store, `${BIBLE_DIR}/world/factions.yaml`, {
    schema_version: 2,
    factions,
    updated_at: now,
  })
  await writeYaml(store, `${BIBLE_DIR}/world/rules.yaml`, {
    schema_version: 2,
    rules,
    updated_at: now,
  })
  await writeYaml(store, `${BIBLE_DIR}/world/glossary.yaml`, {
    schema_version: 2,
    terms: glossary,
    updated_at: now,
  })
  await writeYaml(store, `${BIBLE_DIR}/world/codex.yaml`, {
    schema_version: 2,
    entries: codex,
    updated_at: now,
  })
}

export async function saveBiblePlan(store: FsStore, plan: BiblePlan): Promise<void> {
  await store.writeText(`${BIBLE_DIR}/premise.md`, `${plan.premise}\n`)
  await store.writeText(
    `${BIBLE_DIR}/themes.md`,
    `# 主题\n\n${plan.themes.map((theme) => `- ${theme}`).join('\n')}\n`,
  )
  await store.writeText(`${BIBLE_DIR}/style/guide.md`, `${plan.style.guide}\n`)
  await store.writeText(
    `${BIBLE_DIR}/style/fingerprint.json`,
    `${JSON.stringify(plan.style.fingerprint, null, 2)}\n`,
  )
  await writeYaml(store, `${BIBLE_DIR}/world/rules.yaml`, {
    schema_version: 2,
    rules: plan.world.rules,
    updated_at: new Date().toISOString(),
  })
  await writeYaml(store, `${BIBLE_DIR}/world/factions.yaml`, {
    schema_version: 2,
    factions: plan.world.factions,
    updated_at: new Date().toISOString(),
  })
  await writeYaml(store, `${BIBLE_DIR}/world/locations.yaml`, {
    schema_version: 2,
    locations: plan.world.locations,
    updated_at: new Date().toISOString(),
  })
  await writeYaml(store, `${BIBLE_DIR}/world/glossary.yaml`, {
    schema_version: 2,
    terms: plan.world.glossary,
    updated_at: new Date().toISOString(),
  })
  for (const character of plan.characters) {
    await writeYaml(store, `${BIBLE_DIR}/characters/${character.slug}.yaml`, {
      schema_version: 2,
      ...character,
      updated_at: new Date().toISOString(),
    })
  }
  const keep = new Set(plan.characters.map((character) => `${character.slug}.yaml`))
  for (const file of await store.list(`${BIBLE_DIR}/characters`)) {
    if (file.endsWith('.yaml') && !keep.has(file)) await store.remove(`${BIBLE_DIR}/characters/${file}`)
  }
}

export interface BibleSnapshot {
  premise: string
  themes: string
  styleGuide: string
  fingerprint: Record<string, unknown>
  world: {
    rules: string[]
    factions: string[]
    locations: string[]
    glossary: Record<string, string>
  }
  characters: Array<Record<string, unknown>>
  codex?: Array<Record<string, unknown>>
}

export async function loadBible(store: FsStore): Promise<BibleSnapshot> {
  const premise = (await store.readText(`${BIBLE_DIR}/premise.md`)) ?? ''
  const themes = (await store.readText(`${BIBLE_DIR}/themes.md`)) ?? ''
  const styleGuide = (await store.readText(`${BIBLE_DIR}/style/guide.md`)) ?? ''
  let fingerprint: Record<string, unknown> = {}
  const fingerprintText = await store.readText(`${BIBLE_DIR}/style/fingerprint.json`)
  if (fingerprintText !== null) {
    try {
      fingerprint = JSON.parse(fingerprintText) as Record<string, unknown>
    } catch {
      fingerprint = {}
    }
  }
  const readWorld = async (name: string, key: string): Promise<unknown[]> => {
    const text = await store.readText(`${BIBLE_DIR}/world/${name}.yaml`)
    if (text === null) return []
    try {
      const raw = parseYaml(text)
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
      const values = (raw as Record<string, unknown>)[key]
      return Array.isArray(values) ? values : []
    } catch {
      return []
    }
  }
  const rules = (await readWorld('rules', 'rules')).map(String)
  const factions = (await readWorld('factions', 'factions')).map((item) =>
    typeof item === 'string' ? item : String((item as { name?: unknown }).name ?? ''),
  )
  const locations = (await readWorld('locations', 'locations')).map((item) =>
    typeof item === 'string' ? item : String((item as { name?: unknown }).name ?? ''),
  )
  const glossaryRaw = await store.readText(`${BIBLE_DIR}/world/glossary.yaml`)
  const glossary: Record<string, string> = {}
  if (glossaryRaw !== null) {
    try {
      const raw = parseYaml(glossaryRaw) as { terms?: unknown }
      if (
        raw.terms !== undefined &&
        typeof raw.terms === 'object' &&
        raw.terms !== null &&
        !Array.isArray(raw.terms)
      ) {
        for (const [key, value] of Object.entries(raw.terms as Record<string, unknown>))
          glossary[key] = String(value)
      }
    } catch {
      // An unreadable glossary is reported by doctor, not fatal for a status read.
    }
  }
  const characterFiles = await store.list(`${BIBLE_DIR}/characters`)
  const characters: Array<Record<string, unknown>> = []
  for (const file of characterFiles.filter((name) => name.endsWith('.yaml'))) {
    const text = await store.readText(`${BIBLE_DIR}/characters/${file}`)
    if (text === null) continue
    try {
      const raw = parseYaml(text) as Record<string, unknown>
      characters.push(raw)
    } catch {
      characters.push({ slug: file.replace(/\.yaml$/u, ''), unreadable: true })
    }
  }
  let codex: Array<Record<string, unknown>> = []
  const codexText = await store.readText(`${BIBLE_DIR}/world/codex.yaml`)
  if (codexText !== null) {
    try {
      const raw = parseYaml(codexText) as { entries?: unknown }
      if (Array.isArray(raw.entries)) {
        codex = raw.entries.filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === 'object' && entry !== null && !Array.isArray(entry),
        )
      }
    } catch {
      codex = []
    }
  }
  return {
    premise,
    themes,
    styleGuide,
    fingerprint,
    world: { rules, factions, locations, glossary },
    characters,
    codex,
  }
}

/** Merge an Archivist delta into canon with evidence and resource rules. */
export function applyStateDelta(canon: Canon, delta: StateDelta): Canon {
  const parsed = StateDeltaSchema.parse(delta)
  const next: Canon = structuredClone(canon)
  const resourceModes = new Map<string, 'set' | 'add'>()
  for (const foreshadow of parsed.foreshadows) {
    if (
      foreshadow.action === 'resolved' &&
      (foreshadow.resolved_anchor === undefined || foreshadow.resolved_anchor.trim() === '')
    ) {
      throw new StudioError(
        STUDIO_ERROR_CODES.ARTIFACT_INVALID,
        `foreshadow ${foreshadow.key} is resolved without resolved_anchor`,
        'a resolved foreshadow must quote the正文 anchor that closes it',
      )
    }
  }
  for (const resource of parsed.resources) {
    const key = `${resource.character}\u0000${resource.resource}`
    const prior = resourceModes.get(key)
    if (prior !== undefined && prior !== resource.mode) {
      throw new StudioError(
        STUDIO_ERROR_CODES.ARTIFACT_INVALID,
        `resource ${resource.character}/${resource.resource} uses both set and add in one delta`,
        'choose one channel per resource per chapter',
      )
    }
    resourceModes.set(key, resource.mode)
  }
  for (const entity of parsed.entities) {
    if (
      entity.action === 'updated' &&
      (entity.patch === undefined || Object.keys(entity.patch).length === 0)
    ) {
      throw new StudioError(
        STUDIO_ERROR_CODES.ARTIFACT_INVALID,
        `entity ${entity.key} is updated without a patch`,
        'an update needs before/after fields plus正文 evidence',
      )
    }
    const bucket =
      entity.kind === 'character'
        ? next.entities.characters
        : entity.kind === 'location'
          ? next.entities.locations
          : entity.kind === 'faction'
            ? next.entities.factions
            : entity.kind === 'item'
              ? next.entities.items
              : next.entities.concepts
    const index = bucket.findIndex((row) => row.key === entity.key || row.name === entity.key)
    if (entity.action === 'created' && index === -1)
      bucket.push({ key: entity.key, ...(entity.patch ?? {}), evidence: entity.evidence })
    else if (entity.action === 'updated' && index >= 0)
      bucket[index] = { ...bucket[index], ...(entity.patch ?? {}), evidence: entity.evidence }
  }
  for (const relation of parsed.relationships) {
    const index = next.relationships.findIndex(
      (row) => row.from === relation.from && row.to === relation.to && row.type_code === relation.type_code,
    )
    const value = { ...relation }
    if (index === -1) next.relationships.push(value)
    else next.relationships[index] = value
  }
  for (const event of parsed.timeline) {
    const index = next.timeline.findIndex((row) => row.key === event.key)
    if (index === -1) next.timeline.push({ ...event })
    else next.timeline[index] = { ...event }
  }
  for (const foreshadow of parsed.foreshadows) {
    const index = next.foreshadows.findIndex((row) => row.key === foreshadow.key)
    if (foreshadow.action === 'planted' && index === -1)
      next.foreshadows.push({ ...foreshadow, status: 'open' })
    else if (index >= 0) next.foreshadows[index] = { ...next.foreshadows[index], ...foreshadow }
  }
  for (const resource of parsed.resources) {
    const index = next.resources.findIndex(
      (row) => row.character === resource.character && row.resource === resource.resource,
    )
    if (resource.mode === 'set') {
      if (index === -1)
        next.resources.push({
          character: resource.character,
          resource: resource.resource,
          value: resource.value,
        })
      else next.resources[index] = { ...next.resources[index], value: resource.value }
    } else if (index === -1) {
      next.resources.push({
        character: resource.character,
        resource: resource.resource,
        value: resource.value,
      })
    } else {
      next.resources[index] = {
        ...next.resources[index],
        value: Number(next.resources[index]!.value ?? 0) + resource.value,
      }
    }
  }
  next.handoff = { ...next.handoff, ...parsed.handoff }
  next.next_seq += 1
  next.updated_at = new Date().toISOString()
  return next
}

export function chapterCardFromOutline(
  plan: OutlinePlan,
  chapter: number,
): OutlinePlan['chapters'][number] | undefined {
  return plan.chapters.find((card) => card.chapter === chapter)
}

export async function listChapterPlans(store: FsStore): Promise<ChapterPlan[]> {
  const files = await store.list(`${OUTLINE_DIR}/chapters`)
  const plans: ChapterPlan[] = []
  for (const file of files.filter((name) => /^ch-\d{4}\.yaml$/u.test(name))) {
    const chapter = Number(file.slice(3, 7))
    const plan = await loadChapterPlan(store, chapter)
    if (plan !== null) plans.push(plan)
  }
  return plans.sort((left, right) => left.chapter - right.chapter)
}

/**
 * Reorder chapter cards without touching prose. Refuses while the affected
 * range already has archived manuscript files, because renumbering a plan then
 * would silently point it at another chapter's正文.
 */
export async function moveChapterPlan(store: FsStore, from: number, to: number): Promise<ChapterPlan[]> {
  const plans = await listChapterPlans(store)
  const fromIndex = plans.findIndex((plan) => plan.chapter === from)
  const toIndex = plans.findIndex((plan) => plan.chapter === to)
  if (fromIndex === -1 || toIndex === -1) {
    throw new StudioError(
      STUDIO_ERROR_CODES.PROJECT_INVALID,
      `cannot move chapter ${from} to ${to}: both cards must exist`,
      'reload the outline board and retry',
    )
  }
  if (from === to) return plans
  const low = Math.min(from, to)
  const high = Math.max(from, to)
  const manuscripts = await store.list('manuscript')
  const archived = manuscripts
    .filter((name) => /^ch-\d{4}\.md$/u.test(name))
    .map((name) => Number(name.slice(3, 7)))
    .filter((chapter) => chapter >= low && chapter <= high)
  if (archived.length > 0) {
    throw new StudioError(
      STUDIO_ERROR_CODES.PROJECT_INVALID,
      `cannot renumber chapters ${low}-${high}: manuscript already exists for ${archived.join(', ')}`,
      'move only unwritten chapter cards; archived chapters are immutable',
    )
  }
  const [moving] = plans.splice(fromIndex, 1)
  if (moving === undefined) return plans
  plans.splice(toIndex, 0, moving)
  const renumbered = plans.map((plan, index) => ({ ...plan, chapter: index + 1 }))
  for (const plan of renumbered) await saveChapterPlan(store, plan)
  return renumbered
}

/** Advance one foreshadow on the board; resolving requires a正文 anchor. */
export async function setForeshadowStatus(
  store: FsStore,
  key: string,
  status: 'open' | 'advanced' | 'resolved',
  anchor?: string,
): Promise<Canon> {
  if (status === 'resolved' && (anchor === undefined || anchor.trim().length < 4)) {
    throw new StudioError(
      STUDIO_ERROR_CODES.ARTIFACT_INVALID,
      'a resolved foreshadow must quote its正文 anchor',
      'select the closing sentence in the manuscript and paste it here',
    )
  }
  const canon = await loadCanon(store)
  const row = canon.foreshadows.find((item) => String(item.key ?? item.id ?? item.title ?? '') === key)
  if (row === undefined) {
    throw new StudioError(
      STUDIO_ERROR_CODES.PROJECT_INVALID,
      `unknown foreshadow ${key}`,
      'reload the bible workspace',
    )
  }
  row.status = status
  if (status === 'resolved') row.resolved_anchor = anchor
  if (status !== 'resolved') delete row.resolved_anchor
  canon.updated_at = new Date().toISOString()
  await saveCanon(store, canon)
  return canon
}

export async function listVolumeFiles(store: FsStore): Promise<string[]> {
  return (await store.list(`${OUTLINE_DIR}/volumes`)).filter((name) => name.endsWith('.yaml'))
}

export { volumeFile }
