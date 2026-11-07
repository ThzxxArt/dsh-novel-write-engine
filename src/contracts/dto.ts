import { z } from 'zod'
import {
  ArtifactKindSchema,
  ArtifactStatusSchema,
  ChapterPlanSchema,
  DraftSchema,
  RoleIdSchema,
} from './artifacts.js'
import { BoardSnapshotSchema, StudioEventSchema } from './events.js'
import { AUDIENCES, TAG_FACETS } from '../domain/taxonomy.js'
import { PLATFORMS } from '../types.js'

export const GenreSelectionDtoSchema = z.object({
  major: z.string(),
  sub: z.string(),
  tags: z.array(z.string()).min(3).max(12),
  audience: z.enum(AUDIENCES),
  platform: z.enum(PLATFORMS),
})
export type GenreSelectionDto = z.infer<typeof GenreSelectionDtoSchema>

export const ProjectDtoSchema = z.object({
  id: z.string(),
  root: z.string(),
  title: z.string(),
  author: z.string(),
  genre: GenreSelectionDtoSchema,
  genre_path: z.string(),
  tags: z.array(z.string()),
  format_version: z.literal(2),
  created_at: z.string(),
  updated_at: z.string(),
})
export type ProjectDto = z.infer<typeof ProjectDtoSchema>

export const BootstrapSchema = z.object({
  version: z.literal(8),
  project: ProjectDtoSchema.nullable(),
  roles: z.array(
    z.object({ id: RoleIdSchema, label: z.string(), preset: z.string(), canWrite: z.array(z.string()) }),
  ),
  capabilities: z.object({
    subagents: z.boolean(),
    sqlite: z.boolean(),
    fts5: z.boolean(),
    network: z.boolean(),
  }),
  taxonomy: z.object({
    majors: z.array(z.object({ id: z.string(), label: z.string(), subCount: z.number() })),
    facets: z.array(z.enum(TAG_FACETS)),
    tagCount: z.number(),
  }),
})
export type Bootstrap = z.infer<typeof BootstrapSchema>

export const StatusDtoSchema = z.object({
  project: ProjectDtoSchema,
  stage: z.string(),
  chapter: z.number().int().positive(),
  words: z.number().int().nonnegative(),
  score: z.number().nullable(),
  min_score: z.number().int().min(0).max(150).optional(),
  blocking: z.number().int().nonnegative(),
  run: z
    .object({ id: z.string(), kind: z.string(), status: z.string(), targetChapter: z.number().nullable() })
    .nullable(),
  next: z.object({ action: z.string(), label: z.string(), args: z.record(z.string(), z.unknown()) }),
  counts: z.object({
    chapters: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    openFindings: z.number().int().nonnegative(),
  }),
  cost_usd: z.number().nonnegative(),
})
export type StatusDto = z.infer<typeof StatusDtoSchema>

export const ChapterRowSchema = z.object({
  chapter: z.number().int().positive(),
  title: z.string(),
  stage: z.string(),
  words: z.number().int().nonnegative(),
  score: z.number().nullable(),
  blockers: z.number().int().nonnegative(),
  updated_at: z.string().nullable(),
})
export type ChapterRow = z.infer<typeof ChapterRowSchema>

export const ArtifactSummarySchema = z.object({
  id: z.string(),
  kind: ArtifactKindSchema,
  chapter: z.number().int().positive().nullable(),
  version: z.number().int().positive(),
  status: ArtifactStatusSchema,
  path: z.string(),
  content_hash: z.string(),
  created_at: z.string(),
  role: RoleIdSchema,
  model: z.string(),
})
export type ArtifactSummary = z.infer<typeof ArtifactSummarySchema>

export const ArtifactDetailSchema = ArtifactSummarySchema.extend({
  content: z.unknown(),
  base_artifact_id: z.string().nullable(),
  provenance: z.record(z.string(), z.unknown()),
})
export type ArtifactDetail = z.infer<typeof ArtifactDetailSchema>

export const SearchHitSchema = z.object({
  id: z.string(),
  kind: z.string(),
  chapter: z.number().int().positive().nullable(),
  sourcePath: z.string(),
  sourceHash: z.string(),
  text: z.string(),
  score: z.number(),
  reasons: z.array(z.string()),
})
export type SearchHit = z.infer<typeof SearchHitSchema>

export const ActionRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('run.start'),
    kind: z.enum(['book', 'chapter', 'rewrite', 'review', 'market']),
    chapter: z.number().int().positive().optional(),
  }),
  z.object({ action: z.literal('run.pause'), runId: z.string() }),
  z.object({ action: z.literal('run.resume'), runId: z.string() }),
  z.object({ action: z.literal('run.cancel'), runId: z.string() }),
  z.object({
    action: z.literal('human.approve'),
    runId: z.string(),
    gate: z.enum(['bible', 'outline', 'chapter', 'publish']),
    decision: z.enum(['approve', 'reject', 'edit', 'regenerate']),
    feedback: z.string().optional(),
    approvalToken: z.string().min(1),
  }),
  z.object({
    action: z.literal('artifact.save'),
    kind: ArtifactKindSchema,
    chapter: z.number().int().positive().nullable(),
    content: z.unknown(),
    baseHash: z.string().nullable(),
    reason: z.string().min(1),
  }),
  z.object({
    action: z.literal('chapter.save'),
    chapter: z.number().int().positive(),
    content: z.string(),
    baseHash: z.string().nullable(),
    title: z.string().optional(),
  }),
  z.object({
    action: z.literal('outline.move'),
    chapter: z.number().int().positive(),
    toVolume: z.number().int().nonnegative(),
  }),
  z.object({ action: z.literal('memory.reindex') }),
  z.object({
    action: z.literal('export.run'),
    kind: z.enum(['markdown', 'txt', 'epub', 'outline', 'worldbook', 'proposal']),
    profile: z.string().optional(),
  }),
  z.object({
    action: z.literal('settings.save'),
    models: z.record(z.string(), z.object({ provider: z.string(), model: z.string() })).optional(),
    budgets: z.record(z.string(), z.number()).optional(),
  }),
])
export type ActionRequest = z.infer<typeof ActionRequestSchema>

export const ActionResponseSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
})
export type ActionResponse = z.infer<typeof ActionResponseSchema>

export const BoardDtoSchema = BoardSnapshotSchema
export const SSEEventSchema = StudioEventSchema
export const ChapterPlanDtoSchema = ChapterPlanSchema
export const DraftDtoSchema = DraftSchema
