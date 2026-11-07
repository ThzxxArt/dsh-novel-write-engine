import { randomUUID, timingSafeEqual } from 'node:crypto'
import { sha256Hex } from '../domain/hash.js'
import type { StudioOrm } from '../storage/db.js'
import {
  createHumanGate,
  decideHumanGate,
  getHumanGate,
  listHumanGates,
  setHumanGateToken,
} from '../storage/repositories/runs.js'
import { StudioError, STUDIO_ERROR_CODES } from '../contracts/errors.js'
import type { HumanGate } from '../contracts/stages.js'

export const approvalTokenHash = (token: string): string => sha256Hex(token)

const tokenMatches = (expected: string | null, received: string): boolean => {
  if (expected === null || expected.length !== received.length) return false
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'))
  } catch {
    return false
  }
}

/** A host-only token; agents never receive it. */
export function issueApprovalToken(): { token: string; hash: string } {
  const token = randomUUID()
  return { token, hash: approvalTokenHash(token) }
}

export class HumanGateService {
  readonly orm: StudioOrm

  constructor(orm: StudioOrm) {
    this.orm = orm
  }

  open(input: {
    projectId: string
    runId: string
    taskId?: string | null
    gate: HumanGate
    chapter?: number | null
    artifactId?: string | null
  }): { id: string; token: string } {
    const existing = listHumanGates(this.orm, input.projectId).find(
      (row) => row.runId === input.runId && row.gate === input.gate && row.status === 'awaiting_human',
    )
    if (existing !== undefined) {
      // The caller must not mint a second token for an already-open gate.
      throw new StudioError(
        STUDIO_ERROR_CODES.HUMAN_GATE_REQUIRED,
        `gate ${input.gate} is already awaiting a decision`,
        'decide the existing gate; do not open a second one',
        { gateId: existing.id },
      )
    }
    const { token, hash } = issueApprovalToken()
    const id = createHumanGate(this.orm, { ...input, approvalTokenHash: hash })
    return { id, token }
  }

  /**
   * Verify a one-time token without changing gate state. Director uses this
   * before side effects so a failed publish/plan write can be retried.
   */
  verify(gateId: string, token: string): NonNullable<ReturnType<typeof getHumanGate>> {
    const gate = getHumanGate(this.orm, gateId)
    if (gate === undefined) throw new StudioError(STUDIO_ERROR_CODES.HUMAN_GATE_REQUIRED, `no gate ${gateId}`)
    if (gate.status !== 'awaiting_human') {
      throw new StudioError(
        STUDIO_ERROR_CODES.HUMAN_GATE_REQUIRED,
        `gate ${gateId} is already ${gate.status}`,
      )
    }
    if (!tokenMatches(gate.approvalTokenHash, approvalTokenHash(token))) {
      throw new StudioError(
        STUDIO_ERROR_CODES.APPROVAL_INVALID,
        'approval token does not match this gate',
        'token is one-time and host-only; re-open the gate if it expired',
      )
    }
    return gate
  }

  /** Persist the decision after all side effects succeeded. */
  mark(input: {
    gateId: string
    decision: 'approve' | 'reject' | 'edit' | 'regenerate'
    actor: string
    reason: string
  }): void {
    if (input.decision === 'reject' || input.decision === 'regenerate') {
      decideHumanGate(this.orm, input.gateId, {
        status: 'rejected',
        actor: input.actor,
        reason: `${input.decision}: ${input.reason}`,
      })
      return
    }
    decideHumanGate(this.orm, input.gateId, {
      status: 'approved',
      actor: input.actor,
      reason: input.reason,
    })
  }

  decide(input: {
    gateId: string
    token: string
    decision: 'approve' | 'reject' | 'edit' | 'regenerate'
    actor: string
    reason: string
  }): void {
    this.verify(input.gateId, input.token)
    this.mark(input)
  }

  pending(projectId: string): ReturnType<typeof listHumanGates> {
    return listHumanGates(this.orm, projectId)
  }

  /**
   * Host-only: mint a fresh one-time token for an open gate. The model tool
   * never exposes this method; the panel/command layer calls it after a human
   * actor confirms the action.
   */
  authorize(gateId: string): string {
    const gate = getHumanGate(this.orm, gateId)
    if (gate === undefined || gate.status !== 'awaiting_human') {
      throw new StudioError(
        STUDIO_ERROR_CODES.HUMAN_GATE_REQUIRED,
        `gate ${gateId} is not awaiting a decision`,
      )
    }
    const { token, hash } = issueApprovalToken()
    setHumanGateToken(this.orm, gateId, hash)
    return token
  }
}
