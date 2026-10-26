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
  if (!Array.isArray(dimensions)) return 0
  return dimensions.reduce(
    (total, dimension) =>
      total +
      (Array.isArray(dimension?.deductions)
        ? dimension.deductions.reduce(
            (inner: number, deduction: Deduction) =>
              inner + (Number.isFinite(deduction?.delta) ? deduction.delta : 0),
            0,
          )
        : 0),
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
  if (!Array.isArray(dimensions)) return ['dimensions must be an array']
  if (dimensions.length !== SCORE_DIMENSIONS.length) {
    problems.push(`expected ${SCORE_DIMENSIONS.length} dimensions, got ${dimensions.length}`)
  }
  const seen = new Set<string>()
  for (const dimension of dimensions) {
    if (typeof dimension !== 'object' || dimension === null || Array.isArray(dimension)) {
      problems.push('each dimension must be an object')
      continue
    }
    if (typeof dimension.id !== 'string' || dimension.id.trim() === '') {
      problems.push('each dimension must have an id')
      continue
    }
    if (seen.has(dimension.id)) problems.push(`duplicate dimension ${dimension.id}`)
    seen.add(dimension.id)
    if (!Array.isArray(dimension.deductions)) {
      problems.push(`${dimension.id}: deductions must be an array`)
      continue
    }
    if (!Number.isFinite(dimension.max) || dimension.max < 0) {
      problems.push(`${dimension.id}: max must be a non-negative number`)
    }
    for (const deduction of dimension.deductions) {
      if (typeof deduction !== 'object' || deduction === null || Array.isArray(deduction)) {
        problems.push(`${dimension.id}: each deduction must be an object`)
        continue
      }
      if (!Number.isFinite(deduction.delta) || deduction.delta <= 0) {
        problems.push(`${dimension.id}: delta must be > 0 (got ${String(deduction.delta)})`)
      }
      if (
        typeof deduction.rule !== 'string' ||
        typeof deduction.note !== 'string' ||
        typeof deduction.location !== 'string' ||
        deduction.rule.trim() === '' ||
        deduction.note.trim() === '' ||
        deduction.location.trim() === ''
      ) {
        problems.push(`${dimension.id}: deduction is missing rule/location/note`)
      }
    }
    if (maxOf(dimension.id) === 0) {
      problems.push(`${dimension.id}: unknown dimension id`)
      continue
    }
    const deducted = dimension.deductions.reduce(
      (sum: number, deduction: Deduction) => sum + (Number.isFinite(deduction?.delta) ? deduction.delta : 0),
      0,
    )
    if (dimension.max !== maxOf(dimension.id)) {
      problems.push(`${dimension.id}: max ${dimension.max} does not match spec ${maxOf(dimension.id)}`)
    }
    if (deducted > dimension.max) {
      problems.push(`${dimension.id}: deductions ${deducted} exceed max ${dimension.max}`)
    }
  }
  if (Number.isFinite(total) && totalScore(dimensions) !== total) {
    problems.push(`total ${total} does not equal 150 - Σdelta (${totalScore(dimensions)})`)
  }
  if (!Number.isFinite(total) || total < 0 || total > FULL_SCORE) {
    problems.push(`total ${String(total)} outside 0..${FULL_SCORE}`)
  }
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
  const safeDimensions = Array.isArray(dimensions) ? dimensions : []
  const canonical = (location: string): string => {
    const paragraph = /第\s*(\d+)\s*段/.exec(location)
    return paragraph === null ? location.trim() : `paragraph:${paragraph[1]}`
  }
  const best = new Map<string, Deduction>()
  for (const dimension of safeDimensions) {
    for (const deduction of Array.isArray(dimension?.deductions) ? dimension.deductions : []) {
      const identity = `${deduction.rule}@${canonical(deduction.location)}`
      const previous = best.get(identity)
      if (previous === undefined || deduction.delta > previous.delta) best.set(identity, deduction)
    }
  }
  const deduped = safeDimensions.map((dimension) => ({
    ...dimension,
    deductions: (Array.isArray(dimension?.deductions) ? dimension.deductions : []).filter(
      (deduction: Deduction) => {
        const identity = `${deduction.rule}@${canonical(deduction.location)}`
        const winner = best.get(identity) === deduction
        if (!winner) dropped += 1
        return winner
      },
    ),
  }))

  for (const exclusion of exclusions) {
    const [left, right] = exclusion.pair
    const byLocation = new Map<string, { rule: string; dimension: number; deduction: Deduction }[]>()
    deduped.forEach((dimension, dimensionIndex) => {
      for (const deduction of dimension.deductions) {
        if (deduction.rule !== left && deduction.rule !== right) continue
        const key = canonical(deduction.location)
        const list = byLocation.get(key) ?? []
        list.push({ rule: deduction.rule, dimension: dimensionIndex, deduction })
        byLocation.set(key, list)
      }
    })
    for (const entries of byLocation.values()) {
      const leftEntries = entries.filter((entry) => entry.rule === left)
      const rightEntries = entries.filter((entry) => entry.rule === right)
      if (leftEntries.length === 0 || rightEntries.length === 0) continue
      const leftDelta = leftEntries.reduce((sum, entry) => sum + entry.deduction.delta, 0)
      const rightDelta = rightEntries.reduce((sum, entry) => sum + entry.deduction.delta, 0)
      const loser = leftDelta >= rightDelta ? right : left
      for (const entry of entries) {
        if (entry.rule !== loser) continue
        const dimension = deduped[entry.dimension]!
        dimension.deductions = dimension.deductions.filter(
          (deduction: Deduction) => deduction !== entry.deduction,
        )
        dropped += 1
      }
    }
  }
  return { dimensions: deduped, dropped }
}
