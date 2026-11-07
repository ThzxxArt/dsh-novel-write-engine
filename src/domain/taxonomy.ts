import { GENRES, PLATFORMS, type Genre, type Platform } from '../types.js'
import { EngineFaultError, EngineInputError } from '../types.js'

/** Stable facets in display / digest order. */
export const TAG_FACETS = [
  'world',
  'prot',
  'plot',
  'tone',
  'theme',
  'set',
  'struct',
  'pov',
  'emo',
  'pace',
  'market',
] as const
export type TagFacet = (typeof TAG_FACETS)[number]

export const AUDIENCES = ['male', 'female', 'general', 'teen', 'adult'] as const
export type Audience = (typeof AUDIENCES)[number]

export const TAXONOMY_VERSION = 1 as const

export interface ProfileValues {
  foreshadow_min_dormancy?: number
  motif_min_dormancy?: number
  foreshadow_dormant_after?: number
  dialogue_ratio?: [number, number]
  paragraph_max_words?: number
  water_words?: number
  pleasure_keywords?: string[]
  lexicon_add?: string[]
  lexicon_remove?: string[]
}

export type ProfileKey = keyof ProfileValues

const PROFILE_KEYS: readonly ProfileKey[] = [
  'foreshadow_min_dormancy',
  'motif_min_dormancy',
  'foreshadow_dormant_after',
  'dialogue_ratio',
  'paragraph_max_words',
  'water_words',
  'pleasure_keywords',
  'lexicon_add',
  'lexicon_remove',
]

export interface SubGenre {
  id: string
  label: string
  aliases: string[]
  audienceDefault: Audience
  legacyGenre: Genre
  recommendedTags: string[]
  profile: ProfileValues
  status: 'active' | 'deprecated'
  replacedBy?: string
}

export interface MajorGenre {
  id: string
  label: string
  aliases: string[]
  audienceDefault: Audience
  platformFit: Partial<Record<Platform, 'high' | 'medium' | 'low'>>
  profile: ProfileValues
  subs: SubGenre[]
  status: 'active' | 'deprecated'
  replacedBy?: string
}

export interface GenreTag {
  id: string
  label: string
  facet: TagFacet
  aliases: string[]
  conflicts: string[]
  requires: string[]
  recommendedFor: string[]
  profile: ProfileValues
  status: 'active' | 'deprecated'
  replacedBy?: string
}

export interface Taxonomy {
  taxonomyVersion: number
  majors: MajorGenre[]
  tags: GenreTag[]
  majorById: ReadonlyMap<string, MajorGenre>
  subById: ReadonlyMap<string, SubGenre>
  tagById: ReadonlyMap<string, GenreTag>
}

export interface GenreSelection {
  major: string
  sub: string
  tags: string[]
  audience: Audience
  platform: Platform
}

export interface GenreValidation {
  ok: boolean
  code?: 'GENRE_SELECTION_INVALID'
  conflicts: Array<[string, string]>
  missing: string[]
  suggestions: string[]
  message?: string
}

export interface ResolvedProfile {
  values: ProfileValues
  sources: Record<string, string>
}

const TAXONOMY_ERROR = 'ENGINE_TAXONOMY_INVALID'

function bad(message: string): never {
  throw new EngineFaultError(TAXONOMY_ERROR, `taxonomy rejected: ${message}`)
}

const object = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return bad(`${path} must be an object`)
  return value as Record<string, unknown>
}

const array = (value: unknown, path: string): unknown[] => {
  if (!Array.isArray(value)) return bad(`${path} must be an array`)
  return value
}

const text = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.trim() === '') return bad(`${path} must be a non-empty string`)
  return value
}

const strings = (value: unknown, path: string): string[] =>
  value === undefined ? [] : array(value, path).map((item, index) => text(item, `${path}[${index}]`))

const idPattern = /^[a-z][a-z0-9_]*$/
const subPattern = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/

const audience = (value: unknown, path: string): Audience => {
  if (typeof value !== 'string' || !(AUDIENCES as readonly string[]).includes(value))
    return bad(`${path} must be one of ${AUDIENCES.join(', ')}`)
  return value as Audience
}

const legacyGenre = (value: unknown, path: string): Genre => {
  if (typeof value !== 'string' || !(GENRES as readonly string[]).includes(value))
    return bad(`${path} must be one of the legacy genres: ${GENRES.join(', ')}`)
  return value as Genre
}

const profile = (value: unknown, path: string): ProfileValues => {
  if (value === undefined) return {}
  const raw = object(value, path)
  for (const key of Object.keys(raw)) {
    if (!PROFILE_KEYS.includes(key as ProfileKey)) bad(`${path}.${key} is not a recognised profile key`)
  }
  const out: ProfileValues = {}
  for (const key of ['foreshadow_min_dormancy', 'motif_min_dormancy', 'foreshadow_dormant_after'] as const) {
    if (raw[key] !== undefined) {
      if (!Number.isInteger(raw[key]) || (raw[key] as number) < 0)
        bad(`${path}.${key} must be a non-negative integer`)
      out[key] = raw[key] as number
    }
  }
  if (raw.paragraph_max_words !== undefined) {
    if (
      !Number.isInteger(raw.paragraph_max_words) ||
      (raw.paragraph_max_words as number) < 20 ||
      (raw.paragraph_max_words as number) > 500
    )
      bad(`${path}.paragraph_max_words must be an integer within 20..500`)
    out.paragraph_max_words = raw.paragraph_max_words as number
  }
  if (raw.water_words !== undefined) {
    if (
      typeof raw.water_words !== 'number' ||
      !Number.isFinite(raw.water_words) ||
      raw.water_words < 0 ||
      raw.water_words > 1
    )
      bad(`${path}.water_words must be a number in [0,1]`)
    out.water_words = raw.water_words
  }
  if (raw.dialogue_ratio !== undefined) {
    const pair = array(raw.dialogue_ratio, `${path}.dialogue_ratio`)
    if (pair.length !== 2) bad(`${path}.dialogue_ratio must have two numbers`)
    const [low, high] = pair.map((item) => {
      if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1)
        bad(`${path}.dialogue_ratio values must be in [0,1]`)
      return item
    }) as [number, number]
    if (low > high) bad(`${path}.dialogue_ratio low must not exceed high`)
    out.dialogue_ratio = [low, high]
  }
  for (const key of ['pleasure_keywords', 'lexicon_add', 'lexicon_remove'] as const) {
    if (raw[key] !== undefined) out[key] = strings(raw[key], `${path}.${key}`)
  }
  return out
}

const optionalStatus = (value: unknown, path: string): 'active' | 'deprecated' => {
  if (value === undefined) return 'active'
  if (value !== 'active' && value !== 'deprecated') bad(`${path} must be active or deprecated`)
  return value
}

/** Compile the taxonomy from its parsed YAML. Throws ENGINE_TAXONOMY_INVALID. */
export function compileTaxonomy(raw: unknown): Taxonomy {
  const root = object(raw, 'taxonomy')
  if (
    root.taxonomy_version !== undefined &&
    (!Number.isInteger(root.taxonomy_version) || (root.taxonomy_version as number) < 1)
  )
    bad('taxonomy_version must be a positive integer')
  const majorsRaw = array(root.majors, 'majors')
  const tagsRaw = array(root.tags, 'tags')

  const majors: MajorGenre[] = []
  const seenMajor = new Set<string>()
  const seenSub = new Set<string>()
  for (const [index, item] of majorsRaw.entries()) {
    const row = object(item, `majors[${index}]`)
    const id = text(row.id, `majors[${index}].id`)
    if (!idPattern.test(id)) bad(`majors[${index}].id is not a stable ASCII id`)
    if (seenMajor.has(id)) bad(`duplicate major id ${id}`)
    seenMajor.add(id)
    const subsRaw = array(row.subs, `majors[${index}].subs`)
    const subs: SubGenre[] = []
    for (const [subIndex, subItem] of subsRaw.entries()) {
      const sub = object(subItem, `majors[${index}].subs[${subIndex}]`)
      const subId = text(sub.id, `majors[${index}].subs[${subIndex}].id`)
      if (!subPattern.test(subId) || !subId.startsWith(`${id}.`))
        bad(`sub id ${subId} must match ${id}.<name>`)
      if (seenSub.has(subId)) bad(`duplicate sub id ${subId}`)
      seenSub.add(subId)
      subs.push({
        id: subId,
        label: text(sub.label, `subs.${subId}.label`),
        aliases: strings(sub.aliases, `subs.${subId}.aliases`),
        audienceDefault:
          sub.audience_default === undefined
            ? 'general'
            : audience(sub.audience_default, `subs.${subId}.audience_default`),
        legacyGenre: legacyGenre(sub.legacy_genre, `subs.${subId}.legacy_genre`),
        recommendedTags: strings(sub.recommended_tags, `subs.${subId}.recommended_tags`),
        profile: profile(sub.profile, `subs.${subId}.profile`),
        status: optionalStatus(sub.status, `subs.${subId}.status`),
        ...(sub.replaced_by === undefined
          ? {}
          : { replacedBy: text(sub.replaced_by, `subs.${subId}.replaced_by`) }),
      })
    }
    const platformFitRaw =
      row.platform_fit === undefined ? {} : object(row.platform_fit, `majors[${index}].platform_fit`)
    const platformFit: Partial<Record<Platform, 'high' | 'medium' | 'low'>> = {}
    for (const platform of PLATFORMS) {
      const value = platformFitRaw[platform]
      if (value === undefined) continue
      if (value !== 'high' && value !== 'medium' && value !== 'low')
        bad(`majors.${id}.platform_fit.${platform} must be high/medium/low`)
      platformFit[platform] = value
    }
    majors.push({
      id,
      label: text(row.label, `majors[${index}].label`),
      aliases: strings(row.aliases, `majors[${index}].aliases`),
      audienceDefault:
        row.audience_default === undefined
          ? 'general'
          : audience(row.audience_default, `majors[${index}].audience_default`),
      platformFit,
      profile: profile(row.profile, `majors[${index}].profile`),
      subs,
      status: optionalStatus(row.status, `majors[${index}].status`),
      ...(row.replaced_by === undefined
        ? {}
        : { replacedBy: text(row.replaced_by, `majors[${index}].replaced_by`) }),
    })
  }

  const tags: GenreTag[] = []
  const seenTag = new Set<string>()
  for (const [index, item] of tagsRaw.entries()) {
    const row = object(item, `tags[${index}]`)
    const id = text(row.id, `tags[${index}].id`)
    if (!subPattern.test(id)) bad(`tag id ${id} must match <facet>.<name>`)
    if (seenTag.has(id)) bad(`duplicate tag id ${id}`)
    seenTag.add(id)
    const facet = row.facet
    if (typeof facet !== 'string' || !(TAG_FACETS as readonly string[]).includes(facet))
      bad(`tags.${id}.facet must be one of ${TAG_FACETS.join(', ')}`)
    if (!id.startsWith(`${facet}.`)) bad(`tags.${id}.facet does not match its id prefix`)
    tags.push({
      id,
      label: text(row.label, `tags.${id}.label`),
      facet: facet as TagFacet,
      aliases: strings(row.aliases, `tags.${id}.aliases`),
      conflicts: strings(row.conflicts, `tags.${id}.conflicts`),
      requires: strings(row.requires, `tags.${id}.requires`),
      recommendedFor: strings(row.recommended_for, `tags.${id}.recommended_for`),
      profile: profile(row.profile, `tags.${id}.profile`),
      status: optionalStatus(row.status, `tags.${id}.status`),
      ...(row.replaced_by === undefined
        ? {}
        : { replacedBy: text(row.replaced_by, `tags.${id}.replaced_by`) }),
    })
  }

  const majorById = new Map(majors.map((major) => [major.id, major]))
  const subById = new Map<string, SubGenre>()
  for (const major of majors) for (const sub of major.subs) subById.set(sub.id, sub)
  const tagById = new Map(tags.map((tag) => [tag.id, tag]))

  for (const major of majors) {
    for (const sub of major.subs) {
      for (const tagId of sub.recommendedTags) {
        if (!tagById.has(tagId)) bad(`sub ${sub.id} recommends unknown tag ${tagId}`)
      }
    }
  }
  for (const tag of tags) {
    for (const conflict of tag.conflicts) {
      if (conflict === tag.id) bad(`tag ${tag.id} conflicts with itself`)
      const other = tagById.get(conflict)
      if (other === undefined) bad(`tag ${tag.id} conflicts with unknown ${conflict}`)
      if (!other.conflicts.includes(tag.id))
        bad(`tag conflicts must be bidirectional: ${tag.id} -> ${conflict}`)
    }
    for (const required of tag.requires) {
      if (!tagById.has(required)) bad(`tag ${tag.id} requires unknown ${required}`)
    }
    for (const subId of tag.recommendedFor) {
      if (!subById.has(subId)) bad(`tag ${tag.id} recommends unknown sub ${subId}`)
    }
  }
  // requires may be at most two hops and must be acyclic.
  for (const tag of tags) {
    const seen = new Set<string>()
    let frontier = [tag.id]
    for (let depth = 0; depth < 3; depth += 1) {
      const next: string[] = []
      for (const current of frontier) {
        const node = tagById.get(current)
        if (node === undefined) continue
        for (const required of node.requires) {
          if (seen.has(required)) bad(`tag requires cycle at ${tag.id}`)
          seen.add(required)
          next.push(required)
        }
      }
      frontier = next
      if (frontier.length === 0) break
      if (depth === 2) bad(`tag ${tag.id} requires chain is deeper than 2`)
    }
  }
  for (const major of majors) {
    if (major.status === 'deprecated' && major.replacedBy === undefined)
      bad(`deprecated major ${major.id} needs replaced_by`)
  }

  return {
    taxonomyVersion: (root.taxonomy_version as number | undefined) ?? TAXONOMY_VERSION,
    majors,
    tags,
    majorById,
    subById,
    tagById,
  }
}

/** Normalise tag order: facet order, then id. Stable across input permutations. */
export function sortTags(tags: readonly string[]): string[] {
  return [...tags].sort((left, right) => {
    const leftFacet = left.split('.')[0] as TagFacet
    const rightFacet = right.split('.')[0] as TagFacet
    const facetOrder = TAG_FACETS.indexOf(leftFacet) - TAG_FACETS.indexOf(rightFacet)
    return facetOrder === 0 ? left.localeCompare(right) : facetOrder
  })
}

/** Full selection validation; returns all problems instead of throwing on the first. */
export function validateGenreSelection(selection: GenreSelection, taxonomy: Taxonomy): GenreValidation {
  const conflicts: Array<[string, string]> = []
  const missing: string[] = []
  const suggestions: string[] = []
  const fail = (message: string): GenreValidation => ({
    ok: false,
    code: 'GENRE_SELECTION_INVALID',
    conflicts,
    missing,
    suggestions,
    message,
  })

  const major = taxonomy.majorById.get(selection.major)
  if (major === undefined || major.status !== 'active')
    return fail(`unknown or inactive major ${selection.major}`)
  const sub = taxonomy.subById.get(selection.sub)
  if (sub === undefined || sub.status !== 'active') return fail(`unknown or inactive sub ${selection.sub}`)
  if (!selection.sub.startsWith(`${selection.major}.`))
    return fail(`sub ${selection.sub} does not belong to ${selection.major}`)
  if (!(AUDIENCES as readonly string[]).includes(selection.audience))
    return fail(`unknown audience ${selection.audience}`)
  if (!(PLATFORMS as readonly string[]).includes(selection.platform))
    return fail(`unknown platform ${selection.platform}`)

  const unique = new Set(selection.tags)
  if (unique.size !== selection.tags.length) return fail('tags contain duplicates')
  if (selection.tags.length < 3 || selection.tags.length > 12) return fail('select 3 to 12 tags')
  const perFacet = new Map<TagFacet, number>()
  let hasToneOrTheme = false
  for (const id of selection.tags) {
    const tag = taxonomy.tagById.get(id)
    if (tag === undefined || tag.status !== 'active') return fail(`unknown or inactive tag ${id}`)
    perFacet.set(tag.facet, (perFacet.get(tag.facet) ?? 0) + 1)
    if (tag.facet === 'tone' || tag.facet === 'theme') hasToneOrTheme = true
  }
  for (const [facet, count] of perFacet) {
    if (count > 3) return fail(`facet ${facet} has ${count} tags; maximum is 3`)
  }
  if (!hasToneOrTheme) missing.push('tone/theme')
  for (const id of selection.tags) {
    const tag = taxonomy.tagById.get(id)!
    for (const conflict of tag.conflicts) {
      if (unique.has(conflict) && id < conflict) conflicts.push([id, conflict])
    }
    for (const required of tag.requires) {
      if (!unique.has(required)) {
        missing.push(required)
        if (!suggestions.includes(required)) suggestions.push(required)
      }
    }
  }
  if (conflicts.length > 0) return fail('tag combination has conflicts')
  if (missing.length > 0) return fail(`tag combination is missing: ${missing.join(', ')}`)

  // Profile conflicts: the same key with different values across selected tags.
  const seen = new Map<ProfileKey, { value: unknown; tag: string }>()
  for (const id of selection.tags) {
    const tag = taxonomy.tagById.get(id)!
    for (const key of PROFILE_KEYS) {
      const value = tag.profile[key]
      if (value === undefined) continue
      const prior = seen.get(key)
      if (prior !== undefined && JSON.stringify(prior.value) !== JSON.stringify(value)) {
        return fail(`profile conflict on ${key}: ${prior.tag} vs ${id}`)
      }
      seen.set(key, { value, tag: id })
    }
  }

  return { ok: true, conflicts, missing, suggestions }
}

/** Throw ENGINE_GENRE_SELECTION_INVALID when the selection is not publishable. */
export function assertGenreSelection(selection: GenreSelection, taxonomy: Taxonomy): void {
  const result = validateGenreSelection(selection, taxonomy)
  if (!result.ok) {
    throw new EngineInputError(
      'ENGINE_GENRE_SELECTION_INVALID',
      result.message ?? 'genre selection is invalid',
      result.suggestions.length > 0 ? `add ${result.suggestions.join(', ')}` : undefined,
      {
        details: {
          conflicts: result.conflicts,
          missing: result.missing,
          suggestions: result.suggestions,
        },
      },
    )
  }
}

const PROFILES = new WeakMap<Taxonomy, Map<string, ResolvedProfile>>()

/**
 * Resolve the effective profile: tag > sub > major > global. All selected tag
 * values must agree; validateGenreSelection enforces that before this is called.
 */
export function resolveGenreProfile(
  selection: Pick<GenreSelection, 'major' | 'sub' | 'tags'>,
  taxonomy: Taxonomy,
  global: ProfileValues = {},
): ResolvedProfile {
  let cached = PROFILES.get(taxonomy)
  if (cached === undefined) {
    cached = new Map()
    PROFILES.set(taxonomy, cached)
  }
  const key = `${selection.major}|${selection.sub}|${sortTags(selection.tags).join(',')}|${JSON.stringify(global)}`
  const hit = cached.get(key)
  if (hit !== undefined) return hit

  const values: ProfileValues = {}
  const sources: Record<string, string> = {}
  const apply = (profile: ProfileValues, source: string): void => {
    for (const key of PROFILE_KEYS) {
      const value = profile[key]
      if (value !== undefined) {
        ;(values as Record<string, unknown>)[key] = value
        sources[key] = source
      }
    }
    const add = new Set(values.lexicon_add ?? [])
    for (const word of profile.lexicon_add ?? []) add.add(word)
    if (add.size > 0) values.lexicon_add = [...add].sort()
    const remove = new Set(values.lexicon_remove ?? [])
    for (const word of profile.lexicon_remove ?? []) remove.add(word)
    if (remove.size > 0) values.lexicon_remove = [...remove].sort()
  }
  apply(global, 'global')
  const major = taxonomy.majorById.get(selection.major)
  if (major !== undefined) apply(major.profile, `major:${major.id}`)
  const sub = taxonomy.subById.get(selection.sub)
  if (sub !== undefined) apply(sub.profile, `sub:${sub.id}`)
  for (const tagId of sortTags(selection.tags)) {
    const tag = taxonomy.tagById.get(tagId)
    if (tag !== undefined) apply(tag.profile, `tag:${tag.id}`)
  }
  const result = { values, sources }
  cached.set(key, result)
  return result
}

const LEGACY_OVERRIDES: Record<string, string> = {
  玄幻修仙: 'fantasy.xianxia',
  都市现代: 'urban.daily',
  西方奇幻: 'fantasy.western',
  悬疑推理: 'mystery.detective',
  科幻: 'scifi.hard',
  游戏系统: 'game.system',
  历史架空: 'history.alternate',
  无限流: 'mystery.infinite',
  轻小说: 'light.isekai',
  军事: 'history.military',
  末世流: 'scifi.apocalypse',
  言情: 'romance.modern',
}

/** Map a legacy 0.2.x genre string to a target sub and recommended tags. */
export function mapLegacyGenre(legacy: string, taxonomy: Taxonomy): { sub: string; tags: string[] } | null {
  const override = LEGACY_OVERRIDES[legacy]
  const match =
    (override === undefined ? undefined : taxonomy.subById.get(override)) ??
    taxonomy.majors.flatMap((major) => major.subs).find((sub) => sub.legacyGenre === legacy)
  if (match === undefined) return null
  return { sub: match.id, tags: sortTags(match.recommendedTags) }
}

/** Human-readable path, e.g. `幻想 / 仙侠`. */
export function genrePath(selection: Pick<GenreSelection, 'major' | 'sub'>, taxonomy: Taxonomy): string {
  const major = taxonomy.majorById.get(selection.major)
  const sub = taxonomy.subById.get(selection.sub)
  return `${major?.label ?? selection.major} / ${sub?.label ?? selection.sub}`
}

/** Human-readable tag line in fixed facet order. */
export function tagSummary(tags: readonly string[], taxonomy: Taxonomy): string {
  return sortTags(tags)
    .map((id) => taxonomy.tagById.get(id)?.label ?? id)
    .join(' · ')
}
