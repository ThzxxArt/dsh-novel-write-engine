import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { narrow } from '../src/store/schema.js'
import { bootstrapToDraft, cleanText, harness, sampleSummary } from './helpers.js'

describe('0.2.13 contract audit', () => {
  it('rejects invalid optional ledger fields written through a document amend', () => {
    expect(() =>
      narrow('relationships', {
        schema_version: 1,
        next_seq: 1,
        items: [
          {
            id: 'RL-001',
            a: '甲',
            b: '乙',
            type: '朋友',
            type_code: 'not-a-code',
            since: 1,
            description: '',
            evolution: [],
          },
        ],
      }),
    ).toThrow(/type_code must be one of/)

    expect(() =>
      narrow('foreshadows', {
        schema_version: 1,
        next_seq: 1,
        items: [
          {
            id: 'FS-001',
            title: '欠账',
            planted: 1,
            last_touched: 1,
            status: 'planted',
            resolved_at: null,
            description: '',
            kind: 'not-a-kind',
            advance_log: [],
          },
        ],
      }),
    ).toThrow(/kind must be one of/)

    expect(() =>
      narrow('foreshadows', {
        schema_version: 1,
        next_seq: 1,
        items: [
          {
            id: 'FS-001',
            title: '欠账',
            planted: 1,
            last_touched: 1,
            status: 'resolved',
            resolved_at: 1,
            description: '',
            resolved_anchor: '',
            advance_log: [],
          },
        ],
      }),
    ).toThrow(/resolved_anchor must be a verbatim quote/)

    expect(() =>
      narrow('timeline', {
        schema_version: 1,
        next_seq: 1,
        items: [
          {
            id: 'TE-001',
            chapter: 1,
            story_time: '',
            description: '事件',
            location: '',
            characters: [],
            event_key: 3,
          },
        ],
      }),
    ).toThrow(/event_key must be a string/)

    expect(() =>
      narrow('worldbook', {
        schema_version: 1,
        updated_at: '',
        premise: '',
        setting: '',
        rules: [],
        factions: [],
        locations: [],
        characters: [{ name: '甲', role: 'supporting', description: '', arc: '', appearance: 3 }],
        glossary: [],
        backstory: [],
        themes: [],
      }),
    ).toThrow(/appearance must be a string/)

    expect(() =>
      narrow('project', {
        schema_version: 1,
        title: '书',
        genre: '都市现代',
        platform: 'fanqie',
        author: '',
        description: '',
        created_at: '',
        targets: {
          words_per_chapter: [1, 2],
          total_chapters: null,
          dialogue_ratio: [0, 1],
          min_cjk_chars: 0,
        },
      }),
    ).toThrow(/min_cjk_chars must be a positive integer or null/)
  })

  it('paginates every world entity group and exposes a locks page', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '分页覆盖', genre: '都市现代', platform: 'fanqie', root })
      const world = (await engine.queryState({ kind: 'world', root })).data as {
        schema_version: 1
        locations: unknown[]
        abilities: unknown[]
        artifacts: unknown[]
        factions: unknown[]
        rules: unknown[]
      }
      await engine.amend({
        path: 'state/world.yaml',
        content: {
          ...world,
          abilities: Array.from({ length: 201 }, (_, index) => ({ name: `技能${index + 1}` })),
        },
        reason: '分页夹具',
        root,
      })
      const page = (await engine.queryState({ kind: 'world', root })).data as {
        locations: unknown[]
        abilities: unknown[]
        page: { total: number; returned: number; has_more: boolean; next_cursor: string | null }
      }
      expect(page.page).toMatchObject({ total: 201, returned: 200, has_more: true })
      expect(page.page.next_cursor).not.toBeNull()
      expect(page.abilities).toHaveLength(200)
      const second = (
        await engine.queryState({
          kind: 'world',
          cursor: page.page.next_cursor!,
          root,
        })
      ).data as { abilities: unknown[]; page: { returned: number; has_more: boolean } }
      expect(second.abilities).toHaveLength(1)
      expect(second.page).toMatchObject({ returned: 1, has_more: false })

      const stripped = structuredClone(page) as unknown as Record<string, unknown>
      delete stripped.page
      await expect(
        engine.amend({
          path: 'state/world.yaml',
          content: stripped,
          reason: 'stripping page must not bypass completeness',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })

      const locks = (await engine.queryState({ kind: 'locks', root })).data as {
        characters: Record<string, unknown>
        locations: Record<string, unknown>
        page: { total: number; limit: number; has_more: boolean }
      }
      expect(locks.page).toMatchObject({ total: 0, limit: 200, has_more: false })
      expect(locks.characters).toEqual({})
      expect(locks.locations).toEqual({})
    } finally {
      await cleanup()
    }
  })

  it('adds a page wrapper to the legacy pipeline.briefs fallback', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '旧收据', genre: '都市现代', platform: 'fanqie', root })
      await rm(join(root, 'state', 'briefs.yaml'), { force: true })
      const data = (await engine.queryState({ kind: 'briefs', root })).data as {
        receipts: unknown[]
        page: { total: number; returned: number; limit: number }
      }
      expect(data.receipts).toHaveLength(0)
      expect(data.page).toMatchObject({ total: 0, returned: 0, limit: 50 })
    } finally {
      await cleanup()
    }
  })

  it('enforces the optional CJK lower bound through PG-03', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const project = (await engine.queryState({ kind: 'novel', root })).data as Record<string, unknown> & {
        targets: Record<string, unknown>
      }
      await engine.amend({
        path: 'novel.yaml',
        content: {
          title: project.title,
          author: project.author,
          description: project.description,
          targets: { ...project.targets, min_cjk_chars: 1000 },
        },
        reason: '验证汉字下限',
        root,
      })
      await engine.getBrief({ stage: 'P3', root })
      await expect(
        engine.submitDraft({
          chapter: 1,
          content: cleanText(),
          chapter_title: '开端之雨',
          scene_type: '日常过渡章',
          narrator: '他',
          summary: sampleSummary(),
          root,
        }),
      ).rejects.toMatchObject({
        code: 'ENGINE_GATE_BLOCKED',
        blocking: expect.arrayContaining([expect.objectContaining({ code: 'PG-03' })]),
      })
    } finally {
      await cleanup()
    }
  })
})
