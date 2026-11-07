import { createMachine } from 'xstate'
import { StudioError, STUDIO_ERROR_CODES } from '../contracts/errors.js'
import type { RunStatus } from '../contracts/stages.js'

/** Pure state chart; IO lives in the Director, not in actors. */
export const runMachine = createMachine({
  id: 'studio-run',
  initial: 'queued',
  states: {
    queued: { on: { START: 'running', PAUSE: 'paused', CANCEL: 'cancelled', FAIL: 'failed' } },
    running: {
      on: {
        GATE: 'awaiting_human',
        PAUSE: 'paused',
        COMPLETE: 'completed',
        FAIL: 'failed',
        CANCEL: 'cancelled',
      },
    },
    awaiting_human: { on: { RESUME: 'running', COMPLETE: 'completed', FAIL: 'failed', CANCEL: 'cancelled' } },
    paused: { on: { RESUME: 'running', CANCEL: 'cancelled', FAIL: 'failed' } },
    completed: { type: 'final' },
    failed: { on: { RETRY: 'running', CANCEL: 'cancelled' } },
    cancelled: { type: 'final' },
  },
})

/** Mirror of the run chart for structural checks outside XState actors. */
const TRANSITIONS: Record<
  RunStatus,
  Partial<Record<'START' | 'GATE' | 'PAUSE' | 'RESUME' | 'COMPLETE' | 'FAIL' | 'CANCEL' | 'RETRY', RunStatus>>
> = {
  queued: { START: 'running', PAUSE: 'paused', CANCEL: 'cancelled', FAIL: 'failed' },
  running: {
    GATE: 'awaiting_human',
    PAUSE: 'paused',
    COMPLETE: 'completed',
    FAIL: 'failed',
    CANCEL: 'cancelled',
  },
  awaiting_human: { RESUME: 'running', COMPLETE: 'completed', FAIL: 'failed', CANCEL: 'cancelled' },
  paused: { RESUME: 'running', CANCEL: 'cancelled', FAIL: 'failed' },
  completed: {},
  failed: { RETRY: 'running', CANCEL: 'cancelled' },
  cancelled: {},
}

export function assertRunEvent(from: RunStatus, event: keyof (typeof TRANSITIONS)[RunStatus]): void {
  if (TRANSITIONS[from][event] === undefined) {
    throw new StudioError(
      STUDIO_ERROR_CODES.RUN_STATE_INVALID,
      `run event ${event} is not legal from ${from}`,
      'read the board and use the next legal control',
      { from, event },
    )
  }
}

export function nextRunStatus(from: RunStatus, event: keyof (typeof TRANSITIONS)[RunStatus]): RunStatus {
  assertRunEvent(from, event)
  return TRANSITIONS[from][event]!
}
