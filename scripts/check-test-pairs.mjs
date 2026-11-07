#!/usr/bin/env node
/**
 * Third-review gate: every behavioural test file must contain a negative
 * assertion, and every public action/tool must appear in at least one test.
 *
 * This is deliberately a static check. It cannot prove that each positive case
 * has a matching negative case, but it makes "only the happy path" fail CI
 * instead of being discovered by a reviewer.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const TEST_DIR = join(root, 'tests')

const walk = (dir) => {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (/\.spec\.tsx?$/u.test(name)) out.push(path)
  }
  return out
}

const POSITIVE =
  /\.toBe\(true\)|\.resolves|\.toBe\(200\)|toContain\(|toBeDefined\(\)|toBeGreaterThan|toBeLessThan/u
const NEGATIVE =
  /\.rejects|\.toThrow|toBe\(false\)|not\.to|toBeNull\(\)|toBeUndefined\(\)|status\([^)]*\)\.toBe\(4|statusCode[^)]*not\.toBe\(200\)|\.error\b|INVALID|invalid|missing|failed|denied|forbidden|unknown/u

const failures = []
const warnings = []
const files = walk(TEST_DIR)

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const positive = POSITIVE.test(text)
  const negative = NEGATIVE.test(text)
  if (positive && !negative) {
    failures.push(`${relative(root, file)} has positive assertions but no negative assertion`)
  }
  const titles = [...text.matchAll(/\bit\(\s*['"`]([^'"`]+)['"`]/gu)].map((match) => match[1])
  const positiveTitles = titles.filter((title) =>
    /\b(accepts?|keeps?|returns?|passes?|renders?|creates?|supports?|reads?|writes?|applies?|lists?|serves?|persists?)\b/iu.test(
      title,
    ),
  )
  const negativeTitles = titles.filter((title) =>
    /\b(rejects?|refuses?|fails?|blocks?|denies?|errors?|invalid|missing|unknown|forbids?|guards?|bounds?|no|not|never|without|cannot|doesn't|does not)\b/iu.test(
      title,
    ),
  )
  if (positiveTitles.length > 0 && negativeTitles.length === 0) {
    warnings.push(
      `${relative(root, file)}: ${positiveTitles.length} success-oriented test title(s) and no failure-oriented title`,
    )
  }
}

const source = readFileSync(join(root, 'src/adapters/remote/studio-api.ts'), 'utf8')
const apiActions = new Set([...source.matchAll(/action === '([^']+)'/gu)].map((match) => match[1]))
const mcpTools = new Set([...source.matchAll(/name: '(novel_[a-z_]+)'/gu)].map((match) => match[1]))
const allTests = files.map((file) => readFileSync(file, 'utf8')).join('\n')
for (const action of apiActions) {
  if (!allTests.includes(`'${action}'`)) failures.push(`API action ${action} never appears in a test`)
}
for (const tool of mcpTools) {
  if (!allTests.includes(tool)) failures.push(`MCP tool ${tool} never appears in a test`)
}

const studioTools = readFileSync(join(root, 'src/adapters/tools/studio.ts'), 'utf8')
for (const name of new Set([...studioTools.matchAll(/name: '(novel_[a-z_]+)'/gu)].map((match) => match[1]))) {
  if (!allTests.includes(name)) failures.push(`studio tool ${name} never appears in a test`)
}

console.log(
  `test pair audit: ${files.length} spec files, ${apiActions.size} API actions, ` +
    `${mcpTools.size} MCP tools`,
)
for (const warning of warnings) console.warn(`warning: ${warning}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`ERROR: ${failure}`)
  process.exit(1)
}
console.log('test pair audit passed: every spec has a negative assertion and every action is referenced')
