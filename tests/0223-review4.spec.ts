import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BRIEF_BUDGET_CODEPOINTS, briefContext, type BriefContextInput } from '../src/engine/context.js'
import { windowBookReport } from '../src/engine/insight.js'
import { emptyPipeline } from '../src/engine/state.js'
import type { BookReport, ReviewDocument } from '../src/types.js'
import { bootstrapToDraft, cleanText, harness, sampleReview, sampleSemantic, writeDraft } from './helpers.js'

/**
 * 0.2.20 review round 4.
 *
 * Round 3 left ten items unfixed. Two of them are the same class of lie the
 * round was about: a read model that *reports* a window it never applied.
 *
 *  - `windowBookReport` had no step for `outline.drift`, so a 400-chapter book
 *    whose cards were renamed returned 34 KB under a `window` receipt that
 *    claimed everything was shown.
 *  - P5's brief carried `review` (with every issue) *and* a top-level `issues`
 *    copy of the same rows, neither of which was windowable or compactable.
 *    Thirty issues produced 21,528 code points and `complete: true` next to
 *    `overflow: true` — the model got a task book that was silently cut in half.
 */
const cp = (value: unknown): number => Array.from(JSON.stringify(value) ?? '').length

const emptyReport = (): BookReport =>
  ({
    progress: {
      archived: 0,
      target: null,
      words: 0,
      average_words: 0,
      percent: null,
      remaining_words: null,
      remaining_words_min: null,
      remaining_words_average: null,
      remaining_words_basis: 'none',
    },
    outline: {
      present: false,
      strict: false,
      target: null,
      total: 0,
      planned: 0,
      archived: 0,
      missing_cards: 0,
      planned_coverage: null,
      archived_coverage: null,
      coverage: 0,
      card_coverage: 0,
      volumes: [],
      drift: [],
    },
    worldbook: {
      present: false,
      characters: 0,
      locations: 0,
      factions: 0,
      rules: 0,
      glossary: 0,
      backstory: 0,
    },
    quality: {
      average: 0,
      median: 0,
      min: 0,
      max: 0,
      last_five: [],
      trend: null,
      trend_basis: 'insufficient_samples',
      samples: 0,
      dimensions: [],
    },
    effort: { reviews: 0, revisions: 0, checks: 0, rollbacks: 0, chapters: [], chapters_total: 0 },
    pacing: {
      paragraphs: [],
      dialogue: [],
      scene_types: {},
      hook_strength: {},
      plot_advancement: {},
      longest: null,
      shortest: null,
      calibration: { hook_1_3_count: 0, plot_low_count: 0, flat: false, anchor_note: 'x' },
    },
    cast: { total: 0, top: [] },
    debt: [],
    foreshadows: { open: 0, dormant: 0, overdue: 0, resolved: 0, oldest: [] },
    timeline: { events: 0, first_chapter: null, last_chapter: null },
    relationships: { total: 0, types: {} },
    activity: [],
    warnings: [],
  }) as unknown as BookReport

describe('0.2.20 review 4: report windows the drift list it lists', () => {
  it('shrinks 400 drift rows and reports how many it kept', () => {
    // Titles and scene types only drift when a card was renamed or retyped, so
    // this is a book whose outline was rewritten after the chapters landed.
    const report = emptyReport()
    report.outline.present = true
    report.outline.total = 400
    report.outline.drift = Array.from({ length: 400 }, (_, index) => ({
      chapter: index + 1,
      field: 'title' as const,
      planned: `原定标题：${'被改掉的旧标题'.repeat(5)}第${index + 1}章`,
      actual: `实际标题：${'归档时的新标题'.repeat(5)}第${index + 1}章`,
    }))
    expect(cp(report)).toBeGreaterThan(8_192)

    const windowed = windowBookReport(report)
    expect(cp(windowed)).toBeLessThanOrEqual(8_192)
    expect(windowed.window?.complete).toBe(false)
    const omitted = windowed.window?.omitted['outline.drift']
    expect(omitted).toMatchObject({ total: 400 })
    expect(omitted!.shown).toBeLessThan(400)
    // The receipt must describe the payload it is attached to.
    expect(windowed.outline.drift).toHaveLength(omitted!.shown)
    expect(windowed.window?.fetch.some((entry) => entry.tool === 'novel_state')).toBe(true)
    // Numbers stay whole: the reader still learns how much drifted.
    expect(windowed.outline.total).toBe(400)
  })

  it('leaves a small drift list alone and claims no window', () => {
    const report = emptyReport()
    report.outline.drift = [{ chapter: 2, field: 'title', planned: '旧', actual: '新' }]
    const windowed = windowBookReport(report)
    expect(windowed.outline.drift).toHaveLength(1)
    expect(windowed.window).toBeUndefined()
  })
})

const summary = {
  events: ['第 500 章的事件'],
  characters_appeared: ['角色1'],
  foreshadows: { planted: [], advanced: [], resolved: [] },
  new_elements: { locations: [], abilities: [], artifacts: [] },
  resource_changes: [],
  opening: '风从窗缝里挤进来，把桌上的纸吹得翻了一页。',
  continuity: { opens_from: '上一章结尾', ends_with: '信件' },
  hook_strength: 4 as const,
  pleasure_points: ['新线索'],
  plot_advancement: 'mid' as const,
}

/** A review with `count` open issues, the shape a bad chapter really produces. */
const reviewWith = (count: number): ReviewDocument => ({
  schema_version: 1,
  chapter: 500,
  round: 1,
  content_hash: 'h',
  dimensions: Array.from({ length: 15 }, (_, index) => ({
    id: `R-${String(index + 1).padStart(2, '0')}`,
    max: 10,
    deductions: [{ rule: 'X', location: '第1段', delta: 1, note: '扣一分' }],
  })),
  issues: Array.from({ length: count }, (_, index) => ({
    id: `ISS-${String(index + 1).padStart(3, '0')}`,
    severity: (index === 0 ? 'blocker' : 'advisory') as 'blocker' | 'advisory',
    dimension: 'R-01',
    location: `第 ${index + 1} 段`,
    problem: `问题描述 ${index + 1}：${'这一段的信息密度偏低而情绪指向暧昧。'.repeat(4)}`,
    fix: `修复建议 ${index + 1}：${'把动作写具体，删掉解释情绪的句子。'.repeat(3)}`,
    status: 'open' as const,
  })),
  total: 135,
})

const p5Input = (review: ReviewDocument | null): BriefContextInput => ({
  stage: 'P5',
  chapter: 500,
  project: {
    schema_version: 1,
    title: '长夜之书',
    genre: '都市现代',
    platform: 'fanqie',
    author: '',
    description: '',
    created_at: new Date(0).toISOString(),
    targets: { words_per_chapter: [2000, 3000], total_chapters: 600, dialogue_ratio: [0.4, 0.6] },
  },
  pipeline: emptyPipeline({ revision: 1, chapter: 500, stage: 'P5' }),
  chapters: { schema_version: 1, chapters: [] },
  characters: { schema_version: 1, characters: [] },
  world: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
  locks: { schema_version: 1, locked_at_chapter: 500, characters: {}, locations: {} },
  foreshadows: { schema_version: 1, next_seq: 1, items: [] },
  timeline: { schema_version: 1, next_seq: 1, items: [] },
  relationships: { schema_version: 1, next_seq: 1, items: [] },
  plan: {
    chapter: 500,
    title: '终局之雨',
    scene_type: '情感爆发章',
    narrator: '他',
    beats: ['起', '承'],
    opening: '风从窗缝里挤进来',
    ending: '蜡印',
    target_words: [2000, 3000],
    summary,
    cast: [],
  },
  review,
  check: null,
  text: `正文${'雨'.repeat(400)}`,
  previousText: null,
  handoff: null,
  machine: null,
})

describe('0.2.20 review 4: the P5 task book fits a 30-issue review', () => {
  it('keeps the receipt honest instead of overflowing while claiming complete', () => {
    // The service measures to `BRIEF_BUDGET_CODEPOINTS`; the tool never
    // returns an unmeasured brief, so the test uses the same number.
    const brief = briefContext({ ...p5Input(reviewWith(30)), budget: BRIEF_BUDGET_CODEPOINTS })
    expect(cp(brief)).toBeLessThanOrEqual(8_192)
    const meta = brief.context_meta as {
      complete: boolean
      compacted?: Record<string, { full: number; shown: number; why: string }>
      budget: { used: number; limit: number; overflow: boolean }
    }
    expect(meta.budget.overflow).toBe(false)
    expect(meta.complete).toBe(false)
    expect(meta.compacted?.review).toMatchObject({ full: expect.any(Number) })
    // A blocker must survive compaction; a revision that cannot see it fails
    // PG-08 with no way to learn the id from the brief.
    const text = JSON.stringify(brief)
    expect(text).toContain('ISS-001')
  })

  it('keeps every work order when a review is large but not pathological', () => {
    // Eight issues with a long problem/fix each: dropping rows would leave the
    // model unable to act, so the compact form keeps all eight and shortens the
    // text instead.
    const brief = briefContext({ ...p5Input(reviewWith(8)), budget: BRIEF_BUDGET_CODEPOINTS })
    const review = brief.review as {
      issues: Array<{ id: string; problem: string; fix?: string }>
      issue_counts: { total: number; open: number }
    }
    expect(review.issues).toHaveLength(8)
    expect(review.issue_counts.total).toBe(8)
    expect(review.issues[0]!.fix).toBeTruthy()
    expect(review.issues[0]!.problem.length).toBeGreaterThan(20)
    expect(cp(brief)).toBeLessThanOrEqual(BRIEF_BUDGET_CODEPOINTS)
  })

  it('does not carry the review twice', () => {
    const brief = briefContext(p5Input(reviewWith(3)))
    const issues = (brief.issues as unknown[] | undefined) ?? []
    // `review.issues` is the same rows; a second copy doubles the cost of the
    // one block a revision cannot do without.
    expect(issues).toHaveLength(0)
    expect((brief.review as ReviewDocument).issues).toHaveLength(3)
  })

  it('leaves a short review whole', () => {
    const brief = briefContext(p5Input(reviewWith(2)))
    const meta = brief.context_meta as { complete: boolean; compacted?: Record<string, unknown> }
    expect(meta.complete).toBe(true)
    expect(meta.compacted?.review).toBeUndefined()
    expect((brief.review as ReviewDocument).issues[0]!.problem).toContain('问题描述 1')
  })
})

describe('0.2.20 review 4: a damaged ledger answers with a payload that fits', () => {
  it('caps raw repair text in code points and names the full file', async () => {
    // 4,800 timeline rows is ~480 KB. The old 64 KiB cap made `novel_state`
    // return a repair payload six times the host limit, so the host cut it —
    // the caller lost both the tail of `raw` and the `raw_truncated` flag that
    // said so.
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '损坏台账', genre: '都市现代', platform: 'fanqie', root })
      const rows = Array.from({ length: 4_800 }, (_, index) =>
        [
          `  - id: TE-${String(index + 1).padStart(5, '0')}`,
          `    chapter: ${index + 1}`,
          `    story_time: Day ${index + 1}`,
          `    description: 时间线事件 ${index + 1}`,
          `    location: 地点${index + 1}`,
          `    characters: [角色${index + 1}]`,
          `    characters_extra: [${'配角甲'.repeat(12)}]`,
        ].join('\n'),
      )
      const broken = `schema_version: 1\nnext_seq: 4801\nitems:\n${rows.join('\n')}\n  - id: [半截行`
      await writeFile(join(root, 'state/timeline.yaml'), broken, 'utf8')
      const data = (await engine.queryState({ kind: 'timeline', root })).data as {
        damaged?: boolean
        raw?: string | null
        raw_truncated?: boolean
        raw_total?: number
        raw_path?: string
      }
      expect(data.damaged).toBe(true)
      expect(data.raw_truncated).toBe(true)
      expect(cp(data)).toBeLessThanOrEqual(8_192)
      expect(data.raw_total).toBeGreaterThan(8_192)
      expect(data.raw_path).toBe('state/timeline.yaml')
      // A byte-wise cut can land inside a multi-byte character; a repair built
      // on the mangled text then fails to parse for a new reason.
      expect(data.raw).not.toContain('\uFFFD')
      expect(data.raw ?? '').toContain('raw 已截断')
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.20 review 4: one rule for "the paragraph did not change"', () => {
  it('marks evidence from an unchanged paragraph stale and accepts a rewritten one', async () => {
    const { staleEvidenceParagraph } = await import('../src/engine/gates.js')
    const before = '风从窗缝里挤进来。\n\n门被推开时带进一股凉气。\n\n信封没有署名。'
    const after = '冷风从窗缝里挤进来。\n\n门被推开时带进一股凉气。\n\n信封没有署名。'
    // Paragraph 2 is byte-identical in both versions: a quote from it proves
    // nothing about the revision. PG-08 and `amend_issues` both ask this now.
    expect(staleEvidenceParagraph(after, '门被推开时带进一股凉气', before, 2)).toBe(2)
    // Paragraph 1 really changed.
    expect(staleEvidenceParagraph(after, '冷风从窗缝里挤进来', before, 1)).toBeNull()
    // No baseline (first draft / damaged history) means no staleness claim.
    expect(staleEvidenceParagraph(after, '门被推开时带进一股凉气', null, 2)).toBeNull()
    // A quote that did not exist before cannot be stale.
    expect(staleEvidenceParagraph(after, '信封没有署名', '别的一版正文', 3)).toBeNull()
  })
})

describe('0.2.20 review 4: an archived card always lands inside a volume', () => {
  const outlineDoc = (volumes: Array<{ title: string; start_chapter: number; end_chapter: number }>) => ({
    schema_version: 1 as const,
    book: {
      premise: '',
      logline: '',
      themes: [],
      tone: '',
      pov: '',
      audience: '',
      selling_points: [],
      ending: '',
      strict: false,
    },
    volumes: volumes.map((volume, index) => ({
      id: `V${index + 1}`,
      ...volume,
      goal: '',
      arc: '',
      climax: '',
      status: 'writing' as const,
    })),
    chapters: [],
    updated_at: new Date(0).toISOString(),
  })
  const record = (num: number) => ({
    num,
    title: `第${num}章`,
    file: `chapters/chapter-${String(num).padStart(3, '0')}.md`,
    word_count: 2_000,
    cjk_words: 1_800,
    dialogue_ratio: 0.4,
    scene_type: '日常过渡章' as const,
    narrator: '他',
    score: 140,
    status: 'archived' as const,
    content_hash: 'h',
    archived_at: new Date(0).toISOString(),
    final_check: 'pass' as const,
    rounds: { review: 1, revise: 0, check: 1 },
    summary: {
      events: ['事件一'],
      characters_appeared: ['他'],
      foreshadows: { planted: [], advanced: [], resolved: [] },
      new_elements: { locations: [], abilities: [], artifacts: [] },
      resource_changes: [],
      opening: '开头',
      continuity: { opens_from: '上一章', ends_with: '收束' },
      hook_strength: 4,
      pleasure_points: [],
      plot_advancement: 'mid',
    },
  })

  it('extends the open volume instead of writing a card outside every volume', async () => {
    const { markOutlineArchived } = await import('../src/engine/book.js')
    const document = outlineDoc([{ title: '第一卷', start_chapter: 1, end_chapter: 2 }])
    const next = markOutlineArchived(
      document as unknown as Parameters<typeof markOutlineArchived>[0],
      record(3) as unknown as Parameters<typeof markOutlineArchived>[1],
      new Date(0).toISOString(),
    )
    const card = next.chapters.find((row) => row.num === 3)
    // The old behaviour wrote `volume: null`; `assertArchivedCardsInVolumes`
    // then refused every later outline write on the book that had just archived.
    expect(card?.volume).toBe(1)
    expect(next.volumes[0]!.end_chapter).toBe(3)
    // The chapter that was already covered keeps its own volume.
    const inside = markOutlineArchived(
      document as unknown as Parameters<typeof markOutlineArchived>[0],
      record(2) as unknown as Parameters<typeof markOutlineArchived>[1],
      new Date(0).toISOString(),
    )
    expect(inside.chapters.find((row) => row.num === 2)?.volume).toBe(1)
    expect(inside.volumes[0]!.end_chapter).toBe(2)
  })
})

describe('0.2.20 review 4: a reclaimed lock cannot commit', () => {
  it('aborts the transaction when another writer took the lock', async () => {
    const { FileLock } = await import('../src/store/lock.js')
    const { FsStore } = await import('../src/store/fs.js')
    const { runTransaction } = await import('../src/store/txn.js')
    const { mkdtemp, readFile, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const root = await mkdtemp(join(tmpdir(), 'lock-lost-'))
    try {
      const store = new FsStore(root)
      const lockPath = join(root, '.novel.lock')
      const lock = new FileLock(lockPath)
      await lock.acquire()
      // Another writer reclaimed it: the canonical path now carries a different
      // record, exactly what `tryReclaim` leaves behind after `maxAgeMs`.
      await writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid + 1, startedAt: new Date(0).toISOString(), nonce: 'other' }),
        'utf8',
      )
      await expect(lock.assertOwned()).rejects.toMatchObject({ code: 'ENGINE_LOCK_LOST' })
      await expect(
        runTransaction(store, {
          txid: '11111111-1111-4111-8111-111111111111',
          op: 'amend',
          chapter: 1,
          revision: 2,
          backup: false,
          files: [{ path: 'novel.yaml', text: 'title: 抢锁之后\n' }],
          afterVerify: () => lock.assertOwned(),
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_LOCK_LOST' })
      // Nothing was renamed over the newer writer's file.
      await expect(readFile(join(root, 'novel.yaml'), 'utf8')).rejects.toThrowError()
      await lock.release()
    } finally {
      const { rm } = await import('node:fs/promises')
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('0.2.20 review 4: restoring the manuscript rebinds the blocking list', () => {
  it('drops check blockers that judged the text it replaced', async () => {
    const h = await harness()
    try {
      await bootstrapToDraft({ root: h.root, engine: h.engine })
      const text = cleanText()
      await writeDraft({ root: h.root, engine: h.engine, text })
      await h.engine.getBrief({ stage: 'P4', root: h.root })
      const blocker = {
        id: 'REV-001',
        severity: 'blocker' as const,
        status: 'open' as const,
        dimension: 'R-W-01',
        location: '第 2 段',
        problem: '动作缺少动机',
        fix: '补一句为什么',
      }
      const first = sampleReview(1, text, { issues: [blocker] })
      await h.engine.submitReview({ chapter: 1, ...first, root: h.root })
      await h.engine.getBrief({ stage: 'P5', root: h.root })
      const revised = text.replace('风从窗缝里挤进来', '冷风从窗缝里挤进来')
      const paragraphs = revised.split(/\n+/)
      await h.engine.submitRevision({
        chapter: 1,
        content: revised,
        proof: {
          opening: { paragraph: 1, quote: paragraphs[0]!.slice(0, 14) },
          middle: { paragraph: 3, quote: paragraphs[2]!.slice(0, 14) },
          ending: { paragraph: 5, quote: paragraphs[4]!.slice(0, 14) },
        },
        issues: [
          { ...blocker, status: 'fixed' as const, evidence: '冷风从窗缝里挤进来，把桌上的纸吹得翻了一页。' },
        ],
        root: h.root,
      })
      await h.engine.getBrief({ stage: 'P4', root: h.root })
      await h.engine.submitReview({ chapter: 1, ...sampleReview(1, revised), root: h.root })
      await h.engine.getBrief({ stage: 'P6', root: h.root })
      const semantic = sampleSemantic(revised, {
        'L2-CAUSALITY': { verdict: 'fail', note: '因果断裂' },
      })
      await h.engine.runCheck({ chapter: 1, semantic, root: h.root })
      const before = (await h.engine.getStatus({ root: h.root })).data as {
        blocking?: Array<{ code: string; scope?: string }>
      }
      expect(before.blocking?.some((item) => item.code === 'SEMANTIC_CHECK_FAILED')).toBe(true)
      // Put the pre-revision manuscript back: the failing check judged the other
      // text, so its blockers must not survive the restore.
      const { readFile } = await import('node:fs/promises')
      const journal = await readFile(join(h.root, 'state/journal.jsonl'), 'utf8')
      const txid = [...journal.trim().split('\n')]
        .map((line) => JSON.parse(line) as { txid: string; op: string; status: string })
        .filter((row) => row.op === 'submitRevision' && row.status === 'committed')
        .pop()!.txid
      await h.engine.restoreBackup({ txid, paths: ['chapters/chapter-001.md'], root: h.root })
      const after = (await h.engine.getStatus({ root: h.root })).data as {
        blocking?: Array<{ code: string; scope?: string; detail?: string }>
      }
      // The failing check judged the revised text; after the restore it is
      // stale evidence and must not keep `novel_status` red.
      expect(after.blocking?.some((item) => item.code === 'SEMANTIC_CHECK_FAILED')).toBe(false)
    } finally {
      await h.cleanup()
    }
  }, 60_000)
})

describe('0.2.20 review 4: a diff fits the channel it travels on', () => {
  it('caps the echoed texts and hunks and says how much it cut', async () => {
    const { harness } = await import('./helpers.js')
    const h = await harness()
    try {
      const before = Array.from({ length: 400 }, (_, index) => `第 ${index + 1} 行：${'旧'.repeat(30)}`).join(
        '\n',
      )
      const after = Array.from({ length: 400 }, (_, index) => `第 ${index + 1} 行：${'新'.repeat(30)}`).join(
        '\n',
      )
      const data = (await h.engine.diff({ before, after })).data
      expect(cp(data)).toBeLessThanOrEqual(8_192)
      expect(data.truncated?.before).toMatchObject({ shown: 1_000 })
      expect(data.truncated?.after).toMatchObject({ shown: 1_000 })
      expect(data.truncated?.hunks?.shown).toBe(60)
      expect(Array.from(data.before)).toHaveLength(1_001)
      expect(data.hunks).toHaveLength(60)
      // Numbers still describe the whole change, not the preview.
      expect(data.added + data.removed).toBeGreaterThan(0)
    } finally {
      await h.cleanup()
    }
  })
})

describe('0.2.20 review 4: the worldbook panel section counts every list it carries', () => {
  it('caps volumes and drift instead of shipping them unbudgeted', async () => {
    const { harness } = await import('./helpers.js')
    const h = await harness()
    try {
      await h.engine.initProject({ title: '卷上限', genre: '都市现代', platform: 'fanqie', root: h.root })
      // 50 volumes with realistic prose: ~11 KB of titles/goals/arcs, none of
      // which the preview budget knew about, so `truncated` stayed false.
      const volumes = Array.from({ length: 50 }, (_, index) => ({
        title: `第${index + 1}卷 · ${'卷名'.repeat(8)}`,
        start_chapter: index * 10 + 1,
        end_chapter: index * 10 + 10,
        goal: '本卷目标'.repeat(10),
        arc: '本卷弧线'.repeat(10),
        climax: '本卷高潮'.repeat(10),
        status: 'planned' as const,
      }))
      await h.engine.submitOutline({ volumes, chapters: [], root: h.root })
      const section = await h.engine.panelSection({ root: h.root, section: 'worldbook' })
      const items = section.items as { volumes: unknown[]; drift: unknown[] }
      expect(items.volumes).toHaveLength(12)
      expect(section.counts?.volumes).toMatchObject({ total: 50, shown: 12 })
      expect(section.truncated).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(section.items))).toBeLessThanOrEqual(64 * 1024)
    } finally {
      await h.cleanup()
    }
  })
})

describe('0.2.20 review 5: a summary-only revision forces a new task book', () => {
  it('renders and signs the draft summary, not the plan copy', async () => {
    const { harness, readyToArchive } = await import('./helpers.js')
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      // P6 is the stage that seals the summary. `novel_revise {summary}` is a
      // legal summary-only revision here and writes only `draft.summary`; the
      // plan file keeps the old one.
      const before = await h.engine.getBrief({ stage: 'P6', root: h.root })
      const revised = {
        ...(before.data.context.summary as Record<string, unknown>),
        events: ['改过的摘要事件'],
      }
      await h.engine.submitRevision({
        chapter: 1,
        summary: revised as never,
        root: h.root,
      })
      const after = await h.engine.getBrief({ stage: 'P6', root: h.root })
      // eslint-disable-next-line no-console
      console.log(
        'SUMS',
        JSON.stringify((before.data.context.summary as { events?: string[] }).events),
        JSON.stringify((after.data.context.summary as { events?: string[] }).events),
        before.data.digest === after.data.digest,
      )
      expect(after.data.digest).not.toBe(before.data.digest)
      expect(JSON.stringify(after.data.context.summary)).toContain('改过的摘要事件')
    } finally {
      await h.cleanup()
    }
  }, 60_000)
})

describe('0.2.20 review 5: the detail drawer offers a way back', () => {
  it('renders a retry button next to a failed chapter/quality detail', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    // The detail panels are pure render functions; the repository's panel tests
    // are structural. Assert the retry is wired to the same callback that opens
    // the drawer (`onClose(chapter)` re-fetches, `onClose(null)` closes).
    const source = await readFile(join(import.meta.dirname, '../src/client/panel.ts'), 'utf8')
    for (const label of ['章节详情读取失败', '质量详情读取失败']) {
      const start = source.indexOf(label)
      expect(start).toBeGreaterThan(-1)
      expect(source.slice(start, start + 600)).toContain('onClick: () => onClose(detail.chapter)')
    }
  })
})
