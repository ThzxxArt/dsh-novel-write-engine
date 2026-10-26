import { describe, expect, it } from 'vitest'
import { evaluateSemantic, evidenceQuote, SEMANTIC_CHECK_IDS } from '../src/engine/semantic.js'

const TEXT = '风从窗缝里挤进来，把桌上的纸吹得翻了一页。\n\n他伸手压住，指腹沾了一点灰。'

const item = (patch: Record<string, unknown> = {}): never =>
  ({ id: 'L2-1', verdict: 'pass', evidence: '风从窗缝里挤进来', note: 'ok', ...patch }) as never

describe('semantic evidence validation', () => {
  it('strips a paragraph label and wrapping quotes', () => {
    expect(evidenceQuote('第 2 段：“他伸手压住”')).toBe('他伸手压住')
    expect(evidenceQuote('「风从窗缝里挤进来」')).toBe('风从窗缝里挤进来')
  })

  it('rejects malformed items instead of crashing the check', () => {
    const cases = [
      { name: 'not an object', value: null },
      { name: 'no id', value: { verdict: 'pass', evidence: '风从窗缝里挤进来', note: '' } },
      { name: 'bad verdict', value: item({ verdict: 'maybe' }) },
      { name: 'empty evidence', value: item({ evidence: '' }) },
      { name: 'short quote', value: item({ evidence: '风从' }) },
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

  it('turns a failing verdict into a blocking semantic finding', () => {
    const result = evaluateSemantic(TEXT, [item({ verdict: 'fail' })])
    expect(result.failed).toBe(true)
    expect(result.blocking[0]).toMatchObject({ code: 'SEMANTIC_CHECK_FAILED' })
  })

  it('passes when all four required checks carry a real quote', () => {
    const complete = SEMANTIC_CHECK_IDS.map((id) => ({
      id,
      verdict: 'pass' as const,
      evidence: '风从窗缝里挤进来',
      note: 'ok',
    }))
    expect(evaluateSemantic(TEXT, complete)).toEqual({ blocking: [], failed: false })
  })
})
