import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const code = [
  "import { compareText, stableJson } from './src/domain/stable.ts'",
  'process.stdout.write(stableJson({ b: { d: 1, c: 2 }, a: 3 }) + "|" + compareText("a", "A"))',
].join(';')

const run = (lang: string): string =>
  execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], {
    cwd: root,
    env: { ...process.env, LANG: lang },
    encoding: 'utf8',
  })

describe('locale independence', () => {
  it('produces the same digest and comparison under C and zh_CN.UTF-8', () => {
    expect(run('C')).toBe('{"a":3,"b":{"c":2,"d":1}}|1')
    expect(run('zh_CN.UTF-8')).toBe('{"a":3,"b":{"c":2,"d":1}}|1')
  })
})
