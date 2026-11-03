import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyOutline, emptyWorldbook } from '../src/engine/book.js'
import { OUTLINE_FILE } from '../src/constants.js'
import { panelHandler, panelPayload } from '../src/remote/index.js'
import { archiveDelta, harness, readyToArchive, sampleSummary } from './helpers.js'

describe('0.2.9 panel v7 sections', () => {
  it('returns window metadata and caps a legal oversized worldbook section at 64KB', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '大书',
        genre: '都市现代',
        platform: 'fanqie',
        root,
        description: '简介'.repeat(2000),
      })
      const long = '设定'.repeat(1000)
      const worldbook = emptyWorldbook('2026-01-01')
      worldbook.premise = long
      worldbook.setting = long
      worldbook.locations = Array.from({ length: 5 }, (_, index) => ({
        name: `地点${index}`,
        description: long,
        layout: '布局',
        capacity: index,
      }))
      worldbook.factions = Array.from({ length: 5 }, (_, index) => ({
        name: `势力${index}`,
        description: long,
        goal: '目标',
      }))
      worldbook.rules = Array.from({ length: 5 }, (_, index) => ({
        name: `规则${index}`,
        description: long,
      }))
      await engine.amend({
        path: 'outline/worldbook.yaml',
        content: worldbook as unknown as Record<string, unknown>,
        reason: 'max-size fixture',
        root,
      })
      const section = await engine.panelSection({ root, section: 'worldbook' })
      expect(section.payload_version).toBe(7)
      expect(Buffer.byteLength(JSON.stringify(section.items))).toBeLessThanOrEqual(64 * 1024)
      expect(section.truncated).toBe(true)
      expect(section.returned).toBeGreaterThan(0)
      const sectionItems = section.items as { locations?: Array<{ description: string }> }
      expect(sectionItems.locations?.[0]?.description.length).toBe(240)
      const filtered = await engine.panelSection({
        root,
        section: 'worldbook',
        query: { search: '地点3' },
      })
      expect(filtered.total).toBeGreaterThanOrEqual(1)
      expect(filtered.items).toMatchObject({ locations: [{ name: '地点3' }] })
    } finally {
      await cleanup()
    }
  })

  it('recursively caps a legal nested world ledger at 64KB', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '嵌套大书',
        genre: '都市现代',
        platform: 'fanqie',
        root,
      })
      const long = '设'.repeat(60000)
      await engine.amend({
        path: 'state/world.yaml',
        content: {
          schema_version: 1,
          locations: Array.from({ length: 3 }, (_, index) => ({
            name: `台账地点${index}`,
            first_appearance: 1,
            locked: false,
            description: long,
            layout: '',
            capacity: index,
            changes: [],
          })),
          abilities: [],
          artifacts: [],
          factions: [],
          rules: [],
        },
        reason: 'nested max-size fixture',
        root,
      })
      const section = await engine.panelSection({ root, section: 'worldbook' })
      expect(Buffer.byteLength(JSON.stringify(section.items))).toBeLessThanOrEqual(64 * 1024)
      expect(section.truncated).toBe(true)
      const clipped = section.items as { ledger?: { locations?: Array<{ description: string }> } }
      expect(clipped.ledger?.locations?.[0]?.description.length).toBe(240)
    } finally {
      await cleanup()
    }
  })

  it('refuses a section root that is not registered, active or configured', async () => {
    const { engine, cleanup } = await harness()
    const foreign = await mkdtemp(join(tmpdir(), 'nwe-foreign-'))
    try {
      await writeFile(join(foreign, 'novel.yaml'), 'schema_version: 1\n', 'utf8')
      await expect(engine.panelSection({ root: foreign, section: 'health' })).rejects.toMatchObject({
        code: 'ENGINE_PROJECT_NOT_FOUND',
      })
    } finally {
      await rm(foreign, { recursive: true, force: true })
      await cleanup()
    }
  })

  it('lazily reads chapter and quality detail with explicit totals', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const detail = await engine.panelSection({
        root,
        section: 'chapter_detail',
        query: { chapter: 1 },
      })
      const detailItems = detail.items as {
        chapter: number
        row: { num: number } | null
        manuscript: string | null
        plan: string | null
      }
      expect(detail.total).toBe(1)
      expect(detailItems.chapter).toBe(1)
      expect(detailItems.row?.num ?? 1).toBe(1)
      expect(detailItems.manuscript).not.toBeNull()
      expect(detailItems.plan).not.toBeNull()
      const quality = await engine.panelSection({
        root,
        section: 'quality_detail',
        query: { chapter: 1 },
      })
      const qualityItems = quality.items as { review: string | null; check: string | null }
      expect(quality.total).toBe(1)
      expect(qualityItems.review).not.toBeNull()
      expect(qualityItems.check).not.toBeNull()
      const summary = sampleSummary({ characters_appeared: ['他'] })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root })
      const archivedDetail = await engine.panelSection({
        root,
        section: 'chapter_detail',
        query: { chapter: 1 },
      })
      const archivedItems = archivedDetail.items as {
        row: { num: number; file: string } | null
        manuscript: string | null
        plan: string | null
        world_plan: string | null
      }
      expect(archivedItems.row?.num).toBe(1)
      expect(archivedItems.manuscript).not.toBeNull()
      expect(archivedItems.plan).not.toBeNull()
      expect(archivedItems.world_plan).not.toBeNull()
      const longText = '长'.repeat(840)
      await writeFile(join(root, archivedItems.row!.file), longText, 'utf8')
      const longDetail = await engine.panelSection({
        root,
        section: 'chapter_detail',
        query: { chapter: 1 },
      })
      expect((longDetail.items as { manuscript: string }).manuscript).toHaveLength(840)
      const missing = await engine.panelSection({
        root,
        section: 'chapter_detail',
        query: { chapter: 99 },
      })
      expect(missing.total).toBe(0)
      expect(missing.items).toMatchObject({ chapter: 99, manuscript: null })
      const missingQuality = await engine.panelSection({
        root,
        section: 'quality_detail',
        query: { chapter: 99 },
      })
      expect(missingQuality.total).toBe(0)
      await expect(
        engine.panelSection({ root, section: 'chapter_detail', query: { chapter: 0 } }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('marks the combined leads section truncated when timeline exceeds its window', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '时间线大书', genre: '都市现代', platform: 'fanqie', root })
      await engine.amend({
        path: 'state/timeline.yaml',
        content: {
          schema_version: 1,
          next_seq: 261,
          items: Array.from({ length: 260 }, (_, index) => ({
            id: `T-${index + 1}`,
            chapter: 1,
            story_time: `第${index + 1}天`,
            description: `事件${index + 1}`,
            location: '旧城',
            characters: [],
          })),
        },
        reason: 'timeline window fixture',
        root,
      })
      const section = await engine.panelSection({ root, section: 'foreshadows' })
      const items = section.items as { timeline: unknown[] }
      // The timeline is a preview; the pageable ledger is the foreshadow list,
      // so `total`/`returned` describe that ledger and `counts` carries the rest.
      expect(items.timeline).toHaveLength(50)
      expect(section.total).toBe(0)
      expect(section.truncated).toBe(true)
      const counts = section.counts as Record<string, { total: number; shown: number }>
      expect(counts.timeline).toEqual({ total: 260, shown: 50 })
    } finally {
      await cleanup()
    }
  })

  it('pages the foreshadow ledger instead of letting the byte cap eat it', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '九十伏笔', genre: '都市现代', platform: 'fanqie', root })
      await engine.amend({
        path: 'state/foreshadows.yaml',
        content: {
          schema_version: 1,
          next_seq: 91,
          items: Array.from({ length: 90 }, (_, index) => ({
            id: `FS-${String(index + 1).padStart(3, '0')}`,
            title: `伏笔${index + 1}`,
            planted: 1,
            last_touched: index + 1,
            status: 'planted',
            resolved_at: null,
            description: `第${index + 1}条伏笔的描述`.repeat(8),
            advance_log: [
              { chapter: 1, note: `第一次推进${index}`, new_info: true },
              { chapter: 2, note: `第二次推进${index}`, new_info: false },
            ],
          })),
        },
        reason: 'ninety foreshadows',
        root,
      })
      await engine.amend({
        path: 'state/timeline.yaml',
        content: {
          schema_version: 1,
          next_seq: 353,
          items: Array.from({ length: 352 }, (_, index) => ({
            id: `TE-${String(index + 1).padStart(3, '0')}`,
            chapter: 1,
            story_time: `第${index + 1}天`,
            description: `事件${index + 1}`,
            location: '旧城',
            characters: [],
          })),
        },
        reason: 'timeline pressure fixture',
        root,
      })
      const first = await engine.panelSection({ root, section: 'foreshadows' })
      const page = first.items as { foreshadows: Array<Record<string, unknown>> }
      expect(first.total).toBe(90)
      expect(first.returned).toBe(50)
      expect(page.foreshadows).toHaveLength(50)
      expect(first.next_cursor).toBe('50')
      // The ledger keeps the full log; the panel is the compact read model.
      expect(page.foreshadows[0]?.advance_log).toBeUndefined()
      expect(page.foreshadows[0]?.advance_count).toBe(2)
      expect(Buffer.byteLength(JSON.stringify(first.items))).toBeLessThanOrEqual(64 * 1024)
      const second = await engine.panelSection({
        root,
        section: 'foreshadows',
        query: { cursor: '50' },
      })
      const rest = second.items as { foreshadows: Array<Record<string, unknown>> }
      expect(rest.foreshadows).toHaveLength(40)
      expect(second.next_cursor).toBeNull()
      const counts = second.counts as Record<string, { total: number; shown: number }>
      expect(counts.foreshadows).toEqual({ total: 90, shown: 40 })
      expect(counts.timeline?.total).toBe(352)
      expect(counts.timeline?.shown).toBeLessThanOrEqual(50)
    } finally {
      await cleanup()
    }
  })

  it('shrinks the preview lists before the pageable foreshadow rows', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '预览超帽', genre: '都市现代', platform: 'fanqie', root })
      await engine.amend({
        path: 'state/foreshadows.yaml',
        content: {
          schema_version: 1,
          next_seq: 31,
          items: Array.from({ length: 30 }, (_, index) => ({
            id: `FS-${String(index + 1).padStart(3, '0')}`,
            title: `伏笔${index + 1}`,
            planted: 1,
            last_touched: 1,
            status: 'planted',
            resolved_at: null,
            description: `第${index + 1}条`,
            advance_log: [],
          })),
        },
        reason: 'foreshadow floor',
        root,
      })
      await engine.amend({
        path: 'state/timeline.yaml',
        content: {
          schema_version: 1,
          next_seq: 201,
          items: Array.from({ length: 200 }, (_, index) => ({
            id: `TE-${String(index + 1).padStart(3, '0')}`,
            chapter: 1,
            story_time: `第${index + 1}天`,
            description: '事'.repeat(400),
            location: '旧城',
            characters: [],
          })),
        },
        reason: 'oversized timeline preview',
        root,
      })
      const section = await engine.panelSection({ root, section: 'foreshadows' })
      const items = section.items as { foreshadows: unknown[]; timeline: unknown[] }
      // The timeline preview pays for the byte cap; the pageable ledger keeps
      // every row of its page and its cursor.
      expect(items.foreshadows).toHaveLength(30)
      expect(items.timeline.length).toBeLessThan(50)
      expect(Buffer.byteLength(JSON.stringify(section.items))).toBeLessThanOrEqual(64 * 1024)
      expect(section.truncated).toBe(true)
      const counts = section.counts as Record<string, { total: number; shown: number }>
      expect(counts.foreshadows).toEqual({ total: 30, shown: 30 })
      expect(counts.timeline).toEqual({ total: 200, shown: items.timeline.length })
    } finally {
      await cleanup()
    }
  })

  it('paginates chapters and preserves draft score as null before review', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '章节书', genre: '都市现代', platform: 'fanqie', root })
      const outline = emptyOutline('2026-01-01')
      outline.chapters.push({
        num: 1,
        volume: null,
        title: '开端之雨',
        scene_type: '日常过渡章',
        goal: '目标',
        conflict: '冲突',
        hook: '钩子',
        cast: [],
        target_words: [80, 400],
        notes: '',
        status: 'planned',
        archived_at: null,
        word_count: null,
        score: null,
      })
      await engine.submitOutline({
        chapters: [
          {
            num: 1,
            title: '开端之雨',
            scene_type: '日常过渡章',
            goal: '目标',
            conflict: '冲突',
            hook: '钩子',
            cast: [],
            target_words: [80, 400],
          },
        ],
        root,
      })
      const section = await engine.panelSection({ root, section: 'chapters' })
      const items = section.items as Array<{ status: string; score: number | null }>
      expect(section.total).toBeGreaterThanOrEqual(1)
      expect(items.some((item) => item.status === 'draft')).toBe(true)
      expect(items.find((item) => item.status === 'draft')?.score).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('does not report a targetless book as zero percent or zero coverage', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '无目标书', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitOutline({
        chapters: [
          {
            num: 1,
            title: '开端之雨',
            scene_type: '日常过渡章',
            goal: '目标',
            conflict: '冲突',
            hook: '钩子',
            cast: [],
            target_words: [80, 400],
          },
        ],
        root,
      })
      const report = await engine.report({ root })
      expect(report.data.progress.percent).toBeNull()
      const bundle = await engine.panelBundle({ root })
      expect(bundle.summary?.quality?.last_ten_average).toBeNull()
      expect(bundle.summary?.bookData?.quality.last_ten_average).toBeNull()
      expect(report.data.outline.coverage).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('reports corrupt outline as not present in the health section', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '损坏书', genre: '都市现代', platform: 'fanqie', root })
      await writeFile(join(root, OUTLINE_FILE), 'book: [\n', 'utf8')
      const section = await engine.panelSection({ root, section: 'health' })
      const items = section.items as {
        outline: { present: boolean; file_existed: boolean; error: string | null }
        blocking: unknown[]
      }
      expect(items.outline.present).toBe(false)
      expect(items.outline.file_existed).toBe(true)
      expect(items.outline.error).not.toBeNull()
      expect(items.blocking.length).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })

  it('exposes dimension maxima and full quality in the quality section', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const section = await engine.panelSection({ root, section: 'quality' })
      const items = section.items as {
        dimensions: Array<{ id: string; max: number }>
      }
      expect(items.dimensions.find((dimension) => dimension.id === 'R-W-10')?.max).toBe(1)
      expect(items.dimensions.find((dimension) => dimension.id === 'R-W-04')?.max).toBe(20)
    } finally {
      await cleanup()
    }
  })

  it('invalidates the quality section when a review file is removed', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const first = await engine.panelSection({ root, section: 'quality' })
      await rm(join(root, 'reviews/ch001.review.yaml'), { force: true })
      const second = await engine.panelSection({ root, section: 'quality' })
      const firstQuality = (first.items as { quality: { samples: number } }).quality
      const secondQuality = (second.items as { quality: { samples: number } }).quality
      expect(firstQuality.samples).toBe(1)
      expect(secondQuality.samples).toBe(0)
      expect(second.etag).not.toBe(first.etag)
    } finally {
      await cleanup()
    }
  })

  it('changes the bundle ETag when the project registry changes', async () => {
    const { root, engine, cleanup } = await harness()
    const other = await mkdtemp(join(tmpdir(), 'nwe-other-project-'))
    try {
      await engine.initProject({ title: 'ETag 书', genre: '都市现代', platform: 'fanqie', root })
      const before = await engine.panelBundle({ root })
      await engine.initProject({ title: '另一本', genre: '都市现代', platform: 'fanqie', root: other })
      await engine.registerProject({ root: other })
      const after = await engine.panelBundle({ root })
      expect(after.projects?.length).toBeGreaterThan(before.projects?.length ?? 0)
      expect(after.etag).not.toBe(before.etag)
    } finally {
      await cleanup()
      await rm(other, { recursive: true, force: true })
    }
  })

  it('serves the same section ETag and returns 304 on If-None-Match', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: 'ETag 书', genre: '都市现代', platform: 'fanqie', root })
      const first = await panelPayload(engine, root, 'chapters')
      const second = await panelPayload(engine, root, 'chapters')
      expect(first.etag).toBeTruthy()
      const bundleFirst = await engine.panelBundle({ root })
      const bundleSecond = await engine.panelBundle({ root })
      expect(bundleFirst.etag).toBeTruthy()
      expect(bundleSecond.etag).toBe(bundleFirst.etag)
      expect(second.etag).toBe(first.etag)
      const cachedFirst = await engine.panelSection({ root, section: 'chapters' })
      const cachedSecond = await engine.panelSection({ root, section: 'chapters' })
      expect(cachedSecond).toBe(cachedFirst)
      const response = {
        statusCode: 0,
        headers: {} as Record<string, string>,
        setHeader(name: string, value: string): void {
          this.headers[name] = value
        },
        end(): void {},
      }
      const handler = panelHandler(engine, () => undefined)
      await handler(
        {
          method: 'GET',
          headers: { 'if-none-match': `"${String(first.etag)}"` },
          url: `/api/novel-write-engine/panel?root=${encodeURIComponent(root)}&section=chapters`,
        },
        response,
      )
      expect(response.statusCode).toBe(304)
    } finally {
      await cleanup()
    }
  })

  it('paginates with a cursor and clamps an invalid limit', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '分页书', genre: '都市现代', platform: 'fanqie', root })
      await engine.amend({
        path: 'state/characters.yaml',
        content: {
          schema_version: 1,
          characters: ['甲', '乙', '丙'].map((name, index) => ({
            name,
            role: index === 0 ? 'protagonist' : 'supporting',
            first_appearance: 1,
            profile: {},
            current_state: {},
            growth: [],
            updated_at: 1,
          })),
        },
        reason: 'pagination fixture',
        root,
      })
      const page = await engine.panelSection({
        root,
        section: 'characters',
        query: { limit: 1 },
      })
      expect(page.total).toBe(3)
      expect(page.returned).toBe(1)
      expect(page.next_cursor).toBe('1')
      const next = await engine.panelSection({
        root,
        section: 'characters',
        query: { limit: 0, cursor: page.next_cursor ?? undefined },
      })
      expect(next.returned).toBe(1)
      expect(next.next_cursor).toBe('2')
      const last = await engine.panelSection({
        root,
        section: 'characters',
        query: { limit: 1, cursor: next.next_cursor ?? undefined },
      })
      expect(last.returned).toBe(1)
      expect(last.next_cursor).toBeNull()
      const filtered = await engine.panelSection({
        root,
        section: 'characters',
        query: { search: '乙' },
      })
      expect(filtered.total).toBe(1)
      expect(filtered.items).toMatchObject([{ name: '乙' }])
    } finally {
      await cleanup()
    }
  })

  it('covers every section filter and the overview/health/quality branches', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const queries = [
        { section: 'overview' as const },
        {
          section: 'chapters' as const,
          query: { status: 'archived', scene: '日常过渡章', search: '开端', sort: 'num_asc' },
        },
        { section: 'chapters' as const, query: { status: 'draft' } },
        { section: 'characters' as const, query: { search: '他' } },
        { section: 'foreshadows' as const, query: { status: 'planted', search: '没有' } },
        { section: 'timeline' as const, query: { search: '信' } },
        { section: 'relationships' as const, query: { search: '没有' } },
        { section: 'worldbook' as const },
        { section: 'quality' as const },
        { section: 'health' as const },
      ]
      for (const request of queries) {
        const section = await engine.panelSection({ root, ...request })
        expect(section.payload_version).toBe(7)
      }
    } finally {
      await cleanup()
    }
  })

  it('serves a lean bundle without reading reviews and keeps the book average', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const full = await engine.panelBundle({ root })
      const lean = await engine.panelBundle({ root, lean: true })
      expect(lean.summary?.averageScore).toBe(full.summary?.averageScore)
      expect(lean.summary?.quality?.samples).toBe(0)
      expect(lean.summary?.quality?.averageScore).toBe(full.summary?.averageScore)
      expect(lean.chapters?.rows).toHaveLength(full.chapters?.rows.length ?? 0)
      expect('gates' in full).toBe(false)
      expect('gates' in lean).toBe(false)
    } finally {
      await cleanup()
    }
  })
})
