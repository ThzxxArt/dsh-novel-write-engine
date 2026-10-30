import { describe, expect, it } from 'vitest'
import { dedupeAdvisories, isExempt, runMachineChecks } from '../src/rules/pipeline.js'
import { loadRulepack } from '../src/rulepack.js'
import type { MachineOptions } from '../src/rules/pipeline.js'
import type { Violation } from '../src/types.js'

const pack = loadRulepack()
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

const codesOf = (text: string, overrides: Partial<MachineOptions> = {}): string[] =>
  runMachineChecks(text, options(overrides)).violations.map((violation) => violation.code)

describe('rule edge cases', () => {
  it('accepts a compliant title and rejects bodies outside 4..8 characters', () => {
    expect(codesOf('干净的正文。')).not.toContain('TITLE_FORMAT')
    expect(codesOf('干净的正文。', { title: '第1章 短' })).toContain('TITLE_FORMAT')
    expect(codesOf('干净的正文。', { title: '第1章 这是一个太长的章节标题' })).toContain('TITLE_FORMAT')
    expect(codesOf('干净的正文。', { title: '没有前缀' })).toContain('TITLE_FORMAT')
  })

  it('flags scene separators and keeps the dash budget when respected', () => {
    expect(codesOf('第一段。\n\n———\n\n第二段。')).toContain('SCENE_SEPARATOR')
    expect(codesOf('他说——然后走了——停下来。')).not.toContain('DASH_BUDGET')
  })

  it('flags an overlong ellipsis run', () => {
    expect(codesOf('他走了………………')).toContain('ELLIPSIS_RUN')
  })

  it('treats a regex metacharacter ellipsis token literally', () => {
    const custom = structuredClone(pack)
    custom.punctuation.ellipsis_run.token = '('
    expect(() => codesOf('他(((', { rulepack: custom })).not.toThrow()
  })

  it('allows a zero-tolerance term only when the entry is dialogue-exempt', () => {
    const strict = structuredClone(pack)
    strict.lexicon.zero_tolerance = [{ term: '禁词' }]
    expect(codesOf('“禁词。”', { rulepack: strict })).toContain('LEX_ZERO_TOLERANCE')
    const voice = structuredClone(pack)
    voice.lexicon.zero_tolerance = [{ term: '禁词', dialogueExempt: true }]
    expect(codesOf('“禁词。”', { rulepack: voice })).not.toContain('LEX_ZERO_TOLERANCE')
    expect(codesOf('他使用了禁词。', { rulepack: voice })).toContain('LEX_ZERO_TOLERANCE')
  })

  it('relaxes contextual words for their genre and forbids them elsewhere', () => {
    const text = '这次赋能很关键。'.repeat(2)
    expect(codesOf(text, { genre: '都市现代' })).not.toContain('LEX_SOFT_LIMIT')
    expect(codesOf('这次赋能很关键。', { genre: '玄幻修仙' })).toContain('LEX_SOFT_LIMIT')
  })

  it('reports a match at the first character of a paragraph on that paragraph', () => {
    const custom = structuredClone(pack)
    custom.lexicon.reader_intrusion = [{ pattern: '你' }]
    const result = runMachineChecks('第一段。\n\n你是一个读者。', options({ rulepack: custom }))
    const finding = result.violations.find((violation) => violation.code === 'READER_INTRUSION')
    expect(finding?.location.paragraph).toBe(2)
  })

  it('reports exemptions and the quote ratio', () => {
    expect(isExempt(pack, 'SEMICOLON')).toBe(false)
    const exempt = { ...pack, exemptions: ['SEMICOLON'] }
    expect(isExempt(exempt, 'SEMICOLON')).toBe(true)
    expect(
      runMachineChecks('他说；走了。', options({ rulepack: exempt })).violations.some(
        (violation) => violation.code === 'SEMICOLON',
      ),
    ).toBe(false)
  })

  it('handles a text without sentences or punctuation', () => {
    const result = runMachineChecks('', options())
    expect(result.metrics.total_word_count).toBe(0)
    expect(result.quoteRatio).toBe(1)
    expect(result.paragraphCount).toBe(0)
  })

  it('does not block short repeated dialogue as a copied paragraph', () => {
    const short = '“好。”\n\n他点了点头。'
    const result = runMachineChecks(
      short,
      options({
        chapter: 4,
        evidence: {
          ...options().evidence,
          previousText: short,
          previousTexts: [short],
        },
      }),
    )
    expect(result.violations.some((entry) => entry.code === 'DUPLICATE_PARAGRAPH')).toBe(false)
  })

  it('marks a paragraph duplicated from any of the previous three chapters', () => {
    const repeated = '这是一段足够长的重复段落，用来验证跨章相似度会命中。'.repeat(2)
    const result = runMachineChecks(
      repeated,
      options({
        chapter: 4,
        evidence: {
          ...options().evidence,
          previousText: repeated,
          previousTexts: [repeated],
        },
      }),
    )
    const violation = result.violations.find((entry) => entry.code === 'DUPLICATE_PARAGRAPH')
    expect(violation?.severity).toBe('blocker')
  })

  it('names the duplicated paragraph and both thresholds in its evidence', () => {
    const repeated = '这是一段足够长的重复段落，用来验证跨章相似度会命中。'.repeat(2)
    const prefix = '第一段是完整而独立的叙述，和后面的重复段落没有任何关系，也不应该被误判。'
    const result = runMachineChecks(
      `${prefix}\n\n${repeated}`,
      options({
        chapter: 4,
        evidence: {
          ...options().evidence,
          previousText: repeated,
          previousTexts: [repeated],
        },
      }),
    )
    const violation = result.violations.find((entry) => entry.code === 'DUPLICATE_PARAGRAPH')
    expect(violation?.severity).toBe('blocker')
    expect(violation?.location.paragraph).toBe(2)
    expect(violation?.detail).toContain('paragraph 2')
    expect(violation?.detail).toContain('blocker ≥')
    expect(violation?.detail).not.toContain('advisory threshold')
  })

  it('reports the original paragraph number when short paragraphs were merged', () => {
    const repeated = '这是一段足够长的重复段落，用来验证跨章相似度会命中。'.repeat(2)
    const short = ['一。', '二。', '三。', '四。', '五。', '六。']
    const result = runMachineChecks(
      `${short.join('\n\n')}\n\n${repeated}`,
      options({
        chapter: 4,
        evidence: { ...options().evidence, previousText: repeated, previousTexts: [repeated] },
      }),
    )
    const violation = result.violations.find((entry) => entry.code === 'DUPLICATE_PARAGRAPH')
    expect(violation?.location.paragraph).toBe(7)
    expect(violation?.detail).toContain('paragraph 7')
  })

  it('reports paragraph numbers relative to the matched previous source', () => {
    const repeated = '这是一段足够长的重复段落，用来验证跨章相似度会命中。'.repeat(2)
    const other = '另一本书记录了完全不同的一段海港旧事，和当前章节没有关系。'
    const result = runMachineChecks(
      repeated,
      options({
        chapter: 4,
        evidence: {
          ...options().evidence,
          previousText: null,
          previousTexts: [other, `短句。\n\n${repeated}`],
        },
      }),
    )
    const violation = result.violations.find((entry) => entry.code === 'DUPLICATE_PARAGRAPH')
    expect(violation?.detail).toContain('paragraph 2 from previous source 2')
  })

  it('still blocks a repeated paragraph split into short lines', () => {
    const repeated = '这是一段足够长的重复段落，用来验证跨章相似度会命中。'.repeat(2)
    const split = repeated.match(/.{1,10}/gu)!.join('\n')
    const result = runMachineChecks(
      split,
      options({
        chapter: 4,
        evidence: {
          ...options().evidence,
          previousText: repeated,
          previousTexts: [repeated],
        },
      }),
    )
    expect(result.violations.some((entry) => entry.code === 'DUPLICATE_PARAGRAPH')).toBe(true)
  })

  it('marks an unresolved foreshadow dormant after the configured window', () => {
    const foreshadows = {
      schema_version: 1 as const,
      next_seq: 2,
      items: [
        {
          id: 'FS-001',
          title: '旧信',
          planted: 1,
          last_touched: 1,
          status: 'planted' as const,
          resolved_at: null,
          description: '',
          advance_log: [],
        },
      ],
    }
    expect(
      codesOf('干净的正文。', {
        chapter: 21,
        evidence: { ...options().evidence, foreshadows },
      }),
    ).toContain('FORESHADOW_DORMANT')
    expect(
      codesOf('干净的正文。', {
        chapter: 21,
        evidence: {
          ...options().evidence,
          foreshadows: { ...foreshadows, items: [{ ...foreshadows.items[0]!, status: 'resolved' }] },
        },
      }),
    ).not.toContain('FORESHADOW_DORMANT')
  })

  it('compares the last two timeline entries for a time regression', () => {
    const timeline = {
      schema_version: 1 as const,
      next_seq: 3,
      items: [
        { id: 'TE-001', chapter: 1, story_time: 'Day 5', description: '', location: '', characters: [] },
        { id: 'TE-002', chapter: 2, story_time: 'Day 2', description: '', location: '', characters: [] },
      ],
    }
    expect(
      codesOf('干净的正文。', {
        chapter: 3,
        evidence: { ...options().evidence, timeline },
      }),
    ).toContain('TIME_REGRESSION')
    expect(
      codesOf('干净的正文。', {
        chapter: 3,
        evidence: {
          ...options().evidence,
          timeline: {
            ...timeline,
            items: [
              { ...timeline.items[0]!, story_time: '第5天' },
              { ...timeline.items[1]!, story_time: '第2天' },
            ],
          },
        },
      }),
    ).toContain('TIME_REGRESSION')
  })

  it('finds two known characters in one paragraph without a relationship row', () => {
    const characters = {
      schema_version: 1 as const,
      characters: [
        {
          name: '甲',
          role: 'protagonist',
          first_appearance: 1,
          profile: {},
          current_state: {},
          growth: [],
          updated_at: 1,
        },
        {
          name: '乙',
          role: 'supporting',
          first_appearance: 1,
          profile: {},
          current_state: {},
          growth: [],
          updated_at: 1,
        },
      ],
    }
    const text = '甲看着乙，没有说话。'
    expect(
      codesOf(text, {
        evidence: { ...options().evidence, characters },
      }),
    ).toContain('RELATION_UNKNOWN')
    expect(
      codesOf(text, {
        evidence: {
          ...options().evidence,
          characters,
          relationships: {
            schema_version: 1,
            next_seq: 2,
            items: [
              { id: 'RL-001', a: '甲', b: '乙', type: '同事', since: 1, description: '', evolution: [] },
            ],
          },
        },
      }),
    ).not.toContain('RELATION_UNKNOWN')
  })

  it('flags a character whose description drifts from the locked first appearance', () => {
    const locks = {
      schema_version: 1 as const,
      locked_at_chapter: 1,
      characters: {
        他: { first_appearance: 1, locked_at: 1, appearance: '穿灰色长衫，左手有旧伤。' },
      },
      locations: {},
    }
    expect(
      codesOf('他今天穿着鲜红铠甲，骑着白马冲进广场。', {
        evidence: { ...options().evidence, locks },
      }),
    ).toContain('LOCKED_DETAIL_DRIFT')
  })

  it('does not compare an empty locked appearance', () => {
    const locks = {
      schema_version: 1 as const,
      locked_at_chapter: 1,
      characters: {
        他: { first_appearance: 1, locked_at: 1, appearance: '' },
      },
      locations: {},
    }
    expect(
      codesOf('他今天穿着鲜红铠甲，骑着白马冲进广场。', {
        evidence: { ...options().evidence, locks },
      }),
    ).not.toContain('LOCKED_DETAIL_DRIFT')
  })

  it('detects a water-word cluster that straddles a window boundary', () => {
    const water = structuredClone(pack)
    water.semantics.water_words = {
      window: 10,
      threshold: 0.4,
      terms: ['水'],
      scene_thresholds: {},
    }
    const text = `${'甲'.repeat(8)}${'水'.repeat(5)}${'甲'.repeat(7)}`
    expect(codesOf(text, { rulepack: water })).toContain('WATER_WORDS')
  })

  it('uses the rulepack system labels instead of a hardcoded list', () => {
    expect(codesOf('Day 1 清晨。')).toContain('SYSTEM_LABEL')
    const custom = { ...pack, format: { ...pack.format, system_labels: [] } }
    expect(codesOf('Day 1 清晨。', { rulepack: custom })).not.toContain('SYSTEM_LABEL')
  })

  it('charges dialogue dashes double the budget', () => {
    const text = '"甲——乙"——丙。"丁——戊"——己。"庚——辛"——壬。'
    expect(codesOf(text, { sceneType: '日常过渡章' })).toContain('DASH_BUDGET')
  })

  it('skips rhythm checks for dialogue-dominant paragraphs', () => {
    const text = '"他走了。他来了。他说了。他笑了。他停了。他看了。他等了。他睡了。"'
    expect(codesOf(text)).not.toContain('UNIFORM_SENTENCE')
    const strict = {
      ...pack,
      punctuation: { ...pack.punctuation, dialogue_dominant_ratio: 1 },
    }
    expect(codesOf(text, { rulepack: strict })).toContain('UNIFORM_SENTENCE')
  })

  it('does not treat ordinary first-person narration as reader address', () => {
    expect(codesOf('我们看着窗外的雨，谁也没有说话。')).not.toContain('READER_INTRUSION')
    expect(codesOf('我们可以看到这里的雨。')).toContain('READER_INTRUSION')
  })

  it('allows cause-first order and flags conclusion-first order', () => {
    expect(codesOf('因为下雨，他感到寒冷。')).not.toContain('CONCLUSION_FIRST')
    expect(codesOf('他感到寒冷，因为下雨了。')).toContain('CONCLUSION_FIRST')
  })

  it('counts exclamation terminators in sentence density', () => {
    const text = '风从窗缝里挤进来，他把桌上的纸压住！走廊里没有人，灯还亮着！他坐下来，翻开那封旧信！'
    expect(codesOf(text)).not.toContain('PERIOD_DENSITY')
  })

  it('flags a local arithmetic contradiction but accepts a consistent total', () => {
    expect(codesOf('十一个人，每人三百，共三千四百。')).toContain('NUMERIC_CONTRADICTION')
    expect(codesOf('十一个人，每人三百，共三千三百。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codesOf('11 × 300 = 3300。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codesOf('11 × 300 = 3400。')).toContain('NUMERIC_CONTRADICTION')
    // Duplicate equations and a consistent speed pair exercise the no-report
    // branches without changing the advisory contract.
    expect(codesOf('11 × 300 = 3400。11 × 300 = 3400。')).toContain('NUMERIC_CONTRADICTION')
    expect(codesOf('时速 60 公里，另一处时速 65 公里。')).not.toContain('NUMERIC_CONTRADICTION')
    // Approximate quantities and a verb before the total are normal Chinese.
    expect(codesOf('二三十人，每人两块，一共五十块。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codesOf('三个人每人五块，一共花了二十块。')).toContain('NUMERIC_CONTRADICTION')
    expect(codesOf('三个人每人五块，一共十五块。')).not.toContain('NUMERIC_CONTRADICTION')
    // 五桌 is a different unit/class from the per-person money, not a total.
    expect(codesOf('十一个人，每人三百，共五桌。')).not.toContain('NUMERIC_CONTRADICTION')
  })

  it('understands colloquial trailing units and never joins equations across paragraphs', () => {
    expect(codesOf('四个人每人一千五，一共六千块。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codesOf('三个人每人一百五，一共四百五十块。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codesOf('四个人每人一千五，一共五千块。')).toContain('NUMERIC_CONTRADICTION')
    // Colloquial approximate factors are not exact equations.
    expect(codesOf('三五个人，每人五块，一共十五块。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codesOf('七八个人，每人五块，一共十五块。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codesOf('数十人，每人五块，一共一百五十块。')).not.toContain('NUMERIC_CONTRADICTION')
    // Thousands separators, ranges and colloquial prices are not bad equations.
    expect(codesOf('3,000 × 2 = 6,000。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codesOf('1,500 元 × 2 一共 3,000 元。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codesOf('五、六个人，每人五块，一共二十五块。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codesOf('三块五乘以二等于七块。')).not.toContain('NUMERIC_CONTRADICTION')
    const split = '风从窗缝里挤进来。\n\n他又数了一遍。\n\n一共三个人\n\n每人二十块，一共五十块。'
    expect(codesOf(split)).not.toContain('NUMERIC_CONTRADICTION')
    const located = '风从窗缝里挤进来。\n\n他又数了一遍。\n\n三个人每人五块，一共二十块。'
    const finding = runMachineChecks(located, options()).violations.find(
      (violation) => violation.code === 'NUMERIC_CONTRADICTION',
    )
    expect(finding?.location.paragraph).toBe(3)
  })

  it('recognises arbitrary Day and volume labels', () => {
    expect(codesOf('Day 7，他醒来。')).toContain('SYSTEM_LABEL')
    expect(codesOf('第4卷开始了。')).toContain('SYSTEM_LABEL')
  })

  it('accepts locked details that survive inside a longer paragraph', () => {
    const locks = {
      schema_version: 1 as const,
      locked_at_chapter: 1,
      characters: {},
      locations: {
        旧办公室: {
          first_appearance: 1,
          locked_at: 1,
          layout: '靠窗一张旧办公桌，墙角堆满文件箱',
          capacity: 0,
        },
      },
    }
    const text = '他推开旧办公室的门，靠窗一张旧办公桌还在，墙角堆满文件箱，桌上的台灯没有开。'
    expect(codesOf(text, { evidence: { ...options().evidence, locks } })).not.toContain('LOCKED_DETAIL_DRIFT')
  })

  it('does not compare a possessive passing mention as a locked description', () => {
    const locks = {
      schema_version: 1 as const,
      locked_at_chapter: 1,
      characters: {},
      locations: {
        旧办公室: {
          first_appearance: 1,
          locked_at: 1,
          layout: '靠窗一张旧办公桌，墙角堆满文件箱',
          capacity: 0,
        },
      },
    }
    const text = '他推开旧办公室的门，里面没有人。'
    expect(codesOf(text, { evidence: { ...options().evidence, locks } })).not.toContain('LOCKED_DETAIL_DRIFT')
  })

  it('does not treat a later speech tag as a character appearance change', () => {
    const locks = {
      schema_version: 1 as const,
      locked_at_chapter: 1,
      characters: {
        陈嘉树: { first_appearance: 1, locked_at: 1, appearance: '灰长衫，左眉一道疤' },
      },
      locations: {},
    }
    const text = '陈嘉树穿着灰长衫，左眉一道疤，站在门口。\n\n陈嘉树说：“走吧。”'
    expect(codesOf(text, { evidence: { ...options().evidence, locks } })).not.toContain('LOCKED_DETAIL_DRIFT')
  })

  it('reports a location description that changed after a possessive mention', () => {
    const locks = {
      schema_version: 1 as const,
      locked_at_chapter: 1,
      characters: {},
      locations: {
        旧办公室: {
          first_appearance: 1,
          locked_at: 1,
          layout: '靠窗一张旧办公桌，墙角堆满文件箱',
          capacity: 0,
        },
      },
    }
    const text = '他推开旧办公室的门，桌子换成红木桌，墙角空荡荡的。'
    expect(codesOf(text, { evidence: { ...options().evidence, locks } })).toContain('LOCKED_DETAIL_DRIFT')
  })

  it('does not treat a bare location mention as a changed layout', () => {
    const locks = {
      schema_version: 1 as const,
      locked_at_chapter: 1,
      characters: {},
      locations: {
        旧办公室: {
          first_appearance: 1,
          locked_at: 1,
          layout: '靠窗一张旧办公桌，墙角堆满文件箱',
          capacity: 0,
        },
      },
    }
    const text = '靠窗一张旧办公桌，墙角堆满文件箱。\n\n他回到旧办公室。'
    expect(codesOf(text, { evidence: { ...options().evidence, locks } })).not.toContain('LOCKED_DETAIL_DRIFT')
  })

  it('reports drift introduced after a correct description', () => {
    const locks = {
      schema_version: 1 as const,
      locked_at_chapter: 1,
      characters: {},
      locations: {
        旧办公室: {
          first_appearance: 1,
          locked_at: 1,
          layout: '靠窗一张旧办公桌，墙角堆满文件箱',
          capacity: 0,
        },
      },
    }
    const text =
      '他推开旧办公室的门，靠窗一张旧办公桌还在，墙角堆满文件箱，桌上的台灯没有开。\n\n后来旧办公室重新装修，桌子换成红木桌，墙角空荡荡的。'
    expect(codesOf(text, { evidence: { ...options().evidence, locks } })).toContain('LOCKED_DETAIL_DRIFT')
  })

  it('merges same-code advisories but never drops their distinct evidence', () => {
    const violation = (paragraph: number, detail: string): Violation => ({
      code: 'LOCKED_DETAIL_DRIFT',
      severity: 'advisory',
      location: { paragraph },
      detail,
    })
    const merged = dedupeAdvisories([
      violation(1, 'expected "旧办公桌", actual "红木桌"'),
      violation(2, 'expected "灰长衫", actual "红铠甲"'),
      violation(1, 'expected "旧办公桌", actual "红木桌"'),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.location.paragraph).toBe(1)
    expect(merged[0]!.detail).toContain('旧办公桌')
    expect(merged[0]!.detail).toContain('红铠甲')
    expect(merged[0]!.detail.match(/旧办公桌/g)).toHaveLength(1)
  })
})
