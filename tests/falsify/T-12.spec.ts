import { inflateRawSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { buildEpub } from '../../src/export/epub.js'
import type { NovelProject } from '../../src/types.js'

const project: NovelProject = {
  schema_version: 1,
  title: '解压之书',
  genre: '都市现代',
  platform: 'fanqie',
  author: '',
  description: '',
  created_at: '2026-01-01T00:00:00.000Z',
  targets: { words_per_chapter: [2000, 3000], total_chapters: null, dialogue_ratio: [0.4, 0.6] },
}

/** T-12 / §14.2: the EPUB is a readable ZIP with an uncompressed first mimetype. */
it('T-12 unpacks the EPUB and finds a stored mimetype first', () => {
  const zip = buildEpub(project, [{ num: 1, title: '开端', text: '第一段。' }])
  expect(zip.readUInt32LE(0)).toBe(0x04034b50)
  expect(zip.readUInt16LE(8)).toBe(0)
  const nameLength = zip.readUInt16LE(26)
  const name = zip.subarray(30, 30 + nameLength).toString('utf8')
  expect(name).toBe('mimetype')
  const size = zip.readUInt32LE(18)
  expect(zip.subarray(30 + nameLength, 30 + nameLength + size).toString()).toBe('application/epub+zip')

  let offset = 0
  let found = false
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8)
    const compressed = zip.readUInt32LE(offset + 18)
    const length = zip.readUInt16LE(offset + 26)
    const extra = zip.readUInt16LE(offset + 28)
    const entry = zip.subarray(offset + 30, offset + 30 + length).toString('utf8')
    const start = offset + 30 + length + extra
    if (entry === 'OEBPS/content.opf') {
      const body =
        method === 0
          ? zip.subarray(start, start + compressed)
          : inflateRawSync(zip.subarray(start, start + compressed))
      expect(body.toString('utf8')).toContain('chapter-001.xhtml')
      found = true
    }
    offset = start + compressed
  }
  expect(found).toBe(true)

  const crc32 = (buffer: Buffer): number => {
    let crc = 0xffffffff
    for (const byte of buffer) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    return (crc ^ 0xffffffff) >>> 0
  }
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(eocd).toBeGreaterThanOrEqual(0)
  const totalEntries = zip.readUInt16LE(eocd + 10)
  const centralSize = zip.readUInt32LE(eocd + 12)
  const centralOffset = zip.readUInt32LE(eocd + 16)
  expect(centralSize).toBeGreaterThan(0)
  expect(centralOffset + centralSize).toBeLessThanOrEqual(eocd)
  let central = centralOffset
  for (let index = 0; index < totalEntries; index += 1) {
    expect(zip.readUInt32LE(central)).toBe(0x02014b50)
    const method = zip.readUInt16LE(central + 10)
    const expectedCrc = zip.readUInt32LE(central + 16)
    const compressed = zip.readUInt32LE(central + 20)
    const nameLength = zip.readUInt16LE(central + 28)
    const extraLength = zip.readUInt16LE(central + 30)
    const commentLength = zip.readUInt16LE(central + 32)
    const localOffset = zip.readUInt32LE(central + 42)
    const name = zip.subarray(central + 46, central + 46 + nameLength).toString('utf8')
    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50)
    const localName = zip.readUInt16LE(localOffset + 26)
    const localExtra = zip.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localName + localExtra
    const body =
      method === 0
        ? zip.subarray(start, start + compressed)
        : inflateRawSync(zip.subarray(start, start + compressed))
    expect(crc32(body), name).toBe(expectedCrc)
    central += 46 + nameLength + extraLength + commentLength
  }
  expect(central).toBe(centralOffset + centralSize)
  expect(totalEntries).toBeGreaterThan(4)
})
