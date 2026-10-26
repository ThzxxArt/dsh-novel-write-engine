import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsStore, siblingTemp } from '../src/store/fs.js'
import { isInside, toProjectPath } from '../src/store/path.js'
import { assertJournalHealthy, appendJournal, readJournal } from '../src/store/journal.js'
import { migrateDocument } from '../src/store/migrate.js'
import { FileLock } from '../src/store/lock.js'
import { runTransaction } from '../src/store/txn.js'
import { compileRulepack } from '../src/rules/compiler.js'
import { loadRulepack } from '../src/rulepack.js'

const temp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'novel-extra-'))

describe('store extras', () => {
  it('round-trips typed documents and hashes missing files as null', async () => {
    const root = await temp()
    try {
      const store = new FsStore(root)
      const pipeline = {
        schema_version: 1 as const,
        revision: 1,
        chapter: 1,
        stage: 'idle' as const,
        rounds: {},
        briefs: {},
        blocking: [],
        last_action: null,
      }
      await store.writeDoc('state/pipeline.yaml', pipeline)
      const read = await store.readDoc('state/pipeline.yaml', 'pipeline')
      expect(read).toMatchObject({ revision: 1, stage: 'idle' })
      expect(await store.readDoc('state/none.yaml', 'pipeline')).toBeNull()
      expect(await store.hashOf('nope')).toBeNull()
      expect(await store.hashBytes('nope')).toBeNull()
      expect(await store.readBytes('nope')).toBeNull()
      expect(isInside(root, join(root, 'state/pipeline.yaml'))).toBe(true)
      expect(isInside(root, join(root, '..'))).toBe(false)
      expect(toProjectPath(root, join(root, 'state/pipeline.yaml'))).toBe('state/pipeline.yaml')
      expect(siblingTemp(join(root, 'a.txt'))).toMatch(/\.tmp$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('diagnoses a truncated journal without rewriting it', async () => {
    expect(() => assertJournalHealthy(0)).not.toThrow()
    expect(() => assertJournalHealthy(2)).toThrow(/2 malformed/)
    const root = await temp()
    try {
      const store = new FsStore(root)
      await appendJournal(store, {
        txid: 't',
        at: 'now',
        op: 'x',
        chapter: 1,
        revision: 1,
        files: [],
        status: 'aborted',
      })
      const rows = await readJournal(store)
      expect(rows.rows[0]).toMatchObject({ status: 'aborted' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('migrates a synthetic v1 → v2 chain and wraps non-error aborts', async () => {
    const chain = [{ from: 1, to: 2, migrate: (doc: Record<string, unknown>) => ({ ...doc, added: true }) }]
    expect(migrateDocument({ schema_version: 1 }, chain, 2)).toMatchObject({ schema_version: 2, added: true })
    const root = await temp()
    try {
      const store = new FsStore(root)
      await expect(
        runTransaction(store, {
          txid: 'tx',
          op: 'x',
          chapter: 1,
          revision: 1,
          files: [{ path: 'a.yaml', text: 'a' }],
          backup: false,
          afterVerify: async () => {
            throw 'plain failure'
          },
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not remove a lock owned by another process', async () => {
    const root = await temp()
    const path = join(root, '.engine.lock')
    try {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(path, JSON.stringify({ pid: 1, startedAt: new Date().toISOString() }))
      await new FileLock(path, 60_000, 10).release()
      const rows = await readJournal(new FsStore(root))
      expect(rows.rows).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('rule pack loading and edge cases', () => {
  it('fails loudly for an unreadable pack', () => {
    expect(() => loadRulepack('/definitely/not/here.yaml')).toThrow(/cannot read rule pack/)
  })

  it('rejects empty terms, negative limits, self pairs and inverted densities', () => {
    const base = () => structuredClone(loadRulepack()) as unknown as Record<string, any>
    const emptyTerm = base()
    emptyTerm.lexicon.soft.push({ term: ' ', limit: 1 })
    expect(() => compileRulepack(emptyTerm)).toThrow(/empty term/)

    const negative = base()
    negative.lexicon.soft.push({ term: '新鲜词', limit: -1 })
    expect(() => compileRulepack(negative)).toThrow(/negative/)

    const selfPair = base()
    selfPair.exclusions.push({ pair: ['SEMICOLON', 'SEMICOLON'], family: 'x' })
    expect(() => compileRulepack(selfPair)).toThrow(/with itself/)

    const emptyFamily = base()
    emptyFamily.exclusions.push({ pair: ['SEMICOLON', 'ILLEGAL_QUOTE'], family: ' ' })
    expect(() => compileRulepack(emptyFamily)).toThrow(/family is empty/)

    const inverted = base()
    inverted.punctuation.period_density = { min: 9, max: 1 }
    expect(() => compileRulepack(inverted)).toThrow(/min must not exceed max/)

    const badPattern = base()
    badPattern.lexicon.god_view.push({ pattern: '[' })
    expect(() => compileRulepack(badPattern)).toThrow(/not a valid regular expression/)
  })
})
