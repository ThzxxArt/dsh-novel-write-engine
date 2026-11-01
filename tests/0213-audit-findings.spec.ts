import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { describe, expect, it, vi } from 'vitest'
import { createNovelTools, emptySummary } from '../src/tools/index.js'
import { sha256Hex } from '../src/domain/hash.js'
import { resolveLockBaseline } from '../src/engine/entity-anchors.js'
import { eventKeyFor } from '../src/engine/state-delta.js'
import { EngineService } from '../src/engine/service.js'
import { loadRulepack } from '../src/rulepack.js'
import { compileRulepack } from '../src/rules/compiler.js'
import { runMachineChecks, type MachineOptions } from '../src/rules/pipeline.js'
import {
  archiveDelta,
  bootstrapToDraft,
  cleanText,
  FIXED_NOW,
  harness,
  readyToArchive,
  sampleReview,
  sampleSemantic,
  sampleSummary,
  TEST_CONFIG,
  writeDraft,
} from './helpers.js'
import type { ForeshadowsDocument } from '../src/types.js'

const rulepack = loadRulepack()

const options = (overrides: Partial<MachineOptions> = {}): MachineOptions => ({
  chapter: 1,
  title: '第1章 开端',
  genre: '都市现代',
  sceneType: '日常过渡章',
  rulepack,
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

describe('0.2.13 post-implementation audit findings', () => {
  it('has a pure SHA-256 matching the standard vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('does not use a first-appearance lock when the worldbook character has no appearance', () => {
    const worldbook = {
      schema_version: 1,
      updated_at: '',
      premise: '',
      setting: '',
      rules: [],
      factions: [],
      locations: [],
      characters: [{ name: '乙', role: 'supporting', description: '一段没有外貌的传记。', arc: '' }],
      glossary: [],
      backstory: [],
      themes: [],
    } as never
    const locks = {
      schema_version: 1,
      locked_at_chapter: 1,
      characters: {
        乙: {
          first_appearance: 1,
          locked_at: 1,
          appearance: '瘦高个，左眉有一道旧疤，总穿灰布衫。',
        },
      },
      locations: {},
    } as never
    expect(resolveLockBaseline('乙', 'character', { worldbook, locks })).toBeNull()
    expect(resolveLockBaseline('乙', 'character', { locks })).not.toBeNull()
  })

  it('keeps the worldbook source when world anchors are appended to it', () => {
    const worldbook = {
      schema_version: 1,
      updated_at: '',
      premise: '',
      setting: '',
      rules: [],
      factions: [],
      locations: [{ name: '旧屋', description: '门口有一棵榕树。', layout: '三进深。', capacity: 4 }],
      characters: [],
      glossary: [],
      backstory: [],
      themes: [],
    } as never
    const world = {
      schema_version: 1,
      locations: [
        {
          name: '旧屋',
          anchors: ['榕树的树根拱起'],
          first_appearance: 1,
          locked: true,
          description: '',
          layout: '',
          capacity: 0,
          changes: [],
        },
      ],
      abilities: [],
      artifacts: [],
      factions: [],
      rules: [],
    } as never
    const baseline = resolveLockBaseline('旧屋', 'location', { worldbook, world })
    expect(baseline?.source).toBe('worldbook')
    expect(baseline?.texts).toContain('榕树的树根拱起')
  })

  it('checks a location baseline supplied only by world anchors', () => {
    const world = {
      schema_version: 1,
      locations: [
        {
          name: '旧屋',
          anchors: ['门口有一棵榕树，树根拱起'],
          first_appearance: 1,
          locked: true,
          description: '',
          layout: '',
          capacity: 0,
          changes: [],
        },
      ],
      abilities: [],
      artifacts: [],
      factions: [],
      rules: [],
    } as never
    const result = runMachineChecks(
      '旧屋的墙面刷得雪白，门前停着一辆新车，屋檐下挂着两只红灯笼。',
      options({ evidence: { ...options().evidence, world } }),
    )
    expect(result.violations.some((finding) => finding.code === 'LOCKED_DETAIL_DRIFT')).toBe(true)
  })

  it('does not report ordinary action paragraphs as locked drift', () => {
    const worldbook = {
      schema_version: 1,
      updated_at: '',
      premise: '',
      setting: '',
      rules: [],
      factions: [],
      locations: [{ name: '旧屋', description: '门口有一棵榕树。', layout: '三进深。', capacity: 4 }],
      characters: [
        {
          name: '林砚',
          role: 'protagonist',
          description: '账房先生。',
          arc: '',
          appearance: '瘦高个，左眉有一道旧疤，总穿灰布衫。',
        },
      ],
      glossary: [],
      backstory: [],
      themes: [],
    } as never
    const result = runMachineChecks(
      '林砚把账本合上，起身走到窗边，看着街上的人来人往。\n\n旧屋里静悄悄的，桌上还摆着昨天没喝完的茶。',
      options({ evidence: { ...options().evidence, worldbook } }),
    )
    expect(result.violations.some((finding) => finding.code === 'LOCKED_DETAIL_DRIFT')).toBe(false)
  })

  it('derives legacy timeline event keys per chapter, not from the global ledger index', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '时间线键', genre: '都市现代', platform: 'fanqie', root })
      const current = (await engine.queryState({ kind: 'timeline', root })).data as {
        schema_version: 1
        next_seq: number
        items: unknown[]
      }
      await engine.amend({
        path: 'state/timeline.yaml',
        reason: 'legacy key fixture',
        root,
        content: {
          ...current,
          next_seq: 4,
          items: [
            {
              id: 'TE-001',
              chapter: 1,
              story_time: 'Day 1',
              description: '事件一',
              location: '',
              characters: [],
            },
            {
              id: 'TE-002',
              chapter: 1,
              story_time: 'Day 1',
              description: '事件二',
              location: '',
              characters: [],
            },
            {
              id: 'TE-003',
              chapter: 2,
              story_time: 'Day 2',
              description: '事件三',
              location: '',
              characters: [],
            },
          ],
        },
      })
      const data = (await engine.queryState({ kind: 'timeline', root })).data as {
        items: Array<{ id: string; event_key?: string }>
      }
      const keys = Object.fromEntries(data.items.map((item) => [item.id, item.event_key]))
      expect(keys['TE-001']).toBe(eventKeyFor(1, 0, '事件一'))
      expect(keys['TE-002']).toBe(eventKeyFor(1, 1, '事件二'))
      expect(keys['TE-003']).toBe(eventKeyFor(2, 0, '事件三'))

      const page = (await engine.queryState({ kind: 'timeline', limit: 2, root })).data
      await expect(
        engine.amend({
          path: 'state/timeline.yaml',
          reason: 'truncated page must not be persisted',
          root,
          content: page as Record<string, unknown>,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const filtered = (await engine.queryState({ kind: 'timeline', chapter_range: [99, 99], root })).data
      await expect(
        engine.amend({
          path: 'state/timeline.yaml',
          reason: 'filtered empty page must not wipe the ledger',
          root,
          content: filtered as Record<string, unknown>,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('derives a legacy timeline key from summary.events even when a preceding row is missing', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '稀疏时间线', genre: '都市现代', platform: 'fanqie', root })
      await writeFile(
        join(root, 'state', 'chapters.yaml'),
        stringifyYaml({
          schema_version: 1,
          chapters: [
            {
              num: 1,
              title: '第1章 开端',
              file: 'chapters/chapter-001.md',
              word_count: 100,
              dialogue_lines: 1,
              dialogue_ratio: 0.1,
              scene_type: '日常过渡章',
              narrator: '他',
              score: 120,
              status: 'reviewed',
              content_hash: 'a'.repeat(64),
              summary: sampleSummary({ events: ['事件一', '事件二'] }),
            },
          ],
        }),
        'utf8',
      )
      await writeFile(
        join(root, 'state', 'timeline.yaml'),
        stringifyYaml({
          schema_version: 1,
          next_seq: 2,
          items: [
            {
              id: 'TE-001',
              chapter: 1,
              story_time: 'Day 2',
              description: '事件二',
              location: '',
              characters: [],
            },
          ],
        }),
        'utf8',
      )
      const data = (await engine.queryState({ kind: 'timeline', root })).data as {
        items: Array<{ id: string; event_key?: string }>
      }
      expect(data.items[0]).toMatchObject({
        id: 'TE-001',
        event_key: eventKeyFor(1, 1, '事件二'),
      })
    } finally {
      await cleanup()
    }
  })

  it('sorts timeline by chapter and numeric event index, not lexical event_key', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '时间线排序', genre: '都市现代', platform: 'fanqie', root })
      const current = (await engine.queryState({ kind: 'timeline', root })).data as {
        schema_version: 1
        next_seq: number
        items: unknown[]
      }
      await engine.amend({
        path: 'state/timeline.yaml',
        reason: 'explicit event keys',
        root,
        content: {
          ...current,
          next_seq: 13,
          items: Array.from({ length: 12 }, (_, index) => ({
            id: `TE-${String(index + 1).padStart(3, '0')}`,
            chapter: 1,
            story_time: 'Day 1',
            description: `事件${index + 1}`,
            location: '',
            characters: [],
            event_key: eventKeyFor(1, index, `事件${index + 1}`),
          })),
        },
      })
      const data = (await engine.queryState({ kind: 'timeline', root })).data as {
        items: Array<{ id: string }>
      }
      expect(data.items.map((item) => item.id)).toEqual(
        Array.from({ length: 12 }, (_, index) => `TE-${String(index + 1).padStart(3, '0')}`),
      )
    } finally {
      await cleanup()
    }
  })

  it('keeps same-code advisories distinct when their details differ', () => {
    const items = Array.from({ length: 30 }, (_, index) => ({
      id: `FS-${String(index + 1).padStart(3, '0')}`,
      title: `线索${index + 1}`,
      planted: 1,
      last_touched: 1,
      status: 'planted' as const,
      resolved_at: null,
      description: '',
      advance_log: [],
    }))
    const result = runMachineChecks(
      '正文。',
      options({
        chapter: 30,
        evidence: {
          ...options().evidence,
          foreshadows: { schema_version: 1, next_seq: 31, items },
        },
      }),
    )
    const dormant = result.violations.filter((finding) => finding.code === 'FORESHADOW_DORMANT')
    expect(dormant).toHaveLength(30)
    expect(new Set(dormant.map((finding) => finding.id)).size).toBe(30)
  })

  it('covers numeric operator, speed and fact branches', () => {
    const codes = (text: string): string[] =>
      runMachineChecks(text, options()).violations.map((finding) => finding.code)
    expect(codes('2 + 3 = 6。')).toContain('NUMERIC_CONTRADICTION')
    expect(codes('2 - 3 = 1。')).toContain('NUMERIC_CONTRADICTION')
    expect(codes('8 ÷ 2 = 3。')).toContain('NUMERIC_CONTRADICTION')
    expect(codes('8 ÷ 0 = 1。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codes('2 × 3 = 6。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codes('2 × 3 = 7。2 × 3 = 7。')).toContain('NUMERIC_CONTRADICTION')
    expect(codes('三块五，5 × 2 = 11。')).toContain('NUMERIC_CONTRADICTION')
    expect(codes('时速 60 公里，时速 20 公里。')).toContain('NUMERIC_CONTRADICTION')
    expect(codes('时速 60 公里，时速 50 公里。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codes('走了 120 公里，用了 2 小时。又走了 60 公里，用了 3 小时。')).toContain(
      'NUMERIC_CONTRADICTION',
    )
    expect(codes('走了 120 公里。')).not.toContain('NUMERIC_CONTRADICTION')

    const facts = [{ alias: '船价', value: 300, unit: '元', tolerance: 10 }]
    expect(runMachineChecks('船价 300 元。', options({ facts })).violations.map((f) => f.code)).not.toContain(
      'NUMERIC_FACT_MISMATCH',
    )
    expect(runMachineChecks('船价 320 元。', options({ facts })).violations.map((f) => f.code)).toContain(
      'NUMERIC_FACT_MISMATCH',
    )
    expect(runMachineChecks('船价 300 元。', options({ facts })).numeric.facts_checked).toBe(1)
    expect(
      runMachineChecks('船价 300 元。', options({ facts: [{ ...facts[0]!, value: Number.NaN }] })).numeric
        .facts_checked,
    ).toBe(0)
  })

  it('covers short duplicate fragments and dialogue metric branches', () => {
    const shortPrevious = '旧办公室的门锁换了，桌上多了一只红木匣子。'
    const shortCurrent = '旧办公室的门锁换了，桌上多了一只红木匣子。'
    expect(
      runMachineChecks(
        shortCurrent,
        options({
          chapter: 2,
          evidence: { ...options().evidence, previousText: shortPrevious, previousTexts: [shortPrevious] },
        }),
      ).violations.filter((finding) => finding.code === 'DUPLICATE_PARAGRAPH'),
    ).toHaveLength(1)
    const chars = runMachineChecks(
      '他说："好。"\n「走。」\n他转身。',
      options({
        targets: { words_per_chapter: [1, 999], dialogue_ratio: [0, 0.5], dialogue_ratio_metric: 'chars' },
      }),
    )
    const lines = runMachineChecks(
      '他说："好。"\n「走。」\n他转身。',
      options({
        targets: { words_per_chapter: [1, 999], dialogue_ratio: [0, 0.5], dialogue_ratio_metric: 'lines' },
      }),
    )
    expect(chars.violations.some((finding) => finding.code === 'DIALOGUE_RATIO')).toBe(false)
    expect(lines.violations.some((finding) => finding.code === 'DIALOGUE_RATIO')).toBe(true)
  })

  it('rejects every malformed genre profile scalar', () => {
    const base = loadRulepack()
    for (const [key, value] of [
      ['foreshadow_min_dormancy', 0],
      ['motif_min_dormancy', -1],
      ['foreshadow_dormant_after', 1.5],
      ['pleasure_keywords', [1]],
    ] as const) {
      const document = structuredClone(base) as unknown as {
        genres: Record<string, { profile?: Record<string, unknown> }>
      }
      document.genres['都市现代']!.profile = {
        ...(document.genres['都市现代']!.profile ?? {}),
        [key]: value,
      }
      expect(() => compileRulepack(document), key).toThrow()
    }
  })

  it('does not count narrative 一共 as an equation examined', () => {
    const result = runMachineChecks('2 × 3 = 7。我们一共三个人。', options())
    expect(result.numeric.equations_checked).toBe(1)
    expect(runMachineChecks('三五个人，每人五块，一共十五块。', options()).numeric.equations_checked).toBe(0)
  })

  it('counts numeric facts only when the alias+unit pattern matched', () => {
    const facts = [{ alias: '船价', value: 300, unit: '元' }]
    expect(runMachineChecks('船价 300 元。', options({ facts })).numeric.facts_checked).toBe(1)
    expect(runMachineChecks('船价三百。', options({ facts })).numeric.facts_checked).toBe(0)
  })

  it('shows a real shared fragment for duplicate paragraph evidence', () => {
    const shared = '旧办公室的门锁换了，桌上多了一只红木匣子，窗边那盆花也被人挪走了，墙角多了一张旧藤椅。'
    const previous = `前面还有一段完全不同的话。${shared}尾巴甲。`
    const current = `${shared}尾巴乙。`
    const result = runMachineChecks(
      current,
      options({
        chapter: 2,
        evidence: {
          ...options().evidence,
          previousText: previous,
          previousTexts: [previous],
        },
      }),
    )
    const duplicate = result.violations.find((finding) => finding.code === 'DUPLICATE_PARAGRAPH')
    expect(duplicate?.detail).toContain(Array.from(shared).slice(0, 40).join(''))
    expect(duplicate?.detail).not.toContain('前面还有一段完全不同的话')
  })

  it('accepts planned_resolve and kind in a draft summary through the tool contract', async () => {
    const submitDraft = vi.fn(async () => ({ data: { chapter: 1, stage: 'P4' }, revision: 1, warnings: [] }))
    const tools = new Map(
      createNovelTools({
        withSignal: vi.fn(async (_signal: unknown, task: () => Promise<unknown>) => task()),
        submitDraft,
        submitReview: vi.fn(),
        submitRevision: vi.fn(),
        submitWorldPlan: vi.fn(),
        submitOutline: vi.fn(),
        runCheck: vi.fn(),
        archiveChapter: vi.fn(),
      } as unknown as EngineService).map((tool) => [tool.name, tool]),
    )
    const init = tools.get('novel_init')!
    const initParams = init.parameters as {
      properties: { min_cjk_chars: unknown }
    }
    expect(JSON.stringify(initParams.properties.min_cjk_chars)).toContain('"null"')
    const summary = emptySummary()
    summary.foreshadows.planted = [
      { key: 'fs001', title: '欠账', description: '一笔旧账', planned_resolve: 3, kind: 'motif' },
    ]
    await expect(
      tools.get('novel_write_draft')!.execute(
        {
          chapter: 1,
          content: '正文。',
          chapter_title: '开端',
          scene_type: '日常过渡章',
          narrator: '他',
          summary,
        },
        {} as never,
      ),
    ).resolves.toBeTruthy()
    expect(submitDraft).toHaveBeenCalled()
  })

  it('reports all legacy foreshadows as unplanned, including resolved rows', async () => {
    const { buildBookReport } = await import('../src/engine/insight.js')
    const { emptyOutline, emptyWorldbook } = await import('../src/engine/book.js')
    const project = {
      schema_version: 1,
      title: '书',
      genre: '都市现代',
      platform: 'fanqie',
      author: '',
      description: '',
      created_at: '2026-01-01T00:00:00.000Z',
      targets: { words_per_chapter: [1, 999], total_chapters: null, dialogue_ratio: [0, 1] },
    } as never
    const foreshadows = {
      schema_version: 1,
      next_seq: 3,
      items: [
        {
          id: 'FS-001',
          title: '旧信',
          planted: 1,
          last_touched: 1,
          status: 'planted',
          resolved_at: null,
          description: '',
          advance_log: [],
        },
        {
          id: 'FS-002',
          title: '蜡印',
          planted: 1,
          last_touched: 1,
          status: 'resolved',
          resolved_at: 1,
          description: '',
          advance_log: [],
        },
      ],
    } as unknown as ForeshadowsDocument
    const report = buildBookReport({
      project,
      outline: emptyOutline('2026-01-01'),
      outlinePresent: false,
      outlineError: null,
      worldbook: emptyWorldbook('2026-01-01'),
      worldbookPresent: false,
      worldbookError: null,
      world: {
        schema_version: 1,
        next_seq: 1,
        locations: [],
        abilities: [],
        artifacts: [],
        factions: [],
        rules: [],
      } as never,
      chapters: [
        {
          num: 1,
          title: '开端',
          file: 'chapters/chapter-001.md',
          word_count: 100,
          dialogue_lines: 0,
          dialogue_ratio: 0,
          scene_type: '日常过渡章',
          narrator: '他',
          score: 120,
          status: 'reviewed',
          content_hash: 'x',
          summary: {
            events: [],
            characters_appeared: [],
            foreshadows: { planted: [], advanced: [], resolved: [] },
            new_elements: { locations: [], abilities: [], artifacts: [] },
            resource_changes: [],
            opening: '',
            continuity: { opens_from: '', ends_with: '' },
            hook_strength: 4,
            pleasure_points: [],
            plot_advancement: 'mid',
          },
        },
      ] as never,
      characters: { schema_version: 1, next_seq: 1, characters: [] } as never,
      timeline: { schema_version: 1, next_seq: 1, items: [] } as never,
      foreshadows,
      relationships: { schema_version: 1, next_seq: 1, items: [] } as never,
      reviews: [],
      activity: [],
      journal: [],
      reviewAttempts: 0,
      finalChecks: {},
      targetChapters: null,
      minScore: 120,
      dimensionMax: {},
      foreshadowDormantAfter: 20,
    })
    expect(report.foreshadows.planned).toBe(0)
    expect(report.foreshadows.unplanned).toBe(2)
  })

  it('filters brief receipts by chapter as well as the current marker', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '收据章节过滤', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      const current = (await engine.queryState({ kind: 'briefs', chapter: 1, current_only: true, root }))
        .data as { receipts: Array<{ chapter: number; stage: string }>; page: { total: number } }
      expect(current.receipts).toHaveLength(1)
      expect(current.receipts[0]).toMatchObject({ chapter: 1, stage: 'P1' })
      expect(current.page.total).toBe(1)
      const other = (await engine.queryState({ kind: 'briefs', chapter: 2, current_only: true, root }))
        .data as { receipts: unknown[]; page: { total: number } }
      expect(other.receipts).toHaveLength(0)
      expect(other.page.total).toBe(0)
    } finally {
      await cleanup()
    }
  })

  it('preserves legacy brief receipt rows when a new receipt is appended', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '旧收据保留', genre: '都市现代', platform: 'fanqie', root })
      await writeFile(
        join(root, 'state', 'briefs.yaml'),
        [
          'schema_version: 1',
          'receipts:',
          '  - chapter: 1',
          '    stage: P1',
          '    digest: old-p1',
          '    issued_at: 2026-01-01T00:00:00.000Z',
          '  - chapter: 1',
          '    stage: P2',
          '    digest: old-p2',
          '    issued_at: 2026-01-01T00:01:00.000Z',
          '',
        ].join('\n'),
        'utf8',
      )
      await engine.getBrief({ stage: 'P1', root })
      const saved = parseYaml(await readFile(join(root, 'state', 'briefs.yaml'), 'utf8')) as {
        receipts: Array<Record<string, unknown>>
      }
      expect(saved.receipts).toHaveLength(3)
      expect(saved.receipts[0]).toEqual({
        chapter: 1,
        stage: 'P1',
        digest: 'old-p1',
        issued_at: '2026-01-01T00:00:00.000Z',
      })
      expect(saved.receipts[1]).toEqual({
        chapter: 1,
        stage: 'P2',
        digest: 'old-p2',
        issued_at: '2026-01-01T00:01:00.000Z',
      })
      expect(saved.receipts[2]).toMatchObject({ chapter: 1, stage: 'P1', current: true })
    } finally {
      await cleanup()
    }
  })

  it('keeps a promoted legacy receipt current for queryState and PG-01', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '提升收据一致性', genre: '都市现代', platform: 'fanqie', root })
      const first = await engine.getBrief({ stage: 'P1', root })
      const project = (await engine.queryState({ kind: 'novel', root })).data as Record<string, unknown> & {
        targets: Record<string, unknown>
      }
      await engine.amend({
        path: 'novel.yaml',
        content: {
          title: `${String(project.title)}乙`,
          author: project.author,
          description: project.description,
          targets: project.targets,
        },
        reason: 'change context for second receipt',
        root,
      })
      const second = await engine.getBrief({ stage: 'P1', root })
      expect(second.data.digest).not.toBe(first.data.digest)
      await writeFile(
        join(root, 'state', 'briefs.yaml'),
        stringifyYaml({
          schema_version: 1,
          receipts: [
            {
              chapter: 1,
              stage: 'P1',
              digest: first.data.digest,
              issued_at: '2026-01-01T00:00:00.000Z',
            },
            {
              chapter: 1,
              stage: 'P1',
              digest: second.data.digest,
              issued_at: '2026-01-02T00:00:00.000Z',
            },
          ],
        }),
        'utf8',
      )
      await engine.amend({
        path: 'novel.yaml',
        content: {
          title: project.title,
          author: project.author,
          description: project.description,
          targets: project.targets,
        },
        reason: 'restore first context',
        root,
      })
      const promoted = await engine.getBrief({ stage: 'P1', root })
      expect(promoted.data.digest).toBe(first.data.digest)
      const pipeline = (await engine.queryState({ kind: 'pipeline', root })).data as {
        briefs: Record<string, { digest: string }>
      }
      expect(pipeline.briefs.P1?.digest).toBe(first.data.digest)
      const current = (await engine.queryState({ kind: 'briefs', current_only: true, root })).data as {
        receipts: Array<{ digest: string; current?: boolean }>
      }
      expect(current.receipts.find((receipt) => receipt.current !== false)?.digest).toBe(first.data.digest)
      const status = await engine.getStatus({ root })
      expect(status.data.next?.tool).not.toBe('novel_brief')
    } finally {
      await cleanup()
    }
  })

  it('rejects a zero planned_resolve in the draft summary at PG-05', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const summary = sampleSummary({
        foreshadows: {
          planted: [
            {
              key: 'fs001',
              title: '旧账',
              description: '旧账',
              anchor: '风从窗缝里挤进来',
              planned_resolve: 0,
            },
          ],
          advanced: [],
          resolved: [],
        },
      })
      await engine.getBrief({ stage: 'P3', root })
      await expect(
        engine.submitDraft({
          chapter: 1,
          content: cleanText(),
          chapter_title: '开端之雨',
          scene_type: '日常过渡章',
          narrator: '他',
          summary,
          root,
        }),
      ).rejects.toMatchObject({
        code: 'ENGINE_GATE_BLOCKED',
        blocking: expect.arrayContaining([expect.objectContaining({ code: 'PG-05' })]),
      })
    } finally {
      await cleanup()
    }
  })

  it('rejects a newly added relationship without type_code through novel_amend', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '关系映射', genre: '都市现代', platform: 'fanqie', root })
      const characters = (await engine.queryState({ kind: 'characters', root })).data as {
        schema_version: 1
        characters: unknown[]
      }
      await engine.amend({
        path: 'state/characters.yaml',
        reason: 'character fixture',
        root,
        content: {
          ...characters,
          characters: [
            {
              name: '甲',
              role: 'supporting',
              first_appearance: 1,
              profile: {},
              current_state: {},
              growth: [],
              updated_at: 1,
            },
            {
              name: '乙',
              role: 'supporting',
              first_appearance: 1,
              profile: {},
              current_state: {},
              growth: [],
              updated_at: 1,
            },
          ],
        },
      })
      const relationships = (await engine.queryState({ kind: 'relationships', root })).data as {
        schema_version: 1
        next_seq: number
        items: unknown[]
      }
      await expect(
        engine.amend({
          path: 'state/relationships.yaml',
          reason: 'missing type_code',
          root,
          content: {
            ...relationships,
            next_seq: 2,
            items: [
              {
                id: 'RL-001',
                a: '甲',
                b: '乙',
                type: '朋友',
                since: 1,
                description: '',
                evolution: [],
              },
            ],
          },
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('rejects a newly resolved foreshadow without a resolved_anchor through novel_amend', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '伏笔证据', genre: '都市现代', platform: 'fanqie', root })
      const foreshadows = (await engine.queryState({ kind: 'foreshadows', include_history: true, root }))
        .data as {
        schema_version: 1
        next_seq: number
        items: unknown[]
      }
      await engine.amend({
        path: 'state/foreshadows.yaml',
        reason: 'planted fixture',
        root,
        content: {
          ...foreshadows,
          next_seq: 2,
          items: [
            {
              id: 'FS-001',
              title: '旧账',
              planted: 1,
              last_touched: 1,
              status: 'planted',
              resolved_at: null,
              description: '旧账',
              advance_log: [],
            },
          ],
        },
      })
      await expect(
        engine.amend({
          path: 'state/foreshadows.yaml',
          reason: 'new resolve without evidence',
          root,
          content: {
            ...foreshadows,
            next_seq: 2,
            items: [
              {
                id: 'FS-001',
                title: '旧账',
                planted: 1,
                last_touched: 1,
                status: 'resolved',
                resolved_at: 1,
                description: '旧账',
                advance_log: [],
              },
            ],
          },
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('rejects a forged resolved_anchor through novel_amend when the chapter exists', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '兑现证据', genre: '都市现代', platform: 'fanqie', root })
      await mkdir(join(root, 'chapters'), { recursive: true })
      await writeFile(join(root, 'chapters', 'chapter-001.md'), '甲和乙站在屋前，术法还没散。', 'utf8')
      const planted = {
        schema_version: 1,
        next_seq: 2,
        items: [
          {
            id: 'FS-001',
            title: '旧账',
            planted: 1,
            last_touched: 1,
            status: 'planted',
            resolved_at: null,
            description: '旧账',
            advance_log: [],
          },
        ],
      }
      await engine.amend({
        path: 'state/foreshadows.yaml',
        reason: 'planted fixture',
        root,
        content: planted,
      })
      const verified = {
        ...planted,
        items: [
          {
            ...planted.items[0],
            status: 'resolved',
            resolved_at: 1,
            resolved_anchor: '甲和乙站在屋前，术法还没散',
          },
        ],
      }
      await engine.amend({
        path: 'state/foreshadows.yaml',
        reason: 'valid resolved anchor',
        root,
        content: verified,
      })
      await expect(
        engine.amend({
          path: 'state/foreshadows.yaml',
          reason: 'same verified anchor is idempotent',
          root,
          content: verified,
        }),
      ).resolves.toBeTruthy()
      await expect(
        engine.amend({
          path: 'state/foreshadows.yaml',
          reason: 'forged resolved anchor',
          root,
          content: {
            ...planted,
            items: [
              {
                ...planted.items[0],
                status: 'resolved',
                resolved_at: 1,
                resolved_anchor: '这句原话根本不在任何正文里面',
              },
            ],
          },
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({
          path: 'state/foreshadows.yaml',
          reason: 'anchor chapter file is missing',
          root,
          content: {
            ...planted,
            items: [
              {
                ...planted.items[0],
                status: 'resolved',
                resolved_at: 99,
                resolved_anchor: '这句原话根本不在任何正文里面',
              },
            ],
          },
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({
          path: 'state/foreshadows.yaml',
          reason: 'legacy row with no resolvable chapter remains importable',
          root,
          content: {
            ...planted,
            items: [
              {
                ...planted.items[0],
                status: 'resolved',
                resolved_at: null,
                last_touched: 0,
                resolved_anchor: '这段旧证据不在当前正文里但保留迁移入口',
              },
            ],
          },
        }),
      ).resolves.toBeTruthy()
    } finally {
      await cleanup()
    }
  })

  it('rejects malformed genre profile thresholds and keywords in a rulepack', () => {
    const base = loadRulepack()
    const badKeywords = structuredClone(base) as unknown as {
      genres: Record<string, { profile?: Record<string, unknown> }>
    }
    badKeywords.genres['都市现代']!.profile!.pleasure_keywords = '钱' as never
    expect(() => compileRulepack(badKeywords)).toThrow(/pleasure_keywords/)

    const badThreshold = structuredClone(base) as unknown as {
      crosschapter: Record<string, unknown>
    }
    badThreshold.crosschapter.motif_min_dormancy = 0
    expect(() => compileRulepack(badThreshold)).toThrow(/motif_min_dormancy/)
  })

  it('acknowledges one advisory instance without endorsing the rest of its code', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = `${cleanText()}\n\n账本一：2 × 3 = 7。\n\n账本二：4 × 5 = 19。`
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({ chapter: 1, scope: ['content'], semantic: sampleSemantic(text), root })
      const check = (await engine.queryState({ kind: 'check', root })).data as {
        machine: { advisories: Array<{ id: string; code: string }> }
      }
      const numeric = check.machine.advisories.filter((advisory) => advisory.code === 'NUMERIC_CONTRADICTION')
      expect(numeric.length).toBeGreaterThanOrEqual(2)
      const total = check.machine.advisories.length
      await engine.getBrief({ stage: 'P6', root })
      const result = await engine.runCheck({
        chapter: 1,
        scope: ['content', 'integrity'],
        semantic: sampleSemantic(text),
        acknowledge: [numeric[0]!.id],
        acknowledge_reasons: { [numeric[0]!.id]: '已知的重复算式' },
        root,
      })
      expect(result.data.acknowledged_findings).toHaveLength(1)
      expect(result.data.advisories).toBe(total - 1)
      const saved = (await engine.queryState({ kind: 'check', root })).data as {
        acknowledged_findings?: unknown
        machine: { acknowledged_findings?: unknown[] }
      }
      expect(saved.machine.acknowledged_findings).toHaveLength(1)
      expect(saved.acknowledged_findings).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it('keeps motifs out of archive dormancy and applies the genre dormancy threshold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'novel-0213-dormant-'))
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-0213-state-'))
    const pack = structuredClone(loadRulepack())
    pack.genres['都市现代']!.profile = {
      ...(pack.genres['都市现代']!.profile ?? {}),
      foreshadow_dormant_after: 1,
    }
    const engine = new EngineService({ ...TEST_CONFIG, projectRoot: root, stateDir }, () => pack, {
      now: FIXED_NOW,
    })
    try {
      const summary1 = sampleSummary({
        events: ['收到无名信封'],
        characters_appeared: ['他'],
        foreshadows: {
          planted: [
            { key: 'fs_plot', title: '蜡印', description: '暗红蜡印' },
            { key: 'fs_motif', title: '旧信封', description: '无名信封' },
          ],
          advanced: [],
          resolved: [],
        },
      })
      await readyToArchive({ root, engine, text: cleanText(), summary: summary1 })
      const delta1 = archiveDelta(summary1)
      delta1.foreshadows['fs_plot'] = { ...delta1.foreshadows['fs_plot']!, kind: 'plot' }
      delta1.foreshadows['fs_motif'] = { ...delta1.foreshadows['fs_motif']!, kind: 'motif' }
      await engine.archiveChapter({ chapter: 1, state_delta: delta1, root })

      await engine.getBrief({ stage: 'P1', root })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: '第二天回到码头',
        constraints: [],
        characters: [],
        locations: [],
        continuity_notes: [],
        root,
      })
      await engine.getBrief({ stage: 'P2', root })
      await engine.submitChapterPlan({
        chapter: 0,
        title: '归途码头',
        scene_type: '日常过渡章',
        narrator: '他',
        beats: ['回码头', '看账本', '遇旧人', '收摊', '回家'],
        opening: '海风从码头吹来',
        ending: '脚步慢了下来',
        target_words: [80, 400],
        root,
      })
      const text2 = [
        '海风从码头吹来，带着咸味。他站在仓库门口，看见远处的灯一盏盏亮起。',
        '工人推着板车经过，车轮压过石缝，发出低低的响声。',
        '他把账本翻开，纸页上有几处被水浸过的痕迹。',
        '巷口卖粥的摊子收了火，老板把最后一只碗摞起来。',
        '他沿着来路走回去，脚步比来时慢了一些。',
      ].join('\n\n')
      const summary2 = sampleSummary({
        events: ['他回到码头'],
        characters_appeared: ['他'],
        opening: '海风从码头吹来，带着咸味',
      })
      await engine.getBrief({ stage: 'P3', root })
      await engine.submitDraft({
        chapter: 2,
        content: text2,
        chapter_title: '归途码头',
        scene_type: '日常过渡章',
        narrator: '他',
        summary: summary2,
        root,
      })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 2, ...sampleReview(2, text2), root })
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({ chapter: 2, semantic: sampleSemantic(text2), root })
      await engine.getBrief({ stage: 'P8', root })
      await engine.archiveChapter({
        chapter: 2,
        state_delta: archiveDelta(summary2, { existing: ['他'] }),
        root,
      })
      const ledger = (await engine.queryState({ kind: 'foreshadows', include_history: true, root })).data as {
        items: Array<{ title: string; status: string; kind?: string }>
      }
      expect(ledger.items.find((item) => item.title === '蜡印')?.status).toBe('dormant')
      expect(ledger.items.find((item) => item.title === '旧信封')?.status).toBe('planted')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})
