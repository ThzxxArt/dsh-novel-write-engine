import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createCommands } from '../src/commands/index.js'
import type { EngineService } from '../src/engine/service.js'
import { StudioRuntime } from '../src/studio/runtime.js'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import { openStudioDb } from '../src/storage/db.js'
import { ArtifactStore } from '../src/kernel/artifacts/store.js'
import { FakeAgentBridge } from '../src/studio/fake-bridge.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const invocation = (rawInput: string, agent?: { id: string }) => ({
  rawInput,
  signal: new AbortController().signal,
  ...(agent === undefined ? {} : { agent }),
})

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'commands-studio-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: '命令工作台',
    genre: {
      major: 'urban',
      sub: 'urban.daily',
      tags: ['world.modern_city', 'plot.farming', 'tone.light'],
    },
    audience: 'general',
    platform: 'fanqie',
    targets: { total_chapters: 3 },
  })
  const project = await loadProjectV2(root)
  const db = openStudioDb(join(root, '.studio', 'studio.db'))
  const artifacts = new ArtifactStore(project, db)
  const runtime = new StudioRuntime({
    projectRoot: root,
    bridge: new FakeAgentBridge(project, artifacts),
  })
  const command = createCommands({} as EngineService, { studio: runtime }).find(
    (entry) => entry.name === 'novel',
  )!
  return { root, db, runtime, command }
}

describe('studio /novel commands', () => {
  it('drives board, run, review, cost, artifact, export, repair, doctor and gates', async () => {
    const { db, runtime, command } = await setup()
    try {
      expect((await command.handler(invocation('board'))).text).toContain('Run 0')
      expect((await command.handler(invocation('run chapter 1'))).text).toContain('已创建')
      const handle = await runtime.open()
      const runId = handle.director.board().runs[0]!.id
      await handle.scheduler.run(runId, {} as Agent, new AbortController().signal)

      const board = await command.handler(invocation('board'))
      expect(board.text).toContain(runId)
      expect(board.text).toContain('gate')
      const agent = await command.handler(invocation('agent'))
      expect(agent.text).toContain('drafter')
      expect(agent.text).toContain('novel-role-drafter')
      expect((await command.handler(invocation('agent drafter hello'))).kind).toBe('error')
      const cost = await command.handler(invocation(`cost ${runId}`))
      expect(cost.text).toContain(runId)
      const artifacts = await command.handler(invocation('artifact'))
      expect(artifacts.text).toContain('Draft')
      const doctor = await command.handler(invocation('doctor'))
      expect(doctor.text).toContain('0.3.0 体检')

      const approve = await command.handler(invocation('approve'))
      expect(approve.kind).toBe('success')
      expect(approve.text).toContain('已批准')
      await handle.scheduler.run(runId, {} as Agent, new AbortController().signal)

      const exported = await command.handler(invocation('export md'))
      expect(exported.kind).toBe('success')
      expect(exported.text).toContain('exports/')
      const repaired = await command.handler(invocation('repair'))
      expect(repaired.text).toContain('已重建 FTS5')

      expect((await command.handler(invocation('run chapter 2'))).kind).toBe('success')
      const pausedRun = handle.director.board().runs.find((run) => run.targetChapter === 2)!
      expect((await command.handler(invocation(`pause ${pausedRun.id}`))).text).toContain('已暂停')
      expect((await command.handler(invocation('resume'))).text).toContain('已恢复')
      expect((await command.handler(invocation(`stop ${pausedRun.id}`))).text).toContain('已取消')
      expect((await command.handler(invocation('run book'))).text).toContain('已创建')
      expect((await command.handler(invocation('run market'))).text).toContain('已创建')
      expect((await command.handler(invocation('review 2'))).text).toContain('ReviewRun')
    } finally {
      runtime.close()
      db.close()
    }
  })

  it('covers export publish, rewind, diff/restore and bad arguments', async () => {
    const { db, runtime, command } = await setup()
    try {
      expect((await command.handler(invocation('run nope 1'))).kind).toBe('error')
      expect((await command.handler(invocation('run chapter 0'))).kind).toBe('error')
      expect((await command.handler(invocation('review 0'))).kind).toBe('error')
      expect((await command.handler(invocation('rewind'))).kind).toBe('error')
      expect((await command.handler(invocation('rewind artifact'))).kind).toBe('error')
      expect((await command.handler(invocation('rewind chapter 0'))).kind).toBe('error')
      expect((await command.handler(invocation('rewind run'))).kind).toBe('error')
      expect((await command.handler(invocation('export nope'))).kind).toBe('error')

      expect((await command.handler(invocation('run chapter 1'))).text).toContain('已创建')
      const handle = await runtime.open()
      const runId = handle.director.board().runs[0]!.id
      await handle.scheduler.run(runId, {} as Agent, new AbortController().signal)
      expect((await command.handler(invocation('resume'))).kind).toBe('error')
      const approve = await command.handler(invocation('approve'))
      expect(approve.kind).toBe('success')
      await handle.scheduler.run(runId, {} as Agent, new AbortController().signal)

      const publish = await command.handler(invocation('export publish'))
      expect(publish.kind).toBe('success')
      expect(publish.text).toContain('Publish Gate')
      const rejectPublish = await command.handler(invocation('reject publish 暂不发'))
      expect(rejectPublish.kind).toBe('success')

      const rows = handle.artifacts.list({ chapter: 1, limit: 100 })
      const drafts = rows.filter((row) => row.kind === 'Draft')
      const decision = rows.find((row) => row.kind === 'Decision')!
      expect(drafts.length).toBeGreaterThan(0)
      const diff = await command.handler(
        invocation(`artifact diff ${drafts[0]!.id} ${drafts[drafts.length - 1]!.id}`),
      )
      expect(diff.text).toContain('---')
      const restored = await command.handler(invocation(`artifact restore ${drafts[0]!.id}`))
      expect(restored.text).toContain('已恢复为新版本')
      const forbidden = await command.handler(invocation(`artifact restore ${decision.id}`))
      expect(forbidden.kind).toBe('error')
      expect(forbidden.text).toMatch(/append-only/u)
      const rewindArtifact = await command.handler(invocation(`rewind artifact ${drafts[0]!.id}`))
      expect(rewindArtifact.text).toContain('已恢复为新版本')
      const rewindChapter = await command.handler(invocation('rewind chapter 1'))
      expect(rewindChapter.text).toContain('已创建修订 Run')
    } finally {
      runtime.close()
      db.close()
    }
  })

  it('rejects studio commands without a runtime and guards bad arguments', async () => {
    const command = createCommands({} as EngineService).find((entry) => entry.name === 'novel')!
    expect((await command.handler(invocation('board'))).kind).toBe('error')
    expect((await command.handler(invocation('run chapter 1'))).kind).toBe('error')
    expect((await command.handler(invocation('approve'))).kind).toBe('error')
    expect((await command.handler(invocation('agent'))).kind).toBe('error')
    expect((await command.handler(invocation('artifact'))).kind).toBe('error')
    expect((await command.handler(invocation('cost'))).kind).toBe('error')
    expect((await command.handler(invocation('repair'))).kind).toBe('error')
    expect((await command.handler(invocation('export md'))).kind).toBe('error')
  })
})
