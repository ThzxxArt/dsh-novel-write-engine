import { describe, expect, it } from 'vitest'
import { AI_TONE_RULES } from '../src/codes.js'
import { compileRulepack, DEFAULT_RULEPACK } from '../src/rules/compiler.js'
import { collectToneHits, evaluateTone, quoteSpans } from '../src/rules/ai-tone.js'
import { runMachineChecks } from '../src/rules/pipeline.js'
import type { MachineOptions } from '../src/rules/pipeline.js'
import type { AiToneBlock } from '../src/rules/types.js'
import { loadRulepack } from '../src/rulepack.js'

const rulepack = loadRulepack()
const block = rulepack.lexicon.ai_tone!

const options = (overrides: Partial<MachineOptions> = {}): MachineOptions => ({
  chapter: 1,
  title: '第1章 夜',
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
  ...overrides,
})

const codesOf = (text: string): string[] =>
  runMachineChecks(text, options()).violations.map((violation) => violation.code)

const toneCodes = (text: string): string[] => codesOf(text).filter((code) => code.startsWith('AI_TONE_'))

/** Neutral prose that carries none of the tone families. */
const NEUTRAL = '他推开门，楼道里的灯闪了两下。风从窗缝里进来，纸角被掀起一点。'

describe('0.2.17 AI-tone block', () => {
  it('compiles the seven categories and 39 entries from the shipped pack', () => {
    expect(Object.keys(block.categories)).toHaveLength(7)
    expect(block.entries).toHaveLength(39)
    expect(new Set(block.entries.map((entry) => entry.id)).size).toBe(39)
    for (const entry of block.entries) {
      expect(Object.hasOwn(block.categories, entry.category), entry.id).toBe(true)
    }
    // Every category code is a registered rule code.
    for (const category of Object.values(block.categories)) {
      expect(Object.values(AI_TONE_RULES)).toContain(category.code)
    }
  })

  it('rejects a malformed block instead of silently never matching', () => {
    const withBlock = (mutate: (value: Record<string, unknown>) => void): Record<string, unknown> => {
      const raw = structuredClone(DEFAULT_RULEPACK) as unknown as Record<string, unknown>
      const lexicon = raw.lexicon as Record<string, unknown>
      const value = structuredClone(block) as unknown as Record<string, unknown>
      mutate(value)
      lexicon.ai_tone = value
      return raw
    }
    const cases: Array<[string, (value: Record<string, unknown>) => void, RegExp]> = [
      ['version', (value) => (value.version = 2), /version must be 1/],
      [
        'unknown category',
        (value) => ((value.entries as Array<Record<string, unknown>>)[0]!.category = 'nope'),
        /is not declared/,
      ],
      [
        'bad code',
        (value) => ((value.categories as Record<string, Record<string, unknown>>).ack_loop!.code = 'ACK'),
        /AI_TONE_/,
      ],
      [
        'payload mismatch',
        (value) => ((value.entries as Array<Record<string, unknown>>)[0]!.terms = []),
        /terms must not be empty/,
      ],
      [
        'bad regex',
        (value) => {
          const rows = value.entries as Array<Record<string, unknown>>
          const target = rows.find((row) => row.match === 'regex')!
          target.pattern = '('
        },
        /does not compile/,
      ],
      [
        'bad severity',
        (value) => ((value.entries as Array<Record<string, unknown>>)[0]!.severity = 'fatal'),
        /severity must be/,
      ],
      [
        'bad scope',
        (value) => ((value.entries as Array<Record<string, unknown>>)[0]!.scope = 'everywhere'),
        /scope must be/,
      ],
      [
        'short window',
        (value) => ((value.categories as Record<string, Record<string, unknown>>).ack_loop!.window = 10),
        /window must be >= 100/,
      ],
      [
        'bad exclusion',
        (value) => {
          const rows = value.entries as Array<Record<string, unknown>>
          const target = rows.find((row) => Array.isArray(row.exclude_if_matches))!
          target.exclude_if_matches = ['(']
        },
        /does not compile/,
      ],
      [
        'duplicate id',
        (value) => {
          const rows = value.entries as Array<Record<string, unknown>>
          rows[1]!.id = rows[0]!.id
        },
        /duplicates/,
      ],
      [
        'template placeholder',
        (value) => {
          const rows = value.entries as Array<Record<string, unknown>>
          const target = rows.find((row) => row.match === 'template')!
          target.template = '没有占位符'
        },
        /placeholder/,
      ],
    ]
    for (const [label, mutate, pattern] of cases) {
      expect(() => compileRulepack(withBlock(mutate)), label).toThrow(pattern)
    }
  })

  it('keeps a pack without ai_tone compiling to an empty block', () => {
    const raw = structuredClone(DEFAULT_RULEPACK) as unknown as Record<string, unknown>
    delete (raw.lexicon as Record<string, unknown>).ai_tone
    const pack = compileRulepack(raw)
    expect(pack.lexicon.ai_tone?.entries ?? []).toHaveLength(0)
    const codes = runMachineChecks('这句话稳。', options({ rulepack: pack })).violations.map(
      (row) => row.code,
    )
    expect(codes.filter((code) => code.startsWith('AI_TONE_'))).toEqual([])
  })
})

describe('0.2.17 AI-tone evaluation', () => {
  it('classifies dialogue and narration by offset, not by a whole-line guess', () => {
    const spans = quoteSpans('他说：“你来了。”然后转身。')
    expect(spans.map((span) => span.kind)).toEqual(['narration', 'dialogue', 'narration'])
    expect(spans[1]!.start).toBeLessThan(spans[1]!.end)
  })

  it('AI_TONE_META is a blocker in narration and an advisory in dialogue', () => {
    const narration = runMachineChecks('这句话稳。', options()).violations.filter(
      (violation) => violation.code === AI_TONE_RULES.META,
    )
    expect(narration[0]?.severity).toBe('blocker')
    const dialogue = runMachineChecks('“这句话稳。”他说。', options()).violations.filter(
      (violation) => violation.code === AI_TONE_RULES.META,
    )
    expect(dialogue[0]?.severity).toBe('advisory')
  })

  it('names the entry and the replacement so the model can act on it', () => {
    const violation = runMachineChecks('这句话稳。', options()).violations.find(
      (row) => row.code === AI_TONE_RULES.META,
    )
    expect(violation?.detail).toContain('AI-META-001')
    expect(violation?.detail).toContain('改成：')
  })

  it('honours false_positives: a legitimate sentence is not flagged', () => {
    expect(toneCodes('他说话很稳。')).toEqual([])
  })

  it('honours exclude_if_matches: 把账记下了 is an action, not an ack loop', () => {
    expect(toneCodes('他把账记下了。')).toEqual([])
    expect(toneCodes('我记下了。')).toContain(AI_TONE_RULES.ACK)
  })

  it('escalates an advisory to blocker only inside a crowded window', () => {
    const crowded = '我记下了。他点头。我记下了。她走开。我记下了。'
    const hits = evaluateTone(crowded, block).filter((hit) => hit.code === AI_TONE_RULES.ACK)
    expect(hits.length).toBeGreaterThan(1)
    expect(hits.every((hit) => hit.severity === 'blocker')).toBe(true)
    // One hit stays advisory: the tolerance is 1 per window.
    const single = evaluateTone('我记下了。', block).filter((hit) => hit.code === AI_TONE_RULES.ACK)
    expect(single[0]?.severity).toBe('advisory')
  })

  it('respects a regex matcher and a standalone matcher', () => {
    expect(toneCodes('这箱子比之前都重。')).toContain(AI_TONE_RULES.COMPARATIVE)
    // `很平` only counts when it is its own sentence; inside a clause it is
    // description, which is exactly what `standalone` is for.
    expect(toneCodes('他看了一眼。很平。')).toContain(AI_TONE_RULES.JUDGMENT)
    expect(toneCodes('这条线画得很平整。')).not.toContain(AI_TONE_RULES.JUDGMENT)
  })

  it('matches a template with a bounded gap', () => {
    expect(toneCodes('什么心思都写在脸上。')).toContain(AI_TONE_RULES.TEMPLATE)
    expect(toneCodes('行，认了。')).toContain(AI_TONE_RULES.TEMPLATE)
    expect(toneCodes('行，走吧。')).not.toContain(AI_TONE_RULES.TEMPLATE)
  })

  it('covers the remaining three families', () => {
    expect(toneCodes('睡吧，我守着。')).toContain(AI_TONE_RULES.PROTECTIVE)
    expect(toneCodes('问别人还是问自己。')).toContain(AI_TONE_RULES.SOCRATIC)
  })

  it('gives one span exactly one owner: AI tone wins over zero tolerance (C8)', () => {
    // The shipped pack has no literal overlap, so the mechanism is exercised on
    // a pack where one phrase is deliberately claimed by both owners.
    const raw = structuredClone(DEFAULT_RULEPACK) as unknown as Record<string, unknown>
    const lexicon = raw.lexicon as Record<string, unknown>
    lexicon.zero_tolerance = [{ term: '意味深长' }]
    lexicon.ai_tone = {
      version: 1,
      categories: {
        template_phrase: {
          code: AI_TONE_RULES.TEMPLATE,
          default_severity: 'advisory',
          default_scope: 'any',
          limit: 1,
          window: 1000,
          escalation: 'none',
        },
      },
      entries: [
        {
          id: 'AI-TPL-TEST',
          category: 'template_phrase',
          match: 'exact',
          terms: ['意味深长'],
          severity: 'advisory',
          scope: 'any',
          replacement: '换成一个具体动作。',
        },
      ],
    }
    const pack = compileRulepack(raw)
    const codes = runMachineChecks('他意味深长地笑了笑。', options({ rulepack: pack })).violations.map(
      (row) => row.code,
    )
    // The more specific entry owns the span and carries the advice…
    expect(codes).toContain(AI_TONE_RULES.TEMPLATE)
    // …so the zero-tolerance row for the same phrase steps aside.
    expect(codes).not.toContain('LEX_ZERO_TOLERANCE')
    // A zero-tolerance word with no tone entry still blocks on its own.
    const plain = runMachineChecks('总而言之，他不禁笑了。', options()).violations.map((row) => row.code)
    expect(plain).toContain('LEX_ZERO_TOLERANCE')
  })

  it('lets only the overlapping occurrence step aside, not the whole term (C8)', () => {
    // The pack makes 意味深长 a zero-tolerance term and an AI-tone entry whose
    // phrase is the longer 意味深长地笑. One cliché occurrence is owned by the
    // tone entry; a second, plain occurrence must still block.
    const raw = structuredClone(DEFAULT_RULEPACK) as unknown as Record<string, unknown>
    const lexicon = raw.lexicon as Record<string, unknown>
    lexicon.zero_tolerance = [{ term: '意味深长' }]
    lexicon.ai_tone = {
      version: 1,
      categories: {
        template_phrase: {
          code: AI_TONE_RULES.TEMPLATE,
          default_severity: 'advisory',
          default_scope: 'any',
          limit: 1,
          window: 1000,
          escalation: 'none',
        },
      },
      entries: [
        {
          id: 'AI-TPL-DUP',
          category: 'template_phrase',
          match: 'exact',
          terms: ['意味深长地笑'],
          severity: 'advisory',
          scope: 'any',
        },
      ],
    }
    const pack = compileRulepack(raw)
    // One occurrence, covered by the tone entry: no zero-tolerance row.
    const single = runMachineChecks('他意味深长地笑了笑。', options({ rulepack: pack })).violations
    expect(single.map((row) => row.code)).not.toContain('LEX_ZERO_TOLERANCE')
    // Two occurrences, one covered: the uncovered one still blocks.
    const both = runMachineChecks(
      '他意味深长地笑了笑。她的眼神意味深长。',
      options({ rulepack: pack }),
    ).violations
    const row = both.find((entry) => entry.code === 'LEX_ZERO_TOLERANCE')
    expect(row).toBeDefined()
    expect(row?.detail).toContain('1x')
  })

  it('suppresses a zero-tolerance term that sits *inside* a tone phrase (C8)', () => {
    // The tone entry claims the longer phrase; the blacklisted word is a
    // substring of it. An exact-match set would let both fire on one span.
    const raw = structuredClone(DEFAULT_RULEPACK) as unknown as Record<string, unknown>
    const lexicon = raw.lexicon as Record<string, unknown>
    lexicon.zero_tolerance = [{ term: '意味深长' }]
    lexicon.ai_tone = {
      version: 1,
      categories: {
        template_phrase: {
          code: AI_TONE_RULES.TEMPLATE,
          default_severity: 'advisory',
          default_scope: 'any',
          limit: 1,
          window: 1000,
          escalation: 'none',
        },
      },
      entries: [
        {
          id: 'AI-TPL-LONG',
          category: 'template_phrase',
          match: 'exact',
          terms: ['意味深长地笑了笑'],
          severity: 'advisory',
          scope: 'any',
        },
      ],
    }
    const codes = runMachineChecks(
      '他意味深长地笑了笑。',
      options({ rulepack: compileRulepack(raw) }),
    ).violations.map((row) => row.code)
    expect(codes).toContain(AI_TONE_RULES.TEMPLATE)
    expect(codes).not.toContain('LEX_ZERO_TOLERANCE')
  })

  it('stays silent on neutral prose', () => {
    expect(toneCodes(NEUTRAL)).toEqual([])
  })

  it('computes hits once and shares them across the seven codes', () => {
    const hits = collectToneHits('这句话稳。我记下了。', block)
    const codes = new Set(hits.map((hit) => hit.code))
    expect(codes.size).toBeGreaterThan(1)
    // evaluateTone is the same list plus escalation, never a second scan.
    expect(evaluateTone('这句话稳。我记下了。', block)).toHaveLength(hits.length)
  })

  it('handles an empty block and empty text without throwing', () => {
    const empty: AiToneBlock = { version: 1, categories: {}, entries: [] }
    expect(evaluateTone('这句话稳。', empty)).toEqual([])
    expect(evaluateTone('', block)).toEqual([])
  })
})
