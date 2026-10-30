import { describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { FsStore } from '../src/store/fs.js'
import { readJournal } from '../src/store/journal.js'
import { applyStateDelta } from '../src/engine/state-delta.js'
import { emptyOutline, normalizeOutlineChapters } from '../src/engine/book.js'
import {
  archiveDelta,
  bootstrapToDraft,
  cleanText,
  harness,
  readProjectFile,
  readyToArchive,
  sampleReview,
  sampleSummary,
  writeDraft,
} from './helpers.js'

describe('third full review regressions', () => {
  it('repairs a torn tail before appending the lock-reclaim audit row', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      const store = new FsStore(root)
      await store.appendText('state/journal.jsonl', '{"txid":"torn","op":"amend","status":"comm')
      await writeFile(
        join(root, '.engine.lock'),
        JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() }),
        'utf8',
      )
      await engine.submitWorldbook({ themes: ['记忆'], root })
      expect((await readJournal(store)).malformed).toBe(0)
    } finally {
      await cleanup()
    }
  })

  it('refuses to initialize over a surviving journal or derived digest mirror', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '旧书', genre: '都市现代', platform: 'fanqie', root })
      for (const name of [
        'novel.yaml',
        'state/pipeline.yaml',
        'state/chapters.yaml',
        'state/characters.yaml',
        'state/world.yaml',
        'state/locks.yaml',
        'state/timeline.yaml',
        'state/foreshadows.yaml',
        'state/relationships.yaml',
        'state/handoff.yaml',
        'outline/outline.yaml',
        'outline/worldbook.yaml',
      ]) {
        await rm(join(root, name), { force: true })
      }
      await expect(
        engine.initProject({ title: '新书', genre: '都市现代', platform: 'fanqie', root }),
      ).rejects.toMatchObject({ code: 'ENGINE_PROJECT_EXISTS' })
    } finally {
      await cleanup()
    }
  })

  it('fails closed when the journal has no committed project transaction', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await writeFile(join(root, 'state/journal.jsonl'), '', 'utf8')
      await writeFile(
        join(root, '.engine.lock'),
        JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() }),
        'utf8',
      )
      await expect(
        engine.amend({ path: 'state/world.yaml', content: { schema_version: 1 }, reason: 'x', root }),
      ).rejects.toMatchObject({ code: 'ENGINE_JOURNAL_MISSING' })
      const status = await engine.getStatus({ root })
      expect(status.data.blocking).toContainEqual(expect.objectContaining({ code: 'JOURNAL_MISSING' }))
      expect(status.data.next.tool).toBe('novel_audit')
    } finally {
      await cleanup()
    }
  })

  it('refuses to rewrite a world entity name through detail', () => {
    expect(() =>
      applyStateDelta({
        chapter: 1,
        text: '旧能',
        summary: sampleSummary({
          events: ['旧能'],
          characters_appeared: [],
          opening: '旧能',
        }),
        delta: {
          characters: {},
          world: { 旧能: { action: 'updated', detail: { name: '新能' } } },
          foreshadows: {},
          timeline: { '0': { action: 'created' } },
          relationships: {},
        },
        characters: { schema_version: 1, characters: [] },
        world: {
          schema_version: 1,
          locations: [],
          abilities: [{ name: '旧能', first_appearance: 1, description: '旧能力' }],
          artifacts: [],
          factions: [],
          rules: [],
        },
        locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
        foreshadows: { schema_version: 1, next_seq: 1, items: [] },
        timeline: { schema_version: 1, next_seq: 1, items: [] },
        relationships: { schema_version: 1, next_seq: 1, items: [] },
      } as never),
    ).toThrow(/reserved field "name"/)
  })

  it('recomputes an archived card volume when volume ranges are restructured', () => {
    const existing = {
      num: 2,
      volume: 1,
      title: '第二场雨',
      scene_type: '日常过渡章',
      goal: '目标',
      conflict: '冲突',
      hook: '钩子',
      cast: [],
      target_words: [80, 400],
      notes: '',
      status: 'archived',
      archived_at: '2026-01-01T00:00:00.000Z',
      word_count: 120,
      score: 145,
    }
    const record = {
      num: 2,
      title: '第二场雨',
      file: 'chapters/chapter-002.md',
      word_count: 120,
      dialogue_lines: 2,
      dialogue_ratio: 0.2,
      scene_type: '日常过渡章',
      narrator: '他',
      score: 145,
      status: 'reviewed',
      content_hash: 'sha256:test',
      summary: sampleSummary(),
    }
    const normalized = normalizeOutlineChapters([{ ...existing }], {
      volumes: [
        {
          id: 'V1',
          title: '上',
          start_chapter: 1,
          end_chapter: 1,
          goal: '',
          arc: '',
          climax: '',
          status: 'planned',
        },
        {
          id: 'V2',
          title: '下',
          start_chapter: 2,
          end_chapter: 30,
          goal: '',
          arc: '',
          climax: '',
          status: 'planned',
        },
      ],
      existing: [existing] as never,
      archived: [record] as never,
      titleRule: { pattern: '^', min_chars: 4, max_chars: 8 },
      totalChapters: null,
      defaultTargetWords: [80, 400],
      now: '2026-01-02T00:00:00.000Z',
    })
    expect(normalized[0]?.volume).toBe(2)
  })

  it('protects archived chapter facts from amend rewrites', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root,
      })
      const chapters = (await engine.queryState({ kind: 'chapters', include_summary: true, root })).data as {
        chapters: Array<Record<string, unknown>>
      }
      const changed = structuredClone(chapters)
      changed.chapters[0]!.score = 150
      changed.chapters[0]!.word_count = 99999
      await expect(
        engine.amend({ path: 'state/chapters.yaml', content: changed, reason: '篡改归档事实', root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('initializes through a stale lock without treating the reclaim row as project history', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await writeFile(
        join(root, '.engine.lock'),
        JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() }),
        'utf8',
      )
      await expect(
        engine.initProject({ title: '新书', genre: '都市现代', platform: 'fanqie', root }),
      ).resolves.toMatchObject({ data: { title: '新书' } })
      const journal = await readJournal(new FsStore(root))
      expect(journal.records.some((record) => record.op === 'lock_reclaimed')).toBe(true)
      expect(journal.records.some((record) => record.op === 'initProject')).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('does not treat a same-pid leftover lock without a live nonce as a writer', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await writeFile(
        join(root, '.engine.lock'),
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          nonce: 'leftover-from-a-failed-unlink',
        }),
        'utf8',
      )
      const status = await engine.getStatus({ root })
      expect(status.data.stage).toBe('idle')
      expect(status.data.state_errors).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('surfaces a journal mismatch even when a stale lock file remains', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await writeFile(join(root, 'state/world.yaml'), 'locations: [broken\n', 'utf8')
      await writeFile(
        join(root, '.engine.lock'),
        JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() }),
        'utf8',
      )
      const status = await engine.getStatus({ root })
      expect(status.data.blocking).toContainEqual(expect.objectContaining({ code: 'JOURNAL_HASH_MISMATCH' }))
    } finally {
      await cleanup()
    }
  })

  it('reports four-digit chapter files as orphans', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await mkdir(join(root, 'chapters'), { recursive: true })
      await writeFile(join(root, 'chapters/chapter-1000.md'), '四位数章节', 'utf8')
      const doctor = await engine.doctor({ root })
      const orphan = doctor.data.checks.find((check) => check.id === 'orphans')
      expect(orphan?.detail).toContain('1000')
    } finally {
      await cleanup()
    }
  })

  it('accepts a hand-edited planned card that omits null archive fields', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      const outline = emptyOutline('2026-01-01T00:00:00.000Z')
      outline.chapters = [
        {
          num: 1,
          title: '开端之雨',
          scene_type: '日常过渡章',
          goal: '收信',
          conflict: '拆不拆',
          hook: '日期',
          cast: [],
          target_words: [80, 400],
          notes: '',
          status: 'planned',
        } as never,
      ]
      await writeFile(join(root, 'outline/outline.yaml'), stringifyYaml(outline), 'utf8')
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).not.toContainEqual(
        expect.objectContaining({ code: 'OUTLINE_UNREADABLE' }),
      )
      expect(status.data.book?.outline.total).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('round-trips a volume-only outline through Markdown export/import', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '书', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitBookPlan({
        volumes: [{ title: '第一卷 雨夜', start_chapter: 1, end_chapter: 30 }],
        root,
      })
      await engine.export({ kind: 'outline', root })
      const markdown = await readProjectFile(root, 'exports/outline.md')
      expect(markdown).not.toBeNull()
      const applied = await engine.importOutline({
        format: 'markdown',
        content: markdown!,
        root,
      })
      expect(applied.data).toMatchObject({ applied: true, total: 0 })
      const outline = (await engine.queryState({ kind: 'outline', root })).data as {
        volumes: unknown[]
      }
      expect(outline.volumes).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })

  it('rejects a semantic item that would make the check document unreadable', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await writeDraft({ root, engine })
      const text = cleanText()
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      await engine.getBrief({ stage: 'P6', root })
      await expect(
        engine.runCheck({
          chapter: 1,
          semantic: [{ id: 'L2-VOICE', verdict: 'fail' } as never],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_CHECK_SUBMISSION_INVALID' })
      expect(await readProjectFile(root, 'checks/ch001.check.yaml')).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('treats a malformed stored chapter plan as damaged state', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const raw = await readProjectFile(root, 'plans/ch001.chapter.yaml')
      const plan = parseYaml(raw!) as Record<string, unknown>
      plan.beats = ['only one beat']
      plan.target_words = [400, 80]
      await writeFile(join(root, 'plans/ch001.chapter.yaml'), stringifyYaml(plan), 'utf8')
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toContainEqual(expect.objectContaining({ code: 'PLAN_UNREADABLE' }))
      expect(status.data.next.tool).toBe('novel_rollback')
    } finally {
      await cleanup()
    }
  })
})
