#!/usr/bin/env node
/** Compile the shipped rule pack through the same code path the plugin uses. */
import { loadRulepack } from '../lib/index.js'

const pack = loadRulepack(process.argv[2])
const dimensions = pack.quality.dimensions.reduce((total, dimension) => total + dimension.max, 0)
const terms =
  pack.lexicon.zero_tolerance.length +
  pack.lexicon.soft.length +
  pack.lexicon.contextual.length +
  pack.lexicon.meta_narration.length

console.log(`rule pack ${pack.name}@${pack.version}`)
console.log(`  dimensions: ${pack.quality.dimensions.length} (sum ${dimensions})`)
console.log(`  lexicon terms: ${terms}`)
console.log(`  zero tolerance: ${pack.lexicon.zero_tolerance.length}`)
console.log(`  exemptions: ${pack.exemptions.length}`)
console.log(`  exclusion pairs: ${pack.exclusions.length}`)
console.log(`  platforms: ${Object.keys(pack.platform).length}`)
console.log(`  genres: ${Object.keys(pack.genres).length}`)
if (dimensions !== 150) {
  console.error('dimension maxima must sum to 150')
  process.exit(1)
}
