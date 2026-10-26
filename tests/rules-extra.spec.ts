import { describe, expect, it } from 'vitest'
import { isExempt, runMachineChecks } from '../src/rules/pipeline.js'
import { loadRulepack } from '../src/rulepack.js'
import type { MachineOptions } from '../src/rules/pipeline.js'

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

  it('blocks a paragraph duplicated from any of the previous three chapters', () => {
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
})
