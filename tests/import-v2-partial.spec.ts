import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { importLegacyProject } from '../src/kernel/project/import.js'
import { loadProjectV2 } from '../src/kernel/project/layout.js'
import { loadCanon, listChapterPlans } from '../src/kernel/book/store.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const temp = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('legacy import partial surface', () => {
  it('falls back for a chapter card with no book/volumes/fields and non-array state', async () => {
    const from = temp('legacy-partial-')
    for (const dir of ['outline', 'state']) mkdirSync(join(from, dir), { recursive: true })
    writeFileSync(
      join(from, 'novel.yaml'),
      [
        'schema_version: 1',
        'title: 残缺旧书',
        'genre: 玄幻修仙',
        'description: 只有简介',
        'targets:',
        '  total_chapters: 1',
      ].join('\n'),
    )
    writeFileSync(join(from, 'outline', 'outline.yaml'), 'chapters:\n  - {}\n')
    writeFileSync(
      join(from, 'outline', 'worldbook.yaml'),
      [
        'themes: not-an-array',
        'rules: not-an-array',
        'factions: {}',
        'locations: null',
        'glossary: not-an-array',
        'characters: {}',
      ].join('\n'),
    )
    writeFileSync(join(from, 'state', 'characters.yaml'), 'characters: not-an-array\n')
    writeFileSync(
      join(from, 'state', 'world.yaml'),
      'locations: {}\nfactions: null\nartifacts: x\nrules: {}\n',
    )
    writeFileSync(join(from, 'state', 'relationships.yaml'), 'items: x\n')
    writeFileSync(join(from, 'state', 'timeline.yaml'), 'items: {}\n')
    writeFileSync(join(from, 'state', 'foreshadows.yaml'), 'items: null\n')
    writeFileSync(join(from, 'state', 'handoff.yaml'), '{}\n')

    const to = join(from, '..', `legacy-partial-out-${Date.now()}-${Math.random()}`)
    roots.push(to)
    const result = await importLegacyProject(from, to)
    expect(result.archived).toBe(0)
    const project = await loadProjectV2(to)
    expect(project.config.title).toBe('残缺旧书')
    expect(project.config.targets.words_per_chapter).toEqual([2200, 3200])
    const plans = await listChapterPlans(project.store)
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      title: '第1章 未命名章节',
      scene_type: '日常过渡章',
      pov: '第三人称',
      cast: ['主角'],
      goal: '（旧稿未提供目标）',
      conflict: '（旧稿未提供冲突）',
      turn: '（旧稿未提供转折）',
      outcome: '（旧稿未提供结果）',
      target_words: 2400,
    })
    const canon = await loadCanon(project.store)
    expect(canon.entities.characters).toEqual([])
    expect(canon.entities.locations).toEqual([])
    expect(canon.relationships).toEqual([])
    expect(canon.timeline).toEqual([])
    expect(canon.foreshadows).toEqual([])
  })
})
