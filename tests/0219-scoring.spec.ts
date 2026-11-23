import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import {
  basisOf,
  FULL_SCORE,
  MACHINE_DIMENSIONS,
  MACHINE_SCORING,
  machineDimensionScores,
  maxOf,
} from '../src/domain/scoring.js'
import {
  archiveDelta,
  bootstrapToDraft,
  cleanText,
  harness,
  readyToArchive,
  sampleReview,
  sampleSummary,
  writeDraft,
} from './helpers.js'
import { ruleRegistry } from '../src/rules/pipeline.js'
import type { ScoreDimension } from '../src/types.js'

/**
 * 0.2.19 WP4 — 机检度.
 *
 * `DESIGN.md` has claimed since 1500 that a ● dimension is scored by the engine
 * and cannot be overridden by the model. Until 0.2.19 the model's own number was
 * taken at face value, which made the five format dimensions (15 points) the one
 * part of the score nobody could audit.
 */

const scoreOf = (code: string, count: number) =>
  machineDimensionScores([{ code, hits: count }]).get('R-W-06')!

describe('machineDimensionScores arithmetic', () => {
  it('leaves every dimension full when nothing fired', () => {
    const scores = machineDimensionScores([])
    expect([...scores.keys()]).toEqual(MACHINE_DIMENSIONS)
    for (const [id, score] of scores) {
      expect({ id, deduction: score.deduction, effective: score.effective }).toEqual({
        id,
        deduction: 0,
        effective: maxOf(id),
      })
    }
  })

  it('deducts weight × hits and stops at the per-code cap', () => {
    // LONG_PARAGRAPH: weight 2, cap 4.
    expect(scoreOf('LONG_PARAGRAPH', 1)).toMatchObject({ deduction: 2, effective: 2 })
    expect(scoreOf('LONG_PARAGRAPH', 2)).toMatchObject({ deduction: 4, effective: 0 })
    // Three long paragraphs cannot spend more than the cap.
    expect(scoreOf('LONG_PARAGRAPH', 3)).toMatchObject({ deduction: 4, effective: 0 })
  })

  it('adds two codes together but never beyond the dimension maximum', () => {
    // LONG_PARAGRAPH 1 + SHORT_PARAGRAPH 1 = 2 + 1.
    const rows = machineDimensionScores([
      { code: 'LONG_PARAGRAPH', hits: 1 },
      { code: 'SHORT_PARAGRAPH', hits: 1 },
    ])
    expect(rows.get('R-W-06')).toMatchObject({ deduction: 3, effective: 1 })
  })

  it('caps the whole dimension, not only each code', () => {
    // R-W-08 is worth 4: PUNCT_STANDARD 2 + ILLEGAL_QUOTE 4 = 6 → 4.
    const rows = machineDimensionScores([
      { code: 'PUNCT_STANDARD', hits: 1 },
      { code: 'ILLEGAL_QUOTE', hits: 1 },
    ])
    expect(rows.get('R-W-08')).toMatchObject({ deduction: 4, effective: 0 })
  })

  it('records which code took which points', () => {
    const rows = machineDimensionScores([
      { code: 'TITLE_FORMAT', hits: 1 },
      { code: 'WORD_COUNT_SHORT', hits: 1 },
    ])
    expect(rows.get('R-W-10')!.rules).toEqual([{ code: 'TITLE_FORMAT', hits: 1, delta: 1 }])
    expect(rows.get('R-W-09')!.rules).toEqual([{ code: 'WORD_COUNT_SHORT', hits: 1, delta: 2 }])
  })

  it('ignores an unknown code and a non-positive count', () => {
    const rows = machineDimensionScores([
      { code: 'NOT_A_RULE', hits: 9 },
      { code: 'LONG_PARAGRAPH', hits: 0 },
      { code: 'SHORT_PARAGRAPH', hits: -2 },
    ])
    expect(rows.get('R-W-06')!.deduction).toBe(0)
  })

  it('maps exactly the five format dimensions', () => {
    expect(MACHINE_DIMENSIONS).toEqual(['R-W-06', 'R-W-07', 'R-W-08', 'R-W-09', 'R-W-10'])
    expect(MACHINE_DIMENSIONS.reduce((total, id) => total + maxOf(id), 0)).toBe(15)
  })
})

describe('机检度 basis', () => {
  it('marks the five format dimensions machine and R-W-13 hybrid', () => {
    expect(basisOf('R-W-06')).toBe('machine')
    expect(basisOf('R-W-07')).toBe('machine')
    expect(basisOf('R-W-08')).toBe('machine')
    expect(basisOf('R-W-09')).toBe('machine')
    expect(basisOf('R-W-10')).toBe('machine')
    // 0.2.19: 信息增量 was marked ● in DESIGN and had no implementation. Calling
    // it engine-scored would have required inventing a metric.
    expect(basisOf('R-W-13')).toBe('hybrid')
  })

  it('leaves every other dimension to the model', () => {
    for (const id of [
      'R-W-01',
      'R-W-02',
      'R-W-03',
      'R-W-04',
      'R-W-05',
      'R-W-11',
      'R-W-12',
      'R-W-14',
      'R-W-15',
    ]) {
      expect({ id, basis: basisOf(id) }).toEqual({ id, basis: 'semantic' })
    }
  })

  it('keeps the fifteen-dimension total at 150', () => {
    expect(FULL_SCORE).toBe(150)
    expect(MACHINE_SCORING['R-W-08']!.every((rule) => rule.cap <= maxOf('R-W-08'))).toBe(true)
  })
})

describe('novel_review applies the machine score', () => {
  /**
   * Three consecutive stubs: `SHORT_PARAGRAPH` reports a run, so one short line
   * would not fire. They go second, never last: PG-09 reads the ending proof out
   * of the last paragraph, and a four-character final line fails the gate before
   * the score is ever looked at.
   */
  const withStub = (): string => {
    const paragraphs = cleanText().split('\n\n')
    // Before the last paragraph, so both the middle quote and the ending quote
    // that `sampleReview` builds still land on long paragraphs.
    return [...paragraphs.slice(0, -1), '他走了。', '灯灭了。', '雨停了。', paragraphs.at(-1)!].join('\n\n')
  }

  const dimensionsWith = (deduction: number): ScoreDimension[] =>
    sampleReview(1, cleanText()).dimensions.map((dimension) =>
      dimension.id === 'R-W-06'
        ? {
            ...dimension,
            deductions:
              deduction === 0
                ? []
                : [
                    {
                      rule: 'SHORT_PARAGRAPH',
                      location: '第 6 段',
                      note: '三五字另起一段',
                      delta: deduction,
                    },
                  ],
          }
        : dimension,
    )

  const atP4 = async (text: string) => {
    const h = await harness()
    await bootstrapToDraft({ root: h.root, engine: h.engine })
    await writeDraft({ root: h.root, engine: h.engine, text })
    await h.engine.getBrief({ stage: 'P4', root: h.root })
    return h
  }

  it('overrides a declared format score with the measured one', async () => {
    const text = withStub()
    const h = await atP4(text)
    try {
      const sample = sampleReview(1, text)
      const result = await h.engine.submitReview({
        chapter: 1,
        dimensions: dimensionsWith(0),
        issues: sample.issues,
        proof: sample.proof,
        root: h.root,
      })
      // SHORT_PARAGRAPH: weight 1 → R-W-06 loses one point.
      expect(result.data.adjusted).toMatchObject([
        { id: 'R-W-06', declared: 4, effective: 3, basis: 'machine' },
        // The three stubs are also three one-sentence paragraphs, so the
        // parallel-run code moves the AI-tone dimension too.
        { id: 'R-W-07', declared: 4, effective: 3, basis: 'machine' },
      ])
      expect(result.data.total).toBe(150 - 5 - 2)
      const scores = result.data.machine_scores ?? []
      expect(scores.map((score) => score.id)).toEqual(['R-W-06', 'R-W-07', 'R-W-08', 'R-W-09', 'R-W-10'])
      expect(scores.find((score) => score.id === 'R-W-06')!.rules).toEqual([
        { code: 'SHORT_PARAGRAPH', hits: 1, delta: 1 },
      ])
    } finally {
      await h.cleanup()
    }
  })

  it('records the same override in the persisted review document', async () => {
    const text = withStub()
    const h = await atP4(text)
    try {
      const sample = sampleReview(1, text)
      await h.engine.submitReview({
        chapter: 1,
        dimensions: dimensionsWith(0),
        issues: sample.issues,
        proof: sample.proof,
        root: h.root,
      })
      const stored = (await h.engine.queryState({ kind: 'review', root: h.root })).data as {
        machine_scores: Array<{ id: string; declared: number; effective: number }>
        dimensions: ScoreDimension[]
        total: number
      }
      expect(stored.machine_scores.find((score) => score.id === 'R-W-06')).toMatchObject({
        declared: 4,
        effective: 3,
      })
      expect(stored.dimensions.find((dimension) => dimension.id === 'R-W-06')!.deductions).toEqual([
        expect.objectContaining({ rule: 'SHORT_PARAGRAPH', delta: 1 }),
      ])
      expect(stored.total).toBe(143)
    } finally {
      await h.cleanup()
    }
  })

  it('rejects a total the model declared from its own format deductions', async () => {
    const text = withStub()
    const h = await atP4(text)
    try {
      const sample = sampleReview(1, text)
      const error = await h.engine
        .submitReview({
          chapter: 1,
          dimensions: dimensionsWith(0),
          issues: sample.issues,
          proof: sample.proof,
          total: 145,
          root: h.root,
        })
        .catch((caught: unknown) => caught)
      expect((error as Error).message).toContain('claimed total 145')
      expect((error as Error).message).toContain('(143)')
      // The hint must say what to do, not only that it failed.
      expect((error as { hint?: string }).hint).toContain('机检度')
      const details = (error as { details?: { machine_scores?: unknown[] } }).details
      expect(details?.machine_scores).toHaveLength(5)
    } finally {
      await h.cleanup()
    }
  })

  it('accepts the engine total when the model echoes it', async () => {
    const text = withStub()
    const h = await atP4(text)
    try {
      const sample = sampleReview(1, text)
      const result = await h.engine.submitReview({
        chapter: 1,
        dimensions: dimensionsWith(0),
        issues: sample.issues,
        proof: sample.proof,
        total: 143,
        root: h.root,
      })
      expect(result.data.total).toBe(143)
    } finally {
      await h.cleanup()
    }
  })

  it('reports a dimension that has an issue but no deduction', async () => {
    const text = cleanText()
    const h = await atP4(text)
    try {
      const sample = sampleReview(1, text)
      const result = await h.engine.submitReview({
        chapter: 1,
        dimensions: dimensionsWith(0),
        issues: [
          {
            id: 'REV-001',
            severity: 'advisory',
            dimension: 'R-W-04',
            location: '第 2 段',
            problem: '爽点偏弱',
            fix: '把反转提前到第三段',
            status: 'open',
          },
        ],
        proof: sample.proof,
        root: h.root,
      })
      const warning = result.warnings.find((entry) => entry.code === 'DEDUCTION_NOT_ANCHORED')
      expect(warning?.message).toContain('R-W-04')
      expect(warning?.message).toContain('零扣分')
    } finally {
      await h.cleanup()
    }
  })

  it('does not warn when the dimension carries the deduction', async () => {
    const text = cleanText()
    const h = await atP4(text)
    try {
      const sample = sampleReview(1, text)
      const result = await h.engine.submitReview({
        chapter: 1,
        dimensions: sample.dimensions,
        issues: [
          {
            id: 'REV-001',
            severity: 'blocker',
            dimension: 'R-W-01',
            location: '第 2 段',
            problem: '缺动机',
            fix: '补一句理由',
            status: 'open',
          },
        ],
        proof: sample.proof,
        root: h.root,
      })
      expect(result.warnings.some((entry) => entry.code === 'DEDUCTION_NOT_ANCHORED')).toBe(false)
    } finally {
      await h.cleanup()
    }
  })
})

describe('every code in MACHINE_SCORING is real', () => {
  it('names registered rule codes plus the one internal signal', () => {
    // A typo in this table would silently score nothing for a whole dimension.
    const internal = new Set(['WORD_COUNT_SHORT'])
    const mapped = [
      ...new Set(
        Object.values(MACHINE_SCORING)
          .flat()
          .map((rule) => rule.code),
      ),
    ]
    for (const code of mapped) {
      if (internal.has(code)) continue
      expect({ code, owned: ruleRegistry().has(code) }).toEqual({ code, owned: true })
    }
    expect(mapped.filter((code) => internal.has(code))).toEqual(['WORD_COUNT_SHORT'])
  })
})

/**
 * 0.2.19 WP5 — 口径诚实.
 *
 * The plan's risk table says a chapter archived before the machine-scored
 * format dimensions is not comparable with a re-scored one, and that the report
 * must name it rather than silently average two scales. This is that flag.
 */
describe('scoring basis in the book report', () => {
  it('records the machine basis at archive and stays quiet when every chapter has it', async () => {
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      await h.engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root: h.root,
      })
      const stored = parse(await readFile(join(h.root, 'state/chapters.yaml'), 'utf8')) as {
        chapters: Array<{ num: number; scoring_basis?: string }>
      }
      expect(stored.chapters[0]!.scoring_basis).toBe('machine')
      const report = await h.engine.report({ root: h.root })
      expect(report.data.scoring_basis).toBeUndefined()
    } finally {
      await h.cleanup()
    }
  })

  it('names a legacy row in the report instead of averaging it with machine scores', async () => {
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      await h.engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root: h.root,
      })
      const path = 'state/chapters.yaml'
      // Simulate a row written by 0.2.18: no machine basis at all.
      const document = parse(await readFile(join(h.root, path), 'utf8')) as {
        chapters: Array<Record<string, unknown>>
      }
      delete document.chapters[0]!.scoring_basis
      await h.engine.amend({
        path,
        content: document as Record<string, unknown>,
        reason: 'legacy row',
        root: h.root,
      })
      const report = await h.engine.report({ root: h.root })
      expect(report.data.scoring_basis).toEqual({
        machine: 'R-W-06..R-W-10',
        legacy_chapters: [1],
        note: '这些章按模型自评口径评审；重跑 P6 会按机检度重算，分数可能下降',
      })
    } finally {
      await h.cleanup()
    }
  })

  it('names a legacy row that predates the archived_at field too', async () => {
    // 0.2.18-era rows are not homogeneous: the oldest ones have no `archived_at`
    // either, and the report already backfills it from the journal for the
    // chapters table. `legacy_chapters` must use the same backfill, or the first
    // chapter of a real 57-chapter book disappears from the warning (§3).
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      await h.engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root: h.root,
      })
      const path = 'state/chapters.yaml'
      const document = parse(await readFile(join(h.root, path), 'utf8')) as {
        chapters: Array<Record<string, unknown>>
      }
      delete document.chapters[0]!.scoring_basis
      delete document.chapters[0]!.archived_at
      // `novel_amend` rightly refuses to strip `archived_at` from an archived
      // chapter, so this fixture writes the row the way 0.2.18 left it on disk.
      await writeFile(join(h.root, path), stringify(document))
      const report = await h.engine.report({ root: h.root })
      expect(report.data.scoring_basis?.legacy_chapters).toEqual([1])
    } finally {
      await h.cleanup()
    }
  })
})
