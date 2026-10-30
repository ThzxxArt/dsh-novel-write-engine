import { defineTool } from '@deepseek-ai/dsh-tools'
import { CORE_TOOLS, TOOL_NAMES, type ToolName } from '../constants.js'
import { arraySemanticsDescription, type ArraySemantics } from './semantics.js'
import {
  ERROR_CODES,
  EngineBlockedError,
  EngineError,
  EngineInputError,
  GENRES,
  PLATFORMS,
  SCENE_TYPES,
  type Genre,
  type Platform,
} from '../types.js'
import type { EngineCaller, EngineService } from '../engine/service.js'

/**
 * Providers sometimes serialize a free-form `json` parameter as a JSON string
 * even when the model intended an object. Accept both wire shapes; an invalid
 * string becomes a machine-code error instead of a raw TypeError.
 */
const asJson = <T>(value: unknown, field: string): T => {
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `${field} must be a JSON object or a valid JSON string`,
      `send ${field} as an object, not a malformed string`,
    )
  }
}

/** Turn an engine failure into the message shape tools surface. */
const fail = (error: unknown): never => {
  if (error instanceof EngineError) {
    const blocking =
      error instanceof EngineBlockedError && error.blocking.length > 0
        ? `\nblocking: ${JSON.stringify(error.blocking)}`
        : ''
    const details =
      'items' in error && Array.isArray((error as { items?: unknown }).items)
        ? `\nitems: ${JSON.stringify((error as { items: unknown[] }).items)}`
        : ''
    throw new Error(
      `[${error.code}] ${error.message}${error.hint === undefined ? '' : ` — ${error.hint}`}${blocking}${details}`,
    )
  }
  throw error
}

export interface WorkingDirectoryLike {
  ensure(agent: { id?: string }, signal?: AbortSignal): Promise<string>
}

interface ToolExec {
  signal?: AbortSignal
  agent?: { id?: string }
}

/** Wrap an execute body with caller context, cancellation and a machine-code error. */
const makeGuarded =
  (engine: EngineService, workingDirectory?: WorkingDirectoryLike) =>
  <A>(body: (args: A) => Promise<unknown>) =>
  async (args: A, exec?: ToolExec): Promise<any> => {
    const caller: EngineCaller = {}
    if (typeof exec?.agent?.id === 'string' && exec.agent.id !== '') caller.sessionId = exec.agent.id
    if (exec?.agent !== undefined && workingDirectory !== undefined) {
      try {
        caller.cwd = await workingDirectory.ensure(exec.agent, exec.signal)
      } catch {
        // A deleted cwd must not invalidate an existing session binding.
      }
    }
    try {
      const invoke = (): Promise<unknown> => engine.withSignal(exec?.signal, () => body(args))
      const withCaller = (
        engine as unknown as {
          withCaller?: (value: EngineCaller, task: () => Promise<unknown>) => Promise<unknown>
        }
      ).withCaller
      return await (typeof withCaller === 'function' ? withCaller.call(engine, caller, invoke) : invoke())
    } catch (error) {
      return fail(error)
    }
  }

const percent = (value: number): string => `${Math.round(value * 1000) / 10}%`

const text = (value: unknown): Array<{ type: 'text'; text: string }> => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
]

/**
 * The host passes the value `execute` returned straight to `output.render`.
 * That value is an `OpResult` envelope, while renderers speak in payloads. A
 * direct render call in a unit test may pass either shape, so unwrap only when
 * the envelope is unambiguous.
 */
const payload = (raw: unknown): unknown => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  if (!('data' in raw) || !('revision' in raw) || !('warnings' in raw)) return raw
  return (raw as { data: unknown }).data
}

/** Surface engine warnings (dropped deductions, journal integrity) to the model. */
const withWarnings = (
  rendered: Array<{ type: 'text'; text: string }>,
  raw: unknown,
): Array<{ type: 'text'; text: string }> => {
  if (typeof raw !== 'object' || raw === null || !('warnings' in raw)) return rendered
  const warnings = (raw as { warnings?: unknown }).warnings
  if (!Array.isArray(warnings) || warnings.length === 0) return rendered
  const lines = warnings.map((warning) => {
    if (typeof warning !== 'object' || warning === null) return String(warning)
    const entry = warning as { code?: unknown; message?: unknown }
    return `${String(entry.code ?? 'WARNING')}: ${String(entry.message ?? '')}`
  })
  rendered[0]!.text += `\n\n引擎警告：\n${lines.map((line) => `- ${line}`).join('\n')}`
  return rendered
}

/** Surface host-level idempotency so a retried write is not mistaken for a new commit. */
const withReplay = (
  rendered: Array<{ type: 'text'; text: string }>,
  raw: unknown,
): Array<{ type: 'text'; text: string }> => {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'replayed' in raw &&
    (raw as { replayed?: unknown }).replayed === true
  ) {
    rendered[0]!.text += '\n\n（replayed: true — 本次未再次写盘）'
  }
  return withWarnings(rendered, raw)
}

const jsonOutput = {
  schema: { type: 'json' as const },
  render: (_args: unknown, raw: unknown) => withReplay(text(payload(raw)), raw),
}

const stringArray = (semantics: ArraySemantics, description: string) => ({
  type: 'array' as const,
  items: { type: 'string' as const },
  description: arraySemanticsDescription(semantics, description),
})
const root = {
  type: 'string' as const,
  description:
    'Project root. Passing it selects this project for the current session and persists the choice. When omitted: session binding -> unique project in the workspace -> single registered project -> configured projectRoot -> error. Multiple projects require an explicit choice.',
}
const initRoot = {
  type: 'string' as const,
  description:
    'Project root for the new project. Passing it creates the project there. When omitted, only the configured projectRoot is used; novel_init does not follow the session binding, workspace discovery or registry active. The created project is bound to the current session on success.',
}
const utilityRoot = {
  type: 'string' as const,
  description:
    'Project root for the project-backed mode of this tool. Text-only word_count/diff calls ignore it and do not create a session binding; use a project-backed call when you want to select a book.',
}

/**
 * The twenty-eight tools are thin adapters: narrow parameters, call one service
 * operation, render the canonical value. They never read a file.
 */
export function createNovelTools(
  engine: EngineService,
  options: { workingDirectory?: WorkingDirectoryLike } = {},
): ReturnType<typeof defineTool>[] {
  const guarded = makeGuarded(engine, options.workingDirectory)
  return [
    defineTool({
      name: 'novel_init',
      description:
        'Create a novel project at the project root: novel.yaml, state documents, an empty outline and an empty worldbook. Call novel_guide next.',
      parameters: {
        title: { type: 'string', required: true },
        genre: { type: 'string', required: true, enum: GENRES },
        platform: { type: 'string', required: true, enum: PLATFORMS },
        author: { type: 'string' },
        description: { type: 'string' },
        words_per_chapter: {
          type: 'array',
          items: { type: 'integer' },
          description: arraySemanticsDescription('replace', 'Fixed [min,max] word target for chapters.'),
        },
        total_chapters: { type: 'integer' },
        premise: { type: 'string', description: 'Optional one-sentence premise for the book plan.' },
        logline: { type: 'string' },
        themes: stringArray('replace', 'Book themes; supplied list replaces the theme list.'),
        tone: { type: 'string' },
        pov: { type: 'string' },
        audience: { type: 'string' },
        selling_points: stringArray('replace', 'Selling points; supplied list replaces the list.'),
        ending: { type: 'string' },
        strict_outline: { type: 'boolean' },
        project_root: initRoot,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.initProject({
          title: args.title,
          genre: args.genre as Genre,
          platform: args.platform as Platform,
          author: args.author as string,
          description: args.description as string,
          words_per_chapter: args.words_per_chapter as [number, number],
          total_chapters: args.total_chapters as number,
          premise: args.premise as string,
          logline: args.logline as string,
          themes: args.themes as string[],
          tone: args.tone as string,
          pov: args.pov as string,
          audience: args.audience as string,
          selling_points: args.selling_points as string[],
          ending: args.ending as string,
          strict_outline: args.strict_outline as boolean,
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_status',
      description:
        'Read the project state: chapter, stage, rounds, blocking items, book-level outline/worldbook summary and the next legal step.',
      parameters: {
        chapter: { type: 'integer' },
        project_root: root,
      },
      output: {
        schema: { type: 'json' as const },
        render: (_args: unknown, raw: unknown) => {
          const value = payload(raw) as {
            project: { title: string; root?: string }
            chapter: number
            active_chapter?: number
            stage: string
            rounds?: { review: number; revise: number; check: number }
            blocking: Array<{ code: string; detail: string }>
            next: { tool: string; reason: string }
            selection?: { source: string; root: string }
            metrics?: { total_word_count: number; cjk_chars: number; punctuation_chars: number } | null
            book?: {
              strict: boolean
              outline: {
                total: number
                archived: number
                missing_cards?: number
                coverage: number
                planned_coverage?: number | null
                archived_coverage?: number | null
                current: {
                  num: number
                  title: string
                  scene_type: string
                  target_words: [number, number]
                } | null
              }
              worldbook: {
                characters: number
                locations: number
                factions: number
                rules: number
              }
            }
          }
          const active = value.active_chapter ?? value.chapter
          const where =
            active === value.chapter
              ? `第 ${value.chapter} 章`
              : `当前第 ${active} 章 · 查询第 ${value.chapter} 章字数`
          return text(
            [
              `《${value.project.title}》 ${where} · ${value.stage}`,
              ...(value.selection === undefined
                ? []
                : [`项目根 ${value.selection.root} · 选择来源 ${value.selection.source}`]),
              ...(value.rounds === undefined
                ? []
                : [
                    `轮次：评审 ${value.rounds.review} / 修订 ${value.rounds.revise} / 校验 ${value.rounds.check}`,
                  ]),
              value.blocking.length === 0 ? '门控：全部通过' : `门控：${value.blocking.length} 条阻塞`,
              ...value.blocking.map((item) => `  - ${item.code}: ${item.detail}`),
              ...(value.metrics === null || value.metrics === undefined
                ? []
                : [
                    `字数：${value.metrics.total_word_count}（汉字 ${value.metrics.cjk_chars} + 标点 ${value.metrics.punctuation_chars} + 英文词/数字，含标点）`,
                  ]),
              ...(value.book === undefined
                ? []
                : [
                    `全书：大纲 ${value.book.outline.total} 张卡（规划覆盖 ${value.book.outline.planned_coverage === null || value.book.outline.planned_coverage === undefined ? '—' : percent(value.book.outline.planned_coverage)} · 归档覆盖 ${value.book.outline.archived_coverage === null || value.book.outline.archived_coverage === undefined ? '—' : percent(value.book.outline.archived_coverage)}${(value.book.outline.missing_cards ?? 0) > 0 ? ` · 缺卡 ${value.book.outline.missing_cards}` : ''}）· 世界观 ${value.book.worldbook.characters} 角色 / ${value.book.worldbook.locations} 地点 / ${value.book.worldbook.factions} 势力 / ${value.book.worldbook.rules} 规则${value.book.strict ? ' · 严格大纲' : ''}`,
                    `当前章卡：${
                      value.book.outline.current === null
                        ? '（无）'
                        : `第${value.book.outline.current.num}章 ${value.book.outline.current.title} · ${value.book.outline.current.scene_type} · ${value.book.outline.current.target_words[0]}-${value.book.outline.current.target_words[1]} 字`
                    }`,
                  ]),
              `下一步：${value.next.tool} — ${value.next.reason}`,
            ].join('\n'),
          )
        },
      },
      execute: guarded(async (args) => engine.getStatus({ chapter: args.chapter, root: args.project_root })),
    }),
    defineTool({
      name: 'novel_brief',
      description: 'Fetch the task book for a stage. Issuing it records the digest PG-01 checks.',
      parameters: {
        stage: { type: 'string', required: true, enum: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P8'] as const },
        chapter: { type: 'integer' },
        project_root: root,
      },
      output: {
        schema: { type: 'json' as const },
        render: (_args: unknown, raw: unknown) => {
          const value = payload(raw) as {
            content: string
            digest: string
            fields?: Record<string, unknown>
            context?: Record<string, unknown>
          }
          return text(
            `${value.content}\n\n---\nbrief digest: ${value.digest}${
              value.fields === undefined ? '' : `\nfields:\n${JSON.stringify(value.fields)}`
            }${value.context === undefined ? '' : `\ncontext:\n${JSON.stringify(value.context)}`}`,
          )
        },
      },
      execute: guarded(async (args) =>
        engine.getBrief({ stage: args.stage, chapter: args.chapter, root: args.project_root }),
      ),
    }),
    defineTool({
      name: 'novel_plan_world',
      description: 'Submit the P1 world plan for the active chapter.',
      parameters: {
        objective: { type: 'string', required: true },
        constraints: stringArray('replace', 'P1 constraints; supplied list replaces the plan list.'),
        characters: {
          type: 'json',
          description: arraySemanticsDescription('replace', 'P1 cast; supplied list replaces the cast.'),
        },
        locations: {
          type: 'json',
          description: arraySemanticsDescription('replace', 'P1 locations; supplied list replaces them.'),
        },
        continuity_notes: stringArray('replace', 'P1 continuity notes; supplied list replaces them.'),
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.submitWorldPlan({
          chapter: 0,
          objective: args.objective,
          constraints: (args.constraints as string[]) ?? [],
          characters: asJson<never[]>(args.characters, 'characters') ?? [],
          locations: asJson<never[]>(args.locations, 'locations') ?? [],
          continuity_notes: (args.continuity_notes as string[]) ?? [],
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_plan_chapter',
      description: 'Submit the P2 chapter plan for the active chapter.',
      parameters: {
        title: { type: 'string', required: true },
        scene_type: { type: 'string', required: true, enum: SCENE_TYPES },
        narrator: { type: 'string', required: true },
        beats: {
          ...stringArray('replace', 'Ordered plan beats; supplied list replaces the beats.'),
          required: true,
        },
        opening: { type: 'string', required: true },
        ending: { type: 'string', required: true },
        target_words: {
          type: 'array',
          items: { type: 'integer' },
          required: true,
          description: arraySemanticsDescription('replace', 'Plan [min,max] word target.'),
        },
        cast: {
          type: 'json',
          description: arraySemanticsDescription(
            'replace',
            'Optional 1–8 characters on stage this chapter. Each: name, entry_state, goal, knowledge, exit_change. Names must exist in the P1 world plan or the character ledger.',
          ),
        },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.submitChapterPlan({
          chapter: 0,
          title: args.title,
          scene_type: args.scene_type,
          narrator: args.narrator,
          beats: (args.beats as string[]) ?? [],
          opening: args.opening ?? '',
          ending: args.ending ?? '',
          target_words: args.target_words as [number, number],
          ...(args.cast === undefined ? {} : { cast: asJson<never[]>(args.cast, 'cast') }),
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_write_draft',
      description:
        'Submit the P3 draft. The engine writes the manuscript, validates format and summary, and advances to P4.',
      parameters: {
        chapter: { type: 'integer', required: true },
        content: { type: 'string', required: true },
        chapter_title: { type: 'string', required: true },
        scene_type: { type: 'string', required: true, enum: SCENE_TYPES },
        narrator: { type: 'string', required: true },
        summary: {
          type: 'json',
          required: true,
          description:
            'The ten-field chapter summary required by PG-05. Pass an object (events, characters_appeared, foreshadows, new_elements, resource_changes, opening, continuity, hook_strength, pleasure_points, plot_advancement); a JSON string is accepted too.',
        },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.submitDraft({
          chapter: args.chapter,
          content: args.content,
          chapter_title: args.chapter_title,
          scene_type: args.scene_type,
          narrator: args.narrator,
          summary: asJson(args.summary, 'summary') as never,
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_review',
      description:
        'Submit the P4 scored review with fifteen dimensions, issues and three reading-proof quotes.',
      parameters: {
        chapter: { type: 'integer', required: true },
        dimensions: {
          type: 'json',
          required: true,
          description: arraySemanticsDescription('replace', 'Fifteen scored dimensions.'),
        },
        issues: {
          type: 'json',
          description: arraySemanticsDescription('replace', 'Review issue list.'),
        },
        total: {
          type: 'integer',
          required: true,
          description: '150 - Σdelta, the same number the review reports.',
        },
        proof: {
          type: 'json',
          required: true,
          description: arraySemanticsDescription('replace', 'Three reading-proof quotes.'),
        },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.submitReview({
          chapter: args.chapter,
          dimensions: asJson(args.dimensions, 'dimensions') as never,
          issues: (asJson(args.issues, 'issues') as never) ?? [],
          total: args.total,
          proof: asJson(args.proof, 'proof') as never,
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_revise',
      description: 'Submit a P5 revision. Blockers must be fixed with evidence quoted from the new text.',
      parameters: {
        chapter: { type: 'integer', required: true },
        content: {
          type: 'string',
          description: 'Full revised text; mutually exclusive with patch.',
        },
        patch: {
          type: 'json',
          description:
            'Patch mode: {expected_hash, edits:[{old_text,new_text,occurrence?}]}; edits must be unique unless occurrence is set.',
        },
        summary: {
          type: 'json',
          description:
            'Full ten-field summary. Omit content+patch with a summary to repair only pipeline.draft.summary; this does not consume a revise round.',
        },
        issues: {
          type: 'json',
          description: arraySemanticsDescription('replace', 'Updated issue statuses and evidence for PG-08.'),
        },
        proof: {
          type: 'json',
          description: arraySemanticsDescription(
            'replace',
            'Three quotes from the revised text; required unless this is a summary-only repair. PG-09 verifies them.',
          ),
        },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.submitRevision({
          chapter: args.chapter,
          ...(args.content === undefined ? {} : { content: args.content }),
          ...(args.patch === undefined ? {} : { patch: asJson(args.patch, 'patch') as never }),
          summary: asJson(args.summary, 'summary') as never,
          issues: asJson(args.issues, 'issues') as never,
          proof: asJson(args.proof, 'proof') as never,
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_check',
      description:
        'Run the P6 consistency check. Machine findings and your semantic items form the check document.',
      parameters: {
        chapter: { type: 'integer', required: true },
        scope: stringArray('replace', 'Requested check scopes; supplied list replaces the request.'),
        semantic: {
          type: 'json',
          required: true,
          description: arraySemanticsDescription(
            'replace',
            'Exactly the five P6 semantic items, each with a verbatim evidence quote.',
          ),
        },
        acknowledge: {
          type: 'array',
          items: { type: 'string' },
          description: arraySemanticsDescription(
            'replace',
            'Advisory codes read and accepted; blockers cannot be acknowledged.',
          ),
        },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.runCheck({
          chapter: args.chapter,
          scope: args.scope as string[],
          semantic: asJson(args.semantic, 'semantic') as never[],
          ...(args.acknowledge === undefined ? {} : { acknowledge: args.acknowledge }),
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_archive',
      description:
        'Archive the active chapter: all gates run, then one transaction writes the index, eight ledgers and handoff.',
      parameters: {
        chapter: { type: 'integer', required: true },
        state_delta: { type: 'json', required: true },
        handoff: { type: 'json' },
        project_root: root,
      },
      output: {
        schema: { type: 'json' as const },
        render: (_args: unknown, raw: unknown) => {
          const value = payload(raw) as {
            chapter: number
            score: number
            metrics: { total_word_count: number }
            assigned_ids: Record<string, string>
          }
          return withReplay(
            text(
              [
                `第 ${value.chapter} 章已归档`,
                `字数 ${value.metrics.total_word_count} · 评分 ${value.score}/150`,
                Object.keys(value.assigned_ids).length === 0
                  ? '无新 ID'
                  : `分配 ID：${Object.entries(value.assigned_ids)
                      .map(([key, id]) => `${key}→${id}`)
                      .join(', ')}`,
              ].join('\n'),
            ),
            raw,
          )
        },
      },
      execute: guarded(async (args) =>
        engine.archiveChapter({
          chapter: args.chapter,
          state_delta: asJson(args.state_delta, 'state_delta') as never,
          handoff: asJson(args.handoff, 'handoff') as never,
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_word_count',
      description: 'Count words with the engine rule (CJK chars + English words + numbers + punctuation).',
      parameters: {
        text: { type: 'string' },
        chapter: { type: 'integer' },
        project_root: utilityRoot,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.countWords({ text: args.text, chapter: args.chapter, root: args.project_root }),
      ),
    }),
    defineTool({
      name: 'novel_state',
      description:
        'Read a state document (ledgers, plans, review, check, outline, worldbook), list brief receipts, revision history or backup manifests without touching the manuscript.',
      parameters: {
        kind: {
          type: 'string',
          required: true,
          enum: [
            'pipeline',
            'chapters',
            'characters',
            'world',
            'locks',
            'timeline',
            'foreshadows',
            'relationships',
            'handoff',
            'review',
            'check',
            'novel',
            'planWorld',
            'planChapter',
            'outline',
            'worldbook',
            'history',
            'backups',
            'briefs',
          ] as const,
        },
        chapter: { type: 'integer' },
        revision: { type: 'integer' },
        include_summary: {
          type: 'boolean',
          description: 'For kind=chapters: include the full ten-field summary (default compact).',
        },
        chapter_range: {
          type: 'array',
          items: { type: 'integer' },
          description: arraySemanticsDescription(
            'replace',
            'For kind=chapters: inclusive [start, end] range.',
          ),
        },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.queryState({
          kind: args.kind,
          chapter: args.chapter,
          ...(args.revision === undefined ? {} : { revision: args.revision }),
          ...(args.include_summary === undefined ? {} : { include_summary: args.include_summary }),
          ...(args.chapter_range === undefined
            ? {}
            : { chapter_range: args.chapter_range as [number, number] }),
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_amend',
      description: 'Explicitly amend one state document with a reason; the journal records the intent.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          enum: [
            'novel.yaml',
            'state/chapters.yaml',
            'state/characters.yaml',
            'state/world.yaml',
            'state/locks.yaml',
            'state/timeline.yaml',
            'state/foreshadows.yaml',
            'state/relationships.yaml',
            'state/handoff.yaml',
            'outline/outline.yaml',
            'outline/worldbook.yaml',
          ] as const,
        },
        content: { type: 'json', required: true },
        reason: { type: 'string', required: true },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.amend({
          path: args.path,
          content: asJson<Record<string, unknown>>(args.content, 'content'),
          reason: args.reason,
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_rollback',
      description:
        'Restart a chapter at an earlier stage. The manuscript is kept for reference; rounds reset.',
      parameters: {
        chapter: { type: 'integer', required: true },
        to_stage: { type: 'string', required: true, enum: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'] as const },
        reason: { type: 'string' },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.rollback({
          chapter: args.chapter,
          toStage: args.to_stage,
          reason: args.reason,
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_diff',
      description: 'Diff a chapter against its last archived backup, or between two supplied texts.',
      parameters: {
        chapter: { type: 'integer' },
        before: { type: 'string' },
        after: { type: 'string' },
        project_root: utilityRoot,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.diff({
          chapter: args.chapter,
          before: args.before,
          after: args.after,
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_export',
      description:
        'Export the manuscript as Markdown, plain text or EPUB 3, or export the whole-book outline, worldbook or proposal.',
      parameters: {
        kind: {
          type: 'string',
          required: true,
          enum: ['md', 'txt', 'epub', 'outline', 'worldbook', 'proposal'] as const,
        },
        chapter: { type: 'integer' },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.export({ kind: args.kind, chapter: args.chapter, root: args.project_root }),
      ),
    }),
    defineTool({
      name: 'novel_audit',
      description:
        'Read the append-only journal, including refused gate attempts, with chapter/op/status/time filters and a revision cursor.',
      parameters: {
        limit: { type: 'integer' },
        cursor: { type: 'integer' },
        chapter: { type: 'integer' },
        op: { type: 'string' },
        status: { type: 'string', enum: ['committed', 'aborted'] as const },
        since: { type: 'string' },
        until: { type: 'string' },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.auditHistory({
          limit: args.limit,
          cursor: args.cursor,
          chapter: args.chapter,
          op: args.op,
          status: args.status,
          since: args.since,
          until: args.until,
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_pipeline',
      description: 'Answer "what do I do next": the recommended tool, arguments and the blocking reasons.',
      parameters: { project_root: root },
      output: jsonOutput,
      execute: guarded(async (args) => engine.advise({ root: args.project_root })),
    }),
    defineTool({
      name: 'novel_blueprint',
      description:
        'Write the book-level blueprint: premise, logline, themes, tone, POV, audience, selling points, ending and volume structure. It does not require a chapter stage; call novel_outline next.',
      parameters: {
        premise: { type: 'string' },
        logline: { type: 'string' },
        themes: stringArray('replace', 'Book themes; supplied list replaces the theme list.'),
        tone: { type: 'string' },
        pov: { type: 'string' },
        audience: { type: 'string' },
        selling_points: stringArray('replace', 'Selling points; supplied list replaces the list.'),
        ending: { type: 'string' },
        strict: { type: 'boolean', description: 'Require a chapter card before P2/P3.' },
        volumes: {
          type: 'json',
          description: arraySemanticsDescription(
            'replace',
            'Volume list: [{title,start_chapter,end_chapter,goal?,arc?,climax?,status?}]. Replaces the current volumes; dropping any volume requires confirm_remove:true.',
          ),
        },
        confirm_remove: {
          type: 'boolean',
          description: 'Explicitly confirm a volume-list replacement that drops existing volumes.',
        },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.submitBookPlan({
          premise: args.premise as string,
          logline: args.logline as string,
          themes: args.themes as string[],
          tone: args.tone as string,
          pov: args.pov as string,
          audience: args.audience as string,
          selling_points: args.selling_points as string[],
          ending: args.ending as string,
          strict: args.strict as boolean,
          volumes: asJson(args.volumes, 'volumes') as never,
          confirm_remove: args.confirm_remove as boolean,
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_outline',
      description:
        'Upsert volume/chapter cards by key: chapters by num, volumes by title. Omitted cards are preserved; deletion requires remove/remove_volumes. Archived cards are preserved and cannot be rewritten. Use dry_run to preview. On the first submission strict mode defaults on; with an existing card, PG-13 checks title, scene, target words and cast even in non-strict mode.',
      parameters: {
        book: { type: 'json', description: 'Optional partial book blueprint patch.' },
        volumes: {
          type: 'json',
          description: arraySemanticsDescription(
            'upsert',
            'Volume list: [{title,start_chapter,end_chapter,goal?,arc?,climax?,status?}]. Upserts by title; omitted volumes are kept.',
          ),
        },
        chapters: {
          type: 'json',
          description: arraySemanticsDescription(
            'upsert',
            'Chapter cards: [{num,title,scene_type,goal,conflict,hook,cast?,target_words:[min,max],volume?,notes?}]. Upserts by num; omitted cards are kept.',
          ),
        },
        remove: {
          type: 'array',
          items: { type: 'integer' },
          description: arraySemanticsDescription('remove', 'Explicit chapter numbers to delete.'),
        },
        remove_volumes: {
          type: 'array',
          items: { type: 'string' },
          description: arraySemanticsDescription('remove', 'Explicit volume titles to delete.'),
        },
        dry_run: { type: 'boolean', description: 'Preview changes without writing or journaling.' },
        strict: { type: 'boolean' },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.submitOutline({
          book: asJson(args.book, 'book') as never,
          volumes: asJson(args.volumes, 'volumes') as never,
          chapters: asJson(args.chapters, 'chapters') as never,
          remove: args.remove as number[],
          remove_volumes: args.remove_volumes as string[],
          dry_run: args.dry_run as boolean,
          strict: args.strict as boolean,
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_outline_import',
      description:
        'Import an existing outline from Markdown, YAML or JSON. Use dry_run to preview without writing; apply, then call novel_status.',
      parameters: {
        format: { type: 'string', required: true, enum: ['markdown', 'yaml', 'json'] as const },
        content: { type: 'string', required: true },
        dry_run: { type: 'boolean' },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.importOutline({
          format: args.format,
          content: args.content,
          dry_run: args.dry_run,
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_worldbook',
      description:
        'Update the worldbuilding bible (setting, rules, factions, locations, characters, glossary, backstory). Only supplied sections are replaced.',
      parameters: {
        premise: { type: 'string' },
        setting: { type: 'string' },
        rules: { type: 'json', description: arraySemanticsDescription('replace', 'Rules section list.') },
        factions: {
          type: 'json',
          description: arraySemanticsDescription('replace', 'Factions section list.'),
        },
        locations: {
          type: 'json',
          description: arraySemanticsDescription('replace', 'Locations section list.'),
        },
        characters: {
          type: 'json',
          description: arraySemanticsDescription('replace', 'Characters section list.'),
        },
        glossary: {
          type: 'json',
          description: arraySemanticsDescription('replace', 'Glossary section list.'),
        },
        backstory: {
          type: 'json',
          description: arraySemanticsDescription('replace', 'Backstory section list.'),
        },
        facts: {
          type: 'json',
          description: arraySemanticsDescription(
            'replace',
            'Declared numeric canon: [{alias,value,unit,tolerance?,note?}].',
          ),
        },
        themes: stringArray('replace', 'Worldbook themes; supplied list replaces the list.'),
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.submitWorldbook({
          premise: args.premise as string,
          setting: args.setting as string,
          rules: asJson(args.rules, 'rules') as never,
          factions: asJson(args.factions, 'factions') as never,
          locations: asJson(args.locations, 'locations') as never,
          characters: asJson(args.characters, 'characters') as never,
          glossary: asJson(args.glossary, 'glossary') as never,
          backstory: asJson(args.backstory, 'backstory') as never,
          ...(args.facts === undefined ? {} : { facts: asJson(args.facts, 'facts') as never }),
          themes: args.themes as string[],
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_search',
      description:
        'Search manuscripts, summaries, outline, worldbook or ledgers; results carry chapter and paragraph.',
      parameters: {
        query: { type: 'string', required: true },
        scope: {
          type: 'string',
          enum: ['all', 'chapters', 'summaries', 'outline', 'worldbook', 'ledgers'] as const,
        },
        limit: { type: 'integer' },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.search({
          query: args.query,
          scope: args.scope,
          limit: args.limit,
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_doctor',
      description:
        'Run a read-only health check: project, pipeline, state, journal, manuscripts, outline coverage/drift, stage products, backups, lock and next step.',
      parameters: { project_root: root },
      output: jsonOutput,
      execute: guarded(async (args) => engine.doctor({ root: args.project_root })),
    }),
    defineTool({
      name: 'novel_report',
      description:
        'Whole-book report: progress, outline coverage/drift, worldbook counts, quality trend, pacing, cast, foreshadows, timeline, relationships and activity.',
      parameters: { project_root: root },
      output: jsonOutput,
      execute: guarded(async (args) => engine.report({ root: args.project_root })),
    }),
    defineTool({
      name: 'novel_guide',
      description:
        'Onboarding guide: what is done, what to do next, which tool to call and the relevant commands. Works before a project exists.',
      parameters: { project_root: root },
      output: jsonOutput,
      execute: guarded(async (args) => engine.guide({ root: args.project_root })),
    }),
    defineTool({
      name: 'novel_reopen',
      description:
        'Reopen the immediately preceding archived chapter from its archive backup, returning it to P3 so it can be revised and re-archived. A reason is mandatory and is recorded in the journal.',
      parameters: {
        chapter: { type: 'integer', required: true },
        reason: { type: 'string', required: true },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.reopenChapter({ chapter: args.chapter, reason: args.reason, root: args.project_root }),
      ),
    }),
    defineTool({
      name: 'novel_restore',
      description:
        'Restore an active chapter file, or outline/outline.yaml, from a marked backup transaction. Archived chapters are refused; use novel_reopen first. Every restore is itself journaled and backed up.',
      parameters: {
        txid: { type: 'string', required: true },
        chapter: { type: 'integer' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: arraySemanticsDescription(
            'replace',
            'Project-relative chapter files, or exactly [outline/outline.yaml]; omitted restores every restorable chapter file the manifest records.',
          ),
        },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.restoreBackup({
          txid: args.txid,
          chapter: args.chapter,
          ...(args.paths === undefined ? {} : { paths: args.paths }),
          root: args.project_root,
        }),
      ),
    }),
  ]
}

/** Only the names the adapter actually registered. */
export function toolNames(mode: 'all' | 'core'): ToolName[] {
  return TOOL_NAMES.filter((name) => mode === 'all' || CORE_TOOLS.includes(name))
}

/** Empty summary used when a revision omits it; the plan copy keeps the previous one. */
export function emptySummary(): import('../types.js').ChapterSummary {
  return {
    events: [],
    characters_appeared: [],
    foreshadows: { planted: [], advanced: [], resolved: [] },
    new_elements: { locations: [], abilities: [], artifacts: [] },
    resource_changes: [],
    opening: '',
    continuity: { opens_from: '', ends_with: '' },
    hook_strength: 3,
    pleasure_points: [],
    plot_advancement: 'mid',
  }
}
