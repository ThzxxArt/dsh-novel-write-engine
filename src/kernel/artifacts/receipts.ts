import type { ArtifactStore, StoredArtifact } from './store.js'
import type { Decision } from '../../contracts/artifacts.js'
import { StudioError, STUDIO_ERROR_CODES } from '../../contracts/errors.js'

/** Only the host human-gate path writes provenance with this preset/model pair. */
export const HUMAN_GATE_PRESET = 'human-gate'
export const HUMAN_GATE_MODEL = 'human'

export interface HumanReceipt {
  artifact: StoredArtifact
  decision: Decision
}

const isHumanDecision = (artifact: StoredArtifact): boolean =>
  artifact.provenance.preset === HUMAN_GATE_PRESET && artifact.provenance.model === HUMAN_GATE_MODEL

/**
 * The latest *human* approve receipt for a chapter. Role-submitted Decision
 * artifacts are advice only; they never satisfy the gate.
 */
export async function latestHumanApproval(
  artifacts: ArtifactStore,
  chapter: number,
  gate: Decision['gate'] = 'chapter',
): Promise<HumanReceipt | null> {
  const rows = artifacts
    .list({ kind: 'Decision', chapter, limit: 50 })
    .sort((left, right) => right.version - left.version)
  for (const row of rows) {
    const stored = await artifacts.read(row.id)
    if (stored === null) continue
    if (!isHumanDecision(stored)) continue
    const decision = stored.content as Decision
    if (decision.gate !== gate) continue
    // The latest human decision wins. An older approval cannot resurrect a
    // gate that was rejected afterwards.
    if (stored.status !== 'approved' || decision.action !== 'approve') return null
    return { artifact: stored, decision }
  }
  return null
}

/** A gate receipt is only valid for the exact artifact version the human saw. */
export function assertReceiptBindsDraft(receipt: HumanReceipt, draft: StoredArtifact): void {
  if (receipt.decision.target_artifact_id !== draft.id || receipt.decision.target_version !== draft.version) {
    throw new StudioError(
      STUDIO_ERROR_CODES.HUMAN_GATE_REQUIRED,
      `human approval was for artifact ${receipt.decision.target_artifact_id} v${receipt.decision.target_version}, current draft is ${draft.id} v${draft.version}`,
      'the draft changed after approval; re-run review and open a fresh human gate',
      {
        approvedId: receipt.decision.target_artifact_id,
        approvedVersion: receipt.decision.target_version,
        currentId: draft.id,
        currentVersion: draft.version,
      },
    )
  }
}
