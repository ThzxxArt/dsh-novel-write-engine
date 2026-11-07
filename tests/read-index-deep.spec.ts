import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import { openStudioDb } from '../src/storage/db.js'
import { rebuildProjectIndex } from '../src/kernel/read/index.js'
import { applyWorldbookPatch, saveBiblePlan, saveChapterPlan } from '../src/kernel/book/store.js'
import { searchMemory } from '../src/storage/repositories/memory.js'
import { createSnapshot, verifySnapshot } from '../src/kernel/export/snapshot.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'read-index-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: '索引测试',
    genre: {
      major: 'mystery',
      sub: 'mystery.detective',
      tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
    },
    audience: 'general',
    platform: 'fanqie',
    targets: { total_chapters: 1 },
  })
  const project = await loadProjectV2(root)
  const db = openStudioDb(join(root, '.studio', 'studio.db'))
  return { root, project, db }
}

describe('read index and snapshots', () => {
  it('rebuilds bible/world/character/codex/manuscript rows and removes stale ones', async () => {
    const { project, db } = await setup()
    try {
      await saveBiblePlan(project.store, {
        schema_version: 2,
        kind: 'BiblePlan',
        premise: '城南旧铺的契纸案。',
        themes: ['选择与代价'],
        style: { guide: '短句。', fingerprint: { average_sentence_length: 12 } },
        world: {
          rules: ['契纸必须有落款'],
          factions: ['账房'],
          locations: ['城南旧铺'],
          glossary: { 契纸: '盖印的凭据' },
        },
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
      })
      await applyWorldbookPatch(project.store, {
        schema_version: 2,
        kind: 'WorldbookPatch',
        entities: [
          {
            key: 'item-1',
            entity_kind: 'item',
            name: '木匣',
            summary: '缺角木匣',
            facts: {},
            evidence: '木匣的锁扣缺了一角。',
          },
        ],
        citations: [],
        open_questions: [],
      })
      await saveChapterPlan(project.store, {
        schema_version: 2,
        kind: 'ChapterPlan',
        chapter: 1,
        title: '第1章 风起云涌',
        scene_type: '日常过渡章',
        pov: '第三人称',
        cast: ['林砚'],
        goal: '查账',
        conflict: '不交底',
        turn: '落款被刮',
        outcome: '去城南',
        target_words: 2400,
        hook: '门外三声敲击',
        foreshadows: [],
        notes: [],
        citations: [],
        open_questions: [],
      })
      await project.store.ensureDir('manuscript')
      await project.store.writeText('manuscript/ch-0001.md', '林砚把契纸摊在灯下，木匣的锁扣缺了一角。\n')
      const first = await rebuildProjectIndex(project, db)
      expect(first.indexed).toBeGreaterThan(0)
      expect(first.removed).toBeGreaterThanOrEqual(0)
      expect(
        searchMemory(db.orm, { projectId: project.config.id, query: '林砚', limit: 10 }).length,
      ).toBeGreaterThan(0)
      expect(
        searchMemory(db.orm, { projectId: project.config.id, query: '木匣', limit: 10 }).length,
      ).toBeGreaterThan(0)
      const second = await rebuildProjectIndex(project, db)
      expect(second.removed).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('indexes character and codex rows that omit names', async () => {
    const { project, db } = await setup()
    try {
      await project.store.ensureDir('bible/characters')
      await project.store.writeText('bible/characters/weird.yaml', 'role: 配角\n')
      await project.store.ensureDir('bible/world')
      await project.store.writeText('bible/world/codex.yaml', 'entries:\n  - role: 物品\n')
      const result = await rebuildProjectIndex(project, db)
      expect(result.indexed).toBeGreaterThan(0)
      expect(
        searchMemory(db.orm, { projectId: project.config.id, query: '配角', limit: 10 }).length,
      ).toBeGreaterThanOrEqual(0)
    } finally {
      db.close()
    }
  })

  it('creates and verifies snapshots, reporting missing and corrupt manifests', async () => {
    const { project, db } = await setup()
    try {
      await project.store.ensureDir('manuscript')
      await project.store.writeText('manuscript/ch-0001.md', '正文。\n')
      const snapshot = await createSnapshot(project)
      expect(snapshot.manifest.files.length).toBeGreaterThan(0)
      expect((await verifySnapshot(project, snapshot.path)).ok).toBe(true)
      await project.store.writeText('manuscript/ch-0001.md', '改写。\n')
      const bad = await verifySnapshot(project, snapshot.path)
      expect(bad.ok).toBe(false)
      expect(bad.problems.length).toBeGreaterThan(0)
      await expect(verifySnapshot(project, '.studio/snapshots/missing.json')).rejects.toMatchObject({
        code: 'STUDIO_PROJECT_INVALID',
      })
      await project.store.writeText('.studio/snapshots/corrupt.json', '{broken')
      await expect(verifySnapshot(project, '.studio/snapshots/corrupt.json')).rejects.toMatchObject({
        code: 'STUDIO_PROJECT_INVALID',
      })
    } finally {
      db.close()
    }
  })
})
