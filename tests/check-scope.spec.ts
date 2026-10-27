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

  it('rejects a missing resource name even when the number appears', () => {
    const codes = runMachineChecks(
      '他数了数，少了 200。',
      options({ summary: withResources([{ character: '他', resource: '铜钱', delta: -200, reason: '买' }]) }),
    ).violations.map((violation) => violation.code)
    expect(codes).toContain('RESOURCE_MISMATCH')
  })

  it('does not let a distant opposite sign satisfy the amount', () => {
    const text = `他获得铜钱 200。${'风从窗外吹进来，'.repeat(10)}后来只少了 1。`
    const codes = runMachineChecks(
      text,
      options({ summary: withResources([{ character: '他', resource: '铜钱', delta: -200, reason: '买' }]) }),
    ).violations.map((violation) => violation.code)
    expect(codes).toContain('RESOURCE_MISMATCH')
  })
})
