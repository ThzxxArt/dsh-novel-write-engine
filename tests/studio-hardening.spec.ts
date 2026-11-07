import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import { openStudioDb } from '../src/storage/db.js'
import { ArtifactStore } from '../src/kernel/artifacts/store.js'
import { StudioDirector } from '../src/studio/director.js'
import { StudioScheduler } from '../src/studio/scheduler.js'
import { FakeAgentBridge } from '../src/studio/fake-bridge.js'
import { assertRoleCanWrite, assertRoleTool } from '../src/agents/role-tools.js'
import { validatePolishPatch } from '../src/kernel/gates/index.js'
import type { Draft, PolishPatch } from '../src/contracts/artifacts.js'
import { recordUsage, getRun, listTasks } from '../src/storage/repositories/runs.js'

const roots: string[] = []
const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-hard-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: '硬化测试',
    genre: {
      major: 'mystery',
      sub: 'mystery.detective',
      tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
    },
    audience: 'general',
    platform: 'fanqie',
    targets: { total_chapters: 3, words_per_chapter: [2200, 3200] },
  })
  const project = await loadProjectV2(root)
  const db = openStudioDb(join(root, '.studio', 'studio.db'))
  const artifacts = new ArtifactStore(project, db)
  const director = new StudioDirector(project, db, artifacts)
  const scheduler = new StudioScheduler({
    project,
    db,
    artifacts,
    director,
    bridge: new FakeAgentBridge(project, artifacts),
  })
  return { root, project, db, artifacts, director, scheduler }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('studio hardening', () => {
  it('T-16: the same task completion produces one artifact', async () => {
    const { project, artifacts, db } = await setup()
    try {
      const provenance = {
        runId: 'r',
        taskId: 'same-task',
        role: 'drafter' as const,
        preset: 'p',
        model: 'm',
      }
      const content = {
        schema_version: 2 as const,
        kind: 'ChapterPlan' as const,
        chapter: 1,
        title: '第1章 风起云涌',
        scene_type: '日常过渡章' as const,
        pov: '第三人称',
        cast: ['甲'],
        goal: 'g',
        conflict: 'c',
        turn: 't',
        outcome: 'o',
        target_words: 2400,
        hook: 'h',
        foreshadows: [],
        notes: [],
        citations: [],
        open_questions: [],
      }
      const one = await artifacts.submit({ kind: 'ChapterPlan', chapter: 1, content, provenance })
      const two = await artifacts.submit({ kind: 'ChapterPlan', chapter: 1, content, provenance })
      expect(two.id).toBe(one.id)
      expect(artifacts.list({ kind: 'ChapterPlan', chapter: 1 })).toHaveLength(1)
      void project
    } finally {
      db.close()
    }
  })

  it('T-18/T-19: role write permissions are structural', () => {
    expect(() => assertRoleCanWrite('drafter', 'ReviewReport')).toThrow(/cannot write/)
    expect(() => assertRoleCanWrite('critic-story', 'Draft')).toThrow(/cannot write/)
    expect(() => assertRoleCanWrite('archivist', 'Draft')).toThrow(/cannot write/)
    expect(() => assertRoleCanWrite('drafter', 'Draft')).not.toThrow()
    expect(() => assertRoleTool('drafter', 'novel_archive_commit')).toThrow(/cannot use/)
    expect(() => assertRoleTool('archivist', 'novel_archive_commit')).not.toThrow()
  })

  it('T-20: a tampered artifact blob is refused', async () => {
    const { project, root, artifacts, db } = await setup()
    try {
      const artifact = await artifacts.submit({
        kind: 'ChapterPlan',
        chapter: 1,
        content: {
          schema_version: 2,
          kind: 'ChapterPlan',
          chapter: 1,
          title: '第1章 风起云涌',
          scene_type: '日常过渡章',
          pov: '第三人称',
          cast: ['甲'],
          goal: 'g',
          conflict: 'c',
          turn: 't',
          outcome: 'o',
          target_words: 2400,
          hook: 'h',
          foreshadows: [],
          notes: [],
          citations: [],
          open_questions: [],
        },
        provenance: { runId: 'r', taskId: 'tamper', role: 'planner', preset: 'p' },
      })
      writeFileSync(
        join(root, artifact.path),
        JSON.stringify({ kind: 'ChapterPlan', content: { changed: true } }),
      )
      await expect(artifacts.read(artifact.id)).rejects.toMatchObject({
        code: 'STUDIO_ARTIFACT_HASH_MISMATCH',
      })
      void project
    } finally {
      db.close()
    }
  })

  it('T-29: a polish patch outside the draft is refused', () => {
    const draft = { content: '第一段正文。\n\n第二段正文。' } as Draft
    const patch = {
      schema_version: 2,
      kind: 'PolishPatch',
      chapter: 1,
      base_hash: 'h',
      expected_hash: 'h',
      patches: [{ anchor: '不存在的句子', before: '不存在的句子', after: 'x', reason: 'bad' }],
      open_questions: [],
    } as PolishPatch
    expect(validatePolishPatch(draft, patch)).not.toHaveLength(0)
  })

  it('T-22: budget overrun pauses before a new assignment', async () => {
    const { db, director, scheduler } = await setup()
    try {
      const runId = director.createChapterRun({ chapter: 1 })
      recordUsage(db.orm, {
        runId,
        taskId: 'seed',
        role: 'drafter',
        model: 'm',
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 999,
      })
      await scheduler.run(runId, {} as Agent, new AbortController().signal)
      expect(getRun(db.orm, runId)?.status).toBe('paused')
      expect(listTasks(db.orm, runId).some((task) => task.status === 'failed')).toBe(false)
    } finally {
      db.close()
    }
  })

  it('T-25: cancel before execution writes no manuscript', async () => {
    const { root, db, director } = await setup()
    try {
      const runId = director.createChapterRun({ chapter: 1 })
      director.cancel(runId)
      expect(getRun(db.orm, runId)?.status).toBe('cancelled')
      expect(existsSync(join(root, 'manuscript', 'ch-0001.md'))).toBe(false)
    } finally {
      db.close()
    }
  })
})
