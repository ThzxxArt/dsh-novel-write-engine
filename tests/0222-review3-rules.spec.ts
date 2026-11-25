import { describe, expect, it } from 'vitest'
import { loadRulepack } from '../src/rulepack.js'
import { runMachineChecks, type MachineOptions } from '../src/rules/pipeline.js'
import type { Rulepack, StylePack } from '../src/rules/types.js'
import { compileStylePack } from '../src/rules/style.js'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

/**
 * 0.2.20 third review round — prose rules.
 *
 * Each case is a legal Chinese sentence that the shipped rules judged wrong, or
 * a shape the rules could never see. The rulepack is the shipped one; the only
 * patched packs are the ones a case needs to prove a config knob works.
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

const patchPack = (patch: (pack: Rulepack) => void): Rulepack => {
  const clone = structuredClone(rulepack)
  patch(clone)
  return clone
}

const timeline = (rows: Array<{ chapter: number; story_time: string }>) => ({
  schema_version: 1 as const,
  next_seq: rows.length + 1,
  items: rows.map((row, index) => ({
    id: `TE-${index + 1}`,
    chapter: row.chapter,
    story_time: row.story_time,
    description: `事件 ${index + 1}`,
    location: '屋里',
    characters: ['周慎'],
  })),
})

describe('SC-QUOTE: a quotation that spans paragraphs', () => {
  it('accepts the GB/T form where the next paragraph re-opens with a half-width quote', () => {
    // 段 1 开引号、段 2 以同一引号续引、段末闭合。逐段数奇偶会把段 1 判成缺陷。
    const text = '"我知道你在想什么。\n\n"但我不在乎。"'
    expect(codes(text).has('QUOTE_UNBALANCED')).toBe(false)
  })

  it('still blocks a quotation that never closes', () => {
    expect(codes('他说："走吧。').has('QUOTE_UNBALANCED')).toBe(true)
    const text = '"他没说话。\n\n"他走了。'
    expect(codes(text).has('QUOTE_UNBALANCED')).toBe(true)
  })

  it('accepts a balanced pair inside one paragraph', () => {
    expect(codes('"走吧。"他说，"我不送了。"').has('QUOTE_UNBALANCED')).toBe(false)
  })
})

describe('META_NARRATION: line_start must respect excludeRight', () => {
  it('does not flag 话说得 / 话说清楚 as storytelling filler', () => {
    expect(codes('话说得漂亮不等于事情办得成。').has('META_NARRATION')).toBe(false)
    expect(codes('话说清楚，别让人猜。').has('META_NARRATION')).toBe(false)
  })

  it('still flags the real transition at the start of a paragraph', () => {
    expect(codes('话说那年冬天，雪下得很大。').has('META_NARRATION')).toBe(true)
  })
})

describe('SC-METAPHOR: 好像 is a simile marker', () => {
  it('counts two 好像 similes in one sentence as a stack', () => {
    const text = '他好像一只被踩了尾巴的猫，又好像一口深不见底的井。'
    expect(hits(text, 'METAPHOR_STACK')).toHaveLength(1)
  })

  it('leaves compound words alone', () => {
    expect(codes('好像是这样的，画像挂在墙上，他偶像的照片。').has('METAPHOR_STACK')).toBe(false)
  })
})

describe('LEX_ZERO_TOLERANCE: one span, one finding', () => {
  it('does not report 显而易见 and 显而易见地 for the same span', () => {
    expect(hits('他显而易见地没有听懂。', 'LEX_ZERO_TOLERANCE')).toHaveLength(1)
  })

  it('does not report 与此同时 and 与此同时的 for the same span', () => {
    expect(hits('与此同时的雨声盖过了脚步。', 'LEX_ZERO_TOLERANCE')).toHaveLength(1)
  })
})

describe('SYSTEM_LABEL: a game panel is in-story text', () => {
  it('does not flag a label inside a 【】 panel', () => {
    const text = '【Day 3 · 剩余时间 12:00】\n\n他把提示关掉。'
    expect(codes(text).has('SYSTEM_LABEL')).toBe(false)
  })

  it('still flags a bare out-of-story label in prose', () => {
    expect(codes('Day 3 的记录被他撕了。').has('SYSTEM_LABEL')).toBe(true)
  })
})

describe('PUNCT_STANDARD: ranges keep their tilde', () => {
  it('does not flag 3～5 as an odd symbol', () => {
    expect(codes('他说最多 3～5 天就能回来。').has('PUNCT_STANDARD')).toBe(false)
  })

  it('still flags a decorative tilde in prose', () => {
    expect(codes('他笑了~').has('PUNCT_STANDARD')).toBe(true)
  })
})

describe('FRAME_REPEAT: a two-character exclude works', () => {
  it('honours a two-character opener in opening_repeat.exclude', () => {
    const pack = patchPack((clone) => {
      clone.selfcheck!.opening_repeat.exclude = ['雨点']
    })
    const text = '雨点打在瓦上。\n\n雨点顺着屋檐往下流。\n\n雨点把门槛打湿了。'
    expect(codes(text, { rulepack: pack }).has('FRAME_REPEAT')).toBe(false)
  })
})

describe('ENUMERATION: every run is reported', () => {
  it('reports two separate ordinal runs in one chapter', () => {
    const text =
      '第一，取回账本。第二，清点银两。第三，封好门窗。\n\n他坐下来喝了一口水，把杯子放回桌上。\n\n' +
      '第一，查账。第二，对印。第三，封库。'
    expect(hits(text, 'ENUMERATION')).toHaveLength(2)
  })
})

describe('CONCLUSION_FIRST: cause before effect is ordinary prose', () => {
  it('does not flag 觉得…所以…', () => {
    expect(codes('他觉得冷，所以把窗关上了。').has('CONCLUSION_FIRST')).toBe(false)
  })

  it('still flags a judgement followed by its reason', () => {
    expect(codes('他感到恐惧，因为他知道那意味着什么。').has('CONCLUSION_FIRST')).toBe(true)
  })
})

describe('TIME_REGRESSION: the ledger may write Chinese numerals', () => {
  it('sees 第三日 in the manuscript against 第十日 in the ledger', () => {
    const overrides = base({
      chapter: 5,
      evidence: {
        ...base().evidence,
        timeline: timeline([{ chapter: 5, story_time: '第十日 夜里' }]),
      },
    })
    const found = runMachineChecks('第三日的雨还没停，他出了门。', overrides).violations.find(
      (violation) => violation.code === 'TIME_REGRESSION',
    )
    expect(found).toBeDefined()
  })
})

describe('STYLE_PARAGRAPH_CHARS: the guard compares one unit', () => {
  const packOf = (maxChars: number): StylePack => {
    const pack = compileStylePack(
      parse(readFileSync(new URL('../stylepacks/cold-suspense.yaml', import.meta.url), 'utf8')),
      { fileId: 'cold-suspense', zeroTolerance: rulepack.lexicon.zero_tolerance.map((e) => e.term) },
    ).pack
    return { ...pack, paragraph: { ...pack.paragraph, max_chars: maxChars } }
  }
  // 100 CJK characters plus 30 punctuation marks: 130 non-space characters but
  // only 100 words, so the global rule (limit 150 words) stays quiet.
  const paragraph = `${Array.from({ length: 22 }, () => '雨'.repeat(5)).join('，')}。`

  it('speaks when only the pack limit is exceeded', () => {
    expect(codes(paragraph, { style: packOf(120) }).has('STYLE_PARAGRAPH_CHARS')).toBe(true)
  })

  it('stays quiet when the global blocker already owns the paragraph', () => {
    const long = '雨'.repeat(400)
    const found = codes(`${long}。`, { style: packOf(120) })
    expect(found.has('LONG_PARAGRAPH')).toBe(true)
    expect(found.has('STYLE_PARAGRAPH_CHARS')).toBe(false)
  })
})
