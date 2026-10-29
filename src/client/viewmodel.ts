import { REMOTE_VERSION } from '../constants.js'
import { NEXT_DETAILS } from '../next-reasons.js'
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
  /** The whole book reached its configured target; stage `done` alone is only one chapter. */
  finished: boolean
  revisionLabel: string
  phases: PanelPhase[]
  rows: PanelChapter[]
  blocking: Array<{ code: string; scope: string; detail: string; hint: string }>
  blockingTitle: string
  stats: { chapters: number; words: number; averageScore: number; blocking: number }
  book: {
    present: boolean
    strict: boolean
    premise: string
    target: number | null
    planned: number
    outlineTotal: number
    archivedCards: number
    coverage: number
    volumes: Array<{ title: string; range: string; planned: number; archived: number }>
    worldbook: {
      characters: number
      locations: number
      factions: number
      rules: number
      glossary: number
      backstory: number
    }
  }
  quality: { averageScore: number; scores: number[]; trend: number }
  health: { ok: boolean; blocking: number; stateErrors: number }
  activity: Array<{ at: string; op: string; chapter: number; status: string }>
  nextTitle: string
  nextDetail: string
  nextTool: string
  emptyCommand: string
  /** Compatibility fields used by older cards and tests. */
  revision: string
  next: string
}

export const PANEL_SCHEMA_VERSION = REMOTE_VERSION

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

const TOOL_LABELS: Record<string, string> = {
  novel_init: '创建项目',
  novel_status: '查看状态',
  novel_guide: '上手引导',
  novel_blueprint: '书级蓝图',
  novel_outline: '大纲章卡',
  novel_outline_import: '导入大纲',
  novel_worldbook: '世界观',
  novel_search: '全书搜索',
  novel_doctor: '项目体检',
  novel_report: '全书报告',
  novel_reopen: '重开章节',
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
  finished: false,
  revisionLabel: '',
  phases: [],
  rows: [],
  blocking: [],
  blockingTitle: '门控',
  stats: { chapters: 0, words: 0, averageScore: 0, blocking: 0 },
  book: {
    present: false,
    strict: false,
    premise: '',
    target: null,
    planned: 0,
    outlineTotal: 0,
    archivedCards: 0,
    coverage: 0,
    volumes: [],
    worldbook: { characters: 0, locations: 0, factions: 0, rules: 0, glossary: 0, backstory: 0 },
  },
  quality: { averageScore: 0, scores: [], trend: 0 },
  health: { ok: true, blocking: 0, stateErrors: 0 },
  activity: [],
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
const volumeLabel = (summary: PanelPayloadDto['summary']): string => {
  if (summary.volume === undefined) return ''
  const volume = summary.volume_name === undefined ? `第${summary.volume}卷` : summary.volume_name
  const act =
    summary.act === undefined
      ? ''
      : ` · ${summary.act}${summary.act_progress === undefined ? '' : ` ${summary.act_progress}`}`
  return ` · ${volume}${act}`
}

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
    scope: item.scope ?? '',
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
  const scored = rows.filter((row) => row.tone === 'ok')
  const rowAverage =
    scored.length === 0 ? 0 : scored.reduce((sum, row) => sum + row.scoreValue, 0) / scored.length
  const average =
    summary.averageScore !== undefined && Number.isFinite(summary.averageScore)
      ? summary.averageScore
      : rowAverage
  const next = summary.next
  const finished = summary.finished === true
  const doneLabel =
    summary.stage === 'done' ? (finished ? '全书完成' : '本章已归档') : stageLabel(summary.stage)
  return {
    state: 'ready',
    title: `《${summary.title}》`,
    subtitle:
      summary.stage === 'done'
        ? `${summary.genre} · ${platformLabel(summary.platform)} · ${
            finished ? `共 ${summary.totalChapters} 章` : `下一章 第 ${summary.chapter} 章`
          }${volumeLabel(summary)}`
        : `${summary.genre} · ${platformLabel(summary.platform)} · 第 ${summary.chapter} 章${volumeLabel(summary)}`,
    stageLabel: doneLabel,
    finished,
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
    book: {
      present: summary.book?.outline.present === true,
      strict: summary.book?.strict === true,
      premise: summary.book?.premise ?? '',
      target: summary.book?.target ?? null,
      planned: summary.book?.outline.planned ?? 0,
      outlineTotal: summary.book?.outline.total ?? 0,
      archivedCards: summary.book?.outline.archived ?? 0,
      coverage: summary.book?.outline.coverage ?? 0,
      volumes: (summary.book?.outline.volumes ?? []).map((volume) => ({
        title: volume.title,
        range: `第${volume.start}-${volume.end}章`,
        planned: volume.planned,
        archived: volume.archived,
      })),
      worldbook: summary.book?.worldbook ?? {
        characters: 0,
        locations: 0,
        factions: 0,
        rules: 0,
        glossary: 0,
        backstory: 0,
      },
    },
    quality: {
      averageScore: summary.quality?.averageScore ?? average,
      scores: summary.quality?.scores ?? [],
      trend: summary.quality?.trend ?? 0,
    },
    health: {
      ok: summary.health?.ok ?? blocking.length === 0,
      blocking: summary.health?.blocking ?? blocking.length,
      stateErrors: summary.health?.stateErrors ?? 0,
    },
    activity: summary.activity ?? [],
    nextTitle: finished ? '' : next === undefined ? '状态已同步' : toolLabel(next.tool),
    nextDetail: finished
      ? ''
      : next === undefined
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
  signal?: AbortSignal,
): Promise<{ payload: PanelPayloadDto | null; error: string | null }> {
  try {
    const response = await fetcher(path, {
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    })
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
