import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FsStore } from '../src/store/fs.js'
import { SessionBindings } from '../src/store/bindings.js'

const tempState = async (): Promise<string> => mkdtemp(join(tmpdir(), 'novel-bindings-'))

describe('session bindings', () => {
  it('persists one binding per session and survives a new instance', async () => {
    const dir = await tempState()
    try {
      const store = new FsStore(dir)
      const bindings = new SessionBindings(store)
      expect(await bindings.read()).toEqual({ schema_version: 1, bindings: [] })
      await bindings.bind({
        session_id: 'session-a',
        root: '/novels/a',
        title: 'A 书',
        project_created_at: '2026-10-01T00:00:00.000Z',
        source: 'explicit',
      })
      await bindings.bind({
        session_id: 'session-b',
        root: '/novels/b',
        title: 'B 书',
        project_created_at: '2026-10-02T00:00:00.000Z',
        source: 'command',
      })
      expect(await bindings.get('session-a')).toMatchObject({
        session_id: 'session-a',
        root: '/novels/a',
        title: 'A 书',
        project_created_at: '2026-10-01T00:00:00.000Z',
        source: 'explicit',
      })
      expect((await bindings.list()).map((entry) => entry.session_id).sort()).toEqual([
        'session-a',
        'session-b',
      ])

      const reopened = new SessionBindings(new FsStore(dir))
      expect((await reopened.list()).map((entry) => entry.root).sort()).toEqual(['/novels/a', '/novels/b'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('updates a changed title but does not rewrite an unchanged binding', async () => {
    const dir = await tempState()
    try {
      const bindings = new SessionBindings(new FsStore(dir))
      await bindings.bind({
        session_id: 'session-a',
        root: '/novels/a',
        title: '旧名',
        project_created_at: '2026-10-01T00:00:00.000Z',
        source: 'explicit',
      })
      const path = join(dir, 'session-bindings.yaml')
      const before = await readFile(path, 'utf8')
      await bindings.bind({
        session_id: 'session-a',
        root: '/novels/a',
        title: '旧名',
        project_created_at: '2026-10-01T00:00:00.000Z',
        source: 'explicit',
      })
      expect(await readFile(path, 'utf8')).toBe(before)

      await bindings.bind({
        session_id: 'session-a',
        root: '/novels/a',
        title: '新名',
        project_created_at: '2026-10-01T00:00:00.000Z',
        source: 'explicit',
      })
      expect((await bindings.get('session-a'))?.title).toBe('新名')
      expect(await bindings.list()).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not rewrite a command binding when an explicit read repeats it', async () => {
    const dir = await tempState()
    try {
      const bindings = new SessionBindings(new FsStore(dir))
      await bindings.bind({
        session_id: 'session-a',
        root: '/novels/a',
        title: 'A 书',
        project_created_at: '2026-10-01T00:00:00.000Z',
        source: 'command',
      })
      const path = join(dir, 'session-bindings.yaml')
      const before = await readFile(path, 'utf8')
      await bindings.bind({
        session_id: 'session-a',
        root: '/novels/a',
        title: 'A 书',
        project_created_at: '2026-10-01T00:00:00.000Z',
        source: 'explicit',
      })
      expect(await readFile(path, 'utf8')).toBe(before)
      expect((await bindings.get('session-a'))?.source).toBe('command')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('clears only the named session', async () => {
    const dir = await tempState()
    try {
      const bindings = new SessionBindings(new FsStore(dir))
      for (const id of ['a', 'b']) {
        await bindings.bind({
          session_id: id,
          root: `/novels/${id}`,
          title: id,
          project_created_at: '',
          source: 'explicit',
        })
      }
      await bindings.clear('a')
      expect(await bindings.get('a')).toBeUndefined()
      expect(await bindings.get('b')).toBeDefined()
      await bindings.clear('missing')
      expect(await bindings.list()).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('filters bad rows but fails closed on a corrupt document', async () => {
    const dir = await tempState()
    try {
      const path = join(dir, 'session-bindings.yaml')
      await writeFile(
        path,
        [
          'schema_version: 1',
          'bindings:',
          '  - session_id: good',
          '    root: /novels/good',
          '  - session_id: no-root',
          '  - root: /novels/no-session',
          '  - session_id: string-root',
          '    root: 42',
          '',
        ].join('\n'),
      )
      const bindings = new SessionBindings(new FsStore(dir))
      const rows = await bindings.list()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        session_id: 'good',
        root: '/novels/good',
        title: '',
        project_created_at: '',
        source: 'explicit',
      })

      await writeFile(path, 'not an object')
      await expect(bindings.read()).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await writeFile(path, 'schema_version: 2\nbindings: []\n')
      await expect(bindings.read()).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails closed when the bindings field is present but not an array', async () => {
    const dir = await tempState()
    try {
      const path = join(dir, 'session-bindings.yaml')
      await writeFile(path, 'schema_version: 1\nbindings: {}\n')
      await expect(new SessionBindings(new FsStore(dir)).read()).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await writeFile(path, 'schema_version: 1\nbindings: null\n')
      await expect(new SessionBindings(new FsStore(dir)).read()).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails closed on malformed YAML and repairs duplicate sessions by last write', async () => {
    const dir = await tempState()
    try {
      const path = join(dir, 'session-bindings.yaml')
      await writeFile(path, 'bindings: [\n')
      await expect(new SessionBindings(new FsStore(dir)).read()).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })

      await writeFile(
        path,
        [
          'schema_version: 1',
          'bindings:',
          '  - session_id: same',
          '    root: /novels/first',
          '  - session_id: same',
          '    root: /novels/second',
          '',
        ].join('\n'),
      )
      const rows = await new SessionBindings(new FsStore(dir)).list()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.root).toBe('/novels/second')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
