import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FsStore, joinRel } from '../src/store/fs.js'
import { appendJournal, assertJournalConsistent, readJournal } from '../src/store/journal.js'
import {
  archiveDelta,
  bootstrapToDraft,
  cleanText,
  harness,
  readProjectFile,
  readyToArchive,
  sampleReview,
  sampleSemantic,
  sampleSummary,
  snapshotTree,
  writeDraft,
} from './helpers.js'

const blocker = {
  id: 'REV-001',
  severity: 'blocker' as const,
  dimension: 'R-W-01',
  location: '第 2 段',
  problem: '缺动机',
  fix: '补一句理由',
  status: 'open' as const,
}

it('rejects an archive whose delta would make the ledgers unreadable', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await readyToArchive({ root, engine })
    const delta = archiveDelta(sampleSummary())
    delta.timeline['0'] = { ...delta.timeline['0']!, story_time: 42 } as never
    const before = await snapshotTree(root)
    await expect(engine.archiveChapter({ chapter: 1, state_delta: delta, root })).rejects.toMatchObject({
      code: 'ENGINE_SCHEMA_INVALID',
      message: /timeline/,
    })
    expect([...(await snapshotTree(root)).entries()]).toEqual([...before.entries()])
    const status = await engine.getStatus({ root })
    expect(status.data.stage).toBe('ready_to_archive')

    await expect(
      engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary()),
        handoff: { volume: '2' as never },
        root,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID', message: /handoff/ })
    expect((await engine.getStatus({ root })).data.stage).toBe('ready_to_archive')
  } finally {
    await cleanup()
  }
})

it('refuses to initialize over state documents after novel.yaml is lost', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await engine.initProject({ title: '不可覆盖', genre: '都市现代', platform: 'fanqie', root })
    await rm(join(root, 'novel.yaml'))
    await rm(join(root, 'state', 'journal.jsonl'))
    await expect(
      engine.initProject({ title: '后来者', genre: '都市现代', platform: 'fanqie', root }),
    ).rejects.toMatchObject({ code: 'ENGINE_PROJECT_EXISTS' })
    expect(await readProjectFile(root, 'state/world.yaml')).toBeTruthy()
  } finally {
    await cleanup()
  }
})

it('does not remember a failed explicit project root', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await engine.initProject({ title: '仍在这里', genre: '都市现代', platform: 'fanqie', root })
    await expect(engine.getStatus({ root: join(root, 'typo') })).rejects.toMatchObject({
      code: 'ENGINE_PROJECT_NOT_FOUND',
    })
    const status = await engine.getStatus({})
    expect((status.data as { project: { title: string } }).project.title).toBe('仍在这里')
    expect((await engine.panelBundle({})).summary.title).toBe('仍在这里')
  } finally {
    await cleanup()
  }
})

it('keeps the previous draft as the default diff baseline after a revision', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await bootstrapToDraft({ root, engine })
    const text = cleanText()
    await writeDraft({ root, engine, text })
    await engine.getBrief({ stage: 'P4', root })
    await engine.submitReview({ chapter: 1, ...sampleReview(1, text, { issues: [blocker] }), root })
    await engine.getBrief({ stage: 'P5', root })
    const revised = text.replace('走廊尽头传来脚步声', '楼梯尽头传来脚步声')
    await engine.submitRevision({
      chapter: 1,
      content: revised,
      issues: [{ ...blocker, status: 'fixed', evidence: '楼梯尽头传来脚步声' }],
      proof: sampleReview(1, revised).proof,
      root,
    })
    const diff = await engine.diff({ chapter: 1, root })
    expect(diff.data.before).toContain('走廊尽头传来脚步声')
    expect(diff.data.after).toContain('楼梯尽头传来脚步声')
  } finally {
    await cleanup()
  }
})

it('does not let a pipeline-only brief reset external-edit detection', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await engine.initProject({ title: '对账之书', genre: '都市现代', platform: 'fanqie', root })
    await engine.getBrief({ stage: 'P1', root })
    await writeFile(
      join(root, 'state', 'world.yaml'),
      'schema_version: 1\nlocations: [{ name: 外部, first_appearance: 1, locked: true, description: \"\", layout: \"\", capacity: 0, changes: [] }]\nabilities: []\nartifacts: []\nfactions: []\nrules: []\n',
      'utf8',
    )
    await expect(
      engine.amend({
        path: 'state/world.yaml',
        content: { schema_version: 1, locations: [], abilities: [], artifacts: [], factions: [], rules: [] },
        reason: '外部修改后继续',
        root,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
    const audit = await engine.auditHistory({ root, limit: 20 })
    expect(audit.warnings).toContainEqual(expect.objectContaining({ code: 'JOURNAL_HASH_MISMATCH' }))
  } finally {
    await cleanup()
  }
})

it('rejects a revision issue with a non-string status before writing', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await bootstrapToDraft({ root, engine })
    const text = cleanText()
    await writeDraft({ root, engine, text })
    await engine.getBrief({ stage: 'P4', root })
    await expect(
      engine.submitReview({
        chapter: 1,
        ...sampleReview(1, text, {
          issues: [{ ...blocker, status: null as never }],
        }),
        root,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    expect((await engine.getStatus({ root })).data.stage).toBe('P4')
  } finally {
    await cleanup()
  }
})

it('recovers a pending transaction even when a lock-reclaim audit row follows it', async () => {
  const { root, cleanup } = await harness()
  try {
    const store = new FsStore(root)
    await store.writeText(
      'state/world.yaml',
      'schema_version: 1\nlocations: [{ name: 外部, first_appearance: 1, locked: true, description: \"\", layout: \"\", capacity: 0, changes: [] }]\nabilities: []\nartifacts: []\nfactions: []\nrules: []\n',
    )
    const hash = await store.hashBytes('state/world.yaml')
    expect(hash).not.toBeNull()
    await store.writeText(joinRel('.staging', 'crash', 'before', 'state/world.yaml'), 'old\n')
    await appendJournal(store, {
      txid: 'crash',
      at: '2026-01-01',
      op: 'amend',
      chapter: 1,
      revision: 2,
      files: ['state/world.yaml'],
      status: 'pending',
      hashes: { 'state/world.yaml': hash! },
      before: { 'state/world.yaml': null },
    })
    await appendJournal(store, {
      txid: 'reclaim',
      at: '2026-01-01',
      op: 'lock_reclaimed',
      chapter: 0,
      revision: 0,
      files: ['.engine.lock'],
      status: 'committed',
    })
    await assertJournalConsistent(store)
    const journal = await readJournal(store)
    expect(journal.records.filter((record) => record.txid === 'crash').at(-1)?.status).toBe('committed')
    expect(await store.exists(joinRel('.staging', 'crash'))).toBe(false)
  } finally {
    await cleanup()
  }
})

it('advises the P8 brief before archive at ready_to_archive', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await readyToArchive({ root, engine })
    const status = await engine.getStatus({ root })
    expect(status.data.next.tool).toBe('novel_brief')
    expect(status.data.next.args).toMatchObject({ stage: 'P8' })
    await engine.getBrief({ stage: 'P8', root })
    const archived = await engine.archiveChapter({
      chapter: 1,
      state_delta: archiveDelta(sampleSummary()),
      root,
    })
    expect(archived.data.chapter).toBe(1)
  } finally {
    await cleanup()
  }
})

it('reports a finished book without advising another chapter', async () => {
  const { root, engine, cleanup } = await harness()
  try {
    await engine.initProject({
      title: '一章完结',
      genre: '都市现代',
      platform: 'fanqie',
      total_chapters: 1,
      words_per_chapter: [80, 400],
      root,
    })
    await engine.getBrief({ stage: 'P1', root })
    await engine.submitWorldPlan({
      chapter: 0,
      objective: '收到信',
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
      beats: ['起', '承'],
      opening: '开场',
      ending: '断章',
      target_words: [80, 400],
      root,
    })
    const text = cleanText()
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
    await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
    await engine.getBrief({ stage: 'P6', root })
    await engine.runCheck({ chapter: 1, semantic: sampleSemantic(text), root })
    await engine.getBrief({ stage: 'P8', root })
    await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
    const status = await engine.getStatus({ root })
    expect(status.data.next.tool).toBe('novel_export')
    const summary = await engine.panelSummary({ root })
    expect(summary.finished).toBe(true)
    expect(summary.next).toBeUndefined()
  } finally {
    await cleanup()
  }
})
