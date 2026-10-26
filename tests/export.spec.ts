import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildEpub, buildZip } from '../src/export/epub.js'
import {
  chapterHeading,
  renderBlurb,
  renderCover,
  renderEpubChapter,
  renderMarkdown,
  renderPlainText,
} from '../src/export/render.js'
import { FsStore } from '../src/store/fs.js'
import { archiveDelta, harness, readyToArchive, sampleSummary } from './helpers.js'
import type { NovelProject } from '../src/types.js'

const project: NovelProject = {
  schema_version: 1,
  title: '测试之书',
  genre: '都市现代',
  platform: 'fanqie',
  author: '作者',
  description: '简介',
  created_at: '2026-01-01',
  targets: { words_per_chapter: [2000, 3000], total_chapters: null, dialogue_ratio: [0.4, 0.6] },
}

const chapters = [
  { num: 1, title: '开端之雨', text: '第一段。\n\n第二段 & <tag>。' },
  { num: 2, title: '旧城之影', text: '第三段。' },
]

/** Read the first local-file header of a ZIP archive. */
function firstEntry(zip: Buffer): { name: string; method: number; data: Buffer } {
  expect(zip.readUInt32LE(0)).toBe(0x04034b50)
  const method = zip.readUInt16LE(8)
  const compressedSize = zip.readUInt32LE(18)
  const nameLength = zip.readUInt16LE(26)
  const name = zip.subarray(30, 30 + nameLength).toString('utf8')
  const data = zip.subarray(30 + nameLength, 30 + nameLength + compressedSize)
  return { name, method, data }
}

/** Read one local file entry by name, inflating it when needed. */
function readEntry(zip: Buffer, wanted: string): string {
  let offset = 0
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8)
    const compressedSize = zip.readUInt32LE(offset + 18)
    const nameLength = zip.readUInt16LE(offset + 26)
    const extraLength = zip.readUInt16LE(offset + 28)
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const start = offset + 30 + nameLength + extraLength
    const data = zip.subarray(start, start + compressedSize)
    if (name === wanted) {
      return (method === 0 ? data : inflateRawSync(data)).toString('utf8')
    }
    offset = start + compressedSize
  }
  throw new Error(`zip entry ${wanted} not found`)
}

describe('renderers', () => {
  it('renders markdown, text, blurb and headings', () => {
    expect(chapterHeading({ num: 1, title: '开端之雨' })).toBe('第1章 开端之雨')
    const markdown = renderMarkdown(project, chapters)
    expect(markdown).toContain('# 测试之书')
    expect(markdown).toContain('## 第1章 开端之雨')
    expect(markdown).toContain('作者：作者')
    expect(renderMarkdown({ ...project, author: '', description: '' }, chapters)).not.toContain('作者：')
    const txt = renderPlainText(project, chapters)
    expect(txt.startsWith('测试之书')).toBe(true)
    expect(txt).not.toContain('#')
    expect(renderBlurb(project)).toContain('都市现代')
    expect(renderBlurb({ ...project, description: '' })).toContain('连载')
  })

  it('renders a well-formed SVG cover and escaped XHTML chapters', () => {
    const svg = renderCover(project)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('测试之书')
    expect(svg).toContain('作者')
    expect(renderCover({ ...project, author: '' })).toContain('佚名')
    const html = renderEpubChapter({ num: 1, title: '标题', text: 'a & <b>' })
    expect(html).toContain('&amp;')
    expect(html).toContain('&lt;b&gt;')
    expect(html).toContain('<p>')
  })

  it('builds a zip whose first entry is the stored mimetype (T-12)', () => {
    const zip = buildEpub(project, chapters)
    const first = firstEntry(zip)
    expect(first.name).toBe('mimetype')
    expect(first.method).toBe(0)
    expect(first.data.toString()).toBe('application/epub+zip')
    expect(zip.includes(Buffer.from('OEBPS/content.opf'))).toBe(true)
    expect(zip.includes(Buffer.from('chapter-001.xhtml'))).toBe(true)
    expect(readEntry(zip, 'OEBPS/content.opf')).toContain('href="toc.ncx"')
    expect(readEntry(zip, 'OEBPS/content.opf')).toContain('properties="cover-image"')
    const bare = buildZip([{ name: 'a.txt', data: Buffer.from('x'), store: false }])
    expect(firstEntry(bare).name).toBe('a.txt')
  })
})

describe('engine export', () => {
  it('writes md, txt and epub into exports/ and keeps the journal consistent', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const store = new FsStore(root)
      for (const kind of ['md', 'txt', 'epub'] as const) {
        const result = await engine.export({ kind, root })
        expect(result.data.files).toContain(`exports/book.${kind}`)
        expect(await store.exists(`exports/book.${kind}`)).toBe(true)
      }
      expect(await store.readText('exports/book.md')).toContain('第1章')
      expect(await store.readText('exports/book.txt')).not.toContain('#')
      const epub = (await store.readBytes('exports/book.epub'))!
      expect(firstEntry(epub).name).toBe('mimetype')
      expect(await store.exists('exports/cover.svg')).toBe(true)
      const again = await engine.export({ kind: 'md', root })
      expect(again.replayed).toBe(true)
      const one = await engine.export({ kind: 'md', chapter: 1, root })
      expect(one.data.files).toContain('exports/book-ch001.md')
      expect(await store.exists('exports/book-ch001.md')).toBe(true)
      await expect(engine.export({ kind: 'md', chapter: 99, root })).rejects.toMatchObject({
        code: 'ENGINE_STAGE_ORDER',
      })
    } finally {
      await cleanup()
    }
  })
})
