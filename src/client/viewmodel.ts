import type { PanelPayloadDto } from './dto.js'

/** One human-facing progress step. */
export interface PanelPhase {
  id: string
  label: string
  done: boolean
  active: boolean
}

/** One archived or active chapter, projected for a card rather than a raw table row. */
export interface PanelChapter {
  num: string
  title: string
  words: string
  wordCount: number
  score: string
  scoreValue: number
  scorePercent: number
  badge: string
  tone: 'ok' | 'bad' | 'muted'
  details: string
  stageLabel: string
}

/** Everything the panel renders, derived from the wire payload alone. */
export interface PanelView {
  state: 'ready' | 'loading' | 'empty' | 'error' | 'outdated'
  title: string
  subtitle: string
  stageLabel: string
  revisionLabel: string
  phases: PanelPhase[]
  rows: PanelChapter[]
  blocking: Array<{ code: string; detail: string; hint: string }>
  blockingTitle: string
  stats: { chapters: number; words: number; averageScore: number; blocking: number }
  nextTitle: string
  nextDetail: string
  nextTool: string
  emptyCommand: string
  /** Compatibility fields used by older cards and tests. */
  revision: string
  next: string
}

export const PANEL_SCHEMA_VERSION = 1

const PHASE_LABELS: Record<string, string> = {
  P1: '世界观',
  P2: '章节计划',
  P3: '初稿',
  P4: '评审',
  P5: '修订',
  P6: '一致性',
  P7: '终审',
  P8: '归档',
  P9: '完成',
}

const STAGE_LABELS: Record<string, string> = {
  idle: '待开始',
  P2: '章节规划',
  P3: '初稿',
  P4: '评审',
  P5: '修订',
  P6: '一致性校验',
  ready_to_archive: '待归档',
  done: '已完成',
}

const PLATFORM_LABELS: Record<string, string> = {
  fanqie: '番茄小说',
  qidian: '起点中文网',
  qimao: '七猫小说',
  jinjiang: '晋江文学城',
}

const NEXT_DETAILS: Record<string, string> = {
  novel_init: '先建立一本书的项目根目录。',
  novel_plan_world: '为新章节写下世界观约束与角色关系。',
  novel_plan_chapter: '把本章拆成可执行的节拍与断章点。',
  novel_write_draft: '按任务书写出本章初稿。',
  novel_review: '按十五维给本章打分并标出问题。',
  novel_revise: '处理评审意见后提交修订。',
  novel_check: '核对场景、角色、因果与声音一致性。',
  novel_archive: '通过终审后归档本章。',
}

const TOOL_LABELS: Record<string, string> = {
  novel_init: '创建项目',
  novel_status: '查看状态',
  novel_brief: '领取任务书',
  novel_plan_world: '补全世界观',
  novel_plan_chapter: '规划本章',
  novel_write_draft: '写初稿',
  novel_review: '评审本章',
  novel_revise: '修订本章',
  novel_check: '一致性校验',
  novel_archive: '归档本章',
  novel_word_count: '核对字数',
  novel_state: '查询状态',
  novel_amend: '修订状态',
  novel_rollback: '回退阶段',
  novel_diff: '查看差异',
  novel_export: '导出书稿',
  novel_audit: '查看审计',
  novel_pipeline: '查看建议',
}

const loading = (): PanelView => ({
  state: 'loading',
  title: '网文工坊',
  subtitle: '正在整理书稿…',
  stageLabel: '读取中',
  revisionLabel: '',
  phases: [],
  rows: [],
  blocking: [],
  blockingTitle: '门控',
  stats: { chapters: 0, words: 0, averageScore: 0, blocking: 0 },
  nextTitle: '',
  nextDetail: '',
  nextTool: '',
  emptyCommand: 'novel_init',
  revision: '',
  next: '',
})

const errorView = (message: string): PanelView => ({
  ...loading(),
  state: 'error',
  title: '网文工坊',
  subtitle: message,
  stageLabel: '连接异常',
})

const phaseLabel = (id: string): string => PHASE_LABELS[id] ?? id
const stageLabel = (stage: string): string => STAGE_LABELS[stage] ?? stage
const platformLabel = (platform: string): string => PLATFORM_LABELS[platform] ?? platform
const toolLabel = (tool: string): string => TOOL_LABELS[tool] ?? '继续'

/**
 * Project the wire payload into strings. Version mismatch wins over everything
 * else: a stale panel must never render data from another schema as if it were
 * current.
 */
export function buildView(payload: PanelPayloadDto | null, error: string | null = null): PanelView {
  if (error !== null) return errorView(error)
  if (payload === null) return loading()
  if (payload.schemaVersion !== PANEL_SCHEMA_VERSION) {
    return {
      ...loading(),
      state: 'outdated',
      subtitle: '面板与引擎版本不一致，请刷新页面。',
      stageLabel: '需要刷新',
    }
  }
  if (payload.empty === true) {
    return {
      ...loading(),
      state: 'empty',
      subtitle: payload.error ?? '还没有项目。调用 novel_init 开始第一本书。',
      stageLabel: '等待创建',
    }
  }
  const summary = payload.summary
  const blocking = summary.blocking.map((item) => ({
    code: item.code,
    detail: item.detail,
    hint: item.hint ?? '',
  }))
  const rows: PanelChapter[] = payload.chapters.rows.map((row) => {
    const scoreValue = Number.isFinite(row.score) ? Math.max(0, Math.min(150, row.score)) : 0
    return {
      num: String(row.num),
      title: row.title,
      words: row.wordCount.toLocaleString('zh-CN'),
      wordCount: row.wordCount,
      score: `${scoreValue}/150`,
      scoreValue,
      scorePercent: Math.round((scoreValue / 150) * 100),
      badge: row.status === 'passed' ? '已归档' : row.status === 'blocked' ? '阻塞' : '草稿',
      tone: row.status === 'passed' ? 'ok' : row.status === 'blocked' ? 'bad' : 'muted',
      details: row.details ?? '',
      stageLabel: stageLabel(row.stage),
    }
  })
  const scored = rows.filter((row) => row.tone === 'ok' && row.scoreValue > 0)
  const average =
    scored.length === 0 ? 0 : scored.reduce((sum, row) => sum + row.scoreValue, 0) / scored.length
  const next = summary.next
  return {
    state: 'ready',
    title: `《${summary.title}》`,
    subtitle: `${summary.genre} · ${platformLabel(summary.platform)} · 第 ${summary.chapter} 章`,
    stageLabel: stageLabel(summary.stage),
    revisionLabel: `第 ${summary.revision} 次修订`,
    phases: summary.phases.map((phase) => ({ ...phase, label: phaseLabel(phase.id) })),
    rows,
    blocking,
    blockingTitle: blocking.length === 0 ? '门控已通过' : `待处理 ${blocking.length} 项`,
    stats: {
      chapters: summary.totalChapters,
      words: summary.totalWords,
      averageScore: Math.round(average * 10) / 10,
      blocking: blocking.length,
    },
    nextTitle: next === undefined ? '状态已同步' : toolLabel(next.tool),
    nextDetail:
      next === undefined
        ? '没有待执行的下一步，刷新查看最新状态。'
        : (NEXT_DETAILS[next.tool] ?? next.reason),
    nextTool: next?.tool ?? '',
    emptyCommand: 'novel_init',
    revision: `第 ${summary.revision} 次修订 · ${summary.totalChapters} 章 · ${summary.totalWords} 字`,
    next: next === undefined ? '' : `下一步：${next.tool} — ${next.reason}`,
  }
}

/** Fetch the panel payload; failures become a plain message, never a throw. */
export async function fetchPanel(
  fetcher: typeof fetch,
  path: string,
): Promise<{ payload: PanelPayloadDto | null; error: string | null }> {
  try {
    const response = await fetcher(path, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      let detail = `宿主返回 ${response.status}`
      try {
        const body = (await response.json()) as { error?: unknown }
        if (typeof body?.error === 'string' && body.error !== '') detail = body.error
      } catch {
        // A non-JSON error body keeps the status-only message.
      }
      return { payload: null, error: detail }
    }
    const payload = (await response.json()) as PanelPayloadDto
    return { payload, error: null }
  } catch (error) {
    return { payload: null, error: error instanceof Error ? error.message : '无法连接宿主' }
  }
}
