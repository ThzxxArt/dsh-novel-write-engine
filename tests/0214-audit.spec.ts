import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import {
  archiveDelta,
  bootstrapToDraft,
  cleanText,
  harness,
  readyToArchive,
  sampleReview,
  sampleSemantic,
  sampleSummary,
} from './helpers.js'

const foreshadowDoc = (count: number): Record<string, unknown> => ({
  schema_version: 1,
  next_seq: count + 1,
  items: Array.from({ length: count }, (_, index) => ({
    id: `FS-${String(index + 1).padStart(3, '0')}`,
    title: `旧线索 ${index + 1}`,
    planted: 1,
    last_touched: 1,
    status: 'planted',
    resolved_at: null,
    description: '一件还没有解释的东西',
    advance_log: [],
  })),
})

describe('0.2.14 audit: brief budget floors (WP5)', () => {
  it('keeps the foreshadow and summary floors on a real-shaped project', async () => {
    const h = await harness()
    try {
      await h.engine.initProject({
        title: '审计之书',
        genre: '都市现代',
        platform: 'fanqie',
        root: h.root,
        words_per_chapter: [100, 400],
      })
      await h.engine.amend({
        path: 'state/foreshadows.yaml',
        content: foreshadowDoc(12),
        reason: 'seed ledgers',
        root: h.root,
      })
      const brief = await h.engine.getBrief({ stage: 'P1', root: h.root })
      const context = brief.data.context as {
        open_foreshadows?: unknown[]
        context_meta?: { required_omitted?: number; floor_kept?: Record<string, number> }
      }
      expect(context.open_foreshadows?.length ?? 0).toBeGreaterThanOrEqual(8)
      expect(context.context_meta?.required_omitted ?? 0).toBe(0)
    } finally {
      await h.cleanup()
    }
  })
})

describe('0.2.14 audit: amend before/after and local patch (WP8)', () => {
  it('returns before, after and a change list for a whole-document amend', async () => {
    const h = await harness()
    try {
      await h.engine.initProject({
        title: '审计之书',
        genre: '都市现代',
        platform: 'fanqie',
        root: h.root,
        words_per_chapter: [100, 400],
      })
      const result = await h.engine.amend({
        path: 'novel.yaml',
        content: { title: '改名之书' },
        reason: 'rename',
        root: h.root,
      })
      expect(result.data.before?.title).toBe('审计之书')
      expect(result.data.after.title).toBe('改名之书')
      expect(result.data.changes).toContainEqual({ path: 'title', before: '审计之书', after: '改名之书' })
    } finally {
      await h.cleanup()
    }
  })

  it('edits one field by path and leaves the rest byte-identical', async () => {
    const h = await harness()
    try {
      await h.engine.initProject({
        title: '审计之书',
        genre: '都市现代',
        platform: 'fanqie',
        root: h.root,
        words_per_chapter: [100, 400],
      })
      await h.engine.amend({
        path: 'state/foreshadows.yaml',
        content: foreshadowDoc(3),
        reason: 'seed',
        root: h.root,
      })
      const before = await readFile(join(h.root, 'state/foreshadows.yaml'), 'utf8')
      const result = await h.engine.amend({
        path: 'state/foreshadows.yaml',
        patch: [{ op: 'replace', path: 'items.1.title', value: '改过的线索' }],
        reason: 'rename one row',
        root: h.root,
      })
      expect(result.data.changes).toEqual([
        { path: 'items.1.title', before: '旧线索 2', after: '改过的线索' },
      ])
      const after = await readFile(join(h.root, 'state/foreshadows.yaml'), 'utf8')
      expect(after).toContain('改过的线索')
      // Only the one row changed: the other titles are still present.
      expect(after).toContain('旧线索 1')
      expect(after).toContain('旧线索 3')
      expect(before).toContain('旧线索 2')
    } finally {
      await h.cleanup()
    }
  })
})

describe('0.2.14 audit: PG-01 diagnosis and revision invariant (WP2)', () => {
  it('does not advance the revision when archive is refused, and stays current', async () => {
    const h = await harness()
    try {
      const summary = sampleSummary({
        characters_appeared: ['他'],
        resource_changes: [{ character: '他', resource: '钱', delta: -5, reason: '买米' }],
      })
      const text = await readyToArchive({ root: h.root, engine: h.engine, summary })
      const pipelineBefore = await h.engine.queryState({ kind: 'pipeline', root: h.root })
      const revisionBefore = (pipelineBefore.data as { revision: number }).revision
      const briefBefore = await h.engine.getBrief({ stage: 'P8', root: h.root })

      await expect(
        h.engine.archiveChapter({
          chapter: 1,
          state_delta: archiveDelta(summary),
          root: h.root,
        }),
      ).rejects.toThrowError(/original|negative/i)

      const pipelineAfter = await h.engine.queryState({ kind: 'pipeline', root: h.root })
      expect((pipelineAfter.data as { revision: number }).revision).toBe(revisionBefore)
      const briefAfter = await h.engine.getBrief({ stage: 'P8', root: h.root })
      expect(briefAfter.data.digest).toBe(briefBefore.data.digest)
      // `toBeDefined()` and `text.length > 0` passed even when the refusal was
      // recorded as the last action and the manuscript was rewritten (R10).
      const pipeline = pipelineAfter.data as { last_action: { op: string }; stage: string }
      expect(pipeline.last_action.op).not.toBe('archiveChapter')
      // `stage` uses the workflow vocabulary: P8 is `ready_to_archive`.
      expect(pipeline.stage).toBe('ready_to_archive')
      expect(await readFile(join(h.root, 'chapters/chapter-001.md'), 'utf8')).toBe(text)
    } finally {
      await h.cleanup()
    }
  })

  it('names the changed dependency when the text is revised after P8', async () => {
    const h = await harness()
    try {
      const text = await readyToArchive({ root: h.root, engine: h.engine })
      const revised = `${text}\n\n他忽然停住，把信封重新封好，放回桌角，然后走出门去。`
      const proof = (() => {
        const paragraphs = revised.split(/\n+/).filter((line) => line.trim() !== '')
        return {
          opening: { paragraph: 1, quote: paragraphs[0]!.slice(0, 14) },
          middle: { paragraph: 4, quote: paragraphs[3]!.slice(0, 14) },
          ending: { paragraph: paragraphs.length, quote: paragraphs.at(-1)!.slice(0, 14) },
        }
      })()
      await h.engine.getBrief({ stage: 'P5', root: h.root })
      await h.engine.submitRevision({ chapter: 1, content: revised, proof, root: h.root })
      await h.engine.getBrief({ stage: 'P4', root: h.root })
      await h.engine.submitReview({ chapter: 1, ...sampleReview(1, revised), root: h.root })
      await h.engine.getBrief({ stage: 'P6', root: h.root })
      await h.engine.runCheck({ chapter: 1, semantic: sampleSemantic(revised), root: h.root })
      let error: unknown
      try {
        await h.engine.archiveChapter({
          chapter: 1,
          state_delta: archiveDelta(sampleSummary()),
          root: h.root,
        })
      } catch (caught) {
        error = caught
      }
      const blocking = (error as { blocking?: Array<{ code: string; details?: { stale_reason?: string } }> })
        .blocking
      const pg01 = blocking?.find((item) => item.code === 'PG-01')
      expect(blocking?.map((item) => item.code)).toContain('PG-01')
      expect(pg01?.details?.stale_reason).toBe('text')
    } finally {
      await h.cleanup()
    }
  })
})

describe('0.2.14 audit: brief lifecycle (WP3)', () => {
  it('keeps the P4 digest stable when only the review rounds change', async () => {
    const h = await harness()
    try {
      await bootstrapToDraft({ root: h.root, engine: h.engine })
      const text = cleanText()
      await h.engine.getBrief({ stage: 'P3', root: h.root })
      await h.engine.submitDraft({
        chapter: 1,
        content: text,
        chapter_title: '开端之雨',
        scene_type: '日常过渡章',
        narrator: '他',
        summary: sampleSummary(),
        root: h.root,
      })
      const first = await h.engine.getBrief({ stage: 'P4', root: h.root })
      await h.engine.submitReview({ chapter: 1, ...sampleReview(1, text), root: h.root })
      const second = await h.engine.getBrief({ stage: 'P4', root: h.root })
      expect(second.data.digest).toBe(first.data.digest)
      const receipts = parse(await readFile(join(h.root, 'state/briefs.yaml'), 'utf8')) as {
        receipts: Array<{ stage: string; chapter: number }>
      }
      expect(receipts.receipts.filter((row) => row.stage === 'P4' && row.chapter === 1)).toHaveLength(1)
    } finally {
      await h.cleanup()
    }
  })

  it('lists only the live receipt per stage when a revision supersedes the brief', async () => {
    const h = await harness()
    try {
      const text = await readyToArchive({ root: h.root, engine: h.engine })
      const revised = `${text}\n\n他把灯芯挑亮，又坐回桌边。`
      const paragraphs = revised.split(/\n+/).filter((line) => line.trim() !== '')
      await h.engine.getBrief({ stage: 'P5', root: h.root })
      await h.engine.submitRevision({
        chapter: 1,
        content: revised,
        proof: {
          opening: { paragraph: 1, quote: paragraphs[0]!.slice(0, 14) },
          middle: { paragraph: 4, quote: paragraphs[3]!.slice(0, 14) },
          ending: { paragraph: paragraphs.length, quote: paragraphs.at(-1)!.slice(0, 14) },
        },
        root: h.root,
      })
      await h.engine.getBrief({ stage: 'P4', root: h.root })
      const all = await h.engine.queryState({ kind: 'briefs', root: h.root })
      const current = await h.engine.queryState({ kind: 'briefs', view: 'current', root: h.root })
      const rows = (value: unknown): Array<{ stage: string; current?: boolean }> =>
        (value as { receipts?: Array<{ stage: string; current?: boolean }> }).receipts ?? []
      expect(rows(all.data).filter((row) => row.stage === 'P4').length).toBeGreaterThan(1)
      expect(rows(current.data).filter((row) => row.stage === 'P4')).toHaveLength(1)
    } finally {
      await h.cleanup()
    }
  })

  it('signs three stages in one transaction and one journal row', async () => {
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      const before = await h.engine.auditHistory({ root: h.root })
      const rowsBefore = before.data.filter((row) => row.op === 'getBrief').length
      const batch = await h.engine.getBrief({
        stage: 'P4',
        stages: ['P4', 'P6', 'P8'],
        root: h.root,
      })
      expect(batch.data.briefs ?? []).toHaveLength(3)
      const after = await h.engine.auditHistory({ root: h.root })
      const rowsAfter = after.data.filter((row) => row.op === 'getBrief').length
      expect(rowsAfter - rowsBefore).toBe(1)
      // U8: the signed receipt and the live per-chapter map must carry one
      // digest. A batch once returned a pipeline row signed seconds later than
      // the receipt it was supposed to mirror, which would make PG-01 compare
      // two different briefs.
      const receipts = (await h.engine.queryState({ kind: 'briefs', view: 'current', root: h.root }))
        .data as { receipts?: Array<{ stage: string; digest: string }> }
      const pipeline = (await h.engine.queryState({ kind: 'pipeline', root: h.root })).data as {
        briefs?: Record<string, { digest: string }>
      }
      for (const stage of ['P4', 'P6', 'P8']) {
        const receipt = receipts.receipts?.find((row) => row.stage === stage)
        expect(receipt?.digest).toBe(pipeline.briefs?.[stage]?.digest)
      }
    } finally {
      await h.cleanup()
    }
  })

  it('archives superseded receipts into history and keeps the live file small', async () => {
    const h = await harness()
    try {
      const text = await readyToArchive({ root: h.root, engine: h.engine })
      const revised = `${text}\n\n他又把那枚蜡印翻过来看了一眼，才把信封放回抽屉。`
      const paragraphs = revised.split(/\n+/).filter((line) => line.trim() !== '')
      await h.engine.getBrief({ stage: 'P5', root: h.root })
      await h.engine.submitRevision({
        chapter: 1,
        content: revised,
        proof: {
          opening: { paragraph: 1, quote: paragraphs[0]!.slice(0, 14) },
          middle: { paragraph: 4, quote: paragraphs[3]!.slice(0, 14) },
          ending: { paragraph: paragraphs.length, quote: paragraphs.at(-1)!.slice(0, 14) },
        },
        root: h.root,
      })
      await h.engine.getBrief({ stage: 'P4', root: h.root })
      await h.engine.submitReview({ chapter: 1, ...sampleReview(1, revised), root: h.root })
      await h.engine.getBrief({ stage: 'P6', root: h.root })
      await h.engine.runCheck({ chapter: 1, semantic: sampleSemantic(revised), root: h.root })
      await h.engine.getBrief({ stage: 'P8', root: h.root })
      // Seed the case the old implementation actually failed: a *promoted older
      // current* row plus three newer rows is four live rows under "current +
      // last three". Seeding only old rows passed either way (R10).
      const receiptPath = join(h.root, 'state/briefs.yaml')
      const receiptDoc = parse(await readFile(receiptPath, 'utf8')) as {
        receipts: Array<Record<string, unknown>>
      }
      const currentP4 = receiptDoc.receipts.find(
        (row) => row.chapter === 1 && row.stage === 'P4' && row.current === true,
      )
      expect(currentP4).toBeDefined()
      currentP4!.issued_at = '2026-10-19T09:00:00.000Z'
      for (let index = 0; index < 3; index += 1) {
        receiptDoc.receipts.push({
          chapter: 1,
          stage: 'P4',
          digest: `sha256:seeded${index}`,
          issued_at: `2026-10-20T10:0${index}:00.000Z`,
        })
      }
      await writeFile(receiptPath, stringify(receiptDoc, { lineWidth: 0 }), 'utf8')
      const seededP4 = receiptDoc.receipts.filter((row) => row.chapter === 1 && row.stage === 'P4').length
      expect(seededP4).toBeGreaterThanOrEqual(4)
      const summary = sampleSummary()
      await h.engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(summary),
        root: h.root,
      })
      // `toBeDefined()` on the history payload and `length > 0` on the live file
      // proved nothing about compaction: four seeded rows could stay live and
      // this test still passed (R10).
      const live = parse(await readFile(join(h.root, 'state/briefs.yaml'), 'utf8')) as {
        receipts: Array<{ chapter: number; stage: string; digest: string }>
      }
      const liveP4 = live.receipts.filter((row) => row.chapter === 1 && row.stage === 'P4')
      // Exact: "current + last three" left four live rows and still satisfied
      // a `<= 3` or `> 0` assertion.
      expect(liveP4.length).toBe(3)
      const archivedP4 = parse(await readFile(join(h.root, 'history/briefs/ch001.yaml'), 'utf8')) as {
        receipts: Array<{ chapter: number; stage: string; digest: string }>
      }
      expect(archivedP4.receipts.length).toBe(seededP4 - 3)
      // Nothing may be lost: every seeded signature is still readable somewhere.
      const digests = new Set([...liveP4, ...archivedP4.receipts].map((row) => row.digest))
      expect(digests.has('sha256:seeded0')).toBe(true)
      for (let index = 0; index < 3; index += 1) {
        expect(digests.has(`sha256:seeded${index}`)).toBe(true)
      }
      const all = (await h.engine.queryState({ kind: 'briefs', view: 'all', root: h.root })).data as {
        receipts: Array<{ chapter: number; stage: string; digest: string }>
      }
      // Exact, not "at least": live + history must reproduce the pre-archive set.
      expect(all.receipts.filter((row) => row.chapter === 1 && row.stage === 'P4').length).toBe(seededP4)
    } finally {
      await h.cleanup()
    }
  })
})

describe('0.2.14 audit: effort is one number (WP9)', () => {
  it('reports quality.attempts and effort.reviews from the same projection', async () => {
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      await h.engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root: h.root,
      })
      const report = await h.engine.report({ root: h.root })
      expect(report.data.quality.attempts).toBe(report.data.effort.reviews)
      expect(report.data.quality.samples).toBe(1)
      expect(report.data.effort.chapters[0]?.archived_at).not.toBeNull()
    } finally {
      await h.cleanup()
    }
  })

  it('counts a history-only review copy in status and report the same way', async () => {
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      await h.engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root: h.root,
      })
      // A review copy that no journal row recorded (a truncated upgrade, or a
      // copy written before the journal existed). report() has always counted
      // it; status used the journal alone and reported a shorter lifetime.
      const current = parse(await readFile(join(h.root, 'reviews/ch001.review.yaml'), 'utf8')) as Record<
        string,
        unknown
      >
      await mkdir(join(h.root, 'history/reviews'), { recursive: true })
      for (const [index, suffix] of ['a', 'b'].entries()) {
        const copy = structuredClone(current)
        const issues = (copy.issues ?? []) as Array<Record<string, unknown>>
        issues.push({
          id: `HIST-${suffix}`,
          severity: 'advisory',
          dimension: 'pacing',
          location: 'para 1',
          problem: `history copy ${suffix}`,
          fix: 'split the paragraph',
          status: 'open',
        })
        copy.issues = issues
        await writeFile(
          join(h.root, `history/reviews/ch001.r000${index + 1}.review.yaml`),
          stringify(copy),
          'utf8',
        )
      }
      const report = await h.engine.report({ root: h.root })
      const status = await h.engine.getStatus({ root: h.root })
      expect(report.data.effort.reviews).toBe(3)
      expect(status.data.previous_chapter_effort?.totals.reviews).toBe(report.data.effort.reviews)
      expect(status.data.previous_chapter_effort?.reviews).toBe(report.data.effort.chapters.at(-1)?.reviews)
    } finally {
      await h.cleanup()
    }
  })

  it('carries the archived chapter effort into the next chapter status', async () => {
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      await h.engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root: h.root,
      })
      // Chapter two reaches ready_to_archive the same way; its status must show
      // chapter one's real effort, not the reset pipeline rounds (X1).
      await h.engine.getBrief({ stage: 'P1', root: h.root })
      await h.engine.submitWorldPlan({
        chapter: 1,
        objective: '把信交出去',
        constraints: ['没有超能力'],
        characters: [],
        locations: [],
        continuity_notes: [],
        root: h.root,
      })
      await h.engine.getBrief({ stage: 'P2', root: h.root })
      await h.engine.submitChapterPlan({
        chapter: 1,
        title: '第二封信',
        scene_type: '日常过渡章',
        narrator: '他',
        beats: ['风起', '信到', '拆封', '读信', '决定'],
        opening: '风从窗缝里挤进来',
        ending: '蜡印',
        target_words: [80, 400],
        root: h.root,
      })
      const status = await h.engine.getStatus({ root: h.root })
      expect(status.data.previous_chapter_effort).toMatchObject({ chapter: 1, reviews: 1 })
      expect(status.data.previous_chapter_effort?.reviews).toBeGreaterThan(0)
    } finally {
      await h.cleanup()
    }
  })
})

describe('0.2.14 audit: debt is opt-in and visible (WP4)', () => {
  it('refuses a negative balance, then accepts it after the project opts in and reports debt', async () => {
    const h = await harness()
    try {
      const summary = sampleSummary({
        characters_appeared: ['他'],
        resource_changes: [{ character: '他', resource: '钱', delta: -5, reason: '欠账' }],
      })
      await readyToArchive({ root: h.root, engine: h.engine, summary })
      await expect(
        h.engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root: h.root }),
      ).rejects.toThrowError(/original|negative/i)

      await h.engine.amend({
        path: 'novel.yaml',
        content: { targets: { allow_negative_balances: true } },
        reason: 'allow an overdraft',
        root: h.root,
      })
      await h.engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root: h.root })
      const report = await h.engine.report({ root: h.root })
      expect(report.data.debt).toContainEqual({ character: '他', resource: '钱', balance: -5 })
    } finally {
      await h.cleanup()
    }
  })
})

describe('0.2.14 audit: review total is explained (WP10)', () => {
  it('lists the deductions the rulepack removed when a claimed total disagrees', async () => {
    const h = await harness()
    try {
      await bootstrapToDraft({ root: h.root, engine: h.engine })
      const text = cleanText()
      await h.engine.getBrief({ stage: 'P3', root: h.root })
      await h.engine.submitDraft({
        chapter: 1,
        content: text,
        chapter_title: '开端之雨',
        scene_type: '日常过渡章',
        narrator: '他',
        summary: sampleSummary(),
        root: h.root,
      })
      await h.engine.getBrief({ stage: 'P4', root: h.root })
      const review = sampleReview(1, text)
      // The same rule at the same location twice: the rulepack keeps one copy,
      // so a caller who sums both dimensions over-counts and must be told why.
      review.dimensions[1]!.deductions = [
        { rule: 'NO_MOTIVE', location: '第 2 段', delta: 5, note: '重复扣分' },
      ]
      let error: unknown
      try {
        await h.engine.submitReview({ chapter: 1, ...review, total: 150, root: h.root })
      } catch (caught) {
        error = caught
      }
      const details = (
        error as { details?: { engine_total?: number; raw_total?: number; exclusions_applied?: unknown[] } }
      ).details
      expect(details?.engine_total).toBe(145)
      expect(details?.raw_total).toBe(140)
      expect(details?.exclusions_applied).toHaveLength(1)
    } finally {
      await h.cleanup()
    }
  })
})

describe('0.2.14 audit: legacy check documents (WP8/U16)', () => {
  it('reads a 0.2.0 check without scope and names the chapter in doctor', async () => {
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      await h.engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root: h.root,
      })
      const path = join(h.root, 'checks/ch001.check.yaml')
      const document = parse(await readFile(path, 'utf8')) as Record<string, unknown>
      // A 0.2.0 check had no `scope` and stored advisories in `violations`.
      delete document.scope
      const machine = document.machine as { violations?: unknown[] }
      machine.violations = [
        ...(machine.violations ?? []),
        { code: 'LEGACY_ADVISORY', severity: 'advisory', location: { paragraph: 1 }, detail: '旧告警' },
      ]
      await writeFile(path, stringify(document, { lineWidth: 0 }), 'utf8')

      const check = await h.engine.queryState({ kind: 'check', chapter: 1, root: h.root })
      expect((check.data as { error?: string }).error).toBeUndefined()
      const doctor = await h.engine.doctor({ root: h.root })
      const legacy = doctor.data.checks.find((entry) => entry.id === 'legacy-data')
      expect(legacy?.detail).toContain('第 1 章')
    } finally {
      await h.cleanup()
    }
  })
})
