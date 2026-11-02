import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { describe, expect, it, vi } from 'vitest'
import { applyStateDelta } from '../src/engine/state-delta.js'
import { briefContext } from '../src/engine/context.js'
import { evaluateGates } from '../src/engine/gates.js'
import { createNovelTools } from '../src/tools/index.js'
import { emptyPipeline } from '../src/engine/state.js'
import { loadRulepack } from '../src/rulepack.js'
import type { EngineService } from '../src/engine/service.js'
import type {
  CharactersDocument,
  ForeshadowsDocument,
  GateInput,
  LocksDocument,
  RelationshipsDocument,
  TimelineDocument,
  WorldDocument,
} from '../src/types.js'
import {
  archiveDelta,
  bootstrapToDraft,
  cleanText,
  harness,
  readyToArchive,
  sampleReview,
  sampleSemantic,
  sampleSummary,
  writeDraft,
} from './helpers.js'

/**
 * Regressions for the seven review findings the plan tracked as B13–B20.
 *
 * Each one is written to fail on the pre-fix behaviour: the assertion names the
 * exact value the old code produced (a hard-coded basis, a waived gate, a
 * "第 0 段" that cannot exist, a count with no rows behind it, a message that
 * points at the instance already signed off, a schema that forces an empty
 * 15-dimension array). A test that only re-reads the new field would pass
 * against both implementations.
 */

const rulepack = loadRulepack()
const gateOptions = { rulepack, minScore: 120 }

const characters = (): CharactersDocument => ({ schema_version: 1, characters: [] })
const world = (): WorldDocument => ({
  schema_version: 1,
  locations: [],
  abilities: [],
  artifacts: [],
  factions: [],
  rules: [],
})
const locks = (): LocksDocument => ({
  schema_version: 1,
  locked_at_chapter: 0,
  characters: {},
  locations: {},
})
const timeline = (): TimelineDocument => ({ schema_version: 1, next_seq: 1, items: [] })
const relationships = (): RelationshipsDocument => ({ schema_version: 1, next_seq: 1, items: [] })

const project = (): GateInput['project'] => ({
  schema_version: 1,
  title: '测试之书',
  genre: '都市现代',
  platform: 'fanqie',
  author: '',
  description: '',
  created_at: '2026-01-01',
  targets: { words_per_chapter: [80, 900], total_chapters: 10, dialogue_ratio: [0.1, 0.9] },
})

const gateInput = (patch: Partial<GateInput> = {}): GateInput => ({
  operation: 'submitDraft',
  stage: 'P3',
  text: cleanText(),
  chapter: 1,
  project: project(),
  pipeline: emptyPipeline({ revision: 1, chapter: 1, stage: 'P3' }),
  chapters: { schema_version: 1, chapters: [] },
  briefDigest: null,
  briefStage: null,
  draftTitle: '开端之雨',
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
  priorSceneTypes: ['日常过渡章', '日常过渡章'],
  ...patch,
})

const outline = (sceneType: '日常过渡章' | '战斗/动作章') => ({
  schema_version: 1 as const,
  updated_at: '2026-01-01',
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
  volumes: [],
  chapters: [
    {
      num: 1,
      volume: null,
      title: '开端之雨',
      scene_type: sceneType,
      goal: '',
      conflict: '',
      hook: '',
      cast: [],
      target_words: [80, 400] as [number, number],
      notes: '',
      status: 'planned' as const,
      archived_at: null,
      word_count: null,
      score: null,
    },
  ],
})

describe('0.2.14 audit III: read models must not contradict themselves', () => {
  it('B13 reports the same effort basis in review_basis and basis', async () => {
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      await h.engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root: h.root,
      })
      // A book whose journal was cleared (or truncated) still has every archived
      // chapter record, so the counts come from `ChapterRecord.rounds`. The old
      // read model hard-coded `committed_review_submissions` next to a `basis`
      // of `chapter_record` in the same object.
      await writeFile(join(h.root, 'state/journal.jsonl'), '', 'utf8')
      const report = await h.engine.report({ root: h.root })
      expect(report.data.effort.basis).toBe('chapter_record')
      expect(report.data.effort.review_basis).toBe('chapter_record')
      expect(report.data.effort.reviews).toBeGreaterThan(0)
    } finally {
      await h.cleanup()
    }
  })

  it('B14 only waives PG-06 when the card pins the submitted scene type', () => {
    const pinned = evaluateGates(gateInput({ outline: outline('日常过渡章') }), gateOptions)
    expect(pinned.blocking.some((item) => item.code === 'PG-06')).toBe(false)
    expect(pinned.warnings.map((warning) => warning.code)).toContain('PG-06_CARD_WINS')

    // The card exists but pins a different type. Waiving the gate here hid the
    // monotony the *submission* creates, and PG-13 reports the mismatch anyway.
    const mismatched = evaluateGates(gateInput({ outline: outline('战斗/动作章') }), gateOptions)
    expect(mismatched.blocking.some((item) => item.code === 'PG-06')).toBe(true)

    const bare = evaluateGates(gateInput(), gateOptions)
    expect(bare.blocking.some((item) => item.code === 'PG-06')).toBe(true)
  })

  it('B15 blames the required floor when the floor itself blows the budget', () => {
    const items: ForeshadowsDocument['items'] = Array.from({ length: 8 }, (_, index) => ({
      id: `FS-${String(index + 1).padStart(3, '0')}`,
      title: `伏笔${index + 1}`,
      planted: index + 1,
      last_touched: index + 1,
      status: 'planted' as const,
      resolved_at: null,
      // ~2k characters each: eight of them are ~16k against P1's 6k budget, and
      // the floor keeps all eight, so the pack cannot be trimmed under budget.
      description: '伏'.repeat(2000),
      advance_log: [],
    }))
    const context = briefContext({
      stage: 'P1',
      chapter: 9,
      project: project(),
      // P1 has no pipeline stage of its own: a fresh project sits at `idle`
      // until the world plan is submitted and P2 begins.
      pipeline: emptyPipeline({ revision: 1, chapter: 9, stage: 'idle' }),
      chapters: { schema_version: 1, chapters: [] },
      characters: characters(),
      world: world(),
      locks: locks(),
      foreshadows: { schema_version: 1, next_seq: 9, items },
      timeline: timeline(),
      relationships: relationships(),
      plan: null,
      review: null,
      check: null,
      text: null,
      previousText: null,
      handoff: null,
    })
    const meta = context.context_meta as {
      over_budget: boolean
      over_budget_reason: string | null
      required_omitted: number
      floor_kept: Record<string, number>
      protected: string[]
    }
    expect(meta.over_budget).toBe(true)
    expect(meta.required_omitted).toBe(0)
    expect(meta.floor_kept.open_foreshadows).toBe(8)
    // `open_foreshadows` is not a protected block: the eight-floor is. Saying
    // "protected_block" pointed the author at a list that was not the problem.
    expect(meta.protected).not.toContain('open_foreshadows')
    expect(meta.over_budget_reason).toBe('required_floor')
  })

  it('B16 keeps the archive when history/ cannot be staged, and says why', async () => {
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      // Four live receipts for one stage: three stay hot, one would move.
      const receiptPath = join(h.root, 'state/briefs.yaml')
      const receiptDoc = parse(await readFile(receiptPath, 'utf8')) as {
        receipts: Array<Record<string, unknown>>
      }
      for (let index = 0; index < 3; index += 1) {
        receiptDoc.receipts.push({
          chapter: 1,
          stage: 'P4',
          digest: `sha256:b16seed${index}`,
          issued_at: `2026-10-20T11:0${index}:00.000Z`,
        })
      }
      await writeFile(receiptPath, stringify(receiptDoc, { lineWidth: 0 }), 'utf8')
      // A regular file where the archive wants a directory. The old code only
      // fail-opened the read, so staging `history/briefs/ch001.yaml` died with
      // EEXIST and the whole archive aborted.
      await rm(join(h.root, 'history'), { recursive: true, force: true })
      await writeFile(join(h.root, 'history'), 'not a directory', 'utf8')
      const archived = await h.engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root: h.root,
      })
      const warning = archived.warnings.find((item) => item.code === 'BRIEF_RECEIPT_COMPACTION_FAILED')
      expect(warning?.message).toContain('history is a file')
      const chapters = await h.engine.queryState({ kind: 'chapters', root: h.root })
      expect((chapters.data as { chapters: unknown[] }).chapters).toHaveLength(1)
      // Nothing may be lost just because the archive could not be staged.
      const live = parse(await readFile(receiptPath, 'utf8')) as {
        receipts: Array<{ chapter: number; stage: string }>
      }
      expect(live.receipts.filter((row) => row.chapter === 1 && row.stage === 'P4')).toHaveLength(4)
      await expect(readFile(join(h.root, 'history/briefs/ch001.yaml'), 'utf8')).rejects.toThrow()
    } finally {
      await h.cleanup()
    }
  })

  it('B17 quotes document-level rules without inventing paragraph zero', () => {
    const text = `## 第一节\n\n${cleanText(3)}`
    const result = evaluateGates(gateInput({ text, draftTitle: '雨' }), gateOptions)
    const format = result.blocking.find((item) => item.code === 'PG-04')
    expect(format).toBeDefined()
    // Markdown always lands in a real paragraph, so it must be quotable.
    expect(format?.hint).toContain('near "')
    // TITLE_FORMAT has no paragraph at all. Rendering it as "第 0 段" pointed at
    // a place that cannot exist; "@第0段" is the same lie in shorter form.
    expect(format?.hint).toContain('TITLE_FORMAT')
    expect(format?.hint).not.toContain('第0段')
    expect(format?.hint).not.toContain('第 0 段')
  })

  it('B18 lists the dropped deductions when total is omitted', async () => {
    const h = await harness()
    try {
      const text = cleanText()
      await bootstrapToDraft({ root: h.root, engine: h.engine })
      await writeDraft({ root: h.root, engine: h.engine, text })
      await h.engine.getBrief({ stage: 'P4', root: h.root })
      const base = sampleReview(1, text)
      const dimensions = base.dimensions.map((dimension, index) =>
        index === 1
          ? {
              ...dimension,
              deductions: [
                { rule: 'META_NARRATION', location: '第 2 段', delta: 3, note: '叙述者插话' },
                { rule: 'LEX_ZERO_TOLERANCE', location: '第 2 段', delta: 2, note: '零容忍词' },
              ],
            }
          : dimension,
      )
      const review = await h.engine.submitReview({
        chapter: 1,
        dimensions,
        issues: [],
        proof: base.proof,
        root: h.root,
      })
      const warning = review.warnings.find((item) => item.code === 'SCORE_EXCLUSIONS')
      expect(warning).toBeDefined()
      // The rulepack drops one side of META_NARRATION / LEX_ZERO_TOLERANCE. A
      // bare count left the author unable to see which row went and why.
      expect(warning?.message).toContain('LEX_ZERO_TOLERANCE')
      expect(warning?.message).toContain('第 2 段')
      expect(warning?.message).toContain('exclusion:META_NARRATION|LEX_ZERO_TOLERANCE')
    } finally {
      await h.cleanup()
    }
  })

  it('B19 points an aggregated advisory at the instance still awaiting a decision', async () => {
    const h = await harness()
    try {
      // Two soft-limit hits in different paragraphs: one display row, two
      // instances. Both are advisories, so the check passes either way.
      const text = [
        '风从窗缝里挤进来，把桌上的纸吹得翻了一页，犹如覆着一层薄霜。',
        '走廊尽头传来脚步声，不快不慢，在门口停了两秒，犹如有人踮着脚。',
        '门被推开时带进一股凉气，来人把信封放在桌角，宛若在数着什么。',
        '信封没有署名，封口处压着一枚暗红的蜡印，宛若一枚旧纽扣。',
        '他盯着那枚蜡印看了很久，最后把信封翻过去。',
      ].join('\n\n')
      await bootstrapToDraft({ root: h.root, engine: h.engine })
      await writeDraft({ root: h.root, engine: h.engine, text })
      await h.engine.getBrief({ stage: 'P4', root: h.root })
      await h.engine.submitReview({ chapter: 1, ...sampleReview(1, text), root: h.root })
      await h.engine.getBrief({ stage: 'P6', root: h.root })
      // Content-only first: a full pass advances to P8 and a second check would
      // be a stage error rather than the regression under test.
      const first = await h.engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(text),
        scope: ['content'],
        root: h.root,
      })
      const instances = first.data.advisory_instances
        // `advisory_instances` carries the id, not a separate code field: the id
        // is `${code}:${location}:${hash}`.
        .filter((instance) => instance.id.startsWith('LEX_SOFT_LIMIT:'))
        .sort((left, right) => (left.location.paragraph ?? 0) - (right.location.paragraph ?? 0))
      expect(instances).toHaveLength(2)
      const [earlier, later] = instances
      expect(earlier?.location.paragraph).toBe(1)
      expect(later?.location.paragraph).toBe(3)
      // A check changes the P6 dependencies, so PG-01 requires a fresh brief
      // before the next run; acknowledging is part of the second run.
      await h.engine.getBrief({ stage: 'P6', root: h.root })
      const second = await h.engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(text),
        acknowledge: [earlier!.id],
        acknowledge_reasons: { [earlier!.id]: '这一处是刻意的重复' },
        root: h.root,
      })
      const warning = second.warnings.find((item) => item.code === 'LEX_SOFT_LIMIT')
      expect(warning).toBeDefined()
      // The row must describe the instance that still needs a decision, not the
      // one the author already signed off (it used to keep the first instance).
      expect(warning?.message).toContain('宛若')
      expect(warning?.message).toContain('paragraph 3')
      expect(warning?.message).not.toContain('犹如')
    } finally {
      await h.cleanup()
    }
  })

  it('B10 derives field and expected for every state_delta failure that has no explicit details', () => {
    const docs = {
      characters: { schema_version: 1, characters: [] },
      world: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
      locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 2, items: [] },
    }
    const sections = (characters: Record<string, unknown>): Record<string, unknown> => ({
      characters,
      world: {},
      foreshadows: {},
      timeline: {},
      relationships: {},
    })
    const cases: Array<{ name: string; delta: Record<string, unknown>; summary?: object; field: string }> = [
      {
        name: 'unknown action',
        delta: sections({ 他: { action: 'sideways' } }),
        field: 'characters.他',
      },
      {
        name: 'no_change without a reason',
        delta: sections({ 他: { action: 'no_change', reason: '' } }),
        field: 'characters.他',
      },
      {
        name: 'unknown entry key',
        delta: sections({ 他: { action: 'created', role: 'supporting', profile: {}, name: '他', bogus: 1 } }),
        field: 'characters.他',
      },
      {
        name: 'summary block of the wrong shape',
        delta: sections({ 他: { action: 'no_change', reason: '在场' } }),
        summary: { new_elements: 'oops' },
        field: 'summary.new_elements',
      },
    ]
    let derived = 0
    for (const item of cases) {
      let error: unknown
      try {
        applyStateDelta({
          chapter: 1,
          text: '他站在门口，风从窗缝里挤进来，吹得纸页翻了一动。',
          summary: sampleSummary({ characters_appeared: ['他'], events: [], ...(item.summary ?? {}) }),
          delta: item.delta as never,
          ...docs,
        } as never)
      } catch (caught) {
        error = caught
      }
      // Half of the ~30 `fail()` sites passed no details, so the model got prose
      // with no field to fix. Every one of them must now name a field; where the
      // site already had explicit details the fallback must stay out of the way.
      expect(error, item.name).toMatchObject({ code: 'ENGINE_DELTA_UNVERIFIED' })
      const details = (error as { details?: { field?: string; expected?: string; derived?: boolean } })
        .details
      // Explicit details may name the exact member (`characters.他.action`);
      // the derived fallback names the entry. Both must point inside the entry.
      expect(details?.field, item.name).toContain(item.field)
      expect(typeof details?.expected, item.name).toBe('string')
      if (details?.derived === true) derived += 1
    }
    expect(derived).toBeGreaterThan(0)
  })

  it('B5 names every mutable target when it refuses an immutable one', async () => {
    const h = await harness()
    try {
      await bootstrapToDraft({ root: h.root, engine: h.engine })
      const novel = parse(await readFile(join(h.root, 'novel.yaml'), 'utf8')) as Record<string, unknown>
      let error: unknown
      try {
        await h.engine.amend({
          path: 'novel.yaml',
          // Project amend is field-level; only the mutable targets may be sent.
          content: {
            targets: { ...(novel.targets as Record<string, unknown>), words_per_chapter: [100, 200] },
          },
          reason: 'try to change the chapter length',
          root: h.root,
        })
      } catch (caught) {
        error = caught
      }
      const message = (error as Error).message
      // The old text said "only total_chapters may change", contradicting the
      // three other mutable keys the same function accepts.
      expect(message).not.toContain('only total_chapters')
      for (const field of [
        'total_chapters',
        'min_cjk_chars',
        'dialogue_ratio_metric',
        'allow_negative_balances',
      ]) {
        expect(message, field).toContain(field)
      }
    } finally {
      await h.cleanup()
    }
  })

  it('B6 advertises the seven ledger restores at the tool surface', () => {
    const tools = new Map(
      createNovelTools({
        withSignal: vi.fn(async (_signal: unknown, task: () => Promise<unknown>) => task()),
      } as unknown as EngineService).map((tool) => [tool.name, tool]),
    )
    const restore = tools.get('novel_restore')!
    // A capability only the implementation knows is a capability the model will
    // not use: the description used to stop at chapter/outline/pipeline.
    expect(restore.description).toContain('seven state ledgers')
    for (const ledger of [
      'characters',
      'world',
      'locks',
      'timeline',
      'foreshadows',
      'relationships',
      'handoff',
    ]) {
      expect(restore.description, ledger).toContain(ledger)
    }
    const paths = (restore.parameters as { properties?: { paths?: { description?: string } } }).properties
      ?.paths?.description
    for (const ledger of [
      'state/characters.yaml',
      'state/world.yaml',
      'state/locks.yaml',
      'state/timeline.yaml',
      'state/foreshadows.yaml',
      'state/relationships.yaml',
      'state/handoff.yaml',
    ]) {
      expect(paths, ledger).toContain(ledger)
    }
  })

  it('B20 does not require fifteen dimensions to amend an existing review', async () => {
    const submitReview = vi.fn(async () => ({
      data: { chapter: 1, round: 1, total: 150 },
      revision: 1,
      warnings: [],
    }))
    const tools = new Map(
      createNovelTools({
        withSignal: vi.fn(async (_signal: unknown, task: () => Promise<unknown>) => task()),
        submitReview,
      } as unknown as EngineService).map((tool) => [tool.name, tool]),
    )
    const review = tools.get('novel_review')!
    const required = (review.parameters as { required?: string[] }).required ?? []
    expect(required).not.toContain('dimensions')
    await review.execute(
      {
        chapter: 1,
        amend_issues: [{ id: 'REV-001', status: 'fixed' }],
        project_root: '/tmp/nowhere',
      } as never,
      {} as never,
    )
    expect(submitReview).toHaveBeenCalledWith(
      expect.objectContaining({
        chapter: 1,
        amend_issues: [{ id: 'REV-001', status: 'fixed' }],
      }),
    )
  })
})
