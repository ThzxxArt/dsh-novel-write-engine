import { z } from 'zod'
import { AUDIENCES } from '../domain/taxonomy.js'
import { PLATFORMS } from '../types.js'
import { RoleIdSchema } from './artifacts.js'

export const PROJECT_FORMAT_VERSION = 2 as const
export const PROJECT_SCHEMA_VERSION = 2 as const

export const ModelRouteSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().optional(),
})

export const ProjectTargetsSchema = z.object({
  words_per_chapter: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  total_chapters: z.number().int().positive(),
  dialogue_ratio: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
  min_cjk_chars: z.number().int().nonnegative(),
})

export const ProjectQualitySchema = z.object({
  min_score: z.number().int().min(0).max(150),
  review_rounds: z.number().int().min(1).max(3),
})

export const ExportProfileSchema = z.object({
  author_note: z.string().default(''),
  blurb: z.string().default(''),
  tags: z.array(z.string()).default([]),
  cover_path: z.string().nullable().default(null),
  title_rule: z.string().default(''),
})

export const ProjectBudgetsSchema = z.object({
  per_chapter_usd: z.number().positive(),
  per_run_usd: z.number().positive(),
  per_task_tokens: z.number().int().positive(),
})

export const StudioConfigSchema = z.object({
  schema_version: z.literal(2),
  format_version: z.literal(2),
  id: z.string().min(1),
  title: z.string().min(1),
  author: z.string(),
  genre: z.object({
    major: z.string().min(1),
    sub: z.string().min(1),
    tags: z.array(z.string().min(1)).min(3).max(12),
  }),
  audience: z.enum(AUDIENCES),
  platform: z.enum(PLATFORMS),
  targets: ProjectTargetsSchema,
  quality: ProjectQualitySchema,
  export_profile: ExportProfileSchema.optional(),
  models: z.record(RoleIdSchema, ModelRouteSchema),
  budgets: ProjectBudgetsSchema,
  created_at: z.string(),
  updated_at: z.string(),
})
export type StudioConfig = z.infer<typeof StudioConfigSchema>

export const CanonSchema = z.object({
  schema_version: z.literal(2),
  entities: z.object({
    characters: z.array(z.record(z.string(), z.unknown())).default([]),
    locations: z.array(z.record(z.string(), z.unknown())).default([]),
    factions: z.array(z.record(z.string(), z.unknown())).default([]),
    items: z.array(z.record(z.string(), z.unknown())).default([]),
    concepts: z.array(z.record(z.string(), z.unknown())).default([]),
  }),
  relationships: z.array(z.record(z.string(), z.unknown())).default([]),
  timeline: z.array(z.record(z.string(), z.unknown())).default([]),
  foreshadows: z.array(z.record(z.string(), z.unknown())).default([]),
  resources: z.array(z.record(z.string(), z.unknown())).default([]),
  handoff: z.record(z.string(), z.unknown()).default({}),
  next_seq: z.number().int().nonnegative().default(1),
  updated_at: z.string(),
})
export type Canon = z.infer<typeof CanonSchema>

export const BookOutlineSchema = z.object({
  schema_version: z.literal(2),
  logline: z.string().default(''),
  acts: z.array(z.object({ id: z.string(), title: z.string(), summary: z.string() })).default([]),
  volumes: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        start_chapter: z.number().int().positive(),
        end_chapter: z.number().int().positive(),
        arc: z.string(),
      }),
    )
    .default([]),
  updated_at: z.string(),
})
export type BookOutline = z.infer<typeof BookOutlineSchema>
