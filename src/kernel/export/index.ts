import { createHash } from 'node:crypto'
import { stringify as stringifyYaml } from 'yaml'
import type { LoadedProject } from '../project/layout.js'
import type { StudioDb } from '../../storage/db.js'
import { loadBible, loadBookOutline, listChapterPlans } from '../book/store.js'
import type { ArtifactStore } from '../artifacts/store.js'
import { StudioError, STUDIO_ERROR_CODES } from '../../contracts/errors.js'
import { EXPORTS_DIR } from '../project/layout.js'
import { buildEpub } from '../../export/epub.js'
import { renderMarkdown, renderPlainText, type ExportChapter } from '../../export/render.js'
import type { NovelProject } from '../../types.js'
import { latestGateResults, listArtifacts } from '../../storage/repositories/artifacts.js'
import { assertReceiptBindsDraft, latestHumanApproval } from '../artifacts/receipts.js'

export type ExportKind = 'markdown' | 'txt' | 'epub' | 'outline' | 'worldbook' | 'proposal'

export interface ExportResult {
  path: string
  chapters: number[]
  bytes: number
  contentHash: string
}

const chapterTitle = (title: string): string => title.replace(/^第\d+章\s*/u, '')

const collectChapters = async (project: LoadedProject): Promise<ExportChapter[]> => {
  const plans = new Map((await listChapterPlans(project.store)).map((plan) => [plan.chapter, plan]))
  const files = (await project.store.list('manuscript')).filter((name) => /^ch-\d{4}\.md$/u.test(name))
  const chapters: ExportChapter[] = []
  for (const file of files.sort()) {
    const chapter = Number(file.slice(3, 7))
    const text = await project.store.readText(`manuscript/${file}`)
    if (text === null) continue
    chapters.push({ num: chapter, title: chapterTitle(plans.get(chapter)?.title ?? ''), text })
  }
  return chapters
}

const legacyProject = (project: LoadedProject): NovelProject => ({
  schema_version: 1,
  title: project.config.title,
  genre: project.taxonomy.subById.get(project.config.genre.sub)?.legacyGenre ?? '都市现代',
  platform: project.config.platform,
  author: project.config.author,
  description: '',
  created_at: project.config.created_at,
  targets: {
    words_per_chapter: project.config.targets.words_per_chapter,
    total_chapters: project.config.targets.total_chapters,
    dialogue_ratio: project.config.targets.dialogue_ratio,
    min_cjk_chars: project.config.targets.min_cjk_chars,
    dialogue_ratio_metric: 'both',
  },
})

export async function assertExportReady(
  project: LoadedProject,
  db: StudioDb,
  artifacts: ArtifactStore,
  chapters: readonly number[],
): Promise<void> {
  const problems: string[] = []
  if (chapters.length === 0) problems.push('no archived chapters to export')
  const sorted = [...chapters].sort((left, right) => left - right)
  for (const [index, chapter] of sorted.entries()) {
    if (chapter !== index + 1) {
      problems.push(`chapter numbering is not contiguous: expected ${index + 1}, got ${chapter}`)
      break
    }
  }
  for (const chapter of chapters) {
    const draft = await artifacts.latest('Draft', chapter)
    if (draft === null) {
      problems.push(`chapter ${chapter} has no draft`)
      continue
    }
    if (draft.status !== 'approved') problems.push(`chapter ${chapter} draft is ${draft.status}`)
    const gates = [...latestGateResults(db.orm, draft.id).values()]
    if (gates.some((row) => row.verdict === 'fail')) problems.push(`chapter ${chapter} has failing gates`)
    const receipt = await latestHumanApproval(artifacts, chapter, 'chapter')
    if (receipt === null) {
      problems.push(`chapter ${chapter} has no host human approval receipt`)
      continue
    }
    try {
      assertReceiptBindsDraft(receipt, draft)
    } catch {
      problems.push(`chapter ${chapter} approval does not bind the current draft`)
    }
  }
  if (problems.length > 0) {
    throw new StudioError(
      STUDIO_ERROR_CODES.EXPORT_BLOCKED,
      `export blocked: ${problems.join('; ')}`,
      'approve every chapter through the Chapter Gate before exporting',
      { problems },
    )
  }
  void project
}

export async function exportProject(
  project: LoadedProject,
  db: StudioDb,
  artifacts: ArtifactStore,
  kind: ExportKind,
  onlyChapters?: readonly number[],
): Promise<ExportResult> {
  const allChapters = await collectChapters(project)
  const chapters =
    onlyChapters === undefined
      ? allChapters
      : allChapters.filter((chapter) => onlyChapters.includes(chapter.num))
  const numbers = chapters.map((chapter) => chapter.num)
  if (numbers.length === 0) {
    throw new StudioError(STUDIO_ERROR_CODES.EXPORT_BLOCKED, 'nothing to export: no archived manuscript')
  }
  await assertExportReady(project, db, artifacts, numbers)
  const legacy = legacyProject(project)
  const known = new Set(
    listArtifacts(db.orm, project.config.id, { limit: 100_000 })
      .filter((row) => row.kind === 'Draft')
      .map((row) => row.chapter),
  )
  for (const chapter of numbers) {
    if (!known.has(chapter))
      throw new StudioError(STUDIO_ERROR_CODES.EXPORT_BLOCKED, `chapter ${chapter} has no artifact`)
  }
  let bytes: Uint8Array
  let extension: string
  if (kind === 'markdown') {
    bytes = new TextEncoder().encode(renderMarkdown(legacy, chapters))
    extension = 'md'
  } else if (kind === 'txt') {
    bytes = new TextEncoder().encode(renderPlainText(legacy, chapters))
    extension = 'txt'
  } else if (kind === 'epub') {
    bytes = buildEpub(legacy, chapters)
    extension = 'epub'
  } else if (kind === 'outline') {
    const outline = await loadBookOutline(project.store)
    const plans = await listChapterPlans(project.store)
    bytes = new TextEncoder().encode(stringifyYaml({ ...outline, chapters: plans }, { lineWidth: 0 }))
    extension = 'yaml'
  } else if (kind === 'worldbook') {
    const bible = await loadBible(project.store)
    bytes = new TextEncoder().encode(stringifyYaml(bible, { lineWidth: 0 }))
    extension = 'yaml'
  } else {
    const bible = await loadBible(project.store)
    const outline = await loadBookOutline(project.store)
    const lines = [
      `# ${project.config.title} · 提案`,
      '',
      `类型：${project.config.genre.major}/${project.config.genre.sub}`,
      `平台：${project.config.platform}`,
      `作者：${project.config.author || '佚名'}`,
      '',
      '## 一句话',
      outline.logline || bible.premise,
      '',
      '## 主题',
      bible.themes,
      '',
      '## 世界',
      bible.world.rules.join('；'),
      '',
      '## 角色',
      bible.characters.map((character) => `- ${String(character.name ?? character.slug ?? '')}`).join('\n'),
      '',
      '## 已有章节',
      chapters.map((chapter) => `- 第${chapter.num}章 ${chapter.title}`).join('\n'),
      '',
    ]
    bytes = new TextEncoder().encode(lines.join('\n'))
    extension = 'md'
  }
  const path = `${EXPORTS_DIR}/${kind}-${new Date().toISOString().replace(/[:.]/gu, '-')}.${extension}`
  await project.store.writeBytes(path, bytes)
  const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  return {
    path,
    chapters: numbers,
    bytes: bytes.byteLength,
    contentHash,
  }
}
