import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootstrapToDraft, cleanText, harness, sampleSummary } from './helpers.js'

const characters = (identity: string): Record<string, unknown> => ({
  schema_version: 1,
  characters: [
    {
      name: '他',
      role: 'protagonist',
      first_appearance: 1,
      profile: { identity },
      current_state: { emotion: '警惕' },
      growth: [],
      updated_at: 1,
    },
  ],
})

const locks = (): Record<string, unknown> => ({
  schema_version: 1,
  locked_at_chapter: 1,
  characters: {
    他: { first_appearance: 1, locked_at: 1, appearance: '风从窗缝里挤进来' },
  },
  locations: {},
})

describe('brief context packs', () => {
  it('delivers characters and locked descriptions at P3', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await engine.amend({
        path: 'state/characters.yaml',
        content: characters('档案 A'),
        reason: 'seed',
        root,
      })
      await engine.amend({ path: 'state/locks.yaml', content: locks(), reason: 'seed', root })
      const brief = await engine.getBrief({ stage: 'P3', root })
      const context = brief.data.context as {
        characters: Array<{ name: string; profile: { identity: string } }>
        locks: { characters: Record<string, { appearance: string }> }
      }
      expect(context.characters[0]).toMatchObject({ name: '他', profile: { identity: '档案 A' } })
      expect(context.locks.characters['他']!.appearance).toContain('风从窗缝')
    } finally {
      await cleanup()
    }
  })

  it('changes the digest when the context changes, so PG-01 cannot accept a stale brief', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await engine.amend({
        path: 'state/characters.yaml',
        content: characters('档案 A'),
        reason: 'seed',
        root,
      })
      const first = await engine.getBrief({ stage: 'P3', root })
      await engine.amend({
        path: 'state/characters.yaml',
        content: characters('档案 B'),
        reason: 'update',
        root,
      })
      const second = await engine.getBrief({ stage: 'P3', root })
      expect(second.data.digest).not.toBe(first.data.digest)
    } finally {
      await cleanup()
    }
  })

  it('delivers the live manuscript to P4 and P5 so review and revision read the real text', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
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
      const p4 = await engine.getBrief({ stage: 'P4', root })
      expect((p4.data.context as { text: string }).text).toBe(text)
      expect(
        (p4.data.context as { machine: { metrics: { total_word_count: number } } }).machine.metrics
          .total_word_count,
      ).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })

  it('delivers the full ledger set at P6', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const brief = await engine.getBrief({ stage: 'P6', root })
      expect(Object.keys(brief.data.context)).toEqual(
        expect.arrayContaining([
          'characters',
          'world',
          'locks',
          'foreshadows',
          'timeline',
          'relationships',
          'check',
        ]),
      )
    } finally {
      await cleanup()
    }
  })

  it('falls back to the bundled brief when an override directory is partial', async () => {
    const overrides = await mkdtemp(join(tmpdir(), 'novel-briefs-'))
    const { root, engine, cleanup } = await harness({ briefs: { overrides } })
    try {
      await engine.initProject({ title: '回退之书', genre: '都市现代', platform: 'fanqie', root })
      const bundled = await engine.getBrief({ stage: 'P1', root })
      expect(bundled.data.content).toContain('P1')
      const beforeOverride = await engine.getBrief({ stage: 'P3', root })

      await writeFile(join(overrides, 'P3.md'), '# 自定义 P3\n\n只覆盖 P3。', 'utf8')
      const custom = await engine.getBrief({ stage: 'P3', root })
      expect(custom.data.content).toContain('自定义 P3')
      expect(custom.data.digest).not.toBe(beforeOverride.data.digest)
      const stillBundled = await engine.getBrief({ stage: 'P2', root })
      expect(stillBundled.data.content).toContain('P2')
    } finally {
      await cleanup()
      await rm(overrides, { recursive: true, force: true })
    }
  })

  it('uses the rulepack platform defaults and exposes the genre guide', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '平台之书', genre: '都市现代', platform: 'fanqie', root })
      const project = await engine.queryState({ kind: 'novel', root })
      expect(
        (project.data as { targets: { words_per_chapter: number[] } }).targets.words_per_chapter,
      ).toEqual([2000, 3000])
      const brief = await engine.getBrief({ stage: 'P1', root })
      expect(brief.data.fields.platform_style).toMatchObject({ words_per_chapter: [2000, 3000] })
      expect(brief.data.fields.genre_guide).toMatchObject({ note: expect.stringContaining('都市') })
    } finally {
      await cleanup()
    }
  })
})
