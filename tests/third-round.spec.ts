import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import {
  archiveDelta,
  bootstrapToDraft,
  cleanText,
  harness,
  readyToArchive,
  readProjectFile,
  sampleSummary,
} from './helpers.js'

/**
 * Third-round regressions. Each test names the behavior it protects, not the
 * implementation that currently happens to satisfy it.
 */
describe('0.1.3 third-round review regressions', () => {
  it('does not replay an active-chapter export after its plan title changes', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await engine.getBrief({ stage: 'P3', root })
      await engine.submitDraft({
        chapter: 1,
        content: cleanText(),
        chapter_title: '开端之雨',
        scene_type: '日常过渡章',
        narrator: '他',
        summary: sampleSummary(),
        root,
      })
      const first = await engine.export({ kind: 'md', chapter: 1, root })
      expect(first.replayed).not.toBe(true)
      expect(await readProjectFile(root, 'exports/book-ch001.md')).toContain('第1章 开端之雨')

      const planPath = join(root, 'plans', 'ch001.chapter.yaml')
      const plan = parseYaml((await readFile(planPath, 'utf8'))!) as Record<string, unknown>
      await writeFile(planPath, stringifyYaml({ ...plan, title: '换过的标题' }), 'utf8')

      const second = await engine.export({ kind: 'md', chapter: 1, root })
      expect(second.replayed).not.toBe(true)
      expect(await readProjectFile(root, 'exports/book-ch001.md')).toContain('换过的标题')
    } finally {
      await cleanup()
    }
  })

  it('refuses to rewrite assigned ids on an archived chapter row', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = sampleSummary({
        foreshadows: {
          planted: [{ key: 'hookA', title: '蜡印', description: '蜡印' }],
          advanced: [],
          resolved: [],
        },
      })
      await readyToArchive({ root, engine, summary })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root })
      const saved = await engine.queryState({ kind: 'chapters', include_summary: true, root })
      const forged = structuredClone(saved.data) as {
        chapters: Array<Record<string, unknown>>
      }
      forged.chapters[0]!.assigned_ids = {}
      await expect(
        engine.amend({
          path: 'state/chapters.yaml',
          content: forged as never,
          reason: 'erase an assigned id so it can be reused',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('refuses to lower next_seq while the chapters ledger cannot prove the floor', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = sampleSummary({
        foreshadows: {
          planted: [{ key: 'hookA', title: '蜡印', description: '蜡印' }],
          advanced: [],
          resolved: [],
        },
      })
      await readyToArchive({ root, engine, summary })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root })
      await writeFile(join(root, 'state', 'chapters.yaml'), 'chapters: [unclosed\n', 'utf8')
      await writeFile(join(root, 'state', 'handoff.yaml'), 'volume: [unclosed\n', 'utf8')
      await expect(
        engine.amend({
          path: 'state/foreshadows.yaml',
          content: { schema_version: 1, next_seq: 1, items: [] },
          reason: 'reuse FS-001 while the archive index is unreadable',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('budgets the counter of the operation the P6 status will recommend', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const pipelinePath = join(root, 'state', 'pipeline.yaml')
      const pipeline = parseYaml(await readFile(pipelinePath, 'utf8')) as {
        stage: string
        rounds: { review: number; revise: number; check: number }
        blocking: Array<{ code: string; detail: string }>
      }
      pipeline.stage = 'P6'
      pipeline.blocking = [{ code: 'SEMANTIC_CHECK_FAILED', detail: 'needs revision' }]
      pipeline.rounds = { review: 0, revise: 3, check: 0 }
      await writeFile(pipelinePath, stringifyYaml(pipeline))
      let status = await engine.getStatus({ root })
      expect(status.data.blocking).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'PG-11', detail: expect.stringContaining('revise') }),
        ]),
      )

      pipeline.blocking = []
      pipeline.rounds = { review: 0, revise: 0, check: 3 }
      await writeFile(pipelinePath, stringifyYaml(pipeline))
      status = await engine.getStatus({ root })
      expect(status.data.blocking).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'PG-11', detail: expect.stringContaining('check') }),
        ]),
      )
    } finally {
      await cleanup()
    }
  })

  it('refuses archive when the check scope lost integrity after ready', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const checkPath = join(root, 'checks', 'ch001.check.yaml')
      const check = parseYaml((await readFile(checkPath, 'utf8'))!) as {
        scope: string[]
      }
      check.scope = ['content']
      await writeFile(checkPath, stringifyYaml(check), 'utf8')
      await engine.getBrief({ stage: 'P8', root })
      const status = await engine.getStatus({ root })
      expect(status.data.blocking).toContainEqual(expect.objectContaining({ code: 'PG-12' }))
      expect(status.data.next).toMatchObject({ tool: 'novel_rollback', args: { to_stage: 'P6' } })
      await expect(
        engine.archiveChapter({
          chapter: 1,
          state_delta: archiveDelta(sampleSummary()),
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_GATE_BLOCKED' })
    } finally {
      await cleanup()
    }
  })

  it('keeps the P2 plan immutable when only its legacy summary is damaged', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const planPath = join(root, 'plans', 'ch001.chapter.yaml')
      const plan = parseYaml((await readFile(planPath, 'utf8'))!) as {
        summary?: Record<string, unknown>
      }
      plan.summary = { ...sampleSummary(), events: ['伪造的旧摘要'] }
      await writeFile(planPath, stringifyYaml(plan), 'utf8')
      await engine.getBrief({ stage: 'P8', root })
      const status = await engine.getStatus({ root })
      expect(status.data.blocking).not.toContainEqual(expect.objectContaining({ code: 'PG-05' }))
      // The live summary lives in pipeline.draft; the P2 plan file is evidence.
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      expect((await engine.queryState({ kind: 'chapters', root })).data).toMatchObject({
        chapters: [expect.objectContaining({ num: 1 })],
      })
    } finally {
      await cleanup()
    }
  })
})
