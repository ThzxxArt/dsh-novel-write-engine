import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openStudioDb } from '../src/storage/db.js'
import { LATEST_SCHEMA_VERSION } from '../src/storage/migrations.js'
import { dshHome, globalDbPath, openGlobalRegistry } from '../src/storage/global.js'
import {
  insertComment,
  latestApproved,
  listArtifacts,
  listComments,
  nextArtifactVersion,
  supersedeOlder,
} from '../src/storage/repositories/artifacts.js'
import {
  importMemoryChunks,
  listMemory,
  memoryCount,
  searchMemory,
  upsertMemoryChunk,
} from '../src/storage/repositories/memory.js'
import {
  appendEvent,
  claimTaskById,
  createAssignment,
  createRun,
  createTasks,
  heartbeatTask,
  maxEventSeq,
  retryTask,
  settleTask,
  updateAssignment,
  updateRun,
  usageForRun,
  upsertProject,
} from '../src/storage/repositories/runs.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

const temp = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('storage defensive branches', () => {
  it('opens readonly databases, reports empty schema versions and survives double close', () => {
    const root = temp('storage-db-')
    const path = join(root, 'studio.db')
    const db = openStudioDb(path)
    expect(db.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    db.close()
    db.close()
    const readonly = openStudioDb(path, { readonly: true, busyTimeoutMs: 100 })
    expect(readonly.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    readonly.close()
    const writable = openStudioDb(path)
    writable.raw.prepare('DELETE FROM schema_migration').run()
    expect(writable.schemaVersion).toBe(-1)
    writable.close()
    const asDirectory = join(root, 'not-a-db')
    mkdirSync(asDirectory)
    expect(() => openStudioDb(asDirectory)).toThrow(/cannot open studio database/u)
  })

  it('resolves DSH_HOME/stateDir variants and rejects an unopenable registry', () => {
    delete process.env.DSH_HOME
    expect(dshHome()).toContain('.dsh')
    process.env.DSH_HOME = '   '
    expect(dshHome()).toContain('.dsh')
    process.env.DSH_HOME = '/tmp/novel-dsh-home'
    expect(dshHome()).toBe('/tmp/novel-dsh-home')
    expect(globalDbPath()).toContain('novel-write-engine')
    expect(globalDbPath('')).toContain('novel-write-engine')
    expect(globalDbPath('/tmp/novel-state')).toBe('/tmp/novel-state/studio.db')
    const root = temp('global-bad-')
    const state = join(root, 'state')
    mkdirSync(state)
    mkdirSync(join(state, 'studio.db'))
    expect(() => openGlobalRegistry(state)).toThrow(/cannot open global registry/u)
    const registry = openGlobalRegistry(join(root, 'good-state'))
    registry.close()
    registry.close()
  })

  it('covers artifact default slots, missing supersede target and optional comments', () => {
    const db = openStudioDb(':memory:')
    try {
      const projectId = upsertProject(db.orm, { root: '/tmp/branch-artifacts', title: 'A' })
      expect(nextArtifactVersion(db.orm, projectId, 'Draft', null)).toBe(1)
      expect(listArtifacts(db.orm, projectId, { chapter: null })).toEqual([])
      expect(latestApproved(db.orm, projectId, 'BiblePlan', null)).toBeUndefined()
      expect(supersedeOlder(db.orm, 'missing-id')).toBe(0)
      const id = insertComment(db.orm, {
        projectId,
        author: 'author',
        body: '无章节批注',
      })
      expect(id).toBeTruthy()
      expect(listComments(db.orm, projectId)).toHaveLength(1)
      expect(listComments(db.orm, projectId, 1)).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('covers memory defaults, empty counts, scope rejection and legacy import', () => {
    const db = openStudioDb(':memory:')
    try {
      const projectId = upsertProject(db.orm, { root: '/tmp/branch-memory', title: 'M' })
      expect(memoryCount(db.orm, projectId)).toBe(0)
      expect(searchMemory(db.orm, { projectId, query: '' })).toEqual([])
      const id = upsertMemoryChunk(db.orm, {
        projectId,
        kind: 'chapter',
        sourcePath: 'manuscript/ch-0001.md',
        sourceHash: 'sha256:a',
        text: '林砚在城南查账。',
      })
      expect(
        upsertMemoryChunk(db.orm, {
          projectId,
          kind: 'chapter',
          sourcePath: 'manuscript/ch-0001.md',
          sourceHash: 'sha256:a',
          text: '林砚在城南查账。',
        }),
      ).toBe(id)
      expect(memoryCount(db.orm, projectId)).toBe(1)
      expect(searchMemory(db.orm, { projectId, query: '林砚', scope: ['canon'] })).toEqual([])
      expect(listMemory(db.orm, projectId)).toHaveLength(1)
      expect(listMemory(db.orm, projectId, 'chapter')).toHaveLength(1)
      expect(
        importMemoryChunks(db.orm, projectId, [{ sourcePath: 'manuscript/ch-0002.md', text: '第二段。' }]),
      ).toBe(1)
    } finally {
      db.close()
    }
  })

  it('covers run patches, missing claims, retry exhaustion and empty usage', () => {
    const db = openStudioDb(':memory:')
    try {
      const projectId = upsertProject(db.orm, { root: '/tmp/branch-runs', title: 'R' })
      const runId = createRun(db.orm, { projectId, kind: 'chapter', targetChapter: 1, input: {} })
      updateRun(db.orm, runId, {})
      expect(claimTaskById(db.orm, { id: 'missing', owner: 'o' })).toBeUndefined()
      expect(retryTask(db.orm, 'missing')).toBeUndefined()
      expect(usageForRun(db.orm, 'missing')).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
      })
      expect(maxEventSeq(db.orm, projectId)).toBe(0)
      appendEvent(db.orm, { projectId, type: 'test.default-payload' })
      expect(maxEventSeq(db.orm, projectId)).toBe(1)

      const taskId = createTasks(db.orm, [
        { runId, role: 'drafter', kind: 'draft', dependsOn: [], input: {} },
      ])[0]!
      expect(heartbeatTask(db.orm, taskId, 'wrong-owner')).toBe(false)
      settleTask(db.orm, taskId, 'failed')
      retryTask(db.orm, taskId)
      db.raw.prepare('UPDATE task SET attempt = max_attempts WHERE id = ?').run(taskId)
      retryTask(db.orm, taskId)
      expect(db.raw.prepare('SELECT status FROM task WHERE id = ?').get(taskId)).toMatchObject({
        status: 'failed',
      })

      const assignmentId = createAssignment(db.orm, {
        taskId,
        provider: 'fake',
        preset: 'novel-role-drafter',
      })
      updateAssignment(db.orm, assignmentId, {})
    } finally {
      db.close()
    }
  })
})
