import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { initProjectV2 } from '../src/kernel/project/layout.js'
import { StudioRuntime } from '../src/studio/runtime.js'
import { createHostTools, createStudioTools } from '../src/adapters/tools/studio.js'

const roots: string[] = []
const makeRuntime = async (): Promise<StudioRuntime> => {
  const root = mkdtempSync(join(tmpdir(), 'studio-tools-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: '工具测试',
    genre: {
      major: 'fantasy',
      sub: 'fantasy.xianxia',
      tags: ['world.eastern_cultivation', 'plot.progression', 'tone.hot_blooded'],
    },
    audience: 'male',
    platform: 'qidian',
    targets: { total_chapters: 3 },
  })
  return new StudioRuntime({ projectRoot: root })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const execute = async (
  tool: unknown,
  args: Record<string, unknown>,
  exec = { agent: {} as Agent, signal: new AbortController().signal },
): Promise<unknown> => {
  return (tool as { execute: (args: unknown, exec: unknown) => Promise<unknown> }).execute(args, exec)
}

describe('studio public tools', () => {
  it('exposes 10 model tools and never the host-only pair', async () => {
    const runtime = await makeRuntime()
    try {
      const tools = createStudioTools(runtime)
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'novel_agent',
        'novel_artifact',
        'novel_bible',
        'novel_export',
        'novel_init',
        'novel_outline',
        'novel_run',
        'novel_search',
        'novel_state',
        'novel_status',
      ])
      const host = createHostTools({ runtime })
      expect(host.map((tool) => tool.name).sort()).toEqual(['novel_admin', 'novel_approve'])
    } finally {
      runtime.close()
    }
  })

  it('executes read tools and artifact proposals', async () => {
    const runtime = await makeRuntime()
    try {
      const tools = new Map(createStudioTools(runtime).map((tool) => [tool.name, tool]))
      const status = (await execute(tools.get('novel_status'), {})) as { project: { title: string } }
      expect(status.project.title).toBe('工具测试')
      const state = (await execute(tools.get('novel_state'), { kind: 'canon' })) as { schema_version: number }
      expect(state.schema_version).toBe(2)
      const bible = (await execute(tools.get('novel_bible'), { action: 'read' })) as { premise: string }
      expect(bible.premise).toBeDefined()
      const outline = (await execute(tools.get('novel_outline'), { action: 'read' })) as {
        book: { schema_version: number }
      }
      expect(outline.book.schema_version).toBe(2)
      const search = (await execute(tools.get('novel_search'), { query: '测试' })) as { hits: unknown[] }
      expect(Array.isArray(search.hits)).toBe(true)
      const agents = (await execute(tools.get('novel_agent'), { action: 'list' })) as { roles: unknown[] }
      expect(agents.roles).toHaveLength(12)
      const runs = (await execute(tools.get('novel_run'), { action: 'status' })) as { runs: unknown[] }
      expect(runs.runs).toEqual([])
      const artifacts = (await execute(tools.get('novel_artifact'), { action: 'list' })) as unknown[]
      expect(Array.isArray(artifacts)).toBe(true)
      const proposed = (await execute(tools.get('novel_bible'), {
        action: 'propose',
        patch: {
          schema_version: 2,
          kind: 'BiblePlan',
          premise: '前提',
          themes: ['主题'],
          style: { guide: '短句。', fingerprint: {} },
          world: { rules: ['规则'], factions: [], locations: [], glossary: {} },
          characters: [],
          citations: [],
          open_questions: [],
        },
      })) as { ok: boolean; artifact: { id: string } }
      expect(proposed.ok).toBe(true)
      const got = (await execute(tools.get('novel_artifact'), {
        action: 'get',
        id: proposed.artifact.id,
      })) as { kind: string }
      expect(got.kind).toBe('BiblePlan')
      await expect(execute(tools.get('novel_export'), { kind: 'markdown' })).rejects.toThrow(
        /nothing to export/,
      )
    } finally {
      runtime.close()
    }
  })

  it('initializes a project through the public tool on a fresh root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-tools-init-'))
    roots.push(root)
    const runtime = new StudioRuntime({ projectRoot: root })
    try {
      const init = new Map(createStudioTools(runtime).map((tool) => [tool.name, tool]))
      const result = (await execute(init.get('novel_init'), {
        title: '工具新建',
        genre: {
          major: 'urban',
          sub: 'urban.daily',
          tags: ['world.modern_city', 'plot.farming', 'tone.light'],
        },
        audience: 'general',
        platform: 'fanqie',
      })) as { ok: boolean; project: { title: string } }
      expect(result.ok).toBe(true)
      expect(result.project.title).toBe('工具新建')
    } finally {
      runtime.close()
    }
  })
})
