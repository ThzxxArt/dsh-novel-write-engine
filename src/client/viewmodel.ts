import type { PanelPayloadDto } from './dto.js'

/** Everything the panel renders, derived from the wire payload alone. */
export interface PanelView {
  state: 'ready' | 'loading' | 'empty' | 'error' | 'outdated'
  title: string
  subtitle: string
  revision: string
  phases: Array<{ id: string; done: boolean; active: boolean }>
  rows: Array<{
    num: string
    title: string
    words: string
    score: string
    badge: string
    tone: string
    details: string
  }>
  blocking: Array<{ code: string; detail: string; hint: string }>
  blockingTitle: string
  next: string
}

export const PANEL_SCHEMA_VERSION = 1

const loading = (): PanelView => ({
  state: 'loading',
  title: '网文工坊',
  subtitle: '正在读取项目状态…',
  revision: '',
  phases: [],
  rows: [],
  blocking: [],
  blockingTitle: '阻塞',
  next: '',
})

const errorView = (message: string): PanelView => ({
  ...loading(),
  state: 'error',
  subtitle: message,
})

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
    }
  }
  if (payload.empty === true) {
    return { ...loading(), state: 'empty', subtitle: payload.error ?? '还没有项目：调用 novel_init 创建。' }
  }
  const summary = payload.summary
  const blocking = summary.blocking.map((item) => ({
    code: item.code,
    detail: item.detail,
    hint: item.hint ?? '',
  }))
  return {
    state: 'ready',
    title: `《${summary.title}》`,
    subtitle: `${summary.genre} · ${summary.platform} · 第 ${summary.chapter} 章 · ${summary.stage}`,
    revision: `revision ${summary.revision} · ${summary.totalChapters} 章 · ${summary.totalWords} 字`,
    phases: summary.phases,
    rows: payload.chapters.rows.map((row) => ({
      num: String(row.num),
      title: row.title,
      words: String(row.wordCount),
      score: `${row.score}/150`,
      badge: row.status === 'passed' ? '已归档' : row.status === 'blocked' ? '阻塞' : '草稿',
      tone: row.status === 'passed' ? 'ok' : row.status === 'blocked' ? 'bad' : 'muted',
      details: row.details ?? '',
    })),
    blocking,
    blockingTitle: blocking.length === 0 ? '没有阻塞项' : `阻塞 ${blocking.length} 项`,
    next: summary.next === undefined ? '' : `下一步：${summary.next.tool} — ${summary.next.reason}`,
  }
}

/** Fetch the panel payload; failures become a plain message, never a throw. */
export async function fetchPanel(
  fetcher: typeof fetch,
  path: string,
): Promise<{ payload: PanelPayloadDto | null; error: string | null }> {
  try {
    const response = await fetcher(path, { headers: { accept: 'application/json' } })
    if (!response.ok) return { payload: null, error: `宿主返回 ${response.status}` }
    const payload = (await response.json()) as PanelPayloadDto
    return { payload, error: null }
  } catch (error) {
    return { payload: null, error: error instanceof Error ? error.message : '无法连接宿主' }
  }
}
