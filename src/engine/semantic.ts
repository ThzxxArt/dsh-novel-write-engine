import type { BlockingItem, SemanticItem } from '../types.js'

/** The four checks the P6 task book requires; a subset cannot pass. */
export const SEMANTIC_CHECK_IDS = [
  'L2-SCENE-ANCHOR',
  'L2-CHARACTER-STATE',
  'L2-CAUSALITY',
  'L2-VOICE',
] as const

/** Extract the quoted part of an evidence string, tolerating "第 N 段：" labels. */
export function evidenceQuote(value: string): string {
  let candidate = value.trim()
  const labelled = /^第\s*\d+\s*段\s*[：:]\s*/.exec(candidate)
  if (labelled !== null) candidate = candidate.slice(labelled[0].length)
  candidate = candidate.trim()
  candidate = candidate
    .replace(/^[「『“"']/, '')
    .replace(/[」』”"']$/, '')
    .trim()
  return candidate
}

/**
 * Validate the model-supplied L2 semantic items. Evidence must be a real
 * substring of the manuscript; a failed verdict is itself a blocking finding.
 * The model cannot turn the check green by asserting it.
 */
export function evaluateSemantic(
  text: string,
  items: SemanticItem[],
): {
  blocking: BlockingItem[]
  failed: boolean
} {
  const blocking: BlockingItem[] = []
  const seen = new Set<string>()
  for (const [index, item] of items.entries()) {
    const where = `semantic[${index}]`
    if (typeof item !== 'object' || item === null) {
      blocking.push({
        code: 'SEMANTIC_ITEM_INVALID',
        scope: 'check',
        detail: `${where} is not an object`,
      })
      continue
    }
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      blocking.push({
        code: 'SEMANTIC_ITEM_INVALID',
        scope: 'check',
        detail: `${where} has no id`,
      })
      continue
    }
    if (seen.has(item.id)) {
      blocking.push({
        code: 'SEMANTIC_ITEM_INVALID',
        scope: 'check',
        detail: `${item.id} is declared twice`,
      })
      continue
    }
    seen.add(item.id)
    if (item.verdict !== 'pass' && item.verdict !== 'fail') {
      blocking.push({
        code: 'SEMANTIC_ITEM_INVALID',
        scope: 'check',
        detail: `${item.id} has verdict ${String(item.verdict)}; expected pass|fail`,
      })
      continue
    }
    if (typeof item.evidence !== 'string' || item.evidence.trim() === '') {
      blocking.push({
        code: 'SEMANTIC_EVIDENCE_INVALID',
        scope: 'check',
        detail: `${item.id} has no evidence quote`,
      })
      continue
    }
    const quote = evidenceQuote(item.evidence)
    if (Array.from(quote).length < 4) {
      blocking.push({
        code: 'SEMANTIC_EVIDENCE_INVALID',
        scope: 'check',
        detail: `${item.id} quotes fewer than 4 characters`,
      })
      continue
    }
    if (!text.includes(quote)) {
      blocking.push({
        code: 'SEMANTIC_EVIDENCE_INVALID',
        scope: 'check',
        detail: `${item.id} cites "${quote}", which does not appear in the manuscript`,
      })
      continue
    }
    if (item.verdict === 'fail') {
      blocking.push({
        code: 'SEMANTIC_CHECK_FAILED',
        scope: 'check',
        detail: `${item.id}: ${typeof item.note === 'string' && item.note.trim() !== '' ? item.note : 'semantic check failed'}`,
      })
    }
  }
  const required = new Set<string>(SEMANTIC_CHECK_IDS)
  for (const id of SEMANTIC_CHECK_IDS) {
    if (!seen.has(id)) {
      blocking.push({
        code: 'SEMANTIC_MISSING',
        scope: 'check',
        detail: `${id} is required by the P6 task book`,
      })
    }
  }
  for (const id of seen) {
    if (!required.has(id)) {
      blocking.push({
        code: 'SEMANTIC_ITEM_INVALID',
        scope: 'check',
        detail: `${id} is not one of the required P6 semantic checks`,
      })
    }
  }
  return { blocking, failed: blocking.length > 0 }
}
