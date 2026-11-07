import { createHash } from 'node:crypto'
import type { LoadedProject } from '../project/layout.js'
import { StudioError, STUDIO_ERROR_CODES } from '../../contracts/errors.js'
import { stableJson } from '../../domain/stable.js'

export const SNAPSHOT_ROOTS = ['bible', 'outline', 'manuscript', 'state'] as const

export interface SnapshotEntry {
  path: string
  bytes: number
  hash: string
}

export interface SnapshotManifest {
  schema_version: 2
  project_id: string
  created_at: string
  roots: readonly string[]
  files: SnapshotEntry[]
  content_hash: string
}

const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`

async function walk(project: LoadedProject, dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await project.store.entries(dir)) {
    if (entry.symbolicLink) continue
    const path = `${dir}/${entry.name}`
    if (entry.directory) out.push(...(await walk(project, path)))
    else out.push(path)
  }
  return out
}

/** Build a path+hash manifest for the file-backed truth of a project. */
export async function buildSnapshotManifest(
  project: LoadedProject,
): Promise<Omit<SnapshotManifest, 'content_hash'>> {
  const files: SnapshotEntry[] = []
  for (const root of SNAPSHOT_ROOTS) {
    for (const path of (await walk(project, root)).sort()) {
      const text = await project.store.readText(path)
      if (text === null) continue
      const bytes = new TextEncoder().encode(text).byteLength
      files.push({ path, bytes, hash: sha256(text) })
    }
  }
  const manifest = {
    schema_version: 2 as const,
    project_id: project.config.id,
    created_at: new Date().toISOString(),
    roots: SNAPSHOT_ROOTS,
    files,
  }
  return manifest
}

export async function createSnapshot(
  project: LoadedProject,
): Promise<{ path: string; manifest: SnapshotManifest }> {
  const base = await buildSnapshotManifest(project)
  const contentHash = sha256(stableJson(base))
  const manifest: SnapshotManifest = { ...base, content_hash: contentHash }
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const path = `.studio/snapshots/snapshot-${stamp}-${Math.random().toString(36).slice(2, 8)}.json`
  await project.store.ensureDir('.studio/snapshots')
  await project.store.writeText(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return { path, manifest }
}

/** Verify that the file truth still matches a stored manifest. */
export async function verifySnapshot(
  project: LoadedProject,
  manifestPath: string,
): Promise<{ ok: boolean; problems: string[] }> {
  const text = await project.store.readText(manifestPath)
  if (text === null) {
    throw new StudioError(STUDIO_ERROR_CODES.PROJECT_INVALID, `snapshot ${manifestPath} is missing`)
  }
  let manifest: SnapshotManifest
  try {
    manifest = JSON.parse(text) as SnapshotManifest
  } catch {
    throw new StudioError(STUDIO_ERROR_CODES.PROJECT_INVALID, `snapshot ${manifestPath} is not valid JSON`)
  }
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    manifest.schema_version !== 2 ||
    !Array.isArray(manifest.files) ||
    typeof manifest.content_hash !== 'string'
  ) {
    throw new StudioError(
      STUDIO_ERROR_CODES.PROJECT_INVALID,
      `snapshot ${manifestPath} is not a v2 manifest`,
      'recreate the snapshot with snapshot.create',
    )
  }
  const problems: string[] = []
  // The manifest must authenticate itself. Without this check a user could
  // rewrite a file, rewrite its entry hash, and pass verify trivially.
  const { content_hash: declaredHash, ...base } = manifest
  if (sha256(stableJson(base)) !== declaredHash) {
    problems.push('manifest content_hash does not match its own payload')
  }
  const roots = new Set<string>(manifest.roots ?? SNAPSHOT_ROOTS)
  const covered = new Set<string>()
  for (const entry of manifest.files) {
    const path = typeof entry?.path === 'string' ? entry.path : ''
    const root = path.split('/')[0] ?? ''
    if (path === '' || !roots.has(root) || path.includes('..')) {
      problems.push(`manifest contains a path outside the snapshot roots: ${path}`)
      continue
    }
    if (covered.has(path)) problems.push(`${path} is listed twice`)
    covered.add(path)
    const current = await project.store.readText(path)
    if (current === null) {
      problems.push(`${path} is missing`)
      continue
    }
    const actual = sha256(current)
    if (actual !== entry.hash) problems.push(`${path} hash ${actual} != ${entry.hash}`)
    const bytes = new TextEncoder().encode(current).byteLength
    if (typeof entry.bytes === 'number' && entry.bytes !== bytes) {
      problems.push(`${path} bytes ${bytes} != ${entry.bytes}`)
    }
  }
  // A verify that only checks listed files silently accepts newly written
  // chapters. Compare the actual tree so "snapshot" means the whole book.
  for (const root of SNAPSHOT_ROOTS) {
    for (const path of await walk(project, root)) {
      if (!covered.has(path)) problems.push(`${path} was created after the snapshot`)
    }
  }
  return { ok: problems.length === 0, problems }
}
