import { defineTool } from '@deepseek-ai/dsh-tools'
import { CORE_TOOLS, TOOL_NAMES, type ToolName } from '../constants.js'
import {
  ERROR_CODES,
  EngineError,
  EngineInputError,
  GENRES,
  PLATFORMS,
  SCENE_TYPES,
  type Genre,
  type Platform,
} from '../types.js'
import type { EngineService } from '../engine/service.js'

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
    throw new Error(`[${error.code}] ${error.message}${error.hint === undefined ? '' : ` — ${error.hint}`}`)
  }
  throw error
}

/** Wrap an execute body with cancellation and a machine-code error. */
const makeGuarded =
  (engine: EngineService) =>
  <A>(body: (args: A) => Promise<unknown>) =>
  async (args: A, exec?: { signal?: AbortSignal }): Promise<any> => {
    try {
      return await engine.withSignal(exec?.signal, () => body(args))
    } catch (error) {
      return fail(error)
    }
  }

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

const stringArray = { type: 'array' as const, items: { type: 'string' as const } }
const root = { type: 'string' as const, description: 'Project root; defaults to the configured root.' }

/**
 * The eighteen tools are thin adapters: narrow parameters, call one service
 * operation, render the canonical value. They never read a file.
 */
export function createNovelTools(engine: EngineService): ReturnType<typeof defineTool>[] {
  const guarded = makeGuarded(engine)
  return [
    defineTool({
      name: 'novel_init',
      description: 'Create a novel project at the project root (novel.yaml plus the state documents).',
      parameters: {
        title: { type: 'string', required: true },
        genre: { type: 'string', required: true, enum: GENRES },
        platform: { type: 'string', required: true, enum: PLATFORMS },
        author: { type: 'string' },
        description: { type: 'string' },
        words_per_chapter: { type: 'array', items: { type: 'integer' } },
        total_chapters: { type: 'integer' },
        project_root: root,
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
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_status',
      description: 'Read the project state: chapter, stage, rounds, blocking items and the next legal step.',
      parameters: {
        chapter: { type: 'integer' },
        project_root: root,
      },
      output: {
        schema: { type: 'json' as const },
        render: (_args: unknown, raw: unknown) => {
          const value = payload(raw) as {
            project: { title: string }
            chapter: number
            stage: string
            blocking: Array<{ code: string; detail: string }>
            next: { tool: string; reason: string }
          }
          return text(
            [
              `《${value.project.title}》 第 ${value.chapter} 章 · ${value.stage}`,
              value.blocking.length === 0 ? '门控：全部通过' : `门控：${value.blocking.length} 条阻塞`,
              ...value.blocking.map((item) => `  - ${item.code}: ${item.detail}`),
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
            context?: Record<string, unknown>
          }
          return text(
            `${value.content}\n\n---\nbrief digest: ${value.digest}${
              value.context === undefined ? '' : `\ncontext:\n${JSON.stringify(value.context, null, 2)}`
            }`,
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
        constraints: stringArray,
        characters: { type: 'json' },
        locations: { type: 'json' },
        continuity_notes: stringArray,
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
        beats: stringArray,
        opening: { type: 'string' },
        ending: { type: 'string' },
        target_words: { type: 'array', items: { type: 'integer' } },
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
          target_words: [args.target_words?.[0] ?? 2000, args.target_words?.[1] ?? 3000],
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
        dimensions: { type: 'json', required: true },
        issues: { type: 'json' },
        total: {
          type: 'integer',
          required: true,
          description: '150 - Σdelta, the same number the review reports.',
        },
        proof: { type: 'json', required: true },
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
        content: { type: 'string', required: true },
        summary: { type: 'json' },
        issues: { type: 'json', description: 'Updated issue statuses and evidence for PG-08.' },
        proof: {
          type: 'json',
          required: true,
          description: 'Three quotes from the revised text; PG-09 verifies them.',
        },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.submitRevision({
          chapter: args.chapter,
          content: args.content,
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
        scope: stringArray,
        semantic: {
          type: 'json',
          required: true,
          description: 'Exactly the four P6 semantic items, each with a verbatim evidence quote.',
        },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.runCheck({
          chapter: args.chapter,
          scope: args.scope as string[],
          semantic: asJson(args.semantic, 'semantic') as never[],
          root: args.project_root,
        }),
      ),
    }),
    defineTool({
      name: 'novel_archive',
      description:
        'Archive the active chapter: all gates run, then one transaction writes the index, five ledgers and handoff.',
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
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.countWords({ text: args.text, chapter: args.chapter, root: args.project_root }),
      ),
    }),
    defineTool({
      name: 'novel_state',
      description: 'Read a state document (ledgers, plans, review, check) without touching the manuscript.',
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
          ] as const,
        },
        chapter: { type: 'integer' },
        project_root: root,
      },
      output: jsonOutput,
      execute: guarded(async (args) =>
        engine.queryState({ kind: args.kind, chapter: args.chapter, root: args.project_root }),
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
            'state/chapters.yaml',
            'state/characters.yaml',
            'state/world.yaml',
            'state/locks.yaml',
            'state/timeline.yaml',
            'state/foreshadows.yaml',
            'state/relationships.yaml',
            'state/handoff.yaml',
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
        chapter: { type: 'integer', required: true },
        before: { type: 'string' },
        after: { type: 'string' },
        project_root: root,
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
      description: 'Export the manuscript as Markdown, plain text, or a valid EPUB 3 archive.',
      parameters: {
        kind: { type: 'string', required: true, enum: ['md', 'txt', 'epub'] as const },
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
        'Read the append-only journal as an audit trail of every committed and aborted transaction.',
      parameters: { limit: { type: 'integer' }, project_root: root },
      output: jsonOutput,
      execute: guarded(async (args) => engine.auditHistory({ limit: args.limit, root: args.project_root })),
    }),
    defineTool({
      name: 'novel_pipeline',
      description: 'Answer "what do I do next": the recommended tool, arguments and the blocking reasons.',
      parameters: { project_root: root },
      output: jsonOutput,
      execute: guarded(async (args) => engine.advise({ root: args.project_root })),
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
