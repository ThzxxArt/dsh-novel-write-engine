import { defineTool, type ParameterPropertySpec, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { CORE_TOOLS, STYLE_PACK_CHOICES, STYLE_PACK_LINES, TOOL_NAMES, type ToolName } from '../constants.js'
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
import { amendPatchTouchesKey, type EngineCaller, type EngineService } from '../engine/service.js'

/**
 * Compatibility helper for already-serialized legacy payloads and dynamic
 * maps. Model-facing schemas are typed and reject strings before this runs;
 * the string branch is kept only for old callers that invoke the adapter
 * directly.
 */
const asJson = <T>(value: unknown, field: string): T => {
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    throw new EngineInputError(
      ERROR_CODES.SCHEMA_INVALID,
      `${field} must be a JSON object`,
      `send ${field} as an object, not a serialized string`,
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
    // field/expected/received/allowed are the whole point of the diagnostics
    // contract; without this line the model only saw the prose message (U4,
    // M11, M16).
    const structured = error.details === undefined ? '' : `\ndetails: ${JSON.stringify(error.details)}`
    throw new Error(
      `[${error.code}] ${error.message}${error.hint === undefined ? '' : ` — ${error.hint}`}${blocking}${details}${structured}`,
    )
  }
  throw error
}

export interface WorkingDirectoryLike {
  ensure(agent: { id?: string }, signal?: AbortSignal): Promise<string>
}

/**
 * How the host's `workingDirectory` service reaches the tools. `resolve` is
 * preferred: it is called per invocation so a provider that registers after
 * this plugin applies is still found.
 */
export interface WorkingDirectoryOptions {
  workingDirectory?: WorkingDirectoryLike
  resolveWorkingDirectory?: () => WorkingDirectoryLike | undefined
}

/**
 * 0.2.17: the slice of `ctx.userQuestions` the tools use.
 *
 * Structural typing on purpose — the plugin must not depend on the interaction
 * package, and a host without the service is a supported configuration (the
 * confirmation degrades to `skipped:no-provider`, it does not crash).
 */
export interface UserQuestionsLike {
  ask(request: {
    questions: Array<{
      id: string
      question: string
      header?: string
      detail?: string
      options?: Array<{ label: string; description?: string }>
      multiSelect?: boolean
    }>
    agent?: unknown
    signal?: AbortSignal
  }): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>
}

export interface UserQuestionsOptions {
  userQuestions?: UserQuestionsLike
  resolveUserQuestions?: () => UserQuestionsLike | undefined
}

/** How a confirmation gate ended; persisted so a downgrade is never silent. */
export type Confirmation =
  'confirmed' | 'skipped:no-provider' | 'skipped:delegated' | 'skipped:not-live' | 'skipped:disabled'

/** The label that means "do not write anything yet". */
const CONFIRM_REJECT = '我要改'

/** Result of a confirmation gate: either a state to record, or a refusal. */
type ConfirmOutcome =
  | { ok: true; confirmation: Confirmation; note: string | null }
  | { ok: false; code: 'CONFIRMATION_REJECTED' | 'CONFIRMATION_ABORTED'; message: string }

const resolveQuestions = (options: UserQuestionsOptions): UserQuestionsLike | undefined =>
  options.resolveUserQuestions?.() ?? options.userQuestions

/**
 * Ask the human before an irreversible write.
 *
 * The error codes are the whole point: `NO_PROVIDER`, `DELEGATED_CALLER` and
 * `CALLER_NOT_LIVE` mean "no human is reachable from here" and degrade, while
 * `ASK_ABORTED`/`ASK_CANCELLED` mean "the human declined to answer" and must
 * fail closed. Anything else also fails closed: an unexpected host error is not
 * permission to write.
 */
async function confirmWrite(
  options: UserQuestionsOptions,
  exec: ToolExec | undefined,
  request: { id: string; header: string; question: string },
): Promise<ConfirmOutcome> {
  const service = resolveQuestions(options)
  if (service === undefined) {
    return { ok: true, confirmation: 'skipped:no-provider', note: '宿主没有提问服务，本次未经用户确认' }
  }
  let answer: { answers: Array<{ id: string; selected: string[]; custom?: string }> }
  try {
    answer = await service.ask({
      questions: [
        {
          id: request.id,
          header: request.header,
          question: request.question,
          options: [{ label: '就这个' }, { label: CONFIRM_REJECT }],
        },
      ],
      agent: exec?.agent,
      signal: exec?.signal,
    })
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : ''
    if (code === 'NO_PROVIDER') {
      return { ok: true, confirmation: 'skipped:no-provider', note: '没有可用的回答方，本次未经用户确认' }
    }
    if (code === 'DELEGATED_CALLER') {
      return { ok: true, confirmation: 'skipped:delegated', note: '子代理不能弹窗，本次未经用户确认' }
    }
    if (code === 'CALLER_NOT_LIVE') {
      return { ok: true, confirmation: 'skipped:not-live', note: '调用方不是活动会话，本次未经用户确认' }
    }
    if (code === 'ASK_ABORTED' || code === 'ASK_CANCELLED') {
      return { ok: false, code: 'CONFIRMATION_ABORTED', message: '用户没有确认，已中止；没有写入任何文件' }
    }
    return {
      ok: false,
      code: 'CONFIRMATION_ABORTED',
      message: `提问失败（${code === '' ? 'unknown' : code}），已中止；没有写入任何文件`,
    }
  }
  const answerItem = answer.answers.find((item) => item.id === request.id)
  const selected = answerItem?.selected ?? []
  const custom = answerItem?.custom?.trim() ?? ''
  // A typed answer is a decision too. Treating "风格换成怪谈" as consent would
  // create the book with the values the user just rejected, and the model would
  // never learn why — so any free text fails closed and is quoted back.
  if (selected.includes(CONFIRM_REJECT) || custom !== '') {
    return {
      ok: false,
      code: 'CONFIRMATION_REJECTED',
      // The message is the difference between "no" and a dead end: it tells the
      // model exactly what to ask next.
      message:
        custom === ''
          ? '用户要求修改，已中止；没有写入任何文件。请逐个询问题材（12 选 1）、平台（4 选 1）、字数区间、对白比区间、风格（8 选 1 或 none），拿到明确答复后带新参数重新调用。'
          : `用户没有点选项，而是写了「${custom}」。已中止，没有写入任何文件。请按这句话逐项确认后带新参数重新调用。`,
    }
  }
  return { ok: true, confirmation: 'confirmed', note: null }
}

const resolveService = (options: WorkingDirectoryOptions): WorkingDirectoryLike | undefined =>
  options.resolveWorkingDirectory?.() ?? options.workingDirectory

interface ToolExec {
  signal?: AbortSignal
  agent?: { id?: string }
}

/** Wrap an execute body with caller context, cancellation and a machine-code error. */
const makeGuarded =
  (engine: EngineService, options: WorkingDirectoryOptions = {}) =>
  <A>(body: (args: A, exec?: ToolExec) => Promise<unknown>) =>
  async (args: A, exec?: ToolExec): Promise<any> => {
    const workingDirectory = resolveService(options)
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
      const invoke = (): Promise<unknown> => engine.withSignal(exec?.signal, () => body(args, exec))
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

/* Typed schema builders. Every model-visible object is explicit; only the two
 * genuinely dynamic maps (state_delta entries and new_element_anchors) stay
 * open because DSH's JSON-Schema subset cannot type their keys. */
const str: ParameterPropertySpec = { type: 'string' }
const int: ParameterPropertySpec = { type: 'integer' }
const num: ParameterPropertySpec = { type: 'number' }
const bool: ParameterPropertySpec = { type: 'boolean' }
const nullableInt: ParameterPropertySpec = { oneOf: [{ type: 'integer' }, { type: 'null' }] }
const nullableStr: ParameterPropertySpec = { oneOf: [{ type: 'string' }, { type: 'null' }] }
const required = <T extends ParameterPropertySpec>(value: T): T & { required: true } => ({
  ...value,
  required: true,
})
const optional = <T extends ParameterPropertySpec>(value: T): ParameterPropertySpec => {
  const copy = { ...value } as Record<string, unknown>
  delete copy.required
  return copy as unknown as ParameterPropertySpec
}
const arrayOf = (items: ParameterPropertySpec): ParameterPropertySpec => ({ type: 'array', items })
const objectOf = (properties: ParameterSchemaSpec): ParameterPropertySpec => ({
  type: 'object',
  additionalProperties: false,
  properties,
})
const openObject = (description?: string): ParameterPropertySpec => ({
  type: 'object',
  additionalProperties: true,
  ...(description === undefined ? {} : { description }),
})
const openObjectWith = (properties: ParameterSchemaSpec, description?: string): ParameterPropertySpec => ({
  type: 'object',
  additionalProperties: true,
  properties,
  ...(description === undefined ? {} : { description }),
})

const readingProofRef = objectOf({
  chapter: int,
  paragraph: required(int),
  quote: required(str),
})
const proofSchema = required(
  objectOf({
    opening: required(readingProofRef),
    middle: required(readingProofRef),
    ending: required(readingProofRef),
  }),
)
const issueSchema = objectOf({
  id: required(str),
  severity: required({ type: 'string', enum: ['blocker', 'advisory'] as const }),
  dimension: required(str),
  location: required(str),
  problem: required(str),
  fix: required(str),
  status: required({ type: 'string', enum: ['open', 'fixed', 'waived'] as const }),
  evidence: str,
})
const issueUpdateSchema = objectOf({
  id: required(str),
  status: required({ type: 'string', enum: ['open', 'fixed', 'waived'] as const }),
  evidence: str,
  severity: { type: 'string', enum: ['blocker', 'advisory'] as const },
  dimension: str,
  location: str,
  problem: str,
  fix: str,
})
const dimensionSchema = objectOf({
  id: required(str),
  max: required(int),
  deductions: required(
    arrayOf(
      objectOf({
        rule: required(str),
        location: required(str),
        delta: required(int),
        note: required(str),
      }),
    ),
  ),
})
const summarySchema = required(
  objectOf({
    events: required(arrayOf(str)),
    characters_appeared: required(arrayOf(str)),
    foreshadows: required(
      objectOf({
        planted: required(
          arrayOf(
            objectOf({
              key: required(str),
              title: required(str),
              description: required(str),
              anchor: str,
              planned_resolve: nullableInt,
              kind: { type: 'string', enum: ['plot', 'motif'] as const },
            }),
          ),
        ),
        advanced: required(
          arrayOf(
            objectOf({
              key: required(str),
              note: required(str),
              new_info: required(bool),
            }),
          ),
        ),
        resolved: required(arrayOf(str)),
      }),
    ),
    new_elements: required(
      objectOf({
        locations: required(arrayOf(str)),
        abilities: required(arrayOf(str)),
        artifacts: required(arrayOf(str)),
      }),
    ),
    new_element_anchors: openObject('实体名到正文锚点数组的动态映射；值形状由引擎校验'),
    resource_changes: required(
      arrayOf(
        objectOf({
          character: required(str),
          resource: required(str),
          delta: required(int),
          reason: required(str),
        }),
      ),
    ),
    opening: required(str),
    continuity: required(objectOf({ opens_from: required(str), ends_with: required(str) })),
    hook_strength: required({ type: 'integer', enum: [1, 2, 3, 4, 5] as const }),
    pleasure_points: required(arrayOf(str)),
    plot_advancement: required({ type: 'string', enum: ['high', 'mid', 'low'] as const }),
  }),
)
const volumeSchema = objectOf({
  id: str,
  title: required(str),
  start_chapter: required(int),
  end_chapter: required(int),
  goal: str,
  arc: str,
  climax: str,
  status: { type: 'string', enum: ['planned', 'writing', 'done'] as const },
})
const chapterCardSchema = openObjectWith({
  num: required(int),
  volume: nullableInt,
  title: required(str),
  scene_type: required({ type: 'string', enum: SCENE_TYPES }),
  goal: required(str),
  conflict: required(str),
  hook: required(str),
  cast: arrayOf(str),
  target_words: required(arrayOf(int)),
  notes: str,
  status: { type: 'string', enum: ['planned', 'archived'] as const },
  archived_at: nullableStr,
  word_count: nullableInt,
  score: nullableInt,
})
const dynamicSection = (description: string): ParameterPropertySpec => openObject(description)
const stateDeltaSchema = required(
  objectOf({
    characters: required(
      dynamicSection('人物名到 {action,reason?,role?,profile?,current_state?,growth?} 的映射'),
    ),
    foreshadows: required(
      dynamicSection(
        'key 到 {action,title?,anchor?,planned_resolve?,kind?,resolved_anchor?,description?,note?,new_info?} 的映射',
      ),
    ),
    timeline: required(
      dynamicSection(
        'summary.events 下标或稳定 event_key 到 {action,story_time?,description?,location?,characters?} 的映射',
      ),
    ),
    world: required(dynamicSection('名称到 {action,kind?,description?,layout?,capacity?} 的映射')),
    relationships: required(
      dynamicSection(
        '"甲|乙" 到 {action,type?,type_code?,description?,note?} 的映射；created 必须带 type_code',
      ),
    ),
  }),
)
const handoffSchema = objectOf({
  volume: int,
  volume_name: str,
  act: str,
  act_progress: str,
})
const worldbookRule = objectOf({ name: required(str), description: required(str) })
const worldbookFaction = objectOf({
  name: required(str),
  description: required(str),
  goal: str,
})
const worldbookLocation = objectOf({
  name: required(str),
  description: required(str),
  layout: str,
  capacity: int,
})
const worldbookCharacter = objectOf({
  name: required(str),
  role: required(str),
  description: required(str),
  arc: str,
  appearance: str,
})
const worldbookGlossary = objectOf({ term: required(str), definition: required(str) })
const worldbookBackstory = objectOf({ time: required(str), event: required(str) })
const worldbookFact = objectOf({
  alias: required(str),
  value: required(num),
  unit: required(str),
  tolerance: num,
  note: str,
})

const root = {
  type: 'string' as const,
  description: 'Project root; omit to use the session binding or the only project.',
}
const initRoot = {
  type: 'string' as const,
  description: 'New project root; omit to use the configured projectRoot.',
}
const utilityRoot = {
  type: 'string' as const,
  description: 'Project root for project-backed mode; text-only calls ignore it.',
}

/**
 * The twenty-eight tools are thin adapters: narrow parameters, call one service
 * operation, render the canonical value. They never read a file.
 */
export function createNovelTools(
  engine: EngineService,
  options: WorkingDirectoryOptions & UserQuestionsOptions = {},
): ReturnType<typeof defineTool>[] {
  const guarded = makeGuarded(engine, options)
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
        dialogue_ratio: {
          type: 'array',
          items: { type: 'number' },
          description: arraySemanticsDescription('replace', 'Dialogue ratio [min,max] within 0..1.'),
        },
        min_cjk_chars: {
          ...nullableInt,
          description:
            'Optional CJK-only lower bound; null disables it (the total word target still applies).',
        },
        dialogue_ratio_metric: {
          type: 'string',
          enum: ['lines', 'chars', 'both'] as const,
          description: 'Which dialogue measure the advisory uses; default both.',
        },
        style: {
          type: 'string',
          required: true,
          enum: [...STYLE_PACK_CHOICES, 'none'] as const,
          description: [
            'PERMANENT style choice: one of the eight bundled packs, or "none" for no style.',
            'It cannot be changed after creation — changing your mind means creating a new project.',
            'ASK THE USER FIRST and let them pick; do not choose on their behalf. The plugin will',
            'show them one confirmation dialog before anything is written, and `confirm: false`',
            'skips that dialog for scripts and subagents.',
            'Pack catalogue:',
            ...STYLE_PACK_LINES,
          ].join('\n'),
        },
        confirm: {
          type: 'boolean',
          description:
            'Default true. When true the plugin asks the user to confirm the five permanent fields before writing anything; false skips the dialog (scripts, CI, subagents).',
        },
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
      execute: guarded(async (args, exec) => {
        // WP13: the five permanent fields go in front of the user *before*
        // anything touches the disk. This is the gate, not a suggestion to the
        // model — the tool itself blocks.
        let confirmation: Confirmation = 'skipped:disabled'
        let note: string | null = null
        if (args.confirm !== false) {
          const words = Array.isArray(args.words_per_chapter)
            ? `${args.words_per_chapter[0]}–${args.words_per_chapter[1]}`
            : '平台默认'
          const dialogue = Array.isArray(args.dialogue_ratio)
            ? `${args.dialogue_ratio[0]}–${args.dialogue_ratio[1]}`
            : '平台默认'
          const outcome = await confirmWrite(options, exec, {
            id: 'init-confirm',
            header: '确认开书参数',
            question: [
              `题材：${String(args.genre)}`,
              `平台：${String(args.platform)}`,
              `字数：${words}`,
              `对白：${dialogue}`,
              `风格：${String(args.style)}`,
              '',
              '这五项创建后不可更改，确认吗？',
            ].join('\n'),
          })
          if (!outcome.ok) {
            throw new EngineInputError(
              outcome.code === 'CONFIRMATION_REJECTED'
                ? ERROR_CODES.CONFIRMATION_REJECTED
                : ERROR_CODES.CONFIRMATION_ABORTED,
              outcome.message,
              'nothing was written; ask the user again with the values they want',
            )
          }
          confirmation = outcome.confirmation
          note = outcome.note
        }
        const result = await engine.initProject({
          title: args.title,
          genre: args.genre as Genre,
          platform: args.platform as Platform,
          author: args.author as string,
          description: args.description as string,
          words_per_chapter: args.words_per_chapter as [number, number],
          total_chapters: args.total_chapters as number,
          dialogue_ratio: args.dialogue_ratio as [number, number] | undefined,
          min_cjk_chars: args.min_cjk_chars as number | null | undefined,
          dialogue_ratio_metric: args.dialogue_ratio_metric as 'lines' | 'chars' | 'both' | undefined,
          style: args.style as string,
          style_confirmation: confirmation,
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
        })
        return {
          ...result,
          data: {
            ...(result.data as Record<string, unknown>),
            confirmation,
            ...(note === null ? {} : { confirmation_note: note }),
          },
        }
      }),
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
            progress?: { label: string }
            rounds?: { review: number; revise: number; check: number }
            blocking: Array<{ code: string; detail: string }>
            /** 0.2.17: crash-recovery advisories were invisible on this channel. */
            warnings?: Array<{ code: string; message: string }>
            state_errors?: Array<{ path: string; code: string; message: string }>
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
          const progressLabel = value.progress?.label ?? `第 ${value.chapter} 章 · 阶段 ${value.stage}`
          return text(
            [
              `《${value.project.title}》`,
              `进度：${progressLabel}`,
              ...(active === value.chapter
                ? []
                : [`字数查询：第 ${value.chapter} 章（活动章第 ${active} 章）`]),
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
              ...(value.warnings === undefined || value.warnings.length === 0
                ? []
                : [
                    `恢复提示：${value.warnings.length} 条`,
                    ...value.warnings.map((item) => `  - ${item.code}: ${item.message}`),
                  ]),
              ...(value.state_errors === undefined || value.state_errors.length === 0
                ? []
                : [
                    `状态文档不可读：${value.state_errors.length} 条（先修复，否则门控会一直失败）`,
                    ...value.state_errors.map((item) => `  - ${item.code} @ ${item.path}: ${item.message}`),
                  ]),
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
      description:
        'Fetch the task book for a stage. Issuing it records the digest PG-01 checks. Pass `stage` for one stage or `stages` for several in one transaction.',
      parameters: {
        stage: {
          type: 'string',
          enum: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P8'] as const,
          description: 'Single stage to sign. Omit it when passing `stages`.',
        },
        stages: {
          type: 'array',
          items: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P8'] as const },
          description: arraySemanticsDescription(
            'replace',
            '一次性签发多个阶段：同一事务写一条批量收据，返回 briefs[]。',
          ),
        },
        chapter: { type: 'integer' },
        project_root: root,
      },
      output: {
        schema: { type: 'json' as const },
        render: (_args: unknown, raw: unknown) => {
          type OneBrief = {
            stage?: string
            chapter?: number
            content?: string
            digest?: string
            fields?: Record<string, unknown>
            context?: Record<string, unknown>
          }
          const value = payload(raw) as OneBrief & { briefs?: OneBrief[] }
          // A batch request used to render only the first stage; the model paid
          // for the transaction and never saw P6/P8 (0.2.17 P1-19).
          const briefs = Array.isArray(value.briefs) && value.briefs.length > 0 ? value.briefs : [value]
          return text(
            briefs
              .map((brief) =>
                [
                  brief.stage === undefined ? '' : `# ${brief.stage}`,
                  brief.content ?? '',
                  `brief digest: ${brief.digest ?? ''}`,
                  brief.fields === undefined ? '' : `fields:\n${JSON.stringify(brief.fields)}`,
                  brief.context === undefined ? '' : `context:\n${JSON.stringify(brief.context)}`,
                ]
                  .filter((line) => line !== '')
                  .join('\n'),
              )
              .join('\n\n---\n\n'),
          )
        },
      },
      execute: guarded(async (args) =>
        engine.getBrief({
          ...(args.stage === undefined ? {} : { stage: args.stage }),
          ...(args.stages === undefined ? {} : { stages: args.stages as never[] }),
          chapter: args.chapter,
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_plan_world',
      description: 'Submit the P1 world plan for the active chapter.',
      parameters: {
        objective: { type: 'string', required: true },
        constraints: stringArray('replace', 'P1 constraints; supplied list replaces the plan list.'),
        characters: {
          ...arrayOf(objectOf({ name: required(str), role: required(str), current_state: required(str) })),
          description: arraySemanticsDescription('replace', 'P1 cast; supplied list replaces the cast.'),
        },
        locations: {
          ...arrayOf(objectOf({ name: required(str), layout: required(str), capacity: required(num) })),
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
          ...arrayOf(
            objectOf({
              name: required(str),
              entry_state: str,
              goal: str,
              // Item types are checked by the engine, which can say which index
              // held which type; a tool-level `array of string` can only say
              // "must be an array" (M16).
              knowledge: {
                type: 'array',
                description: 'String array of what this character knows entering the chapter.',
              },
              exit_change: str,
            }),
          ),
          description: arraySemanticsDescription(
            'replace',
            'Optional 1–8 characters on stage this chapter; names must exist in the P1 world plan or the character ledger.',
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
          ...summarySchema,
          description:
            'The ten-field chapter summary required by PG-05; send a JSON object, not a JSON string.',
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
          ...arrayOf(dimensionSchema),
          // Optional at the boundary: `amend_issues` never reads it, and the
          // engine still rejects a normal review that omits it with a message
          // that names all three required parts.
          description: arraySemanticsDescription('replace', 'Fifteen scored dimensions.'),
        },
        issues: {
          ...arrayOf(issueSchema),
          description: arraySemanticsDescription('replace', 'Review issue list.'),
        },
        total: {
          type: 'integer',
          description: '150 - Σdelta；省略时由引擎实算，传了就必须一致。',
        },
        proof: {
          ...optional(proofSchema),
          description: arraySemanticsDescription(
            'replace',
            'Three reading-proof quotes; omitted only for amend_issues.',
          ),
        },
        amend_issues: {
          type: 'array',
          items: objectOf({
            id: required(str),
            status: { type: 'string', enum: ['open', 'fixed', 'waived'] as const },
            severity: { type: 'string', enum: ['blocker', 'advisory'] as const },
            location: str,
            problem: str,
            fix: str,
            // Required in practice when a blocker is marked fixed: PG-08 verifies
            // the same quote, so an amendment without it would be a lie.
            evidence: str,
          }),
          description: arraySemanticsDescription(
            'replace',
            'P5/P6/ready_to_archive 就地修正评审元数据；不消耗评审轮次。把 blocker 改为 fixed 时必须给 evidence（正文原句）。',
          ),
        },
        amend_note: str,
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.submitReview({
          chapter: args.chapter,
          dimensions: asJson(args.dimensions, 'dimensions') as never,
          issues: (asJson(args.issues, 'issues') as never) ?? [],
          ...(args.total === undefined ? {} : { total: args.total }),
          proof: asJson(args.proof, 'proof') as never,
          ...(args.amend_issues === undefined ? {} : { amend_issues: args.amend_issues as never[] }),
          ...(typeof args.amend_note === 'string' ? { amend_note: args.amend_note } : {}),
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
        patch: objectOf({
          expected_hash: required(str),
          edits: required(
            arrayOf(
              objectOf({
                old_text: required(str),
                new_text: required(str),
                occurrence: int,
              }),
            ),
          ),
        }),
        summary: {
          ...optional(summarySchema),
          description:
            'Full ten-field summary. Omit content+patch with a summary to repair only pipeline.draft.summary; this does not consume a revise round.',
        },
        issues: {
          ...arrayOf(issueUpdateSchema),
          description: arraySemanticsDescription('replace', 'Updated issue statuses and evidence for PG-08.'),
        },
        proof: {
          ...optional(proofSchema),
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
          ...arrayOf(
            objectOf({
              id: required({
                type: 'string',
                enum: [
                  'L2-SCENE-ANCHOR',
                  'L2-CHARACTER-STATE',
                  'L2-CAUSALITY',
                  'L2-VOICE',
                  'L2-POV',
                ] as const,
              }),
              verdict: required({ type: 'string', enum: ['pass', 'fail'] as const }),
              evidence: required(str),
              note: required(str),
            }),
          ),
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
            'Advisory codes or instance ids read and accepted; blockers cannot be acknowledged.',
          ),
        },
        acknowledge_reasons: openObject('Token 到理由的映射；每个 acknowledge 项都必须有非空理由。'),
        acknowledge_until_chapter: int,
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.runCheck({
          chapter: args.chapter,
          scope: args.scope as string[],
          semantic: asJson(args.semantic, 'semantic') as never[],
          ...(args.acknowledge === undefined ? {} : { acknowledge: args.acknowledge }),
          ...(args.acknowledge_reasons === undefined
            ? {}
            : { acknowledge_reasons: args.acknowledge_reasons as Record<string, string> }),
          ...(typeof args.acknowledge_until_chapter === 'number'
            ? { acknowledge_until_chapter: args.acknowledge_until_chapter }
            : {}),
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
        state_delta: {
          ...stateDeltaSchema,
          description: 'Five ledger sections; entry values are dynamic maps validated by the engine.',
        },
        handoff: handoffSchema,
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
            'Inclusive [start, end] range for chapters/timeline/foreshadows/relationships.',
          ),
        },
        limit: {
          type: 'integer',
          description: 'Page size 1..200; omitted uses 50 for ledgers and 200 for characters/world/locks.',
        },
        cursor: {
          type: 'string',
          description: 'Opaque cursor from page.next_cursor; bound to one section and its filters.',
        },
        status: {
          type: 'string',
          description: 'For kind=foreshadows: open|planted|dormant|advanced|resolved.',
        },
        include_history: {
          type: 'boolean',
          description: 'For kind=foreshadows: include full advance_log; default false returns advance_count.',
        },
        current_only: {
          type: 'boolean',
          description: 'For kind=briefs: only the current receipt per chapter/stage.',
        },
        view: {
          type: 'string',
          enum: ['all', 'current'] as const,
          description: 'For kind=briefs: current is an alias of current_only; all includes history/briefs.',
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
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
          ...(args.status === undefined ? {} : { status: args.status }),
          ...(args.include_history === undefined ? {} : { include_history: args.include_history }),
          ...(args.current_only === undefined ? {} : { current_only: args.current_only }),
          ...(args.view === 'all' || args.view === 'current' ? { view: args.view } : {}),
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
        content: openObject('按 path 的完整替换文档；根必须是映射。与 patch 二选一。'),
        patch: {
          type: 'array',
          items: objectOf({
            op: required({ type: 'string', enum: ['replace', 'add', 'remove'] as const }),
            path: required(str),
            value: { type: 'json' },
          }),
          description: arraySemanticsDescription(
            'replace',
            '局部修改：点路径（items.3.title）；与 content 二选一。',
          ),
        },
        allow_delete: bool,
        reason: { type: 'string', required: true },
        confirm: {
          type: 'boolean',
          description:
            'Default true. Only used by the style migration (novel.yaml setting `style` on a project that predates 0.2.17): the plugin asks once before writing. Ordinary amendments never ask.',
        },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args, exec) => {
        // C12: `style` has exactly two doors — `novel_init` and this one. Gating
        // only the first would leave a back door wide open, because an AI could
        // set the style on an old project through `novel_amend` without asking.
        let confirmation: Confirmation | null = null
        // Both halves must use the engine's own path parser: a raw prefix test
        // let `".style"` (legal for the engine) set the style with no dialog.
        const setsStyle =
          args.path === 'novel.yaml' &&
          ((typeof args.content === 'object' &&
            args.content !== null &&
            Object.hasOwn(args.content as Record<string, unknown>, 'style')) ||
            amendPatchTouchesKey(args.patch as Array<{ path?: unknown }> | undefined, 'style'))
        if (setsStyle && args.confirm !== false) {
          const migration = await engine.styleMigration({ root: args.project_root })
          if (migration.data.open) {
            const project = (await engine.queryState({ kind: 'novel', root: args.project_root })).data as {
              created_at?: string
            }
            const wanted =
              typeof args.content === 'object' && args.content !== null
                ? (args.content as Record<string, unknown>).style
                : '(patch)'
            const outcome = await confirmWrite(options, exec, {
              id: 'style-migrate-confirm',
              header: '确认启用文风',
              question: [
                `这本书建于 ${project.created_at ?? '（未知时间）'}，还没有文风。`,
                `风格：${String(wanted)}`,
                '',
                '风格一旦设定不可更改，确认吗？',
              ].join('\n'),
            })
            if (!outcome.ok) {
              throw new EngineInputError(
                outcome.code === 'CONFIRMATION_REJECTED'
                  ? ERROR_CODES.CONFIRMATION_REJECTED
                  : ERROR_CODES.CONFIRMATION_ABORTED,
                outcome.message,
                'nothing was written; novel.yaml is byte-identical',
              )
            }
            confirmation = outcome.confirmation
          }
        }
        const result = await engine.amend({
          path: args.path,
          ...(args.content === undefined
            ? {}
            : { content: asJson<Record<string, unknown>>(args.content, 'content') }),
          ...(args.patch === undefined ? {} : { patch: args.patch as never[] }),
          ...(typeof args.allow_delete === 'boolean' ? { allow_delete: args.allow_delete } : {}),
          reason: args.reason,
          root: args.project_root,
        })
        return confirmation === null
          ? result
          : { ...result, data: { ...(result.data as Record<string, unknown>), confirmation } }
      }),
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
        limit: {
          type: 'integer',
          description:
            'Page size 1..200 (the engine clamps to 200). Capped so the host result pruner cannot cut a self-inconsistent head/tail.',
        },
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
          ...arrayOf(volumeSchema),
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
        book: {
          ...objectOf({
            premise: str,
            logline: str,
            themes: stringArray('replace', 'Book themes; supplied list replaces the theme list.'),
            tone: str,
            pov: str,
            audience: str,
            selling_points: stringArray('replace', 'Selling points; supplied list replaces the list.'),
            ending: str,
            strict: bool,
          }),
          description: 'Optional partial book blueprint patch.',
        },
        volumes: {
          ...arrayOf(volumeSchema),
          description: arraySemanticsDescription(
            'upsert',
            'Volume list: [{title,start_chapter,end_chapter,goal?,arc?,climax?,status?}]. Upserts by title; omitted volumes are kept.',
          ),
        },
        chapters: {
          ...arrayOf(chapterCardSchema),
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
        rules: {
          ...arrayOf(worldbookRule),
          description: arraySemanticsDescription('replace', 'Rules section list.'),
        },
        factions: {
          ...arrayOf(worldbookFaction),
          description: arraySemanticsDescription('replace', 'Factions section list.'),
        },
        locations: {
          ...arrayOf(worldbookLocation),
          description: arraySemanticsDescription('replace', 'Locations section list.'),
        },
        characters: {
          ...arrayOf(worldbookCharacter),
          description: arraySemanticsDescription('replace', 'Characters section list.'),
        },
        glossary: {
          ...arrayOf(worldbookGlossary),
          description: arraySemanticsDescription('replace', 'Glossary section list.'),
        },
        backstory: {
          ...arrayOf(worldbookBackstory),
          description: arraySemanticsDescription('replace', 'Backstory section list.'),
        },
        facts: {
          ...arrayOf(worldbookFact),
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
        'Run a health check. baseline:true accepts the current warnings (state/doctor-baseline.yaml); reset:true clears it.',
      parameters: {
        baseline: bool,
        reset: bool,
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.doctor({
          ...(typeof args.baseline === 'boolean' ? { baseline: args.baseline } : {}),
          ...(typeof args.reset === 'boolean' ? { reset: args.reset } : {}),
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_report',
      description:
        'Whole-book report: progress, outline coverage/drift, worldbook counts, quality trend, pacing, cast, foreshadows, timeline, relationships and activity.',
      parameters: {
        lean: {
          type: 'boolean',
          description: '只返回汇总 + 最近 20 章 effort；大项目上避免宿主裁剪出不自洽的头尾。',
        },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.report({ root: args.project_root, ...(args.lean === undefined ? {} : { lean: args.lean }) }),
      ),
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
        'Restore a pre-image from a marked backup transaction: an active chapter file, outline/outline.yaml, a damaged state/pipeline.yaml, or any of the eight state ledgers (chapters/characters/world/locks/timeline/foreshadows/relationships/handoff). A ledger restore refuses a lower next_seq and any cross-ledger reference the restore would newly dangle; restore ledger files on their own, not mixed with chapter files. Archived chapters are refused; use novel_reopen first. Every restore is itself journaled and backed up.',
      parameters: {
        txid: { type: 'string', required: true },
        chapter: { type: 'integer' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: arraySemanticsDescription(
            'replace',
            'Project-relative chapter files, outline/outline.yaml, state/pipeline.yaml when unreadable, or the eight state ledgers (state/chapters.yaml, state/characters.yaml, state/world.yaml, state/locks.yaml, state/timeline.yaml, state/foreshadows.yaml, state/relationships.yaml, state/handoff.yaml); omitted restores every restorable chapter file the manifest records. Ledger paths must be given on their own.',
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
