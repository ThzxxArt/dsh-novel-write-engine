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

/* --------------------------------------------------------------- 机检度 (0.2.19) */

/** One rule's contribution to one dimension. */
export interface MachineScoreRule {
  /** The rule code whose findings deduct points. */
  code: string
  /** Points per finding. */
  weight: number
  /** The most this one code may ever deduct from this dimension. */
  cap: number
}

/**
 * 机检度 (WP4): the five format dimensions the engine scores itself.
 *
 * This is a *design decision*, not taste, so it is a constant table rather than
 * a rulepack block: which format facts are worth how many points must not vary
 * per project, or the same manuscript would score differently under a different
 * pack. `DESIGN.md` has claimed since 1500 that a ● dimension is engine-scored;
 * until 0.2.19 the model's own number was taken at face value.
 *
 * `WORD_COUNT_SHORT` is not a rule code — it is the internal signal the engine
 * raises when the chapter is under the floor, and it exists so R-W-09 uses the
 * same arithmetic as every other dimension instead of a special case.
 */
export const MACHINE_SCORING: Readonly<Record<string, readonly MachineScoreRule[]>> = {
  'R-W-06': [
    { code: 'LONG_PARAGRAPH', weight: 2, cap: 4 },
    { code: 'SHORT_PARAGRAPH', weight: 1, cap: 2 },
  ],
  'R-W-07': [
    { code: 'AI_TONE_META', weight: 2, cap: 4 },
    { code: 'AI_TONE_TEMPLATE', weight: 1, cap: 2 },
    { code: 'FRAME_REPEAT', weight: 1, cap: 2 },
    { code: 'PARALLEL_RUN', weight: 1, cap: 2 },
  ],
  'R-W-08': [
    { code: 'PUNCT_STANDARD', weight: 2, cap: 4 },
    { code: 'QUOTE_UNBALANCED', weight: 4, cap: 4 },
    { code: 'ILLEGAL_QUOTE', weight: 2, cap: 4 },
    { code: 'SEMICOLON', weight: 1, cap: 2 },
    { code: 'SCENE_SEPARATOR', weight: 2, cap: 4 },
    { code: 'MD_CONTAMINATION', weight: 2, cap: 4 },
  ],
  'R-W-09': [{ code: 'WORD_COUNT_SHORT', weight: 2, cap: 2 }],
  'R-W-10': [{ code: 'TITLE_FORMAT', weight: 1, cap: 1 }],
}

/** The five dimensions the engine decides; no model deduction survives here. */
export const MACHINE_DIMENSIONS: readonly string[] = Object.keys(MACHINE_SCORING)

/**
 * 机检度 per dimension: ● the engine decides, ◐ the engine supplies evidence,
 * ○ only the model can judge.
 *
 * `R-W-13 信息增量` moved from ● to ◐ in 0.2.19. It was marked ● in `DESIGN.md`
 * from the start, but "does this chapter tell the reader something new" has no
 * mechanical reading: calling it engine-scored was a documentation error that
 * would have required inventing a metric nobody could defend.
 */
export const DIMENSION_BASIS: Readonly<Record<string, 'machine' | 'hybrid' | 'semantic'>> = {
  'R-W-06': 'machine',
  'R-W-07': 'machine',
  'R-W-08': 'machine',
  'R-W-09': 'machine',
  'R-W-10': 'machine',
  'R-W-13': 'hybrid',
}

/** Basis for a dimension id; every unlisted dimension is the model's call. */
export function basisOf(id: string): 'machine' | 'hybrid' | 'semantic' {
  return DIMENSION_BASIS[id] ?? 'semantic'
}

/** One code's finding count for a chapter. */
export interface MachineScoreHit {
  code: string
  hits: number
}

export interface MachineDimensionScore {
  id: string
  max: number
  deduction: number
  effective: number
  rules: Array<{ code: string; hits: number; delta: number }>
}

/**
 * `deduction = min(max, Σ_code min(cap, weight × hits))`.
 *
 * The cap is per code, not for the dimension: a chapter with three long
 * paragraphs and one stub must not be able to spend the whole paragraph budget
 * on the long ones and hide the stub.
 */
export function machineDimensionScores(hits: readonly MachineScoreHit[]): Map<string, MachineDimensionScore> {
  const counts = new Map<string, number>()
  for (const hit of hits) {
    if (!Number.isFinite(hit.hits) || hit.hits <= 0) continue
    counts.set(hit.code, (counts.get(hit.code) ?? 0) + hit.hits)
  }
  const scores = new Map<string, MachineDimensionScore>()
  for (const [id, rules] of Object.entries(MACHINE_SCORING)) {
    const max = maxOf(id)
    const applied: MachineDimensionScore['rules'] = []
    let total = 0
    for (const rule of rules) {
      const count = counts.get(rule.code) ?? 0
      if (count <= 0) continue
      const delta = Math.min(rule.cap, rule.weight * count)
      applied.push({ code: rule.code, hits: count, delta })
      total += delta
    }
    const deduction = Math.min(max, total)
    scores.set(id, { id, max, deduction, effective: max - deduction, rules: applied })
  }
  return scores
}

/**
 * Drop the lighter side of a mutually exclusive pair when both fire on the same
 * location, and drop repeated identical deductions. Order is preserved.
 */
export function applyExclusions(
  dimensions: readonly ScoreDimension[],
  exclusions: readonly Exclusion[],
): {
  dimensions: ScoreDimension[]
  dropped: number
  /** 0.2.14: the exact rows the rulepack removed, so a score mismatch is explainable. */
  dropped_entries: Array<{
    rule: string
    location: string
    delta: number
    dimension: string
    reason: string
  }>
} {
  let dropped = 0
  const droppedEntries: Array<{
    rule: string
    location: string
    delta: number
    dimension: string
    reason: string
  }> = []
  const safeDimensions = Array.isArray(dimensions) ? dimensions : []
  const canonical = (location: unknown): string => {
    if (typeof location !== 'string') return ''
    const paragraph = /第\s*(\d+)\s*段/.exec(location)
    return paragraph === null ? location.trim() : `paragraph:${Number(paragraph[1])}`
  }
  const deductionsOf = (dimension: unknown): readonly unknown[] => {
    if (typeof dimension !== 'object' || dimension === null) return []
    const value = (dimension as { deductions?: unknown }).deductions
    return Array.isArray(value) ? value : []
  }
  const best = new Map<string, Deduction>()
  for (const dimension of safeDimensions) {
    for (const deduction of deductionsOf(dimension)) {
      if (typeof deduction !== 'object' || deduction === null) continue
      const entry = deduction as Partial<Deduction>
      const identity = `${String(entry.rule ?? '')}@${canonical(entry.location)}`
      const previous = best.get(identity)
      if (previous === undefined || (typeof entry.delta === 'number' && entry.delta > previous.delta)) {
        best.set(identity, entry as Deduction)
      }
    }
  }
  const deduped = safeDimensions.map((dimension) => {
    const record = typeof dimension === 'object' && dimension !== null ? dimension : ({} as ScoreDimension)
    return {
      ...record,
      deductions: deductionsOf(dimension).filter((deduction) => {
        if (typeof deduction !== 'object' || deduction === null) return true
        const entry = deduction as Partial<Deduction>
        const identity = `${String(entry.rule ?? '')}@${canonical(entry.location)}`
        const winner = best.get(identity) === deduction
        if (!winner) {
          dropped += 1
          droppedEntries.push({
            rule: String(entry.rule ?? ''),
            location: String(entry.location ?? ''),
            delta: Number(entry.delta ?? 0),
            dimension: String((record as { id?: unknown }).id ?? ''),
            reason: 'duplicate',
          })
        }
        return winner
      }) as Deduction[],
    }
  })

  for (const exclusion of exclusions) {
    const [left, right] = exclusion.pair
    const byLocation = new Map<string, { rule: string; dimension: number; deduction: Deduction }[]>()
    deduped.forEach((dimension, dimensionIndex) => {
      for (const deduction of dimension.deductions) {
        if (typeof deduction !== 'object' || deduction === null) continue
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
        droppedEntries.push({
          rule: entry.rule,
          location: String(entry.deduction.location ?? ''),
          delta: Number(entry.deduction.delta ?? 0),
          dimension: String((dimension as { id?: unknown }).id ?? ''),
          reason: `exclusion:${left}|${right}`,
        })
      }
    }
  }
  return { dimensions: deduped, dropped, dropped_entries: droppedEntries }
}
