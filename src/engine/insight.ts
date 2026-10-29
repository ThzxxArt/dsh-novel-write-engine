import { bookPlanPresent, outlineDrift, outlineSummary, worldbookCounts } from './book.js'
import { splitParagraphs } from '../domain/text.js'
import type {
  AuditRow,
  BookReport,
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
  WorldbookDocument,
} from '../types.js'

export interface ReportInput {
  project: NovelProject
  outline: OutlineDocument
  outlinePresent: boolean
  outlineError?: string | null
  worldbook: WorldbookDocument
  worldbookPresent: boolean
  worldbookError?: string | null
  chapters: ChapterRecord[]
  characters: CharactersDocument
  timeline: TimelineDocument
  foreshadows: ForeshadowsDocument
  relationships: RelationshipsDocument
  reviews: ReviewDocument[]
  activity: AuditRow[]
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

/** Build the whole-book report from one committed snapshot. No IO. */
export function buildBookReport(input: ReportInput): BookReport {
  const records = [...input.chapters].sort((left, right) => left.num - right.num)
  const words = records.reduce((total, record) => total + record.word_count, 0)
  const scores = records.map((record) => record.score)
  const lastFive = scores.slice(-5)
  const previous = scores.slice(-10, -5)
  const qualityAverage = average(scores)
  const dimensions = new Map<string, { total: number; samples: number }>()
  for (const review of input.reviews) {
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
  const castTop = input.characters.characters
    .map((character) => ({
      name: character.name,
      role: character.role,
      appearances: appearances.get(character.name) ?? 0,
      last_seen: Math.max(character.updated_at, lastAppearance.get(character.name) ?? 0),
    }))
    .sort(
      (left, right) =>
        right.appearances - left.appearances ||
        right.last_seen - left.last_seen ||
        left.name.localeCompare(right.name, 'zh-CN'),
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
  const outline = outlineSummary(input.outline, records.length)
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
  return {
    progress: {
      archived: records.length,
      target: input.targetChapters,
      words,
      average_words: records.length === 0 ? 0 : Math.round(words / records.length),
      percent:
        input.targetChapters === null || input.targetChapters === 0
          ? 0
          : Math.min(100, Math.round((records.length / input.targetChapters) * 100)),
      remaining_words:
        input.targetChapters === null
          ? null
          : Math.max(0, (input.targetChapters - records.length) * input.project.targets.words_per_chapter[0]),
    },
    outline: {
      present: outline.present,
      strict: input.outline.book.strict,
      planned: outline.planned,
      archived: outline.archived,
      coverage: outline.coverage,
      volumes: volumeCounts,
      drift,
    },
    worldbook: worldbookCounts(input.worldbook),
    quality: {
      average: Math.round(qualityAverage * 10) / 10,
      median: Math.round(median(scores) * 10) / 10,
      min: scores.length === 0 ? 0 : Math.min(...scores),
      max: scores.length === 0 ? 0 : Math.max(...scores),
      last_five: lastFive,
      trend: previous.length === 0 ? 0 : Math.round((average(lastFive) - average(previous)) * 10) / 10,
      dimensions: [...dimensions.entries()]
        .map(([id, value]) => ({
          id,
          average: Math.round((value.total / value.samples) * 10) / 10,
          samples: value.samples,
        }))
        .sort((left, right) => left.id.localeCompare(right.id, 'zh-CN')),
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
        .sort((left, right) => left.last_touched - right.last_touched || left.id.localeCompare(right.id))
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
      title: input.finished ? '全书章节已写完' : `写第 ${input.chapter} 章`,
      detail: input.finished
        ? `已完成 ${input.archived} 章；下一步是导出成书。`
        : `当前阶段 ${input.stage}；${input.blocking === 0 ? '没有阻塞' : `${input.blocking} 条阻塞`}。`,
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
    title: input.finished ? '全书已完成' : `第 ${input.chapter} 章 · ${input.stage}`,
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

/** Re-export the score helper for the report tests and the doctor. */
export { scoreOf }
