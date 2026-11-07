import { stringify as stringifyYaml } from 'yaml'
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import type { LoadedProject } from '../project/layout.js'
import type { StudioDb } from '../../storage/db.js'
import type { ArtifactStore } from '../artifacts/store.js'
import { EXPORTS_DIR } from '../project/layout.js'
import { assertExportReady, exportProject } from './index.js'
import { loadBible } from '../book/store.js'
import { latestGateResults } from '../../storage/repositories/artifacts.js'
import { StudioError, STUDIO_ERROR_CODES } from '../../contracts/errors.js'

export interface ExportProfile {
  platform: 'fanqie' | 'qidian' | 'qimao' | 'jinjiang'
  authorNote: string
  blurb: string
  tags: string[]
  coverPath: string | null
  titleRule: string
}

export interface PublishManifestEntry {
  path: string
  bytes: number
  hash: string
}

export interface PublishPackage {
  path: string
  chapters: number[]
  manifest: PublishManifestEntry[]
  checks: string[]
  contentHash: string
  profile: ExportProfile
}

const defaultProfile = (project: LoadedProject): ExportProfile => {
  const configured = project.config.export_profile
  return {
    platform: project.config.platform,
    authorNote: configured?.author_note ?? '',
    blurb: configured?.blurb ?? '',
    tags: configured?.tags.length ? [...configured.tags] : [...project.config.genre.tags],
    coverPath: configured?.cover_path ?? null,
    titleRule: configured?.title_rule ?? '',
  }
}

/** Build a platform-ready publish directory after ExportGate passes. */
export async function publishPackage(
  project: LoadedProject,
  db: StudioDb,
  artifacts: ArtifactStore,
  overrides: Partial<ExportProfile> = {},
): Promise<PublishPackage> {
  const files = (await project.store.list('manuscript')).filter((name) => /^ch-\d{4}\.md$/u.test(name))
  const chapters = files.map((name) => Number(name.slice(3, 7))).sort((left, right) => left - right)
  if (chapters.length === 0) {
    throw new StudioError(STUDIO_ERROR_CODES.EXPORT_BLOCKED, 'nothing to publish: no archived manuscript')
  }
  await assertExportReady(project, db, artifacts, chapters)
  const ebook = await exportProject(project, db, artifacts, 'epub')
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const dir = `${EXPORTS_DIR}/publish-${stamp}-${Math.random().toString(36).slice(2, 8)}`
  const profile = { ...defaultProfile(project), ...overrides }
  const book = await loadBible(project.store)
  const metadata = stringifyYaml(
    {
      schema_version: 2,
      platform: profile.platform,
      title: project.config.title,
      author: project.config.author,
      genre: project.config.genre,
      audience: project.config.audience,
      tags: profile.tags,
      blurb: profile.blurb || book.premise,
      author_note: profile.authorNote,
      title_rule: profile.titleRule,
      chapters,
      generated_at: new Date().toISOString(),
    },
    { lineWidth: 0 },
  )
  const checks: string[] = []
  for (const chapter of chapters) {
    const draft = await artifacts.latest('Draft', chapter)
    const gates = draft === null ? [] : [...latestGateResults(db.orm, draft.id).values()]
    checks.push(
      `chapter ${chapter}: ${draft?.status ?? 'missing'} / ${gates.filter((row) => row.verdict === 'fail').length} failing gates`,
    )
  }
  checks.push(`ebook: ${ebook.contentHash}`)
  const manifest: PublishManifestEntry[] = []
  const writeText = async (name: string, text: string): Promise<void> => {
    const path = `${dir}/${name}`
    await project.store.writeText(path, text)
    manifest.push({
      path,
      bytes: new TextEncoder().encode(text).byteLength,
      hash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
    })
  }
  const cover = profile.coverPath === null ? null : await project.store.readBytes(profile.coverPath)
  if (profile.coverPath !== null && cover === null) {
    throw new StudioError(
      STUDIO_ERROR_CODES.EXPORT_BLOCKED,
      `publish profile cover ${profile.coverPath} is missing`,
      'upload the cover under the project root or clear cover_path in Settings',
    )
  }
  if (cover !== null && profile.coverPath !== null) {
    const extension = extname(profile.coverPath) || '.bin'
    const path = `${dir}/cover${extension}`
    await project.store.writeBytes(path, cover)
    manifest.push({
      path,
      bytes: cover.byteLength,
      hash: `sha256:${createHash('sha256').update(cover).digest('hex')}`,
    })
  }
  await writeText('metadata.yaml', metadata)
  await writeText('checks.txt', `${checks.join('\n')}\n`)
  await writeText('chapters.txt', `${chapters.join('\n')}\n`)
  const ebookBytes = await project.store.readBytes(ebook.path)
  if (ebookBytes !== null) {
    const path = `${dir}/book.epub`
    await project.store.writeBytes(path, ebookBytes)
    manifest.push({ path, bytes: ebookBytes.byteLength, hash: ebook.contentHash })
  }
  const manifestText = `${JSON.stringify({ files: manifest }, null, 2)}\n`
  await project.store.writeText(`${dir}/manifest.json`, manifestText)
  manifest.push({
    path: `${dir}/manifest.json`,
    bytes: new TextEncoder().encode(manifestText).byteLength,
    hash: `sha256:${createHash('sha256').update(manifestText).digest('hex')}`,
  })
  return {
    path: dir,
    chapters,
    manifest,
    checks,
    contentHash: `sha256:${createHash('sha256').update(manifestText).digest('hex')}`,
    profile,
  }
}
