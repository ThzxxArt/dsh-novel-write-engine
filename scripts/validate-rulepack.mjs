#!/usr/bin/env node
/** Compile the shipped rule pack through the same code path the plugin uses. */
import { loadRulepack } from '../lib/index.js'

const pack = loadRulepack(process.argv[2])
const dimensions = pack.quality.dimensions.reduce((total, dimension) => total + dimension.max, 0)
const aiTone = pack.lexicon.ai_tone
const categories = Object.keys(aiTone.categories).length
const entries = aiTone.entries.length
const terms =
  pack.lexicon.zero_tolerance.length +
  pack.lexicon.soft.length +
  pack.lexicon.contextual.length +
  pack.lexicon.meta_narration.length

console.log(`rule pack ${pack.name}@${pack.version}`)
console.log(`  schema: ${String(pack.schema_version)}`)
console.log(`  dimensions: ${pack.quality.dimensions.length} (sum ${dimensions})`)
console.log(`  ai_tone: ${categories} categories / ${entries} entries`)
console.log(`  lexicon terms: ${terms}`)
console.log(`  zero tolerance: ${pack.lexicon.zero_tolerance.length}`)
console.log(`  exemptions: ${pack.exemptions.length}`)
console.log(`  exclusion pairs: ${pack.exclusions.length}`)
console.log(`  platforms: ${Object.keys(pack.platform).length}`)
console.log(`  genres: ${Object.keys(pack.genres).length}`)
console.log(
  `  genre profiles: ${Object.values(pack.genres).filter((genre) => genre.profile !== undefined).length}`,
)
if (pack.schema_version !== 2 || pack.version !== '2.0.0') {
  console.error('default rule pack must be schema_version 2 / version 2.0.0')
  process.exit(1)
}
if (categories !== 7 || entries !== 39) {
  console.error('ai_tone must contain exactly 7 categories / 39 entries')
  process.exit(1)
}
if (dimensions !== 150) {
  console.error('dimension maxima must sum to 150')
  process.exit(1)
}
