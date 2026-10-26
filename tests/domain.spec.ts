import { describe, expect, it } from 'vitest'
import { countWordMetrics, countWordMetricsOfParagraph } from '../src/domain/wordcount.js'
import { paragraphAt, sentenceRhythm, splitParagraphs, splitSentences } from '../src/domain/text.js'
import {
  hammingDistance,
  maxParagraphSimilarity,
  simhash,
  similarity,
  textSimilarity,
} from '../src/domain/simhash.js'
import {
  SCORE_DIMENSIONS,
  applyExclusions,
  dimensionScore,
  maxOf,
  reviewArithmeticProblems,
  sumDeductions,
  totalScore,
} from '../src/domain/scoring.js'
import {
  availableOps,
  canRun,
  findTransition,
  nextStage,
  roundsExhausted,
} from '../src/domain/transitions.js'
import { allocateIds, formatId, parseId } from '../src/domain/ids.js'
import type { Operation, ScoreDimension, Stage } from '../src/types.js'

const dim = (
  id: string,
  max: number,
  deductions: Array<{ rule: string; location: string; delta: number }> = [],
): ScoreDimension => ({
  id,
  max,
  deductions: deductions.map((deduction) => ({ ...deduction, note: 'note' })),
})

const fullDimensions = (): ScoreDimension[] => SCORE_DIMENSIONS.map(({ id, max }) => dim(id, max))

describe('word count', () => {
  it('counts CJK, English words, standalone numbers and both punctuation ranges', () => {
    const metrics = countWordMetrics('你好，world 123。')
    expect(metrics.cjk_chars).toBe(2)
    expect(metrics.english_words).toBe(1)
    expect(metrics.numbers).toBe(1)
    expect(metrics.chinese_punct).toBe(2)
    expect(metrics.english_punct).toBe(0)
    expect(metrics.total_word_count).toBe(6)
  })

  it('does not double count digits inside an identifier', () => {
    const metrics = countWordMetrics('ABC123')
    expect(metrics.numbers).toBe(0)
    expect(metrics.english_words).toBe(1)
  })

  it('counts curly quotes and dashes as English punctuation (the documented trap)', () => {
    const metrics = countWordMetrics('“你好”——……')
    expect(metrics.english_punct).toBe(6)
    expect(metrics.chinese_punct).toBe(0)
  })

  it('treats empty and whitespace text as zero', () => {
    expect(countWordMetrics('').total_word_count).toBe(0)
    expect(countWordMetrics('   \n\n').non_empty_lines).toBe(0)
    expect(countWordMetrics('   \n\n').dialogue_ratio).toBe(0)
  })

  it('counts dialogue lines and paragraph maxima', () => {
    const metrics = countWordMetrics('"你好"\n\n"再见"\n\n无引号\n\n' + '字'.repeat(95))
    expect(metrics.dialogue_lines).toBe(2)
    expect(metrics.dialogue_ratio).toBe(2 / 4)
    expect(metrics.paragraph_max_words).toBe(95)
    expect(countWordMetricsOfParagraph('四个汉字')).toBe(4)
  })
})

describe('text segmentation', () => {
  it('splits paragraphs on blank lines and trims', () => {
    expect(splitParagraphs('\n\n甲\n\n\n乙  \n')).toEqual(['甲', '乙'])
    expect(splitSentences('甲。乙！丙？')).toEqual(['甲', '乙', '丙'])
  })

  it('computes rhythm and paragraph lookup', () => {
    const rhythm = sentenceRhythm('今天是晴天。明天也是晴天。后天还是晴天。好。')
    expect(rhythm.count).toBe(4)
    expect(rhythm.average).toBeGreaterThan(0)
    expect(rhythm.uniformRatio).toBeGreaterThan(0)
    expect(sentenceRhythm('')).toEqual({ count: 0, average: 0, min: 0, max: 0, uniformRatio: 0 })
    expect(paragraphAt('甲\n\n乙', 2)).toBe('乙')
    expect(paragraphAt('甲', 0)).toBeNull()
    expect(paragraphAt('甲', 2)).toBeNull()
    expect(paragraphAt('甲', 1.5)).toBeNull()
  })
})

describe('simhash', () => {
  it('is deterministic and identical inputs are fully similar', () => {
    expect(simhash('重复的段落文本')).toBe(simhash('重复的段落文本'))
    expect(similarity(simhash('甲乙丙丁'), simhash('甲乙丙丁'))).toBe(1)
    expect(hammingDistance(1n, 1n)).toBe(0)
    expect(hammingDistance(0n, (1n << 64n) - 1n)).toBe(64)
  })

  it('separates unrelated text and detects near duplicates', () => {
    expect(textSimilarity('甲乙丙丁戊己', '甲乙丙丁戊己')).toBe(1)
    const near = textSimilarity(
      '我们走进一间很大的办公室，窗边有三排工位。',
      '我们走进一间很大的办公室，窗边有三排工位。',
    )
    expect(near).toBe(1)
    expect(textSimilarity('晴天', '雨天')).toBeLessThan(1)
    expect(maxParagraphSimilarity('甲段落内容', ['完全无关的乙段落', '甲段落内容'])).toBeGreaterThan(0.9)
    expect(maxParagraphSimilarity('甲', [])).toBe(0)
    expect(simhash('')).toBe(0n)
  })
})

describe('scoring arithmetic', () => {
  it('sums deductions and floors each dimension at zero', () => {
    const dimensions = fullDimensions()
    dimensions[0] = dim('R-W-01', 15, [{ rule: 'X', location: '第 1 段', delta: 20 }])
    expect(sumDeductions(dimensions)).toBe(20)
    expect(dimensionScore(dimensions[0]!)).toBe(0)
    expect(totalScore(dimensions)).toBe(130)
    expect(maxOf('R-W-01')).toBe(15)
    expect(maxOf('NOPE')).toBe(0)
  })

  it('accepts a closing review and rejects broken arithmetic', () => {
    const dimensions = fullDimensions()
    expect(reviewArithmeticProblems(dimensions, 150)).toEqual([])
    expect(reviewArithmeticProblems(dimensions, 149)).toEqual([expect.stringContaining('does not equal')])
    const short = fullDimensions().slice(1)
    expect(reviewArithmeticProblems(short, 150)).toEqual(
      expect.arrayContaining([expect.stringContaining('dimensions')]),
    )
    const negative = fullDimensions()
    negative[0] = dim('R-W-01', 15, [{ rule: 'X', location: '第 1 段', delta: 0 }])
    expect(reviewArithmeticProblems(negative, 150)).toEqual(
      expect.arrayContaining([expect.stringContaining('delta must be > 0')]),
    )
    const missing = fullDimensions()
    missing[0] = { id: 'R-W-01', max: 15, deductions: [{ rule: '', location: '', delta: 1, note: '' }] }
    expect(reviewArithmeticProblems(missing, 149)).toEqual(
      expect.arrayContaining([expect.stringContaining('missing rule')]),
    )
    const over = fullDimensions()
    over[0] = dim('R-W-01', 15, [{ rule: 'X', location: '第 1 段', delta: 99 }])
    expect(reviewArithmeticProblems(over, 51)).toEqual(
      expect.arrayContaining([expect.stringContaining('exceed max')]),
    )
    expect(reviewArithmeticProblems(dimensions, 999)).toEqual(
      expect.arrayContaining([expect.stringContaining('outside')]),
    )
    expect(
      reviewArithmeticProblems(
        [
          null,
          {},
          { id: '', max: 1, deductions: [] },
          { id: 'R-W-01', max: -1, deductions: [] },
          { id: 'R-W-03', max: 10, deductions: null },
          { id: 'R-W-02', max: 10, deductions: [null, { delta: 'x', rule: 1, note: null, location: 2 }] },
        ] as never,
        Number.NaN,
      ),
    ).toEqual(
      expect.arrayContaining([
        'each dimension must be an object',
        'each dimension must have an id',
        expect.stringContaining('max must be a non-negative number'),
        expect.stringContaining('each deduction must be an object'),
        expect.stringContaining('missing rule/location/note'),
        expect.stringContaining('outside'),
      ]),
    )
    expect(reviewArithmeticProblems(null as never, 0)).toEqual(['dimensions must be an array'])
    expect(applyExclusions([{ id: 'R-W-01', max: 15, deductions: null }] as never, [])).toEqual({
      dimensions: [{ id: 'R-W-01', max: 15, deductions: [] }],
      dropped: 0,
    })
    expect(sumDeductions(null as never)).toBe(0)
    expect(sumDeductions([{ deductions: [{ delta: Number.NaN }] }] as never)).toBe(0)
    expect(applyExclusions(null as never, [])).toEqual({ dimensions: [], dropped: 0 })
    expect(
      applyExclusions(
        [
          {
            id: 'R-W-01',
            max: 15,
            deductions: [{ rule: 'A', location: '正文', delta: 1, note: 'n' }],
          },
        ],
        [],
      ).dimensions[0]!.deductions,
    ).toHaveLength(1)
  })

  it('keeps the heaviest duplicate and canonicalizes paragraph spacing for exclusions', () => {
    const dimensions = fullDimensions()
    dimensions[0] = dim('R-W-01', 15, [
      { rule: 'A', location: '第2段', delta: 1 },
      { rule: 'A', location: '第 2 段', delta: 5 },
    ])
    dimensions[1] = dim('R-W-02', 10, [{ rule: 'B', location: '第 2 段', delta: 2 }])
    dimensions[2] = dim('R-W-03', 10, [{ rule: 'C', location: '第2段', delta: 1 }])
    const result = applyExclusions(dimensions, [{ pair: ['B', 'C'], family: 'f' }])
    expect(result.dimensions[0]!.deductions).toHaveLength(1)
    expect(result.dimensions[0]!.deductions[0]!.delta).toBe(5)
    expect(result.dimensions[1]!.deductions).toHaveLength(1)
    expect(result.dimensions[2]!.deductions).toHaveLength(0)
  })

  it('drops duplicates and the lighter side of an exclusive pair', () => {
    const dimensions = fullDimensions()
    dimensions[0] = dim('R-W-01', 15, [
      { rule: 'A', location: '第 1 段', delta: 3 },
      { rule: 'A', location: '第 1 段', delta: 3 },
    ])
    dimensions[1] = dim('R-W-02', 10, [{ rule: 'B', location: '第 2 段', delta: 1 }])
    dimensions[2] = dim('R-W-03', 10, [{ rule: 'C', location: '第 2 段', delta: 5 }])
    const result = applyExclusions(dimensions, [{ pair: ['B', 'C'], family: 'f' }])
    expect(result.dropped).toBe(2)
    expect(result.dimensions[0]!.deductions).toHaveLength(1)
    expect(result.dimensions[1]!.deductions).toHaveLength(0)
    expect(result.dimensions[2]!.deductions).toHaveLength(1)
  })
})

describe('transition table', () => {
  const stages: Stage[] = ['idle', 'P2', 'P3', 'P4', 'P5', 'P6', 'ready_to_archive', 'done']
  const ops: Operation[] = [
    'submitWorldPlan',
    'submitChapterPlan',
    'submitDraft',
    'submitReview',
    'submitRevision',
    'runCheck',
    'archiveChapter',
  ]

  it('is total over the stage × operation matrix', () => {
    for (const stage of stages) {
      for (const op of ops) {
        const transition = findTransition(stage, op)
        expect(canRun(stage, op)).toBe(transition !== undefined)
      }
    }
    expect(findTransition('P4', 'submitReview')).toBeDefined()
    expect(findTransition('P3', 'archiveChapter')).toBeUndefined()
  })

  it('has exactly one data-dependent branch (P4 review → P5 or P6)', () => {
    expect(nextStage('P4', 'submitReview', 1)).toBe('P5')
    expect(nextStage('P4', 'submitReview', 0)).toBe('P6')
    expect(nextStage('idle', 'submitWorldPlan', 0)).toBe('P2')
    expect(nextStage('ready_to_archive', 'archiveChapter', 0)).toBe('done')
    expect(() => nextStage('P3', 'archiveChapter', 0)).toThrow(/not allowed at stage P3/)
  })

  it('lists available operations and round exhaustion', () => {
    expect(availableOps('P4')).toEqual(['submitReview'])
    expect(availableOps('done')).toEqual(['submitWorldPlan'])
    expect(roundsExhausted({ review: 3, revise: 0, check: 0 })).toBe(true)
    expect(roundsExhausted({ review: 0, revise: 0, check: 2 })).toBe(false)
  })
})

describe('id allocation', () => {
  it('formats, parses and allocates sequentially', () => {
    expect(formatId('FS', 7)).toBe('FS-007')
    expect(parseId('FS', 'FS-007')).toBe(7)
    expect(parseId('FS', 'TE-007')).toBeNull()
    expect(parseId('FS', 'FS-0')).toBeNull()
    expect(allocateIds('TE', 3, 2)).toEqual({ ids: ['TE-003', 'TE-004'], nextSeq: 5 })
    expect(() => formatId('FS', 0)).toThrow()
    expect(() => allocateIds('FS', 1, -1)).toThrow()
  })
})
