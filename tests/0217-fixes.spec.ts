import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { promises as fsPromises } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FsStore } from '../src/store/fs.js'
import { FileLock } from '../src/store/lock.js'
import { readJournal, reconcileJournal } from '../src/store/journal.js'
import { runTransaction, type TransactionInput } from '../src/store/txn.js'
import { countWordMetrics } from '../src/domain/wordcount.js'
import { matchEvidence } from '../src/domain/text.js'
import { evaluateSemantic } from '../src/engine/semantic.js'
import { resolveLockBaseline } from '../src/engine/entity-anchors.js'
import { advanceHandoff, projectHandoff } from '../src/engine/handoff.js'
import { markOutlineReopened } from '../src/engine/book.js'
import { applyStateDelta } from '../src/engine/state-delta.js'
import { ledgerIdFloor, ledgerReferenceProblems } from '../src/engine/service.js'
import { roundsExhausted } from '../src/domain/transitions.js'
import { createNovelTools } from '../src/tools/index.js'
import { runMachineChecks } from '../src/rules/pipeline.js'
import { loadRulepack } from '../src/rulepack.js'
import type { MachineOptions } from '../src/rules/pipeline.js'
import type { EngineService } from '../src/engine/service.js'
import type { HandoffDocument, OutlineDocument } from '../src/types.js'
import { bootstrapToDraft, cleanText, harness, sampleReview, sampleSummary, writeDraft } from './helpers.js'

const pack = loadRulepack()

const options = (overrides: Partial<MachineOptions> = {}): MachineOptions => ({
  chapter: 1,
  title: '第1章 开端之雨',
  genre: '都市现代',
  sceneType: '日常过渡章',
  rulepack: pack,
  summary: null,
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
  ...overrides,
})

const codesOf = (text: string, overrides: Partial<MachineOptions> = {}): string[] =>
  runMachineChecks(text, options(overrides)).violations.map((violation) => violation.code)

/** A project sitting at P4 with a two-paragraph draft already submitted. */
async function twoParagraphAtReview(root: string, engine: EngineService, text: string): Promise<void> {
  await engine.initProject({
    title: '测试之书',
    genre: '都市现代',
    platform: 'fanqie',
    root,
    words_per_chapter: [10, 400],
  })
  await engine.getBrief({ stage: 'P1', root })
  await engine.submitWorldPlan({
    chapter: 0,
    objective: '让主角收到一封无名信',
    constraints: [],
    characters: [],
    locations: [],
    continuity_notes: [],
    root,
  })
  await engine.getBrief({ stage: 'P2', root })
  await engine.submitChapterPlan({
    chapter: 0,
    title: '开端之雨',
    scene_type: '日常过渡章',
    narrator: '他',
    beats: ['风起', '信到', '拆封', '读信', '决定'],
    opening: '风从窗缝里挤进来',
    ending: '蜡印',
    target_words: [10, 400],
    root,
  })
  await engine.getBrief({ stage: 'P3', root })
  await engine.submitDraft({
    chapter: 1,
    content: text,
    chapter_title: '开端之雨',
    scene_type: '日常过渡章',
    narrator: '他',
    summary: sampleSummary(),
    root,
  })
  await engine.getBrief({ stage: 'P4', root })
}

describe('0.2.17 P1-01 full-width indent is not a word', () => {
  it('does not count U+3000 as a punctuation word', () => {
    const bare = '风从窗缝里挤进来，把桌上的纸吹得翻了一页。'
    const indented = `\u3000\u3000${bare}`
    expect(countWordMetrics(indented).total_word_count).toBe(countWordMetrics(bare).total_word_count)
  })

  it('reports how many indent characters were dropped', () => {
    const metrics = countWordMetrics('\u3000\u3000第一段。\n\n\u3000\u3000第二段。')
    expect(metrics.indent_chars).toBe(4)
  })

  it('keeps ordinary Chinese punctuation counted', () => {
    expect(countWordMetrics('他说：“走吧。”').chinese_punct).toBe(4)
  })
})

describe('0.2.17 P1-02 evidence may not be spliced across distant paragraphs', () => {
  it('rejects a quote stitched from three paragraphs', () => {
    const text = ['他把信封翻过去', '背面', '写着一行很小的字'].join('\n\n')
    expect(matchEvidence(text, '翻过去背面写着一行').found).toBe(false)
  })

  it('still accepts a quote that really spans two adjacent paragraphs', () => {
    const text = ['他把信封翻过去', '背面写着一行很小的字'].join('\n\n')
    const match = matchEvidence(text, '翻过去背面写着')
    expect(match.found).toBe(true)
    expect(match.via).toBe('crossline')
    expect(match.span).toEqual({ from: 1, to: 2 })
  })
})

describe('0.2.17 P1-03 PG-09 is satisfiable on short chapters', () => {
  const text = [
    '风从窗缝里挤进来，把桌上的纸吹得翻了一页。他伸手压住，指腹沾了一点灰。',
    '门被推开时带进一股凉气，来人把一只旧信封放在桌角，指尖敲了两下。',
  ].join('\n\n')

  it('accepts three distinct quotes from a two-paragraph chapter', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await twoParagraphAtReview(root, engine, text)
      const [first, second] = text.split('\n\n') as [string, string]
      const review = sampleReview(1, text)
      await expect(
        engine.submitReview({
          chapter: 1,
          dimensions: review.dimensions,
          issues: [],
          total: review.total,
          proof: {
            opening: { paragraph: 1, quote: first.slice(0, 14) },
            middle: { paragraph: 1, quote: first.slice(14, 28) },
            ending: { paragraph: 2, quote: second.slice(0, 14) },
          },
          root,
        }),
      ).resolves.toBeDefined()
    } finally {
      await cleanup()
    }
  })

  it('rejects three references that repeat the same quote', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await twoParagraphAtReview(root, engine, text)
      const [first, second] = text.split('\n\n') as [string, string]
      const review = sampleReview(1, text)
      const quote = first.slice(0, 14)
      await expect(
        engine.submitReview({
          chapter: 1,
          dimensions: review.dimensions,
          issues: [],
          total: review.total,
          proof: {
            opening: { paragraph: 1, quote },
            middle: { paragraph: 1, quote },
            ending: { paragraph: 2, quote: second.slice(0, 14) },
          },
          root,
        }),
      ).rejects.toThrow(/different|distinct/i)
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.17 P1-04 semantic evidence uses the shared matcher', () => {
  it('accepts a quote typed with curly quotes against straight-quote prose', () => {
    const text = '"你一个人住？"警察问，手还搭在门框上。'
    const evaluation = evaluateSemantic(text, [
      { id: 'L2-SCENE-ANCHOR', verdict: 'pass', evidence: '“你一个人住？”警察问' },
    ])
    const item = evaluation.items.find((entry) => entry.id === 'L2-SCENE-ANCHOR')!
    expect(item.state).toBe('pass')
  })

  it('accepts a quote that spans two adjacent paragraphs', () => {
    const text = '他把信封翻过去\n\n背面写着一行很小的字'
    const evaluation = evaluateSemantic(text, [
      { id: 'L2-SCENE-ANCHOR', verdict: 'pass', evidence: '翻过去背面写着一行' },
    ])
    const item = evaluation.items.find((entry) => entry.id === 'L2-SCENE-ANCHOR')!
    expect(item.state).toBe('pass')
  })

  it('rejects a quote stitched from three paragraphs', () => {
    const text = '他把信封翻过去\n\n背面\n\n写着一行很小的字'
    const evaluation = evaluateSemantic(text, [
      { id: 'L2-SCENE-ANCHOR', verdict: 'pass', evidence: '翻过去背面写着一行' },
    ])
    const item = evaluation.items.find((entry) => entry.id === 'L2-SCENE-ANCHOR')!
    expect(item.state).toBe('not_found')
  })
})

describe('0.2.17 P1-05 lexicon entries declare how they match', () => {
  it('does not flag 话说 in the middle of a sentence', () => {
    expect(codesOf('他话说了一半，忽然停住，把杯子放回桌上。')).not.toContain('META_NARRATION')
  })

  it('flags 话说 at the head of a paragraph', () => {
    expect(codesOf('话说那年冬天，雪下得很大。')).toContain('META_NARRATION')
  })

  it('does not flag 读者 when it is an ordinary noun', () => {
    expect(codesOf('他是这本杂志的读者，每个月都买。')).not.toContain('SYSTEM_LABEL')
  })

  it('still flags 读者 at the head of a paragraph', () => {
    expect(codesOf('读者朋友们，故事到这里就结束了。')).toContain('SYSTEM_LABEL')
  })

  it('does not flag 仿佛 inside an ordinary clause', () => {
    expect(codesOf('他站住了，仿佛一切都停了下来，连风也停了。')).not.toContain('LEX_ZERO_TOLERANCE')
  })
})

describe('0.2.17 P1-06 lock baselines accept short appearance anchors', () => {
  it('keeps a seven-character appearance as a baseline', () => {
    const resolved = resolveLockBaseline('他', 'character', {
      worldbook: null,
      world: null,
      locks: {
        schema_version: 1,
        locked_at_chapter: 1,
        characters: {
          他: { first_appearance: 1, locked_at: 1, appearance: '左边眉骨一道疤。' },
        },
        locations: {},
      },
    })
    expect(resolved.baseline?.texts).toEqual(['左边眉骨一道疤'])
    expect(resolved.gap).toBe('none')
  })

  it('reports a missing baseline instead of staying silent', () => {
    const codes = codesOf('他推门进来，在桌边坐下。', {
      evidence: {
        ...options().evidence,
        locks: {
          schema_version: 1,
          locked_at_chapter: 1,
          characters: { 他: { first_appearance: 1, locked_at: 1, appearance: '' } },
          locations: {},
        },
      },
    })
    expect(codes).toContain('LOCK_BASELINE_MISSING')
  })
})

describe('0.2.17 P1-07 handoff advances one step per skipped chapter', () => {
  const previous: HandoffDocument = {
    schema_version: 1,
    current_chapter: 1,
    volume: 1,
    volume_name: '第一卷',
    act: '第一幕',
    act_progress: '2/5',
    next_chapter: 2,
    last_summary: '',
    open_hooks: [],
    updated_at: '2026-01-01T00:00:00.000Z',
  }

  it('lands on the same position the projection reports after a three-chapter jump', () => {
    expect(advanceHandoff(previous, 4)).toEqual(projectHandoff(previous, 4))
  })

  it('refuses a backwards chapter number', () => {
    expect(() => advanceHandoff(previous, 1)).toThrow(/backwards/i)
  })
})

describe('0.2.17 P1-08 reopening clears the archived CJK count', () => {
  it('clears cjk_words on the reopened card', () => {
    const document = {
      schema_version: 1,
      updated_at: 'x',
      book: {
        premise: '',
        logline: '',
        themes: [],
        tone: '',
        pov: '',
        audience: '',
        selling_points: [],
        ending: '',
        strict: false,
      },
      volumes: [],
      chapters: [
        {
          num: 1,
          volume: 1,
          title: '开端之雨',
          scene_type: '日常过渡章',
          goal: 'g',
          conflict: 'c',
          hook: 'h',
          cast: [],
          target_words: [10, 400],
          notes: '',
          status: 'archived',
          archived_at: '2026-01-01T00:00:00.000Z',
          word_count: 2000,
          cjk_words: 1900,
          score: 140,
        },
      ],
    } as unknown as OutlineDocument
    const reopened = markOutlineReopened(document, 1, '2026-02-01T00:00:00.000Z')
    expect(reopened.chapters[0]?.cjk_words).toBeNull()
    expect(reopened.chapters[0]?.word_count).toBeNull()
  })
})

describe('0.2.17 P1-09 a location keeps its declared detail', () => {
  it('merges detail into a created location row', () => {
    const summary = sampleSummary({
      events: [],
      characters_appeared: [],
      new_elements: { locations: ['旧屋'], abilities: [], artifacts: [] },
    })
    const result = applyStateDelta({
      chapter: 1,
      text: '甲走进旧屋，横梁上挂着一盏油灯，屋里有一股霉味。',
      summary,
      delta: {
        characters: {},
        world: {
          旧屋: {
            action: 'created',
            kind: 'location',
            description: '旧屋',
            layout: '',
            capacity: 0,
            detail: { atmosphere: '潮湿' },
          },
        },
        foreshadows: {},
        timeline: {},
        relationships: {},
      } as never,
      characters: { schema_version: 1, characters: [] },
      world: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
      locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
      foreshadows: { schema_version: 1, next_seq: 1, items: [] },
      timeline: { schema_version: 1, next_seq: 1, items: [] },
      relationships: { schema_version: 1, next_seq: 1, items: [] },
    })
    const location = result.world.locations.find((row) => row.name === '旧屋')
    expect(location?.atmosphere).toBe('潮湿')
  })

  it('refuses a detail that rewrites a reserved location field', () => {
    const summary = sampleSummary({
      events: [],
      characters_appeared: [],
      new_elements: { locations: ['旧屋'], abilities: [], artifacts: [] },
    })
    expect(() =>
      applyStateDelta({
        chapter: 1,
        text: '甲走进旧屋，横梁上挂着一盏油灯。',
        summary,
        delta: {
          characters: {},
          world: {
            旧屋: {
              action: 'created',
              kind: 'location',
              description: '旧屋',
              layout: '',
              capacity: 0,
              detail: { capacity: 9 },
            },
          },
          foreshadows: {},
          timeline: {},
          relationships: {},
        } as never,
        characters: { schema_version: 1, characters: [] },
        world: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
        locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
        foreshadows: { schema_version: 1, next_seq: 1, items: [] },
        timeline: { schema_version: 1, next_seq: 1, items: [] },
        relationships: { schema_version: 1, next_seq: 1, items: [] },
      }),
    ).toThrow(/reserved field/i)
  })
})

describe('0.2.17 P1-10 the brief reports its real size in UTF-8 bytes', () => {
  it('reports used as the byte length of the returned context', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({
        title: '中文项目标题',
        genre: '都市现代',
        platform: 'fanqie',
        root,
        words_per_chapter: [80, 400],
      })
      const brief = await engine.getBrief({ stage: 'P1', root })
      const context = brief.data.context as Record<string, unknown>
      const meta = context.context_meta as { used: number; complete: boolean }
      const bytes = Buffer.byteLength(JSON.stringify(context), 'utf8')
      // The reported size is the size of the document the caller holds, and the
      // document is complete — the 0.2.17 removal of the context budget means
      // `used` no longer gates anything, only reports.
      expect(meta.used).toBe(bytes)
      expect(meta.complete).toBe(true)
      expect(bytes).toBeGreaterThan(JSON.stringify(context).length)
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.17 P1-11 a damaged receipt file is repairable, not a deadlock', () => {
  it('points status at novel_amend and reports the state error', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '收据损坏', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      await writeFile(join(root, 'state/briefs.yaml'), 'receipts: not-an-array\n', 'utf8')
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors.some((error) => error.code === 'BRIEFS_UNREADABLE')).toBe(true)
      expect(status.data.next.tool).toBe('novel_amend')
      expect(String(status.data.next.args.path)).toContain('briefs.yaml')
      const doctor = await engine.doctor({ root })
      expect(doctor.data.ok).toBe(false)
      expect(doctor.data.checks.some((check) => check.id.includes('briefs.yaml'))).toBe(true)
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.17 P1-12 a blocker cannot be marked fixed without evidence', () => {
  it('rejects an amendment that clears a blocker with no quote', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({
        chapter: 1,
        ...sampleReview(1, text, {
          issues: [
            {
              id: 'REV-001',
              severity: 'blocker',
              dimension: 'R-W-01',
              location: '第 2 段',
              problem: '动作缺少动机',
              fix: '补一句动机',
              status: 'open',
            },
          ],
        }),
        root,
      })
      await expect(
        engine.submitReview({
          chapter: 1,
          amend_issues: [{ id: 'REV-001', status: 'fixed' }],
          amend_note: 'try to clear it without proof',
          root,
        }),
      ).rejects.toThrow(/evidence/i)
      // The same amendment succeeds once the quote is real.
      const quote = cleanText().split('\n\n')[1]!.slice(0, 14)
      await expect(
        engine.submitReview({
          chapter: 1,
          amend_issues: [{ id: 'REV-001', status: 'fixed', evidence: quote }],
          amend_note: 'quote the revised sentence',
          root,
        }),
      ).resolves.toBeDefined()
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.17 P1-13 the ledger id floor is shared by restore and amend', () => {
  it('counts content-only check attempts against the check budget', () => {
    expect(roundsExhausted({ review: 0, revise: 0, check: 0, partial_checks: 3 }, 'check')).toBe(true)
    expect(roundsExhausted({ review: 0, revise: 0, check: 0, partial_checks: 2 }, 'check')).toBe(false)
  })
  it('returns the highest suffix the archive already issued', () => {
    const chapters = {
      schema_version: 1,
      chapters: [
        { num: 1, assigned_ids: { 'FS-001': 'FS-001', 'TE-004': 'TE-004' } },
        { num: 2, assigned_ids: { 'FS-007': 'FS-007' } },
      ],
    } as unknown as Parameters<typeof ledgerIdFloor>[1]
    expect(ledgerIdFloor('foreshadows', chapters, null)).toBe(7)
    expect(ledgerIdFloor('timeline', chapters, null)).toBe(4)
    expect(ledgerIdFloor('relationships', chapters, null)).toBe(0)
  })

  it('reports a lock on a location the world ledger does not declare', () => {
    const problems = ledgerReferenceProblems(
      {
        characters: { schema_version: 1, characters: [] },
        locks: {
          schema_version: 1,
          locked_at_chapter: 1,
          characters: {},
          locations: { 旧屋: { first_appearance: 1, locked_at: 1, layout: '', capacity: 0 } },
        },
        timeline: { schema_version: 1, next_seq: 1, items: [] },
        relationships: { schema_version: 1, next_seq: 1, items: [] },
        handoff: null,
        world: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
      },
      null,
    )
    expect(problems.join('; ')).toContain('locks.locations["旧屋"]')
  })
})

describe('0.2.17 P1-19/P1-20 tool renderers show every issued brief and the warnings', () => {
  const tools = createNovelTools({} as never, { toolsMode: 'all' } as never)
  const tool = (name: string) => {
    const found = tools.find((entry) => entry.name === name)
    if (found === undefined) throw new Error(`${name} is not registered`)
    return found as unknown as {
      output: { render: (args: unknown, raw: unknown) => Array<{ text: string }> }
    }
  }

  it('renders both stages of a batch brief', () => {
    const rendered = tool('novel_brief').output.render(
      {},
      {
        stage: 'P6',
        chapter: 1,
        digest: 'd6',
        content: 'P6 任务书',
        briefs: [
          { stage: 'P6', chapter: 1, digest: 'd6', content: 'P6 任务书' },
          { stage: 'P8', chapter: 1, digest: 'd8', content: 'P8 任务书' },
        ],
      },
    )
    const body = rendered.map((part) => part.text).join('\n')
    expect(body).toContain('P6 任务书')
    expect(body).toContain('P8 任务书')
    expect(body).toContain('d8')
  })

  it('renders crash-recovery warnings and unreadable state documents', () => {
    const rendered = tool('novel_status').output.render(
      {},
      {
        project: { title: '测试之书' },
        chapter: 1,
        stage: 'P6',
        blocking: [],
        warnings: [{ code: 'PENDING_RECOVERABLE', message: '上一轮事务可以重放' }],
        state_errors: [
          { path: 'state/briefs.yaml', code: 'BRIEFS_UNREADABLE', message: 'receipts 不是数组' },
        ],
        next: { tool: 'novel_amend', reason: 'repair the receipt file' },
      },
    )
    const body = rendered.map((part) => part.text).join('\n')
    expect(body).toContain('PENDING_RECOVERABLE')
    expect(body).toContain('BRIEFS_UNREADABLE')
  })
})

describe('0.2.17 P1-14 the rename fallback never deletes another writer lock', () => {
  it('lets exactly one writer win on a volume without hard links', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    // FAT/SMB/WSL volumes reject `link`; the claim then goes through rename,
    // which frees the canonical path and is the race this guards.
    const link = vi
      .spyOn(fsPromises, 'link')
      .mockRejectedValue(Object.assign(new Error('no links'), { code: 'ENOSYS' }))
    try {
      const first = new FileLock(path, 1_000, 900)
      const second = new FileLock(path, 1_000, 300)
      const results = await Promise.allSettled([first.acquire(), second.acquire()])
      const winners = results.filter((result) => result.status === 'fulfilled')
      expect(winners).toHaveLength(1)
      // The loser waited and gave up rather than sharing the lock.
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
      await first.release()
      await second.release()
    } finally {
      link.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reclaims a live foreign lock whose owner left a release tombstone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'novel-lock-'))
    const path = join(dir, '.engine.lock')
    // The owner is a live process that released but could not unlink. Without
    // the tombstone this lock is indistinguishable from a running writer, so it
    // would be held until the owner exits.
    const holder = { pid: process.ppid, startedAt: new Date().toISOString(), nonce: 'released' }
    await writeFile(path, JSON.stringify(holder))
    await writeFile(
      `${path}.dead`,
      JSON.stringify({ ...holder, released_at: new Date(Date.now() - 5_000).toISOString() }),
    )
    try {
      const lock = new FileLock(path, 1_000, 800)
      await lock.acquire()
      expect(await readFile(path, 'utf8')).toContain(`"pid":${process.pid}`)
      // A successful claim clears the tombstone.
      expect(
        await stat(`${path}.dead`).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
      await lock.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('0.2.17 P1-15 a compensated transaction never blocks the next write', () => {
  it('records a terminal row and lets the following transaction commit', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '终态之书', genre: '都市现代', platform: 'fanqie', root })
      const store = new FsStore(root)
      const files = [
        { path: 'state/chapters.yaml', text: 'schema_version: 1\nchapters: []\n# a\n' },
        { path: 'state/world.yaml', text: 'schema_version: 1\nlocations: []\n# a\n' },
      ]
      // Files are renamed, then the commit fails: this is the state that used to
      // leave a partial `committed` row and make every later write TXN_ABORTED.
      await expect(
        runTransaction(store, {
          txid: 'tx-compensated',
          op: 'amend',
          chapter: 1,
          revision: 2,
          files,
          afterRename: async (_path: string, index: number) => {
            if (index === 1) throw new Error('simulated failure after renames')
          },
        } as TransactionInput),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
      const { rows } = await readJournal(store)
      const terminal = rows.filter((row) => row.txid === 'tx-compensated').map((row) => row.status)
      expect(terminal).toEqual(['rolled_back'])
      // The journal reconciles: the compensating row voids the hashes, so the
      // next write is not blocked by a phantom mismatch.
      expect((await reconcileJournal(store)).mismatches).toEqual([])
      await runTransaction(store, {
        txid: 'tx-after',
        op: 'amend',
        chapter: 1,
        revision: 3,
        files: [{ path: 'state/chapters.yaml', text: 'schema_version: 1\nchapters: []\n# b\n' }],
      } as TransactionInput)
      const after = await readJournal(store)
      expect(after.rows.filter((row) => row.txid === 'tx-after').map((row) => row.status)).toEqual([
        'committed',
      ])
    } finally {
      await cleanup()
    }
  })
})
