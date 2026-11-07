import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { openMemoryDb } from '../src/storage/db.js'
import { claimTask, createRun, createTasks, upsertProject } from '../src/storage/repositories/runs.js'
import { assertTaskDag } from '../src/studio/dag.js'
import { assertRunEvent, nextRunStatus } from '../src/studio/state-machines.js'
import { RUN_STATUSES, type RunStatus } from '../src/contracts/stages.js'
import { applyPolishPatch, quoteFrom } from '../src/kernel/gates/index.js'
import { loadRulepack } from '../src/rulepack.js'
import { scanAiTone } from '../src/rules/ai-tone.js'
import type { Draft, PolishPatch } from '../src/contracts/artifacts.js'

const RUN_EVENTS = ['START', 'GATE', 'PAUSE', 'RESUME', 'COMPLETE', 'FAIL', 'CANCEL', 'RETRY'] as const

describe('property invariants', () => {
  it('accepts generated DAGs and rejects a back edge', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 12 }), fc.infiniteStream(fc.nat()), (count, stream) => {
        const iterator = stream[Symbol.iterator]()
        const nodes = Array.from({ length: count }, (_, index) => {
          const dependsOn: string[] = []
          for (let earlier = 0; earlier < index; earlier += 1) {
            if ((iterator.next().value ?? 0) % 3 === 0) dependsOn.push(`n${earlier}`)
          }
          return { id: `n${index}`, dependsOn }
        })
        expect(() => assertTaskDag(nodes)).not.toThrow()
        const cyclic = nodes.map((node, index) => {
          if (index === 0) return { ...node, dependsOn: [...new Set([...node.dependsOn, `n${count - 1}`])] }
          if (index === count - 1) return { ...node, dependsOn: [...new Set([...node.dependsOn, 'n0'])] }
          return node
        })
        expect(() => assertTaskDag(cyclic)).toThrow(/cycle|DAG/u)
      }),
      { numRuns: 30 },
    )
  })

  it('never hands one task to two claims', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (count) => {
        const db = openMemoryDb()
        try {
          const projectId = upsertProject(db.orm, { root: `/tmp/p-${count}`, title: 'P' })
          const runId = createRun(db.orm, { projectId, kind: 'chapter', targetChapter: 1, input: {} })
          createTasks(
            db.orm,
            Array.from({ length: count }, () => ({
              runId,
              role: 'drafter' as const,
              kind: 'draft',
              dependsOn: [],
              input: { chapter: 1 },
            })),
          )
          const claimed = new Set<string>()
          for (let index = 0; index < count; index += 1) {
            const task = claimTask(db.orm, { runId, owner: `owner-${index}` })
            expect(task).toBeDefined()
            expect(claimed.has(task!.id)).toBe(false)
            claimed.add(task!.id)
          }
          expect(claimTask(db.orm, { runId, owner: 'late' })).toBeUndefined()
        } finally {
          db.close()
        }
      }),
      { numRuns: 20 },
    )
  })

  it('keeps the transition mirror total and legal', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<RunStatus>(...RUN_STATUSES),
        fc.constantFrom(...RUN_EVENTS),
        (from, event) => {
          let asserted = true
          try {
            assertRunEvent(from, event)
          } catch {
            asserted = false
          }
          if (!asserted) {
            expect(() => nextRunStatus(from, event)).toThrow()
          } else {
            const next = nextRunStatus(from, event)
            expect(RUN_STATUSES).toContain(next)
          }
        },
      ),
      { numRuns: 80 },
    )
  })

  it('matches quotes modulo whitespace only', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[甲乙丙丁戊己庚辛]{8,40}$/u), (text) => {
        const draft = { content: text } as Draft
        expect(quoteFrom(draft, text)).toBe(true)
        const spaced = Array.from(text).join(' ')
        expect(quoteFrom(draft, spaced)).toBe(true)
        expect(quoteFrom(draft, `${text}壬`)).toBe(false)
      }),
      { numRuns: 30 },
    )
  })

  it('applies a unique polish replace without touching anything else', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[甲乙丙丁戊己庚辛]{8,20}$/u), (before) => {
        const content = `开头。${before}结尾。`
        const draft = { content } as Draft
        const patch: PolishPatch = {
          schema_version: 2,
          kind: 'PolishPatch',
          chapter: 1,
          base_hash: 'h',
          expected_hash: 'h',
          patches: [{ anchor: before, before, after: '替换后的句子。', reason: 'test' }],
          open_questions: [],
        }
        const polished = applyPolishPatch(draft, patch)
        expect(polished.content).toBe('开头。替换后的句子。结尾。')
      }),
      { numRuns: 20 },
    )
  })

  it('never throws on arbitrary prose while scanning AI tone', () => {
    const lexicon = loadRulepack().lexicon.ai_tone!
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        const result = scanAiTone(text, lexicon, { chapter: 1 })
        expect(Array.isArray(result.findings)).toBe(true)
      }),
      { numRuns: 40 },
    )
  })
})
