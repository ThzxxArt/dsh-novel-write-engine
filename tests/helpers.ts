import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { EngineService } from '../src/engine/service.js'
import type { EngineConfig } from '../src/engine/state.js'
import { loadRulepack } from '../src/rulepack.js'
import { SEMANTIC_CHECK_IDS } from '../src/engine/semantic.js'
import type {
  ChapterSummary,
  ReviewDocument,
  SceneType,
  ScoreDimension,
  SemanticItem,
  StateDelta,
} from '../src/types.js'

export const FIXED_NOW = (): Date => new Date('2026-10-26T10:00:00.000Z')

export const TEST_CONFIG: EngineConfig = {
  projectRoot: '.',
  stateDir: '',
  tools: { mode: 'all' },
  quality: { minScore: 120 },
  briefs: { overrides: '' },
  storage: { backupRetention: 5 },
}

export interface Harness {
  root: string
  engine: EngineService
  cleanup: () => Promise<void>
}

/** A fresh project root per test; the engine is wired exactly like the plugin. */
export async function harness(config: Partial<EngineConfig> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'novel-engine-'))
  const defaultStateDir = await mkdtemp(join(tmpdir(), 'novel-state-'))
  const stateDir = config.stateDir ?? defaultStateDir
  const engine = new EngineService(
    { ...TEST_CONFIG, projectRoot: root, stateDir, ...config },
    () => loadRulepack(),
    { now: FIXED_NOW },
  )
  return {
    root,
    engine,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true })
      await rm(config.stateDir ?? defaultStateDir, { recursive: true, force: true })
    },
  }
}

/** A clean paragraph set: no markdown, no curly quotes, no semicolons, no long paragraphs. */
export function cleanText(paragraphs = 5): string {
  const lines = [
    '风从窗缝里挤进来，把桌上的纸吹得翻了一页。他伸手压住，指腹沾了一点灰。',
    '走廊尽头传来脚步声，不快不慢，在门口停了两秒。他没有抬头，只把笔帽扣紧。',
    '门被推开时带进一股凉气，来人把一只旧信封放在桌角，指尖敲了两下。',
    '信封没有署名，封口处压着一枚暗红的蜡印，边缘已经磨得发白。',
    '他盯着那枚蜡印看了很久，最后把信封翻过去，背面写着一行很小的字。',
    '窗外天色暗下来，楼下的路灯一盏接一盏亮起，照见窗台上薄薄一层灰。',
  ]
  return lines.slice(0, paragraphs).join('\n\n')
}

/** The ten PG-05 fields. */
export function sampleSummary(patch: Partial<ChapterSummary> = {}): ChapterSummary {
  return {
    events: ['收到无名信封'],
    characters_appeared: ['他'],
    foreshadows: { planted: [], advanced: [], resolved: [] },
    new_elements: { locations: [], abilities: [], artifacts: [] },
    resource_changes: [],
    opening: '风从窗缝里挤进来，把桌上',
    continuity: { opens_from: '上一章结尾', ends_with: '信封' },
    hook_strength: 4,
    pleasure_points: ['新线索'],
    plot_advancement: 'mid',
    ...patch,
  }
}

/** A review whose arithmetic closes: 150 minus a single 5-point deduction. */
export function sampleReview(
  _chapter: number,
  text: string,
  options: { total?: number; deductions?: number; issues?: ReviewDocument['issues'] } = {},
): {
  dimensions: ScoreDimension[]
  issues: ReviewDocument['issues']
  total: number
  proof: {
    opening: { paragraph: number; quote: string }
    middle: { paragraph: number; quote: string }
    ending: { paragraph: number; quote: string }
  }
} {
  const paragraphs = text.split(/\n+/).filter((line) => line.trim() !== '')
  const ids: Array<[string, number]> = [
    ['R-W-01', 15],
    ['R-W-02', 10],
    ['R-W-03', 10],
    ['R-W-04', 20],
    ['R-W-05', 15],
    ['R-W-12', 20],
    ['R-W-11', 10],
    ['R-W-13', 15],
    ['R-W-14', 10],
    ['R-W-15', 10],
    ['R-W-06', 4],
    ['R-W-07', 4],
    ['R-W-08', 4],
    ['R-W-09', 2],
    ['R-W-10', 1],
  ]
  const deduction = options.deductions ?? 5
  const dimensions: ScoreDimension[] = ids.map(([id, max], index) => ({
    id,
    max,
    deductions:
      index === 0 && deduction > 0
        ? [{ rule: 'NO_MOTIVE', location: '第 2 段', delta: deduction, note: '动作缺少动机' }]
        : [],
  }))
  const middleIndex = Math.max(1, Math.min(paragraphs.length - 2, Math.floor((paragraphs.length - 1) / 2)))
  const proof = {
    opening: { paragraph: 1, quote: paragraphs[0]!.slice(0, 14) },
    middle: { paragraph: middleIndex + 1, quote: paragraphs[middleIndex]!.slice(0, 14) },
    ending: { paragraph: paragraphs.length, quote: paragraphs[paragraphs.length - 1]!.slice(0, 14) },
  }
  return { dimensions, issues: options.issues ?? [], total: 150 - deduction, proof }
}

/** Recursively hash every file under a directory, for zero-write assertions. */
export async function snapshotTree(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const key = relative(root, absolute).replace(/\\/g, '/')
      // Refused operations now append an aborted attempt to the journal as
      // evidence. Content-state tests use this tree to prove no manuscript,
      // plan, ledger or pipeline byte moved; the audit trail is checked
      // separately by the attempt tests.
      if (key === 'state/journal.jsonl') continue
      if (entry.isDirectory()) {
        result.set(`${key}/`, 'directory')
        await walk(absolute)
        continue
      }
      const content = await readFile(absolute)
      const metadata = await stat(absolute)
      result.set(
        key,
        `${metadata.mtimeMs}:${content.byteLength}:${createHash('sha256').update(content).digest('hex')}`,
      )
    }
  }
  await walk(root)
  return result
}

/** Run init → world plan → chapter plan, leaving the project at P3. */
export async function bootstrapToDraft(input: {
  root: string
  engine: EngineService
  title?: string
  scene?: SceneType
}): Promise<void> {
  const root = input.root
  await input.engine.initProject({
    title: '测试之书',
    genre: '都市现代',
    platform: 'fanqie',
    root,
    words_per_chapter: [80, 400],
  })
  await input.engine.getBrief({ stage: 'P1', root })
  await input.engine.submitWorldPlan({
    chapter: 0,
    objective: '让主角收到一封无名信',
    constraints: ['没有超能力'],
    characters: [],
    locations: [],
    continuity_notes: [],
    root,
  })
  await input.engine.getBrief({ stage: 'P2', root })
  await input.engine.submitChapterPlan({
    chapter: 0,
    title: '开端之雨',
    scene_type: input.scene ?? '日常过渡章',
    narrator: '他',
    beats: ['风起', '信到', '拆封', '读信', '决定'],
    opening: '风从窗缝里挤进来',
    ending: '蜡印',
    target_words: [80, 400],
    root,
  })
}

/** Draft the clean text at P3. */
export async function writeDraft(input: {
  root: string
  engine: EngineService
  text?: string
  summary?: ChapterSummary
}): Promise<void> {
  await input.engine.getBrief({ stage: 'P3', root: input.root })
  await input.engine.submitDraft({
    chapter: 1,
    content: input.text ?? cleanText(),
    chapter_title: '开端之雨',
    scene_type: '日常过渡章',
    narrator: '他',
    summary: input.summary ?? sampleSummary(),
    root: input.root,
  })
}

/** Five disjoint 8-character quotes from five different sentences. */
export function semanticQuotes(text: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const sentences = text.match(/[^。！？!?]+[。！？!?]?/g) ?? []
  for (const sentence of sentences) {
    const chars = Array.from(sentence.trim())
    if (chars.length < 8) continue
    const quote = chars.slice(0, 8).join('')
    if (seen.has(quote)) continue
    seen.add(quote)
    found.push(quote)
    if (found.length === 5) break
  }
  if (found.length < 5) {
    throw new Error(`sampleSemantic needs five distinct sentence quotes, found ${found.length}`)
  }
  return found
}

/** The five P6 semantic items, all passing against distinct quotes from the text. */
export function sampleSemantic(
  text: string,
  patch: Partial<Record<(typeof SEMANTIC_CHECK_IDS)[number], Partial<SemanticItem>>> = {},
): SemanticItem[] {
  const quotes = semanticQuotes(text)
  return SEMANTIC_CHECK_IDS.map((id, index) => ({
    id,
    verdict: 'pass',
    evidence: quotes[index]!,
    note: '已核对',
    ...(patch[id] ?? {}),
  }))
}

/** Take chapter one all the way to `ready_to_archive`. */
export async function readyToArchive(input: {
  root: string
  engine: EngineService
  text?: string
  summary?: ChapterSummary
}): Promise<string> {
  const text = input.text ?? cleanText()
  await bootstrapToDraft(input)
  await writeDraft({ ...input, text, summary: input.summary })
  await input.engine.getBrief({ stage: 'P4', root: input.root })
  await input.engine.submitReview({ chapter: 1, ...sampleReview(1, text), root: input.root })
  await input.engine.getBrief({ stage: 'P6', root: input.root })
  await input.engine.runCheck({ chapter: 1, semantic: sampleSemantic(text), root: input.root })
  await input.engine.getBrief({ stage: 'P8', root: input.root })
  return text
}

/** Read a project file as text, or null. */
export async function readProjectFile(root: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(root, path), 'utf8')
  } catch {
    return null
  }
}

/**
 * Test-only reconciliation sheet for the default summaries. `existing` lists
 * characters already in the ledger; everything else is declared created.
 */
export function archiveDelta(summary: ChapterSummary, options: { existing?: string[] } = {}): StateDelta {
  const existing = new Set(options.existing ?? [])
  const characters: StateDelta['characters'] = {}
  for (const name of summary.characters_appeared) {
    characters[name] = existing.has(name)
      ? { action: 'no_change', reason: 'already present before this chapter' }
      : { action: 'created', role: name === '他' ? 'protagonist' : 'supporting' }
  }
  const world: StateDelta['world'] = {}
  for (const name of summary.new_elements.locations) {
    world[name] = { action: 'created', kind: 'location', description: name, layout: '', capacity: 0 }
  }
  for (const name of summary.new_elements.abilities) {
    world[name] = { action: 'created', kind: 'ability', description: name }
  }
  for (const name of summary.new_elements.artifacts) {
    world[name] = { action: 'created', kind: 'artifact', description: name }
  }
  const foreshadows: StateDelta['foreshadows'] = {}
  for (const plant of summary.foreshadows.planted) {
    foreshadows[plant.key] = {
      action: 'created',
      title: plant.title,
      description: plant.description,
    }
  }
  for (const advance of summary.foreshadows.advanced) {
    foreshadows[advance.key] = {
      action: 'updated',
      note: advance.note,
      new_info: advance.new_info,
    }
  }
  for (const key of summary.foreshadows.resolved) {
    foreshadows[key] = { action: 'updated' }
  }
  const timeline: StateDelta['timeline'] = {}
  for (const [index, event] of summary.events.entries()) {
    timeline[String(index)] = { action: 'created', description: event }
  }
  return { characters, world, foreshadows, timeline, relationships: {} }
}
