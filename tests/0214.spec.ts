import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import { applyStateDelta, type DeltaInput } from '../src/engine/state-delta.js'
import { briefContext } from '../src/engine/context.js'
import { evaluateGates } from '../src/engine/gates.js'
import { dedupeAdvisories, runMachineChecks } from '../src/rules/pipeline.js'
import { loadRulepack } from '../src/rulepack.js'
import { emptyPipeline } from '../src/engine/state.js'
import { matchEvidence } from '../src/domain/text.js'
import { checkReference } from '../src/engine/gates.js'
import {
  archiveDelta,
  cleanText,
  harness,
  readyToArchive,
  sampleReview,
  sampleSemantic,
  sampleSummary,
} from './helpers.js'
import type {
  ChapterSummary,
  CharactersDocument,
  ForeshadowsDocument,
  GateInput,
  LocksDocument,
  RelationshipsDocument,
  TimelineDocument,
  WorldDocument,
} from '../src/types.js'

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
const foreshadows = (): ForeshadowsDocument => ({ schema_version: 1, next_seq: 1, items: [] })
const timeline = (): TimelineDocument => ({ schema_version: 1, next_seq: 1, items: [] })
const relationships = (): RelationshipsDocument => ({ schema_version: 1, next_seq: 1, items: [] })

const deltaInput = (patch: Partial<DeltaInput> = {}): DeltaInput => ({
  chapter: 2,
  text: '他把钱收进袋里，数了两遍。',
  summary: sampleSummary(),
  delta: {
    characters: {},
    foreshadows: {},
    timeline: { '0': { action: 'created' } },
    world: {},
    relationships: {},
  },
  characters: characters(),
  world: world(),
  locks: locks(),
  foreshadows: foreshadows(),
  timeline: timeline(),
  relationships: relationships(),
  ...patch,
})

describe('0.2.14 resource and scalar write semantics', () => {
  it('refuses the same resource through the set and add channels', () => {
    const summary = sampleSummary({ characters_appeared: ['他'] })
    const delta = deltaInput({
      summary,
      delta: {
        characters: { 他: { action: 'created', current_state: { resources: { 钱: 10 } } } },
        foreshadows: {},
        timeline: { '0': { action: 'created' } },
        world: {},
        relationships: {},
      },
      ...(summary.resource_changes.length === 0
        ? {
            summary: {
              ...summary,
              resource_changes: [{ character: '他', resource: '钱', delta: -2, reason: '买米' }],
            },
          }
        : {}),
    })
    expect(() => applyStateDelta(delta)).toThrowError(
      expect.objectContaining({ code: 'ENGINE_RESOURCE_DOUBLE_COUNT' }),
    )
  })

  it('names original, delta and result when a balance would go negative', () => {
    const summary = sampleSummary({
      characters_appeared: ['他'],
      resource_changes: [{ character: '他', resource: '钱', delta: -5, reason: '买米' }],
    })
    const existing = characters()
    existing.characters.push({
      name: '他',
      role: 'protagonist',
      first_appearance: 1,
      profile: {},
      current_state: { resources: { 钱: 3 } },
      growth: [],
      updated_at: 1,
    })
    let error: unknown
    try {
      applyStateDelta(
        deltaInput({
          summary,
          characters: existing,
          delta: {
            characters: { 他: { action: 'updated' } },
            foreshadows: {},
            timeline: { '0': { action: 'created' } },
            world: {},
            relationships: {},
          },
        }),
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'ENGINE_RESOURCE_NEGATIVE_BALANCE' })
    expect((error as Error).message).toContain('original 3')
    expect((error as Error).message).toContain('-5')
    expect((error as Error).message).toContain('result -2')
  })

  it('allows debt only when the project asks for it', () => {
    const summary = sampleSummary({
      characters_appeared: ['他'],
      resource_changes: [{ character: '他', resource: '钱', delta: -5, reason: '欠账' }],
    })
    const delta = deltaInput({
      summary,
      allowNegativeBalances: true,
      delta: {
        characters: { 他: { action: 'created' } },
        foreshadows: {},
        timeline: { '0': { action: 'created' } },
        world: {},
        relationships: {},
      },
    })
    const result = applyStateDelta(delta)
    expect(result.characters.characters[0]!.current_state.resources).toEqual({ 钱: -5 })
  })

  it('clears a stale scalar with unset and refuses no_change writes', () => {
    const existing = characters()
    existing.characters.push({
      name: '他',
      role: 'protagonist',
      first_appearance: 1,
      profile: {},
      current_state: { deadline: '1971-03-01', mood: 'calm' },
      growth: [],
      updated_at: 1,
    })
    const summary = sampleSummary({ characters_appeared: ['他'] })
    const result = applyStateDelta(
      deltaInput({
        summary,
        characters: existing,
        delta: {
          characters: { 他: { action: 'updated', unset: ['deadline'] } },
          foreshadows: {},
          timeline: { '0': { action: 'created' } },
          world: {},
          relationships: {},
        },
      }),
    )
    expect(result.characters.characters[0]!.current_state).toEqual({ mood: 'calm' })
    expect(() =>
      applyStateDelta(
        deltaInput({
          summary,
          characters: existing,
          delta: {
            characters: { 他: { action: 'no_change', reason: '无变化', current_state: { mood: 'x' } } },
            foreshadows: {},
            timeline: { '0': { action: 'created' } },
            world: {},
            relationships: {},
          },
        }),
      ),
    ).toThrowError(/no_change accepts only role/)
  })

  it('refuses an unknown delta key with the allowed list instead of dropping it', () => {
    let error: unknown
    try {
      applyStateDelta(
        deltaInput({
          delta: {
            characters: { 他: { action: 'created', resolved: true } as never },
            foreshadows: {},
            timeline: { '0': { action: 'created' } },
            world: {},
            relationships: {},
          },
        }),
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'ENGINE_DELTA_UNVERIFIED' })
    const details = (error as { details?: { allowed?: string[]; received?: unknown } }).details
    expect(details?.allowed).toContain('action')
    expect(details?.received).toBe(true)
  })

  it('names the field, the expected shape and the received type for a non-object current_state', () => {
    let error: unknown
    try {
      applyStateDelta(
        deltaInput({
          delta: {
            characters: { 他: { action: 'updated', current_state: [] as never } },
            foreshadows: {},
            timeline: { '0': { action: 'created' } },
            world: {},
            relationships: {},
          },
        }),
      )
    } catch (caught) {
      error = caught
    }
    expect((error as { details?: unknown }).details).toMatchObject({
      field: 'characters.他.current_state',
      expected: 'object',
      received_type: 'array',
    })
  })

  it('refuses a strict plot foreshadow without a planned payoff', () => {
    const summary = sampleSummary({
      characters_appeared: [],
      foreshadows: {
        planted: [{ key: 'FS-A', title: '旧钥匙', description: '一把打不开的钥匙' }],
        advanced: [],
        resolved: [],
      },
    })
    expect(() =>
      applyStateDelta(
        deltaInput({
          summary,
          strict: true,
          delta: {
            characters: {},
            foreshadows: { 'FS-A': { action: 'created', anchor: '他把钱收进袋里，数了两遍。' } },
            timeline: {},
            world: {},
            relationships: {},
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'ENGINE_FORESHADOW_UNPLANNED' }))
  })
})

describe('0.2.14 diagnostics and evidence', () => {
  it('matches quotes across curly quotes and line breaks, and reports the nearest paragraph', () => {
    const text = '第一段有风。\n\n他说：「你走」。\n\n第三段没有。'
    expect(matchEvidence(text, '「你走」').found).toBe(true)
    const missing = matchEvidence(text, '他说明天再来找你')
    expect(missing.found).toBe(false)
    expect(missing.nearest?.paragraph).toBe(2)
  })

  it('accepts an eight-character Chinese reading-proof quote', () => {
    const text =
      '风从窗缝里挤进来，把桌上一盏灯吹得发晃。\n\n他拆开信封，读到第三行才停。\n\n窗外天色暗下来。'
    const check = checkReference(text, { paragraph: 1, quote: '风从窗缝里挤进来' })
    expect(check.problem).toBeNull()
  })

  it('reports the real paragraph when the submitted locator is off by more than one', () => {
    const text = '甲段。\n\n乙段。\n\n丙段。\n\n丁段。\n\n戊段，风从窗缝里挤进来。'
    const check = checkReference(text, { paragraph: 1, quote: '风从窗缝里挤进来' })
    expect(check.problem).toContain('paragraph 5')
    expect(check.actual).toBe(5)
  })

  it('aggregates advisories by code while keeping per-instance acknowledgements', () => {
    const aggregated = dedupeAdvisories([
      { code: 'LOCKED_DETAIL_DRIFT', severity: 'advisory', location: { paragraph: 2 }, detail: 'A' },
      { code: 'LOCKED_DETAIL_DRIFT', severity: 'advisory', location: { paragraph: 5 }, detail: 'B' },
    ])
    expect(aggregated).toHaveLength(1)
    expect(aggregated[0]!.instances).toHaveLength(2)
    expect(new Set(aggregated[0]!.instances!.map((instance) => instance.id)).size).toBe(2)
  })

  it('locates a ledger advisory on the row, not on paragraph 1', () => {
    const ledger = foreshadows()
    ledger.items.push({
      id: 'FS-001',
      title: '旧钥匙',
      planted: 1,
      last_touched: 1,
      status: 'planted',
      resolved_at: null,
      description: '',
      advance_log: [],
    })
    const result = runMachineChecks('与伏笔无关的正文。', {
      chapter: 30,
      title: null,
      genre: '都市现代',
      sceneType: '日常过渡章',
      rulepack,
      summary: null,
      evidence: {
        characters: null,
        previousText: null,
        previousTexts: [],
        foreshadows: ledger,
        timeline: null,
        relationships: null,
        world: null,
        locks: null,
      },
    })
    const dormant = result.violations.find((violation) => violation.code === 'FORESHADOW_DORMANT')
    expect(dormant?.location).toEqual({ ledger: 'foreshadows', entity: 'FS-001' })
  })
})

describe('0.2.14 brief lifecycle and budget floors', () => {
  it('keeps every open foreshadow, not a floor of eight', () => {
    const items = Array.from({ length: 60 }, (_, index) => ({
      id: `FS-${String(index + 1).padStart(3, '0')}`,
      title: `伏笔${index + 1}`,
      planted: index + 1,
      last_touched: index + 1,
      status: 'planted' as const,
      resolved_at: null,
      description: `伏笔描述 ${index + 1}`,
      advance_log: [],
    }))
    const context = briefContext({
      stage: 'P2',
      chapter: 60,
      project: {
        schema_version: 1,
        title: '长书',
        genre: '都市现代',
        platform: 'fanqie',
        author: '',
        description: '',
        created_at: '2026-01-01',
        targets: { words_per_chapter: [2000, 3000], total_chapters: 200, dialogue_ratio: [0.4, 0.6] },
      },
      pipeline: emptyPipeline({ revision: 1, chapter: 60, stage: 'idle' }),
      chapters: { schema_version: 1, chapters: [] },
      characters: characters(),
      world: world(),
      locks: locks(),
      foreshadows: { schema_version: 1, next_seq: 61, items },
      timeline: timeline(),
      relationships: relationships(),
      plan: {
        chapter: 60,
        title: '长夜',
        scene_type: '日常过渡章',
        narrator: '他',
        beats: Array.from(
          { length: 400 },
          (_, index) => `第 ${index + 1} 个节拍：他把信收好，又数了一遍钱。`,
        ),
        opening: '开场',
        ending: '收束',
        target_words: [2000, 3000],
      },
      review: null,
      check: null,
      text: null,
      previousText: null,
      handoff: null,
    })
    // 0.2.17 removed the budget: all sixty open foreshadows arrive, not the
    // eight the old floor guaranteed.
    expect((context.open_foreshadows as unknown[]).length).toBe(60)
    expect((context.context_meta as { complete: boolean }).complete).toBe(true)
  })

  it('signs P8 against its own dependencies, not the whole world ledger', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const worldText = await readFile(join(root, 'state/world.yaml'), 'utf8')
      // A world-only edit must not invalidate a P8 brief that never shows it.
      await engine.amend({
        path: 'state/world.yaml',
        content: { ...parse(worldText), rules: [{ name: '新规则', description: '世界规则' }] },
        reason: 'add a world rule',
        root,
      })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const chapters = await engine.queryState({ kind: 'chapters', root })
      expect((chapters.data as { chapters: unknown[] }).chapters).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })

  it('keeps exactly one current receipt per chapter and stage after archive', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const live = parse(await readFile(join(root, 'state/briefs.yaml'), 'utf8')) as {
        receipts: Array<{ chapter: number; stage: string; current?: boolean }>
      }
      // The previous body asserted `all.length >= live.length` and
      // `text.length > 0`: both were true no matter what the archive wrote.
      // The real invariant is that "current" identifies exactly one row per
      // group; a compaction that drops the current row or keeps two of them
      // changes what PG-01 replays (R10).
      const keys = (rows: Array<{ chapter: number; stage: string }>): string =>
        rows
          .map((row) => `${row.chapter}:${row.stage}`)
          .sort()
          .join(',')
      const groups = new Set(live.receipts.map((row) => `${row.chapter}:${row.stage}`))
      const current = live.receipts.filter((row) => row.current === true)
      expect(new Set(current.map((row) => `${row.chapter}:${row.stage}`)).size).toBe(groups.size)
      expect(current.length).toBe(groups.size)
      expect(keys(current)).toBe(keys(live.receipts))
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.14 amend, restore and review correction', () => {
  it('applies a local patch and returns before/after', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const before = (await engine.queryState({ kind: 'worldbook', root })).data as Record<string, unknown>
      const result = await engine.amend({
        path: 'outline/worldbook.yaml',
        patch: [{ op: 'replace', path: 'premise', value: '一句新的前提' }],
        reason: 'patch premise',
        root,
      })
      expect(result.data.after.premise).toBe('一句新的前提')
      expect(result.data.before).toMatchObject(before)
      expect(result.data.changes).toContainEqual({
        path: 'premise',
        before: before.premise,
        after: '一句新的前提',
      })
    } finally {
      await cleanup()
    }
  })

  it('refuses a truncated ledger unless the deletion is explicit', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const seeded = parse(await readFile(join(root, 'state/foreshadows.yaml'), 'utf8')) as {
        next_seq: number
        items: unknown[]
      }
      seeded.items.push({
        id: 'FS-001',
        title: '旧钥匙',
        planted: 1,
        last_touched: 1,
        status: 'planted',
        resolved_at: null,
        description: '旧钥匙',
        advance_log: [],
      })
      seeded.next_seq = 2
      await engine.amend({
        path: 'state/foreshadows.yaml',
        content: seeded,
        reason: 'seed a foreshadow row',
        root,
      })
      const before = seeded
      await expect(
        engine.amend({
          path: 'state/foreshadows.yaml',
          content: { schema_version: 1, next_seq: before.next_seq, items: [] },
          reason: 'truncate by mistake',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({
          path: 'state/foreshadows.yaml',
          content: { schema_version: 1, next_seq: before.next_seq, items: [] },
          allow_delete: true,
          reason: 'intentional truncation',
          root,
        }),
      ).resolves.toMatchObject({ data: { path: 'state/foreshadows.yaml' } })
    } finally {
      await cleanup()
    }
  })

  it('restores a ledger from its pre-image', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const original = await readFile(join(root, 'state/foreshadows.yaml'), 'utf8')
      const before = parse(original) as Record<string, unknown>
      const items = before.items as Array<Record<string, unknown>>
      await engine.amend({
        path: 'state/foreshadows.yaml',
        content: {
          ...before,
          items: items.map((item) => ({ ...item, title: `${String(item.title)}（改）` })),
        },
        reason: 'edit a title',
        root,
      })
      const backups = (await engine.queryState({ kind: 'backups', root })).data as {
        backups: Array<{ txid?: string; name: string; files: string[] }>
      }
      const entry = backups.backups.find((row) => row.files.includes('state/foreshadows.yaml'))!
      const txid = entry.txid ?? entry.name
      const restored = await engine.restoreBackup({ txid, paths: ['state/foreshadows.yaml'], root })
      expect(restored.data.restored).toEqual(['state/foreshadows.yaml'])
      expect(await readFile(join(root, 'state/foreshadows.yaml'), 'utf8')).toBe(original)
    } finally {
      await cleanup()
    }
  })

  it('corrects review metadata without consuming a review round', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = cleanText()
      await readyToArchive({
        root,
        engine,
        text,
        // A review with no findings made amend_issues untestable; the old body
        // skipped its own assertions when the list was empty (R10).
        issues: [
          {
            id: 'REV-001',
            severity: 'advisory',
            dimension: 'R-W-01',
            location: '第 2 段',
            problem: '动作缺少动机',
            fix: '补一句他为什么停下',
            status: 'open',
          },
        ],
      })
      const before = await engine.getStatus({ root })
      const result = await engine
        .submitReview({
          chapter: 1,
          amend_issues: [{ id: 'REV-NONE', status: 'fixed' }],
          root,
        })
        .catch((error: unknown) => error)
      expect(result).toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const review = (await engine.queryState({ kind: 'review', root })).data as {
        issues: Array<{ id: string }>
      }
      // The conditional skip was the assertion: with no issues the test still
      // passed while proving nothing (R10).
      expect(review.issues.length).toBeGreaterThan(0)
      const id = review.issues[0]!.id
      const amended = await engine.submitReview({
        chapter: 1,
        amend_issues: [{ id, status: 'fixed', problem: '改写后的问题描述' }],
        root,
      })
      expect(amended.data.rounds?.review).toBe(before.data.rounds.review)
      expect((await engine.getStatus({ root })).data.rounds.review).toBe(before.data.rounds.review)
      const after = (await engine.queryState({ kind: 'review', root })).data as {
        issues: Array<{ id: string; status: string; problem: string }>
      }
      expect(after.issues.find((issue) => issue.id === id)?.status).toBe('fixed')
    } finally {
      await cleanup()
    }
  })

  it('suppresses an identical doctor warning after baseline and restores it on reset', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      // Distinct prose per chapter: identical text would be a legitimate
      // DUPLICATE_PARAGRAPH blocker and this test is about doctor warnings.
      const banks = [
        { place: '骑楼', object: '湿伞', act: '数铜板', sound: '叫卖声' },
        { place: '码头', object: '货箱', act: '抄货单', sound: '汽笛' },
        { place: '天井', object: '灯芯', act: '补账页', sound: '咳嗽声' },
      ]
      const chapterProse = (index: number): string => {
        const bank = banks[index]!
        return Array.from({ length: 8 }, (_, row) =>
          row === 0
            ? `风从窗缝里挤进来，把桌上${bank.place}的${bank.object}吹得发晃，他伸手按住，又继续${bank.act}。`
            : `${bank.place}的第${row}段里，他把${bank.object}挪到一边，重新${bank.act}。${bank.sound}从巷口传过来，灯影在墙上晃了一下。`,
        ).join('\n\n')
      }
      const texts = banks.map((_, index) => chapterProse(index))
      const scenes = ['日常过渡章', '纯叙事章', '情感爆发章'] as const
      await readyToArchive({ root, engine, text: texts[0]! })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      for (const index of [1, 2]) {
        const text = texts[index]!
        const chapter = index + 1
        const scene = scenes[index]!
        await engine.getBrief({ stage: 'P1', root })
        await engine.submitWorldPlan({
          chapter: 0,
          objective: `第 ${chapter} 章目标`,
          constraints: [],
          characters: [],
          locations: [],
          continuity_notes: [],
          root,
        })
        await engine.getBrief({ stage: 'P2', root })
        await engine.submitChapterPlan({
          chapter: 0,
          title: ['开端之雨', '第二场雨', '第三场雨'][index]!,
          scene_type: scene,
          narrator: '他',
          beats: ['起', '承', '转', '合', '收'],
          opening: '风从窗缝里挤进来，把桌上',
          ending: '灯座底下',
          target_words: [80, 400],
          root,
        })
        await engine.getBrief({ stage: 'P3', root })
        await engine.submitDraft({
          chapter,
          content: text,
          chapter_title: ['开端之雨', '第二场雨', '第三场雨'][index]!,
          scene_type: scene,
          narrator: '他',
          summary: sampleSummary(),
          root,
        })
        await engine.getBrief({ stage: 'P4', root })
        await engine.submitReview({ chapter, ...sampleReview(chapter, text), root })
        await engine.getBrief({ stage: 'P6', root })
        await engine.runCheck({ chapter, semantic: sampleSemantic(text), root })
        await engine.getBrief({ stage: 'P8', root })
        await engine.archiveChapter({
          chapter,
          state_delta: archiveDelta(sampleSummary(), { existing: ['他'] }),
          root,
        })
      }
      // A real target with three archived chapters turns planning coverage
      // into a persistent warning.
      const novel = parse(await readFile(join(root, 'novel.yaml'), 'utf8')) as Record<string, unknown>
      await engine.amend({
        path: 'novel.yaml',
        // Project amend is field-level: only mutable fields may be sent.
        content: {
          targets: { ...(novel.targets as Record<string, unknown>), total_chapters: 10 },
        },
        reason: 'set a ten chapter target',
        root,
      })
      const before = await engine.doctor({ root })
      expect(before.data.checks).toContainEqual(
        expect.objectContaining({ id: 'outline-coverage', severity: 'warning' }),
      )
      await engine.doctor({ baseline: true, root })
      const after = await engine.doctor({ root })
      expect(after.data.checks).not.toContainEqual(expect.objectContaining({ id: 'outline-coverage' }))
      await engine.doctor({ reset: true, root })
      const reset = await engine.doctor({ root })
      expect(reset.data.checks).toContainEqual(
        expect.objectContaining({ id: 'outline-coverage', severity: 'warning' }),
      )
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.14 gates and counts', () => {
  const gateInput = (patch: Partial<GateInput> = {}): GateInput => ({
    operation: 'submitDraft',
    stage: 'P3',
    text: cleanText(),
    chapter: 1,
    project: {
      schema_version: 1,
      title: '测试',
      genre: '都市现代',
      platform: 'fanqie',
      author: '',
      description: '',
      created_at: '2026-01-01',
      targets: { words_per_chapter: [80, 400], total_chapters: 10, dialogue_ratio: [0.1, 0.9] },
    },
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

  it('lets an outline card win over the PG-06 monotony block and reports a warning', () => {
    const outline = {
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
          scene_type: '日常过渡章' as const,
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
    }
    const result = evaluateGates(gateInput({ outline }), gateOptions)
    expect(result.blocking.some((item) => item.code === 'PG-06')).toBe(false)
    expect(result.warnings.map((warning) => warning.code)).toContain('PG-06_CARD_WINS')
    const noCard = evaluateGates(gateInput(), gateOptions)
    expect(noCard.blocking.some((item) => item.code === 'PG-06')).toBe(true)
  })

  it('keeps effort.reviews and quality.attempts at the same number', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      // One typed, one legacy row: `toBeDefined()` passed for any number, and
      // coverage read 1 only because the ledger was empty (R10). A legacy row
      // cannot be written through amend any more (new rows need type_code), so
      // the fixture is a real pre-0.2.13 file.
      await writeFile(
        join(root, 'state/relationships.yaml'),
        stringify({
          schema_version: 1,
          next_seq: 3,
          items: [
            {
              id: 'RL-001',
              a: '他',
              b: '她',
              type: '朋友',
              type_code: 'ally',
              since: 1,
              description: '旧识',
              evolution: [],
            },
            {
              id: 'RL-002',
              a: '他',
              b: '老周',
              type: '雇主',
              since: 1,
              description: '雇主',
              evolution: [],
            },
          ],
        }),
        'utf8',
      )
      const report = (await engine.report({ root })).data
      expect(report.effort.reviews).toBe(report.quality.attempts)
      expect(report.effort.basis).toBe('committed_journal')
      expect(report.relationships.total).toBe(2)
      expect(report.relationships.classified).toBe(1)
      expect(report.relationships.uncategorized).toBe(1)
      expect(report.relationships.coverage).toBe(0.5)
    } finally {
      await cleanup()
    }
  })

  it('explains unused numeric facts instead of printing 0/0 as a pass', () => {
    const summary: ChapterSummary = sampleSummary()
    const result = runMachineChecks('正文里没有任何数字声明。', {
      chapter: 1,
      title: null,
      genre: '都市现代',
      sceneType: '日常过渡章',
      rulepack,
      summary,
      facts: [{ alias: '船价', value: 300, unit: '块' }],
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
    })
    expect(result.numeric.facts_unused).toBe(1)
    expect(result.violations.map((violation) => violation.code)).toContain('NUMERIC_FACTS_UNUSED')
  })

  it('shows which dialogue measure is out instead of saying nothing', () => {
    // Many short quoted lines plus one long narration block: the line ratio is
    // far out of range while the character ratio stays inside it, which is the
    // only way `skewed` is reachable and the reason a single ratio was wrong.
    const dialogue = '"嗯。"\n'.repeat(20)
    const narration = `他走过长街，看见灯一盏一盏亮起来，接着又拐进巷子，数着门牌。${'远处有人收摊，铁皮卷帘门哗啦一声落下。'.repeat(2)}`
    const text = `${dialogue}${narration}`
    const result = runMachineChecks(text, {
      chapter: 1,
      title: null,
      genre: '都市现代',
      sceneType: '日常过渡章',
      rulepack,
      summary: sampleSummary(),
      targets: { words_per_chapter: [80, 900], dialogue_ratio: [0.2, 0.4], dialogue_ratio_metric: 'both' },
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
    })
    // A regex that accepts every verdict proved nothing (R10).
    expect(result.dialogue?.verdict).toBe('skewed')
    expect(result.dialogue?.line_ratio).toBeGreaterThan(0.4)
    expect(result.dialogue?.char_ratio).toBeLessThanOrEqual(0.4)
  })

  it('does not let an 11-word sample review fake the fifteen dimensions', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = cleanText()
      await readyToArchive({ root, engine, text })
      const status = await engine.getStatus({ root })
      expect(status.data.target_words?.includes_punctuation).toBe(true)
      expect(sampleReview(1, text).dimensions).toHaveLength(15)
      expect(sampleSemantic(text)).toHaveLength(5)
    } finally {
      await cleanup()
    }
  })
})
