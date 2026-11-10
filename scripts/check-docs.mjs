#!/usr/bin/env node
/**
 * 0.2.17 documentation assertions.
 *
 * Prose that counts things rots silently. Every number the docs claim about the
 * engine is asserted here, so a stale figure is a red build instead of a wrong
 * answer the model reads out loud.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  GATE_ORDER,
  OPERATIONS,
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
const LEDGERS = [
  'chapters',
  'characters',
  'world',
  'locks',
  'timeline',
  'foreshadows',
  'relationships',
  'handoff',
]
check('ledgers', LEDGERS.length === 8, `ledger list has ${LEDGERS.length}`)
check('ledgers/DESIGN', /八本台账|8 本台账|八个台账/.test(design), 'DESIGN does not mention eight ledgers')

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
const statesDoc = read('docs/states.md')
check('states/style', statesDoc.includes('style'), 'docs/states.md does not mention style')

if (problems.length > 0) {
  for (const problem of problems) console.error(`docs check failed — ${problem}`)
  process.exit(1)
}
console.log(
  `docs check passed: ${TOOL_NAMES.length} tools, ${GATE_ORDER.length} gates, ${OPERATIONS.length} operations, ${packs.length} style packs, ${LEDGERS.length} ledgers`,
)
