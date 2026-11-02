import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import { checkReference, evaluateGates } from '../src/engine/gates.js'
import { runMachineChecks } from '../src/rules/pipeline.js'
import { emptyPipeline } from '../src/engine/state.js'
import type { GateInput } from '../src/types.js'
import { loadRulepack } from '../src/rulepack.js'
import { damagedLedgerSummary, ledgerReferenceProblems, projectPatchDelta } from '../src/engine/service.js'
import { sha256 } from '../src/store/fs.js'
import {
  archiveDelta,
  bootstrapToDraft,
  cleanText,
  harness,
  readyToArchive,
  sampleReview,
  sampleSemantic,
  sampleSummary,
  writeDraft,
} from './helpers.js'

const rulepack = loadRulepack()
const gateOptions = { rulepack, minScore: 120 }

const gateInput = (patch: Partial<GateInput> = {}): GateInput => ({
  operation: 'submitDraft',
  stage: 'P3',
  text: cleanText(),
  chapter: 1,
  project: {
    schema_version: 1,
    title: '长夜',
    genre: '都市现代',
    platform: 'fanqie',
    author: '',
    description: '',
    created_at: '2026-01-01',
    targets: { words_per_chapter: [80, 900], total_chapters: 10, dialogue_ratio: [0.1, 0.9] },
  },
  pipeline: emptyPipeline({ revision: 1, chapter: 1, stage: 'P3' }),
  chapters: { schema_version: 1, chapters: [] },
  briefDigest: null,
  briefStage: null,
  draftTitle: '开端之雨',
  sceneType: '日常过渡章',
  summary: sampleSummary(),
  review: null,
  check: null,
  semantic: [],
  proof: null,
  rounds: { review: 0, revise: 0, check: 0 },
  archive: null,
  evidence: {
    characters: null,
    foreshadows: null,
    timeline: null,
    relationships: null,
    world: null,
    locks: null,
  },
  previousText: null,
  previousTexts: [],
  priorSceneTypes: ['日常过渡章', '日常过渡章'],
  ...patch,
})

/**
 * The ten items the 0.2.14 audit left open (R1–R10). Each test below fails on
 * the tree that shipped the plan, which is the only reason to keep it.
 */

describe('R1: novel.yaml accepts a patch', () => {
  it('edits one project field by path without claiming the immutable ones', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const original = parse(await readFile(join(root, 'novel.yaml'), 'utf8')) as { title: string }
      const before = (await engine.queryState({ kind: 'pipeline', root })).data as { revision: number }
      const result = await engine.amend({
        path: 'novel.yaml',
        patch: [{ op: 'replace', path: 'title', value: '潮水与灯' }],
        reason: 'rename the book',
        root,
      })
      expect(result.data.after.title).toBe('潮水与灯')
      expect(result.data.changes).toContainEqual({
        path: 'title',
        before: original.title,
        after: '潮水与灯',
      })
      const project = parse(await readFile(join(root, 'novel.yaml'), 'utf8')) as {
        title: string
        genre: string
        platform: string
      }
      expect(project.title).toBe('潮水与灯')
      // The immutable fields must survive a patch that never mentioned them.
      expect(project.genre).not.toBe('')
      expect(project.platform).not.toBe('')
      expect((await engine.queryState({ kind: 'pipeline', root })).data).toMatchObject({
        revision: before.revision + 1,
      })
    } finally {
      await cleanup()
    }
  })

  it('patches one targets field and leaves the immutable targets intact', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const original = parse(await readFile(join(root, 'novel.yaml'), 'utf8')) as {
        targets: { words_per_chapter: [number, number]; dialogue_ratio: [number, number] }
      }
      await engine.amend({
        path: 'novel.yaml',
        patch: [{ op: 'add', path: 'targets.min_cjk_chars', value: 1200 }],
        reason: 'require a CJK floor',
        root,
      })
      const project = parse(await readFile(join(root, 'novel.yaml'), 'utf8')) as {
        targets: {
          min_cjk_chars?: number
          words_per_chapter: [number, number]
          dialogue_ratio: [number, number]
        }
      }
      expect(project.targets.min_cjk_chars).toBe(1200)
      expect(project.targets.words_per_chapter).toEqual(original.targets.words_per_chapter)
      expect(project.targets.dialogue_ratio).toEqual(original.targets.dialogue_ratio)
    } finally {
      await cleanup()
    }
  })

  it('still refuses a patch that really tries to change an immutable field', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await expect(
        engine.amend({
          path: 'novel.yaml',
          patch: [{ op: 'replace', path: 'genre', value: '科幻' }],
          reason: 'change genre',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })
})

describe('R2: a ledger restore may not dangle cross-ledger references', () => {
  it('refuses restoring a characters pre-image that another ledger still names', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = sampleSummary({ characters_appeared: ['他'] })
      await readyToArchive({ root, engine, summary })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root })
      const charactersPath = join(root, 'state/characters.yaml')
      const seeded = parse(await readFile(charactersPath, 'utf8')) as {
        characters: Array<Record<string, unknown>>
      }
      seeded.characters.push({
        name: '她',
        role: 'supporting',
        first_appearance: 1,
        profile: {},
        current_state: {},
        growth: [],
        updated_at: 1,
      })
      // This amend captures the pre-image that does NOT have 她.
      await engine.amend({
        path: 'state/characters.yaml',
        content: { schema_version: 1, ...seeded },
        reason: 'add a second character',
        root,
      })
      await engine.amend({
        path: 'state/relationships.yaml',
        content: {
          schema_version: 1,
          next_seq: 2,
          items: [
            {
              id: 'RL-001',
              a: '他',
              b: '她',
              type: '旧识',
              type_code: 'ally',
              since: 1,
              description: '旧识',
              evolution: [],
            },
          ],
        },
        reason: 'record the relationship',
        root,
      })
      const backups = (await engine.queryState({ kind: 'backups', root })).data as {
        backups: Array<{ txid?: string; name: string; files: string[] }>
      }
      const entry = backups.backups.find((row) => row.files.includes('state/characters.yaml'))!
      const txid = entry.txid ?? entry.name
      let error: unknown
      try {
        await engine.restoreBackup({ txid, paths: ['state/characters.yaml'], root })
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      expect((error as Error).message).toContain('relationships.RL-001')
      expect((error as Error).message).toContain('她')
      // This transaction captured only characters.yaml, so "also restore the
      // other ledgers in this call" is advice the author cannot follow: restore
      // can only replay pre-images the transaction recorded (B4).
      const hint = (error as { hint?: string }).hint ?? ''
      expect(hint).toContain('captured only')
      expect(hint).not.toContain('also restore')
      // Refused means untouched: the character is still declared.
      const after = parse(await readFile(charactersPath, 'utf8')) as {
        characters: Array<{ name: string }>
      }
      expect(after.characters.map((row) => row.name)).toContain('她')
    } finally {
      await cleanup()
    }
  })

  it('accepts the same restore once the dangling row is gone', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const summary = sampleSummary({ characters_appeared: ['他'] })
      await readyToArchive({ root, engine, summary })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(summary), root })
      const charactersPath = join(root, 'state/characters.yaml')
      const seeded = parse(await readFile(charactersPath, 'utf8')) as {
        characters: Array<Record<string, unknown>>
      }
      seeded.characters.push({
        name: '她',
        role: 'supporting',
        first_appearance: 1,
        profile: {},
        current_state: {},
        growth: [],
        updated_at: 1,
      })
      await engine.amend({
        path: 'state/characters.yaml',
        content: { schema_version: 1, ...seeded },
        reason: 'add a second character',
        root,
      })
      await engine.amend({
        path: 'state/relationships.yaml',
        content: {
          schema_version: 1,
          next_seq: 2,
          items: [
            {
              id: 'RL-001',
              a: '他',
              b: '她',
              type: '旧识',
              type_code: 'ally',
              since: 1,
              description: '旧识',
              evolution: [],
            },
          ],
        },
        reason: 'record the relationship',
        root,
      })
      const backups = (await engine.queryState({ kind: 'backups', root })).data as {
        backups: Array<{ txid?: string; name: string; files: string[] }>
      }
      const charactersBackup = backups.backups.find((row) => row.files.includes('state/characters.yaml'))!
      const txid = charactersBackup.txid ?? charactersBackup.name
      await expect(
        engine.restoreBackup({ txid, paths: ['state/characters.yaml'], root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      // The guard is about the dangle the restore introduces, not a ban on
      // restoring this file: clear the row and the same restore is accepted.
      await engine.amend({
        path: 'state/relationships.yaml',
        content: { schema_version: 1, next_seq: 2, items: [] },
        allow_delete: true,
        reason: 'drop the relationship',
        root,
      })
      await expect(
        engine.restoreBackup({ txid, paths: ['state/characters.yaml'], root }),
      ).resolves.toMatchObject({ data: { restored: ['state/characters.yaml'] } })
      const restoredCharacters = parse(await readFile(charactersPath, 'utf8')) as {
        characters: Array<{ name: string }>
      }
      expect(restoredCharacters.characters.map((row) => row.name)).not.toContain('她')
    } finally {
      await cleanup()
    }
  })
})

describe('R3: a damaged ledger still answers with a summary', () => {
  it('reports counts and sample ids instead of only an error and raw text', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine, summary: sampleSummary({ characters_appeared: ['他'] }) })
      await engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary({ characters_appeared: ['他'] })),
        root,
      })
      const path = join(root, 'state/characters.yaml')
      const good = await readFile(path, 'utf8')
      // Truncate mid-document: the file no longer parses, but the rows above
      // the cut are still readable evidence.
      await writeFile(path, `${good.slice(0, Math.floor(good.length / 2))}  - name: 半截行`, 'utf8')
      const damaged = (await engine.queryState({ kind: 'characters', root })).data as {
        error?: string
        damaged?: boolean
        summary?: { present: boolean; rows: number; bytes: number; sample_names: string[] }
      }
      expect(damaged.error).toBeDefined()
      expect(damaged.damaged).toBe(true)
      expect(damaged.summary?.present).toBe(true)
      expect(damaged.summary?.bytes).toBeGreaterThan(0)
      expect(damaged.summary?.rows).toBeGreaterThanOrEqual(1)
      expect(damaged.summary?.sample_names.length).toBeGreaterThanOrEqual(1)
    } finally {
      await cleanup()
    }
  })
})

describe('R4: a drifted reading-proof locator names the real paragraph', () => {
  it('quotes the opening of the paragraph the text is actually in', () => {
    const paragraphs = [
      '风从窗缝里挤进来，把桌上的纸吹得翻了一页。他伸手压住，指腹沾了一点灰。',
      '走廊尽头传来脚步声，不快不慢，在门口停了两秒。他没有抬头，只把笔帽扣紧。',
      '门被推开时带进一股凉气，来人把一只旧信封放在桌角，指尖敲了两下。',
      '他盯着那枚蜡印看了很久，最后把信封翻过去，背面写着一行很小的字。',
    ]
    const text = paragraphs.join('\n\n')
    const result = checkReference(text, {
      paragraph: 1,
      quote: '他盯着那枚蜡印看了很久',
    })
    // The quote is real, but it is the fourth paragraph, not the first.
    expect(result.actual).toBe(4)
    expect(result.problem).toContain('paragraph 4')
    expect(result.problem).toContain('starts')
    expect(result.hint).toContain('他盯着那枚蜡印看了很久')
  })
})

describe('R5: PG-04 samples quote the characters that broke the rule', () => {
  const check = (text: string): ReturnType<typeof runMachineChecks> =>
    runMachineChecks(text, {
      chapter: 1,
      title: null,
      genre: '都市现代',
      sceneType: '日常过渡章',
      rulepack,
      summary: sampleSummary(),
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
    } as Parameters<typeof runMachineChecks>[1])

  it('shows the semicolon in context', () => {
    const result = check('他数完了钱；又把账本合上，放回抽屉里。')
    const hit = result.violations.find((violation) => violation.code === 'SEMICOLON')!
    expect(hit).toBeDefined()
    expect(hit.detail).toContain('；')
    expect(hit.detail).toContain('near "')
  })

  it('shows the curly quote marks', () => {
    const result = check('他说“走吧”，然后把灯关了。')
    const hit = result.violations.find((violation) => violation.code === 'ILLEGAL_QUOTE')!
    expect(hit.detail).toContain('“')
    expect(hit.detail).toContain('near "')
  })

  it('shows the ellipsis that should be a Chinese one', () => {
    const result = check('他停在门口，想了很久...最后什么也没说。')
    const hit = result.violations.find((violation) => violation.code === 'ENGLISH_ELLIPSIS')!
    expect(hit.detail).toContain('...')
    expect(hit.detail).toContain('near "')
  })
})

describe('R6: an explicit occurrence of zero is a diagnosable error', () => {
  it('rejects occurrence 0 at the service boundary, not only in the tool schema', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = await readyToArchive({ root, engine })
      const paragraphs = text.split(/\n+/).filter((line) => line.trim() !== '')
      await engine.getBrief({ stage: 'P5', root })
      let error: unknown
      try {
        await engine.submitRevision({
          chapter: 1,
          patch: {
            expected_hash: sha256(text),
            edits: [{ old_text: paragraphs[0]!.slice(0, 10), new_text: '换一句', occurrence: 0 }],
          },
          proof: {
            opening: { paragraph: 1, quote: paragraphs[0]!.slice(0, 14) },
            middle: { paragraph: 4, quote: paragraphs[3]!.slice(0, 14) },
            ending: { paragraph: paragraphs.length, quote: paragraphs.at(-1)!.slice(0, 14) },
          },
          root,
        })
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      expect((error as Error).message).toContain('occurrence must be a positive integer')
    } finally {
      await cleanup()
    }
  })
})

describe('R7: an archived chapter records its CJK count', () => {
  it('writes cjk_words into the chapter record and the compact row', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = cleanText()
      await readyToArchive({ root, engine, text })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const stored = parse(await readFile(join(root, 'state/chapters.yaml'), 'utf8')) as {
        chapters: Array<{ cjk_words?: number; word_count: number }>
      }
      const row = stored.chapters[0]!
      expect(typeof row.cjk_words).toBe('number')
      // Punctuation is counted by word_count but not by cjk_words, so the CJK
      // number must be the smaller of the two.
      expect(row.cjk_words).toBeGreaterThan(0)
      expect(row.cjk_words! <= row.word_count).toBe(true)
      const compact = (await engine.queryState({ kind: 'chapters', root })).data as {
        chapters: Array<{ cjk_words: number | null }>
      }
      expect(compact.chapters[0]?.cjk_words).toBe(row.cjk_words)
      // The outline card is where an author checks the PG-03 floor, and the
      // number is archive evidence: it must be present and not editable.
      const outline = (await engine.queryState({ kind: 'outline', root })).data as {
        chapters: Array<{ num: number; cjk_words?: number | null }>
      }
      expect(outline.chapters.find((card) => card.num === 1)?.cjk_words).toBe(row.cjk_words)
      const chaptersPath = join(root, 'state/chapters.yaml')
      const document = parse(await readFile(chaptersPath, 'utf8')) as {
        chapters: Array<Record<string, unknown>>
      }
      document.chapters[0]!.cjk_words = (row.cjk_words ?? 0) + 10
      await expect(
        engine.amend({ path: 'state/chapters.yaml', content: document, reason: 'forge', root }),
      ).rejects.toThrow(/cannot change its cjk_words/)
    } finally {
      await cleanup()
    }
  })
})

describe('R8: doctor separates accepted warnings from expired baseline rows', () => {
  it('names a baseline entry that no longer reproduces', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await writeFile(
        join(root, 'state/doctor-baseline.yaml'),
        stringify({
          schema_version: 1,
          updated_at: '2026-01-01T00:00:00.000Z',
          entries: [{ id: 'legacy-data', detail: '这条告警早已修好，基线里还在' }],
        }),
        'utf8',
      )
      const report = (await engine.doctor({ root })).data
      const stale = report.checks.find((row) => row.id === 'doctor-baseline-stale')
      expect(stale).toBeDefined()
      expect(stale?.detail).toContain('1 条基线条目已不再复现')
      expect(stale?.detail).toContain('legacy-data')
      // Nothing was suppressed, so the accepted-warnings row must not appear.
      expect(report.checks.some((row) => row.id === 'doctor-baseline')).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('rewrites the baseline to the warnings that still reproduce', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const path = join(root, 'state/doctor-baseline.yaml')
      await writeFile(
        path,
        stringify({
          schema_version: 1,
          updated_at: '2026-01-01T00:00:00.000Z',
          entries: [{ id: 'legacy-data', detail: 'expired row' }],
        }),
        'utf8',
      )
      await engine.doctor({ root, baseline: true })
      const rewritten = parse(await readFile(path, 'utf8')) as {
        entries: Array<{ id: string; detail: string }>
      }
      expect(rewritten.entries.some((row) => row.detail === 'expired row')).toBe(false)
      const report = (await engine.doctor({ root })).data
      expect(report.checks.some((row) => row.id === 'doctor-baseline-stale')).toBe(false)
    } finally {
      await cleanup()
    }
  })
})

describe('R9: pipeline carries the archived chapter effort', () => {
  it('reports the same previous_chapter_effort status does', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const pipeline = (await engine.queryState({ kind: 'pipeline', root })).data as {
        previous_chapter_effort?: { chapter: number; reviews: number; final_check: string | null }
      }
      const status = (await engine.getStatus({ root })).data
      expect(pipeline.previous_chapter_effort).toBeDefined()
      expect(pipeline.previous_chapter_effort?.chapter).toBe(1)
      expect(pipeline.previous_chapter_effort?.reviews).toBeGreaterThan(0)
      expect(pipeline.previous_chapter_effort).toEqual(status.previous_chapter_effort)
    } finally {
      await cleanup()
    }
  })
})

describe('A20: pipeline names the store that actually answered', () => {
  it('does not claim a receipt file a legacy book does not have', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: 'probe', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      const file = join(root, 'state/briefs.yaml')
      const briefsText = await readFile(file, 'utf8')
      await rm(file)
      // Pre-0.2.13 shape: one receipt in pipeline.briefs, no receipt file.
      const pipelinePath = join(root, 'state/pipeline.yaml')
      const pipeline = parse(await readFile(pipelinePath, 'utf8')) as Record<string, unknown>
      pipeline.briefs = {
        '1:P1': { digest: 'a'.repeat(16), issued_at: '2026-10-01T00:00:00.000Z' },
      }
      await writeFile(pipelinePath, stringify(pipeline), 'utf8')
      const legacy = (await engine.queryState({ kind: 'pipeline', root })).data as {
        briefs_source: string
      }
      expect(legacy.briefs_source).toBe('pipeline.briefs (legacy)')
      // Restoring the file makes it authoritative; the legacy map is ignored.
      await writeFile(file, briefsText, 'utf8')
      const current = (await engine.queryState({ kind: 'pipeline', root })).data as {
        briefs_source: string
      }
      expect(current.briefs_source).toBe('state/briefs.yaml (pipeline.briefs ignored)')
      // With the legacy map gone, the file is the only source.
      pipeline.briefs = {}
      await writeFile(pipelinePath, stringify(pipeline), 'utf8')
      const onlyFile = (await engine.queryState({ kind: 'pipeline', root })).data as {
        briefs_source: string
      }
      expect(onlyFile.briefs_source).toBe('state/briefs.yaml')
    } finally {
      await cleanup()
    }
  })
})

describe('R2/R3 internals: every dangling reference and every damaged shape', () => {
  it('names locks, timeline, relationships and handoff problems', () => {
    const documents = {
      characters: {
        schema_version: 1 as const,
        characters: [
          {
            name: '他',
            role: 'protagonist' as const,
            first_appearance: 1,
            profile: {},
            current_state: {},
            growth: [],
            updated_at: 1,
          },
        ],
      },
      locks: {
        schema_version: 1 as const,
        locked_at_chapter: 1,
        characters: {
          他: { first_appearance: 1, locked_at: 1, appearance: '他' },
          她: { first_appearance: 1, locked_at: 1, appearance: '她' },
        },
        locations: {},
      },
      timeline: {
        schema_version: 1 as const,
        next_seq: 1,
        items: [
          {
            id: 'TL-001',
            chapter: 1,
            story_time: '夜',
            description: '她来了',
            location: '',
            characters: ['她'],
          },
        ],
      },
      relationships: {
        schema_version: 1 as const,
        next_seq: 1,
        items: [
          {
            id: 'RL-001',
            a: '他',
            b: '她',
            type: '旧识',
            since: 1,
            description: '旧识',
            evolution: [],
          },
        ],
      },
      handoff: {
        schema_version: 1 as const,
        current_chapter: 9,
        volume: 7,
        volume_name: '第一卷',
        act: '第一幕',
        act_progress: '1/3',
        next_chapter: 5,
        last_summary: '',
        open_hooks: [],
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    }
    const problems = ledgerReferenceProblems(documents, 3)
    expect(problems.some((row) => row.startsWith('locks.characters["她"]'))).toBe(true)
    expect(problems.some((row) => row.startsWith('timeline.TL-001 names "她"'))).toBe(true)
    expect(problems.some((row) => row.startsWith('relationships.RL-001 names "她"'))).toBe(true)
    expect(problems.some((row) => row.startsWith('handoff.volume 7 exceeds targets.total_chapters 3'))).toBe(
      true,
    )
    expect(problems.some((row) => row.includes('current_chapter 9 is ahead of next_chapter 5'))).toBe(true)
    // No handoff and no chapter target: nothing to compare, nothing to report.
    expect(ledgerReferenceProblems({ ...documents, handoff: null }, null)).toHaveLength(3)
  })

  it('summarizes a damaged ledger without claiming rows it cannot see', () => {
    expect(damagedLedgerSummary(null)).toEqual({ present: false })
    const raw = [
      'schema_version: 1',
      'next_seq: 4',
      'items:',
      '  - id: FS-001',
      '    title: 旧钥匙',
      '  - id: FS-002',
      '    title: 半截',
      '  - name: 他',
    ].join('\n')
    const summary = damagedLedgerSummary(raw) as {
      present: boolean
      bytes: number
      rows: number
      next_seq: number | null
      sample_ids: string[]
      sample_names: string[]
      ends_without_newline: boolean
    }
    expect(summary.present).toBe(true)
    expect(summary.rows).toBe(2)
    expect(summary.next_seq).toBe(4)
    expect(summary.sample_ids).toEqual(['FS-001', 'FS-002'])
    expect(summary.sample_names).toEqual(['他'])
    expect(summary.ends_without_newline).toBe(true)
    expect(damagedLedgerSummary('items: []')).toMatchObject({ rows: 0, next_seq: null })
    // `locks` is the map-shaped ledger: two-space keys are its rows, so a
    // damaged one must not report zero rows and no samples.
    const locks = damagedLedgerSummary(
      [
        'schema_version: 1',
        'locked_at_chapter: 3',
        'locations: {}',
        'characters:',
        '  他:',
        '    first_appearance: 1',
        '    appearance: "未闭合',
        '  她:',
        '    first_appearance: 1',
        '    appearance: 她站在门口',
      ].join('\n'),
    ) as { rows: number; sample_names: string[] }
    expect(locks.rows).toBe(2)
    expect(locks.sample_names).toEqual(['他', '她'])
  })

  it('reduces a project patch to the fields that changed', () => {
    const base = {
      schema_version: 1,
      title: '旧名',
      genre: '都市现代',
      targets: { words_per_chapter: [2000, 3000], total_chapters: 100 },
    }
    // Nothing changed: an empty delta, not the whole document.
    expect(projectPatchDelta(base, structuredClone(base))).toEqual({})
    const titleOnly = projectPatchDelta(base, { ...structuredClone(base), title: '新名' })
    expect(titleOnly).toEqual({ title: '新名' })
    const targetOnly = projectPatchDelta(base, {
      ...structuredClone(base),
      targets: { ...base.targets, total_chapters: 120 },
    })
    expect(targetOnly).toEqual({ targets: { total_chapters: 120 } })
    // A document without targets must not invent one.
    expect(projectPatchDelta({ title: '旧名' }, { title: '新名' })).toEqual({ title: '新名' })
  })
})

describe('R10: the last four assertions that could not fail', () => {
  it('warns at P2 before a third identical scene type reaches PG-06', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const banks = [
        { place: '骑楼', object: '湿伞', act: '数铜板', sound: '叫卖声' },
        { place: '码头', object: '货箱', act: '抄货单', sound: '汽笛' },
      ]
      const prose = (index: number): string => {
        const bank = banks[index]!
        return Array.from({ length: 8 }, (_, row) =>
          row === 0
            ? `风从窗缝里挤进来，把桌上${bank.place}的${bank.object}吹得发晃，他伸手按住，又继续${bank.act}。`
            : `${bank.place}的第${row}段里，他把${bank.object}挪到一边，重新${bank.act}。${bank.sound}从巷口传过来，灯影在墙上晃了一下。`,
        ).join('\n\n')
      }
      // Two archived chapters of the same scene type: only then is a third one
      // monotony, and only then can the plan-time warning exist (M13).
      await readyToArchive({ root, engine, text: prose(0) })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      for (const index of [1]) {
        const chapter = index + 1
        await engine.getBrief({ stage: 'P1', root })
        await engine.submitWorldPlan({
          chapter: 0,
          objective: `第 ${chapter} 章目标`,
          constraints: [],
          characters: [],
          locations: [],
          continuity_notes: [],
          root,
        })
        await engine.getBrief({ stage: 'P2', root })
        await engine.submitChapterPlan({
          chapter: 0,
          title: '第二场雨',
          scene_type: '日常过渡章',
          narrator: '他',
          beats: ['起', '承', '转', '合', '收'],
          opening: '风从窗缝里挤进来，把桌上',
          ending: '灯座底下',
          target_words: [80, 400],
          root,
        })
        await engine.getBrief({ stage: 'P3', root })
        await engine.submitDraft({
          chapter,
          content: prose(index),
          chapter_title: '第二场雨',
          scene_type: '日常过渡章',
          narrator: '他',
          summary: sampleSummary(),
          root,
        })
        await engine.getBrief({ stage: 'P4', root })
        await engine.submitReview({ chapter, ...sampleReview(chapter, prose(index)), root })
        await engine.getBrief({ stage: 'P6', root })
        await engine.runCheck({ chapter, semantic: sampleSemantic(prose(index)), root })
        await engine.getBrief({ stage: 'P8', root })
        await engine.archiveChapter({
          chapter,
          state_delta: archiveDelta(sampleSummary(), { existing: ['他'] }),
          root,
        })
      }
      await engine.getBrief({ stage: 'P1', root })
      await engine.submitWorldPlan({
        chapter: 0,
        objective: '第 3 章目标',
        constraints: [],
        characters: [],
        locations: [],
        continuity_notes: [],
        root,
      })
      await engine.getBrief({ stage: 'P2', root })
      const plan = await engine.submitChapterPlan({
        chapter: 0,
        title: '第三场雨',
        scene_type: '日常过渡章',
        narrator: '他',
        beats: ['起', '承', '转', '合', '收'],
        opening: '风从窗缝里挤进来，把桌上',
        ending: '灯座底下',
        target_words: [80, 400],
        root,
      })
      expect(plan.warnings.map((warning) => warning.code)).toContain('PG-06_PLAN_CONFLICT')
    } finally {
      await cleanup()
    }
  })

  it('filters the panel advisories by instance id, not just code', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = cleanText()
      // Stop at P6: runCheck is a P6 operation, and the acknowledgement has to
      // come from the previous check document.
      await bootstrapToDraft({ root, engine })
      await writeDraft({ root, engine, text, summary: sampleSummary() })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      // A declared fact the prose never uses is a deterministic advisory. Seed
      // it before the P6 brief, or the brief is stale by construction.
      await engine.amend({
        path: 'outline/worldbook.yaml',
        content: {
          ...((await engine.queryState({ kind: 'worldbook', root })).data as Record<string, unknown>),
          facts: [{ alias: '船价', value: 300, unit: '块' }],
        },
        reason: 'seed a numeric fact',
        root,
      })
      await engine.getBrief({ stage: 'P6', root })
      const first = await engine.runCheck({
        chapter: 1,
        scope: ['content'],
        semantic: sampleSemantic(text),
        root,
      })
      const instance = first.data.advisory_instances?.find((row) => row.id.startsWith('NUMERIC_FACTS_UNUSED'))
      expect(instance).toBeDefined()
      // The differential: the panel shows the advisory before the waiver and
      // hides it after, so the assertion below can actually fail.
      const panel = await engine.panelSummary({ root })
      // The differential: before the waiver the panel lists the advisory …
      expect(JSON.stringify(panel.advisories)).toContain('NUMERIC_FACTS_UNUSED')
      // A passing check advances to P8; re-issue the P6 brief to run it again.
      await engine.getBrief({ stage: 'P6', root })
      const acked = await engine.runCheck({
        chapter: 1,
        scope: ['content'],
        semantic: sampleSemantic(text),
        acknowledge: [instance!.id],
        acknowledge_reasons: { [instance!.id]: '这一章故意不写船价' },
        root,
      })
      // `advisories` is a count; the rows are in `advisory_instances`.
      expect(
        acked.data.advisory_instances?.some((row) => row.id.startsWith('NUMERIC_FACTS_UNUSED')) ?? false,
      ).toBe(false)
      const after = await engine.panelSummary({ root })
      // … and after it, the row is gone while the same check still exists.
      expect(JSON.stringify(after.advisories)).not.toContain('NUMERIC_FACTS_UNUSED')
    } finally {
      await cleanup()
    }
  })

  it('accepts the same curly-quote quote as revision evidence and as a reading proof', async () => {
    // PG-08 only runs on a revision; asserting it on `submitReview` proved
    // nothing because the gate never executed (R10). The negative control below
    // is what makes the positive assertion meaningful.
    const text = `${cleanText()}\n\n他压低声音说："你先走。"门在他身后合上。`
    const withEvidence = (evidence: string) =>
      evaluateGates(
        gateInput({
          operation: 'submitRevision',
          stage: 'P5',
          text,
          pipeline: emptyPipeline({ revision: 1, chapter: 1, stage: 'P5' }),
          review: {
            schema_version: 1,
            chapter: 1,
            round: 1,
            content_hash: sha256(text),
            dimensions: [],
            issues: [
              {
                id: 'REV-001',
                severity: 'blocker',
                dimension: 'R-W-01',
                location: '第 1 段',
                problem: '动作缺少动机',
                fix: '补一句',
                status: 'fixed',
                evidence,
              },
            ],
            total: 150,
            proof: sampleReview(1, text).proof,
          },
        }),
        gateOptions,
      )
    // Control: PG-08 does run here and rejects an invented quote.
    expect(withEvidence('这段引文根本不在正文里出现过').blocking.some((item) => item.code === 'PG-08')).toBe(
      true,
    )
    // Same words, ASCII quotes in the manuscript and curly quotes in the review.
    const evidenceGate = withEvidence('他压低声音说：“你先走。”门在他身后合上')
    expect(evidenceGate.blocking.some((item) => item.code === 'PG-08')).toBe(false)
    const proofGate = evaluateGates(
      gateInput({
        operation: 'submitReview',
        stage: 'P4',
        text,
        pipeline: emptyPipeline({ revision: 1, chapter: 1, stage: 'P4' }),
        review: {
          schema_version: 1,
          chapter: 1,
          round: 1,
          content_hash: sha256(text),
          dimensions: [],
          issues: [],
          total: 150,
        },
        // A quote split across a line break still has to match: PG-09 reads the
        // proof from the submission, not from the review document.
        proof: {
          opening: { paragraph: 1, quote: '风从窗缝里挤进来，\n把桌上的纸吹得翻了一页' },
          middle: { paragraph: 3, quote: '门被推开时带进一股凉气，来人把一只旧信封放在桌角' },
          ending: { paragraph: 5, quote: '最后把信封翻过去，背面写着一行很小的字' },
        },
      }),
      gateOptions,
    )
    expect(proofGate.blocking.some((item) => item.code === 'PG-09')).toBe(false)
  })
})

describe('R5/R8 edges: the excerpt at both ends and the two deadline states', () => {
  const check = (text: string): ReturnType<typeof runMachineChecks> =>
    runMachineChecks(text, {
      chapter: 1,
      title: null,
      genre: '都市现代',
      sceneType: '日常过渡章',
      rulepack,
      summary: sampleSummary(),
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
    } as Parameters<typeof runMachineChecks>[1])

  it('quotes a semicolon at the start and at the end of a paragraph', () => {
    const leading = check('；他把钱数完，又把账本合上。')
    const trailing = check('他把钱数完，又把账本合上；')
    for (const result of [leading, trailing]) {
      const hit = result.violations.find((violation) => violation.code === 'SEMICOLON')!
      expect(hit).toBeDefined()
      expect(hit.detail).toContain('；')
      expect(hit.detail).toContain('near "')
    }
    // A leading hit has nothing before it, so the excerpt must not start with
    // an ellipsis; a trailing one must not end with one.
    expect(leading.violations[0]!.detail).not.toContain('near "…')
    expect(trailing.violations[0]!.detail).not.toContain('…"')
  })

  it('quotes the opening of an over-long paragraph', () => {
    const long = `${'他把木箱挪到墙根，又数了一遍铜板。'.repeat(12)}`
    const result = check(long)
    const hit = result.violations.find((violation) => violation.code === 'LONG_PARAGRAPH')!
    expect(hit).toBeDefined()
    expect(hit.detail).toContain('starts "他把木箱挪到墙根')
  })

  it('separates an expired deadline from a pending one in the same report', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const characters = (await engine.queryState({ kind: 'characters', root })).data as {
        schema_version: 1
        characters: Array<Record<string, unknown>>
      }
      const first = characters.characters[0]!
      await engine.amend({
        path: 'state/characters.yaml',
        content: {
          ...characters,
          characters: [
            {
              ...first,
              current_state: {
                ...(first.current_state as object),
                deadline: 1,
                due_at: '99',
                expires: '第 9 章前',
              },
            },
          ],
        },
        reason: 'seed three deadline shapes',
        root,
      })
      const report = (await engine.doctor({ root })).data
      const row = report.checks.find((check_) => check_.id === 'scalar-state')!
      expect(row).toBeDefined()
      // Chapter 2 is the chapter being written: 1 is behind it, 99 ahead, and
      // the prose-shaped value stays unjudged.
      expect(row.detail).toContain('1 个已过期')
      expect(row.detail).toContain('1 个仍待办')
      expect(row.detail).toContain('1 个无法判断')
      expect(row.severity).toBe('warning')
    } finally {
      await cleanup()
    }
  })
})
