import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { compileRulepack } from '../src/rules/compiler.js'
import { runMachineChecks } from '../src/rules/pipeline.js'
import type { MachineOptions } from '../src/rules/pipeline.js'
import type { CharactersDocument } from '../src/types.js'

/**
 * 0.2.20 WP0: the false-positive corpus.
 *
 * Every paragraph here is a de-identified rewrite of a shape that appears in
 * real Chinese web fiction: repeated subject runs, six-item 顿号 inventories,
 * ledger lines spaced with half-width spaces, stage directions, name-first
 * lines, chapter-end markers. None of them is a defect in the manuscript, so
 * none of them may be reported as one.
 *
 * The guard has two levels, because the codes are not equally dangerous:
 *
 * 1. A `blocker` on any paragraph is a false positive, always. It stops an
 *    author from archiving a chapter they wrote on purpose.
 * 2. An `advisory` is also a false positive, except where the corpus entry
 *    lists the code in `allow` — the ledger lines are genuinely non-standard
 *    typography, so `PUNCT_STANDARD` may note them, but it may never block.
 *
 * Until WP5 lands the rule changes this file is expected to be red; `docs/0.2.20-implementation-log.md`
 * records the red run.
 */
interface CorpusEntry {
  id: string
  group: string
  trap: string
  text: string
  /**
   * The project's declared quote style (D1). Absent means the default `ascii`;
   * an entry written with 弯引号 must declare `curly`, because blocking them
   * under an `ascii` project is the rule working, not a false positive.
   */
  quotes?: 'ascii' | 'curly'
  allow?: string[]
}

const corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/prose/corpus.json', import.meta.url)), 'utf8'),
) as {
  version: number
  note: string
  title: string
  characters: string[]
  entries: CorpusEntry[]
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const pack = compileRulepack(
  structuredClone(
    parseYaml(readFileSync(`${repoRoot}rulepacks/default.yaml`, 'utf8')) as Record<string, unknown>,
  ),
)

const characters: CharactersDocument = {
  schema_version: 1,
  characters: corpus.characters.map((name) => ({
    name,
    role: '配角',
    first_appearance: 1,
    profile: {},
    current_state: {},
    growth: [],
    updated_at: 1,
  })),
}

const options = (entry: CorpusEntry): MachineOptions => {
  const base: MachineOptions = {
    chapter: 1,
    title: corpus.title,
    genre: '都市现代',
    sceneType: '日常过渡章',
    rulepack: pack,
    summary: null,
    evidence: {
      characters,
      previousText: null,
      previousTexts: [],
      foreshadows: null,
      timeline: null,
      relationships: null,
      world: null,
      locks: null,
    },
  }
  // WP5 adds `quotes` to `RuleContext`. Until then the field rides along behind
  // a cast so the corpus can be written against the final contract; the cast is
  // removed in the same commit that adds the field.
  return entry.quotes === undefined ? base : ({ ...base, quotes: entry.quotes } as MachineOptions)
}

/** Codes whose thresholds 0.2.20 governs. Anything else is out of scope here. */
const TARGETED = [
  'DIALOGUE_RUN',
  'ENUMERATION',
  'FRAME_REPEAT',
  'ILLEGAL_QUOTE',
  'LONG_PARAGRAPH',
  'METAPHOR_STACK',
  'PARALLEL_RUN',
  'PUNCT_STANDARD',
  'QUOTE_UNBALANCED',
  'SHORT_PARAGRAPH',
  'CHAPTER_END_OPEN',
] as const

const describeHit = (hit: { code: string; severity: string; location: unknown; detail: string }) =>
  `${hit.code} (${hit.severity}) @ ${JSON.stringify(hit.location)} · ${hit.detail}`

describe('0.2.20 prose corpus', () => {
  it('holds fifty de-identified paragraphs across every governed shape', () => {
    expect(corpus.entries.length).toBe(50)
    expect(new Set(corpus.entries.map((entry) => entry.id)).size).toBe(50)
    const groups = new Map<string, number>()
    for (const entry of corpus.entries) {
      groups.set(entry.group, (groups.get(entry.group) ?? 0) + 1)
    }
    expect(groups.size).toBeGreaterThanOrEqual(8)
    // A guard that shrinks to three entries stops proving anything.
    for (const [group, count] of groups) expect(count, group).toBeGreaterThanOrEqual(3)
  })

  for (const entry of corpus.entries) {
    it(`${entry.id} does not trip a governed rule: ${entry.trap}`, () => {
      const { violations } = runMachineChecks(entry.text, options(entry))
      const hits = violations.filter((violation) => (TARGETED as readonly string[]).includes(violation.code))
      const allow = new Set(entry.allow ?? [])
      const unexpected = hits.filter((hit) => !allow.has(hit.code))
      // A length assertion, not a deep-equal: vitest truncates arrays to `[…]`
      // and the whole point of a corpus failure is which code fired where.
      expect(unexpected.length, unexpected.map(describeHit).join('\n')).toBe(0)
      const blockers = hits.filter((hit) => hit.severity === 'blocker')
      expect(
        blockers.length,
        `a deliberate shape must never be blocked:\n${blockers.map(describeHit).join('\n')}`,
      ).toBe(0)
    })
  }
})
