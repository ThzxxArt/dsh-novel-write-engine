import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

interface Entry {
  id?: string
  name: string
  group?: boolean
  isolate?: Record<string, boolean>
  config?: unknown
}

const loadPatch = (path: string): Entry[] => {
  const raw = parseYaml(readFileSync(join(repoRoot, path), 'utf8')) as Array<{ insert: Entry[] }>
  expect(Array.isArray(raw)).toBe(true)
  return raw.flatMap((operation) => operation.insert)
}

describe('root patch', () => {
  it('inserts exactly one host row addressed by bare package name', () => {
    const rows = loadPatch('cordis.patch.yml')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'novel-write-engine', name: 'dsh-novel-write-engine' })
  })

  it('declares both patch files in the manifest', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      dsh: { bundle: { patch: string[] }; client: { platform: string } }
      files: string[]
    }
    expect(manifest.dsh.bundle.patch).toEqual([
      './cordis.patch.yml',
      './presets/novel-write-engine.patch.yml',
    ])
    expect(manifest.dsh.client.platform).toBe('web')
    for (const required of ['lib', 'rulepacks', 'briefs', 'locale', 'presets', 'cordis.patch.yml']) {
      expect(manifest.files, required).toContain(required)
    }
  })
})

describe('preset patch', () => {
  const rows = loadPatch('presets/novel-write-engine.patch.yml')

  it('registers one preset row with a stable identity', () => {
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'preset-novel-write-engine', name: '@deepseek-ai/dsh-agent-preset' })
    const config = rows[0]!.config as { id: string; name: string; order: number; plugins: Entry[] }
    expect(config.id).toBe('novel-write-engine')
    expect(config.name).toBe('网文工坊')
    expect(config.order).toBe(20)
    expect(config.plugins.length).toBeGreaterThanOrEqual(8)
  })

  it('gives every nested row an id and keeps them unique', () => {
    const config = rows[0]!.config as { plugins: Entry[] }
    const ids = config.plugins.map((entry) => entry.id)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)

    const nested = config.plugins.flatMap((entry) => (entry.group === true ? (entry.config as Entry[]) : []))
    expect(nested.length).toBeGreaterThan(0)
    for (const entry of nested) {
      expect(entry.id, entry.name).toBeTruthy()
      expect(entry.name.length).toBeGreaterThan(0)
    }
    for (const group of config.plugins.filter((entry) => entry.group === true)) {
      expect(group.name).toBe('cordis:group')
      expect(group.isolate).toBeDefined()
    }
  })

  it('does not hand the novel session any filesystem-like capability', () => {
    const config = rows[0]!.config as { plugins: Entry[] }
    const names = JSON.stringify(config.plugins)
    for (const forbidden of [
      'tool-bash',
      'tool-pwsh',
      'tool-fs',
      'tool-fs-search',
      'tool-jobs',
      'tool-schedule',
      'tool-goal',
      'plan-mode',
      'plugin-manager',
      'workflow-ptc',
      'agent-instructions',
    ]) {
      expect(names, forbidden).not.toContain(forbidden)
    }
  })

  it('ships the persona text in the preset, not in code', () => {
    const config = rows[0]!.config as { plugins: Array<{ id: string; config?: { prefix?: string } }> }
    const persona = config.plugins.find((entry) => entry.id === 'persona')
    expect(persona?.config?.prefix).toContain('主笔')
    expect(persona?.config?.prefix).toContain('novel_status')
    expect(persona?.config?.prefix).toContain('novel_archive')
  })
})
