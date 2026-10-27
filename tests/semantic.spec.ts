import { describe, expect, it } from 'vitest'
import { evaluateSemantic, evidenceQuote, SEMANTIC_CHECK_IDS } from '../src/engine/semantic.js'

const TEXT = [
  '风从窗缝里挤进来，把桌上的纸吹得翻了一页。',
  '他伸手压住，指腹沾了一点灰。',
  '走廊尽头传来脚步声，不快不慢。',
  '门被推开时带进一股凉气。',
].join('\n\n')

/** Four disjoint 8-character quotes, one per paragraph. */
const QUOTES = ['风从窗缝里挤进来', '他伸手压住，指腹', '走廊尽头传来脚步', '门被推开时带进一']

const item = (patch: Record<string, unknown> = {}): never =>
  ({ id: 'L2-1', verdict: 'pass', evidence: QUOTES[0], note: 'ok', ...patch }) as never

describe('semantic evidence validation', () => {
  it('strips a paragraph label and wrapping quotes', () => {
    expect(evidenceQuote('第 2 段：“他伸手压住，指腹”')).toBe('他伸手压住，指腹')
    expect(evidenceQuote('「风从窗缝里挤进来」')).toBe('风从窗缝里挤进来')
  })

  it('rejects malformed items instead of crashing the check', () => {
    const cases = [
      { name: 'not an object', value: null },
      { name: 'no id', value: { verdict: 'pass', evidence: QUOTES[0], note: '' } },
      { name: 'bad verdict', value: item({ verdict: 'maybe' }) },
      { name: 'empty evidence', value: item({ evidence: '' }) },
      { name: 'short quote', value: item({ evidence: '风从窗' }) },
    ]
    for (const testCase of cases) {
      const result = evaluateSemantic(TEXT, [testCase.value as never])
      expect(result.failed, testCase.name).toBe(true)
      expect(result.blocking[0]!.code, testCase.name).toMatch(/SEMANTIC_(ITEM|EVIDENCE)_INVALID/)
    }
  })

  it('rejects duplicate ids and evidence absent from the manuscript', () => {
    const duplicate = evaluateSemantic(TEXT, [item(), item()])
    expect(duplicate.blocking.map((entry) => entry.code)).toContain('SEMANTIC_ITEM_INVALID')
    const absent = evaluateSemantic(TEXT, [item({ evidence: '这句话不在正文里' })])
    expect(absent.blocking[0]).toMatchObject({ code: 'SEMANTIC_EVIDENCE_INVALID' })
  })

  it('rejects four checks that quote the same sentence', () => {
    const repeated = SEMANTIC_CHECK_IDS.map((id) => ({
      id,
      verdict: 'pass' as const,
      evidence: QUOTES[0],
      note: 'ok',
    }))
    const result = evaluateSemantic(TEXT, repeated)
    expect(result.failed).toBe(true)
    expect(result.blocking.map((entry) => entry.code)).toContain('SEMANTIC_EVIDENCE_INVALID')
    expect(result.blocking.map((entry) => entry.detail).join(' ')).toContain('distinct')
  })

  it('rejects overlapping substrings of one sentence from counting as four checks', () => {
    const sentence = '他站在雨里看着远处的灯火一言不发。'
    const overlapping = [
      '他站在雨里看着远处',
      '在雨里看着远处的灯',
      '雨里看着远处的灯火',
      '看着远处的灯火一言',
    ]
    const result = evaluateSemantic(
      sentence,
      SEMANTIC_CHECK_IDS.map((id, index) => ({
        id,
        verdict: 'pass' as const,
        evidence: overlapping[index]!,
        note: 'ok',
      })),
    )
    expect(result.failed).toBe(true)
    expect(result.blocking.map((entry) => entry.code)).toContain('SEMANTIC_EVIDENCE_INVALID')
  })

  it('rejects four non-overlapping substrings of the same sentence', () => {
    const sentence = '他站在雨里看着远处的灯火一言不发，雨声很大，街上没有人，只有风从巷口吹过来。'
    const chars = Array.from(sentence)
    const quotes = [chars.slice(0, 8), chars.slice(9, 17), chars.slice(18, 26), chars.slice(27, 35)].map(
      (part) => part.join(''),
    )
    const result = evaluateSemantic(
      sentence,
      SEMANTIC_CHECK_IDS.map((id, index) => ({
        id,
        verdict: 'pass' as const,
        evidence: quotes[index]!,
        note: 'ok',
      })),
    )
    expect(result.failed).toBe(true)
    expect(result.blocking.map((entry) => entry.code)).toContain('SEMANTIC_EVIDENCE_INVALID')
  })

  it('rejects a seven-character quote even when it appears in the manuscript', () => {
    const result = evaluateSemantic(TEXT, [item({ evidence: '风从窗缝里挤进' })])
    expect(result.failed).toBe(true)
    expect(result.blocking.map((entry) => entry.code)).toContain('SEMANTIC_EVIDENCE_INVALID')
  })

  it('turns a failing verdict into a blocking semantic finding', () => {
    const result = evaluateSemantic(TEXT, [item({ verdict: 'fail' })])
    expect(result.failed).toBe(true)
    expect(result.blocking[0]).toMatchObject({ code: 'SEMANTIC_CHECK_FAILED' })
  })

  it('passes only when all four required checks carry distinct real quotes', () => {
    const complete = SEMANTIC_CHECK_IDS.map((id, index) => ({
      id,
      verdict: 'pass' as const,
      evidence: QUOTES[index]!,
      note: 'ok',
    }))
    expect(evaluateSemantic(TEXT, complete)).toEqual({ blocking: [], failed: false })
  })
})
