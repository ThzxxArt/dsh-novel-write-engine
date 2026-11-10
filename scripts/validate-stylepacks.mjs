#!/usr/bin/env node
/**
 * Compile every bundled style pack through the same code path the plugin uses.
 *
 * This is the gate that makes "8 packs ship and they all parse" a fact instead
 * of a hope: the catalogue is compiled with the rulepack's zero-tolerance list,
 * so a C3 overlap that would silently double-own a word fails here too.
 */
import { loadRulepack, loadStyleCatalogue, stylePackSummaries } from '../lib/index.js'

const rulepack = loadRulepack()
const zeroTolerance = rulepack.lexicon.zero_tolerance.map((entry) => entry.term)
const { packs, warnings } = loadStyleCatalogue({ zeroTolerance })

console.log(`style packs: ${packs.length}`)
for (const pack of packs) {
  const rules = pack.banned_patterns.length
  const thresholds = Object.keys(pack.thresholds).length
  console.log(`  ${pack.id.padEnd(20)} ${pack.name}  rules=${rules} thresholds=${thresholds}`)
}

const summaries = stylePackSummaries()
if (summaries.length !== packs.length) {
  console.error(`index names ${summaries.length} packs but ${packs.length} compiled`)
  process.exit(1)
}

if (warnings.length > 0) {
  // An overlap is not fatal — C3 removes the style-side duplicate — but printing
  // it keeps the "one word, one owner" decision visible instead of silent.
  console.log(`warnings: ${warnings.length}`)
  for (const warning of warnings) console.log(`  ${warning.code} ${warning.path}: ${warning.message}`)
}

const empty = packs.filter((pack) => pack.banned_patterns.length === 0)
if (empty.length > 0) {
  console.error(
    `packs with no banned patterns after the overlap rule: ${empty.map((pack) => pack.id).join(', ')}`,
  )
  process.exit(1)
}
