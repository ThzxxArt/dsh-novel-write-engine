import { sha256Hex } from '../../domain/hash.js'
import type { StudioDb } from '../../storage/db.js'
import { searchMemory } from '../../storage/repositories/memory.js'
import { listComments } from '../../storage/repositories/artifacts.js'
import type { LoadedProject } from '../project/layout.js'
import { loadBible, loadCanon, loadChapterPlan } from '../book/store.js'
import type { ChapterPlan } from '../../contracts/artifacts.js'
import type { Canon } from '../../contracts/project.js'

export type ContextKind = 'canon' | 'summary' | 'chapter' | 'review' | 'style' | 'market'

export interface ContextItem {
  id: string
  kind: ContextKind
  sourcePath: string
  sourceHash: string
  text: string
  score: number
  reason: string[]
  protected: boolean
  tokens: number
}

export interface ContextPack {
  chapter: number
  stage: string
  query: string
  budgetTokens: number
  usedTokens: number
  items: ContextItem[]
  omitted: number
}

const STAGE_BUDGET: Record<string, number> = {
  plan: 12_000,
  draft: 20_000,
  review: 16_000,
  continuity: 24_000,
  polish: 16_000,
}

const digest = (text: string): string => `sha256:${sha256Hex(text)}`

const approxTokens = (text: string): number => Math.max(1, Math.ceil(Array.from(text).length / 1.5))
const item = (input: Omit<ContextItem, 'id' | 'tokens'>): ContextItem => ({
  ...input,
  id: sha256Hex(`${input.sourcePath}:${input.sourceHash}`).slice(0, 16),
  tokens: approxTokens(input.text),
})

export interface BuildContextInput {
  chapter: number
  stage: string
  role: string
  query?: string
  activeCast?: string[]
  budgetTokens?: number
}

/**
 * Deterministic context pack. Protected facts always go first; the remaining
 * budget is filled by FTS5 score plus entity/recency/foreshadow boosts. Every
 * item carries its source path, hash, score and reason list.
 */
export async function buildContextPack(
  project: LoadedProject,
  db: StudioDb,
  input: BuildContextInput,
): Promise<ContextPack> {
  const [plan, bible, canon] = await Promise.all([
    loadChapterPlan(project.store, input.chapter),
    loadBible(project.store),
    loadCanon(project.store),
  ])
  const query = input.query ?? [plan?.title, plan?.goal, plan?.hook].filter(Boolean).join(' ')
  const budgetTokens = input.budgetTokens ?? STAGE_BUDGET[input.stage] ?? 16_000
  const protectedItems: ContextItem[] = []
  const push = (kind: ContextKind, sourcePath: string, text: string, reason: string[]): void => {
    if (text.trim() === '') return
    const trimmed = text.length > 20_000 ? `${text.slice(0, 20_000)}\n…` : text
    protectedItems.push(
      item({
        kind,
        sourcePath,
        sourceHash: digest(trimmed),
        text: trimmed,
        score: 100,
        reason,
        protected: true,
      }),
    )
  }
  if (plan !== null)
    push(
      'summary',
      `outline/chapters/ch-${String(input.chapter).padStart(4, '0')}.yaml`,
      JSON.stringify(plan, null, 2),
      ['current-plan'],
    )
  if (bible.premise !== '') push('style', 'bible/premise.md', bible.premise, ['premise'])
  if (bible.styleGuide !== '') push('style', 'bible/style/guide.md', bible.styleGuide, ['style-guide'])
  if (bible.world.rules.length > 0)
    push('canon', 'bible/world/rules.yaml', bible.world.rules.join('\n'), ['world-rules'])
  const activeCast = new Set(input.activeCast ?? plan?.cast ?? [])
  const openForeshadows = canon.foreshadows.filter((row) => row.status !== 'resolved')
  if (activeCast.size > 0) {
    const castFacts = canon.entities.characters.filter((row) =>
      activeCast.has(String(row.key ?? row.name ?? '')),
    )
    if (castFacts.length > 0)
      push('canon', 'state/canon.yaml#characters', JSON.stringify(castFacts, null, 2), ['active-cast'])
  }
  if (openForeshadows.length > 0)
    push('canon', 'state/canon.yaml#foreshadows', JSON.stringify(openForeshadows, null, 2), [
      'open-foreshadows',
    ])

  const searchResults =
    query.trim() === ''
      ? []
      : searchMemory(db.orm, {
          projectId: project.config.id,
          query,
          chapter: input.chapter,
          limit: 30,
          activeCast: [...activeCast],
        })
  const candidates: ContextItem[] = []
  const comments = listComments(db.orm, project.config.id, input.chapter).filter(
    (row) => row.status === 'open' && row.body.trim() !== '',
  )
  if (comments.length > 0) {
    const text = comments
      .map((row) => `第 ${row.paragraph ?? '—'} 段 · ${row.author}：${row.body}`)
      .join('\n')
    candidates.push(
      item({
        kind: 'summary',
        sourcePath: `comments/ch-${String(input.chapter).padStart(4, '0')}.md`,
        sourceHash: digest(text),
        text,
        score: 50,
        reason: ['author-comments'],
        protected: false,
      }),
    )
  }
  for (const hit of searchResults) {
    candidates.push(
      item({
        kind: hit.kind === 'canon' ? 'canon' : hit.kind === 'review' ? 'review' : 'summary',
        sourcePath: hit.sourcePath,
        sourceHash: hit.sourceHash.startsWith('sha256:') ? hit.sourceHash : digest(hit.text),
        text: hit.text,
        score: hit.score,
        reason: hit.reasons,
        protected: false,
      }),
    )
  }
  // Recent archived chapters are always useful even when FTS has no hit.
  for (let offset = 1; offset <= 3 && input.chapter - offset >= 1; offset += 1) {
    const sourcePath = `manuscript/ch-${String(input.chapter - offset).padStart(4, '0')}.md`
    const text = await project.store.readText(sourcePath)
    if (text === null) continue
    candidates.push(
      item({
        kind: 'chapter',
        sourcePath,
        sourceHash: digest(text),
        text: text.length > 4_000 ? `${text.slice(0, 4_000)}\n…` : text,
        score: 2 / offset,
        reason: [`recent:${offset}`],
        protected: false,
      }),
    )
  }

  const seen = new Set<string>()
  const items: ContextItem[] = []
  let usedTokens = 0
  // Protected facts are never displaced by a lower-priority search hit. If they
  // alone exceed the stage budget the pack reports the overflow honestly so the
  // caller can see why the prompt is larger than requested.
  for (const row of protectedItems) {
    if (seen.has(row.sourcePath)) continue
    seen.add(row.sourcePath)
    items.push(row)
    usedTokens += row.tokens
  }
  for (const row of candidates.sort((left, right) => right.score - left.score)) {
    if (seen.has(row.sourcePath)) continue
    if (usedTokens + row.tokens > budgetTokens) continue
    seen.add(row.sourcePath)
    items.push(row)
    usedTokens += row.tokens
  }
  const totalCandidates = new Set([...protectedItems, ...candidates].map((row) => row.sourcePath)).size
  return {
    chapter: input.chapter,
    stage: input.stage,
    query,
    budgetTokens,
    usedTokens,
    items,
    omitted: Math.max(0, totalCandidates - items.length),
  }
}

/** The compact prompt section shown to the role; full pack is stored as JSON. */
export function contextPromptSection(pack: ContextPack): string {
  if (pack.items.length === 0) return '上下文：无可用条目'
  return [
    `上下文包（${pack.usedTokens}/${pack.budgetTokens} tokens，省略 ${pack.omitted} 条）：`,
    ...pack.items.map(
      (row) =>
        `- [${row.kind}${row.protected ? '/protected' : ''}] ${row.sourcePath} (${row.reason.join(', ')})\n${row.text}`,
    ),
  ].join('\n\n')
}

export type { ChapterPlan, Canon }
