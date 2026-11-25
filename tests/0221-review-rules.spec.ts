import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { dialogueCharacterRatio } from '../src/domain/text.js'
import { loadRulepack } from '../src/rulepack.js'
import { collectToneHits } from '../src/rules/ai-tone.js'
import { compileRulepack } from '../src/rules/compiler.js'
import { runMachineChecks, type MachineOptions } from '../src/rules/pipeline.js'
import type { Rulepack } from '../src/rules/types.js'

/**
 * 0.2.20 review: the confirmed defects in the rules layer.
 *
 * One `describe` per finding. Every positive fixture is the reviewer's probe,
 * and every negative fixture is the boundary the document promises, so a fix
 * that merely silences the probe is caught.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const rawPack = parseYaml(readFileSync(`${repoRoot}rulepacks/default.yaml`, 'utf8')) as Record<string, any>
const rulepack = loadRulepack()

const base = (overrides: Partial<MachineOptions> = {}): MachineOptions => ({
  chapter: 1,
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

const violations = (text: string, overrides: Partial<MachineOptions> = {}) =>
  runMachineChecks(text, base(overrides)).violations

const codes = (text: string, overrides: Partial<MachineOptions> = {}): Set<string> =>
  new Set(violations(text, overrides).map((violation) => violation.code))

const hits = (text: string, code: string, overrides: Partial<MachineOptions> = {}) =>
  violations(text, overrides).filter((violation) => violation.code === code)

/** A pack whose selfcheck block carries a non-default threshold. */
const withSelfcheck = (patch: (block: NonNullable<Rulepack['selfcheck']>) => void): Rulepack => {
  const pack = structuredClone(rulepack) as Rulepack
  patch(pack.selfcheck!)
  return pack
}

/** Neutral prose that trips none of the self-check rules. */
const CLEAN = [
  '风从窗缝里挤进来，把桌上的纸吹得翻了一页。他伸手压住，指腹沾了一点灰。',
  '走廊尽头传来脚步声，不快不慢，在门口停了两秒。他没有抬头，只把笔帽扣紧。',
  '门开了一条缝，外面的人没有进来，先递进来一只牛皮纸袋，边角磨得发白。',
].join('\n\n')

/* ------------------------------------------- 1. tone-hit paragraph numbering */

describe('P2: AI-tone findings use non-empty paragraph numbering', () => {
  it('reports the paragraph the phrase is in, not the blank line between paragraphs', () => {
    // Two paragraphs separated by a blank line. The old counter walked `\n`,
    // so the phrase in paragraph 2 was reported as paragraph 3.
    const text = '他推开门，楼道里的灯闪了两下。\n\n他说：“这句话稳。”'
    const tone = collectToneHits(text, rulepack.lexicon.ai_tone!)
    expect(tone).toHaveLength(1)
    expect(tone[0]!.paragraph).toBe(2)
    const found = hits(text, 'AI_TONE_META')
    expect(found).toHaveLength(1)
    expect(found[0]!.location.paragraph).toBe(2)
  })
})

/* --------------------------------------- 2. dialogue across all quote styles */

describe('P2: dialogue detection knows every legal quote family', () => {
  it('counts 「」 and curly quotes as quoted characters', () => {
    expect(dialogueCharacterRatio('「稳住心神，别慌。」')).toBeGreaterThanOrEqual(0.6)
    expect(dialogueCharacterRatio('“稳住心神，别慌。”')).toBeGreaterThanOrEqual(0.6)
    expect(dialogueCharacterRatio('他稳住呼吸，继续往前。')).toBe(0)
  })

  it('classifies a tone hit inside 「」 as dialogue', () => {
    const tone = collectToneHits('「这句话稳。」', rulepack.lexicon.ai_tone!)
    expect(tone).toHaveLength(1)
    expect(tone[0]!.inDialogue).toBe(true)
    expect(tone[0]!.severity).toBe('advisory')
  })

  it('doubles a dash inside 「」 like it does inside an ASCII quote', () => {
    const found = hits('「甲——乙——丙——丁——戊。」', 'DASH_BUDGET')
    expect(found).toHaveLength(1)
    expect(found[0]!.detail).toContain('dialogue 4x double')
  })
})

/* ------------------------------------------------ 3. 顿号 threshold boundary */

describe('P2: 顿号 enumeration fires at eight items (seven separators)', () => {
  it('stays silent at seven items (six separators)', () => {
    // docs/selfcheck.md S5: 7 separators (8 items) is the checklist habit;
    // the code used to fire one separator early.
    const sevenItems = '他买了米、面、油、盐、酱、醋、茶。'
    expect(sevenItems.split('、')).toHaveLength(7)
    expect(codes(sevenItems).has('ENUMERATION')).toBe(false)
  })

  it('reports at eight items (seven separators)', () => {
    const eightItems = '他买了米、面、油、盐、酱、醋、茶、糖。'
    expect(eightItems.split('、')).toHaveLength(8)
    expect(hits(eightItems, 'ENUMERATION')).toHaveLength(1)
  })
})

/* ----------------------------------------------- 4. S5 system-panel exemption */

describe('P2: the S5 system-panel exemption covers every list shape', () => {
  it('exempts an ordinal run inside a system-label paragraph', () => {
    const text = 'Day 3 记录。第一，取回账本。第二，清点银两。第三，封好门窗。'
    expect(codes(text).has('ENUMERATION')).toBe(false)
  })

  it('exempts a 顿号 list inside a 【】 paragraph', () => {
    const text = '【刀、剑、枪、棍、绳、鞭、盾、弓。】'
    expect(codes(text).has('ENUMERATION')).toBe(false)
  })

  it('still reports the same shapes outside a panel', () => {
    expect(codes('第一，取回账本。第二，清点银两。第三，封好门窗。').has('ENUMERATION')).toBe(true)
    expect(codes('刀、剑、枪、棍、绳、鞭、盾、弓。').has('ENUMERATION')).toBe(true)
  })
})

/* ------------------------------------------- 5. speech attributions are not keys */

describe('P2: a speech attribution is not a 短名词 list key', () => {
  it('stays silent on three lines that only attribute speech', () => {
    const text = ['他说：走吧。', '她说：不去。', '他低声道：等一下。'].join('\n\n')
    expect(codes(text).has('ENUMERATION')).toBe(false)
  })

  it('still reports a real short-noun key block', () => {
    const text = ['账本：三万七。', '名字：没有。', '归期：不知。'].join('\n\n')
    expect(hits(text, 'ENUMERATION')).toHaveLength(1)
  })
})

/* ------------------------------------------------- 6. degenerate frame patterns */

describe('P2: a frame needs a literal on both sides of its gap', () => {
  const compileWithFrames = (frames: unknown[]): (() => unknown) => {
    const draft = structuredClone(rawPack)
    draft.selfcheck.frames = frames
    return () => compileRulepack(draft)
  }

  it('rejects the wildcard-only pattern', () => {
    expect(compileWithFrames([{ pattern: '……', max: 1 }])).toThrow(/literal on both sides/)
  })

  it('rejects a one-sided frame', () => {
    expect(compileWithFrames([{ pattern: '不是……', max: 1 }])).toThrow(/literal on both sides/)
    expect(compileWithFrames([{ pattern: '……而是', max: 1 }])).toThrow(/literal on both sides/)
  })

  it('still accepts the shipped two-sided frames including a trailing gap', () => {
    expect(compileWithFrames([{ pattern: '不是……而是……', max: 1 }])).not.toThrow()
    expect(compileWithFrames([{ pattern: '当……的时候', max: 2 }])).not.toThrow()
  })
})

/* --------------------------------------------- 7. one separator, one finding */

describe('P2: one separator paragraph produces one SCENE_SEPARATOR', () => {
  it('does not double-report a configured separator paragraph', () => {
    const text = `${CLEAN}\n\n…………\n\n他推开门。`
    const found = hits(text, 'SCENE_SEPARATOR')
    expect(found).toHaveLength(1)
    // The configured matcher is the more specific owner of the same paragraph.
    expect(found[0]!.detail).toContain('contains scene separator')
  })

  it('keeps reporting an ellipsis-only paragraph the pack does not configure', () => {
    const found = hits(`${CLEAN}\n\n……\n\n他推开门。`, 'SCENE_SEPARATOR')
    expect(found).toHaveLength(1)
    expect(found[0]!.detail).toContain('整段只有')
  })
})

/* ------------------------------------------- 8. C8 coverage is per paragraph */

describe('P1: C8 does not hide a narration occurrence behind a dialogue hit', () => {
  const c8Pack = (): Rulepack => {
    const pack = structuredClone(rulepack) as Rulepack
    pack.lexicon.zero_tolerance = [
      ...pack.lexicon.zero_tolerance,
      { term: '稳住', dialogueExempt: true, note: 'review probe' },
    ]
    pack.lexicon.ai_tone!.entries.push({
      id: 'AI-C8-PROBE',
      category: 'meta_commentary',
      match: 'exact',
      terms: ['稳住心神'],
      severity: 'advisory',
      scope: 'any',
    })
    return pack
  }

  it('keeps the zero-tolerance blocker for the narration occurrence', () => {
    // The tone hit covers only the dialogue occurrence. The eligible (narration)
    // count must not subtract it: the old chapter-wide coverage made 1 - 1 = 0.
    const text = '他稳住呼吸，继续往前。\n\n"稳住心神，别慌。"'
    const pack = c8Pack()
    const found = hits(text, 'LEX_ZERO_TOLERANCE', { rulepack: pack })
    expect(found).toHaveLength(1)
    expect(found[0]!.severity).toBe('blocker')
    expect(found[0]!.location.paragraph).toBe(1)
    expect(found[0]!.detail).toContain('稳住')
  })

  it('still lets a tone span claim an occurrence in its own paragraph', () => {
    const text = '他稳住心神，继续往前。'
    const pack = c8Pack()
    expect(codes(text, { rulepack: pack }).has('LEX_ZERO_TOLERANCE')).toBe(false)
  })
})

/* ------------------------------------------ 9. category codes must be implemented */

describe('P2: an AI-tone category code without a rule is refused', () => {
  it('rejects an AI_TONE_* code the engine does not implement', () => {
    const draft = structuredClone(rawPack)
    draft.lexicon.ai_tone.categories.ghost_category = {
      code: 'AI_TONE_GHOST',
      default_severity: 'advisory',
      default_scope: 'any',
      limit: 1,
      window: 1000,
      escalation: 'none',
    }
    expect(() => compileRulepack(draft)).toThrow(/AI_TONE_GHOST/)
    expect(() => compileRulepack(draft)).toThrow(/AI_TONE_META/)
  })
})

/* ---------------------------------------- 10. curly mode still pairs ASCII quotes */

describe('P2: curly mode still reports an unpaired straight quote', () => {
  it('emits both ILLEGAL_QUOTE and QUOTE_UNBALANCED', () => {
    const found = codes('"你来了。', { quotes: 'curly' })
    expect(found.has('ILLEGAL_QUOTE')).toBe(true)
    expect(found.has('QUOTE_UNBALANCED')).toBe(true)
  })
})

/* --------------------------------- 11. max_stacks_per_paragraph is a real threshold */

describe('P2: max_stacks_per_paragraph decides when a paragraph is reported', () => {
  const single = '她的眼睛像两口井，像两潭死水。'
  const double = '她的眼睛像两口井，像两潭死水。那声音像钝刀，像铁皮在刮。'

  it('reports one stacked sentence at the default threshold', () => {
    expect(hits(single, 'METAPHOR_STACK')).toHaveLength(1)
  })

  it('lets a raised threshold tolerate one stacked sentence', () => {
    // This value was inert: the old code only fed already-over sentences into
    // the paragraph bucket, so `stacked >= 2` could never suppress anything.
    const tolerant = withSelfcheck((block) => {
      block.metaphor.max_stacks_per_paragraph = 2
    })
    expect(codes(single, { rulepack: tolerant }).has('METAPHOR_STACK')).toBe(false)
    expect(hits(double, 'METAPHOR_STACK', { rulepack: tolerant })).toHaveLength(1)
  })

  it('a threshold of three tolerates two stacked sentences', () => {
    const stricter = withSelfcheck((block) => {
      block.metaphor.max_stacks_per_paragraph = 3
    })
    expect(codes(double, { rulepack: stricter }).has('METAPHOR_STACK')).toBe(false)
  })
})
