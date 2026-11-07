import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import {
  applyStateDelta,
  chapterCardFromOutline,
  emptyBookOutline,
  emptyCanon,
  listChapterPlans,
  listVolumeFiles,
  loadBible,
  loadBookOutline,
  loadCanon,
  loadChapterPlan,
  moveChapterPlan,
  applyWorldbookPatch,
  saveBiblePlan,
  saveBookOutline,
  saveCanon,
  saveChapterPlan,
  saveOutlinePlan,
  setForeshadowStatus,
} from '../src/kernel/book/store.js'
import type { BiblePlan, OutlinePlan, StateDelta } from '../src/contracts/artifacts.js'

const roots: string[] = []
const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'book-v2-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: '书测试',
    genre: {
      major: 'fantasy',
      sub: 'fantasy.xianxia',
      tags: ['world.eastern_cultivation', 'plot.progression', 'tone.hot_blooded'],
    },
    audience: 'male',
    platform: 'qidian',
    targets: { total_chapters: 3 },
  })
  return loadProjectV2(root)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('kernel book store', () => {
  it('round-trips outline, canon and chapter plans', async () => {
    const project = await setup()
    const empty = await loadBookOutline(project.store)
    expect(empty.schema_version).toBe(2)
    await saveBookOutline(project.store, { ...emptyBookOutline(), logline: '一句话' })
    expect((await loadBookOutline(project.store)).logline).toBe('一句话')
    const canon = await loadCanon(project.store)
    expect(canon.entities.characters).toEqual([])
    await saveCanon(project.store, { ...emptyCanon(), next_seq: 5 })
    expect((await loadCanon(project.store)).next_seq).toBe(5)
    expect(await listVolumeFiles(project.store)).toEqual([])
    const plan: OutlinePlan = {
      schema_version: 2,
      kind: 'OutlinePlan',
      logline: '一句话',
      acts: [{ id: 'a1', title: '第一幕', summary: '开端' }],
      volumes: [{ id: 'v1', title: '第一卷', start_chapter: 1, end_chapter: 2, arc: '弧' }],
      chapters: [
        { chapter: 1, title: '第1章 风起云涌', summary: '开端', scene_type: '日常过渡章', hook: '钩子一' },
        { chapter: 2, title: '第2章 城南旧事', summary: '发展', scene_type: '日常过渡章', hook: '钩子二' },
      ],
      citations: [],
      open_questions: [],
    }
    await saveOutlinePlan(project.store, plan)
    const plans = await listChapterPlans(project.store)
    expect(plans).toHaveLength(2)
    expect((await loadChapterPlan(project.store, 1))?.title).toBe('第1章 风起云涌')
    expect(await loadChapterPlan(project.store, 9)).toBeNull()
    expect(chapterCardFromOutline(plan, 2)?.title).toBe('第2章 城南旧事')
    expect(chapterCardFromOutline(plan, 9)).toBeUndefined()
  })

  it('writes and reads a BiblePlan', async () => {
    const project = await setup()
    const plan: BiblePlan = {
      schema_version: 2,
      kind: 'BiblePlan',
      premise: '前提',
      themes: ['成长', '选择'],
      style: { guide: '短句。', fingerprint: { average_sentence_length: 12 } },
      world: { rules: ['规则'], factions: ['势力'], locations: ['地点'], glossary: { 术语: '解释' } },
      characters: [
        {
          slug: 'lin-yan',
          name: '林砚',
          role: '主角',
          profile: {},
          voice: { signature_phrases: [], register: '克制' },
        },
      ],
      citations: [],
      open_questions: [],
    }
    await saveBiblePlan(project.store, plan)
    const bible = await loadBible(project.store)
    expect(bible.premise).toContain('前提')
    expect(bible.themes).toContain('成长')
    expect(bible.world.rules).toEqual(['规则'])
    expect(bible.world.glossary['术语']).toBe('解释')
    expect(bible.characters[0]?.name).toBe('林砚')
  })

  it('merges a StateDelta across every ledger', async () => {
    await setup()
    const canon = emptyCanon()
    const delta: StateDelta = {
      schema_version: 2,
      kind: 'StateDelta',
      chapter: 1,
      entities: [
        {
          key: '林砚',
          kind: 'character',
          action: 'created',
          reason: '出场',
          evidence: '林砚推门进来，雨水从伞骨滴下。',
          patch: { role: '主角' },
        },
        {
          key: '旧城',
          kind: 'location',
          action: 'created',
          reason: '地点',
          evidence: '旧城的雨停了，街面泛着灰光。',
        },
        {
          key: '林砚',
          kind: 'character',
          action: 'updated',
          reason: '成长',
          evidence: '林砚握紧了刀，指节发白。',
          patch: { state: '警觉' },
        },
        {
          key: '秘密',
          kind: 'concept',
          action: 'no_change',
          reason: '尚未揭示',
          evidence: '屋里没有人提起那件秘密。',
        },
      ],
      relationships: [
        {
          from: '林砚',
          to: '掌柜',
          type_code: ' acquaintance',
          change: '建立',
          evidence: '两人交换了一个很短的的眼神。',
        },
      ],
      timeline: [{ key: 't1', label: '雨停', order: 1, evidence: '雨停在午后，屋檐还在滴水。' }],
      foreshadows: [
        { key: 'fs1', action: 'planted', reason: '埋下', evidence: '木匣锁扣缺了一角，铜绿发暗。' },
        { key: 'fs1', action: 'advanced', reason: '推进', evidence: '锁扣上的铜绿又深了一层。' },
        {
          key: 'fs1',
          action: 'resolved',
          reason: '回收',
          evidence: '木匣终于打开，里面是一叠契纸。',
          resolved_anchor: '木匣终于打开，里面是一叠契纸。',
        },
      ],
      resources: [
        { character: '林砚', resource: '钱', mode: 'set', value: 10, evidence: '柜台上摆着十枚铜钱。' },
        { character: '掌柜', resource: '账', mode: 'add', value: 3, evidence: '账本上记了三笔旧账。' },
      ],
      handoff: { next: '城南' },
    }
    const next = applyStateDelta(canon, delta)
    expect(next.entities.characters).toHaveLength(1)
    expect(next.entities.locations).toHaveLength(1)
    expect(next.entities.concepts).toHaveLength(0)
    expect(next.relationships).toHaveLength(1)
    expect(next.timeline).toHaveLength(1)
    expect(next.foreshadows[0]).toMatchObject({ key: 'fs1', action: 'resolved' })
    expect(next.resources.find((row) => row.character === '林砚' && row.resource === '钱')?.value).toBe(10)
    const afterAdd = applyStateDelta(next, {
      ...delta,
      chapter: 2,
      resources: [
        { character: '林砚', resource: '钱', mode: 'add', value: 5, evidence: '掌柜又添了五枚铜钱。' },
      ],
    })
    expect(afterAdd.resources.find((row) => row.character === '林砚' && row.resource === '钱')?.value).toBe(
      15,
    )
    expect(next.handoff.next).toBe('城南')
    expect(next.next_seq).toBe(canon.next_seq + 1)
    expect(next.updated_at).toBeDefined()
    const again = applyStateDelta(next, delta)
    expect(again.entities.characters).toHaveLength(1)
  })

  it('applies a worldbook patch to characters, world arrays, glossary and codex', async () => {
    const project = await setup()
    await applyWorldbookPatch(project.store, {
      schema_version: 2,
      kind: 'WorldbookPatch',
      entities: [
        {
          key: 'lin-yan',
          entity_kind: 'character',
          name: '林砚',
          summary: '查账的年轻人',
          facts: { role: '主角' },
          evidence: '林砚推门进来，雨水从伞骨滴下。',
        },
        {
          key: 'loc-1',
          entity_kind: 'location',
          name: '城南旧铺',
          summary: '旧铺',
          facts: {},
          evidence: '城南旧铺的门轴响了一声。',
        },
        {
          key: 'fac-1',
          entity_kind: 'faction',
          name: '账房',
          summary: '管账的人',
          facts: {},
          evidence: '账房先生把算盘收进抽屉。',
        },
        {
          key: 'rule-1',
          entity_kind: 'rule',
          name: '契纸',
          summary: '契纸必须有落款',
          facts: {},
          evidence: '契纸右下角缺了一枚落款。',
        },
        {
          key: 'term-1',
          entity_kind: 'term',
          name: '契纸',
          summary: '盖印的凭据',
          facts: {},
          evidence: '掌柜把契纸摊在灯下。',
        },
        {
          key: 'item-1',
          entity_kind: 'item',
          name: '木匣',
          summary: '缺角木匣',
          facts: {},
          evidence: '木匣锁扣缺了一角，铜绿发暗。',
        },
      ],
      citations: [],
      open_questions: [],
    })
    const bible = await loadBible(project.store)
    expect(bible.characters.some((row) => row.slug === 'lin-yan')).toBe(true)
    expect(bible.world.locations).toContain('城南旧铺')
    expect(bible.world.factions).toContain('账房')
    expect(bible.world.rules).toContain('契纸必须有落款')
    expect(bible.world.glossary['契纸']).toBe('盖印的凭据')
    expect(bible.codex?.[0]).toMatchObject({ entity_kind: 'item', name: '木匣' })
    await applyWorldbookPatch(project.store, {
      schema_version: 2,
      kind: 'WorldbookPatch',
      entities: [
        {
          key: 'lin-yan',
          entity_kind: 'character',
          name: '林砚',
          summary: '更成熟的查账人',
          facts: { role: '主角', state: '警觉' },
          evidence: '林砚握紧了刀，指节发白。',
        },
        {
          key: 'loc-1',
          entity_kind: 'location',
          name: '城南旧铺',
          summary: '修葺后的旧铺',
          facts: {},
          evidence: '城南旧铺换了新的门轴。',
        },
        {
          key: 'rule-1',
          entity_kind: 'rule',
          name: '契纸',
          summary: '契纸必须有落款',
          facts: {},
          evidence: '契纸右下角缺了一枚落款。',
        },
      ],
      citations: [],
      open_questions: [],
    })
    const updated = await loadBible(project.store)
    expect(updated.characters.filter((row) => row.slug === 'lin-yan')).toHaveLength(1)
    expect(updated.characters.find((row) => row.slug === 'lin-yan')?.summary).toBe('更成熟的查账人')
    expect(updated.world.locations.filter((row) => row === '城南旧铺')).toHaveLength(1)
    expect(updated.world.rules.filter((row) => row === '契纸必须有落款')).toHaveLength(1)
  })

  it('rejects set and add for the same resource in one chapter delta', () => {
    const delta = {
      schema_version: 2,
      kind: 'StateDelta',
      chapter: 1,
      entities: [],
      relationships: [],
      timeline: [],
      foreshadows: [],
      resources: [
        { character: '林砚', resource: '钱', mode: 'set', value: 10, evidence: '柜台上摆着十枚铜钱。' },
        { character: '林砚', resource: '钱', mode: 'add', value: 5, evidence: '掌柜又添了五枚铜钱。' },
      ],
      handoff: {},
    } as StateDelta
    expect(() => applyStateDelta(emptyCanon(), delta)).toThrow(/both set and add/u)
  })

  it('moves unwritten chapter cards but refuses to renumber archived prose', async () => {
    const project = await setup()
    const plan = (chapter: number, title: string): import('../src/contracts/artifacts.js').ChapterPlan => ({
      schema_version: 2,
      kind: 'ChapterPlan',
      chapter,
      title,
      scene_type: '日常过渡章',
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
    await saveChapterPlan(project.store, plan(1, '第1章 第一场'))
    await saveChapterPlan(project.store, plan(2, '第2章 第二场'))
    const moved = await moveChapterPlan(project.store, 1, 2)
    expect(moved.map((row) => row.title)).toEqual(['第2章 第二场', '第1章 第一场'])
    await project.store.writeText('manuscript/ch-0001.md', '已归档正文\n')
    await expect(moveChapterPlan(project.store, 1, 2)).rejects.toThrow(/manuscript already exists/u)
  })

  it('requires a正文 anchor before a foreshadow can be resolved', async () => {
    const project = await setup()
    await saveCanon(project.store, {
      ...emptyCanon(),
      foreshadows: [{ key: 'fs-move', title: '缺角契纸', status: 'open' }],
    })
    await expect(setForeshadowStatus(project.store, 'fs-move', 'resolved')).rejects.toThrow(/anchor/u)
    const next = await setForeshadowStatus(project.store, 'fs-move', 'resolved', '契纸在灯下合上。')
    expect(next.foreshadows[0]).toMatchObject({ status: 'resolved', resolved_anchor: '契纸在灯下合上。' })
  })
})
