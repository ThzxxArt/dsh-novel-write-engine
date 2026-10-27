#!/usr/bin/env node
/**
 * T-11 release gate: every non-group plugin name in the preset must resolve
 * from a real DSH Web bundle root. Structural checks cannot catch a typo in a
 * package name; this script needs the host checkout (or an installed bundle).
 *
 * Usage: DSH_BUNDLE_ROOT=/path/to/deepseek-harness/packages/bundle/web-app \
 *        pnpm check:preset
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const bundleRoot = process.env.DSH_BUNDLE_ROOT
if (bundleRoot === undefined || bundleRoot.trim() === '') {
  console.error('DSH_BUNDLE_ROOT is required (for example packages/bundle/web-app)')
  process.exit(2)
}
const root = resolve(bundleRoot)
const require = createRequire(join(root, 'package.json'))
const patch = parseYaml(
  readFileSync(new URL('../presets/novel-write-engine.patch.yml', import.meta.url), 'utf8'),
)
const rows = patch.flatMap((operation) => operation.insert ?? [])
const config = rows[0]?.config
if (config === undefined || !Array.isArray(config.plugins)) {
  console.error('preset patch does not contain plugins[]')
  process.exit(1)
}

const names = []
const walk = (entries) => {
  for (const entry of entries) {
    if (typeof entry.name !== 'string' || entry.name === '') {
      console.error(`preset entry ${String(entry.id)} has no package name`)
      process.exit(1)
    }
    if (entry.name !== 'cordis:group') names.push(entry.name)
    if (entry.group === true && Array.isArray(entry.config)) walk(entry.config)
  }
}
walk(config.plugins)

let failures = 0
for (const name of [...new Set(names)].sort()) {
  try {
    require.resolve(name)
  } catch (error) {
    failures += 1
    console.error(
      `cannot resolve preset package ${name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
if (failures > 0) {
  console.error(`${failures} preset package name(s) do not resolve from ${root}`)
  process.exit(1)
}
console.log(`preset resolution passed for ${new Set(names).size} packages from ${root}`)
