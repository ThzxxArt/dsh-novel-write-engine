#!/usr/bin/env node
/**
 * Anti-cheat gate: keep coverage suppressions and placeholder assertions from
 * silently replacing real tests. The budget is deliberately tiny (5).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const files = []
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) walk(absolute)
    else if (entry.name.endsWith('.ts')) files.push(absolute)
  }
}
walk(join(root, 'src'))
walk(join(root, 'tests'))
const failures = []
let ignores = 0
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const display = relative(root, file).replaceAll('\\', '/')
  ignores += [...text.matchAll(/v8\s+ignore/g)].length
  if (/expect\s*\(\s*true\s*\)\s*\./.test(text))
    failures.push(`${display}: expect(true) placeholder assertion`)
  if (/(?:^|\.)(skip|only|todo)\s*\(/m.test(text)) failures.push(`${display}: skipped/focused/todo test`)
}
if (ignores > 5) failures.push(`${ignores} v8 ignore suppressions exceed the budget of 5`)
if (failures.length > 0) {
  console.error(`hygiene check failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`hygiene check passed: ${files.length} files, ${ignores} v8 ignore(s)`)
