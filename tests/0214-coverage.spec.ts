import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  matchEvidence,
  normalizeEvidenceText,
  normalizeQuoteStyle,
  quoteMeetsFloor,
} from '../src/domain/text.js'
import { jsonSafeValue, carryAcknowledgements, castShapeProblems } from '../src/engine/service.js'
import { checkReference, evaluateGates, verifyReference } from '../src/engine/gates.js'
import { hasNumericFactMatch } from '../src/rules/checks.js'
import { briefContext } from '../src/engine/context.js'
import { createNovelTools } from '../src/tools/index.js'
import { runMachineChecks } from '../src/rules/pipeline.js'
import { loadRulepack } from '../src/rulepack.js'
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
import { applyStateDelta } from '../src/engine/state-delta.js'
import type { CharactersDocument, StateDelta } from '../src/types.js'
import type { EngineService } from '../src/engine/service.js'
import type { MachineOptions } from '../src/rules/pipeline.js'

const rulepack = loadRulepack()

const machine = (text: string, patch: Partial<MachineOptions> = {}) =>
  runMachineChecks(text, {
    chapter: 1,
    title: null,
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
    ...patch,
  })

describe('0.2.14 domain evidence matching (per-file 100% gate)', () => {
  it('normalizes every quote style and ellipsis form', () => {
    expect(normalizeQuoteStyle('“甲”«乙»')).toBe('"甲""乙"')
    expect(normalizeQuoteStyle('「甲」『乙』')).toBe('"甲""乙"')
    expect(normalizeQuoteStyle('‘甲’')).toBe("'甲'")
    expect(normalizeQuoteStyle('1−2–3—4')).toBe('1-2-3-4')
    expect(normalizeQuoteStyle('a......b')).toBe('a…b')
    expect(normalizeQuoteStyle('a……b')).toBe('a…b')
  })

  it('drops all whitespace, including line breaks', () => {
    expect(normalizeEvidenceText(' 甲 乙\n丙\t丁 ')).toBe('甲乙丙丁')
  })

  it('returns not-found without a nearest paragraph for empty input', () => {
    expect(matchEvidence('甲。', '')).toEqual({ found: false, paragraph: null, via: null })
    const empty = matchEvidence('', '甲')
    expect(empty.found).toBe(false)
    expect(empty.nearest).toBeUndefined()
  })

  it('matches exactly, then after quote normalization, then across paragraphs', () => {
    expect(matchEvidence('他说"你走"了。', '"你走"').via).toBe('exact')
    expect(matchEvidence('他说：「你走」了。', '"你走"').via).toBe('normalized')
    // A quote that starts in the second paragraph exercises the offset walk.
    const later = matchEvidence('甲段内容。\n\n他说"你\n走"了。', '"你走"')
    expect(later.via).toBe('crossline')
    expect(later.paragraph).toBe(2)
    const crossline = matchEvidence('他说"你\n走"了。', '"你走"')
    expect(crossline.found).toBe(true)
    expect(crossline.via).toBe('crossline')
    expect(crossline.paragraph).toBe(1)
  })

  it('reports the nearest paragraph and similarity for a miss', () => {
    const miss = matchEvidence('甲段。\n\n风从窗缝里挤进来。', '风从门缝里挤出去')
    expect(miss.found).toBe(false)
    expect(miss.nearest?.paragraph).toBe(2)
    expect(miss.nearest!.similarity).toBeGreaterThan(0)
  })

  it('applies the 8-CJK / 12-character quote floor', () => {
    expect(quoteMeetsFloor('')).toBe(false)
    expect(quoteMeetsFloor('   ')).toBe(false)
    expect(quoteMeetsFloor('风从窗缝里挤进来')).toBe(true)
    expect(quoteMeetsFloor('一二三四五六七')).toBe(false)
    expect(quoteMeetsFloor('abcdefghijkl')).toBe(true)
    expect(quoteMeetsFloor('abcdefghijk')).toBe(false)
    expect(quoteMeetsFloor('一二三四五六七八九十', 10)).toBe(true)
  })
})

describe('0.2.14 jsonSafeValue', () => {
  it('omits undefined members, nulls undefined array slots and breaks cycles', () => {
    const cyclic: Record<string, unknown> = { a: 1, b: undefined, list: [1, undefined, 2] }
    cyclic.self = cyclic
    const safe = jsonSafeValue(cyclic) as Record<string, unknown>
    expect(safe.b).toBeUndefined()
    expect(safe.list).toEqual([1, null, 2])
    expect(safe.self).toBe('[Circular]')
    expect(() => JSON.stringify(safe)).not.toThrow()
  })

  it('stringifies functions/symbols and falls back for unencodable values', () => {
    const safe = jsonSafeValue({ fn: () => 1, big: BigInt(2) }) as Record<string, unknown>
    expect(typeof safe.fn).toBe('string')
    expect(safe.big).toBe('2')
    const bad = jsonSafeValue({ nested: new Map([[1, 2]]) }) as Record<string, unknown>
    expect(bad.nested).toEqual({})
  })
})

describe('0.2.14 tool branches for new optional parameters', () => {
  const result = <T>(data: T) => ({ data, revision: 2, warnings: [] })
  const engineStub = () => {
    const calls: Array<{ method: string; args: unknown }> = []
    const record = (method: string) => async (args: unknown) => {
      calls.push({ method, args })
      return result({ ok: true })
    }
    const engine = {
      withSignal: async (_signal: unknown, task: () => Promise<unknown>) => task(),
      getBrief: record('getBrief'),
      submitReview: record('submitReview'),
      amend: record('amend'),
      doctor: record('doctor'),
      runCheck: record('runCheck'),
      queryState: record('queryState'),
    } as unknown as EngineService
    return { engine, calls }
  }

  const toolMap = (engine: EngineService) =>
    new Map(createNovelTools(engine).map((tool) => [tool.name, tool]))

  it('passes brief stages, review amendments and optional totals through', async () => {
    const { engine, calls } = engineStub()
    const tools = toolMap(engine)
    await tools.get('novel_brief')!.execute({ stage: 'P1', stages: ['P1', 'P2'] }, {} as never)
    await tools.get('novel_review')!.execute({ chapter: 1, dimensions: [], issues: [] } as never, {} as never)
    await tools.get('novel_review')!.execute(
      {
        chapter: 1,
        dimensions: [],
        issues: [],
        amend_issues: [{ id: 'REV-1', status: 'fixed' }],
        amend_note: '修正段号',
      } as never,
      {} as never,
    )
    expect(calls.map((call) => call.method)).toEqual(['getBrief', 'submitReview', 'submitReview'])
    expect(calls[0]!.args).toMatchObject({ stages: ['P1', 'P2'] })
    expect(calls[1]!.args).not.toHaveProperty('total')
    expect(calls[2]!.args).toMatchObject({ amend_note: '修正段号' })
  })

  it('passes amend patch/allow_delete, doctor switches, check expiry and briefs view', async () => {
    const { engine, calls } = engineStub()
    const tools = toolMap(engine)
    await tools.get('novel_amend')!.execute(
      {
        path: 'state/world.yaml',
        patch: [{ op: 'replace', path: 'rules', value: [] }],
        allow_delete: true,
        reason: 'patch',
      },
      {} as never,
    )
    await tools
      .get('novel_amend')!
      .execute({ path: 'state/world.yaml', content: {}, reason: 'content' }, {} as never)
    await tools.get('novel_doctor')!.execute({ baseline: true }, {} as never)
    await tools.get('novel_doctor')!.execute({ reset: true }, {} as never)
    await tools.get('novel_doctor')!.execute({}, {} as never)
    await tools
      .get('novel_check')!
      .execute({ chapter: 1, semantic: [], acknowledge_until_chapter: 9 }, {} as never)
    await tools.get('novel_state')!.execute({ kind: 'briefs', view: 'current' }, {} as never)
    await tools.get('novel_state')!.execute({ kind: 'briefs', view: 'all' }, {} as never)
    const byMethod = (method: string) => calls.filter((call) => call.method === method)
    expect(byMethod('amend')[0]!.args).toMatchObject({ allow_delete: true })
    expect(byMethod('amend')[0]!.args).not.toHaveProperty('content')
    expect(byMethod('amend')[1]!.args).not.toHaveProperty('patch')
    expect(byMethod('doctor').map((call) => call.args)).toEqual([{ baseline: true }, { reset: true }, {}])
    expect(byMethod('runCheck')[0]!.args).toMatchObject({ acknowledge_until_chapter: 9 })
    expect(byMethod('queryState').map((call) => (call.args as { view?: string }).view)).toEqual([
      'current',
      'all',
    ])
  })
})

describe('0.2.14 rule branches', () => {
  it('keeps mixed dimensions out of the equation check', () => {
    expect(machine('2 元 × 3 斤 = 7 个。').violations.map((row) => row.code)).not.toContain(
      'NUMERIC_CONTRADICTION',
    )
    expect(machine('2 元 × 3 元 = 6 元。').violations.map((row) => row.code)).not.toContain(
      'NUMERIC_CONTRADICTION',
    )
  })

  it('reports each dialogue verdict branch', () => {
    const target = {
      words_per_chapter: [80, 900] as [number, number],
      dialogue_ratio: [0.2, 0.4] as [number, number],
    }
    const lineOutText = `${Array.from({ length: 9 }, () => '"好。"').join('\n')}\n${'他走过长街，看见灯亮。'.repeat(4)}`
    const bothOutText = Array.from({ length: 10 }, () => `"${'你好'.repeat(40)}"`).join('\n')
    const charOutText = `${Array.from({ length: 3 }, () => `"${'你好'.repeat(40)}"`).join('\n')}\n${Array.from(
      { length: 7 },
      () => '他走过长街。',
    ).join('\n')}`
    const verdict = (text: string, metric: 'lines' | 'chars' | 'both') =>
      machine(text, { targets: { ...target, dialogue_ratio_metric: metric } }).dialogue?.verdict
    expect(verdict(lineOutText, 'lines')).toBe('line_out')
    expect(verdict(lineOutText, 'chars')).toBe('pass')
    expect(verdict(lineOutText, 'both')).toBe('skewed')
    expect(verdict(charOutText, 'chars')).toBe('char_out')
    expect(verdict(bothOutText, 'both')).toBe('both_out')
    const balanced = `${Array.from({ length: 3 }, () => '"你好，今天走哪条街？"').join('\n')}\n${Array.from(
      { length: 7 },
      () => '他数着铜板，把账记在纸上。',
    ).join('\n')}`
    expect(verdict(balanced, 'both')).toBe('pass')
    expect(verdict('他走过长街，看见灯一盏一盏亮起来。', 'both')).toBe('both_out')
    expect(machine('他走过长街。').dialogue?.verdict).toBe('unconfigured')
  })

  it('treats a one-character locked description as a preserved keyword', () => {
    const locks = {
      schema_version: 1 as const,
      locked_at_chapter: 1,
      characters: {},
      locations: {
        屋: { first_appearance: 1, locked_at: 1, layout: '门', capacity: 1 },
      },
    }
    expect(() =>
      machine('他走进屋，屋里没有人。', {
        evidence: {
          characters: null,
          previousText: null,
          previousTexts: [],
          foreshadows: null,
          timeline: null,
          relationships: null,
          world: null,
          locks,
        },
      }),
    ).not.toThrow()
  })
})

describe('0.2.14 amend patch grammar', () => {
  it('adds, replaces and removes by path, and rejects malformed ops', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const worldbook = (await engine.queryState({ kind: 'worldbook', root })).data as {
        themes: string[]
      }
      await engine.amend({
        path: 'outline/worldbook.yaml',
        patch: [{ op: 'add', path: 'themes.0', value: '旧theme' }],
        reason: 'add a theme',
        root,
      })
      expect((await engine.queryState({ kind: 'worldbook', root })).data).toMatchObject({
        themes: ['旧theme'],
      })
      await engine.amend({
        path: 'outline/worldbook.yaml',
        patch: [{ op: 'replace', path: 'themes.0', value: '新theme' }],
        reason: 'replace the theme',
        root,
      })
      expect((await engine.queryState({ kind: 'worldbook', root })).data).toMatchObject({
        themes: ['新theme'],
      })
      await engine.amend({
        path: 'outline/worldbook.yaml',
        patch: [{ op: 'remove', path: 'themes.0' }],
        reason: 'remove the theme',
        root,
      })
      expect((await engine.queryState({ kind: 'worldbook', root })).data).toMatchObject({ themes: [] })
      expect(worldbook.themes).toEqual([])

      const rejects = async (
        patch: Array<{ op: string; path: string; value?: unknown }>,
        pattern: RegExp,
      ): Promise<void> => {
        await expect(
          engine.amend({ path: 'outline/worldbook.yaml', patch: patch as never, reason: 'bad', root }),
        ).rejects.toThrowError(pattern)
      }
      await rejects([{ op: 'merge', path: 'themes' }], /replace\|add\|remove/)
      await rejects([{ op: 'replace', path: 'themes.9', value: 'x' }], /out of range/)
      await rejects([{ op: 'replace', path: 'missing.field', value: 'x' }], /does not exist/)
      await rejects([{ op: 'add', path: 'premise', value: 'x' }], /already exists/)
      await rejects(
        [{ op: 'replace', path: 'premise.child', value: 'x' }],
        /non-object parent|does not exist/,
      )
      await rejects([{ op: 'remove', path: 'themes.9' }], /out of range/)
      await rejects([{ op: 'add', path: 'themes.9', value: 'x' }], /skips past the end/)
    } finally {
      await cleanup()
    }
  })

  it('rejects amend without content or patch, and with both', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await expect(
        engine.amend({ path: 'outline/worldbook.yaml', reason: 'neither', root } as never),
      ).rejects.toThrowError(/requires content or patch/)
      await expect(
        engine.amend({
          path: 'outline/worldbook.yaml',
          content: {},
          patch: [{ op: 'remove', path: 'themes' }],
          reason: 'both',
          root,
        }),
      ).rejects.toThrowError(/not both/)
    } finally {
      await cleanup()
    }
  })

  it('rejects patch when the target document is missing or unreadable', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await writeFile(join(root, 'state/relationships.yaml'), '- just\n- a list\n', 'utf8')
      await expect(
        engine.amend({
          path: 'state/relationships.yaml',
          patch: [{ op: 'replace', path: 'next_seq', value: 2 }],
          reason: 'patch a damaged doc',
          root,
        }),
      ).rejects.toThrow(/not a document object/)
      await writeFile(join(root, 'outline/worldbook.yaml'), '', 'utf8')
      await expect(
        engine.amend({
          path: 'outline/worldbook.yaml',
          patch: [{ op: 'replace', path: 'premise', value: '一句前提' }],
          reason: 'patch an empty doc',
          root,
        }),
      ).rejects.toThrow(/not a document object/)
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.14 review amendment guards', () => {
  it('rejects amendments before a review, with unknown ids, and for blockers', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = await readyToArchive({ root, engine })
      await expect(engine.submitReview({ chapter: 1, amend_issues: [], root })).rejects.toThrowError(
        /must not be empty/,
      )
      await expect(
        engine.submitReview({
          chapter: 1,
          amend_issues: [{ id: 'REV-NOPE', status: 'fixed' }],
          root,
        }),
      ).rejects.toThrowError(/not in the current review/)
      // Blockers cannot be downgraded or waived.
      const blocker = {
        id: 'REV-001',
        severity: 'blocker' as const,
        dimension: 'R-W-01',
        location: '第 2 段',
        problem: '缺动机',
        fix: '补理由',
        status: 'open' as const,
      }
      await engine.rollback({ chapter: 1, toStage: 'P3', reason: 'reset for a blocker review', root })
      await engine.getBrief({ stage: 'P3', root })
      await engine.submitDraft({
        chapter: 1,
        content: text,
        chapter_title: '开端之雨',
        scene_type: '日常过渡章',
        narrator: '他',
        summary: sampleSummary(),
        root,
      })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({
        chapter: 1,
        ...sampleReview(1, text, { issues: [blocker] }),
        root,
      })
      await engine.getBrief({ stage: 'P5', root })
      await expect(
        engine.submitReview({
          chapter: 1,
          amend_issues: [{ id: 'REV-001', severity: 'advisory' }],
          root,
        }),
      ).rejects.toThrowError(/cannot be downgraded/)
      await expect(
        engine.submitReview({
          chapter: 1,
          amend_issues: [{ id: 'REV-001', status: 'waived' }],
          root,
        }),
      ).rejects.toThrowError(/cannot be waived/)
      await expect(
        engine.submitReview({
          chapter: 1,
          amend_issues: [{ id: 'REV-001', location: '第 999 段' }],
          root,
        }),
      ).rejects.toThrowError(/outside the chapter/)
      const amended = await engine.submitReview({
        chapter: 1,
        amend_issues: [{ id: 'REV-001', problem: '改写后的问题' }],
        root,
      })
      expect(amended.data.amended).toEqual(['REV-001'])
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.14 restore guards and baseline reset', () => {
  it('refuses mixed ledger/chapter restore paths and a lower next_seq', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await mkdir(join(root, 'state'), { recursive: true })
      const backups = (await engine.queryState({ kind: 'backups', root })).data as {
        backups: Array<{ name: string; files: string[] }>
      }
      const txid = backups.backups[0]?.name ?? '00000000-0000-4000-8000-000000000000'
      await expect(
        engine.restoreBackup({
          txid,
          paths: ['state/foreshadows.yaml', 'state/handoff.yaml'],
          chapter: 1,
          root,
        }),
      ).rejects.toThrow()
      await expect(
        engine.restoreBackup({
          txid,
          paths: ['state/foreshadows.yaml', 'chapters/chapter-001.md'],
          root,
        }),
      ).rejects.toThrow(/mixes ledger files/)
    } finally {
      await cleanup()
    }
  })

  it('reset clears the baseline file entries', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.doctor({ baseline: true, root })
      await engine.doctor({ reset: true, root })
      const baseline = (await import('node:fs/promises')).readFile(
        join(root, 'state/doctor-baseline.yaml'),
        'utf8',
      )
      expect(await baseline).toContain('entries: []')
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.14 reading-proof reference guards', () => {
  const text =
    '风从窗缝里挤进来，把桌上一盏灯吹得发晃。\n\n他拆开信封，读到第三行才停。\n\n窗外天色暗下来，路灯亮了。'
  it('rejects malformed references without throwing', () => {
    expect(checkReference(text, null as never).problem).toContain('not an object')
    expect(checkReference(text, { paragraph: 1, quote: 42 as never }).problem).toContain('not text')
    expect(checkReference(text, { paragraph: 0, quote: '风从窗缝里挤进来' }).problem).toContain(
      'positive integer',
    )
    expect(checkReference(text, { paragraph: 1, quote: '短' }).problem).toContain('shorter than')
    const missing = checkReference('', { paragraph: 1, quote: '风从窗缝里挤进来' })
    expect(missing.problem).toContain('does not appear')
    expect(missing.problem).not.toContain('nearest paragraph')
    expect(verifyReference(text, { paragraph: 1, quote: '风从窗缝里挤进来' })).toBeNull()
  })

  it('reports each PG-09 boundary violation', () => {
    const paragraphs = text.split(/\n+/)
    const gate = (proof: unknown) =>
      evaluateGates(
        {
          operation: 'submitReview',
          stage: 'P4',
          text,
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
          pipeline: {
            schema_version: 1,
            revision: 1,
            chapter: 1,
            stage: 'P4',
            rounds: { review: 1, revise: 0, check: 0 },
            briefs: {},
            blocking: [],
            review_digest: null,
            last_action: null,
          },
          chapters: { schema_version: 1, chapters: [] },
          briefDigest: null,
          briefStage: null,
          draftTitle: '开端之雨',
          sceneType: '日常过渡章',
          summary: sampleSummary(),
          review: null,
          check: null,
          semantic: [],
          proof: proof as never,
          rounds: { review: 1, revise: 0, check: 0 },
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
          priorSceneTypes: [],
        } as never,
        { rulepack, minScore: 120 },
      )
    const problems = (proof: unknown) =>
      gate(proof)
        .blocking.filter((item) => item.code === 'PG-09')
        .map((item) => item.detail)
        .join('; ')
    expect(problems(null)).toContain('no reading proof supplied')
    expect(problems({ opening: {}, middle: {}, ending: {} })).toContain(
      'opening/middle/ending quote references',
    )
    const base = {
      opening: { paragraph: 1, quote: paragraphs[0]!.slice(0, 12) },
      middle: { paragraph: 3, quote: paragraphs[1]!.slice(0, 12) },
      ending: { paragraph: 1, quote: paragraphs[2]!.slice(0, 12) },
    }
    expect(problems({ ...base, opening: { paragraph: 3, quote: paragraphs[2]!.slice(0, 12) } })).toContain(
      'opening quote',
    )
    expect(problems({ ...base, ending: { paragraph: 1, quote: paragraphs[0]!.slice(0, 12) } })).toContain(
      'ending quote',
    )
    // The middle quote from the opening paragraph is not interior.
    expect(
      problems({
        ...base,
        middle: { paragraph: 1, quote: paragraphs[0]!.slice(0, 12) },
      }),
    ).toContain('middle quote')
  })
})

describe('0.2.14 delta validation matrix', () => {
  const emptyChars = (): CharactersDocument => ({ schema_version: 1, characters: [] })
  const baseDelta = (patch: Partial<StateDelta> = {}): StateDelta => ({
    characters: { 他: { action: 'created' } },
    foreshadows: {},
    timeline: { '0': { action: 'created' } },
    world: {},
    relationships: {},
    ...patch,
  })
  const run = (delta: StateDelta, patch: Record<string, unknown> = {}) =>
    applyStateDelta({
      chapter: 2,
      text: '他把钱收进袋里，数了两遍。',
      summary: sampleSummary(),
      delta,
      characters: emptyChars(),
      world: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
      locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
      ...patch,
    } as never)
  const rejects = (delta: StateDelta, pattern: RegExp, patch: Record<string, unknown> = {}) =>
    expect(() => run(delta, patch)).toThrowError(pattern)

  it('rejects malformed resource containers and names', () => {
    rejects(
      baseDelta({ characters: { 他: { action: 'created', current_state: { resources: 'money' } } } }),
      /resources must be an object/,
    )
    rejects(
      baseDelta({ characters: { 他: { action: 'created', current_state: { resources: [] } } } }),
      /resources must be an object/,
    )
    rejects(
      baseDelta({ characters: { 他: { action: 'created', current_state: { resources: { 钱: '1' } } } } }),
      /must be an integer/,
    )
    rejects(baseDelta({ characters: { 他: null as never } }), /must be an object/)
    rejects(baseDelta({ characters: { 他: [] as never } }), /must be an object/)
    rejects(
      baseDelta({ characters: { 他: { action: 'created', name: '别人' } as never } }),
      /does not match its key/,
    )
    rejects(baseDelta({ characters: { 他: { action: 'deleted' as never } } }), /must declare action/)
  })

  it('rejects malformed foreshadow fields', () => {
    const plant = (patch: Record<string, unknown>) =>
      baseDelta({
        foreshadows: {
          'FS-A': { action: 'created', anchor: '他把钱收进袋里，数了两遍。', ...patch } as never,
        },
      })
    rejects(plant({ description: 42 }), /description must be a string/)
    rejects(plant({ note: 42 }), /note must be a string/)
    rejects(plant({ new_info: 'yes' }), /new_info must be a boolean/)
    rejects(plant({ planned_resolve: 0 }), /planned_resolve must be a positive integer/)
    rejects(plant({ resolved_anchor: '短' }), /resolved_anchor must be a verbatim quote/)
    rejects(plant({ kind: 'other' }), /kind must be plot|motif/)
    rejects(plant({ title: 42 }), /title must be a string/)
  })

  it('rejects malformed world, timeline and relationship fields', () => {
    rejects(
      baseDelta({ world: { 旧宅: { action: 'created', kind: 'castle' } as never } }),
      /unknown kind|must declare kind/,
      { text: '他走进旧宅，把账本放在桌上。' },
    )
    rejects(
      baseDelta({ world: { 旧宅: { action: 'created', kind: 'location', capacity: 'many' } as never } }),
      /capacity must be/,
      { text: '他走进旧宅，把账本放在桌上。' },
    )
    rejects(
      baseDelta({ timeline: { '0': { action: 'created', characters: '他' } as never } }),
      /characters must be a string array/,
    )
    rejects(
      baseDelta({
        relationships: { '甲|乙': { action: 'created', type: '同事', type_code: 'unknown' } as never },
      }),
      /not declared in characters/,
    )
  })

  it('rejects malformed summary containers', () => {
    const summary = { ...sampleSummary(), new_elements: 'x' as never }
    expect(() =>
      applyStateDelta({
        chapter: 2,
        text: '正文',
        summary,
        delta: baseDelta(),
        characters: emptyChars(),
        world: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
        locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
        foreshadows: { schema_version: 1, next_seq: 1, items: [] },
        timeline: { schema_version: 1, next_seq: 1, items: [] },
        relationships: { schema_version: 1, next_seq: 1, items: [] },
      } as never),
    ).toThrowError(/new_elements/)
  })

  it('fills an absent base resource map and allows an explicit name echo', () => {
    const characters = emptyChars()
    characters.characters.push({
      name: '他',
      role: 'protagonist',
      first_appearance: 1,
      profile: {},
      current_state: {},
      growth: [],
      updated_at: 1,
    })
    const result = run(
      baseDelta({
        characters: {
          他: { action: 'updated', name: '他', current_state: { resources: { 钱: 3 } } } as never,
        },
      }),
      { characters },
    )
    const row = result.characters.characters[0]!
    expect(row.current_state.resources).toEqual({ 钱: 3 })
  })
})

describe('0.2.14 delta container guards', () => {
  const chars = (): CharactersDocument => ({ schema_version: 1, characters: [] })
  const runRaw = (delta: unknown, summary: unknown, text = '他把钱收进袋里，数了两遍。') =>
    applyStateDelta({
      chapter: 2,
      text,
      summary,
      delta,
      characters: chars(),
      world: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
      locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
    } as never)
  const base = () => ({
    characters: { 他: { action: 'created' } },
    foreshadows: {},
    timeline: { '0': { action: 'created' } },
    world: {},
    relationships: {},
  })

  it('rejects missing/unknown sections and malformed summary blocks', () => {
    const missingTimeline = base()
    delete (missingTimeline as { timeline?: unknown }).timeline
    expect(() => runRaw(missingTimeline, sampleSummary())).toThrowError(/missing section/)
    expect(() => runRaw({ ...base(), extra: {} }, sampleSummary())).toThrowError(/unknown section/)
    expect(() => runRaw(base(), { ...sampleSummary(), new_elements: { locations: 'x' } })).toThrowError(
      /new_elements/,
    )
    expect(() => runRaw(base(), { ...sampleSummary(), resource_changes: 'x' })).toThrowError(
      /resource_changes/,
    )
    expect(() => runRaw(base(), { ...sampleSummary(), foreshadows: [] })).toThrowError(/foreshadows/)
  })

  it('rejects undeclared appearances and malformed character fields', () => {
    expect(() =>
      runRaw(
        { ...base(), characters: { 他: { action: 'created' } } },
        {
          ...sampleSummary(),
          characters_appeared: [],
        },
      ),
    ).toThrowError(/appeared|characters/)
    expect(() =>
      runRaw(
        { ...base(), characters: { 他: { action: 'created', growth: { change: '', status_change: 'x' } } } },
        sampleSummary(),
      ),
    ).toThrowError(/growth/)
    expect(() =>
      runRaw({ ...base(), characters: { 他: { action: 'created', profile: 'x' } } }, sampleSummary()),
    ).toThrowError(/profile/)
    expect(() =>
      runRaw({ ...base(), characters: { 他: { action: 'created', role: 3 } } }, sampleSummary()),
    ).toThrowError(/role/)
    expect(() =>
      runRaw({ ...base(), characters: { 他: { action: 'created', current_state: null } } }, sampleSummary()),
    ).toThrowError(/current_state/)
  })

  it('rejects unknown timeline keys and updates before creation', () => {
    expect(() =>
      runRaw({ ...base(), timeline: { '99': { action: 'updated' } } }, sampleSummary()),
    ).toThrowError(/timeline/)
    expect(() =>
      runRaw({ ...base(), relationships: { '他|他': { action: 'updated', note: 'x' } } }, sampleSummary()),
    ).toThrowError(/relationships/)
  })

  it('rejects a created world entity absent from the manuscript', () => {
    expect(() =>
      runRaw(
        { ...base(), world: { 旧宅: { action: 'created', kind: 'location' } } },
        sampleSummary(),
        '他把钱收进袋里。',
      ),
    ).toThrowError(/old|旧宅|manuscript|summary/)
  })
})

describe('0.2.14 PG-08 evidence guards', () => {
  const text =
    '风从窗缝里挤进来，把桌上一盏灯吹得发晃。\n\n他拆开信封，读到第三行才停。\n\n窗外天色暗下来，路灯亮了。'
  const gate = (issues: unknown[]) =>
    evaluateGates(
      {
        operation: 'submitRevision',
        stage: 'P5',
        text,
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
        pipeline: {
          schema_version: 1,
          revision: 1,
          chapter: 1,
          stage: 'P5',
          rounds: { review: 1, revise: 1, check: 0 },
          briefs: {},
          blocking: [],
          review_digest: null,
          last_action: null,
        },
        chapters: { schema_version: 1, chapters: [] },
        briefDigest: null,
        briefStage: null,
        draftTitle: '开端之雨',
        sceneType: '日常过渡章',
        summary: sampleSummary(),
        review: {
          schema_version: 1,
          chapter: 1,
          round: 1,
          content_hash: 'sha256:x',
          dimensions: [],
          issues,
          total: 150,
          proof: {
            opening: { paragraph: 1, quote: '风从窗缝里挤进来' },
            middle: { paragraph: 2, quote: '他拆开信封，读到第三行才停' },
            ending: { paragraph: 3, quote: '窗外天色暗下来' },
          },
        } as never,
        check: null,
        semantic: [],
        proof: {
          opening: { paragraph: 1, quote: '风从窗缝里挤进来' },
          middle: { paragraph: 2, quote: '他拆开信封，读到第三行才停' },
          ending: { paragraph: 3, quote: '窗外天色暗下来' },
        },
        rounds: { review: 1, revise: 1, check: 0 },
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
        priorSceneTypes: [],
      } as never,
      { rulepack, minScore: 120 },
    )
  const detail = (issue: Record<string, unknown>) =>
    gate([issue])
      .blocking.filter((item) => item.code === 'PG-08')
      .map((item) => item.detail)
      .join('; ')

  it('names every blocker-repair failure', () => {
    const base = {
      id: 'REV-001',
      severity: 'blocker',
      dimension: 'R-W-01',
      location: '第 2 段',
      problem: '缺动机',
      fix: '补理由',
      status: 'open',
    }
    expect(detail(base)).toContain('still open')
    expect(detail({ ...base, status: 'waived' })).toContain('cannot be waived')
    expect(detail({ ...base, status: 'fixed' })).toContain('no evidence quote')
    expect(detail({ ...base, status: 'fixed', evidence: '短' })).toContain('shorter than 8')
    const missing = gate([
      { ...base, status: 'fixed', evidence: '风从窗缝里挤进来' },
      { ...base, id: 'REV-002', status: 'fixed', evidence: '正文里没有的一句话' },
    ]).blocking.find((item) => item.code === 'PG-08')
    expect(missing?.detail).toContain('not in the text')
    expect(missing?.details?.nearest).toBeDefined()
  })
})

describe('0.2.14 restore and review stage guards', () => {
  it('refuses ledger restore with a chapter, invalid content, or a lower next_seq', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const backups = (await engine.queryState({ kind: 'backups', root })).data as {
        backups: Array<{ name: string; files: string[] }>
      }
      const txid = backups.backups.find((entry) => entry.files.includes('state/foreshadows.yaml'))!.name
      await expect(
        engine.restoreBackup({ txid, chapter: 1, paths: ['state/foreshadows.yaml'], root }),
      ).rejects.toThrowError(/does not accept a chapter/)
      await expect(
        engine.restoreBackup({ txid, paths: ['state/foreshadows.yaml'], root }),
      ).resolves.toBeDefined()
    } finally {
      await cleanup()
    }
  })

  it('rejects review amendments before a review and at a write stage', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.rollback({ chapter: 1, toStage: 'P3', reason: 'drop back to drafting', root })
      await expect(
        engine.submitReview({ chapter: 1, amend_issues: [{ id: 'REV-1', status: 'fixed' }], root }),
      ).rejects.toThrowError(/not allowed at stage/)
    } finally {
      await cleanup()
    }
  })

  it('reports a scalar-state info row for deadline-like keys', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const characters = (await engine.queryState({ kind: 'characters', root })).data as {
        schema_version: 1
        characters: Array<Record<string, unknown>>
      }
      const first = characters.characters[0]!
      await engine.amend({
        path: 'state/characters.yaml',
        content: {
          ...characters,
          characters: [
            { ...first, current_state: { ...(first.current_state as object), deadline: '第 3 章前' } },
          ],
        },
        reason: 'seed a deadline scalar',
        root,
      })
      const doctor = await engine.doctor({ root })
      expect(doctor.data.checks).toContainEqual(
        expect.objectContaining({ id: 'scalar-state', severity: 'info' }),
      )
    } finally {
      await cleanup()
    }
  })

  it('reports the action-pair PG-06 warning when a card pins it', () => {
    const text = '风从窗缝里挤进来，把桌上一盏灯吹得发晃。'
    const gate = evaluateGates(
      {
        operation: 'submitDraft',
        stage: 'P3',
        text,
        chapter: 3,
        project: {
          schema_version: 1,
          title: '测试',
          genre: '都市现代',
          platform: 'fanqie',
          author: '',
          description: '',
          created_at: '2026-01-01',
          targets: { words_per_chapter: [8, 400], total_chapters: 10, dialogue_ratio: [0.1, 0.9] },
        },
        pipeline: {
          schema_version: 1,
          revision: 1,
          chapter: 3,
          stage: 'P3',
          rounds: { review: 0, revise: 0, check: 0 },
          briefs: {},
          blocking: [],
          review_digest: null,
          last_action: null,
        },
        chapters: { schema_version: 1, chapters: [] },
        briefDigest: null,
        briefStage: null,
        draftTitle: '开端之雨',
        sceneType: '战斗/动作章',
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
        priorSceneTypes: ['日常过渡章', '战斗/动作章'],
        outline: {
          schema_version: 1,
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
              num: 3,
              volume: null,
              title: '开端之雨',
              scene_type: '战斗/动作章',
              goal: '',
              conflict: '',
              hook: '',
              cast: [],
              target_words: [8, 400],
              notes: '',
              status: 'planned',
              archived_at: null,
              word_count: null,
              score: null,
            },
          ],
        },
      } as never,
      { rulepack, minScore: 120 },
    )
    expect(gate.blocking.some((item) => item.code === 'PG-06')).toBe(false)
    expect(gate.warnings.map((warning) => warning.code)).toContain('PG-06_CARD_WINS')
  })
})

describe('0.2.14 acknowledgement expiry and baseline merge', () => {
  it('lets an acknowledgement expire at a chapter boundary', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = `${cleanText()}\n\n账本一：2 × 3 = 7。\n\n账本二：4 × 5 = 19。`
      await bootstrapToDraft({ root, engine })
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      await engine.getBrief({ stage: 'P6', root })
      const first = await engine.runCheck({
        chapter: 1,
        scope: ['content'],
        semantic: sampleSemanticOf(text),
        root,
      })
      const instance = first.data.advisory_instances[0]!
      await engine.getBrief({ stage: 'P6', root })
      const instanceId = instance.id
      const expired = await engine.runCheck({
        chapter: 1,
        semantic: sampleSemanticOf(text),
        acknowledge: [instanceId],
        acknowledge_reasons: { [instanceId]: '已知的重复算式' },
        acknowledge_until_chapter: 0,
        root,
      })
      expect(expired.data.acknowledged_findings).toHaveLength(1)
      // The waiver expired before this chapter, so the finding is still counted.
      expect(expired.data.advisory_instances.length).toBe(first.data.advisory_instances.length)
    } finally {
      await cleanup()
    }
  })

  it('merges a second baseline capture instead of replacing it', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.doctor({ baseline: true, root })
      await engine.doctor({ baseline: true, root })
      const baseline = await readFile(join(root, 'state/doctor-baseline.yaml'), 'utf8')
      expect(baseline).toContain('entries:')
    } finally {
      await cleanup()
    }
  })
})

function sampleSemanticOf(text: string) {
  const sentences = text
    .split(/[。！？\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => Array.from(sentence).length >= 8)
  const ids = ['L2-SCENE-ANCHOR', 'L2-CHARACTER-STATE', 'L2-CAUSALITY', 'L2-VOICE', 'L2-POV'] as const
  return ids.map((id, index) => ({
    id,
    verdict: 'pass' as const,
    evidence: sentences[index] ?? sentences[index % sentences.length]!,
    note: '已核对',
  }))
}

describe('0.2.14 numeric approximation and dimension skips', () => {
  const codes = (text: string) => machine(text).violations.map((violation) => violation.code)
  it('skips approximate prefixes, approximate words and unit mismatches', () => {
    expect(codes('大约三个人每人五块，一共二十块。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codes('近五个人每人五块，一共二十块。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codes('三个人每人五块，一共二十斤。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codes('2 元 × 3 = 7 斤。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codes('三五个人，每人五块，一共二十块。')).not.toContain('NUMERIC_CONTRADICTION')
  })

  it('groups several format blocker codes into one PG-04 row', () => {
    const text = '“引号”错了；还有分号。\n\n## 标题\n\n' + '长'.repeat(120)
    const result = evaluateGates(
      {
        operation: 'submitDraft',
        stage: 'P3',
        text,
        chapter: 1,
        project: {
          schema_version: 1,
          title: '测试',
          genre: '都市现代',
          platform: 'fanqie',
          author: '',
          description: '',
          created_at: '2026-01-01',
          targets: { words_per_chapter: [8, 400], total_chapters: 10, dialogue_ratio: [0.1, 0.9] },
        },
        pipeline: {
          schema_version: 1,
          revision: 1,
          chapter: 1,
          stage: 'P3',
          rounds: { review: 0, revise: 0, check: 0 },
          briefs: {},
          blocking: [],
          review_digest: null,
          last_action: null,
        },
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
        priorSceneTypes: [],
      } as never,
      { rulepack, minScore: 120 },
    )
    const format = result.blocking.find((item) => item.code === 'PG-04')
    expect(format).toBeDefined()
    expect(format!.detail).toMatch(/×\d+/)
    expect(format!.details?.candidates?.length).toBeGreaterThan(0)
  })
})

describe('0.2.14 context error passthrough', () => {
  it('passes outline/worldbook/world-plan errors into the pack', () => {
    const context = briefContext({
      stage: 'P2',
      chapter: 2,
      project: {
        schema_version: 1,
        title: '错误之书',
        genre: '都市现代',
        platform: 'fanqie',
        author: '',
        description: '',
        created_at: '2026-01-01',
        targets: { words_per_chapter: [200, 400], total_chapters: 10, dialogue_ratio: [0.2, 0.4] },
      },
      pipeline: {
        schema_version: 1,
        revision: 1,
        chapter: 2,
        stage: 'P2',
        rounds: { review: 0, revise: 0, check: 0 },
        briefs: {},
        blocking: [],
        last_action: null,
      },
      chapters: { schema_version: 1, chapters: [] },
      characters: { schema_version: 1, characters: [] },
      world: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
      locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
      plan: null,
      review: null,
      check: null,
      text: null,
      previousText: null,
      handoff: null,
      outline_error: 'outline is broken',
      worldbook_error: 'worldbook is broken',
      world_plan_error: 'world plan is broken',
    })
    expect(context).toMatchObject({
      outline_error: 'outline is broken',
      worldbook_error: 'worldbook is broken',
      world_plan_error: 'world plan is broken',
    })
  })
})

describe('0.2.14 status dialogue verdict by metric', () => {
  it('reports line_out, pass and skewed through novel_status', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const dialogue = [
        '"风从窗缝里挤进来，把桌上的灯吹得发晃。"',
        ...Array.from({ length: 17 }, () => '"好。"'),
      ].join('\n')
      const narration = Array.from({ length: 2 }, () => '他走过长街，看见灯一盏一盏亮起来。').join('\n')
      await writeDraft({ root, engine, text: `${dialogue}\n${narration}` })
      const novel = parse(await readFile(join(root, 'novel.yaml'), 'utf8')) as {
        targets: Record<string, unknown>
      }
      const setMetric = async (metric: 'lines' | 'chars' | 'both') =>
        engine.amend({
          path: 'novel.yaml',
          content: { targets: { ...novel.targets, dialogue_ratio_metric: metric } },
          reason: `metric ${metric}`,
          root,
        })
      await setMetric('lines')
      expect((await engine.getStatus({ root })).data.dialogue).toMatchObject({
        metric: 'lines',
        verdict: 'line_out',
      })
      await setMetric('chars')
      expect((await engine.getStatus({ root })).data.dialogue).toMatchObject({
        metric: 'chars',
        verdict: 'pass',
      })
      await setMetric('both')
      expect((await engine.getStatus({ root })).data.dialogue).toMatchObject({
        metric: 'both',
        verdict: 'skewed',
      })
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.14 numeric facts and receipt bounds', () => {
  it('reads 一米八五 as 1.85 metres instead of leaving the fact unused', () => {
    // Two trailing decimals ("一八五") used to fail the lookahead, so the fact
    // was declared but never matched and the advisory said it was unused (X10).
    const fact = { alias: '身高', value: 1.85, unit: '米' }
    expect(hasNumericFactMatch('他身高一米八五，站在门口。', fact)).toBe(true)
    expect(hasNumericFactMatch('他身高一米八，站在门口。', fact)).toBe(true)
    // Mixed script: `1米85` is the same claim and was reported as an unused
    // fact because the decimal tail only accepted Chinese digits (A14).
    expect(hasNumericFactMatch('他身高1米85，站在门口。', fact)).toBe(true)
    expect(hasNumericFactMatch('他身高1米8，站在门口。', fact)).toBe(true)
    expect(hasNumericFactMatch('他走了三米。', fact)).toBe(false)
    // A different unit is not a match; converting inches is out of scope.
    expect(hasNumericFactMatch('他身高185cm，站在门口。', fact)).toBe(false)
    const findings = machine('他身高一米八五，站在门口。', {
      facts: [{ alias: '身高', value: 1.85, unit: '米' }],
    })
    expect(findings.numeric.facts_unused).toBe(0)
    expect(findings.violations.map((violation) => violation.code)).not.toContain('NUMERIC_FACTS_UNUSED')
  })

  it('carries an unexpired waiver forward and drops an expired one', () => {
    const findings = [
      { id: 'A', code: 'NUMERIC_FACTS_UNUSED', reason: 'r', at: 't', expires_at_chapter: 5 },
      { id: 'B', code: 'PLEASURE_DENSITY', reason: 'r', at: 't', expires_at_chapter: 2 },
      { id: 'C', code: 'LOCKED_DETAIL_DRIFT', reason: 'r', at: 't' },
    ]
    expect(carryAcknowledgements(findings, 3).map((row) => row.id)).toEqual(['A'])
    expect(carryAcknowledgements(findings, 6)).toEqual([])
    expect(carryAcknowledgements(findings, 5).map((row) => row.id)).toEqual(['A'])
  })

  it('names the field and received type for every cast shape problem', () => {
    const notArray = castShapeProblems('oops')
    expect(notArray.messages).toEqual(['cast must be an array'])
    expect(notArray.details).toMatchObject({ field: 'cast', received_type: 'string' })

    const badItem = castShapeProblems([{ name: '他', knowledge: 'not-an-array' }])
    expect(badItem.details).toMatchObject({
      field: 'cast[0].knowledge',
      expected: 'string[]',
      received_type: 'string',
    })

    const badElement = castShapeProblems([{ name: '他', knowledge: ['ok', 7] }])
    expect(badElement.details).toMatchObject({
      field: 'cast[0].knowledge[1]',
      received_type: 'number',
    })

    const missingName = castShapeProblems([{ goal: 'x' }])
    expect(missingName.details).toMatchObject({ field: 'cast[0].name', expected: 'non-empty string' })

    const duplicate = castShapeProblems([{ name: '他' }, { name: '他' }])
    expect(duplicate.messages.join(' ')).toContain('duplicate name')

    const wrongField = castShapeProblems([{ name: '他', goal: 3 }])
    expect(wrongField.details).toMatchObject({ field: 'cast[0].goal', received_type: 'number' })

    const notObject = castShapeProblems(['x'])
    expect(notObject.details).toMatchObject({ field: 'cast[0]', expected: 'object' })

    expect(castShapeProblems([]).messages).toEqual(['cast must contain 1..8 members'])
  })
})
