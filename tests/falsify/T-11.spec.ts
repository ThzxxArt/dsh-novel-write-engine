import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { expect, it } from 'vitest'
import { entryListProblem } from '@deepseek-ai/dsh-agent-preset-registry'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

interface Entry {
  id?: string
  name: string
  group?: boolean
  isolate?: Record<string, boolean>
  config?: unknown
}

const flatten = (entries: Entry[]): Entry[] =>
  entries.flatMap((entry) => [
    entry,
    ...(entry.group === true && Array.isArray(entry.config) ? flatten(entry.config as Entry[]) : []),
  ])

/** T-11 / §11.6: the preset entry list must be structurally valid and complete. */
it('T-11 the preset patch passes the registry entry-list contract', () => {
  const operations = parseYaml(
    readFileSync(join(repoRoot, 'presets/novel-write-engine.patch.yml'), 'utf8'),
  ) as Array<{ insert: Entry[] }>
  const entries = operations.flatMap((operation) => operation.insert)
  expect(entries).toHaveLength(1)
  const config = entries[0]!.config as { plugins: Entry[] }
  expect(entryListProblem(config.plugins)).toBeUndefined()
  const all = flatten(config.plugins)
  const ids = all.map((entry) => entry.id)
  expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
  expect(new Set(ids).size).toBe(ids.length)
  const groups = all.filter((entry) => entry.group === true)
  expect(groups).toHaveLength(2)
  for (const group of groups) {
    expect(group.name).toBe('cordis:group')
    expect(group.isolate).toBeTypeOf('object')
    expect(Object.values(group.isolate ?? {}).every((value) => value === true)).toBe(true)
  }
  expect(groups[0]!.isolate).toMatchObject({ compaction: true, toolResultPruner: true })
  expect(groups[1]!.isolate).toMatchObject({ workflowEngine: true })
})
