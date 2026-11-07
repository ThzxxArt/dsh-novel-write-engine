import { z } from 'zod'

export const BOOK_STAGES = [
  'intake',
  'bible',
  'outline',
  'volume_plan',
  'writing',
  'production',
  'published',
] as const
export type BookStage = (typeof BOOK_STAGES)[number]

export const CHAPTER_STAGES = [
  'planned',
  'drafted',
  'reviewed',
  'revised',
  'continuity',
  'polished',
  'approved',
  'archived',
] as const
export type ChapterStage = (typeof CHAPTER_STAGES)[number]

export const RUN_KINDS = ['book', 'chapter', 'rewrite', 'review', 'market'] as const
export type RunKind = (typeof RUN_KINDS)[number]

export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_human',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const TASK_STATUSES = [
  'pending',
  'ready',
  'leased',
  'running',
  'validating',
  'awaiting_human',
  'retry_wait',
  'completed',
  'failed',
  'cancelled',
  'skipped',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const ASSIGNMENT_STATUSES = [
  'created',
  'started',
  'completed',
  'failed',
  'aborted',
  'max_tokens',
  'refusal',
] as const
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number]

export const HUMAN_GATES = ['bible', 'outline', 'chapter', 'publish'] as const
export type HumanGate = (typeof HUMAN_GATES)[number]

export const RunKindSchema = z.enum(RUN_KINDS)
export const RunStatusSchema = z.enum(RUN_STATUSES)
export const TaskStatusSchema = z.enum(TASK_STATUSES)
export const AssignmentStatusSchema = z.enum(ASSIGNMENT_STATUSES)
export const HumanGateSchema = z.enum(HUMAN_GATES)
export const ChapterStageSchema = z.enum(CHAPTER_STAGES)
export const BookStageSchema = z.enum(BOOK_STAGES)

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['awaiting_human', 'paused', 'completed', 'failed', 'cancelled'],
  awaiting_human: ['running', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled', 'failed'],
  completed: [],
  failed: ['running', 'cancelled'],
  cancelled: [],
}

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['ready', 'cancelled', 'skipped'],
  ready: ['leased', 'cancelled', 'skipped'],
  leased: ['running', 'retry_wait', 'failed', 'cancelled'],
  running: ['validating', 'retry_wait', 'failed', 'cancelled'],
  validating: ['completed', 'awaiting_human', 'retry_wait', 'failed'],
  awaiting_human: ['completed', 'failed', 'cancelled'],
  retry_wait: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  skipped: [],
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to)
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to)
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) throw new Error(`illegal run transition ${from} -> ${to}`)
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) throw new Error(`illegal task transition ${from} -> ${to}`)
}

/** Project the chapter stage from the highest completed pipeline task. */
export function chapterStageOf(completedKinds: readonly string[]): ChapterStage {
  if (completedKinds.includes('archive')) return 'archived'
  if (completedKinds.includes('approve')) return 'approved'
  if (completedKinds.includes('polish')) return 'polished'
  if (completedKinds.includes('continuity.final')) return 'continuity'
  if (completedKinds.includes('revise')) return 'revised'
  if (completedKinds.includes('review.merge')) return 'reviewed'
  if (completedKinds.includes('draft')) return 'drafted'
  if (completedKinds.includes('plan')) return 'planned'
  return 'planned'
}
