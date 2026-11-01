import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import { BACKUP_DIR, OUTLINE_FILE } from '../src/constants.js'
import type { OutlineChapterInput } from '../src/engine/book.js'
import { sha256 } from '../src/store/fs.js'
import { archiveDelta, harness, readyToArchive, sampleSummary } from './helpers.js'

const card = (targetWords: [number, number], goal = '真实目标'): OutlineChapterInput => ({
  num: 1,
  title: '开端之雨',
  scene_type: '日常过渡章',
  goal,
  conflict: '真实冲突',
  hook: '真实钩子',
  cast: [],
  target_words: targetWords,
  notes: '真实备注',
})

const setup = async (): Promise<{
  root: string
  engine: Awaited<ReturnType<typeof harness>>['engine']
  cleanup: () => Promise<void>
}> => {
  const { root, engine, cleanup } = await harness()
  await readyToArchive({ root, engine })
  await engine.submitOutline({ chapters: [card([100, 200])], root })
  await engine.getBrief({ stage: 'P8', root })
  await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
  return { root, engine, cleanup }
}

const outlineOf = async (engine: Awaited<ReturnType<typeof harness>>['engine'], root: string) =>
  (await engine.queryState({ kind: 'outline', root })).data as Record<string, unknown>

const corruptOutline = async (root: string): Promise<void> => {
  await writeFile(join(root, OUTLINE_FILE), 'chapters: [\n', 'utf8')
}

const removeBackups = async (root: string): Promise<void> => {
  await rm(join(root, BACKUP_DIR), { recursive: true, force: true })
}

const chaptersOf = async (
  root: string,
): Promise<{ schema_version: 1; chapters: Array<Record<string, unknown>> }> =>
  parse(await readFile(join(root, 'state/chapters.yaml'), 'utf8')) as {
    schema_version: 1
    chapters: Array<Record<string, unknown>>
  }

describe('0.2.9 archive-card evidence', () => {
  it('writes the protected card and lets the true card repair a lost outline', async () => {
    const { root, engine, cleanup } = await setup()
    try {
      const rows = await chaptersOf(root)
      expect(rows.chapters[0]?.archive_card).toMatchObject({
        target_words: [100, 200],
        goal: '真实目标',
        conflict: '真实冲突',
        hook: '真实钩子',
        notes: '真实备注',
        cast: [],
      })
      expect(rows.chapters[0]?.archive_card_digest).toMatch(/^v1:/)
      const outline = await outlineOf(engine, root)
      await removeBackups(root)
      await corruptOutline(root)
      await engine.amend({
        path: OUTLINE_FILE,
        content: outline,
        reason: 'repair the lost outline from the recorded card',
        root,
      })
      const repaired = await outlineOf(engine, root)
      expect(repaired.chapters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            num: 1,
            target_words: [100, 200],
            goal: '真实目标',
            conflict: '真实冲突',
            hook: '真实钩子',
            notes: '真实备注',
          }),
        ]),
      )
    } finally {
      await cleanup()
    }
  })

  it('rejects a guessed card when the outline and backups are gone', async () => {
    const { root, engine, cleanup } = await setup()
    try {
      const outline = await outlineOf(engine, root)
      await removeBackups(root)
      await corruptOutline(root)
      const guessed = structuredClone(outline) as {
        chapters: Array<Record<string, unknown>>
      }
      guessed.chapters[0] = {
        ...guessed.chapters[0],
        target_words: [80, 400],
        goal: 'g',
      }
      await expect(
        engine.amend({
          path: OUTLINE_FILE,
          content: guessed,
          reason: 'guess the archived card',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('fails closed for a legacy record without archive_card when the outline is unreadable', async () => {
    const { root, engine, cleanup } = await setup()
    try {
      const outline = await outlineOf(engine, root)
      const rows = await chaptersOf(root)
      for (const row of rows.chapters) {
        delete row.archive_card
        delete row.archive_card_digest
      }
      const chaptersText = stringify(rows)
      await writeFile(join(root, 'state/chapters.yaml'), chaptersText, 'utf8')
      // Model an old project whose recorded archive row has no archive_card:
      // rewrite the fixture's journal hash so the test reaches amend evidence
      // instead of stopping at the external-edit detector.
      const journalPath = join(root, 'state/journal.jsonl')
      const journal = (await readFile(journalPath, 'utf8'))
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { hashes?: Record<string, string> })
      for (const entry of journal) {
        if (entry.hashes?.['state/chapters.yaml'] !== undefined) {
          entry.hashes['state/chapters.yaml'] = sha256(Buffer.from(chaptersText).toString('base64'))
        }
      }
      await writeFile(journalPath, `${journal.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
      await removeBackups(root)
      await corruptOutline(root)
      await expect(
        engine.amend({
          path: OUTLINE_FILE,
          content: outline,
          reason: 'repair without provable evidence',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('fails closed while chapters.yaml is unreadable', async () => {
    const { root, engine, cleanup } = await setup()
    try {
      const outline = await outlineOf(engine, root)
      await writeFile(join(root, 'state/chapters.yaml'), 'chapters: [\n', 'utf8')
      const guessed = structuredClone(outline) as {
        chapters: Array<Record<string, unknown>>
      }
      guessed.chapters[0] = {
        ...guessed.chapters[0],
        target_words: [80, 400],
        goal: 'g',
      }
      await expect(
        engine.amend({
          path: OUTLINE_FILE,
          content: guessed,
          reason: 'attempt while the index is unreadable',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })
})
