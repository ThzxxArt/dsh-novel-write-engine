import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const roots: Array<{ directory: URL; extension: string }> = [
  { directory: new URL('../tests/', import.meta.url), extension: '.ts' },
  { directory: new URL('../docs/', import.meta.url), extension: '.md' },
]

const files = async (directory: URL, extension: string): Promise<URL[]> => {
  const out: URL[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
    if (entry.isDirectory()) out.push(...(await files(child, extension)))
    else if (entry.name.endsWith(extension)) out.push(child)
  }
  return out
}

describe('project privacy', () => {
  it('does not embed the real project manuscript in tests or docs', async () => {
    const forbidden = [
      '九记' + '茶楼。门口一个伙记正在收碗。',
      '二十蚊。' + '他身上一个仙都冇。',
      '卡上面' + '盖到九十二，碟洗出来一百零三。',
      '冇' + '身份证就系冇身份证。',
      '城寨六婶家' + '在三楼，他爬上去',
    ]
    for (const { directory, extension } of roots) {
      for (const file of await files(directory, extension)) {
        const text = await readFile(file, 'utf8')
        for (const needle of forbidden) {
          expect(text, `${file.pathname} contains ${needle}`).not.toContain(needle)
        }
      }
    }
  })
})
