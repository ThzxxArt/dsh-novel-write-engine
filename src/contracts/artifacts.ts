import { z } from 'zod'

/** 0.3.0 on-disk schema version. */
export const ARTIFACT_SCHEMA_VERSION = 2 as const

export const RoleIdSchema = z.enum([
  'showrunner',
  'architect',
  'worldsmith',
  'planner',
  'drafter',
  'critic-story',
  'critic-character',
  'critic-prose',
  'continuity',
  'polisher',
  'archivist',
  'radar',
])
export type RoleId = z.infer<typeof RoleIdSchema>

export const ArtifactKindSchema = z.enum([
  'BiblePlan',
  'WorldbookPatch',
  'OutlinePlan',
  'VolumePlan',
  'ChapterPlan',
  'Draft',
  'ReviewReport',
  'ContinuityReport',
  'PolishPatch',
  'StateDelta',
  'Decision',
  'MarketBrief',
  'Export',
])
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>

export const CitationSchema = z.object({
  sourcePath: z.string().min(1),
  sourceHash: z.string().min(1),
  quote: z.string().min(8),
  location: z.string().min(1),
})
export type Citation = z.infer<typeof CitationSchema>

export const SceneTypeSchema = z.enum(['战斗/动作章', '日常过渡章', '情感爆发章', '纯叙事章'])
export type SceneType = z.infer<typeof SceneTypeSchema>

export const ChapterPlanSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('ChapterPlan'),
  chapter: z.number().int().positive(),
  // PG-04 is a hard gate. The schema must reject a title the gate would reject,
  // so the model gets a repair prompt instead of burning a whole review round.
  title: z.string().regex(/^第\d+章\s+\S+/u, 'title must start with 第N章 '),
  scene_type: SceneTypeSchema,
  pov: z.string().min(1),
  cast: z.array(z.string()).min(1),
  goal: z.string().min(1),
  conflict: z.string().min(1),
  turn: z.string().min(1),
  outcome: z.string().min(1),
  target_words: z.number().int().positive(),
  hook: z.string().min(1),
  foreshadows: z.array(z.string()),
  notes: z.array(z.string()),
  citations: z.array(CitationSchema),
  open_questions: z.array(z.string()),
})
export type ChapterPlan = z.infer<typeof ChapterPlanSchema>

export const ChapterSummarySchema = z.object({
  events: z.array(z.string()).min(1),
  characters_appeared: z.array(z.string()),
  foreshadows: z.object({
    planted: z.array(
      z.object({
        key: z.string().min(1),
        title: z.string().min(1),
        description: z.string().min(1),
        anchor: z.string().min(8).optional(),
        planned_resolve: z.number().int().nullable(),
        kind: z.enum(['plot', 'motif']),
      }),
    ),
    advanced: z.array(
      z.object({ key: z.string().min(1), note: z.string().min(1), new_info: z.string().min(1) }),
    ),
    resolved: z.array(z.string()),
  }),
  new_elements: z.object({
    locations: z.array(z.string()),
    abilities: z.array(z.string()),
    artifacts: z.array(z.string()),
  }),
  new_element_anchors: z.record(z.string(), z.array(z.string())).optional(),
  resource_changes: z.array(
    z.object({
      character: z.string(),
      resource: z.string(),
      delta: z.number().int(),
      reason: z.string(),
    }),
  ),
  opening: z.string().min(8),
  continuity: z.object({ opens_from: z.string(), ends_with: z.string() }),
  hook_strength: z.number().int().min(1).max(5),
  pleasure_points: z.array(z.string()),
  plot_advancement: z.enum(['high', 'mid', 'low']),
})
export type ChapterSummary = z.infer<typeof ChapterSummarySchema>

export const DraftSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('Draft'),
  chapter: z.number().int().positive(),
  title: z.string().regex(/^第\d+章\s+\S+/u, 'title must start with 第N章 '),
  scene_type: SceneTypeSchema,
  narrator: z.string().min(1),
  content: z.string().min(1),
  summary: ChapterSummarySchema,
  self_check: z.object({
    word_count: z.number().int().positive(),
    cjk_chars: z.number().int().nonnegative(),
    scene_contract: z.object({
      goal: z.string(),
      conflict: z.string(),
      turn: z.string(),
      outcome: z.string(),
    }),
  }),
  citations: z.array(CitationSchema),
  open_questions: z.array(z.string()),
  base_artifact_id: z.string().nullable(),
  expected_hash: z.string().nullable(),
})
export type Draft = z.infer<typeof DraftSchema>

export const ReviewFindingSchema = z.object({
  id: z.string().min(1),
  dimension: z.string().min(1),
  severity: z.enum(['blocker', 'advisory']),
  location: z.string().min(1),
  evidence: z.string().min(8),
  problem: z.string().min(1),
  fix: z.string().min(1),
  status: z.enum(['open', 'fixed', 'waived']),
  /** Current-draft sentence that closes a blocker; filled from the DB after a human fix. */
  resolution: z.string().min(8).nullable().optional(),
})
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>

/**
 * The 15 commercial dimensions are a closed set. Free-form ids let a model
 * invent `structure`/`pacing`, which the gate then rejects as an ownership
 * violation after a full review round. A closed enum turns that into a cheap
 * schema repair instead.
 */
export const ReviewDimensionSchema = z.object({
  id: z.enum([
    'R-W-01',
    'R-W-02',
    'R-W-03',
    'R-W-04',
    'R-W-05',
    'R-W-06',
    'R-W-07',
    'R-W-08',
    'R-W-09',
    'R-W-10',
    'R-W-11',
    'R-W-12',
    'R-W-13',
    'R-W-14',
    'R-W-15',
  ]),
  max: z.number().int().positive(),
  deductions: z.array(
    z.object({
      rule: z.string().min(1),
      location: z.string().min(1),
      delta: z.number().positive(),
      note: z.string().min(1),
    }),
  ),
})

export const ReviewReportSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('ReviewReport'),
  chapter: z.number().int().positive(),
  role: z.enum(['critic-story', 'critic-character', 'critic-prose']),
  base_hash: z.string().min(1),
  findings: z.array(ReviewFindingSchema),
  dimensions: z.array(ReviewDimensionSchema),
  total: z.number().int().min(0).max(150),
  proof: z.object({
    opening: CitationSchema,
    middle: CitationSchema,
    ending: CitationSchema,
  }),
  confidence: z.number().min(0).max(1),
  open_questions: z.array(z.string()),
})
export type ReviewReport = z.infer<typeof ReviewReportSchema>

export const ContinuityFindingSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['canon', 'timeline', 'foreshadow', 'resource', 'relationship', 'space']),
  severity: z.enum(['blocker', 'advisory']),
  location: z.string().min(1),
  evidence: z.string().min(8),
  problem: z.string().min(1),
  fix: z.string().min(1),
  status: z.enum(['open', 'fixed', 'waived']),
  resolution: z.string().min(8).nullable().optional(),
})

export const ContinuityReportSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('ContinuityReport'),
  chapter: z.number().int().positive(),
  base_hash: z.string().min(1),
  findings: z.array(ContinuityFindingSchema),
  canon_conflicts: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  citations: z.array(CitationSchema),
  open_questions: z.array(z.string()),
})
export type ContinuityReport = z.infer<typeof ContinuityReportSchema>

export const PolishPatchSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('PolishPatch'),
  chapter: z.number().int().positive(),
  base_hash: z.string().min(1),
  expected_hash: z.string().min(1),
  patches: z
    .array(
      z.object({
        anchor: z.string().min(8),
        before: z.string().min(1),
        after: z.string(),
        reason: z.string().min(1),
      }),
    )
    .min(1),
  open_questions: z.array(z.string()),
})
export type PolishPatch = z.infer<typeof PolishPatchSchema>

export const StateDeltaSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('StateDelta'),
  chapter: z.number().int().positive(),
  entities: z.array(
    z.object({
      key: z.string().min(1),
      kind: z.enum(['character', 'location', 'faction', 'item', 'concept']),
      action: z.enum(['created', 'updated', 'no_change']),
      reason: z.string().min(1),
      evidence: z.string().min(8),
      patch: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  relationships: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      type_code: z.string().min(1),
      change: z.string().min(1),
      evidence: z.string().min(8),
    }),
  ),
  timeline: z.array(
    z.object({
      key: z.string().min(1),
      label: z.string().min(1),
      order: z.number(),
      evidence: z.string().min(8),
    }),
  ),
  foreshadows: z.array(
    z.object({
      key: z.string().min(1),
      action: z.enum(['planted', 'advanced', 'resolved']),
      reason: z.string().min(1),
      evidence: z.string().min(8),
      resolved_anchor: z.string().min(8).optional(),
    }),
  ),
  resources: z.array(
    z.object({
      character: z.string().min(1),
      resource: z.string().min(1),
      mode: z.enum(['set', 'add']),
      value: z.number(),
      evidence: z.string().min(8),
    }),
  ),
  handoff: z.record(z.string(), z.unknown()),
})
export type StateDelta = z.infer<typeof StateDeltaSchema>

export const DecisionSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('Decision'),
  gate: z.enum(['bible', 'outline', 'chapter', 'publish']),
  action: z.enum(['approve', 'reject', 'edit', 'regenerate']),
  target_artifact_id: z.string().min(1),
  target_version: z.number().int().positive(),
  actor: z.string().min(1),
  reason: z.string().min(1),
  approval_token: z.string().min(1),
  at: z.string().datetime(),
})
export type Decision = z.infer<typeof DecisionSchema>

export const BiblePlanSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('BiblePlan'),
  premise: z.string().min(1),
  themes: z.array(z.string()).min(1),
  style: z.object({ guide: z.string().min(1), fingerprint: z.record(z.string(), z.unknown()) }),
  world: z.object({
    rules: z.array(z.string()),
    factions: z.array(z.string()),
    locations: z.array(z.string()),
    glossary: z.record(z.string(), z.string()),
  }),
  characters: z.array(
    z.object({
      slug: z.string().min(1),
      name: z.string().min(1),
      role: z.string().min(1),
      profile: z.record(z.string(), z.unknown()),
      voice: z.object({
        signature_phrases: z.array(z.string()).max(1),
        register: z.string(),
      }),
    }),
  ),
  citations: z.array(CitationSchema),
  open_questions: z.array(z.string()),
})
export type BiblePlan = z.infer<typeof BiblePlanSchema>

export const WorldbookPatchSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('WorldbookPatch'),
  entities: z.array(
    z.object({
      key: z.string().min(1),
      entity_kind: z.enum(['character', 'location', 'faction', 'item', 'concept', 'rule', 'term', 'event']),
      name: z.string().min(1),
      summary: z.string().min(1),
      facts: z.record(z.string(), z.unknown()),
      evidence: z.string().min(8),
    }),
  ),
  citations: z.array(CitationSchema),
  open_questions: z.array(z.string()),
})
export type WorldbookPatch = z.infer<typeof WorldbookPatchSchema>

export const OutlinePlanSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('OutlinePlan'),
  logline: z.string().min(1),
  acts: z.array(z.object({ id: z.string(), title: z.string(), summary: z.string() })).min(1),
  volumes: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        start_chapter: z.number().int().positive(),
        end_chapter: z.number().int().positive(),
        arc: z.string().min(1),
      }),
    )
    .min(1),
  chapters: z.array(
    z.object({
      chapter: z.number().int().positive(),
      title: z.string().min(1),
      summary: z.string().min(1),
      scene_type: SceneTypeSchema,
      hook: z.string().min(1),
    }),
  ),
  citations: z.array(CitationSchema),
  open_questions: z.array(z.string()),
})
export type OutlinePlan = z.infer<typeof OutlinePlanSchema>

export const VolumePlanSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('VolumePlan'),
  volume: z.number().int().positive(),
  title: z.string().min(1),
  arc: z.string().min(1),
  chapters: z.array(z.object({ chapter: z.number().int().positive(), title: z.string().min(1) })),
  open_questions: z.array(z.string()),
})
export type VolumePlan = z.infer<typeof VolumePlanSchema>

export const MarketBriefSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('MarketBrief'),
  platform: z.enum(['fanqie', 'qidian', 'qimao', 'jinjiang']),
  trends: z.array(
    z.object({ label: z.string(), evidence: z.string(), confidence: z.number().min(0).max(1) }),
  ),
  competitors: z.array(
    z.object({ title: z.string(), tags: z.array(z.string()), strength: z.string(), weakness: z.string() }),
  ),
  recommendations: z.array(z.string()),
  sources: z.array(z.string()),
})
export type MarketBrief = z.infer<typeof MarketBriefSchema>

export const ExportSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('Export'),
  format: z.enum(['markdown', 'txt', 'epub', 'outline', 'worldbook', 'proposal', 'publish']),
  path: z.string().min(1),
  chapters: z.array(z.number().int().positive()),
  content_hash: z.string().min(1),
  profile: z.record(z.string(), z.unknown()).optional(),
  package_path: z.string().optional(),
  manifest: z.array(z.object({ path: z.string(), bytes: z.number(), hash: z.string() })).optional(),
  checks: z.array(z.string()).optional(),
})
export type ExportArtifact = z.infer<typeof ExportSchema>

export const ArtifactContentSchema = z.discriminatedUnion('kind', [
  BiblePlanSchema,
  WorldbookPatchSchema,
  OutlinePlanSchema,
  VolumePlanSchema,
  ChapterPlanSchema,
  DraftSchema,
  ReviewReportSchema,
  ContinuityReportSchema,
  PolishPatchSchema,
  StateDeltaSchema,
  DecisionSchema,
  MarketBriefSchema,
  ExportSchema,
])

export const ArtifactStatusSchema = z.enum(['draft', 'reviewed', 'approved', 'superseded', 'rejected'])
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>

export const ArtifactRecordSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: ArtifactKindSchema,
  chapter: z.number().int().positive().nullable(),
  version: z.number().int().positive(),
  status: ArtifactStatusSchema,
  path: z.string().min(1),
  contentHash: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  baseArtifactId: z.string().nullable(),
  provenance: z.object({
    runId: z.string().min(1),
    taskId: z.string().min(1),
    role: RoleIdSchema,
    preset: z.string().min(1),
    agentSessionId: z.string(),
    model: z.string(),
    promptHash: z.string(),
    createdAt: z.string(),
  }),
  content: ArtifactContentSchema,
})
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>

/** Map a kind to its schema. One kind, one schema. */
export const ARTIFACT_SCHEMAS = {
  BiblePlan: BiblePlanSchema,
  WorldbookPatch: WorldbookPatchSchema,
  OutlinePlan: OutlinePlanSchema,
  VolumePlan: VolumePlanSchema,
  ChapterPlan: ChapterPlanSchema,
  Draft: DraftSchema,
  ReviewReport: ReviewReportSchema,
  ContinuityReport: ContinuityReportSchema,
  PolishPatch: PolishPatchSchema,
  StateDelta: StateDeltaSchema,
  Decision: DecisionSchema,
  MarketBrief: MarketBriefSchema,
  Export: ExportSchema,
} as const
