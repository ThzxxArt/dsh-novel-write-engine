import { describe, expect, it } from 'vitest'
import { openMemoryDb } from '../src/storage/db.js'
import {
  appendEvent,
  claimTask,
  createRun,
  createTasks,
  getProjectByRoot,
  getTask,
  listEvents,
  upsertProject,
} from '../src/storage/repositories/runs.js'
import {
  insertArtifact,
  latestArtifact,
  setArtifactStatus,
  supersedeOlder,
} from '../src/storage/repositories/artifacts.js'
import { searchMemory, upsertMemoryChunk } from '../src/storage/repositories/memory.js'
import { LATEST_SCHEMA_VERSION } from '../src/storage/migrations.js'

describe('sqlite storage v2', () => {
  it('creates the schema and enforces project/root uniqueness', () => {
    const db = openMemoryDb()
    try {
      expect(db.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
      expect(db.schemaVersion).toBeGreaterThanOrEqual(1)
      expect(db.integrity()).toBe('ok')
      const id = upsertProject(db.orm, { root: '/tmp/a', title: 'A' })
      const same = upsertProject(db.orm, { root: '/tmp/a', title: 'A2' })
      expect(same).toBe(id)
      expect(getProjectByRoot(db.orm, '/tmp/a')?.title).toBe('A2')
      expect(getProjectByRoot(db.orm, '/tmp/missing')).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('creates runs/tasks and refuses a second claim for a ready task', () => {
    const db = openMemoryDb()
    try {
      const projectId = upsertProject(db.orm, { root: '/tmp/b', title: 'B' })
      const runId = createRun(db.orm, { projectId, kind: 'chapter', targetChapter: 1, input: {} })
      const ids = createTasks(db.orm, [
        { runId, role: 'planner', kind: 'plan', dependsOn: [], input: {} },
        { runId, role: 'drafter', kind: 'draft', dependsOn: [], input: {}, priority: 1 },
      ])
      const first = claimTask(db.orm, { runId, owner: 'a' })
      expect(first?.id).toBe(ids[1])
      const second = claimTask(db.orm, { runId, owner: 'b' })
      expect(second?.id).toBe(ids[0])
      expect(claimTask(db.orm, { runId, owner: 'c' })).toBeUndefined()
      expect(getTask(db.orm, ids[0]!)?.attempt).toBe(1)
    } finally {
      db.close()
    }
  })

  it('versions artifacts immutably and supersedes older versions', () => {
    const db = openMemoryDb()
    try {
      const projectId = upsertProject(db.orm, { root: '/tmp/c', title: 'C' })
      const provenance = {
        runId: 'r',
        taskId: 't',
        role: 'drafter' as const,
        preset: 'p',
        agentSessionId: 's',
        model: 'm',
        promptHash: 'h',
        createdAt: new Date().toISOString(),
      }
      const one = insertArtifact(db.orm, {
        projectId,
        kind: 'Draft',
        chapter: 1,
        path: 'a.json',
        contentHash: 'h1',
        schemaVersion: 2,
        provenance,
      })
      const two = insertArtifact(db.orm, {
        projectId,
        kind: 'Draft',
        chapter: 1,
        path: 'b.json',
        contentHash: 'h2',
        schemaVersion: 2,
        provenance,
      })
      expect(one.version).toBe(1)
      expect(two.version).toBe(2)
      setArtifactStatus(db.orm, two.id, 'approved')
      expect(supersedeOlder(db.orm, two.id)).toBe(1)
      expect(latestArtifact(db.orm, projectId, 'Draft', 1)?.contentHash).toBe('h2')
    } finally {
      db.close()
    }
  })

  it('searches FTS5 deterministically and appends ordered events', () => {
    const db = openMemoryDb()
    try {
      const projectId = upsertProject(db.orm, { root: '/tmp/d', title: 'D' })
      upsertMemoryChunk(db.orm, {
        projectId,
        kind: 'canon',
        sourcePath: 'state/canon.yaml',
        sourceHash: 'h',
        text: '林砚的刀在城南当铺',
        meta: { entities: ['林砚'] },
      })
      const hits = searchMemory(db.orm, { projectId, query: '林砚', activeCast: ['林砚'] })
      expect(hits).toHaveLength(1)
      expect(hits[0]!.reasons).toContain('active-cast')
      const seq1 = appendEvent(db.orm, { projectId, type: 'run.start', payload: { a: 1 } })
      const seq2 = appendEvent(db.orm, { projectId, type: 'run.done', payload: {} })
      expect(seq1).toBeGreaterThan(0)
      expect(seq2).toBeGreaterThan(seq1)
      expect(listEvents(db.orm, projectId, seq1).map((row) => row.type)).toEqual(['run.done'])
    } finally {
      db.close()
    }
  })
})
