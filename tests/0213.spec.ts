import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countWordMetrics } from '../src/domain/wordcount.js'
import { loadRulepack } from '../src/rulepack.js'
import { runMachineChecks, type MachineOptions } from '../src/rules/pipeline.js'
import { eventKeyFor } from '../src/engine/state-delta.js'
import { resolveLockBaseline } from '../src/engine/entity-anchors.js'
import { harness } from './helpers.js'
import type { ForeshadowsDocument, WorldbookDocument } from '../src/types.js'

const options = (overrides: Partial<MachineOptions> = {}): MachineOptions => ({
  chapter: 1,
  title: '第1章 开端',
  genre: '都市现代',
  sceneType: '日常过渡章',
  rulepack: loadRulepack(),
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

describe('0.2.13 ledger truth', () => {
  it('separates line and character dialogue metrics and punctuation classes', () => {
    const metrics = countWordMetrics('他说："好。"\n「走。」')
    expect(metrics.dialogue_lines).toBe(2)
    expect(metrics.dialogue_chars).toBeGreaterThan(0)
    expect(metrics.dialogue_char_ratio).toBeGreaterThan(0)
    expect(metrics.punctuation_breakdown?.chinese).toBeGreaterThan(0)
    expect(metrics.punctuation_breakdown?.ascii).toBeGreaterThan(0)
  })

  it('uses both dialogue measures for the advisory', () => {
    const text = '他说："好。"\n「走。」\n他转身。'
    const lineHeavy = runMachineChecks(
      text,
      options({
        targets: { words_per_chapter: [1, 999], dialogue_ratio: [0, 0.5], dialogue_ratio_metric: 'lines' },
      }),
    )
    const both = runMachineChecks(
      text,
      options({
        targets: { words_per_chapter: [1, 999], dialogue_ratio: [0, 0.5], dialogue_ratio_metric: 'both' },
      }),
    )
    expect(lineHeavy.violations.some((finding) => finding.code === 'DIALOGUE_RATIO')).toBe(true)
    expect(both.violations.some((finding) => finding.code === 'DIALOGUE_RATIO')).toBe(false)
  })

  it('reports explicit arithmetic, skips approximations, and exposes numeric counts', () => {
    const bad = runMachineChecks('2 × 3 = 7。', options())
    expect(bad.violations.some((finding) => finding.code === 'NUMERIC_CONTRADICTION')).toBe(true)
    expect(bad.numeric.equations_checked).toBeGreaterThan(0)
    const good = runMachineChecks('2 × 3 = 6。', options())
    expect(good.violations.some((finding) => finding.code === 'NUMERIC_CONTRADICTION')).toBe(false)
    const approximate = runMachineChecks('三五个人，每人五块，一共十五块。', options())
    expect(approximate.violations.some((finding) => finding.code === 'NUMERIC_CONTRADICTION')).toBe(false)
    const emptyFacts = runMachineChecks('船价 300 元。', options({ facts: [], strict: true }))
    expect(emptyFacts.violations.some((finding) => finding.code === 'NUMERIC_FACTS_EMPTY')).toBe(true)
  })

  it('makes event keys stable and distinguishing', () => {
    expect(eventKeyFor(3, 0, '收到信')).toBe(eventKeyFor(3, 0, '收到信'))
    expect(eventKeyFor(3, 0, '收到信')).not.toBe(eventKeyFor(3, 1, '收到信'))
    expect(eventKeyFor(3, 0, '收到信')).toMatch(/^E3-1-[0-9a-f]{8}$/)
  })

  it('prefers the worldbook description over a first-appearance paragraph', () => {
    const worldbook = {
      schema_version: 1,
      updated_at: '',
      premise: '',
      setting: '',
      rules: [],
      factions: [],
      locations: [],
      characters: [
        {
          name: '甲',
          role: 'supporting',
          description: '塑胶花厂的啤机工，左手被机器压伤。',
          arc: '',
          appearance: '瘦高个，左眉有一道旧疤，总穿灰布衫。',
        },
      ],
      glossary: [],
      backstory: [],
      themes: [],
    } as unknown as WorldbookDocument
    const baseline = resolveLockBaseline('甲', 'character', { worldbook }).baseline
    expect(baseline?.texts[0]).toContain('左眉')
    expect(baseline?.source).toBe('worldbook')
  })

  it('replays the same brief digest without appending a second receipt', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '收据夹具', genre: '都市现代', platform: 'fanqie', root })
      const first = await engine.getBrief({ stage: 'P1', root })
      const second = await engine.getBrief({ stage: 'P1', root })
      expect(first.data.digest).toBe(second.data.digest)
      const receipts = (await engine.queryState({ kind: 'briefs', current_only: true, root })).data as {
        receipts: Array<{ stage: string; current?: boolean }>
      }
      expect(receipts.receipts).toHaveLength(1)
      expect(receipts.receipts[0]).toMatchObject({ stage: 'P1', current: true })
    } finally {
      await cleanup()
    }
  })

  it('paginates ledgers with a cursor bound to the section and filters', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '分页夹具', genre: '都市现代', platform: 'fanqie', root })
      const items = Array.from({ length: 51 }, (_, index) => ({
        id: `FS-${String(index + 1).padStart(3, '0')}`,
        title: `线索${index + 1}`,
        planted: 1,
        last_touched: 1,
        status: 'planted' as const,
        resolved_at: null,
        description: '',
        advance_log: [{ chapter: 1, note: '种下', new_info: true }],
      }))
      await engine.amend({
        path: 'state/foreshadows.yaml',
        content: { schema_version: 1, next_seq: 52, items },
        reason: '分页夹具',
        root,
      })
      const first = await engine.queryState({ kind: 'foreshadows', root })
      const firstData = first.data as {
        items: unknown[]
        page: { total: number; has_more: boolean; next_cursor: string | null }
      }
      expect(firstData.items).toHaveLength(50)
      expect(firstData.page).toMatchObject({ total: 51, has_more: true })
      expect((firstData.items[0] as { advance_log?: unknown }).advance_log).toBeUndefined()
      const second = await engine.queryState({
        kind: 'foreshadows',
        cursor: firstData.page.next_cursor!,
        root,
      })
      expect((second.data as { items: unknown[] }).items).toHaveLength(1)
      await expect(
        engine.queryState({ kind: 'timeline', cursor: firstData.page.next_cursor!, root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('uses an explicit appearance baseline and skips biography without one', () => {
    const worldbook = {
      schema_version: 1,
      updated_at: '',
      premise: '',
      setting: '',
      rules: [],
      factions: [],
      locations: [],
      characters: [
        {
          name: '甲',
          role: 'supporting',
          description: '塑胶花厂的啤机工，左手被机器压伤。',
          arc: '',
          appearance: '左眉有一道旧疤。',
        },
        { name: '乙', role: 'supporting', description: '一段传记，没有外貌。', arc: '' },
      ],
      glossary: [],
      backstory: [],
      themes: [],
    } as unknown as WorldbookDocument
    expect(resolveLockBaseline('甲', 'character', { worldbook }).baseline?.texts[0]).toContain('左眉')
    expect(resolveLockBaseline('乙', 'character', { worldbook }).baseline).toBeNull()
    const drift = runMachineChecks(
      '甲穿着雪白西装，头发梳得整齐，手上没有一点旧伤。',
      options({ evidence: { ...options().evidence, worldbook } }),
    )
    expect(drift.violations.some((finding) => finding.code === 'LOCKED_DETAIL_DRIFT')).toBe(true)
  })

  it('reports planned overdue plot foreshadows but lets motifs rest', () => {
    const item = (patch: Record<string, unknown>) => ({
      id: 'FS-001',
      title: '欠账',
      planted: 1,
      last_touched: 1,
      status: 'planted',
      resolved_at: null,
      description: '',
      planned_resolve: 1,
      kind: 'plot',
      advance_log: [],
      ...patch,
    })
    const ledger = (patch: Record<string, unknown>) =>
      ({
        schema_version: 1,
        next_seq: 3,
        items: [item(patch)],
      }) as unknown as ForeshadowsDocument
    const plot = runMachineChecks(
      '正文。',
      options({ chapter: 3, evidence: { ...options().evidence, foreshadows: ledger({}) } }),
    )
    expect(plot.violations.some((finding) => finding.code === 'FORESHADOW_OVERDUE')).toBe(true)
    const motif = runMachineChecks(
      '正文。',
      options({
        chapter: 3,
        evidence: { ...options().evidence, foreshadows: ledger({ kind: 'motif' }) },
      }),
    )
    expect(motif.violations.some((finding) => finding.code === 'FORESHADOW_OVERDUE')).toBe(false)
    expect(motif.violations.some((finding) => finding.code === 'FORESHADOW_DORMANT')).toBe(false)
  })

  it('checks declared numeric facts and arithmetic operators', () => {
    const mismatch = runMachineChecks(
      '船价 320 元。',
      options({ facts: [{ alias: '船价', value: 300, unit: '元' }] }),
    )
    expect(mismatch.violations.some((finding) => finding.code === 'NUMERIC_FACT_MISMATCH')).toBe(true)
    const match = runMachineChecks(
      '船价 300 元。',
      options({ facts: [{ alias: '船价', value: 300, unit: '元' }] }),
    )
    expect(match.violations.some((finding) => finding.code === 'NUMERIC_FACT_MISMATCH')).toBe(false)
    expect(
      runMachineChecks('2 + 3 = 6。', options()).violations.some(
        (finding) => finding.code === 'NUMERIC_CONTRADICTION',
      ),
    ).toBe(true)
    expect(
      runMachineChecks('2 ÷ 2 = 1。', options()).violations.some(
        (finding) => finding.code === 'NUMERIC_CONTRADICTION',
      ),
    ).toBe(false)
  })
})

describe('0.2.13 branch edges', () => {
  it('covers character-only dialogue, plus/divide and zero-division guards', () => {
    const text = '他说："好。"\n「走。」\n他转身。'
    const chars = runMachineChecks(
      text,
      options({
        targets: {
          words_per_chapter: [1, 999],
          dialogue_ratio: [0, 0.1],
          dialogue_ratio_metric: 'chars',
        },
      }),
    )
    expect(chars.violations.some((finding) => finding.code === 'DIALOGUE_RATIO')).toBe(true)
    expect(
      runMachineChecks('2 + 3 = 5。', options()).violations.some(
        (finding) => finding.code === 'NUMERIC_CONTRADICTION',
      ),
    ).toBe(false)
    expect(
      runMachineChecks('2 + 3 = 6 元。', options()).violations.some(
        (finding) => finding.code === 'NUMERIC_CONTRADICTION',
      ),
    ).toBe(true)
    expect(
      runMachineChecks('2 ÷ 0 = 7。', options()).violations.some(
        (finding) => finding.code === 'NUMERIC_CONTRADICTION',
      ),
    ).toBe(false)
  })

  it('covers numeric facts tolerance and unknown aliases', () => {
    const facts = [{ alias: '船价', value: 300, unit: '元', tolerance: 10 }]
    expect(
      runMachineChecks('船价 305 元。', options({ facts })).violations.some(
        (finding) => finding.code === 'NUMERIC_FACT_MISMATCH',
      ),
    ).toBe(false)
    expect(
      runMachineChecks('船价 320 元。', options({ facts })).violations.some(
        (finding) => finding.code === 'NUMERIC_FACT_MISMATCH',
      ),
    ).toBe(true)
    expect(runMachineChecks('别的价 320 元。', options({ facts })).numeric.facts_checked).toBe(0)
  })

  it('covers motif duplicate-title and location baseline branches', () => {
    const ledger = {
      schema_version: 1,
      next_seq: 3,
      items: [
        {
          id: 'FS-001',
          title: '同一线索',
          planted: 1,
          last_touched: 1,
          status: 'planted',
          resolved_at: null,
          description: '',
          kind: 'motif',
          advance_log: [],
        },
        {
          id: 'FS-002',
          title: '同一线索',
          planted: 1,
          last_touched: 1,
          status: 'planted',
          resolved_at: null,
          description: '',
          kind: 'motif',
          advance_log: [],
        },
      ],
    } as unknown as ForeshadowsDocument
    const result = runMachineChecks(
      '正文。',
      options({ evidence: { ...options().evidence, foreshadows: ledger } }),
    )
    expect(result.violations.some((finding) => finding.code === 'FORESHADOW_DUPLICATE_TITLE')).toBe(true)
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
    } as unknown as WorldbookDocument
    expect(resolveLockBaseline('旧屋', 'location', { worldbook }).baseline?.texts.length).toBeGreaterThan(0)
  })
})

describe('0.2.13 receipt and cursor edges', () => {
  it('reactivates a superseded brief digest instead of leaving a newer digest current', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '收据提升夹具', genre: '都市现代', platform: 'fanqie', root })
      const first = await engine.getBrief({ stage: 'P1', root })
      const project = (await engine.queryState({ kind: 'novel', root })).data as Record<string, unknown> & {
        targets: Record<string, unknown>
      }
      await engine.amend({
        path: 'novel.yaml',
        content: {
          title: `${String(project.title)}换`,
          author: project.author,
          description: project.description,
          targets: project.targets,
        },
        reason: '换上下文',
        root,
      })
      const second = await engine.getBrief({ stage: 'P1', root })
      expect(second.data.digest).not.toBe(first.data.digest)
      await engine.amend({
        path: 'novel.yaml',
        content: {
          title: project.title,
          author: project.author,
          description: project.description,
          targets: project.targets,
        },
        reason: '换回上下文',
        root,
      })
      const third = await engine.getBrief({ stage: 'P1', root })
      expect(third.data.digest).toBe(first.data.digest)
      const current = (await engine.queryState({ kind: 'briefs', current_only: true, root })).data as {
        receipts: Array<{ digest: string; current?: boolean }>
      }
      expect(current.receipts.filter((receipt) => receipt.current !== false)).toHaveLength(1)
      expect(current.receipts[0]?.digest).toBe(first.data.digest)
    } finally {
      await cleanup()
    }
  })

  it('rejects bad page parameters and filter-mismatched cursors', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '游标夹具', genre: '都市现代', platform: 'fanqie', root })
      await expect(engine.queryState({ kind: 'chapters', limit: 0, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.queryState({ kind: 'foreshadows', status: 'bogus', root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(
        engine.queryState({ kind: 'timeline', chapter_range: [0, 1], root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.queryState({ kind: 'foreshadows', cursor: 'not-a-cursor', root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const first = await engine.queryState({ kind: 'foreshadows', limit: 1, root })
      const cursor = (first.data as { page: { next_cursor: string | null } }).page.next_cursor
      if (cursor !== null) {
        await expect(
          engine.queryState({ kind: 'foreshadows', status: 'planted', cursor, root }),
        ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
        await expect(engine.queryState({ kind: 'foreshadows', cursor: 'e30', root })).rejects.toMatchObject({
          code: 'ENGINE_SCHEMA_INVALID',
        })
      }
      const characters = await engine.queryState({ kind: 'characters', limit: 1, root })
      expect((characters.data as { page: { limit: number } }).page.limit).toBe(1)
      const world = await engine.queryState({ kind: 'world', limit: 1, root })
      expect((world.data as { page: { limit: number } }).page.limit).toBe(1)
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.13 state read edges', () => {
  it('covers empty status, damaged outline/worldbook reads and bad range shapes', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '损坏读取', genre: '都市现代', platform: 'fanqie', root })
      const status = await engine.getStatus({ root })
      expect(status.data.previous_chapter_effort).toBeNull()
      await writeFile(join(root, 'outline', 'outline.yaml'), 'book: [bad]\n', 'utf8')
      expect((await engine.queryState({ kind: 'outline', root })).data).toMatchObject({
        error: 'OUTLINE_UNREADABLE',
      })
      await writeFile(join(root, 'outline', 'worldbook.yaml'), 'schema_version: 1\n', 'utf8')
      expect((await engine.queryState({ kind: 'worldbook', root })).data).toMatchObject({
        error: 'WORLDBOOK_UNREADABLE',
      })
      await expect(
        engine.queryState({
          kind: 'chapters',
          chapter_range: [1] as unknown as [number, number],
          root,
        }),
      ).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
    } finally {
      await cleanup()
    }
  })

  it('covers optional filters, history pages, legacy briefs and out-of-range cursors', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '状态边角', genre: '都市现代', platform: 'fanqie', root })
      const items = [1, 2].map((index) => ({
        id: `FS-00${index}`,
        title: `线索${index}`,
        planted: 1,
        last_touched: 1,
        status: 'planted' as const,
        resolved_at: null,
        description: '',
        planned_resolve: 3,
        kind: 'plot' as const,
        advance_log: [{ chapter: 1, note: '种下', new_info: true }],
      }))
      await engine.amend({
        path: 'state/foreshadows.yaml',
        content: { schema_version: 1, next_seq: 3, items },
        reason: '状态边角',
        root,
      })
      const first = await engine.queryState({ kind: 'foreshadows', limit: 1, root })
      const page = (first.data as { page: { next_cursor: string | null } }).page
      expect(page.next_cursor).not.toBeNull()
      const withHistory = await engine.queryState({
        kind: 'foreshadows',
        include_history: true,
        status: 'planted',
        chapter_range: [1, 1],
        root,
      })
      expect(
        (withHistory.data as { items: Array<{ advance_log?: unknown[] }> }).items[0]?.advance_log,
      ).toHaveLength(1)
      const clamped = await engine.queryState({ kind: 'foreshadows', limit: 999, root })
      expect((clamped.data as { page: { limit: number } }).page.limit).toBe(200)
      await engine.queryState({ kind: 'foreshadows', status: 'resolved', root })
      await engine.queryState({ kind: 'foreshadows', status: 'open', root })
      await engine.queryState({ kind: 'relationships', chapter_range: [1, 1], root })
      await engine.queryState({ kind: 'timeline', chapter_range: [1, 1], root })
      await engine.queryState({ kind: 'history', limit: 1, root })
      await engine.queryState({ kind: 'backups', limit: 1, root })
      await engine.queryState({ kind: 'characters', limit: 1, root })
      await engine.queryState({ kind: 'world', limit: 1, root })
      const decoded = JSON.parse(Buffer.from(page.next_cursor!, 'base64url').toString('utf8')) as {
        offset: number
      }
      decoded.offset = 999
      const beyond = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
      await expect(engine.queryState({ kind: 'foreshadows', cursor: beyond, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await rm(join(root, 'state', 'briefs.yaml'), { force: true })
      const legacy = await engine.queryState({ kind: 'briefs', current_only: true, root })
      expect((legacy.data as { receipts: unknown[] }).receipts).toHaveLength(0)
    } finally {
      await cleanup()
    }
  })

  it('falls back to lock sentences only when the worldbook has no entry', () => {
    const locks = {
      schema_version: 1,
      locked_at_chapter: 1,
      characters: {},
      locations: {
        旧屋: {
          first_appearance: 1,
          locked_at: 1,
          layout: '门口有一棵老榕树，树根拱起。',
          capacity: 3,
        },
      },
    } as unknown as import('../src/types.js').LocksDocument
    expect(resolveLockBaseline('旧屋', 'location', { locks }).baseline?.texts.length).toBeGreaterThan(0)
    expect(resolveLockBaseline('不存在', 'location', { locks }).baseline).toBeNull()
  })
})
