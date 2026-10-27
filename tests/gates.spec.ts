import { describe, expect, it } from 'vitest'
import { SCORE_DIMENSIONS } from '../src/domain/scoring.js'
import {
  evaluateGates,
  applicableGates,
  verifyReference,
  parseParagraphLocation,
  briefStageFor,
} from '../src/engine/gates.js'
import { loadRulepack } from '../src/rulepack.js'
import { cleanText, sampleSummary } from './helpers.js'
import type { GateInput, ReadingProof, ReviewDocument, ScoreDimension, Stage } from '../src/types.js'

const rulepack = loadRulepack()
const options = { rulepack, minScore: 120 }
const text = cleanText()

const dimensions = (delta = 0): ScoreDimension[] =>
  SCORE_DIMENSIONS.map(({ id, max }, index) => ({
    id,
    max,
    deductions:
      index === 0 && delta > 0 ? [{ rule: 'NO_MOTIVE', location: '第 2 段', delta, note: '缺动机' }] : [],
  }))

const review = (total = 150, delta = 0, patch: Partial<ReviewDocument> = {}): ReviewDocument => ({
  schema_version: 1,
  chapter: 1,
  round: 1,
  content_hash: 'sha256:x',
  dimensions: dimensions(delta),
  issues: [],
  total,
  proof: proof(),
  ...patch,
})

const proof = (): ReadingProof => ({
  opening: { paragraph: 1, quote: text.split('\n')[0]!.slice(0, 14) },
  middle: { paragraph: 2, quote: text.split('\n')[2]!.slice(0, 14) },
  ending: { paragraph: 4, quote: text.split('\n')[6]!.slice(0, 14) },
})

const input = (patch: Partial<GateInput> = {}): GateInput => ({
  operation: 'submitDraft',
  stage: 'P3',
  text,
  chapter: 1,
  project: {
    schema_version: 1,
    title: '测试',
    genre: '都市现代',
    platform: 'fanqie',
    author: '',
    description: '',
    created_at: '2026-01-01',
    targets: { words_per_chapter: [80, 400], total_chapters: null, dialogue_ratio: [0.4, 0.6] },
  },
  pipeline: {
    schema_version: 1,
    revision: 1,
    chapter: 1,
    stage: 'P3',
    rounds: { review: 0, revise: 0, check: 0 },
    briefs: { P3: { issued_at: '2026-01-01', digest: 'D' } },
    blocking: [],
    last_action: null,
  },
  chapters: { schema_version: 1, chapters: [] },
  briefDigest: 'D',
  briefStage: 'P3',
  draftTitle: '第1章 开端之雨',
  sceneType: '日常过渡章',
  summary: sampleSummary(),
  review: null,
  check: null,
  semantic: [],
  proof: null,
  rounds: { review: 0, revise: 0, check: 0 },
  archive: null,
  evidence: {
    characters: null,
    foreshadows: null,
    timeline: null,
    relationships: null,
    world: null,
    locks: null,
  },
  previousText: null,
  previousTexts: [],
  priorSceneTypes: [],
  ...patch,
})

const codes = (gateInput: GateInput): string[] =>
  evaluateGates(gateInput, options).blocking.map((item) => item.code)

describe('gate evaluation', () => {
  it('applies only the gates that belong to the operation', () => {
    expect(applicableGates(input())).toEqual(['PG-01', 'PG-02', 'PG-04', 'PG-03', 'PG-05', 'PG-06'])
    expect(applicableGates(input({ operation: 'submitReview' }))).toEqual([
      'PG-01',
      'PG-02',
      'PG-09',
      'PG-07',
      'PG-11',
    ])
    expect(applicableGates(input({ operation: 'runCheck' }))).toEqual([
      'PG-01',
      'PG-02',
      'PG-04',
      'PG-05',
      'PG-08',
      'PG-09',
      'PG-10',
      'PG-11',
    ])
    expect(applicableGates(input({ operation: 'archiveChapter' }))).toContain('PG-12')
    expect(applicableGates(input({ operation: 'submitWorldPlan' }))).toEqual(['PG-01', 'PG-02'])
    expect(briefStageFor('submitWorldPlan', 'idle')).toBe('P1')
    expect(briefStageFor('submitRevision', 'P6')).toBe('P6')
    expect(briefStageFor('submitRevision', 'P5')).toBe('P5')
    expect(briefStageFor('runCheck', 'P6')).toBe('P6')
    expect(briefStageFor('archiveChapter', 'ready_to_archive')).toBe('P8')
    expect(briefStageFor('getStatus', 'idle')).toBeNull()
  })

  it('PG-10 is skipped when runCheck excludes integrity', () => {
    const checkInput = input({
      operation: 'runCheck',
      stage: 'P6',
      pipeline: {
        ...input().pipeline,
        stage: 'P6',
        briefs: { P6: { issued_at: '2026-01-01', digest: 'D' } },
      },
      briefStage: 'P6',
      proof: proof(),
      previousTexts: [text],
      scope: ['content'],
    })
    expect(codes({ ...checkInput, scope: undefined })).toContain('PG-10')
    expect(codes(checkInput)).not.toContain('PG-10')
  })

  it('runs PG-04 before PG-03 and collects every failure', () => {
    const gateInput = input({ text: '他推开门，“你敢”。\n\n短。', summary: null, sceneType: null })
    const blocking = evaluateGates(gateInput, options).blocking
    expect(blocking.length).toBeGreaterThanOrEqual(3)
    expect(blocking.map((item) => item.code)).toContain('PG-04')
    expect(blocking.map((item) => item.code)).toContain('PG-05')
    expect(blocking.findIndex((item) => item.code === 'PG-04')).toBeLessThan(
      blocking.findIndex((item) => item.code === 'PG-03'),
    )
    expect(blocking.every((item) => typeof item.scope === 'string')).toBe(true)
  })

  it('PG-01 requires a matching brief digest', () => {
    expect(codes(input({ briefDigest: 'other' }))).toContain('PG-01')
    expect(codes(input({ briefDigest: 'other', pipeline: { ...input().pipeline, briefs: {} } }))).toContain(
      'PG-01',
    )
    expect(codes(input({ briefDigest: null, briefStage: null }))).toContain('PG-01')
    expect(codes(input())).not.toContain('PG-01')
  })

  it('PG-02 rejects an operation from the wrong stage', () => {
    expect(codes(input({ stage: 'P4', pipeline: { ...input().pipeline, stage: 'P4' as Stage } }))).toContain(
      'PG-02',
    )
  })

  it('PG-03 measures with the engine count and reports the gap', () => {
    expect(codes(input({ text: '太短了。' }))).toContain('PG-03')
    expect(
      codes(
        input({
          project: {
            ...input().project,
            targets: { words_per_chapter: [0, 1], total_chapters: null, dialogue_ratio: [0, 1] },
          },
        }),
      ),
    ).not.toContain('PG-03')
  })

  it('PG-05 validates the ten summary fields and value ranges', () => {
    expect(codes(input({ summary: null }))).toContain('PG-05')
    expect(codes(input({ summary: { ...sampleSummary(), events: [] } }))).toContain('PG-05')
    expect(codes(input({ summary: { ...sampleSummary(), hook_strength: 9 } }))).toContain('PG-05')
    expect(codes(input({ summary: { ...sampleSummary(), plot_advancement: 'nope' as never } }))).toContain(
      'PG-05',
    )
    expect(codes(input({ summary: { ...sampleSummary(), opening: ' ' } }))).toContain('PG-05')
    expect(codes(input({ summary: { ...sampleSummary(), opening: '风' } }))).toContain('PG-05')
  })

  it('PG-06 rejects monotony and back-to-back action chapters', () => {
    expect(codes(input({ sceneType: null }))).toContain('PG-06')
    expect(codes(input({ priorSceneTypes: ['日常过渡章', '日常过渡章'] }))).toContain('PG-06')
    expect(codes(input({ sceneType: '战斗/动作章', priorSceneTypes: ['战斗/动作章'] }))).toContain('PG-06')
  })

  it('PG-07 requires closing arithmetic, locatable deductions and the score floor', () => {
    const gateInput = input({
      operation: 'submitReview',
      stage: 'P4',
      pipeline: { ...input().pipeline, stage: 'P4', briefs: { P4: { issued_at: 'x', digest: 'D' } } },
      briefStage: 'P4',
      proof: proof(),
      review: review(149, 5),
    })
    expect(codes(gateInput)).toContain('PG-07')
    const low = input({ ...gateInput, review: review(100, 50) })
    expect(codes(low)).toContain('PG-07')
    const badLocation = input({
      ...gateInput,
      review: review(145, 5, {
        dimensions: dimensions(5).map((dimension, index) =>
          index === 0
            ? { ...dimension, deductions: [{ rule: 'X', location: '别处', delta: 5, note: 'x' }] }
            : dimension,
        ),
      }),
    })
    expect(codes(badLocation)).toContain('PG-07')
    const outOfRange = input({
      ...gateInput,
      review: review(145, 5, {
        dimensions: dimensions(5).map((dimension, index) =>
          index === 0
            ? { ...dimension, deductions: [{ rule: 'X', location: '第 99 段', delta: 5, note: 'x' }] }
            : dimension,
        ),
      }),
    })
    expect(codes(outOfRange)).toContain('PG-07')
    expect(parseParagraphLocation('第 12 段')).toBe(12)
    expect(parseParagraphLocation('序章')).toBeNull()
  })

  it('PG-08 requires every blocker fixed with evidence found in the text', () => {
    const base = input({
      operation: 'submitRevision',
      stage: 'P5',
      pipeline: { ...input().pipeline, stage: 'P5', briefs: { P5: { issued_at: 'x', digest: 'D' } } },
      briefStage: 'P5',
      proof: proof(),
      review: review(),
    })
    expect(
      codes({
        ...base,
        review: review(150, 0, {
          issues: [
            {
              id: 'REV-1',
              severity: 'blocker',
              dimension: 'R-W-01',
              location: '第 1 段',
              problem: 'p',
              fix: 'f',
              status: 'open',
            },
          ],
        }),
      }),
    ).toContain('PG-08')
    expect(
      codes({
        ...base,
        review: review(150, 0, {
          issues: [
            {
              id: 'REV-1',
              severity: 'blocker',
              dimension: 'R-W-01',
              location: '第 1 段',
              problem: 'p',
              fix: 'f',
              status: 'waived',
            },
          ],
        }),
      }),
    ).toContain('PG-08')
    expect(
      codes({
        ...base,
        review: review(150, 0, {
          issues: [
            {
              id: 'REV-1',
              severity: 'blocker',
              dimension: 'R-W-01',
              location: '第 1 段',
              problem: 'p',
              fix: 'f',
              status: 'fixed',
              evidence: '这句话根本不在正文里面',
            },
          ],
        }),
      }),
    ).toContain('PG-08')
    expect(
      codes({
        ...base,
        review: review(150, 0, {
          issues: [
            {
              id: 'REV-1',
              severity: 'blocker',
              dimension: 'R-W-01',
              location: '第 1 段',
              problem: 'p',
              fix: 'f',
              status: 'fixed',
            },
          ],
        }),
      }),
    ).toContain('PG-08')
    expect(
      codes({
        ...base,
        review: review(150, 0, {
          issues: [
            {
              id: 'REV-1',
              severity: 'blocker',
              dimension: 'R-W-01',
              location: '第 1 段',
              problem: 'p',
              fix: 'f',
              status: 'fixed',
              evidence: text.split('\n')[0]!.slice(0, 12),
            },
          ],
        }),
      }),
    ).not.toContain('PG-08')
  })

  it('PG-09 verifies three real quotes at the right places', () => {
    const base = input({
      operation: 'submitReview',
      stage: 'P4',
      pipeline: { ...input().pipeline, stage: 'P4', briefs: { P4: { issued_at: 'x', digest: 'D' } } },
      briefStage: 'P4',
      review: review(),
    })
    expect(codes({ ...base, proof: null })).toContain('PG-09')
    expect(codes({ ...base, proof: {} as never })).toContain('PG-09')
    expect(
      codes({
        ...base,
        review: { ...review(), dimensions: [{}] } as never,
      }),
    ).toContain('PG-07')
    expect(
      codes({
        ...base,
        proof: {
          opening: { paragraph: 1, quote: '不存在的十二字引用内容' },
          middle: proof().middle,
          ending: proof().ending,
        },
      }),
    ).toContain('PG-09')
    expect(codes({ ...base, proof: { ...proof(), opening: { paragraph: 1, quote: '短句' } } })).toContain(
      'PG-09',
    )
    expect(
      codes({
        ...base,
        proof: { ...proof(), opening: { paragraph: 4, quote: text.split('\n')[0]!.slice(0, 14) } },
      }),
    ).toContain('PG-09')
    expect(
      codes({
        ...base,
        proof: { ...proof(), middle: { paragraph: 9, quote: text.split('\n')[2]!.slice(0, 14) } },
      }),
    ).toContain('PG-09')
    expect(verifyReference(text, proof().opening)).toBeNull()
  })

  it('PG-09 checks the actual paragraph, not the submitted paragraph, for opening and ending', () => {
    const longText = cleanText(6)
    const paragraphs = longText.split('\n\n')
    const base = input({
      operation: 'submitReview',
      stage: 'P4',
      text: longText,
      pipeline: { ...input().pipeline, stage: 'P4', briefs: { P4: { issued_at: 'x', digest: 'D' } } },
      briefStage: 'P4',
      review: review(),
    })
    const valid = {
      opening: { paragraph: 1, quote: paragraphs[0]!.slice(0, 14) },
      middle: { paragraph: 3, quote: paragraphs[2]!.slice(0, 14) },
      ending: { paragraph: 6, quote: paragraphs[5]!.slice(0, 14) },
    }
    expect(codes({ ...base, proof: valid })).not.toContain('PG-09')
    expect(
      codes({
        ...base,
        proof: {
          ...valid,
          // The quote is really in paragraph 3; claiming paragraph 2 passes the
          // ±1 locator tolerance and must still fail the opening boundary.
          opening: { paragraph: 2, quote: paragraphs[2]!.slice(0, 14) },
        },
      }),
    ).toContain('PG-09')
    expect(
      codes({
        ...base,
        proof: {
          ...valid,
          // The quote is really in paragraph 4; claiming paragraph 5 passes the
          // locator tolerance and must still fail the ending boundary.
          ending: { paragraph: 5, quote: paragraphs[3]!.slice(0, 14) },
        },
      }),
    ).toContain('PG-09')
    expect(
      codes({
        ...base,
        proof: {
          ...valid,
          // Paragraph 2 is an edge paragraph in a six-paragraph chapter, not
          // the body; a distinct paragraph alone is not enough for "middle".
          middle: { paragraph: 2, quote: paragraphs[1]!.slice(0, 14) },
        },
      }),
    ).toContain('PG-09')
  })

  it('PG-10 flags repeated cross-chapter content', () => {
    const gateInput = input({
      operation: 'runCheck',
      stage: 'P6',
      pipeline: { ...input().pipeline, stage: 'P6', briefs: { P6: { issued_at: 'x', digest: 'D' } } },
      briefStage: 'P6',
      previousText: text,
    })
    expect(codes(gateInput)).toContain('PG-10')
  })

  it('PG-11 blocks once the review/revise budget is spent', () => {
    const gateInput = input({
      operation: 'submitReview',
      stage: 'P4',
      pipeline: { ...input().pipeline, stage: 'P4', briefs: { P4: { issued_at: 'x', digest: 'D' } } },
      briefStage: 'P4',
      proof: proof(),
      review: review(),
      rounds: { review: 3, revise: 0, check: 0 },
    })
    expect(codes(gateInput)).toContain('PG-11')
  })

  it('PG-11 checks only the counter used by the operation', () => {
    const base = {
      ...input(),
      stage: 'P6' as const,
      pipeline: {
        ...input().pipeline,
        stage: 'P6' as const,
        briefs: { P6: { issued_at: 'x', digest: 'D' } },
      },
      briefStage: 'P6' as const,
      rounds: { review: 3, revise: 2, check: 2 },
    }
    expect(codes({ ...base, operation: 'runCheck' } as GateInput)).not.toContain('PG-11')
    expect(codes({ ...base, operation: 'submitRevision' } as GateInput)).not.toContain('PG-11')
    expect(codes({ ...base, operation: 'submitReview' } as GateInput)).toContain('PG-11')
  })

  it('PG-09 is applied at the archive boundary, not only at review', () => {
    const base = input({
      operation: 'archiveChapter',
      stage: 'ready_to_archive',
      pipeline: {
        ...input().pipeline,
        stage: 'ready_to_archive',
        briefs: { P8: { issued_at: 'x', digest: 'D' } },
      },
      briefStage: 'P8',
      proof: proof(),
      review: review(),
    })
    expect(codes(base)).not.toContain('PG-09')
    expect(
      codes({
        ...base,
        proof: {
          ...proof(),
          opening: { paragraph: 1, quote: '这是一段完全伪造的阅读证明引用' },
        },
      }),
    ).toContain('PG-09')
  })

  it('PG-12 checks archive preconditions', () => {
    const base = input({
      operation: 'archiveChapter',
      stage: 'ready_to_archive',
      pipeline: {
        ...input().pipeline,
        stage: 'ready_to_archive',
        briefs: { P8: { issued_at: 'x', digest: 'D' } },
      },
      briefStage: 'P8',
      proof: proof(),
      review: review(),
      check: {
        schema_version: 1,
        chapter: 1,
        scope: ['content'],
        content_hash: 'x',
        machine: {
          violations: [],
          metrics: {
            total_word_count: 1,
            cjk_chars: 1,
            english_words: 0,
            numbers: 0,
            chinese_punct: 0,
            english_punct: 0,
            non_ws_chars: 1,
            total_lines: 1,
            non_empty_lines: 1,
            dialogue_lines: 0,
            dialogue_ratio: 0,
            paragraph_count: 1,
            paragraph_max_words: 1,
          },
        },
        semantic: { items: [] },
        verdict: 'pass',
      },
    })
    expect(codes({ ...base, archive: null })).toContain('PG-12')
    expect(
      codes({ ...base, archive: { chapterExists: true, checkPassed: true, hashMatches: true } }),
    ).toContain('PG-12')
    expect(
      codes({ ...base, archive: { chapterExists: false, checkPassed: false, hashMatches: false } }),
    ).toContain('PG-12')
    expect(
      codes({ ...base, archive: { chapterExists: false, checkPassed: true, hashMatches: true } }),
    ).not.toContain('PG-12')
  })
})
