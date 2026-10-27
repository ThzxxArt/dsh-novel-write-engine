import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { expect, it } from 'vitest'
import {
  bootstrapToDraft,
  cleanText,
  harness,
  readProjectFile,
  sampleReview,
  snapshotTree,
  writeDraft,
} from './helpers.js'

const blocker = {
  id: 'REV-001',
  severity: 'blocker' as const,
  dimension: 'R-W-01',
  location: '第 2 段',
  problem: '缺动机',
  fix: '补一句理由',
  status: 'open' as const,
}

it('resolves an omitted root through the active registry project', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'novel-registry-'))
  const other = await mkdtemp(join(tmpdir(), 'novel-other-'))
  const { root, engine, cleanup } = await harness({ stateDir })
  try {
    await engine.initProject({ title: '甲方', genre: '都市现代', platform: 'fanqie', root })
    await engine.initProject({ title: '乙方', genre: '都市现代', platform: 'fanqie', root: other })
    await engine.setActiveProject({ root: other })
    const active = await engine.getStatus({})
    expect((active.data as { project: { title: string } }).project.title).toBe('乙方')
    await engine.forgetProject({ root: other })
    const fallback = await engine.getStatus({})
    expect((fallback.data as { project: { title: string } }).project.title).toBe('甲方')
  } finally {
    await cleanup()
    await rm(stateDir, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})

it('makes the panel follow the project a tool call just touched', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await engine.initProject({ title: '面板之书', genre: '都市现代', platform: 'fanqie', root })
    const bundle = await engine.panelBundle()
    expect(bundle.summary.title).toBe('面板之书')
    expect(bundle.chapters.rows).toHaveLength(1)
  } finally {
    await cleanup()
  }
})

it('records an honest sub-threshold review and moves to P5', async () => {
  const { root, engine, cleanup } = await harness({ quality: { minScore: 149 } })
  try {
    await bootstrapToDraft({ root, engine })
    const text = cleanText()
    await writeDraft({ root, engine, text })
    await engine.getBrief({ stage: 'P4', root })
    const review = sampleReview(1, text, { deductions: 5 })
    expect(review.total).toBe(145)
    const submitted = await engine.submitReview({ chapter: 1, ...review, root })
    expect(submitted.data.next_stage).toBe('P5')
    expect(submitted.data.open_blockers).toBe(1)
    const pipeline = parseYaml((await readProjectFile(root, 'state/pipeline.yaml'))!) as {
      stage: string
      blocking: Array<{ code: string }>
    }
    expect(pipeline.stage).toBe('P5')
    expect(pipeline.blocking.map((item) => item.code)).toContain('SCORE-BELOW-MIN')
  } finally {
    await cleanup()
  }
})

it('does not rewrite the reviewed content_hash during a revision', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await bootstrapToDraft({ root, engine })
    const text = cleanText()
    await writeDraft({ root, engine, text })
    await engine.getBrief({ stage: 'P4', root })
    await engine.submitReview({ chapter: 1, ...sampleReview(1, text, { issues: [blocker] }), root })
    await engine.getBrief({ stage: 'P5', root })
    const before = parseYaml((await readProjectFile(root, 'reviews/ch001.review.yaml'))!) as {
      content_hash: string
    }
    const revised = text.replace('走廊尽头传来脚步声', '楼梯尽头传来脚步声')
    await engine.submitRevision({
      chapter: 1,
      content: revised,
      issues: [{ ...blocker, status: 'fixed', evidence: '楼梯尽头传来脚步声' }],
      proof: sampleReview(1, revised).proof,
      root,
    })
    const after = parseYaml((await readProjectFile(root, 'reviews/ch001.review.yaml'))!) as {
      content_hash: string
    }
    expect(after.content_hash).toBe(before.content_hash)
  } finally {
    await cleanup()
  }
})

it('refuses to erase or downgrade a blocker through novel_revise', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await bootstrapToDraft({ root, engine })
    const text = cleanText()
    await writeDraft({ root, engine, text })
    await engine.getBrief({ stage: 'P4', root })
    await engine.submitReview({ chapter: 1, ...sampleReview(1, text, { issues: [blocker] }), root })
    await engine.getBrief({ stage: 'P5', root })
    await expect(
      engine.submitRevision({
        chapter: 1,
        content: text,
        issues: [],
        proof: sampleReview(1, text).proof,
        root,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_GATE_BLOCKED' })
    await expect(
      engine.submitRevision({
        chapter: 1,
        content: text,
        issues: [{ ...blocker, severity: 'advisory' }],
        proof: sampleReview(1, text).proof,
        root,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
  } finally {
    await cleanup()
  }
})

it('allows the documented P6-to-revise edge without refetching the P6 brief', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await bootstrapToDraft({ root, engine })
    const text = cleanText()
    await writeDraft({ root, engine, text })
    await engine.getBrief({ stage: 'P4', root })
    await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
    await engine.getBrief({ stage: 'P6', root })
    const check = await engine.runCheck({
      chapter: 1,
      semantic: [{ id: 'L2-VOICE', verdict: 'fail', evidence: '他没有抬头', note: '声音无区分' }],
      root,
    })
    expect(check.data.verdict).toBe('fail')
    const revised = await engine.submitRevision({
      chapter: 1,
      content: text,
      proof: sampleReview(1, text).proof,
      root,
    })
    expect(revised.data.stage).toBe('P4')
  } finally {
    await cleanup()
  }
})

it('rejects a nested malformed amendment without writing', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await engine.initProject({ title: '结构校验', genre: '都市现代', platform: 'fanqie', root })
    const before = await snapshotTree(root)
    await expect(
      engine.amend({
        path: 'state/locks.yaml',
        content: {
          schema_version: 1,
          locked_at_chapter: 1,
          characters: { 他: {} },
          locations: {},
        },
        reason: '试图写入坏锁',
        root,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    expect([...(await snapshotTree(root)).entries()]).toEqual([...before.entries()])
  } finally {
    await cleanup()
  }
})

it('rejects malformed numeric inputs before touching the project', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await expect(
      engine.initProject({
        title: '坏输入',
        genre: '都市现代',
        platform: 'fanqie',
        words_per_chapter: null as never,
        root,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    await expect(
      engine.initProject({
        title: '坏输入',
        genre: '都市现代',
        platform: 'fanqie',
        dialogue_ratio: null as never,
        root,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    await bootstrapToDraft({ root, engine })
    await expect(
      engine.submitChapterPlan({
        chapter: 0,
        title: '坏节拍',
        scene_type: '日常过渡章',
        narrator: '他',
        beats: ['b'],
        opening: 'o',
        ending: 'e',
        target_words: null as never,
        root,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    await expect(
      engine.amend({ path: 'state/world.yaml', content: null as never, reason: 'x', root }),
    ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
  } finally {
    await cleanup()
  }
})
