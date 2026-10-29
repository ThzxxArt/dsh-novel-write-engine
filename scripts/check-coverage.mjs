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
const groups = [
  {
    prefix: '/src/domain/',
    floor: 100,
    expected: [
      '/src/domain/ids.ts',
      '/src/domain/index.ts',
      '/src/domain/scoring.ts',
      '/src/domain/simhash.ts',
      '/src/domain/stable.ts',
      '/src/domain/text.ts',
      '/src/domain/transitions.ts',
      '/src/domain/wordcount.ts',
    ],
  },
  { prefix: '/src/client/viewmodel.ts', floor: 95, expected: ['/src/client/viewmodel.ts'] },
  {
    prefix: '/src/engine/book.ts',
    floor: 95,
    keys: ['lines', 'statements', 'functions'],
    expected: ['/src/engine/book.ts'],
  },
  {
    prefix: '/src/engine/book.ts',
    floor: 93,
    keys: ['branches'],
    expected: ['/src/engine/book.ts'],
  },
  {
    prefix: '/src/engine/insight.ts',
    floor: 95,
    keys: ['lines', 'statements', 'functions'],
    expected: ['/src/engine/insight.ts'],
  },
  {
    prefix: '/src/engine/insight.ts',
    floor: 93,
    keys: ['branches'],
    expected: ['/src/engine/insight.ts'],
  },
]

const files = Object.entries(summary).filter(([file]) => file !== 'total')
const failures = []
for (const { prefix, floor, keys: groupKeys = keys, expected } of groups) {
  const matched = files.filter(([file]) => file.replaceAll('\\', '/').includes(prefix))
  if (matched.length === 0) {
    failures.push(`coverage group ${prefix} matched no files; the gate is not running`)
    continue
  }
  for (const wanted of expected) {
    if (!matched.some(([file]) => file.replaceAll('\\', '/').endsWith(wanted))) {
      failures.push(`coverage group ${prefix} is missing expected file ${wanted}`)
    }
  }
  for (const [file, data] of matched) {
    const normalized = file.replaceAll('\\', '/')
    for (const key of groupKeys) {
      const pct = data[key]?.pct
      if (typeof pct !== 'number' || pct < floor) {
        failures.push(`${normalized}: ${key} ${String(pct)}% < ${floor}%`)
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
