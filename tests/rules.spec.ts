import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compileRulepack, DEFAULT_RULEPACK, normalize } from '../src/rules/compiler.js'
import { RuleRegistry } from '../src/rules/registry.js'
import { PIPELINE_STEPS, runMachineChecks, runRules } from '../src/rules/pipeline.js'
import { BUILTIN_RULES } from '../src/rules/checks.js'
import { loadRulepack, bundledRulepackPath } from '../src/rulepack.js'
import type { Rulepack } from '../src/rules/types.js'
import type { MachineOptions } from '../src/rules/pipeline.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const rawPack = parseYaml(readFileSync(`${repoRoot}rulepacks/default.yaml`, 'utf8')) as Record<
  string,
  unknown
>
const pack = compileRulepack(structuredClone(rawPack))

const options = (overrides: Partial<MachineOptions> = {}): MachineOptions => ({
  chapter: 1,
  title: '第1章 开端之雨',
  genre: '都市现代',
  sceneType: '日常过渡章',
  rulepack: pack,
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
  ...overrides,
})

describe('rule pack compiler', () => {
  it('accepts the shipped pack and freezes it', () => {
    expect(pack.quality.dimensions.reduce((total, dimension) => total + dimension.max, 0)).toBe(150)
    expect(Object.isFrozen(pack)).toBe(true)
    expect(Object.isFrozen(pack.lexicon.zero_tolerance)).toBe(true)
    expect(loadRulepack().name).toBe('default')
    expect(bundledRulepackPath()).toContain('rulepacks')
  })

  it('rejects the six classes of defect', () => {
    const cases: Array<[string, (draft: Record<string, any>) => void, RegExp]> = [
      [
        'dimension sum',
        (draft) => {
          draft.quality.dimensions[0].max = 99
        },
        /dimension maxima sum/,
      ],
      [
        'unknown key',
        (draft) => {
          draft.experimental = true
        },
        /not a recognised key/,
      ],
      [
        'duplicate term',
        (draft) => {
          draft.lexicon.soft.push({ term: '总而言之', limit: 1 })
        },
        /appears in both/,
      ],
      [
        'dangling exclusion',
        (draft) => {
          draft.exclusions.push({ pair: ['NOPE', 'NOPE2'], family: 'x' })
        },
        /unknown rule/,
      ],
      [
        'threshold',
        (draft) => {
          draft.format.paragraph_max_words = 5
        },
        /paragraph_max_words/,
      ],
      [
        'bad regex',
        (draft) => {
          draft.format.title.pattern = '('
        },
        /not a valid regular expression/,
      ],
    ]
    for (const [name, mutate, pattern] of cases) {
      const draft = structuredClone(rawPack)
      mutate(draft)
      expect(() => compileRulepack(draft), name).toThrow(pattern)
    }
    const missingPlatform = structuredClone(rawPack) as { platform: Record<string, unknown> }
    delete missingPlatform.platform.fanqie
    expect(() => compileRulepack(missingPlatform)).toThrow(/platform.fanqie/)
    expect(() => compileRulepack({ ...structuredClone(rawPack), schema_version: 2 })).toThrow(
      /schema_version/,
    )
    expect(() =>
      compileRulepack({ ...structuredClone(rawPack), crosschapter: { duplicate_similarity: 2 } }),
    ).toThrow(/duplicate_similarity/)
  })

  it('normalizes missing optional blocks from defaults', () => {
    const normalized = normalize({ name: 'x', version: '1.0.0' })
    expect(normalized.format.paragraph_max_words).toBe(DEFAULT_RULEPACK.format.paragraph_max_words)
    expect(normalized.quality.dimensions).toHaveLength(15)
    expect(() => normalize({ name: '', version: '1' })).toThrow(/non-empty string/)
  })

  it('refuses duplicate code ownership', () => {
    const registry = new RuleRegistry()
    registry.register('A', () => [])
    expect(registry.has('A')).toBe(true)
    expect(registry.size()).toBe(1)
    expect(() => registry.register('A', () => [])).toThrow(/already registered/)
    expect(registry.codes()).toEqual(['A'])
    expect(registry.get('missing')).toBeUndefined()
  })
})

describe('machine pipeline', () => {
  it('runs the five steps in order and never emits the lexicon first', () => {
    expect(PIPELINE_STEPS).toEqual(['segment', 'density', 'quote', 'exemption', 'lexicon'])
    expect(Object.keys(BUILTIN_RULES)).toHaveLength(30)
  })

  it('detects format, punctuation and lexicon violations', () => {
    const text =
      '# 标题\n\n他推开门，“你来了”；她说...\n\n由此可见，多年以后，时间仿佛静止——这——是——场——戏——了。\n\n' +
      '了'.repeat(5) +
      '\n\n' +
      '他感到因为风很大，所以关上门。'
    const result = runMachineChecks(text, options({ title: '第1章 开端之雨' }))
    const codes = new Set(result.violations.map((violation) => violation.code))
    for (const expected of [
      'MD_CONTAMINATION',
      'ILLEGAL_QUOTE',
      'SEMICOLON',
      'ENGLISH_ELLIPSIS',
      'LEX_ZERO_TOLERANCE',
      'META_NARRATION',
      'GOD_VIEW',
      'CONCLUSION_FIRST',
    ]) {
      expect(codes, expected).toContain(expected)
    }
    expect(result.quoteRatio).toBeLessThan(1)
    expect(result.paragraphCount).toBeGreaterThan(2)
  })

  it('computes the quote ratio and honours exemptions', () => {
    const quoteOnly = '他说“好”。\n\n她说“走”。'
    const strict = runMachineChecks(quoteOnly, options())
    expect(strict.quoteRatio).toBe(0)
    const exempt: Rulepack = { ...pack, exemptions: ['ILLEGAL_QUOTE'] }
    expect(
      runMachineChecks(quoteOnly, options({ rulepack: exempt })).violations.some(
        (v) => v.code === 'ILLEGAL_QUOTE',
      ),
    ).toBe(false)
    expect(runMachineChecks('干净正文。', options()).quoteRatio).toBe(1)
  })

  it('runs only the requested subset for gates', () => {
    const violations = runRules(['SEMICOLON'], '他说；然后走了。', options())
    expect(violations.map((violation) => violation.code)).toEqual(['SEMICOLON'])
    expect(runRules(['UNKNOWN'], 'x', options())).toEqual([])
  })

  it('flags long paragraphs, bad titles and system labels', () => {
    const long = '字'.repeat(95)
    const result = runMachineChecks(`${long}\n\nDay 3 的风很大。`, options({ title: '错误的标题' }))
    const codes = result.violations.map((violation) => violation.code)
    expect(codes).toContain('LONG_PARAGRAPH')
    expect(codes).toContain('TITLE_FORMAT')
    expect(codes).toContain('SYSTEM_LABEL')
  })

  it('flags readers, dash budget, ellipsis runs and uniform sentences', () => {
    const uniform = Array.from({ length: 12 }, () => '今天天气很好啊').join('。') + '。'
    const text = `${uniform}\n\n我们可以看到，这一切——都是——假的——吧——啊——呀……`
    const result = runMachineChecks(text, options())
    const codes = result.violations.map((violation) => violation.code)
    expect(codes).toContain('READER_INTRUSION')
    expect(codes).toContain('DASH_BUDGET')
    expect(codes).toContain('UNIFORM_SENTENCE')
    expect(
      codes.some((code) => code === 'PERIOD_DENSITY' || code === 'ELLIPSIS_RUN' || code === 'CONSECUTIVE_LE'),
    ).toBe(true)
  })

  it('flags semantic densities and water words', () => {
    const adjectives = '美丽漂亮英俊巨大渺小愤怒悲伤开心恐怖温柔冰冷炙热明亮昏暗'.repeat(2)
    const water = '的就是的时候的时候一个一种一些这个那个这样那样其实确实真的非常十分'.repeat(8)
    const text = `${adjectives}，他看见窗外的光，听见风响。\n\n${water}`
    const result = runMachineChecks(text, options())
    const codes = result.violations.map((violation) => violation.code)
    expect(codes).toContain('ADJECTIVE_DENSITY')
    expect(codes).toContain('WATER_WORDS')
    expect(codes).toContain('PLEASURE_DENSITY')
    expect(runMachineChecks('他走了。', options()).violations.map((violation) => violation.code)).toContain(
      'SENSORY_DENSITY',
    )
  })

  it('flags cross-chapter problems from evidence', () => {
    const text = '主角和配角一起走进旧办公室。Day 4 的风很大。'
    const result = runMachineChecks(
      text,
      options({
        summary: {
          events: ['x'],
          characters_appeared: [],
          foreshadows: { planted: [], advanced: [], resolved: [] },
          new_elements: { locations: [], abilities: [], artifacts: [] },
          resource_changes: [{ character: '主角', resource: '铜钱', delta: -200, reason: 'x' }],
          opening: 'x',
          continuity: { opens_from: '', ends_with: '' },
          hook_strength: 3,
          pleasure_points: [],
          plot_advancement: 'mid',
        },
        evidence: {
          characters: null,
          previousText: text,
          previousTexts: [text],
          foreshadows: {
            schema_version: 1,
            next_seq: 2,
            items: [
              {
                id: 'FS-001',
                title: '旧信封',
                planted: 1,
                last_touched: 1,
                status: 'dormant',
                resolved_at: null,
                description: '',
                advance_log: [],
              },
            ],
          },
          timeline: {
            schema_version: 1,
            next_seq: 2,
            items: [
              {
                id: 'TE-001',
                chapter: 1,
                story_time: 'Day 5',
                description: '',
                location: '',
                characters: [],
              },
            ],
          },
          relationships: {
            schema_version: 1,
            next_seq: 1,
            items: [
              { id: 'RL-001', a: '主角', b: '配角', type: '师徒', since: 1, description: '', evolution: [] },
            ],
          },
          world: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
          locks: {
            schema_version: 1,
            locked_at_chapter: 1,
            characters: {},
            locations: {
              旧办公室: { first_appearance: 1, locked_at: 1, layout: '完全不同的布局描述', capacity: 3 },
            },
          },
        },
        chapter: 3,
      }),
    )
    const codes = result.violations.map((violation) => violation.code)
    expect(codes).toContain('DUPLICATE_PARAGRAPH')
    expect(codes).toContain('RESOURCE_MISMATCH')
    expect(codes).toContain('TIME_REGRESSION')
    expect(codes).toContain('LOCKED_DETAIL_DRIFT')
  })

  it('flags a foreshadow that reappears too soon', () => {
    const result = runMachineChecks(
      '他再次看见那封旧信封。',
      options({
        chapter: 2,
        evidence: {
          characters: null,
          previousText: null,
          previousTexts: [],
          foreshadows: {
            schema_version: 1,
            next_seq: 2,
            items: [
              {
                id: 'FS-001',
                title: '旧信封',
                planted: 1,
                last_touched: 1,
                status: 'planted',
                resolved_at: null,
                description: '',
                advance_log: [],
              },
            ],
          },
          timeline: null,
          relationships: null,
          world: null,
          locks: null,
        },
      }),
    )
    expect(result.violations.map((violation) => violation.code)).toContain('FS_REVISITED_TOO_SOON')
  })
})
