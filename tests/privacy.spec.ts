import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const root = new URL('../tests/', import.meta.url)

const files = async (directory: URL): Promise<URL[]> => {
  const out: URL[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
    if (entry.isDirectory()) out.push(...(await files(child)))
    else if (entry.name.endsWith('.ts')) out.push(child)
  }
  return out
}

describe('test privacy', () => {
  it('does not embed the real project manuscript in test sources', async () => {
    const forbidden = ['九记' + '茶楼', '冇' + '身份证', '卡上面' + '盖到九十二', '碟洗出来' + '一百零三']
    for (const file of await files(root)) {
      const text = await readFile(file, 'utf8')
      for (const needle of forbidden) {
        expect(text, `${file.pathname} contains ${needle}`).not.toContain(needle)
      }
    }
  })
})
