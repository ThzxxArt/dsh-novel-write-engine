import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildView } from '../src/client/viewmodel.js'
import { buildPanelBookData } from '../src/engine/insight.js'
import { projectChapters, projectSummary, type PanelSnapshot } from '../src/engine/projections.js'
import { panelElement } from '../src/client/panel.js'
import { archiveDelta, cleanText, harness, readyToArchive, sampleSummary } from './helpers.js'
import type { BookReport } from '../src/types.js'

describe('panel v6 book data', () => {
  it('carries book identity, progress, quality and explicit health from a real engine snapshot', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine, text: cleanText() })
      const summary = sampleSummary({
        new_elements: { locations: ['旧茶楼'], abilities: [], artifacts: [] },
        new_element_anchors: { locations: { 旧茶楼: ['门口'] } },
      })
      await engine.submitRevision({ chapter: 1, summary, root })
      await engine.getBrief({ stage: 'P8', root })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root })
      const bundle = await engine.panelBundle({ root })
      expect(bundle.summary?.schemaVersion).toBe(6)
      const data = bundle.summary?.bookData
      expect(data).toBeDefined()
      expect(data!.identity.author).toBe('')
      expect(data!.identity.targets.words_per_chapter).toEqual([80, 400])
      expect(data!.progress.archived).toBe(1)
      expect(data!.progress.words_archived).toBeGreaterThan(0)
      expect(data!.quality.samples).toBe(1)
      expect(data!.quality.attempts).toBeGreaterThanOrEqual(data!.quality.samples)
      expect(data!.worldbook.locations[0]?.anchors).toEqual(['门口'])
      expect(data!.health.outline).toMatchObject({ error: null })
      expect(data!.health.worldbook).toMatchObject({ error: null })
      expect(bundle.summary?.pending).toBeUndefined()

      const view = buildView({ schemaVersion: 6, ...bundle })
      expect(view.state).toBe('ready')
      expect(view.bookData?.progress.archived).toBe(1)
      expect(view.quality.samples).toBe(1)
      expect(view.quality.attempts).toBeGreaterThanOrEqual(view.quality.samples)
      const chapterRow = bundle.chapters!.rows[0]!
      expect(chapterRow.dialogueRatio).toBeTypeOf('number')
      expect(chapterRow.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(view.rows[0]?.dialogueRatio).toBe(chapterRow.dialogueRatio)
      const html = renderToStaticMarkup(panelElement(view, false, () => undefined))
      expect(html).toContain('这本书')
      expect(html).toContain('对话')
      expect(html).toContain('归档')
      expect(html).toContain('书脊与蓝图')
      expect(html).toContain('质量与节奏')
      expect(html).toContain('第 1 章')
      expect(html).toContain('锚点：门口')
    } finally {
      await cleanup()
    }
  })

  it('renders v6 data without a bookData payload as a refresh-required client', async () => {
    const view = buildView({ schemaVersion: 5, projects: [], selection: { root: null, source: 'none' } })
    expect(view.state).toBe('outdated')
  })

  it('covers the zero-archive/minimum-target and missing-card branches without inventing data', () => {
    const report = {
      progress: {
        archived: 0,
        target: 5,
        words: 0,
        average_words: 0,
        percent: 0,
        remaining_words: 100,
        remaining_words_min: 100,
        remaining_words_average: 120,
        remaining_words_basis: 'minimum_target',
      },
      outline: { drift: [] },
      worldbook: {
        present: true,
        characters: 0,
        locations: 1,
        factions: 0,
        rules: 0,
        glossary: 0,
        backstory: 0,
        facts: 0,
      },
      quality: {
        average: 0,
        median: 0,
        min: 0,
        max: 0,
        last_five: [],
        trend: null,
        trend_basis: 'insufficient_samples',
        samples: 0,
        attempts: 0,
        dimensions: [],
      },
      effort: {
        reviews: 0,
        revisions: 0,
        checks: 0,
        rollbacks: 0,
        chapters: Array.from({ length: 800 }, (_, index) => ({
          num: index + 1,
          reviews: 0,
          revisions: 0,
          checks: 0,
          rollbacks: 0,
          final_check: 'pass',
          archived_at: '2026-01-01',
        })),
      },
      pacing: {
        scene_types: {},
        hook_strength: {},
        plot_advancement: {},
        longest: null,
        shortest: null,
      },
      cast: { total: 0, top: [] },
      foreshadows: { open: 0, dormant: 0, overdue: 0, resolved: 0, oldest: [] },
      timeline: { events: 0, first_chapter: null, last_chapter: null },
      relationships: { total: 0, types: {} },
    } as unknown as BookReport
    const worldbook = {
      schema_version: 1 as const,
      updated_at: '2026-01-01',
      premise: '',
      setting: '',
      rules: [],
      factions: [],
      locations: [{ name: '旧茶楼', description: ' 旧 茶楼 ', layout: '', capacity: 1 }],
      characters: [],
      glossary: [],
      backstory: [],
      themes: [],
    }
    const data = buildPanelBookData({
      report,
      project: {
        schema_version: 1,
        title: '书',
        genre: '都市现代',
        platform: 'fanqie',
        author: '',
        description: '',
        created_at: '2026-01-01',
        targets: { words_per_chapter: [80, 400], total_chapters: 5, dialogue_ratio: [0.4, 0.6] },
      },
      worldbook,
      world: {
        schema_version: 1,
        locations: [
          {
            name: '旧茶楼',
            anchors: ['门口'],
            first_appearance: 1,
            locked: true,
            description: '旧茶楼',
            layout: '',
            capacity: 1,
            changes: [],
          },
          null as never,
          {
            name: '',
            description: 'empty',
            anchors: ['x'],
            first_appearance: 1,
            locked: true,
            layout: '',
            capacity: 1,
            changes: [],
          } as never,
          {
            name: '坏地点',
            description: 42,
            anchors: 'bad',
            first_appearance: 1,
            locked: true,
            layout: '',
            capacity: 1,
            changes: [],
          } as never,
        ],
        abilities: [],
        artifacts: [],
        factions: [{ name: '码头帮', description: '旧码头势力', anchors: ['码头'] }, null as never],
        rules: [{ name: '夜禁', description: '入夜后不得出城', anchors: ['宵禁'] }],
      },
      outline: {
        schema_version: 1,
        updated_at: '2026-01-01',
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
        },
        volumes: [],
        chapters: [],
      },
      outlinePresent: true,
      worldbookPresent: true,
      currentChapter: 99,
      stage: 'idle',
      rounds: { review: 0, revise: 0, check: 0 },
      draftWords: 0,
      lastTenAverage: 0,
      manuscriptHash: null,
      metrics: null,
      stateErrors: [],
      pending: null,
      outlineError: null,
      worldbookError: null,
    })
    expect(data.progress.remaining_words_basis).toBe('minimum_target')
    expect(data.progress.remaining_words).toBe(100)
    expect(data.current.card).toBeNull()
    expect(data.effort.chapters).toHaveLength(30)
    expect(data.effort.chapters[0]?.num).toBe(771)
    expect(data.effort.chapters[29]?.num).toBe(800)
    expect(data.worldbook.locations[0]?.anchors).toEqual(['门口'])
    expect(data.worldbook.factions[0]?.anchors).toEqual(['码头'])
    expect(data.worldbook.rules[0]?.anchors).toEqual(['宵禁'])
    expect(data.worldbook.locations).toHaveLength(2)
    expect(data.worldbook.locations[0]?.description).toBe('旧 茶楼')
    expect(JSON.stringify(data).length).toBeLessThan(64 * 1024)
    const chapters = Array.from({ length: 800 }, (_, index) => ({
      num: index + 1,
      title: `第${index + 1}章`,
      file: `chapters/chapter-${String(index + 1).padStart(3, '0')}.md`,
      word_count: 100,
      dialogue_lines: 1,
      dialogue_ratio: 0.4,
      scene_type: '日常过渡章',
      narrator: '他',
      score: 140,
      status: 'reviewed' as const,
      content_hash: 'hash',
      summary: {
        events: ['事件'],
        characters_appeared: ['他'],
        foreshadows: { planted: [], advanced: [], resolved: [] },
        new_elements: { locations: [], abilities: [], artifacts: [] },
        resource_changes: [],
        opening: '开头',
        continuity: { opens_from: '上章', ends_with: '钩子' },
        hook_strength: 3,
        pleasure_points: [],
        plot_advancement: 'mid' as const,
      },
      rounds: { review: 1, revise: 0, check: 1, rollbacks: 0 },
      final_check: 'pass' as const,
      archived_at: '2026-01-01',
    }))
    const snapshot = {
      root: '/tmp/book',
      title: '书',
      genre: '都市现代',
      platform: 'fanqie',
      chapter: 1,
      stage: 'done',
      revision: 1,
      rounds: { review: 0, revise: 0, check: 0 },
      blocking: [],
      chapters,
      totalWords: 80000,
      phases: [],
      bookData: data,
    } as unknown as PanelSnapshot
    const payloadBytes = Buffer.byteLength(
      JSON.stringify({
        schemaVersion: 6,
        projects: [],
        selection: { root: null, source: 'none' },
        summary: projectSummary(snapshot),
        chapters: projectChapters(snapshot),
      }),
    )
    expect(payloadBytes).toBeLessThan(64 * 1024)
  })
})
