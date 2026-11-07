import { stableJson } from '../domain/stable.js'
import { sha256Hex } from '../domain/hash.js'
import type { TaskRow } from '../storage/repositories/runs.js'
import type { LoadedProject } from '../kernel/project/layout.js'
import type { BibleSnapshot } from '../kernel/book/store.js'
import type { Canon } from '../contracts/project.js'
import type { ArtifactKind, Draft, ReviewReport } from '../contracts/artifacts.js'
import type { StoredArtifact } from '../kernel/artifacts/store.js'
import { contextPromptSection, type ContextPack } from '../kernel/read/context.js'
import { applyTaxonomyProfile, CRITIC_DIMENSIONS } from '../kernel/gates/index.js'
import { SCORE_DIMENSIONS } from '../domain/scoring.js'
import { splitSentenceSpans } from '../domain/text.js'
import { loadRulepack } from '../rulepack.js'
import { AI_TONE_RULES } from '../codes.js'
import { taskContract } from './task-contract.js'

const clip = (value: string, max = 4000): string =>
  value.length <= max ? value : `${value.slice(0, max)}\n…（已截断）`

export interface PromptInput {
  project: LoadedProject
  task: TaskRow
  bible: BibleSnapshot
  canon: Canon
  artifacts: {
    draft?: StoredArtifact | null
    plan?: StoredArtifact | null
    reviews?: StoredArtifact[]
    continuity?: StoredArtifact | null
  }
  previousChapters: Array<{ chapter: number; title: string; text: string }>
  contextPack?: ContextPack
}

const chapterOf = (task: TaskRow): number => {
  try {
    const parsed = JSON.parse(task.inputJson) as { chapter?: unknown }
    return typeof parsed.chapter === 'number' ? parsed.chapter : 1
  } catch {
    return 1
  }
}

const roundOf = (task: TaskRow): number => {
  try {
    const parsed = JSON.parse(task.inputJson) as { round?: unknown }
    return typeof parsed.round === 'number' ? parsed.round : 1
  } catch {
    return 1
  }
}

const asDraft = (artifact: StoredArtifact | null | undefined): Draft | null =>
  artifact !== null && artifact !== undefined && artifact.kind === 'Draft'
    ? (artifact.content as Draft)
    : null

const asReview = (artifact: StoredArtifact): ReviewReport => artifact.content as ReviewReport

/** Quotes the model is allowed to cite; gate PG-09 rejects invented evidence. */
const quoteCandidates = (text: string, max = 18): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const span of splitSentenceSpans(text)) {
    const raw = span.text.trim()
    if (Array.from(raw).length < 8) continue
    const quote = Array.from(raw).slice(0, 40).join('')
    if (seen.has(quote)) continue
    seen.add(quote)
    out.push(quote)
    if (out.length >= max) break
  }
  return out
}

/**
 * The gate set is deterministic. A model that only sees the JSON schema has
 * no way to know about title/paragraph limits, role-owned dimensions, or the
 * ban on invented evidence; that produced avoidable review-round burn in live
 * runs. These lines are the human-readable mirror of the hard gates.
 */
const gateConstraints = (input: PromptInput, chapter: number): string[] => {
  const { project, task } = input
  // Prompt construction must also work for a partially loaded project (tests,
  // import preview). Fall back to the base pack rather than throwing here.
  let pack = loadRulepack()
  try {
    pack = applyTaxonomyProfile(project, pack)
  } catch {
    // Base pack is the safe floor.
  }
  const [minWords, maxWords] = project.config.targets.words_per_chapter
  const titleMin = pack.format.title.min_chars
  const titleMax = pack.format.title.max_chars
  const lines = [
    `标题硬约束：必须匹配 /${pack.format.title.pattern}/（「第N章 」前缀），标题正文 ${titleMin}–${titleMax} 个字符；Draft.title 必须与章卡 title 完全一致。`,
    `段落硬约束：每段最多 ${pack.format.paragraph_max_words} 个词（中文按字计），按句号/问号/感叹号拆段；正文禁用 Markdown 标记（#、**、---、>、|）、分号、英文省略号与系统标签；对白使用中文引号“”或「」，禁止 ASCII 直引号 " 和 '。`,
    `字数硬约束：${minWords}–${maxWords} 词，汉字至少 ${project.config.targets.min_cjk_chars}。`,
  ]
  if (task.kind === 'plan') {
    lines.push(
      '章卡要求：target_words 必须落在上面字数区间内；hook 会由 PG-13 检查是否逐字出现在正文，请写成可直接嵌入正文的一句。',
    )
  }
  if (task.kind === 'draft' || task.kind === 'revise') {
    lines.push(
      '正文要求：章卡 goal/conflict/turn/outcome 都要在正文有可识别的对应句；章卡 hook 必须逐字出现在正文中；章卡 cast 中的每个角色都必须在正文出场。',
      task.kind === 'revise'
        ? '修订要求：保留 title、hook 原句和已落地的四要素；只修复 blockers，不要重写整章；不得把未修复的 blocker 标成 fixed。'
        : '首次起草：title 直接使用章卡 title；self_check.word_count / cjk_chars 按实际正文填写（PG-03 会用正文重算）。',
    )
  }
  if (task.role.startsWith('critic-')) {
    const allowed = CRITIC_DIMENSIONS[task.role as ReviewReport['role']] ?? []
    const dimensions = allowed
      .map((id) => {
        const dimension = SCORE_DIMENSIONS.find((row) => row.id === id)
        return `${id}（满分 ${dimension?.max ?? 0}）`
      })
      .join('、')
    const full = allowed.reduce(
      (total, id) => total + (SCORE_DIMENSIONS.find((row) => row.id === id)?.max ?? 0),
      0,
    )
    lines.push(
      `维度所有权：你只能输出 ${dimensions}；每个 dimension.max 必须等于括号内满分；total 必须等于 ${full} 减去所有 deduction.delta 之和。缺少任一维度会被 PG-07 直接判失败。`,
      '扣分原则：只有能指出具体问题的维度才写 deduction；没有问题时 deductions 必须为空数组，不要为了显得严格而虚扣分。',
      '证据要求：findings[].evidence 和 proof.opening/middle/ending.quote 必须逐字复制下面的候选句或正文原句；proof.sourceHash 必须等于 base_hash；location 用「第N段」或「开头/中段/结尾」。',
    )
    if (task.role === 'critic-prose') {
      lines.push(
        `AI 味规则码：R-W-07 的每个 deduction.rule 必须是以下之一：${Object.values(AI_TONE_RULES).join('、')}。没有 AI 味问题时不要扣 R-W-07。`,
      )
    }
    const draft = asDraft(input.artifacts.draft)
    if (draft !== null) {
      const quotes = quoteCandidates(draft.content)
      if (quotes.length > 0) {
        lines.push(`可用引文（逐字选择，禁止改写）：\n${quotes.map((quote) => `- ${quote}`).join('\n')}`)
      }
    }
  }
  if (task.kind.startsWith('continuity')) {
    lines.push(
      'canon 冲突定义：canon_conflicts 只放与 canon、时间线、既有设定直接矛盾的事项；章卡执行不足/文风问题写入 findings（advisory），不要塞进 canon_conflicts。',
    )
  }
  if (task.kind === 'polish') {
    lines.push(
      'patch 要求：before 必须在当前正文中唯一且逐字出现，anchor 同上；after 不得为空；不得整段删除；base_hash 与 expected_hash 都等于当前 Draft base_hash。',
    )
  }
  if (task.kind === 'archive') {
    lines.push(
      '状态差量：每个 created/updated 必须带正文逐字 evidence（至少 8 字）；没有变化时写 no_change 并说明原因。',
    )
  }
  void chapter
  return lines
}

export function buildTaskPrompt(input: PromptInput): { prompt: string; promptHash: string } {
  const { project, task, bible, canon, artifacts } = input
  const chapter = chapterOf(task)
  const round = roundOf(task)
  const contract = taskContract(task.kind)
  const draft = asDraft(artifacts.draft)
  const plan = artifacts.plan?.content as Record<string, unknown> | undefined
  const reviews = (artifacts.reviews ?? []).map(asReview)
  const findings = reviews.flatMap((review) =>
    review.findings.map(
      (finding) => `${finding.severity} ${finding.location}: ${finding.problem} -> ${finding.fix}`,
    ),
  )
  const previous = input.previousChapters
    .slice(-3)
    .map((row) => `第 ${row.chapter} 章《${row.title}》\n${clip(row.text, 1200)}`)
    .join('\n\n')
  const sections = [
    `你是「网文工坊 · 创作室」的${task.role}。任务：${contract.instruction}`,
    `项目：《${project.config.title}》；类型：${project.config.genre.major}/${project.config.genre.sub}；标签：${project.config.genre.tags.join(', ')}`,
    `章节：第 ${chapter} 章；轮次：${round}/${project.config.quality.review_rounds}`,
    `Draft artifact_id：${artifacts.draft?.id ?? '（无草稿）'}；version：${artifacts.draft?.version ?? '（无草稿）'}；base_hash：${artifacts.draft?.contentHash ?? '（无草稿）'}。`,
    '回填规则：ReviewReport / ContinuityReport 的 base_hash 必须等于上面 base_hash；PolishPatch 的 base_hash/expected_hash 也必须等于它；revise/redraft 的 Draft.base_artifact_id 必须等于 artifact_id、expected_hash 必须等于 base_hash；首次 draft 两者为 null。禁止编造。',
    input.contextPack === undefined ? '' : contextPromptSection(input.contextPack),
    `目标字数：${project.config.targets.words_per_chapter[0]}–${project.config.targets.words_per_chapter[1]}；汉字下限：${project.config.targets.min_cjk_chars}`,
    `Story Bible：\n${clip(`${bible.premise}\n${bible.themes}\n${bible.styleGuide}`, 2400)}`,
    `世界规则：${bible.world.rules.join('；') || '（暂无）'}`,
    `角色：${
      bible.characters
        .map((character) => String(character.name ?? character.slug ?? ''))
        .filter(Boolean)
        .join('、') || '（暂无）'
    }`,
    `Canon：${clip(stableJson(canon), 3000)}`,
    plan === undefined ? '章卡：尚未生成' : `章卡：${clip(stableJson(plan), 3000)}`,
    draft === null ? '当前正文：尚未生成' : `当前正文：\n${clip(draft.content, 18_000)}`,
    findings.length === 0 ? '历史评审：无' : `历史评审：\n${findings.slice(0, 40).join('\n')}`,
    previous === '' ? '前情：无' : `前情：\n${previous}`,
    `写作室硬约束（违反任一条都会被确定性门控拒绝）：\n${gateConstraints(input, chapter)
      .map((line) => `- ${line}`)
      .join('\n')}`,
    '硬性要求：只输出结构化结果，不输出 Markdown 围栏或解释；所有判断必须有正文/设定证据；不能编造 canon；不能修改正文以外的文件。',
  ]
  const prompt = sections.join('\n\n')
  return { prompt, promptHash: sha256Hex(prompt) }
}

export function artifactKindOf(taskKind: string): ArtifactKind {
  return taskContract(taskKind).artifactKind
}

export function taskChapter(task: TaskRow): number {
  return chapterOf(task)
}

export function taskRound(task: TaskRow): number {
  return roundOf(task)
}
