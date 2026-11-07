import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { importLegacyProject } from '../src/kernel/project/import.js'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const temp = (prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const legacyYaml = (extra: Record<string, unknown> = {}) =>
  [
    'schema_version: 1',
    'title: 极简旧书',
    'genre: 玄幻修仙',
    'platform: fanqie',
    'author: 旧作者',
    'description: 旧简介',
    'created_at: "2026-01-01T00:00:00.000Z"',
    'targets: { total_chapters: 2 }',
    ...Object.entries(extra).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
  ].join('\n')

describe('legacy import edge paths', () => {
  it('imports a minimal project without outline/worldbook/state and reports warnings', async () => {
    const from = temp('legacy-min-')
    writeFileSync(join(from, 'novel.yaml'), legacyYaml())
    const to = join(from, '..', `legacy-imported-${Date.now()}-${Math.random()}`)
    roots.push(to)
    const result = await importLegacyProject(from, to)
    expect(result.chapters).toBe(0)
    expect(result.report).toContain('legacy outline had no chapter cards')
    const project = await loadProjectV2(to)
    expect(project.config.genre.sub).toBe('fantasy.xianxia')
    expect(existsSync(join(to, 'bible', 'world', 'rules.yaml'))).toBe(true)
  })

  it('copies journal and backups and maps loose worldbook rows', async () => {
    const from = temp('legacy-rich-')
    mkdirSync(join(from, 'outline'), { recursive: true })
    mkdirSync(join(from, 'state'), { recursive: true })
    mkdirSync(join(from, 'backups'), { recursive: true })
    writeFileSync(join(from, 'novel.yaml'), legacyYaml())
    writeFileSync(join(from, 'state', 'journal.jsonl'), '{}\n')
    writeFileSync(join(from, 'backups', 'old.db'), 'db')
    writeFileSync(
      join(from, 'outline', 'worldbook.yaml'),
      [
        'premise: 世界前提',
        'themes: [成长, 选择]',
        'rules: [规则一, { name: 规则二 }]',
        'factions: [门派, { name: 家族 }]',
        'locations: [旧城, { name: 北境 }]',
        'characters: [{ name: 甲, role: 主角 }]',
        'glossary: [{ term: 旧词, definition: 旧义 }]',
      ].join('\n'),
    )
    const to = join(from, '..', `legacy-rich-${Date.now()}-${Math.random()}`)
    roots.push(to)
    await importLegacyProject(from, to)
    expect(existsSync(join(to, '.studio', 'legacy', 'journal.jsonl'))).toBe(true)
    expect(existsSync(join(to, '.studio', 'legacy', 'backups', 'old.db'))).toBe(true)
    const project = await loadProjectV2(to)
    const rules = await project.store.readText('bible/world/rules.yaml')
    expect(rules).toContain('规则二')
    expect(existsSync(join(to, 'bible', 'characters'))).toBe(true)
  })

  it('rejects same source/destination, missing manifests, unknown genres and existing targets', async () => {
    const from = temp('legacy-invalid-')
    writeFileSync(join(from, 'novel.yaml'), legacyYaml())
    await expect(importLegacyProject(from, from)).rejects.toMatchObject({
      code: 'STUDIO_IMPORT_INVALID',
    })
    const empty = temp('legacy-empty-')
    await expect(importLegacyProject(empty, join(empty, '..', `x-${Date.now()}`))).rejects.toMatchObject({
      code: 'STUDIO_IMPORT_INVALID',
    })
    const badGenre = temp('legacy-genre-')
    writeFileSync(join(badGenre, 'novel.yaml'), legacyYaml({ genre: '不存在的类型' }))
    await expect(
      importLegacyProject(badGenre, join(badGenre, '..', `bad-${Date.now()}-${Math.random()}`)),
    ).rejects.toMatchObject({ code: 'STUDIO_IMPORT_INVALID' })

    const to = temp('legacy-target-')
    await initProjectV2({
      root: to,
      title: '已有项目',
      genre: {
        major: 'mystery',
        sub: 'mystery.detective',
        tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
      },
      audience: 'general',
      platform: 'fanqie',
      targets: { total_chapters: 1 },
    })
    await expect(importLegacyProject(from, to)).rejects.toMatchObject({
      code: 'STUDIO_PROJECT_EXISTS',
    })
  })
})
