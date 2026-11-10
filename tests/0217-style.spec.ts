import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'
import {
  STYLE_GENRE_ALIASES,
  StylePackError,
  compileStyleCatalogue,
  compileStylePack,
  isTemplatePattern,
  stylePatternToRegExp,
  styleTolerances,
} from '../src/rules/style.js'
import type { StylePack } from '../src/rules/types.js'
import {
  loadStyleCatalogue,
  loadStyleIndex,
  resetStylePackCache,
  stylePackById,
  stylePackMap,
  stylePackSummaries,
} from '../src/stylepack.js'
import { loadRulepack } from '../src/rulepack.js'
import { EngineService } from '../src/engine/service.js'

/** A minimal pack that passes every assertion; each case mutates one field. */
const basePack = (): Record<string, unknown> => ({
  schema_version: 1,
  id: 'base-pack',
  name: '基准包',
  description: '用于坏包矩阵的最小合法风格包。',
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
    sensory_channels: ['sound', 'cold'],
  },
  structure: {
    opening_moves: ['anomaly', 'object'],
    scene_transition: 'hard_cut',
    hook_moves: ['unresolved_question', 'new_clue'],
    cool_point_every_chars: 1000,
  },
  emotion: {
    intensity: 'medium',
    expression: 'restrained',
    required_beats: ['body_reaction', 'cost'],
    min_cues_per_1000: 2,
  },
  banned_patterns: ['不是……而是……', '眸中', '缓缓'],
  exemplars: [
    '“你一个人住？”警察问。\n“嗯。”女人把门开了一条缝，“有事？”\n“昨晚谁开的窗？”\n“我自己。”\n女人沉默了两秒：“可能我记错了。”',
  ],
  critic_rubric: ['克制：少解释情绪，用身体反应代替。', '线索：关键物件要前置。', '对白：短、冷、留白。'],
  thresholds: { burstiness_min: 0.35, banned_patterns_max: 1, abstract_emotion_max: 3 },
})

const compile = (raw: unknown, fileId = 'base-pack', zeroTolerance?: string[]): StylePack =>
  compileStylePack(raw, { fileId, ...(zeroTolerance === undefined ? {} : { zeroTolerance }) }).pack

const problemsOf = (raw: unknown, fileId = 'base-pack'): string[] => {
  try {
    compileStylePack(raw, { fileId })
    return []
  } catch (error) {
    if (error instanceof StylePackError) return error.problems.map((problem) => problem.path)
    throw error
  }
}

describe('0.2.17 style pack compiler', () => {
  it('compiles every bundled pack and keeps the index as the source of truth', () => {
    resetStylePackCache()
    const ids = loadStyleIndex()
    expect(ids).toHaveLength(8)
    const { packs } = loadStyleCatalogue()
    expect(packs.map((pack) => pack.id).sort()).toEqual([...ids].sort())
    // Sorted by id so output and ETags stay stable across runs.
    expect(packs.map((pack) => pack.id)).toEqual([...packs.map((pack) => pack.id)].sort())
    for (const pack of packs) {
      expect(pack.genres.length).toBeGreaterThan(0)
      expect(pack.banned_patterns.length).toBeGreaterThan(0)
      expect(pack.thresholds.banned_patterns_max).toBeGreaterThanOrEqual(0)
    }
  })

  it('summarises the catalogue in index order for the tool description', () => {
    resetStylePackCache()
    const summaries = stylePackSummaries()
    expect(summaries.map((entry) => entry.id)).toEqual(loadStyleIndex())
    for (const entry of summaries) {
      expect(entry.name).not.toBe('')
      expect(entry.genres).not.toBe('')
      expect(entry.description).not.toBe('')
    }
  })

  it('resolves a bundled pack by id and returns null for an unknown one', () => {
    resetStylePackCache()
    expect(stylePackById('cold-suspense')?.name).toBe('冷峻悬疑')
    // A hand-edited novel.yaml can name anything; that must not throw.
    expect(stylePackById('does-not-exist')).toBeNull()
  })

  it('rejects every malformed shape with a path, not a crash', () => {
    const cases: Array<[string, (pack: Record<string, unknown>) => void, string]> = [
      ['schema_version', (pack) => (pack.schema_version = 2), 'schema_version'],
      ['id shape', (pack) => (pack.id = 'Bad_ID'), 'id'],
      ['id mismatch', (pack) => (pack.id = 'other-pack'), 'id'],
      ['empty name', (pack) => (pack.name = '  '), 'name'],
      ['long description', (pack) => (pack.description = '长'.repeat(81)), 'description'],
      ['ratio sum', (pack) => ((pack.sentence as Record<string, number>).long_ratio = 0.5), 'sentence'],
      [
        'ratio range',
        (pack) => ((pack.sentence as Record<string, number>).short_ratio = 1.5),
        'sentence.short_ratio',
      ],
      [
        'paragraph max',
        (pack) => ((pack.paragraph as Record<string, number>).max_chars = 10),
        'paragraph.max_chars',
      ],
      ['dialogue ratio', (pack) => ((pack.dialogue as Record<string, number>).ratio = 2), 'dialogue.ratio'],
      ['unknown genre', (pack) => (pack.genres = ['steampunk']), 'genres[0]'],
      ['banned count', (pack) => (pack.banned_patterns = []), 'banned_patterns'],
      ['banned short', (pack) => (pack.banned_patterns = ['叮']), 'banned_patterns[0]'],
      ['banned duplicate', (pack) => (pack.banned_patterns = ['眸中', '眸中']), 'banned_patterns[1]'],
      ['leading template', (pack) => (pack.banned_patterns = ['……而是……']), 'banned_patterns[0]'],
      ['exemplar marker', (pack) => (pack.exemplars = [`# 标题\n${'正文'.repeat(30)}`]), 'exemplars[0]'],
      ['exemplar length', (pack) => (pack.exemplars = ['太短了']), 'exemplars[0]'],
      ['rubric count', (pack) => (pack.critic_rubric = ['只有一条规则']), 'critic_rubric'],
      [
        'sensory enum',
        (pack) => ((pack.diction as Record<string, unknown>).sensory_channels = ['x-ray']),
        'diction.sensory_channels[0]',
      ],
      [
        'beat enum',
        (pack) => ((pack.emotion as Record<string, unknown>).required_beats = ['nope']),
        'emotion.required_beats[0]',
      ],
      [
        'threshold order',
        (pack) =>
          Object.assign(pack.thresholds as Record<string, number>, {
            dialogue_ratio_min: 0.9,
            dialogue_ratio_max: 0.6,
          }),
        'thresholds',
      ],
    ]
    for (const [label, mutate, path] of cases) {
      const raw = basePack()
      mutate(raw)
      expect(problemsOf(raw), label).toContain(path)
    }
  })

  it('rejects a duplicate id or name across the catalogue', () => {
    const first = basePack()
    const second = { ...basePack(), id: 'second-pack' }
    expect(() =>
      compileStyleCatalogue([
        { fileId: 'base-pack', raw: first },
        { fileId: 'base-pack', raw: { ...second, id: 'base-pack' } },
      ]),
    ).toThrow(StylePackError)
    expect(() =>
      compileStyleCatalogue([
        { fileId: 'base-pack', raw: first },
        { fileId: 'second-pack', raw: second },
      ]),
    ).toThrow(StylePackError)
  })

  it('normalises English genre tags to the engine enum (C1)', () => {
    const pack = compile({ ...basePack(), genres: ['mystery', 'suspense', 'urban'] })
    expect(pack.genres).toEqual(['悬疑推理', '都市现代'])
    // The author-facing tags survive so `/novel style show` can echo them.
    expect(pack.genre_tags).toEqual(['mystery', 'suspense', 'urban'])
    expect(STYLE_GENRE_ALIASES.mystery).toBe('悬疑推理')
  })

  it('turns 不是……而是…… into a bounded template (C2)', () => {
    const pattern = '不是……而是……'
    expect(isTemplatePattern(pattern)).toBe(true)
    const regexp = stylePatternToRegExp(pattern)
    expect(regexp.test('他不是没钱，而是不想给')).toBe(true)
    expect(regexp.test('他不是没钱')).toBe(false)
    // A literal entry stays literal.
    expect(isTemplatePattern('眸中')).toBe(false)
  })

  it('removes a zero-tolerance word from the style side (C3)', () => {
    const { pack, warnings } = compileStylePack(
      { ...basePack(), banned_patterns: ['眸中', '缓缓'] },
      {
        fileId: 'base-pack',
        zeroTolerance: ['缓缓'],
      },
    )
    expect(pack.banned_patterns).toEqual(['眸中'])
    expect(warnings.map((warning) => warning.code)).toEqual(['STYLE_BANNED_OVERLAP'])
    expect(warnings[0]?.message).toContain('缓缓')
  })

  it('resolves the three tolerances to their documented defaults (附录 C)', () => {
    const pack = compile(basePack())
    expect(styleTolerances(pack)).toEqual({
      sentenceMix: 0.15,
      dialogueTarget: 0.15,
      coolPointGapFactor: 1.5,
    })
    const explicit = compile({
      ...basePack(),
      thresholds: { sentence_mix_tolerance: 0.2, dialogue_target_tolerance: 0.1, cool_point_gap_factor: 2 },
    })
    expect(styleTolerances(explicit)).toEqual({
      sentenceMix: 0.2,
      dialogueTarget: 0.1,
      coolPointGapFactor: 2,
    })
  })

  it('keeps the bundled packs free of zero-tolerance duplicates after compilation', () => {
    resetStylePackCache()
    const rulepack = loadRulepack()
    const zeroTolerance = new Set(rulepack.lexicon.zero_tolerance.map((entry) => entry.term))
    const { packs } = loadStyleCatalogue({ zeroTolerance: [...zeroTolerance] })
    for (const pack of packs) {
      for (const pattern of pack.banned_patterns) expect(zeroTolerance.has(pattern), pack.id).toBe(false)
    }
  })

  it('keys the catalogue cache by the zero-tolerance set, so the first caller cannot decide for everyone', () => {
    resetStylePackCache()
    // Call order is the whole point: with an unkeyed cache the second call
    // silently returns the first call's result.
    const collapsedFirst = stylePackMap({ zeroTolerance: ['仿佛'] }).get('cold-suspense')!
    const rawAfter = stylePackMap().get('cold-suspense')!
    expect(collapsedFirst.banned_patterns).not.toContain('仿佛')
    expect(rawAfter.banned_patterns).toContain('仿佛')
    expect(collapsedFirst).not.toBe(rawAfter)

    resetStylePackCache()
    // And the other way round.
    const rawFirst = stylePackMap().get('cold-suspense')!
    const collapsedAfter = stylePackMap({ zeroTolerance: ['仿佛'] }).get('cold-suspense')!
    expect(rawFirst.banned_patterns).toContain('仿佛')
    expect(collapsedAfter.banned_patterns).not.toContain('仿佛')
  })

  it('gives the engine the collapsed pack, not the raw one (C3 at runtime)', () => {
    resetStylePackCache()
    const engine = new EngineService(
      {
        projectRoot: '.',
        stateDir: '',
        tools: { mode: 'all' },
        quality: { minScore: 120 },
        briefs: { overrides: '' },
        storage: { backupRetention: 5 },
      },
      loadRulepack(),
    )
    try {
      const pack = engine.stylepackFor({ style: 'cold-suspense' })
      expect(pack).not.toBeNull()
      const zeroTolerance = new Set(loadRulepack().lexicon.zero_tolerance.map((entry) => entry.term))
      // The engine used to resolve the catalogue with no list at all, so every
      // zero-tolerance word stayed in `banned_patterns` and was reported twice.
      for (const pattern of pack!.banned_patterns) expect(zeroTolerance.has(pattern), pattern).toBe(false)
      expect(pack!.banned_patterns).toContain('眸中')
    } finally {
      engine.dispose()
    }
  })

  it('ships neutral exemplars that carry no manuscript identity', () => {
    resetStylePackCache()
    const { packs } = loadStyleCatalogue()
    for (const pack of packs) {
      for (const exemplar of pack.exemplars) {
        // C9: exemplars ship inside the npm package, so only generic forms.
        expect(exemplar, pack.id).not.toMatch(/林砚|苏禾|沈砚|林深|林渊|陈嘉树/)
        expect(exemplar, pack.id).not.toContain('\r')
      }
    }
  })

  it('reads the bundled YAML through the same path the runtime uses', () => {
    const text = readFileSync(new URL('../stylepacks/weird-horror.yaml', import.meta.url), 'utf8')
    const raw = parse(text)
    const pack = compileStylePack(raw, { fileId: 'weird-horror' }).pack
    expect(pack.name).toBe('怪谈克苏鲁')
    expect(pack.pov).toBe('first')
    expect(pack.genres).toContain('末世流')
  })
})
