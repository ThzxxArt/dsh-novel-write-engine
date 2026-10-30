import { LIMITS } from '../constants.js'
import type { Operation, Stage } from '../types.js'
import { ERROR_CODES, EngineInputError } from '../types.js'

/** One row of the transition table. Gate applicability has one owner: `applicableGates`. */
export interface Transition {
  from: Stage
  op: Operation
  to: (context: TransitionContext) => Stage
}

/** The only input a `to` function may read. */
export interface TransitionContext {
  openBlockers: number
  /** A check over only content or integrity is a pass but not an archive pass. */
  completeCheck?: boolean
}

/**
 * The single definition of allowed progress. The engine queries this table
 * instead of writing `if (stage === ...)` branches.
 */
export const TRANSITIONS: readonly Transition[] = [
  { from: 'idle', op: 'submitWorldPlan', to: () => 'P2' },
  { from: 'done', op: 'submitWorldPlan', to: () => 'P2' },
  { from: 'P2', op: 'submitChapterPlan', to: () => 'P3' },
  { from: 'P3', op: 'submitDraft', to: () => 'P4' },
  {
    from: 'P4',
    op: 'submitReview',
    to: (context) => (context.openBlockers > 0 ? 'P5' : 'P6'),
  },
  { from: 'P5', op: 'submitRevision', to: () => 'P4' },
  { from: 'P6', op: 'submitRevision', to: () => 'P4' },
  {
    from: 'P6',
    op: 'runCheck',
    to: (context) => (context.completeCheck === false ? 'P6' : 'ready_to_archive'),
  },
  { from: 'ready_to_archive', op: 'archiveChapter', to: () => 'done' },
  // An archive failure must not force a rollback just to fix a word. A revision
  // invalidates the old review/check, so it returns to P4 for a fresh review.
  { from: 'ready_to_archive', op: 'submitRevision', to: () => 'P4' },
]

/** Find the row for this (stage, op), if any. */
export function findTransition(stage: Stage, op: Operation): Transition | undefined {
  return TRANSITIONS.find((transition) => transition.from === stage && transition.op === op)
}

/** Whether this operation is legal in this stage. */
export function canRun(stage: Stage, op: Operation): boolean {
  return findTransition(stage, op) !== undefined
}

/** Compute the next stage, or throw `ENGINE_STAGE_ORDER` with an actionable message. */
export function nextStage(
  stage: Stage,
  op: Operation,
  openBlockers: number,
  context: Omit<TransitionContext, 'openBlockers'> = {},
): Stage {
  const transition = findTransition(stage, op)
  if (transition === undefined) {
    throw new EngineInputError(
      ERROR_CODES.STAGE_ORDER,
      `operation ${op} is not allowed at stage ${stage}`,
      `allowed here: ${availableOps(stage).join(', ')}; call novel_status for the full picture`,
    )
  }
  return transition.to({ openBlockers, ...context })
}

/** Operations legal at a stage, in table order. */
export function availableOps(stage: Stage): Operation[] {
  return TRANSITIONS.filter((transition) => transition.from === stage).map((transition) => transition.op)
}

/** Whether one retry budget (or, without a counter, any budget) is spent. */
export function roundsExhausted(
  rounds: { review: number; revise: number; check: number },
  counter?: 'review' | 'revise' | 'check',
): boolean {
  if (counter !== undefined) return rounds[counter] >= LIMITS.maxRounds
  return (
    rounds.review >= LIMITS.maxRounds || rounds.revise >= LIMITS.maxRounds || rounds.check >= LIMITS.maxRounds
  )
}

/** The operation a stage expects next, used by `advise` and the status `next` block. */
export const STAGE_NEXT: Readonly<Record<Stage, { tool: string; reason: string }>> = {
  idle: { tool: 'novel_plan_world', reason: 'submit the world plan' },
  P2: { tool: 'novel_plan_chapter', reason: 'submit the chapter plan' },
  P3: { tool: 'novel_write_draft', reason: 'submit the draft' },
  P4: { tool: 'novel_review', reason: 'submit the scored review' },
  P5: { tool: 'novel_revise', reason: 'fix every blocker issue, then submit the revision' },
  P6: { tool: 'novel_check', reason: 'run the consistency check' },
  ready_to_archive: {
    tool: 'novel_archive',
    reason: 'all gates pass; archive the chapter with its state_delta',
  },
  done: { tool: 'novel_plan_world', reason: 'chapter archived; start the next chapter with a world plan' },
}
