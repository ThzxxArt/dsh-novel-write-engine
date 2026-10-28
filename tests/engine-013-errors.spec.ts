import { describe, expect, it } from 'vitest'
import { harness } from './helpers.js'

describe('0.1.3 input and maintenance error boundaries', () => {
  it('rejects invalid init metadata and numeric targets before writing a project', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const base = { title: '边界', genre: '都市现代' as const, platform: 'fanqie' as const, root }
      await expect(engine.initProject({ ...base, author: 1 as never })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.initProject({ ...base, description: 1 as never })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.initProject({ ...base, words_per_chapter: [1] as never })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.initProject({ ...base, words_per_chapter: [0, 1] as never })).rejects.toMatchObject(
        { code: 'ENGINE_SCHEMA_INVALID' },
      )
      await expect(
        engine.initProject({ ...base, words_per_chapter: [10, 5] as never }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(engine.initProject({ ...base, total_chapters: 0 })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(
        engine.initProject({ ...base, dialogue_ratio: [0.7, 0.4] as never }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(engine.initProject({ ...base, dialogue_ratio: [0, 2] as never })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.initProject({ ...base, genre: '不存在' as never })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.initProject({ ...base, platform: '不存在' as never })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.getStatus({ root })).rejects.toMatchObject({
        code: 'ENGINE_PROJECT_NOT_FOUND',
      })
    } finally {
      await cleanup()
    }
  })

  it('rejects invalid amend targets, reasons and pipeline documents', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: 'amend 边界', genre: '都市现代', platform: 'fanqie', root })
      await expect(
        engine.amend({ path: '../outside.yaml', content: {}, reason: 'x', root }),
      ).rejects.toMatchObject({ code: 'ENGINE_PATH_ESCAPE' })
      await expect(
        engine.amend({ path: 'state/pipeline.yaml', content: {}, reason: 'x', root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({ path: 'state/characters.yaml', content: {}, reason: ' ', root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({ path: 'state/characters.yaml', content: [] as never, reason: 'x', root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({
          path: 'state/characters.yaml',
          content: { schema_version: 1, characters: [] },
          reason: 'x',
          root,
        }),
      ).resolves.toMatchObject({ data: { path: 'state/characters.yaml' } })
    } finally {
      await cleanup()
    }
  })

  it('reads historical plan slots as null without treating them as damage', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '历史计划', genre: '都市现代', platform: 'fanqie', root })
      expect((await engine.queryState({ kind: 'planWorld', chapter: 2, root })).data).toBeNull()
      expect((await engine.queryState({ kind: 'planChapter', chapter: 2, root })).data).toBeNull()
    } finally {
      await cleanup()
    }
  })
})
