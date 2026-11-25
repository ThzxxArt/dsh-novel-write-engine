#!/usr/bin/env node
/**
 * 0.2.17 documentation assertions.
 *
 * Prose that counts things rots silently. Every number the docs claim about the
 * engine is asserted here, so a stale figure is a red build instead of a wrong
 * answer the model reads out loud.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GATE_ORDER,
  OPERATIONS,
  PANEL_VERSION,
  SELF_CHECK_SPEC,
  STATE_FILES,
  STYLE_PACK_LINES,
  TOOL_NAMES,
  loadStyleCatalogue,
  stylePackSummaries,
} from '../lib/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (name) => readFileSync(`${root}${name}`, 'utf8')
const design = read('DESIGN.md')

const problems = []

const check = (label, condition, detail) => {
  if (condition) return
  problems.push(`${label}: ${detail}`)
}

// 0.2.20 release: GitHub answers a broken workflow file with "This run likely
// failed because of a workflow file issue" and **zero jobs**, so the failure has
// no log to read and every later gate is skipped. A plain YAML colon in an
// unquoted `name:` did exactly that. Parse every workflow here so the same
// mistake is a red local gate instead of a dead CI run.
for (const file of readdirSync(join(root, '.github/workflows')).filter((name) => /\.ya?ml$/.test(name))) {
  const text = readFileSync(join(root, '.github/workflows', file), 'utf8')
  try {
    const parsed = parseYaml(text)
    check(
      `workflow/${file}`,
      typeof parsed === 'object' && parsed !== null && parsed.jobs !== undefined,
      `${file} has no jobs block`,
    )
  } catch (error) {
    problems.push(
      `workflow/${file}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    )
  }
}

// 0. 0.2.20 release review: the version is a product fact in four places —
// package.json (what npm serves), PANEL_VERSION (what the panel tells a stale
// tab to reload), DESIGN.md (what the design book claims) and CHANGELOG.md
// (what the release notes describe). Only the first two were tied by a test;
// the other two drifted silently through every release, and this review found
// the whole tree still saying 0.2.19 while the changelog said 0.2.20.
const manifest = JSON.parse(read('package.json'))
const changelog = read('CHANGELOG.md')
check(
  'version/panel',
  PANEL_VERSION === manifest.version,
  `PANEL_VERSION is ${PANEL_VERSION}, package.json is ${manifest.version}`,
)
check(
  'version/design',
  new RegExp(`\\| 插件版本 \\| \\x60${manifest.version.replace(/\./g, '\\.')}\\x60`).test(design),
  `DESIGN.md does not name the shipped version ${manifest.version}`,
)
check(
  'version/changelog',
  changelog.includes(`\n## ${manifest.version}\n`) || changelog.startsWith(`## ${manifest.version}\n`),
  `CHANGELOG.md has no "## ${manifest.version}" section at the top`,
)
check(
  'version/readme',
  new RegExp(`最近一版是\\D{0,8}${manifest.version.replace(/\./g, '\\.')}`).test(read('README.md')),
  `README.md does not say the latest version is ${manifest.version}`,
)

// 1. Tool count: one namespace, and the docs agree.
check('tools', TOOL_NAMES.length === 28, `TOOL_NAMES has ${TOOL_NAMES.length}, expected 28`)
check('tools/DESIGN', /28 个工具|28 tools/.test(design), 'DESIGN does not mention 28 tools')

// 2. Gate order: thirteen gates in the documented order.
check('gates', GATE_ORDER.length === 13, `GATE_ORDER has ${GATE_ORDER.length}, expected 13`)
check('gates/DESIGN', /PG-01\s*[~-]\s*PG-13/.test(design), 'DESIGN does not mention PG-01~PG-13')

// 3. Operation count.
check('operations', OPERATIONS.length === 34, `OPERATIONS has ${OPERATIONS.length}, expected 34`)
check(
  'operations/DESIGN',
  new RegExp(`${OPERATIONS.length} 个操作`).test(design),
  `DESIGN does not say "${OPERATIONS.length} 个操作"`,
)

// 4. Style packs: eight built in, and the two catalogues agree line by line.
const { packs } = loadStyleCatalogue()
check('stylepacks', packs.length === 8, `compiled ${packs.length} packs, expected 8`)
const summaries = stylePackSummaries()
check('stylepacks/guide', summaries.length === 8, `guide lists ${summaries.length}, expected 8`)
// The tool description is a static string (apply() does no IO); the guide is
// generated from the catalogue. This assertion is the only thing keeping the two
// from drifting apart.
check('stylepacks/lines', STYLE_PACK_LINES.length === 8, `STYLE_PACK_LINES has ${STYLE_PACK_LINES.length}`)
for (const [index, line] of STYLE_PACK_LINES.entries()) {
  const summary = summaries[index]
  if (summary === undefined) {
    problems.push(`stylepacks/lines: no summary for line ${index}`)
    continue
  }
  const expected = `${summary.id} ${summary.name}：${summary.description}`
  check('stylepacks/lines', line === expected, `line ${index} is "${line}", expected "${expected}"`)
}

// 5. The ledgers the archive transaction writes.
//
// 0.2.20 review 4: this used to assert `LEDGERS.length === 8` against a literal
// list typed into this file — a tautology that could not fail, and that named
// the ledgers the engine had two releases ago without noticing. The list now
// comes from `STATE_FILES`, and every ledger must be *described* by the state
// contract doc, not merely mentioned somewhere in it.
const LEDGERS = Object.keys(STATE_FILES).filter((key) => key !== 'pipeline' && key !== 'journal')
const statesDoc = read('docs/states.md')
check('ledgers', LEDGERS.length === 8, `STATE_FILES has ${LEDGERS.length} ledgers, expected 8`)
check('ledgers/DESIGN', /八本台账|8 本台账|八个台账/.test(design), 'DESIGN does not mention eight ledgers')
for (const ledger of LEDGERS) {
  check(
    `ledgers/${ledger}`,
    statesDoc.includes(`state/${ledger}.yaml`) || statesDoc.includes(`${ledger}.yaml`),
    `docs/states.md does not describe state/${ledger}.yaml`,
  )
}

// 6. The rulepack contract doc must describe the 0.2.17 blocks it ships.
// A block nobody documented is a block nobody can safely author.
const rulepackDoc = read('docs/rulepack.md')
for (const block of ['ai_tone', 'abstract_emotion', 'metaphor', 'emotion_cues']) {
  check(`rulepack/${block}`, rulepackDoc.includes(block), `docs/rulepack.md does not mention ${block}`)
}
const shipped = read('rulepacks/default.yaml')
check('rulepack/ai_tone ships', shipped.includes('ai_tone:'), 'rulepacks/default.yaml has no ai_tone block')
// Every AI_TONE code the engine registers must appear in the doc.
for (const code of [
  'AI_TONE_META',
  'AI_TONE_ACK',
  'AI_TONE_COMPARATIVE',
  'AI_TONE_PROTECTIVE',
  'AI_TONE_SOCRATIC',
  'AI_TONE_TEMPLATE',
  'AI_TONE_JUDGMENT',
]) {
  check(`rulepack/${code}`, rulepackDoc.includes(code), `docs/rulepack.md does not mention ${code}`)
}

// 7. The state contract doc must describe the project's style field.
check('states/style', statesDoc.includes('style'), 'docs/states.md does not mention style')

// 8. 0.2.19: the thirteen submission self-check items are one table in code and
// one document for the author. Assert both, line by line, so a renamed row or a
// changed basis is a red build instead of a wrong answer the model reads out.
const selfCheckDoc = read('docs/selfcheck.md')
for (const entry of SELF_CHECK_SPEC) {
  check(
    `selfcheck/${entry.id}`,
    selfCheckDoc.includes(`| \`${entry.id}\` |`),
    `docs/selfcheck.md has no row for ${entry.id}`,
  )
  check(
    `selfcheck/${entry.id}/title`,
    selfCheckDoc.includes(entry.title),
    `docs/selfcheck.md does not carry the checklist wording of ${entry.id}`,
  )
  // The basis must sit in *this row* of the table. `includes()` on the whole
  // document was satisfied by the basis legend above it, so every row could
  // claim any basis and the gate stayed green.
  const row = selfCheckDoc
    .split('\n')
    .find((line) => line.startsWith('|') && line.includes(`\`${entry.id}\``))
  check(
    `selfcheck/${entry.id}/basis`,
    row !== undefined && row.includes(`\`${entry.basis}\``),
    `docs/selfcheck.md row ${entry.id} does not state its basis ${entry.basis}`,
  )
}
check('selfcheck/count', SELF_CHECK_SPEC.length === 13, `SELF_CHECK_SPEC has ${SELF_CHECK_SPEC.length} rows`)

// The three briefs that carry the checklist must name it, or the model is scored
// against a table it never saw.
for (const [stage, needles] of [
  ['P3', ['投稿自查清单', '13']],
  ['P4', ['self_check', 'machine_scores', 'must_answer']],
  // 0.2.20: the P6 brief no longer carries `self_check` (only P3/P4 do), so the
  // page must name the eight model-judged ids instead of a field it cannot see.
  ['P6', ['自查清单复核', 'SC-CONCRETE', 'SC-QUOTE']],
]) {
  const brief = read(`briefs/${stage}.md`)
  for (const needle of needles) {
    check(`briefs/${stage}`, brief.includes(needle), `briefs/${stage}.md does not mention ${needle}`)
  }
}

// 0.2.20 WP6: the README's test-file count is generated, not remembered.
// It used to say "117 个测试文件" while the suite ran 120, then 121 — a number
// nobody updates is a number that lies. `check:docs` counts the same globs
// vitest does (tests/** and src/**) and requires the README to agree.
const specFiles = []
const walkSpecs = (dir) => {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (['node_modules', 'lib', 'dist', '.git', 'docs'].includes(entry.name)) continue
      walkSpecs(join(dir, entry.name))
    } else if (/\.spec\.tsx?$/.test(entry.name)) {
      specFiles.push(join(dir, entry.name))
    }
  }
}
walkSpecs(join(root, 'tests'))
walkSpecs(join(root, 'src'))
const readme = read('README.md')
const claimed = /\*\*(\d+) 个测试文件/.exec(readme)
check(
  'readme/test-file-count',
  claimed !== null && Number(claimed[1]) === specFiles.length,
  `README.md claims ${claimed?.[1] ?? 'no'} test files; the suite contains ${specFiles.length}`,
)

if (problems.length > 0) {
  for (const problem of problems) console.error(`docs check failed — ${problem}`)
  process.exit(1)
}
console.log(
  `docs check passed: ${TOOL_NAMES.length} tools, ${GATE_ORDER.length} gates, ${OPERATIONS.length} operations, ${packs.length} style packs, ${LEDGERS.length} ledgers`,
)
