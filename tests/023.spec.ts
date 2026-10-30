import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import { reviewHistoryFile } from '../src/constants.js'
import { emptyOutline, emptyWorldbook } from '../src/engine/book.js'
import { buildBookReport } from '../src/engine/insight.js'
import { sha256 } from '../src/store/fs.js'
import type { AuditRow, ChapterRecord, ChapterSummary, ReviewDocument } from '../src/types.js'
import { archiveDelta, harness, readyToArchive, sampleReview, sampleSummary } from './helpers.js'

const project = {
  schema_version: 1 as const,
  title: '回填之书',
  genre: '都市现代' as const,
  platform: 'fanqie' as const,
  author: '',
  description: '',
  created_at: '2026-01-01',
  targets: {
    words_per_chapter: [80, 400] as [number, number],
    total_chapters: 2,
    dialogue_ratio: [0.4, 0.6] as [number, number],
  },
}

const summary: ChapterSummary = sampleSummary()

const oldChapter = (): ChapterRecord => ({
  num: 1,
  title: '旧章',
  file: 'chapters/chapter-001.md',
  word_count: 300,
  dialogue_lines: 0,
  dialogue_ratio: 0,
  scene_type: '日常过渡章',
  narrator: '他',
  score: 140,
  status: 'reviewed',
  content_hash: 'hash-1',
  summary,
})

const review = (): ReviewDocument => ({
  schema_version: 1,
  chapter: 1,
  round: 1,
  content_hash: 'hash-1',
  dimensions: [{ id: 'R-W-01', max: 15, deductions: [] }],
  issues: [],
  total: 140,
})

const row = (op: string, chapter: number, at: string): AuditRow => ({
  at,
  op,
  chapter,
  revision: 1,
  txid: `${op}-${at}`,
  status: 'committed',
  files: [],
})

describe('0.2.3 trusted ledgers', () => {
  it('backfills legacy effort from the journal and counts attempts separately from samples', () => {
    const report = buildBookReport({
      project,
      outline: emptyOutline('2026-01-01'),
      outlinePresent: false,
      worldbook: emptyWorldbook('2026-01-01'),
      worldbookPresent: false,
      chapters: [oldChapter()],
      characters: { schema_version: 1, characters: [] },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
      reviews: [review()],
      activity: [],
      journal: [
        row('submitReview', 1, '2026-01-01T00:00:00.000Z'),
        row('submitReview', 1, '2026-01-01T00:01:00.000Z'),
        row('submitRevision', 1, '2026-01-01T00:02:00.000Z'),
        row('runCheck', 1, '2026-01-01T00:03:00.000Z'),
        row('rollback', 1, '2026-01-01T00:04:00.000Z'),
        row('archiveChapter', 1, '2026-01-01T00:05:00.000Z'),
      ],
      reviewAttempts: 2,
      finalChecks: { 1: 'pass' },
      targetChapters: 2,
      minScore: 120,
      foreshadowDormantAfter: 5,
    })
    expect(report.effort).toMatchObject({ reviews: 2, revisions: 1, checks: 1, rollbacks: 1 })
    expect(report.effort.chapters[0]).toMatchObject({
      reviews: 2,
      final_check: 'pass',
      archived_at: '2026-01-01T00:05:00.000Z',
    })
    expect(report.quality).toMatchObject({ samples: 1, attempts: 2, trend: null })
    expect(report.quality.dimensions[0]).toMatchObject({ id: 'R-W-01', samples: 1 })
  })

  it('projects an old extra role from the worldbook without rewriting the ledger', () => {
    const report = buildBookReport({
      project,
      outline: emptyOutline('2026-01-01'),
      outlinePresent: false,
      worldbook: {
        ...emptyWorldbook('2026-01-01'),
        characters: [{ name: '他', role: '主角', description: '', arc: '' }],
      },
      worldbookPresent: true,
      chapters: [oldChapter()],
      characters: {
        schema_version: 1,
        characters: [
          {
            name: '他',
            role: 'extra',
            first_appearance: 1,
            profile: {},
            current_state: {},
            growth: [],
            updated_at: 1,
          },
        ],
      },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
      reviews: [review()],
      activity: [],
      targetChapters: 2,
      minScore: 120,
      foreshadowDormantAfter: 5,
    })
    expect(report.cast.top[0]).toMatchObject({ name: '他', role: 'protagonist' })
  })

  it('explains an empty quality trend when history is too short for a window', () => {
    const report = buildBookReport({
      project,
      outline: emptyOutline('2026-01-01'),
      outlinePresent: false,
      worldbook: emptyWorldbook('2026-01-01'),
      worldbookPresent: false,
      chapters: [1, 2, 3, 4].map((num) => ({
        ...oldChapter(),
        num,
        title: `章${num}`,
        content_hash: `hash-${num}`,
        score: 140 + num,
      })),
      characters: { schema_version: 1, characters: [] },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
      reviews: [1, 2, 3, 4].map((num) => ({
        ...review(),
        chapter: num,
        content_hash: `hash-${num}`,
        total: 140 + num,
      })),
      activity: [],
      targetChapters: 4,
      minScore: 120,
      foreshadowDormantAfter: 5,
    })
    expect(report.quality.samples).toBe(4)
    expect(report.quality.attempts).toBe(4)
    expect(report.quality.trend).toBeNull()
    expect(report.quality.trend_basis).toBe('insufficient_history')
  })

  it('computes a trend once a previous five-chapter window exists', () => {
    const report = buildBookReport({
      project,
      outline: emptyOutline('2026-01-01'),
      outlinePresent: false,
      worldbook: emptyWorldbook('2026-01-01'),
      worldbookPresent: false,
      chapters: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((num) => ({
        ...oldChapter(),
        num,
        title: `章${num}`,
        content_hash: `hash-${num}`,
        score: 130 + num,
      })),
      characters: { schema_version: 1, characters: [] },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
      reviews: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((num) => ({
        ...review(),
        chapter: num,
        content_hash: `hash-${num}`,
        total: 130 + num,
      })),
      activity: [],
      targetChapters: 10,
      minScore: 120,
      foreshadowDormantAfter: 5,
    })
    expect(report.quality.samples).toBe(10)
    expect(report.quality.trend_basis).toBe('last_five_vs_previous_five')
    expect(report.quality.trend).toBe(5)
  })

  it('does not label a one- or four-sample previous window as a five-chapter trend', () => {
    const six = buildBookReport({
      project,
      outline: emptyOutline('2026-01-01'),
      outlinePresent: false,
      worldbook: emptyWorldbook('2026-01-01'),
      worldbookPresent: false,
      chapters: [1, 2, 3, 4, 5, 6].map((num) => ({
        ...oldChapter(),
        num,
        title: `章${num}`,
        content_hash: `hash-${num}`,
        score: 130 + num,
      })),
      characters: { schema_version: 1, characters: [] },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
      reviews: [1, 2, 3, 4, 5, 6].map((num) => ({
        ...review(),
        chapter: num,
        content_hash: `hash-${num}`,
        total: 130 + num,
      })),
      activity: [],
      targetChapters: 6,
      minScore: 120,
      foreshadowDormantAfter: 5,
    })
    expect(six.quality.samples).toBe(6)
    expect(six.quality.trend).toBeNull()
    expect(six.quality.trend_basis).toBe('insufficient_history')
  })

  it('refuses an identical failed retry but allows it after the brief changes', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '重试之书', genre: '都市现代', platform: 'fanqie', root })
      const plan = {
        chapter: 0,
        objective: '让主角收到一封信',
        constraints: [],
        characters: [],
        locations: [],
        continuity_notes: [],
        root,
      }
      await expect(engine.submitWorldPlan(plan)).rejects.toMatchObject({ code: 'ENGINE_GATE_BLOCKED' })
      const attempts = await engine.auditHistory({ op: 'submitWorldPlan', root })
      expect(attempts.data[0]).toMatchObject({ status: 'aborted', retry_key: expect.any(String) })
      await expect(engine.submitWorldPlan(plan)).rejects.toMatchObject({ code: 'ENGINE_RETRY_UNCHANGED' })
      await engine.getBrief({ stage: 'P1', root })
      await expect(engine.submitWorldPlan(plan)).resolves.toMatchObject({ data: { stage: 'P2' } })
    } finally {
      await cleanup()
    }
  })

  it('replays the same brief without a new journal row', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '简报之书', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      const before = (await engine.auditHistory({ op: 'getBrief', root })).data.length
      const again = await engine.getBrief({ stage: 'P1', root })
      const after = (await engine.auditHistory({ op: 'getBrief', root })).data.length
      expect(again.replayed).toBe(true)
      expect(after).toBe(before)
      expect(again.data.fields.manuscript_hash).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('persists effective brief receipts instead of stale legacy pipeline signatures', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '签收之书', genre: '都市现代', platform: 'fanqie', root })
      const brief = await engine.getBrief({ stage: 'P1', root })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: '让主角收到一封信',
        constraints: [],
        characters: [],
        locations: [],
        continuity_notes: [],
        root,
      })
      const pipeline = parse(await readFile(join(root, 'state/pipeline.yaml'), 'utf8')) as {
        briefs: Record<string, { digest?: string }>
      }
      expect(pipeline.briefs.P1?.digest).toBe(brief.data.digest)
      const state = await engine.queryState({ kind: 'pipeline', root })
      expect((state.data as { briefs: Record<string, { digest?: string }> }).briefs.P1?.digest).toBe(
        brief.data.digest,
      )
    } finally {
      await cleanup()
    }
  })

  it('allows a direct revision from ready_to_archive and returns to P4', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const original = await readyToArchive({ root, engine })
      const revised = original.replace('风从窗缝里挤进来', '雨从窗缝里挤进来')
      await engine.getBrief({ stage: 'P5', root })
      const status = await engine.getStatus({ root })
      expect(status.data.manuscript_hash).toBe(sha256(original))
      const revision = await engine.submitRevision({
        chapter: 1,
        content: revised,
        summary: sampleSummary({ opening: '雨从窗缝里挤进来，把桌上' }),
        proof: sampleReview(1, revised).proof,
        root,
      })
      expect(revision.data.stage).toBe('P4')
      expect((await engine.getStatus({ root })).data.stage).toBe('P4')
      expect((await engine.getStatus({ root })).data.manuscript_hash).toBe(sha256(revised))
    } finally {
      await cleanup()
    }
  })

  it('does not call a renewed P5 receipt legacy after a normal revision', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const original = await readyToArchive({ root, engine })
      await engine.getBrief({ stage: 'P5', root })
      const revised = original.replace('风从窗缝里挤进来', '雨从窗缝里挤进来')
      await engine.submitRevision({
        chapter: 1,
        content: revised,
        summary: sampleSummary({ opening: '雨从窗缝里挤进来，把桌上' }),
        proof: sampleReview(1, revised).proof,
        root,
      })
      await engine.getBrief({ stage: 'P5', root })
      const doctor = await engine.doctor({ root })
      const legacy = doctor.data.checks.find((check) => check.id === 'legacy-data')
      expect(legacy?.detail ?? '').not.toContain('LEGACY_BRIEFS')
    } finally {
      await cleanup()
    }
  })

  it('compares the retry fingerprint with the latest attempt, not an older one', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const original = await readyToArchive({ root, engine })
      await engine.getBrief({ stage: 'P5', root })
      const proof = sampleReview(1, original).proof
      const patch = (oldText: string) => ({
        expected_hash: sha256(original),
        edits: [{ old_text: oldText, new_text: '雨' }],
      })
      await expect(
        engine.submitRevision({ chapter: 1, patch: patch('不存在一'), proof, root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitRevision({ chapter: 1, patch: patch('不存在二'), proof, root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitRevision({ chapter: 1, patch: patch('不存在一'), proof, root }),
      ).rejects.not.toMatchObject({ code: 'ENGINE_RETRY_UNCHANGED' })
    } finally {
      await cleanup()
    }
  })

  it('rejects content and patch together even when content is only whitespace', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const original = await readyToArchive({ root, engine })
      await engine.getBrief({ stage: 'P5', root })
      await expect(
        engine.submitRevision({
          chapter: 1,
          content: '   ',
          patch: {
            expected_hash: sha256(original),
            edits: [{ old_text: '风从窗缝里挤进来', new_text: '雨从窗缝里挤进来' }],
          },
          summary: sampleSummary({ opening: '雨从窗缝里挤进来，把桌上' }),
          proof: sampleReview(1, original).proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('reports no manuscript hash after rolling back to a stage without a draft', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.rollback({ chapter: 1, toStage: 'P2', root })
      const status = await engine.getStatus({ root })
      expect(status.data.stage).toBe('P2')
      expect(status.data.manuscript_hash).toBeNull()
      const brief = await engine.getBrief({ stage: 'P2', root })
      expect(brief.data.fields.manuscript_hash).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('exposes current check advisories separately from panel blocking', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const bundle = await engine.panelBundle({ root })
      expect(bundle.summary?.advisories?.length ?? 0).toBeGreaterThan(0)
      expect(bundle.summary?.blocking.some((item) => item.code === 'DIALOGUE_RATIO')).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('publishes the archive summary-link contract in the P8 brief', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const brief = await engine.getBrief({ stage: 'P8', root })
      const rules = (
        brief.data.fields as {
          delta_rules: { summary_links: Record<string, string>; linked_example: unknown }
        }
      ).delta_rules
      expect(rules.summary_links.characters_appeared).toContain('summary.characters_appeared')
      expect(rules.summary_links.new_elements).toContain('summary.new_elements')
      expect(rules.summary_links.relationships).toContain('characters')
      expect(rules.linked_example).toBeTruthy()
    } finally {
      await cleanup()
    }
  })

  it('does not invent legacy warnings on a clean project', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '干净项目', genre: '都市现代', platform: 'fanqie', root })
      const doctor = await engine.doctor({ root })
      expect(doctor.data.checks.find((check) => check.id === 'legacy-data')).toBeUndefined()
      const bundle = await engine.panelBundle({ root })
      expect(bundle.summary?.legacy).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it('reports empty facts as an informational strict-mode warning', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '空事实项目', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitBookPlan({ strict: true, root })
      const doctor = await engine.doctor({ root })
      expect(doctor.data.checks.find((check) => check.id === 'worldbook-facts')).toMatchObject({
        severity: 'info',
      })
    } finally {
      await cleanup()
    }
  })

  it('marks a 0.2.0-style check whose advisories are still in violations', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const path = join(root, 'checks/ch001.check.yaml')
      const document = parse(await readFile(path, 'utf8')) as {
        machine: { advisories?: unknown[]; violations?: unknown[] }
      }
      const advisories = document.machine.advisories ?? []
      delete document.machine.advisories
      document.machine.violations = [...(document.machine.violations ?? []), ...advisories]
      await writeFile(path, stringify(document), 'utf8')
      const doctor = await engine.doctor({ root })
      expect(doctor.data.checks.find((check) => check.id === 'legacy-data')?.detail).toContain(
        'LEGACY_CHECK_FORMAT',
      )
    } finally {
      await cleanup()
    }
  })

  it('doctor reports legacy roles and missing anchors without rewriting them', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      await engine.amend({
        path: 'outline/worldbook.yaml',
        content: {
          ...emptyWorldbook('2026-01-01'),
          characters: [{ name: '他', role: '主角', description: '主角', arc: '成长' }],
          themes: [],
        },
        reason: 'test legacy worldbook',
        root,
      })
      await engine.amend({
        path: 'state/characters.yaml',
        content: {
          schema_version: 1,
          characters: [
            {
              name: '他',
              role: 'extra',
              first_appearance: 1,
              profile: {},
              current_state: {},
              growth: [],
              updated_at: 1,
            },
          ],
        },
        reason: 'test legacy role',
        root,
      })
      await engine.amend({
        path: 'state/foreshadows.yaml',
        content: {
          schema_version: 1,
          next_seq: 3,
          items: [
            {
              id: 'FS-001',
              title: '船费债',
              planted: 1,
              last_touched: 1,
              status: 'planted',
              resolved_at: null,
              description: '旧伏笔',
              advance_log: [],
            },
            {
              id: 'FS-002',
              title: '狗叫',
              planted: 1,
              last_touched: 1,
              status: 'resolved',
              resolved_at: 1,
              description: '旧兑现',
              advance_log: [],
            },
          ],
        },
        reason: 'test legacy anchor',
        root,
      })
      const doctor = await engine.doctor({ root })
      const legacy = doctor.data.checks.find((check) => check.id === 'legacy-data')
      expect(legacy?.detail).toContain('LEGACY_CAST_ROLE')
      expect(legacy?.detail).toContain('LEGACY_FORESHADOW_ANCHOR')
      expect(legacy?.detail).toContain('LEGACY_FORESHADOW_ADVANCE')
      const bundle = await engine.panelBundle({ root })
      expect(bundle.summary?.legacy?.map((item) => item.code)).toEqual(
        expect.arrayContaining(['LEGACY_CAST_ROLE', 'LEGACY_FORESHADOW_ANCHOR', 'LEGACY_FORESHADOW_ADVANCE']),
      )
      // The audit is read-only: the old rows are still exactly what was written.
      const characters = await engine.queryState({ kind: 'characters', root })
      expect((characters.data as { characters: Array<{ role: string }> }).characters[0]!.role).toBe('extra')
    } finally {
      await cleanup()
    }
  })

  it('does not label a healthy new anchorless foreshadow or normal receipts as legacy', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = sampleSummary({
        foreshadows: {
          planted: [{ key: '蜡印', title: '蜡印', description: '信上的暗红蜡印' }],
          advanced: [],
          resolved: [],
        },
      })
      await readyToArchive({ root, engine, summary })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root })
      const doctor = await engine.doctor({ root })
      expect(doctor.data.checks.find((check) => check.id === 'legacy-data')).toBeUndefined()
      const bundle = await engine.panelBundle({ root })
      expect(bundle.summary?.legacy).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it('counts review attempts from the journal, not duplicate history copies', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const review = await readFile(join(root, 'reviews/ch001.review.yaml'), 'utf8')
      const document = parse(review) as unknown
      await mkdir(join(root, 'history/reviews'), { recursive: true })
      await writeFile(join(root, reviewHistoryFile(1, 1)), stringify(document), 'utf8')
      await writeFile(join(root, reviewHistoryFile(1, 2)), stringify(document), 'utf8')
      const report = await engine.report({ root })
      expect(report.data.quality.samples).toBe(1)
      expect(report.data.quality.attempts).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('counts history when the journal has a gap', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const reviewPath = join(root, 'reviews/ch001.review.yaml')
      const document = parse(await readFile(reviewPath, 'utf8')) as Record<string, unknown>
      await mkdir(join(root, 'history/reviews'), { recursive: true })
      for (let revision = 10; revision <= 13; revision += 1) {
        await writeFile(
          join(root, reviewHistoryFile(1, revision)),
          stringify({ ...document, round: revision, total: 120 + revision }),
          'utf8',
        )
      }
      await appendFile(
        join(root, 'state/journal.jsonl'),
        `${JSON.stringify({
          at: '2026-01-01T00:06:00.000Z',
          op: 'submitReview',
          chapter: 1,
          revision: 1,
          txid: 'extra-review',
          status: 'committed',
          files: [],
        })}\n`,
        'utf8',
      )
      const report = await engine.report({ root })
      const bundle = await engine.panelBundle({ root })
      expect(report.data.quality.samples).toBe(1)
      expect(report.data.quality.attempts).toBe(5)
      expect(bundle.summary?.quality?.attempts).toBe(5)
    } finally {
      await cleanup()
    }
  })

  it('reports a stale pipeline.briefs signature without treating historical receipts as stale', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const path = join(root, 'state/pipeline.yaml')
      const pipeline = parse(await readFile(path, 'utf8')) as {
        briefs: Record<string, { digest: string; issued_at: string }>
      }
      pipeline.briefs = { P1: { digest: 'stale-digest', issued_at: '2026-01-01T00:00:00.000Z' } }
      await writeFile(path, stringify(pipeline), 'utf8')
      const doctor = await engine.doctor({ root })
      expect(doctor.data.checks.find((check) => check.id === 'legacy-data')?.detail).toContain(
        'LEGACY_BRIEFS',
      )
    } finally {
      await cleanup()
    }
  })

  it('reports acknowledged advisories without keeping them in the blocking-like list', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const path = join(root, 'checks/ch001.check.yaml')
      const document = parse(await readFile(path, 'utf8')) as {
        machine: { advisories: Array<{ code: string }> }
        acknowledged?: string[]
      }
      const code = document.machine.advisories[0]?.code
      expect(code).toBeTruthy()
      document.acknowledged = [code!]
      await writeFile(path, stringify(document), 'utf8')
      const bundle = await engine.panelBundle({ root })
      expect(bundle.summary?.acknowledgedAdvisories).toBe(1)
      expect((bundle.summary?.advisories ?? []).map((item) => item.code)).not.toContain(code)
    } finally {
      await cleanup()
    }
  })

  it('keeps the selector payload when a project has a hard schema fault', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '未来 schema', genre: '都市现代', platform: 'fanqie', root })
      await engine.setActiveProject({ root })
      const path = join(root, 'novel.yaml')
      const document = parse(await readFile(path, 'utf8')) as Record<string, unknown>
      document.schema_version = 99
      await writeFile(path, stringify(document), 'utf8')
      const bundle = await engine.panelBundle({ root })
      expect(bundle.projects.some((project) => project.root === root)).toBe(true)
      expect(bundle.missing).toMatchObject({ root, reason: 'unreadable' })
    } finally {
      await cleanup()
    }
  })

  it('labels a registered directory without a project and prunes only its row', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '目录还在', genre: '都市现代', platform: 'fanqie', root })
      await engine.setActiveProject({ root })
      await rm(root, { recursive: true, force: true })
      await mkdir(root)
      await writeFile(join(root, 'keep.txt'), 'keep', 'utf8')
      const bundle = await engine.panelBundle({ root })
      expect(bundle.projects[0]).toMatchObject({ root, state: 'not-project' })
      expect(bundle.missing).toMatchObject({ root, reason: 'not-project' })
      const dry = await engine.pruneProjects({})
      expect(dry.candidates.some((candidate) => candidate.root === root)).toBe(true)
      const applied = await engine.pruneProjects({ apply: true })
      expect(applied.removed).toContain(root)
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('keep')
    } finally {
      await cleanup()
    }
  })

  it('shows the disk title when a registered path now holds another book', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '甲书', genre: '都市现代', platform: 'fanqie', root })
      await engine.setActiveProject({ root })
      const path = join(root, 'novel.yaml')
      const project = parse(await readFile(path, 'utf8')) as Record<string, unknown>
      project.title = '乙书'
      project.created_at = '2026-02-02'
      await writeFile(path, stringify(project), 'utf8')
      const bundle = await engine.panelBundle({ root })
      expect(bundle.projects[0]).toMatchObject({
        root,
        title: '乙书',
        state: 'ok',
        identity_changed: true,
      })
      expect(bundle.summary?.title).toBe('乙书')
    } finally {
      await cleanup()
    }
  })

  it('keeps report and panel quality samples aligned when a final review is gone', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      await rm(join(root, 'reviews/ch001.review.yaml'))
      const report = await engine.report({ root })
      const bundle = await engine.panelBundle({ root })
      expect(report.data.quality.samples).toBe(0)
      expect(bundle.summary?.quality?.samples).toBe(0)
      expect(report.data.quality.attempts).toBe(1)
      expect(bundle.summary?.quality?.attempts).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('does not count a malformed final review as a readable panel sample', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      await writeFile(join(root, 'reviews/ch001.review.yaml'), 'not: [valid', 'utf8')
      const report = await engine.report({ root })
      const bundle = await engine.panelBundle({ root })
      expect(report.data.quality.samples).toBe(0)
      expect(bundle.summary?.quality?.samples).toBe(0)
      expect(report.data.quality.attempts).toBe(1)
      expect(bundle.summary?.quality?.attempts).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('does not trust a malformed brief receipt file over a stale pipeline signature', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '回执之书', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      const receiptPath = join(root, 'state/briefs.yaml')
      const receipts = parse(await readFile(receiptPath, 'utf8')) as {
        receipts: Array<{ chapter: number; stage: string; digest: string; issued_at: string }>
      }
      const receipt = receipts.receipts[0]!
      const pipelinePath = join(root, 'state/pipeline.yaml')
      const pipeline = parse(await readFile(pipelinePath, 'utf8')) as {
        briefs: Record<string, { digest: string; issued_at: string }>
      }
      // A legacy signature that would be treated as current if the malformed
      // receipt file silently fell back to pipeline.briefs.
      pipeline.briefs = { P1: { digest: receipt.digest, issued_at: receipt.issued_at } }
      await writeFile(pipelinePath, stringify(pipeline), 'utf8')
      await writeFile(receiptPath, 'not: [valid', 'utf8')
      const bundle = await engine.panelBundle({ root })
      expect(bundle.summary?.legacy?.some((item) => item.code === 'LEGACY_BRIEFS')).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('refuses to overwrite a malformed brief receipt audit on getBrief', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '坏回执之书', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      const receiptPath = join(root, 'state/briefs.yaml')
      await writeFile(receiptPath, 'not: [valid', 'utf8')
      await expect(engine.getBrief({ stage: 'P1', root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      expect(await readFile(receiptPath, 'utf8')).toBe('not: [valid')
    } finally {
      await cleanup()
    }
  })

  it('ignores review documents for chapters outside the archived snapshot', () => {
    const extra = { ...review(), chapter: 2, round: 1, content_hash: 'hash-2' }
    const report = buildBookReport({
      project,
      outline: emptyOutline('2026-01-01'),
      outlinePresent: false,
      worldbook: emptyWorldbook('2026-01-01'),
      worldbookPresent: false,
      chapters: [oldChapter()],
      characters: { schema_version: 1, characters: [] },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
      reviews: [review(), extra],
      activity: [],
      targetChapters: 2,
      minScore: 120,
      foreshadowDormantAfter: 5,
    })
    expect(report.quality.samples).toBe(1)
    expect(report.quality.dimensions[0]).toMatchObject({ samples: 1 })
  })

  it('never reports fewer quality attempts than readable samples', () => {
    const second = { ...oldChapter(), num: 2, title: '第二章', file: 'chapters/chapter-002.md', score: 141 }
    const secondReview = { ...review(), chapter: 2, round: 1, content_hash: 'hash-2' }
    const report = buildBookReport({
      project,
      outline: emptyOutline('2026-01-01'),
      outlinePresent: false,
      worldbook: emptyWorldbook('2026-01-01'),
      worldbookPresent: false,
      chapters: [oldChapter(), second],
      characters: { schema_version: 1, characters: [] },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
      reviews: [review(), secondReview],
      activity: [],
      reviewAttempts: 1,
      targetChapters: 2,
      minScore: 120,
      foreshadowDormantAfter: 5,
    })
    expect(report.quality.samples).toBe(2)
    expect(report.quality.attempts).toBe(2)
  })

  it('does not show stale advisories after the manuscript leaves their check hash', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const original = await readyToArchive({ root, engine })
      const revised = original.replace('风从窗缝里挤进来', '雨从窗缝里挤进来')
      await engine.getBrief({ stage: 'P5', root })
      await engine.submitRevision({
        chapter: 1,
        content: revised,
        summary: sampleSummary({ opening: '雨从窗缝里挤进来，把桌上' }),
        proof: sampleReview(1, revised).proof,
        root,
      })
      const bundle = await engine.panelBundle({ root })
      expect(bundle.summary?.advisories ?? []).toHaveLength(0)
      expect(bundle.summary?.acknowledgedAdvisories ?? 0).toBe(0)
    } finally {
      await cleanup()
    }
  })
})
