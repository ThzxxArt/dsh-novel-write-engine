import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  bootstrapToDraft,
  harness,
  readProjectFile,
  sampleReview,
  sampleSemantic,
  writeDraft,
} from './helpers.js'

const atP6 = async (): Promise<{
  root: string
  engine: Awaited<ReturnType<typeof harness>>['engine']
  cleanup: () => Promise<void>
}> => {
  const { root, engine, cleanup } = await harness()
  await bootstrapToDraft({ root, engine })
  await writeDraft({ root, engine })
  await engine.getBrief({ stage: 'P4', root })
  await engine.submitReview({
    chapter: 1,
    ...sampleReview(1, (await readProjectFile(root, 'chapters/chapter-001.md'))!),
    root,
  })
  await engine.getBrief({ stage: 'P6', root })
  return { root, engine, cleanup }
}

const pipeline = async (root: string): Promise<Record<string, unknown>> =>
  parseYaml((await readProjectFile(root, 'state/pipeline.yaml'))!) as Record<string, unknown>

describe('semantic check evidence', () => {
  it('fails the check when an evidence quote is not in the manuscript', async () => {
    const { root, engine, cleanup } = await atP6()
    try {
      const text = (await readProjectFile(root, 'chapters/chapter-001.md'))!
      const result = await engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(text, {
          'L2-SCENE-ANCHOR': {
            verdict: 'pass',
            evidence: '第 2 段：这句话根本不在正文里',
            note: '伪造引用',
          },
        }),
        root,
      })
      expect(result.data.verdict).toBe('fail')
      expect(result.data.stage).toBe('P6')
      const state = await pipeline(root)
      expect(state.stage).toBe('P6')
      expect(state.blocking).toEqual([expect.objectContaining({ code: 'SEMANTIC_EVIDENCE_INVALID' })])
    } finally {
      await cleanup()
    }
  })

  it('fails the check when a semantic item reports a failure, even with valid evidence', async () => {
    const { root, engine, cleanup } = await atP6()
    try {
      const text = (await readProjectFile(root, 'chapters/chapter-001.md'))!
      const result = await engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(text, {
          'L2-VOICE': {
            verdict: 'fail',
            evidence: '没有抬头，只把笔',
            note: '叙述视角漂移',
          },
        }),
        root,
      })
      expect(result.data.verdict).toBe('fail')
      const state = await pipeline(root)
      expect(state.blocking).toEqual([expect.objectContaining({ code: 'SEMANTIC_CHECK_FAILED' })])
    } finally {
      await cleanup()
    }
  })

  it('accepts a labelled quote that really appears in the manuscript', async () => {
    const { root, engine, cleanup } = await atP6()
    try {
      const text = (await readProjectFile(root, 'chapters/chapter-001.md'))!
      const result = await engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(text).map((item, index) => ({
          ...item,
          evidence: `第 ${index + 1} 段：${item.evidence}`,
        })),
        root,
      })
      expect(result.data.verdict).toBe('pass')
      expect(result.data.stage).toBe('ready_to_archive')
      expect((await pipeline(root)).blocking).toEqual([])
    } finally {
      await cleanup()
    }
  })

  it('does not replay a failed check after the semantic evidence is corrected', async () => {
    const { root, engine, cleanup } = await atP6()
    try {
      const text = (await readProjectFile(root, 'chapters/chapter-001.md'))!
      const failed = await engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(text, {
          'L2-VOICE': { verdict: 'fail', evidence: '没有抬头，只把笔', note: '声音无区分' },
        }),
        root,
      })
      expect(failed.data.verdict).toBe('fail')
      await engine.getBrief({ stage: 'P6', root })
      const corrected = await engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(text),
        root,
      })
      expect(corrected.replayed).not.toBe(true)
      expect(corrected.data.verdict).toBe('pass')
      expect(corrected.data.stage).toBe('ready_to_archive')
    } finally {
      await cleanup()
    }
  })

  it('repairs a corrupt check before a stale revision blocker', async () => {
    const { root, engine, cleanup } = await atP6()
    try {
      const text = (await readProjectFile(root, 'chapters/chapter-001.md'))!
      await engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(text, {
          'L2-VOICE': { verdict: 'fail', evidence: '没有抬头，只把笔', note: '声音无区分' },
        }),
        root,
      })
      expect((await engine.getStatus({ root })).data.stage).toBe('P6')
      await writeFile(join(root, 'checks/ch001.check.yaml'), 'verdict: [unclosed\n', 'utf8')
      const damaged = await engine.getStatus({ root })
      expect(damaged.data.state_errors).toEqual([expect.objectContaining({ code: 'CHECK_UNREADABLE' })])
      expect(damaged.data.next).toMatchObject({
        tool: 'novel_brief',
        args: { stage: 'P6', chapter: 1 },
      })
      await engine.getBrief({ stage: 'P6', root })
      expect((await engine.getStatus({ root })).data.next).toMatchObject({
        tool: 'novel_check',
        args: { chapter: 1 },
      })
    } finally {
      await cleanup()
    }
  })

  it('does not spend the check budget on partial-scope passes', async () => {
    const { root, engine, cleanup } = await atP6()
    try {
      const text = (await readProjectFile(root, 'chapters/chapter-001.md'))!
      const semantic = sampleSemantic(text)
      for (const scope of [['content'], ['integrity'], ['content']] as string[][]) {
        await engine.getBrief({ stage: 'P6', root })
        const partial = await engine.runCheck({ chapter: 1, scope, semantic, root })
        expect(partial.data.verdict).toBe('pass')
        expect((await pipeline(root)).rounds).toMatchObject({ check: 0 })
      }
      await engine.getBrief({ stage: 'P6', root })
      const full = await engine.runCheck({ chapter: 1, semantic, root })
      expect(full.data.verdict).toBe('pass')
      expect((await pipeline(root)).rounds).toMatchObject({ check: 1 })
      expect((await pipeline(root)).stage).toBe('ready_to_archive')
    } finally {
      await cleanup()
    }
  })

  it('applies content and integrity scopes separately and records the actual scope', async () => {
    const { root, engine, cleanup } = await atP6()
    try {
      const original = (await readProjectFile(root, 'chapters/chapter-001.md'))!
      const semantic = sampleSemantic(original)
      await expect(engine.runCheck({ chapter: 1, scope: [], semantic, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.runCheck({ chapter: 1, scope: ['unknown'], semantic, root })).rejects.toMatchObject(
        { code: 'ENGINE_SCHEMA_INVALID' },
      )

      const polluted = `${original} # 这是 Markdown 污染`
      await writeFile(join(root, 'chapters/chapter-001.md'), polluted, 'utf8')
      await engine.getBrief({ stage: 'P6', root })
      // The review binds the manuscript. A scope check must not pass a text
      // that no longer matches its P4 review, even if that scope skips PG-04.
      await expect(
        engine.runCheck({
          chapter: 1,
          scope: ['integrity'],
          semantic: sampleSemantic(polluted),
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_GATE_BLOCKED' })

      await writeFile(join(root, 'chapters/chapter-001.md'), original, 'utf8')
      await engine.getBrief({ stage: 'P6', root })
      const integrityOnly = await engine.runCheck({
        chapter: 1,
        scope: ['integrity'],
        semantic,
        root,
      })
      expect(integrityOnly.data.verdict).toBe('pass')
      // A single-scope pass is not an archive pass; it must not leave status
      // pointing at an archive that PG-04/PG-10 will always reject.
      expect((await pipeline(root)).stage).toBe('P6')
      const check = parseYaml((await readProjectFile(root, 'checks/ch001.check.yaml'))!) as {
        scope: string[]
      }
      expect(check.scope).toEqual(['integrity'])

      await engine.rollback({ chapter: 1, toStage: 'P6', reason: '重新跑内容检查', root })
      await engine.getBrief({ stage: 'P6', root })
      const contentOnly = await engine.runCheck({
        chapter: 1,
        scope: ['content'],
        semantic,
        root,
      })
      expect(contentOnly.data.verdict).toBe('pass')
      expect((await pipeline(root)).stage).toBe('P6')

      await engine.rollback({ chapter: 1, toStage: 'P6', reason: '重新跑全量检查', root })
      await engine.getBrief({ stage: 'P6', root })
      const allScopes = await engine.runCheck({
        chapter: 1,
        scope: ['integrity', 'content'],
        semantic,
        root,
      })
      expect(allScopes.data.verdict).toBe('pass')
      const fullCheck = parseYaml((await readProjectFile(root, 'checks/ch001.check.yaml'))!) as {
        scope: string[]
      }
      expect(fullCheck.scope).toEqual(['content', 'integrity'])
    } finally {
      await cleanup()
    }
  })
})
