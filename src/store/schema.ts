import { GENRES, PLATFORMS, SCENE_TYPES, SCHEMA_VERSION, ERROR_CODES, EngineFaultError } from '../types.js'

/** Every persisted document the engine knows how to load. */
export type DocKind =
  | 'project'
  | 'pipeline'
  | 'chapters'
  | 'characters'
  | 'world'
  | 'locks'
  | 'foreshadows'
  | 'timeline'
  | 'relationships'
  | 'handoff'
  | 'review'
  | 'check'
  | 'worldPlan'
  | 'chapterPlan'

type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'any'

interface Field {
  type: FieldType
  required?: boolean
  enum?: readonly string[]
  items?: Field
}

const STAGE_VALUES = ['idle', 'P2', 'P3', 'P4', 'P5', 'P6', 'ready_to_archive', 'done'] as const

const f = (type: FieldType, extra: Omit<Field, 'type'> = {}): Field => ({ type, ...extra })
const req = (type: FieldType, extra: Omit<Field, 'type' | 'required'> = {}): Field => ({
  type,
  required: true,
  ...extra,
})

/**
 * Top-level shape of every document. Nested payloads stay open on purpose: the
 * engine validates what it reads (scores, summaries, plans) with dedicated
 * validators, not with a second schema language.
 */
const SCHEMAS: Record<DocKind, Record<string, Field>> = {
  project: {
    title: req('string'),
    genre: req('string', { enum: GENRES }),
    platform: req('string', { enum: PLATFORMS }),
    author: req('string'),
    description: req('string'),
    created_at: req('string'),
    targets: req('object'),
  },
  pipeline: {
    revision: req('integer'),
    chapter: req('integer'),
    stage: req('string', { enum: STAGE_VALUES }),
    rounds: req('object'),
    briefs: req('object'),
    blocking: req('array'),
    last_action: f('any'),
  },
  chapters: { chapters: req('array') },
  characters: { characters: req('array') },
  world: {
    locations: req('array'),
    abilities: req('array'),
    artifacts: req('array'),
    factions: req('array'),
    rules: req('array'),
  },
  locks: {
    locked_at_chapter: req('integer'),
    characters: req('object'),
    locations: req('object'),
  },
  foreshadows: { next_seq: req('integer'), items: req('array') },
  timeline: { next_seq: req('integer'), items: req('array') },
  relationships: { next_seq: req('integer'), items: req('array') },
  handoff: {
    current_chapter: req('integer'),
    volume: req('integer'),
    volume_name: req('string'),
    act: req('string'),
    act_progress: req('string'),
    next_chapter: req('integer'),
    last_summary: req('string'),
    open_hooks: req('array'),
    updated_at: req('string'),
  },
  review: {
    chapter: req('integer'),
    round: req('integer'),
    content_hash: req('string'),
    dimensions: req('array'),
    issues: req('array'),
    total: req('integer'),
    // Optional for documents written before P6 began re-checking PG-09; a
    // missing proof makes the P6 gate fail rather than silently passing.
    proof: f('object'),
  },
  check: {
    chapter: req('integer'),
    scope: req('array'),
    content_hash: req('string'),
    machine: req('object'),
    semantic: req('object'),
    verdict: req('string', { enum: ['pass', 'fail'] }),
  },
  worldPlan: {
    chapter: req('integer'),
    objective: req('string'),
    constraints: req('array'),
    characters: req('array'),
    locations: req('array'),
    continuity_notes: req('array'),
  },
  chapterPlan: {
    chapter: req('integer'),
    title: req('string'),
    scene_type: req('string', { enum: SCENE_TYPES }),
    narrator: req('string'),
    beats: req('array'),
    opening: req('string'),
    ending: req('string'),
    target_words: req('array'),
  },
}

const invalid = (kind: DocKind, detail: string): never => {
  throw new EngineFaultError(ERROR_CODES.SCHEMA_INVALID, `invalid ${kind} document: ${detail}`)
}

const matchesType = (value: unknown, field: Field): boolean => {
  switch (field.type) {
    case 'any':
      return true
    case 'array':
      return Array.isArray(value)
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    default:
      return false
  }
}

/**
 * Narrow an untrusted YAML value to a document shape.
 *
 * Unknown top-level keys are refused (a typo must not be silently ignored) and
 * a document newer than this engine is refused with a dedicated code, so the
 * user upgrades instead of the engine rewriting their data.
 */
export function narrow<K extends DocKind>(
  kind: K,
  value: unknown,
): Record<string, unknown> & { schema_version: 1 } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(kind, 'not an object')
  const record = value as Record<string, unknown>
  const version = record.schema_version
  if (typeof version !== 'number' || !Number.isInteger(version))
    return invalid(kind, 'missing schema_version')
  if (version > SCHEMA_VERSION) {
    throw new EngineFaultError(
      ERROR_CODES.SCHEMA_TOO_NEW,
      `refusing ${kind}: schema_version ${version} is newer than supported ${SCHEMA_VERSION}`,
      'upgrade the plugin; the file was left untouched',
    )
  }
  if (version !== SCHEMA_VERSION) invalid(kind, `unsupported schema_version ${version}`)

  const schema = SCHEMAS[kind]
  for (const key of Object.keys(record)) {
    if (key === 'schema_version') continue
    if (!(key in schema)) invalid(kind, `unknown key "${key}"`)
  }
  for (const [key, field] of Object.entries(schema)) {
    const fieldValue = record[key]
    if (fieldValue === undefined) {
      if (field.required === true) invalid(kind, `missing required key "${key}"`)
      continue
    }
    if (!matchesType(fieldValue, field)) invalid(kind, `"${key}" must be ${field.type}`)
    if (field.enum !== undefined && !field.enum.includes(fieldValue as string)) {
      invalid(kind, `"${key}" must be one of ${field.enum.join(', ')}`)
    }
  }
  return record as Record<string, unknown> & { schema_version: 1 }
}

/** Exposed for the knowledge test that every document kind is covered. */
export const DOC_KINDS = Object.keys(SCHEMAS) as DocKind[]
