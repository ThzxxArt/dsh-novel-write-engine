import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { importLegacyProject } from '../src/kernel/project/import.js'
import { loadProjectV2 } from '../src/kernel/project/layout.js'
import { loadBible, loadCanon, listChapterPlans } from '../src/kernel/book/store.js'
import { openStudioDb } from '../src/storage/db.js'
import { memoryCount } from '../src/storage/repositories/memory.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const temp = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('legacy import full surface', () => {
  it('maps every optional legacy field, state file, review, check, journal and backup', async () => {
    const from = temp('legacy-full-')
    for (const dir of ['outline', 'state', 'chapters', 'reviews', 'checks', 'backups', 'history']) {
      mkdirSync(join(from, dir), { recursive: true })
    }
    writeFileSync(
      join(from, 'novel.yaml'),
      [
        'schema_version: 1',
        'title: 完整旧书',
        'genre: 玄幻修仙',
        'platform: qidian',
        'author: 旧作者',
        'description: 完整简介',
        'created_at: "2026-01-01T00:00:00.000Z"',
        'targets:',
        '  words_per_chapter: [2000, 3000]',
        '  total_chapters: 2',
        '  dialogue_ratio: [0.4, 0.6]',
        '  min_cjk_chars: 1500',
      ].join('\n'),
    )
    writeFileSync(
      join(from, 'outline', 'outline.yaml'),
      [
        'book:',
        '  pov: 第一人称',
        '  logline: 一句话梗概',
        '  premise: 书前提',
        'volumes:',
        '  - { id: v1, title: 第一卷, start_chapter: 1, end_chapter: 2, arc: 第一卷弧 }',
        'chapters:',
        '  - num: 1',
        '    title: 第1章 开端',
        '    scene_type: 战斗/动作章',
        '    cast: [甲, 乙]',
        '    goal: 目标一',
        '    conflict: 冲突一',
        '    notes: 备注一',
        '    hook: 钩子一',
        '    target_words: [2200, 2400]',
        '  - { num: 2, title: 第2章 发展, hook: 钩子二 }',
      ].join('\n'),
    )
    writeFileSync(
      join(from, 'outline', 'worldbook.yaml'),
      [
        'premise: 世界前提',
        'themes: [成长, 选择]',
        'rules: [规则一, { name: 规则二 }]',
        'factions: [门派, { name: 家族 }]',
        'locations: [旧城, { name: 北境 }]',
        'glossary: [{ term: 旧词, definition: 旧义 }]',
        'characters: [{ name: 甲, role: 主角 }]',
      ].join('\n'),
    )
    writeFileSync(join(from, 'state', 'characters.yaml'), 'characters: [{ name: 甲, role: 主角 }]\n')
    writeFileSync(
      join(from, 'state', 'world.yaml'),
      ['locations: [旧城]', 'factions: [门派]', 'artifacts: [木匣]', 'rules: [契纸有落款]'].join('\n'),
    )
    writeFileSync(join(from, 'state', 'relationships.yaml'), 'items: [{ from: 甲, to: 乙 }]\n')
    writeFileSync(join(from, 'state', 'timeline.yaml'), 'items: [{ at: 第一天, event: 相遇 }]\n')
    writeFileSync(
      join(from, 'state', 'foreshadows.yaml'),
      'next_seq: 5\nitems: [{ key: fs1, title: 木匣 }]\n',
    )
    writeFileSync(join(from, 'state', 'handoff.yaml'), 'note: 交接说明\n')
    writeFileSync(join(from, 'state', 'journal.jsonl'), '{}\n')
    writeFileSync(join(from, 'chapters', 'chapter-001.md'), '第一章正文。\n')
    writeFileSync(join(from, 'chapters', 'chapter-002.md'), '第二章正文。\n')
    writeFileSync(join(from, 'reviews', 'ch001.review.yaml'), 'score: 120\n')
    writeFileSync(join(from, 'checks', 'ch001.check.yaml'), 'ok: true\n')
    writeFileSync(join(from, 'backups', 'old.db'), 'db')
    writeFileSync(join(from, 'history', 'old.md'), 'old')

    const to = join(from, '..', `legacy-full-out-${Date.now()}-${Math.random()}`)
    roots.push(to)
    const result = await importLegacyProject(from, to)
    expect(result.archived).toBe(2)
    expect(result.report).toContain('章节：2')
    const project = await loadProjectV2(to)
    expect(project.config.targets).toMatchObject({
      words_per_chapter: [2000, 3000],
      total_chapters: 2,
      dialogue_ratio: [0.4, 0.6],
      min_cjk_chars: 1500,
    })
    const plans = await listChapterPlans(project.store)
    expect(plans).toHaveLength(2)
    expect(plans[0]).toMatchObject({
      title: '第1章 开端',
      scene_type: '战斗/动作章',
      pov: '第一人称',
      goal: '目标一',
      conflict: '冲突一',
      turn: '备注一',
      hook: '钩子一',
      target_words: 2200,
    })
    expect(plans[0]!.notes).toEqual(['备注一'])
    const bible = await loadBible(project.store)
    expect(bible.premise.trim()).toBe('世界前提')
    expect(bible.themes).toContain('成长')
    expect(bible.world.rules).toEqual(expect.arrayContaining(['规则一', '规则二']))
    expect(bible.world.factions).toEqual(expect.arrayContaining(['门派', '家族']))
    expect(bible.world.locations).toEqual(expect.arrayContaining(['旧城', '北境']))
    expect(bible.world.glossary).toMatchObject({ 旧词: '旧义' })
    const canon = await loadCanon(project.store)
    expect(canon.entities.characters).toHaveLength(1)
    expect(canon.entities.locations).toHaveLength(1)
    expect(canon.entities.items).toHaveLength(1)
    expect(canon.entities.concepts).toHaveLength(1)
    expect(canon.relationships).toHaveLength(1)
    expect(canon.timeline).toHaveLength(1)
    expect(canon.foreshadows).toHaveLength(1)
    expect(canon.next_seq).toBe(5)
    expect(existsSync(join(to, '.studio', 'legacy', 'journal.jsonl'))).toBe(true)
    expect(existsSync(join(to, '.studio', 'legacy', 'backups', 'old.db'))).toBe(true)
    expect(existsSync(join(to, '.studio', 'legacy', 'history', 'old.md'))).toBe(true)
    expect(existsSync(join(to, 'reviews', 'ch-0001', 'legacy.yaml'))).toBe(true)
    expect(existsSync(join(to, 'reviews', 'ch-0001', 'legacy-check.yaml'))).toBe(true)
    const db = openStudioDb(join(to, '.studio', 'studio.db'))
    try {
      expect(memoryCount(db.orm, project.config.id)).toBe(2)
    } finally {
      db.close()
    }
    // Re-importing into the same destination must not merge or overwrite.
    await expect(importLegacyProject(from, to)).rejects.toMatchObject({
      code: 'STUDIO_PROJECT_EXISTS',
    })
  })
})
