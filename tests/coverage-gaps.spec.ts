import { describe, expect, it } from 'vitest'
import { SCORE_DIMENSIONS, applyExclusions, reviewArithmeticProblems } from '../src/domain/scoring.js'
import { TRANSITIONS, nextStage } from '../src/domain/transitions.js'
import { compileRulepack } from '../src/rules/compiler.js'
import { loadRulepack } from '../src/rulepack.js'
import { runMachineChecks, type MachineOptions } from '../src/rules/pipeline.js'
import { createNovelTools } from '../src/tools/index.js'
import type { EngineService } from '../src/engine/service.js'
import type { ScoreDimension } from '../src/types.js'

const pack = loadRulepack()
const options = (): MachineOptions => ({
  chapter: 1,
  title: '第1章 开端之雨',
  genre: '都市现代',
  sceneType: '日常过渡章',
  rulepack: pack,
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
})

describe('transition coverage', () => {
  it('invokes every row of the table', () => {
    for (const transition of TRANSITIONS) {
      expect(
        nextStage(transition.from, transition.op, 0),
        `${transition.from} ${transition.op}`,
      ).toBeDefined()
    }
    expect(nextStage('P4', 'submitReview', 2)).toBe('P5')
  })
})

describe('scoring branches', () => {
  it('reports duplicate dimensions and one-sided exclusions', () => {
    const dimensions: ScoreDimension[] = SCORE_DIMENSIONS.map(({ id, max }) => ({ id, max, deductions: [] }))
    const duplicate = [...dimensions, { id: 'R-W-01', max: 15, deductions: [] }]
    expect(reviewArithmeticProblems(duplicate, 150)).toEqual(
      expect.arrayContaining([expect.stringContaining('duplicate dimension')]),
    )
    const withOne = dimensions.map((dimension, index) =>
      index === 0
        ? { ...dimension, deductions: [{ rule: 'B', location: '第 1 段', delta: 2, note: 'n' }] }
        : dimension,
    )
    expect(applyExclusions(withOne, [{ pair: ['B', 'C'], family: 'f' }]).dropped).toBe(0)
  })
})

describe('rule branches', () => {
  it('ignores a locked location that never appears in the text', () => {
    const result = runMachineChecks('这里没有提到任何地点。', {
      ...options(),
      evidence: {
        ...options().evidence,
        locks: {
          schema_version: 1,
          locked_at_chapter: 1,
          characters: {},
          locations: { 废弃车站: { first_appearance: 1, locked_at: 1, layout: '铁轨', capacity: 1 } },
        },
      },
    })
    expect(result.violations.map((violation) => violation.code)).not.toContain('LOCKED_DETAIL_DRIFT')
  })

  it('rejects malformed optional blocks during normalization', () => {
    const base = () => structuredClone(loadRulepack()) as unknown as Record<string, any>
    const nameNumber = base()
    nameNumber.name = 42
    expect(() => compileRulepack(nameNumber)).toThrow(/non-empty string/)
    const dimensionsObject = base()
    dimensionsObject.quality.dimensions = {}
    expect(() => compileRulepack(dimensionsObject)).toThrow(/must be an array/)
    const lexiconObject = base()
    lexiconObject.lexicon.soft = 'nope'
    expect(() => compileRulepack(lexiconObject)).toThrow(/must be an array/)
    const badTitle = base()
    badTitle.format.title.min_chars = 'x'
    expect(() => compileRulepack(badTitle)).toThrow(/must be a number/)
  })
})

describe('adapter optional-argument branches', () => {
  it('accepts required-only arguments for every tool', async () => {
    const result = <T>(data: T) => ({ data, revision: 1, warnings: [] })
    const engine = {
      withSignal: async (_signal: unknown, task: () => Promise<unknown>) => task(),
      initProject: async () => result({}),
      getStatus: async () => result({}),
      getBrief: async () => result({}),
      submitWorldPlan: async () => result({}),
      submitChapterPlan: async () => result({}),
      submitDraft: async () => result({}),
      submitReview: async () => result({}),
      submitRevision: async () => result({}),
      runCheck: async () => result({}),
      archiveChapter: async () => result({}),
      countWords: async () => result({}),
      queryState: async () => result({}),
      amend: async () => result({}),
      rollback: async () => result({}),
      diff: async () => result({}),
      export: async () => result({}),
      auditHistory: async () => result({}),
      advise: async () => result({}),
      submitBookPlan: async () => result({}),
      submitOutline: async () => result({}),
      importOutline: async () => result({}),
      submitWorldbook: async () => result({}),
      search: async () => result({}),
      doctor: async () => result({}),
      report: async () => result({}),
      guide: async () => result({}),
      reopenChapter: async () => result({}),
    }
    const tools = new Map(
      createNovelTools(engine as unknown as EngineService).map((tool) => [tool.name, tool]),
    )
    const run = async (name: string, args: unknown): Promise<void> => {
      await (tools.get(name) as unknown as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(
        args,
        {},
      )
    }
    await run('novel_init', { title: 't', genre: '都市现代', platform: 'fanqie' })
    await run('novel_status', {})
    await run('novel_brief', { stage: 'P1' })
    await run('novel_plan_world', { objective: 'o' })
    await run('novel_plan_chapter', {
      title: 't',
      scene_type: '日常过渡章',
      narrator: 'n',
      beats: ['a', 'b', 'c', 'd', 'e'],
      opening: 'o',
      ending: 'e',
      target_words: [100, 200],
    })
    await run('novel_review', { chapter: 1, dimensions: [], total: 150, proof: {} })
    await run('novel_revise', { chapter: 1, content: 'x', proof: {} })
    await run('novel_check', { chapter: 1, semantic: [] })
    await run('novel_word_count', {})
    await run('novel_state', { kind: 'pipeline' })
    await run('novel_rollback', { chapter: 1, to_stage: 'P3' })
    await run('novel_diff', { chapter: 1 })
    await run('novel_export', { kind: 'md' })
    await run('novel_audit', {})
    await run('novel_blueprint', {})
    await run('novel_outline', { chapters: [] })
    await run('novel_outline_import', { format: 'markdown', content: 'x' })
    await run('novel_worldbook', { premise: 'x' })
    await run('novel_search', { query: 'x' })
    await run('novel_doctor', {})
    await run('novel_report', {})
    await run('novel_guide', {})
    await run('novel_reopen', { chapter: 1, reason: 'test' })
    expect(tools.size).toBe(27)
  })
})
