import type { EngineCaller, EngineService } from '../engine/service.js'
import { NEXT_DETAILS } from '../next-reasons.js'
import { EngineError } from '../types.js'
import { adminHelp, runAdminOperation } from './admin.js'

/** Result shape accepted by `ctx.commands.register`. */
export interface CommandResultShape {
  kind: 'success' | 'error'
  text?: string
}

export interface CommandWorkingDirectory {
  ensure(agent: { id?: string }, signal?: AbortSignal): Promise<string>
}

export interface CommandHost {
  workingDirectory?: CommandWorkingDirectory
}

export interface Invocation {
  rawInput: string
  signal: AbortSignal
  /** Present on a real host invocation; unit tests may omit it. */
  agent?: { id?: string }
  /** Resolved by the wrapper; exposed for unit tests and scan. */
  cwd?: string
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
    ...(data.selection === undefined
      ? []
      : [`项目根 ${data.selection.root} · 选择来源 ${data.selection.source}`]),
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
    '/novel projects      列出项目与目录状态',
    '/novel current       当前会话绑定与选择来源',
    '/novel use <path|title|.>  切换当前会话项目',
    '/novel unbind        清除当前会话绑定（不删项目）',
    '/novel scan [--register]   扫描工作区候选',
    '/novel resume        输出可粘贴的续写指令',
    '/novel admin         隐藏操作与参数说明',
    '/novel admin <op> <json>  执行隐藏操作',
    '/novel-next          等价于 /novel next',
    '/novel-stats         等价于 /novel stats',
    '/novel-export <kind>',
    '/novel-admin [<op> <json>]',
  ].join('\n')

/** Every command calls a service operation; none touches a file directly. */
export function createCommands(engine: EngineService, host: CommandHost = {}): CommandDefinition[] {
  const dispatch = async (invocation: Invocation): Promise<CommandResultShape> => {
    const { rawInput: raw, signal } = invocation
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
        case 'projects': {
          const list = await engine.listProjects()
          let current: string | undefined
          try {
            const selection = await engine.currentProject()
            current = selection.bound ? selection.selection?.root : undefined
          } catch {
            // `projects` also works outside an Agent conversation.
          }
          const lines = [
            `项目 ${list.projects.length} 个${list.active === null ? '' : ` · 面板默认 ${list.active}`}`,
            ...list.projects.map((project) => {
              const marks = [
                ...(project.root === current ? ['*'] : []),
                ...(project.root === list.active ? ['P'] : []),
                ...(project.state === 'ok' ? [] : ['!']),
              ].join('')
              const state = project.state === 'ok' ? '' : ` [${project.state}]`
              return `${marks === '' ? '  ' : marks} 《${project.title}》 — ${project.root}${state}`
            }),
            '* 当前会话 · P 面板默认 · ! 目录缺失/待修复',
          ]
          return ok(lines.join('\n'))
        }
        case 'current': {
          const current = await engine.currentProject()
          if (current.selection === null) {
            return ok(
              `当前会话未绑定；也没有可唯一推导的项目。${current.error === undefined ? '' : `\n${current.error}`}\n运行 /novel use <path|title|.> 选择项目。`,
            )
          }
          return ok(
            current.bound
              ? [
                  `当前会话绑定《${current.selection.title ?? ''}》${current.state === undefined || current.state === 'ok' ? '' : ` [${current.state}]`}`,
                  `项目根 ${current.selection.root}`,
                  ...(current.state === 'missing'
                    ? ['项目目录不在了；绑定保留，恢复目录后可继续，或 /novel unbind 后重选。']
                    : current.state === 'not-project'
                      ? ['目录存在，但没有 novel.yaml 或项目状态；请恢复项目定义或重新选择。']
                      : current.state === 'damaged'
                        ? ['项目定义不可读；先用显式 project_root 的 novel_amend 修复。']
                        : current.state === 'unreadable'
                          ? ['项目目录不可读；修复权限或 IO 错误后再试。']
                          : []),
                ].join('\n')
              : `当前会话未绑定；将按 ${current.selection.source} 推导到 ${current.selection.root}\n要固定选择，运行 /novel use ${current.selection.root}`,
          )
        }
        case 'use': {
          const target = raw.trim().slice('use'.length).trim()
          if (target === '') return bad('用法：/novel use <path|title|.>')
          const result = await engine.useProject({ target })
          return ok(
            `当前会话已切换到《${result.title}》\n项目根 ${result.selection.root}\n面板 active 未改变；后续工具调用会默认使用这本书。`,
          )
        }
        case 'unbind': {
          const result = await engine.unbindProject()
          return ok(
            result.cleared
              ? '已清除当前会话绑定；项目和注册表未改动。'
              : '当前会话没有绑定；项目和注册表未改动。',
          )
        }
        case 'scan': {
          const flags = rest.filter((part) => part.startsWith('--'))
          const positional = rest.filter((part) => !part.startsWith('--'))
          const unknown = flags.filter((flag) => flag !== '--register')
          if (unknown.length > 0 || positional.length > 0) {
            return bad('用法：/novel scan [--register]；scan 不接受路径参数')
          }
          const cwd = invocation.cwd
          if (cwd === undefined || cwd === '') {
            return bad('请在项目工作区中执行 /novel scan')
          }
          const register = flags.includes('--register')
          const result = await engine.scanProjects({ cwd, register })
          const lines = [
            `扫描到 ${result.candidates.length} 个候选；${result.candidates.filter((row) => row.registered).length} 个已登记${result.truncated ? '（只显示前 50 个，请缩小工作区）' : ''}`,
            ...result.candidates.map((candidate) => {
              const state = candidate.state === 'ok' ? '' : ` [${candidate.state}]`
              const registered = candidate.registered ? ' 已登记' : ''
              const identity = candidate.identity_changed === true ? ' ! identity_changed' : ''
              return `- 《${candidate.title}》 — ${candidate.root}${state}${registered}${identity}`
            }),
          ]
          if (result.candidates.length === 0) {
            lines.push('未发现项目；检查当前目录，或用 novel_init 创建第一本书。')
          }
          if (register) {
            lines.push(
              `登记结果：新增 ${result.added.length} · 已存在 ${result.already.length} · 跳过 ${result.skipped.length}`,
            )
            if (result.identity_changed.length > 0) {
              lines.push(
                `identity_changed：${result.identity_changed.join(', ')}；这些行没有被覆盖，请用显式 register/activate 确认替换。`,
              )
            }
            for (const skipped of result.skipped) {
              lines.push(`跳过 ${skipped.root}：${skipped.reason}`)
            }
            lines.push('登记不等于选择，写作请用 /novel use 或 project_root。')
          }
          return ok(lines.join('\n'))
        }
        case 'resume': {
          const { data } = await engine.resumePrompt({})
          if (data.text === null) {
            return bad('当前项目没有可续写的下一步；先用 /novel status 查看项目状态。')
          }
          return ok(data.text)
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

  const withInvocation = async (
    invocation: Invocation,
    task: (enriched: Invocation) => Promise<CommandResultShape>,
  ): Promise<CommandResultShape> => {
    const caller: EngineCaller = {}
    if (typeof invocation.agent?.id === 'string' && invocation.agent.id !== '') {
      caller.sessionId = invocation.agent.id
    }
    if (invocation.cwd !== undefined && invocation.cwd !== '') {
      caller.cwd = invocation.cwd
    } else if (invocation.agent !== undefined && host.workingDirectory !== undefined) {
      try {
        caller.cwd = await host.workingDirectory.ensure(invocation.agent, invocation.signal)
      } catch {
        // A broken cwd must not invalidate an existing binding.
      }
    }
    const enriched: Invocation = {
      ...invocation,
      ...(caller.cwd === undefined ? {} : { cwd: caller.cwd }),
    }
    const run = (): Promise<CommandResultShape> => task(enriched)
    const withCaller = (
      engine as unknown as {
        withCaller?: (
          value: EngineCaller,
          body: () => Promise<CommandResultShape>,
        ) => Promise<CommandResultShape>
      }
    ).withCaller
    return typeof withCaller === 'function' ? withCaller.call(engine, caller, run) : run()
  }

  const commands: CommandDefinition[] = [
    {
      name: 'novel',
      description: 'Novel engine: status, next step, stats, export and admin help.',
      input: {
        hint: '[status|next|stats|projects|current|use|unbind|scan|resume|export <kind>|admin]',
      },
      handler: (invocation) => dispatch(invocation),
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
  return commands.map((command) => ({
    ...command,
    handler: (invocation: Invocation) => withInvocation(invocation, command.handler),
  }))
}
