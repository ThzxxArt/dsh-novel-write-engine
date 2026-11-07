import { z } from 'zod'

export const STUDIO_ERROR_CODES = {
  PROJECT_NOT_FOUND: 'STUDIO_PROJECT_NOT_FOUND',
  PROJECT_EXISTS: 'STUDIO_PROJECT_EXISTS',
  PROJECT_INVALID: 'STUDIO_PROJECT_INVALID',
  TAXONOMY_INVALID: 'STUDIO_TAXONOMY_INVALID',
  GENRE_SELECTION_INVALID: 'STUDIO_GENRE_SELECTION_INVALID',
  ARTIFACT_NOT_FOUND: 'STUDIO_ARTIFACT_NOT_FOUND',
  ARTIFACT_INVALID: 'STUDIO_ARTIFACT_INVALID',
  ARTIFACT_HASH_MISMATCH: 'STUDIO_ARTIFACT_HASH_MISMATCH',
  ARTIFACT_CONFLICT: 'STUDIO_ARTIFACT_CONFLICT',
  ARTIFACT_RESTORE_FORBIDDEN: 'STUDIO_ARTIFACT_RESTORE_FORBIDDEN',
  RUN_NOT_FOUND: 'STUDIO_RUN_NOT_FOUND',
  RUN_STATE_INVALID: 'STUDIO_RUN_STATE_INVALID',
  TASK_NOT_FOUND: 'STUDIO_TASK_NOT_FOUND',
  TASK_STATE_INVALID: 'STUDIO_TASK_STATE_INVALID',
  LEASE_CONFLICT: 'STUDIO_LEASE_CONFLICT',
  HUMAN_GATE_REQUIRED: 'STUDIO_HUMAN_GATE_REQUIRED',
  APPROVAL_INVALID: 'STUDIO_APPROVAL_INVALID',
  BUDGET_EXCEEDED: 'STUDIO_BUDGET_EXCEEDED',
  AGENT_PROVIDER_UNSUPPORTED: 'STUDIO_AGENT_PROVIDER_UNSUPPORTED',
  AGENT_FAILED: 'STUDIO_AGENT_FAILED',
  DB_INVALID: 'STUDIO_DB_INVALID',
  PATH_ESCAPE: 'STUDIO_PATH_ESCAPE',
  IMPORT_INVALID: 'STUDIO_IMPORT_INVALID',
  EXPORT_BLOCKED: 'STUDIO_EXPORT_BLOCKED',
  NETWORK_UNTRUSTED: 'STUDIO_NETWORK_UNTRUSTED',
} as const

export type StudioErrorCode = (typeof STUDIO_ERROR_CODES)[keyof typeof STUDIO_ERROR_CODES]

export class StudioError extends Error {
  readonly code: StudioErrorCode | string
  readonly hint: string | undefined
  readonly details: Record<string, unknown> | undefined

  constructor(
    code: StudioErrorCode | string,
    message: string,
    hint?: string,
    details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'StudioError'
    this.code = code
    this.hint = hint
    this.details = details
  }
}

export class StudioInputError extends StudioError {}

export class StudioBlockedError extends StudioError {
  readonly blocking: readonly unknown[]

  constructor(
    code: StudioErrorCode | string,
    message: string,
    blocking: readonly unknown[],
    hint?: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, hint, details)
    this.name = 'StudioBlockedError'
    this.blocking = blocking
  }
}

export const ERROR_ENVELOPE = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type ErrorEnvelope = z.infer<typeof ERROR_ENVELOPE>
