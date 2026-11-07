import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import { openStudioDb } from '../src/storage/db.js'
import { ArtifactStore } from '../src/kernel/artifacts/store.js'
import { StudioDirector } from '../src/studio/director.js'
import { StudioScheduler } from '../src/studio/scheduler.js'
import { FakeAgentBridge } from '../src/studio/fake-bridge.js'
import { exportProject } from '../src/kernel/export/index.js'
import { publishPackage } from '../src/kernel/export/publish.js'

const roots: string[] = []
const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'export-v2-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: '导出测试',
    author: '作者',
    genre: {
      major: 'mystery',
      sub: 'mystery.detective',
      tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
    },
    audience: 'general',
    platform: 'fanqie',
    targets: { total_chapters: 2, words_per_chapter: [2200, 3200] },
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

describe('kernel export v2', () => {
  it('blocks export until a chapter is approved, then renders every format', async () => {
    const { root, project, db, artifacts, director, scheduler } = await setup()
    try {
      const runId = director.createChapterRun({ chapter: 1 })
      const signal = new AbortController().signal
      await scheduler.run(runId, {} as Agent, signal)
      await expect(exportProject(project, db, artifacts, 'markdown')).rejects.toMatchObject({
        code: 'STUDIO_EXPORT_BLOCKED',
      })
      const gate = director.gates.pending(project.config.id)[0]!
      const token = director.gates.authorize(gate.id)
      await director.decide({ gateId: gate.id, token, decision: 'approve', actor: '作者', reason: '通过' })
      await scheduler.run(runId, {} as Agent, signal)
      const markdown = await exportProject(project, db, artifacts, 'markdown')
      expect(markdown.chapters).toEqual([1])
      expect(readFileSync(join(root, markdown.path), 'utf8')).toContain('导出测试')
      const txt = await exportProject(project, db, artifacts, 'txt')
      expect(readFileSync(join(root, txt.path), 'utf8')).toContain('第1章')
      const epub = await exportProject(project, db, artifacts, 'epub')
      expect(readFileSync(join(root, epub.path)).subarray(0, 2).toString()).toBe('PK')
      const outline = await exportProject(project, db, artifacts, 'outline')
      expect(readFileSync(join(root, outline.path), 'utf8')).toContain('chapters')
      const worldbook = await exportProject(project, db, artifacts, 'worldbook')
      expect(readFileSync(join(root, worldbook.path), 'utf8')).toContain('premise')
      const proposal = await exportProject(project, db, artifacts, 'proposal')
      expect(readFileSync(join(root, proposal.path), 'utf8')).toContain('提案')
      writeFileSync(join(root, 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
      const published = await publishPackage(project, db, artifacts, {
        authorNote: '感谢阅读',
        blurb: '简介',
        coverPath: 'cover.jpg',
        titleRule: '第{n}章 标题',
      })
      expect(published.manifest.some((entry) => entry.path.endsWith('cover.jpg'))).toBe(true)
      expect(readFileSync(join(root, published.path, 'metadata.yaml'), 'utf8')).toContain('第{n}章 标题')
      expect(published.chapters).toEqual([1])
      expect(published.manifest.some((entry) => entry.path.endsWith('book.epub'))).toBe(true)
      expect(readFileSync(join(root, published.path, 'metadata.yaml'), 'utf8')).toContain('感谢阅读')
      const drafts = artifacts.list({ kind: 'Draft', chapter: 1, limit: 10 })
      const restored = await artifacts.restore(drafts[drafts.length - 1]!.id, 'tester', '回滚')
      expect(restored.version).toBeGreaterThan(drafts[drafts.length - 1]!.version)
    } finally {
      db.close()
    }
  })
})
