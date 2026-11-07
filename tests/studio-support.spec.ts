import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initProjectV2, loadProjectV2, saveProjectConfig } from '../src/kernel/project/layout.js'
import { openStudioDb } from '../src/storage/db.js'
import { createRun, recordUsage } from '../src/storage/repositories/runs.js'
import { BudgetGuard } from '../src/studio/budget.js'
import { artifactKindOf, buildTaskPrompt, taskChapter, taskRound } from '../src/studio/prompt.js'
import { emptyCanon } from '../src/kernel/book/store.js'
import type { LoadedProject } from '../src/kernel/project/layout.js'
import type { StoredArtifact } from '../src/kernel/artifacts/store.js'
import type { TaskRow } from '../src/storage/repositories/runs.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('studio support helpers', () => {
  it('maps task kinds and reads chapter/round from task input', () => {
    expect(artifactKindOf('plan')).toBe('ChapterPlan')
    expect(artifactKindOf('draft')).toBe('Draft')
    expect(artifactKindOf('revise')).toBe('Draft')
    expect(artifactKindOf('review.story')).toBe('ReviewReport')
    expect(artifactKindOf('continuity.precheck')).toBe('ContinuityReport')
    expect(artifactKindOf('continuity.final')).toBe('ContinuityReport')
    expect(artifactKindOf('polish')).toBe('PolishPatch')
    expect(artifactKindOf('archive')).toBe('StateDelta')
    expect(artifactKindOf('bible')).toBe('BiblePlan')
    expect(artifactKindOf('outline')).toBe('OutlinePlan')
    expect(artifactKindOf('worldbook')).toBe('WorldbookPatch')
    expect(artifactKindOf('decision')).toBe('Decision')
    expect(artifactKindOf('market')).toBe('MarketBrief')
    expect(() => artifactKindOf('unknown.task')).toThrow(/no artifact contract/u)
    const task = {
      inputJson: JSON.stringify({ chapter: 7, round: 2 }),
    } as TaskRow
    expect(taskChapter(task)).toBe(7)
    expect(taskRound(task)).toBe(2)
    const empty = { inputJson: '{}' } as TaskRow
    expect(taskChapter(empty)).toBe(1)
    expect(taskRound(empty)).toBe(1)
    const broken = { inputJson: '{' } as TaskRow
    expect(taskChapter(broken)).toBe(1)
    expect(taskRound(broken)).toBe(1)
  })

  it('builds a deterministic prompt with review findings and previous chapters', () => {
    const project = {
      config: {
        title: '提示词',
        genre: { major: 'mystery', sub: 'mystery.detective', tags: ['theme.mystery'] },
        audience: 'general',
        targets: { words_per_chapter: [2200, 3200], min_cjk_chars: 2000 },
        quality: { review_rounds: 3 },
      },
    } as unknown as LoadedProject
    const task = {
      kind: 'review.story',
      role: 'critic-story',
      inputJson: JSON.stringify({ chapter: 2, round: 2 }),
    } as TaskRow
    const review = {
      kind: 'ReviewReport',
      content: {
        findings: [
          {
            severity: 'blocker',
            location: '第 2 段',
            problem: '因果断裂',
            fix: '补一句过渡',
          },
        ],
      },
    } as StoredArtifact
    const built = buildTaskPrompt({
      project,
      task,
      bible: {
        premise: '旧铺查账。',
        themes: '成长',
        styleGuide: '短句。',
        fingerprint: {},
        world: { rules: ['契纸有落款'], factions: [], locations: [], glossary: {} },
        characters: [{ name: '林砚' }],
      },
      canon: emptyCanon(),
      artifacts: { reviews: [review] },
      previousChapters: [{ chapter: 1, title: '第一章', text: '前情正文'.repeat(400) }],
    })
    expect(built.prompt).toContain('第 2 章')
    expect(built.prompt).toContain('轮次：2/3')
    expect(built.prompt).toContain('blocker 第 2 段: 因果断裂')
    expect(built.prompt).toContain('前情：')
    expect(built.prompt).toContain('已截断')
    expect(built.promptHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(
      buildTaskPrompt({
        project,
        task,
        bible: {
          premise: '',
          themes: '',
          styleGuide: '',
          fingerprint: {},
          world: { rules: [], factions: [], locations: [], glossary: {} },
          characters: [],
        },
        canon: emptyCanon(),
        artifacts: {},
        previousChapters: [],
      }).prompt,
    ).toContain('章节：第 2 章')
  })

  it('rejects runs that exceed per-run, token or chapter budgets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'budget-'))
    roots.push(root)
    await initProjectV2({
      root,
      title: '预算',
      genre: {
        major: 'urban',
        sub: 'urban.daily',
        tags: ['world.modern_city', 'plot.farming', 'tone.light'],
      },
      audience: 'general',
      platform: 'fanqie',
    })
    const project = await loadProjectV2(root)
    const config = await saveProjectConfig(project, {
      budgets: { per_chapter_usd: 1, per_run_usd: 2, per_task_tokens: 10 } as never,
    })
    project.config = config
    const db = openStudioDb(join(root, '.studio', 'studio.db'))
    try {
      const guard = new BudgetGuard(project, db.orm)
      const runId = createRun(db.orm, {
        projectId: project.config.id,
        kind: 'chapter',
        targetChapter: 1,
        input: {},
      })
      expect(guard.checkRun(runId)).toMatchObject({ ok: true })
      recordUsage(db.orm, {
        runId,
        taskId: 't1',
        role: 'drafter',
        model: 'fake',
        promptTokens: 200,
        completionTokens: 200,
        costUsd: 0.5,
      })
      const tokenLimited = guard.checkRun(runId)
      expect(tokenLimited.ok).toBe(false)
      expect(tokenLimited.reason).toContain('token budget')
      recordUsage(db.orm, {
        runId,
        taskId: 't2',
        role: 'drafter',
        model: 'fake',
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 3,
      })
      const runLimited = guard.checkRun(runId)
      expect(runLimited.ok).toBe(false)
      expect(runLimited.reason).toContain('exceeds $2')
      const chapterLimited = guard.checkChapter(runId)
      expect(chapterLimited.ok).toBe(false)
      expect(chapterLimited.reason).toContain('chapter cost')
      expect(guard.usage(runId).chapterCostUsd).toBe(3.5)
    } finally {
      db.close()
    }
  })
})
