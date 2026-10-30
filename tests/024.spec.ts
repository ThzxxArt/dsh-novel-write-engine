import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OUTLINE_FILE } from '../src/constants.js'
import type { EngineService } from '../src/engine/service.js'
import type { OutlineChapterInput } from '../src/engine/book.js'
import { archiveDelta, harness, readProjectFile, readyToArchive, sampleSummary } from './helpers.js'

const card = (num: number, title: string, patch: Partial<OutlineChapterInput> = {}): OutlineChapterInput => ({
  num,
  title,
  scene_type: '日常过渡章',
  goal: `目标${num}`,
  conflict: `冲突${num}`,
  hook: `钩子${num}`,
  cast: ['他'],
  target_words: [80, 400],
  ...patch,
})

const project = async (engine: EngineService, root: string): Promise<void> => {
  await engine.initProject({
    title: '0.2.4 大纲之书',
    genre: '都市现代',
    platform: 'fanqie',
    root,
    words_per_chapter: [80, 400],
    total_chapters: 5,
  })
}

const outline = async (engine: EngineService, root: string) =>
  (await engine.queryState({ kind: 'outline', root })).data as {
    chapters: Array<Record<string, unknown>>
    volumes: Array<Record<string, unknown>>
  }

describe('0.2.4 outline upsert contract', () => {
  it('upserts by num and preserves every omitted planned card', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await project(engine, root)
      await expect(
        engine.submitOutline({ book: { strict_explicit: true } as never, root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitOutline({ chapters: [card(1, '开端之雨', { volume: 9 })], root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const initial = await engine.submitOutline({
        chapters: [
          card(1, '开端之雨', { notes: '旧备注', cast: ['他', '她'] }),
          card(2, '旧城之影'),
          card(3, '灯下之言'),
        ],
        root,
      })
      expect(initial.data.added).toEqual([1, 2, 3])
      const firstUpdate = card(1, '开端之雨', { goal: '只改第一章目标' })
      delete firstUpdate.cast
      delete firstUpdate.notes
      const result = await engine.submitOutline({ chapters: [firstUpdate], root })
      expect(result.data).toMatchObject({
        planned: 3,
        added: [],
        updated: [1],
        removed: [],
      })
      const document = await outline(engine, root)
      expect(document.chapters.map((item) => item.num)).toEqual([1, 2, 3])
      expect(document.chapters[0]?.goal).toBe('只改第一章目标')
      expect(document.chapters[0]).toMatchObject({ notes: '旧备注', cast: ['他', '她'] })
      expect(document.chapters[1]).toMatchObject({
        num: 2,
        title: '旧城之影',
        goal: '目标2',
        conflict: '冲突2',
        hook: '钩子2',
        target_words: [80, 400],
      })
      const nullUpdate = {
        ...card(1, '开端之雨', { goal: '目标2' }),
        cast: null,
        notes: null,
      } as unknown as OutlineChapterInput
      await engine.submitOutline({ chapters: [nullUpdate], root })
      const nullDocument = await outline(engine, root)
      expect(nullDocument.chapters[0]).toMatchObject({ notes: '旧备注', cast: ['他', '她'] })
    } finally {
      await cleanup()
    }
  })

  it('makes deletion explicit and makes an empty submission a true no-op', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await project(engine, root)
      await engine.submitOutline({ chapters: [card(1, '开端之雨'), card(2, '旧城之影')], root })
      const before = await readProjectFile(root, OUTLINE_FILE)
      const noop = await engine.submitOutline({ chapters: [], root })
      expect(noop.data).toMatchObject({ planned: 2, added: [], updated: [], removed: [] })
      expect(await readProjectFile(root, OUTLINE_FILE)).toBe(before)
      const noopVolumes = await engine.submitOutline({ volumes: [], root })
      const noopBook = await engine.submitOutline({ book: {}, root })
      expect(noopVolumes.data).toMatchObject({ volumes: 0, added: [], updated: [] })
      expect(noopBook.data).toMatchObject({ added: [], updated: [] })
      expect(await readProjectFile(root, OUTLINE_FILE)).toBe(before)

      const removed = await engine.submitOutline({ remove: [2], root })
      expect(removed.data).toMatchObject({ planned: 1, removed: [2] })
      expect((await outline(engine, root)).chapters.map((item) => item.num)).toEqual([1])
    } finally {
      await cleanup()
    }
  })

  it('rejects removing the active, archived, unknown or submitted card', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await project(engine, root)
      await engine.submitOutline({ chapters: [card(1, '开端之雨'), card(2, '旧城之影')], root })
      await expect(engine.submitOutline({ chapters: [], remove: [1], root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.submitOutline({ chapters: [], remove: [9], root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(
        engine.submitOutline({ chapters: [card(2, '旧城之影')], remove: [2], root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('refuses removing an archived card', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root,
      })
      await expect(engine.submitOutline({ remove: [1], root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
        message: expect.stringContaining('archived'),
      })
      const backups = await engine.queryState({ kind: 'backups', root })
      const entries = backups.data as {
        backups: Array<{ name: string; op: string; files: string[] }>
      }
      const archiveBackup = entries.backups.find(
        (entry) => entry.op === 'archiveChapter' && entry.files.includes(OUTLINE_FILE),
      )
      expect(archiveBackup).toBeDefined()
      await expect(
        engine.restoreBackup({ txid: archiveBackup!.name, paths: [OUTLINE_FILE], root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('refuses removing a volume containing an archived chapter', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.submitBookPlan({
        volumes: [{ title: '第一卷', start_chapter: 1, end_chapter: 5 }],
        root,
      })
      await engine.submitOutline({ chapters: [card(1, '开端之雨', { volume: 1, cast: [] })], root })
      await engine.getBrief({ stage: 'P8', root })
      await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root,
      })
      await expect(engine.submitOutline({ remove_volumes: ['第一卷'], root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
        message: expect.stringContaining('archived'),
      })
      await expect(
        engine.submitBookPlan({
          volumes: [{ title: '第二卷', start_chapter: 2, end_chapter: 5 }],
          confirm_remove: true,
          root,
        }),
      ).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
        message: expect.stringContaining('archived'),
      })
      const beforeImport = await readProjectFile(root, OUTLINE_FILE)
      await expect(
        engine.importOutline({
          format: 'yaml',
          content: [
            'volumes:',
            '  - title: 第二卷',
            '    start_chapter: 2',
            '    end_chapter: 5',
            'chapters: []',
          ].join('\n'),
          dry_run: true,
          root,
        }),
      ).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
        message: expect.stringContaining('archived'),
      })
      expect(await readProjectFile(root, OUTLINE_FILE)).toBe(beforeImport)
    } finally {
      await cleanup()
    }
  })

  it('dry_run reports would_* and never changes the outline or journal', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await project(engine, root)
      await engine.submitOutline({ chapters: [card(1, '开端之雨'), card(2, '旧城之影')], root })
      const beforeOutline = await readProjectFile(root, OUTLINE_FILE)
      const beforeJournal = await readFile(join(root, 'state/journal.jsonl'), 'utf8')
      await expect(engine.submitOutline({ remove: [1], dry_run: true, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      expect(await readProjectFile(root, OUTLINE_FILE)).toBe(beforeOutline)
      expect(await readFile(join(root, 'state/journal.jsonl'), 'utf8')).toBe(beforeJournal)
      const preview = await engine.submitOutline({
        chapters: [card(1, '开端之雨', { goal: '预演目标' }), card(3, '灯下之言')],
        remove: [2],
        dry_run: true,
        root,
      })
      expect(preview.data).toMatchObject({
        dry_run: true,
        would_add: [3],
        would_update: [1],
        would_remove: [2],
        added: [],
        updated: [],
        removed: [],
      })
      expect(await readProjectFile(root, OUTLINE_FILE)).toBe(beforeOutline)
      expect(await readFile(join(root, 'state/journal.jsonl'), 'utf8')).toBe(beforeJournal)
    } finally {
      await cleanup()
    }
  })

  it('keeps the previous outline as a deprecated repair copy', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await project(engine, root)
      await engine.submitOutline({ chapters: [card(1, '开端之雨')], root })
      const initial = await readProjectFile(root, OUTLINE_FILE)
      await engine.submitOutline({
        chapters: [card(1, '开端之雨', { goal: '第二次目标' })],
        root,
      })
      expect(await readProjectFile(root, 'outline/outline.deprecated.yaml')).toBe(initial)
    } finally {
      await cleanup()
    }
  })

  it('restores outline.yaml from a backup without a chapter argument', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await project(engine, root)
      await engine.submitOutline({ chapters: [card(1, '开端之雨'), card(2, '旧城之影')], root })
      const initial = await readProjectFile(root, OUTLINE_FILE)
      await engine.submitOutline({
        chapters: [card(1, '开端之雨'), card(2, '旧城之影'), card(3, '灯下之言')],
        root,
      })
      const backups = await engine.queryState({ kind: 'backups', root })
      const entries = backups.data as {
        backups: Array<{ name: string; op: string; files: string[] }>
      }
      const entry = entries.backups.find(
        (item) => item.op === 'submitOutline' && item.files.includes(OUTLINE_FILE),
      )
      expect(entry).toBeDefined()
      await engine.submitOutline({
        chapters: [card(1, '开端之雨'), card(2, '旧城之影'), card(3, '灯下之言'), card(4, '雨停之后')],
        root,
      })
      expect(await readProjectFile(root, OUTLINE_FILE)).not.toBe(initial)
      expect(await readProjectFile(root, 'outline/outline.deprecated.yaml')).not.toBe(initial)
      await expect(
        engine.restoreBackup({ txid: entry!.name, chapter: 1, paths: [OUTLINE_FILE], root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const restored = await engine.restoreBackup({
        txid: entry!.name,
        paths: [OUTLINE_FILE],
        root,
      })
      expect(restored.data.restored).toEqual([OUTLINE_FILE])
      expect(await readProjectFile(root, OUTLINE_FILE)).toBe(initial)
    } finally {
      await cleanup()
    }
  })

  it('upserts volumes by title and requires explicit volume removal', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await project(engine, root)
      await engine.submitBookPlan({
        volumes: [
          { title: '第一卷', start_chapter: 1, end_chapter: 2 },
          { title: '第二卷', start_chapter: 3, end_chapter: 5 },
        ],
        root,
      })
      await engine.submitOutline({
        chapters: [
          card(1, '开端之雨', { volume: 1 }),
          card(2, '旧城之影', { volume: 1 }),
          card(3, '灯下之言', { volume: 2 }),
        ],
        root,
      })
      await expect(engine.submitOutline({ remove_volumes: ['不存在'], root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await engine.submitBookPlan({
        volumes: [
          { title: '第一卷', start_chapter: 1, end_chapter: 2 },
          { title: '第二卷', start_chapter: 3, end_chapter: 5, status: 'done' },
        ],
        root,
      })
      await expect(engine.submitOutline({ remove_volumes: ['第二卷'], root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      const removed = await engine.submitOutline({
        remove_volumes: ['第一卷'],
        root,
      })
      expect(removed.data).toMatchObject({ volumes: 1, reindexed: [1, 2, 3], volumes_removed: ['第一卷'] })
      const document = await outline(engine, root)
      expect(document.volumes).toHaveLength(1)
      expect(document.volumes[0]).toMatchObject({ title: '第二卷', start_chapter: 3 })
      expect(document.chapters[0]?.volume).toBeNull()
      expect(document.chapters[2]?.volume).toBe(1)
      // Removing a volume frees the title, not the numeric id. A later upsert
      // must allocate a fresh id instead of colliding with the surviving V2.
      const addedResult = await engine.submitOutline({
        volumes: [{ title: '新第一卷', start_chapter: 1, end_chapter: 2 }],
        root,
      })
      expect(addedResult.data).toMatchObject({ volumes_added: ['新第一卷'] })
      const added = await outline(engine, root)
      expect(added.volumes.map((volume) => volume.title)).toEqual(['新第一卷', '第二卷'])
      expect(new Set(added.volumes.map((volume) => volume.id)).size).toBe(2)
    } finally {
      await cleanup()
    }
  })

  it('requires confirm_remove before a blueprint volume replacement drops a volume', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await project(engine, root)
      await engine.submitBookPlan({
        volumes: [
          { title: '第一卷', start_chapter: 1, end_chapter: 2 },
          { title: '第二卷', start_chapter: 3, end_chapter: 5 },
        ],
        root,
      })
      await expect(
        engine.submitBookPlan({
          volumes: [{ title: '第一卷', start_chapter: 1, end_chapter: 2 }],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitBookPlan({
          volumes: [
            { title: '重复卷', start_chapter: 1, end_chapter: 2 },
            { title: '重复卷', start_chapter: 3, end_chapter: 5 },
          ],
          confirm_remove: true,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const applied = await engine.submitBookPlan({
        volumes: [{ title: '第一卷', start_chapter: 1, end_chapter: 2 }],
        confirm_remove: true,
        root,
      })
      expect(applied.data.volumes).toBe(1)
    } finally {
      await cleanup()
    }
  })
})
