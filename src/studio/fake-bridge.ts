import type { AgentBridge, AgentStartRequest, AgentStartResult } from './agent-bridge.js'
import type { LoadedProject } from '../kernel/project/layout.js'
import type { ArtifactStore } from '../kernel/artifacts/store.js'
import type {
  ChapterPlan,
  ContinuityReport,
  Draft,
  PolishPatch,
  ReviewReport,
} from '../contracts/artifacts.js'
import { countWordMetrics } from '../domain/wordcount.js'
import { taskChapter } from './prompt.js'

const SENTENCES = [
  '雨停在午后，街面的水洼映着灰白的天。',
  '林砚把伞收在门边，抖落一层细小的水珠。',
  '铺子里的灯芯短了一截，火苗贴着铜盏边缘。',
  '掌柜低头拨算盘，珠子撞出短促的声响。',
  '门外有人踩过石阶，脚步在第三级停住。',
  '林砚没有回头，只把袖口往上挽了半寸。',
  '风从门缝里挤进来，带着潮湿的木头气味。',
  '桌上的茶已经凉了，杯沿留着一道浅浅的水痕。',
  '来人把一只旧木匣放在柜台上，没有开口。',
  '木匣的锁扣缺了一角，铜绿沿着裂缝爬开。',
  '林砚伸手按住匣盖，指腹碰到一道新划痕。',
  '掌柜抬眼看了看他，又把目光落回账本。',
  '街角传来车轮碾过碎石的声音，很快又远了。',
  '匣子里是一叠契纸，纸边被水浸得发皱。',
  '最上面那张写着城南的地址，墨迹已经发灰。',
  '林砚把契纸一张张摊开，按日期排好。',
  '窗外有孩子跑过，笑声撞在墙面上散开。',
  '他抽出最底下那张，发现落款被人刮去。',
  '掌柜的算盘停了，屋里只剩灯芯轻响。',
  '林砚把契纸折回原样，推回木匣里。',
  '来人终于坐下，椅腿在砖地上磨出一声。',
  '茶壶重新添了水，白汽沿着壶嘴升起来。',
  '林砚问他从哪来，他只说从北边。',
  '北边的路这个月不好走，雨把桥冲断了两座。',
  '掌柜把账本合上，手指在封皮上敲了两下。',
  '林砚记下地址，却没把木匣还回去。',
  '门外的天色暗了一层，街灯还没点。',
  '来人起身告辞，走到门口又回头看了一眼。',
  '林砚把木匣收进柜下，用一块旧布盖住。',
  '雨又落下来，先是几滴，随后连成一片。',
  '他坐在灯下，把今天的日期写在纸角。',
  '纸上留下一个墨点，慢慢洇开。',
  '掌柜问他打算怎么办，他说先去城南。',
  '城南的巷子窄，晚上没有灯，得趁天亮前到。',
  '林砚把刀从柜后取出来，擦掉鞘上的灰。',
  '刀锋不长，胜在轻，藏在袖里也不显眼。',
  '他试了试腕力，刀尖在灯影里停得平稳。',
  '掌柜把一包干粮推过来，没有多问。',
  '林砚收好干粮，吹灭桌上的灯。',
]

const openingFor = (plan: ChapterPlan): string => `${plan.hook}。`

const asSentence = (text: string): string =>
  /[。！？]$/u.test(text.trim()) ? text.trim() : `${text.trim()}。`

const makeContent = (plan: ChapterPlan): { content: string; sentences: string[] } => {
  const sentences: string[] = [
    openingFor(plan),
    asSentence(plan.goal),
    asSentence(plan.conflict),
    asSentence(plan.turn),
    asSentence(plan.outcome),
  ]
  for (const name of plan.cast) {
    if (!sentences.some((sentence) => sentence.includes(name))) sentences.push(`${name}也在场。`)
  }
  let total = sentences.reduce((sum, sentence) => sum + countWordMetrics(sentence).total_word_count, 0)
  let index = 0
  while (total < plan.target_words) {
    const sentence = SENTENCES[index % SENTENCES.length]!
    sentences.push(sentence)
    total += countWordMetrics(sentence).total_word_count
    index += 1
  }
  const paragraphs: string[] = []
  for (let start = 0; start < sentences.length; start += 4) {
    paragraphs.push(sentences.slice(start, start + 4).join(''))
  }
  return { content: paragraphs.join('\n\n'), sentences }
}

const draftFor = (
  plan: ChapterPlan,
  baseArtifactId: string | null = null,
  baseHash: string | null = null,
): Draft => {
  const { content, sentences } = makeContent(plan)
  const metrics = countWordMetrics(content)
  return {
    schema_version: 2,
    kind: 'Draft',
    chapter: plan.chapter,
    title: plan.title,
    scene_type: plan.scene_type,
    narrator: plan.pov,
    content,
    summary: {
      events: [`第 ${plan.chapter} 章：${plan.goal}`, plan.turn],
      characters_appeared: plan.cast,
      foreshadows: { planted: [], advanced: [], resolved: [] },
      new_elements: { locations: [], abilities: [], artifacts: [] },
      resource_changes: [],
      opening: sentences[0]!,
      continuity: { opens_from: '上一章结尾', ends_with: sentences[sentences.length - 1]! },
      hook_strength: 4,
      pleasure_points: [plan.turn],
      plot_advancement: 'mid',
    },
    self_check: {
      word_count: metrics.total_word_count,
      cjk_chars: metrics.cjk_chars,
      scene_contract: {
        goal: plan.goal,
        conflict: plan.conflict,
        turn: plan.turn,
        outcome: plan.outcome,
      },
    },
    citations: [],
    open_questions: [],
    base_artifact_id: baseArtifactId,
    expected_hash: baseHash,
  }
}

const reviewFor = (role: ReviewReport['role'], draft: Draft, baseHash: string): ReviewReport => {
  const sentences = draft.content.match(/[^。！？]+[。！？]?/gu) ?? [draft.content]
  const opening = sentences[0]!
  const middle = sentences[Math.floor(sentences.length / 2)]!
  const ending = sentences[sentences.length - 1]!
  const dimensions: ReviewReport['dimensions'] =
    role === 'critic-story'
      ? [
          { id: 'R-W-04', max: 20, deductions: [] },
          { id: 'R-W-05', max: 15, deductions: [] },
          { id: 'R-W-12', max: 20, deductions: [] },
        ]
      : role === 'critic-character'
        ? [
            { id: 'R-W-01', max: 15, deductions: [] },
            { id: 'R-W-02', max: 10, deductions: [] },
            { id: 'R-W-03', max: 10, deductions: [] },
          ]
        : [
            { id: 'R-W-06', max: 4, deductions: [] },
            { id: 'R-W-07', max: 4, deductions: [] },
            { id: 'R-W-08', max: 4, deductions: [] },
            { id: 'R-W-09', max: 2, deductions: [] },
            { id: 'R-W-10', max: 1, deductions: [] },
            { id: 'R-W-11', max: 10, deductions: [] },
            { id: 'R-W-13', max: 15, deductions: [] },
            { id: 'R-W-14', max: 10, deductions: [] },
            { id: 'R-W-15', max: 10, deductions: [] },
          ]
  const ownMax = dimensions.reduce((total, dimension) => total + dimension.max, 0)
  return {
    schema_version: 2,
    kind: 'ReviewReport',
    chapter: draft.chapter,
    role,
    base_hash: baseHash,
    findings: [],
    dimensions,
    total: ownMax,
    proof: {
      opening: { sourcePath: 'draft', sourceHash: baseHash, quote: opening, location: '第 1 段' },
      middle: { sourcePath: 'draft', sourceHash: baseHash, quote: middle, location: '中段' },
      ending: { sourcePath: 'draft', sourceHash: baseHash, quote: ending, location: '结尾' },
    },
    confidence: 1,
    open_questions: [],
  }
}

const continuityFor = (chapter: number, baseHash: string): ContinuityReport => ({
  schema_version: 2,
  kind: 'ContinuityReport',
  chapter,
  base_hash: baseHash,
  findings: [],
  canon_conflicts: [],
  confidence: 1,
  citations: [],
  open_questions: [],
})

const polishFor = (draft: Draft, baseHash: string): PolishPatch => {
  const sentences = draft.content.match(/[^。！？]+[。！？]?/gu) ?? [draft.content]
  const before = sentences[0]!
  return {
    schema_version: 2,
    kind: 'PolishPatch',
    chapter: draft.chapter,
    base_hash: baseHash,
    expected_hash: baseHash,
    patches: [
      { anchor: before, before, after: before.replace(/。$/u, '') + '，风从巷口吹来。', reason: '收紧开头' },
    ],
    open_questions: [],
  }
}

/** Deterministic bridge used by tests and `novel run --dry-run`. */
export class FakeAgentBridge implements AgentBridge {
  readonly name = 'fake'
  readonly project: LoadedProject
  readonly artifacts: ArtifactStore

  constructor(project: LoadedProject, artifacts: ArtifactStore) {
    this.project = project
    this.artifacts = artifacts
  }

  available(): boolean {
    return true
  }

  async start(request: AgentStartRequest): Promise<AgentStartResult> {
    const chapter = taskChapter(request.task)
    const role = request.role.id
    const planArtifact = await this.artifacts.latest('ChapterPlan', chapter)
    const draftArtifact = await this.artifacts.latest('Draft', chapter)
    const baseHash = draftArtifact?.contentHash ?? 'no-draft'
    const plan = planArtifact?.content as ChapterPlan | undefined
    let structured: unknown
    if (role === 'planner') {
      structured = {
        schema_version: 2,
        kind: 'ChapterPlan',
        chapter,
        title: `第${chapter}章 风起云涌`,
        scene_type: '日常过渡章',
        pov: '第三人称',
        cast: ['林砚', '掌柜'],
        goal: '查清木匣契纸的来历',
        conflict: '来人只说从北边来，不肯交底',
        turn: '契纸落款被人刮去',
        outcome: '林砚决定天亮前去城南',
        target_words: 2400,
        hook: '门外传来三声敲击',
        foreshadows: [],
        notes: [],
        citations: [],
        open_questions: [],
      } satisfies ChapterPlan
    } else if (role === 'drafter') {
      const effectivePlan: ChapterPlan =
        plan ??
        ({
          schema_version: 2,
          kind: 'ChapterPlan',
          chapter,
          title: `第${chapter}章 风起云涌`,
          scene_type: '日常过渡章',
          pov: '第三人称',
          cast: ['林砚'],
          goal: '查清木匣契纸的来历',
          conflict: '来人只说从北边来',
          turn: '契纸落款被人刮去',
          outcome: '林砚决定天亮前去城南',
          target_words: 2400,
          hook: '门外传来三声敲击',
          foreshadows: [],
          notes: [],
          citations: [],
          open_questions: [],
        } satisfies ChapterPlan)
      structured = draftFor(effectivePlan, draftArtifact?.id ?? null, draftArtifact?.contentHash ?? null)
    } else if (role === 'critic-story' || role === 'critic-character' || role === 'critic-prose') {
      const draft =
        (draftArtifact?.content as Draft | undefined) ??
        draftFor(
          plan ??
            ({
              schema_version: 2,
              kind: 'ChapterPlan',
              chapter,
              title: `第${chapter}章 风起云涌`,
              scene_type: '日常过渡章',
              pov: '第三人称',
              cast: ['林砚'],
              goal: '查清木匣契纸的来历',
              conflict: '来人只说从北边来',
              turn: '契纸落款被人刮去',
              outcome: '林砚决定天亮前去城南',
              target_words: 2400,
              hook: '门外传来三声敲击',
              foreshadows: [],
              notes: [],
              citations: [],
              open_questions: [],
            } satisfies ChapterPlan),
        )
      structured = reviewFor(role, draft, baseHash)
    } else if (role === 'continuity') {
      structured = continuityFor(chapter, baseHash)
    } else if (role === 'polisher') {
      const draft = draftArtifact?.content as Draft | undefined
      structured = draft === undefined ? null : polishFor(draft, baseHash)
    } else if (role === 'archivist') {
      structured = {
        schema_version: 2,
        kind: 'StateDelta',
        chapter,
        entities: [],
        relationships: [],
        timeline: [],
        foreshadows: [],
        resources: [],
        handoff: {},
      }
    } else if (role === 'architect') {
      structured =
        request.task.kind === 'bible'
          ? {
              schema_version: 2,
              kind: 'BiblePlan',
              premise: '一个替人查账的年轻人，在城南旧铺里发现一叠被水浸过的契纸。',
              themes: ['选择与代价'],
              style: { guide: '短句，动作优先，不解释情绪。', fingerprint: { average_sentence_length: 14 } },
              world: {
                rules: ['契纸必须有落款'],
                factions: [],
                locations: ['城南旧铺'],
                glossary: { 契纸: '盖印的凭据' },
              },
              characters: [
                {
                  slug: 'lin-yan',
                  name: '林砚',
                  role: '主角',
                  profile: {},
                  voice: { signature_phrases: [], register: '克制' },
                },
              ],
              citations: [],
              open_questions: [],
            }
          : {
              schema_version: 2,
              kind: 'OutlinePlan',
              logline: '一叠契纸牵出城南旧案。',
              acts: [{ id: 'act-1', title: '第一幕', summary: '木匣出现' }],
              volumes: [{ id: 'v1', title: '第一卷', start_chapter: 1, end_chapter: 3, arc: '追查契纸' }],
              chapters: [
                {
                  chapter: 1,
                  title: '第1章 风起',
                  summary: '木匣送到铺子',
                  scene_type: '日常过渡章',
                  hook: '门外传来三声敲击',
                },
                {
                  chapter: 2,
                  title: '第2章 城南',
                  summary: '林砚去城南',
                  scene_type: '日常过渡章',
                  hook: '巷口没有灯',
                },
                {
                  chapter: 3,
                  title: '第3章 落款',
                  summary: '落款被刮去',
                  scene_type: '情感爆发章',
                  hook: '纸背还有一个名字',
                },
              ],
              citations: [],
              open_questions: [],
            }
    } else if (role === 'worldsmith') {
      structured = {
        schema_version: 2,
        kind: 'WorldbookPatch',
        entities: [],
        citations: [],
        open_questions: [],
      }
    } else if (role === 'radar') {
      structured = {
        schema_version: 2,
        kind: 'MarketBrief',
        platform: this.project.config.platform,
        trends: [{ label: '短剧感', evidence: '平台榜单摘要', confidence: 0.6 }],
        competitors: [],
        recommendations: ['前三章加快冲突'],
        sources: [],
      }
    } else {
      throw new Error(`fake bridge has no fixture for ${role}`)
    }
    return {
      structured,
      outputText: '',
      usage: { promptTokens: 100, completionTokens: 100, costUsd: 0 },
      stopReason: 'completed',
      agentSessionId: `fake-${request.task.id}`,
      childId: `fake-${request.task.id}`,
      dispose: async () => undefined,
    }
  }
}
