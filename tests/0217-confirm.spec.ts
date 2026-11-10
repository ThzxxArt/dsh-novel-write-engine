import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createNovelTools, type UserQuestionsLike } from '../src/tools/index.js'
import { harness, type Harness } from './helpers.js'

/**
 * WP13: the creation-time and migration confirmation gate.
 *
 * These tests exist because "the model usually asks" is not a gate. The tool
 * itself must block before the first byte is written, and the seven outcomes
 * must each be distinguishable — a downgrade that looks like a confirmation is
 * the failure mode this whole work package exists to prevent.
 */

const cleanupQueue: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanupQueue.splice(0)) await cleanup()
})

/** A question service that answers with `selected` and records every call. */
const answerer = (
  selected: string[],
  options: { code?: string; custom?: string } = {},
): UserQuestionsLike & { calls: Array<{ question: string; id: string }> } => {
  const calls: Array<{ question: string; id: string }> = []
  return {
    calls,
    async ask(request) {
      const question = request.questions[0]!
      calls.push({ id: question.id, question: question.question })
      if (options.code !== undefined) {
        throw Object.assign(new Error(options.code), { code: options.code })
      }
      return {
        answers: [
          {
            id: question.id,
            selected,
            ...(options.custom === undefined ? {} : { custom: options.custom }),
          },
        ],
      }
    },
  }
}

const initArgs = (root: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: '确认之书',
  genre: '都市现代',
  platform: 'fanqie',
  style: 'cold-suspense',
  project_root: root,
  ...extra,
})

type LooseTool = { execute: (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown> }

const tool = (h: Harness, questions?: UserQuestionsLike): Map<string, LooseTool> =>
  new Map(
    createNovelTools(h.engine, questions === undefined ? {} : { userQuestions: questions }).map((entry) => [
      entry.name,
      entry as unknown as LooseTool,
    ]),
  )

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  )

describe('0.2.17 creation confirmation gate', () => {
  it('creates the project when the user picks 就这个', async () => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    const questions = answerer(['就这个'])
    const result = (await tool(h, questions).get('novel_init')!.execute(initArgs(h.root), {})) as {
      data: { confirmation: string }
    }
    expect(result.data.confirmation).toBe('confirmed')
    expect(questions.calls).toHaveLength(1)
    // The dialog must name every permanent field, not just the style.
    for (const label of ['题材', '平台', '字数', '对白', '风格', '不可更改']) {
      expect(questions.calls[0]!.question).toContain(label)
    }
    expect(await exists(join(h.root, 'novel.yaml'))).toBe(true)
  })

  it('treats a typed answer as a decision, not as consent', async () => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    // The user skipped the options and wrote what they actually want. Proceeding
    // would create the book with the values they just rejected.
    await expect(
      tool(h, answerer([], { custom: '风格换成怪谈克苏鲁，题材改成悬疑推理' }))
        .get('novel_init')!
        .execute(initArgs(h.root), {}),
    ).rejects.toThrow(/CONFIRMATION_REJECTED/)
    await expect(
      tool(h, answerer([], { custom: '风格换成怪谈' }))
        .get('novel_init')!
        .execute(initArgs(h.root), {}),
    ).rejects.toThrow(/风格换成怪谈/)
    expect(await exists(join(h.root, 'novel.yaml'))).toBe(false)
  })

  it('writes nothing when the user picks 我要改', async () => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    await expect(
      tool(h, answerer(['我要改']))
        .get('novel_init')!
        .execute(initArgs(h.root), {}),
    ).rejects.toThrow(/CONFIRMATION_REJECTED/)
    // The rejection must tell the model what to ask next, not just say "no".
    await expect(
      tool(h, answerer(['我要改']))
        .get('novel_init')!
        .execute(initArgs(h.root), {}),
    ).rejects.toThrow(/逐个询问/)
    expect(await exists(join(h.root, 'novel.yaml'))).toBe(false)
  })

  it('does not call ask at all when confirm is false', async () => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    const questions = answerer(['就这个'])
    const result = (await tool(h, questions)
      .get('novel_init')!
      .execute(initArgs(h.root, { confirm: false }), {})) as { data: { confirmation: string } }
    expect(questions.calls).toHaveLength(0)
    expect(result.data.confirmation).toBe('skipped:disabled')
    expect(await exists(join(h.root, 'novel.yaml'))).toBe(true)
  })

  it('degrades to skipped:no-provider when no answerer exists', async () => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    const result = (await tool(h, answerer(['就这个'], { code: 'NO_PROVIDER' }))
      .get('novel_init')!
      .execute(initArgs(h.root), {})) as { data: { confirmation: string; confirmation_note: string } }
    expect(result.data.confirmation).toBe('skipped:no-provider')
    expect(result.data.confirmation_note).toContain('未经用户确认')
    expect(await exists(join(h.root, 'novel.yaml'))).toBe(true)
    // The downgrade is recorded on the book, not just in this response.
    const status = (await tool(h).get('novel_status')!.execute({ project_root: h.root }, {})) as {
      data: { style_confirmation?: string }
    }
    expect(status.data.style_confirmation).toBe('skipped:no-provider')
  })

  it('degrades for a delegated caller instead of failing the book', async () => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    const result = (await tool(h, answerer([], { code: 'DELEGATED_CALLER' }))
      .get('novel_init')!
      .execute(initArgs(h.root), {})) as { data: { confirmation: string } }
    expect(result.data.confirmation).toBe('skipped:delegated')
    expect(await exists(join(h.root, 'novel.yaml'))).toBe(true)
  })

  it('degrades when the caller is not the live agent', async () => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    const result = (await tool(h, answerer([], { code: 'CALLER_NOT_LIVE' }))
      .get('novel_init')!
      .execute(initArgs(h.root), {})) as { data: { confirmation: string } }
    expect(result.data.confirmation).toBe('skipped:not-live')
    expect(await exists(join(h.root, 'novel.yaml'))).toBe(true)
  })

  it('fails closed when the ask is aborted, leaving no directory behind', async () => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    const target = join(h.root, 'aborted-book')
    await expect(
      tool(h, answerer([], { code: 'ASK_ABORTED' }))
        .get('novel_init')!
        .execute(initArgs(target), {}),
    ).rejects.toThrow(/CONFIRMATION_ABORTED/)
    expect(await exists(target)).toBe(false)
  })

  it('fails closed on an unexpected ask error rather than assuming consent', async () => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    const target = join(h.root, 'weird-error')
    await expect(
      tool(h, answerer([], { code: 'BAD_TIMEOUT' }))
        .get('novel_init')!
        .execute(initArgs(target), {}),
    ).rejects.toThrow(/CONFIRMATION_ABORTED/)
    expect(await exists(target)).toBe(false)
  })

  it('asks before the first write, not after', async () => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    const questions = answerer(['我要改'])
    const execute = tool(h, questions).get('novel_init')!.execute(initArgs(h.root), {})
    await expect(execute).rejects.toThrow(/CONFIRMATION_REJECTED/)
    // The gate ran, and afterwards nothing exists: the ask preceded any write.
    expect(questions.calls).toHaveLength(1)
    expect(await exists(join(h.root, 'novel.yaml'))).toBe(false)
  })

  it('reports the confirmation state on novel_status', async () => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    await tool(h, answerer(['就这个']))
      .get('novel_init')!
      .execute(initArgs(h.root), {})
    const status = (await tool(h).get('novel_status')!.execute({ project_root: h.root }, {})) as {
      data: {
        style: { id: string; name: string } | null
        style_id?: string | null
        style_confirmation?: string
      }
    }
    expect(status.data.style).toEqual({ id: 'cold-suspense', name: '冷峻悬疑' })
    expect(status.data.style_id).toBe('cold-suspense')
    // The gate's outcome is durable: a downgrade that only lived in one tool
    // response would be invisible by the next call.
    expect(status.data.style_confirmation).toBe('confirmed')
  })
})

describe('0.2.17 migration confirmation gate', () => {
  /** A project that predates the style layer: `novel.yaml` has no `style` key. */
  const legacyProject = async (): Promise<Harness> => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    await h.engine.initProject({
      title: '旧项目',
      genre: '都市现代',
      platform: 'fanqie',
      root: h.root,
    })
    const text = await readFile(join(h.root, 'novel.yaml'), 'utf8')
    expect(text).not.toContain('style')
    return h
  }

  it('asks once and writes when the migration is confirmed', async () => {
    const h = await legacyProject()
    const questions = answerer(['就这个'])
    const result = (await tool(h, questions)
      .get('novel_amend')!
      .execute(
        { path: 'novel.yaml', content: { style: 'weird-horror' }, reason: '启用文风', project_root: h.root },
        {},
      )) as { data: { confirmation?: string } }
    expect(questions.calls).toHaveLength(1)
    expect(questions.calls[0]!.id).toBe('style-migrate-confirm')
    expect(result.data.confirmation).toBe('confirmed')
    expect(await readFile(join(h.root, 'novel.yaml'), 'utf8')).toContain('weird-horror')
  })

  it('leaves novel.yaml byte-identical when the migration is rejected', async () => {
    const h = await legacyProject()
    const before = await readFile(join(h.root, 'novel.yaml'), 'utf8')
    await expect(
      tool(h, answerer(['我要改']))
        .get('novel_amend')!
        .execute(
          {
            path: 'novel.yaml',
            content: { style: 'weird-horror' },
            reason: '启用文风',
            project_root: h.root,
          },
          {},
        ),
    ).rejects.toThrow(/CONFIRMATION_REJECTED/)
    expect(await readFile(join(h.root, 'novel.yaml'), 'utf8')).toBe(before)
  })

  it('never asks for an ordinary amendment that does not touch style', async () => {
    const h = await legacyProject()
    const questions = answerer(['就这个'])
    await tool(h, questions)
      .get('novel_amend')!
      .execute(
        { path: 'novel.yaml', content: { description: '只改简介' }, reason: '改简介', project_root: h.root },
        {},
      )
    expect(questions.calls).toHaveLength(0)
    expect(await readFile(join(h.root, 'novel.yaml'), 'utf8')).toContain('只改简介')
  })

  it('asks for a patch that spells the style path the way the engine accepts it', async () => {
    // The engine splits on dots and drops empty segments, so `.style` and
    // `style` are the same write. A raw prefix test on the patch path let the
    // dotted spelling through with no dialog at all.
    const h = await legacyProject()
    const before = await readFile(join(h.root, 'novel.yaml'), 'utf8')
    const questions = answerer(['我要改'])
    await expect(
      tool(h, questions)
        .get('novel_amend')!
        .execute(
          {
            path: 'novel.yaml',
            patch: [{ op: 'add', path: '.style', value: 'weird-horror' }],
            reason: '迁移',
            project_root: h.root,
          },
          {},
        ),
    ).rejects.toThrow(/CONFIRMATION_REJECTED/)
    expect(questions.calls).toHaveLength(1)
    expect(questions.calls[0]!.id).toBe('style-migrate-confirm')
    expect(await readFile(join(h.root, 'novel.yaml'), 'utf8')).toBe(before)
  })

  it('applies a dotted style patch when the migration is confirmed', async () => {
    const h = await legacyProject()
    const result = (await tool(h, answerer(['就这个']))
      .get('novel_amend')!
      .execute(
        {
          path: 'novel.yaml',
          patch: [{ op: 'add', path: '.style', value: 'cold-suspense' }],
          reason: '迁移',
          project_root: h.root,
        },
        {},
      )) as { data: { confirmation?: string } }
    expect(result.data.confirmation).toBe('confirmed')
    expect(await readFile(join(h.root, 'novel.yaml'), 'utf8')).toContain('cold-suspense')
  })

  it('reports the migration window so the gate only fires when it is open', async () => {
    const h = await legacyProject()
    expect((await h.engine.styleMigration({ root: h.root })).data).toMatchObject({ open: true, archived: 0 })
    await h.engine
      .initProject({ title: '已定风格', genre: '都市现代', platform: 'fanqie', style: 'none', root: h.root })
      .catch(() => undefined)
  })

  it('refuses to change a style that is already set', async () => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    await h.engine.initProject({
      title: '已定',
      genre: '都市现代',
      platform: 'fanqie',
      style: 'cold-suspense',
      root: h.root,
    })
    await expect(
      h.engine.amend({
        path: 'novel.yaml',
        content: { style: 'weird-horror' },
        reason: '换风格',
        root: h.root,
      }),
    ).rejects.toThrow(/immutable/)
  })

  it('closes the migration window when an archived chapter file has no index row', async () => {
    const h = await legacyProject()
    // A chapter file that is not the active chapter is an archived chapter, even
    // when the index lost its row. The gate used to look only at rows, so it
    // offered a migration the semantic gate would then refuse.
    await mkdir(join(h.root, 'chapters'), { recursive: true })
    await writeFile(join(h.root, 'chapters', 'chapter-002.md'), '正文。', 'utf8')
    const migration = await h.engine.styleMigration({ root: h.root })
    expect(migration.data).toMatchObject({ open: false, archived: 0 })
    await expect(
      h.engine.amend({
        path: 'novel.yaml',
        content: { style: 'weird-horror' },
        reason: '迁移',
        root: h.root,
      }),
    ).rejects.toThrow(/immutable/)
  })

  it('rejects the migration once the book already decided (explicit null)', async () => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    await h.engine.initProject({
      title: '已决定不用',
      genre: '都市现代',
      platform: 'fanqie',
      style: 'none',
      root: h.root,
    })
    // `null` is a decision, not a gap: the window is closed even with zero chapters.
    expect((await h.engine.styleMigration({ root: h.root })).data).toMatchObject({
      open: false,
      current: null,
      archived: 0,
    })
    await expect(
      h.engine.amend({
        path: 'novel.yaml',
        content: { style: 'weird-horror' },
        reason: '迁移',
        root: h.root,
      }),
    ).rejects.toThrow(/immutable/)
  })

  it('validates the style id at creation instead of silently ignoring a typo', async () => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    // The tool enum rejects a typo before the engine sees it…
    await expect(
      tool(h)
        .get('novel_init')!
        .execute(initArgs(h.root, { style: 'cold-suspence', confirm: false }), {}),
    ).rejects.toThrow(/style/)
    // …and the engine refuses it too, so a direct caller cannot slip past.
    await expect(
      h.engine.initProject({
        title: '拼错',
        genre: '都市现代',
        platform: 'fanqie',
        style: 'cold-suspence',
        root: h.root,
      }),
    ).rejects.toThrow(/unknown style pack/)
    expect(await exists(join(h.root, 'novel.yaml'))).toBe(false)
  })

  it('writes an explicit null for "none" and keeps it immutable', async () => {
    const h = await harness()
    cleanupQueue.push(h.cleanup)
    await tool(h)
      .get('novel_init')!
      .execute(initArgs(h.root, { style: 'none', confirm: false }), {})
    const text = await readFile(join(h.root, 'novel.yaml'), 'utf8')
    expect(text).toMatch(/style: null/)
    await expect(
      h.engine.amend({
        path: 'novel.yaml',
        content: { style: 'cold-suspense' },
        reason: '改主意',
        root: h.root,
      }),
    ).rejects.toThrow(/immutable/)
  })
})
