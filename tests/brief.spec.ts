import { describe, expect, it } from 'vitest'
import { bootstrapToDraft, harness } from './helpers.js'

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
