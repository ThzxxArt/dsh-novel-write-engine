import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsStore } from '../src/store/fs.js'
import { ProjectRegistry } from '../src/store/registry.js'
import { harness, bootstrapToDraft } from './helpers.js'

describe('project registry', () => {
  it('tracks rows without becoming authoritative', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-registry-'))
    try {
      const registry = new ProjectRegistry(new FsStore(dir))
      expect(await registry.read()).toEqual({ schema_version: 1, active: null, projects: [] })
      await registry.register({ root: '/a', title: 'A' })
      await registry.register({ root: '/b', title: 'B' })
      const afterTwo = await registry.register({ root: '/a', title: 'A2' })
      expect(afterTwo.projects.map((entry) => entry.title)).toEqual(['A2', 'B'])
      expect((await registry.setActive('/b')).active).toBe('/b')
      const forgotten = await registry.forget('/b')
      expect(forgotten.projects).toHaveLength(1)
      expect(forgotten.active).toBeNull()
      await writeFile(join(dir, 'projects.yaml'), 'not an object')
      await expect(registry.read()).rejects.toThrow(/not an object/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('exposes registry operations through the engine', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await bootstrapToDraft({ root, engine })
      expect((await engine.listProjects()).projects).toEqual([])
      const registered = await engine.registerProject({ root })
      expect(registered.projects[0]).toMatchObject({ root, title: '测试之书' })
      expect((await engine.setActiveProject({ root })).active).toBe(root)
      const forgotten = await engine.forgetProject({ root })
      expect(forgotten.projects).toEqual([])
    } finally {
      await cleanup()
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})

describe('settings pack import', () => {
  it('previews with a diff, then applies in one transaction', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const content = {
        schema_version: 1,
        characters: [
          {
            name: '他',
            role: 'protagonist',
            first_appearance: 1,
            profile: {},
            current_state: {},
            growth: [],
            updated_at: 1,
          },
        ],
      }
      const preview = await engine.importPack({ kind: 'characters', content, dryRun: true, root })
      expect(preview.data.applied).toBe(false)
      expect(preview.data.preview).toContain('+')
      expect((await engine.queryState({ kind: 'characters', root })).data).toMatchObject({ characters: [] })

      const applied = await engine.importPack({ kind: 'characters', content, root })
      expect(applied.data.applied).toBe(true)
      const stored = await engine.queryState({ kind: 'characters', root })
      expect((stored.data as { characters: unknown[] }).characters).toHaveLength(1)

      await expect(
        engine.importPack({ kind: 'characters', content: { schema_version: 1 }, root }),
      ).rejects.toThrow(/missing required key/)
    } finally {
      await cleanup()
    }
  })
})
