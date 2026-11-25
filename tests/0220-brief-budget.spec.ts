import { describe, expect, it } from 'vitest'
import { briefContext, type BriefContextInput } from '../src/engine/context.js'
import { emptyPipeline } from '../src/engine/state.js'
import type { CheckDocument, ReviewDocument } from '../src/types.js'
import {
  archiveDelta,
  cleanText,
  harness,
  readyToArchive,
  sampleReview,
  sampleSemantic,
  sampleSummary,
  writeDraft,
} from './helpers.js'

/**
 * 0.2.20 WP1: the task book must fit the host's task-result pruner.
 *
 * The host counts **Unicode code points** (`Array.from(text).length`), not
 * bytes, and keeps only the first 4,096 + last 1,024 of a result above 8,192.
 * The engine therefore budgets in code points and reports what it left out.
 * These tests are deliberately written against that unit; measuring bytes here
 * would pass while the model still received half a brief.
 */
const cp = (value: unknown): number => Array.from(JSON.stringify(value) ?? '').length
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

const summaryFor = (chapter: number) => ({
  events: [`第 ${chapter} 章的事件`],
  characters_appeared: ['角色1', '角色2'],
  foreshadows: { planted: [], advanced: [], resolved: [] },
  new_elements: { locations: [], abilities: [], artifacts: [] },
  resource_changes: [],
  opening: '风从窗缝里挤进来，把桌上的纸吹得翻了一页。',
  continuity: { opens_from: '上一章结尾', ends_with: '信件' },
  hook_strength: 4 as const,
  pleasure_points: ['新线索'],
  plot_advancement: 'mid' as const,
})

const inputWith = (overrides: Partial<BriefContextInput> = {}): BriefContextInput => {
  const chapter = overrides.chapter ?? 500
  return {
    stage: 'P6',
    chapter,
    project: {
      schema_version: 1,
      title: '长夜之书',
      genre: '都市现代',
      platform: 'fanqie',
      author: '',
      description: '一个关于旧信与旧账的故事',
      created_at: new Date(0).toISOString(),
      targets: { words_per_chapter: [2000, 3000], total_chapters: 600, dialogue_ratio: [0.4, 0.6] },
    },
    pipeline: emptyPipeline({ revision: 1, chapter, stage: 'P6' }),
    chapters: {
      schema_version: 1,
      chapters: Array.from({ length: 4 }, (_, index) => {
        const num = chapter - 3 + index
        return {
          num,
          title: `第${num}章`,
          file: `chapters/chapter-${String(num).padStart(3, '0')}.md`,
          word_count: 2000,
          dialogue_lines: 10,
          dialogue_ratio: 0.4,
          scene_type: '日常过渡章' as const,
          narrator: '他',
          score: 130,
          status: 'reviewed' as const,
          content_hash: 'h',
          summary: summaryFor(num),
        }
      }),
    },
    characters: {
      schema_version: 1,
      characters: Array.from({ length: 200 }, (_, index) => ({
        name: `角色${index + 1}`,
        role: 'supporting',
        first_appearance: index + 1,
        profile: { bio: `人物小传 ${index + 1}。`.repeat(3) },
        current_state: { mood: '平静' },
        growth: [],
        updated_at: index + 1,
      })),
    },
    world: {
      schema_version: 1,
      locations: Array.from({ length: 80 }, (_, index) => ({
        name: `地点${index + 1}`,
        first_appearance: index + 1,
        locked: false,
        description: `地点描述 ${index + 1}。`.repeat(3),
        layout: '三排工位',
        capacity: 30,
        changes: [],
      })),
      abilities: Array.from({ length: 30 }, (_, index) => ({ name: `能力${index + 1}` })),
      artifacts: Array.from({ length: 30 }, (_, index) => ({ name: `物品${index + 1}` })),
      factions: Array.from({ length: 20 }, (_, index) => ({ name: `势力${index + 1}` })),
      rules: Array.from({ length: 20 }, (_, index) => ({ name: `规则${index + 1}` })),
    },
    locks: {
      schema_version: 1,
      locked_at_chapter: chapter,
      characters: Object.fromEntries(
        Array.from({ length: 60 }, (_, index) => [
          `角色${index + 1}`,
          { first_appearance: index + 1, locked_at: index + 1, appearance: `外貌 ${index + 1}` },
        ]),
      ),
      locations: Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [
          `地点${index + 1}`,
          { first_appearance: index + 1, locked_at: index + 1, layout: '三排工位', capacity: 30 },
        ]),
      ),
    },
    foreshadows: {
      schema_version: 1,
      next_seq: 101,
      items: Array.from({ length: 100 }, (_, index) => ({
        id: `FS-${String(index + 1).padStart(3, '0')}`,
        title: `伏笔${index + 1}`,
        planted: index + 1,
        last_touched: index + 1,
        status: 'planted' as const,
        resolved_at: null,
        description: `伏笔描述 ${index + 1}。`.repeat(4),
        advance_log: [],
      })),
    },
    timeline: {
      schema_version: 1,
      next_seq: 4801,
      items: Array.from({ length: 4800 }, (_, index) => ({
        id: `TE-${String(index + 1).padStart(5, '0')}`,
        chapter: index + 1,
        story_time: `Day ${index + 1}`,
        description: `时间线事件 ${index + 1}`,
        location: `地点${(index % 80) + 1}`,
        characters: [`角色${(index % 200) + 1}`],
      })),
    },
    relationships: {
      schema_version: 1,
      next_seq: 101,
      items: Array.from({ length: 100 }, (_, index) => ({
        id: `RL-${String(index + 1).padStart(3, '0')}`,
        a: `角色${index + 1}`,
        b: `角色${((index + 1) % 200) + 1}`,
        type: '同僚',
        since: index + 1,
        description: `关系 ${index + 1}`,
        evolution: [],
      })),
    },
    plan: {
      chapter,
      title: '终局之雨',
      scene_type: '情感爆发章',
      narrator: '他',
      beats: ['起', '承', '转', '合', '收'],
      opening: '风从窗缝里挤进来',
      ending: '蜡印',
      target_words: [2000, 3000],
      summary: summaryFor(chapter),
      cast: [{ name: '角色1', goal: '守住门' }],
    },
    review: {
      schema_version: 1,
      chapter,
      round: 1,
      content_hash: 'h',
      dimensions: [{ id: 'R-W-01', max: 15, deductions: [] }],
      issues: [],
      total: 150,
    } satisfies ReviewDocument,
    check: {
      schema_version: 1,
      chapter,
      scope: ['content', 'integrity'],
      content_hash: 'h',
      machine: { violations: [], metrics: {} as never },
      semantic: { items: [] },
      verdict: 'pass',
    } satisfies CheckDocument,
    text: `正文${'雨'.repeat(400)}`,
    machine: { violations: [], metrics: {} },
    previousText: `上一章结尾${'风'.repeat(100)}`,
    handoff: null,
    ...overrides,
  }
}

describe('0.2.20 WP1: context windowing', () => {
  it('fits a 4,800-row timeline into a 6,000-code-point context and says what it omitted', () => {
    const input = inputWith({ budget: 6000 })
    const context = briefContext(input) as Record<string, unknown> & {
      context_meta: {
        version: number
        stage: string
        used: number
        complete: boolean
        strategy: string
        budget: { unit: string; limit: number; used: number; exempt: string[]; overflow: boolean }
        omitted: Record<string, { total: number; shown: number }>
        fetch: Array<{ tool: string; args: Record<string, unknown>; why: string }>
      }
    }
    expect(cp(context), 'the whole context must fit the budget').toBeLessThanOrEqual(6000)
    const meta = context.context_meta
    expect(meta.version).toBe(2)
    expect(meta.stage).toBe('P6')
    expect(meta.complete).toBe(false)
    expect(meta.strategy).toBe('windowed')
    expect(meta.used, 'used is still the UTF-8 byte length of this document').toBe(bytes(context))
    expect(meta.budget.unit).toBe('codepoint')
    expect(meta.budget.limit).toBe(8192)
    expect(meta.budget.used).toBe(cp(context))
    expect(meta.budget.exempt).toEqual([])
    expect(meta.budget.overflow).toBe(false)
    // The one omission the test asked about.
    expect(meta.omitted.timeline?.total).toBe(4800)
    expect(meta.omitted.timeline!.shown).toBeGreaterThan(0)
    expect(meta.omitted.timeline!.shown).toBeLessThan(4800)
    // Every omitted block has a fetch entry that names novel_state.
    const fetchKinds = meta.fetch.map((entry) => {
      expect(entry.tool).toBe('novel_state')
      expect(typeof entry.why).toBe('string')
      expect(entry.why.length).toBeGreaterThan(0)
      return entry.args.kind
    })
    expect(fetchKinds).toContain('timeline')
    // Required blocks are whole. `book_plan` / `scene_distribution` /
    // `previous_ending` are roadmap blocks: P1–P3 and P5 place a chapter and
    // need them, P6 judges one that already exists and reads its own card.
    for (const key of [
      'project',
      'chapter',
      'stage',
      'summary',
      'check',
      'review',
      'active_cast',
      'score_history',
      'outline_card',
    ]) {
      expect(context[key], `required block ${key} must stay present`).toBeDefined()
    }
    for (const key of ['book_plan', 'scene_distribution', 'previous_ending', 'plan']) {
      expect(context[key], `block ${key} is not read at P6`).toBeUndefined()
    }
    expect(context.text).toBe(input.text)
    // P6 reads the summary it will archive with; the plan card is P3–P5.
    expect((context.summary as { opening: string }).opening).toContain('风从窗缝')
    // The shown timeline rows are a prefix of the relevance order.
    expect(Array.isArray(context.timeline)).toBe(true)
  })

  it('is byte-identical for equal input', () => {
    const first = JSON.stringify(briefContext(inputWith({ budget: 6000 })))
    const second = JSON.stringify(briefContext(inputWith({ budget: 6000 })))
    expect(second).toBe(first)
  })

  it('shows timeline rows nearest the current chapter before cutting', () => {
    const chapter = 500
    const input = inputWith({ chapter, budget: 6000 })
    const context = briefContext(input) as {
      timeline: Array<{ id: string; chapter: number }>
      context_meta: { omitted: Record<string, { total: number; shown: number }> }
    }
    const shown = new Set(context.timeline.map((item) => item.id))
    expect(context.timeline.length).toBe(context.context_meta.omitted.timeline!.shown)
    expect(shown.size).toBeGreaterThan(0)
    const shownDistances = context.timeline.map((item) => Math.abs(item.chapter - chapter))
    const omittedDistances = input.timeline.items
      .filter((item) => !shown.has(item.id))
      .map((item) => Math.abs(item.chapter - chapter))
    expect(Math.max(...shownDistances)).toBeLessThanOrEqual(Math.min(...omittedDistances))
    expect(Math.abs(context.timeline[0]!.chapter - chapter)).toBeLessThanOrEqual(
      Math.min(...omittedDistances),
    )
  })

  it('keeps the full content when the budget is infinite', () => {
    const unbudgeted = briefContext(inputWith())
    const full = briefContext(inputWith({ budget: Number.POSITIVE_INFINITY })) as {
      context_meta: {
        version: number
        complete: boolean
        strategy: string
        omitted: Record<string, unknown>
        fetch: unknown[]
      }
      timeline: unknown[]
    }
    expect(full.context_meta.version).toBe(2)
    expect(full.context_meta.complete).toBe(true)
    expect(full.context_meta.strategy).toBe('complete')
    expect(full.context_meta.omitted).toEqual({})
    expect(full.context_meta.fetch).toEqual([])
    expect(full.timeline).toHaveLength(4800)
    const strip = (value: Record<string, unknown>): string => {
      const copy = { ...value }
      delete copy.context_meta
      return JSON.stringify(copy)
    }
    expect(strip(full as unknown as Record<string, unknown>)).toBe(strip(unbudgeted))
  })

  it('still reports version 2 and a complete strategy when a finite budget fits', () => {
    const small = inputWith({ budget: 7000 })
    small.timeline.items = small.timeline.items.slice(0, 2)
    small.characters.characters = small.characters.characters.slice(0, 2)
    small.foreshadows.items = small.foreshadows.items.slice(0, 2)
    small.relationships.items = small.relationships.items.slice(0, 2)
    small.world.locations = small.world.locations.slice(0, 2)
    small.world.abilities = []
    small.world.artifacts = []
    small.world.factions = []
    small.world.rules = []
    small.locks.characters = Object.fromEntries(Object.entries(small.locks.characters).slice(0, 1))
    small.locks.locations = Object.fromEntries(Object.entries(small.locks.locations).slice(0, 1))
    const context = briefContext(small) as {
      context_meta: {
        version: number
        complete: boolean
        strategy: string
        omitted: Record<string, unknown>
        fetch: unknown[]
        budget: { unit: string; limit: number; used: number; exempt: string[]; overflow: boolean }
      }
    }
    expect(context.context_meta.version).toBe(2)
    expect(context.context_meta.complete).toBe(true)
    expect(context.context_meta.strategy).toBe('complete')
    expect(context.context_meta.omitted).toEqual({})
    expect(context.context_meta.fetch).toEqual([])
    expect(context.context_meta.budget).toMatchObject({
      unit: 'codepoint',
      limit: 8192,
      exempt: [],
      overflow: false,
    })
    expect(context.context_meta.budget.used).toBe(cp(context))
  })
})

const charactersDoc = (count: number) => ({
  schema_version: 1 as const,
  characters: Array.from({ length: count }, (_, index) => ({
    name: `角色${index + 1}`,
    role: 'supporting',
    first_appearance: index + 1,
    profile: { bio: `人物小传 ${index + 1}。`.repeat(4) },
    current_state: { mood: '平静' },
    growth: [],
    updated_at: index + 1,
  })),
})

const timelineDoc = (count: number) => ({
  schema_version: 1 as const,
  next_seq: count + 1,
  items: Array.from({ length: count }, (_, index) => ({
    id: `TE-${String(index + 1).padStart(5, '0')}`,
    chapter: index + 1,
    story_time: `Day ${index + 1}`,
    description: `时间线事件 ${index + 1}`,
    location: `地点${(index % 40) + 1}`,
    characters: [`角色${(index % 120) + 1}`],
  })),
})

const foreshadowsDoc = (count: number) => ({
  schema_version: 1 as const,
  next_seq: count + 1,
  items: Array.from({ length: count }, (_, index) => ({
    id: `FS-${String(index + 1).padStart(3, '0')}`,
    // Distinct two-character labels: `伏笔1` / `伏笔10` are similar enough for
    // the duplicate-title advisory to fire 92 times and swamp the measurement.
    title: `${String.fromCharCode(0x4e00 + index * 13)}${String.fromCharCode(0x6000 + ((index * 53) % 800))}`,
    planted: (index % 20) + 1,
    last_touched: (index % 20) + 1,
    status: 'planted' as const,
    resolved_at: null,
    description: `伏笔描述 ${index + 1}。`.repeat(4),
    advance_log: [],
  })),
})

const worldDoc = (locations: number) => ({
  schema_version: 1 as const,
  locations: Array.from({ length: locations }, (_, index) => ({
    name: `地点${index + 1}`,
    first_appearance: (index % 20) + 1,
    locked: false,
    description: `地点描述 ${index + 1}。`.repeat(3),
    layout: '三排工位',
    capacity: 30,
    changes: [],
  })),
  abilities: [],
  artifacts: [],
  factions: [],
  rules: [],
})

describe('0.2.20 WP1: engine payload budget', () => {
  it('windows a 120-character, 4,800-event project and keeps the pointers working', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '百人长书',
        genre: '都市现代',
        platform: 'fanqie',
        root,
        words_per_chapter: [80, 400],
      })
      await engine.getBrief({ stage: 'P1', root })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: '让一百二十个角色在雨夜碰头',
        constraints: ['没有超能力'],
        characters: Array.from({ length: 120 }, (_, index) => ({
          name: `角色${index + 1}`,
          role: '配角',
          current_state: '在场',
        })),
        locations: [],
        continuity_notes: [],
        root,
      })
      await engine.getBrief({ stage: 'P2', root })
      await engine.submitChapterPlan({
        chapter: 0,
        title: '雨夜碰头',
        scene_type: '日常过渡章',
        narrator: '他',
        beats: ['风起', '人来', '对质', '交换', '决定'],
        opening: '风从窗缝里挤进来',
        ending: '蜡印',
        target_words: [80, 400],
        root,
      })
      await engine.amend({
        path: 'state/characters.yaml',
        content: charactersDoc(120),
        reason: 'scale',
        root,
      })
      await engine.amend({ path: 'state/timeline.yaml', content: timelineDoc(4800), reason: 'scale', root })
      await engine.amend({
        path: 'state/foreshadows.yaml',
        content: foreshadowsDoc(100),
        reason: 'scale',
        root,
      })
      await engine.amend({ path: 'state/world.yaml', content: worldDoc(40), reason: 'scale', root })

      const measurements: Array<{
        stage: string
        payload: number
        fields: number
        context: number
        complete: boolean
        overflow: boolean
        /** The largest blocks, so a failure names what to cut. */
        blocks: string
      }> = []
      const measure = async (stage: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P8') => {
        const brief = await engine.getBrief({ stage, root })
        const meta = (
          brief.data.context as {
            context_meta: {
              version: number
              complete: boolean
              budget: { overflow: boolean }
            }
          }
        ).context_meta
        expect(meta.version, `${stage} context_meta version`).toBe(2)
        const parts: Array<[string, unknown]> = [
          ['content', brief.data.content],
          ['fields', brief.data.fields],
          ...Object.entries(brief.data.context as Record<string, unknown>).filter(
            ([key]) => key !== 'context_meta',
          ),
        ]
        const blocks = parts
          .map(([label, block]) => `${label} ${cp(block)}` as const)
          .sort((left, right) => Number(right.split(' ')[1]) - Number(left.split(' ')[1]))
          .slice(0, 6)
          .join(', ')
        measurements.push({
          stage,
          payload: cp(brief.data),
          fields: cp(brief.data.fields),
          context: cp(brief.data.context),
          complete: meta.complete,
          overflow: meta.budget.overflow,
          blocks,
        })
        return brief
      }
      await measure('P1')
      await measure('P2')
      await measure('P3')
      await writeDraft({ root, engine })
      await measure('P4')
      const text = cleanText()
      const review = sampleReview(1, text)
      await engine.submitReview({
        chapter: 1,
        dimensions: review.dimensions,
        issues: review.issues,
        proof: review.proof,
        root,
      })
      await measure('P6')
      await engine.runCheck({ chapter: 1, semantic: sampleSemantic(text), root })
      await measure('P8')
      await measure('P5')
      for (const row of measurements) {
        expect(row.fields, `${row.stage} fields code points`).toBeLessThanOrEqual(2048)
      }
      // Every stage fits the host's 8,192 code points, and no stage reports an
      // overflow: the blocks that could not be windowed (review, check,
      // self-check) are handed over as locators plus a `novel_state` pointer.
      // A brief that is silently pruned by the host is the defect this whole
      // work package exists to remove.
      for (const stage of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P8']) {
        const row = measurements.find((entry) => entry.stage === stage)!
        expect(row.payload, `${stage} payload ${row.payload} (${row.blocks})`).toBeLessThanOrEqual(8192)
        expect(
          row.overflow,
          `${stage} reports overflow (payload ${row.payload}, context ${row.context}, ${row.blocks})`,
        ).toBe(false)
      }
      const p6 = await engine.getBrief({ stage: 'P6', root })
      const meta = (
        p6.data.context as {
          context_meta: {
            complete: boolean
            omitted: Record<string, { total: number; shown: number }>
            fetch: Array<{ tool: string; args: Record<string, unknown> }>
          }
        }
      ).context_meta
      expect(meta.complete).toBe(false)
      expect(meta.omitted.timeline?.total).toBe(4800)
      expect(meta.omitted.characters?.total).toBe(120)
      for (const entry of meta.fetch) {
        // A fetch is only useful if it actually resolves. `novel_export` is the
        // manuscript pointer; `novel_state` is every ledger/document one.
        if (entry.tool === 'novel_export') {
          const exported = await engine.export({ ...(entry.args as Record<string, unknown>), root } as never)
          expect(exported.data).toBeDefined()
          continue
        }
        expect(entry.tool).toBe('novel_state')
        const answer = await engine.queryState({
          ...(entry.args as Record<string, unknown>),
          root,
        } as never)
        expect(answer.data).toBeDefined()
      }
      expect(new Set(measurements.map((row) => row.payload)).size).toBeGreaterThan(1)
    } finally {
      await cleanup()
    }
  })

  it('changes the signed digest when the displayed ledger grows', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const before = await engine.getBrief({ stage: 'P6', root })
      await engine.amend({
        path: 'state/characters.yaml',
        content: charactersDoc(120),
        reason: 'grow the ledger',
        root,
      })
      const after = await engine.getBrief({ stage: 'P6', root })
      expect(after.data.digest).not.toBe(before.data.digest)
    } finally {
      await cleanup()
    }
  })

  it('lets full:true exceed the host limit, warns, and does not poison the windowed cache', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.amend({ path: 'state/timeline.yaml', content: timelineDoc(4800), reason: 'scale', root })
      const windowed = await engine.getBrief({ stage: 'P6', root })
      const full = await engine.getBrief({ stage: 'P6', root, full: true })
      const fullContext = full.data.context as {
        context_meta: { complete: boolean; budget: { overflow: boolean } }
        timeline: unknown[]
      }
      expect(cp(full.data), 'full mode is allowed to exceed the budget').toBeGreaterThan(8192)
      expect(fullContext.context_meta.complete).toBe(true)
      expect(fullContext.context_meta.budget.overflow).toBe(true)
      expect(fullContext.timeline).toHaveLength(4800)
      expect(full.warnings.some((warning) => /诊断/.test(warning.message))).toBe(true)
      expect(full.warnings.some((warning) => /裁剪/.test(warning.message))).toBe(true)
      // The cache key must include the budget: asking for the window again
      // returns the same windowed document, not the full one.
      const again = await engine.getBrief({ stage: 'P6', root })
      expect(JSON.stringify(again.data.context)).toBe(JSON.stringify(windowed.data.context))
      expect(again.data.digest).toBe(windowed.data.digest)
      expect(full.data.digest).not.toBe(windowed.data.digest)
    } finally {
      await cleanup()
    }
  })

  it('rejects a submission signed under the full window', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.getBrief({ stage: 'P8', root, full: true })
      let error: unknown
      try {
        await engine.archiveChapter({
          chapter: 1,
          state_delta: archiveDelta(sampleSummary()),
          root,
        })
      } catch (caught) {
        error = caught
      }
      const blocking = (error as { blocking?: Array<{ code: string; details?: { stale_reason?: string } }> })
        .blocking
      expect(blocking?.map((item) => item.code)).toContain('PG-01')
      expect(blocking?.find((item) => item.code === 'PG-01')?.details?.stale_reason).toContain('window')
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.20 WP1: the manuscript is cut last and by paragraph', () => {
  /**
   * 0.2.20 changed this contract. 0.2.17 refused to trim the manuscript and
   * declared the overflow instead — but the host prunes at 8,192 code points
   * anyway, at an arbitrary offset, and the model then reads half a sentence
   * with no receipt saying so. A paragraph-boundary window plus an explicit
   * `novel_export` pointer is the only version where the reader knows what is
   * missing and can fetch it.
   */
  const paragraphInput = (): BriefContextInput => {
    const input = inputWith({ budget: 6000 })
    input.stage = 'P6'
    input.text = Array.from({ length: 200 }, (_, index) => `第${index + 1}段：${'雨'.repeat(60)}`).join(
      '\n\n',
    )
    return input
  }

  it('keeps whole paragraphs, names the ones it withheld, and points at novel_export', () => {
    const input = paragraphInput()
    const context = briefContext(input) as {
      text: string
      context_meta: {
        complete: boolean
        strategy: string
        budget: { overflow: boolean; exempt: string[] }
        omitted: Record<string, { total: number; shown: number }>
        fetch: Array<{ tool: string; args: Record<string, unknown>; why: string }>
      }
    }
    expect(context.context_meta.budget.overflow, 'the document itself fits').toBe(false)
    expect(context.context_meta.complete).toBe(false)
    expect(context.context_meta.strategy).toBe('windowed')
    expect(context.context_meta.budget.exempt).toEqual([])
    expect(cp(context)).toBeLessThanOrEqual(6000)
    const window = context.context_meta.omitted.text
    expect(window?.total).toBe(200)
    expect(window!.shown).toBeGreaterThan(0)
    expect(window!.shown).toBeLessThan(200)
    // Whole paragraphs only: every kept paragraph is one of the originals.
    const kept = context.text.split('\n\n')
    expect(kept).toHaveLength(window!.shown)
    expect(kept[0]).toBe(`第1段：${'雨'.repeat(60)}`)
    expect(kept.at(-1)).toBe(`第${window!.shown}段：${'雨'.repeat(60)}`)
    const exportEntry = context.context_meta.fetch.find((entry) => entry.tool === 'novel_export')
    expect(exportEntry?.args).toMatchObject({ kind: 'md' })
  })

  it('keeps a short manuscript whole and reports no window', () => {
    const input = inputWith({ budget: 6000 })
    input.stage = 'P6'
    const context = briefContext(input) as { text: string; context_meta: { omitted: object } }
    expect(context.text).toBe(input.text)
    expect(context.context_meta.omitted).not.toHaveProperty('text')
  })
})

describe('0.2.20 WP1: clean text fixture is stable', () => {
  it('does not depend on wall-clock text generation', () => {
    expect(cleanText()).toContain('风从窗缝')
  })
})

/**
 * 0.2.20 review: "complete" used to mean "every row is here", not "every row is
 * whole".
 *
 * `chooseRows` rendered the clipped form of every row on every windowed block,
 * so a five-event summary reached the stage as two events, a four-name cast as
 * two names, and a 240-code-point foreshadow description as 80 plus an ellipsis
 * — while `context_meta` said `complete: true`, `omitted: {}` and `fetch: []`.
 * The stage cannot tell a truncated ledger from a short one, which is exactly
 * the failure the windowing contract exists to prevent.
 */
describe('0.2.20 review: a complete brief carries whole rows', () => {
  const EVENTS = ['收到无名信封', '拆开蜡印', '发现背面小字', '去码头找老周', '老周认出了蜡印']
  const NAMES = ['他', '老周', '阿敏', '巡警']

  const oneChapterBook = (overrides: Partial<BriefContextInput> = {}): BriefContextInput => {
    const input = inputWith({ stage: 'P1', chapter: 2, budget: 8000, ...overrides })
    input.chapters.chapters = [
      {
        num: 1,
        title: '第1章',
        file: 'chapters/chapter-001.md',
        word_count: 2000,
        dialogue_lines: 10,
        dialogue_ratio: 0.4,
        scene_type: '日常过渡章',
        narrator: '他',
        score: 130,
        status: 'reviewed',
        content_hash: 'h',
        summary: {
          events: EVENTS.slice(),
          characters_appeared: NAMES.slice(),
          foreshadows: { planted: [], advanced: [], resolved: [] },
          new_elements: { locations: [], abilities: [], artifacts: [] },
          resource_changes: [],
          opening: '风从窗缝里挤进来',
          continuity: { opens_from: '上一章结尾', ends_with: '蜡印' },
          hook_strength: 4,
          pleasure_points: ['新线索'],
          plot_advancement: 'mid',
        },
      },
    ]
    input.characters.characters = input.characters.characters.slice(0, 2)
    input.world.locations = input.world.locations.slice(0, 1)
    input.world.abilities = []
    input.world.artifacts = []
    input.world.factions = []
    input.world.rules = []
    input.locks.characters = {}
    input.locks.locations = {}
    input.timeline.items = input.timeline.items.slice(0, 2)
    input.foreshadows.items = input.foreshadows.items.slice(0, 1)
    input.relationships.items = input.relationships.items.slice(0, 1)
    return input
  }

  it('keeps all five events and all four names of a recent summary', () => {
    const context = briefContext(oneChapterBook()) as {
      recent_summaries: Array<{ events: string[]; characters_appeared: string[] }>
      context_meta: {
        complete: boolean
        omitted: Record<string, { total: number; shown: number; clipped?: number }>
        fetch: unknown[]
      }
    }
    expect(context.context_meta.complete).toBe(true)
    expect(context.context_meta.omitted).toEqual({})
    expect(context.context_meta.fetch).toEqual([])
    expect(context.recent_summaries).toHaveLength(1)
    expect(context.recent_summaries[0]!.events).toEqual(EVENTS)
    expect(context.recent_summaries[0]!.characters_appeared).toEqual(NAMES)
  })

  it('marks a block whose rows had to be shortened instead of claiming complete', () => {
    const long = '一枚暗红蜡印，'.repeat(500)
    const input = oneChapterBook({ budget: 5000 })
    input.chapters.chapters[0]!.summary.events = [long]
    const context = briefContext(input) as {
      recent_summaries: Array<{ events: string[] }>
      context_meta: {
        complete: boolean
        strategy: string
        omitted: Record<string, { total: number; shown: number; clipped?: number }>
        fetch: Array<{ tool: string; args: Record<string, unknown> }>
      }
    }
    const meta = context.context_meta
    expect(meta.complete, 'a shortened row is not a complete row').toBe(false)
    expect(meta.strategy).toBe('windowed')
    expect(meta.omitted.recent_summaries).toMatchObject({ total: 1, shown: 1, clipped: 1 })
    expect(meta.fetch.map((entry) => entry.args.kind)).toContain('chapters')
    // The row is still there and still recognizable, just not whole.
    expect(context.recent_summaries).toHaveLength(1)
    expect(Array.from(context.recent_summaries[0]!.events[0]!).length).toBeLessThan(Array.from(long).length)
  })
})
