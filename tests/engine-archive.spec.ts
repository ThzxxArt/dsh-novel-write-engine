import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  cleanText,
  harness,
  readyToArchive,
  readProjectFile,
  sampleSemantic,
  sampleSummary,
} from './helpers.js'
import type { ChapterSummary } from '../src/types.js'

const readYaml = async (root: string, path: string): Promise<Record<string, unknown>> => {
  const text = await readProjectFile(root, path)
  expect(text, `${path} must exist`).not.toBeNull()
  return parseYaml(text!) as Record<string, unknown>
}

const ledgerText = (): string =>
  `${cleanText()}\n\n他数了数铜钱，少了 200。配角A站在旧办公室门口，他有感知雨的能力。桌上压着蜡印。`

const summaryWithLedgerEntities = (): ChapterSummary =>
  sampleSummary({
    events: ['他收到无名信封', '他离开办公室'],
    characters_appeared: ['他', '配角A'],
    new_elements: { locations: ['旧办公室'], abilities: ['感知雨'], artifacts: [] },
    foreshadows: {
      planted: [{ key: 'fs001', title: '蜡印', description: '暗红蜡印' }],
      advanced: [],
      resolved: [],
    },
    resource_changes: [{ character: '他', resource: '铜钱', delta: -200, reason: '买信封' }],
  })

/** A complete declaration for every entity the summary claims. */
const fullDelta = (summary: ChapterSummary): Record<string, Record<string, unknown>> => {
  const characters = Object.fromEntries(
    summary.characters_appeared.map((name) => [
      name,
      {
        action: 'created',
        role: name === '他' ? 'protagonist' : 'supporting',
        ...(name === '他' ? { current_state: { resources: { 铜钱: 1000 } } } : {}),
      },
    ]),
  )
  const world: Record<string, unknown> = {}
  for (const name of summary.new_elements.locations)
    world[name] = {
      action: 'created',
      kind: 'location',
      layout: '三排工位',
      capacity: 30,
      description: '旧办公室',
    }
  for (const name of summary.new_elements.abilities)
    world[name] = { action: 'created', kind: 'ability', description: '能感到雨意' }
  for (const name of summary.new_elements.artifacts)
    world[name] = { action: 'created', kind: 'artifact', description: '旧物' }
  const foreshadows = Object.fromEntries(
    summary.foreshadows.planted.map((item) => [
      item.key,
      { action: 'created', title: item.title, description: item.description },
    ]),
  )
  const timeline = Object.fromEntries(
    summary.events.map((event, index) => [
      String(index),
      { action: 'created', story_time: `Day 1 ${index + 1}`, description: event },
    ]),
  )
  return {
    characters,
    world,
    foreshadows,
    timeline,
    relationships: {
      '他|配角A': { action: 'created', type: '同事', description: '同处一间办公室' },
    },
  }
}

const archive = (
  engine: Awaited<ReturnType<typeof harness>>['engine'],
  root: string,
  delta: Record<string, unknown>,
  chapter = 1,
): Promise<unknown> => engine.archiveChapter({ chapter, root, state_delta: delta } as never)

describe('archive state_delta reconciliation', () => {
  it('refuses an archive without a delta and writes nothing', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = summaryWithLedgerEntities()
      await readyToArchive({ root, engine, summary, text: ledgerText() })
      await expect(engine.archiveChapter({ chapter: 1, root } as never)).rejects.toMatchObject({
        code: 'ENGINE_DELTA_UNVERIFIED',
      })
      const characters = await readYaml(root, 'state/characters.yaml')
      expect(characters.characters).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('refuses when an appeared character is not declared', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = summaryWithLedgerEntities()
      await readyToArchive({ root, engine, summary, text: ledgerText() })
      const delta = fullDelta(summary)
      delete (delta.characters as Record<string, unknown>)['配角A']
      await expect(archive(engine, root, delta)).rejects.toMatchObject({
        code: 'ENGINE_DELTA_UNVERIFIED',
      })
    } finally {
      await cleanup()
    }
  })

  it('requires a reason for a no_change declaration', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = summaryWithLedgerEntities()
      await readyToArchive({ root, engine, summary, text: ledgerText() })
      const delta = fullDelta(summary)
      ;(delta.characters as Record<string, unknown>)['配角A'] = { action: 'no_change' }
      await expect(archive(engine, root, delta)).rejects.toMatchObject({
        code: 'ENGINE_DELTA_UNVERIFIED',
      })
    } finally {
      await cleanup()
    }
  })

  it('writes characters, world, locks, relationships and the full timeline', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = summaryWithLedgerEntities()
      await readyToArchive({ root, engine, summary, text: ledgerText() })
      const delta = fullDelta(summary)
      const result = (await archive(engine, root, delta)) as {
        data: { assigned_ids: Record<string, string> }
      }

      const characters = await readYaml(root, 'state/characters.yaml')
      const rows = characters.characters as Array<Record<string, unknown>>
      expect(rows.map((row) => row.name)).toEqual(['他', '配角A'])
      expect(rows[0]).toMatchObject({ role: 'protagonist', first_appearance: 1 })
      expect((rows[0]!.current_state as Record<string, unknown>).resources).toEqual({ 铜钱: 800 })

      const world = await readYaml(root, 'state/world.yaml')
      expect((world.locations as Array<Record<string, unknown>>)[0]).toMatchObject({
        name: '旧办公室',
        first_appearance: 1,
        layout: '三排工位',
        capacity: 30,
      })
      expect((world.abilities as Array<Record<string, unknown>>)[0]).toMatchObject({ name: '感知雨' })

      const locks = await readYaml(root, 'state/locks.yaml')
      expect(locks.locked_at_chapter).toBe(1)
      expect(Object.keys(locks.characters as Record<string, unknown>)).toContain('他')
      expect((locks.characters as Record<string, Record<string, unknown>>)['他']!.appearance).toContain(
        '风从窗缝',
      )

      const relationships = await readYaml(root, 'state/relationships.yaml')
      const relationship = (relationships.items as Array<Record<string, unknown>>)[0]!
      expect(relationship).toMatchObject({ id: 'RL-001', a: '他', b: '配角A', type: '同事' })

      const timeline = await readYaml(root, 'state/timeline.yaml')
      const events = timeline.items as Array<Record<string, unknown>>
      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({ id: 'TE-001', story_time: 'Day 1 1', description: '他收到无名信封' })
      expect(events[1]).toMatchObject({ id: 'TE-002', story_time: 'Day 1 2' })

      expect(result.data.assigned_ids).toMatchObject({ fs001: 'FS-001', '他|配角A': 'RL-001' })
    } finally {
      await cleanup()
    }
  })

  it('re-validates the semantic evidence at the archive boundary', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = summaryWithLedgerEntities()
      const text = ledgerText()
      await readyToArchive({ root, engine, summary, text })
      const checkPath = join(root, 'checks', 'ch001.check.yaml')
      const check = parseYaml((await readProjectFile(root, 'checks/ch001.check.yaml'))!) as {
        semantic: { items: unknown[] }
      }
      // A hand-edited check document keeps a valid content hash but removes the
      // four evidence-backed semantic items. Archive must not trust it.
      check.semantic = { items: [] }
      await writeFile(checkPath, `${JSON.stringify(check)}\n`, 'utf8')
      await expect(archive(engine, root, fullDelta(summary))).rejects.toMatchObject({
        code: 'ENGINE_GATE_BLOCKED',
      })
      expect((await readYaml(root, 'state/chapters.yaml')).chapters).toEqual([])
      // The helper's evidence remains valid when the check is not tampered with.
      expect(sampleSemantic(text)).toHaveLength(4)
    } finally {
      await cleanup()
    }
  })

  it('refuses a review edited after submission even when its arithmetic still closes', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = summaryWithLedgerEntities()
      await readyToArchive({ root, engine, summary, text: ledgerText() })
      const reviewPath = join(root, 'reviews', 'ch001.review.yaml')
      const review = parseYaml((await readProjectFile(root, 'reviews/ch001.review.yaml'))!) as {
        dimensions: Array<{ deductions: unknown[] }>
        total: number
        content_hash: string
      }
      for (const dimension of review.dimensions) dimension.deductions = []
      review.total = 150
      review.content_hash = 'deadbeef'
      await writeFile(reviewPath, `${JSON.stringify(review)}\n`, 'utf8')
      // The P8 digest covers the review, so refresh it before retrying.
      await engine.getBrief({ stage: 'P8', root })
      await expect(archive(engine, root, fullDelta(summary))).rejects.toMatchObject({
        code: 'ENGINE_GATE_BLOCKED',
      })
      expect((await readYaml(root, 'state/chapters.yaml')).chapters).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('refuses an unknown foreshadow key instead of touching an unrelated item (T-05)', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = sampleSummary({
        foreshadows: {
          planted: [{ key: 'fs001', title: '蜡印', description: '暗红蜡印' }],
          advanced: [{ key: 'FS-999', note: '误写的 key', new_info: true }],
          resolved: [],
        },
      })
      await readyToArchive({ root, engine, summary, text: ledgerText() })
      const delta = fullDelta(summary)
      delta.foreshadows = {
        fs001: { action: 'created', title: '蜡印', description: '暗红蜡印' },
        'FS-999': { action: 'updated', note: '误写的 key', new_info: true },
      }
      await expect(archive(engine, root, delta)).rejects.toMatchObject({
        code: 'ENGINE_DELTA_UNVERIFIED',
      })
      expect((await readYaml(root, 'state/foreshadows.yaml')).items).toEqual([])
    } finally {
      await cleanup()
    }
  })
})
