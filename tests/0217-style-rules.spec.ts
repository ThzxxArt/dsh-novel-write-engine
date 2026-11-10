import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'
import { compileStylePack } from '../src/rules/style.js'
import { loadRulepack } from '../src/rulepack.js'
import { runMachineChecks } from '../src/rules/pipeline.js'
import type { MachineOptions } from '../src/rules/pipeline.js'
import type { StylePack } from '../src/rules/types.js'
import { STYLE_RULES } from '../src/codes.js'
import { measureStyle, styleVocabulary, SHORT_SENTENCE_MAX, LONG_SENTENCE_MIN } from '../src/domain/style.js'

const repoRoot = new URL('../', import.meta.url)
const rulepack = loadRulepack()

const packOf = (id: string): StylePack =>
  compileStylePack(parse(readFileSync(new URL(`stylepacks/${id}.yaml`, repoRoot), 'utf8')), {
    fileId: id,
    zeroTolerance: rulepack.lexicon.zero_tolerance.map((entry) => entry.term),
  }).pack

const cold = packOf('cold-suspense')
const infinite = packOf('infinite-flow')

const options = (style: StylePack, overrides: Partial<MachineOptions> = {}): MachineOptions => ({
  chapter: 1,
  title: '第1章 雨夜',
  genre: '悬疑推理',
  sceneType: '纯叙事章',
  rulepack,
  summary: null,
  evidence: {
    characters: null,
    previousText: null,
    previousTexts: [],
    foreshadows: null,
    timeline: null,
    relationships: null,
    world: null,
    locks: null,
  },
  targets: { words_per_chapter: [2000, 3000], dialogue_ratio: [0.2, 0.6], dialogue_ratio_metric: 'both' },
  style,
  ...overrides,
})

const codesOf = (text: string, style: StylePack, overrides: Partial<MachineOptions> = {}): Set<string> =>
  new Set(runMachineChecks(text, options(style, overrides)).violations.map((violation) => violation.code))

const severityOf = (text: string, style: StylePack, code: string): string | undefined =>
  runMachineChecks(text, options(style)).violations.find((violation) => violation.code === code)?.severity

/** A sentence of exactly `length` CJK characters (the terminator is stripped). */
const sentence = (length: number, body = '雨'): string => `${body.repeat(length)}。`

/** `count` sentences of one length inside one paragraph. */
const run = (length: number, count: number): string =>
  Array.from({ length: count }, () => sentence(length)).join('')

/** Neutral prose that matches cold-suspense's targets closely enough to be quiet. */
const mixedProse = (): string =>
  [
    run(8, 2) + run(20, 3) + run(40, 1),
    run(9, 2) + run(22, 2) + run(36, 1),
    run(7, 2) + run(18, 2) + run(34, 1),
    run(10, 2) + run(24, 2) + run(38, 1),
  ].join('\n\n')

describe('0.2.17 style metrics', () => {
  const vocabulary = styleVocabulary(rulepack)
  const metrics = (text: string, pack = cold) => measureStyle(text, pack, vocabulary)

  it('buckets sentences at the documented 12/32 boundaries (附录 C-17)', () => {
    const text = [
      sentence(SHORT_SENTENCE_MAX),
      sentence(SHORT_SENTENCE_MAX + 1),
      sentence(LONG_SENTENCE_MIN - 1),
      sentence(LONG_SENTENCE_MIN),
    ].join('')
    const measured = metrics(text)
    expect(measured.sentence.total).toBe(4)
    expect(measured.sentence.short).toBe(1)
    expect(measured.sentence.medium).toBe(2)
    expect(measured.sentence.long).toBe(1)
    expect(measured.sentence.short_ratio).toBe(0.25)
  })

  it('computes burstiness as std/mean and returns 0 for a flat text (附录 C-18)', () => {
    expect(metrics(run(10, 8)).sentence.cv).toBe(0)
    const varied = metrics([sentence(4), sentence(20), sentence(40), sentence(6)].join(''))
    expect(varied.sentence.cv).toBeGreaterThan(0.5)
    expect(metrics('')).toMatchObject({ sentence: { total: 0, cv: 0 } })
  })

  it('tracks the longest run of same-length sentences', () => {
    expect(metrics(run(10, 5) + sentence(40)).sentence.longest_run).toBe(5)
    expect(metrics(sentence(10) + sentence(40) + sentence(10)).sentence.longest_run).toBe(1)
  })

  it('measures paragraph width and sentence count', () => {
    const measured = metrics([run(20, 5), run(20, 2)].join('\n\n'))
    expect(measured.paragraph.count).toBe(2)
    expect(measured.paragraph.max_sentences).toBe(5)
    expect(measured.paragraph.mean_sentences).toBe(3.5)
    // 5 sentences of 20 chars plus their five terminators: punctuation counts,
    // exactly as it does in the word count.
    expect(measured.paragraph.max_chars).toBe(105)
  })

  it('reports both dialogue readings so target and range speak one language (C6)', () => {
    const text = ['“你一个人住？”警察问。', '“嗯。”', '他把门关上，退到墙角，听着楼道里的脚步。'].join('\n')
    const measured = metrics(text)
    expect(measured.dialogue.line_ratio).toBeCloseTo(2 / 3, 3)
    expect(measured.dialogue.char_ratio).toBeGreaterThan(0)
    expect(measured.dialogue.char_ratio).toBeLessThan(1)
  })

  it('normalises the three densities per 1000 non-whitespace characters (附录 C-19/20/22)', () => {
    // 1000 non-ws chars: 989 filler + 8 emotion terms + 3 metaphor markers.
    const base = '雨'.repeat(1000 - 8 - 3)
    const text = `${base}悲伤愤怒恐惧孤独像如同`
    const measured = metrics(text)
    expect(measured.diction.abstract_emotion_per_1000).toBe(4)
    expect(measured.diction.metaphor_per_1000).toBe(2)
    expect(measured.emotion.cues_per_1000).toBe(0)
  })

  it('measures the cool-point gap as the longest stretch between hits (附录 C-21)', () => {
    const gapText = `${'雨'.repeat(100)}震惊${'雨'.repeat(300)}打脸${'雨'.repeat(50)}`
    const measured = metrics(gapText)
    // The longest gap is the 300 chars between the two hits, not the 100 before
    // the first one: only the space *between* adjacent hits counts.
    expect(measured.structure.longest_cool_gap_chars).toBe(300)
    // No hit at all means the whole chapter is one gap.
    expect(metrics('雨'.repeat(500)).structure.longest_cool_gap_chars).toBe(500)
  })

  it('counts banned patterns, including the bounded template (C2)', () => {
    const text = '他不是没钱，而是不想给。他眸中一暗，缓缓起身。'
    const measured = metrics(text)
    expect(measured.banned.hits).toBe(3)
    expect(measured.banned.by_pattern['不是……而是……']).toBe(1)
    expect(measured.banned.by_pattern['眸中']).toBe(1)
  })

  it('records which sensory channels the chapter actually uses', () => {
    const measured = metrics('他听见楼道里有响动，指尖发冷。')
    expect(measured.diction.sensory_channels_hit).toEqual(expect.arrayContaining(['sound', 'cold', 'touch']))
  })
})

describe('0.2.17 style rules', () => {
  it('stays completely silent for a project without a style', () => {
    // A text that trips several style rules when a pack is bound.
    const text = run(8, 12) + '他眸中一暗，缓缓起身。'
    const withStyle = codesOf(text, cold)
    expect([...withStyle].some((code) => code.startsWith('STYLE_'))).toBe(true)
    const without = new Set(
      runMachineChecks(text, options(cold, { style: undefined })).violations.map((v) => v.code),
    )
    for (const code of Object.values(STYLE_RULES)) expect(without.has(code)).toBe(false)
  })

  it('STYLE_BANNED_PATTERN is advisory at the tolerance and blocker beyond it (C4)', () => {
    const one = '雨'.repeat(300) + '他眸中一暗。'
    expect(severityOf(one, cold, STYLE_RULES.BANNED_PATTERN)).toBe('advisory')
    const two = '雨'.repeat(300) + '他眸中一暗，缓缓起身。'
    expect(severityOf(two, cold, STYLE_RULES.BANNED_PATTERN)).toBe('blocker')
    expect(codesOf('雨'.repeat(300), cold).has(STYLE_RULES.BANNED_PATTERN)).toBe(false)
  })

  it('STYLE_SENTENCE_MIX reports a bucket that drifted past the tolerance', () => {
    // Every sentence short: short_ratio 1.0 against a 0.30 target.
    expect(codesOf(run(8, 12), cold).has(STYLE_RULES.SENTENCE_MIX)).toBe(true)
    expect(codesOf(mixedProse(), cold).has(STYLE_RULES.SENTENCE_MIX)).toBe(false)
  })

  it('STYLE_BURSTINESS reports flat rhythm and long same-bucket runs', () => {
    const flat = run(20, 10)
    expect(codesOf(flat, cold).has(STYLE_RULES.BURSTINESS)).toBe(true)
    // Same length bucket (medium) nine times in a row, with variation inside it.
    const longRun = [sentence(14), sentence(16), sentence(18), sentence(20), sentence(22), sentence(24)].join(
      '',
    )
    expect(codesOf(longRun, cold).has(STYLE_RULES.BURSTINESS)).toBe(true)
  })

  it('STYLE_PARAGRAPH_CHARS only speaks when the pack is stricter than the global limit (C5)', () => {
    // cold-suspense allows 110 chars, the global blocker owns 90 — so it defers.
    const wide = run(60, 2)
    expect(codesOf(wide, cold).has(STYLE_RULES.PARAGRAPH_CHARS)).toBe(false)
    // infinite-flow allows 80, which is stricter than 90.
    expect(codesOf(wide, infinite).has(STYLE_RULES.PARAGRAPH_CHARS)).toBe(true)
  })

  it('STYLE_PARAGRAPH_SENTENCES reports a paragraph over the pack limit', () => {
    expect(codesOf(run(10, 5), cold).has(STYLE_RULES.PARAGRAPH_SENTENCES)).toBe(true)
    expect(codesOf(run(10, 3), cold).has(STYLE_RULES.PARAGRAPH_SENTENCES)).toBe(false)
  })

  it('STYLE_DIALOGUE_RATIO judges distance from the target, not the project range (C6)', () => {
    const narration = run(20, 20)
    expect(codesOf(narration, cold).has(STYLE_RULES.DIALOGUE_RATIO)).toBe(true)
    // Within the project range [0.2, 0.6] but far from the 0.25 target.
    const halfDialogue = [
      '“你一个人住？”警察问。',
      '他把门关上，退到墙角，听着楼道里的脚步，没有出声，也没有回头。',
    ].join('\n')
    const codes = codesOf(halfDialogue, cold)
    expect(codes.has('DIALOGUE_RATIO')).toBe(false)
    expect(codes.has(STYLE_RULES.DIALOGUE_RATIO)).toBe(true)
  })

  it('STYLE_ABSTRACT_EMOTION reports over the per-1000 ceiling', () => {
    const base = '雨'.repeat(980)
    expect(codesOf(`${base}悲伤愤怒恐惧孤独`, cold).has(STYLE_RULES.ABSTRACT_EMOTION)).toBe(true)
    expect(codesOf(`${base}悲伤`, cold).has(STYLE_RULES.ABSTRACT_EMOTION)).toBe(false)
  })

  it('STYLE_METAPHOR_DENSITY reports over the per-1000 ceiling', () => {
    const base = '雨'.repeat(980)
    expect(codesOf(`${base}像如同仿佛宛如好似`, cold).has(STYLE_RULES.METAPHOR_DENSITY)).toBe(true)
    expect(codesOf(`${base}像`, cold).has(STYLE_RULES.METAPHOR_DENSITY)).toBe(false)
  })

  it('STYLE_COOL_POINT_GAP allows the documented 1.5x stretch (附录 C-28)', () => {
    // cold-suspense: 1000 × 1.5 = 1500 allowed.
    expect(codesOf('雨'.repeat(1400), cold).has(STYLE_RULES.COOL_POINT_GAP)).toBe(false)
    expect(codesOf('雨'.repeat(1600), cold).has(STYLE_RULES.COOL_POINT_GAP)).toBe(true)
  })

  it('STYLE_EMOTION_CUES stays quiet on chapters too short to carry a per-1000 floor', () => {
    expect(codesOf('雨'.repeat(400), cold).has(STYLE_RULES.EMOTION_CUES)).toBe(false)
    expect(codesOf('雨'.repeat(1200), cold).has(STYLE_RULES.EMOTION_CUES)).toBe(true)
  })

  it('attaches measured style metrics to the machine result', () => {
    const result = runMachineChecks(mixedProse(), options(cold))
    expect(result.style).toMatchObject({ version: 1, style_id: 'cold-suspense' })
    const plain = runMachineChecks(mixedProse(), options(cold, { style: undefined }))
    expect(plain.style).toBeUndefined()
  })

  it('never lets a style pack waive a global blocker (T-16)', () => {
    // A pack cannot rescue a chapter that breaks a zero-tolerance word.
    const text = '雨'.repeat(300) + '总而言之，他不禁笑了。'
    const codes = codesOf(text, cold)
    expect(codes.has('LEX_ZERO_TOLERANCE')).toBe(true)
  })
})
