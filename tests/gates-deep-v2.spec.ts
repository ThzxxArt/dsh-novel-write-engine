import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import { loadBible, loadCanon } from '../src/kernel/book/store.js'
import {
  applyPolishPatch,
  applyTaxonomyProfile,
  dimensionMax,
  evaluateArchiveTone,
  evaluateDraftFormat,
  evaluateGates,
  validatePolishPatch,
  type GateInput,
  type GateReport,
} from '../src/kernel/gates/index.js'
import type {
  ChapterPlan,
  ContinuityReport,
  Draft,
  PolishPatch,
  ReviewReport,
} from '../src/contracts/artifacts.js'
import { loadRulepack } from '../src/rulepack.js'
import { countWordMetrics } from '../src/domain/wordcount.js'

const roots: string[] = []

const setup = async (genre?: { major: string; sub: string; tags: string[] }) => {
  const root = mkdtempSync(join(tmpdir(), 'gates-deep-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: '门控分支',
    genre: genre ?? {
      major: 'mystery',
      sub: 'mystery.detective',
      tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
    },
    audience: 'general',
    platform: 'fanqie',
    targets: { total_chapters: 3, words_per_chapter: [2200, 3200], min_cjk_chars: 2000 },
  })
  return loadProjectV2(root)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const planFor = (chapter = 1): ChapterPlan => ({
  schema_version: 2,
  kind: 'ChapterPlan',
  chapter,
  title: '第1章 风起云涌',
  scene_type: '日常过渡章',
  pov: '第三人称',
  cast: ['林砚'],
  goal: '查清契纸来历',
  conflict: '来人不肯交底',
  turn: '落款被刮去',
  outcome: '去城南查证',
  target_words: 2400,
  hook: '门外传来三声敲击',
  foreshadows: [],
  notes: [],
  citations: [],
  open_questions: [],
})

const filler = '雨落在石阶上，街面浮起一层薄光。'
const buildContent = (plan: ChapterPlan): string => {
  const sentences = [
    plan.hook,
    plan.goal,
    plan.conflict,
    plan.turn,
    plan.outcome,
    ...Array.from({ length: 400 }, () => filler),
  ]
  const paragraphs: string[] = []
  for (let index = 0; index < sentences.length; index += 3) {
    paragraphs.push(sentences.slice(index, index + 3).join(''))
  }
  return paragraphs.join('\n\n')
}

const draftFor = (plan: ChapterPlan, overrides: Partial<Draft> = {}): Draft => {
  const content = overrides.content ?? buildContent(plan)
  const metrics = countWordMetrics(content)
  return {
    schema_version: 2,
    kind: 'Draft',
    chapter: 1,
    title: plan.title,
    scene_type: plan.scene_type,
    narrator: plan.pov,
    content,
    citations: [],
    open_questions: [],
    base_artifact_id: null,
    expected_hash: null,
    ...overrides,
    summary: {
      events: ['契纸出现'],
      characters_appeared: ['林砚'],
      foreshadows: { planted: [], advanced: [], resolved: [] },
      new_elements: { locations: [], abilities: [], artifacts: [] },
      resource_changes: [],
      opening: content.slice(0, 20),
      continuity: { opens_from: '', ends_with: '' },
      hook_strength: 4,
      pleasure_points: [],
      plot_advancement: 'mid',
      ...overrides.summary,
    },
    self_check: {
      word_count: metrics.total_word_count,
      cjk_chars: metrics.cjk_chars,
      scene_contract: {
        goal: plan.goal,
        conflict: plan.conflict,
        turn: plan.turn,
        outcome: plan.outcome,
      },
      ...overrides.self_check,
    },
  }
}

const dimensions = (role: ReviewReport['role']): ReviewReport['dimensions'] =>
  role === 'critic-story'
    ? [
        { id: 'R-W-04', max: 20, deductions: [] },
        { id: 'R-W-05', max: 15, deductions: [] },
        { id: 'R-W-12', max: 20, deductions: [] },
      ]
    : role === 'critic-character'
      ? [
          { id: 'R-W-01', max: 15, deductions: [] },
          { id: 'R-W-02', max: 10, deductions: [] },
          { id: 'R-W-03', max: 10, deductions: [] },
        ]
      : [
          { id: 'R-W-06', max: 4, deductions: [] },
          { id: 'R-W-07', max: 4, deductions: [] },
          { id: 'R-W-08', max: 4, deductions: [] },
          { id: 'R-W-09', max: 2, deductions: [] },
          { id: 'R-W-10', max: 1, deductions: [] },
          { id: 'R-W-11', max: 10, deductions: [] },
          { id: 'R-W-13', max: 15, deductions: [] },
          { id: 'R-W-14', max: 10, deductions: [] },
          { id: 'R-W-15', max: 10, deductions: [] },
        ]

const reviewFor = (role: ReviewReport['role'], draft: Draft, hash: string): ReviewReport => {
  const sentences = draft.content.split(/[。！？]/u).filter((row) => row.trim() !== '')
  const dims = dimensions(role)
  return {
    schema_version: 2,
    kind: 'ReviewReport',
    chapter: 1,
    role,
    base_hash: hash,
    findings: [],
    dimensions: dims,
    total: dims.reduce((total, dimension) => total + dimension.max, 0),
    proof: {
      opening: { sourcePath: 'draft', sourceHash: hash, quote: sentences[0]!.slice(0, 12), location: '开头' },
      middle: {
        sourcePath: 'draft',
        sourceHash: hash,
        quote: sentences[Math.floor(sentences.length / 2)]!.slice(0, 12),
        location: '中段',
      },
      ending: {
        sourcePath: 'draft',
        sourceHash: hash,
        quote: sentences[sentences.length - 1]!.slice(-12),
        location: '结尾',
      },
    },
    confidence: 1,
    open_questions: [],
  }
}

const continuityFor = (hash: string): ContinuityReport => ({
  schema_version: 2,
  kind: 'ContinuityReport',
  chapter: 1,
  base_hash: hash,
  findings: [],
  canon_conflicts: [],
  confidence: 1,
  citations: [],
  open_questions: [],
})

const baseInput = async (project: Awaited<ReturnType<typeof setup>>): Promise<GateInput> => {
  const plan = planFor()
  const draft = draftFor(plan)
  const hash = 'hash-1'
  return {
    project,
    chapter: 1,
    plan,
    draft,
    draftHash: hash,
    reviews: [
      reviewFor('critic-story', draft, hash),
      reviewFor('critic-character', draft, hash),
      reviewFor('critic-prose', draft, hash),
    ],
    continuity: continuityFor(hash),
    canon: await loadCanon(project.store),
    bible: await loadBible(project.store),
    previousTexts: [],
    round: 1,
    maxRounds: 3,
  }
}

const verdict = (report: GateReport, code: string) =>
  report.findings.find((finding) => finding.code === code)?.verdict

describe('gate branches', () => {
  it('passes a clean chapter and applies taxonomy profiles', async () => {
    const project = await setup()
    const input = await baseInput(project)
    const report = evaluateGates(input)
    expect(report.pass).toBe(true)
    expect(report.score).toBe(150)
    expect(report.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(['PG-01', 'PG-13', 'EG-01', 'EG-08']),
    )
    const profiled = await setup({
      major: 'fantasy',
      sub: 'fantasy.xianxia',
      tags: ['world.eastern_cultivation', 'plot.progression', 'tone.hot_blooded', 'pace.fast'],
    })
    const pack = applyTaxonomyProfile(profiled, loadRulepack())
    expect(pack.format.paragraph_max_words).toBe(90)
    expect(pack.crosschapter.foreshadow_min_dormancy).toBe(2)
    expect(pack.lexicon.soft.some((entry) => entry.term === '灵气')).toBe(true)
  })

  it('fails structural, word, format and alignment gates', async () => {
    const project = await setup()
    const input = await baseInput(project)
    input.plan = { ...input.plan, chapter: 2 }
    expect(verdict(evaluateGates(input), 'PG-01')).toBe('fail')
    input.plan = planFor()
    input.draft = { ...input.draft, content: '太短。' }
    expect(verdict(evaluateGates(input), 'PG-03')).toBe('fail')
    input.draft = draftFor(input.plan, {
      content: `${buildContent(input.plan)}\n\n**加粗**`,
    })
    expect(verdict(evaluateGates(input), 'PG-04')).toBe('fail')
    input.draft = draftFor(input.plan, { title: '另一个标题' })
    expect(verdict(evaluateGates(input), 'PG-13')).toBe('fail')
    input.draft = draftFor(input.plan, { content: `${filler.repeat(200)}` })
    expect(verdict(evaluateGates(input), 'PG-13')).toBe('fail')
  })

  it('fails scene, summary, POV and hook branches', async () => {
    const project = await setup()
    const input = await baseInput(project)
    input.draft = draftFor(input.plan, {
      scene_type: '战斗/动作章',
      self_check: {
        ...input.draft.self_check,
        scene_contract: { goal: '', conflict: '', turn: '', outcome: '' },
      },
    })
    expect(verdict(evaluateGates(input), 'PG-06')).toBe('fail')
    expect(verdict(evaluateGates(input), 'EG-02')).toBe('fail')
    input.draft = draftFor(input.plan, {
      summary: { ...input.draft.summary, hook_strength: 1 },
    })
    expect(verdict(evaluateGates(input), 'EG-03')).toBe('advisory')
    input.plan = { ...input.plan, pov: '第一人称' }
    input.draft = draftFor(input.plan, { narrator: '第一人称' })
    expect(verdict(evaluateGates(input), 'EG-05')).toBe('fail')
  })

  it('fails critic ownership, arithmetic and stale proof branches', async () => {
    const project = await setup()
    const input = await baseInput(project)
    input.reviews[0] = {
      ...input.reviews[0]!,
      dimensions: [...input.reviews[0]!.dimensions, { id: 'R-W-01', max: 15, deductions: [] }],
    }
    expect(verdict(evaluateGates(input), 'PG-07')).toBe('fail')
    input.reviews = (await baseInput(project)).reviews
    input.reviews[0] = { ...input.reviews[0]!, base_hash: 'stale' }
    expect(verdict(evaluateGates(input), 'PG-09')).toBe('fail')
    input.reviews = (await baseInput(project)).reviews
    input.reviews = input.reviews.slice(0, 2)
    expect(verdict(evaluateGates(input), 'PG-09')).toBe('fail')
    input.reviews = (await baseInput(project)).reviews
    input.reviews[0] = {
      ...input.reviews[0]!,
      proof: {
        ...input.reviews[0]!.proof,
        opening: { ...input.reviews[0]!.proof.opening, quote: '正文里没有的引文' },
      },
    }
    expect(verdict(evaluateGates(input), 'PG-09')).toBe('fail')
  })

  it('requires blocker evidence in the current draft', async () => {
    const project = await setup()
    const input = await baseInput(project)
    input.reviews[0] = {
      ...input.reviews[0]!,
      findings: [
        {
          id: 'f1',
          dimension: 'R-W-04',
          severity: 'blocker',
          location: '开头',
          evidence: input.draft.content.slice(0, 12),
          problem: '开局拖沓',
          fix: '加快',
          status: 'fixed',
        },
      ],
    }
    expect(verdict(evaluateGates(input), 'PG-08')).toBe('fail')
    input.reviews[0] = {
      ...input.reviews[0]!,
      findings: [
        {
          ...input.reviews[0]!.findings[0]!,
          resolution: input.draft.content.slice(0, 12),
        },
      ],
    }
    expect(verdict(evaluateGates(input), 'PG-08')).toBe('pass')
    input.reviews[0] = {
      ...input.reviews[0]!,
      findings: [{ ...input.reviews[0]!.findings[0]!, resolution: '不存在的修复证据' }],
    }
    expect(verdict(evaluateGates(input), 'PG-08')).toBe('fail')
  })

  it('fails continuity, rounds, canon and AI-tone branches', async () => {
    const project = await setup()
    const input = await baseInput(project)
    input.continuity = null
    expect(verdict(evaluateGates(input), 'PG-10')).toBe('fail')
    input.continuity = { ...continuityFor('hash-1'), canon_conflicts: ['时间线冲突'] }
    expect(verdict(evaluateGates(input), 'PG-10')).toBe('fail')
    input.continuity = continuityFor('hash-1')
    input.round = 4
    expect(verdict(evaluateGates(input), 'PG-11')).toBe('fail')
    input.continuity = {
      ...continuityFor('hash-1'),
      findings: [
        {
          id: 'c1',
          kind: 'canon',
          severity: 'blocker',
          location: '中段',
          evidence: input.draft.content.slice(0, 12),
          problem: '设定冲突',
          fix: '改',
          status: 'open',
        },
      ],
    }
    expect(verdict(evaluateGates(input), 'EG-06')).toBe('fail')
    input.continuity = continuityFor('hash-1')
    input.draft = draftFor(input.plan, {
      content: `${buildContent(input.plan)}\n\n他稳了稳，说：“这句话稳。”`,
    })
    expect(verdict(evaluateGates(input), 'EG-07')).not.toBe('pass')
  })

  it('verifies polish patches instead of trusting them', async () => {
    const project = await setup()
    const input = await baseInput(project)
    const before = input.draft.content.slice(0, 12)
    const patch: PolishPatch = {
      schema_version: 2,
      kind: 'PolishPatch',
      chapter: 1,
      base_hash: 'hash-1',
      expected_hash: 'hash-1',
      patches: [{ anchor: before, before, after: `${before}更紧。`, reason: '收紧' }],
      open_questions: [],
    }
    input.polish = { patch, sourceDraft: input.draft }
    const good = evaluateGates(input)
    expect(verdict(good, 'EG-08')).toBe('fail')
    expect(validatePolishPatch(input.draft, patch)).toEqual([])
    expect(() =>
      validatePolishPatch(input.draft, {
        ...patch,
        patches: [patch.patches[0]!, patch.patches[0]!],
      }),
    ).not.toThrow()
    expect(
      validatePolishPatch(input.draft, {
        ...patch,
        patches: [patch.patches[0]!, patch.patches[0]!],
      }).length,
    ).toBeGreaterThan(0)
  })

  it('applies every taxonomy profile key including lexicon removal', async () => {
    const project = await setup()
    const taxonomy = structuredClone(project.taxonomy) as typeof project.taxonomy
    const sub = taxonomy.subById.get(project.config.genre.sub)!
    sub.profile = {
      ...sub.profile,
      water_words: 0.31,
      pleasure_keywords: ['钱', '账'],
      motif_min_dormancy: 4,
      foreshadow_dormant_after: 8,
      lexicon_remove: ['稳'],
    }
    const tag = taxonomy.tags.find((row) => row.id === project.config.genre.tags[0]!)!
    tag.profile = { ...tag.profile, paragraph_max_words: 88 }
    project.taxonomy = taxonomy
    const pack = applyTaxonomyProfile(project, loadRulepack())
    expect(pack.semantics.water_words.threshold).toBe(0.31)
    expect(pack.semantics.pleasure_density.keywords).toEqual(['钱', '账'])
    expect(pack.crosschapter.motif_min_dormancy).toBe(4)
    expect(pack.crosschapter.foreshadow_dormant_after).toBe(8)
    expect(pack.format.paragraph_max_words).toBe(88)
    expect(pack.lexicon.soft.some((entry) => entry.term === '稳')).toBe(false)
    expect(
      pack.lexicon.ai_tone?.entries.every((entry) => entry.match !== 'exact' || entry.terms.length > 0),
    ).toBe(true)
  })

  it('covers arithmetic, proof, fingerprint and patch rejection branches', async () => {
    const project = await setup()
    const input = await baseInput(project)
    input.draft = draftFor(input.plan, {
      summary: { ...input.draft.summary, opening: '短' },
    })
    expect(verdict(evaluateGates(input), 'PG-05')).toBe('fail')

    input.draft = draftFor(input.plan)
    input.reviews[0] = {
      ...input.reviews[0]!,
      proof: { ...input.reviews[0]!.proof, opening: { ...input.reviews[0]!.proof.opening, quote: '短' } },
    }
    expect(verdict(evaluateGates(input), 'PG-09')).toBe('fail')

    input.reviews = (await baseInput(project)).reviews
    input.reviews[0] = {
      ...input.reviews[0]!,
      dimensions: [
        { id: 'R-W-04', max: 99, deductions: [] },
        { id: 'R-W-05', max: 15, deductions: [{ rule: 'X', location: 'x', delta: 99, note: 'x' }] },
      ],
      total: 1,
      findings: [
        {
          id: 'f1',
          dimension: 'R-W-04',
          severity: 'advisory',
          location: '开头',
          evidence: '短',
          problem: 'p',
          fix: 'f',
          status: 'open',
        },
      ],
    }
    expect(verdict(evaluateGates(input), 'PG-07')).toBe('fail')

    input.bible = {
      ...input.bible,
      fingerprint: { sentence_length: [10, 12], dialogue_ratio: 0.9 },
    }
    input.reviews = (await baseInput(project)).reviews
    input.draft = draftFor(input.plan)
    expect(verdict(evaluateGates(input), 'EG-01')).toBe('advisory')

    input.bible = { ...input.bible, fingerprint: {} }
    input.draft = draftFor(input.plan, {
      content: `${buildContent(input.plan)}\n\n${'我抬头看天。'.repeat(200)}`,
    })
    expect(verdict(evaluateGates(input), 'EG-05')).toBe('fail')

    const before = input.draft.content.slice(0, 12)
    const unsafe: PolishPatch = {
      schema_version: 2,
      kind: 'PolishPatch',
      chapter: 1,
      base_hash: 'h',
      expected_hash: 'h',
      patches: [{ anchor: before, before: 'not-in-draft', after: 'x', reason: 'x' }],
      open_questions: [],
    }
    expect(validatePolishPatch(input.draft, unsafe).length).toBeGreaterThan(0)
    expect(() =>
      evaluateGates({ ...input, polish: { patch: unsafe, sourceDraft: input.draft } }),
    ).not.toThrow()
    expect(() => applyPolishPatch(input.draft, unsafe)).toThrow(/unsafe polish patch/u)
  })

  it('rejects unsafe human edits and archive-stage AI tone', async () => {
    const project = await setup()
    const plan = planFor()
    const dirty = `${buildContent(plan)}\n\n# 标题\n\n**加粗**`
    expect(evaluateDraftFormat(project, 1, plan.title, dirty).length).toBeGreaterThan(0)
    const input = await baseInput(project)
    input.draft = draftFor(plan, {
      content: `${buildContent(plan)}\n\n他稳了稳，说：“这句话稳。”`,
    })
    const findings = evaluateArchiveTone({
      project,
      chapter: 1,
      draft: input.draft,
      bible: input.bible,
      previousTexts: [],
    })
    expect(findings.some((finding) => finding.entryId.startsWith('AI-'))).toBe(true)
  })

  it('uses character signature phrases in review and archive tone scans', async () => {
    const project = await setup()
    const input = await baseInput(project)
    input.bible = {
      ...input.bible,
      characters: [{ name: '林砚', voice: { signature_phrases: ['他稳了稳'] } }],
    }
    input.draft = draftFor(input.plan, {
      content: `${buildContent(input.plan)}\n\n他稳了稳，说：“这句话稳。”`,
    })
    expect(verdict(evaluateGates(input), 'EG-07')).not.toBe('pass')
    const findings = evaluateArchiveTone({
      project,
      chapter: 1,
      draft: input.draft,
      bible: input.bible,
      previousTexts: [{ chapter: 0, text: '他稳了稳。' }],
    })
    expect(findings.length).toBeGreaterThan(0)
  })

  it('covers empty prose, fallback genre, malformed scores and stale continuity', async () => {
    const project = await setup()
    expect(dimensionMax('unknown-dimension')).toBe(0)
    const noTone = structuredClone(loadRulepack())
    delete noTone.lexicon.ai_tone
    const profiled = applyTaxonomyProfile(project, noTone)
    expect(profiled.lexicon.ai_tone).toBeUndefined()

    const input = await baseInput(project)
    input.draft = draftFor(input.plan, { content: '' })
    const empty = evaluateGates(input)
    expect(verdict(empty, 'PG-03')).toBe('fail')
    expect(verdict(empty, 'EG-04')).toBe('pass')

    input.plan = { ...input.plan, goal: '好', hook: '。' }
    input.draft = draftFor(input.plan, { content: `${buildContent(input.plan)}好。` })
    const odd = evaluateGates(input)
    expect(verdict(odd, 'PG-13')).toBeDefined()

    input.plan = planFor()
    input.draft = draftFor(input.plan)
    input.reviews = (await baseInput(project)).reviews
    input.reviews[0] = {
      ...input.reviews[0]!,
      dimensions: [...input.reviews[0]!.dimensions, { id: 'R-W-04', max: 20, deductions: [] }],
    }
    expect(verdict(evaluateGates(input), 'PG-07')).toBe('fail')

    input.reviews = (await baseInput(project)).reviews
    input.reviews[0] = {
      ...input.reviews[0]!,
      dimensions: input.reviews[0]!.dimensions.map((row, index) => (index === 0 ? { ...row, max: 99 } : row)),
    }
    expect(verdict(evaluateGates(input), 'PG-07')).toBe('fail')

    input.reviews = (await baseInput(project)).reviews
    const proseReview = input.reviews.find((review) => review.role === 'critic-prose')!
    proseReview.dimensions = proseReview.dimensions.map((row) =>
      row.id === 'R-W-07'
        ? { ...row, deductions: [{ rule: 'NOT_AI', location: '开头', delta: 1, note: 'x' }] }
        : row,
    )
    expect(verdict(evaluateGates(input), 'PG-07')).toBe('fail')

    proseReview.dimensions = proseReview.dimensions.map((row) =>
      row.id === 'R-W-07'
        ? { ...row, deductions: [{ rule: 'AI_TONE_META', location: '开头', delta: 1, note: 'x' }] }
        : row,
    )
    expect(verdict(evaluateGates(input), 'PG-07')).toBeDefined()

    input.continuity = { ...continuityFor('hash-1'), base_hash: 'stale-hash' }
    expect(verdict(evaluateGates(input), 'PG-10')).toBe('fail')

    input.draft = draftFor(input.plan, {
      self_check: {
        ...input.draft.self_check,
        scene_contract: { goal: '', conflict: '', turn: '', outcome: '' },
      },
    })
    expect(verdict(evaluateGates(input), 'PG-06')).toBe('fail')

    input.draft = draftFor(input.plan)
    input.continuity = continuityFor('hash-1')
    input.bible = { ...input.bible, characters: [{ name: '林砚' }] }
    expect(verdict(evaluateGates(input), 'EG-07')).toBeDefined()
    input.project.config.quality.min_score = 200
    expect(verdict(evaluateGates(input), 'PG-07')).toBe('fail')
  })
})
