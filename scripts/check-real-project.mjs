#!/usr/bin/env node
/**
 * Opt-in acceptance against a real long-running project.
 *
 *   NOVEL_REAL_PROJECT=/path/to/book node scripts/check-real-project.mjs
 *
 * The suite runs on a temporary copy: `novel_brief` is a write operation (it
 * appends a receipt when the digest changed), so pointing it at the live
 * project would edit the author's ledger. The copy makes this genuinely
 * read-only with respect to the source.
 *
 * CI has no such project, which is why this is a script and not a test file:
 * the repository's architecture rule forbids skipped tests.
 */
import { existsSync } from 'node:fs'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EngineService, loadRulepack } from '../lib/index.js'

const source = process.env.NOVEL_REAL_PROJECT ?? ''
if (source === '' || !existsSync(join(source, 'novel.yaml'))) {
  console.error('set NOVEL_REAL_PROJECT to a project root that contains novel.yaml')
  process.exit(1)
}

const root = await mkdtemp(join(tmpdir(), 'novel-real-project-'))
await cp(source, root, { recursive: true })

const engine = new EngineService(
  {
    projectRoot: root,
    stateDir: join(tmpdir(), 'novel-real-state'),
    tools: { mode: 'all' },
    quality: { minScore: 120 },
    briefs: { overrides: '' },
    storage: { backupRetention: 5 },
  },
  () => loadRulepack(),
)

const check = (condition, message) => {
  if (!condition) throw new Error(message)
}

const status = await engine.getStatus({ root })
check((status.data.blocking ?? []).length === 0, 'status has blocking items')

const report = await engine.report({ root })
const archived = report.data.progress.archived
check(archived >= 20, `expected at least 20 archived chapters, got ${archived}`)
check(report.data.quality.samples === archived, 'quality.samples must equal the archived chapters')
check(
  report.data.quality.attempts === report.data.effort.reviews,
  'quality.attempts and effort.reviews must be one number',
)
check(report.data.effort.chapters.length === archived, 'every archived chapter needs an effort row')

const brief = await engine.getBrief({ stage: 'P1', root })
const context = brief.data.context
check((context.open_foreshadows ?? []).length >= 8, 'P1 must keep at least eight open foreshadows')
check((context.recent_summaries ?? []).length >= 2, 'P1 must keep at least two recent summaries')
check((context.context_meta?.required_omitted ?? 0) === 0, 'no required block may be omitted')

const kinds = [
  'characters',
  'world',
  'locks',
  'timeline',
  'foreshadows',
  'relationships',
  'handoff',
  'chapters',
  'pipeline',
  'briefs',
  'history',
  'backups',
  'outline',
  'worldbook',
]
for (const kind of kinds) {
  const result = await engine.queryState({ kind, root })
  const text = JSON.stringify(result.data)
  check(!text.includes('undefined'), `${kind} leaks undefined`)
  JSON.parse(text)
}

console.log(
  `real-project acceptance ok: ${archived} chapters, ` +
    `samples=${report.data.quality.samples}, attempts=${report.data.quality.attempts}, ` +
    `foreshadows=${context.open_foreshadows.length}, debt=${report.data.debt.length}`,
)

await rm(root, { recursive: true, force: true })
