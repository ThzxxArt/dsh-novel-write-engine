import { describe, expect, it } from 'vitest'
import { archiveDelta, harness, readyToArchive, sampleSummary } from './helpers.js'

/**
 * 0.2.20 release review — the migration paths the README promises.
 *
 * The upgrade notes tell an author of a curly-quote book to run
 * `novel_amend` on `novel.yaml` before the first archive, and to turn the
 * self-check requirement off with the same tool. A promise in the upgrade notes
 * that the engine refuses is worse than no note at all, so both paths are
 * asserted here rather than assumed.
 */
describe('0.2.20 release: the documented migration paths work', () => {
  it('lets an existing book switch quotes and self_check_required before archiving', async () => {
    const h = await harness()
    try {
      await h.engine.initProject({
        title: '迁移之书',
        genre: '都市现代',
        platform: 'fanqie',
        root: h.root,
      })
      const quotes = await h.engine.amend({
        path: 'novel.yaml',
        // A 0.2.19 book has no `quotes` key at all, so the documented move is
        // JSON Patch `add`; `replace` on an absent field is refused with a
        // hint (asserted below).
        patch: [{ op: 'add', path: 'quotes', value: 'curly' }],
        reason: '本书一直用弯引号',
        root: h.root,
      })
      expect((quotes.data as { changes: Array<{ path: string }> }).changes.map((row) => row.path)).toContain(
        'quotes',
      )
      const checked = await h.engine.amend({
        path: 'novel.yaml',
        patch: [{ op: 'add', path: 'self_check_required', value: false }],
        reason: '作者决定不做自查',
        root: h.root,
      })
      expect((checked.data as { changes: Array<{ path: string }> }).changes.map((row) => row.path)).toContain(
        'self_check_required',
      )
      const status = (await h.engine.getStatus({ root: h.root })).data as {
        project: { quotes?: string; self_check_required?: boolean }
      }
      // 0.2.20 release review: these three switches decide what the gates
      // accept, and they were only readable by opening `novel.yaml` — so after
      // the documented migration the author could not confirm it took effect.
      expect(status.project.quotes).toBe('curly')
      expect(status.project.self_check_required).toBe(false)
    } finally {
      await h.cleanup()
    }
  }, 60_000)

  it('refuses the quotes switch once the first chapter is archived', async () => {
    const h = await harness()
    try {
      await readyToArchive({ root: h.root, engine: h.engine })
      await h.engine.archiveChapter({
        chapter: 1,
        state_delta: archiveDelta(sampleSummary({ characters_appeared: ['他'] })),
        root: h.root,
      })
      await expect(
        h.engine.amend({
          path: 'novel.yaml',
          patch: [{ op: 'replace', path: 'quotes', value: 'curly' }],
          reason: '归档后改引号口径',
          root: h.root,
        }),
      ).rejects.toThrowError(/quotes/i)
    } finally {
      await h.cleanup()
    }
  }, 60_000)
})

describe('0.2.20 release: a CRLF checkout renders the same brief', () => {
  it('normalises template line endings when it loads them', async () => {
    const { BriefLibrary } = await import('../src/engine/brief.js')
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = await mkdtemp(join(tmpdir(), 'brief-crlf-'))
    try {
      await writeFile(join(directory, 'P8.md'), '第一行\r\n第二行\r\n{{chapter}}\r\n', 'utf8')
      const library = new BriefLibrary(directory)
      const loaded = library.load('P8')
      // A Windows checkout with core.autocrlf=true gives every template CRLF.
      // The rendered book was one code point per line longer than the one the
      // budget measured, and a P8 brief came out at 8,227 on the Windows runner
      // against 8,192 on Linux.
      expect(loaded.content).not.toContain('\r')
      expect(loaded.content.split('\n')).toHaveLength(4)
      expect(library.render('P8', { chapter: 7 }).content).toContain('7')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('0.2.20 release: a too-long path is named on every platform', () => {
  it('maps Windows ENOENT for an oversized component to the path code', async () => {
    const { pathLooksTooLong } = await import('../src/store/fs.js')
    // Windows reports MAX_PATH overruns as ENOENT; the old mapping only knew
    // ENAMETOOLONG, so the author got a bare libuv message for a problem whose
    // fix ("shorten the root") is nothing like a missing file.
    expect(pathLooksTooLong(undefined)).toBe(false)
    expect(pathLooksTooLong('state/short.yaml')).toBe(false)
    expect(pathLooksTooLong(`state/${'x'.repeat(300)}.yaml`)).toBe(true)
    expect(pathLooksTooLong(`/tmp/${'y'.repeat(260)}/file.yaml`)).toBe(true)
  })
})
