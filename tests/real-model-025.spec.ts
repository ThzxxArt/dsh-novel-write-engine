import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { archiveDelta, harness, readyToArchive, sampleSummary } from './helpers.js'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'agnes-025')

/** Normalize only paragraph separation; the prose is the model's output. */
const normalize = (text: string): string =>
  text
    .replace(/\r\n/g, '\n')
    .replace(/\n(?=\S)/g, '\n\n')
    .trim()

describe('agnes real model prose through the public engine', () => {
  it.each(['agnes-2.5-flash', 'agnes-3.0-flash'])(
    'takes %s prose through P3->P8 and archive',
    async (model) => {
      const text = normalize(await readFile(join(FIXTURES, `${model}.md`), 'utf8'))
      const opening = Array.from(text.replace(/\s+/g, '')).slice(0, 14).join('')
      const summary = sampleSummary({
        events: ['他收到无名信封', '他决定拆开'],
        characters_appeared: ['他'],
        opening,
        continuity: { opens_from: '上一章结尾', ends_with: '夜色已深' },
        pleasure_points: ['新线索'],
      })
      const { root, engine, cleanup } = await harness()
      try {
        await readyToArchive({ root, engine, text, summary })
        const status = await engine.getStatus({ root })
        expect(status.data.stage).toBe('ready_to_archive')
        const archived = await engine.archiveChapter({
          chapter: 1,
          state_delta: archiveDelta(summary),
          root,
        })
        expect(archived.data.score).toBeGreaterThanOrEqual(120)
        expect((await engine.getStatus({ root })).data.stage).toBe('done')
      } finally {
        await cleanup()
      }
    },
    120_000,
  )
})
