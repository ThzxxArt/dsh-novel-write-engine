import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initProjectV2, loadProjectV2 } from '../src/kernel/project/layout.js'
import { createSnapshot, verifySnapshot } from '../src/kernel/export/snapshot.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-branch-'))
  roots.push(root)
  await initProjectV2({
    root,
    title: '快照边界',
    genre: {
      major: 'mystery',
      sub: 'mystery.detective',
      tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
    },
    audience: 'general',
    platform: 'fanqie',
    targets: { total_chapters: 1 },
  })
  const project = await loadProjectV2(root)
  await project.store.ensureDir('manuscript')
  await project.store.writeText('manuscript/ch-0001.md', '原始正文。\n')
  return project
}

const rewriteManifest = async (
  project: Awaited<ReturnType<typeof setup>>,
  path: string,
  mutate: (manifest: Record<string, unknown>) => void,
): Promise<void> => {
  const text = await project.store.readText(path)
  const manifest = JSON.parse(text!) as Record<string, unknown>
  mutate(manifest)
  await project.store.writeText(path, JSON.stringify(manifest))
}

describe('snapshot verify branches', () => {
  it('detects escaped, duplicate, byte-mismatched and newly added entries', async () => {
    const project = await setup()
    const snapshot = await createSnapshot(project)
    expect((await verifySnapshot(project, snapshot.path)).ok).toBe(true)

    await rewriteManifest(project, snapshot.path, (manifest) => {
      const files = manifest.files as Array<Record<string, unknown>>
      files.push({ path: '../escape.md', bytes: 1, hash: 'sha256:x' })
    })
    expect((await verifySnapshot(project, snapshot.path)).problems.join('\n')).toMatch(/outside/u)

    await rewriteManifest(project, snapshot.path, (manifest) => {
      const files = manifest.files as Array<Record<string, unknown>>
      files.push({ ...files[0] })
    })
    expect((await verifySnapshot(project, snapshot.path)).problems.join('\n')).toMatch(/listed twice/u)

    await rewriteManifest(project, snapshot.path, (manifest) => {
      const files = manifest.files as Array<Record<string, unknown>>
      files[0]!.bytes = Number(files[0]!.bytes) + 1
    })
    expect((await verifySnapshot(project, snapshot.path)).problems.join('\n')).toMatch(/bytes/u)

    await project.store.writeText('manuscript/ch-0002.md', '快照后新增。\n')
    expect((await verifySnapshot(project, snapshot.path)).problems.join('\n')).toMatch(
      /created after the snapshot/u,
    )
  })

  it('rejects malformed manifests and skips symbolic links when walking', async () => {
    const project = await setup()
    await project.store.writeText('.studio/snapshots/corrupt-shape.json', '{"schema_version":1}')
    await expect(verifySnapshot(project, '.studio/snapshots/corrupt-shape.json')).rejects.toMatchObject({
      code: 'STUDIO_PROJECT_INVALID',
    })
    await expect(verifySnapshot(project, '.studio/snapshots/missing.json')).rejects.toMatchObject({
      code: 'STUDIO_PROJECT_INVALID',
    })
    symlinkSync(join(project.root, 'bible', 'premise.md'), join(project.root, 'manuscript', 'linked.md'))
    const snapshot = await createSnapshot(project)
    expect(snapshot.manifest.files.some((entry) => entry.path.endsWith('linked.md'))).toBe(false)
    await expect(verifySnapshot(project, snapshot.path)).resolves.toMatchObject({ ok: true })
  })

  it('flags a self-hash mismatch when a manifest entry is edited', async () => {
    const project = await setup()
    const snapshot = await createSnapshot(project)
    await rewriteManifest(project, snapshot.path, (manifest) => {
      const files = manifest.files as Array<Record<string, unknown>>
      files[0]!.hash = 'sha256:tampered'
    })
    expect((await verifySnapshot(project, snapshot.path)).problems.join('\n')).toMatch(
      /content_hash does not match/u,
    )
  })
})
