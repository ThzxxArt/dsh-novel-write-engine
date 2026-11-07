import { z } from 'zod'
import { ARTIFACT_SCHEMAS, type ArtifactKind } from '../contracts/artifacts.js'
import type { RoleId } from '../contracts/artifacts.js'

export interface TaskContract {
  artifactKind: ArtifactKind
  schema: z.ZodType<unknown>
  instruction: string
}

const CONTRACTS: Record<string, { kind: ArtifactKind; instruction: string }> = {
  plan: {
    kind: 'ChapterPlan',
    instruction:
      '产出一张可执行的章卡：标题、场景类型、POV、cast、目标/冲突/转折/结果、目标字数、钩子、伏笔。',
  },
  draft: {
    kind: 'Draft',
    instruction: '按章卡写完整正文，并返回十字段摘要、自检、引文与开放问题。正文不得含 Markdown。',
  },
  revise: {
    kind: 'Draft',
    instruction: '按修订任务修复 blocker；保留已通过的部分，返回完整新正文与新的摘要/自检。',
  },
  'review.story': {
    kind: 'ReviewReport',
    instruction: '只评审结构、节奏、因果、爽点、钩子与商业性；每条 finding 必须引用正文 8 字以上原文。',
  },
  'review.character': {
    kind: 'ReviewReport',
    instruction: '只评审人物动机、声音、关系、成长与 POV；每条 finding 必须引用正文。',
  },
  'review.prose': {
    kind: 'ReviewReport',
    instruction: '只评审句式、描写、对话、去 AI 味与格式；发现 AI_TONE_* 时必须映射到 R-W-07 扣分。',
  },
  'continuity.precheck': {
    kind: 'ContinuityReport',
    instruction: '审计 canon、时间线、伏笔、资源、关系与空间；blocker 必须带正文证据。',
  },
  'continuity.final': { kind: 'ContinuityReport', instruction: '最终连续性审计；确认修订没有引入新冲突。' },
  polish: { kind: 'PolishPatch', instruction: '输出最小局部 patch；不得吞段、越界或修改 canon。' },
  archive: {
    kind: 'StateDelta',
    instruction: '从正文提取状态变化；每个 created/updated 必须带正文逐字证据；no_change 必须写原因。',
  },
  bible: {
    kind: 'BiblePlan',
    instruction: '产出完整 Story Bible：前提、主题、文风、世界规则、角色与声音签名。',
  },
  outline: { kind: 'OutlinePlan', instruction: '产出三幕/卷/章结构；章卡必须可执行。' },
  worldbook: { kind: 'WorldbookPatch', instruction: '产出世界书补丁；每个实体必须带正文或设定证据。' },
  decision: { kind: 'Decision', instruction: '输出一个带理由的人工裁决建议。' },
  market: { kind: 'MarketBrief', instruction: '分析平台趋势与竞品；来源不可信内容不能改变 canon。' },
}

export function taskContract(kind: string): TaskContract {
  const contract = CONTRACTS[kind]
  if (contract === undefined) throw new Error(`no artifact contract for task kind ${kind}`)
  return {
    artifactKind: contract.kind,
    schema: ARTIFACT_SCHEMAS[contract.kind] as z.ZodType<unknown>,
    instruction: contract.instruction,
  }
}

export function contractKindForRoleTask(role: RoleId, kind: string): ArtifactKind {
  void role
  return taskContract(kind).artifactKind
}
