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

/* Nested shape checks: top-level keys alone let amend write a document whose
 * records crash the panel or a rule on the next read. Only fields the engine
 * actually dereferences are pinned here. */
const objectAt = (kind: DocKind, value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(kind, `${path} must be an object`)
  }
  return value as Record<string, unknown>
}

const listAt = (kind: DocKind, value: unknown, path: string): unknown[] => {
  if (!Array.isArray(value)) return invalid(kind, `${path} must be an array`)
  return value
}

const stringAt = (kind: DocKind, value: unknown, path: string): string => {
  if (typeof value !== 'string') return invalid(kind, `${path} must be a string`)
  return value
}

const numberAt = (kind: DocKind, value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return invalid(kind, `${path} must be a number`)
  }
  return value
}

const integerAt = (kind: DocKind, value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return invalid(kind, `${path} must be an integer`)
  }
  return value
}

const booleanAt = (kind: DocKind, value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') return invalid(kind, `${path} must be a boolean`)
  return value
}

const optionalString = (kind: DocKind, value: unknown, path: string): void => {
  if (value !== undefined) stringAt(kind, value, path)
}

const validateRecords = (
  kind: DocKind,
  value: unknown,
  path: string,
  validate: (record: Record<string, unknown>, path: string) => void,
): void => {
  for (const [index, raw] of listAt(kind, value, path).entries()) {
    validate(objectAt(kind, raw, `${path}[${index}]`), `${path}[${index}]`)
  }
}

const validateSummary = (kind: DocKind, value: unknown, path: string): void => {
  const summary = objectAt(kind, value, path)
  for (const key of ['events', 'characters_appeared', 'pleasure_points'] as const) {
    for (const [index, item] of listAt(kind, summary[key], `${path}.${key}`).entries()) {
      stringAt(kind, item, `${path}.${key}[${index}]`)
    }
  }
  const foreshadows = objectAt(kind, summary.foreshadows, `${path}.foreshadows`)
  for (const key of ['planted', 'advanced', 'resolved'] as const) {
    listAt(kind, foreshadows[key], `${path}.foreshadows.${key}`)
  }
  objectAt(kind, summary.new_elements, `${path}.new_elements`)
  listAt(kind, summary.resource_changes, `${path}.resource_changes`)
  stringAt(kind, summary.opening, `${path}.opening`)
  const continuity = objectAt(kind, summary.continuity, `${path}.continuity`)
  stringAt(kind, continuity.opens_from, `${path}.continuity.opens_from`)
  stringAt(kind, continuity.ends_with, `${path}.continuity.ends_with`)
  numberAt(kind, summary.hook_strength, `${path}.hook_strength`)
  stringAt(kind, summary.plot_advancement, `${path}.plot_advancement`)
}

const validateNested = (kind: DocKind, record: Record<string, unknown>): void => {
  switch (kind) {
    case 'project': {
      const targets = objectAt(kind, record.targets, 'targets')
      for (const key of ['words_per_chapter', 'dialogue_ratio'] as const) {
        const pair = listAt(kind, targets[key], `targets.${key}`)
        if (pair.length !== 2) invalid(kind, `targets.${key} must contain two numbers`)
        for (const [index, item] of pair.entries()) numberAt(kind, item, `targets.${key}[${index}]`)
      }
      if (targets.total_chapters !== null) integerAt(kind, targets.total_chapters, 'targets.total_chapters')
      return
    }
    case 'chapters':
      validateRecords(kind, record.chapters, 'chapters', (row, path) => {
        integerAt(kind, row.num, `${path}.num`)
        stringAt(kind, row.title, `${path}.title`)
        stringAt(kind, row.file, `${path}.file`)
        numberAt(kind, row.word_count, `${path}.word_count`)
        numberAt(kind, row.dialogue_lines, `${path}.dialogue_lines`)
        numberAt(kind, row.dialogue_ratio, `${path}.dialogue_ratio`)
        stringAt(kind, row.scene_type, `${path}.scene_type`)
        stringAt(kind, row.narrator, `${path}.narrator`)
        numberAt(kind, row.score, `${path}.score`)
        stringAt(kind, row.status, `${path}.status`)
        stringAt(kind, row.content_hash, `${path}.content_hash`)
        validateSummary(kind, row.summary, `${path}.summary`)
        if (row.assigned_ids !== undefined) objectAt(kind, row.assigned_ids, `${path}.assigned_ids`)
        optionalString(kind, row.archive_digest, `${path}.archive_digest`)
      })
      return
    case 'characters':
      validateRecords(kind, record.characters, 'characters', (row, path) => {
        stringAt(kind, row.name, `${path}.name`)
        stringAt(kind, row.role, `${path}.role`)
        integerAt(kind, row.first_appearance, `${path}.first_appearance`)
        objectAt(kind, row.profile, `${path}.profile`)
        objectAt(kind, row.current_state, `${path}.current_state`)
        listAt(kind, row.growth, `${path}.growth`)
        integerAt(kind, row.updated_at, `${path}.updated_at`)
      })
      return
    case 'world':
      validateRecords(kind, record.locations, 'locations', (row, path) => {
        stringAt(kind, row.name, `${path}.name`)
        integerAt(kind, row.first_appearance, `${path}.first_appearance`)
        booleanAt(kind, row.locked, `${path}.locked`)
        stringAt(kind, row.description, `${path}.description`)
        stringAt(kind, row.layout, `${path}.layout`)
        numberAt(kind, row.capacity, `${path}.capacity`)
        listAt(kind, row.changes, `${path}.changes`)
      })
      for (const key of ['abilities', 'artifacts', 'factions', 'rules'] as const) {
        listAt(kind, record[key], key)
      }
      return
    case 'locks': {
      integerAt(kind, record.locked_at_chapter, 'locked_at_chapter')
      const characters = objectAt(kind, record.characters, 'characters')
      for (const [name, raw] of Object.entries(characters)) {
        const row = objectAt(kind, raw, `characters.${name}`)
        integerAt(kind, row.first_appearance, `characters.${name}.first_appearance`)
        integerAt(kind, row.locked_at, `characters.${name}.locked_at`)
        stringAt(kind, row.appearance, `characters.${name}.appearance`)
      }
      const locations = objectAt(kind, record.locations, 'locations')
      for (const [name, raw] of Object.entries(locations)) {
        const row = objectAt(kind, raw, `locations.${name}`)
        integerAt(kind, row.first_appearance, `locations.${name}.first_appearance`)
        integerAt(kind, row.locked_at, `locations.${name}.locked_at`)
        stringAt(kind, row.layout, `locations.${name}.layout`)
        numberAt(kind, row.capacity, `locations.${name}.capacity`)
      }
      return
    }
    case 'foreshadows':
      integerAt(kind, record.next_seq, 'next_seq')
      validateRecords(kind, record.items, 'items', (row, path) => {
        stringAt(kind, row.id, `${path}.id`)
        stringAt(kind, row.title, `${path}.title`)
        integerAt(kind, row.planted, `${path}.planted`)
        integerAt(kind, row.last_touched, `${path}.last_touched`)
        stringAt(kind, row.status, `${path}.status`)
        stringAt(kind, row.description, `${path}.description`)
        listAt(kind, row.advance_log, `${path}.advance_log`)
      })
      return
    case 'timeline':
      integerAt(kind, record.next_seq, 'next_seq')
      validateRecords(kind, record.items, 'items', (row, path) => {
        stringAt(kind, row.id, `${path}.id`)
        integerAt(kind, row.chapter, `${path}.chapter`)
        stringAt(kind, row.story_time, `${path}.story_time`)
        stringAt(kind, row.description, `${path}.description`)
        stringAt(kind, row.location, `${path}.location`)
        listAt(kind, row.characters, `${path}.characters`)
      })
      return
    case 'relationships':
      integerAt(kind, record.next_seq, 'next_seq')
      validateRecords(kind, record.items, 'items', (row, path) => {
        stringAt(kind, row.id, `${path}.id`)
        stringAt(kind, row.a, `${path}.a`)
        stringAt(kind, row.b, `${path}.b`)
        stringAt(kind, row.type, `${path}.type`)
        integerAt(kind, row.since, `${path}.since`)
        stringAt(kind, row.description, `${path}.description`)
        listAt(kind, row.evolution, `${path}.evolution`)
      })
      return
    case 'handoff':
      validateRecords(kind, record.open_hooks, 'open_hooks', (row, path) => {
        stringAt(kind, row.id, `${path}.id`)
        stringAt(kind, row.title, `${path}.title`)
      })
      return
    case 'review':
      validateRecords(kind, record.dimensions, 'dimensions', (row, path) => {
        stringAt(kind, row.id, `${path}.id`)
        numberAt(kind, row.max, `${path}.max`)
        listAt(kind, row.deductions, `${path}.deductions`)
      })
      validateRecords(kind, record.issues, 'issues', (row, path) => {
        stringAt(kind, row.id, `${path}.id`)
        stringAt(kind, row.severity, `${path}.severity`)
        stringAt(kind, row.status, `${path}.status`)
      })
      return
    default:
      return
  }
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
  validateNested(kind, record)
  return record as Record<string, unknown> & { schema_version: 1 }
}

/** Exposed for the knowledge test that every document kind is covered. */
export const DOC_KINDS = Object.keys(SCHEMAS) as DocKind[]
