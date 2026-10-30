import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildEpub, buildZip } from '../src/export/epub.js'
import { emptyOutline, emptyWorldbook } from '../src/engine/book.js'
import {
  chapterHeading,
  renderBlurb,
  renderCover,
  renderEpubChapter,
  renderMarkdown,
  renderPlainText,
  renderProposal,
} from '../src/export/render.js'
import { FsStore } from '../src/store/fs.js'
import { EngineService } from '../src/engine/service.js'
import { loadRulepack } from '../src/rulepack.js'
import {
  FIXED_NOW,
  TEST_CONFIG,
  archiveDelta,
  harness,
  readProjectFile,
  readyToArchive,
  sampleSummary,
} from './helpers.js'
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
    expect(html).toContain('<p class="body">')
    const indented = renderEpubChapter({ num: 1, title: '标题', text: '　　第一段\n\n第二段' })
    expect(indented).toContain('<p class="body">　　第一段</p>')
    expect(indented).toContain('<p class="body">第二段</p>')
    const indentedChapter = [{ num: 1, title: '标题', text: '　　第一段\n\n第二段' }]
    expect(renderMarkdown(project, indentedChapter)).toContain('　　第一段')
    expect(renderPlainText(project, indentedChapter)).toContain('　　第一段')
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
    const offset = buildEpub({ ...project, created_at: '2026-01-01T08:00:00+08:00' }, chapters)
    expect(readEntry(offset, 'OEBPS/content.opf')).toContain(
      '<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>',
    )
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
      await store.remove('exports/book.md')
      const repaired = await engine.export({ kind: 'md', root })
      expect(repaired.replayed).not.toBe(true)
      expect(await store.exists('exports/book.md')).toBe(true)
      expect(await store.readText('exports/blurb.txt')).toContain('都市现代')
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

  it('does not replay an export after another process changes project metadata', async () => {
    const { root, engine, cleanup } = await harness()
    const second = new EngineService(
      { ...TEST_CONFIG, projectRoot: root, stateDir: '' },
      () => loadRulepack(),
      { now: FIXED_NOW },
    )
    try {
      const summary = sampleSummary()
      await readyToArchive({ root, engine, summary })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root })
      await engine.export({ kind: 'md', root })
      await second.amend({
        path: 'novel.yaml',
        content: { author: '乙', description: '另一个进程改写的简介' },
        reason: 'change metadata in a second process',
        root,
      })
      const again = await engine.export({ kind: 'md', root })
      expect(again.replayed).not.toBe(true)
      expect(await readProjectFile(root, 'exports/cover.svg')).toContain('乙')
      expect(await readProjectFile(root, 'exports/blurb.txt')).toContain('另一个进程改写的简介')
    } finally {
      second.dispose()
      await cleanup()
    }
  })

  it('renders a proposal with and without planning content', () => {
    const empty = renderProposal(project, emptyOutline('2026-01-01'), emptyWorldbook('2026-01-01'), [])
    expect(empty).toContain('测试之书')
    const outline = emptyOutline('2026-01-01')
    outline.book.logline = '梗概'
    outline.book.premise = '前提'
    outline.book.themes = ['主题']
    outline.book.tone = '冷'
    outline.book.pov = '第三人称'
    outline.book.selling_points = ['卖点']
    outline.book.ending = '结局'
    outline.volumes = [
      {
        id: 'V1',
        title: '第一卷',
        start_chapter: 1,
        end_chapter: 3,
        goal: '目标',
        arc: '',
        climax: '',
        status: 'planned',
      },
    ]
    const worldbook = emptyWorldbook('2026-01-01')
    worldbook.premise = '世界'
    worldbook.setting = '设定'
    worldbook.characters = [{ name: '他', role: '主角', description: '档案员', arc: '成长' }]
    const rendered = renderProposal(project, outline, worldbook, [
      {
        num: 1,
        title: '开端',
        file: 'chapters/chapter-001.md',
        word_count: 100,
        dialogue_lines: 0,
        dialogue_ratio: 0,
        scene_type: '日常过渡章',
        narrator: '他',
        score: 140,
        status: 'reviewed',
        content_hash: 'hash',
        summary: {
          events: ['事件'],
          characters_appeared: ['他'],
          foreshadows: { planted: [], advanced: [], resolved: [] },
          new_elements: { locations: [], abilities: [], artifacts: [] },
          resource_changes: [],
          opening: '开头',
          continuity: { opens_from: '', ends_with: '' },
          hook_strength: 3,
          pleasure_points: [],
          plot_advancement: 'mid',
        },
      },
    ] as never)
    expect(rendered).toContain('## 前提')
    expect(rendered).toContain('第一卷')
    expect(rendered).toContain('档案员')
    expect(rendered).toContain('章节样例')
  })
})
