import { deflateRawSync } from 'node:zlib'
import type { NovelProject } from '../types.js'
import { chapterHeading, renderCover, renderEpubChapter, type ExportChapter } from './render.js'

/** Minimal ZIP writer: store `mimetype` first, deflate everything else. */
interface ZipEntry {
  name: string
  data: Uint8Array
  store: boolean
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0
  return (crc ^ 0xffffffff) >>> 0
}

const u16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value & 0xffff)
  return buffer
}

const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0)
  return buffer
}

/** Build the archive bytes; deterministic so exports can be diffed. */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  const now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0))
  const time = ((now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() / 2)) & 0xffff
  const date =
    (((now.getUTCFullYear() - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate()) & 0xffff

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const payload = entry.store ? Buffer.from(entry.data) : deflateRawSync(Buffer.from(entry.data))
    const crc = crc32(entry.data)
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(entry.store ? 0 : 8),
      u16(time),
      u16(date),
      u32(crc),
      u32(payload.length),
      u32(entry.data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      payload,
    ])
    localParts.push(local)
    centralParts.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(entry.store ? 0 : 8),
        u16(time),
        u16(date),
        u32(crc),
        u32(payload.length),
        u32(entry.data.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ]),
    )
    offset += local.length
  }
  const central = Buffer.concat(centralParts)
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ])
  return Buffer.concat([...localParts, central, end])
}

/** Build a valid EPUB 3 archive from chapters; `mimetype` is the first entry. */
export function buildEpub(project: NovelProject, chapters: readonly ExportChapter[]): Buffer {
  const id = 'urn:uuid:6a7d3f8e-6b4f-4f2a-9c1d-2b8f7a0c1234'
  const manifestItems = chapters
    .map(
      (_, index) =>
        `<item id="chap${index + 1}" href="chapter-${String(index + 1).padStart(3, '0')}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join('\n    ')
  const spineItems = chapters.map((_, index) => `<itemref idref="chap${index + 1}"/>`).join('\n    ')
  const navPoints = chapters
    .map(
      (chapter, index) =>
        `<navPoint id="navPoint-${index + 1}" playOrder="${index + 1}"><navLabel><text>${escapeXml(chapterHeading(chapter))}</text></navLabel><content src="chapter-${String(index + 1).padStart(3, '0')}.xhtml"/></navPoint>`,
    )
    .join('\n    ')

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${id}</dc:identifier>
    <dc:title>${escapeXml(project.title)}</dc:title>
    <dc:creator>${escapeXml(project.author === '' ? '佚名' : project.author)}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="cover.svg" media-type="image/svg+xml"/>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>${chapters
    .map(
      (chapter, index) =>
        `<li><a href="chapter-${String(index + 1).padStart(3, '0')}.xhtml">${escapeXml(chapterHeading(chapter))}</a></li>`,
    )
    .join('')}</ol></nav></body></html>`

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${id}"/></head>
  <docTitle><text>${escapeXml(project.title)}</text></docTitle>
  <navMap>
    ${navPoints}
  </navMap>
</ncx>`

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

  const entries: ZipEntry[] = [
    { name: 'mimetype', data: Buffer.from('application/epub+zip'), store: true },
    { name: 'META-INF/container.xml', data: Buffer.from(container), store: false },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf), store: false },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(nav), store: false },
    { name: 'OEBPS/toc.ncx', data: Buffer.from(ncx), store: false },
    { name: 'OEBPS/cover.svg', data: Buffer.from(renderCover(project)), store: false },
  ]
  chapters.forEach((chapter, index) => {
    entries.push({
      name: `OEBPS/chapter-${String(index + 1).padStart(3, '0')}.xhtml`,
      data: Buffer.from(renderEpubChapter(chapter)),
      store: false,
    })
  })
  return buildZip(entries)
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
