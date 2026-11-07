import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import { openStudioDb } from '../src/storage/db.js'
import { saveCanon, saveChapterPlan } from '../src/kernel/book/store.js'
import { emptyCanon } from '../src/kernel/book/store.js'
import { upsertMemoryChunk } from '../src/storage/repositories/memory.js'
import { insertComment } from '../src/storage/repositories/artifacts.js'
import { buildContextPack, contextPromptSection } from '../src/kernel/read/context.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('context pack', () => {
  it('protects current plan/cast/foreshadows and explains every item', async () => {
    const root = mkdtempSync(join(tmpdir(), 'context-v2-'))
    roots.push(root)
    await initProjectV2({
      root,
      title: '上下文',
      genre: {
        major: 'mystery',
        sub: 'mystery.detective',
        tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
      },
      audience: 'general',
      platform: 'fanqie',
    })
    const project = await loadProjectV2(root)
    const db = openStudioDb(join(root, '.studio', 'studio.db'))
    try {
      await saveChapterPlan(project.store, {
        schema_version: 2,
        kind: 'ChapterPlan',
        chapter: 1,
        title: '第1章 风起云涌',
        scene_type: '日常过渡章',
        pov: '第三人称',
        cast: ['林砚'],
        goal: '查账',
        conflict: '来人不肯交底',
        turn: '契纸落款被刮去',
        outcome: '去城南',
        target_words: 2400,
        hook: '门外传来三声敲击',
        foreshadows: [],
        notes: [],
        citations: [],
        open_questions: [],
      })
      await saveCanon(project.store, {
        ...emptyCanon(),
        entities: {
          characters: [{ key: '林砚', name: '林砚', role: '主角' }],
          locations: [],
          factions: [],
          items: [],
          concepts: [],
        },
        foreshadows: [{ key: 'fs1', title: '木匣', status: 'open' }],
      })
      upsertMemoryChunk(db.orm, {
        projectId: project.config.id,
        kind: 'canon',
        sourcePath: 'state/canon.yaml',
        sourceHash: 'h',
        text: '林砚在城南旧铺查账。',
        meta: { entities: ['林砚'] },
      })
      insertComment(db.orm, {
        projectId: project.config.id,
        chapter: 1,
        paragraph: 2,
        author: 'author',
        body: '这里要收紧，不要把情绪写满。',
      })
      const pack = await buildContextPack(project, db, {
        chapter: 1,
        stage: 'draft',
        role: 'drafter',
        query: '林砚',
      })
      expect(pack.items.some((item) => item.protected && item.sourcePath.includes('ch-0001'))).toBe(true)
      expect(pack.items.some((item) => item.reason.includes('active-cast'))).toBe(true)
      expect(pack.items.some((item) => item.reason.includes('open-foreshadows'))).toBe(true)
      expect(pack.items.some((item) => item.reason.includes('author-comments'))).toBe(true)
      expect(pack.usedTokens).toBeLessThanOrEqual(pack.budgetTokens)
      for (const item of pack.items) {
        expect(item.sourceHash.startsWith('sha256:')).toBe(true)
        expect(item.reason.length).toBeGreaterThan(0)
      }
      expect(contextPromptSection(pack)).toContain('上下文包')
      await project.store.writeText('manuscript/ch-0001.md', '林砚把伞收在门边。\n')
      const recent = await buildContextPack(project, db, { chapter: 2, stage: 'draft', role: 'drafter' })
      const recall = recent.items.find((item) => item.sourcePath === 'manuscript/ch-0001.md')
      expect(recall?.reason).toContain('recent:1')
      expect(recall?.sourceHash.startsWith('sha256:')).toBe(true)
      const protectedOnly = await buildContextPack(project, db, {
        chapter: 1,
        stage: 'draft',
        role: 'drafter',
        budgetTokens: 1,
      })
      expect(protectedOnly.items.some((item) => item.protected && item.sourcePath.includes('ch-0001'))).toBe(
        true,
      )
      expect(protectedOnly.items.some((item) => !item.protected)).toBe(false)
    } finally {
      db.close()
    }
  })

  it('truncates long protected text, matches cast by name and handles empty packs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'context-v2-long-'))
    roots.push(root)
    await initProjectV2({
      root,
      title: '长上下文',
      genre: {
        major: 'mystery',
        sub: 'mystery.detective',
        tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
      },
      audience: 'general',
      platform: 'fanqie',
    })
    const project = await loadProjectV2(root)
    const db = openStudioDb(join(root, '.studio', 'studio.db'))
    try {
      await project.store.writeText('bible/premise.md', '长'.repeat(25_000))
      await saveCanon(project.store, {
        ...emptyCanon(),
        entities: {
          characters: [{ name: '林砚', role: '主角' }],
          locations: [],
          factions: [],
          items: [],
          concepts: [],
        },
      })
      insertComment(db.orm, {
        projectId: project.config.id,
        chapter: 1,
        author: 'author',
        body: '没有段号的批注。',
      })
      const pack = await buildContextPack(project, db, {
        chapter: 1,
        stage: 'draft',
        role: 'drafter',
        activeCast: ['林砚'],
        budgetTokens: 32_000,
      })
      const premise = pack.items.find((item) => item.sourcePath === 'bible/premise.md')
      expect(premise?.text.length).toBeLessThan(20_100)
      expect(premise?.text).toContain('…')
      expect(pack.items.some((item) => item.reason.includes('active-cast'))).toBe(true)
      expect(pack.items.some((item) => item.text.includes('— 段'))).toBe(true)
      expect(
        contextPromptSection({
          items: [],
          usedTokens: 0,
          budgetTokens: 10,
          omitted: 0,
          requiredOmitted: 0,
        } as never),
      ).toContain('无可用条目')
    } finally {
      db.close()
    }
  })
})
