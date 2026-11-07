import { AI_TONE_RULES } from '../codes.js'
import type { Severity, Violation } from '../types.js'
import type { AiToneEntry, AiToneLexicon, RuleContext } from './types.js'

/** The 50 phrases the default pack must cover. Kept in code so drift is a test failure. */
export const CANONICAL_AI_TONE_PHRASES = [
  '这句话稳',
  '比之前的都重',
  '我记下了',
  '我记得了',
  '我记住了',
  '这个账我记住了',
  '比之前的都轻',
  '睡吧，我守着',
  '你去，我跟',
  '问别人还是问自己',
  '行，xxx',
  '什么心思都写着xx上',
  '这句话接的漂亮',
  '行，我认',
  '这句话我不接',
  'xx比xx沉',
  'xx比xx重',
  'xx比xx稳',
  'xx比xx轻',
  '没接你的xxx',
  '比之前的都强',
  '他记得这事',
  '这话我留着',
  '很平',
  '稳',
  '我不拦',
  '我跟',
  '回去睡',
  '你这句话我记着',
  '认你',
  '我不催你',
  '这话是ta告诉你的，还是你自己想明白的',
  '认下来',
  '声音没抖，但比刚才稳',
  '比刚才轻',
  '比刚才重',
  '比刚才平',
  '很直',
  '这话我记下了',
  '这话我收下了',
  '说的比谁都响',
  '认这个',
  '收不回去',
  '认得实',
  'xx就是认了',
  '你自己掂量',
  '我不拦',
  '没接你那句xx',
  '不催',
  '你掂量',
] as const

/** Phrases that are only valid as a whole short sentence. */
const CATEGORY_PRIORITY: Record<string, number> = {
  meta_commentary: 0,
  ack_loop: 1,
  empty_comparative: 2,
  protective_cliche: 3,
  socratic_trope: 4,
  template_phrase: 5,
  short_judgment: 6,
}

export interface AiToneFinding {
  code: string
  category: string
  entryId: string
  severity: Severity
  paragraph: number
  evidence: string
  matched: string
  replacement: string
  dialogue: boolean
  /** True when the hit is the character's declared signature phrase (first use). */
  signature: boolean
  offset: number
}

export interface AiToneHistoryEntry {
  chapter: number
  entries: string[]
}

export interface AiToneScanOptions {
  chapter?: number
  history?: readonly AiToneHistoryEntry[]
  signaturePhrases?: readonly string[]
}

export interface AiToneScanResult {
  findings: AiToneFinding[]
  /** Entry ids that actually matched, including suppressed signature phrases. */
  entryIds: string[]
  /** Entry ids whose only occurrence was the permitted signature phrase. */
  suppressedEntryIds: string[]
  /** Entry ids eligible for cross-chapter repeat tracking. */
  repeatEntryIds: string[]
}

interface Normalized {
  text: string
  /** normalized index -> original UTF-16 offset */
  map: number[]
}

const PUNCTUATION: Record<string, string> = {
  ',': '，',
  '.': '。',
  '!': '！',
  '?': '？',
  ':': '：',
  ';': '；',
}

const WHITESPACE = /[\s\u3000]/u

/** Normalise only for matching; offsets always map back to the source text. */
export function normalizeForAiTone(text: string): Normalized {
  let normalized = ''
  const map: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (WHITESPACE.test(char)) continue
    normalized += PUNCTUATION[char] ?? char
    map.push(index)
  }
  return { text: normalized, map }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const normalizeTerm = (value: string): string => normalizeForAiTone(value).text

/** Compile a template with only the three documented slots. */
export function compileAiToneTemplate(template: string): RegExp {
  let pattern = ''
  let index = 0
  while (index < template.length) {
    if (template.startsWith('{xxx}', index)) {
      pattern += '.{1,20}?'
      index += 5
    } else if (template.startsWith('{xx}', index)) {
      pattern += '.{1,12}?'
      index += 4
    } else if (template.startsWith('{ta}', index)) {
      pattern += '(?:ta|TA|Ta|tA|他|她)'
      index += 4
    } else {
      pattern += escapeRegExp(template[index]!)
      index += 1
    }
  }
  return new RegExp(pattern, 'u')
}

/** Validate a template slot set without compiling user input as a regex. */
export function assertAiToneTemplate(template: string): void {
  let rest = template
  let slots = 0
  while (rest !== '') {
    const next = rest.search(/\{(?:xx|xxx|ta)\}/u)
    if (next === -1) {
      if (rest.includes('{') || rest.includes('}'))
        throw new Error(`unsupported template slot in ${template}`)
      break
    }
    slots += 1
    rest = rest.slice(next).replace(/^\{(?:xx|xxx|ta)\}/u, '')
  }
  if (slots === 0) throw new Error(`template ${template} must contain at least one slot`)
}

interface Sentence {
  start: number
  end: number
  text: string
}

const sentenceSpans = (normalized: string): Sentence[] => {
  const spans: Sentence[] = []
  let start = 0
  for (let index = 0; index < normalized.length; index += 1) {
    if (!/[。！？!?；;]/u.test(normalized[index]!)) continue
    let end = index + 1
    while (end < normalized.length && /[。！？!?；;]/u.test(normalized[end]!)) end += 1
    spans.push({ start, end, text: normalized.slice(start, end) })
    start = end
    index = end - 1
  }
  if (start < normalized.length) spans.push({ start, end: normalized.length, text: normalized.slice(start) })
  return spans
}

interface DialogueRange {
  start: number
  end: number
}

/** Mark opening/closing quote ranges in original offsets. */
const dialogueRanges = (text: string): DialogueRange[] => {
  const ranges: DialogueRange[] = []
  let open: { index: number; close: string } | null = null
  let straightStart = -1
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (open !== null) {
      if (char === open.close) {
        ranges.push({ start: open.index, end: index + 1 })
        open = null
      }
      continue
    }
    if (straightStart >= 0) {
      if (char === '"') {
        ranges.push({ start: straightStart, end: index + 1 })
        straightStart = -1
      }
      continue
    }
    if (char === '“') open = { index, close: '”' }
    else if (char === '「') open = { index, close: '」' }
    else if (char === '『') open = { index, close: '』' }
    else if (char === '"') straightStart = index
  }
  if (straightStart >= 0) ranges.push({ start: straightStart, end: text.length })
  return ranges
}

const inRanges = (offset: number, ranges: readonly DialogueRange[]): boolean => {
  for (const range of ranges) {
    if (offset >= range.start && offset < range.end) return true
    if (range.start > offset) break
  }
  return false
}

interface RawHit {
  start: number
  end: number
  matched: string
  entry: AiToneEntry
  category: string
}

const entryRegex = (entry: AiToneEntry): RegExp | null => {
  if (entry.match === 'regex') {
    return entry.pattern === undefined || entry.pattern === '' ? null : new RegExp(entry.pattern, 'gu')
  }
  if (entry.match === 'template') {
    return entry.template === undefined || entry.template === ''
      ? null
      : new RegExp(compileAiToneTemplate(entry.template).source, 'gu')
  }
  return null
}

const stripSentencePunctuation = (value: string): string =>
  value.replace(/^[\s，。！？!?；;、]+/u, '').replace(/[\s，。！？!?；;、]+$/u, '')

const sentenceFor = (sentences: readonly Sentence[], index: number): Sentence => {
  for (const sentence of sentences) if (index >= sentence.start && index < sentence.end) return sentence
  return sentences[sentences.length - 1] ?? { start: 0, end: 0, text: '' }
}

const exclusionsMatch = (entry: AiToneEntry, sentence: string): boolean => {
  for (const pattern of entry.excludeIfMatches) {
    try {
      if (new RegExp(pattern, 'u').test(sentence)) return true
    } catch {
      // Compile-time validation rejects these; a malformed user pack cannot
      // make one chapter crash.
    }
  }
  return false
}

const collectHits = (normalized: string, lexicon: AiToneLexicon): RawHit[] => {
  const sentences = sentenceSpans(normalized)
  const hits: RawHit[] = []
  for (const entry of lexicon.entries) {
    const category = lexicon.categories[entry.category]
    if (category === undefined) continue
    if (entry.match === 'exact') {
      for (const term of entry.terms) {
        const needle = normalizeTerm(term)
        if (needle === '') continue
        for (const sentence of sentences) {
          const sentenceText = sentence.text
          let at = sentenceText.indexOf(needle)
          while (at !== -1) {
            const start = sentence.start + at
            const end = start + needle.length
            if (entry.standalone) {
              const body = stripSentencePunctuation(sentenceText)
              if (body.length > 6 && body !== needle) {
                at = sentenceText.indexOf(needle, at + 1)
                continue
              }
            }
            if (!exclusionsMatch(entry, sentenceText)) {
              hits.push({
                start,
                end,
                matched: normalized.slice(start, end),
                entry,
                category: entry.category,
              })
            }
            at = sentenceText.indexOf(needle, at + Math.max(1, needle.length))
          }
        }
      }
      continue
    }
    const regex = entryRegex(entry)
    if (regex === null) continue
    for (const sentence of sentences) {
      regex.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = regex.exec(sentence.text)) !== null) {
        if (match[0] === '') {
          regex.lastIndex += 1
          continue
        }
        const start = sentence.start + match.index
        const end = start + match[0].length
        if (entry.standalone) {
          const body = stripSentencePunctuation(sentence.text)
          if (body.length > 6 && body !== match[0]) continue
        }
        if (!exclusionsMatch(entry, sentence.text)) {
          hits.push({ start, end, matched: match[0], entry, category: entry.category })
        }
      }
    }
  }
  return hits
}

const dedupeHits = (hits: readonly RawHit[]): RawHit[] => {
  const sorted = [...hits].sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start
    if (left.end !== right.end) return right.end - left.end
    return (CATEGORY_PRIORITY[left.category] ?? 99) - (CATEGORY_PRIORITY[right.category] ?? 99)
  })
  const kept: RawHit[] = []
  let lastEnd = -1
  for (const hit of sorted) {
    if (hit.start < lastEnd) continue
    kept.push(hit)
    lastEnd = hit.end
  }
  return kept
}

interface ClassifiedHit extends RawHit {
  severity: Severity
  dialogue: boolean
  signature: boolean
  suppressed: boolean
}

const classify = (
  hit: RawHit,
  lexicon: AiToneLexicon,
  dialogue: boolean,
  signaturePhrase: string | null,
  signatureAllowed: boolean,
): ClassifiedHit | null => {
  const category = lexicon.categories[hit.category]
  if (category === undefined) return null
  const scope = hit.entry.scope ?? category.defaultScope
  if (scope === 'narration' && dialogue) return null
  if (scope === 'dialogue' && !dialogue) return null
  let severity: Severity = hit.entry.severity ?? category.defaultSeverity
  if (dialogue && hit.entry.severityInDialogue !== undefined) severity = hit.entry.severityInDialogue
  const signature = signaturePhrase !== null
  return {
    ...hit,
    severity,
    dialogue,
    signature,
    suppressed: signature && signatureAllowed,
  }
}

const escalate = (severity: Severity, mode: 'none' | 'one_level' | 'blocker'): Severity => {
  if (mode === 'none') return severity
  if (mode === 'blocker') return 'blocker'
  return 'blocker'
}

const applyCategoryDensity = (hits: ClassifiedHit[], lexicon: AiToneLexicon): void => {
  const byCategory = new Map<string, ClassifiedHit[]>()
  for (const hit of hits) {
    const rows = byCategory.get(hit.category)
    if (rows === undefined) byCategory.set(hit.category, [hit])
    else rows.push(hit)
  }
  for (const [categoryId, rows] of byCategory) {
    const category = lexicon.categories[categoryId]
    if (category === undefined) continue
    const sorted = [...rows].sort((left, right) => left.start - right.start)
    const window = category.window > 0 ? category.window : Number.POSITIVE_INFINITY
    for (let start = 0; start < sorted.length; start += 1) {
      let end = start
      while (end + 1 < sorted.length && sorted[end + 1]!.start - sorted[start]!.start <= window) end += 1
      if (end - start + 1 <= category.limit) continue
      for (let index = start + category.limit; index <= end; index += 1) {
        sorted[index]!.severity = escalate(sorted[index]!.severity, category.escalation)
      }
    }
  }
}

const globalDensityFinding = (
  hits: readonly ClassifiedHit[],
  original: string,
  map: readonly number[],
): AiToneFinding | null => {
  if (hits.length === 0) return null
  const sorted = [...hits].sort((left, right) => left.start - right.start)
  for (let start = 0; start < sorted.length; start += 1) {
    const windowStart = sorted[start]!.start
    const categories = new Set<string>()
    let total = 0
    let last: ClassifiedHit | null = null
    for (let index = start; index < sorted.length; index += 1) {
      const hit = sorted[index]!
      if (hit.start - windowStart > 1000) break
      categories.add(hit.category)
      total += 1
      last = hit
    }
    if (categories.size >= 3 || total >= 5) {
      const first = sorted[start]!
      return {
        code: AI_TONE_RULES.DENSITY,
        category: 'density',
        entryId: 'AI-TONE-DENSITY',
        severity: 'blocker',
        paragraph: paragraphAt(original, map[first.start] ?? 0),
        evidence: excerpt(
          original,
          map[first.start] ?? 0,
          map[(last ?? first).end - 1] ?? map[first.start] ?? 0,
        ),
        matched: 'AI 味密度',
        replacement: '删掉空转的对白点评、记账式确认和比较句，改成动作、物件或具体后果。',
        dialogue: first.dialogue,
        signature: false,
        offset: map[first.start] ?? 0,
      }
    }
  }
  return null
}

const paragraphAt = (text: string, offset: number): number => {
  let paragraph = 1
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') paragraph += 1
  }
  return paragraph
}

const excerpt = (text: string, start: number, end: number, radius = 16): string => {
  const from = Math.max(0, start - radius)
  const to = Math.min(text.length, end + radius + 1)
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`
}

/** Scan one chapter and return deterministic AI-tone findings. */
export function scanAiTone(
  original: string,
  lexicon: AiToneLexicon | undefined,
  options: AiToneScanOptions = {},
): AiToneScanResult {
  if (lexicon === undefined) {
    return { findings: [], entryIds: [], suppressedEntryIds: [], repeatEntryIds: [] }
  }
  const normalized = normalizeForAiTone(original)
  const ranges = dialogueRanges(original)
  const signature = (options.signaturePhrases ?? []).map(normalizeTerm).filter((value) => value !== '')
  const signatureUsed = new Map<string, number>()
  const hits = dedupeHits(collectHits(normalized.text, lexicon))
  const sentences = sentenceSpans(normalized.text)
  const classified: ClassifiedHit[] = []
  const entryIds = new Set<string>()
  const suppressedEntryIds = new Set<string>()
  for (const hit of hits) {
    const originalOffset = normalized.map[hit.start] ?? 0
    const dialogue = inRanges(originalOffset, ranges)
    const sentence = sentenceFor(sentences, hit.start)
    const phrase =
      signature.find((candidate) => {
        const at = sentence.text.indexOf(candidate)
        return (
          at !== -1 && hit.start >= sentence.start + at && hit.end <= sentence.start + at + candidate.length
        )
      }) ?? null
    const seen = phrase === null ? 0 : (signatureUsed.get(phrase) ?? 0)
    if (phrase !== null) signatureUsed.set(phrase, seen + 1)
    const row = classify(hit, lexicon, dialogue, phrase, seen === 0)
    if (row === null) continue
    entryIds.add(row.entry.id)
    if (row.suppressed) suppressedEntryIds.add(row.entry.id)
    classified.push(row)
  }
  applyCategoryDensity(classified, lexicon)
  const findings: AiToneFinding[] = classified
    .filter((row) => !row.suppressed)
    .map((row) => {
      const offset = normalized.map[row.start] ?? 0
      return {
        code: lexicon.categories[row.category]?.code ?? AI_TONE_RULES.TEMPLATE,
        category: row.category,
        entryId: row.entry.id,
        severity: row.severity,
        paragraph: paragraphAt(original, offset),
        evidence: excerpt(original, offset, normalized.map[row.end - 1] ?? offset),
        matched: row.matched,
        replacement: row.entry.replacement,
        dialogue: row.dialogue,
        signature: row.signature,
        offset,
      }
    })
  const density = globalDensityFinding(classified, original, normalized.map)
  if (density !== null) findings.push(density)
  const repeat = repeatFindings(
    classified,
    options.history ?? [],
    options.chapter ?? 0,
    original,
    normalized.map,
  )
  findings.push(...repeat)
  const repeatEntryIds = [
    ...new Set(classified.filter((row) => !row.signature && !row.suppressed).map((row) => row.entry.id)),
  ].sort()
  return {
    findings,
    entryIds: [...entryIds].sort(),
    suppressedEntryIds: [...suppressedEntryIds].sort(),
    repeatEntryIds,
  }
}

const repeatFindings = (
  hits: readonly ClassifiedHit[],
  history: readonly AiToneHistoryEntry[],
  chapter: number,
  original: string,
  map: readonly number[],
): AiToneFinding[] => {
  if (chapter <= 0 || history.length === 0) return []
  const firstByEntry = new Map<string, ClassifiedHit>()
  for (const hit of hits) {
    if (hit.signature || hit.suppressed) continue
    if (!firstByEntry.has(hit.entry.id)) firstByEntry.set(hit.entry.id, hit)
  }
  const findings: AiToneFinding[] = []
  for (const [entryId, hit] of firstByEntry) {
    const previous = history.filter(
      (row) => row.chapter < chapter && chapter - row.chapter <= 10 && row.entries.includes(entryId),
    )
    const consecutive = history.some((row) => row.chapter === chapter - 1 && row.entries.includes(entryId))
    if (!consecutive && previous.length < 2) continue
    const offset = map[hit.start] ?? 0
    findings.push({
      code: AI_TONE_RULES.REPEAT,
      category: 'repeat',
      entryId,
      severity: 'blocker',
      paragraph: paragraphAt(original, offset),
      evidence: excerpt(original, offset, map[hit.end - 1] ?? offset),
      matched: hit.matched,
      replacement: '同一口头禅连续跨章出现；换成动作、场景细节或人物各自不同的说法。',
      dialogue: hit.dialogue,
      signature: false,
      offset,
    })
  }
  return findings
}

/** Convert detector findings to the engine's Violation shape. */
export function aiToneViolations(result: AiToneScanResult): Violation[] {
  return result.findings.map((finding) => ({
    code: finding.code,
    severity: finding.severity,
    location: { paragraph: finding.paragraph },
    detail: `${finding.entryId} "${finding.matched}"：${finding.replacement}`,
  }))
}

/** Run the detector from a rule context; history is optional. */
export function scanAiToneContext(ctx: RuleContext): AiToneScanResult {
  return scanAiTone(ctx.text, ctx.rulepack.lexicon.ai_tone, {
    chapter: ctx.chapter,
    history: ctx.aiToneHistory ?? [],
    signaturePhrases: ctx.signaturePhrases ?? [],
  })
}
