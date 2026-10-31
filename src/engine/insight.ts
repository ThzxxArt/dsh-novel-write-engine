import { bookPlanPresent, outlineDrift, outlineSummary, worldbookCounts } from './book.js'
import { normalizeRole } from './state-delta.js'
import { compareText } from '../domain/stable.js'
import { splitParagraphs } from '../domain/text.js'
import type {
  AuditRow,
  BookReport,
  ChapterProgress,
  ChapterRecord,
  CharactersDocument,
  ForeshadowsDocument,
  GuideReport,
  HandoffDocument,
  LocksDocument,
  NovelProject,
  OutlineDocument,
  RelationshipsDocument,
  ReviewDocument,
  SearchReport,
  SearchResultItem,
  Stage,
  TimelineDocument,
  WorldDocument,
  WordMetrics,
  WorldbookDocument,
} from '../types.js'
import type { PanelBookData, PanelCardData, PanelWorldEntry } from '../panel-contract.js'

export interface ReportInput {
  project: NovelProject
  outline: OutlineDocument
  outlinePresent: boolean
  outlineError?: string | null
  worldbook: WorldbookDocument
  worldbookPresent: boolean
  worldbookError?: string | null
  /** Archived world ledger; its anchors are the only persisted retrieval proof. */
  world?: WorldDocument
  chapters: ChapterRecord[]
  characters: CharactersDocument
  timeline: TimelineDocument
  foreshadows: ForeshadowsDocument
  relationships: RelationshipsDocument
  /** One current review per chapter; history belongs in `reviewAttempts`. */
  reviews: ReviewDocument[]
  activity: AuditRow[]
  /** Full committed journal, used to backfill effort for pre-0.2.1 chapters. */
  journal?: AuditRow[]
  /** Committed review rounds for the report, including history. */
  reviewAttempts?: number
  /** Check verdicts recovered from disk for legacy chapters without final_check. */
  finalChecks?: Record<number, 'pass' | 'fail'>
  targetChapters: number | null
  minScore: number
  foreshadowDormantAfter: number
}

const average = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

const scoreOf = (review: ReviewDocument): number =>
  review.dimensions.reduce(
    (total, dimension) =>
      total +
      Math.max(
        0,
        dimension.max -
          (Array.isArray(dimension.deductions)
            ? dimension.deductions.reduce((sum, deduction) => sum + Number(deduction.delta ?? 0), 0)
            : 0),
      ),
    0,
  )

/** Persisted anchors exposed by the report; top-level caps keep the JSON small. */
const worldAnchors = (world?: WorldDocument): NonNullable<BookReport['worldbook']['anchors']> => {
  if (world === undefined) return []
  const groups: Array<[string, readonly unknown[]]> = [
    ['location', world.locations],
    ['ability', world.abilities],
    ['artifact', world.artifacts],
    ['faction', world.factions],
    ['rule', world.rules],
  ]
  const out: NonNullable<BookReport['worldbook']['anchors']> = []
  for (const [kind, entries] of groups) {
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as { name?: unknown; anchors?: unknown }
      if (typeof record.name !== 'string' || !Array.isArray(record.anchors)) continue
      const anchors = record.anchors
        .filter((anchor): anchor is string => typeof anchor === 'string')
        .slice(0, 8)
      if (anchors.length > 0) out.push({ name: record.name, kind, anchors })
    }
  }
  return out.slice(0, 10)
}

/** Build the whole-book report from one committed snapshot. No IO. */
export function buildBookReport(input: ReportInput): BookReport {
  const records = [...input.chapters].sort((left, right) => left.num - right.num)
  const words = records.reduce((total, record) => total + record.word_count, 0)
  const scores = records.map((record) => record.score)
  const lastFive = scores.slice(-5)
  const previous = scores.slice(-10, -5)
  const qualityAverage = average(scores)
  // A chapter contributes one sample: its final review. History is counted as
  // `attempts`, never as an independent chapter score. Pick the newest round
  // defensively even when a caller passes history, and ignore reviews for
  // chapters that are not in this archived snapshot.
  const archivedChapterNums = new Set(records.map((record) => record.num))
  const finalReviews = new Map<number, ReviewDocument>()
  for (const review of input.reviews) {
    if (!archivedChapterNums.has(review.chapter)) continue
    const current = finalReviews.get(review.chapter)
    if (current === undefined || review.round >= current.round) finalReviews.set(review.chapter, review)
  }
  const chapterReviews = [...finalReviews.values()]
  const qualitySamples = chapterReviews.length
  // A readable final review is itself at least one attempt. A truncated or
  // legacy journal must never make attempts lower than samples.
  const qualityAttempts = Math.max(input.reviewAttempts ?? input.reviews.length, qualitySamples)
  const trendBasis: BookReport['quality']['trend_basis'] =
    qualitySamples < 3
      ? 'insufficient_samples'
      : previous.length < 5
        ? 'insufficient_history'
        : 'last_five_vs_previous_five'
  const trend =
    trendBasis === 'last_five_vs_previous_five'
      ? Math.round((average(lastFive) - average(previous)) * 10) / 10
      : null
  const dimensions = new Map<string, { total: number; samples: number }>()
  for (const review of chapterReviews) {
    for (const dimension of review.dimensions) {
      const max = Number(dimension.max ?? 0)
      const deductions = Array.isArray(dimension.deductions)
        ? dimension.deductions.reduce((sum, deduction) => sum + Number(deduction.delta ?? 0), 0)
        : 0
      const score = Math.max(0, max - deductions)
      const current = dimensions.get(dimension.id) ?? { total: 0, samples: 0 }
      dimensions.set(dimension.id, { total: current.total + score, samples: current.samples + 1 })
    }
  }
  const sceneTypes: Record<string, number> = {}
  const hookStrength: Record<string, number> = {}
  const plotAdvancement: Record<string, number> = {}
  let longest: BookReport['pacing']['longest'] = null
  let shortest: BookReport['pacing']['shortest'] = null
  for (const record of records) {
    sceneTypes[record.scene_type] = (sceneTypes[record.scene_type] ?? 0) + 1
    hookStrength[String(record.summary.hook_strength)] =
      (hookStrength[String(record.summary.hook_strength)] ?? 0) + 1
    plotAdvancement[record.summary.plot_advancement] =
      (plotAdvancement[record.summary.plot_advancement] ?? 0) + 1
    if (longest === null || record.word_count > longest.words) {
      longest = { chapter: record.num, words: record.word_count }
    }
    if (shortest === null || record.word_count < shortest.words) {
      shortest = { chapter: record.num, words: record.word_count }
    }
  }
  const appearances = new Map<string, number>()
  const lastAppearance = new Map<string, number>()
  for (const record of records) {
    for (const name of new Set(record.summary.characters_appeared)) {
      appearances.set(name, (appearances.get(name) ?? 0) + 1)
      lastAppearance.set(name, Math.max(lastAppearance.get(name) ?? 0, record.num))
    }
  }
  const roleHints = new Map<string, string>()
  for (const character of input.worldbook.characters) {
    if (character.role !== '') roleHints.set(character.name, character.role)
  }
  const castTop = input.characters.characters
    .map((character) => ({
      name: character.name,
      // Old ledgers wrote extra for everyone before the role owner was fixed;
      // report can still show the worldbook role without rewriting history.
      role:
        character.role === 'extra' && roleHints.has(character.name)
          ? normalizeRole(roleHints.get(character.name), character.role)
          : character.role,
      appearances: appearances.get(character.name) ?? 0,
      last_seen: Math.max(character.updated_at, lastAppearance.get(character.name) ?? 0),
    }))
    .sort(
      (left, right) =>
        right.appearances - left.appearances ||
        right.last_seen - left.last_seen ||
        compareText(left.name, right.name),
    )
    .slice(0, 10)
  const latestChapter = records.length === 0 ? 0 : records[records.length - 1]!.num
  const open = input.foreshadows.items.filter((item) => item.status !== 'resolved')
  const dormant = open.filter((item) => item.status === 'dormant')
  const overdue = open.filter((item) => latestChapter - item.last_touched >= input.foreshadowDormantAfter)
  const relationshipTypes: Record<string, number> = {}
  for (const relationship of input.relationships.items) {
    relationshipTypes[relationship.type] = (relationshipTypes[relationship.type] ?? 0) + 1
  }
  const outline = outlineSummary(
    input.outline,
    records.length,
    input.targetChapters,
    records.map((record) => record.num),
  )
  const averageWords = records.length === 0 ? 0 : Math.round(words / records.length)
  const remainingChapters =
    input.targetChapters === null ? null : Math.max(0, input.targetChapters - records.length)
  const minimumRemaining =
    remainingChapters === null ? null : remainingChapters * input.project.targets.words_per_chapter[0]
  const averageRemaining =
    remainingChapters === null
      ? null
      : remainingChapters * (records.length === 0 ? input.project.targets.words_per_chapter[0] : averageWords)
  const drift = outlineDrift(input.outline, records)
  const volumeCounts = input.outline.volumes.map((volume) => {
    const cards = input.outline.chapters.filter(
      (card) => card.num >= volume.start_chapter && card.num <= volume.end_chapter,
    )
    return {
      title: volume.title,
      start: volume.start_chapter,
      end: volume.end_chapter,
      planned: cards.filter((card) => card.status === 'planned').length,
      archived: cards.filter((card) => card.status === 'archived').length,
    }
  })
  const warnings: string[] = []
  if (input.outlineError !== null && input.outlineError !== undefined) {
    warnings.push(`书级大纲不可读：${input.outlineError}`)
  } else if (!outline.present) {
    warnings.push('还没有书级大纲；写第二章前建议先建立章卡')
  }
  if (input.worldbookError !== null && input.worldbookError !== undefined) {
    warnings.push(`世界观设定集不可读：${input.worldbookError}`)
  } else if (!worldbookCounts(input.worldbook).present) {
    warnings.push('还没有世界观设定集；P1/P2 的世界观上下文为空')
  }
  if (drift.length > 0) warnings.push(`${drift.length} 处大纲与已归档章节漂移`)
  if (records.length === 0) warnings.push('还没有已归档章节')
  if (input.targetChapters !== null && records.length > input.targetChapters) {
    warnings.push(`已归档 ${records.length} 章，超过目标 ${input.targetChapters} 章`)
  }
  if (scores.length > 0 && qualityAverage < input.minScore) {
    warnings.push(`平均分 ${qualityAverage.toFixed(1)} 低于合格线 ${input.minScore}`)
  }
  const committed = (input.journal ?? []).filter((row) => row.status === 'committed')
  const committedCount = (op: string, chapter: number): number =>
    committed.filter((row) => row.op === op && row.chapter === chapter).length
  const archivedAt = (chapter: number): string | null => {
    const row = [...committed]
      .reverse()
      .find((entry) => entry.op === 'archiveChapter' && entry.chapter === chapter)
    return row?.at ?? null
  }
  const effortChapters = records.map((record) => {
    const rounds = record.rounds
    return {
      num: record.num,
      reviews: Math.max(rounds?.review ?? 0, committedCount('submitReview', record.num)),
      revisions: Math.max(rounds?.revise ?? 0, committedCount('submitRevision', record.num)),
      checks: Math.max(rounds?.check ?? 0, committedCount('runCheck', record.num)),
      rollbacks: Math.max(rounds?.rollbacks ?? 0, committedCount('rollback', record.num)),
      final_check: record.final_check ?? input.finalChecks?.[record.num] ?? null,
      archived_at: record.archived_at ?? archivedAt(record.num),
    }
  })
  if (records.some((record) => record.rounds === undefined || record.archived_at === undefined)) {
    warnings.push('部分旧章缺少归档 effort 元数据；报告已按事务日志回填')
  }
  const persistedAnchors = worldAnchors(input.world)
  return {
    progress: {
      archived: records.length,
      target: input.targetChapters,
      words,
      average_words: averageWords,
      percent:
        input.targetChapters === null || input.targetChapters === 0
          ? 0
          : Math.min(100, Math.round((records.length / input.targetChapters) * 1000) / 10),
      remaining_words: averageRemaining,
      remaining_words_min: minimumRemaining,
      remaining_words_average: averageRemaining,
      remaining_words_basis:
        input.targetChapters === null ? 'none' : records.length === 0 ? 'minimum_target' : 'actual_average',
    },
    outline: {
      present: outline.present,
      strict: input.outline.book.strict,
      target: outline.target,
      total: outline.total,
      planned: outline.planned,
      archived: outline.archived,
      missing_cards: outline.missingCards,
      planned_coverage: outline.plannedCoverage,
      archived_coverage: outline.archivedCoverage,
      coverage: outline.coverage,
      card_coverage: outline.cardCoverage,
      volumes: volumeCounts,
      drift,
    },
    worldbook: {
      ...worldbookCounts(input.worldbook),
      ...(persistedAnchors.length === 0 ? {} : { anchors: persistedAnchors }),
    },
    quality: {
      average: Math.round(qualityAverage * 10) / 10,
      median: Math.round(median(scores) * 10) / 10,
      min: scores.length === 0 ? 0 : Math.min(...scores),
      max: scores.length === 0 ? 0 : Math.max(...scores),
      last_five: lastFive,
      trend,
      trend_basis: trendBasis,
      samples: qualitySamples,
      attempts: qualityAttempts,
      dimensions: [...dimensions.entries()]
        .map(([id, value]) => ({
          id,
          average: Math.round((value.total / value.samples) * 10) / 10,
          samples: value.samples,
        }))
        .sort((left, right) => compareText(left.id, right.id)),
    },
    effort: {
      reviews: effortChapters.reduce((total, chapter) => total + chapter.reviews, 0),
      revisions: effortChapters.reduce((total, chapter) => total + chapter.revisions, 0),
      checks: effortChapters.reduce((total, chapter) => total + chapter.checks, 0),
      rollbacks: effortChapters.reduce((total, chapter) => total + chapter.rollbacks, 0),
      chapters: effortChapters,
    },
    pacing: {
      scene_types: sceneTypes,
      hook_strength: hookStrength,
      plot_advancement: plotAdvancement,
      longest,
      shortest,
    },
    cast: { total: input.characters.characters.length, top: castTop },
    foreshadows: {
      open: open.length,
      dormant: dormant.length,
      overdue: overdue.length,
      resolved: input.foreshadows.items.length - open.length,
      oldest: [...open]
        .sort((left, right) => left.last_touched - right.last_touched || compareText(left.id, right.id))
        .slice(0, 5)
        .map((item) => ({
          id: item.id,
          title: item.title,
          last_touched: item.last_touched,
          age: latestChapter - item.last_touched,
        })),
    },
    timeline: {
      events: input.timeline.items.length,
      first_chapter:
        input.timeline.items.length === 0
          ? null
          : Math.min(...input.timeline.items.map((item) => item.chapter)),
      last_chapter:
        input.timeline.items.length === 0
          ? null
          : Math.max(...input.timeline.items.map((item) => item.chapter)),
    },
    relationships: { total: input.relationships.items.length, types: relationshipTypes },
    activity: input.activity.map((row) => ({
      at: row.at,
      op: row.op,
      chapter: row.chapter,
      status: row.status,
    })),
    warnings,
  }
}

export interface GuideInput {
  projectPresent: boolean
  chapter: number
  stage: Stage
  /** Chapter-boundary projection; omitted by older synthetic callers. */
  progress?: ChapterProgress
  archived: number
  target: number | null
  finished: boolean
  outline: OutlineDocument
  outlinePresent: boolean
  outlineError?: string | null
  worldbook: WorldbookDocument
  worldbookPresent: boolean
  worldbookError?: string | null
  next: { tool: string; args: Record<string, unknown>; reason: string }
  blocking: number
  stateErrors: number
}

/** Build the onboarding guide. No IO; a missing project is a normal state. */
export function buildGuide(input: GuideInput): GuideReport {
  if (!input.projectPresent) {
    return {
      state: 'no-project',
      title: '先建一本书',
      steps: [
        {
          id: 'init',
          title: '创建项目',
          detail: 'novel_init 会建立 novel.yaml、九个状态文档、空大纲与空世界观。',
          done: false,
          tool: 'novel_init',
        },
        {
          id: 'blueprint',
          title: '写书级蓝图',
          detail: '用 novel_blueprint 写梗概、主题、基调、视角与卷结构。',
          done: false,
          tool: 'novel_blueprint',
        },
        {
          id: 'outline',
          title: '拆章卡',
          detail: '用 novel_outline 或 novel_outline_import 建立全书章节卡。',
          done: false,
          tool: 'novel_outline',
        },
        {
          id: 'write',
          title: '写第一章',
          detail: '按 P1→P9 流水线写第一张章卡。',
          done: false,
          tool: 'novel_brief',
        },
      ],
      next: {
        tool: 'novel_init',
        args: { title: '我的第一本书', genre: '都市现代', platform: 'fanqie' },
        reason: '还没有项目；先创建一本书',
      },
      commands: ['/novel', '/novel next', '/novel guide'],
      tips: ['先填蓝图再拆章卡，P2/P3 会自动带入当前章卡。'],
    }
  }
  const blueprintDone = bookPlanPresent(input.outline.book)
  const outlineDone = input.outline.chapters.length > 0
  const worldbookDone = worldbookCounts(input.worldbook).present
  const steps: GuideReport['steps'] = [
    { id: 'init', title: '创建项目', detail: '项目已建立。', done: true, tool: 'novel_init' },
    {
      id: 'blueprint',
      title: '写书级蓝图',
      detail: blueprintDone
        ? '梗概与主题已就绪。'
        : '补 premise/logline/themes/tone/pov/audience/卖点/结局。',
      done: blueprintDone,
      tool: 'novel_blueprint',
    },
    {
      id: 'outline',
      title: '拆全书章卡',
      detail:
        input.outlineError !== null && input.outlineError !== undefined
          ? `大纲不可读：${input.outlineError}；先用 novel_amend 修复 outline/outline.yaml`
          : outlineDone
            ? `已规划 ${input.outline.chapters.length} 张章卡${input.outline.book.strict ? '（严格模式）' : ''}。`
            : '用 novel_outline 或从 Markdown 导入章卡；严格模式会要求每章先有卡。',
      done: outlineDone,
      tool: 'novel_outline',
    },
    {
      id: 'worldbook',
      title: '建立世界观',
      detail:
        input.worldbookError !== null && input.worldbookError !== undefined
          ? `世界观设定集不可读：${input.worldbookError}；先用 novel_amend 修复 outline/worldbook.yaml`
          : worldbookDone
            ? '世界观设定集已有内容。'
            : '写设定、规则、势力、地点、角色小传、术语与前史。',
      done: worldbookDone,
      tool: 'novel_worldbook',
    },
    {
      id: 'write',
      title: input.finished
        ? '全书章节已写完'
        : input.progress?.current !== null && input.progress?.current !== undefined
          ? `写第 ${input.progress.current.chapter} 章`
          : input.progress?.next !== null && input.progress?.next !== undefined
            ? `准备第 ${input.progress.next.chapter} 章（P1）`
            : `写第 ${input.chapter} 章`,
      detail: input.finished
        ? `已完成 ${input.archived} 章；下一步是导出成书。`
        : `${input.progress?.label ?? `当前阶段 ${input.stage}`}；${input.blocking === 0 ? '没有阻塞' : `${input.blocking} 条阻塞`}。`,
      done: input.finished,
      tool: input.next.tool,
    },
    {
      id: 'finish',
      title: '成书',
      detail: input.finished ? '已达到目标章数，可导出。' : '完成目标章数后导出 md/txt/epub 与提案。',
      done: input.finished,
      tool: 'novel_export',
    },
  ]
  const state: GuideReport['state'] = input.finished
    ? 'finished'
    : input.stateErrors > 0 || input.blocking > 0
      ? 'blocked'
      : input.stage === 'idle' && input.archived === 0 && !outlineDone && !blueprintDone && !worldbookDone
        ? 'new'
        : input.stage === 'idle' && input.archived === 0
          ? 'planning'
          : 'writing'
  return {
    state,
    title: input.finished
      ? '全书已完成'
      : (input.progress?.label ?? `第 ${input.chapter} 章 · ${input.stage}`),
    steps,
    next: input.next,
    commands: [
      '/novel',
      '/novel next',
      '/novel outline',
      '/novel report',
      '/novel doctor',
      input.finished ? '/novel export epub' : '/novel guide',
    ],
    tips: [
      input.outline.book.strict
        ? '严格模式已开启：P2/P3 前必须有当前章卡，标题/场景/字数/角色要与章卡一致。'
        : '严格模式未开启：可先写后补大纲；novel_blueprint {"strict":true} 可开启。',
      '世界观是规划层，不会自动进入 state/；只有正文出现并经归档核销的实体才进台账。',
      '每章归档后大纲会自动回写 archived 状态，report/doctor 会检查漂移。',
    ],
  }
}

export interface SearchInput {
  query: string
  scope: SearchReport['scope']
  limit: number
  chapterTexts: Map<number, string>
  chapters: ChapterRecord[]
  outline: OutlineDocument
  worldbook: WorldbookDocument
  characters: CharactersDocument
  world: WorldDocument
  timeline: TimelineDocument
  foreshadows: ForeshadowsDocument
  relationships: RelationshipsDocument
  locks: LocksDocument
  handoff: HandoffDocument | null
}

const snippetAround = (source: string, index: number, queryLength: number): string => {
  const radius = 48
  const start = Math.max(0, index - radius)
  const end = Math.min(source.length, index + queryLength + radius)
  return `${start > 0 ? '…' : ''}${source.slice(start, end).replace(/\s+/g, ' ')}${end < source.length ? '…' : ''}`
}

const hit = (results: SearchResultItem[], total: number, limit: number, item: SearchResultItem): number => {
  const next = total + 1
  if (results.length < limit) results.push(item)
  return next
}

/** Search text and structured planning data. No IO; chapter texts are supplied. */
export function searchSnapshot(input: SearchInput): SearchReport {
  const query = input.query.trim()
  if (query === '') {
    throw new Error('search query must not be empty')
  }
  const needle = query.toLowerCase()
  const results: SearchResultItem[] = []
  let total = 0
  const want = (scope: SearchReport['scope']): boolean => input.scope === 'all' || input.scope === scope
  const records = [...input.chapters].sort((left, right) => left.num - right.num)
  if (want('chapters')) {
    // Iterate the texts, not the index: an active, unarchived draft is present
    // in chapterTexts but has no ChapterRecord yet.
    const byNum = new Map(records.map((record) => [record.num, record]))
    const entries = [...input.chapterTexts.entries()].sort(([left], [right]) => left - right)
    for (const [num, text] of entries) {
      const record = byNum.get(num)
      const paragraphs = splitParagraphs(text)
      for (const [index, paragraph] of paragraphs.entries()) {
        const at = paragraph.toLowerCase().indexOf(needle)
        if (at === -1) continue
        total = hit(results, total, input.limit, {
          kind: 'chapters',
          chapter: num,
          title: record?.title ?? '当前草稿',
          paragraph: index + 1,
          snippet: snippetAround(paragraph, at, query.length),
        })
      }
    }
  }
  if (want('summaries')) {
    for (const record of records) {
      const source = JSON.stringify(record.summary)
      const at = source.toLowerCase().indexOf(needle)
      if (at === -1) continue
      total = hit(results, total, input.limit, {
        kind: 'summaries',
        chapter: record.num,
        title: record.title,
        snippet: snippetAround(source, at, query.length),
      })
    }
  }
  if (want('outline')) {
    const blueprint = [
      input.outline.book.premise,
      input.outline.book.logline,
      ...input.outline.book.themes,
      input.outline.book.tone,
      input.outline.book.pov,
      input.outline.book.audience,
      ...input.outline.book.selling_points,
      input.outline.book.ending,
    ]
      .filter((value) => value !== '')
      .join('\n')
    if (blueprint !== '') {
      const at = blueprint.toLowerCase().indexOf(needle)
      if (at !== -1) {
        total = hit(results, total, input.limit, {
          kind: 'outline',
          title: '书级蓝图',
          snippet: snippetAround(blueprint, at, query.length),
        })
      }
    }
    for (const volume of input.outline.volumes) {
      const source = [volume.title, volume.goal, volume.arc, volume.climax]
        .filter((value) => value !== '')
        .join('\n')
      const at = source.toLowerCase().indexOf(needle)
      if (at === -1) continue
      total = hit(results, total, input.limit, {
        kind: 'outline',
        title: volume.title,
        snippet: snippetAround(source, at, query.length),
      })
    }
    for (const card of input.outline.chapters) {
      const source = [
        card.title,
        card.scene_type,
        card.goal,
        card.conflict,
        card.hook,
        card.notes,
        ...card.cast,
      ].join('\n')
      const at = source.toLowerCase().indexOf(needle)
      if (at === -1) continue
      total = hit(results, total, input.limit, {
        kind: 'outline',
        chapter: card.num,
        title: card.title,
        snippet: snippetAround(source, at, query.length),
      })
    }
  }
  if (want('worldbook')) {
    const entries: Array<{ title: string; source: string }> = [
      { title: 'premise', source: input.worldbook.premise },
      { title: 'setting', source: input.worldbook.setting },
      { title: 'themes', source: input.worldbook.themes.join('、') },
      ...input.worldbook.rules.map((entry) => ({
        title: entry.name,
        source: `${entry.name}\n${entry.description}`,
      })),
      ...input.worldbook.factions.map((entry) => ({
        title: entry.name,
        source: `${entry.name}\n${entry.description}\n${entry.goal}`,
      })),
      ...input.worldbook.locations.map((entry) => ({
        title: entry.name,
        source: `${entry.name}\n${entry.description}\n${entry.layout}`,
      })),
      ...input.worldbook.characters.map((entry) => ({
        title: entry.name,
        source: `${entry.name}\n${entry.role}\n${entry.description}\n${entry.arc}`,
      })),
      ...input.worldbook.glossary.map((entry) => ({
        title: entry.term,
        source: `${entry.term}\n${entry.definition}`,
      })),
      ...input.worldbook.backstory.map((entry) => ({
        title: entry.time,
        source: `${entry.time}\n${entry.event}`,
      })),
      ...(input.worldbook.facts ?? []).map((fact) => ({
        title: fact.alias,
        source: `${fact.alias}\n${fact.value} ${fact.unit}${fact.tolerance === undefined ? '' : ` ±${fact.tolerance}`}\n${fact.note ?? ''}`,
      })),
    ]
    for (const entry of entries) {
      const at = entry.source.toLowerCase().indexOf(needle)
      if (at === -1) continue
      total = hit(results, total, input.limit, {
        kind: 'worldbook',
        title: entry.title,
        snippet: snippetAround(entry.source, at, query.length),
      })
    }
  }
  if (want('ledgers')) {
    const entries: Array<{ title: string; source: string }> = [
      ...input.characters.characters.map((entry) => ({
        title: entry.name,
        source: `${entry.name}\n${entry.role}\n${JSON.stringify(entry.profile)}\n${JSON.stringify(entry.current_state)}`,
      })),
      ...input.world.locations.map((entry) => ({
        title: entry.name,
        source: `${entry.name}\n${entry.description}\n${entry.layout}`,
      })),
      ...(['abilities', 'artifacts', 'factions', 'rules'] as const).flatMap((kind) =>
        (input.world[kind] as unknown[]).map((entry, index) => ({
          title: `${kind}-${index + 1}`,
          source: JSON.stringify(entry),
        })),
      ),
      ...Object.entries(input.locks.characters).map(([name, lock]) => ({
        title: name,
        source: `${name}\n${JSON.stringify(lock)}`,
      })),
      ...Object.entries(input.locks.locations).map(([name, lock]) => ({
        title: name,
        source: `${name}\n${JSON.stringify(lock)}`,
      })),
      ...(input.handoff === null
        ? []
        : [
            {
              title: 'handoff',
              source: `${input.handoff.last_summary}\n${input.handoff.open_hooks
                .map((hook) => `${hook.id} ${hook.title}`)
                .join('\n')}`,
            },
          ]),
      ...input.timeline.items.map((entry) => ({
        title: entry.id,
        source: `${entry.id}\n${entry.story_time}\n${entry.description}\n${entry.location}`,
      })),
      ...input.foreshadows.items.map((entry) => ({
        title: entry.id,
        source: `${entry.id}\n${entry.title}\n${entry.description}`,
      })),
      ...input.relationships.items.map((entry) => ({
        title: entry.id,
        source: `${entry.id}\n${entry.a}\n${entry.b}\n${entry.type}\n${entry.description}`,
      })),
    ]
    for (const entry of entries) {
      const at = entry.source.toLowerCase().indexOf(needle)
      if (at === -1) continue
      total = hit(results, total, input.limit, {
        kind: 'ledgers',
        title: entry.title,
        snippet: snippetAround(entry.source, at, query.length),
      })
    }
  }
  return {
    query,
    scope: input.scope,
    total,
    truncated: total > results.length,
    results,
  }
}

export interface PanelBookDataInput {
  report: BookReport
  project: NovelProject
  worldbook: WorldbookDocument
  world: WorldDocument
  outline: OutlineDocument
  outlinePresent: boolean
  worldbookPresent: boolean
  currentChapter: number
  stage: Stage
  rounds: { review: number; revise: number; check: number }
  draftWords: number
  lastTenAverage: number
  manuscriptHash: string | null
  metrics: WordMetrics | null
  stateErrors: Array<{ path: string; code: string; message: string }>
  pending: { state: string; txid: string; detail: string } | null
  outlineError: string | null
  worldbookError: string | null
}

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()
type PanelWorldKind = 'location' | 'faction' | 'rule'

const ledgerWorldEntries = (world: WorldDocument, kind: PanelWorldKind): PanelWorldEntry[] => {
  const rows: readonly unknown[] =
    kind === 'location' ? world.locations : kind === 'faction' ? world.factions : world.rules
  const entries: PanelWorldEntry[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as { name?: unknown; description?: unknown; anchors?: unknown }
    if (typeof record.name !== 'string' || record.name.trim() === '') continue
    const anchors = Array.isArray(record.anchors)
      ? record.anchors.filter((anchor): anchor is string => typeof anchor === 'string')
      : []
    entries.push({
      name: record.name,
      description: typeof record.description === 'string' ? record.description : '',
      ...(anchors.length === 0 ? {} : { anchors }),
    })
  }
  return entries
}

const nameDescription = (
  entries: readonly { name: string; description: string; anchors?: string[] }[],
  world: WorldDocument,
  kind: PanelWorldKind = 'location',
): PanelWorldEntry[] => {
  const merged = new Map<string, PanelWorldEntry>()
  for (const entry of [...entries, ...ledgerWorldEntries(world, kind)]) {
    const name = oneLine(entry.name)
    if (name === '') continue
    const existing = merged.get(name)
    if (existing === undefined) {
      merged.set(name, {
        name,
        description: oneLine(entry.description),
        ...(entry.anchors === undefined || entry.anchors.length === 0 ? {} : { anchors: [...entry.anchors] }),
      })
      continue
    }
    if (existing.anchors === undefined && entry.anchors !== undefined && entry.anchors.length > 0) {
      existing.anchors = [...entry.anchors]
    }
  }
  return [...merged.values()].slice(0, 5)
}

/**
 * Build the v6 panel book view from the canonical `BookReport`. This function
 * only truncates and renames; it never recomputes a quality/pacing aggregate.
 */
export function buildPanelBookData(input: PanelBookDataInput): PanelBookData {
  const report = input.report
  const remainingBasis: PanelBookData['progress']['remaining_words_basis'] =
    report.progress.target === null
      ? 'none'
      : report.progress.archived === 0
        ? 'minimum_target'
        : 'actual_average'
  const remaining =
    remainingBasis === 'actual_average'
      ? report.progress.remaining_words_average
      : remainingBasis === 'minimum_target'
        ? report.progress.remaining_words_min
        : null
  const card = input.outline.chapters.find((candidate) => candidate.num === input.currentChapter)
  const currentCard: PanelCardData | null =
    card === undefined
      ? null
      : {
          num: card.num,
          title: card.title,
          scene_type: card.scene_type,
          goal: card.goal,
          conflict: card.conflict,
          hook: card.hook,
          cast: [...card.cast],
          target_words: [card.target_words[0], card.target_words[1]],
          status: card.status,
        }
  const quality = report.quality
  const counts = {
    present: report.worldbook.present,
    characters: report.worldbook.characters,
    locations: report.worldbook.locations,
    factions: report.worldbook.factions,
    rules: report.worldbook.rules,
    glossary: report.worldbook.glossary,
    backstory: report.worldbook.backstory,
    ...(report.worldbook.facts === undefined ? {} : { facts: report.worldbook.facts }),
  }
  return {
    identity: {
      author: input.project.author,
      description: input.project.description,
      created_at: input.project.created_at,
      targets: {
        words_per_chapter: [
          input.project.targets.words_per_chapter[0],
          input.project.targets.words_per_chapter[1],
        ],
        total_chapters: input.project.targets.total_chapters,
        dialogue_ratio: [input.project.targets.dialogue_ratio[0], input.project.targets.dialogue_ratio[1]],
      },
    },
    blueprint: {
      premise: input.outline.book.premise,
      logline: input.outline.book.logline,
      themes: [...input.outline.book.themes],
      tone: input.outline.book.tone,
      pov: input.outline.book.pov,
      audience: input.outline.book.audience,
      selling_points: [...input.outline.book.selling_points],
      ending: input.outline.book.ending,
    },
    progress: {
      archived: report.progress.archived,
      target: report.progress.target,
      words_archived: report.progress.words,
      words_with_draft: report.progress.words + input.draftWords,
      average_words: report.progress.average_words,
      remaining_words: remaining,
      remaining_words_basis: remainingBasis,
      percent: report.progress.percent,
    },
    current: {
      card: currentCard,
      chapter: input.currentChapter,
      stage: input.stage,
      rounds: { ...input.rounds },
      manuscript_hash: input.manuscriptHash,
      metrics: input.metrics,
    },
    worldbook: {
      counts,
      locations: nameDescription(input.worldbook.locations, input.world),
      factions: nameDescription(input.worldbook.factions, input.world, 'faction'),
      rules: nameDescription(input.worldbook.rules, input.world, 'rule'),
      facts: (input.worldbook.facts ?? []).slice(0, 5).map((fact) => ({
        alias: fact.alias,
        value: fact.value,
        unit: fact.unit,
      })),
    },
    cast: {
      total: report.cast.total,
      top: report.cast.top.slice(0, 5).map((entry) => ({ ...entry })),
    },
    relationships: { total: report.relationships.total, types: { ...report.relationships.types } },
    foreshadows: {
      ...report.foreshadows,
      oldest: report.foreshadows.oldest.slice(0, 5).map((entry) => ({ ...entry })),
    },
    timeline: { ...report.timeline },
    outline: { drift: report.outline.drift.slice(0, 10).map((entry) => ({ ...entry })) },
    quality: {
      average: quality.average,
      median: quality.median,
      min: quality.min,
      max: quality.max,
      last_ten_average: input.lastTenAverage,
      trend: quality.trend,
      trend_basis: quality.trend_basis,
      samples: quality.samples,
      attempts: quality.attempts,
      dimensions: quality.dimensions.slice(0, 15).map((entry) => ({ ...entry })),
    },
    pacing: {
      scene_types: { ...report.pacing.scene_types },
      hook_strength: { ...report.pacing.hook_strength },
      plot_advancement: { ...report.pacing.plot_advancement },
      longest: report.pacing.longest === null ? null : { ...report.pacing.longest },
      shortest: report.pacing.shortest === null ? null : { ...report.pacing.shortest },
    },
    effort: {
      ...report.effort,
      chapters: report.effort.chapters.slice(-30).map((entry) => ({ ...entry })),
    },
    health: {
      state_errors: input.stateErrors.slice(0, 10).map((entry) => ({ ...entry })),
      outline: { present: input.outlinePresent, error: input.outlineError },
      worldbook: { present: input.worldbookPresent, error: input.worldbookError },
      pending: input.pending === null ? null : { ...input.pending },
    },
  }
}

/** Re-export the score helper for the report tests and the doctor. */
export { scoreOf }
