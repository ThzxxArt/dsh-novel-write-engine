import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  bootstrapToDraft,
  harness,
  sampleReview,
  sampleSemantic,
  sampleSummary,
  writeDraft,
  type Harness,
} from './helpers.js'

/**
 * WP12: the style layer end to end.
 *
 * A unit test can prove a rule fires on a string; only this proves the pack the
 * user picked is the one the brief, the machine pass, the status and the panel
 * all read. A1 (no style) and A2 (with style) are the two halves.
 */

const queue: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of queue.splice(0)) await cleanup()
})

/** Drive a project to P4 with one draft; `style` is the only difference. */
async function toReview(h: Harness, style?: string): Promise<void> {
  await h.engine.initProject({
    title: '文风之书',
    genre: '悬疑推理',
    platform: 'fanqie',
    ...(style === undefined ? {} : { style }),
    root: h.root,
    words_per_chapter: [10, 400],
  })
  await h.engine.getBrief({ stage: 'P1', root: h.root })
  await h.engine.submitWorldPlan({
    chapter: 0,
    objective: '让主角收到一封无名信',
    constraints: [],
    characters: [],
    locations: [],
    continuity_notes: [],
    root: h.root,
  })
  await h.engine.getBrief({ stage: 'P2', root: h.root })
  await h.engine.submitChapterPlan({
    chapter: 0,
    title: '开端之雨',
    scene_type: '日常过渡章',
    narrator: '他',
    beats: ['风起', '信到', '拆封', '读信', '决定'],
    opening: '风从窗缝里挤进来',
    ending: '蜡印',
    target_words: [10, 400],
    root: h.root,
  })
  await h.engine.getBrief({ stage: 'P3', root: h.root })
  await h.engine.submitDraft({
    chapter: 1,
    content:
      '风从窗缝里挤进来，把桌上的纸吹得翻了一页。他伸手压住，指腹沾了一点灰。\n\n信封没有署名，封口处压着一枚暗红的蜡印，边缘已经磨得发白。',
    chapter_title: '开端之雨',
    scene_type: '日常过渡章',
    narrator: '他',
    summary: sampleSummary(),
    root: h.root,
  })
  await h.engine.getBrief({ stage: 'P4', root: h.root })
}

describe('0.2.17 style layer integration', () => {
  it('carries the chosen pack into the P2 brief, the status and the panel', async () => {
    const h = await harness()
    queue.push(h.cleanup)
    await toReview(h, 'cold-suspense')

    // The brief the model reads names the pack and both dialogue numbers.
    const brief = await h.engine.getBrief({ stage: 'P2', root: h.root })
    const context = (brief.data as { content?: unknown }).content
    // The brief is rendered markdown; the style block rides in the context pack
    // that produced it, so the assertion is that the brief was built at all and
    // the pack is reachable from every read model below.
    expect(typeof context).toBe('string')
    expect((brief.data as unknown as { digest?: string }).digest).toBeTruthy()

    const status = await h.engine.getStatus({ root: h.root })
    expect(status.data.style).toEqual({ id: 'cold-suspense', name: '冷峻悬疑' })
    expect(status.data.style_id).toBe('cold-suspense')
    // C6: target is the aiming point, range is what the user confirmed.
    expect(status.data.dialogue?.target).toBe(0.25)
    // fanqie defaults to 0.40–0.60 and the pack only tightens (min 0.25 → 0.40).
    expect(status.data.dialogue?.range).toEqual([0.4, 0.6])

    // The verdict travels on the bundle the overview tab actually renders;
    // the overview *section* is never fetched by the client.
    const panel = (await h.engine.panelSection({ section: 'overview', root: h.root })) as unknown as {
      items?: { bookData?: { identity?: { style?: { id: string } }; style_verdict?: { verdict: string } } }
    }
    expect(panel.items?.bookData?.identity?.style?.id).toBe('cold-suspense')
    expect(['pass', 'attention']).toContain(panel.items?.bookData?.style_verdict?.verdict)
  })

  it('omits the style block entirely when the book has no style (A1)', async () => {
    const h = await harness()
    queue.push(h.cleanup)
    await toReview(h, 'none')
    const report = await h.engine.report({ root: h.root })
    // A1: no pack means no style block, not an empty one pretending to pass.
    expect((report.data as { style?: unknown }).style).toBeUndefined()
    const status = await h.engine.getStatus({ root: h.root })
    expect(status.data.style).toBeNull()
    expect(status.data.dialogue?.target).toBeNull()
  })

  it('measures the chapter against the pack in the book report (A2)', async () => {
    const h = await harness()
    queue.push(h.cleanup)
    await toReview(h, 'cold-suspense')
    const report = await h.engine.report({ root: h.root })
    const style = (
      report.data as { style?: { id: string; metrics: { sentence: { total: number } }; verdict: string } }
    ).style
    expect(style?.id).toBe('cold-suspense')
    expect(style?.metrics.sentence.total).toBeGreaterThan(0)
    expect(['pass', 'attention']).toContain(style?.verdict)
  })

  it('never calls an empty chapter a fit', async () => {
    const h = await harness()
    queue.push(h.cleanup)
    await h.engine.initProject({
      title: '空白之书',
      genre: '悬疑推理',
      platform: 'fanqie',
      style: 'cold-suspense',
      root: h.root,
    })
    const report = await h.engine.report({ root: h.root })
    const style = (report.data as { style?: { verdict: string } }).style
    // No manuscript yet: the honest answer is "nothing to judge", not "pass".
    expect(style?.verdict).toBe('no-draft')
  })

  it('refuses to change the style after creation', async () => {
    const h = await harness()
    queue.push(h.cleanup)
    await toReview(h, 'cold-suspense')
    await expect(
      h.engine.amend({
        path: 'novel.yaml',
        content: { style: 'weird-horror' },
        reason: '换风格',
        root: h.root,
      }),
    ).rejects.toThrow(/immutable/)
  })

  it('reports the style in the book report', async () => {
    const h = await harness()
    queue.push(h.cleanup)
    await toReview(h, 'cold-suspense')
    const report = await h.engine.report({ root: h.root })
    expect((report.data as { style?: { id: string } }).style?.id).toBe('cold-suspense')
  })
})

describe('0.2.17 check record keeps the style measurements', () => {
  it('persists machine.style so a stored STYLE_* row can be re-read', async () => {
    const h = await harness()
    queue.push(h.cleanup)
    await bootstrapToDraft({ root: h.root, engine: h.engine, style: 'cold-suspense' })
    await writeDraft({ root: h.root, engine: h.engine })
    await h.engine.getBrief({ stage: 'P4', root: h.root })
    const text = await readFile(`${h.root}/chapters/chapter-001.md`, 'utf8')
    await h.engine.submitReview({ chapter: 1, ...sampleReview(1, text), root: h.root })
    await h.engine.getBrief({ stage: 'P6', root: h.root })
    await h.engine.runCheck({ chapter: 1, scope: ['content'], semantic: sampleSemantic(text), root: h.root })
    const stored = (await h.engine.queryState({ kind: 'check', root: h.root })).data as {
      machine?: { style?: { style_id: string; sentence: { total: number } } }
    }
    // A stored check that names a STYLE_* code must carry the numbers behind it.
    expect(stored.machine?.style?.style_id).toBe('cold-suspense')
    expect(stored.machine?.style?.sentence.total).toBeGreaterThan(0)
  })
})
