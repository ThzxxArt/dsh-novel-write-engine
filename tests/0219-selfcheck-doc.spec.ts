import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { EngineService } from '../src/engine/service.js'
import { loadRulepack } from '../src/rulepack.js'
import { checkFile } from '../src/constants.js'
import {
  bootstrapToDraft,
  cleanText,
  FIXED_NOW,
  harness,
  readProjectFile,
  sampleReview,
  sampleSemantic,
  sampleSummary,
  TEST_CONFIG,
  writeDraft,
} from './helpers.js'
import { buildSelfCheck, SELF_CHECK_SPEC } from '../src/rules/selfcheck.js'
import type { SelfCheckAnswer } from '../src/rules/selfcheck.js'
import type { Rulepack } from '../src/rules/types.js'
import type { Violation } from '../src/types.js'

/**
 * 0.2.19 WP3 — the thirteen-row self-check document.
 *
 * The document is the contract between the machine pass, the P4 model and the
 * panel: every row must exist, carry a verdict, name the codes behind it and
 * point at a paragraph. `content_hash` binds it to the exact manuscript it
 * judged, so a stale row can never be read as a judgement of new text.
 */

const hash = 'sha256:0'.repeat(1)

const violation = (code: string, paragraph: number, detail = 'detail'): Violation => ({
  code,
  severity: 'advisory',
  location: { paragraph },
  detail,
})

const CLEAN = [
  '风从窗缝里挤进来，把桌上的纸吹得翻了一页。他伸手压住，指腹沾了一点灰。',
  '走廊尽头传来脚步声，不快不慢，在门口停了两秒。他没有抬头，只把笔帽扣紧。',
  '门开了一条缝，外面的人没有进来，先递进来一只牛皮纸袋，边角磨得发白。',
].join('\n\n')

const block = (answers?: SelfCheckAnswer[], violations: Violation[] = [], text = CLEAN) =>
  buildSelfCheck({ text, chapter: 3, contentHash: hash, violations, answers })

describe('SELF_CHECK_SPEC is the checklist', () => {
  it('has thirteen rows in checklist order', () => {
    expect(SELF_CHECK_SPEC.map((entry) => entry.id)).toEqual([
      'SC-METAPHOR',
      'SC-CONCRETE',
      'SC-FORMULA',
      'SC-PARALLEL',
      'SC-LIST',
      'SC-DIALOGUE-BEAT',
      'SC-DASH',
      'SC-QUOTE',
      'SC-PUNCT',
      'SC-PARAGRAPH',
      'SC-LINEBREAK',
      'SC-CHAPTER-BREAK',
      'SC-TRANSITION',
    ])
  })

  it('splits five machine rows, seven hybrid rows and one model row', () => {
    const byBasis = (basis: string) => SELF_CHECK_SPEC.filter((entry) => entry.basis === basis).length
    expect(byBasis('machine')).toBe(5)
    expect(byBasis('hybrid')).toBe(7)
    expect(byBasis('model')).toBe(1)
  })

  it('puts the six voice items first and the seven layout items after', () => {
    const voice = SELF_CHECK_SPEC.filter((entry) => entry.category === 'voice').length
    expect(voice).toBe(6)
    expect(SELF_CHECK_SPEC.filter((entry) => entry.category === 'layout')).toHaveLength(7)
    expect(SELF_CHECK_SPEC.slice(0, 6).every((entry) => entry.category === 'voice')).toBe(true)
  })

  it('gives every row at least one rule code and no duplicate ids', () => {
    const ids = new Set<string>()
    for (const entry of SELF_CHECK_SPEC) {
      expect({ id: entry.id, codes: entry.codes.length > 0 }).toEqual({ id: entry.id, codes: true })
      expect(ids.has(entry.id)).toBe(false)
      ids.add(entry.id)
    }
    expect(ids.size).toBe(13)
  })
})

describe('buildSelfCheck', () => {
  it('always returns thirteen rows bound to the chapter and the content hash', () => {
    const document = block()
    expect(document.schema_version).toBe(1)
    expect(document.chapter).toBe(3)
    expect(document.content_hash).toBe(hash)
    expect(document.items).toHaveLength(13)
    expect(document.summary).toEqual({ pass: 11, fail: 0, na: 2 })
  })

  it('passes a machine row when nothing behind it fired', () => {
    const dash = block().items.find((item) => item.id === 'SC-DASH')!
    expect(dash.verdict).toBe('pass')
    expect(dash.evidence).toEqual([])
    expect(dash.codes).toContain('DASH_BUDGET')
  })

  it('fails a machine row and quotes the paragraph', () => {
    const document = block(undefined, [violation('DASH_BUDGET', 2, 'dash weight 9, budget is 3')])
    const dash = document.items.find((item) => item.id === 'SC-DASH')!
    expect(dash.verdict).toBe('fail')
    expect(dash.evidence).toHaveLength(1)
    expect(dash.evidence[0]!.paragraph).toBe(2)
    expect(dash.evidence[0]!.quote).toContain('走廊尽头')
    expect(dash.evidence[0]!.detail).toContain('dash weight 9')
    expect(document.summary).toEqual({ pass: 10, fail: 1, na: 2 })
  })

  it('reports na for the two dialogue rows in a chapter with no dialogue', () => {
    const rows = block()
      .items.filter((item) => item.verdict === 'na')
      .map((item) => item.id)
    expect(rows).toEqual(['SC-DIALOGUE-BEAT', 'SC-QUOTE'])
    for (const item of block().items.filter((entry) => entry.verdict === 'na')) {
      expect(item.note).toContain('没有对白')
      expect(item.evidence).toEqual([])
    }
  })

  it('reports na for every row when there is no prose at all', () => {
    const document = buildSelfCheck({ text: '   ', chapter: 3, contentHash: hash, violations: [] })
    expect(document.summary).toEqual({ pass: 0, fail: 0, na: 13 })
    expect(document.items.every((item) => item.note?.includes('没有正文'))).toBe(true)
  })

  it('refuses to let a model answer turn a machine failure into a pass', () => {
    // The builder is the second line of defence; the service refuses first. This
    // asserts the rule at the document layer so no caller can bypass it.
    const answers: SelfCheckAnswer[] = [{ id: 'SC-FORMULA', verdict: 'pass', note: '我觉得没问题' }]
    const document = block(answers, [violation('FRAME_REPEAT', 1, '固定句式 3 次')])
    expect(document.items.find((item) => item.id === 'SC-FORMULA')!.verdict).toBe('fail')
  })

  it('takes a hybrid model answer when the machine half passed', () => {
    const answers: SelfCheckAnswer[] = [
      { id: 'SC-PARALLEL', verdict: 'fail', note: '第三段读起来像排比', evidence: '他走了。他停了。' },
    ]
    const parallel = block(answers).items.find((item) => item.id === 'SC-PARALLEL')!
    expect(parallel.verdict).toBe('fail')
    expect(parallel.note).toContain('第三段读起来像排比')
    expect(parallel.evidence.at(-1)!.quote).toBe('他走了。他停了。')
  })

  it('says the judgement half is missing instead of pretending a model read it', () => {
    const hybrid = block().items.find((item) => item.id === 'SC-FORMULA')!
    expect(hybrid.verdict).toBe('pass')
    expect(hybrid.note).toContain('没有模型判定')
  })

  it('lets the model pass SC-CONCRETE over a machine flag', () => {
    // SC-CONCRETE is the one model-basis row: PROSE_ABSTRACT only says "look
    // here", so "can it be pictured" is still the model's call.
    const flagged = block(undefined, [violation('PROSE_ABSTRACT', 2, '抽象词 3 个')])
    expect(flagged.items.find((item) => item.id === 'SC-CONCRETE')!.verdict).toBe('na')
    const answered = block(
      [{ id: 'SC-CONCRETE', verdict: 'pass', note: '这一段能拍出来' }],
      [violation('PROSE_ABSTRACT', 2, '抽象词 3 个')],
    )
    expect(answered.items.find((item) => item.id === 'SC-CONCRETE')!.verdict).toBe('pass')
  })

  it('keeps the model quote on the one model-decided row', () => {
    // The row is ○: the document has to carry the sentence the model pointed at,
    // or a reader cannot tell a considered pass from a shrug.
    const answered = block(
      [
        {
          id: 'SC-CONCRETE',
          verdict: 'fail',
          note: '这一段只有情绪词，看不出画面',
          evidence: '空气里有一种说不清的气氛',
        },
      ],
      [violation('PROSE_ABSTRACT', 2, '抽象词 3 个')],
    )
    const concrete = answered.items.find((item) => item.id === 'SC-CONCRETE')!
    expect(concrete.verdict).toBe('fail')
    expect(concrete.evidence.at(-1)).toMatchObject({
      paragraph: 0,
      quote: '空气里有一种说不清的气氛',
      detail: '模型给出的理由',
    })
  })
})

describe('novel_check writes the document', () => {
  /** Drive a project to P6 with a check ready to run. */
  const atP6 = async (text: string) => {
    const h = await harness()
    await bootstrapToDraft({ root: h.root, engine: h.engine })
    await writeDraft({ root: h.root, engine: h.engine, text })
    await h.engine.getBrief({ stage: 'P4', root: h.root })
    // The fixture may now fire a machine-scored rule (FRAME_REPEAT here), so its
    // own 150 - Σdelta is no longer the engine's total. Omit it, as a caller is
    // told to.
    const sample = sampleReview(1, text)
    await h.engine.submitReview({
      chapter: 1,
      dimensions: sample.dimensions,
      issues: sample.issues,
      proof: sample.proof,
      root: h.root,
    })
    await h.engine.getBrief({ stage: 'P6', root: h.root })
    return h
  }

  it('returns thirteen rows and persists them in the check document', async () => {
    const text = cleanText()
    const h = await atP6(text)
    try {
      const result = await h.engine.runCheck({ chapter: 1, semantic: sampleSemantic(text), root: h.root })
      expect(result.data.self_check?.items).toHaveLength(13)
      expect(result.data.self_check?.chapter).toBe(1)
      const stored = await readProjectFile(h.root, checkFile(1))
      expect(stored).not.toBeNull()
      const parsed = parse(stored!) as { self_check?: { items: unknown[]; content_hash: string } }
      expect(parsed.self_check?.items).toHaveLength(13)
      expect(parsed.self_check?.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/)
    } finally {
      await h.cleanup()
    }
  })

  it('refuses an unknown self-check id', async () => {
    const text = cleanText()
    const h = await atP6(text)
    try {
      await expect(
        h.engine.runCheck({
          chapter: 1,
          semantic: sampleSemantic(text),
          self_check: [{ id: 'SC-NOPE' as never, verdict: 'pass', note: 'x' }],
          root: h.root,
        }),
      ).rejects.toThrow(/SC-NOPE/)
    } finally {
      await h.cleanup()
    }
  })

  it('refuses a verdict on a machine-decided row', async () => {
    const text = cleanText()
    const h = await atP6(text)
    try {
      await expect(
        h.engine.runCheck({
          chapter: 1,
          semantic: sampleSemantic(text),
          self_check: [{ id: 'SC-DASH', verdict: 'pass', note: '没用破折号' }],
          root: h.root,
        }),
      ).rejects.toThrow(/decided by the engine/)
    } finally {
      await h.cleanup()
    }
  })

  it('refuses a pass that contradicts a machine finding', async () => {
    // Two `不是……而是……` frames in one paragraph is what SC-FORMULA reports,
    // and the row is hybrid: the model may add a judgement, never delete the
    // evidence behind it.
    const text = `${cleanText()}\n\n他不是要钱，而是要命。他不是怕死，而是怕疼。\n\n里面没有人，也没有声音。`
    const h = await atP6(text)
    try {
      // The refusal itself: the first submission is the lying pass, so the
      // branch that rejects it is the assertion instead of a comment.
      await expect(
        h.engine.runCheck({
          chapter: 1,
          semantic: sampleSemantic(text),
          self_check: [{ id: 'SC-FORMULA', verdict: 'pass', note: '我觉得只有一个' }],
          root: h.root,
        }),
      ).rejects.toThrow(/SC-FORMULA cannot be marked pass/)
      const findings = await h.engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(text),
        root: h.root,
      })
      const formula = findings.data.self_check?.items.find((item) => item.id === 'SC-FORMULA')
      expect(formula?.verdict).toBe('fail')
    } finally {
      await h.cleanup()
    }
  })

  it('refuses self_check when the pack has no block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'novel-legacy-'))
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-legacy-state-'))
    const legacy = structuredClone(loadRulepack()) as Rulepack
    delete legacy.selfcheck
    const engine = new EngineService({ ...TEST_CONFIG, projectRoot: root, stateDir }, () => legacy, {
      now: FIXED_NOW,
    })
    try {
      await bootstrapToDraft({ root, engine })
      await writeDraft({ root, engine })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, cleanText()), root })
      await engine.getBrief({ stage: 'P6', root })
      // Without the block no row exists, so answering one is refused rather than
      // silently dropped.
      await expect(
        engine.runCheck({
          chapter: 1,
          semantic: sampleSemantic(cleanText()),
          self_check: [{ id: 'SC-FORMULA', verdict: 'pass', note: 'x' }],
          root,
        }),
      ).rejects.toThrow(/selfcheck/)
      const plain = await engine.runCheck({ chapter: 1, semantic: sampleSemantic(cleanText()), root })
      expect(plain.data.self_check).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})

describe('the two new blockers reach PG-04 before the review rounds', () => {
  /** A project at P3 with the P3 brief signed, ready to submit a draft. */
  const atDraft = async () => {
    const h = await harness()
    await bootstrapToDraft({ root: h.root, engine: h.engine })
    await h.engine.getBrief({ stage: 'P3', root: h.root })
    return h
  }

  const submit = async (
    h: Awaited<ReturnType<typeof atDraft>>,
    content: string,
    opening: string,
  ): Promise<Error | null> =>
    h.engine
      .submitDraft({
        chapter: 1,
        content,
        chapter_title: '开端之雨',
        scene_type: '日常过渡章',
        narrator: '他',
        summary: sampleSummary({ opening }),
        root: h.root,
      })
      .then(() => null)
      .catch((caught: unknown) => caught as Error)

  it('blocks halfwidth punctuation at P3 instead of leaving it to P6', async () => {
    const h = await atDraft()
    try {
      const error = await submit(h, `他把碗放下,说了一句走吧。\n\n${cleanText(4)}`, '他把碗放下,说了一句走吧')
      expect(error).not.toBeNull()
      expect(error!.message).toContain('PG-04')
      expect(error!.message).toContain('PUNCT_STANDARD')
    } finally {
      await h.cleanup()
    }
  })

  it('blocks an unpaired straight quote at P3', async () => {
    const h = await atDraft()
    try {
      const error = await submit(h, `他说："你走吧，我不拦你。\n\n${cleanText(4)}`, '他说："你走吧，我不拦你')
      expect(error).not.toBeNull()
      expect(error!.message).toContain('PG-04')
      expect(error!.message).toContain('QUOTE_UNBALANCED')
    } finally {
      await h.cleanup()
    }
  })

  it('leaves a pack without the selfcheck block exactly as it was', async () => {
    // The gate runs both codes; on a pre-0.2.19 pack the rules themselves must
    // stay silent, or the same manuscript that passed in 0.2.18 would now fail.
    const root = await mkdtemp(join(tmpdir(), 'novel-legacy-pg04-'))
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-legacy-pg04-state-'))
    const legacy = structuredClone(loadRulepack()) as Rulepack
    delete legacy.selfcheck
    const engine = new EngineService({ ...TEST_CONFIG, projectRoot: root, stateDir }, () => legacy, {
      now: FIXED_NOW,
    })
    try {
      await bootstrapToDraft({ root, engine })
      await engine.getBrief({ stage: 'P3', root })
      await expect(
        engine.submitDraft({
          chapter: 1,
          content: `他把碗放下,说了一句走吧。\n\n他说："你走吧，我不拦你。\n\n${cleanText(4)}`,
          chapter_title: '开端之雨',
          scene_type: '日常过渡章',
          narrator: '他',
          summary: sampleSummary({ opening: '他把碗放下,说了一句走吧' }),
          root,
        }),
      ).resolves.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})
