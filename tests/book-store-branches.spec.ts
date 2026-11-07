import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FsStore } from '../src/store/fs.js'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import {
  applyStateDelta,
  applyWorldbookPatch,
  emptyCanon,
  loadBible,
  loadCanon,
  moveChapterPlan,
  saveBiblePlan,
  saveCanon,
  saveChapterPlan,
  saveOutlinePlan,
  setForeshadowStatus,
} from '../src/kernel/book/store.js'
import type { BiblePlan, OutlinePlan, StateDelta } from '../src/contracts/artifacts.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const temp = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const setup = async () => {
  const root = temp('book-branch-')
  await initProjectV2({
    root,
    title: '分支之书',
    genre: {
      major: 'mystery',
      sub: 'mystery.detective',
      tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
    },
    audience: 'general',
    platform: 'fanqie',
    targets: { total_chapters: 3 },
  })
  return loadProjectV2(root)
}

describe('book store defensive branches', () => {
  it('returns defaults for missing bible files and tolerates corrupt sub-files', async () => {
    const store = new FsStore(temp('book-empty-'))
    const empty = await loadBible(store)
    expect(empty.premise).toBe('')
    expect(empty.themes).toBe('')
    expect(empty.styleGuide).toBe('')
    expect(empty.fingerprint).toEqual({})
    expect(empty.world).toEqual({ rules: [], factions: [], locations: [], glossary: {} })
    expect(empty.characters).toEqual([])
    expect(empty.codex).toEqual([])

    await store.ensureDir('bible/style')
    await store.ensureDir('bible/world')
    await store.ensureDir('bible/characters')
    await store.writeText('bible/style/fingerprint.json', '{broken')
    await store.writeText('bible/world/rules.yaml', '{broken')
    await store.writeText('bible/world/factions.yaml', 'null')
    await store.writeText('bible/world/locations.yaml', '- 旧城')
    await store.writeText('bible/world/glossary.yaml', '{broken')
    await store.writeText('bible/world/codex.yaml', '{broken')
    await store.writeText('bible/characters/a.yaml', '{broken')
    const bible = await loadBible(store)
    expect(bible.fingerprint).toEqual({})
    expect(bible.world.rules).toEqual([])
    expect(bible.world.factions).toEqual([])
    expect(bible.world.locations).toEqual([])
    expect(bible.world.glossary).toEqual({})
    expect(bible.characters).toEqual([{ slug: 'a', unreadable: true }])
    expect(bible.codex).toEqual([])
    expect(await loadCanon(store)).toMatchObject({ schema_version: 2, next_seq: 1 })
  })

  it('writes every worldbook entity kind and updates existing rows', async () => {
    const store = new FsStore(temp('book-world-'))
    const patch = {
      schema_version: 2 as const,
      kind: 'WorldbookPatch' as const,
      entities: [
        {
          key: 'char-1',
          entity_kind: 'character' as const,
          name: '林砚',
          summary: '主角',
          facts: { age: 20 },
          evidence: '林砚把契纸合上。',
        },
        {
          key: 'loc-1',
          entity_kind: 'location' as const,
          name: '城南',
          summary: '旧铺所在',
          facts: {},
          evidence: '城南的巷子很窄。',
        },
        {
          key: 'fac-1',
          entity_kind: 'faction' as const,
          name: '账房',
          summary: '旧势力',
          facts: {},
          evidence: '账房的人来过一次。',
        },
        {
          key: 'item-1',
          entity_kind: 'item' as const,
          name: '木匣',
          summary: '缺角',
          facts: {},
          evidence: '木匣的锁扣缺了一角。',
        },
        {
          key: 'rule-1',
          entity_kind: 'rule' as const,
          name: '契纸规则',
          summary: '必须有落款',
          facts: {},
          evidence: '契纸必须有落款和日期。',
        },
      ],
      citations: [],
      open_questions: [],
    }
    await applyWorldbookPatch(store, patch)
    expect(await store.readText('bible/characters/char-1.yaml')).toContain('林砚')
    expect(await store.readText('bible/world/locations.yaml')).toContain('城南')
    expect(await store.readText('bible/world/factions.yaml')).toContain('账房')
    expect(await store.readText('bible/world/rules.yaml')).toContain('必须有落款')
    expect(await store.readText('bible/world/codex.yaml')).toContain('木匣')
    await applyWorldbookPatch(store, {
      ...patch,
      entities: [{ ...patch.entities[0]!, summary: '更新后的主角' }],
    })
    expect(await store.readText('bible/characters/char-1.yaml')).toContain('更新后的主角')
    const bible = await loadBible(store)
    expect(bible.world.locations).toEqual(expect.arrayContaining(['城南']))
    expect(bible.characters.some((row) => row.name === '林砚')).toBe(true)
    expect(bible.codex?.some((row) => row.name === '木匣')).toBe(true)
  })

  it('normalizes string world rows, malformed files and empty character slugs', async () => {
    const project = await setup()
    const store = project.store
    await store.writeText('bible/world/locations.yaml', 'locations: [旧城, 42]\n')
    await store.writeText('bible/world/factions.yaml', 'factions: { a: 1 }\n')
    await store.writeText('bible/world/glossary.yaml', 'terms: [1, 2]\n')
    await store.writeText('bible/world/codex.yaml', 'entries: { a: 1 }\n')
    await applyWorldbookPatch(store, {
      schema_version: 2,
      kind: 'WorldbookPatch',
      entities: [
        {
          key: '!!!',
          entity_kind: 'character',
          name: '怪名',
          summary: '没有合法 slug',
          facts: {},
          evidence: '这个人的名字很奇怪。',
        },
        {
          key: 'loc-2',
          entity_kind: 'location',
          name: '旧城',
          summary: '已有地点',
          facts: {},
          evidence: '旧城的墙皮掉了。',
        },
      ],
      citations: [],
      open_questions: [],
    })
    expect(await store.readText('bible/characters/character.yaml')).toContain('怪名')
    const bible = await loadBible(store)
    expect(bible.world.locations).toEqual(expect.arrayContaining(['旧城']))
    expect(bible.world.factions).toEqual([])
    expect(bible.world.glossary).toEqual({})
    expect(bible.codex).toEqual([])
  })

  it('handles move-to-self and foreshadows keyed by id/title', async () => {
    const project = await setup()
    const store = project.store
    const plan = (chapter: number, title: string) => ({
      schema_version: 2 as const,
      kind: 'ChapterPlan' as const,
      chapter,
      title,
      scene_type: '日常过渡章' as const,
      pov: '第三人称',
      cast: ['林砚'],
      goal: '目标',
      conflict: '冲突',
      turn: '转折',
      outcome: '结果',
      target_words: 2400,
      hook: '钩子',
      foreshadows: [],
      notes: [],
      citations: [],
      open_questions: [],
    })
    await saveChapterPlan(store, plan(1, '第1章 开端'))
    await saveChapterPlan(store, plan(2, '第2章 发展'))
    expect(await moveChapterPlan(store, 1, 1)).toHaveLength(2)
    await expect(moveChapterPlan(store, 1, 9)).rejects.toMatchObject({
      code: 'STUDIO_PROJECT_INVALID',
    })
    const canon = emptyCanon()
    canon.foreshadows.push({ id: 'fs-id', status: 'open' })
    canon.foreshadows.push({ title: 'fs-title', status: 'open' })
    await saveCanon(store, canon)
    expect((await setForeshadowStatus(store, 'fs-id', 'advanced')).foreshadows[0]!.status).toBe('advanced')
    expect(
      (await setForeshadowStatus(store, 'fs-title', 'resolved', '文本里的收束句')).foreshadows[1]!.status,
    ).toBe('resolved')
  })

  it('removes stale character and volume files when plans shrink', async () => {
    const project = await setup()
    const store = project.store
    await store.writeText('bible/characters/stale.yaml', 'stale: true\n')
    const bible: BiblePlan = {
      schema_version: 2,
      kind: 'BiblePlan',
      premise: '前提',
      themes: ['主题'],
      style: { guide: '短句。', fingerprint: {} },
      world: { rules: [], factions: [], locations: [], glossary: {} },
      characters: [
        {
          slug: 'lin',
          name: '林砚',
          role: '主角',
          profile: {},
          voice: { signature_phrases: [], register: '' },
        },
      ],
      citations: [],
      open_questions: [],
    }
    await saveBiblePlan(store, bible)
    expect(await store.readText('bible/characters/stale.yaml')).toBeNull()
    expect(await store.readText('bible/characters/lin.yaml')).toContain('林砚')

    await store.writeText('outline/volumes/stale.yaml', 'stale: true\n')
    await store.writeText('outline/volumes/readme.txt', 'keep')
    const outline: OutlinePlan = {
      schema_version: 2,
      kind: 'OutlinePlan',
      logline: '一句话',
      acts: [{ id: 'a', title: '第一幕', summary: '开始' }],
      volumes: [{ id: 'v1', title: '第一卷', start_chapter: 1, end_chapter: 1, arc: '弧' }],
      chapters: [],
      citations: [],
      open_questions: [],
    }
    await saveOutlinePlan(store, outline)
    expect(await store.readText('outline/volumes/stale.yaml')).toBeNull()
    expect(await store.readText('outline/volumes/readme.txt')).toBe('keep')
  })

  it('handles unknown, open, advanced and resolved foreshadow transitions', async () => {
    const project = await setup()
    const canon = emptyCanon()
    canon.foreshadows.push({ key: 'fs1', title: '木匣', status: 'open', resolved_anchor: '旧锚点' })
    await saveCanon(project.store, canon)
    await expect(setForeshadowStatus(project.store, 'fs1', 'resolved')).rejects.toMatchObject({
      code: 'STUDIO_ARTIFACT_INVALID',
    })
    await expect(setForeshadowStatus(project.store, 'missing', 'open')).rejects.toMatchObject({
      code: 'STUDIO_PROJECT_INVALID',
    })
    const advanced = await setForeshadowStatus(project.store, 'fs1', 'advanced')
    expect(advanced.foreshadows[0]!.resolved_anchor).toBeUndefined()
    const resolved = await setForeshadowStatus(project.store, 'fs1', 'resolved', '木匣的锁扣缺了一角')
    expect(resolved.foreshadows[0]!.resolved_anchor).toBe('木匣的锁扣缺了一角')
    const reopened = await setForeshadowStatus(project.store, 'fs1', 'open')
    expect(reopened.foreshadows[0]!.resolved_anchor).toBeUndefined()
  })

  it('applies every delta bucket and both resource modes', async () => {
    const canon = emptyCanon()
    canon.resources.push({ character: '林砚', resource: '钱', value: 10 })
    const delta: StateDelta = {
      schema_version: 2,
      kind: 'StateDelta',
      chapter: 1,
      entities: [
        {
          key: 'loc',
          kind: 'location',
          action: 'created',
          reason: '到达',
          evidence: '他推门走进城南的旧铺子。',
        },
        {
          key: 'fac',
          kind: 'faction',
          action: 'created',
          reason: '接触',
          evidence: '账房的人那天下午来过一次。',
        },
        {
          key: 'item',
          kind: 'item',
          action: 'created',
          reason: '获得',
          evidence: '他伸手拿起柜上的旧木匣。',
        },
        {
          key: 'con',
          kind: 'concept',
          action: 'created',
          reason: '规则',
          evidence: '契纸必须有落款和日期。',
        },
        {
          key: 'loc',
          kind: 'location',
          action: 'updated',
          reason: '改名',
          evidence: '旧铺门口换了新的招牌。',
          patch: { name: '新铺' },
        },
      ],
      relationships: [
        { from: '林砚', to: '老周', type_code: 'knows', change: 'add', evidence: '两个人在灯下对坐了很久。' },
      ],
      timeline: [
        { key: 't1', label: '入冬', order: 1, evidence: '城南的冬天来得很早。' },
        { key: 't1', label: '入冬后', order: 2, evidence: '入冬后下了第一场冷雨。' },
      ],
      foreshadows: [
        { key: 'fs', action: 'planted', reason: '埋线', evidence: '木匣的锁扣缺了一角。' },
        { key: 'fs', action: 'advanced', reason: '推进', evidence: '锁扣上又被磨掉了一层铜绿。' },
      ],
      resources: [
        { character: '林砚', resource: '钱', mode: 'add', value: 5, evidence: '他又得了五枚铜钱。' },
        { character: '林砚', resource: '粮', mode: 'set', value: 3, evidence: '油纸包里的干粮还剩三包。' },
        { character: '林砚', resource: '柴', mode: 'add', value: 2, evidence: '掌柜又从后院搬来两捆柴。' },
      ],
      handoff: { note: '下一章去城北' },
    }
    const next = applyStateDelta(canon, delta)
    expect(next.entities.locations).toHaveLength(1)
    expect(next.entities.locations[0]).toMatchObject({ key: 'loc', name: '新铺' })
    expect(next.entities.factions).toHaveLength(1)
    expect(next.entities.items).toHaveLength(1)
    expect(next.entities.concepts).toHaveLength(1)
    expect(next.relationships).toHaveLength(1)
    expect(next.timeline).toEqual([expect.objectContaining({ key: 't1', order: 2 })])
    expect(next.foreshadows[0]).toMatchObject({ key: 'fs', action: 'advanced' })
    expect(next.resources.find((row) => row.resource === '钱')?.value).toBe(15)
    expect(next.resources.find((row) => row.resource === '粮')?.value).toBe(3)
    expect(next.resources.find((row) => row.resource === '柴')?.value).toBe(2)
    expect(next.handoff).toMatchObject({ note: '下一章去城北' })
  })
})
