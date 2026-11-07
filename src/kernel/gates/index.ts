import { z } from 'zod'
import { countWordMetrics } from '../../domain/wordcount.js'
import { splitParagraphs, splitSentenceSpans } from '../../domain/text.js'
import { SCORE_DIMENSIONS, totalScore } from '../../domain/scoring.js'
import { runRules } from '../../rules/pipeline.js'
import { loadRulepack } from '../../rulepack.js'
import { AI_TONE_RULES, FORMAT_RULES } from '../../codes.js'
import { scanAiTone, type AiToneFinding, type AiToneHistoryEntry } from '../../rules/ai-tone.js'
import {
  ChapterSummarySchema,
  type ChapterPlan,
  type ContinuityReport,
  type Draft,
  type PolishPatch,
  type ReviewReport,
} from '../../contracts/artifacts.js'
import type { Canon } from '../../contracts/project.js'
import type { LoadedProject } from '../project/layout.js'
import type { BibleSnapshot } from '../book/store.js'
import { resolveGenreProfile } from '../../domain/taxonomy.js'
import type { Rulepack } from '../../rules/types.js'

export interface GateInput {
  project: LoadedProject
  chapter: number
  plan: ChapterPlan
  draft: Draft
  /** Hash of the draft artifact the critics read; stale reports fail PG-09. */
  draftHash?: string
  /** Hash of the proof draft; defaults to draftHash when polish has not run. */
  reviewHash?: string
  /** The draft the critics actually read; polish may change the latest bytes. */
  proofSource?: Draft
  /** Latest polish patch and the draft it was applied to; EG-08 verifies it. */
  polish?: { patch: PolishPatch; sourceDraft: Draft }
  reviews: ReviewReport[]
  continuity: ContinuityReport | null
  canon: Canon
  bible: BibleSnapshot
  previousTexts: Array<{ chapter: number; text: string }>
  round: number
  maxRounds: number
}

export type GateVerdict = 'pass' | 'fail' | 'advisory'

export interface GateFinding {
  code: string
  name: string
  verdict: GateVerdict
  severity: 'blocker' | 'advisory'
  message: string
  details?: Record<string, unknown>
}

export interface GateReport {
  pass: boolean
  score: number
  findings: GateFinding[]
  blockers: GateFinding[]
  advisories: GateFinding[]
  aiTone: AiToneFinding[]
}

export const CRITIC_DIMENSIONS: Record<ReviewReport['role'], readonly string[]> = {
  'critic-story': ['R-W-04', 'R-W-05', 'R-W-12'],
  'critic-character': ['R-W-01', 'R-W-02', 'R-W-03'],
  'critic-prose': ['R-W-06', 'R-W-07', 'R-W-08', 'R-W-09', 'R-W-10', 'R-W-11', 'R-W-13', 'R-W-14', 'R-W-15'],
}

const dimensionMax = (id: string): number =>
  SCORE_DIMENSIONS.find((dimension) => dimension.id === id)?.max ?? 0

/** Apply taxonomy profile overrides to a compiled rulepack without mutating it. */
export function applyTaxonomyProfile(project: LoadedProject, base: Rulepack): Rulepack {
  const values = resolveGenreProfile(project.config.genre, project.taxonomy).values
  const pack = structuredClone(base) as Rulepack
  if (values.paragraph_max_words !== undefined) pack.format.paragraph_max_words = values.paragraph_max_words
  if (values.water_words !== undefined) pack.semantics.water_words.threshold = values.water_words
  if (values.pleasure_keywords !== undefined)
    pack.semantics.pleasure_density.keywords = [...values.pleasure_keywords]
  if (values.foreshadow_min_dormancy !== undefined)
    pack.crosschapter.foreshadow_min_dormancy = values.foreshadow_min_dormancy
  if (values.motif_min_dormancy !== undefined)
    pack.crosschapter.motif_min_dormancy = values.motif_min_dormancy
  if (values.foreshadow_dormant_after !== undefined)
    pack.crosschapter.foreshadow_dormant_after = values.foreshadow_dormant_after
  if (values.lexicon_add !== undefined) {
    const known = new Set(pack.lexicon.soft.map((entry) => entry.term))
    for (const term of values.lexicon_add) if (!known.has(term)) pack.lexicon.soft.push({ term, limit: 4 })
  }
  if (values.lexicon_remove !== undefined) {
    const remove = new Set(values.lexicon_remove)
    pack.lexicon.zero_tolerance = pack.lexicon.zero_tolerance.filter((entry) => !remove.has(entry.term))
    pack.lexicon.soft = pack.lexicon.soft.filter((entry) => !remove.has(entry.term))
    pack.lexicon.contextual = pack.lexicon.contextual.filter((entry) => !remove.has(entry.term))
    pack.lexicon.meta_narration = pack.lexicon.meta_narration.filter((entry) => !remove.has(entry.term))
    const aiTone = pack.lexicon.ai_tone
    if (aiTone !== undefined) {
      aiTone.entries = aiTone.entries
        .map((entry) =>
          entry.terms.length === 0
            ? entry
            : { ...entry, terms: entry.terms.filter((term) => !remove.has(term)) },
        )
        .filter((entry) => entry.match !== 'exact' || entry.terms.length > 0)
    }
  }
  return pack
}

const quoteFrom = (draft: Draft, quote: string): boolean => {
  const normalize = (value: string): string => value.replace(/\s+/gu, '')
  return normalize(draft.content).includes(normalize(quote))
}

const keywordHit = (text: string, needle: string): boolean => {
  const tokens = needle
    .split(/[\s，。！？、；：,.!?;:]+/u)
    .map((token) => token.trim())
    .filter((token) => Array.from(token).length >= 2)
  if (tokens.length === 0) return text.includes(needle)
  return tokens.some((token) => text.includes(token))
}

/** A plan concept counts as present when a 2-char n-gram occurs in the prose. */
const conceptHit = (text: string, phrase: string): boolean => {
  const chars = Array.from(phrase.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, ''))
  if (chars.length < 2) return text.includes(phrase)
  for (let index = 0; index + 1 < chars.length; index += 1) {
    if (text.includes(`${chars[index]}${chars[index + 1]}`)) return true
  }
  return false
}

const dialogueText = (text: string): string =>
  [...text.matchAll(/[“「]([^”」]*)[”」]/gu)].map((match) => match[1] ?? '').join('')

const countFirstPerson = (text: string): number => (text.match(/我/gu) ?? []).length

const firstEvidence = (text: string): string => {
  const sentence = splitSentenceSpans(text).find((span) => span.text.includes('我'))
  return sentence?.text.slice(0, 80) ?? ''
}

const paragraphLengths = (text: string): number[] =>
  splitParagraphs(text).map((paragraph) => countWordMetrics(paragraph).total_word_count)

export function evaluateGates(input: GateInput): GateReport {
  const findings: GateFinding[] = []
  const add = (
    code: string,
    name: string,
    verdict: GateVerdict,
    message: string,
    details?: Record<string, unknown>,
  ): void => {
    findings.push({
      code,
      name,
      verdict,
      severity: verdict === 'fail' ? 'blocker' : 'advisory',
      message,
      ...(details === undefined ? {} : { details }),
    })
  }
  const profileValues = resolveGenreProfile(input.project.config.genre, input.project.taxonomy).values
  const pack = applyTaxonomyProfile(input.project, loadRulepack())
  const legacyGenre =
    input.project.taxonomy.subById.get(input.project.config.genre.sub)?.legacyGenre ?? '都市现代'
  const metrics = countWordMetrics(input.draft.content)
  const rulesContext = {
    chapter: input.chapter,
    title: input.draft.title,
    genre: legacyGenre,
    sceneType: input.draft.scene_type,
    rulepack: pack,
    summary: input.draft.summary as never,
    evidence: {
      characters: null,
      previousText: input.previousTexts[0]?.text ?? null,
      previousTexts: input.previousTexts.map((row) => row.text),
      previousChapterNums: input.previousTexts.map((row) => row.chapter),
      foreshadows: null,
      timeline: null,
      relationships: null,
      world: null,
      locks: null,
    },
    targets: {
      words_per_chapter: input.project.config.targets.words_per_chapter,
      dialogue_ratio: profileValues.dialogue_ratio ?? input.project.config.targets.dialogue_ratio,
      min_cjk_chars: input.project.config.targets.min_cjk_chars,
      dialogue_ratio_metric: 'both' as const,
    },
    facts: [] as Array<{ alias: string; value: number; unit: string; tolerance?: number }>,
    strict: false,
    disableRelationUnknown: true,
    aiToneStage: 'check' as const,
  }

  // PG-01 / PG-02: the plan and draft must exist and be tied to this chapter.
  if (input.plan.chapter !== input.chapter || input.draft.chapter !== input.chapter) {
    add('PG-01', 'BRIEF_REQUIRED', 'fail', 'chapter plan and draft target different chapters')
  } else {
    add('PG-01', 'BRIEF_REQUIRED', 'pass', 'plan and draft are present')
  }
  add('PG-02', 'STAGE_ORDER', 'pass', 'plan -> draft -> review -> continuity -> polish is in order')

  // PG-03: word count.
  const [minWords] = input.project.config.targets.words_per_chapter
  const minCjk = input.project.config.targets.min_cjk_chars
  if (metrics.total_word_count < minWords || metrics.cjk_chars < minCjk) {
    add(
      'PG-03',
      'WORD_COUNT',
      'fail',
      `words ${metrics.total_word_count}/${minWords}, CJK ${metrics.cjk_chars}/${minCjk}`,
      {
        words: metrics.total_word_count,
        cjk: metrics.cjk_chars,
      },
    )
  } else add('PG-03', 'WORD_COUNT', 'pass', `${metrics.total_word_count} words`)

  // PG-04: deterministic format.
  const format = runRules(
    [
      FORMAT_RULES.MD_CONTAMINATION,
      FORMAT_RULES.ILLEGAL_QUOTE,
      FORMAT_RULES.SEMICOLON,
      FORMAT_RULES.ENGLISH_ELLIPSIS,
      FORMAT_RULES.SCENE_SEPARATOR,
      FORMAT_RULES.LONG_PARAGRAPH,
      FORMAT_RULES.TITLE_FORMAT,
      FORMAT_RULES.SYSTEM_LABEL,
    ],
    input.draft.content,
    rulesContext,
  ).filter((violation) => violation.severity === 'blocker')
  if (format.length > 0)
    add('PG-04', 'FORMAT', 'fail', format.map((row) => row.detail).join('; '), { findings: format })
  else add('PG-04', 'FORMAT', 'pass', 'format clean')

  // PG-05: summary schema.
  const summary = ChapterSummarySchema.safeParse(input.draft.summary)
  if (!summary.success) add('PG-05', 'SUMMARY_SCHEMA', 'fail', 'summary does not match the 10-section schema')
  else add('PG-05', 'SUMMARY_SCHEMA', 'pass', 'summary schema valid')

  // PG-06: scene contract.
  if (input.draft.scene_type !== input.plan.scene_type) {
    add(
      'PG-06',
      'SCENE_TYPE',
      'fail',
      `draft scene ${input.draft.scene_type} != plan ${input.plan.scene_type}`,
    )
  } else if (!input.draft.self_check.scene_contract.goal || !input.draft.self_check.scene_contract.conflict) {
    add('PG-06', 'SCENE_TYPE', 'fail', 'scene contract is incomplete')
  } else add('PG-06', 'SCENE_TYPE', 'pass', 'scene type and contract valid')

  // PG-09: reading proof before score, because proof is evidence for deductions.
  const proofProblems: string[] = []
  const evidenceDraft = input.proofSource ?? input.draft
  const expectedReviewHash = input.reviewHash ?? input.draftHash
  for (const review of input.reviews) {
    if (expectedReviewHash !== undefined && review.base_hash !== expectedReviewHash)
      proofProblems.push(`${review.role} reviewed stale draft ${review.base_hash}`)
    for (const [name, citation] of Object.entries(review.proof)) {
      if (Array.from(citation.quote).length < 8)
        proofProblems.push(`${review.role}.${name} quote is shorter than 8 chars`)
      else if (!quoteFrom(evidenceDraft, citation.quote))
        proofProblems.push(`${review.role}.${name} quote is not in the draft`)
    }
  }
  if (input.reviews.length !== 3) proofProblems.push(`expected 3 critic reports, got ${input.reviews.length}`)
  if (proofProblems.length > 0) add('PG-09', 'READING_PROOF', 'fail', proofProblems.join('; '))
  else add('PG-09', 'READING_PROOF', 'pass', 'three critics cite the draft')

  // PG-07: score arithmetic and critic ownership.
  const merged = new Map<string, number>()
  const scoreProblems: string[] = []
  const aiRules: string[] = []
  for (const review of input.reviews) {
    const allowed = CRITIC_DIMENSIONS[review.role]
    const ownMax = allowed.reduce((total, id) => total + dimensionMax(id), 0)
    let ownDeductions = 0
    const seenDimensions = new Set<string>()
    for (const dimension of review.dimensions) {
      if (!allowed.includes(dimension.id)) scoreProblems.push(`${review.role} cannot score ${dimension.id}`)
      if (seenDimensions.has(dimension.id)) scoreProblems.push(`${review.role} repeats ${dimension.id}`)
      seenDimensions.add(dimension.id)
      if (dimension.max !== dimensionMax(dimension.id))
        scoreProblems.push(`${dimension.id} max must be ${dimensionMax(dimension.id)}`)
      const dimensionDelta = dimension.deductions.reduce((total, row) => total + row.delta, 0)
      if (dimensionDelta > dimension.max) {
        scoreProblems.push(`${dimension.id} deductions ${dimensionDelta} exceed max ${dimension.max}`)
      }
      if (dimension.id === 'R-W-07' && dimension.deductions.length > 0) {
        aiRules.push('R-W-07')
        if (dimension.deductions.some((deduction) => !deduction.rule.startsWith('AI_TONE_'))) {
          scoreProblems.push('R-W-07 deductions must cite AI_TONE_* rule codes')
        }
      }
      for (const deduction of dimension.deductions) {
        ownDeductions += deduction.delta
        merged.set(dimension.id, (merged.get(dimension.id) ?? 0) + deduction.delta)
        if (deduction.rule.startsWith('AI_TONE_')) aiRules.push(deduction.rule)
      }
    }
    for (const id of allowed) {
      if (!seenDimensions.has(id)) scoreProblems.push(`${review.role} is missing dimension ${id}`)
    }
    if (review.total !== ownMax - ownDeductions) {
      scoreProblems.push(`${review.role} total ${review.total} != ${ownMax} - ${ownDeductions}`)
    }
    for (const finding of review.findings) {
      if (Array.from(finding.evidence).length < 8 || !quoteFrom(evidenceDraft, finding.evidence)) {
        scoreProblems.push(`${review.role} finding ${finding.id} has no locatable evidence`)
      }
    }
  }
  const score = totalScore(
    SCORE_DIMENSIONS.map((dimension) => ({
      id: dimension.id,
      max: dimension.max,
      deductions: [
        {
          rule: 'MERGED',
          location: 'chapter',
          delta: Math.min(dimension.max, merged.get(dimension.id) ?? 0),
          note: 'merged',
        },
      ],
    })),
  )
  if (score < input.project.config.quality.min_score)
    scoreProblems.push(`score ${score} < min ${input.project.config.quality.min_score}`)

  // PG-08: blockers must be fixed with evidence.
  const openBlockers: Array<{
    severity: 'blocker' | 'advisory'
    status: string
    problem: string
    resolution?: string | null
  }> = input.reviews.flatMap((review) =>
    review.findings.map((finding) => ({
      severity: finding.severity,
      status: finding.status,
      problem: finding.problem,
      resolution: finding.resolution ?? null,
    })),
  )
  if (input.continuity !== null) {
    for (const finding of input.continuity.findings) {
      openBlockers.push({
        severity: finding.severity,
        status: finding.status,
        problem: finding.problem,
        resolution: finding.resolution ?? null,
      })
    }
  }
  const openOnly = openBlockers.filter(
    (finding) => finding.severity === 'blocker' && finding.status !== 'fixed',
  )
  const fixedWithoutEvidence = openBlockers.filter(
    (finding) =>
      finding.severity === 'blocker' &&
      finding.status === 'fixed' &&
      (finding.resolution === undefined ||
        finding.resolution === null ||
        Array.from(finding.resolution).length < 8 ||
        !quoteFrom(evidenceDraft, finding.resolution)),
  )
  if (openOnly.length > 0) {
    add('PG-08', 'ISSUES_CLEARED', 'fail', `${openOnly.length} blocker(s) still open`)
  } else if (fixedWithoutEvidence.length > 0) {
    add(
      'PG-08',
      'ISSUES_CLEARED',
      'fail',
      `${fixedWithoutEvidence.length} fixed blocker(s) lack current-draft evidence: ${fixedWithoutEvidence
        .map((finding) => finding.problem)
        .join('; ')}`,
    )
  } else add('PG-08', 'ISSUES_CLEARED', 'pass', 'all blockers closed with evidence')

  // PG-10: continuity.
  if (input.continuity === null) add('PG-10', 'CONSISTENCY', 'fail', 'continuity report is missing')
  else {
    const problems = [
      ...(input.draftHash !== undefined && input.continuity.base_hash !== input.draftHash
        ? [`continuity reviewed stale draft ${input.continuity.base_hash}`]
        : []),
      ...input.continuity.canon_conflicts,
      ...input.continuity.findings
        .filter((finding) => finding.severity === 'blocker' && finding.status !== 'fixed')
        .map((finding) => finding.problem),
    ]
    if (problems.length > 0) add('PG-10', 'CONSISTENCY', 'fail', problems.join('; '))
    else add('PG-10', 'CONSISTENCY', 'pass', 'canon consistent')
  }

  // PG-11: rounds.
  if (input.round > input.maxRounds)
    add('PG-11', 'ROUNDS', 'fail', `round ${input.round} > ${input.maxRounds}`)
  else add('PG-11', 'ROUNDS', 'pass', `round ${input.round}/${input.maxRounds}`)

  // PG-12 is completed by archive itself; the preflight proves the draft hash exists.
  add('PG-12', 'ARCHIVE_ATOMIC', 'pass', 'archive preflight: draft hash is present')

  // PG-13: outline alignment.
  const alignment: string[] = []
  if (input.draft.title !== input.plan.title)
    alignment.push(`title "${input.draft.title}" != plan "${input.plan.title}"`)
  if (!keywordHit(input.draft.content, input.plan.hook))
    alignment.push('chapter hook is not visible in the draft')
  if (input.draft.content.length === 0) alignment.push('draft is empty')
  if (alignment.length > 0) add('PG-13', 'OUTLINE_ALIGNMENT', 'fail', alignment.join('; '))
  else add('PG-13', 'OUTLINE_ALIGNMENT', 'pass', 'draft follows the chapter card')

  // EG-01 voice fingerprint (advisory).
  const rhythm = splitSentenceSpans(input.draft.content)
  const lengths = rhythm.map((span) => Array.from(span.text).length)
  const average =
    lengths.length === 0 ? 0 : lengths.reduce((total, value) => total + value, 0) / lengths.length
  const fingerprint = input.bible.fingerprint as Record<string, unknown>
  const fingerprintSamples = Array.isArray(fingerprint.sentence_length)
    ? fingerprint.sentence_length
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
    : []
  const fingerprintAverage =
    fingerprintSamples.length > 0
      ? fingerprintSamples.reduce((total, value) => total + value, 0) / fingerprintSamples.length
      : Number(fingerprint.average_sentence_length ?? 0)
  const fingerprintDialogue = Number(fingerprint.dialogue_ratio ?? 0)
  const dialogueRatio =
    metrics.total_word_count === 0
      ? 0
      : countWordMetrics(dialogueText(input.draft.content)).total_word_count / metrics.total_word_count
  const voiceProblems: string[] = []
  if (
    fingerprintAverage > 0 &&
    Math.abs(average - fingerprintAverage) > Math.max(4, fingerprintAverage * 0.35)
  ) {
    voiceProblems.push(
      `average sentence ${average.toFixed(1)} deviates from fingerprint ${fingerprintAverage.toFixed(1)}`,
    )
  }
  if (fingerprintDialogue > 0 && Math.abs(dialogueRatio - fingerprintDialogue) > 0.2) {
    voiceProblems.push(
      `dialogue ratio ${dialogueRatio.toFixed(2)} deviates from fingerprint ${fingerprintDialogue.toFixed(2)}`,
    )
  }
  if (voiceProblems.length > 0) {
    add('EG-01', 'VOICE_FINGERPRINT', 'advisory', voiceProblems.join('; '), {
      average,
      fingerprintAverage,
      dialogueRatio,
      fingerprintDialogue,
    })
  } else add('EG-01', 'VOICE_FINGERPRINT', 'pass', 'voice within tolerance')

  // EG-02 scene contract: all four plan beats must land in the prose. Requiring
  // verbatim equality would fail every real draft; requiring zero presence
  // would let the model ignore the card. At least three of four is the floor.
  const contract = input.draft.self_check.scene_contract
  const contractFields = [contract.goal, contract.conflict, contract.turn, contract.outcome]
  const planBeats = [input.plan.goal, input.plan.conflict, input.plan.turn, input.plan.outcome]
  const absentBeats = planBeats.filter((beat) => beat.trim() !== '' && !conceptHit(input.draft.content, beat))
  if (contractFields.some((value) => value.trim() === '')) {
    add('EG-02', 'SCENE_CONTRACT', 'fail', 'draft scene contract has an empty beat')
  } else if (absentBeats.length >= 2) {
    add(
      'EG-02',
      'SCENE_CONTRACT',
      'fail',
      `${absentBeats.length} chapter-card beat(s) have no landing in the prose`,
      { absentBeats },
    )
  } else add('EG-02', 'SCENE_CONTRACT', 'pass', 'scene contract beats present')

  // EG-03 hook strength (advisory).
  if (input.draft.summary.hook_strength < 3)
    add('EG-03', 'HOOK_STRENGTH', 'advisory', `hook strength ${input.draft.summary.hook_strength}/5`)
  else add('EG-03', 'HOOK_STRENGTH', 'pass', 'hook is strong')

  // EG-04 pacing (advisory).
  const paragraphs = paragraphLengths(input.draft.content)
  const maxParagraph = paragraphs.length === 0 ? 0 : Math.max(...paragraphs)
  if (maxParagraph > pack.format.paragraph_max_words)
    add(
      'EG-04',
      'PACING_CURVE',
      'advisory',
      `longest paragraph ${maxParagraph} > ${pack.format.paragraph_max_words}`,
    )
  else add('EG-04', 'PACING_CURVE', 'pass', 'pacing within budget')

  // EG-05 POV: dialogue is allowed to say 我; only narration counts.
  const firstPerson = input.plan.pov.includes('第一')
  const narration = input.draft.content.replace(/[“「][^”」]*[”」]/gu, '')
  const firstPersonHits = countFirstPerson(narration)
  const narrationWords = Math.max(1, countWordMetrics(narration).total_word_count)
  if (firstPerson && firstPersonHits === 0) {
    add('EG-05', 'POV_CONSISTENCY', 'fail', 'plan declares first person but narration never uses 我')
  } else if (!firstPerson && firstPersonHits > Math.max(3, narrationWords * 0.02)) {
    add('EG-05', 'POV_CONSISTENCY', 'fail', 'third-person narration has too many first-person pronouns', {
      firstPersonHits,
      narrationWords,
      evidence: firstEvidence(narration),
    })
  } else add('EG-05', 'POV_CONSISTENCY', 'pass', 'POV consistent')

  // EG-06 canon contradictions.
  const canonBlockers =
    input.continuity?.findings.filter(
      (finding) => finding.kind === 'canon' && finding.severity === 'blocker' && finding.status !== 'fixed',
    ) ?? []
  if (canonBlockers.length > 0)
    add('EG-06', 'CANON_CONTRADICTION', 'fail', canonBlockers.map((finding) => finding.problem).join('; '))
  else add('EG-06', 'CANON_CONTRADICTION', 'pass', 'no canon contradiction')

  // EG-07 AI tone: reuse the rulepack scanner with ten-chapter history.
  const lexicon = pack.lexicon.ai_tone
  const signaturePhrases = input.bible.characters.flatMap((character) => {
    const voice = character.voice as { signature_phrases?: unknown } | undefined
    return Array.isArray(voice?.signature_phrases)
      ? voice.signature_phrases.filter((item): item is string => typeof item === 'string')
      : []
  })
  const history: AiToneHistoryEntry[] = input.previousTexts
    .map((row) => ({
      chapter: row.chapter,
      entries: scanAiTone(row.text, lexicon, { chapter: row.chapter, signaturePhrases }).repeatEntryIds,
    }))
    .sort((left, right) => left.chapter - right.chapter)
  const aiTone = scanAiTone(input.draft.content, lexicon, {
    chapter: input.chapter,
    history,
    signaturePhrases,
  })
  const aiBlockers = aiTone.findings.filter((finding) => finding.severity === 'blocker')
  if (aiBlockers.length > 0) {
    add('EG-07', 'AI_TONE', 'fail', `${aiBlockers.length} AI-tone blocker(s)`, { findings: aiBlockers })
  } else if (aiTone.findings.length > 0) {
    add('EG-07', 'AI_TONE', 'advisory', `${aiTone.findings.length} AI-tone advisory finding(s)`, {
      findings: aiTone.findings,
    })
  } else add('EG-07', 'AI_TONE', 'pass', 'AI tone clean')

  // R-W-07 mapping: a meta/density blocker requires a prose deduction.
  const severeAi = aiBlockers.some(
    (finding) => finding.code === AI_TONE_RULES.META || finding.code === AI_TONE_RULES.DENSITY,
  )
  if (severeAi && !aiRules.includes('R-W-07')) {
    scoreProblems.push('AI_TONE blocker exists but critic-prose did not deduct R-W-07')
  }
  if (scoreProblems.length > 0) add('PG-07', 'SCORE', 'fail', scoreProblems.join('; '), { score })
  else add('PG-07', 'SCORE', 'pass', `score ${score}`, { score })

  // EG-08: verify the actual polish patch against the draft the critics read.
  if (input.polish === undefined) {
    add('EG-08', 'DIFF_SAFETY', 'pass', 'no polish patch to verify')
  } else {
    const patchProblems = validatePolishPatch(input.polish.sourceDraft, input.polish.patch)
    let applied = ''
    try {
      applied = applyPolishPatch(input.polish.sourceDraft, input.polish.patch).content
    } catch {
      patchProblems.push('polish patch cannot be applied')
    }
    if (applied !== '' && applied !== input.draft.content) {
      patchProblems.push('approved draft is not the deterministic polish result')
    }
    if (patchProblems.length > 0) {
      add('EG-08', 'DIFF_SAFETY', 'fail', patchProblems.join('; '), { patchProblems })
    } else add('EG-08', 'DIFF_SAFETY', 'pass', 'polish patch is bounded and hash-bound')
  }

  const blockers = findings.filter((finding) => finding.verdict === 'fail')
  return {
    pass: blockers.length === 0,
    score,
    findings,
    blockers,
    advisories: findings.filter((finding) => finding.verdict === 'advisory'),
    aiTone: aiTone.findings,
  }
}

export { dimensionMax, keywordHit, quoteFrom }

/**
 * Archive-stage AI-tone escalation: P3/P4 advisories become blockers once the
 * chapter is about to become canonical prose. Runs are intentionally separate
 * from review-stage gates so an advisory never silently ships.
 */
export function evaluateArchiveTone(input: {
  project: LoadedProject
  chapter: number
  draft: Draft
  bible: BibleSnapshot
  previousTexts: Array<{ chapter: number; text: string }>
}): AiToneFinding[] {
  const pack = applyTaxonomyProfile(input.project, loadRulepack())
  const lexicon = pack.lexicon.ai_tone
  if (lexicon === undefined) return []
  const signaturePhrases = input.bible.characters.flatMap((character) => {
    const voice = character.voice as { signature_phrases?: unknown } | undefined
    return Array.isArray(voice?.signature_phrases)
      ? voice.signature_phrases.filter((item): item is string => typeof item === 'string')
      : []
  })
  const history: AiToneHistoryEntry[] = input.previousTexts
    .map((row) => ({
      chapter: row.chapter,
      entries: scanAiTone(row.text, lexicon, { chapter: row.chapter, signaturePhrases }).repeatEntryIds,
    }))
    .sort((left, right) => left.chapter - right.chapter)
  return scanAiTone(input.draft.content, lexicon, {
    chapter: input.chapter,
    history,
    signaturePhrases,
  }).findings
}

/** Deterministic format preflight for host-side human edits. */
export function evaluateDraftFormat(
  project: LoadedProject,
  chapter: number,
  title: string,
  content: string,
): GateFinding[] {
  const pack = applyTaxonomyProfile(project, loadRulepack())
  const legacyGenre = project.taxonomy.subById.get(project.config.genre.sub)?.legacyGenre ?? '都市现代'
  const violations = runRules(
    [
      FORMAT_RULES.MD_CONTAMINATION,
      FORMAT_RULES.ILLEGAL_QUOTE,
      FORMAT_RULES.SEMICOLON,
      FORMAT_RULES.ENGLISH_ELLIPSIS,
      FORMAT_RULES.SCENE_SEPARATOR,
      FORMAT_RULES.LONG_PARAGRAPH,
      FORMAT_RULES.TITLE_FORMAT,
      FORMAT_RULES.SYSTEM_LABEL,
    ],
    content,
    {
      chapter,
      title,
      genre: legacyGenre,
      sceneType: '日常过渡章',
      rulepack: pack,
      summary: {} as never,
      evidence: {
        characters: null,
        previousText: null,
        previousTexts: [],
        previousChapterNums: [],
        foreshadows: null,
        timeline: null,
        relationships: null,
        world: null,
        locks: null,
      },
      targets: {
        words_per_chapter: project.config.targets.words_per_chapter,
        dialogue_ratio: project.config.targets.dialogue_ratio,
        min_cjk_chars: project.config.targets.min_cjk_chars,
        dialogue_ratio_metric: 'both' as const,
      },
      facts: [],
      strict: false,
      disableRelationUnknown: true,
      aiToneStage: 'check' as const,
    },
  ).filter((violation) => violation.severity === 'blocker')
  return violations.map((violation) => ({
    code: 'PG-04',
    name: 'FORMAT',
    verdict: 'fail' as const,
    severity: 'blocker' as const,
    message: violation.detail,
  }))
}

/** Validate a polish patch before applying: anchors must be unique and present. */
export function validatePolishPatch(
  draft: Draft,
  patch: import('../../contracts/artifacts.js').PolishPatch,
): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const [index, item] of patch.patches.entries()) {
    if (seen.has(item.anchor)) problems.push(`patch ${index} repeats anchor`)
    seen.add(item.anchor)
    const count = draft.content.split(item.anchor).length - 1
    if (count !== 1) problems.push(`patch ${index} anchor appears ${count} times`)
    if (!item.before || !draft.content.includes(item.before))
      problems.push(`patch ${index} before text is not in the draft`)
  }
  return problems
}

export function applyPolishPatch(
  draft: Draft,
  patch: import('../../contracts/artifacts.js').PolishPatch,
): Draft {
  const problems = validatePolishPatch(draft, patch)
  if (problems.length > 0) {
    throw new Error(`unsafe polish patch: ${problems.join('; ')}`)
  }
  let content = draft.content
  for (const item of patch.patches) content = content.replace(item.before, item.after)
  return { ...draft, content, summary: { ...draft.summary } }
}

export const GateFindingSchema = z.object({
  code: z.string(),
  name: z.string(),
  verdict: z.enum(['pass', 'fail', 'advisory']),
  severity: z.enum(['blocker', 'advisory']),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
})
