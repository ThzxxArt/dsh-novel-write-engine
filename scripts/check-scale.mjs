#!/usr/bin/env node
/**
 * Scale gate for the 0.2.20 release.
 *
 * Builds a synthetic 600-archived-chapter project in a temp directory, checks
 * that the engine can read it without state/journal damage, then measures the
 * read paths and the task-book payload sizes against fixed budgets.
 *
 *   node scripts/check-scale.mjs [--keep] [--briefs-only]
 *
 * `--briefs-only` keeps the task-book budgets and skips latency sampling.
 * It prints, for every stage over budget, the blocks that caused the overrun.
 *
 * Exit codes: 0 = every budget passed, 1 = a budget failed (or a measured
 * operation errored), 2 = the fixture could not be built or validated.
 *
 * The fixture is self-contained: no network, no external book, and every file
 * is written under a fresh temp root. The only repository input is the
 * de-identified prose corpus used for the manuscript bodies.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify as yamlStringify } from 'yaml'
import { EngineService, loadRulepack } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const CORPUS_FILE = join(REPO_ROOT, 'tests/fixtures/prose/corpus.json')
const KEEP = process.argv.includes('--keep')
/**
 * Only the task-book budgets, no latency sampling: 20 warm samples of five
 * read paths dominate the runtime of this gate, and iterating on brief sizes
 * should not cost four minutes a run. The full gate is still what CI runs.
 */
const BRIEFS_ONLY = process.argv.includes('--briefs-only')

const CHAPTERS = 600
const TIMELINE_PER_CHAPTER = 8
const TIMELINE_ITEMS = CHAPTERS * TIMELINE_PER_CHAPTER
const FORESHADOWS = 100
const CHARACTERS = 40
const WORLD_LOCATIONS = 20
const RELATIONSHIPS = 80
const JOURNAL_PER_CHAPTER = 40

const WARM_ITERATIONS = 20

const BUDGET = {
  getStatusMs: 150,
  // 0.2.20 release: this budget was calibrated on a developer box. The GitHub
  // runner is ~5x slower on the same fixture (report p95 482 ms there vs ~100 ms
  // locally, with every other section still at 55–96 ms), so the gate failed on
  // a build that had not regressed. Raised to 1,200: still 1.7x below the 0.2.19
  // report (1,689 ms locally, ~8 s on the runner), so a regression of that size
  // cannot pass.
  reportMs: 1_200,
  // 0.2.20 review raised this from 120 to 240. `FsStore.readDoc` now revalidates
  // after a 5 s TTL (a same-size, same-mtime external edit was served stale
  // forever), and the per-chapter sections pay one re-parse of the review files
  // per TTL window instead of holding them for the process lifetime. Cold latency
  // is unchanged (~450 ms); the warm p95 on the 600-chapter fixture moved from
  // ~60 ms to ~180–205 ms. The budget still bounds the section, and the cause is
  // measured rather than assumed.
  panelSectionMs: 240,
  // `health` aggregates the doctor-style checks and is the one section whose
  // p95 is real work; 383.7 ms on the runner against ~100 ms locally is the
  // machine, not the algorithm.
  panelSectionHealthMs: 900,
  auditHistoryMs: 150,
  briefBytes: 8192,
  briefTotalBytes: 48 * 1024,
  // 0.2.20: the gate is the host pruner's unit. `compaction-tool-result-pruner`
  // measures Unicode code points (`Array.from(text).length`), not bytes, and it
  // measures the whole tool result. A Chinese-heavy payload is ~3 bytes per
  // code point, so a byte budget here would be three times too strict and
  // would hide the real overrun behind the wrong number.
  briefPoints: 8192,
  briefTotalPoints: 7 * 8192,
  panelPayloadBytes: 64 * 1024,
}

const SCENE_TYPES = ['日常过渡章', '纯叙事章', '情感爆发章', '战斗/动作章']
const TITLE_BODIES = [
  '旧城夜雨',
  '灯火未眠',
  '雨停之前',
  '一纸旧约',
  '长街无声',
  '潮水东去',
  '灯下故人',
  '窄巷回声',
  '风起南门',
  '桥头等候',
  '未寄的信',
  '深夜来客',
  '空屋余温',
  '第七码头',
  '雨夜归途',
  '最后一盏',
]

class SetupError extends Error {}

const sha256 = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
/** Journal hashes are computed over base64 bytes, not over UTF-8 text. */
const journalHash = (text) => sha256(Buffer.from(text, 'utf8').toString('base64'))
const pad3 = (value) => String(value).padStart(3, '0')
const pad6 = (value) => String(value).padStart(6, '0')
const formatMs = (value) => `${value.toFixed(1)} ms`
const formatBytes = (value) => `${value.toLocaleString('en-US')} B`
const errorCode = (error) => {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  if (error instanceof Error) return error.name
  return 'ERROR'
}
const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

const percentile = (values, fraction) => {
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.ceil(fraction * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

const timed = async (fn) => {
  const start = performance.now()
  const value = await fn()
  return { value, ms: performance.now() - start }
}

const mapLimit = async (items, limit, worker) => {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

const row = (metric, measured, budget, verdict) =>
  `${metric.padEnd(46)} | ${measured.padEnd(56)} | ${budget.padEnd(16)} | ${verdict}`

const describeError = (error) => {
  const code = errorCode(error)
  const message = errorMessage(error)
  return message === '' ? code : `${code}: ${message}`
}

const parseJsonFile = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new SetupError(`cannot read ${path}: ${errorMessage(error)}`)
  }
}

const tableRows = []
const measurementFailures = []
const refusals = []
const failures = []

const addBudgetRow = (metric, measured, budget, ok) => {
  const verdict = ok ? 'PASS' : 'FAIL'
  if (!ok) failures.push(metric)
  tableRows.push(row(metric, measured, budget, verdict))
}

const addInfoRow = (metric, measured, budget = '-') => {
  tableRows.push(row(metric, measured, budget, 'INFO'))
}

const addNotMeasuredRow = (metric, measured, budget) => {
  tableRows.push(row(metric, measured, budget, 'NOT MEASURED'))
}

const buildChapterText = (num, paragraphs) => {
  const picked = []
  let length = 0
  let index = num % paragraphs.length
  while (length < 600 && picked.length < 40) {
    const paragraph = paragraphs[index % paragraphs.length]
    picked.push(paragraph)
    length += Array.from(paragraph).length
    index += 7
  }
  return `第${num}章\n${picked.join('\n')}\n`
}

const archiveTime = (num) => new Date(Date.UTC(2025, 0, 1) + num * 6 * 60 * 60 * 1000).toISOString()

const opsForChapter = (num, paths) => {
  const planWorld = `plans/ch${pad3(num)}.world.yaml`
  const planChapter = `plans/ch${pad3(num)}.chapter.yaml`
  const exportChapter = `exports/chapter-${pad3(num)}.md`
  return [
    { op: 'getBrief', stage: 'P1', files: [paths.briefs] },
    { op: 'getBrief', stage: 'P2', files: [paths.briefs] },
    { op: 'getBrief', stage: 'P3', files: [paths.briefs] },
    { op: 'submitWorldPlan', stage: 'P2', files: [planWorld] },
    { op: 'getBrief', stage: 'P3', files: [paths.briefs] },
    { op: 'submitChapterPlan', stage: 'P3', files: [planChapter] },
    { op: 'getBrief', stage: 'P3', files: [paths.briefs] },
    { op: 'submitDraft', stage: 'P3', files: [paths.chapter] },
    { op: 'getBrief', stage: 'P4', files: [paths.briefs] },
    { op: 'submitReview', stage: 'P4', files: [paths.review] },
    { op: 'getBrief', stage: 'P5', files: [paths.briefs] },
    { op: 'submitRevision', stage: 'P5', files: [paths.chapter] },
    { op: 'getBrief', stage: 'P6', files: [paths.briefs] },
    { op: 'runCheck', stage: 'P6', files: [paths.check] },
    { op: 'amend', files: [paths.project] },
    { op: 'amend', files: [paths.chapters, paths.timeline, paths.foreshadows] },
    { op: 'amend', files: [paths.characters, paths.relationships, paths.world] },
    { op: 'export', files: [exportChapter] },
    { op: 'getBrief', stage: 'P8', files: [paths.briefs] },
    { op: 'reviewAmendment', stage: 'P4', files: [paths.review] },
    { op: 'submitWorldbook', files: [paths.worldbook] },
    { op: 'submitOutline', files: [paths.outline] },
    { op: 'submitBookPlan', files: [paths.outline] },
    { op: 'export', files: [exportChapter] },
    { op: 'amend', files: [paths.handoff] },
    { op: 'amend', files: [paths.locks] },
    { op: 'reviewAmendment', stage: 'P4', files: [paths.review] },
    { op: 'runCheck', stage: 'P6', files: [paths.check] },
    { op: 'submitRevision', stage: 'P5', files: [paths.chapter] },
    { op: 'export', files: ['exports/outline.md'] },
    { op: 'amend', files: [paths.pipeline] },
    { op: 'amend', files: [paths.handoff] },
    { op: 'amend', files: [paths.world] },
    { op: 'amend', files: [paths.relationships] },
    { op: 'amend', files: [paths.locks] },
    { op: 'export', files: ['exports/worldbook.md'] },
    { op: 'getBrief', stage: 'P1', files: [paths.briefs] },
    { op: 'submitDraft', stage: 'P3', files: [paths.chapter] },
    { op: 'amend', files: [paths.pipeline] },
    { op: 'archiveChapter', files: paths.archive },
  ]
}

let root = null
let stateDir = null
let engine = null
let exitCode = 2

try {
  const tempBase = process.env.NOVEL_SCALE_TMPDIR ?? tmpdir()
  root = await mkdtemp(join(tempBase, 'novel-scale-'))
  stateDir = await mkdtemp(join(tempBase, 'novel-scale-state-'))

  const rulepack = loadRulepack()
  const dimensions = rulepack.quality.dimensions
  const qualityTotal = dimensions.reduce((sum, dimension) => sum + dimension.max, 0)
  const targetWords = rulepack.platform.fanqie.words_per_chapter

  engine = new EngineService(
    {
      projectRoot: root,
      stateDir,
      tools: { mode: 'all' },
      quality: { minScore: 120 },
      briefs: { overrides: '' },
      storage: { backupRetention: 5 },
    },
    () => loadRulepack(),
    { now: () => new Date() },
  )

  const buildStart = performance.now()

  const init = await engine.initProject({
    title: 'Scale Fixture 600',
    genre: '都市现代',
    platform: 'fanqie',
    author: 'scale-gate',
    description: 'synthetic 600-chapter fixture for the 0.2.20 scale gate',
    total_chapters: CHAPTERS,
    style: 'none',
    style_confirmation: 'skipped:scale-gate',
    root,
  })
  if (init?.data?.title !== 'Scale Fixture 600') {
    throw new SetupError('initProject returned an unexpected project title')
  }

  const corpus = await parseJsonFile(CORPUS_FILE)
  const paragraphs = Array.isArray(corpus?.entries)
    ? corpus.entries
        .map((entry) => entry?.text)
        .filter((text) => typeof text === 'string' && text.trim() !== '')
    : []
  if (paragraphs.length < 10) {
    throw new SetupError(`prose corpus ${CORPUS_FILE} has fewer than ten usable entries`)
  }

  const chapterTexts = Array.from({ length: CHAPTERS }, (_, index) => buildChapterText(index + 1, paragraphs))
  const counted = await Promise.all(chapterTexts.map((text) => engine.countWords({ text })))
  const counts = counted.map((result, index) => {
    if (result?.data === undefined) throw new SetupError(`countWords failed for chapter ${index + 1}`)
    return result.data
  })

  const names = Array.from({ length: CHARACTERS }, (_, index) => `角色${String(index + 1).padStart(2, '0')}`)
  const locations = Array.from(
    { length: WORLD_LOCATIONS },
    (_, index) => `地点${String(index + 1).padStart(2, '0')}`,
  )
  const titleBody = (num) => TITLE_BODIES[(num - 1) % TITLE_BODIES.length]
  const sceneFor = (num) => SCENE_TYPES[(num - 1) % SCENE_TYPES.length]
  const narratorFor = (num) => names[(num - 1) % names.length]

  const chapterRecords = []
  const chapterFiles = []
  const reviewFiles = []
  const checkFiles = []

  for (let num = 1; num <= CHAPTERS; num += 1) {
    const text = chapterTexts[num - 1]
    const metrics = counts[num - 1]
    const contentHash = sha256(text)
    const body = titleBody(num)
    const sceneType = sceneFor(num)
    const narrator = narratorFor(num)
    const archivedAt = archiveTime(num)
    const events = Array.from({ length: 3 }, (_, index) => `事件${num}-${index + 1}`)
    const cast = [names[num % names.length], names[(num * 3 + 1) % names.length]]
    const summary = {
      events,
      characters_appeared: cast,
      foreshadows: { planted: [], advanced: [], resolved: [] },
      new_elements: { locations: [], abilities: [], artifacts: [] },
      resource_changes: [],
      opening: `开场${num}`,
      continuity: { opens_from: `承接${num - 1}`, ends_with: `收束${num}` },
      hook_strength: num % 7 === 0 ? 2 : num % 5 === 0 ? 3 : num % 3 === 0 ? 4 : 5,
      pleasure_points: ['信息差'],
      plot_advancement: num % 11 === 0 ? 'low' : num % 4 === 0 ? 'high' : 'mid',
    }

    chapterRecords.push({
      num,
      title: `第${num}章 ${body}`,
      file: `chapters/chapter-${pad3(num)}.md`,
      word_count: metrics.total_word_count,
      cjk_words: metrics.cjk_chars,
      dialogue_lines: metrics.dialogue_lines,
      dialogue_ratio: metrics.dialogue_ratio,
      scene_type: sceneType,
      narrator,
      score: qualityTotal,
      status: 'reviewed',
      content_hash: contentHash,
      summary,
      rounds: { review: 1, revise: 2, check: 2 },
      final_check: 'pass',
      archived_at: archivedAt,
      scoring_basis: 'machine',
    })
    chapterFiles.push({ path: `chapters/chapter-${pad3(num)}.md`, text })

    reviewFiles.push({
      path: `reviews/ch${pad3(num)}.review.yaml`,
      text: yamlStringify({
        schema_version: 1,
        chapter: num,
        round: 1,
        content_hash: contentHash,
        dimensions: dimensions.map((dimension) => ({
          id: dimension.id,
          max: dimension.max,
          deductions: [],
        })),
        issues: [],
        total: qualityTotal,
      }),
    })

    checkFiles.push({
      path: `checks/ch${pad3(num)}.check.yaml`,
      text: yamlStringify({
        schema_version: 1,
        chapter: num,
        scope: ['machine', 'semantic'],
        content_hash: contentHash,
        machine: {
          violations: [],
          advisories: [],
          metrics,
        },
        semantic: { items: [] },
        acknowledged: [],
        failure_class: 'submission',
        counted: false,
        legacy_format: false,
        verdict: 'pass',
      }),
    })
  }

  const timeline = {
    schema_version: 1,
    next_seq: TIMELINE_ITEMS + 1,
    items: Array.from({ length: TIMELINE_ITEMS }, (_, index) => {
      const chapter = Math.floor(index / TIMELINE_PER_CHAPTER) + 1
      const offset = index % TIMELINE_PER_CHAPTER
      return {
        id: `TL${String(index + 1).padStart(4, '0')}`,
        chapter,
        story_time: `第${chapter}日`,
        description: `线索${offset + 1}`,
        location: locations[index % locations.length],
        characters: [names[index % names.length], names[(index * 3 + 1) % names.length]],
        event_key: `c${chapter}e${offset}`,
      }
    }),
  }

  const foreshadows = {
    schema_version: 1,
    next_seq: FORESHADOWS + 1,
    items: Array.from({ length: FORESHADOWS }, (_, index) => {
      const seq = index + 1
      const planted = Math.min(550, 1 + ((index * 5) % CHAPTERS))
      const resolved = index % 4 === 0
      const lastTouched = Math.min(CHAPTERS, planted + (resolved ? 20 : 40))
      return {
        id: `FS-${pad3(seq)}`,
        title: `伏笔 ${pad3(seq)}`,
        planted,
        last_touched: lastTouched,
        status: resolved ? 'resolved' : index % 3 === 0 ? 'advanced' : 'planted',
        resolved_at: resolved ? lastTouched : null,
        description: '旧城线索引',
        anchor: '旧城夜雨里那盏灯',
        planned_resolve: Math.min(CHAPTERS, planted + 30),
        ...(resolved ? { resolved_anchor: '旧城夜雨里那盏灯终于灭了' } : {}),
        kind: index % 10 === 0 ? 'motif' : 'plot',
        format_version: 1,
        advance_log: [],
      }
    }),
  }

  const characters = {
    schema_version: 1,
    characters: names.map((name, index) => ({
      name,
      role: index === 0 ? 'protagonist' : index < 5 ? 'supporting' : 'extra',
      first_appearance: 1 + (index % 10),
      profile: { identity: `身份${index + 1}` },
      current_state: {},
      growth: [],
      updated_at: CHAPTERS - (index % 3),
    })),
  }

  const world = {
    schema_version: 1,
    locations: locations.map((name) => ({
      name,
      anchors: [name],
      first_appearance: 1,
      locked: false,
      description: `${name}的旧街`,
      layout: '南北向两条街',
      capacity: 100,
      changes: [],
    })),
    abilities: [],
    artifacts: [],
    factions: [],
    rules: [],
  }

  const locks = { schema_version: 1, locked_at_chapter: CHAPTERS, characters: {}, locations: {} }

  const relationships = {
    schema_version: 1,
    next_seq: RELATIONSHIPS + 1,
    items: Array.from({ length: RELATIONSHIPS }, (_, index) => {
      const left = names[index % names.length]
      const rightIndex = (index * 7 + 1) % names.length
      const right = names[rightIndex === index % names.length ? (rightIndex + 1) % names.length : rightIndex]
      return {
        id: `REL-${pad3(index + 1)}`,
        a: left,
        b: right,
        type: '盟友',
        type_code: 'ally',
        since: 1 + (index % 100),
        description: '旧城里的合作者',
        evolution: [],
      }
    }),
  }

  const handoff = {
    schema_version: 1,
    current_chapter: CHAPTERS,
    volume: 6,
    volume_name: '第六卷',
    act: '第六幕',
    act_progress: '100/100',
    next_chapter: CHAPTERS + 1,
    last_summary: '旧城的线索收束到码头。',
    open_hooks: [
      { id: 'FS-001', title: '伏笔 001' },
      { id: 'FS-005', title: '伏笔 005' },
    ],
    updated_at: archiveTime(CHAPTERS),
  }

  const volumes = Array.from({ length: 6 }, (_, index) => ({
    id: `v${index + 1}`,
    title: `第${index + 1}卷`,
    start_chapter: index * 100 + 1,
    end_chapter: (index + 1) * 100,
    goal: `第${index + 1}卷目标`,
    arc: `第${index + 1}卷弧线`,
    climax: `第${index + 1}卷高潮`,
    status: 'done',
  }))

  const outline = {
    schema_version: 1,
    updated_at: archiveTime(CHAPTERS),
    book: {
      premise: '暴雨夜的城市里，旧城线索把几个人重新连在一起。',
      logline: '一封信让旧案重开，所有人都必须在记忆和当下之间选择。',
      themes: ['城市', '记忆'],
      tone: '冷峻',
      pov: '第三人称',
      audience: '都市悬疑读者',
      selling_points: ['线索前置', '旧城氛围'],
      ending: '最后一盏灯熄灭，旧案有了答案。',
      strict: false,
      strict_explicit: true,
    },
    volumes,
    chapters: chapterRecords.map((record) => ({
      num: record.num,
      volume: Math.ceil(record.num / 100),
      title: titleBody(record.num),
      scene_type: record.scene_type,
      goal: `目标${record.num}`,
      conflict: '冲突',
      hook: '钩子',
      cast: record.summary.characters_appeared,
      target_words: [targetWords[0], targetWords[1]],
      notes: '',
      status: 'archived',
      archived_at: record.archived_at,
      word_count: record.word_count,
      cjk_words: record.cjk_words,
      score: record.score,
    })),
  }

  const worldbook = {
    schema_version: 1,
    updated_at: archiveTime(CHAPTERS),
    premise: '旧城在雨季里显露出另一条时间线。',
    setting: '南方旧城，雨夜与码头。',
    rules: [],
    factions: [],
    locations: [],
    characters: [],
    glossary: [],
    backstory: [],
    facts: [],
    themes: ['城市', '记忆'],
  }

  const pipeline = {
    schema_version: 1,
    revision: CHAPTERS * JOURNAL_PER_CHAPTER + 1,
    chapter: CHAPTERS + 1,
    stage: 'idle',
    rounds: { review: 0, revise: 0, check: 0 },
    briefs: {},
    blocking: [],
    last_action: {
      op: 'archiveChapter',
      at: archiveTime(CHAPTERS),
      digest: 'sha256:scale-fixture',
    },
  }

  const chaptersDocument = { schema_version: 1, chapters: chapterRecords }

  const documents = new Map([
    ['state/chapters.yaml', yamlStringify(chaptersDocument)],
    ['state/timeline.yaml', yamlStringify(timeline)],
    ['state/foreshadows.yaml', yamlStringify(foreshadows)],
    ['state/characters.yaml', yamlStringify(characters)],
    ['state/world.yaml', yamlStringify(world)],
    ['state/locks.yaml', yamlStringify(locks)],
    ['state/relationships.yaml', yamlStringify(relationships)],
    ['state/handoff.yaml', yamlStringify(handoff)],
    ['state/pipeline.yaml', yamlStringify(pipeline)],
    ['outline/outline.yaml', yamlStringify(outline)],
    ['outline/worldbook.yaml', yamlStringify(worldbook)],
  ])

  const writeText = async (relativePath, text) => {
    const absolutePath = join(root, relativePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, text, 'utf8')
  }

  for (const [relativePath, text] of documents) {
    await writeText(relativePath, text)
  }
  await mapLimit(chapterFiles, 32, (file) => writeText(file.path, file.text))
  await mapLimit(reviewFiles, 32, (file) => writeText(file.path, file.text))
  await mapLimit(checkFiles, 32, (file) => writeText(file.path, file.text))

  const projectText = await readFile(join(root, 'novel.yaml'), 'utf8')
  const briefsText = await readFile(join(root, 'state/briefs.yaml'), 'utf8')

  const knownHashes = new Map()
  for (const [relativePath, text] of documents) knownHashes.set(relativePath, journalHash(text))
  knownHashes.set('novel.yaml', journalHash(projectText))
  knownHashes.set('state/briefs.yaml', journalHash(briefsText))
  for (const file of chapterFiles) knownHashes.set(file.path, journalHash(file.text))
  for (const file of reviewFiles) knownHashes.set(file.path, journalHash(file.text))
  for (const file of checkFiles) knownHashes.set(file.path, journalHash(file.text))

  const hashOf = (relativePath) => {
    const known = knownHashes.get(relativePath)
    if (known !== undefined) return known
    if (
      relativePath.startsWith('state/') ||
      relativePath === 'novel.yaml' ||
      relativePath.startsWith('outline/')
    ) {
      throw new SetupError(`no fixture hash for tracked path ${relativePath}`)
    }
    return sha256(`fixture:${relativePath}`)
  }

  const stateArchives = [
    'state/chapters.yaml',
    'state/timeline.yaml',
    'state/foreshadows.yaml',
    'state/characters.yaml',
    'state/world.yaml',
    'state/locks.yaml',
    'state/relationships.yaml',
    'state/handoff.yaml',
  ]

  const journalRows = []
  let journalSeq = 0
  const addJournalRecord = (record) => {
    journalSeq += 1
    journalRows.push({
      txid: `tx-${pad6(journalSeq)}`,
      at: new Date(Date.UTC(2025, 0, 1) + journalSeq * 10 * 60 * 1000).toISOString(),
      revision: journalSeq,
      status: 'committed',
      ...record,
    })
  }

  addJournalRecord({
    op: 'initProject',
    chapter: 0,
    files: ['novel.yaml', 'state/pipeline.yaml', 'state/chapters.yaml', 'outline/outline.yaml'],
    hashes: Object.fromEntries(
      ['novel.yaml', 'state/pipeline.yaml', 'state/chapters.yaml', 'outline/outline.yaml'].map((path) => [
        path,
        hashOf(path),
      ]),
    ),
  })

  for (let num = 1; num <= CHAPTERS; num += 1) {
    const files = {
      project: 'novel.yaml',
      briefs: 'state/briefs.yaml',
      chapter: `chapters/chapter-${pad3(num)}.md`,
      review: `reviews/ch${pad3(num)}.review.yaml`,
      check: `checks/ch${pad3(num)}.check.yaml`,
      pipeline: 'state/pipeline.yaml',
      handoff: 'state/handoff.yaml',
      locks: 'state/locks.yaml',
      world: 'state/world.yaml',
      relationships: 'state/relationships.yaml',
      chapters: 'state/chapters.yaml',
      timeline: 'state/timeline.yaml',
      foreshadows: 'state/foreshadows.yaml',
      characters: 'state/characters.yaml',
      outline: 'outline/outline.yaml',
      worldbook: 'outline/worldbook.yaml',
      archive: [
        `chapters/chapter-${pad3(num)}.md`,
        `reviews/ch${pad3(num)}.review.yaml`,
        `checks/ch${pad3(num)}.check.yaml`,
        ...stateArchives,
        'outline/outline.yaml',
      ],
    }
    const operations = opsForChapter(num, files)
    if (operations.length !== JOURNAL_PER_CHAPTER) {
      throw new SetupError(
        `chapter ${num} has ${operations.length} journal operations, expected ${JOURNAL_PER_CHAPTER}`,
      )
    }
    operations.forEach((operation, index) => {
      const hashes = Object.fromEntries(operation.files.map((path) => [path, hashOf(path)]))
      const record = {
        op: operation.op,
        chapter: num,
        revision: num * JOURNAL_PER_CHAPTER + index + 1,
        files: operation.files,
        hashes,
        ...(operation.stage === undefined ? {} : { stage: operation.stage }),
      }
      if (operation.op === 'archiveChapter') {
        record.before = Object.fromEntries(
          operation.files.map((path) => [
            path,
            path.startsWith('chapters/') || path.startsWith('reviews/') || path.startsWith('checks/')
              ? null
              : hashOf(path),
          ]),
        )
      }
      addJournalRecord(record)
    })
  }

  const journalText = `${journalRows.map((record) => JSON.stringify(record)).join('\n')}\n`
  await writeText('state/journal.jsonl', journalText)

  const buildMs = performance.now() - buildStart

  const sizes = []
  for (const relativePath of [
    'state/chapters.yaml',
    'state/timeline.yaml',
    'state/foreshadows.yaml',
    'state/characters.yaml',
    'state/world.yaml',
    'state/locks.yaml',
    'state/relationships.yaml',
    'state/handoff.yaml',
    'state/pipeline.yaml',
    'outline/outline.yaml',
    'outline/worldbook.yaml',
    'state/journal.jsonl',
  ]) {
    const info = await stat(join(root, relativePath))
    sizes.push({ path: relativePath, bytes: info.size })
  }

  const statusCold = await timed(() => engine.getStatus({ root }))
  const reportCold = await timed(() => engine.report({ root }))
  const doctorCold = await timed(() => engine.doctor({ root }))
  const auditCold = await timed(() => engine.auditHistory({ root, limit: 50 }))

  const status = statusCold.value
  const report = reportCold.value
  const doctor = doctorCold.value
  const audit = auditCold.value

  const validationProblems = []
  const stateErrors = Array.isArray(status?.data?.state_errors) ? status.data.state_errors : []
  const statusBlocking = Array.isArray(status?.data?.blocking) ? status.data.blocking : []
  if (stateErrors.length !== 0) {
    validationProblems.push(`getStatus state_errors=${stateErrors.length}: ${stateErrors[0]?.message ?? ''}`)
  }
  if (statusBlocking.length !== 0) {
    validationProblems.push(`getStatus blocking=${statusBlocking.length}: ${statusBlocking[0]?.code ?? ''}`)
  }
  if (report?.data?.progress?.archived !== CHAPTERS) {
    validationProblems.push(`report archived=${String(report?.data?.progress?.archived)}`)
  }
  if (doctor?.data?.summary?.errors !== 0) {
    validationProblems.push(`doctor errors=${String(doctor?.data?.summary?.errors)}`)
  }
  const journalCheck = doctor?.data?.checks?.find((check) => check.id === 'journal')
  if (journalCheck !== undefined && journalCheck.severity === 'error') {
    validationProblems.push(`doctor journal: ${journalCheck.detail}`)
  }
  const journalWarnings = (audit?.warnings ?? []).filter(
    (warning) =>
      warning.code === 'JOURNAL_MISSING' ||
      warning.code === 'JOURNAL_MALFORMED' ||
      warning.code === 'JOURNAL_HASH_MISMATCH' ||
      warning.code === 'PENDING_PARTIAL' ||
      warning.code === 'PENDING_RECOVERABLE' ||
      warning.code === 'PENDING_ABORTABLE',
  )
  if (journalWarnings.length !== 0) {
    validationProblems.push(
      `auditHistory warnings: ${journalWarnings.map((warning) => warning.code).join(',')}`,
    )
  }
  const statusWarnings = (status?.warnings ?? []).filter((warning) => warning.code.startsWith('PENDING'))
  if (statusWarnings.length !== 0) {
    validationProblems.push(
      `getStatus pending warnings: ${statusWarnings.map((warning) => warning.code).join(',')}`,
    )
  }
  if (validationProblems.length !== 0) {
    throw new SetupError(`fixture validation failed: ${validationProblems.join(' | ')}`)
  }

  console.log(`fixture root: ${root}`)
  console.log(`fixture state dir: ${stateDir}`)
  for (const size of sizes) {
    console.log(`fixture size: ${size.path} = ${formatBytes(size.bytes)}`)
  }
  console.log(`fixture journal lines: ${journalRows.length}`)
  console.log(
    `fixture validation: state_errors=${stateErrors.length} blocking=${statusBlocking.length} ` +
      `report.archived=${report.data.progress.archived} doctor.errors=${doctor.data.summary.errors} ` +
      `audit.warnings=${(audit.warnings ?? []).length}`,
  )
  console.log(`fixture build: ${formatMs(buildMs)}`)
  console.log('')

  const measureWarm = async (label, fn, coldMs) => {
    try {
      const samples = []
      for (let index = 0; index < WARM_ITERATIONS; index += 1) {
        samples.push((await timed(fn)).ms)
      }
      return { coldMs, p95: percentile(samples, 0.95) }
    } catch (error) {
      measurementFailures.push(`${label}: ${describeError(error)}`)
      return null
    }
  }

  const measureSeries = async (label, fn) => {
    try {
      const cold = await timed(fn)
      const samples = []
      for (let index = 0; index < WARM_ITERATIONS; index += 1) {
        samples.push((await timed(fn)).ms)
      }
      return { coldMs: cold.ms, p95: percentile(samples, 0.95), coldValue: cold.value }
    } catch (error) {
      measurementFailures.push(`${label}: ${describeError(error)}`)
      return null
    }
  }

  const panelResults = new Map()
  if (!BRIEFS_ONLY) {
    const statusSeries = await measureWarm('getStatus', () => engine.getStatus({ root }), statusCold.ms)
    if (statusSeries === null) {
      addBudgetRow('getStatus (p95)', 'ERROR', `<= ${BUDGET.getStatusMs} ms`, false)
    } else {
      addBudgetRow(
        'getStatus (p95)',
        `p95 ${formatMs(statusSeries.p95)} - cold ${formatMs(statusSeries.coldMs)}`,
        `<= ${BUDGET.getStatusMs} ms`,
        statusSeries.p95 <= BUDGET.getStatusMs,
      )
    }

    const reportSeries = await measureWarm('report', () => engine.report({ root }), reportCold.ms)
    if (reportSeries === null) {
      addBudgetRow('report (p95)', 'ERROR', `<= ${BUDGET.reportMs} ms`, false)
    } else {
      addBudgetRow(
        'report (p95)',
        `p95 ${formatMs(reportSeries.p95)} - cold ${formatMs(reportSeries.coldMs)}`,
        `<= ${BUDGET.reportMs} ms`,
        reportSeries.p95 <= BUDGET.reportMs,
      )
    }

    const panelSections = [
      'overview',
      'chapters',
      'characters',
      'foreshadows',
      'timeline',
      'relationships',
      'worldbook',
      'quality',
      'health',
    ]
    const sectionBudget = (section) =>
      section === 'health' ? BUDGET.panelSectionHealthMs : BUDGET.panelSectionMs
    for (const section of panelSections) {
      const result = await measureSeries(`panelSection ${section}`, () =>
        engine.panelSection({ root, section }),
      )
      panelResults.set(section, result)
      const budget = sectionBudget(section)
      if (result === null) {
        addBudgetRow(`panelSection ${section} (p95)`, 'ERROR', `<= ${budget} ms`, false)
        continue
      }
      addBudgetRow(
        `panelSection ${section} (p95)`,
        `p95 ${formatMs(result.p95)} - cold ${formatMs(result.coldMs)}`,
        `<= ${budget} ms`,
        result.p95 <= budget,
      )
    }
    const panelMeasured = [...panelResults.entries()].filter((entry) => entry[1] !== null)
    if (panelMeasured.length !== panelSections.length) {
      addBudgetRow('panelSection worst (p95)', 'ERROR', `<= ${BUDGET.panelSectionMs} ms`, false)
    } else {
      const [worstSection, worst] = panelMeasured.reduce((worst, current) =>
        current[1].p95 > worst[1].p95 ? current : worst,
      )
      const worstBudget = sectionBudget(worstSection)
      addBudgetRow(
        `panelSection worst = ${worstSection} (p95)`,
        `p95 ${formatMs(worst.p95)} - cold ${formatMs(worst.coldMs)}`,
        `<= ${worstBudget} ms`,
        worst.p95 <= worstBudget,
      )
    }

    const auditSeries = await measureWarm(
      'auditHistory',
      () => engine.auditHistory({ root, limit: 50 }),
      auditCold.ms,
    )
    if (auditSeries === null) {
      addBudgetRow('auditHistory(limit=50) (p95)', 'ERROR', `<= ${BUDGET.auditHistoryMs} ms`, false)
    } else {
      addBudgetRow(
        'auditHistory(limit=50) (p95)',
        `p95 ${formatMs(auditSeries.p95)} - cold ${formatMs(auditSeries.coldMs)}`,
        `<= ${BUDGET.auditHistoryMs} ms`,
        auditSeries.p95 <= BUDGET.auditHistoryMs,
      )
    }
  } else {
    addInfoRow('latency sampling', 'skipped (--briefs-only)')
  }

  const briefStages = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P8']
  const briefResults = new Map()
  for (const stage of briefStages) {
    try {
      const { value } = await timed(() => engine.getBrief({ stage, root }))
      const serialized = JSON.stringify({
        content: value.data.content,
        context: value.data.context,
        fields: value.data.fields,
        digest: value.data.digest,
      })
      const points = Array.from(serialized).length
      const bytes = Buffer.byteLength(serialized, 'utf8')
      briefResults.set(stage, { points, bytes })
      addBudgetRow(
        `brief ${stage} payload code points`,
        `${points.toLocaleString('en-US')} (${formatBytes(bytes)})`,
        `<= ${BUDGET.briefPoints.toLocaleString('en-US')}`,
        points <= BUDGET.briefPoints,
      )
      // When a stage overruns, name the blocks that did it. Without this the
      // gate only says "too big" and the fix is guesswork.
      if (points > BUDGET.briefPoints) {
        const parts = [
          ['content (guide)', value.data.content],
          ['fields', value.data.fields],
          ['digest', value.data.digest],
          ...Object.entries(value.data.context ?? {})
            .filter(([key]) => key !== 'context_meta')
            .map(([key, block]) => [`context.${key}`, block]),
        ]
        const ranked = parts
          .map(([label, block]) => [label, Array.from(JSON.stringify(block) ?? '').length])
          .sort((left, right) => right[1] - left[1])
          .slice(0, 8)
        console.log(
          `${stage} over budget by ${(points - BUDGET.briefPoints).toLocaleString('en-US')}: ` +
            ranked.map(([label, size]) => `${label} ${size.toLocaleString('en-US')}`).join(', '),
        )
      }
    } catch (error) {
      if (errorCode(error) === 'SCHEMA_INVALID' || error?.name === 'EngineInputError') {
        const code = errorCode(error)
        refusals.push({ stage, code, message: errorMessage(error) })
        addNotMeasuredRow(
          `brief ${stage} payload code points`,
          `REFUSED ${code}`,
          `<= ${BUDGET.briefPoints.toLocaleString('en-US')}`,
        )
        console.log(`REFUSED ${stage} (${code}): ${errorMessage(error)}`)
      } else {
        measurementFailures.push(`brief ${stage}: ${describeError(error)}`)
        addBudgetRow(`brief ${stage} payload code points`, 'ERROR', `<= ${BUDGET.briefPoints}`, false)
      }
    }
  }

  if (briefResults.size === briefStages.length) {
    let totalPoints = 0
    let totalBytes = 0
    for (const result of briefResults.values()) {
      totalPoints += result.points
      totalBytes += result.bytes
    }
    addBudgetRow(
      'brief total (7 stages, payload code points)',
      `${totalPoints.toLocaleString('en-US')} (${formatBytes(totalBytes)})`,
      `<= ${BUDGET.briefTotalPoints.toLocaleString('en-US')}`,
      totalPoints <= BUDGET.briefTotalPoints,
    )
  } else {
    addNotMeasuredRow(
      'brief total (7 stages, payload code points)',
      `${briefResults.size}/${briefStages.length} stages measured`,
      `<= ${BUDGET.briefTotalPoints.toLocaleString('en-US')}`,
    )
  }

  const bundle = await timed(() => engine.panelBundle({ root, lean: true }))
    .then((result) => result)
    .catch((error) => {
      measurementFailures.push(`panelBundle: ${describeError(error)}`)
      return null
    })
  if (bundle === null) {
    addBudgetRow(
      'panel overview payload (panelBundle lean)',
      'ERROR',
      `<= ${formatBytes(BUDGET.panelPayloadBytes)}`,
      false,
    )
  } else {
    const bundleBytes = Buffer.byteLength(JSON.stringify(bundle.value), 'utf8')
    addBudgetRow(
      'panel overview payload (panelBundle lean)',
      formatBytes(bundleBytes),
      `<= ${formatBytes(BUDGET.panelPayloadBytes)}`,
      bundleBytes <= BUDGET.panelPayloadBytes,
    )
    const overview = panelResults.get('overview')
    if (overview !== null && overview !== undefined) {
      const overviewBytes = Buffer.byteLength(JSON.stringify(overview.coldValue), 'utf8')
      addInfoRow('panelSection overview payload (info)', formatBytes(overviewBytes))
    }
  }

  if (!BRIEFS_ONLY) {
    const doctorSeries = await measureWarm('doctor', () => engine.doctor({ root }), doctorCold.ms)
    addInfoRow(
      'doctor (p95, info only)',
      doctorSeries === null
        ? 'ERROR'
        : `p95 ${formatMs(doctorSeries.p95)} - cold ${formatMs(doctorSeries.coldMs)}`,
    )
  }

  try {
    const query = await timed(() => engine.queryState({ kind: 'chapters', root }))
    const returned = query.value?.data?.chapters?.length ?? 0
    addInfoRow('queryState chapters (info only)', `${formatMs(query.ms)} - ${returned} row(s) returned`)
  } catch (error) {
    addInfoRow('queryState chapters (info only)', `ERROR ${errorCode(error)}`)
  }

  addInfoRow('fixture build time (info only)', formatMs(buildMs))

  console.log(row('metric'.padEnd(46), 'measured'.padEnd(56), 'budget'.padEnd(16), 'verdict'))
  console.log(row('-'.repeat(46), '-'.repeat(56), '-'.repeat(16), '-'.repeat(7)))
  for (const line of tableRows) console.log(line)
  console.log('')
  if (refusals.length === 0) {
    console.log('unmeasured brief stages: none')
  } else {
    console.log(
      `unmeasured brief stages: ${refusals
        .map((entry) => `${entry.stage} (REFUSED ${entry.code})`)
        .join(', ')}`,
    )
  }
  if (measurementFailures.length === 0) {
    console.log('measurement failures: none')
  } else {
    console.log(`measurement failures: ${measurementFailures.join(' | ')}`)
  }
  const passed = failures.length === 0 && measurementFailures.length === 0
  console.log(`SCALE RESULT: ${passed ? 'PASS' : 'FAIL'}`)
  exitCode = passed ? 0 : 1
  if (KEEP) console.log(`kept fixture at ${root} and state dir at ${stateDir}`)
} catch (error) {
  if (error instanceof SetupError) {
    console.error(`SCALE SETUP FAILED: ${error.message}`)
  } else {
    console.error(`SCALE SETUP FAILED: ${errorCode(error)}: ${errorMessage(error)}`)
  }
  exitCode = 2
} finally {
  if (engine !== null) {
    try {
      await engine.dispose()
    } catch (error) {
      console.error(`dispose failed: ${errorCode(error)}: ${errorMessage(error)}`)
      if (exitCode === 0) exitCode = 2
    }
  }
  if (!KEEP) {
    if (root !== null) await rm(root, { recursive: true, force: true }).catch(() => undefined)
    if (stateDir !== null) await rm(stateDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

process.exitCode = exitCode
