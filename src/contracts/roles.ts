import { z } from 'zod'
import { RoleIdSchema } from './artifacts.js'

export const ROLE_IDS = [
  'showrunner',
  'architect',
  'worldsmith',
  'planner',
  'drafter',
  'critic-story',
  'critic-character',
  'critic-prose',
  'continuity',
  'polisher',
  'archivist',
  'radar',
] as const

export interface RoleDefinition {
  id: (typeof ROLE_IDS)[number]
  label: string
  preset: string
  order: number
  /** Artifact kinds this role may submit. */
  canWrite: readonly string[]
  /** Artifact kinds this role may read; `*` means every project artifact. */
  canRead: readonly string[]
  canCommitCanon: boolean
  canUseNetwork: boolean
  canSpawn: boolean
  modelTier: 'reasoning' | 'creative' | 'standard' | 'cheap'
}

export const ROLES: Record<(typeof ROLE_IDS)[number], RoleDefinition> = {
  showrunner: {
    id: 'showrunner',
    label: '主编',
    preset: 'novel-role-showrunner',
    order: 20,
    canWrite: ['Decision', 'BiblePlan', 'OutlinePlan'],
    canRead: ['*'],
    canCommitCanon: false,
    canUseNetwork: false,
    canSpawn: true,
    modelTier: 'reasoning',
  },
  architect: {
    id: 'architect',
    label: '架构师',
    preset: 'novel-role-architect',
    order: 80,
    canWrite: ['BiblePlan', 'OutlinePlan'],
    canRead: ['BiblePlan', 'OutlinePlan', 'VolumePlan', 'ChapterPlan', 'MarketBrief'],
    canCommitCanon: false,
    canUseNetwork: false,
    canSpawn: false,
    modelTier: 'creative',
  },
  worldsmith: {
    id: 'worldsmith',
    label: '设定师',
    preset: 'novel-role-worldsmith',
    order: 81,
    canWrite: ['WorldbookPatch'],
    canRead: ['BiblePlan', 'WorldbookPatch', 'OutlinePlan', 'ChapterPlan', 'Draft'],
    canCommitCanon: false,
    canUseNetwork: false,
    canSpawn: false,
    modelTier: 'creative',
  },
  planner: {
    id: 'planner',
    label: '章纲师',
    preset: 'novel-role-planner',
    order: 82,
    canWrite: ['ChapterPlan'],
    canRead: ['BiblePlan', 'OutlinePlan', 'VolumePlan', 'ChapterPlan', 'WorldbookPatch', 'Draft'],
    canCommitCanon: false,
    canUseNetwork: false,
    canSpawn: false,
    modelTier: 'standard',
  },
  drafter: {
    id: 'drafter',
    label: '写手',
    preset: 'novel-role-drafter',
    order: 83,
    canWrite: ['Draft'],
    canRead: ['ChapterPlan', 'BiblePlan', 'WorldbookPatch', 'Draft'],
    canCommitCanon: false,
    canUseNetwork: false,
    canSpawn: false,
    modelTier: 'creative',
  },
  'critic-story': {
    id: 'critic-story',
    label: '故事审稿',
    preset: 'novel-role-critic-story',
    order: 84,
    canWrite: ['ReviewReport'],
    canRead: ['Draft', 'ChapterPlan', 'BiblePlan', 'OutlinePlan', 'ReviewReport'],
    canCommitCanon: false,
    canUseNetwork: false,
    canSpawn: false,
    modelTier: 'standard',
  },
  'critic-character': {
    id: 'critic-character',
    label: '人物审稿',
    preset: 'novel-role-critic-character',
    order: 85,
    canWrite: ['ReviewReport'],
    canRead: ['Draft', 'ChapterPlan', 'BiblePlan', 'WorldbookPatch', 'ReviewReport'],
    canCommitCanon: false,
    canUseNetwork: false,
    canSpawn: false,
    modelTier: 'standard',
  },
  'critic-prose': {
    id: 'critic-prose',
    label: '文风审稿',
    preset: 'novel-role-critic-prose',
    order: 86,
    canWrite: ['ReviewReport'],
    canRead: ['Draft', 'ChapterPlan', 'BiblePlan', 'ReviewReport'],
    canCommitCanon: false,
    canUseNetwork: false,
    canSpawn: false,
    modelTier: 'standard',
  },
  continuity: {
    id: 'continuity',
    label: '连续性审计',
    preset: 'novel-role-continuity',
    order: 87,
    canWrite: ['ContinuityReport'],
    canRead: ['Draft', 'ChapterPlan', 'BiblePlan', 'WorldbookPatch', 'StateDelta', 'ContinuityReport'],
    canCommitCanon: false,
    canUseNetwork: false,
    canSpawn: false,
    modelTier: 'standard',
  },
  polisher: {
    id: 'polisher',
    label: '润色师',
    preset: 'novel-role-polisher',
    order: 88,
    canWrite: ['PolishPatch'],
    canRead: ['Draft', 'ReviewReport', 'ContinuityReport', 'BiblePlan'],
    canCommitCanon: false,
    canUseNetwork: false,
    canSpawn: false,
    modelTier: 'standard',
  },
  archivist: {
    id: 'archivist',
    label: '档案员',
    preset: 'novel-role-archivist',
    order: 89,
    canWrite: ['StateDelta'],
    canRead: ['Draft', 'ChapterPlan', 'BiblePlan', 'WorldbookPatch', 'StateDelta', 'ContinuityReport'],
    canCommitCanon: true,
    canUseNetwork: false,
    canSpawn: false,
    modelTier: 'standard',
  },
  radar: {
    id: 'radar',
    label: '市场雷达',
    preset: 'novel-role-radar',
    order: 90,
    canWrite: ['MarketBrief'],
    canRead: ['MarketBrief', 'OutlinePlan'],
    canCommitCanon: false,
    canUseNetwork: true,
    canSpawn: false,
    modelTier: 'cheap',
  },
}

export const CHAPTER_ROLES = ROLE_IDS.filter((role) => role !== 'radar')

export const roleOfPreset = (preset: string | undefined): RoleDefinition | undefined => {
  if (preset === undefined) return undefined
  return Object.values(ROLES).find((role) => role.preset === preset)
}

export const RoleDefinitionSchema = z.object({
  id: RoleIdSchema,
  label: z.string(),
  preset: z.string(),
  order: z.number(),
  canWrite: z.array(z.string()),
  canRead: z.array(z.string()),
  canCommitCanon: z.boolean(),
  canUseNetwork: z.boolean(),
  canSpawn: z.boolean(),
  modelTier: z.enum(['reasoning', 'creative', 'standard', 'cheap']),
})
