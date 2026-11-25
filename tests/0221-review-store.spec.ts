import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { applyStateDelta, type DeltaInput } from '../src/engine/state-delta.js'
import { mergeOutline } from '../src/engine/outline-merge.js'
import { normalizeLegacyCheck } from '../src/store/migrate.js'
import { FsStore } from '../src/store/fs.js'
import { readJournal } from '../src/store/journal.js'
import { runTransaction } from '../src/store/txn.js'
import type { ChapterRecord, ChapterSummary, OutlineChapter, OutlineVolume } from '../src/types.js'
import { sampleSummary } from './helpers.js'

/**
 * 0.2.20/0.2.21 review: persistence-layer defects.
 *
 * Every case here is a confirmed finding: the engine either accepted evidence
 * it never verified (world anchors, a damaged check scope), served a stale
 * parse forever after an external edit, or hid a maintenance failure behind a
 * successful commit.
 */

const temp = async (prefix = 'novel-review-store-'): Promise<string> => mkdtemp(join(tmpdir(), prefix))

// ---------------------------------------------------------------------------
// Finding 1: `state_delta.world.<name>.detail.anchors`
// ---------------------------------------------------------------------------

const MANUSCRIPT = '甲和乙站在屋前，术法还没散。风从窗缝里挤进来。他伸手压住。飞剑出鞘。'

const stateDocs = (): Record<string, unknown> => ({
  characters: { schema_version: 1, characters: [] },
  world: {
    schema_version: 1,
    locations: [],
    abilities: [{ name: '飞剑', first_appearance: 1, description: '旧剑', anchors: ['旧剑出鞘，寒光一闪'] }],
    artifacts: [],
    factions: [],
    rules: [],
  },
  locks: { schema_version: 1, locked_at_chapter: 0, characters: {}, locations: {} },
  foreshadows: { schema_version: 1, next_seq: 1, items: [] },
  timeline: { schema_version: 1, next_seq: 1, items: [] },
  relationships: { schema_version: 1, next_seq: 1, items: [] },
})

const emptyDelta = (): Record<string, Record<string, unknown>> => ({
  characters: {},
  world: {},
  foreshadows: {},
  timeline: {},
  relationships: {},
})

const runDelta = (
  summary: ChapterSummary,
  delta: Record<string, unknown>,
  docs: Record<string, unknown> = stateDocs(),
): ReturnType<typeof applyStateDelta> =>
  applyStateDelta({
    chapter: 1,
    text: MANUSCRIPT,
    summary,
    delta: delta as never,
    ...(docs as Omit<DeltaInput, 'chapter' | 'text' | 'summary' | 'delta'>),
  })

describe('0.2.21 review: world detail cannot rewrite or forge anchors', () => {
  it('rejects anchors in detail on an updated entity', () => {
    const delta = emptyDelta()
    delta.world['飞剑'] = { action: 'updated', detail: { anchors: ['只有六个字'] } }
    expect(() => runDelta(sampleSummary({ characters_appeared: [], events: [] }), delta)).toThrowError(
      expect.objectContaining({
        code: 'ENGINE_DELTA_UNVERIFIED',
        message: expect.stringContaining('anchors'),
      }),
    )
  })

  it('rejects anchors in detail on a created entity', () => {
    const summary = sampleSummary({
      characters_appeared: [],
      events: [],
      new_elements: { locations: [], abilities: ['术'], artifacts: [] },
    })
    const delta = emptyDelta()
    delta.world['术'] = { action: 'created', kind: 'ability', detail: { anchors: ['只有六个字'] } }
    expect(() => runDelta(summary, delta)).toThrowError(
      expect.objectContaining({
        code: 'ENGINE_DELTA_UNVERIFIED',
        message: expect.stringContaining('anchors'),
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Finding 2: `readDoc` parse cache
// ---------------------------------------------------------------------------

/** Same byte length for both names, so only content and ctime differ. */
const worldText = (name: string): string =>
  `schema_version: 1\nlocations: []\nabilities:\n  - name: ${name}\nartifacts: []\nfactions: []\nrules: []\n`

describe('0.2.21 review: readDoc never serves a stale parse', () => {
  it('re-reads an external edit that restores the same size and mtime', async () => {
    const root = await temp()
    try {
      const path = join(root, 'state', 'world.yaml')
      await mkdir(join(root, 'state'), { recursive: true })
      const pinned = new Date('2026-01-01T00:00:00.000Z')
      await writeFile(path, worldText('甲地'))
      await utimes(path, pinned, pinned)
      const store = new FsStore(root)
      const before = await store.stat('state/world.yaml')
      expect((await store.readDoc('state/world.yaml', 'world'))?.abilities).toMatchObject([{ name: '甲地' }])

      await writeFile(path, worldText('乙地'))
      await utimes(path, pinned, pinned)
      const after = await store.stat('state/world.yaml')
      // The premise: the legacy cache key (size + mtime) still matches, so the
      // only reason to re-read is the ctime/inode component.
      expect(after).toMatchObject({ size: before?.size, mtimeMs: before?.mtimeMs })

      expect((await store.readDoc('state/world.yaml', 'world'))?.abilities).toMatchObject([{ name: '乙地' }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('re-reads after the TTL even when the stat key did not change', async () => {
    const root = await temp()
    try {
      const path = join(root, 'state', 'world.yaml')
      await mkdir(join(root, 'state'), { recursive: true })
      await writeFile(path, worldText('甲地'))
      const store = new FsStore(root, { docCacheTtlMs: 5_000 })
      let reads = 0
      const readText = store.readText.bind(store)
      vi.spyOn(store, 'readText').mockImplementation(async (relativePath: string) => {
        reads += 1
        return readText(relativePath)
      })
      await store.readDoc('state/world.yaml', 'world')
      await store.readDoc('state/world.yaml', 'world')
      expect(reads, 'a second read within the TTL must reuse the parse').toBe(1)
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(Date.now() + 5_001)
        await store.readDoc('state/world.yaml', 'world')
      } finally {
        vi.useRealTimers()
      }
      expect(reads, 'the TTL must force a re-read even with an unchanged stat key').toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Finding 3: legacy check detection
// ---------------------------------------------------------------------------

const CHECK_FILE = 'checks/ch001.check.yaml'

describe('0.2.21 review: a damaged check is not upgraded to a legacy pass', () => {
  it('leaves a non-array scope for narrow to reject', async () => {
    const root = await temp()
    try {
      const store = new FsStore(root)
      await store.writeText(
        CHECK_FILE,
        'schema_version: 1\nchapter: 1\nscope: content\ncontent_hash: sha256:abc\nmachine:\n  violations: []\nsemantic:\n  items: []\nverdict: pass\n',
      )
      await expect(store.readDoc(CHECK_FILE, 'check')).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
        message: expect.stringContaining('"scope" must be array'),
      })

      const damaged = {
        chapter: 1,
        scope: 'content',
        content_hash: 'sha256:abc',
        machine: { violations: [] },
        semantic: { items: [] },
        verdict: 'pass',
      }
      const normalized = normalizeLegacyCheck(damaged)
      expect(normalized.scope).toBe('content')
      expect(normalized.legacy_format).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still normalizes a 0.2.0 check that has no scope at all', async () => {
    const root = await temp()
    try {
      const store = new FsStore(root)
      await store.writeText(
        'checks/legacy.check.yaml',
        'chapter: 1\ncontent_hash: sha256:abc\nmachine:\n  violations:\n    - code: R-W-01\n      severity: advisory\nsemantic:\n  items: []\nverdict: pass\n',
      )
      const legacy = await store.readDoc('checks/legacy.check.yaml', 'check')
      expect(legacy).toMatchObject({ scope: ['content', 'integrity'], legacy_format: true })
      const machine = legacy?.machine as { violations: unknown[]; advisories: unknown[] }
      expect(machine.violations).toEqual([])
      expect(machine.advisories).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Finding 4: a failed backup prune must be surfaced, not swallowed
// ---------------------------------------------------------------------------

class PruneFailureStore extends FsStore {
  override async removeTree(relativePath: string): Promise<void> {
    if (relativePath.startsWith('backups/')) throw new Error('EBUSY: injected backup prune failure')
    await super.removeTree(relativePath)
  }
}

describe('0.2.21 review: backup retention failure is surfaced after the commit', () => {
  it('calls onWarning and keeps the committed transaction intact', async () => {
    const root = await temp()
    try {
      const old = new Date('2020-01-01T00:00:00.000Z')
      for (const name of ['old-a', 'old-b']) {
        await mkdir(join(root, 'backups', name), { recursive: true })
        await writeFile(join(root, 'backups', name, '.engine-backup'), '1')
        await utimes(join(root, 'backups', name), old, old)
      }
      const store = new PruneFailureStore(root)
      const warnings: string[] = []
      await runTransaction(store, {
        txid: 'tx-prune-failure',
        op: 'archiveChapter',
        chapter: 1,
        revision: 2,
        files: [{ path: 'novel.yaml', text: 'live: true' }],
        backup: true,
        backupRetention: 1,
        onWarning: (message) => warnings.push(message),
      })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/backup retention/)
      expect(warnings[0]).toContain('injected backup prune failure')
      // The commit itself must be untouched by the maintenance failure.
      expect(await store.readText('novel.yaml')).toBe('live: true')
      const journal = await readJournal(store)
      expect(journal.rows.at(-1)).toMatchObject({ txid: 'tx-prune-failure', status: 'committed' })
      expect(await store.exists('backups/tx-prune-failure')).toBe(true)
      expect(await store.exists('backups/old-a')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Finding 5: renaming a volume that holds archived chapters
// ---------------------------------------------------------------------------

const titleRule = { pattern: '^', min_chars: 4, max_chars: 8 }

const card = (patch: Partial<OutlineChapter> = {}): OutlineChapter => ({
  num: 1,
  volume: null,
  title: '开端之雨',
  scene_type: '日常过渡章',
  goal: '收信',
  conflict: '拆不拆',
  hook: '日期',
  cast: ['他'],
  target_words: [80, 400],
  notes: '',
  status: 'planned',
  archived_at: null,
  word_count: null,
  score: null,
  ...patch,
})

const record = (num = 1): ChapterRecord => ({
  num,
  title: '开端之雨',
  file: `chapters/chapter-${String(num).padStart(3, '0')}.md`,
  word_count: 120,
  dialogue_lines: 2,
  dialogue_ratio: 0.4,
  scene_type: '日常过渡章',
  narrator: '他',
  score: 130,
  status: 'reviewed',
  content_hash: `hash-${num}`,
  summary: {
    events: ['收信'],
    characters_appeared: ['他'],
    foreshadows: { planted: [], advanced: [], resolved: [] },
    new_elements: { locations: [], abilities: [], artifacts: [] },
    resource_changes: [],
    opening: '开头',
    continuity: { opens_from: '上章', ends_with: '钩子' },
    hook_strength: 4,
    pleasure_points: [],
    plot_advancement: 'mid',
  },
})

const volume = (patch: Partial<OutlineVolume> = {}): OutlineVolume => ({
  id: 'V1',
  title: '第一卷',
  start_chapter: 1,
  end_chapter: 3,
  goal: '',
  arc: '',
  climax: '',
  status: 'planned',
  ...patch,
})

const outlineOptions = (
  volumes: Array<Partial<OutlineVolume>>,
  archivedChapters: ChapterRecord[],
  existing: OutlineChapter[] = [card({ volume: 1, status: 'archived' })],
): Parameters<typeof mergeOutline>[0] => ({
  chapters: [],
  volumes,
  existing,
  archivedChapters,
  existingVolumes: [volume()],
  titleRule,
  totalChapters: 3,
  defaultTargetWords: [80, 400],
  now: '2026-01-01',
  activeChapter: 1,
})

describe('0.2.21 review: volume identity is the stable id, not the title', () => {
  it('allows renaming a volume that contains archived chapters', () => {
    const result = mergeOutline(
      outlineOptions([{ id: 'V1', title: '改名卷', start_chapter: 1, end_chapter: 3 }], [record()]),
    )
    expect(result.volumes).toHaveLength(1)
    expect(result.volumes[0]).toMatchObject({ id: 'V1', title: '改名卷' })
    expect(result.chapters[0]).toMatchObject({ num: 1, volume: 1, status: 'archived' })
  })

  it('still refuses a rename whose range no longer covers the archived chapter', () => {
    expect(() =>
      mergeOutline(
        outlineOptions([{ id: 'V1', title: '改名卷', start_chapter: 2, end_chapter: 3 }], [record()]),
      ),
    ).toThrow(/outside its volume/)
  })
})
