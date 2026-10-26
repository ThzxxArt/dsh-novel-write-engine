import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { BriefLibrary } from '../src/engine/brief.js'
import { createSkill } from '../src/skills/index.js'
import { GENRES, PLATFORMS, SCENE_TYPES } from '../src/types.js'
import { loadRulepack } from '../src/rulepack.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

describe('task books', () => {
  const library = new BriefLibrary()

  it('ships a task book for every brief stage and renders its variables', () => {
    for (const stage of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P8'] as const) {
      const brief = library.render(stage, {
        chapter: 3,
        min_words: 2000,
        min_score: 120,
        round: 2,
        title: '书',
        genre: '都市现代',
        platform: 'fanqie',
      })
      expect(brief.content.length, stage).toBeGreaterThan(200)
      expect(brief.content).not.toContain('{{chapter}}')
      expect(brief.contentHash.startsWith('fnv:')).toBe(true)
      expect(brief.title.length).toBeGreaterThan(0)
    }
  })

  it('never ships a bare task book without instructions', () => {
    const files = readdirSync(join(repoRoot, 'briefs')).filter((name) => name.endsWith('.md'))
    expect(files.sort()).toEqual(['P1.md', 'P2.md', 'P3.md', 'P4.md', 'P5.md', 'P6.md', 'P8.md'])
    for (const file of files) {
      const text = readFileSync(join(repoRoot, 'briefs', file), 'utf8')
      expect(text.split('\n').length, file).toBeGreaterThan(10)
      expect(text).toContain('novel_')
    }
  })

  it('fails loudly when a task book is missing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'briefs-'))
    try {
      expect(() => new BriefLibrary(empty).load('P1')).toThrow(/brief P1 is missing/)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('entry skill', () => {
  it('stays under 120 lines and carries the six iron rules', () => {
    const skill = createSkill()
    const lines = skill.content.split('\n')
    expect(lines.length).toBeLessThanOrEqual(120)
    expect(skill.content).toContain('六条铁律')
    for (const tool of [
      'novel_status',
      'novel_brief',
      'novel_write_draft',
      'novel_revise',
      'novel_archive',
      'novel_state',
    ]) {
      expect(skill.content).toContain(tool)
    }
    expect(skill.source).toBe('bundled')
    expect(skill.description.length).toBeLessThan(400)
  })
})

describe('locale and enums', () => {
  it('keeps zh/en key sets identical', () => {
    const zh = JSON.parse(readFileSync(join(repoRoot, 'locale', 'zh.json'), 'utf8')) as Record<string, string>
    const en = JSON.parse(readFileSync(join(repoRoot, 'locale', 'en.json'), 'utf8')) as Record<string, string>
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const value of [...Object.values(zh), ...Object.values(en)]) expect(value.length).toBeGreaterThan(0)
    expect(zh['panel.title']).toBe('网文工坊')
  })

  it('declares all twelve genres, four platforms and four scene types', () => {
    expect(GENRES).toHaveLength(12)
    expect(PLATFORMS).toEqual(['fanqie', 'qidian', 'qimao', 'jinjiang'])
    expect(SCENE_TYPES).toHaveLength(4)
  })

  it('declares a genre-specific entry for every context genre and no unknown genre', () => {
    const pack = loadRulepack()
    for (const entry of pack.lexicon.contextual) {
      for (const genre of entry.genres ?? []) expect(GENRES).toContain(genre)
    }
    expect(pack.lexicon.zero_tolerance.length).toBeGreaterThanOrEqual(60)
  })
})
