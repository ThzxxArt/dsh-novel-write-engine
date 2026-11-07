import { usageForRun } from '../storage/repositories/runs.js'
import type { StudioOrm } from '../storage/db.js'
import type { LoadedProject } from '../kernel/project/layout.js'

export interface BudgetSnapshot {
  costUsd: number
  promptTokens: number
  completionTokens: number
  chapterCostUsd: number
}

export class BudgetGuard {
  readonly project: LoadedProject
  readonly orm: StudioOrm

  constructor(project: LoadedProject, orm: StudioOrm) {
    this.project = project
    this.orm = orm
  }

  usage(runId: string): BudgetSnapshot {
    const usage = usageForRun(this.orm, runId)
    return {
      costUsd: usage.costUsd,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      chapterCostUsd: usage.costUsd,
    }
  }

  checkRun(runId: string): { ok: boolean; reason?: string; usage: BudgetSnapshot } {
    const usage = this.usage(runId)
    if (usage.costUsd > this.project.config.budgets.per_run_usd) {
      return {
        ok: false,
        reason: `run cost $${usage.costUsd.toFixed(2)} exceeds $${this.project.config.budgets.per_run_usd}`,
        usage,
      }
    }
    if (usage.promptTokens + usage.completionTokens > this.project.config.budgets.per_task_tokens * 32) {
      return { ok: false, reason: 'run token budget exceeded', usage }
    }
    return { ok: true, usage }
  }

  checkChapter(runId: string): { ok: boolean; reason?: string; usage: BudgetSnapshot } {
    const usage = this.usage(runId)
    if (usage.chapterCostUsd > this.project.config.budgets.per_chapter_usd) {
      return {
        ok: false,
        reason: `chapter cost $${usage.chapterCostUsd.toFixed(2)} exceeds $${this.project.config.budgets.per_chapter_usd}`,
        usage,
      }
    }
    return { ok: true, usage }
  }
}
