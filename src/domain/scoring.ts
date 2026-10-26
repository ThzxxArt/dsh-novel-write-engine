import type { Deduction, ScoreDimension } from '../types.js'

/** The fifteen dimensions, grouped as the commercial weights demand. */
export const SCORE_DIMENSIONS: readonly { id: string; max: number; group: string }[] = [
  { id: 'R-W-01', max: 15, group: 'narrative' },
  { id: 'R-W-02', max: 10, group: 'narrative' },
  { id: 'R-W-03', max: 10, group: 'narrative' },
  { id: 'R-W-04', max: 20, group: 'narrative' },
  { id: 'R-W-05', max: 15, group: 'narrative' },
  { id: 'R-W-12', max: 20, group: 'narrative' },
  { id: 'R-W-11', max: 10, group: 'commercial' },
  { id: 'R-W-13', max: 15, group: 'commercial' },
  { id: 'R-W-14', max: 10, group: 'commercial' },
  { id: 'R-W-15', max: 10, group: 'commercial' },
  { id: 'R-W-06', max: 4, group: 'format' },
  { id: 'R-W-07', max: 4, group: 'format' },
  { id: 'R-W-08', max: 4, group: 'format' },
  { id: 'R-W-09', max: 2, group: 'format' },
  { id: 'R-W-10', max: 1, group: 'format' },
]

/** Full marks; compiling a rule pack whose dimensions do not sum to this is an error. */
export const FULL_SCORE = 150

/** One mutually exclusive rule pair declared by a rule pack. */
export interface Exclusion {
  pair: [string, string]
  family: string
}

/** Sum of every deduction delta across dimensions. */
export function sumDeductions(dimensions: readonly ScoreDimension[]): number {
  return dimensions.reduce(
    (total, dimension) =>
      total + dimension.deductions.reduce((inner, deduction) => inner + deduction.delta, 0),
    0,
  )
}

/** Score of one dimension, floored at zero so a dimension can never go negative. */
export function dimensionScore(dimension: ScoreDimension): number {
  const deducted = dimension.deductions.reduce((total, deduction) => total + deduction.delta, 0)
  return Math.max(0, dimension.max - deducted)
}

/** `total = 150 - Σdelta`, the only definition of the headline score. */
export function totalScore(dimensions: readonly ScoreDimension[]): number {
  return FULL_SCORE - sumDeductions(dimensions)
}

/**
 * Problems that make a review document arithmetically unsound. An empty array
 * means the score can be re-derived by anyone holding the deductions.
 */
export function reviewArithmeticProblems(dimensions: readonly ScoreDimension[], total: number): string[] {
  const problems: string[] = []
  if (dimensions.length !== SCORE_DIMENSIONS.length) {
    problems.push(`expected ${SCORE_DIMENSIONS.length} dimensions, got ${dimensions.length}`)
  }
  const seen = new Set<string>()
  for (const dimension of dimensions) {
    if (seen.has(dimension.id)) problems.push(`duplicate dimension ${dimension.id}`)
    seen.add(dimension.id)
    for (const deduction of dimension.deductions) {
      if (!Number.isFinite(deduction.delta) || deduction.delta <= 0) {
        problems.push(`${dimension.id}: delta must be > 0 (got ${String(deduction.delta)})`)
      }
      if (deduction.rule.trim() === '' || deduction.note.trim() === '' || deduction.location.trim() === '') {
        problems.push(`${dimension.id}: deduction is missing rule/location/note`)
      }
    }
    if (maxOf(dimension.id) === 0) {
      problems.push(`${dimension.id}: unknown dimension id`)
      continue
    }
    const deducted = dimension.deductions.reduce((sum, deduction) => sum + deduction.delta, 0)
    if (dimension.max !== maxOf(dimension.id)) {
      problems.push(`${dimension.id}: max ${dimension.max} does not match spec ${maxOf(dimension.id)}`)
    }
    if (deducted > dimension.max) {
      problems.push(`${dimension.id}: deductions ${deducted} exceed max ${dimension.max}`)
    }
  }
  if (totalScore(dimensions) !== total) {
    problems.push(`total ${total} does not equal 150 - Σdelta (${totalScore(dimensions)})`)
  }
  if (total < 0 || total > FULL_SCORE) problems.push(`total ${total} outside 0..${FULL_SCORE}`)
  return problems
}

/** Spec maximum for a dimension id, or 0 when the id is unknown. */
export function maxOf(id: string): number {
  return SCORE_DIMENSIONS.find((dimension) => dimension.id === id)?.max ?? 0
}

/**
 * Drop the lighter side of a mutually exclusive pair when both fire on the same
 * location, and drop repeated identical deductions. Order is preserved.
 */
export function applyExclusions(
  dimensions: readonly ScoreDimension[],
  exclusions: readonly Exclusion[],
): { dimensions: ScoreDimension[]; dropped: number } {
  let dropped = 0
  const seen = new Set<string>()
  const result = dimensions.map((dimension) => {
    const kept: Deduction[] = []
    for (const deduction of dimension.deductions) {
      const identity = `${deduction.rule}@${deduction.location}`
      if (seen.has(identity)) {
        dropped += 1
        continue
      }
      seen.add(identity)
      kept.push(deduction)
    }
    return { ...dimension, deductions: kept }
  })

  for (const exclusion of exclusions) {
    const [left, right] = exclusion.pair
    const byLocation = new Map<string, { dimension: number; deduction: Deduction }[]>()
    result.forEach((dimension, dimensionIndex) => {
      for (const deduction of dimension.deductions) {
        if (deduction.rule !== left && deduction.rule !== right) continue
        const list = byLocation.get(deduction.location) ?? []
        list.push({ dimension: dimensionIndex, deduction })
        byLocation.set(deduction.location, list)
      }
    })
    for (const [location, entries] of byLocation) {
      const hasLeft = entries.some((entry) => entry.deduction.rule === left)
      const hasRight = entries.some((entry) => entry.deduction.rule === right)
      if (!hasLeft || !hasRight) continue
      const sorted = [...entries].sort((a, b) => b.deduction.delta - a.deduction.delta)
      const winner = sorted[0]!
      for (const entry of resultsToDrop(entries)) {
        const dimension = result[entry.dimension]!
        dimension.deductions = dimension.deductions.filter((deduction) => deduction !== entry.deduction)
        dropped += 1
        void location
        void winner
      }
    }
  }
  return { dimensions: result, dropped }
}

/** Every entry except the heaviest one at this location (ties keep the first). */
function resultsToDrop(entries: { dimension: number; deduction: Deduction }[]): typeof entries {
  const sorted = [...entries].sort((a, b) => b.deduction.delta - a.deduction.delta)
  return sorted.slice(1)
}
