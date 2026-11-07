import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import { openStudioDb } from '../src/storage/db.js'
import { ArtifactStore } from '../src/kernel/artifacts/store.js'
import type { Draft } from '../src/contracts/artifacts.js'

const roots: string[] = []

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifacts-deep-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: 'Artifact 边界',
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
  return { root, project, db, artifacts: new ArtifactStore(project, db) }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const plan = {
  schema_version: 2 as const,
  kind: 'ChapterPlan' as const,
  chapter: 1,
  title: '第1章 风起云涌',
  scene_type: '日常过渡章' as const,
  pov: '第三人称',
  cast: ['林砚'],
  goal: '查账',
  conflict: '来人不交底',
  turn: '落款被刮',
  outcome: '去城南',
  target_words: 2400,
  hook: '门外三声敲击',
  foreshadows: [],
  notes: [],
  citations: [],
  open_questions: [],
}

const draft = (content = '林砚把契纸合上，灯芯暗了一寸。'): Draft => ({
  schema_version: 2,
  kind: 'Draft',
  chapter: 1,
  title: plan.title,
  scene_type: plan.scene_type,
  narrator: plan.pov,
  content,
  summary: {
    events: ['合上契纸'],
    characters_appeared: ['林砚'],
    foreshadows: { planted: [], advanced: [], resolved: [] },
    new_elements: { locations: [], abilities: [], artifacts: [] },
    resource_changes: [],
    opening: content,
    continuity: { opens_from: '', ends_with: '' },
    hook_strength: 4,
    pleasure_points: [],
    plot_advancement: 'mid',
  },
  self_check: {
    word_count: 16,
    cjk_chars: 15,
    scene_contract: { goal: '查账', conflict: '不交底', turn: '刮去', outcome: '去城南' },
  },
  citations: [],
  open_questions: [],
  base_artifact_id: null,
  expected_hash: null,
})

describe('artifact store deep paths', () => {
  it('rejects schema drift and cross-kind task reuse', async () => {
    const ctx = await setup()
    try {
      await expect(
        ctx.artifacts.submit({
          kind: 'ChapterPlan',
          chapter: 1,
          content: { schema_version: 2, kind: 'ChapterPlan' },
          provenance: { runId: 'r', taskId: 't', role: 'planner', preset: 'p' },
        }),
      ).rejects.toMatchObject({ code: 'STUDIO_ARTIFACT_INVALID' })
      const first = await ctx.artifacts.submit({
        kind: 'ChapterPlan',
        chapter: 1,
        content: plan,
        provenance: { runId: 'r', taskId: 'same-task', role: 'planner', preset: 'p' },
      })
      const again = await ctx.artifacts.submit({
        kind: 'ChapterPlan',
        chapter: 1,
        content: plan,
        provenance: { runId: 'r', taskId: 'same-task', role: 'planner', preset: 'p' },
      })
      expect(again.id).toBe(first.id)
      expect(again.content).toMatchObject({ title: plan.title })
      await expect(
        ctx.artifacts.submit({
          kind: 'Draft',
          chapter: 1,
          content: draft(),
          provenance: { runId: 'r', taskId: 'same-task', role: 'drafter', preset: 'p' },
        }),
      ).rejects.toMatchObject({ code: 'STUDIO_ARTIFACT_CONFLICT' })
    } finally {
      ctx.db.close()
    }
  })

  it('detects missing, malformed and mutated blobs', async () => {
    const ctx = await setup()
    try {
      expect(await ctx.artifacts.read('missing')).toBeNull()
      const stored = await ctx.artifacts.submit({
        kind: 'Draft',
        chapter: 1,
        content: draft(),
        provenance: { runId: 'r', taskId: 't1', role: 'drafter', preset: 'p' },
      })
      const row = ctx.artifacts.list({ kind: 'Draft', chapter: 1 })[0]!
      const path = row.path
      const original = await ctx.project.store.readText(path)
      await ctx.project.store.remove(path)
      await expect(ctx.artifacts.read(stored.id)).rejects.toMatchObject({
        code: 'STUDIO_ARTIFACT_NOT_FOUND',
      })
      await ctx.project.store.writeText(path, '{broken')
      await expect(ctx.artifacts.read(stored.id)).rejects.toMatchObject({
        code: 'STUDIO_ARTIFACT_INVALID',
      })
      await ctx.project.store.writeText(path, original!.replace('林砚', '别人'))
      await expect(ctx.artifacts.read(stored.id)).rejects.toMatchObject({
        code: 'STUDIO_ARTIFACT_HASH_MISMATCH',
      })
    } finally {
      ctx.db.close()
    }
  })

  it('guards human edits and restores only creative artifacts', async () => {
    const ctx = await setup()
    try {
      const first = await ctx.artifacts.saveHumanEdit({
        kind: 'Draft',
        chapter: 1,
        content: draft(),
        baseHash: null,
        actor: '作者',
      })
      await expect(
        ctx.artifacts.saveHumanEdit({
          kind: 'Draft',
          chapter: 1,
          content: draft('另一段正文，林砚没有回头。'),
          baseHash: null,
          actor: '作者',
        }),
      ).rejects.toMatchObject({ code: 'STUDIO_ARTIFACT_CONFLICT' })
      await expect(
        ctx.artifacts.saveHumanEdit({
          kind: 'Draft',
          chapter: 1,
          content: draft('另一段正文，林砚没有回头。'),
          baseHash: 'wrong',
          actor: '作者',
        }),
      ).rejects.toMatchObject({ code: 'STUDIO_ARTIFACT_CONFLICT' })
      const second = await ctx.artifacts.saveHumanEdit({
        kind: 'Draft',
        chapter: 1,
        content: draft('另一段正文，林砚没有回头。'),
        baseHash: first.contentHash,
        actor: '作者',
      })
      expect(second.version).toBeGreaterThan(first.version)
      await expect(
        ctx.artifacts.saveHumanEdit({
          kind: 'Draft',
          chapter: 2,
          content: draft('新章节正文，林砚推门进来。'),
          baseHash: 'declared-but-missing',
          actor: '作者',
        }),
      ).rejects.toMatchObject({ code: 'STUDIO_ARTIFACT_CONFLICT' })
      await expect(ctx.artifacts.restore('missing', '作者', 'x')).rejects.toMatchObject({
        code: 'STUDIO_ARTIFACT_NOT_FOUND',
      })
      const restored = await ctx.artifacts.restore(first.id, '作者', 'rewind')
      expect(restored.version).toBeGreaterThan(second.version)
      const decision = await ctx.artifacts.submit({
        kind: 'Decision',
        chapter: 1,
        content: {
          schema_version: 2,
          kind: 'Decision',
          gate: 'chapter',
          action: 'approve',
          target_artifact_id: first.id,
          target_version: first.version,
          actor: '作者',
          reason: 'ok',
          approval_token: 'hash',
          at: new Date().toISOString(),
        },
        provenance: { runId: 'r', taskId: 'd1', role: 'showrunner', preset: 'human-gate', model: 'human' },
        status: 'approved',
      })
      await expect(ctx.artifacts.restore(decision.id, '作者', 'forge')).rejects.toMatchObject({
        code: 'STUDIO_ARTIFACT_RESTORE_FORBIDDEN',
      })
    } finally {
      ctx.db.close()
    }
  })

  it('diffs non-prose artifacts, identical bytes and missing ids', async () => {
    const ctx = await setup()
    try {
      const bible = {
        schema_version: 2 as const,
        kind: 'BiblePlan' as const,
        premise: '同一个前提',
        themes: ['主题'],
        style: { guide: '短句。', fingerprint: {} },
        world: { rules: [], factions: [], locations: [], glossary: {} },
        characters: [],
        citations: [],
        open_questions: [],
      }
      const first = await ctx.artifacts.submit({
        kind: 'BiblePlan',
        chapter: null,
        content: bible,
        provenance: { runId: 'r', taskId: 'b1', role: 'architect', preset: 'p' },
      })
      const second = await ctx.artifacts.submit({
        kind: 'BiblePlan',
        chapter: null,
        content: bible,
        provenance: { runId: 'r', taskId: 'b2', role: 'architect', preset: 'p' },
      })
      const diff = await ctx.artifacts.diffContent(first.id, second.id)
      expect(diff).toContain('---')
      expect(() => ctx.artifacts.diff('missing', first.id)).toThrow(/both artifacts/u)
      await expect(ctx.artifacts.diffContent('missing', first.id)).rejects.toMatchObject({
        code: 'STUDIO_ARTIFACT_NOT_FOUND',
      })
    } finally {
      ctx.db.close()
    }
  })

  it('approves, supersedes and diffs versions', async () => {
    const ctx = await setup()
    try {
      const first = await ctx.artifacts.saveHumanEdit({
        kind: 'Draft',
        chapter: 1,
        content: draft('第一版正文，林砚把契纸合上。'),
        baseHash: null,
        actor: '作者',
      })
      const second = await ctx.artifacts.saveHumanEdit({
        kind: 'Draft',
        chapter: 1,
        content: draft('第二版正文，林砚把铜锁扣回。'),
        baseHash: first.contentHash,
        actor: '作者',
      })
      await expect(ctx.artifacts.approve('missing')).rejects.toMatchObject({
        code: 'STUDIO_ARTIFACT_NOT_FOUND',
      })
      const approved = await ctx.artifacts.approve(second.id)
      expect(approved.status).toBe('approved')
      expect(
        ctx.artifacts.list({ kind: 'Draft', chapter: 1 }).find((row) => row.id === first.id)?.status,
      ).toBe('superseded')
      const diff = await ctx.artifacts.diffContent(first.id, second.id)
      expect(diff).toContain('---')
      expect(diff).toContain('+++')
      await expect(ctx.artifacts.diffContent('missing', second.id)).rejects.toMatchObject({
        code: 'STUDIO_ARTIFACT_NOT_FOUND',
      })
    } finally {
      ctx.db.close()
    }
  })
})
