import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_RULE_CODES } from '../src/codes.js'
import { ruleRegistry } from '../src/rules/pipeline.js'
import { TOOL_NAMES } from '../src/constants.js'
import * as remote from '../src/remote/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))

const sources = async (directory: string, extension = '.ts'): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sources(absolute, extension)))
    else if (entry.name.endsWith(extension)) files.push(absolute)
  }
  return files
}

const importsOf = (text: string): string[] =>
  [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]!)

describe('architecture rules', () => {
  it('R1: domain and rules never import IO or the store', async () => {
    for (const directory of ['src/domain', 'src/rules']) {
      for (const file of await sources(join(root, directory))) {
        const text = await readFile(file, 'utf8')
        const imports = importsOf(text)
        expect(
          imports.some((specifier) => specifier.startsWith('node:')),
          file,
        ).toBe(false)
        expect(
          imports.some((specifier) => specifier.includes('/store/')),
          file,
        ).toBe(false)
      }
    }
  })

  it('R1b: only the store and the asset loader touch the filesystem', async () => {
    const allowed = /[/\\]src[/\\](store[/\\]|assets\.ts$)/
    for (const file of await sources(join(root, 'src'))) {
      const imports = importsOf(await readFile(file, 'utf8'))
      if (allowed.test(file)) continue
      expect(
        imports.some((specifier) => specifier.startsWith('node:fs')),
        `${file} must use src/assets.ts or src/store`,
      ).toBe(false)
    }
  })

  it('R1c: the filesystem scanner itself can detect a violation (meta test)', () => {
    const sample = "import { readFileSync } from 'node:fs'"
    expect(importsOf(sample).some((specifier) => specifier.startsWith('node:fs'))).toBe(true)
  })

  it('R2: the store never imports the engine or the adapters', async () => {
    for (const file of await sources(join(root, 'src/store'))) {
      const imports = importsOf(await readFile(file, 'utf8'))
      expect(
        imports.some((specifier) => specifier.includes('/engine/')),
        file,
      ).toBe(false)
      expect(
        imports.some((specifier) => specifier.includes('/tools/')),
        file,
      ).toBe(false)
    }
  })

  it('R3: adapters never reach into the store or the filesystem', async () => {
    for (const directory of ['src/tools', 'src/commands', 'src/remote']) {
      for (const file of await sources(join(root, directory))) {
        const imports = importsOf(await readFile(file, 'utf8'))
        expect(
          imports.some((specifier) => specifier.startsWith('node:fs')),
          file,
        ).toBe(false)
        expect(
          imports.some((specifier) => specifier.includes('/store/')),
          file,
        ).toBe(false)
      }
    }
  })

  it('R4: the browser half never imports host code', async () => {
    for (const file of await sources(join(root, 'src/client'))) {
      const imports = importsOf(await readFile(file, 'utf8'))
      expect(
        imports.some((specifier) => specifier.includes('/engine/')),
        file,
      ).toBe(false)
      expect(
        imports.some((specifier) => specifier.includes('/store/')),
        file,
      ).toBe(false)
      expect(
        imports.some((specifier) => specifier.startsWith('node:')),
        file,
      ).toBe(false)
    }
  })

  it('R5: every rule code has exactly one implementation and the registry is complete', () => {
    expect(new Set(ALL_RULE_CODES).size).toBe(ALL_RULE_CODES.length)
    expect(ruleRegistry().codes().sort()).toEqual([...ALL_RULE_CODES].sort())
  })

  it('R6: tools all live in the novel_ namespace and the names are unique', () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length)
    for (const name of TOOL_NAMES) expect(name.startsWith('novel_')).toBe(true)
    expect(TOOL_NAMES).toHaveLength(18)
  })

  it('R7: no test is skipped, focused, or marked todo', async () => {
    for (const file of await sources(join(root, 'tests'))) {
      const text = await readFile(file, 'utf8')
      expect(text, file).not.toMatch(/(?:^|\.)(skip|only|todo)\s*\(/m)
    }
  })

  it('INV-10: the remote surface exposes no write method', () => {
    const exported = Object.keys(remote).filter(
      (name) => typeof (remote as Record<string, unknown>)[name] === 'function',
    )
    expect(exported.some((name) => /write|save|delete|update|set[A-Z]/.test(name))).toBe(false)
    expect(exported.sort()).toEqual(['panelHandler', 'panelPayload', 'panelRoute'])
  })
})
