import { describe, expect, it } from 'vitest'
import {
  CheckSubmissionError,
  evaluateSemantic,
  evidenceQuote,
  SEMANTIC_CHECK_IDS,
  validateSemanticSubmission,
} from '../src/engine/semantic.js'

// Synthetic evidence shape; deliberately not copied from the real project.
const TEXT = [
  '旧楼停电。守门人正在收伞。',
  '三枚铜钱。他口袋里一枚也没有。',
  '最后两趟，伙计忘了盖章。账本写着九十二，碟子洗出一百零三。',
  '没有通行证就是没有通行证。你在铺头站一个钟，也是犯法。',
  '他转过脸，看见路边的木牌。',
].join('\n\n')

const CROSS = [
  '旧楼停电。守门人正在收伞。',
  '三枚铜钱。他口袋里一枚也没有。',
  '最后两趟，伙计忘了盖章。账本写着九十二，碟子洗出一百零三。',
  '没有通行证就是没有通行证。你在铺头站一个钟，也是犯法。',
  '他转过脸，看见路边的木牌。',
]

const item = (id: string, evidence: string, verdict: 'pass' | 'fail' = 'pass') => ({
  id,
  verdict,
  evidence,
  note: 'ok',
})

const complete = (quotes: string[]) => SEMANTIC_CHECK_IDS.map((id, index) => item(id, quotes[index]!))

describe('semantic evidence validation', () => {
  it('strips a paragraph label and wrapping quotes', () => {
    expect(evidenceQuote('第 2 段：“他伸手压住，指腹”')).toBe('他伸手压住，指腹')
    expect(evidenceQuote('「风从窗缝里挤进来」')).toBe('风从窗缝里挤进来')
    expect(evidenceQuote('   ')).toBe('')
    expect(evidenceQuote('第 2 段：')).toBe('')
  })

  it('classifies malformed items by state instead of crashing', () => {
    const cases = [
      { name: 'not an object', value: null, state: 'invalid' },
      { name: 'no id', value: { verdict: 'pass', evidence: CROSS[0], note: '' }, state: 'invalid' },
      { name: 'bad verdict', value: item('L2-X', CROSS[0]!, 'maybe' as never), state: 'invalid' },
      { name: 'empty evidence', value: item('L2-X', ''), state: 'invalid' },
      { name: 'short quote', value: item('L2-X', '风从窗'), state: 'too_short' },
    ]
    for (const testCase of cases) {
      const result = evaluateSemantic(TEXT, [testCase.value as never])
      expect(result.submission_failed, testCase.name).toBe(true)
      expect(
        result.items.some((entry) => entry.state === testCase.state),
        testCase.name,
      ).toBe(true)
    }
  })

  it('returns no nearest paragraph for an empty manuscript', () => {
    const result = evaluateSemantic('', [item('L2-POV', '这句话完全不存在')])
    expect(result.items[0]?.state).toBe('not_found')
    expect(result.items[0]?.nearest).toBeUndefined()
  })

  it('reports an absent quote as NOT_FOUND with a nearest paragraph', () => {
    const result = evaluateSemantic(TEXT, [item('L2-POV', '这句话完全不在正文里')])
    const finding = result.items.find((entry) => entry.id === 'L2-POV')!
    expect(finding.state).toBe('not_found')
    expect(finding.nearest?.paragraph).toBeGreaterThanOrEqual(1)
    expect(finding.nearest?.quote.length).toBeGreaterThan(0)
    expect(result.blocking.some((entry) => entry.code === 'SEMANTIC_EVIDENCE_NOT_FOUND')).toBe(true)
  })

  it('reports exact duplicate quotes as DUPLICATE with the other item id', () => {
    const result = evaluateSemantic(TEXT, [
      item('L2-SCENE-ANCHOR', CROSS[0]!),
      item('L2-CHARACTER-STATE', CROSS[0]!),
    ])
    const duplicate = result.items.find((entry) => entry.id === 'L2-CHARACTER-STATE')!
    expect(duplicate.state).toBe('duplicate')
    expect(duplicate.conflict_with).toBe('L2-SCENE-ANCHOR')
  })

  it('reports overlapping substrings as OVERLAP with the accepted item id and interval evidence', () => {
    const sentence = '他站在雨里看着远处的灯火一言不发。'
    const overlapping = ['他站在雨里看着远处的灯火', '在雨里看着远处的灯火一', '雨里看着远处的灯火一言']
    const result = evaluateSemantic(
      sentence,
      SEMANTIC_CHECK_IDS.map((id, index) => item(id, overlapping[index]!)),
    )
    const overlap = result.items.find((entry) => entry.state === 'overlap')!
    expect(overlap.conflict_with).toBe('L2-SCENE-ANCHOR')
    expect(overlap.conflicts?.[0]).toMatchObject({
      kind: 'interval_overlap',
      other_id: 'L2-SCENE-ANCHOR',
    })
    expect(overlap.conflicts?.[0]?.overlap_text).toBeTruthy()
    expect(overlap.conflicts?.[0]?.overlap_chars).toBeGreaterThanOrEqual(8)
    expect(result.blocking.some((entry) => entry.code === 'SEMANTIC_EVIDENCE_OVERLAP')).toBe(true)
  })

  it('does not reject evidence from different paragraphs that merely share common words', () => {
    const text = '何九把秤砣放在柜台。\n\n何九看着秤杆上的星。'
    const result = evaluateSemantic(text, [
      item('L2-SCENE-ANCHOR', '何九把秤砣放在柜台'),
      item('L2-CHARACTER-STATE', '何九看着秤杆上的星'),
    ])
    expect(result.items.find((entry) => entry.id === 'L2-SCENE-ANCHOR')?.state).toBe('pass')
    expect(result.items.find((entry) => entry.id === 'L2-CHARACTER-STATE')?.state).toBe('pass')
    expect(result.conflicts).toHaveLength(0)
  })

  it('does not let a long quote swallow an independent sentence after an ellipsis', () => {
    const text = '第一句很长。第二句也很长……第三句独立成段。'
    const result = evaluateSemantic(text, [
      item('L2-SCENE-ANCHOR', '第一句很长。第二句也很长……'),
      item('L2-CHARACTER-STATE', '第三句独立成段。'),
    ])
    expect(result.items.find((entry) => entry.id === 'L2-SCENE-ANCHOR')?.state).toBe('pass')
    expect(result.items.find((entry) => entry.id === 'L2-CHARACTER-STATE')?.state).toBe('pass')
    expect(result.conflicts).toHaveLength(0)
  })

  it('reports different non-overlapping substrings of one sentence as SAME_SENTENCE with sentence evidence', () => {
    const sentence = '他站在雨里看着远处的灯火一言不发，雨声很大，街上没有人，只有风从巷口吹过来。'
    const chars = Array.from(sentence)
    const quotes = [chars.slice(0, 8), chars.slice(9, 17), chars.slice(18, 26), chars.slice(27, 35)].map(
      (part) => part.join(''),
    )
    const result = evaluateSemantic(
      sentence,
      SEMANTIC_CHECK_IDS.map((id, index) => item(id, quotes[index]!)),
    )
    const same = result.items.find((entry) => entry.state === 'same_sentence')!
    expect(same.conflicts?.[0]).toMatchObject({
      kind: 'same_sentence',
      other_id: 'L2-SCENE-ANCHOR',
      sentence: { paragraph: 1 },
    })
    expect(same.conflicts?.[0]?.sentence?.text).toContain('他站在雨里')
    expect(result.blocking.some((entry) => entry.code === 'SEMANTIC_EVIDENCE_SAME_SENTENCE')).toBe(true)
  })

  it('rejects a seven-character quote even when it appears in the manuscript', () => {
    const result = evaluateSemantic(TEXT, [item('L2-POV', '风从窗缝里挤进')])
    expect(result.items.find((entry) => entry.id === 'L2-POV')?.state).toBe('too_short')
  })

  it('turns a valid failing verdict into content failure, not a submission error', () => {
    const passing = evaluateSemantic(TEXT, complete(CROSS))
    expect(passing.submission_failed).toBe(false)
    expect(passing.content_failed).toBe(false)
    expect(passing.items.every((entry) => entry.state === 'pass')).toBe(true)

    const failing = evaluateSemantic(
      TEXT,
      complete(CROSS).map((entry, index) =>
        index === 4 ? { ...entry, verdict: 'fail' as const, note: 'POV 不稳定' } : entry,
      ),
    )
    expect(failing.submission_failed).toBe(false)
    expect(failing.content_failed).toBe(true)
    expect(failing.findings[0]).toMatchObject({ code: 'SEMANTIC_CHECK_FAILED' })
  })

  it('accepts five quotes that each span two sentences', () => {
    const result = evaluateSemantic(TEXT, complete(CROSS))
    expect(result.submission_failed).toBe(false)
    expect(result.content_failed).toBe(false)
    expect(result.failed).toBe(false)
    expect(result.items.map((entry) => entry.state)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass'])
  })

  it('only reports the one fabricated quote when four real quotes are valid', () => {
    const result = evaluateSemantic(TEXT, [
      ...complete(CROSS).slice(0, 4),
      item('L2-POV', '他在码头等了一整夜。'),
    ])
    expect(result.submission_failed).toBe(true)
    expect(result.items.filter((entry) => entry.state === 'not_found').map((entry) => entry.id)).toEqual([
      'L2-POV',
    ])
    expect(result.items.filter((entry) => entry.state === 'pass')).toHaveLength(4)
    expect(
      result.blocking.some(
        (entry) =>
          entry.code === 'SEMANTIC_EVIDENCE_OVERLAP' || entry.code === 'SEMANTIC_EVIDENCE_SAME_SENTENCE',
      ),
    ).toBe(false)
  })

  it('accepts a quote that ends with a closing quote after the sentence terminator', () => {
    const text = '走吧。」她点点头，转身走了。他留在原地。'
    const result = evaluateSemantic(text, [item('L2-SCENE-ANCHOR', '走吧。」她点点头，转身走了。')])
    expect(result.items.find((entry) => entry.id === 'L2-SCENE-ANCHOR')?.state).toBe('pass')
  })

  it('accepts a quote that crosses a paragraph boundary', () => {
    const text = '第一句在上一段。\n\n第二句在下一段，仍然连续。'
    const result = evaluateSemantic(text, [item('L2-SCENE-ANCHOR', '第一句在上一段。\n\n第二句在下一段')])
    expect(result.items.find((entry) => entry.id === 'L2-SCENE-ANCHOR')?.state).toBe('pass')
  })

  it('throws CheckSubmissionError with no consumed round for invalid shapes', () => {
    expect(() => validateSemanticSubmission(TEXT, [])).toThrow(CheckSubmissionError)
    try {
      validateSemanticSubmission(TEXT, [])
    } catch (error) {
      expect(error).toBeInstanceOf(CheckSubmissionError)
      expect((error as CheckSubmissionError).rounds_consumed).toBe(0)
      expect((error as CheckSubmissionError).failure_class).toBe('submission')
      expect((error as CheckSubmissionError).items.length).toBeGreaterThan(0)
    }
  })

  it('exposes pair conflicts and all blocking rows on the typed submission error', () => {
    let caught: CheckSubmissionError | null = null
    try {
      validateSemanticSubmission(TEXT, [
        item('L2-SCENE-ANCHOR', CROSS[0]!),
        item('L2-CHARACTER-STATE', CROSS[0]!),
      ])
    } catch (error) {
      caught = error as CheckSubmissionError
    }
    expect(caught).toBeInstanceOf(CheckSubmissionError)
    expect(caught!.conflicts).toEqual([
      expect.objectContaining({ kind: 'duplicate', other_id: 'L2-SCENE-ANCHOR' }),
    ])
    expect(caught!.blocking.length).toBeGreaterThanOrEqual(4)
    expect(caught!.message).toContain('L2-CHARACTER-STATE↔L2-SCENE-ANCHOR')
    expect(caught!.message).toContain('no check was written')
  })
})
