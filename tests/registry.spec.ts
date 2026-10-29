import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAdminOperation } from '../src/commands/admin.js'
import { FsStore } from '../src/store/fs.js'
import { ProjectRegistry } from '../src/store/registry.js'
import { archiveDelta, bootstrapToDraft, harness, readyToArchive, sampleSummary } from './helpers.js'

describe('project registry', () => {
  it('tracks rows without becoming authoritative', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-registry-'))
    try {
      const registry = new ProjectRegistry(new FsStore(dir))
      expect(await registry.read()).toEqual({ schema_version: 1, active: null, projects: [] })
      await registry.register({ root: '/a', title: 'A', created_at: '2026-10-01T00:00:00.000Z' })
      await registry.register({ root: '/b', title: 'B', created_at: '2026-10-02T00:00:00.000Z' })
      const afterTwo = await registry.register({
        root: '/a',
        title: 'A2',
        created_at: '2026-10-01T00:00:00.000Z',
      })
      expect(afterTwo.projects.map((entry) => entry.title)).toEqual(['A2', 'B'])
      expect(afterTwo.projects[0]?.created_at).toBe('2026-10-01T00:00:00.000Z')
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

  it('treats an empty active value as no default instead of resolving it to cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-registry-'))
    try {
      await writeFile(
        join(dir, 'projects.yaml'),
        ['schema_version: 1', 'active: ""', 'projects: []', ''].join('\n'),
      )
      const document = await new ProjectRegistry(new FsStore(dir)).read()
      expect(document.active).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads a v1 registry without created_at and upgrades the row on registration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-registry-'))
    try {
      await writeFile(
        join(dir, 'projects.yaml'),
        ['schema_version: 1', 'active: /old', 'projects:', '  - root: /old', '    title: 旧书', ''].join(
          '\n',
        ),
      )
      const registry = new ProjectRegistry(new FsStore(dir))
      const legacy = await registry.read()
      expect(legacy.active).toBe('/old')
      expect(legacy.projects[0]).toEqual({ root: '/old', title: '旧书', updated_at: '' })
      const upgraded = await registry.register({
        root: '/old',
        title: '旧书',
        created_at: '2026-10-01T00:00:00.000Z',
      })
      expect(upgraded.projects).toHaveLength(1)
      expect(upgraded.projects[0]?.created_at).toBe('2026-10-01T00:00:00.000Z')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('exposes registry operations through the engine', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await bootstrapToDraft({ root, engine })
      expect((await engine.listProjects()).projects).toEqual([
        expect.objectContaining({ root, title: '测试之书', state: 'ok' }),
      ])
      const registered = await engine.registerProject({ root })
      expect(registered.projects[0]).toMatchObject({ root, title: '测试之书' })
      const duplicate = await engine.registerProject({ root })
      expect(duplicate.replaced).toBe(false)
      expect(duplicate.projects.filter((row) => row.root === root)).toHaveLength(1)
      expect((await engine.setActiveProject({ root })).active).toBe(root)
      const forgotten = await engine.forgetProject({ root })
      expect(forgotten.projects).toEqual([])
    } finally {
      await cleanup()
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('reaches the registry and settings-pack import through /novel admin', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'novel-state-'))
    const { root, engine, cleanup } = await harness({ stateDir })
    try {
      await bootstrapToDraft({ root, engine })
      const parseAdminJson = (value: string): Record<string, unknown> =>
        JSON.parse(value.slice(value.indexOf('{'))) as Record<string, unknown>
      expect(await runAdminOperation(engine, 'novel_registry_list', '{}')).toContain('projects')
      const registered = await runAdminOperation(engine, 'novel_registry_register', JSON.stringify({ root }))
      expect(parseAdminJson(registered)).toMatchObject({
        projects: [expect.objectContaining({ root })],
      })
      const activated = await runAdminOperation(engine, 'novel_registry_activate', JSON.stringify({ root }))
      expect(parseAdminJson(activated)).toMatchObject({ active: root })
      expect(await runAdminOperation(engine, 'novel_registry_forget', JSON.stringify({ root }))).toContain(
        'projects',
      )
      const preview = await runAdminOperation(
        engine,
        'novel_import',
        JSON.stringify({
          kind: 'characters',
          content: { schema_version: 1, characters: [] },
          dryRun: true,
          root,
        }),
      )
      expect(preview).toContain('"applied": false')
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

  it('does not let a settings pack remove a character still referenced by locks', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = sampleSummary()
      await readyToArchive({ root, engine, summary })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root })
      await expect(
        engine.importPack({
          kind: 'characters',
          content: { schema_version: 1, characters: [] },
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('fails closed on malformed YAML/schema and collapses duplicate roots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-registry-'))
    try {
      const path = join(dir, 'projects.yaml')
      await writeFile(path, 'projects: [\n')
      await expect(new ProjectRegistry(new FsStore(dir)).read()).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await writeFile(path, 'schema_version: 2\nactive: null\nprojects: []\n')
      await expect(new ProjectRegistry(new FsStore(dir)).read()).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await writeFile(path, 'schema_version: 1\nactive: null\nprojects: {}\n')
      await expect(new ProjectRegistry(new FsStore(dir)).read()).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await writeFile(
        path,
        [
          'schema_version: 1',
          'active: /same',
          'projects:',
          '  - root: /same',
          '    title: first',
          '  - root: /same',
          '    title: second',
          '',
        ].join('\n'),
      )
      const document = await new ProjectRegistry(new FsStore(dir)).read()
      expect(document.projects).toHaveLength(1)
      expect(document.projects[0]?.title).toBe('second')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
