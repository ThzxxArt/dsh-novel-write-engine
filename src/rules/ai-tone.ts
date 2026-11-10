import { AI_TONE_RULES } from '../codes.js'
import { splitSentenceSpans } from '../domain/text.js'
import type { AiToneBlock, AiToneEntry, Rule, RuleContext } from './types.js'
import type { Severity, Violation } from '../types.js'

/**
 * 0.2.17 AI-tone evaluation (附录 B).
 *
 * The design asset's `ai_tone` block is executable, not a word list: every entry
 * carries a matcher, a scope, a window and an escalation. This module turns the
 * block into findings exactly once, and the seven rule codes read that one
 * result — computing it seven times would let the codes disagree.
 */

/** One occurrence of a tone phrase, with the span it occupies. */
export interface ToneHit {
  entry: AiToneEntry
  code: string
  start: number
  end: number
  /** The phrase that matched, for the detail line. */
  phrase: string
  inDialogue: boolean
  severity: Severity
  paragraph: number
}

const DIALOGUE_OPEN = '“「『"'
const DIALOGUE_CLOSE = '”」』"'
const SENTENCE_BREAK = '。！？…\n'

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A template placeholder matches a short run inside one sentence. */
const TEMPLATE_GAP = '[^\\n]{1,8}'

/**
 * Build the matcher for one entry. `g` is mandatory: the evaluator needs every
 * occurrence, and a non-global regex would silently stop at the first.
 */
export function compileToneMatcher(entry: AiToneEntry): RegExp {
  if (entry.match === 'regex') return new RegExp(entry.pattern!, 'g')
  if (entry.match === 'template') {
    const source = entry
      .template!.split(/\{[a-z]+\}/)
      .map(escapeRegExp)
      .join(TEMPLATE_GAP)
    return new RegExp(source, 'g')
  }
  const terms = entry.terms!.filter((term) => term !== '').map(escapeRegExp)
  // Longest first so "我记下了" wins over "记下了" at the same offset.
  terms.sort((left, right) => right.length - left.length)
  return new RegExp(terms.join('|'), 'g')
}

/** Dialogue spans with offsets preserved, so a hit can be classified by position. */
export function quoteSpans(
  text: string,
): Array<{ start: number; end: number; kind: 'dialogue' | 'narration' }> {
  const spans: Array<{ start: number; end: number; kind: 'dialogue' | 'narration' }> = []
  let index = 0
  let narrationStart = 0
  while (index < text.length) {
    const open = DIALOGUE_OPEN.indexOf(text[index]!)
    if (open === -1) {
      index += 1
      continue
    }
    const close = DIALOGUE_CLOSE[open]!
    const end = text.indexOf(close, index + 1)
    if (end === -1) break
    if (index > narrationStart) spans.push({ start: narrationStart, end: index, kind: 'narration' })
    spans.push({ start: index, end: end + 1, kind: 'dialogue' })
    narrationStart = end + 1
    index = end + 1
  }
  if (narrationStart < text.length) spans.push({ start: narrationStart, end: text.length, kind: 'narration' })
  return spans
}

/** Sentence boundaries, used for `standalone` and `exclude_if_matches`. */
const sentenceSpans = (text: string) => splitSentenceSpans(text)

const isBoundaryBefore = (text: string, index: number): boolean => {
  if (index === 0) return true
  const previous = text[index - 1]!
  return (
    SENTENCE_BREAK.includes(previous) || DIALOGUE_OPEN.includes(previous) || DIALOGUE_CLOSE.includes(previous)
  )
}

const isBoundaryAfter = (text: string, index: number): boolean => {
  if (index >= text.length) return true
  const next = text[index]!
  return SENTENCE_BREAK.includes(next) || DIALOGUE_OPEN.includes(next) || DIALOGUE_CLOSE.includes(next)
}

/** Paragraph number for a character offset; paragraphs are newline-separated. */
const paragraphAt = (text: string, index: number): number => {
  let paragraph = 1
  for (let cursor = 0; cursor < index; cursor += 1) if (text[cursor] === '\n') paragraph += 1
  return paragraph
}

/**
 * Every tone hit in the text, before window escalation.
 *
 * Exported because the zero-tolerance rule needs the same phrase set for C8:
 * one span, one owner — the more specific AI-tone entry wins.
 */
export function collectToneHits(text: string, block: AiToneBlock | undefined): ToneHit[] {
  if (block === undefined || block.entries.length === 0) return []
  const spans = quoteSpans(text)
  const sentences = sentenceSpans(text)
  const hits: ToneHit[] = []

  for (const entry of block.entries) {
    const category = block.categories[entry.category]
    if (category === undefined) continue
    const scope = entry.scope
    const severity = entry.severity
    const severityInDialogue = entry.severity_in_dialogue ?? severity
    const matcher = compileToneMatcher(entry)
    matcher.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = matcher.exec(text)) !== null) {
      const start = match.index
      const end = start + match[0].length
      if (match[0] === '') {
        matcher.lastIndex += 1
        continue
      }
      const span = spans.find((candidate) => start >= candidate.start && start < candidate.end)
      const inDialogue = span?.kind === 'dialogue'
      if (scope === 'dialogue' && !inDialogue) continue
      if (scope === 'narration' && inDialogue) continue
      // `standalone` means "this phrase is the whole sentence", which is how a
      // one-character judgement like 稳 differs from 稳住 in a longer clause.
      if (entry.standalone === true && !(isBoundaryBefore(text, start) && isBoundaryAfter(text, end))) {
        continue
      }
      if (entry.exclude_if_matches !== undefined && entry.exclude_if_matches.length > 0) {
        const sentence = sentences.find((candidate) => start >= candidate.start && start < candidate.end)
        const line = sentence?.text ?? text.slice(start, end)
        const excluded = entry.exclude_if_matches.some((pattern) => new RegExp(pattern).test(line))
        if (excluded) continue
      }
      hits.push({
        entry,
        code: category.code,
        start,
        end,
        phrase: match[0],
        inDialogue,
        severity: inDialogue ? severityInDialogue : severity,
        paragraph: paragraphAt(text, start),
      })
    }
  }
  hits.sort((left, right) => left.start - right.start)
  return hits
}

/**
 * Apply the per-entry window and escalation.
 *
 * `count > limit` inside one `window` escalates one level, and only the hits
 * that are actually inside that crowded window escalate — a single late
 * repetition must not turn three earlier harmless ones into blockers.
 */
export function escalateToneHits(hits: readonly ToneHit[], block: AiToneBlock): ToneHit[] {
  const byEntry = new Map<string, ToneHit[]>()
  for (const hit of hits) {
    const rows = byEntry.get(hit.entry.id)
    if (rows === undefined) byEntry.set(hit.entry.id, [hit])
    else rows.push(hit)
  }
  // Only the hits inside a crowded window escalate. A flag per entry would
  // turn three harmless early repetitions into blockers because of one late one.
  const escalated = new Set<ToneHit>()
  for (const [, rows] of byEntry) {
    const entry = rows[0]!.entry
    const category = block.categories[entry.category]
    if (category === undefined) continue
    const limit = entry.limit ?? category.limit
    const window = entry.window ?? category.window
    const escalation = entry.escalation ?? category.escalation
    if (escalation !== 'one_level') continue
    const positions = rows.map((row) => row.start)
    const crowded = new Set<number>()
    for (let index = 0; index < positions.length; index += 1) {
      let count = 0
      for (let other = index; other < positions.length; other += 1) {
        if (positions[other]! - positions[index]! <= window) count += 1
        else break
      }
      if (count > limit) {
        for (let other = index; other < positions.length; other += 1) {
          if (positions[other]! - positions[index]! <= window) crowded.add(other)
          else break
        }
      }
    }
    for (const index of crowded) escalated.add(rows[index]!)
  }
  return hits.map((hit) => (escalated.has(hit) ? { ...hit, severity: 'blocker' as Severity } : hit))
}

/** The one evaluation the seven codes share, computed once per chapter. */
export function evaluateTone(text: string, block: AiToneBlock | undefined): ToneHit[] {
  if (block === undefined) return []
  return escalateToneHits(collectToneHits(text, block), block)
}

/** Build the violation for one hit; the detail carries the advice to act on. */
const violationOf = (hit: ToneHit): Violation => ({
  code: hit.code,
  severity: hit.severity,
  location: { paragraph: hit.paragraph },
  detail:
    `${hit.entry.id} "${hit.phrase}"${hit.inDialogue ? '（对白）' : ''}` +
    (hit.entry.replacement === undefined ? '' : `；改成：${hit.entry.replacement}`),
})

/** One rule per category code; each reads the shared evaluation off the context. */
const toneRule =
  (code: string): Rule =>
  (ctx: RuleContext): Violation[] => {
    const block = ctx.rulepack.lexicon.ai_tone
    if (block === undefined || block.entries.length === 0) return []
    // The pipeline precomputes the hits and stores them on the context so the
    // seven codes cannot disagree about what was found.
    const hits = ctx.toneHits ?? evaluateTone(ctx.text, block)
    return hits.filter((hit) => hit.code === code).map(violationOf)
  }

/** The seven AI-tone rules, ready to merge into `BUILTIN_RULES`. */
export const AI_TONE_IMPLEMENTATIONS: Readonly<Record<string, Rule>> = {
  [AI_TONE_RULES.META]: toneRule(AI_TONE_RULES.META),
  [AI_TONE_RULES.ACK]: toneRule(AI_TONE_RULES.ACK),
  [AI_TONE_RULES.COMPARATIVE]: toneRule(AI_TONE_RULES.COMPARATIVE),
  [AI_TONE_RULES.PROTECTIVE]: toneRule(AI_TONE_RULES.PROTECTIVE),
  [AI_TONE_RULES.SOCRATIC]: toneRule(AI_TONE_RULES.SOCRATIC),
  [AI_TONE_RULES.TEMPLATE]: toneRule(AI_TONE_RULES.TEMPLATE),
  [AI_TONE_RULES.JUDGMENT]: toneRule(AI_TONE_RULES.JUDGMENT),
}
