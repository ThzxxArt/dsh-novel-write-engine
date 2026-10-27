import { describe, expect, it } from 'vitest'
import {
  phaseStrip,
  projectChapters,
  projectGates,
  projectSummary,
  type PanelSnapshot,
} from '../src/engine/projections.js'
import type { ChapterRecord } from '../src/types.js'

const chapter = (num: number, status: 'draft' | 'reviewed'): ChapterRecord => ({
  num,
  title: `第${num}章`,
  file: `chapters/chapter-${String(num).padStart(3, '0')}.md`,
  word_count: 100,
  dialogue_lines: 10,
  dialogue_ratio: 0.4,
  scene_type: '日常过渡章',
  narrator: '他',
  score: 130,
  status,
  content_hash: 'h',
  summary: {
    events: ['e'],
    characters_appeared: ['他'],
    foreshadows: { planted: [], advanced: [], resolved: [] },
    new_elements: { locations: [], abilities: [], artifacts: [] },
    resource_changes: [],
    opening: 'o',
    continuity: { opens_from: '', ends_with: '' },
    hook_strength: 3,
    pleasure_points: [],
    plot_advancement: 'mid',
  },
})

const snapshot = (patch: Partial<PanelSnapshot> = {}): PanelSnapshot => ({
  root: '/tmp/book',
  title: '书',
  genre: '都市现代',
  platform: 'fanqie',
  chapter: 2,
  stage: 'P6',
  revision: 7,
  rounds: { review: 1, revise: 1, check: 0 },
  blocking: [],
  chapters: [chapter(1, 'reviewed'), chapter(2, 'draft')],
  totalWords: 200,
  phases: phaseStrip('P6'),
  ...patch,
})

describe('panel projections', () => {
  it('maps stages to a nine-phase strip with one active phase', () => {
    const strip = phaseStrip('P6')
    expect(strip.filter((phase) => phase.active)).toHaveLength(1)
    expect(strip.find((phase) => phase.active)?.id).toBe('P6')
    expect(strip.filter((phase) => phase.done).length).toBeGreaterThan(0)
    expect(phaseStrip('done', true).every((phase) => phase.done && !phase.active)).toBe(true)
    const nextCycle = phaseStrip('done')
    expect(nextCycle.find((phase) => phase.active)?.id).toBe('P1')
    expect(nextCycle.every((phase) => !phase.done)).toBe(true)
  })

  it('distinguishes reviewed from draft chapters', () => {
    const rows = projectChapters(snapshot()).rows
    expect(rows[0]).toMatchObject({ status: 'passed', stage: 'done' })
    expect(rows[1]).toMatchObject({ status: 'draft', stage: 'P3' })
  })

  it('renders scope in gate explanations and keeps the status contract', () => {
    const input = snapshot({
      blocking: [
        { code: 'PG-07', scope: 'score', detail: 'low' },
        { code: 'PG-10', detail: 'drift' },
      ],
      next: { tool: 'novel_check', args: {}, reason: 'next' },
    })
    const gates = projectGates(input)
    expect(gates.explanations[0]).toContain('PG-07 (score): low')
    expect(gates.explanations[1]).toBe('PG-10: drift')
    const summarised = projectSummary(input)
    expect(summarised).toMatchObject({ totalChapters: 2, totalWords: 200, revision: 7 })
    expect(summarised.next).toEqual({ tool: 'novel_check', reason: 'next' })
  })
})
