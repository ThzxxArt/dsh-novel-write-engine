import type { EngineService } from '../engine/service.js'
import { EngineError } from '../types.js'

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

const statusText = async (engine: EngineService): Promise<string> => {
  const { data } = await engine.getStatus({})
  const lines = [
    `《${data.project.title}》 ${data.project.genre} · ${data.project.platform}`,
    `第 ${data.chapter} 章 · 阶段 ${data.stage}`,
    `轮次 评审 ${data.rounds.review} / 修订 ${data.rounds.revise} / 校验 ${data.rounds.check}`,
    data.metrics === null ? '字数 —' : `字数 ${data.metrics.total_word_count}`,
    data.blocking.length === 0 ? '门控 全部通过' : `门控 ${data.blocking.length} 条阻塞：`,
    ...data.blocking.map((item) => `  - ${item.code}: ${item.detail}`),
    `下一步 ${data.next.tool}：${data.next.reason}`,
  ]
  return lines.join('\n')
}

const usage = () =>
  [
    '/novel status        当前状态',
    '/novel next          下一步该调什么',
    '/novel stats         字数与章节统计',
    '/novel export md|txt|epub',
    '/novel admin         隐藏操作与参数说明',
    '/novel-next          等价于 /novel next',
    '/novel-stats         等价于 /novel stats',
    '/novel-export <kind>',
    '/novel-admin',
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
          return ok(
            `下一步：${data.tool}\n理由：${data.reason}${data.blocking.length === 0 ? '' : `\n阻塞 ${data.blocking.length} 条`}`,
          )
        }
        case 'stats': {
          const stats = await engine.stats({})
          return ok(
            `章节 ${stats.chapters} 章 · 总字数 ${stats.totalWords} · revision ${stats.revision} · 规则包 ${stats.rulepack}`,
          )
        }
        case 'export': {
          const kind = rest[0]
          if (kind !== 'md' && kind !== 'txt' && kind !== 'epub')
            return bad('用法：/novel export md|txt|epub')
          const { data } = await engine.export({ kind })
          return ok(`已导出 ${data.kind}：${data.files.join(', ')}`)
        }
        case 'admin':
          return ok(
            [
              '隐藏操作（tools.mode=core 时仍可用）：',
              '  novel_init / novel_plan_world / novel_plan_chapter / novel_amend',
              '  novel_rollback / novel_diff / novel_export / novel_audit / novel_pipeline / novel_state',
              '这些操作以工具形式注册；在 core 模式下请让模型直接调用工具名。',
              '',
              usage(),
            ].join('\n'),
          )
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
          return ok(`下一步：${data.tool}\n理由：${data.reason}`)
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
          return ok(`章节 ${stats.chapters} 章 · 总字数 ${stats.totalWords} · 规则包 ${stats.rulepack}`)
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      name: 'novel-export',
      description: 'Export the manuscript: /novel-export md|txt|epub.',
      input: { hint: 'md|txt|epub' },
      handler: async (invocation) => {
        if (invocation.signal.aborted) return bad('已取消')
        const kind = invocation.rawInput.trim()
        if (kind !== 'md' && kind !== 'txt' && kind !== 'epub') return bad('用法：/novel-export md|txt|epub')
        try {
          const { data } = await engine.export({ kind })
          return ok(`已导出：${data.files.join(', ')}`)
        } catch (error) {
          return failure(error)
        }
      },
    },
    {
      name: 'novel-admin',
      description: 'List the operations hidden from the core tool set.',
      handler: async (invocation) => {
        if (invocation.signal.aborted) return bad('已取消')
        try {
          const { data } = await engine.advise({})
          return ok(
            [
              '核心模式下隐藏的操作仍可通过工具名调用：',
              'novel_init, novel_plan_world, novel_plan_chapter, novel_amend,',
              'novel_rollback, novel_diff, novel_export, novel_audit, novel_pipeline, novel_state',
              '',
              `当前阶段 ${data.stage}，建议 ${data.tool}`,
            ].join('\n'),
          )
        } catch (error) {
          return failure(error)
        }
      },
    },
  ]
}
