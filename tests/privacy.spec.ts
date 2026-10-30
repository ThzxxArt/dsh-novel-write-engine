import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const files = async (directory: URL, extensions: readonly string[]): Promise<URL[]> => {
  const out: URL[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
    if (entry.isDirectory()) out.push(...(await files(child, extensions)))
    else if (extensions.some((extension) => entry.name.endsWith(extension))) out.push(child)
  }
  return out
}

const manuscriptRoots = [
  { directory: new URL('../tests/', import.meta.url), extensions: ['.ts'] },
  { directory: new URL('../docs/', import.meta.url), extensions: ['.md'] },
]

const productRoots = [
  { directory: new URL('../src/', import.meta.url), extensions: ['.ts'] },
  { directory: new URL('../briefs/', import.meta.url), extensions: ['.md'] },
  { directory: new URL('../skills/', import.meta.url), extensions: ['.md'] },
  { directory: new URL('../presets/', import.meta.url), extensions: ['.yml', '.yaml'] },
  { directory: new URL('../rulepacks/', import.meta.url), extensions: ['.yml', '.yaml'] },
  { directory: new URL('../docs/', import.meta.url), extensions: ['.md'] },
]

const productFiles = ['README.md', 'CHANGELOG.md', 'PLAN.md', 'DESIGN.md'].map(
  (name) => new URL(`../${name}`, import.meta.url),
)

/** Split so this guard's own source does not contain the forbidden identity. */
const concreteProjectMarkers = [
  '19' + '71' + '从偷渡' + '港' + '岛' + '开始',
  '陈' + '嘉树',
  '陈' + '默',
  '陈' + '七',
  '何' + '九',
  '六' + '婶',
  '方' + '锦荣',
  '阿' + '寿',
  '林' + '深',
  '林' + '渊',
  '城' + '寨',
  '大' + '鹏' + '湾',
  '旧' + '码头',
  '/mnt/d/' + 'Book' + 'Workspace',
  '/mnt/d/' + 'Code' + 'Workspace',
  '/home/' + 'tianhao',
]

describe('project privacy', () => {
  it('does not embed the real project manuscript in tests or docs', async () => {
    const forbidden = [
      '九' + '记' + '茶' + '楼。门口一个伙记正在收碗。',
      '二十' + '蚊。' + '他身上一个仙都冇。',
      '卡上面' + '盖到九十二，碟洗出来一百零三。',
      '冇' + '身份证就系冇身份证。',
      '城' + '寨' + '六' + '婶家' + '在三楼，他爬上去',
    ]
    for (const { directory, extensions } of manuscriptRoots) {
      for (const file of await files(directory, extensions)) {
        const text = await readFile(file, 'utf8')
        for (const needle of forbidden) {
          expect(text, `${file.pathname} contains ${needle}`).not.toContain(needle)
        }
      }
    }
  })

  it('keeps a concrete project identity out of the shipped surface', async () => {
    const surfaces: URL[] = []
    for (const { directory, extensions } of productRoots) {
      surfaces.push(...(await files(directory, extensions)))
    }
    surfaces.push(...productFiles)
    // A missing directory must fail loudly instead of turning the scan into a no-op.
    expect(surfaces.some((file) => file.pathname.endsWith('/briefs/P8.md'))).toBe(true)
    expect(surfaces.some((file) => file.pathname.endsWith('/src/engine/service.ts'))).toBe(true)
    expect(surfaces.some((file) => file.pathname.endsWith('/README.md'))).toBe(true)

    for (const file of surfaces) {
      const text = await readFile(file, 'utf8')
      for (const marker of concreteProjectMarkers) {
        expect(text, `${file.pathname} contains ${marker}`).not.toContain(marker)
      }
    }
  })
})
