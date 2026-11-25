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
 *
 * 0.2.20 WP7 adds a rules-diff mode:
 *
 *   NOVEL_REAL_PROJECT=/path/to/book node scripts/check-real-project.mjs --rules-dump
 *
 * It prints one JSON line per rule code (hits, blocker hits, chapters touched)
 * so a rule change can be compared before/after on the same manuscript instead
 * of argued about. Run it with the old pack, switch the pack, run it again, and
 * diff the two files.
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

const RULES_DUMP = process.argv.includes('--rules-dump')

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

if (RULES_DUMP) {
  // One pass over every archived chapter with the current rulepack. The counts
  // are per code, so a threshold change shows up as a number moving rather than
  // as an opinion.
  const { runMachineChecks } = await import('../lib/index.js')
  const { readFile } = await import('node:fs/promises')
  const { parse } = await import('yaml')
  const report = await engine.report({ root })
  const project = await engine.queryState({ kind: 'novel', root })
  // The compact `chapters` view drops `file`; the ledger itself carries the
  // manuscript path plus the archived summary each rule is judged against.
  const ledger = parse(await readFile(join(root, 'state/chapters.yaml'), 'utf8'))
  const rows = Array.isArray(ledger?.chapters) ? ledger.chapters : []
  const counts = new Map()
  let sampled = 0
  for (const row of rows) {
    const relative = typeof row.file === 'string' ? row.file : ''
    if (relative === '') continue
    const text = await readFile(join(root, relative), 'utf8').catch(() => '')
    if (text.trim() === '') continue
    sampled += 1
    const result = runMachineChecks(text, {
      chapter: row.num,
      // The ledger stores the title *body*; TITLE_FORMAT judges the rendered
      // heading. Passing the body made every chapter a false blocker.
      title: `第${row.num}章 ${row.title ?? ''}`.trim(),
      genre: project.data?.genre ?? '都市现代',
      sceneType: row.scene_type ?? '日常过渡章',
      rulepack: loadRulepack(),
      summary: row.summary ?? null,
      evidence: {
        characters: null,
        previousText: null,
        previousTexts: [],
        foreshadows: null,
        timeline: null,
        relationships: null,
        world: null,
        locks: null,
      },
    })
    for (const violation of result.violations) {
      const entry = counts.get(violation.code) ?? {
        code: violation.code,
        hits: 0,
        blockers: 0,
        chapters: new Set(),
      }
      entry.hits += 1
      if (violation.severity === 'blocker') entry.blockers += 1
      entry.chapters.add(row.num)
      counts.set(violation.code, entry)
    }
  }
  const summary = [...counts.values()]
    .map((entry) => ({
      code: entry.code,
      hits: entry.hits,
      blockers: entry.blockers,
      chapters: entry.chapters.size,
    }))
    .sort((left, right) => right.hits - left.hits)
  console.log(JSON.stringify({ archived: report.data.progress.archived, sampled, codes: summary }))
  await rm(root, { recursive: true, force: true })
  process.exit(0)
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
// 0.2.20 review: the report is windowed to fit the host result limit, so
// "every row in the payload" is no longer the contract — the window is. The
// coverage claim is: the totals still cover every archived chapter, and the
// rows that were withheld are named with their total.
const effortWindow = report.data.window?.omitted?.['effort.chapters']
const effortTotal = effortWindow?.total ?? report.data.effort.chapters.length
check(effortTotal === archived, `effort covers ${effortTotal} chapters, expected ${archived}`)
if (report.data.window !== undefined) {
  check(report.data.effort.chapters.length <= archived, 'the effort window cannot show more rows than exist')
  check(
    effortWindow === undefined || effortWindow.total === archived,
    'the effort window must name the true total',
  )
}

const brief = await engine.getBrief({ stage: 'P1', root })
const context = brief.data.context
// 0.2.20: the brief is windowed, so "all rows" is no longer the contract. The
// contract is: at least one row shows, and what was withheld is named with a
// fetch that resolves. The old assertion asked for eight foreshadows because
// 0.2.17 delivered every row and let the host prune the result instead.
check(
  (context.open_foreshadows ?? []).length >= 1,
  'P1 must show at least one open foreshadow (a window that shows none is not a window)',
)
// One summary is enough to open a chapter; the second is a bonus. The old
// ">= 2" asked for the 0.2.17 contract where every summary was delivered and the
// host pruned the payload afterwards.
check((context.recent_summaries ?? []).length >= 1, 'P1 must keep at least one recent summary')
const meta = context.context_meta ?? {}
for (const [block, row] of Object.entries(meta.omitted ?? {})) {
  check((row.shown ?? 0) > 0, `omitted block ${block} must still show at least one row`)
  check((row.shown ?? 0) <= (row.total ?? 0), `omitted block ${block} shows more rows than it has`)
}
for (const entry of meta.fetch ?? []) {
  check(
    entry.tool === 'novel_state' || entry.tool === 'novel_export',
    `fetch entry for ${entry.why ?? 'a block'} must name a real tool`,
  )
}
// 0.2.20: `required_omitted` no longer exists; the receipt is `omitted` (rows
// withheld) plus `compacted` (documents handed over as locators). Asserting the
// old field would be vacuously true — `undefined ?? 0 === 0` — which is the
// class of check this release exists to remove.
check(context.context_meta?.version === 2, 'P1 context must carry context_meta v2')
check(Array.isArray(context.context_meta?.fetch), 'context_meta.fetch must be an array')
check(
  Object.keys(context.context_meta?.omitted ?? {}).every(
    (block) => (context.context_meta.omitted[block].shown ?? 0) > 0,
  ),
  'a block listed as omitted must still show at least one row',
)

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
