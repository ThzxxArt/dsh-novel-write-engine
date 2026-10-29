import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { outlineSummary, emptyOutline, worldbookBrief, worldbookCounts } from '../src/engine/book.js'
import { listHistory } from '../src/engine/history.js'
import { BACKUP_MARKER, listBackups, readBackupManifest } from '../src/store/backup.js'
import { FsStore, sha256 } from '../src/store/fs.js'
import { runMachineChecks, type MachineOptions } from '../src/rules/pipeline.js'
import { loadRulepack } from '../src/rulepack.js'
import { countWordMetrics } from '../src/domain/wordcount.js'
import type { StateDelta } from '../src/types.js'
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
const machineOptions = (): MachineOptions => ({
  chapter: 1,
  title: '第1章 开端之雨',
  genre: '都市现代',
  sceneType: '日常过渡章',
  rulepack,
  targets: { words_per_chapter: [80, 400], dialogue_ratio: [0.4, 0.6] },
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
})

describe('0.2.1 state truth', () => {
  it('uses the project target as the outline denominator and reports both coverages', () => {
    const outline = emptyOutline('2026-01-01')
    for (let num = 1; num <= 40; num += 1) {
      outline.chapters.push({
        num,
        volume: 1,
        title: `测试卡${num}`,
        scene_type: '日常过渡章',
        goal: '目标',
        conflict: '冲突',
        hook: '钩子',
        cast: [],
        target_words: [2200, 2800],
        notes: '',
        status: num === 1 ? 'archived' : 'planned',
        archived_at: num === 1 ? '2026-01-01' : null,
        word_count: num === 1 ? 2400 : null,
        score: num === 1 ? 145 : null,
      })
    }
    const progress = outlineSummary(outline, 1, 800)
    expect(progress.total).toBe(40)
    expect(progress.missingCards).toBe(760)
    expect(progress.plannedCoverage).toBeCloseTo(0.05)
    expect(progress.archivedCoverage).toBeCloseTo(0.00125)
    expect(progress.coverage).toBeCloseTo(0.05)
    expect(outlineSummary(outline, 2, 800, [1, 999]).cardCoverage).toBeCloseTo(0.5)
    const noTarget = outlineSummary(outline, 0, null)
    expect(noTarget.plannedCoverage).toBeNull()
    expect(noTarget.archivedCoverage).toBeNull()
    expect(noTarget.coverage).toBe(0)
  })

  it('separates punctuation from CJK and uses quote-bearing dialogue lines', () => {
    const metrics = countWordMetrics('“走吧。”他说。\n下一段没有引号。')
    expect(metrics.total_word_count).toBe(
      metrics.cjk_chars + metrics.english_words + metrics.numbers + metrics.punctuation_chars,
    )
    expect(metrics.chinese_punct).toBeGreaterThan(0)
    expect(metrics.english_punct).toBe(0)
    expect(metrics.dialogue_lines).toBe(1)
    expect(metrics.dialogue_ratio).toBe(0.5)
  })

  it('records gate refusals as aborted attempts and supports audit filters', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '审计之书', genre: '都市现代', platform: 'fanqie', root })
      await expect(
        engine.submitWorldPlan({
          chapter: 1,
          objective: '尚未领取 P1 任务书',
          constraints: [],
          characters: [],
          locations: [],
          continuity_notes: [],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_GATE_BLOCKED' })
      const audit = await engine.auditHistory({ status: 'aborted', op: 'submitWorldPlan', chapter: 1, root })
      expect(audit.data).toHaveLength(1)
      expect(audit.data[0]).toMatchObject({
        status: 'aborted',
        attempt: true,
        code: 'ENGINE_GATE_BLOCKED',
      })
      expect(audit.data[0]!.reason).toContain('PG-01')
      const all = await engine.auditHistory({ limit: 100, root })
      expect(all.data[0]!.seq).toBe(1)
      const page = await engine.auditHistory({ cursor: all.data[0]!.seq, limit: 100, root })
      expect(page.data.length).toBeGreaterThan(0)
      expect(page.data.every((row) => (row.seq ?? 0) > all.data[0]!.seq!)).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('keeps the P2 plan immutable and the live summary in pipeline.draft', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const planPath = join(root, 'plans', 'ch001.chapter.yaml')
      const before = await readFile(planPath, 'utf8')
      await writeDraft({ root, engine })
      expect(await readFile(planPath, 'utf8')).toBe(before)
      const pipeline = await engine.queryState({ kind: 'pipeline', root })
      expect(pipeline.data).toMatchObject({
        draft: { chapter: 1, summary: { events: ['收到无名信封'] } },
      })
    } finally {
      await cleanup()
    }
  })

  it('writes prior reviews into revision history so the report has real samples', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.rollback({ chapter: 1, toStage: 'P4', reason: '再评一次', root })
      await engine.getBrief({ stage: 'P4', root })
      const text = cleanText()
      // A different score keeps this review distinct from the first one; an
      // identical copy must not inflate report samples.
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text, { deductions: 10 }), root })
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({ chapter: 1, semantic: sampleSemantic(text), root })
      await engine.getBrief({ stage: 'P8', root })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const history = await engine.queryState({ kind: 'history', chapter: 1, root })
      const reviewEntries = (history.data as { entries: Array<{ kind: string }> }).entries.filter(
        (entry) => entry.kind === 'reviews',
      )
      expect(reviewEntries.length).toBeGreaterThan(0)
      const report = await engine.report({ root })
      expect(report.data.quality.dimensions.length).toBeGreaterThan(0)
      expect(report.data.quality.dimensions.every((dimension) => dimension.samples === 2)).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('lists backup manifests and restores the active chapter from a marked backup', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const original = await readyToArchive({ root, engine })
      await engine.rollback({ chapter: 1, toStage: 'P4', reason: '制造可恢复备份', root })
      const backups = await engine.queryState({ kind: 'backups', root })
      const entries = (
        backups.data as { backups: Array<{ name: string; files: string[]; op: string | null }> }
      ).backups
      const entry = entries.find((backup) => backup.op === 'rollback')
      expect(entry).toBeDefined()
      expect(entry!.files).toContain('chapters/chapter-001.md')
      await writeFile(join(root, 'chapters/chapter-001.md'), '外部覆盖后的正文', 'utf8')
      const restored = await engine.restoreBackup({ txid: entry!.name, chapter: 1, root })
      expect(restored.data.restored).toContain('chapters/chapter-001.md')
      expect(await readFile(join(root, 'chapters/chapter-001.md'), 'utf8')).toBe(original)
      await writeFile(join(root, 'chapters/chapter-001.md'), '第二次外部覆盖', 'utf8')
      await engine.restoreBackup({ txid: entry!.name, chapter: 1, root })
      expect(await readFile(join(root, 'chapters/chapter-001.md'), 'utf8')).toBe(original)
    } finally {
      await cleanup()
    }
  })

  it('splits advisories from blockers and acknowledges them', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.rollback({ chapter: 1, toStage: 'P6', reason: '重跑检查', root })
      await engine.getBrief({ stage: 'P6', root })
      const text = cleanText()
      const check = await engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(text),
        acknowledge: ['DIALOGUE_RATIO'],
        root,
      })
      expect(check.data.acknowledged).toContain('DIALOGUE_RATIO')
      expect(check.data.verdict).toBe('pass')
      const document = await engine.queryState({ kind: 'check', chapter: 1, root })
      const machine = (
        document.data as {
          machine: { violations: unknown[]; advisories: unknown[]; acknowledged?: string[] }
        }
      ).machine
      expect(machine.violations).toHaveLength(0)
      expect(machine.advisories.length).toBeGreaterThan(0)
      expect((document.data as { acknowledged: string[] }).acknowledged).toContain('DIALOGUE_RATIO')
    } finally {
      await cleanup()
    }
  })

  it('catches numeric contradictions and initializes missing metadata with warnings', async () => {
    const result = runMachineChecks('第一段两海里，一小时。第二段一千米，两个钟头。', machineOptions())
    expect(result.violations.map((violation) => violation.code)).toContain('NUMERIC_CONTRADICTION')
    const { root, engine, cleanup } = await harness()
    try {
      const init = await engine.initProject({
        title: '无作者之书',
        genre: '都市现代',
        platform: 'fanqie',
        root,
      })
      expect(init.warnings.map((warning) => warning.code)).toEqual(
        expect.arrayContaining(['PROJECT_AUTHOR_EMPTY', 'PROJECT_DESCRIPTION_EMPTY']),
      )
    } finally {
      await cleanup()
    }
  })

  it('accepts a patch revision only when its hash and anchors are exact', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = await readyToArchive({ root, engine })
      await engine.rollback({ chapter: 1, toStage: 'P5', reason: '补一句', root })
      await engine.getBrief({ stage: 'P5', root })
      const original = text
      const hash = sha256(original)
      await expect(
        engine.submitRevision({
          chapter: 1,
          patch: { expected_hash: 'bad', edits: [{ old_text: '风', new_text: '雨' }] },
          proof: sampleReview(1, original).proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const revision = await engine.submitRevision({
        chapter: 1,
        patch: {
          expected_hash: hash,
          edits: [{ old_text: '风从窗缝里挤进来', new_text: '雨从窗缝里挤进来' }],
        },
        summary: sampleSummary({ opening: '雨从窗缝里挤进来，把桌上的纸吹得翻了一页' }),
        proof: sampleReview(1, original.replace('风从窗缝里挤进来', '雨从窗缝里挤进来')).proof,
        root,
      })
      expect(revision.data.chapter).toBe(1)
      expect(await readFile(join(root, 'chapters/chapter-001.md'), 'utf8')).toContain('雨从窗缝里挤进来')
    } finally {
      await cleanup()
    }
  })

  it('infers the protagonist role from the narrator instead of defaulting to extra', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const summary = sampleSummary({ characters_appeared: ['他'], events: ['收到信封'] })
      const delta = archiveDelta(summary) as StateDelta
      delete delta.characters['他']!.role
      await engine.archiveChapter({ chapter: 1, state_delta: delta, root })
      const characters = await engine.queryState({ kind: 'characters', root })
      expect(
        (characters.data as { characters: Array<{ name: string; role: string }> }).characters[0]?.role,
      ).toBe('protagonist')
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.1 restore and audit guards', () => {
  it('rejects invalid, missing, out-of-chapter and archived restores without touching content', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const backups = await engine.queryState({ kind: 'backups', root })
      const entries = (
        backups.data as { backups: Array<{ name: string; op: string | null; files: string[] }> }
      ).backups
      const entry = entries.find((backup) => backup.op === 'submitDraft')
      expect(entry).toBeDefined()
      await expect(engine.restoreBackup({ txid: 'not-a-uuid', root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.restoreBackup({ txid: entry!.name, paths: [], root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.restoreBackup({ txid: 42 as never, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.restoreBackup({ txid: entry!.name, chapter: 0, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(
        engine.restoreBackup({ txid: entry!.name, paths: [1 as never], root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.restoreBackup({ txid: entry!.name, paths: 'x' as never, root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.restoreBackup({ txid: '00000000-0000-0000-0000-000000000000', root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.restoreBackup({ txid: entry!.name, paths: ['state/pipeline.yaml'], root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.restoreBackup({ txid: entry!.name, paths: ['plans/ch001.chapter.yaml'], root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      await expect(engine.restoreBackup({ txid: entry!.name, chapter: 1, root })).rejects.toMatchObject({
        code: 'ENGINE_STAGE_ORDER',
      })
    } finally {
      await cleanup()
    }
  })

  it('validates every audit filter and cursor branch', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '审计过滤', genre: '都市现代', platform: 'fanqie', root })
      await expect(engine.auditHistory({ cursor: -1, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.auditHistory({ cursor: 1.5, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.auditHistory({ since: 'not-time', root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.auditHistory({ until: 'not-time', root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.auditHistory({ chapter: 0, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(
        engine.submitWorldPlan({
          chapter: 1,
          objective: 'x',
          constraints: [],
          characters: [],
          locations: [],
          continuity_notes: [],
          root,
        }),
      ).rejects.toBeDefined()
      const aborted = await engine.auditHistory({
        status: 'aborted',
        chapter: 1,
        op: 'submitWorldPlan',
        since: '2000-01-01T00:00:00.000Z',
        until: '2999-01-01T00:00:00.000Z',
        root,
      })
      expect(aborted.data).toHaveLength(1)
      const committed = await engine.auditHistory({ status: 'committed', root })
      expect(committed.data.length).toBeGreaterThan(0)
      const none = await engine.auditHistory({ limit: 0, root })
      expect(none.data).toEqual([])
      const future = await engine.auditHistory({ since: '2999-01-01T00:00:00.000Z', root })
      expect(future.data).toEqual([])
      const page = await engine.auditHistory({ cursor: committed.data[0]!.seq, root })
      expect(page.data.length).toBeGreaterThan(0)
      expect(page.data.every((row) => row.seq! > committed.data[0]!.seq!)).toBe(true)
      expect((await engine.auditHistory({ limit: Number.NaN, root })).data.length).toBeGreaterThan(0)
      expect((await engine.auditHistory({ chapter: 999, root })).data).toEqual([])
      expect((await engine.auditHistory({ op: 'missing-op', root })).data).toEqual([])
      expect((await engine.auditHistory({ until: '2000-01-01T00:00:00.000Z', root })).data).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('covers patch-mode validation failures', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = await readyToArchive({ root, engine })
      await engine.rollback({ chapter: 1, toStage: 'P5', reason: 'patch guards', root })
      await engine.getBrief({ stage: 'P5', root })
      const proof = sampleReview(1, text).proof
      await expect(
        engine.submitRevision({ chapter: 1, patch: { expected_hash: sha256(text), edits: [] }, proof, root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(engine.submitRevision({ chapter: 1, content: '', proof, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(
        engine.submitRevision({ chapter: 1, patch: null as never, proof, root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitRevision({
          chapter: 1,
          patch: { expected_hash: 1 as never, edits: [{ old_text: '风', new_text: '雨' }] },
          proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitRevision({
          chapter: 1,
          patch: { expected_hash: sha256(text), edits: [null as never] },
          proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitRevision({
          chapter: 1,
          patch: {
            expected_hash: sha256(text),
            edits: [{ old_text: '风', new_text: '雨', occurrence: 1.5 }],
          },
          proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitRevision({
          chapter: 1,
          patch: { expected_hash: sha256(text), edits: 'x' as never },
          proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitRevision({
          chapter: 1,
          patch: {
            expected_hash: sha256(text),
            edits: [{ old_text: '风', new_text: 1 as never }],
          },
          proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitRevision({
          chapter: 1,
          content: text,
          patch: { expected_hash: sha256(text), edits: [{ old_text: '风', new_text: '雨' }] },
          proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitRevision({
          chapter: 1,
          patch: { expected_hash: sha256(text), edits: [{ old_text: '', new_text: '雨' }] },
          proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitRevision({
          chapter: 1,
          patch: {
            expected_hash: sha256(text),
            edits: [{ old_text: '风', new_text: '雨', occurrence: 0 }],
          },
          proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitRevision({
          chapter: 1,
          patch: { expected_hash: 'bad', edits: [{ old_text: '风', new_text: '雨' }] },
          proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitRevision({
          chapter: 1,
          patch: { expected_hash: sha256(text), edits: [{ old_text: '。', new_text: '！' }] },
          proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitRevision({
          chapter: 1,
          patch: {
            expected_hash: sha256(text),
            edits: [{ old_text: '风从窗缝里挤进来', new_text: '雨从窗缝里挤进来', occurrence: 2 }],
          },
          proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.1 history and backup readers', () => {
  it('lists only valid history names and filters a chapter', async () => {
    const { root, cleanup } = await harness()
    try {
      const store = new FsStore(root)
      await store.writeText('history/reviews/ch001.r0002.review.yaml', 'review: true\n')
      await store.writeText('history/reviews/ch001.r0003.check.yaml', 'wrong suffix\n')
      await store.writeText('history/checks/ch001.r0001.bad.yaml', 'bad suffix\n')
      await store.writeText('history/chapters/not-a-name.md', 'bad name\n')
      await store.writeText('history/chapters/ch002.r0001.md', 'chapter two\n')
      await store.writeText('history/plans/ch001.r0001.chapter.yaml', 'plan: true\n')
      const all = await listHistory(store)
      expect(all.map((entry) => entry.path)).toEqual([
        'history/reviews/ch001.r0002.review.yaml',
        'history/plans/ch001.r0001.chapter.yaml',
        'history/chapters/ch002.r0001.md',
      ])
      const onlyOne = await listHistory(store, 1)
      expect(onlyOne).toHaveLength(2)
      expect(await listHistory(store, 2)).toHaveLength(1)
      const originalRead = store.readText.bind(store)
      store.readText = async (path: string) => (path.includes('ch002') ? null : originalRead(path))
      expect((await listHistory(store, 2))[0]?.chars).toBe(0)
      store.readText = originalRead
    } finally {
      await cleanup()
    }
  })

  it('rejects malformed backup manifests and tolerates unmarked directories', async () => {
    const { root, cleanup } = await harness()
    try {
      const store = new FsStore(root)
      const valid = '11111111-1111-1111-1111-111111111111'
      const unmarked = '22222222-2222-2222-2222-222222222222'
      const malformed = '33333333-3333-3333-3333-333333333333'
      const wrongShape = '44444444-4444-4444-4444-444444444444'
      const noManifest = '55555555-5555-5555-5555-555555555555'
      await store.writeText(`backups/${valid}/${BACKUP_MARKER}`, '1')
      await store.writeText(
        `backups/${valid}/manifest.json`,
        JSON.stringify({
          schema_version: 1,
          txid: valid,
          op: 'submitReview',
          chapter: 1,
          revision: 2,
          at: '2026-01-01T00:00:00.000Z',
          reason: 'test',
          files: ['chapters/chapter-001.md'],
        }),
      )
      await store.writeText(`backups/${unmarked}/manifest.json`, '{}')
      await store.writeText(`backups/${malformed}/${BACKUP_MARKER}`, '1')
      await store.writeText(`backups/${malformed}/manifest.json`, '{oops')
      await store.writeText(`backups/${wrongShape}/${BACKUP_MARKER}`, '1')
      await store.writeText(`backups/${wrongShape}/manifest.json`, '{"schema_version":1}')
      await store.writeText(`backups/${noManifest}/${BACKUP_MARKER}`, '1')
      expect(await readBackupManifest(store, 'bad')).toBeNull()
      expect(await readBackupManifest(store, unmarked)).toBeNull()
      expect(await readBackupManifest(store, malformed)).toBeNull()
      expect(await readBackupManifest(store, wrongShape)).toBeNull()
      expect(await readBackupManifest(store, noManifest)).toBeNull()
      expect(await readBackupManifest(store, valid)).toMatchObject({
        chapter: 1,
        files: ['chapters/chapter-001.md'],
      })
      const listed = await listBackups(store)
      expect(listed.find((entry) => entry.name === valid)).toMatchObject({
        op: 'submitReview',
        chapter: 1,
        files: ['chapters/chapter-001.md'],
      })
      expect(listed.find((entry) => entry.name === noManifest)).toMatchObject({ op: null, chapter: null })
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.1 quality rules branches', () => {
  it('covers dialogue target boundaries and numeric no-op paths', () => {
    const codes = (text: string, options = machineOptions()): string[] =>
      runMachineChecks(text, options).violations.map((violation) => violation.code)
    expect(codes('“走吧。”\n他说。')).not.toContain('DIALOGUE_RATIO')
    expect(codes('“走吧。”\n“好。”')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codes('两海里，一小时。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codes('一小时，两个钟头。')).not.toContain('NUMERIC_CONTRADICTION')
    expect(codes('零小时，两海里。')).not.toContain('NUMERIC_CONTRADICTION')
    const consistent = codes('两海里，一小时。四公里，一小时。')
    expect(consistent).not.toContain('NUMERIC_CONTRADICTION')
    expect(codes('一万米，一小时。一千米，一小时。')).toContain('NUMERIC_CONTRADICTION')
    const explicit = codes('第一段时速两海里。第二段时速一千米。')
    expect(explicit).toContain('NUMERIC_CONTRADICTION')
    const differentSubjects = runMachineChecks(
      '他的车速每小时六十公里，码头上那艘船的速度是十二海里。',
      machineOptions(),
    )
    expect(
      differentSubjects.violations.find((violation) => violation.code === 'NUMERIC_CONTRADICTION')?.severity,
    ).toBe('advisory')
    const factsOptions = machineOptions()
    factsOptions.facts = [
      { alias: '船费', value: 300, unit: '蚊' },
      { alias: '房租', value: 100, unit: '蚊', tolerance: 5 },
      { alias: '不存在', value: 1, unit: '个' },
      { alias: '无数字', value: 1, unit: '个' },
    ]
    const factCodes = codes('船费三百五十蚊，房租九十八蚊。', factsOptions)
    expect(factCodes).toContain('NUMERIC_FACT_MISMATCH')
    expect(factCodes.filter((code) => code === 'NUMERIC_FACT_MISMATCH')).toHaveLength(1)
    expect(codes('无数字。', factsOptions)).not.toContain('NUMERIC_FACT_MISMATCH')
    expect(codes('船费三百蚊。', machineOptions())).not.toContain('NUMERIC_FACT_MISMATCH')
    const priceOptions = machineOptions()
    priceOptions.facts = [{ alias: '船价', value: 3000, unit: '元' }]
    expect(codes('船价不低，他数了三遍才把银元收好，又叫来两个伙计。', priceOptions)).not.toContain(
      'NUMERIC_FACT_MISMATCH',
    )
    expect(codes('船费三百蚊。船费三百五十蚊。', factsOptions)).toContain('NUMERIC_FACT_MISMATCH')
    const invalidFacts = machineOptions()
    invalidFacts.facts = [
      { alias: '', value: 1, unit: '元' },
      { alias: '坏值', value: Number.NaN, unit: '元' },
    ]
    expect(codes('坏值一元。', invalidFacts)).not.toContain('NUMERIC_FACT_MISMATCH')
  })
})

describe('0.2.1 restore document kinds', () => {
  it('restores plan, review and check documents and rejects empty/invalid backups', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const store = new FsStore(root)
      const txid = 'aaaaaaaa-1111-4111-8111-111111111111'
      const emptyTxid = 'bbbbbbbb-2222-4222-8222-222222222222'
      const invalidTxid = 'cccccccc-3333-4333-8333-333333333333'
      const plan = `${await readFile(join(root, 'plans/ch001.chapter.yaml'), 'utf8')}cast:\n  - name: 他\n`
      const world = await readFile(join(root, 'plans/ch001.world.yaml'), 'utf8')
      const review = JSON.stringify({
        schema_version: 1,
        chapter: 1,
        round: 1,
        content_hash: 'h',
        dimensions: [],
        issues: [],
        total: 150,
      })
      const check = JSON.stringify({
        schema_version: 1,
        chapter: 1,
        scope: ['content'],
        content_hash: 'h',
        machine: { violations: [], metrics: {} },
        semantic: { items: [] },
        verdict: 'pass',
      })
      const manifest = (name: string, files: string[]): string =>
        JSON.stringify({
          schema_version: 1,
          txid: name,
          op: 'test',
          chapter: 1,
          revision: 1,
          at: '2026-01-01T00:00:00.000Z',
          files,
        })
      for (const [name, docs] of [
        [txid, { plan, world, review, check }],
        [emptyTxid, {}],
        [invalidTxid, { review: '{"schema_version":1}' }],
      ] as const) {
        await store.writeText(`backups/${name}/${BACKUP_MARKER}`, '1')
        const files = Object.keys(docs)
        const paths = files.map((value) =>
          value === 'plan'
            ? 'plans/ch001.chapter.yaml'
            : value === 'world'
              ? 'plans/ch001.world.yaml'
              : value === 'review'
                ? 'reviews/ch001.review.yaml'
                : 'checks/ch001.check.yaml',
        )
        await store.writeText(
          `backups/${name}/manifest.json`,
          manifest(name, name === emptyTxid ? ['state/pipeline.yaml'] : paths),
        )
        if (files.includes('plan')) await store.writeText(`backups/${name}/plans/ch001.chapter.yaml`, plan!)
        if (files.includes('world')) await store.writeText(`backups/${name}/plans/ch001.world.yaml`, world!)
        if (files.includes('review'))
          await store.writeText(`backups/${name}/reviews/ch001.review.yaml`, docs.review!)
        if (files.includes('check')) await store.writeText(`backups/${name}/checks/ch001.check.yaml`, check)
      }
      const restored = await engine.restoreBackup({ txid, chapter: 1, root })
      expect(restored.data.restored).toEqual(
        expect.arrayContaining([
          'plans/ch001.chapter.yaml',
          'plans/ch001.world.yaml',
          'reviews/ch001.review.yaml',
          'checks/ch001.check.yaml',
        ]),
      )
      const crossTxid = 'eeeeeeee-4444-4444-8444-444444444444'
      await store.writeText(`backups/${crossTxid}/${BACKUP_MARKER}`, '1')
      await store.writeText(
        `backups/${crossTxid}/manifest.json`,
        manifest(crossTxid, ['plans/ch001.chapter.yaml']),
      )
      await store.writeText(
        `backups/${crossTxid}/plans/ch001.chapter.yaml`,
        plan.replace('chapter: 1', 'chapter: 2'),
      )
      await expect(
        engine.restoreBackup({ txid: crossTxid, chapter: 1, paths: ['plans/ch001.chapter.yaml'], root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })

      await expect(engine.restoreBackup({ txid: emptyTxid, chapter: 1, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(
        engine.restoreBackup({
          txid: invalidTxid,
          chapter: 1,
          paths: ['reviews/ch001.review.yaml'],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.1 query edge cases', () => {
  it('returns empty receipts for malformed brief state and reads a history revision', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.rollback({ chapter: 1, toStage: 'P6', reason: 'history read', root })
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(await readFile(join(root, 'chapters/chapter-001.md'), 'utf8')),
        root,
      })
      await engine.rollback({ chapter: 1, toStage: 'P6', reason: 'again', root })
      await engine.getBrief({ stage: 'P6', root })
      const pipeline = await engine.queryState({ kind: 'pipeline', root })
      expect((pipeline.data as { briefs: Record<string, unknown> }).briefs.P6).toBeDefined()
      await expect(
        engine.queryState({ kind: 'history', chapter: 1, revision: 1.5, root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const listed = await engine.queryState({ kind: 'history', chapter: 1, root })
      const entries = (listed.data as { entries: Array<{ revision: number; path: string }> }).entries
      expect(entries.length).toBeGreaterThan(0)
      const knownRevision = entries[0]!.revision
      const history = await engine.queryState({
        kind: 'history',
        chapter: 1,
        revision: knownRevision,
        root,
      })
      const files = (history.data as { files: Array<{ path: string; text: string | null }> }).files
      expect(files.length).toBeGreaterThan(0)
      expect(files[0]!.text).not.toBeNull()
      expect(
        (await engine.queryState({ kind: 'history', chapter: 1, revision: 99, root })).data,
      ).toMatchObject({
        revision: 99,
        files: [],
      })
      await writeFile(join(root, 'state/briefs.yaml'), 'broken: [', 'utf8')
      expect(await engine.queryState({ kind: 'briefs', root })).toMatchObject({
        data: { schema_version: 1, receipts: [] },
      })
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.1 audit journal warnings', () => {
  it('warns on a missing or malformed journal instead of hiding the audit gap', async () => {
    const missing = await harness()
    try {
      await missing.engine.initProject({
        title: '缺日志',
        genre: '都市现代',
        platform: 'fanqie',
        root: missing.root,
      })
      await rm(join(missing.root, 'state/journal.jsonl'))
      const audit = await missing.engine.auditHistory({ root: missing.root })
      expect(audit.warnings.map((warning) => warning.code)).toContain('JOURNAL_MISSING')
    } finally {
      await missing.cleanup()
    }
    const malformed = await harness()
    try {
      await malformed.engine.initProject({
        title: '坏日志',
        genre: '都市现代',
        platform: 'fanqie',
        root: malformed.root,
      })
      const journal = join(malformed.root, 'state/journal.jsonl')
      await writeFile(journal, `${await readFile(journal, 'utf8')}{broken\n`, 'utf8')
      const audit = await malformed.engine.auditHistory({ root: malformed.root })
      expect(audit.warnings.map((warning) => warning.code)).toContain('JOURNAL_MALFORMED')
      const changed = await harness()
      try {
        await changed.engine.initProject({
          title: '外部改动',
          genre: '都市现代',
          platform: 'fanqie',
          root: changed.root,
        })
        const characters = join(changed.root, 'state/characters.yaml')
        await writeFile(characters, `${await readFile(characters, 'utf8')}# external edit\n`, 'utf8')
        const mismatch = await changed.engine.auditHistory({ root: changed.root })
        expect(mismatch.warnings.map((warning) => warning.code)).toContain('JOURNAL_HASH_MISMATCH')
      } finally {
        await changed.cleanup()
      }
    } finally {
      await malformed.cleanup()
    }
  })
})

describe('0.2.1 diagnostic branches', () => {
  it('reports missing planning files and journal blocking through doctor/advise', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '诊断分支', genre: '都市现代', platform: 'fanqie', root })
      await rm(join(root, 'outline/outline.yaml'))
      await rm(join(root, 'outline/worldbook.yaml'))
      const doctor = await engine.doctor({ root })
      expect(doctor.data.checks.find((check) => check.id === 'outline')?.detail).toContain('missing')
      expect(doctor.data.checks.find((check) => check.id === 'worldbook')?.detail).toContain('missing')
      const advise = await engine.advise({ root })
      expect(['novel_audit', 'novel_outline']).toContain(advise.data.tool)
      await rm(join(root, 'state/journal.jsonl'))
      const blocked = await engine.advise({ root })
      expect(blocked.data.tool).toBe('novel_audit')
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.1 worldbook numeric facts', () => {
  it('writes and reads declared numeric facts', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const result = await engine.submitWorldbook({
        facts: [{ alias: '船费', value: 300, unit: '蚊', tolerance: 0, note: '开篇债务' }],
        root,
      })
      expect(result.data.counts.facts).toBe(1)
      expect(result.data.entries).toBe(1)
      const worldbook = await engine.queryState({ kind: 'worldbook', root })
      expect((worldbook.data as { facts: Array<{ alias: string }> }).facts[0]?.alias).toBe('船费')
      await expect(
        engine.submitWorldbook({
          facts: [{ alias: '坏容差', value: 1, unit: '米', tolerance: -1 }],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitWorldbook({
          facts: [
            { alias: '重复', value: 1, unit: '米' },
            { alias: '重复', value: 2, unit: '米' },
          ],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.submitWorldbook({
          facts: [{ alias: '', value: 1, unit: '米' }],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.1 closure regressions', () => {
  it('keeps one history file per review revision across rollbacks', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = await readyToArchive({ root, engine })
      await engine.rollback({ chapter: 1, toStage: 'P4', reason: '再评一次', root })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      await engine.rollback({ chapter: 1, toStage: 'P4', reason: '三评', root })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      const history = await engine.queryState({ kind: 'history', chapter: 1, root })
      const reviews = (history.data as { entries: Array<{ kind: string; revision: number }> }).entries.filter(
        (entry) => entry.kind === 'reviews',
      )
      expect(reviews).toHaveLength(2)
      expect(new Set(reviews.map((entry) => entry.revision)).size).toBe(2)
    } finally {
      await cleanup()
    }
  })

  it('does not replay a rollback after the manuscript changed externally', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const store = new FsStore(root)
      await engine.rollback({ chapter: 1, toStage: 'P4', reason: 'first rollback', root })
      const first = (await listHistory(store, 1)).filter((entry) => entry.kind === 'chapters')
      expect(first).toHaveLength(1)
      await writeFile(join(root, 'chapters/chapter-001.md'), '外部改写后的正文，不能被 replay 吞掉。', 'utf8')
      await engine.rollback({ chapter: 1, toStage: 'P4', reason: 'second rollback', root })
      const second = (await listHistory(store, 1)).filter((entry) => entry.kind === 'chapters')
      expect(second.length).toBeGreaterThan(first.length)
    } finally {
      await cleanup()
    }
  })

  it('applies a second amend at the same revision instead of replaying the first', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await engine.amend({
        path: 'state/characters.yaml',
        content: { schema_version: 1, characters: [] },
        reason: 'reset characters',
        root,
      })
      const character = {
        name: '甲',
        role: 'extra',
        first_appearance: 1,
        profile: {},
        current_state: {},
        growth: [],
        updated_at: 1,
      }
      await engine.amend({
        path: 'state/characters.yaml',
        content: { schema_version: 1, characters: [character] },
        reason: 'restore character',
        root,
      })
      const characters = await engine.queryState({ kind: 'characters', root })
      expect((characters.data as { characters: Array<{ name: string }> }).characters[0]?.name).toBe('甲')
    } finally {
      await cleanup()
    }
  })

  it('does not recommend restoring the previous archived chapter from the newest backup', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const doctor = await engine.doctor({ root })
      const backups = doctor.data.checks.find((check) => check.id === 'backups')
      expect(backups).toBeDefined()
      expect(backups!.hint ?? '').not.toContain('novel_restore')
      expect(backups!.hint ?? '').toContain('novel_reopen')
    } finally {
      await cleanup()
    }
  })

  it('records lifetime review/check/rollback effort even after a rollback reset', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = await readyToArchive({ root, engine })
      await engine.rollback({ chapter: 1, toStage: 'P4', reason: 'effort review', root })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({ chapter: 1, semantic: sampleSemantic(text), root })
      await engine.getBrief({ stage: 'P8', root })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const report = await engine.report({ root })
      expect(report.data.effort.rollbacks).toBe(1)
      expect(report.data.effort.chapters[0]).toMatchObject({
        reviews: 2,
        checks: 2,
        rollbacks: 1,
      })
    } finally {
      await cleanup()
    }
  })

  it('restores only the active chapter and rejects a manifest for another chapter', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const store = new FsStore(root)
      const txid = 'dddddddd-1111-4111-8111-111111111111'
      await store.writeText(`backups/${txid}/${BACKUP_MARKER}`, '1')
      await store.writeText(
        `backups/${txid}/manifest.json`,
        JSON.stringify({
          schema_version: 1,
          txid,
          op: 'submitDraft',
          chapter: 2,
          revision: 1,
          at: '2026-01-01T00:00:00.000Z',
          files: ['chapters/chapter-002.md'],
        }),
      )
      await store.writeText(`backups/${txid}/chapters/chapter-002.md`, 'chapter two')
      await expect(engine.restoreBackup({ txid, chapter: 2, root })).rejects.toMatchObject({
        code: 'ENGINE_STAGE_ORDER',
      })
      await expect(engine.restoreBackup({ txid, chapter: 1, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
    } finally {
      await cleanup()
    }
  })

  it('rejects overlapping patch edits instead of applying them twice', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = await readyToArchive({ root, engine })
      await engine.rollback({ chapter: 1, toStage: 'P5', reason: 'overlap guard', root })
      await engine.getBrief({ stage: 'P5', root })
      await expect(
        engine.submitRevision({
          chapter: 1,
          patch: {
            expected_hash: sha256(text),
            edits: [
              { old_text: '风从窗缝里挤进来', new_text: '风从窗缝里挤进来，雨' },
              { old_text: '从窗缝里挤进来', new_text: '从窗缝里挤进来，雪' },
            ],
          },
          summary: sampleSummary(),
          proof: sampleReview(1, text).proof,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('refuses to archive a manuscript that no longer matches the live draft summary', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = await readyToArchive({ root, engine })
      const changed = `${text}\n补记：雨停后，码头的灯一盏一盏亮起来。`
      await writeFile(join(root, 'chapters/chapter-001.md'), changed, 'utf8')
      await engine.rollback({ chapter: 1, toStage: 'P4', reason: 'external body change', root })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, changed), root })
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({ chapter: 1, semantic: sampleSemantic(changed), root })
      await engine.getBrief({ stage: 'P8', root })
      await expect(
        engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root }),
      ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
    } finally {
      await cleanup()
    }
  })

  it('journals a refused attempt against the chapter the caller named', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '错章审计', genre: '都市现代', platform: 'fanqie', root })
      await expect(
        engine.submitReview({ chapter: 2, ...sampleReview(2, cleanText()), root }),
      ).rejects.toBeDefined()
      const audit = await engine.auditHistory({
        chapter: 2,
        op: 'submitReview',
        status: 'aborted',
        root,
      })
      expect(audit.data).toHaveLength(1)
      expect(audit.data[0]).toMatchObject({ chapter: 2, attempt: true })
    } finally {
      await cleanup()
    }
  })

  it('does not hide history beyond two hundred entries and counts fact-only worldbooks', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '历史边界', genre: '都市现代', platform: 'fanqie', root })
      const store = new FsStore(root)
      for (let revision = 1; revision <= 201; revision += 1) {
        await store.writeText(
          `history/reviews/ch001.r${String(revision).padStart(4, '0')}.review.yaml`,
          'review: true\n',
        )
      }
      const history = await engine.queryState({ kind: 'history', chapter: 1, root })
      expect((history.data as { entries: unknown[] }).entries).toHaveLength(201)

      await engine.submitWorldbook({
        facts: [{ alias: '船费', value: 300, unit: '蚊' }],
        root,
      })
      const worldbook = (await engine.queryState({ kind: 'worldbook', root })).data as Parameters<
        typeof worldbookCounts
      >[0]
      expect(worldbookCounts(worldbook)).toMatchObject({ present: true, facts: 1 })
      expect(worldbookBrief(worldbook, '', [])).toMatchObject({ facts: [{ alias: '船费', value: 300 }] })
      const status = await engine.getStatus({ root })
      expect(status.data.book?.worldbook.facts).toBe(1)
      const stats = await engine.stats({ root })
      expect(stats.worldbookEntries).toBeGreaterThanOrEqual(1)
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.1 second-order review regressions', () => {
  it('does not let a narrow restore replay shadow a broader restore', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const store = new FsStore(root)
      const txid = 'eeeeeeee-1111-4111-8111-111111111111'
      const plan = await readFile(join(root, 'plans/ch001.chapter.yaml'), 'utf8')
      const review = JSON.stringify({
        schema_version: 1,
        chapter: 1,
        round: 1,
        content_hash: 'h',
        dimensions: [],
        issues: [],
        total: 150,
      })
      const check = JSON.stringify({
        schema_version: 1,
        chapter: 1,
        scope: ['content', 'integrity'],
        content_hash: 'h',
        machine: { violations: [], metrics: {} },
        semantic: { items: [] },
        verdict: 'pass',
      })
      const files = ['plans/ch001.chapter.yaml', 'reviews/ch001.review.yaml', 'checks/ch001.check.yaml']
      await store.writeText(`backups/${txid}/${BACKUP_MARKER}`, '1')
      await store.writeText(
        `backups/${txid}/manifest.json`,
        JSON.stringify({
          schema_version: 1,
          txid,
          op: 'test',
          chapter: 1,
          revision: 1,
          at: '2026-01-01T00:00:00.000Z',
          files,
        }),
      )
      await store.writeText(`backups/${txid}/plans/ch001.chapter.yaml`, plan)
      await store.writeText(`backups/${txid}/reviews/ch001.review.yaml`, review)
      await store.writeText(`backups/${txid}/checks/ch001.check.yaml`, check)
      const narrow = await engine.restoreBackup({
        txid,
        paths: ['plans/ch001.chapter.yaml'],
        root,
      })
      expect(narrow.data.restored).toEqual(['plans/ch001.chapter.yaml'])
      const broad = await engine.restoreBackup({ txid, root })
      expect(broad.data.restored).toHaveLength(3)
    } finally {
      await cleanup()
    }
  })

  it('keeps writes available after an external brief-receipt edit', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '收据恢复', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      const path = join(root, 'state/briefs.yaml')
      const raw = await readFile(path, 'utf8')
      await writeFile(path, `${raw}\n# external edit\n`, 'utf8')
      await expect(engine.getBrief({ stage: 'P1', root })).resolves.toBeDefined()
    } finally {
      await cleanup()
    }
  })

  it('journals reopen against the reopened chapter and names its backup correctly', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      await engine.reopenChapter({ chapter: 1, reason: 'chapter-one rollback', root })
      const audit = await engine.auditHistory({
        chapter: 1,
        op: 'reopenChapter',
        status: 'committed',
        root,
      })
      expect(audit.data).toHaveLength(1)
      const backups = (await engine.queryState({ kind: 'backups', root })).data as {
        backups: Array<{ op: string | null; chapter: number | null; files: string[] }>
      }
      const reopened = backups.backups.find((entry) => entry.op === 'reopenChapter')
      expect(reopened).toMatchObject({ chapter: 1 })
      expect(reopened?.files).toContain('chapters/chapter-001.md')
    } finally {
      await cleanup()
    }
  })

  it('refuses to reopen when the P2 plan changed after the archive', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const path = join(root, 'plans/ch001.chapter.yaml')
      const plan = await readFile(path, 'utf8')
      await writeFile(path, plan.replace('scene_type: 日常过渡章', 'scene_type: 纯叙事章'), 'utf8')
      await expect(engine.reopenChapter({ chapter: 1, reason: 'plan tamper', root })).rejects.toMatchObject({
        code: 'ENGINE_TXN_ABORTED',
      })
    } finally {
      await cleanup()
    }
  })

  it('recomputes blocking when restoring a clean review over a newer blocker', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const text = await readyToArchive({ root, engine })
      await engine.rollback({ chapter: 1, toStage: 'P4', reason: 'blocker then restore', root })
      await engine.getBrief({ stage: 'P4', root })
      const blocker = {
        id: 'ISSUE-RESTORE',
        severity: 'blocker' as const,
        status: 'open' as const,
        dimension: 'R-W-01',
        location: '第 1 段',
        problem: '动作没有动机',
        fix: '补一句动机',
      }
      await engine.submitReview({
        chapter: 1,
        ...sampleReview(1, text, { issues: [blocker] }),
        root,
      })
      const before = await engine.getStatus({ root })
      expect(before.data.blocking.some((item) => item.code === 'ISSUE-ISSUE-RESTORE')).toBe(true)
      const backups = (await engine.queryState({ kind: 'backups', root })).data as {
        backups: Array<{ name: string; op: string | null; files: string[] }>
      }
      const reviewBackup = backups.backups.find(
        (entry) => entry.op === 'submitReview' && entry.files.includes('reviews/ch001.review.yaml'),
      )
      expect(reviewBackup).toBeDefined()
      await engine.restoreBackup({
        txid: reviewBackup!.name,
        chapter: 1,
        paths: ['reviews/ch001.review.yaml'],
        root,
      })
      const after = await engine.getStatus({ root })
      expect(after.data.blocking.some((item) => item.code === 'ISSUE-ISSUE-RESTORE')).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('does not let amend rewrite archived rounds, final check or archived time', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const chapters = (await engine.queryState({ kind: 'chapters', include_summary: true, root })).data as {
        schema_version: 1
        chapters: Array<Record<string, unknown>>
      }
      const row = chapters.chapters[0]!
      await expect(
        engine.amend({
          path: 'state/chapters.yaml',
          content: {
            ...chapters,
            chapters: [
              {
                ...row,
                rounds: { review: 0, revise: 0, check: 0, rollbacks: 0 },
                final_check: 'fail',
                archived_at: '2020-01-01T00:00:00.000Z',
              },
            ],
          },
          reason: 'attempt to falsify effort evidence',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('creates a real plan backup that can be listed and restored', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await engine.rollback({ chapter: 1, toStage: 'P2', reason: 'rewrite plan', root })
      await engine.getBrief({ stage: 'P2', root })
      await engine.submitChapterPlan({
        chapter: 1,
        title: '开端之雨',
        scene_type: '日常过渡章',
        narrator: '他',
        beats: ['风起', '信到', '拆封', '读信', '决定'],
        opening: '风从窗缝里挤进来',
        ending: '蜡印',
        target_words: [80, 400],
        root,
      })
      const backups = (await engine.queryState({ kind: 'backups', root })).data as {
        backups: Array<{ op: string | null; files: string[] }>
      }
      const planBackup = backups.backups.find((entry) => entry.op === 'submitChapterPlan')
      expect(planBackup).toBeDefined()
      expect(planBackup!.files).toContain('plans/ch001.chapter.yaml')
    } finally {
      await cleanup()
    }
  })

  it('rejects a one-character foreshadow anchor even when it is a substring', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await readyToArchive({ root, engine })
      const summary = sampleSummary({
        foreshadows: {
          planted: [{ key: 'FS-01', title: '船费债', description: '欠船费', anchor: '的' }],
          advanced: [],
          resolved: [],
        },
      })
      const delta = archiveDelta(summary)
      delta.foreshadows['FS-01']!.anchor = '的'
      await expect(engine.archiveChapter({ chapter: 1, state_delta: delta, root })).rejects.toMatchObject({
        code: 'ENGINE_DELTA_UNVERIFIED',
      })
    } finally {
      await cleanup()
    }
  })
})
