#!/usr/bin/env node
/** Compile the shipped taxonomy through the same code path the plugin uses. */
import { loadTaxonomy } from '../lib/index.js'

const taxonomy = loadTaxonomy(process.argv[2])
const subs = taxonomy.majors.flatMap((major) => major.subs)
const facets = new Map()
for (const tag of taxonomy.tags) facets.set(tag.facet, (facets.get(tag.facet) ?? 0) + 1)
console.log(`taxonomy v${taxonomy.taxonomyVersion}`)
console.log(`  majors: ${taxonomy.majors.length}`)
console.log(`  subs: ${subs.length}`)
console.log(`  tags: ${taxonomy.tags.length}`)
console.log(`  facets: ${[...facets.entries()].map(([facet, count]) => `${facet}=${count}`).join(' ')}`)
if (taxonomy.majors.length !== 12 || subs.length !== 100 || taxonomy.tags.length !== 137) {
  console.error('taxonomy counts must be 12 / 100 / 137')
  process.exit(1)
}
if (
  new Set(subs.map((sub) => sub.id)).size !== subs.length ||
  new Set(taxonomy.tags.map((tag) => tag.id)).size !== taxonomy.tags.length
) {
  console.error('taxonomy contains duplicate ids')
  process.exit(1)
}
for (const major of taxonomy.majors) {
  if (major.subs.length < 6 || major.subs.length > 11) {
    console.error(`major ${major.id} has ${major.subs.length} subs; expected 6..11`)
    process.exit(1)
  }
  for (const sub of major.subs) {
    if (!sub.id.startsWith(`${major.id}.`)) {
      console.error(`sub ${sub.id} is not namespaced under ${major.id}`)
      process.exit(1)
    }
  }
}
const expectedFacets = {
  world: 18,
  prot: 14,
  plot: 26,
  tone: 12,
  theme: 12,
  set: 14,
  struct: 8,
  pov: 5,
  emo: 8,
  pace: 8,
  market: 12,
}
for (const [facet, expected] of Object.entries(expectedFacets)) {
  if ((facets.get(facet) ?? 0) !== expected) {
    console.error(`facet ${facet} has ${facets.get(facet) ?? 0} tags; expected ${expected}`)
    process.exit(1)
  }
}
