import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import { openStudioDb } from '../src/storage/db.js'
import { ArtifactStore } from '../src/kernel/artifacts/store.js'
import { StudioDirector } from '../src/studio/director.js'
import { StudioScheduler } from '../src/studio/scheduler.js'
import { FakeAgentBridge } from '../src/studio/fake-bridge.js'
import { StudioRuntime } from '../src/studio/runtime.js'
import {
  assertRoleCanWrite,
  assertRoleTool,
  createRoleToolDefinitions,
  roleDefinition,
} from '../src/agents/role-tools.js'
import type { RoleId } from '../src/contracts/artifacts.js'
import {
  claimTaskById,
  createAssignment,
  createRun,
  createTasks,
  listAssignments,
  listTasks,
  markTaskRunning,
} from '../src/storage/repositories/runs.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'role-tools-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: '角色工具',
    genre: {
      major: 'fantasy',
      sub: 'fantasy.xianxia',
      tags: ['world.eastern_cultivation', 'plot.progression', 'tone.hot_blooded'],
    },
    audience: 'male',
    platform: 'qidian',
    targets: { total_chapters: 2 },
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
  const runtime = new StudioRuntime({ projectRoot: root })
  await runtime.open()
  const runId = director.createChapterRun({ chapter: 1 })
  await scheduler.run(runId, {} as Agent, new AbortController().signal)
  const tasks = listTasks(db.orm, runId)
  const assignments = listAssignments(
    db.orm,
    tasks.map((task) => task.id),
  )
  return { root, project, db, artifacts, director, scheduler, runtime, runId, tasks, assignments }
}

const execute = async (
  runtime: StudioRuntime,
  role: Parameters<typeof createRoleToolDefinitions>[1],
  name: string,
  args: Record<string, unknown>,
  agentSessionId: string,
): Promise<unknown> => {
  const tool = createRoleToolDefinitions(runtime, role).find((definition) => definition.name === name)
  if (tool === undefined) throw new Error(`missing tool ${name}`)
  return (tool as { execute: (args: unknown, exec: unknown) => Promise<unknown> }).execute(args, {
    agent: { id: agentSessionId } as Agent,
    signal: new AbortController().signal,
  })
}

describe('role scoped tools', () => {
  it('reads the assignment and canon, and reuses the task artifact on submit', async () => {
    const { db, project, artifacts, runtime, tasks, assignments } = await setup()
    try {
      const draftTask = tasks.find((task) => task.kind === 'draft')!
      const draftAssignment = assignments.find((row) => row.taskId === draftTask.id)!
      const read = (await execute(
        runtime,
        'drafter',
        'novel_task_read',
        {},
        draftAssignment.agentSessionId!,
      )) as {
        assignment: { id: string }
        task: { kind: string }
        input: Record<string, unknown>
      }
      expect(read.task.kind).toBe('draft')
      expect(read.input.chapter).toBe(1)
      const originalRow = artifacts
        .list({ kind: 'Draft', chapter: 1, limit: 10 })
        .find((row) => row.taskId === draftTask.id)!
      const original = (await artifacts.read(originalRow.id))!
      const submitted = (await execute(
        runtime,
        'drafter',
        'novel_draft_submit',
        { content: original.content },
        draftAssignment.agentSessionId!,
      )) as { ok: boolean; artifactId: string }
      expect(submitted.ok).toBe(true)
      expect(submitted.artifactId).toBe(original.id)
      const stored = await artifacts.read(submitted.artifactId)
      expect(stored?.kind).toBe('Draft')

      // A second output for the same task is not idempotent: it must be
      // rejected instead of silently returning the first artifact.
      const latest = await artifacts.latest('Draft', 1)
      if (latest !== null && latest.id !== original.id) {
        await expect(
          execute(
            runtime,
            'drafter',
            'novel_draft_submit',
            {
              content: {
                ...(latest.content as Record<string, unknown>),
                content: `${String((latest.content as { content: string }).content)}追加一句。`,
                base_artifact_id: latest.id,
                expected_hash: latest.contentHash,
              },
            },
            draftAssignment.agentSessionId!,
          ),
        ).rejects.toThrow(/different Draft/u)
      }

      const continuityTask = tasks.find((task) => task.kind === 'continuity.precheck')!
      const continuityAssignment = assignments.find((row) => row.taskId === continuityTask.id)!
      const canon = (await execute(
        runtime,
        'continuity',
        'novel_canon_query',
        {},
        continuityAssignment.agentSessionId!,
      )) as { entities: { characters: unknown[] } }
      expect(Array.isArray(canon.entities.characters)).toBe(true)
      expect(project.config.title).toBe('角色工具')
    } finally {
      runtime.close()
      db.close()
    }
  })

  it('rejects missing assignments and tools outside the role allowlist', async () => {
    const { db, runtime, tasks, assignments } = await setup()
    try {
      const draftTask = tasks.find((task) => task.kind === 'draft')!
      const draftAssignment = assignments.find((row) => row.taskId === draftTask.id)!
      await expect(execute(runtime, 'drafter', 'novel_task_read', {}, 'missing-agent')).rejects.toThrow(
        /no project|no assignment|cannot resolve/u,
      )
      const archivist = createRoleToolDefinitions(runtime, 'archivist')
      expect(archivist.map((tool) => tool.name)).toContain('novel_archive_commit')
      const draftTools = createRoleToolDefinitions(runtime, 'drafter').map((tool) => tool.name)
      expect(draftTools).not.toContain('novel_archive_commit')
      expect(draftAssignment.agentSessionId?.startsWith('fake-')).toBe(true)
    } finally {
      runtime.close()
      db.close()
    }
  })

  it('rejects stale hashes for first-time draft/review/continuity/polish submits', async () => {
    const { db, project, artifacts, runtime } = await setup()
    try {
      // Fresh tasks have no artifact yet, so the base-hash check is the only
      // thing standing between a stale model output and the kernel.
      const taskFor = (role: string, kind: string, agent: string): string => {
        const runId = createRun(db.orm, {
          projectId: project.config.id,
          kind: 'chapter',
          targetChapter: 1,
          input: { chapter: 1 },
        })
        const taskId = createTasks(db.orm, [
          { runId, role: role as RoleId, kind, dependsOn: [], input: { chapter: 1 } },
        ])[0]!
        claimTaskById(db.orm, { id: taskId, owner: 'test' })
        markTaskRunning(db.orm, taskId)
        createAssignment(db.orm, {
          taskId,
          provider: 'fake',
          preset: `novel-role-${role}`,
          agentSessionId: agent,
        })
        return agent
      }

      const draft = (await artifacts.latest('Draft', 1))!
      const draftAgent = taskFor('drafter', 'draft', 'stale-drafter')
      await expect(
        execute(
          runtime,
          'drafter',
          'novel_draft_submit',
          { content: { ...(draft.content as object), expected_hash: 'stale' } },
          draftAgent,
        ),
      ).rejects.toThrow(/bind the current draft|base_artifact_id|expected_hash/u)

      const reviewRow = artifacts.list({ kind: 'ReviewReport', chapter: 1, limit: 1 })[0]!
      const review = (await artifacts.read(reviewRow.id))!
      const storyAgent = taskFor('critic-story', 'review.story', 'stale-story')
      await expect(
        execute(
          runtime,
          'critic-story',
          'novel_review_submit',
          { content: { ...(review.content as object), base_hash: 'stale' } },
          storyAgent,
        ),
      ).rejects.toThrow(/base_hash/u)

      const continuityRow = artifacts.list({ kind: 'ContinuityReport', chapter: 1, limit: 1 })[0]!
      const continuity = (await artifacts.read(continuityRow.id))!
      const continuityAgent = taskFor('continuity', 'continuity.precheck', 'stale-continuity')
      await expect(
        execute(
          runtime,
          'continuity',
          'novel_continuity_submit',
          { content: { ...(continuity.content as object), base_hash: 'stale' } },
          continuityAgent,
        ),
      ).rejects.toThrow(/base_hash/u)

      const polishRow = artifacts.list({ kind: 'PolishPatch', chapter: 1, limit: 1 })[0]!
      const polish = (await artifacts.read(polishRow.id))!
      const polishAgent = taskFor('polisher', 'polish', 'stale-polisher')
      await expect(
        execute(
          runtime,
          'polisher',
          'novel_polish_submit',
          { content: { ...(polish.content as object), expected_hash: 'stale' } },
          polishAgent,
        ),
      ).rejects.toThrow(/base_hash|expected_hash/u)
    } finally {
      runtime.close()
      db.close()
    }
  })

  it('enforces structural role boundaries and missing-agent errors', async () => {
    const { db, runtime } = await setup()
    try {
      expect(() => assertRoleCanWrite('nope' as RoleId, 'Draft')).toThrow(/unknown role/u)
      expect(() => assertRoleCanWrite('critic-story', 'Draft')).toThrow(/cannot write/u)
      expect(() => assertRoleTool('drafter', 'novel_archive_commit')).toThrow(/cannot use/u)
      expect(roleDefinition('drafter').id).toBe('drafter')
      const tool = (role: RoleId, name: string) => {
        const found = createRoleToolDefinitions(runtime, role).find((entry) => entry.name === name)
        if (found === undefined) throw new Error(`missing ${name}`)
        return found as unknown as {
          execute: (args: unknown, exec: unknown) => Promise<unknown>
        }
      }
      await expect(tool('drafter', 'novel_task_read').execute({}, { agent: undefined })).rejects.toThrow(
        /without an agent/u,
      )
      await expect(
        tool('critic-story', 'novel_review_submit').execute(
          { content: { schema_version: 2 } },
          { agent: undefined },
        ),
      ).rejects.toThrow(/without an agent/u)
      await expect(
        tool('continuity', 'novel_canon_query').execute({}, { agent: { id: 'missing-agent' } }),
      ).rejects.toThrow(/cannot resolve project/u)
      await expect(
        tool('showrunner', 'novel_agent_message').execute(
          { target_id: 'x', message: 'y' },
          { agent: undefined },
        ),
      ).rejects.toThrow(/no sender agent/u)
      await expect(
        tool('archivist', 'novel_archive_commit').execute({}, { agent: { id: 'missing-agent' } }),
      ).rejects.toThrow(/cannot resolve project/u)
    } finally {
      runtime.close()
      db.close()
    }
  })

  it('covers schema rejection, wrong archive state, render and direct messages', async () => {
    const { db, project, runtime, tasks, assignments } = await setup()
    const messageRuntime = new StudioRuntime({
      projectRoot: project.root,
      context: { subagents: { sendMessage: async () => undefined } as never },
    })
    try {
      const draftTask = tasks.find((task) => task.kind === 'draft')!
      const draftAssignment = assignments.find((row) => row.taskId === draftTask.id)!
      await expect(
        execute(runtime, 'drafter', 'novel_draft_submit', { content: {} }, draftAssignment.agentSessionId!),
      ).rejects.toThrow(/schema failed/u)
      const definition = createRoleToolDefinitions(runtime, 'drafter').find(
        (tool) => tool.name === 'novel_draft_submit',
      ) as unknown as {
        output: { render: (args: unknown, raw: unknown) => unknown }
      }
      expect(definition.output.render({}, 'text')).toEqual([{ type: 'text', text: 'text' }])
      expect(definition.output.render({}, { ok: true })).toEqual([
        { type: 'text', text: JSON.stringify({ ok: true }, null, 2) },
      ])

      const runId = createRun(db.orm, {
        projectId: project.config.id,
        kind: 'chapter',
        targetChapter: 2,
        input: {},
      })
      const taskId = createTasks(db.orm, [
        { runId, role: 'archivist', kind: 'draft', dependsOn: [], input: { chapter: 2 } },
      ])[0]!
      claimTaskById(db.orm, { id: taskId, owner: 'test' })
      markTaskRunning(db.orm, taskId)
      createAssignment(db.orm, {
        taskId,
        provider: 'fake',
        preset: 'novel-role-archivist',
        agentSessionId: 'archivist-wrong-state',
      })
      await expect(
        execute(runtime, 'archivist', 'novel_archive_commit', {}, 'archivist-wrong-state'),
      ).rejects.toThrow(/only legal while the archive task is running/u)

      const messageTool = createRoleToolDefinitions(messageRuntime, 'showrunner').find(
        (tool) => tool.name === 'novel_agent_message',
      )!
      const sent = (await (
        messageTool as unknown as {
          execute: (args: unknown, exec: unknown) => Promise<unknown>
        }
      ).execute({ target_id: 'child', message: 'hello' }, { agent: {} as Agent })) as {
        ok: boolean
      }
      expect(sent.ok).toBe(true)
    } finally {
      messageRuntime.close()
      runtime.close()
      db.close()
    }
  })

  it('only lets the archivist commit an archive-kind task', async () => {
    const { db, project, runtime } = await setup()
    try {
      const runId = createRun(db.orm, {
        projectId: project.config.id,
        kind: 'chapter',
        targetChapter: 1,
        input: {},
      })
      const taskId = createTasks(db.orm, [
        {
          runId,
          role: 'archivist',
          kind: 'archive',
          dependsOn: [],
          input: { chapter: 1 },
        },
      ])[0]!
      claimTaskById(db.orm, { id: taskId, owner: 'test' })
      markTaskRunning(db.orm, taskId)
      createAssignment(db.orm, {
        taskId,
        provider: 'fake',
        preset: 'novel-role-archivist',
        agentSessionId: 'archive-agent',
      })
      const result = (await execute(runtime, 'archivist', 'novel_archive_commit', {}, 'archive-agent')) as {
        ok: boolean
      }
      expect(result.ok).toBe(true)
      expect(listTasks(db.orm, runId)[0]!.status).toBe('failed')
    } finally {
      runtime.close()
      db.close()
    }
  })
})
