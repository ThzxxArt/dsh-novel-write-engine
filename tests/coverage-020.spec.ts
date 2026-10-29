import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { archiveDelta, cleanText, harness, readyToArchive, sampleSummary } from './helpers.js'

const validInit = {
  title: '覆盖之书',
  genre: '都市现代' as const,
  platform: 'fanqie' as const,
}

describe('0.2.0 service validation coverage', () => {
  it('rejects malformed init inputs and a second project', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const init = (patch: Record<string, unknown>): Promise<unknown> =>
        engine.initProject({ ...validInit, root, ...patch } as never)
      await expect(init({ title: '   ' })).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(init({ author: 1 })).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(init({ description: 1 })).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(init({ genre: 'bad' })).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(init({ platform: 'bad' })).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(init({ words_per_chapter: [1] })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(init({ words_per_chapter: [0, 1] })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(init({ total_chapters: 0 })).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(init({ dialogue_ratio: [1] })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(init({ dialogue_ratio: [2, 1] })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(init({})).resolves.toBeDefined()
      await expect(init({})).rejects.toMatchObject({ code: 'ENGINE_PROJECT_EXISTS' })
    } finally {
      await cleanup()
    }
  })

  it('rejects malformed search, export and book inputs before writing', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await expect(engine.search({ query: ' ' })).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(engine.search({ query: 'x'.repeat(201) })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.search({ query: 'x', scope: 'bad' as never })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.search({ query: 'x', limit: 0 })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.search({ query: 'x', limit: 51 })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.search({ query: 'x', limit: 1.5 })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.export({ kind: 'pdf' as never })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.export({ kind: 'outline', chapter: 1 })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.export({ kind: 'md', chapter: 0 })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })

      await engine.initProject({ ...validInit, root })
      await expect(engine.submitBookPlan({ bogus: true, root } as never)).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.submitOutline({ bogus: true, chapters: [], root } as never)).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(
        engine.importOutline({
          format: 'yaml',
          content: 'chapters: []',
          bogus: true,
          root,
        } as never),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitBookPlan({
          volumes: [
            { title: 'a', start_chapter: 1, end_chapter: 2 },
            { title: 'b', start_chapter: 4, end_chapter: 5 },
          ],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitBookPlan({
          volumes: Array.from({ length: 51 }, (_, i) => ({
            title: `v${i}`,
            start_chapter: i + 1,
            end_chapter: i + 1,
          })),
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(engine.submitWorldbook({ root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.submitWorldbook({ unknown: true, root } as never)).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(
        engine.submitWorldbook({
          locations: [{ name: '', description: '', layout: '', capacity: -1 }],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(engine.submitOutline({ chapters: [{}], root } as never)).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(
        engine.submitOutline({
          chapters: [
            {
              num: 1,
              title: '开端之雨',
              scene_type: '日常过渡章',
              goal: '',
              conflict: '',
              hook: '',
              target_words: [80, 400],
            },
          ],
          root,
        } as never),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(engine.submitOutline({ chapters: [], volumes: 'x', root } as never)).rejects.toMatchObject(
        { code: 'ENGINE_SCHEMA_INVALID' },
      )
    } finally {
      await cleanup()
    }
  })

  it('rejects malformed amend targets and protects planning invariants', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ ...validInit, root })
      await expect(engine.amend({ path: '', reason: 'x', content: {}, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(
        engine.amend({ path: 'outline/outline.yaml', reason: '', content: {}, root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({ path: 'outline/outline.yaml', reason: 'x', content: [], root } as never),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({ path: 'chapters/x.md', reason: 'x', content: {}, root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({
          path: 'outline/outline.yaml',
          reason: 'x',
          content: { schema_version: 1, updated_at: 'x', book: {}, volumes: [], chapters: [] },
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({
          path: 'outline/outline.yaml',
          reason: 'x',
          content: {
            schema_version: 1,
            updated_at: 'x',
            book: {
              premise: '',
              logline: '',
              themes: [],
              tone: '',
              pov: '',
              audience: '',
              selling_points: [],
              ending: '',
              strict: false,
              extra: true,
            },
            volumes: [],
            chapters: [],
          },
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({
          path: 'outline/worldbook.yaml',
          reason: 'x',
          content: {
            schema_version: 1,
            updated_at: 'x',
            premise: '',
            setting: '',
            rules: [],
            factions: [],
            locations: [{ name: 'a', description: 'b', layout: '', capacity: -1 }],
            characters: [],
            glossary: [],
            backstory: [],
            themes: [],
          },
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('reports damaged planning, journal drift and a damaged review without wedging reads', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = cleanText()
      await readyToArchive({ root, engine, text })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      await writeFile(join(root, 'reviews/ch001.review.yaml'), 'bad: [yaml\n', 'utf8')
      const report = await engine.report({ root })
      expect(report.data.progress.archived).toBe(1)
      const chapters = structuredClone(
        (await engine.queryState({ kind: 'chapters', include_summary: true, root })).data,
      ) as { chapters: Array<Record<string, unknown>> }
      chapters.chapters[0]!.word_count = Number(chapters.chapters[0]!.word_count) + 1
      await writeFile(join(root, 'state/chapters.yaml'), JSON.stringify(chapters), 'utf8')
      const panel = await engine.panelSummary({ root })
      expect(panel.health?.ok).toBe(false)
      expect(panel.next?.tool).toBe('novel_audit')
      await writeFile(join(root, 'outline/outline.yaml'), 'book: [bad]\n', 'utf8')
      const doctor = await engine.doctor({ root })
      expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id: 'outline', severity: 'error' }))
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'OUTLINE_UNREADABLE' })]),
      )
    } finally {
      await cleanup()
    }
  })

  it('exposes every damaged ledger through status, queryState and doctor', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ ...validInit, root })
      const kinds = [
        ['chapters', 'state/chapters.yaml'],
        ['characters', 'state/characters.yaml'],
        ['world', 'state/world.yaml'],
        ['locks', 'state/locks.yaml'],
        ['timeline', 'state/timeline.yaml'],
        ['foreshadows', 'state/foreshadows.yaml'],
        ['relationships', 'state/relationships.yaml'],
        ['handoff', 'state/handoff.yaml'],
      ] as const
      for (const [, path] of kinds) await writeFile(join(root, path), 'bad: [yaml\n', 'utf8')
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toHaveLength(kinds.length)
      for (const [kind] of kinds) {
        const raw = await engine.queryState({ kind, root })
        expect(raw.data).toMatchObject({ error: expect.any(String), raw: 'bad: [yaml\n' })
      }
      const doctor = await engine.doctor({ root })
      expect(doctor.data.ok).toBe(false)
      expect(doctor.data.checks.some((check) => check.id.startsWith('state:'))).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('exposes damaged world/chapter plans, review and check through raw state', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ ...validInit, root })
      for (const dir of ['plans', 'reviews', 'checks']) {
        await mkdir(join(root, dir), { recursive: true })
      }
      const files = [
        'plans/ch001.world.yaml',
        'plans/ch001.chapter.yaml',
        'reviews/ch001.review.yaml',
        'checks/ch001.check.yaml',
      ]
      for (const path of files) await writeFile(join(root, path), 'bad: [yaml\n', 'utf8')
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'WORLD_PLAN_UNREADABLE' }),
          expect.objectContaining({ code: 'PLAN_UNREADABLE' }),
          expect.objectContaining({ code: 'REVIEW_UNREADABLE' }),
          expect.objectContaining({ code: 'CHECK_UNREADABLE' }),
        ]),
      )
      for (const [kind, chapter] of [
        ['review', 1],
        ['check', 1],
      ] as const) {
        const raw = await engine.queryState({ kind, chapter, root })
        expect(raw.data).toMatchObject({ error: expect.any(String), raw: 'bad: [yaml\n' })
      }
      const doctor = await engine.doctor({ root })
      expect(doctor.data.ok).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('rejects project, lock and handoff amendment variants', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine, text: cleanText() })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const project = structuredClone((await engine.queryState({ kind: 'novel', root })).data) as Record<
        string,
        unknown
      >
      const amend = (path: string, content: Record<string, unknown>): Promise<unknown> =>
        engine.amend({ path, content, reason: 'coverage probe', root })
      for (const patch of [
        { genre: '玄幻修仙' },
        { platform: 'qidian' },
        { created_at: '2000-01-01' },
        { targets: { ...(project.targets as object), words_per_chapter: [1, 2] } },
        { targets: { ...(project.targets as object), total_chapters: 0 } },
        { extra: true },
        { targets: null },
      ]) {
        await expect(amend('novel.yaml', { ...project, ...patch })).rejects.toMatchObject({
          code: 'ENGINE_SCHEMA_INVALID',
        })
      }
      const locks = structuredClone((await engine.queryState({ kind: 'locks', root })).data) as {
        characters: Record<string, unknown>
        locations: Record<string, unknown>
      }
      await expect(
        amend('state/locks.yaml', {
          ...(locks as object),
          characters: { ...locks.characters, ghost: { first_appearance: 1, locked_at: 1, appearance: '' } },
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        amend('state/locks.yaml', {
          ...(locks as object),
          locations: { ghost: { first_appearance: 1, locked_at: 1, layout: '', capacity: 0 } },
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const handoff = structuredClone((await engine.queryState({ kind: 'handoff', root })).data) as Record<
        string,
        unknown
      >
      for (const patch of [
        { current_chapter: -1 },
        { next_chapter: 0 },
        { next_chapter: 99 },
        { volume: 0 },
        { volume_name: '' },
        { act: '' },
        { act_progress: 'bad' },
        { open_hooks: [{ id: 'FS-999', title: 'x' }] },
      ]) {
        await expect(amend('state/handoff.yaml', { ...handoff, ...patch })).rejects.toMatchObject({
          code: 'ENGINE_SCHEMA_INVALID',
        })
      }
      for (const [kind, path] of [
        ['timeline', 'state/timeline.yaml'],
        ['foreshadows', 'state/foreshadows.yaml'],
        ['relationships', 'state/relationships.yaml'],
      ] as const) {
        const document = structuredClone((await engine.queryState({ kind, root })).data) as {
          next_seq: number
          items: Array<Record<string, unknown>>
        }
        await expect(amend(path, { ...document, next_seq: 0 })).rejects.toMatchObject({
          code: 'ENGINE_SCHEMA_INVALID',
        })
        await expect(amend(path, { ...document, items: [{ id: '' }] })).rejects.toMatchObject({
          code: 'ENGINE_SCHEMA_INVALID',
        })
        await expect(
          amend(path, { ...document, items: [{ id: 'X-001' }, { id: 'X-001' }] }),
        ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
        await expect(
          amend(path, { ...document, next_seq: 1, items: [{ id: 'X-099' }] }),
        ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      }
      const relationships = structuredClone(
        (await engine.queryState({ kind: 'relationships', root })).data,
      ) as { items: Array<Record<string, unknown>> }
      await expect(
        amend('state/relationships.yaml', {
          ...relationships,
          items: [{ id: 'RL-001', a: 1, b: '他', type: '友', since: 1, description: '', evolution: [] }],
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('rejects chapter-index amendments that would rewrite archive evidence', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine, text: cleanText() })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const chapters = structuredClone(
        (await engine.queryState({ kind: 'chapters', include_summary: true, root })).data,
      ) as { schema_version: 1; chapters: Array<Record<string, unknown>> }
      const amend = (document: typeof chapters): Promise<unknown> =>
        engine.amend({
          path: 'state/chapters.yaml',
          content: document as never,
          reason: 'coverage probe',
          root,
        })
      await expect(amend({ ...chapters, chapters: [] })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(
        amend({ ...chapters, chapters: [{ ...chapters.chapters[0]!, content_hash: 'different' }] }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        amend({ ...chapters, chapters: [{ ...chapters.chapters[0]!, archive_digest: 'different' }] }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        amend({
          ...chapters,
          chapters: [{ ...chapters.chapters[0]!, assigned_ids: { FS: 'FS-999' } }],
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        amend({ ...chapters, chapters: [{ ...chapters.chapters[0]!, num: 2 }] }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        amend({ ...chapters, chapters: [...chapters.chapters, chapters.chapters[0]!] }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('rejects ledger amendments that break reference or sequence invariants', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine, text: cleanText() })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const characters = structuredClone((await engine.queryState({ kind: 'characters', root })).data)
      await expect(
        engine.amend({
          path: 'state/characters.yaml',
          content: { ...(characters as object), characters: [] },
          reason: 'remove referenced character',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const timeline = structuredClone((await engine.queryState({ kind: 'timeline', root })).data)
      await expect(
        engine.amend({
          path: 'state/timeline.yaml',
          content: { ...(timeline as object), next_seq: 0 },
          reason: 'rewind timeline',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const handoff = structuredClone((await engine.queryState({ kind: 'handoff', root })).data)
      await expect(
        engine.amend({
          path: 'state/handoff.yaml',
          content: { ...(handoff as object), next_chapter: 99 },
          reason: 'break handoff',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const foreshadows = structuredClone((await engine.queryState({ kind: 'foreshadows', root })).data)
      await expect(
        engine.amend({
          path: 'state/foreshadows.yaml',
          content: { ...(foreshadows as object), next_seq: 0 },
          reason: 'rewind foreshadows',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const relationships = structuredClone(
        (await engine.queryState({ kind: 'relationships', root })).data,
      ) as { items: Array<Record<string, unknown>> }
      await expect(
        engine.amend({
          path: 'state/relationships.yaml',
          content: {
            ...(relationships as object),
            items: [
              { id: 'RL-999', a: '不存在', b: '他', type: '友', since: 1, description: '', evolution: [] },
            ],
          },
          reason: 'break relationship',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const project = structuredClone((await engine.queryState({ kind: 'novel', root })).data)
      await expect(
        engine.amend({
          path: 'novel.yaml',
          content: { ...(project as object), title: '' },
          reason: 'break project',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const worldbook = structuredClone((await engine.queryState({ kind: 'worldbook', root })).data) as {
        characters: Array<Record<string, unknown>>
      }
      await expect(
        engine.amend({
          path: 'outline/worldbook.yaml',
          content: {
            ...(worldbook as object),
            characters: [...worldbook.characters, { name: '他', role: 'x', description: '', arc: '' }],
          },
          reason: 'duplicate worldbook character',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const outline = structuredClone((await engine.queryState({ kind: 'outline', root })).data) as {
        chapters: Array<Record<string, unknown>>
      }
      await expect(
        engine.amend({
          path: 'outline/outline.yaml',
          content: {
            ...(outline as object),
            chapters: [{ ...outline.chapters[0]!, word_count: 999 }],
          },
          reason: 'change archived word count',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })
})
