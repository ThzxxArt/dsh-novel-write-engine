import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import { openStudioDb } from '../src/storage/db.js'
import { ArtifactStore } from '../src/kernel/artifacts/store.js'
import { StudioDirector } from '../src/studio/director.js'
import { createRun, createTasks } from '../src/storage/repositories/runs.js'
import { upsertMemoryChunk, searchMemory } from '../src/storage/repositories/memory.js'
import { saveChapterPlan } from '../src/kernel/book/store.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('0.3.0 performance budget', () => {
  it('status/search/board stay within the 100-chapter budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'perf-v2-'))
    roots.push(root)
    await initProjectV2({
      root,
      title: '性能',
      genre: {
        major: 'fantasy',
        sub: 'fantasy.xianxia',
        tags: ['world.eastern_cultivation', 'plot.progression', 'tone.hot_blooded'],
      },
      audience: 'male',
      platform: 'qidian',
      targets: { total_chapters: 120 },
    })
    const project = await loadProjectV2(root)
    const db = openStudioDb(join(root, '.studio', 'studio.db'))
    try {
      for (let chapter = 1; chapter <= 100; chapter += 1) {
        await saveChapterPlan(project.store, {
          schema_version: 2,
          kind: 'ChapterPlan',
          chapter,
          title: `第${chapter}章 风起云涌`,
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
        await project.store.writeText(
          `manuscript/ch-${String(chapter).padStart(4, '0')}.md`,
          `第 ${chapter} 章正文。`.repeat(300),
        )
        upsertMemoryChunk(db.orm, {
          projectId: project.config.id,
          kind: 'chapter',
          chapter,
          sourcePath: `manuscript/ch-${String(chapter).padStart(4, '0')}.md`,
          sourceHash: `sha256:chapter${chapter}`,
          text: `第 ${chapter} 章 林砚在城南查账。`,
          meta: { entities: ['林砚'] },
        })
      }
      const director = new StudioDirector(project, db, new ArtifactStore(project, db))
      const statusStart = performance.now()
      await director.status(100)
      const statusMs = performance.now() - statusStart

      const searchStart = performance.now()
      const hits = searchMemory(db.orm, {
        projectId: project.config.id,
        query: '林砚',
        activeCast: ['林砚'],
        limit: 20,
      })
      const searchMs = performance.now() - searchStart
      expect(hits.length).toBeGreaterThan(0)

      const runId = createRun(db.orm, {
        projectId: project.config.id,
        kind: 'chapter',
        targetChapter: 1,
        input: {},
      })
      createTasks(
        db.orm,
        Array.from({ length: 1000 }, (_, index) => ({
          runId,
          role: 'critic-story' as const,
          kind: `perf.${index}`,
          dependsOn: [],
          input: {},
        })),
      )
      const boardStart = performance.now()
      director.board()
      const boardMs = performance.now() - boardStart

      console.log(
        `performance: status=${statusMs.toFixed(1)}ms search=${searchMs.toFixed(1)}ms board=${boardMs.toFixed(1)}ms`,
      )
      expect(statusMs).toBeLessThan(200)
      expect(searchMs).toBeLessThan(300)
      expect(boardMs).toBeLessThan(150)

      // Negative: a different project must not see these memory rows.
      const { upsertProject } = await import('../src/storage/repositories/runs.js')
      const other = upsertProject(db.orm, { root: '/tmp/perf-other', title: 'Other' })
      expect(
        searchMemory(db.orm, { projectId: other, query: '林砚', activeCast: ['林砚'], limit: 20 }),
      ).toEqual([])
      expect(statusMs).not.toBe(0)
    } finally {
      db.close()
    }
  })
})
