import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { FsStore } from '../../store/fs.js'
import { ensureDirAt } from '../../assets.js'
import { loadTaxonomy } from '../../taxonomy.js'
import {
  assertGenreSelection,
  resolveGenreProfile,
  type Audience,
  type Taxonomy,
} from '../../domain/taxonomy.js'
import {
  ProjectTargetsSchema,
  ProjectQualitySchema,
  ProjectBudgetsSchema,
  StudioConfigSchema,
  type BookOutline,
  type Canon,
  type StudioConfig,
  ProjectTargetsSchema as Targets,
} from '../../contracts/project.js'
import type { Platform } from '../../types.js'
import type { RoleId } from '../../contracts/artifacts.js'
import { ROLE_IDS } from '../../contracts/roles.js'
import { StudioError, STUDIO_ERROR_CODES } from '../../contracts/errors.js'
import { openStudioDb } from '../../storage/db.js'
import { upsertProject } from '../../storage/repositories/runs.js'

export const STUDIO_FILE = 'studio.yaml'
export const BIBLE_DIR = 'bible'
export const OUTLINE_DIR = 'outline'
export const MANUSCRIPT_DIR = 'manuscript'
export const REVIEWS_DIR = 'reviews'
export const STATE_DIR = 'state'
export const RUNS_DIR = 'runs'
export const EXPORTS_DIR = 'exports'
export const STUDIO_DIR = '.studio'
export const DB_FILE = '.studio/studio.db'
export const ARTIFACT_DIR = '.studio/artifacts'
export const BACKUP_DIR = '.studio/backups'
export const LOG_DIR = '.studio/logs'

export interface ProjectPaths {
  root: string
  studio: string
  bible: string
  outline: string
  manuscript: string
  reviews: string
  state: string
  runs: string
  exports: string
  studioDir: string
  db: string
  artifacts: string
  backups: string
  logs: string
}

export const projectPaths = (root: string): ProjectPaths => ({
  root: resolve(root),
  studio: STUDIO_FILE,
  bible: BIBLE_DIR,
  outline: OUTLINE_DIR,
  manuscript: MANUSCRIPT_DIR,
  reviews: REVIEWS_DIR,
  state: STATE_DIR,
  runs: RUNS_DIR,
  exports: EXPORTS_DIR,
  studioDir: STUDIO_DIR,
  db: DB_FILE,
  artifacts: ARTIFACT_DIR,
  backups: BACKUP_DIR,
  logs: LOG_DIR,
})

export const chapterFileName = (chapter: number): string => `ch-${String(chapter).padStart(4, '0')}.md`
export const chapterFile = (chapter: number): string => `${MANUSCRIPT_DIR}/${chapterFileName(chapter)}`
export const chapterPlanFile = (chapter: number): string =>
  `${OUTLINE_DIR}/chapters/ch-${String(chapter).padStart(4, '0')}.yaml`
export const reviewDir = (chapter: number): string => `${REVIEWS_DIR}/ch-${String(chapter).padStart(4, '0')}`
export const reviewFile = (chapter: number, role: string): string => `${reviewDir(chapter)}/${role}.yaml`
export const volumeFile = (volume: number): string =>
  `${OUTLINE_DIR}/volumes/v-${String(volume).padStart(2, '0')}.yaml`
export const bibleCharacterFile = (slug: string): string => `${BIBLE_DIR}/characters/${slug}.yaml`

export interface InitProjectInput {
  root: string
  title: string
  author?: string
  genre: { major: string; sub: string; tags: string[] }
  audience: Audience
  platform: Platform
  premise?: string
  targets?: Partial<{
    words_per_chapter: [number, number]
    total_chapters: number
    dialogue_ratio: [number, number]
    min_cjk_chars: number
  }>
  quality?: Partial<{ min_score: number; review_rounds: number }>
  models?: Partial<Record<RoleId, { provider: string; model: string; reasoningEffort?: string }>>
  budgets?: Partial<{ per_chapter_usd: number; per_run_usd: number; per_task_tokens: number }>
}

const platformTargets: Record<Platform, { words: [number, number]; dialogue: [number, number] }> = {
  fanqie: { words: [2200, 3200], dialogue: [0.4, 0.6] },
  qidian: { words: [2200, 3500], dialogue: [0.3, 0.5] },
  qimao: { words: [1800, 2600], dialogue: [0.45, 0.65] },
  jinjiang: { words: [2500, 4000], dialogue: [0.35, 0.55] },
}

const defaultModels = (): Record<RoleId, { provider: string; model: string }> => {
  const models = {} as Record<RoleId, { provider: string; model: string }>
  for (const role of ROLE_IDS) {
    const reasoning = role === 'showrunner' || role === 'architect' || role === 'worldsmith'
    models[role] = { provider: 'deepseek', model: reasoning ? 'deepseek-reasoner' : 'deepseek-chat' }
  }
  return models
}

const emptyBible = (now: string, premise: string): Record<string, string> => ({
  [`${BIBLE_DIR}/premise.md`]: premise === '' ? '（待填写）' : premise,
  [`${BIBLE_DIR}/themes.md`]: '# 主题\n\n（待填写）\n',
  [`${BIBLE_DIR}/style/guide.md`]: '# 文风指南\n\n（待填写）\n',
  [`${BIBLE_DIR}/style/fingerprint.json`]: `${JSON.stringify({ version: 1, sentence_length: [], dialogue_ratio: 0, top_words: [] }, null, 2)}\n`,
  [`${BIBLE_DIR}/world/rules.yaml`]: stringifyYaml(
    { schema_version: 2, rules: [], updated_at: now },
    { lineWidth: 0 },
  ),
  [`${BIBLE_DIR}/world/factions.yaml`]: stringifyYaml(
    { schema_version: 2, factions: [], updated_at: now },
    { lineWidth: 0 },
  ),
  [`${BIBLE_DIR}/world/locations.yaml`]: stringifyYaml(
    { schema_version: 2, locations: [], updated_at: now },
    { lineWidth: 0 },
  ),
  [`${BIBLE_DIR}/world/glossary.yaml`]: stringifyYaml(
    { schema_version: 2, terms: [], updated_at: now },
    { lineWidth: 0 },
  ),
})

/** Create a complete format-v2 project. Existing directories are refused. */
export async function initProjectV2(
  input: InitProjectInput,
): Promise<{ config: StudioConfig; paths: ProjectPaths; taxonomy: Taxonomy }> {
  const root = resolve(input.root)
  const store = new FsStore(root)
  ensureDirAt(root)
  if (await store.exists(STUDIO_FILE)) {
    throw new StudioError(
      STUDIO_ERROR_CODES.PROJECT_EXISTS,
      `a studio project already exists at ${root}`,
      'choose a new directory or run novel import for a 0.2.x project',
    )
  }
  const taxonomy = loadTaxonomy()
  const selection = {
    major: input.genre.major,
    sub: input.genre.sub,
    tags: input.genre.tags,
    audience: input.audience,
    platform: input.platform,
  }
  assertGenreSelection(selection, taxonomy)
  const profile = resolveGenreProfile(selection, taxonomy)
  const now = new Date().toISOString()
  const defaults = platformTargets[input.platform]
  const targets = ProjectTargetsSchema.parse({
    words_per_chapter: input.targets?.words_per_chapter ?? defaults.words,
    total_chapters: input.targets?.total_chapters ?? 120,
    dialogue_ratio: input.targets?.dialogue_ratio ?? defaults.dialogue,
    min_cjk_chars: input.targets?.min_cjk_chars ?? 1800,
  })
  const quality = ProjectQualitySchema.parse({
    min_score: input.quality?.min_score ?? 120,
    review_rounds: input.quality?.review_rounds ?? 3,
  })
  const budgets = ProjectBudgetsSchema.parse({
    per_chapter_usd: input.budgets?.per_chapter_usd ?? 0.6,
    per_run_usd: input.budgets?.per_run_usd ?? 30,
    per_task_tokens: input.budgets?.per_task_tokens ?? 32_000,
  })
  const models = { ...defaultModels(), ...(input.models ?? {}) }
  const config = StudioConfigSchema.parse({
    schema_version: 2,
    format_version: 2,
    id: ulid(),
    title: input.title,
    author: input.author ?? '',
    genre: { major: selection.major, sub: selection.sub, tags: selection.tags },
    audience: selection.audience,
    platform: selection.platform,
    targets,
    quality,
    models,
    budgets,
    created_at: now,
    updated_at: now,
  })

  const paths = projectPaths(root)
  await store.ensureDir(BIBLE_DIR)
  await store.ensureDir(`${BIBLE_DIR}/style`)
  await store.ensureDir(`${BIBLE_DIR}/world`)
  await store.ensureDir(`${BIBLE_DIR}/characters`)
  await store.ensureDir(`${OUTLINE_DIR}/volumes`)
  await store.ensureDir(`${OUTLINE_DIR}/chapters`)
  await store.ensureDir(MANUSCRIPT_DIR)
  await store.ensureDir(REVIEWS_DIR)
  await store.ensureDir(STATE_DIR)
  await store.ensureDir(RUNS_DIR)
  await store.ensureDir(EXPORTS_DIR)
  await store.ensureDir(ARTIFACT_DIR)
  await store.ensureDir(BACKUP_DIR)
  await store.ensureDir(LOG_DIR)

  await store.writeText(STUDIO_FILE, stringifyYaml(config, { lineWidth: 0 }))
  for (const [path, text] of Object.entries(emptyBible(now, input.premise ?? ''))) {
    await store.writeText(path, text)
  }
  const outline: BookOutline = { schema_version: 2, logline: '', acts: [], volumes: [], updated_at: now }
  await store.writeText(`${OUTLINE_DIR}/book.yaml`, stringifyYaml(outline, { lineWidth: 0 }))
  const canon: Canon = {
    schema_version: 2,
    entities: { characters: [], locations: [], factions: [], items: [], concepts: [] },
    relationships: [],
    timeline: [],
    foreshadows: [],
    resources: [],
    handoff: {},
    next_seq: 1,
    updated_at: now,
  }
  await store.writeText(`${STATE_DIR}/canon.yaml`, stringifyYaml(canon, { lineWidth: 0 }))
  await store.writeText(
    `${STATE_DIR}/handoff.yaml`,
    stringifyYaml({ schema_version: 2, handoff: {}, updated_at: now }, { lineWidth: 0 }),
  )
  await store.writeText(
    `${STUDIO_DIR}/project.json`,
    `${JSON.stringify({ id: config.id, format_version: 2, taxonomy_version: taxonomy.taxonomyVersion, profile, created_at: now }, null, 2)}\n`,
  )

  const db = openStudioDb(join(root, DB_FILE))
  try {
    upsertProject(db.orm, {
      id: config.id,
      root,
      title: config.title,
      author: config.author,
      formatVersion: 2,
    })
  } finally {
    db.close()
  }
  return { config, paths, taxonomy }
}

export interface LoadedProject {
  root: string
  store: FsStore
  config: StudioConfig
  paths: ProjectPaths
  taxonomy: Taxonomy
}

/** Load and semantically validate a format-v2 project. */
export async function loadProjectV2(root: string): Promise<LoadedProject> {
  const absolute = resolve(root)
  const store = new FsStore(absolute)
  const text = await store.readText(STUDIO_FILE)
  if (text === null) {
    throw new StudioError(
      STUDIO_ERROR_CODES.PROJECT_NOT_FOUND,
      `no studio.yaml at ${absolute}`,
      'run novel init, or import a 0.2.x project with novel import',
    )
  }
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error) {
    throw new StudioError(
      STUDIO_ERROR_CODES.PROJECT_INVALID,
      `studio.yaml is not valid YAML`,
      'fix the YAML or restore .studio/backups',
      { root: absolute },
      { cause: error },
    )
  }
  const parsed = StudioConfigSchema.safeParse(raw)
  if (!parsed.success) {
    throw new StudioError(
      STUDIO_ERROR_CODES.PROJECT_INVALID,
      `studio.yaml does not match format v2`,
      '0.3.0 reads only format_version 2; import 0.2.x projects instead',
      { issues: parsed.error.issues },
    )
  }
  const taxonomy = loadTaxonomy()
  assertGenreSelection(
    {
      major: parsed.data.genre.major,
      sub: parsed.data.genre.sub,
      tags: parsed.data.genre.tags,
      audience: parsed.data.audience,
      platform: parsed.data.platform,
    },
    taxonomy,
  )
  if (parsed.data.targets.words_per_chapter[0] > parsed.data.targets.words_per_chapter[1]) {
    throw new StudioError(STUDIO_ERROR_CODES.PROJECT_INVALID, 'words_per_chapter min exceeds max')
  }
  return { root: absolute, store, config: parsed.data, paths: projectPaths(absolute), taxonomy }
}

export async function saveProjectConfig(
  project: LoadedProject,
  patch: Partial<StudioConfig>,
): Promise<StudioConfig> {
  const next = StudioConfigSchema.parse({ ...project.config, ...patch, updated_at: new Date().toISOString() })
  assertGenreSelection(
    {
      major: next.genre.major,
      sub: next.genre.sub,
      tags: next.genre.tags,
      audience: next.audience,
      platform: next.platform,
    },
    project.taxonomy,
  )
  await project.store.writeText(STUDIO_FILE, stringifyYaml(next, { lineWidth: 0 }))
  return next
}

export function parseProjectTargets(value: unknown): StudioConfig['targets'] {
  return Targets.parse(value)
}

export function profileFor(project: LoadedProject): ReturnType<typeof resolveGenreProfile> {
  return resolveGenreProfile(
    {
      major: project.config.genre.major,
      sub: project.config.genre.sub,
      tags: project.config.genre.tags,
    },
    project.taxonomy,
  )
}
