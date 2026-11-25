import { describe, expect, it } from 'vitest'
import { loadRulepack } from '../src/rulepack.js'
import { ruleRegistry, runMachineChecks, type MachineOptions } from '../src/rules/pipeline.js'
import { loadStyleCatalogue } from '../src/stylepack.js'
import type { Rulepack } from '../src/rules/types.js'

/**
 * 0.2.19 WP0/WP1 — the thirteen submission self-check items as executable rules.
 *
 * Every case is the plan's own acceptance example plus the false-positive
 * boundary it names. The eleven new codes are gated on `rulepack.selfcheck`:
 * a pack without the block keeps producing exactly the pre-0.2.19 output.
 */

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

const codes = (text: string, overrides: Partial<MachineOptions> = {}): Set<string> =>
  new Set(runMachineChecks(text, base(overrides)).violations.map((violation) => violation.code))

const hits = (text: string, code: string, overrides: Partial<MachineOptions> = {}) =>
  runMachineChecks(text, base(overrides)).violations.filter((violation) => violation.code === code)

/** Severity of the first finding for `code`, or undefined when it did not fire. */
const severity = (text: string, code: string, overrides: Partial<MachineOptions> = {}): string | undefined =>
  hits(text, code, overrides)[0]?.severity

const withSelfcheck = (patch: (block: NonNullable<Rulepack['selfcheck']>) => void): Rulepack => {
  const block = structuredClone(rulepack.selfcheck!)
  patch(block)
  return { ...rulepack, selfcheck: block }
}

/** Prose that satisfies the thirteen items; the baseline every negative case extends. */
const CLEAN = [
  '风从窗缝里挤进来，把桌上的纸吹得翻了一页。他伸手压住，指腹沾了一点灰。',
  '走廊尽头传来脚步声，不快不慢，在门口停了两秒。他没有抬头，只把笔帽扣紧。',
  '门开了一条缝，外面的人没有进来，先递进来一只牛皮纸袋，边角磨得发白。',
].join('\n\n')

describe('S1 SC-METAPHOR · METAPHOR_STACK', () => {
  it('reports two similes stacked in one sentence', () => {
    expect(hits('她的眼睛像两口井，像两潭死水。', 'METAPHOR_STACK')).toHaveLength(1)
  })

  it('reports the stack at the paragraph it belongs to', () => {
    const text = ['他坐下。', '她的眼睛像两口井，像两潭死水。'].join('\n\n')
    expect(hits(text, 'METAPHOR_STACK')[0]!.location.paragraph).toBe(2)
  })

  it('stays silent for compounds that are not similes', () => {
    expect(codes('好像是这样的，画像挂在墙上，他偶像的照片。').has('METAPHOR_STACK')).toBe(false)
  })

  it('stays silent when two sentences in one paragraph each carry one simile', () => {
    // Boundary: one per sentence is not a stack, and one stacked sentence per
    // paragraph is below max_stacks_per_paragraph.
    const text = '她的眼睛像两口井。他的手像砂纸，磨得她腕子发红。'
    expect(codes(text).has('METAPHOR_STACK')).toBe(false)
  })

  it('reports a paragraph where several sentences each stack', () => {
    const text = '她的眼睛像两口井，像两潭死水。那声音像钝刀，像铁皮在刮。他站着像根木桩，像插进地里。'
    expect(hits(text, 'METAPHOR_STACK')).toHaveLength(1)
  })

  it('is advisory: a stack never blocks archiving', () => {
    expect(severity('她的眼睛像两口井，像两潭死水。', 'METAPHOR_STACK')).toBe('advisory')
  })

  it('stays silent when the pack has no selfcheck block', () => {
    // A 0.2.18 pack has no block; deleting it from a clone is the honest way to
    // simulate one, because the shipped pack now always carries it.
    const legacy = structuredClone(rulepack) as Rulepack
    delete legacy.selfcheck
    expect(codes('她的眼睛像两口井，像两潭死水。', { rulepack: legacy }).size).toBeGreaterThan(0)
    expect(codes('她的眼睛像两口井，像两潭死水。', { rulepack: legacy }).has('METAPHOR_STACK')).toBe(false)
  })
})

describe('S2 SC-CONCRETE · PROSE_ABSTRACT', () => {
  it('reports a paragraph of abstractions with no sensory anchor', () => {
    expect(hits('空气里有一种说不清的气氛，整个人的状态都变得很微妙。', 'PROSE_ABSTRACT')).toHaveLength(1)
  })

  it('stays silent when the abstraction is carried by a body or an object', () => {
    expect(codes('他摸到桌沿，凉的，有一层灰。').has('PROSE_ABSTRACT')).toBe(false)
  })

  it('skips a dialogue-dominant paragraph', () => {
    const text = '"气氛不对，状态也不对，你感觉不到？"他说。'
    expect(codes(text).has('PROSE_ABSTRACT')).toBe(false)
  })

  it('needs at least two abstract nouns, not one', () => {
    expect(codes('屋里的气氛有点冷，他关上了窗。').has('PROSE_ABSTRACT')).toBe(false)
  })

  it('stays silent once the paragraph carries a sensory word', () => {
    const text = '空气里有一种说不清的气氛，整个人的状态都变得很微妙，他闻到了铁锈味。'
    expect(codes(text).has('PROSE_ABSTRACT')).toBe(false)
  })
})

describe('S3 SC-FORMULA · FRAME_REPEAT', () => {
  it('reports two 不是……而是…… frames in one paragraph', () => {
    const text = '他不是要钱，而是要命。他不是怕死，而是怕疼。'
    expect(hits(text, 'FRAME_REPEAT')).toHaveLength(1)
  })

  it('allows a single frame in a paragraph', () => {
    const text = '他不是来吃饭的，而是来问一句话。'
    expect(codes(text + '\n\n他坐下，把帽子放在桌上。').has('FRAME_REPEAT')).toBe(false)
  })

  it('allows the same frame once in each of two paragraphs', () => {
    // The window is the paragraph: one use per paragraph is ordinary prose.
    const text = ['他不是来吃饭的，而是来问一句话。', '她不是怕黑，而是怕有人站在门后。'].join('\n\n')
    expect(codes(text).has('FRAME_REPEAT')).toBe(false)
  })

  it('reports a repeated two-character opener across the chapter', () => {
    const text = ['门外有人敲门。', '门外传来脚步声。', '门外站着一个孩子。'].join('\n\n')
    expect(hits(text, 'FRAME_REPEAT')).toHaveLength(1)
  })

  it('does not count pronoun openers', () => {
    const text = ['他把门推开。', '他把伞收起来。', '他把杯子放回去。'].join('\n\n')
    expect(codes(text).has('FRAME_REPEAT')).toBe(false)
  })

  it('is advisory', () => {
    expect(severity('他不是要钱，而是要命。他不是怕死，而是怕疼。', 'FRAME_REPEAT')).toBe('advisory')
  })

  it('hands the same formula over to the style pack that already bans it', () => {
    // C8 / plan §8 S3: 不是……而是…… is in every bundled pack's banned list. The
    // style rule owns that span (and its replacement advice), so the checklist
    // rule must not report the same paragraph a second time.
    const pack = loadStyleCatalogue().packs.find((candidate) => candidate.id === 'cold-suspense')!
    expect(pack.banned_patterns).toContain('不是……而是……')
    const text = '他不是要钱，而是要命。他不是怕死，而是怕疼。'
    expect(codes(text, { style: pack }).has('FRAME_REPEAT')).toBe(false)
    expect(codes(text, { style: pack }).has('STYLE_BANNED_PATTERN')).toBe(true)
  })

  it('still reports a frame no pack bans', () => {
    const pack = loadStyleCatalogue().packs.find((candidate) => candidate.id === 'cold-suspense')!
    const text = '如果说他要钱，那么他就要命。如果说他怕死，那么他更怕疼。'
    expect(codes(text, { style: pack }).has('FRAME_REPEAT')).toBe(true)
  })
})

describe('S4 SC-PARALLEL · PARALLEL_RUN', () => {
  it('reports three sentences sharing a verb frame', () => {
    // 0.2.20 WP5 changed what "same shape" means: a repeated *subject* is
    // staccato narration, a repeated two-character verb frame is 排比.
    expect(hits('看见血。看见火。看见门。', 'PARALLEL_RUN')).toHaveLength(1)
  })

  it('stays silent when the sentences repeat their subject', () => {
    expect(codes('他走。他停。他看。').has('PARALLEL_RUN')).toBe(false)
    // A name is a subject too: the shared head is looked up in the cast ledger.
    const ledger = {
      schema_version: 1 as const,
      characters: [
        {
          name: '老屠',
          role: '配角' as const,
          first_appearance: 1,
          profile: {},
          current_state: {},
          growth: [],
          updated_at: 1,
        },
      ],
    }
    const withCast: Partial<MachineOptions> = {
      evidence: { ...base().evidence, characters: ledger },
    }
    expect(codes('老屠放下刀。老屠解了围裙。老屠掩上门。', withCast).has('PARALLEL_RUN')).toBe(false)
  })

  it('stays silent when the shapes differ', () => {
    expect(codes('他走。风停了。远处有人在喊。').has('PARALLEL_RUN')).toBe(false)
  })

  it('counts a one-sentence-per-paragraph run across paragraphs', () => {
    // This is the half `UNIFORM_SENTENCE` cannot see: its window is one paragraph.
    const text = ['他走了。', '他停了。', '他看了。'].join('\n\n')
    expect(hits(text, 'PARALLEL_RUN')).toHaveLength(1)
  })

  it('requires the third paragraph before it speaks', () => {
    const text = ['他走了。', '他停了。'].join('\n\n')
    expect(codes(text).has('PARALLEL_RUN')).toBe(false)
  })

  it('skips dialogue-dominant paragraphs', () => {
    const text = '"你走。"\n"你停。"\n"你看。"'
    expect(codes(text).has('PARALLEL_RUN')).toBe(false)
  })

  it('asks for one more line in an action chapter', () => {
    // 连击短句是动作章的风格，不是缺陷：min_run + 1.
    const three = ['他走了。', '他停了。', '他看了。'].join('\n\n')
    const four = ['他走了。', '他停了。', '他看了。', '他退了。'].join('\n\n')
    expect(codes(three, { sceneType: '战斗/动作章' }).has('PARALLEL_RUN')).toBe(false)
    expect(codes(four, { sceneType: '战斗/动作章' }).has('PARALLEL_RUN')).toBe(true)
  })

  it('honours a raised min_run from the pack', () => {
    const pack = withSelfcheck((block) => {
      block.parallel.min_run = 4
    })
    expect(codes('他走。他停。他看。', { rulepack: pack }).has('PARALLEL_RUN')).toBe(false)
  })
})

describe('S5 SC-LIST · ENUMERATION', () => {
  it('reports three ordinal-led sentences in a row', () => {
    expect(hits('第一，他要钱。第二，他要命。第三，他还要脸。', 'ENUMERATION')).toHaveLength(1)
  })

  it('stays silent for ordinary sequencing prose', () => {
    expect(codes('他先要钱，再要命。').has('ENUMERATION')).toBe(false)
  })

  it('reports a long 顿号 list of short items', () => {
    // Seven items (six separators) is a list habit; six items is an inventory.
    expect(hits('他买了米、面、油、盐、酱、醋、茶、糖。', 'ENUMERATION')).toHaveLength(1)
  })

  it('allows a short 顿号 list', () => {
    expect(codes('他买了米、面、油。').has('ENUMERATION')).toBe(false)
    expect(codes('架子上摆着刀、剑、枪、棍、绳、鞭。').has('ENUMERATION')).toBe(false)
  })

  it('reports three paragraphs shaped like 短名词：说明', () => {
    const text = ['账本：三万七。', '名字：没有。', '归期：不知。'].join('\n\n')
    expect(hits(text, 'ENUMERATION')).toHaveLength(1)
  })

  it('exempts a system panel paragraph in 【】', () => {
    const text = ['【任务：取回账本】', '【奖励：三百铜钱】', '【期限：三日】'].join('\n\n')
    expect(codes(text).has('ENUMERATION')).toBe(false)
  })

  it('is advisory', () => {
    expect(severity('第一，他要钱。第二，他要命。第三，他还要脸。', 'ENUMERATION')).toBe('advisory')
  })
})

describe('S6 SC-DIALOGUE-BEAT · DIALOGUE_RUN', () => {
  const quoted = (line: string): string => `"${line}"`
  const LINES = [
    '我今晚不走了，你先睡吧。',
    '那我把灯留着。',
    '不用，你别等我。',
    '好，那我先睡。',
    '门别锁。',
    '水在灶上。',
  ]

  it('reports six quoted paragraphs with no narration between them', () => {
    const text = LINES.map(quoted).join('\n\n')
    expect(hits(text, 'DIALOGUE_RUN')).toHaveLength(1)
  })

  it('counts an action beat between two lines as interspersed', () => {
    const text = [
      ...LINES.slice(0, 3).map(quoted),
      '他把外套搭在椅背上。',
      ...LINES.slice(3).map(quoted),
    ].join('\n\n')
    expect(codes(text).has('DIALOGUE_RUN')).toBe(false)
  })

  it('needs six lines, not four', () => {
    // WP7: on the real manuscript a 4-line threshold reported 3.94% of
    // paragraphs; six keeps it at 1.42% and still catches a real ping-pong run.
    const text = LINES.slice(0, 4).map(quoted).join('\n\n')
    expect(codes(text).has('PARALLEL_RUN')).toBe(false)
    expect(codes(text).has('DIALOGUE_RUN')).toBe(false)
  })

  it('is advisory', () => {
    expect(severity(LINES.map(quoted).join('\n\n'), 'DIALOGUE_RUN')).toBe('advisory')
  })
})

describe('S7 SC-DASH · DASH_BUDGET stays the only owner', () => {
  it('reports a chapter over the dash budget', () => {
    const text = ['他——是——谁。', '不——是——他。', '谁——在——门口。', '也——不——知道。'].join('\n\n')
    expect(hits(text, 'DASH_BUDGET').length).toBeGreaterThan(0)
  })

  it('stays silent well under the budget', () => {
    expect(codes(CLEAN).has('DASH_BUDGET')).toBe(false)
  })
})

describe('S8 SC-QUOTE · QUOTE_UNBALANCED', () => {
  it('reports an unclosed straight quote as a blocker', () => {
    expect(severity('他说："走吧。', 'QUOTE_UNBALANCED')).toBe('blocker')
  })

  it('stays silent when the quotes pair up', () => {
    expect(codes('他说："走吧。"\n\n她没动。').has('QUOTE_UNBALANCED')).toBe(false)
  })

  it('judges each paragraph on its own', () => {
    const text = ['他说："走吧。"', '她把门关上。"'].join('\n\n')
    expect(hits(text, 'QUOTE_UNBALANCED')).toHaveLength(1)
    expect(hits(text, 'QUOTE_UNBALANCED')[0]!.location.paragraph).toBe(2)
  })

  it('leaves curly quotes to ILLEGAL_QUOTE', () => {
    const text = '他说：“走吧。”'
    expect(codes(text).has('ILLEGAL_QUOTE')).toBe(true)
    expect(codes(text).has('QUOTE_UNBALANCED')).toBe(false)
  })

  it('ignores apostrophes and the CJK corner brackets it does not own', () => {
    expect(codes("it's fine，don't worry。").has('QUOTE_UNBALANCED')).toBe(false)
  })
})

describe('S9 SC-PUNCT · PUNCT_STANDARD', () => {
  it('reports a half-width comma between Chinese characters as a blocker', () => {
    expect(severity('他说,走吧。', 'PUNCT_STANDARD')).toBe('blocker')
  })

  it('reports a half-width full stop between Chinese characters', () => {
    expect(hits('他推开门.屋里没人。', 'PUNCT_STANDARD')).toHaveLength(1)
  })

  it('exempts numbers, decimals, percentages, thousands separators and acronyms', () => {
    const exempt = [
      '他身高 1.85 米，体重 72 公斤。',
      '气温 3.5% 的涨幅可以忽略。',
      '账上还剩 10,000 元。',
      '他叫 U.S. Grant。',
      '型号是 A/B 两种。',
      'The quick brown fox jumps over the lazy dog.',
    ]
    for (const text of exempt) {
      expect({ text, codes: [...codes(text)].filter((code) => code === 'PUNCT_STANDARD') }).toEqual({
        text,
        codes: [],
      })
    }
  })

  it('reports an ASCII space between two Chinese characters', () => {
    expect(hits('他 推开门，屋里没人。', 'PUNCT_STANDARD')).toHaveLength(1)
  })

  it('reports a leading ASCII space on a paragraph', () => {
    expect(hits(' 他推开门，屋里没人。', 'PUNCT_STANDARD')).toHaveLength(1)
  })

  it('allows a single U+3000 indent', () => {
    expect(codes('\u3000\u3000他推开门，屋里没人。').has('PUNCT_STANDARD')).toBe(false)
  })

  it('reports decorative symbols', () => {
    expect(hits('他笑了~', 'PUNCT_STANDARD')).toHaveLength(1)
    expect(hits('他转过身★', 'PUNCT_STANDARD')).toHaveLength(1)
  })

  it('leaves 【】 to the system-panel owner', () => {
    expect(codes('【任务：取回账本】\n\n他接过来。').has('PUNCT_STANDARD')).toBe(false)
  })

  it('does not double-report a paragraph twice for the same defect class', () => {
    expect(hits('他说,走吧.真的。', 'PUNCT_STANDARD')).toHaveLength(1)
  })
})

describe('S10 SC-PARAGRAPH · LONG_PARAGRAPH and SHORT_PARAGRAPH', () => {
  /** Seven characters or more: the stub rule must not fire on the control line. */
  const CONTROL = '他把门关上，屋里彻底黑了。'
  /** Three consecutive stubs: one four-character line is a beat, three is a habit. */
  const RUN = ['他走了。', '灯灭了。', '雨停了。'].join('\n\n')

  it('reports a run of three three-word paragraphs once', () => {
    expect(hits(`${RUN}\n\n${CONTROL}`, 'SHORT_PARAGRAPH')).toHaveLength(1)
  })

  it('names the first paragraph of the run', () => {
    expect(hits(`${CONTROL}\n\n${RUN}`, 'SHORT_PARAGRAPH')[0]!.location.paragraph).toBe(2)
  })

  it('does not report a single short paragraph', () => {
    // WP7: on the real manuscript a per-paragraph rule hit 2.97% of paragraphs,
    // because one short line is a deliberate beat.
    expect(codes(`他走了。\n\n${CONTROL}`).has('SHORT_PARAGRAPH')).toBe(false)
  })

  it('does not count a short dialogue line towards the run', () => {
    const text = ['他走了。', '"走。"', '灯灭了。'].join('\n\n')
    expect(codes(`${text}\n\n${CONTROL}`).has('SHORT_PARAGRAPH')).toBe(false)
  })

  it('does not report a seven-character paragraph', () => {
    const run = ['他推开门走了。', '他把灯关了。', '他把门锁上。'].join('\n\n')
    expect(codes(`${run}\n\n${CONTROL}`).has('SHORT_PARAGRAPH')).toBe(false)
  })

  it('keeps the existing long-paragraph blocker as the only upper bound', () => {
    // 0.2.20 D3: the bound is 150 CJK characters, punctuation excluded.
    const long = '他'.repeat(151) + '。'
    expect(severity(long, 'LONG_PARAGRAPH')).toBe('blocker')
    expect(codes(long).has('SHORT_PARAGRAPH')).toBe(false)
  })

  it('is advisory', () => {
    expect(severity(`${RUN}\n\n${CONTROL}`, 'SHORT_PARAGRAPH')).toBe('advisory')
  })
})

describe('S11 SC-LINEBREAK · MID_SENTENCE_BREAK', () => {
  it('reports a line broken after a comma', () => {
    const text = ['他把手放在门把上停了一会儿，', '里面没有人。'].join('\n\n')
    expect(hits(text, 'MID_SENTENCE_BREAK')).toHaveLength(1)
  })

  it('reports a line broken after a dash', () => {
    const text = ['他把手放在门把上停了一会儿——', '里面没有人。'].join('\n\n')
    expect(hits(text, 'MID_SENTENCE_BREAK')).toHaveLength(1)
  })

  it('stays silent when the next paragraph opens a new line of dialogue', () => {
    const text = ['他压低声音说，', '"别开门。"'].join('\n\n')
    expect(codes(text).has('MID_SENTENCE_BREAK')).toBe(false)
  })

  it('stays silent when the paragraph ends a sentence', () => {
    const text = ['他把手放在门把上停了一会儿。', '里面没有人。'].join('\n\n')
    expect(codes(text).has('MID_SENTENCE_BREAK')).toBe(false)
  })

  it('is advisory', () => {
    expect(
      severity(['他把手放在门把上停了一会儿，', '里面没有人。'].join('\n\n'), 'MID_SENTENCE_BREAK'),
    ).toBe('advisory')
  })
})

describe('S12 SC-CHAPTER-BREAK · CHAPTER_END_OPEN', () => {
  it('reports a chapter that ends on a comma', () => {
    expect(hits(`${CLEAN}\n\n他抬起头，`, 'CHAPTER_END_OPEN')).toHaveLength(1)
  })

  it('stays silent for a closed sentence', () => {
    expect(codes(CLEAN).has('CHAPTER_END_OPEN')).toBe(false)
  })

  it('accepts a closing quote, an exclamation and an ellipsis', () => {
    for (const ending of ['他抬起头。', '他抬起头！', '他抬起头…', '他说："走吧。"']) {
      const found = [...codes(`${CLEAN}\n\n${ending}`)].filter((code) => code === 'CHAPTER_END_OPEN')
      expect({ ending, found }).toEqual({ ending, found: [] })
    }
  })

  it('is advisory: the model still owns hook_strength', () => {
    expect(severity(`${CLEAN}\n\n他抬起头，`, 'CHAPTER_END_OPEN')).toBe('advisory')
  })
})

describe('S13 SC-TRANSITION · SCENE_SEPARATOR stays the only owner', () => {
  it('reports an ellipsis-only paragraph as a separator', () => {
    expect(severity(`${CLEAN}\n\n……\n\n他推开门。`, 'SCENE_SEPARATOR')).toBe('blocker')
  })

  it('reports a dash-only paragraph', () => {
    expect(codes(`${CLEAN}\n\n——\n\n他推开门。`).has('SCENE_SEPARATOR')).toBe(true)
  })

  it('stays silent for an ellipsis inside a sentence', () => {
    expect(codes('他想了想……最后还是没敲门。').has('SCENE_SEPARATOR')).toBe(false)
  })

  it('stays silent for a quoted ellipsis line', () => {
    expect(codes('"……"\n\n他推开门。').has('SCENE_SEPARATOR')).toBe(false)
  })
})

describe('the eleven new codes are owned, bounded and self-gated', () => {
  const NEW_CODES = [
    'METAPHOR_STACK',
    'PROSE_ABSTRACT',
    'FRAME_REPEAT',
    'PARALLEL_RUN',
    'ENUMERATION',
    'DIALOGUE_RUN',
    'QUOTE_UNBALANCED',
    'PUNCT_STANDARD',
    'SHORT_PARAGRAPH',
    'MID_SENTENCE_BREAK',
    'CHAPTER_END_OPEN',
  ]

  it('registers a rule implementation for each of the eleven codes', () => {
    // The registry refuses a second owner for one code, so `has` is the single
    // source of truth for "this code exists".
    for (const code of NEW_CODES) {
      expect({ code, owned: ruleRegistry().has(code) }).toEqual({ code, owned: true })
    }
  })

  it('keeps exactly two blocking codes and nine advisory ones', () => {
    expect(NEW_CODES.filter((code) => code === 'QUOTE_UNBALANCED' || code === 'PUNCT_STANDARD')).toEqual([
      'QUOTE_UNBALANCED',
      'PUNCT_STANDARD',
    ])
    expect(severity('他笑了~', 'PUNCT_STANDARD')).toBe('blocker')
    expect(severity('他说："走吧。', 'QUOTE_UNBALANCED')).toBe('blocker')
    expect(severity('看见血。看见火。看见门。', 'PARALLEL_RUN')).toBe('advisory')
    expect(severity('空气里有一种说不清的气氛，整个人的状态都变得很微妙。', 'PROSE_ABSTRACT')).toBe(
      'advisory',
    )
  })

  it('produces no new finding on the clean baseline', () => {
    // The engine's own false-positive floor: ordinary prose must stay quiet.
    const found = [...codes(CLEAN)].filter((code) => NEW_CODES.includes(code))
    expect(found).toEqual([])
  })

  it('stays entirely silent when the pack has no selfcheck block', () => {
    const legacy = structuredClone(rulepack) as Rulepack
    delete legacy.selfcheck
    const found = [...codes(CLEAN, { rulepack: legacy })].filter((code) => NEW_CODES.includes(code))
    expect(found).toEqual([])
  })

  it('produces none of the eleven codes on a pre-0.2.19 pack, trigger by trigger', () => {
    // The CLEAN baseline above cannot prove the gate: no rule fires on it either
    // way. Every string below is the positive fixture of one code from the
    // suites above, so this walks all eleven and the S13 extension.
    const legacy = structuredClone(rulepack) as Rulepack
    delete legacy.selfcheck
    const run = [
      '"我今晚不走了，你先睡吧。"',
      '"那我把灯留着。"',
      '"不用，你别等我。"',
      '"好，那我先睡。"',
      '"门别锁。"',
      '"水在灶上。"',
    ].join('\n\n')
    const triggers: Array<[string, string]> = [
      ['METAPHOR_STACK', '她的眼睛像两口井，像两潭死水。'],
      ['PROSE_ABSTRACT', '空气里有一种说不清的气氛，整个人的状态都变得很微妙。'],
      ['FRAME_REPEAT', '他不是要钱，而是要命。他不是怕死，而是怕疼。'],
      ['PARALLEL_RUN', '看见血。看见火。看见门。'],
      ['ENUMERATION', '第一，他要钱。第二，他要命。第三，他还要脸。'],
      ['DIALOGUE_RUN', run],
      ['QUOTE_UNBALANCED', '他说："走吧。'],
      ['PUNCT_STANDARD', '他笑了~'],
      ['SHORT_PARAGRAPH', ['他走了。', '灯灭了。', '雨停了。', '他把门关上，屋里彻底黑了。'].join('\n\n')],
      ['MID_SENTENCE_BREAK', ['他把手放在门把上停了一会儿，', '里面没有人。'].join('\n\n')],
      ['CHAPTER_END_OPEN', `${CLEAN}\n\n他抬起头，`],
    ]
    for (const [code, text] of triggers) {
      // The fixture is honest only if the current pack still reports it.
      expect({ code, current: [...codes(text)].includes(code) }).toEqual({ code, current: true })
      expect({ code, legacy: [...codes(text, { rulepack: legacy })].includes(code) }).toEqual({
        code,
        legacy: false,
      })
    }
    // S13 adds a trigger to an existing code instead of a new one; "output is
    // identical to 0.2.18" must cover that trigger too.
    const ellipsis = `${CLEAN}\n\n……\n\n他推开门。`
    expect([...codes(ellipsis)].includes('SCENE_SEPARATOR')).toBe(true)
    expect([...codes(ellipsis, { rulepack: legacy })].includes('SCENE_SEPARATOR')).toBe(false)
  })
})
