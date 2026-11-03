import { describe, expect, it } from 'vitest'
import { emptyWorldbook } from '../src/engine/book.js'
import type { PanelSectionName } from '../src/engine/projections.js'
import { harness } from './helpers.js'

/** The panel section cap; a page that exceeds it is a page-size bug. */
const CAP = 64 * 1024

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null')

const PAGEABLE: PanelSectionName[] = ['characters', 'timeline', 'relationships', 'foreshadows']

const rowsOf = (section: PanelSectionName, items: unknown): Array<Record<string, unknown>> => {
  if (section === 'foreshadows') {
    const row = items as { foreshadows?: Array<Record<string, unknown>> }
    return row.foreshadows ?? []
  }
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : []
}

describe('0.2.15 panel paging owns every row', () => {
  it('walks every page of every pageable ledger without losing a row', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '分页全书', genre: '都市现代', platform: 'fanqie', root })
      await engine.amend({
        path: 'state/characters.yaml',
        root,
        reason: 'characters fixture',
        content: {
          schema_version: 1,
          characters: Array.from({ length: 120 }, (_, index) => ({
            name: `人物${index}`,
            role: 'supporting',
            first_appearance: 1,
            profile: {},
            current_state: {},
            growth: [],
            updated_at: 1,
          })),
        },
      })
      await engine.amend({
        path: 'state/timeline.yaml',
        root,
        reason: 'timeline fixture',
        content: {
          schema_version: 1,
          next_seq: 121,
          items: Array.from({ length: 120 }, (_, index) => ({
            id: `TE-${String(index).padStart(3, '0')}`,
            chapter: 1,
            story_time: '夜',
            description: `事件${index}`,
            location: '旧城',
            characters: [],
          })),
        },
      })
      await engine.amend({
        path: 'state/relationships.yaml',
        root,
        reason: 'relationships fixture',
        content: {
          schema_version: 1,
          next_seq: 121,
          items: Array.from({ length: 120 }, (_, index) => ({
            id: `RL-${String(index).padStart(3, '0')}`,
            a: `人物${index}`,
            b: `人物${(index + 1) % 120}`,
            type: '朋友',
            type_code: 'ally',
            since: 1,
            description: `关系${index}`,
            evolution: [],
          })),
        },
      })
      await engine.amend({
        path: 'state/foreshadows.yaml',
        root,
        reason: 'foreshadow fixture',
        content: {
          schema_version: 1,
          next_seq: 121,
          items: Array.from({ length: 120 }, (_, index) => ({
            id: `FS-${String(index).padStart(3, '0')}`,
            title: `伏笔${index}`,
            planted: 1,
            last_touched: 1,
            status: 'planted',
            resolved_at: null,
            description: `描述${index}`,
            advance_log: [],
          })),
        },
      })
      for (const section of PAGEABLE) {
        const seen = new Set<string>()
        let cursor: string | undefined
        let pages = 0
        let total = 0
        for (;;) {
          const page = await engine.panelSection({ root, section, query: { limit: 50, cursor } })
          pages += 1
          total = page.total
          expect(bytes(page.items)).toBeLessThanOrEqual(CAP)
          for (const row of rowsOf(section, page.items)) {
            seen.add(String(row.id ?? row.name))
          }
          if (page.next_cursor === null) break
          cursor = page.next_cursor
          // A cursor that never advances would page forever.
          expect(pages).toBeLessThan(20)
        }
        // Every row is reachable: the pager reports a total the walk can meet.
        expect(seen.size).toBe(total)
        expect(total).toBe(120)
      }
    } finally {
      await cleanup()
    }
  })

  it('shrinks an oversized page and keeps its cursor instead of deleting rows', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '超帽分页', genre: '都市现代', platform: 'fanqie', root })
      await engine.amend({
        path: 'state/characters.yaml',
        root,
        reason: 'oversized characters',
        content: {
          schema_version: 1,
          characters: Array.from({ length: 120 }, (_, index) => ({
            name: `人物${index}`,
            role: 'supporting',
            first_appearance: 1,
            profile: { a: '背'.repeat(400), b: '景'.repeat(400) },
            current_state: { c: '状'.repeat(400) },
            growth: [],
            updated_at: 1,
          })),
        },
      })
      const first = await engine.panelSection({
        root,
        section: 'characters',
        query: { limit: 200 },
      })
      expect(bytes(first.items)).toBeLessThanOrEqual(CAP)
      // The page gave way, not the ledger: rows remain reachable through the cue.
      expect(first.returned).toBeLessThan(120)
      expect(first.next_cursor).not.toBeNull()
      expect(first.truncated).toBe(true)
      const seen = new Set<string>()
      let cursor: string | undefined = first.next_cursor ?? undefined
      for (const row of rowsOf('characters', first.items)) seen.add(String(row.name))
      while (cursor !== undefined) {
        const page = await engine.panelSection({
          root,
          section: 'characters',
          query: { limit: 200, cursor },
        })
        expect(bytes(page.items)).toBeLessThanOrEqual(CAP)
        for (const row of rowsOf('characters', page.items)) seen.add(String(row.name))
        cursor = page.next_cursor ?? undefined
      }
      expect(seen.size).toBe(120)
    } finally {
      await cleanup()
    }
  })

  it('counts every structured preview instead of dropping rows silently', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '设定书', genre: '都市现代', platform: 'fanqie', root })
      const worldbook = emptyWorldbook('2026-01-01')
      worldbook.rules = Array.from({ length: 60 }, (_, index) => ({
        name: `规则${index}`,
        description: '设定'.repeat(200),
      }))
      await engine.amend({
        path: 'outline/worldbook.yaml',
        content: worldbook as unknown as Record<string, unknown>,
        reason: 'worldbook fixture',
        root,
      })
      const section = await engine.panelSection({ root, section: 'worldbook' })
      const counts = section.counts as Record<string, { total: number; shown: number }>
      expect(bytes(section.items)).toBeLessThanOrEqual(CAP)
      expect(counts.rules?.total).toBe(60)
      expect(counts.rules?.shown).toBeLessThanOrEqual(60)
      expect(counts.rules?.shown).toBeLessThan(counts.rules?.total ?? 0)
      expect(Object.keys(counts)).toEqual(
        expect.arrayContaining([
          'rules',
          'factions',
          'locations',
          'characters',
          'glossary',
          'backstory',
          'facts',
          'themes',
          'ledger_locations',
          'outline_cards',
        ]),
      )
      expect(section.truncated).toBe(true)
      // The rendered rows and the reported count agree; neither can claim more
      // than the payload actually carries.
      expect((section.items as { rules: unknown[] }).rules).toHaveLength(counts.rules?.shown ?? -1)
    } finally {
      await cleanup()
    }
  })
})
