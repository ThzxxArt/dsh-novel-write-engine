import { ALL_RULE_CODES, CROSS_RULES } from '../codes.js'
import type { Violation, WordMetrics } from '../types.js'
import { countWordMetrics } from '../domain/wordcount.js'
import { sentenceRhythm, splitParagraphs, type SentenceRhythm } from '../domain/text.js'
import { BUILTIN_RULES } from './checks.js'
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

  // 2. density (everything whose verdict is per-paragraph or per-window)
  const densityViolations: Violation[] = []
  for (const code of registry.codes()) {
    if (lexiconCodes.has(code)) continue
    densityViolations.push(...registry.get(code)!(toContext(text, options)))
  }

  // 3. quote ratio (computed before exemptions so the report can explain itself)
  const quoteRatio = measureQuoteRatio(text)

  // 4. exemptions (rule-pack declared waivers)
  const kept = densityViolations.filter((violation) => !options.rulepack.exemptions.includes(violation.code))

  // 5. lexicon (last, guaranteed)
  const lexiconViolations: Violation[] = []
  for (const code of registry.codes()) {
    if (!lexiconCodes.has(code)) continue
    lexiconViolations.push(...registry.get(code)!(toContext(text, options)))
  }
  const finalLexicon = lexiconViolations.filter(
    (violation) => !options.rulepack.exemptions.includes(violation.code),
  )

  const violations = dedupe([...kept, ...finalLexicon])
  return {
    violations,
    metrics,
    rhythm,
    quoteRatio,
    paragraphCount: paragraphs.length,
  }
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

/** One violation per (code, paragraph, detail); order follows the canonical code list. */
function dedupe(violations: Violation[]): Violation[] {
  const seen = new Set<string>()
  const order = new Map(ALL_RULE_CODES.map((code, index) => [code, index]))
  return violations
    .filter((violation) => {
      const key = `${violation.code}|${violation.location.paragraph}|${violation.detail}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => {
      if (a.location.paragraph !== b.location.paragraph) return a.location.paragraph - b.location.paragraph
      return (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99)
    })
}

/** Whether a rule pack declares a code as exempted (used by `doctor` output). */
export function isExempt(rulepack: Rulepack, code: string): boolean {
  return rulepack.exemptions.includes(code)
}
