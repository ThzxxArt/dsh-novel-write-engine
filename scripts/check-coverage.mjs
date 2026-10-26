import { readFileSync } from 'node:fs'

/**
 * The per-file gate that vitest's aggregate thresholds cannot express:
 * every pure domain file must be fully covered. Other layers use the aggregate
 * thresholds in vitest.config.ts. Also prints the five weakest files so a
 * global average cannot hide a dead module.
 */
const summary = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8'))
const keys = ['lines', 'branches', 'functions', 'statements']
// Design §13.3 requires a per-file 100% gate only for the pure domain layer;
// every other layer is judged by the aggregate thresholds in vitest.config.ts.
const groups = [['/src/domain/', 100]]

const files = Object.entries(summary).filter(([file]) => file !== 'total')
const failures = []
for (const [prefix, floor] of groups) {
  for (const [file, data] of files) {
    const normalized = file.replaceAll('\\', '/')
    if (!normalized.includes(prefix)) continue
    for (const key of keys) {
      const pct = data[key]?.pct
      if (typeof pct === 'number' && pct < floor) {
        failures.push(`${normalized}: ${key} ${pct}% < ${floor}%`)
      }
    }
  }
}

const weakest = files
  .filter(([file]) => file.replaceAll('\\', '/').includes('/src/'))
  .sort((left, right) => left[1].lines.pct - right[1].lines.pct)
  .slice(0, 5)
  .map(([file, data]) => `${file.replaceAll('\\', '/').split('/src/')[1]} lines ${data.lines.pct}%`)

if (weakest.length > 0) {
  console.log(`lowest covered files:\n  ${weakest.join('\n  ')}`)
}

if (failures.length > 0) {
  console.error(`per-file coverage gate failed:\n${failures.map((line) => `  ${line}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log('per-file coverage gate passed')
}
