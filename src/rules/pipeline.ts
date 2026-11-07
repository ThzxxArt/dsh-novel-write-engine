import { ALL_RULE_CODES, CROSS_RULES } from '../codes.js'
import type { AdvisoryInstance, Violation, ViolationLocation, WordMetrics } from '../types.js'
import { sha256Hex } from '../domain/hash.js'
import { countWordMetrics } from '../domain/wordcount.js'
import { sentenceRhythm, splitParagraphs, type SentenceRhythm } from '../domain/text.js'
import { BUILTIN_RULES, countArithmeticEquations, hasNumericFactMatch } from './checks.js'
import { RuleRegistry } from './registry.js'
import type { RuleContext, Rulepack } from './types.js'

/** Options the engine supplies when it runs the machine pass. */
export type MachineOptions = Omit<RuleContext, 'text'>

/** Output of the machine pass, persisted verbatim in `checks/*.check.yaml`. */
export interface MachineResult {
  violations: Violation[]
  metrics: WordMetrics
  rhythm: SentenceRhythm
  quoteRatio: number
  paragraphCount: number
  numeric: {
    facts_declared: number
    facts_checked: number
    facts_unused: number
    equations_checked: number
    findings: number
  }
  /** 0.2.14: both dialogue measures plus the configured metric and verdict. */
  dialogue?: {
    target: [number, number] | null
    metric: 'lines' | 'chars' | 'both'
    line_ratio: number
    char_ratio: number
    verdict: 'pass' | 'line_out' | 'char_out' | 'both_out' | 'skewed' | 'unconfigured'
  }
}

/** The five ordered steps. The order is semantic, not an implementation detail. */
export const PIPELINE_STEPS = ['segment', 'density', 'quote', 'exemption', 'lexicon'] as const
export type PipelineStep = (typeof PIPELINE_STEPS)[number]

const registry = new RuleRegistry()
for (const [code, rule] of Object.entries(BUILTIN_RULES)) registry.register(code, rule)

/** The process-wide registry, exposed so tests can assert code ownership. */
export function ruleRegistry(): RuleRegistry {
  return registry
}

const lexiconCodes = new Set([
  'LEX_ZERO_TOLERANCE',
  'LEX_SOFT_LIMIT',
  'META_NARRATION',
  'READER_INTRUSION',
  'GOD_VIEW',
  'CONCLUSION_FIRST',
])

const integrityCodes = new Set<string>(Object.values(CROSS_RULES))

/** Stable string for a location: paragraph first, then ledger/entity. */
export function locationKey(location: ViolationLocation): string {
  if (location.paragraph !== undefined) return `p${location.paragraph}`
  return `${location.ledger ?? 'ledger'}:${location.entity ?? ''}`
}

/** Stable per-instance id: same code at the same place with the same detail. */
export const advisoryId = (code: string, location: ViolationLocation, detail: string): string =>
  `${code}:${locationKey(location)}:${sha256Hex(detail).slice(0, 12)}`

/** Which runCheck scope owns one machine finding. */
export function scopeOfRule(code: string): 'content' | 'integrity' {
  return integrityCodes.has(code) ? 'integrity' : 'content'
}

export { slidingWindows } from './checks.js'

/**
 * Run the deterministic pass. Format and punctuation run before the lexicon so
 * the report reads in the order an author fixes things; the lexicon runs last
 * because a blacklisted word inside an otherwise broken paragraph is noise
 * until the paragraph is fixed.
 */
export function runMachineChecks(text: string, options: MachineOptions): MachineResult {
  // 1. segment
  const paragraphs = splitParagraphs(text)
  const metrics = countWordMetrics(text)
  const rhythm = sentenceRhythm(text)
  const context = toContext(text, options)

  // 2. density (everything whose verdict is per-paragraph or per-window)
  const densityViolations: Violation[] = []
  for (const code of registry.codes()) {
    if (lexiconCodes.has(code)) continue
    densityViolations.push(...registry.get(code)!(context))
  }

  // 3. quote ratio (computed before exemptions so the report can explain itself)
  const quoteRatio = measureQuoteRatio(text)

  // 4. exemptions (rule-pack declared waivers)
  const kept = densityViolations.filter((violation) => !options.rulepack.exemptions.includes(violation.code))

  // 5. lexicon (last, guaranteed)
  const lexiconViolations: Violation[] = []
  for (const code of registry.codes()) {
    if (!lexiconCodes.has(code)) continue
    lexiconViolations.push(...registry.get(code)!(context))
  }
  const finalLexicon = lexiconViolations.filter(
    (violation) => !options.rulepack.exemptions.includes(violation.code),
  )

  const violations = dedupe([...kept, ...finalLexicon]).map((violation) => ({
    ...violation,
    id: violation.id ?? advisoryId(violation.code, violation.location, violation.detail),
  }))
  const numericFindings = violations.filter((violation) =>
    [
      'NUMERIC_CONTRADICTION',
      'NUMERIC_FACT_MISMATCH',
      'NUMERIC_FACTS_EMPTY',
      'NUMERIC_FACTS_UNUSED',
    ].includes(violation.code),
  ).length
  const facts = options.facts ?? []
  const checked = facts.filter(
    (fact) => Number.isFinite(fact.value) && fact.alias.trim() !== '' && hasNumericFactMatch(text, fact),
  ).length
  const target = options.targets?.dialogue_ratio ?? null
  const metric = options.targets?.dialogue_ratio_metric ?? 'both'
  const lineRatio = metrics.dialogue_ratio
  const charRatio = metrics.dialogue_char_ratio ?? 0
  let dialogueVerdict: NonNullable<MachineResult['dialogue']>['verdict'] = 'unconfigured'
  if (target !== null) {
    const lower = Math.max(0, target[0] - 0.005)
    const upper = Math.min(1, target[1] + 0.005)
    const lineOut = lineRatio < lower || lineRatio > upper
    const charOut = charRatio < lower || charRatio > upper
    // The verdict must describe the configured metric, not the raw pair: with
    // metric 'chars' a line-only overflow is a pass.
    if (metric === 'lines') dialogueVerdict = lineOut ? 'line_out' : 'pass'
    else if (metric === 'chars') dialogueVerdict = charOut ? 'char_out' : 'pass'
    else if (!lineOut && !charOut) dialogueVerdict = 'pass'
    else if (lineOut && charOut) dialogueVerdict = 'both_out'
    else dialogueVerdict = 'skewed'
  }
  return {
    violations,
    metrics,
    rhythm,
    quoteRatio,
    paragraphCount: paragraphs.length,
    dialogue: {
      target,
      metric,
      line_ratio: lineRatio,
      char_ratio: charRatio,
      verdict: dialogueVerdict,
    },
    numeric: {
      facts_declared: facts.length,
      facts_checked: checked,
      facts_unused: Math.max(0, facts.length - checked),
      equations_checked: countArithmeticEquations(text),
      findings: numericFindings,
    },
  }
}

/**
 * Advisories are hints, not a second gate list. One display row per code for
 * the chapter keeps the panel readable; `instances[]` preserves every distinct
 * finding so an acknowledgement still covers exactly one instance.
 */
export function dedupeAdvisories(violations: readonly Violation[]): Violation[] {
  const groups = new Map<string, Violation[]>()
  for (const violation of violations) {
    const rows = groups.get(violation.code)
    if (rows === undefined) groups.set(violation.code, [violation])
    else rows.push(violation)
  }
  return [...groups.entries()].map(([code, rows]) => {
    const instances: AdvisoryInstance[] = []
    const seen = new Set<string>()
    const locations: ViolationLocation[] = []
    const locationKeys = new Set<string>()
    const details: string[] = []
    for (const row of rows) {
      const id = row.id ?? advisoryId(row.code, row.location, row.detail)
      if (seen.has(id)) continue
      seen.add(id)
      instances.push({ id, location: row.location, detail: row.detail })
      const key = locationKey(row.location)
      if (!locationKeys.has(key)) {
        locationKeys.add(key)
        locations.push(row.location)
      }
      if (!details.includes(row.detail)) details.push(row.detail)
    }
    const first = rows[0]!
    return {
      ...first,
      // The display row is addressed by its code; instances carry their own ids.
      id: code,
      detail: details.join('；'),
      instances,
      locations,
    }
  })
}

/** Run only an explicit subset, used by PG-04 (format) and PG-10 (consistency). */
export function runRules(codes: readonly string[], text: string, options: MachineOptions): Violation[] {
  const context = toContext(text, options)
  const violations: Violation[] = []
  for (const code of codes) {
    const rule = registry.get(code)
    if (rule !== undefined) violations.push(...rule(context))
  }
  return dedupe(violations.filter((violation) => !options.rulepack.exemptions.includes(violation.code)))
}

const toContext = (text: string, options: MachineOptions): RuleContext => ({ ...options, text })

/** Share of legal straight quotes among all quote marks; 1 when there are none. */
export function measureQuoteRatio(text: string): number {
  const legal = (text.match(/"/g) ?? []).length
  const illegal = (text.match(/[“”「」『』]/g) ?? []).length
  const total = legal + illegal
  return total === 0 ? 1 : legal / total
}

/** One violation per (code, location, detail); order follows the canonical code list. */
function dedupe(violations: Violation[]): Violation[] {
  const seen = new Set<string>()
  const order = new Map(ALL_RULE_CODES.map((code, index) => [code, index]))
  return violations
    .filter((violation) => {
      const key = `${violation.code}|${locationKey(violation.location)}|${violation.detail}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => {
      const left = a.location.paragraph ?? 0
      const right = b.location.paragraph ?? 0
      if (left !== right) return left - right
      return (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99)
    })
}

/** Whether a rule pack declares a code as exempted (used by `doctor` output). */
export function isExempt(rulepack: Rulepack, code: string): boolean {
  return rulepack.exemptions.includes(code)
}
