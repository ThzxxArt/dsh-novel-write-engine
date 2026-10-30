import { describe, expect, it } from 'vitest'
import { loadRulepack } from '../src/rulepack.js'
import { runMachineChecks, slidingWindows } from '../src/rules/pipeline.js'
import type { MachineOptions } from '../src/rules/pipeline.js'
import type { ChapterSummary } from '../src/types.js'
import { sampleSummary } from './helpers.js'

const rulepack = loadRulepack()

const options = (overrides: Partial<MachineOptions> = {}): MachineOptions => ({
  chapter: 1,
  title: '第1章 开端之雨',
  genre: '都市现代',
  sceneType: '日常过渡章',
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

const withResources = (changes: ChapterSummary['resource_changes']): ChapterSummary =>
  sampleSummary({ resource_changes: changes })

describe('0.1.2 non-whitespace windows', () => {
  it('advances by non-whitespace characters, so spaces and newlines do not create extra windows', () => {
    const text = `的 时 候\n的 时 候\n的 时 候`
    const windows = slidingWindows(text, 8)
    expect(windows.length).toBe(2)
    for (const window of windows) {
      expect(window.replace(/\s/g, '')).toHaveLength(8)
    }
    expect(text.length).toBeGreaterThan(4)
  })

  it('uses the same window count when the same text is formatted differently', () => {
    const compact = '的时候的时候的时候的时候的时候的时候'
    const spaced = compact.split('').join(' \n\u3000')
    expect(slidingWindows(compact, 6).length).toBe(slidingWindows(spaced, 6).length)
  })
})

describe('0.1.2 resource sign reconciliation', () => {
  it('accepts the right sign and resource name', () => {
    const codes = runMachineChecks(
      '他数了数铜钱，少了 200。',
      options({ summary: withResources([{ character: '他', resource: '铜钱', delta: -200, reason: '买' }]) }),
    ).violations.map((violation) => violation.code)
    expect(codes).not.toContain('RESOURCE_MISMATCH')
  })

  it('rejects the opposite sign', () => {
    const codes = runMachineChecks(
      '他数了数铜钱，多了 200。',
      options({ summary: withResources([{ character: '他', resource: '铜钱', delta: -200, reason: '买' }]) }),
    ).violations.map((violation) => violation.code)
    expect(codes).toContain('RESOURCE_MISMATCH')
  })

  it('does not invent a mismatch when the resource name is absent', () => {
    const codes = runMachineChecks(
      '他数了数，少了 200。',
      options({ summary: withResources([{ character: '他', resource: '铜钱', delta: -200, reason: '买' }]) }),
    ).violations.map((violation) => violation.code)
    expect(codes).not.toContain('RESOURCE_MISMATCH')
  })

  it('does not let a distant opposite sign satisfy the amount', () => {
    const text = `他获得铜钱 200。${'风从窗外吹进来，'.repeat(10)}后来只少了 1。`
    const codes = runMachineChecks(
      text,
      options({ summary: withResources([{ character: '他', resource: '铜钱', delta: -200, reason: '买' }]) }),
    ).violations.map((violation) => violation.code)
    expect(codes).toContain('RESOURCE_MISMATCH')
  })

  it('does not invent a contradiction when normal prose omits the minus sign', () => {
    const codes = runMachineChecks(
      '他数了数铜钱，还剩 200。',
      options({ summary: withResources([{ character: '他', resource: '铜钱', delta: -200, reason: '买' }]) }),
    ).violations.map((violation) => violation.code)
    expect(codes).not.toContain('RESOURCE_MISMATCH')
  })

  it('does not borrow an opposite verb from the next resource', () => {
    const codes = runMachineChecks(
      '角色甲得到 5 块灵石，又花掉 2 个铜钱。',
      options({
        summary: withResources([{ character: '角色甲', resource: '灵石', delta: 5, reason: '收到' }]),
      }),
    ).violations.map((violation) => violation.code)
    expect(codes).not.toContain('RESOURCE_MISMATCH')
  })

  it('still reports the opposite sign in the same local phrase', () => {
    const codes = runMachineChecks(
      '角色甲花掉 5 块灵石，买了两斤米。',
      options({
        summary: withResources([{ character: '角色甲', resource: '灵石', delta: 5, reason: '收到' }]),
      }),
    ).violations.map((violation) => violation.code)
    expect(codes).toContain('RESOURCE_MISMATCH')
  })

  it('does not mistake 花园/参加/更加 for 花/加/增', () => {
    for (const text of [
      '他走进花园，手里攥着五块灵石。',
      '他参加完集会，把五块灵石放在桌上。',
      '他更加确信，那五块灵石是假的。',
    ]) {
      const codes = runMachineChecks(
        text,
        options({
          summary: withResources([
            { character: '他', resource: '灵石', delta: text.includes('花园') ? 5 : -5, reason: 'x' },
          ]),
        }),
      ).violations.map((violation) => violation.code)
      expect(codes).not.toContain('RESOURCE_MISMATCH')
    }
  })

  it('finds a resource far before the amount and reports the sign word, not the number', () => {
    const codes = runMachineChecks(
      '他把昨天挣来的那些灵石仔细数了一遍，发现少了三块。',
      options({ summary: withResources([{ character: '他', resource: '灵石', delta: 3, reason: '收到' }]) }),
    ).violations
    const finding = codes.find((violation) => violation.code === 'RESOURCE_MISMATCH')
    expect(finding?.detail).toContain('"少了"')
    expect(finding?.detail).not.toContain('opposite sign "3"')
    expect(finding?.location.paragraph).toBe(1)
  })

  it('does not borrow the same magnitude from another amount clause', () => {
    const codes = runMachineChecks(
      '他买米花了 5 块，后来灵石多了 5 块。',
      options({ summary: withResources([{ character: '他', resource: '灵石', delta: 5, reason: '收到' }]) }),
    ).violations.map((violation) => violation.code)
    expect(codes).not.toContain('RESOURCE_MISMATCH')
  })

  it('does not attribute a clause amount to another named character', () => {
    const summary = withResources([{ character: '角色甲', resource: '灵石', delta: 5, reason: '收到' }])
    summary.characters_appeared = ['角色甲', '角色乙']
    const codes = runMachineChecks(
      '角色甲得到五块灵石，角色乙花掉五块。',
      options({ summary }),
    ).violations.map((violation) => violation.code)
    expect(codes).not.toContain('RESOURCE_MISMATCH')
  })

  it('does not borrow a resource from a prior amount clause in reverse order', () => {
    const codes = runMachineChecks(
      '后来灵石多了 5 块，他买米花了 5 块。',
      options({ summary: withResources([{ character: '他', resource: '灵石', delta: 5, reason: '收到' }]) }),
    ).violations.map((violation) => violation.code)
    expect(codes).not.toContain('RESOURCE_MISMATCH')
  })

  it('does not put the current sentence into the previous-sentence attribution', () => {
    const summary = withResources([{ character: '角色甲', resource: '灵石', delta: 5, reason: '收到' }])
    summary.characters_appeared = ['角色甲', '角色丙']
    const codes = runMachineChecks(
      '角色甲走进院子。他随手花掉五块灵石，角色丙站在门口。',
      options({ summary }),
    ).violations.map((violation) => violation.code)
    expect(codes).toContain('RESOURCE_MISMATCH')
  })

  it('accepts a pronoun in the next sentence when the previous sentence names one character', () => {
    const summary = withResources([{ character: '角色甲', resource: '灵石', delta: 5, reason: '收到' }])
    summary.characters_appeared = ['角色甲']
    const codes = runMachineChecks(
      '角色甲走进院子。他随手花掉五块灵石。',
      options({ summary }),
    ).violations.map((violation) => violation.code)
    expect(codes).toContain('RESOURCE_MISMATCH')
  })
})
