import type { EngineService } from '../engine/service.js'
import { NEXT_DETAILS } from '../next-reasons.js'
import { EngineError } from '../types.js'
import { adminHelp, runAdminOperation } from './admin.js'

/** Result shape accepted by `ctx.commands.register`. */
export interface CommandResultShape {
  kind: 'success' | 'error'
  text?: string
}

interface Invocation {
  rawInput: string
  signal: AbortSignal
}

/** One command definition; `handler` is the property the registry expects. */
export interface CommandDefinition {
  name: string
  description: string
  input?: { hint: string }
  handler: (invocation: Invocation) => Promise<CommandResultShape>
}

const ok = (text: string): CommandResultShape => ({ kind: 'success', text })
const bad = (text: string): CommandResultShape => ({ kind: 'error', text })

const failure = (error: unknown): CommandResultShape =>
  error instanceof EngineError
    ? bad(`[${error.code}] ${error.message}${error.hint === undefined ? '' : ` — ${error.hint}`}`)
    : bad(String(error))

const formatPercent = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `${Math.round(value * 1000) / 10}%`

const statusText = async (engine: EngineService): Promise<string> => {
  const { data } = await engine.getStatus({})
  const lines = [
    `《${data.project.title}》 ${data.project.genre} · ${data.project.platform}`,
    `第 ${data.chapter} 章 · 阶段 ${data.stage}`,
    `轮次 评审 ${data.rounds.review} / 修订 ${data.rounds.revise} / 校验 ${data.rounds.check}`,
    data.metrics === null
      ? '字数 —'
      : `字数 ${data.metrics.total_word_count}（汉字 ${data.metrics.cjk_chars} + 标点 ${data.metrics.punctuation_chars}，含标点）`,
    data.blocking.length === 0 ? '门控 全部通过' : `门控 ${data.blocking.length} 条阻塞：`,
    ...data.blocking.map((item) => `  - ${item.code}: ${item.detail}`),
    ...(data.book === undefined
      ? []
      : [
          `全书：大纲 ${data.book.outline.total} 张卡（规划覆盖 ${formatPercent(data.book.outline.planned_coverage)} · 归档覆盖 ${formatPercent(data.book.outline.archived_coverage)}${data.book.outline.missing_cards > 0 ? ` · 缺卡 ${data.book.outline.missing_cards}` : ''}）· 世界观 ${data.book.worldbook.characters} 角色 / ${data.book.worldbook.locations} 地点 / ${data.book.worldbook.factions} 势力 / ${data.book.worldbook.rules} 规则${data.book.strict ? ' · 严格大纲' : ''}`,
          ...(data.book.outline.current === null
            ? ['当前章卡：（无）']
            : [
                `当前章卡：第${data.book.outline.current.num}章 ${data.book.outline.current.title} · ${data.book.outline.current.scene_type} · ${data.book.outline.current.target_words[0]}-${data.book.outline.current.target_words[1]} 字`,
              ]),
        ]),
    `下一步 ${data.next.tool}：${data.next.reason}`,
  ]
  return lines.join('\n')
}

const usage = () =>
  [
    '/novel status        当前状态',
    '/novel next          下一步该调什么',
    '/novel stats         字数与章节统计',
    '/novel outline       大纲与世界观概览',
    '/novel guide         上手引导与下一步',
    '/novel report        全书报告',
    '/novel doctor        项目体检',
    '/novel search <词>   搜索正文/大纲/世界观/台账',
    '/novel export md|txt|epub|outline|worldbook|proposal',
    '/novel admin         隐藏操作与参数说明',
    '/novel admin <op> <json>  执行隐藏操作',
    '/novel-next          等价于 /novel next',
    '/novel-stats         等价于 /novel stats',
    '/novel-export <kind>',
    '/novel-admin [<op> <json>]',
  ].join('\n')

/** The five slash commands; every one calls a service operation, none touches a file. */
export function createCommands(engine: EngineService): CommandDefinition[] {
  const dispatch = async (raw: string, signal: AbortSignal): Promise<CommandResultShape> => {
    if (signal.aborted) return bad('已取消')
    const [head = '', ...rest] = raw
      .trim()
      .split(/\s+/)
      .filter((part) => part !== '')
    try {
      switch (head) {
        case '':
        case 'status':
          return ok(await statusText(engine))
        case 'next': {
          const { data } = await engine.advise({})
          const reason = NEXT_DETAILS[data.tool] ?? data.reason
          return ok(
            `下一步：${data.tool}\n理由：${reason}${data.blocking.length === 0 ? '' : `\n阻塞 ${data.blocking.length} 条`}`,
          )
        }
        case 'stats': {
          const stats = await engine.stats({})
          return ok(
            `章节 ${stats.chapters} 章 · 总字数 ${stats.totalWords} · 平均分 ${stats.averageScore} · 未回收伏笔 ${stats.openForeshadows} · 大纲 ${stats.totalCards} 卡（规划覆盖 ${formatPercent(stats.outlineCoverage)} · 归档覆盖 ${formatPercent(stats.archivedCoverage)}${stats.missingCards > 0 ? ` · 缺卡 ${stats.missingCards}` : ''}）· 蓝图 ${stats.blueprintReady ? '就绪' : '未就绪'} · 严格 ${stats.strictOutline ? '开' : '关'} · 目标 ${stats.targetChapters ?? '未设'} 章 · 世界观 ${stats.worldbookEntries} 条 · revision ${stats.revision} · 规则包 ${stats.rulepack}`,
          )
        }
        case 'outline': {
          const status = await engine.getStatus({})
          const planningErrors = (status.data.state_errors ?? []).filter(
            (error) =>
              error.path === 'outline/outline.yaml' ||
              error.path === 'outline/worldbook.yaml' ||
              error.path === 'novel.yaml',
          )
          if (planningErrors.length > 0) {
            return bad(
              [
                '全书规划不可读，先修复状态文档：',
                ...planningErrors.map((error) => `${error.code} @ ${error.path}: ${error.message}`),
                '下一步：novel_amend {path, content, reason}',
              ].join('\n'),
            )
          }
          const book = status.data.book
          if (book === undefined) return ok('这本书还没有书级规划数据。')
          return ok(
            [
              `蓝图：${book.premise === '' ? '（空）' : book.premise}`,
              `大纲：${book.outline.total} 张卡 · 规划覆盖 ${formatPercent(book.outline.planned_coverage)} · 归档覆盖 ${formatPercent(book.outline.archived_coverage)}${book.outline.missing_cards > 0 ? ` · 缺卡 ${book.outline.missing_cards}` : ''} · 严格模式 ${book.strict ? '开' : '关'}`,
              `当前章卡：${book.outline.current === null ? '（无）' : `第${book.outline.current.num}章 ${book.outline.current.title} / ${book.outline.current.scene_type}`}`,
              `世界观：${book.worldbook.characters} 角色 · ${book.worldbook.locations} 地点 · ${book.worldbook.factions} 势力 · ${book.worldbook.rules} 规则`,
            ].join('\n'),
          )
        }
        case 'guide': {
          const { data } = await engine.guide({})
          return ok(
            [
              `${data.title} · ${data.state}`,
              ...data.steps.map((step) => `${step.done ? '✓' : '○'} ${step.title}：${step.detail}`),
              `下一步：${data.next.tool} — ${data.next.reason}`,
            ].join('\n'),
          )
        }
        case 'report': {
          const { data } = await engine.report({})
          return ok(
            [
              `进度：${data.progress.archived}/${data.progress.target ?? '—'} 章 · ${data.progress.words} 字 · ${data.progress.percent}%`,
              `大纲：${data.outline.planned} 计划 / ${data.outline.archived} 归档 · 漂移 ${data.outline.drift.length} 项`,
              `质量：均分 ${data.quality.average} · 中位 ${data.quality.median} · 趋势 ${data.quality.trend >= 0 ? '+' : ''}${data.quality.trend}`,
              `伏笔：未回收 ${data.foreshadows.open} · 逾期 ${data.foreshadows.overdue}`,
              ...data.warnings.map((warning) => `警告：${warning}`),
            ].join('\n'),
          )
        }
        case 'doctor': {
          const { data } = await engine.doctor({})
          return ok(
            [
              data.ok ? '体检通过' : '体检发现错误',
              ...data.checks
                .filter((check) => check.severity !== 'ok')
                .map((check) => `[${check.severity}] ${check.title}：${check.detail}`),
            ].join('\n'),
          )
        }
        case 'search': {
          const query = rest.join(' ').trim()
          if (query === '') return bad('用法：/novel search <关键词>')
          const { data } = await engine.search({ query })
          return ok(
            data.total === 0
              ? `没有找到「${query}」`
              : [
                  `找到 ${data.total} 条（显示 ${data.results.length} 条）`,
                  ...data.results.map(
                    (row) =>
                      `- ${row.kind}${row.chapter === undefined ? '' : ` 第${row.chapter}章`}：${row.snippet}`,
                  ),
                ].join('\n'),
          )
        }
        case 'export': {
          const kind = rest[0]
          if (!['md', 'txt', 'epub', 'outline', 'worldbook', 'proposal'].includes(kind ?? ''))
            return bad('用法：/novel export md|txt|epub|outline|worldbook|proposal')
          const { data } = await engine.export({ kind: kind as 'md' })
          return ok(`已导出 ${data.kind}：${data.files.join(', ')}`)
        }
        case 'admin': {
          if (rest.length === 0) return ok(adminHelp())
          const text = raw.trim()
          const bodyStart = text.search(/\s/)
          const body = bodyStart === -1 ? '' : text.slice(bodyStart + 1).trim()
          const separator = body.search(/\s/)
          const operation = separator === -1 ? body : body.slice(0, separator)
          const args = separator === -1 ? '' : body.slice(separator + 1)
          return ok(await runAdminOperation(engine, operation, args))
        }
        default:
          return bad(`未知子命令 "${head}"\n${usage()}`)
      }
    } catch (error) {
      return failure(error)
    }
  }

  return [
    {
      name: 'novel',
      description: 'Novel engine: status, next step, stats, export and admin help.',
      input: { hint: '[status|next|stats|export <kind>|admin]' },
      handler: (invocation) => dispatch(invocation.rawInput, invocation.signal),
    },
    {
      name: 'novel-next',
      description: 'Show the next legal engine operation and why.',
      handler: async (invocation) => {
        if (invocation.signal.aborted) return bad('已取消')
        try {
          const { data } = await engine.advise({})
          return ok(`下一步：${data.tool}\n理由：${NEXT_DETAILS[data.tool] ?? data.reason}`)
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      name: 'novel-stats',
      description: 'Show chapter count, total words and the active rule pack.',
      handler: async (invocation) => {
        if (invocation.signal.aborted) return bad('已取消')
        try {
          const stats = await engine.stats({})
          return ok(
            `章节 ${stats.chapters} 章 · 总字数 ${stats.totalWords} · 平均分 ${stats.averageScore} · 未回收伏笔 ${stats.openForeshadows} · 大纲 ${stats.totalCards} 卡（规划覆盖 ${formatPercent(stats.outlineCoverage)} · 归档覆盖 ${formatPercent(stats.archivedCoverage)}${stats.missingCards > 0 ? ` · 缺卡 ${stats.missingCards}` : ''}）· 蓝图 ${stats.blueprintReady ? '就绪' : '未就绪'} · 严格 ${stats.strictOutline ? '开' : '关'} · 目标 ${stats.targetChapters ?? '未设'} 章 · 世界观 ${stats.worldbookEntries} 条 · revision ${stats.revision} · 规则包 ${stats.rulepack}`,
          )
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      name: 'novel-export',
      description:
        'Export the manuscript or planning artifacts: /novel-export md|txt|epub|outline|worldbook|proposal.',
      input: { hint: 'md|txt|epub|outline|worldbook|proposal' },
      handler: async (invocation) => {
        if (invocation.signal.aborted) return bad('已取消')
        const kind = invocation.rawInput.trim()
        if (!['md', 'txt', 'epub', 'outline', 'worldbook', 'proposal'].includes(kind))
          return bad('用法：/novel-export md|txt|epub|outline|worldbook|proposal')
        try {
          const { data } = await engine.export({ kind: kind as 'md' })
          return ok(`已导出：${data.files.join(', ')}`)
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      name: 'novel-admin',
      description: 'Run an operation hidden from the core tool set: /novel-admin <op> <json>.',
      input: { hint: '[<operation> <json>]' },
      handler: async (invocation) => {
        if (invocation.signal.aborted) return bad('已取消')
        try {
          const text = invocation.rawInput.trim()
          if (text === '') return ok(adminHelp())
          const separator = text.search(/\s/)
          const operation = separator === -1 ? text : text.slice(0, separator)
          const args = separator === -1 ? '' : text.slice(separator + 1)
          return ok(await runAdminOperation(engine, operation, args))
        } catch (error) {
          return failure(error)
        }
      },
    },
  ]
}
