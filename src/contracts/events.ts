import { z } from 'zod'
import { ArtifactKindSchema, RoleIdSchema } from './artifacts.js'
import {
  AssignmentStatusSchema,
  HumanGateSchema,
  RunKindSchema,
  RunStatusSchema,
  TaskStatusSchema,
} from './stages.js'

export const EVENT_TYPES = [
  'run.start',
  'run.pause',
  'run.resume',
  'run.cancel',
  'run.done',
  'run.fail',
  'task.ready',
  'task.lease',
  'task.start',
  'task.validating',
  'task.done',
  'task.fail',
  'task.retry',
  'assignment.start',
  'assignment.end',
  'artifact.submit',
  'artifact.approve',
  'artifact.supersede',
  'gate.pass',
  'gate.fail',
  'human_gate.awaiting',
  'human_gate.approved',
  'human_gate.rejected',
  'budget.exceeded',
  'memory.reindex',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const StudioEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  projectId: z.string(),
  runId: z.string().nullable(),
  taskId: z.string().nullable(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  at: z.string(),
})
export type StudioEvent = z.infer<typeof StudioEventSchema>

export const RunSnapshotSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: RunKindSchema,
  status: RunStatusSchema,
  targetChapter: z.number().int().positive().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
})

export const TaskSnapshotSchema = z.object({
  id: z.string(),
  runId: z.string(),
  role: RoleIdSchema,
  kind: z.string(),
  status: TaskStatusSchema,
  dependsOn: z.array(z.string()),
  priority: z.number(),
  attempt: z.number(),
  maxAttempts: z.number(),
  leaseOwner: z.string().nullable(),
  leaseUntil: z.string().nullable(),
  outputArtifactId: z.string().nullable(),
  error: z.string().nullable(),
})

export const AssignmentSnapshotSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  agentSessionId: z.string().nullable(),
  provider: z.string(),
  preset: z.string(),
  model: z.string().nullable(),
  status: AssignmentStatusSchema,
  stopReason: z.string().nullable(),
  usage: z.record(z.string(), z.unknown()).nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
})

export const HumanGateSnapshotSchema = z.object({
  gate: HumanGateSchema,
  runId: z.string(),
  taskId: z.string().nullable(),
  artifactId: z.string().nullable(),
  chapter: z.number().int().positive().nullable(),
  requestedAt: z.string(),
})

export const BoardSnapshotSchema = z.object({
  projectId: z.string(),
  runs: z.array(RunSnapshotSchema),
  tasks: z.array(TaskSnapshotSchema),
  assignments: z.array(AssignmentSnapshotSchema),
  gates: z.array(HumanGateSnapshotSchema),
  artifacts: z.array(
    z.object({
      id: z.string(),
      kind: ArtifactKindSchema,
      chapter: z.number().nullable(),
      version: z.number(),
    }),
  ),
  seq: z.number().int().nonnegative(),
})
export type BoardSnapshot = z.infer<typeof BoardSnapshotSchema>
