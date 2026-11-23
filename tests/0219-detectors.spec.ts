import { describe, expect, it } from 'vitest'
import { loadRulepack } from '../src/rulepack.js'
import { runMachineChecks, type MachineOptions } from '../src/rules/pipeline.js'
import { measureStyle, styleVocabulary } from '../src/domain/style.js'
import { briefContext, type BriefContextInput } from '../src/engine/context.js'
import { loadStyleCatalogue } from '../src/stylepack.js'
import { AI_TONE_RULES } from '../src/codes.js'
import type { StylePack } from '../src/rules/types.js'

/**
 * 0.2.19 WP0 — the four detector defects fail before any production change.
 *
 * Each test states the *behaviour* the plan promises, not the shape of an
 * implementation. They are written against today's code, so the first run is
 * red for D1/D2/D4/D5 and green only once the root cause is fixed.
 */

const rulepack = loadRulepack()

const base = (overrides: Partial<MachineOptions> = {}): MachineOptions => ({
  chapter: 1,
  // No title: TITLE_FORMAT is a different owner and must not pollute a code set.
  title: null,
  genre: '都市现代',
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

const codesOf = (text: string, overrides: Partial<MachineOptions> = {}): string[] =>
  runMachineChecks(text, base(overrides)).violations.map((violation) => violation.code)

const detailsOf = (text: string, code: string, overrides: Partial<MachineOptions> = {}): string[] =>
  runMachineChecks(text, base(overrides))
    .violations.filter((violation) => violation.code === code)
    .map((violation) => violation.detail)

/** measureStyle reads the id and the banned patterns only; a stub pack is honest here. */
const stubPack = { id: 'stub', banned_patterns: [] } as unknown as StylePack
const measures = (text: string) => measureStyle(text, stubPack, styleVocabulary(rulepack))

describe('D1 AI-TPL-001 must fire on a line, not only on the whole chapter', () => {
  // Root cause: ai-tone.ts compiles every `regex` entry with the `g` flag only,
  // so a pattern written as `^行…$` can only match when the entire chapter is
  // that one sentence. The pack states the intent as "only abstract concessions".
  const chapter = ['他把烟按灭，没接话。', '行，认了。', '她把杯子推到桌子中间。'].join('\n\n')

  it('flags 行，认了。 when it is one paragraph among many', () => {
    const details = detailsOf(chapter, AI_TONE_RULES.TEMPLATE)
    expect(details.join('\n')).toContain('AI-TPL-001')
  })

  it('flags 行，听你的。 as a standalone paragraph', () => {
    const text = ['雨停了。', '行，听你的。', '他把伞收起来。'].join('\n\n')
    expect(detailsOf(text, AI_TONE_RULES.TEMPLATE).join('\n')).toContain('AI-TPL-001')
  })

  it('still fires when the whole chapter is that single line', () => {
    // This is the only case that works today: it must keep working.
    expect(detailsOf('行，认了。', AI_TONE_RULES.TEMPLATE).join('\n')).toContain('AI-TPL-001')
  })

  it('keeps the documented false positives silent', () => {
    // The pack lists 行，走吧。 and 行，先吃饭。 as false positives of this entry.
    for (const text of ['他说完站起来。\n\n行，走吧。\n\n她跟上。', '行，先吃饭。\n\n他把碗推过去。']) {
      expect(detailsOf(text, AI_TONE_RULES.TEMPLATE)).toEqual([])
    }
  })

  it('does not widen the anchor to mid-sentence occurrences', () => {
    // `^` still means "starts the line": a concession buried inside a sentence
    // is a different finding, and loosening it would invent hits.
    expect(detailsOf('他说行，认了，然后走了。\n\n她把门关上。', AI_TONE_RULES.TEMPLATE)).toEqual([])
  })
})

describe('D2 the metaphor counter must not count compounds', () => {
  // Root cause: `markers` contains the single character 像 and the counter is a
  // plain substring scan, so 好像 / 画像 / 偶像 all count as one metaphor each.
  it('counts zero for 好像 / 画像 / 偶像', () => {
    expect(measures('好像是这样的，画像挂在墙上，他偶像的照片。').diction.metaphor_per_1000).toBe(0)
  })

  it('counts both similes in 她的眼睛像两口井，像两潭死水。', () => {
    // 15 non-whitespace characters, 2 hits: 2 * 1000 / 15 = 133.333.
    expect(measures('她的眼睛像两口井，像两潭死水。').diction.metaphor_per_1000).toBe(133.333)
  })

  it('requires 似的 to follow 像/跟/和/如', () => {
    expect(measures('风似的走开了。').diction.metaphor_per_1000).toBe(0)
    expect(measures('那条船像叶子似的飘着。').diction.metaphor_per_1000).toBeGreaterThan(0)
  })

  it('does not treat the prepositional 像他这样的人 as a simile', () => {
    expect(measures('像他这样的人也能活下来。').diction.metaphor_per_1000).toBe(0)
  })

  it('keeps the compound list complete, not just the three reported cases', () => {
    // 石像 / 木像 / 泥像 / 铜像 are the same class of defect as 画像.
    expect(measures('门口立着一尊石像，旁边是木像和泥像。').diction.metaphor_per_1000).toBe(0)
  })
})

describe('D4 the P4 task book must carry every banned pattern', () => {
  const minimal = (style: StylePack): BriefContextInput => ({
    stage: 'P4',
    chapter: 1,
    project: {
      schema_version: 1,
      title: '禁句之书',
      genre: '都市现代',
      platform: 'fanqie',
      author: '',
      description: '',
      created_at: '2026-01-01',
      targets: { words_per_chapter: [2000, 3000], total_chapters: 10, dialogue_ratio: [0.2, 0.6] },
    },
    pipeline: {
      schema_version: 1,
      revision: 1,
      chapter: 1,
      stage: 'P4',
      rounds: { review: 0, revise: 0, check: 0 },
      briefs: {},
      blocking: [],
      last_action: null,
    },
    chapters: { schema_version: 1, chapters: [] },
    characters: { schema_version: 1, characters: [] },
    world: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
    locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
    foreshadows: { schema_version: 1, next_seq: 1, items: [] },
    timeline: { schema_version: 1, next_seq: 1, items: [] },
    relationships: { schema_version: 1, next_seq: 1, items: [] },
    plan: null,
    review: null,
    check: null,
    text: '他推开门。屋里没人。',
    previousText: null,
    handoff: null,
    style,
  })

  const bannedOf = (style: StylePack): string[] => {
    const context = briefContext(minimal(style))
    const block = context.style as { banned_patterns: string[] } | undefined
    expect(block).toBeDefined()
    return block!.banned_patterns
  }

  it('carries all seventeen patterns of the longest pack', () => {
    // Widen a real pack rather than hand-rolling one: the brief reads many
    // fields, and a synthetic stub would test the stub.
    const base = loadStyleCatalogue().packs[0]!
    const style: StylePack = {
      ...base,
      banned_patterns: Array.from({ length: 17 }, (_, index) => `禁句${index + 1}`),
    }
    expect(bannedOf(style)).toHaveLength(17)
  })

  it('carries every pattern of every bundled pack', () => {
    const { packs } = loadStyleCatalogue()
    expect(packs.length).toBe(8)
    for (const pack of packs) {
      const carried = bannedOf(pack)
      expect({ id: pack.id, carried: carried.length }).toEqual({
        id: pack.id,
        carried: pack.banned_patterns.length,
      })
      expect(carried).toEqual(pack.banned_patterns)
    }
  })
})

describe('D5 DIALOGUE_RATIO_SKEWED needs its own assertion', () => {
  // 56 codes, 55 with a direct rule-layer assertion. This one only had a status
  // verdict. `both` fires only when both measures leave the range, so the
  // disagreement case is the only path to this code.
  const skewedText = (): string => {
    const dialogue = '"嗯。"\n'.repeat(20)
    const narration = `他走过长街，看见灯一盏一盏亮起来，接着又拐进巷子，数着门牌。${'远处有人收摊，铁皮卷帘门哗啦一声落下。'.repeat(2)}`
    return `${dialogue}\n${narration}`
  }

  it('reports DIALOGUE_RATIO_SKEWED when the two measures disagree', () => {
    const text = skewedText()
    const result = runMachineChecks(
      text,
      base({
        targets: { words_per_chapter: [80, 900], dialogue_ratio: [0.2, 0.4], dialogue_ratio_metric: 'both' },
      }),
    )
    const codes = result.violations.map((violation) => violation.code)
    expect(codes).toContain('DIALOGUE_RATIO_SKEWED')
    expect(codes).not.toContain('DIALOGUE_RATIO')
    const detail = result.violations.find((violation) => violation.code === 'DIALOGUE_RATIO_SKEWED')!.detail
    // The detail must name both readings and which one is out.
    expect(detail).toMatch(/lines .*%/)
    expect(detail).toMatch(/chars .*%/)
    expect(detail).toContain('target 20%..40%')
    expect(detail).toContain('(out)')
  })

  it('does not report it when both measures are inside the range', () => {
    const text = '"嗯。"她说。\n"走。"他答。'
    const codes = codesOf(text, {
      targets: { words_per_chapter: [80, 900], dialogue_ratio: [0.2, 1], dialogue_ratio_metric: 'both' },
    })
    expect(codes).not.toContain('DIALOGUE_RATIO_SKEWED')
    expect(codes).not.toContain('DIALOGUE_RATIO')
  })

  it('does not report it when both measures are outside the range', () => {
    // Both out is DIALOGUE_RATIO, the stronger code. Two owners would double-count.
    const text = '他把杯子放下，走到窗边看了一眼楼下。\n\n街上没有人。'
    const codes = codesOf(text, {
      targets: { words_per_chapter: [80, 900], dialogue_ratio: [0.5, 1], dialogue_ratio_metric: 'both' },
    })
    expect(codes).toContain('DIALOGUE_RATIO')
    expect(codes).not.toContain('DIALOGUE_RATIO_SKEWED')
  })
})
