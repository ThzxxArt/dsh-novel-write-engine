import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { importLegacyProject } from '../src/kernel/project/import.js'
import { loadProjectV2 } from '../src/kernel/project/layout.js'
import { openStudioDb } from '../src/storage/db.js'
import { listRuns } from '../src/storage/repositories/runs.js'

const roots: string[] = []
const makeLegacy = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-import-'))
  roots.push(root)
  mkdirSync(join(root, 'outline'), { recursive: true })
  mkdirSync(join(root, 'state'), { recursive: true })
  mkdirSync(join(root, 'chapters'), { recursive: true })
  mkdirSync(join(root, 'reviews'), { recursive: true })
  mkdirSync(join(root, 'checks'), { recursive: true })
  writeFileSync(
    join(root, 'novel.yaml'),
    [
      'schema_version: 1',
      'title: 旧书',
      'genre: 玄幻修仙',
      'platform: fanqie',
      'author: 旧作者',
      'description: 旧简介',
      'created_at: "2026-01-01T00:00:00.000Z"',
      'targets: { words_per_chapter: [2000, 3000], total_chapters: 2, dialogue_ratio: [0.4, 0.6] }',
    ].join('\n'),
  )
  writeFileSync(
    join(root, 'outline', 'outline.yaml'),
    [
      'schema_version: 1',
      'updated_at: "2026-01-01T00:00:00.000Z"',
      'book:',
      '  premise: 旧前提',
      '  logline: 旧一句话',
      '  themes: [成长]',
      '  tone: 冷峻',
      '  pov: 第三人称',
      '  audience: 男频',
      '  selling_points: []',
      '  ending: 旧结局',
      '  strict: false',
      'volumes: []',
      'chapters:',
      '  - num: 1',
      '    volume: null',
      '    title: 第1章 旧章',
      '    scene_type: 日常过渡章',
      '    goal: 旧目标',
      '    conflict: 旧冲突',
      '    hook: 旧钩子',
      '    cast: [甲]',
      '    target_words: [2000, 3000]',
      '    notes: ""',
      '    status: planned',
      '    archived_at: null',
      '    word_count: null',
      '    score: null',
    ].join('\n'),
  )
  writeFileSync(
    join(root, 'outline', 'worldbook.yaml'),
    [
      'schema_version: 1',
      'updated_at: "2026-01-01T00:00:00.000Z"',
      'premise: 旧世界',
      'setting: 旧设定',
      'rules: [{ name: 规则一, description: 说明 }]',
      'factions: []',
      'locations: [{ name: 旧城, description: 城市, layout: 南北, capacity: 100 }]',
      'characters: [{ name: 甲, role: 主角, description: 旧角色, arc: 成长 }]',
      'glossary: [{ term: 旧词, definition: 旧义 }]',
      'backstory: []',
      'themes: [成长]',
    ].join('\n'),
  )
  writeFileSync(join(root, 'state', 'characters.yaml'), 'schema_version: 1\ncharacters: []\n')
  writeFileSync(
    join(root, 'state', 'world.yaml'),
    'schema_version: 1\nlocations: []\nfactions: []\nartifacts: []\nrules: []\n',
  )
  writeFileSync(join(root, 'state', 'timeline.yaml'), 'schema_version: 1\nitems: []\n')
  writeFileSync(join(root, 'state', 'foreshadows.yaml'), 'schema_version: 1\nnext_seq: 1\nitems: []\n')
  writeFileSync(join(root, 'state', 'relationships.yaml'), 'schema_version: 1\nitems: []\n')
  writeFileSync(join(root, 'state', 'handoff.yaml'), 'schema_version: 1\nhandoff: {}\n')
  writeFileSync(join(root, 'chapters', 'chapter-001.md'), '旧正文第一章。\n')
  writeFileSync(join(root, 'reviews', 'ch001.review.yaml'), 'schema_version: 1\nverdict: pass\n')
  writeFileSync(join(root, 'checks', 'ch001.check.yaml'), 'schema_version: 1\nverdict: pass\n')
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('legacy import', () => {
  it('imports a 0.2.x project once, maps the genre and never auto-continues', async () => {
    const from = makeLegacy()
    const to = join(from, '..', `imported-${Date.now()}`)
    roots.push(to)
    const result = await importLegacyProject(from, to)
    expect(result.chapters).toBe(1)
    const project = await loadProjectV2(to)
    expect(project.config.title).toBe('旧书')
    expect(project.config.genre.sub).toBe('fantasy.xianxia')
    expect(readFileSync(join(to, 'manuscript', 'ch-0001.md'), 'utf8')).toContain('旧正文')
    expect(existsSync(join(to, 'reviews', 'ch-0001', 'legacy.yaml'))).toBe(true)
    expect(existsSync(join(to, 'reviews', 'ch-0001', 'legacy-check.yaml'))).toBe(true)
    expect(existsSync(join(to, 'IMPORT_REPORT.md'))).toBe(true)
    const report = readFileSync(join(to, 'IMPORT_REPORT.md'), 'utf8')
    expect(report).toContain('玄幻修仙')
    expect(report).toContain('fantasy.xianxia')
    const db = openStudioDb(join(to, '.studio', 'studio.db'))
    try {
      expect(listRuns(db.orm, project.config.id)).toHaveLength(0)
      const hits = db.raw
        .prepare("SELECT COUNT(*) AS count FROM memory_chunk WHERE kind = 'chapter'")
        .get() as { count: number }
      expect(hits.count).toBe(1)
    } finally {
      db.close()
    }
    await expect(importLegacyProject(from, to)).rejects.toMatchObject({ code: 'STUDIO_PROJECT_EXISTS' })
  })
})
