import { describe, expect, it } from 'vitest'
import {
  STYLE_GENRE_ALIASES,
  StylePackError,
  compileStyleCatalogue,
  compileStylePack,
  isTemplatePattern,
  stylePatternToRegExp,
  styleTolerances,
} from '../src/rules/style.js'
import { dialogueRatioFor, measureStyle, styleVocabulary, SHORT_SENTENCE_MAX } from '../src/domain/style.js'
import { collectToneHits, compileToneMatcher, evaluateTone, quoteSpans } from '../src/rules/ai-tone.js'
import { compileRulepack, DEFAULT_RULEPACK } from '../src/rules/compiler.js'
import { runMachineChecks } from '../src/rules/pipeline.js'
import { evidenceOccurrences, matchEvidence, paragraphAtOffset, paragraphSpans } from '../src/domain/text.js'
import { countWordMetrics } from '../src/domain/wordcount.js'
import type { MachineOptions } from '../src/rules/pipeline.js'
import type { AiToneBlock, StylePack } from '../src/rules/types.js'
import { loadRulepack } from '../src/rulepack.js'
import { harness } from './helpers.js'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Edge and defensive paths for the 0.2.17 additions.
 *
 * Every case here is a shape the code must survive — a malformed pack, an empty
 * chapter, a missing threshold. They are grouped separately from the behaviour
 * suites so a failure says "a guard broke", not "a rule changed".
 */

const rulepack = loadRulepack()

const basePack = (): Record<string, unknown> => ({
  schema_version: 1,
  id: 'base-pack',
  name: '基准包',
  description: '用于边界用例的最小合法风格包。',
  audience: 'general',
  genres: ['mystery'],
  pov: 'third-limited',
  tense: 'past',
  register: 'restrained',
  narrative_distance: 'close',
  sentence: {
    short_ratio: 0.3,
    medium_ratio: 0.45,
    long_ratio: 0.25,
    burstiness: 'high',
    max_consecutive_same_length: 4,
  },
  paragraph: { max_chars: 110, one_action_per_paragraph: true, max_sentences: 4, max_actions: 3 },
  dialogue: { ratio: 0.25, tag_style: 'sparse', allow_interruptions: true, allow_fragments: true },
  diction: {
    abstract_emotion_density: 'low',
    metaphor_density: 'low',
    adjective_density: 'low',
    slang: 'low',
    idiom: 'low',
    sensory_channels: ['sound'],
  },
  structure: {
    opening_moves: ['anomaly'],
    scene_transition: 'hard_cut',
    hook_moves: ['new_clue'],
    cool_point_every_chars: 1000,
  },
  emotion: {
    intensity: 'medium',
    expression: 'restrained',
    required_beats: ['cost'],
    min_cues_per_1000: 2,
  },
  banned_patterns: ['眸中', '缓缓'],
  exemplars: ['“你一个人住？”警察问。\n“嗯。”女人把门开了一条缝，“有事？”\n“昨晚谁开的窗？”\n“我自己。”'],
  critic_rubric: ['克制：少解释情绪。', '线索：关键物件前置。', '对白：短、冷、留白。'],
  thresholds: { burstiness_min: 0.35, banned_patterns_max: 1 },
})

const pack = (): StylePack => compileStylePack(basePack(), { fileId: 'base-pack' }).pack

const problemsOf = (mutate: (value: Record<string, unknown>) => void): string[] => {
  const raw = basePack()
  mutate(raw)
  try {
    compileStylePack(raw, { fileId: 'base-pack' })
    return []
  } catch (error) {
    if (error instanceof StylePackError) return error.problems.map((problem) => problem.path)
    throw error
  }
}

describe('0.2.17 style pack guards', () => {
  it('rejects a non-mapping pack outright', () => {
    expect(() => compileStylePack([], { fileId: 'base-pack' })).toThrow(/must be a mapping/)
  })

  it('reports every wrong type instead of the first one', () => {
    const cases: Array<[string, (value: Record<string, unknown>) => void]> = [
      ['audience', (value) => (value.audience = 3)],
      ['pov', (value) => (value.pov = 'second')],
      ['tense', (value) => (value.tense = 'future')],
      ['register', (value) => (value.register = 'shouty')],
      ['narrative_distance', (value) => (value.narrative_distance = 'far-far')],
      ['sentence', (value) => (value.sentence = 'nope')],
      ['sentence.burstiness', (value) => ((value.sentence as Record<string, unknown>).burstiness = 'max')],
      [
        'sentence.max_consecutive_same_length',
        (value) => ((value.sentence as Record<string, unknown>).max_consecutive_same_length = 99),
      ],
      ['paragraph', (value) => (value.paragraph = [])],
      [
        'paragraph.one_action_per_paragraph',
        (value) => ((value.paragraph as Record<string, unknown>).one_action_per_paragraph = 'yes'),
      ],
      [
        'paragraph.max_sentences',
        (value) => ((value.paragraph as Record<string, unknown>).max_sentences = 0),
      ],
      ['paragraph.max_actions', (value) => ((value.paragraph as Record<string, unknown>).max_actions = 99)],
      ['dialogue', (value) => (value.dialogue = null)],
      ['dialogue.tag_style', (value) => ((value.dialogue as Record<string, unknown>).tag_style = 'loud')],
      [
        'dialogue.allow_interruptions',
        (value) => ((value.dialogue as Record<string, unknown>).allow_interruptions = 1),
      ],
      [
        'dialogue.allow_fragments',
        (value) => ((value.dialogue as Record<string, unknown>).allow_fragments = 0),
      ],
      ['diction', (value) => (value.diction = 'x')],
      [
        'diction.abstract_emotion_density',
        (value) => ((value.diction as Record<string, unknown>).abstract_emotion_density = 'off'),
      ],
      [
        'diction.metaphor_density',
        (value) => ((value.diction as Record<string, unknown>).metaphor_density = 'off'),
      ],
      [
        'diction.adjective_density',
        (value) => ((value.diction as Record<string, unknown>).adjective_density = 'off'),
      ],
      ['diction.slang', (value) => ((value.diction as Record<string, unknown>).slang = 'off')],
      ['diction.idiom', (value) => ((value.diction as Record<string, unknown>).idiom = 'off')],
      [
        'diction.sensory_channels',
        (value) => ((value.diction as Record<string, unknown>).sensory_channels = 'sound'),
      ],
      ['structure', (value) => (value.structure = 1)],
      [
        'structure.opening_moves',
        (value) => ((value.structure as Record<string, unknown>).opening_moves = 'anomaly'),
      ],
      [
        'structure.hook_moves',
        (value) => ((value.structure as Record<string, unknown>).hook_moves = ['nope']),
      ],
      [
        'structure.scene_transition',
        (value) => ((value.structure as Record<string, unknown>).scene_transition = 'fade'),
      ],
      [
        'structure.cool_point_every_chars',
        (value) => ((value.structure as Record<string, unknown>).cool_point_every_chars = 10),
      ],
      ['emotion', (value) => (value.emotion = true)],
      ['emotion.intensity', (value) => ((value.emotion as Record<string, unknown>).intensity = 'max')],
      ['emotion.expression', (value) => ((value.emotion as Record<string, unknown>).expression = 'loud')],
      [
        'emotion.required_beats',
        (value) => ((value.emotion as Record<string, unknown>).required_beats = [1]),
      ],
      [
        'emotion.min_cues_per_1000',
        (value) => ((value.emotion as Record<string, unknown>).min_cues_per_1000 = 99),
      ],
      ['banned_patterns', (value) => (value.banned_patterns = '眸中')],
      ['banned_patterns[0] type', (value) => (value.banned_patterns = [1])],
      ['exemplars', (value) => (value.exemplars = 'x')],
      ['exemplars[0] type', (value) => (value.exemplars = [1])],
      ['exemplars CRLF', (value) => (value.exemplars = [`${'正文'.repeat(20)}\r\n${'正文'.repeat(20)}`])],
      ['critic_rubric', (value) => (value.critic_rubric = 'x')],
      ['critic_rubric[0] type', (value) => (value.critic_rubric = [1, 2, 3])],
      ['thresholds', (value) => (value.thresholds = 'x')],
      [
        'thresholds.burstiness_min',
        (value) => ((value.thresholds as Record<string, unknown>).burstiness_min = 99),
      ],
      [
        'thresholds.dialogue_ratio_min',
        (value) => ((value.thresholds as Record<string, unknown>).dialogue_ratio_min = 2),
      ],
      [
        'thresholds.dialogue_ratio_max',
        (value) => ((value.thresholds as Record<string, unknown>).dialogue_ratio_max = 2),
      ],
      [
        'thresholds.banned_patterns_max',
        (value) => ((value.thresholds as Record<string, unknown>).banned_patterns_max = -1),
      ],
      [
        'thresholds.abstract_emotion_max',
        (value) => ((value.thresholds as Record<string, unknown>).abstract_emotion_max = 0),
      ],
      [
        'thresholds.metaphor_per_1000_max',
        (value) => ((value.thresholds as Record<string, unknown>).metaphor_per_1000_max = 999),
      ],
      [
        'thresholds.sentence_mix_tolerance',
        (value) => ((value.thresholds as Record<string, unknown>).sentence_mix_tolerance = 5),
      ],
      [
        'thresholds.dialogue_target_tolerance',
        (value) => ((value.thresholds as Record<string, unknown>).dialogue_target_tolerance = 5),
      ],
      [
        'thresholds.cool_point_gap_factor',
        (value) => ((value.thresholds as Record<string, unknown>).cool_point_gap_factor = 0.5),
      ],
    ]
    for (const [label, mutate] of cases) expect(problemsOf(mutate), label).not.toHaveLength(0)
  })

  it('rejects a critic line that is too short or too long', () => {
    expect(
      problemsOf((value) => (value.critic_rubric = ['短', '正常的一条规则。', '正常的一条规则。'])),
    ).toContain('critic_rubric[0]')
    expect(
      problemsOf(
        (value) => (value.critic_rubric = ['长'.repeat(61), '正常的一条规则。', '正常的一条规则。']),
      ),
    ).toContain('critic_rubric[0]')
  })

  it('rejects a template with too many gaps and a genre that is not a string', () => {
    expect(problemsOf((value) => (value.banned_patterns = ['……眸中', '缓缓']))).toContain(
      'banned_patterns[0]',
    )
    expect(problemsOf((value) => (value.banned_patterns = ['甲……乙……丙……丁……戊']))).toContain(
      'banned_patterns[0]',
    )
    expect(problemsOf((value) => (value.genres = [1]))).toContain('genres[0]')
  })

  it('deduplicates a genre that maps to the same engine value', () => {
    const result = compileStylePack(
      { ...basePack(), genres: ['mystery', 'suspense'] },
      { fileId: 'base-pack' },
    )
    expect(result.pack.genres).toEqual(['悬疑推理'])
  })

  it('accepts a Chinese genre tag directly', () => {
    const result = compileStylePack({ ...basePack(), genres: ['无限流'] }, { fileId: 'base-pack' })
    expect(result.pack.genres).toEqual(['无限流'])
    expect(STYLE_GENRE_ALIASES['infinite-flow']).toBe('无限流')
  })

  it('exposes the template helpers without leaking state', () => {
    expect(isTemplatePattern('眸中')).toBe(false)
    const regexp = stylePatternToRegExp('不是……而是……')
    expect(regexp.source).toContain('[\\s\\S]{0,12}')
    // Two calls must not share `lastIndex`.
    expect(regexp.test('不是甲而是乙')).toBe(true)
  })

  it('returns an empty catalogue for an empty input', () => {
    const { packs, warnings } = compileStyleCatalogue([])
    expect(packs).toEqual([])
    expect(warnings).toEqual([])
  })
})

describe('0.2.17 style metrics edges', () => {
  const vocabulary = styleVocabulary(rulepack)
  const metrics = (text: string, target = pack()) => measureStyle(text, target, vocabulary)

  it('handles empty and whitespace-only text', () => {
    const empty = metrics('')
    expect(empty.sentence.total).toBe(0)
    expect(empty.paragraph.count).toBe(0)
    expect(empty.dialogue.line_ratio).toBe(0)
    expect(empty.diction.abstract_emotion_per_1000).toBe(0)
    expect(empty.structure.longest_cool_gap_chars).toBe(0)
    expect(metrics('   \n\n  ').sentence.total).toBe(0)
  })

  it('returns 0 for a zero denominator rather than Infinity', () => {
    const onlySpaces = measureStyle('　　', pack(), vocabulary)
    expect(onlySpaces.diction.adjective_per_100).toBe(0)
    expect(onlySpaces.dialogue.char_ratio).toBe(0)
  })

  it('resolves all three dialogue metrics from the same measurement', () => {
    const measured = metrics('“你来了。”他点头。')
    const both = dialogueRatioFor(measured, 'both')
    expect(both.used).toBe(Math.max(both.lines, both.chars))
    expect(dialogueRatioFor(measured, 'lines').used).toBe(measured.dialogue.line_ratio)
    expect(dialogueRatioFor(measured, 'chars').used).toBe(measured.dialogue.char_ratio)
  })

  it('treats a single short sentence as a run of one', () => {
    const measured = metrics('雨。')
    expect(measured.sentence.total).toBe(1)
    expect(measured.sentence.longest_run).toBe(1)
    expect(measured.sentence.short).toBe(1)
    expect(SHORT_SENTENCE_MAX).toBe(12)
  })

  it('counts an unclosed quote as narration, not dialogue', () => {
    expect(quoteSpans('他说：“你来了。').every((span) => span.kind === 'narration')).toBe(true)
    expect(quoteSpans('没有引号。')).toEqual([{ start: 0, end: 5, kind: 'narration' }])
  })

  it('builds an empty vocabulary when the rulepack has no style blocks', () => {
    const bare = compileRulepack({
      ...(structuredClone(DEFAULT_RULEPACK) as unknown as Record<string, unknown>),
    })
    const vocab = styleVocabulary(bare)
    expect(vocab.abstractEmotion).toEqual([])
    expect(vocab.metaphor).toEqual([])
    expect(vocab.emotionCues).toEqual([])
  })

  it('falls back to the documented tolerances when a pack omits them', () => {
    expect(styleTolerances(pack())).toEqual({
      sentenceMix: 0.15,
      dialogueTarget: 0.15,
      coolPointGapFactor: 1.5,
    })
  })
})

describe('0.2.17 style rule guards', () => {
  const options = (
    style: StylePack | undefined,
    overrides: Partial<MachineOptions> = {},
  ): MachineOptions => ({
    chapter: 1,
    title: '第1章 雨',
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
    ...(style === undefined ? {} : { style }),
    ...overrides,
  })

  it('stays silent when a pack omits every optional threshold', () => {
    const bare = compileStylePack({ ...basePack(), thresholds: {} }, { fileId: 'base-pack' }).pack
    const codes = runMachineChecks('雨'.repeat(2000), options(bare)).violations.map((row) => row.code)
    // No burstiness floor, no emotion floor, no density ceilings: the rules that
    // need one stay quiet instead of inventing a default.
    expect(codes).not.toContain('STYLE_BURSTINESS')
    expect(codes).not.toContain('STYLE_ABSTRACT_EMOTION')
    expect(codes).not.toContain('STYLE_METAPHOR_DENSITY')
  })

  it('skips rules that need sentences when the chapter has none', () => {
    const codes = runMachineChecks('', options(pack())).violations.map((row) => row.code)
    expect(codes.filter((code) => code.startsWith('STYLE_'))).toEqual([])
  })

  it('treats a short chapter as unable to carry a per-1000 floor', () => {
    const codes = runMachineChecks('雨。'.repeat(50), options(pack())).violations.map((row) => row.code)
    expect(codes).not.toContain('STYLE_EMOTION_CUES')
  })

  it('lets a style rule run through runRules for an explicit subset', () => {
    const codes = runMachineChecks('他眸中一暗。', options(pack())).violations.map((row) => row.code)
    expect(codes).toContain('STYLE_BANNED_PATTERN')
  })
})

describe('0.2.17 AI-tone guards', () => {
  const block = rulepack.lexicon.ai_tone!

  it('returns nothing for an empty block and empty text', () => {
    const empty: AiToneBlock = { version: 1, categories: {}, entries: [] }
    expect(collectToneHits('这句话稳。', empty)).toEqual([])
    expect(collectToneHits('', block)).toEqual([])
    expect(evaluateTone('', block)).toEqual([])
  })

  it('skips an entry whose category is not declared', () => {
    const orphan: AiToneBlock = {
      version: 1,
      categories: {},
      entries: [{ ...block.entries[0]!, category: 'missing' }],
    }
    expect(collectToneHits('这句话稳。', orphan)).toEqual([])
  })

  it('compiles all three matcher shapes', () => {
    const exact = compileToneMatcher({
      id: 'x',
      category: 'c',
      match: 'exact',
      terms: ['甲', '乙'],
      severity: 'advisory',
      scope: 'any',
    })
    expect(exact.test('乙')).toBe(true)
    const regex = compileToneMatcher({
      id: 'x',
      category: 'c',
      match: 'regex',
      pattern: '甲.',
      severity: 'advisory',
      scope: 'any',
    })
    expect(regex.test('甲乙')).toBe(true)
    const template = compileToneMatcher({
      id: 'x',
      category: 'c',
      match: 'template',
      template: '甲{xx}乙',
      severity: 'advisory',
      scope: 'any',
    })
    expect(template.test('甲丙丁乙')).toBe(true)
  })

  it('scopes an entry to narration or dialogue explicitly', () => {
    const narrationOnly: AiToneBlock = {
      version: 1,
      categories: {
        c: {
          code: 'AI_TONE_META',
          default_severity: 'advisory',
          default_scope: 'narration',
          limit: 1,
          window: 1000,
          escalation: 'none',
        },
      },
      entries: [
        {
          id: 'n1',
          category: 'c',
          match: 'exact',
          terms: ['这句话稳'],
          severity: 'advisory',
          scope: 'narration',
        },
      ],
    }
    expect(collectToneHits('这句话稳。', narrationOnly)).toHaveLength(1)
    expect(collectToneHits('“这句话稳。”', narrationOnly)).toHaveLength(0)
    const dialogueOnly: AiToneBlock = {
      ...narrationOnly,
      entries: [{ ...narrationOnly.entries[0]!, id: 'd1', scope: 'dialogue' }],
    }
    expect(collectToneHits('“这句话稳。”', dialogueOnly)).toHaveLength(1)
    expect(collectToneHits('这句话稳。', dialogueOnly)).toHaveLength(0)
  })

  it('does not escalate when the category says none', () => {
    const noEscalation: AiToneBlock = {
      version: 1,
      categories: {
        c: {
          code: 'AI_TONE_ACK',
          default_severity: 'advisory',
          default_scope: 'any',
          limit: 1,
          window: 1000,
          escalation: 'none',
        },
      },
      entries: [
        { id: 'a1', category: 'c', match: 'exact', terms: ['我记下了'], severity: 'advisory', scope: 'any' },
      ],
    }
    const hits = evaluateTone('我记下了。我记下了。我记下了。', noEscalation)
    expect(hits.every((hit) => hit.severity === 'advisory')).toBe(true)
  })

  it('escalates a hit whose entry overrides the category window', () => {
    const overridden: AiToneBlock = {
      version: 1,
      categories: {
        c: {
          code: 'AI_TONE_ACK',
          default_severity: 'advisory',
          default_scope: 'any',
          limit: 99,
          window: 5000,
          escalation: 'one_level',
        },
      },
      entries: [
        {
          id: 'a1',
          category: 'c',
          match: 'exact',
          terms: ['我记下了'],
          severity: 'advisory',
          scope: 'any',
          limit: 1,
          window: 100,
        },
      ],
    }
    const hits = evaluateTone('我记下了。我记下了。', overridden)
    expect(hits.every((hit) => hit.severity === 'blocker')).toBe(true)
  })

  it('stops counting a window at the first hit outside it', () => {
    // Two hits inside the window and one far beyond: the inner loop must break
    // on the far hit rather than counting it.
    const spaced: AiToneBlock = {
      version: 1,
      categories: {
        c: {
          code: 'AI_TONE_ACK',
          default_severity: 'advisory',
          default_scope: 'any',
          limit: 1,
          window: 20,
          escalation: 'one_level',
        },
      },
      entries: [
        { id: 's1', category: 'c', match: 'exact', terms: ['我记下了'], severity: 'advisory', scope: 'any' },
      ],
    }
    const text = `我记下了。我记下了。${'雨'.repeat(200)}我记下了。`
    const hits = evaluateTone(text, spaced)
    expect(hits).toHaveLength(3)
    // The first two crowd each other; the third is outside every window.
    expect(hits[0]!.severity).toBe('blocker')
    expect(hits[1]!.severity).toBe('blocker')
    expect(hits[2]!.severity).toBe('advisory')
  })

  it('handles a zero-length matcher without looping forever', () => {
    const zero: AiToneBlock = {
      version: 1,
      categories: {
        c: {
          code: 'AI_TONE_META',
          default_severity: 'advisory',
          default_scope: 'any',
          limit: 1,
          window: 1000,
          escalation: 'none',
        },
      },
      entries: [
        { id: 'z', category: 'c', match: 'regex', pattern: '(?:)', severity: 'advisory', scope: 'any' },
      ],
    }
    expect(collectToneHits('雨。', zero)).toEqual([])
  })
})

describe('0.2.17 remaining guards', () => {
  it('normalises an ellipsis run and a literal three-dot run without splitting them', () => {
    // `……` and `...` both normalise to one marker, and neither may be mistaken
    // for a sentence terminator: PG-09 quotes across them must still match.
    const ellipsis = matchEvidence('他说完就走了……没有回头。', '说完就走了……没有')
    expect(ellipsis).not.toBeNull()
    // The manuscript uses ASCII dots while the quote uses ……, so the literal
    // lookup fails and the folding path runs — that is the branch under test.
    const dots = matchEvidence('他说完就走了...没有回头。', '说完就走了……没有')
    expect(dots).not.toBeNull()
    // A lone period stays a period, not an ellipsis.
    expect(matchEvidence('第 3.5 节讲这个。', '3.5')).not.toBeNull()
    // One text carrying both a …… run and a single period, with ASCII quotes in
    // the quote so the folding path (not the literal one) is what matches.
    const mixed = matchEvidence('他说：“走了……三.五米。”', '他说:"走了……三.五米。"')
    expect(mixed).not.toBeNull()
    // An empty quote never matches and never throws.
    expect(matchEvidence('正文。', '   ')).toMatchObject({ found: false })
    expect(evidenceOccurrences('正文。', '   ')).toEqual([])
    // A quote that folds away entirely is not a match either.
    expect(evidenceOccurrences('正文。', '“”')).toEqual([])
    // An ellipsis that runs to the very end of the manuscript still folds.
    expect(matchEvidence('他走了……', '走了...')).not.toBeNull()
    // A lone … is not a run: it folds to one marker and advances by one.
    expect(matchEvidence('他走了…回头。', '走了...回头')).not.toBeNull()
    // Whitespace-only quote: rejected before any normalisation.
    expect(evidenceOccurrences('正文。', '　')).toEqual([])
  })

  it('clamps a paragraph offset past the end and survives an empty document', () => {
    const spans = paragraphSpans('第一段。\n\n第二段。')
    expect(paragraphAtOffset(spans, 0)).toBe(1)
    expect(paragraphAtOffset(spans, 999)).toBe(spans.length)
    expect(paragraphAtOffset([], 0)).toBe(1)
  })

  it('handles a quote that opens but never closes in the word metrics', () => {
    const metrics = countWordMetrics('“没有收尾的引号')
    expect(metrics.dialogue_chars).toBeGreaterThanOrEqual(0)
    expect(metrics.dialogue_char_ratio).toBeGreaterThanOrEqual(0)
  })

  it('returns an empty vocabulary when a pack carries only some blocks', () => {
    const partial = {
      semantics: {
        adjective_density: { adjectives: [] },
        sensory_density: { senses: [] },
        pleasure_density: { keywords: [] },
      },
    }
    expect(styleVocabulary(partial)).toEqual({
      abstractEmotion: [],
      metaphor: [],
      emotionCues: [],
      pleasure: [],
      adjectives: [],
      senses: [],
    })
  })

  it('ignores an empty term list without dividing by zero', () => {
    const empty = compileStylePack({ ...basePack(), banned_patterns: ['眸中'] }, { fileId: 'base-pack' }).pack
    const metrics = measureStyle('雨。', empty, {
      abstractEmotion: [],
      metaphor: [],
      emotionCues: [],
      pleasure: [],
      adjectives: [],
      senses: [],
    })
    expect(metrics.diction.abstract_emotion_per_1000).toBe(0)
    expect(metrics.banned.hits).toBe(0)
    // An empty term in a list is ignored rather than counted once per character.
    const withEmpty = measureStyle('雨。', empty, {
      abstractEmotion: [''],
      metaphor: [],
      emotionCues: [],
      pleasure: [''],
      adjectives: [],
      senses: [],
    })
    expect(withEmpty.diction.abstract_emotion_per_1000).toBe(0)
    expect(withEmpty.structure.longest_cool_gap_chars).toBe(2)
  })
})

describe('0.2.17 STYLE_UNKNOWN', () => {
  it('warns on status and report but never blocks reading', async () => {
    const h = await harness()
    try {
      await h.engine.initProject({
        title: '手改之书',
        genre: '都市现代',
        platform: 'fanqie',
        style: 'cold-suspense',
        root: h.root,
      })
      // A hand-edited novel.yaml names a pack that no longer exists. Writing the
      // file directly is the only way to reach this state: `novel_amend` refuses
      // to change an already-set style.
      const path = join(h.root, 'novel.yaml')
      const text = await readFile(path, 'utf8')
      await writeFile(path, text.replace('style: cold-suspense', 'style: vanished-pack'), 'utf8')
      const status = await h.engine.getStatus({ root: h.root })
      // The status warnings live on the report, not on the OpResult envelope.
      expect((status.data.warnings ?? []).map((warning) => warning.code)).toContain('STYLE_UNKNOWN')
      expect(status.data.style).toBeNull()
      const report = await h.engine.report({ root: h.root })
      expect(report.data.warnings.some((line) => line.includes('vanished-pack'))).toBe(true)
      // The doctor names it too.
      const doctor = await h.engine.doctor({ root: h.root })
      expect(doctor.data.checks.find((check) => check.id === 'style-pack')?.severity).toBe('warning')
    } finally {
      await h.cleanup()
    }
  })
})
