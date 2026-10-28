import type { ChapterRecord, NovelProject } from '../types.js'

/** One rendered chapter, assembled by the engine before rendering. */
export interface ExportChapter {
  num: number
  title: string
  text: string
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** `第 N 章 标题` — the title stored in the index never carries the prefix. */
export function chapterHeading(chapter: Pick<ChapterRecord, 'num' | 'title'>): string {
  return `第${chapter.num}章 ${chapter.title}`
}

/** Remove blank lines at the document edges, never manuscript indentation. */
const trimBlankEdges = (text: string): string => text.replace(/^\n+|\n+$/g, '')

/** Markdown export: one heading per chapter, body unchanged (it is plain text). */
export function renderMarkdown(project: NovelProject, chapters: readonly ExportChapter[]): string {
  const parts = [`# ${project.title}`, '']
  if (project.author !== '') parts.push(`作者：${project.author}`, '')
  if (project.description !== '') parts.push(`> ${project.description}`, '')
  for (const chapter of chapters) {
    parts.push(`## ${chapterHeading(chapter)}`, '', trimBlankEdges(chapter.text), '')
  }
  return parts.join('\n')
}

/** Plain-text export: no markdown syntax, no BOM. */
export function renderPlainText(project: NovelProject, chapters: readonly ExportChapter[]): string {
  const parts = [project.title, '']
  for (const chapter of chapters) {
    parts.push(chapterHeading(chapter), '', trimBlankEdges(chapter.text), '')
  }
  return parts.join('\n')
}

/** Blurb built from the project record; deterministic, no model call. */
export function renderBlurb(project: NovelProject): string {
  const target = project.targets.words_per_chapter
  return [
    `《${project.title}》`,
    project.genre,
    project.description === '' ? '一部正在连载的网文。' : project.description,
    `每章 ${target[0]}–${target[1]} 字。`,
  ].join('\n')
}

/** Cover as a standalone SVG string; text is escaped, palette is theme-neutral. */
export function renderCover(project: NovelProject): string {
  const title = escapeHtml(project.title)
  const author = escapeHtml(project.author === '' ? '佚名' : project.author)
  const genre = escapeHtml(project.genre)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800" role="img" aria-label="${title}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f2933"/><stop offset="1" stop-color="#0b1014"/></linearGradient></defs>
  <rect width="600" height="800" fill="url(#bg)"/>
  <rect x="40" y="40" width="520" height="720" fill="none" stroke="#c8a96a" stroke-width="2"/>
  <text x="300" y="300" fill="#f5e6c8" font-size="52" font-family="serif" text-anchor="middle">${title}</text>
  <text x="300" y="360" fill="#c8a96a" font-size="22" font-family="serif" text-anchor="middle">${genre}</text>
  <text x="300" y="700" fill="#f5e6c8" font-size="24" font-family="serif" text-anchor="middle">${author}</text>
</svg>
`
}

/** XHTML chapter document for the EPUB package. */
export function renderEpubChapter(chapter: ExportChapter): string {
  // Leading full-width indentation is manuscript content, not transport
  // whitespace. Keep it and ask the reading system to preserve it; trimming
  // here silently removes the paragraph indentation from every exported book.
  const paragraphs = chapter.text
    .split(/\n+/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '')
    .map((line) => `<p class="body">${escapeHtml(line)}</p>`)
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeHtml(chapterHeading(chapter))}</title>
<style>.body { white-space: pre-wrap; margin: 0 0 0.6em; }</style></head>
<body><h1>${escapeHtml(chapterHeading(chapter))}</h1>${paragraphs}</body></html>`
}
