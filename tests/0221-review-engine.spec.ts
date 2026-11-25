import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { windowBookReport } from '../src/engine/insight.js'
import type { BookReport } from '../src/types.js'
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

/**
 * 0.2.20 review round: the defects that only a legal sequence of tool calls
 * reaches.
 *
 * Every case here is something the shipped suite could not see because each
 * individual call was valid; the state machine let the *sequence* through.
 */

describe('0.2.20 review: project switches round-trip', () => {
  it('creates a curly-quote project the engine can read back, and PG-04 accepts curly prose', async () => {
    const h = await harness()
    try {
      await bootstrapToDraft({ root: h.root, engine: h.engine, quotes: 'curly' })
      // The disk schema did not list `quotes`, so init wrote a field its own
      // reader rejected: every later call failed with PROJECT_UNREADABLE.
      const status = await h.engine.getStatus({ root: h.root })
      expect(status.data.project.title).toBe('测试之书')
      expect(status.data.state_errors ?? []).toEqual([])
      const project = parseYaml(await readFile(join(h.root, 'novel.yaml'), 'utf8')) as never
      expect(project).toMatchObject({ quotes: 'curly' })

      const text = `${cleanText(6)}\n\n“你来晚了。”他说。\n\n“路上堵车。”她把伞收起来。`
      await writeDraft({ root: h.root, engine: h.engine, text })
      // PG-04 used to judge quotes against `ascii` regardless of the project.
      await expect(h.engine.getBrief({ stage: 'P4', root: h.root })).resolves.toBeDefined()
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  it('accepts strict_cross and self_check_required at creation and through novel_amend', async () => {
    const h = await harness()
    try {
      await h.engine.initProject({
        title: '开关之书',
        genre: '都市现代',
        platform: 'fanqie',
        strict_cross: true,
        self_check_required: false,
        root: h.root,
      })
      const status = await h.engine.getStatus({ root: h.root })
      expect(status.data.project.title).toBe('开关之书')
      expect(status.data.state_errors ?? []).toEqual([])
      await h.engine.amend({
        path: 'novel.yaml',
        content: { strict_cross: false },
        reason: 'close the escalation',
        root: h.root,
      })
      const project = parseYaml(await readFile(join(h.root, 'novel.yaml'), 'utf8')) as never
      expect(project).toMatchObject({ strict_cross: false, self_check_required: false })
      await expect(
        h.engine.amend({ path: 'novel.yaml', content: { strict_cross: 'yes' }, reason: 'bad', root: h.root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await h.cleanup()
    }
  }, 60_000)
})

describe('0.2.20 review: a blocker cannot be closed by unchanged prose', () => {
  const blockedReview = (text: string) =>
    sampleReview(1, text, {
      issues: [
        {
          id: 'REV-001',
          severity: 'blocker' as const,
          status: 'open' as const,
          dimension: 'R-W-01',
          location: '第 2 段',
          problem: '动作缺少动机',
          fix: '补一句他为什么这么做',
        },
      ],
    })

  it('rejects a content revision that leaves the manuscript byte-identical', async () => {
    const h = await harness()
    try {
      await bootstrapToDraft({ root: h.root, engine: h.engine })
      const text = cleanText()
      await writeDraft({ root: h.root, engine: h.engine, text })
      await h.engine.getBrief({ stage: 'P4', root: h.root })
      await h.engine.submitReview({ chapter: 1, ...blockedReview(text), root: h.root })
      await h.engine.getBrief({ stage: 'P5', root: h.root })
      const sample = sampleReview(1, text)
      await expect(
        h.engine.submitRevision({
          chapter: 1,
          content: text,
          issues: sample.issues.map((issue) => ({
            ...issue,
            status: 'fixed' as const,
            evidence: '风从窗缝里挤进来，把桌上的纸吹得翻了一页。',
          })),
          proof: sample.proof,
          root: h.root,
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/ENGINE_GATE_BLOCKED|ENGINE_SCHEMA_INVALID/) })
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  it('rejects a blocker born `fixed` on the first review', async () => {
    const h = await harness()
    try {
      await bootstrapToDraft({ root: h.root, engine: h.engine })
      const text = cleanText()
      await writeDraft({ root: h.root, engine: h.engine, text })
      await h.engine.getBrief({ stage: 'P4', root: h.root })
      const sample = blockedReview(text)
      sample.issues[0]!.status = 'fixed'
      sample.issues[0]!.evidence = '风从窗缝里挤进来，把桌上的纸吹得翻了一页。'
      await expect(h.engine.submitReview({ chapter: 1, ...sample, root: h.root })).rejects.toMatchObject({
        code: 'ENGINE_ISSUE_IMMUTABLE',
      })
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  it('refuses to mark a blocker fixed by amendment while the text is unchanged', async () => {
    const h = await harness()
    try {
      await bootstrapToDraft({ root: h.root, engine: h.engine })
      const text = cleanText()
      await writeDraft({ root: h.root, engine: h.engine, text })
      await h.engine.getBrief({ stage: 'P4', root: h.root })
      await h.engine.submitReview({ chapter: 1, ...blockedReview(text), root: h.root })
      await h.engine.getBrief({ stage: 'P5', root: h.root })
      // A summary-only repair is legal at P5 and does not touch the manuscript.
      await h.engine.submitRevision({
        chapter: 1,
        summary: sampleSummary({ hook_strength: 5 }),
        root: h.root,
      })
      await expect(
        h.engine.submitReview({
          chapter: 1,
          amend_issues: [
            { id: 'REV-001', status: 'fixed', evidence: '风从窗缝里挤进来，把桌上的纸吹得翻了一页。' },
          ],
          root: h.root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_ISSUE_IMMUTABLE' })
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  it('cannot amend a blocker after a revision, because a revision returns to P4', async () => {
    // Round 3 listed this as a hole: `amend_issues` compares the whole-manuscript
    // hash while PG-08 compares paragraphs, so a stale quote could close a
    // blocker. The scenario needs a review whose `content_hash` predates the
    // current text *and* a stage where amendments are legal — but the transition
    // table sends every revision back to P4, and P4 refuses amendments. The two
    // rules are shared now anyway (`staleEvidenceParagraph`), so a future
    // transition change cannot reintroduce the gap.
    const h = await harness()
    try {
      await bootstrapToDraft({ root: h.root, engine: h.engine })
      const text = cleanText()
      await writeDraft({ root: h.root, engine: h.engine, text })
      await h.engine.getBrief({ stage: 'P4', root: h.root })
      const sample = blockedReview(text)
      await h.engine.submitReview({ chapter: 1, ...sample, root: h.root })
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
          {
            ...sample.issues[0]!,
            status: 'fixed' as const,
            evidence: '冷风从窗缝里挤进来，把桌上的纸吹得翻了一页。',
          },
        ],
        root: h.root,
      })
      const pipeline = (await h.engine.queryState({ kind: 'pipeline', root: h.root })).data as {
        stage: string
      }
      expect(pipeline.stage).toBe('P4')
      await expect(
        h.engine.submitReview({
          chapter: 1,
          amend_issues: [{ id: 'REV-001', status: 'fixed', evidence: '门被推开时带进一股凉气' }],
          root: h.root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_STAGE_ORDER' })
    } finally {
      await h.cleanup()
    }
  }, 60_000)
})

describe('0.2.20 review: archive evidence survives a restore', () => {
  it('refuses a chapters.yaml restore that would delete an archived chapter', async () => {
    const h = await harness()
    try {
      const text = cleanText()
      await readyToArchive({ root: h.root, engine: h.engine, text })
      const summary = sampleSummary()
      await h.engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root: h.root })
      const journal = await readFile(join(h.root, 'state/journal.jsonl'), 'utf8')
      const txid = [...journal.trim().split('\n')]
        .map((line) => JSON.parse(line) as { txid: string; op: string; status: string })
        .filter((row) => row.op === 'archiveChapter' && row.status === 'committed')
        .pop()!.txid
      await expect(
        h.engine.restoreBackup({
          txid,
          paths: ['state/chapters.yaml'],
          root: h.root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const chapters = await h.engine.queryState({ kind: 'chapters', root: h.root })
      expect((chapters.data as { chapters: Array<{ num: number }> }).chapters.map((row) => row.num)).toEqual([
        1,
      ])
    } finally {
      await h.cleanup()
    }
  }, 90_000)

  it('still reopens the last chapter after a brief was issued for the next one', async () => {
    const h = await harness()
    try {
      const text = cleanText()
      await readyToArchive({ root: h.root, engine: h.engine, text })
      await h.engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root: h.root,
      })
      // Exactly what `novel_status.next` recommends at `done`: the P1 brief for
      // the next chapter appends a receipt to state/briefs.yaml. That used to
      // make the reopen guard report "changed after the archive".
      await h.engine.getBrief({ stage: 'P1', root: h.root })
      const reopened = await h.engine.reopenChapter({
        chapter: 1,
        reason: 'review round probe',
        root: h.root,
      })
      expect(reopened.data.stage).toBe('P3')
    } finally {
      await h.cleanup()
    }
  }, 90_000)
})

describe('0.2.20 review: read models fit the host pruner', () => {
  it('returns the head of the journal first and reaches every row through the cursor', async () => {
    const h = await harness()
    try {
      await bootstrapToDraft({ root: h.root, engine: h.engine })
      const all = await h.engine.auditHistory({ limit: 200, root: h.root })
      const total = all.data.length
      expect(total).toBeGreaterThan(2)
      const first = await h.engine.auditHistory({ limit: 2, root: h.root })
      expect(first.data.map((row) => row.seq)).toEqual([1, 2])
      const seen = new Set<number>()
      for (const row of first.data) seen.add(row.seq!)
      let cursor = first.data[first.data.length - 1]!.seq!
      for (let page = 0; page < total; page += 1) {
        const next = await h.engine.auditHistory({ limit: 2, cursor, root: h.root })
        if (next.data.length === 0) break
        for (const row of next.data) seen.add(row.seq!)
        cursor = next.data[next.data.length - 1]!.seq!
      }
      expect(seen.size).toBe(total)
      const newest = await h.engine.auditHistory({ limit: 2, latest: true, root: h.root })
      expect(newest.data.map((row) => row.seq)).toEqual([total - 1, total])
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  it('windows a report that would otherwise be pruned, and says what it kept', () => {
    const chapters = Array.from({ length: 80 }, (_, index) => ({
      num: index + 1,
      reviews: 2,
      revisions: 1,
      checks: 2,
      rollbacks: 0,
      final_check: 'pass' as const,
      archived_at: '2026-01-01T00:00:00.000Z',
    }))
    const report = {
      progress: {
        archived: 80,
        target: null,
        words: 1,
        average_words: 1,
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
        average: 120,
        median: 120,
        min: 120,
        max: 120,
        last_five: [],
        trend: null,
        trend_basis: 'insufficient_samples',
        samples: 80,
        sample_chapters: Array.from({ length: 80 }, (_, index) => index + 1),
        dimensions: [],
      },
      effort: { reviews: 160, revisions: 80, checks: 160, rollbacks: 0, chapters, chapters_total: 80 },
      pacing: {
        scene_types: {},
        hook_strength: {},
        plot_advancement: {},
        longest: null,
        shortest: null,
        calibration: { hook_1_3_count: 0, plot_low_count: 0, flat: true, anchor_note: 'x' },
      },
      cast: { total: 0, top: [] },
      debt: [],
      foreshadows: { open: 0, dormant: 0, overdue: 0, resolved: 0, oldest: [] },
      timeline: { events: 0, first_chapter: null, last_chapter: null },
      relationships: { total: 0, types: {} },
      activity: [],
      warnings: [],
    } as unknown as BookReport
    const windowed = windowBookReport(report)
    const points = Array.from(JSON.stringify(windowed)).length
    expect(points).toBeLessThanOrEqual(8_192)
    expect(windowed.window?.complete).toBe(false)
    expect(windowed.window?.omitted['effort.chapters']).toMatchObject({ total: 80 })
    expect(windowed.window?.omitted['effort.chapters']!.shown).toBeLessThan(80)
    expect(windowed.effort.chapters.length).toBe(windowed.window!.omitted['effort.chapters']!.shown)
    expect(windowed.window?.fetch.length).toBeGreaterThan(0)
  })

  it('trims every preview list it can when one list would not be enough', () => {
    // Every ladder step has to run: a 40-row list is not enough to force the
    // page under the limit, so the loop walks down the ladder until it fits and
    // `omitted` names each list that lost rows.
    const row = (index: number) => ({ label: `条目${index}`, text: '很长的描述'.repeat(40) })
    const report = {
      progress: {
        archived: 40,
        target: null,
        words: 1,
        average_words: 1,
        percent: null,
        remaining_words: null,
        remaining_words_min: null,
        remaining_words_average: null,
        remaining_words_basis: 'none',
      },
      outline: {
        present: true,
        strict: true,
        target: 40,
        total: 40,
        planned: 0,
        archived: 40,
        missing_cards: 0,
        planned_coverage: 1,
        archived_coverage: 1,
        coverage: 1,
        card_coverage: 1,
        volumes: Array.from({ length: 40 }, (_, index) => ({
          title: `第${index + 1}卷`,
          start: index + 1,
          end: index + 1,
          planned: 1,
          archived: 1,
        })),
        drift: [],
      },
      worldbook: {
        present: true,
        characters: 40,
        locations: 0,
        factions: 0,
        rules: 0,
        glossary: 0,
        backstory: 0,
        anchors: Array.from({ length: 40 }, (_, index) => ({
          name: `角色${index}`,
          kind: 'character',
          anchors: ['很长的锚点'.repeat(30)],
        })),
      },
      quality: {
        average: 120,
        median: 120,
        min: 120,
        max: 120,
        last_five: [],
        trend: null,
        trend_basis: 'insufficient_samples',
        samples: 40,
        sample_chapters: Array.from({ length: 80 }, (_, index) => index + 1),
        dimensions: [],
      },
      effort: {
        reviews: 80,
        revisions: 40,
        checks: 80,
        rollbacks: 0,
        chapters: Array.from({ length: 80 }, (_, index) => ({
          num: index + 1,
          reviews: 2,
          revisions: 1,
          checks: 2,
          rollbacks: 0,
          final_check: 'pass' as const,
          archived_at: '2026-01-01T00:00:00.000Z',
        })),
      },
      pacing: {
        scene_types: {},
        hook_strength: {},
        plot_advancement: {},
        longest: null,
        shortest: null,
        calibration: { hook_1_3_count: 0, plot_low_count: 0, flat: true, anchor_note: 'x' },
      },
      cast: {
        total: 40,
        top: Array.from({ length: 40 }, (_, index) => ({
          name: `角色${index}`,
          appearances: 40,
          last_seen: 40,
          role: 'supporting',
        })),
      },
      debt: [],
      foreshadows: {
        open: 0,
        dormant: 0,
        overdue: 0,
        resolved: 0,
        oldest: Array.from({ length: 40 }, (_, index) => ({
          id: `FS-${index}`,
          title: `伏笔${index}`,
          last_touched: index + 1,
          age: 40 - index,
        })),
      },
      timeline: { events: 0, first_chapter: null, last_chapter: null },
      relationships: { total: 0, types: {} },
      activity: Array.from({ length: 40 }, (_, index) => ({
        at: '2026-01-01T00:00:00.000Z',
        op: `op${index}`,
        chapter: index + 1,
        status: 'committed',
      })),
      self_check: {
        chapters: 40,
        items: Array.from({ length: 13 }, (_, index) => ({
          id: 'SC-METAPHOR' as const,
          title: `自查${index}`,
          pass: 1,
          fail: 0,
          na: 0,
          fail_rate: 0,
        })),
        worst: [],
      },
      warnings: Array.from({ length: 40 }, () => row(1).text),
    } as unknown as BookReport
    const windowed = windowBookReport(report)
    expect(Array.from(JSON.stringify(windowed)).length).toBeLessThanOrEqual(8_192)
    expect(windowed.window?.complete).toBe(false)
    expect(Object.keys(windowed.window!.omitted).length).toBeGreaterThan(3)
    for (const [key, entry] of Object.entries(windowed.window!.omitted)) {
      expect(entry.shown, `${key} shown count`).toBeLessThan(entry.total)
    }
    expect(windowed.effort.chapters_truncated).toBeDefined()
  })

  it('keeps a P4 brief under the host cap even when every cast card is long', async () => {
    const h = await harness()
    try {
      const names = Array.from({ length: 8 }, (_, index) => `角色${index + 1}`)
      await h.engine.initProject({
        title: '宽卡之书',
        genre: '都市现代',
        platform: 'fanqie',
        root: h.root,
        words_per_chapter: [80, 400],
      })
      await h.engine.getBrief({ stage: 'P1', root: h.root })
      await h.engine.submitWorldPlan({
        chapter: 0,
        objective: '八个人在雨夜碰头',
        constraints: [],
        characters: names.map((name) => ({ name, role: '配角', current_state: '在场' })),
        locations: [],
        continuity_notes: [],
        root: h.root,
      })
      await h.engine.getBrief({ stage: 'P2', root: h.root })
      await h.engine.submitChapterPlan({
        chapter: 0,
        title: '雨夜碰头',
        scene_type: '日常过渡章',
        narrator: '角色1',
        beats: ['风起', '人来', '对质', '交换', '决定'],
        opening: '风从窗缝里挤进来',
        ending: '蜡印',
        target_words: [80, 400],
        cast: names.map((name) => ({ name })),
        root: h.root,
      })
      await h.engine.amend({
        path: 'state/characters.yaml',
        content: {
          schema_version: 1,
          characters: names.map((name, index) => ({
            name,
            role: 'supporting',
            first_appearance: 1,
            profile: { bio: `人物小传 ${index + 1}。`.repeat(40) },
            current_state: { mood: '平静' },
            growth: [],
            updated_at: 1,
          })),
        },
        reason: 'fat cast cards',
        root: h.root,
      })
      const text = `${cleanText(6)}\n\n${names.join('、')}都在码头等着。`
      await h.engine.getBrief({ stage: 'P3', root: h.root })
      await h.engine.submitDraft({
        chapter: 1,
        content: text,
        chapter_title: '雨夜碰头',
        scene_type: '日常过渡章',
        narrator: '角色1',
        summary: sampleSummary({ characters_appeared: names }),
        root: h.root,
      })
      const brief = await h.engine.getBrief({ stage: 'P4', root: h.root })
      const payload = Array.from(JSON.stringify(brief.data)).length
      const meta = (
        brief.data.context as {
          context_meta: { complete: boolean; omitted: Record<string, { clipped?: number }>; fetch: unknown[] }
        }
      ).context_meta
      expect(payload, `payload ${payload} cp; meta ${JSON.stringify(meta)}`).toBeLessThanOrEqual(8_192)
      // P4 judges the manuscript, so a brief that fits by showing zero
      // paragraphs is not a fix: the whole (short) chapter must be there.
      const context = brief.data.context as { text?: string }
      expect(context.text, 'P4 must receive the manuscript').toContain('风从窗缝里挤进来')
      expect(meta.omitted['text'], 'a 7-paragraph chapter must fit whole').toBeUndefined()
      // If the cast rows were shortened, the receipt must say so; a brief that
      // silently truncates a card is the defect this round removes.
      const cast = JSON.stringify((brief.data.context as { characters?: unknown }).characters ?? [])
      if (cast.includes('…')) {
        expect(meta.complete).toBe(false)
        expect(meta.omitted['characters']!.clipped).toBeGreaterThan(0)
      }
    } finally {
      await h.cleanup()
    }
  }, 90_000)
})

describe('0.2.20 review: amend paths stay inside the document', () => {
  it('refuses a patch path that would walk the prototype chain', async () => {
    const h = await harness()
    try {
      await h.engine.initProject({ title: '原型之书', genre: '都市现代', platform: 'fanqie', root: h.root })
      for (const path of ['__proto__.nwe_polluted', 'constructor.prototype.nwe_polluted']) {
        await expect(
          h.engine.amend({
            path: 'state/characters.yaml',
            patch: [{ op: 'add', path, value: 'yes' }],
            reason: 'probe',
            root: h.root,
          }),
        ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      }
      // The previous code walked into Object.prototype and wrote there while
      // reporting a successful amend with `changes: []`.
      expect(({} as Record<string, unknown>).nwe_polluted).toBeUndefined()
    } finally {
      await h.cleanup()
    }
  }, 60_000)
})
