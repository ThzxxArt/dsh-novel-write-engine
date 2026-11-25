import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { compileRulepack } from '../src/rules/compiler.js'
import {
  archiveDelta,
  bootstrapToDraft,
  cleanText,
  FIXTURE_WAIVERS,
  harness,
  sampleReview,
  sampleSemantic,
  sampleSummary,
  writeDraft,
} from './helpers.js'
import { runMachineChecks } from '../src/rules/pipeline.js'
import type { MachineOptions } from '../src/rules/pipeline.js'
import type { Rulepack } from '../src/rules/types.js'

/**
 * 0.2.20 WP2 · D2: cross-chapter severity is one decision, not six literals.
 *
 * Before 0.2.20 a story whose clock ran backwards was an *advisory*, so the
 * archive gate let it through; and a book that wanted the two heuristic
 * continuity rules to block had no switch at all. These tests pin the table:
 *
 * | rule                  | default | strict_cross |
 * | --------------------- | ------- | ------------ |
 * | DUPLICATE_PARAGRAPH   | blocker | blocker      |
 * | TIME_REGRESSION       | blocker | blocker      |
 * | FORESHADOW_DORMANT    | advisory| advisory     |
 * | FS_REVISITED_TOO_SOON | advisory| advisory     |
 * | RESOURCE_MISMATCH     | advisory| blocker      |
 * | LOCKED_DETAIL_DRIFT   | advisory| blocker      |
 */
const repoRoot = new URL('..', import.meta.url).pathname
const pack = compileRulepack(
  structuredClone(
    parseYaml(readFileSync(`${repoRoot}rulepacks/default.yaml`, 'utf8')) as Record<string, unknown>,
  ),
) as Rulepack

const timeline = (rows: Array<{ chapter: number; story_time: string }>) => ({
  schema_version: 1 as const,
  next_seq: rows.length + 1,
  items: rows.map((row, index) => ({
    id: `TE-${index + 1}`,
    chapter: row.chapter,
    story_time: row.story_time,
    description: `事件 ${index + 1}`,
    location: '屋里',
    characters: ['周慎'],
  })),
})

const options = (overrides: Partial<MachineOptions> = {}): MachineOptions => ({
  chapter: 5,
  title: null,
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

describe('0.2.20 WP2 D2: cross-chapter severity', () => {
  it('treats a story that moves backwards in time as a blocker, with no switch', () => {
    // The draft says Day 3 while the ledger already recorded Day 9 for the
    // previous chapter: the reader would experience time running backwards.
    const regression = options({
      chapter: 5,
      evidence: {
        ...options().evidence,
        timeline: timeline([
          { chapter: 4, story_time: 'Day 9 清晨' },
          { chapter: 5, story_time: 'Day 9 夜里' },
        ]),
      },
    })
    expect(
      runMachineChecks('Day 3 的雨还没停，他出了门。', regression).violations.find(
        (row) => row.code === 'TIME_REGRESSION',
      )?.severity,
    ).toBe('blocker')
    const strict = { ...regression, strictCross: true }
    expect(
      runMachineChecks('Day 3 的雨还没停，他出了门。', strict).violations.find(
        (row) => row.code === 'TIME_REGRESSION',
      )?.severity,
    ).toBe('blocker')
  })

  it('stays quiet when the clock moves forward', () => {
    const forward = options({
      chapter: 5,
      evidence: {
        ...options().evidence,
        timeline: timeline([{ chapter: 5, story_time: 'Day 9 夜里' }]),
      },
    })
    expect(
      runMachineChecks('Day 10 的雨还没停，他出了门。', forward).violations.map((row) => row.code),
    ).not.toContain('TIME_REGRESSION')
  })

  it('keeps the two heuristic continuity rules advisory by default', () => {
    // A resource line the manuscript contradicts: heuristic, so it may not
    // block a chapter the author wrote on purpose.
    const mismatch = options({
      summary: {
        events: ['他花掉了钱'],
        characters_appeared: ['周慎'],
        foreshadows: { planted: [], advanced: [], resolved: [] },
        new_elements: { locations: [], abilities: [], artifacts: [] },
        resource_changes: [{ character: '周慎', resource: '银子', delta: -3, reason: '买米' }],
        opening: '夜里',
        continuity: { opens_from: '', ends_with: '' },
        hook_strength: 3,
        pleasure_points: [],
        plot_advancement: 'mid',
      },
    })
    const codes = runMachineChecks('他数了数，银子还有二十两。'.repeat(3), mismatch).violations
    const row = codes.find((entry) => entry.code === 'RESOURCE_MISMATCH')
    // Either it did not fire (no trigger word found) or it fired as advisory —
    // both are the default policy; a blocker here would be the regression.
    expect(row?.severity ?? 'advisory').toBe('advisory')
  })

  it('escalates only the two heuristic rules when the project asks for strict cross', () => {
    const strictText = '周慎站在门口，雨水顺着檐角落下来。'
    const strict = { ...options({ strictCross: true }), text: '正文' }
    // The escalation switch itself must not create findings; it only changes
    // the severity of what the rules already found. The table is asserted in
    // `crossSeverity` below so this stays true even when no fixture fires.
    const bare = runMachineChecks(strictText, options()).violations
    const escalated = runMachineChecks(strictText, strict).violations
    expect(escalated.filter((row) => row.severity === 'blocker')).toEqual(
      bare.filter((row) => row.severity === 'blocker'),
    )
  })

  it('answers the same severity from the check path and the gate path', async () => {
    const { crossSeverity } = await import('../src/rules/checks.js')
    const base = { ...options({ strictCross: false }), text: '正文' }
    expect(crossSeverity('TIME_REGRESSION', base)).toBe('blocker')
    expect(crossSeverity('DUPLICATE_PARAGRAPH', base)).toBe('blocker')
    expect(crossSeverity('RESOURCE_MISMATCH', base)).toBe('advisory')
    expect(crossSeverity('LOCKED_DETAIL_DRIFT', base)).toBe('advisory')
    expect(crossSeverity('FORESHADOW_DORMANT', base)).toBe('advisory')
    expect(crossSeverity('FS_REVISITED_TOO_SOON', base)).toBe('advisory')
    const strict = { ...options({ strictCross: true }), text: '正文' }
    expect(crossSeverity('RESOURCE_MISMATCH', strict)).toBe('blocker')
    expect(crossSeverity('LOCKED_DETAIL_DRIFT', strict)).toBe('blocker')
    expect(crossSeverity('FORESHADOW_DORMANT', strict)).toBe('advisory')
  })
})

describe('0.2.20 WP2: the archive gate does not pretend', () => {
  it('refuses to archive a check whose checklist rows nobody answered, and accepts a reasoned waiver', async () => {
    const { root, engine, rawRunCheck, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      await engine.getBrief({ stage: 'P6', root })
      // The raw call: no fixture waiver. This is what a model that answered
      // nothing actually sends.
      await rawRunCheck({ chapter: 1, semantic: sampleSemantic(text), root })
      await engine.getBrief({ stage: 'P8', root })
      await expect(
        engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root }),
      ).rejects.toMatchObject({
        blocking: expect.arrayContaining([
          expect.objectContaining({ code: 'PG-12', detail: expect.stringContaining('unanswered') }),
        ]),
      })

      // Answering is the normal fix; a reasoned waiver is the documented escape.
      // The partial check advanced the pipeline, so restart at P6 first.
      await engine.rollback({ chapter: 1, toStage: 'P6', reason: 're-run the checklist with waivers' })
      await engine.getBrief({ stage: 'P6', root })
      await rawRunCheck({
        chapter: 1,
        semantic: sampleSemantic(text),
        self_check_waivers: FIXTURE_WAIVERS,
        root,
      })
      await engine.getBrief({ stage: 'P8', root })
      const archived = await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root,
      })
      expect(archived.data.chapter).toBe(1)
      const check = (await engine.queryState({ kind: 'check', chapter: 1, root })).data as {
        self_check: { summary: { unanswered?: number }; waivers?: Array<{ id: string }> }
      } | null
      expect(check?.self_check.summary.unanswered).toBe(0)
      expect(check?.self_check.waivers?.length).toBe(FIXTURE_WAIVERS.length)
    } finally {
      await cleanup()
    }
  })

  it('rejects a `fixed` claim that quotes a sentence the previous version already had', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const first = cleanText()
      await writeDraft({ root, engine, text: first })
      await engine.getBrief({ stage: 'P4', root })
      const issue = {
        id: 'REV-001',
        severity: 'blocker' as const,
        dimension: 'R-W-01',
        location: '第 1 段',
        problem: '开头缺少动机',
        fix: '补一句理由',
        status: 'open' as const,
      }
      await engine.submitReview({ chapter: 1, ...sampleReview(1, first, { issues: [issue] }), root })
      await engine.getBrief({ stage: 'P5', root })
      // A revision that keeps the first paragraph and changes the rest.
      // Change paragraph 2 only; paragraph 4 keeps a sentence we can wrongly
      // cite as proof of a fix.
      const second = first.replace('不快不慢', '忽快忽慢')
      // PG-08 also runs on submitRevision now, so the blocker must be repaired
      // with evidence from the new text before the review can be resubmitted.
      const review = sampleReview(1, second, {
        issues: [{ ...issue, status: 'fixed', evidence: '信封没有署名，封口处压着一枚暗红的蜡印' }],
      })
      // 0.2.20 review: PG-08 now runs on the revision with the *replaced* text
      // as its baseline (a first revision has no history/chapters, so the old
      // baseline made the check vacuous). The claim is therefore caught here,
      // one round earlier than the review-time half of the same rule.
      await expect(
        engine.submitRevision({
          chapter: 1,
          content: second,
          summary: sampleSummary(),
          proof: review.proof,
          issues: review.issues,
          root,
        }),
      ).rejects.toMatchObject({
        blocking: expect.arrayContaining([
          expect.objectContaining({
            code: 'PG-08',
            detail: expect.stringContaining('already existed in the previous version'),
          }),
        ]),
      })
      // The same revision with a quote from the paragraph that actually changed
      // is accepted: the rule rejects copying, not revising.
      const rewritten = '走廊尽头传来脚步声，忽快忽慢，在门口停了两秒。'
      const okReview = sampleReview(1, second)
      await engine.submitRevision({
        chapter: 1,
        content: second,
        summary: sampleSummary(),
        proof: okReview.proof,
        issues: [{ ...issue, status: 'fixed', evidence: rewritten }],
        root,
      })
    } finally {
      await cleanup()
    }
  })
})
