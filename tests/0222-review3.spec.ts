import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
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

/**
 * 0.2.20 third review round: the four items the second round listed as
 * "unfixed" (docs/0.2.20-review.md §5), each with the red test that proves the
 * defect before the fix.
 */

const PANEL_BYTES = 64 * 1024

describe('0.2.20 review 3: panel sections obey their own byte cap', () => {
  it('caps a 50-volume worldbook section and counts every volume it drops', async () => {
    const h = await harness()
    try {
      await h.engine.initProject({
        title: '卷宗之书',
        genre: '都市现代',
        platform: 'fanqie',
        total_chapters: 60,
        root: h.root,
      })
      const volumes = Array.from({ length: 50 }, (_, index) => ({
        title: `第${index + 1}卷 长夜`,
        start_chapter: index + 1,
        end_chapter: index + 1,
        goal: '主角要在这一卷里拿到账本并活着离开码头。'.repeat(14),
        arc: '从被追债到握住别人的欠条，中间隔着三次背叛。'.repeat(13),
        climax: '仓库起火，账本沉进海里，只有他记得最后一行数字。'.repeat(13),
      }))
      await h.engine.submitOutline({ volumes, root: h.root })
      const section = await h.engine.panelSection({ section: 'worldbook', root: h.root })
      const bytes = Buffer.byteLength(JSON.stringify(section.items), 'utf8')
      // The panel renders its own payload; nothing downstream prunes it. A
      // section that exceeds the 64 KiB cap is a payload the browser has to
      // parse in full and that the panel's own counters call complete.
      expect(bytes).toBeLessThanOrEqual(PANEL_BYTES)
      expect(section.truncated).toBe(true)
      expect(section.counts?.volumes).toMatchObject({ total: 50 })
      expect(section.counts?.volumes?.shown ?? 0).toBeLessThan(50)
      const shown = (section.items as { volumes: unknown[] }).volumes
      expect(shown.length).toBe(section.counts?.volumes?.shown)
    } finally {
      await h.cleanup()
    }
  }, 60_000)
})

describe('0.2.20 review 3: blocking is the union of review and check', () => {
  it('keeps a failed check in status after an unrelated review amendment', async () => {
    const h = await harness()
    try {
      const text = await readyToArchive({
        root: h.root,
        engine: h.engine,
        issues: [
          {
            id: 'I9',
            severity: 'advisory',
            dimension: 'R-W-01',
            location: '第 1 段',
            problem: '开头略平',
            fix: '加一句动作',
            status: 'open',
          },
        ],
      })
      // Back to P6 so a check can run again on the same manuscript.
      await h.engine.rollback({ chapter: 1, toStage: 'P6', reason: 'recheck', root: h.root })
      await h.engine.getBrief({ stage: 'P6', root: h.root })
      const semantic = sampleSemantic(text, {
        'L2-POV': { verdict: 'fail', note: '视角在中段滑到配角身上' },
      })
      const check = await h.engine.runCheck({ chapter: 1, semantic, root: h.root })
      expect(check.data.verdict).toBe('fail')
      const before = await h.engine.getStatus({ root: h.root })
      expect(before.data.blocking.map((item) => item.code)).toContain('SEMANTIC_CHECK_FAILED')

      // An amendment that touches only the review must not erase the check's
      // blockers: pipeline.blocking is derived evidence for status, and the
      // archive gate still refuses while the check fails.
      await h.engine.submitReview({
        chapter: 1,
        amend_issues: [{ id: 'I9', problem: '开头略平，缺一个具体动作' }],
        amend_note: 'wording',
        root: h.root,
      })
      const after = await h.engine.getStatus({ root: h.root })
      expect(after.data.blocking.map((item) => item.code)).toContain('SEMANTIC_CHECK_FAILED')
    } finally {
      await h.cleanup()
    }
  }, 90_000)
})

describe('0.2.20 review 3: a reopened chapter is not blocked by an empty next chapter', () => {
  it('reopens the previous chapter after a rollback to P1 cleared the next one', async () => {
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      await h.engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root: h.root,
      })
      const done = await h.engine.getStatus({ root: h.root })
      expect(done.data.stage).toBe('done')
      expect(done.data.chapter).toBe(2)
      // `novel_rollback {toStage:'P1'}` is the documented way to restart the
      // next chapter: it clears the draft and leaves the active chapter empty.
      // Reopening the previous chapter then failed with STAGE_ORDER because the
      // guard only accepted `stage === 'done'`.
      const rolled = await h.engine.rollback({
        chapter: 2,
        toStage: 'P1',
        reason: 'restart planning',
        root: h.root,
      })
      expect(rolled.data.stage).toBe('idle')
      const reopened = await h.engine.reopenChapter({
        chapter: 1,
        reason: 'the ledger for chapter 1 is wrong',
        root: h.root,
      })
      expect(reopened.data).toMatchObject({ chapter: 1, stage: 'P3' })
      const status = await h.engine.getStatus({ root: h.root })
      expect(status.data.chapter).toBe(1)
      expect(status.data.stage).toBe('P3')
    } finally {
      await h.cleanup()
    }
  }, 90_000)
})

describe('0.2.20 review 3: a brief signs the summary it shows', () => {
  it('re-signs P6 after a summary-only repair changes the draft summary', async () => {
    const h = await harness()
    try {
      await bootstrapToDraft({ root: h.root, engine: h.engine })
      const text = cleanText(7)
      await writeDraft({ root: h.root, engine: h.engine, text })
      await h.engine.getBrief({ stage: 'P4', root: h.root })
      const sample = sampleReview(1, text)
      await h.engine.submitReview({
        chapter: 1,
        dimensions: sample.dimensions,
        issues: sample.issues,
        proof: sample.proof,
        root: h.root,
      })
      const before = await h.engine.getBrief({ stage: 'P6', root: h.root })
      // Same length as the default first event, so the window signature cannot
      // move for a size reason: only a digest that signs the summary changes.
      const repaired = sampleSummary({ pleasure_points: ['旧照片'] })
      await h.engine.submitRevision({ chapter: 1, summary: repaired, root: h.root })
      const after = await h.engine.getBrief({ stage: 'P6', root: h.root })
      // P6 judges the chapter against the summary it will archive with, so a
      // summary the brief never saw cannot leave the old signature current.
      expect(after.data.digest).not.toBe(before.data.digest)
      expect(after.data.context.summary).toMatchObject({ events: repaired.events })
    } finally {
      await h.cleanup()
    }
  }, 90_000)
})

describe('0.2.20 review 3: a stale check is not evidence for new prose', () => {
  it('drops a failed check from blocking once the manuscript changes', async () => {
    const h = await harness()
    try {
      const text = await readyToArchive({
        root: h.root,
        engine: h.engine,
        text:
          '雨从午后开始落，先是几滴，后来连成线。\n\n他站在檐下，把信翻过来，蜡印已经被磨平。\n\n' +
          '"你不该来。"她把手里的伞往后收了收。\n\n他没有回答，只把信递过去，指尖碰到雨水。\n\n' +
          '她看完，把信折好，放进袖子里，转身走进雨里。',
        summary: sampleSummary({
          opening: '雨从午后开始落，先是几滴',
          continuity: { opens_from: '上一章结尾', ends_with: '转身走进雨里' },
        }),
      })
      await h.engine.rollback({ chapter: 1, toStage: 'P6', reason: 'recheck', root: h.root })
      await h.engine.getBrief({ stage: 'P6', root: h.root })
      const semantic = sampleSemantic(text, {
        'L2-POV': { verdict: 'fail', note: '视角在中段滑到配角身上' },
      })
      await h.engine.runCheck({ chapter: 1, semantic, root: h.root })
      // A failed check changes the evidence, so the revision needs a brief that
      // signs the new check before it can be submitted.
      await h.engine.getBrief({ stage: 'P6', root: h.root })
      expect((await h.engine.getStatus({ root: h.root })).data.blocking.map((item) => item.code)).toContain(
        'SEMANTIC_CHECK_FAILED',
      )
      // A real revision invalidates the check: it judged prose that no longer
      // exists, so its blockers must not follow the chapter into P5.
      const revised = text.replace('把信翻过来', '把信翻过去')
      await h.engine.submitRevision({
        chapter: 1,
        content: revised,
        proof: sampleReview(1, revised).proof,
        root: h.root,
      })
      await h.engine.getBrief({ stage: 'P4', root: h.root })
      const sample = sampleReview(1, revised)
      await h.engine.submitReview({
        chapter: 1,
        dimensions: sample.dimensions,
        issues: [],
        proof: sample.proof,
        root: h.root,
      })
      const after = await h.engine.getStatus({ root: h.root })
      expect(after.data.blocking.map((item) => item.code)).not.toContain('SEMANTIC_CHECK_FAILED')
    } finally {
      await h.cleanup()
    }
  }, 90_000)
})

describe('0.2.20 review 3: document-shaped read models fit the host cap', () => {
  const points = (value: unknown): number => Array.from(JSON.stringify(value)).length

  it('bounds a 120-card outline and says which cards it kept', async () => {
    const h = await harness()
    try {
      await h.engine.initProject({
        title: '长卷之书',
        genre: '都市现代',
        platform: 'fanqie',
        total_chapters: 120,
        root: h.root,
      })
      const long = '他要在一夜之间把账本、人证和船票都凑齐，然后赶在天亮前离开码头。'.repeat(2)
      await h.engine.submitOutline({
        volumes: [
          {
            title: '第一卷 长夜',
            start_chapter: 1,
            end_chapter: 120,
            goal: '拿到账本',
            arc: '起',
            climax: '火',
          },
        ],
        chapters: Array.from({ length: 120 }, (_, index) => ({
          num: index + 1,
          title: `第${index + 1}章 雨夜长街`,
          scene_type: '日常过渡章' as const,
          goal: long,
          conflict: long,
          hook: long,
          target_words: [80, 400] as [number, number],
          volume: 1,
        })),
        root: h.root,
      })
      const state = await h.engine.queryState({ kind: 'outline', root: h.root })
      expect(points(state)).toBeLessThanOrEqual(8_192)
      const data = state.data as {
        truncated?: boolean
        omitted?: Record<string, { total: number; shown: number }>
      }
      expect(data.truncated).toBe(true)
      expect(data.omitted?.chapters?.total).toBe(120)
      expect((data as { chapters: unknown[] }).chapters.length).toBe(data.omitted?.chapters?.shown)
    } finally {
      await h.cleanup()
    }
  }, 120_000)

  it('bounds a 120-row worldbook and counts every group it drops', async () => {
    const h = await harness()
    try {
      await h.engine.initProject({
        title: '设定之书',
        genre: '都市现代',
        platform: 'fanqie',
        root: h.root,
      })
      const long = '这条码头规矩从上一任把头手里传下来，谁碰了都得付出一条命的价钱。'.repeat(3)
      await h.engine.submitWorldbook({
        locations: Array.from({ length: 120 }, (_, index) => ({
          name: `地点${index + 1}`,
          description: long,
          layout: long,
          capacity: 10,
        })),
        root: h.root,
      })
      const state = await h.engine.queryState({ kind: 'worldbook', root: h.root })
      expect(points(state)).toBeLessThanOrEqual(8_192)
      const data = state.data as {
        truncated?: boolean
        omitted?: Record<string, { total: number; shown: number }>
      }
      expect(data.truncated).toBe(true)
      expect(data.omitted?.locations?.total).toBe(120)
    } finally {
      await h.cleanup()
    }
  }, 120_000)
})

describe('0.2.20 review 3: the lock never spins', () => {
  it('fails fast on a lock path it cannot interpret instead of looping forever', async () => {
    const { mkdtemp, symlink, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { FileLock } = await import('../src/store/lock.js')
    const dir = await mkdtemp(join(tmpdir(), 'lock-probe-'))
    try {
      // A dangling symlink: open(...,'wx') fails with EEXIST while stat fails
      // with ENOENT. The old code read that as "the lock disappeared" and
      // retried without ever checking its deadline.
      await symlink(join(dir, 'no-such-target'), join(dir, '.engine.lock'))
      const lock = new FileLock(join(dir, '.engine.lock'), 50, 200)
      const started = Date.now()
      await expect(lock.acquire()).rejects.toMatchObject({ code: 'ENGINE_LOCK_TIMEOUT' })
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('0.2.20 review 3: an external edit has a reachable repair', () => {
  it('lets novel_amend rewrite the document that was edited outside the engine', async () => {
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      const { appendFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      // A one-line comment is a legal YAML edit but changes the file hash, which
      // the journal gate treats as external tampering.
      await appendFile(join(h.root, 'outline/outline.yaml'), '\n# edited by hand\n', 'utf8')
      const current = await readFile(join(h.root, 'outline/outline.yaml'), 'utf8')
      const { parse } = await import('yaml')
      const document = parse(current) as Record<string, unknown>
      await expect(
        h.engine.amend({
          path: 'outline/outline.yaml',
          content: document,
          reason: 'accept the hand edit',
          root: h.root,
        }),
      ).resolves.toBeDefined()
    } finally {
      await h.cleanup()
    }
  }, 90_000)

  it('lets novel_restore bring back a ledger that was edited outside the engine', async () => {
    const h = await harness()
    try {
      const text = await readyToArchive({ root: h.root, engine: h.engine })
      expect(text.length).toBeGreaterThan(0)
      const archive = await h.engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root: h.root,
      })
      const txid = (() => {
        const rows = JSON.parse(`[${readJournalLines(h.root)}]`) as Array<{
          txid: string
          op: string
          status: string
        }>
        return rows.filter((row) => row.op === 'archiveChapter' && row.status === 'committed').pop()!.txid
      })()
      expect(archive.data.chapter).toBe(1)
      const { appendFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      await appendFile(join(h.root, 'state/handoff.yaml'), '\n# edited by hand\n', 'utf8')
      await expect(
        h.engine.restoreBackup({
          txid,
          paths: ['state/handoff.yaml'],
          root: h.root,
        }),
      ).resolves.toBeDefined()
    } finally {
      await h.cleanup()
    }
  }, 90_000)
})

/** Raw journal lines as comma-separated JSON, for the txid lookup above. */
function readJournalLines(root: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const raw = require('node:fs').readFileSync(`${root}/state/journal.jsonl`, 'utf8') as string
  return raw
    .trim()
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => line !== '')
    .join(',')
}

describe('0.2.20 review 3: an abandoned draft is not a dead end', () => {
  it('reopens the previous chapter after the next one was drafted and rolled back', async () => {
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      await h.engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        root: h.root,
      })
      // Chapter 2 is opened and drafted, then the author restarts it from P1.
      await h.engine.getBrief({ stage: 'P1', root: h.root })
      await h.engine.submitWorldPlan({
        chapter: 2,
        objective: '第二章的目标',
        constraints: [],
        characters: [],
        locations: [],
        continuity_notes: [],
        root: h.root,
      })
      await h.engine.getBrief({ stage: 'P2', root: h.root })
      await h.engine.submitChapterPlan({
        chapter: 2,
        title: '第二章 雨夜长街',
        scene_type: '日常过渡章',
        narrator: '他',
        beats: ['风起', '信到', '拆封', '读信', '决定'],
        opening: '风从窗缝里挤进来',
        ending: '蜡印',
        target_words: [80, 400],
        root: h.root,
      })
      await h.engine.getBrief({ stage: 'P3', root: h.root })
      await h.engine.submitDraft({
        chapter: 2,
        content: cleanText(7),
        chapter_title: '第二章 雨夜长街',
        scene_type: '日常过渡章',
        narrator: '他',
        summary: sampleSummary({ opening: '风从窗缝里挤进来，把桌上' }),
        root: h.root,
      })
      await h.engine.rollback({ chapter: 2, toStage: 'P1', reason: 'restart chapter two', root: h.root })
      // The rollback keeps chapter-002.md on disk (it is the audit copy). That
      // used to make reopening chapter 1 impossible, with a hint telling the
      // author to run the rollback they had just run.
      const reopened = await h.engine.reopenChapter({
        chapter: 1,
        reason: 'chapter two will be replanned',
        root: h.root,
      })
      expect(reopened.data).toMatchObject({ chapter: 1, stage: 'P3' })
      expect(reopened.warnings.map((warning) => warning.code)).toContain('REOPEN_DRAFT_LEFT')
    } finally {
      await h.cleanup()
    }
  }, 90_000)
})

describe('0.2.20 review 3: a lock row cannot vanish silently', () => {
  it('refuses to drop a lock row without a deleted declaration', async () => {
    const h = await harness()
    try {
      await h.engine.initProject({ title: '锁定之书', genre: '都市现代', platform: 'fanqie', root: h.root })
      const locked = {
        schema_version: 1,
        locked_at_chapter: 0,
        characters: {
          他: { first_appearance: 1, locked_at: 0, appearance: '左手有旧伤' },
        },
        locations: {},
      }
      await h.engine.amend({
        path: 'state/characters.yaml',
        content: {
          schema_version: 1,
          characters: [
            {
              name: '他',
              role: 'protagonist',
              first_appearance: 1,
              profile: {},
              current_state: {},
              growth: [],
              updated_at: 0,
            },
          ],
        },
        reason: 'seed the character a lock refers to',
        root: h.root,
      })
      await h.engine.amend({ path: 'state/locks.yaml', content: locked, reason: 'seed a lock', root: h.root })
      // Dropping the only row used to pass: the guard only compared arrays, and
      // `locks.characters` is a map. `deleted` is the only deletion channel.
      await expect(
        h.engine.amend({
          path: 'state/locks.yaml',
          content: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
          reason: 'clear the locks',
          root: h.root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        h.engine.amend({
          path: 'state/locks.yaml',
          content: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
          deleted: ['characters.他'],
          reason: 'clear the locks deliberately',
          root: h.root,
        }),
      ).resolves.toBeDefined()
    } finally {
      await h.cleanup()
    }
  }, 60_000)
})

describe('0.2.20 review 3: the P6 brief signs the ledgers it shows', () => {
  it('changes digest when a character is amended in place', async () => {
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      await h.engine.rollback({ chapter: 1, toStage: 'P6', reason: 're-sign', root: h.root })
      const before = await h.engine.getBrief({ stage: 'P6', root: h.root })
      await h.engine.amend({
        path: 'state/characters.yaml',
        content: {
          schema_version: 1,
          characters: [
            {
              name: '他',
              role: 'protagonist',
              first_appearance: 1,
              profile: {},
              current_state: { note: '改过' },
              growth: [],
              updated_at: 0,
            },
          ],
        },
        reason: 'in-place ledger edit while at P6',
        root: h.root,
      })
      const after = await h.engine.getBrief({ stage: 'P6', root: h.root })
      // P6 renders the character ledger, so a receipt signed before the edit
      // must not stay current: PG-01 promises "you saw this brief".
      expect(after.data.digest).not.toBe(before.data.digest)
    } finally {
      await h.cleanup()
    }
  }, 90_000)
})
