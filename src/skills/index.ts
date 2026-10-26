import { readBundledText } from '../assets.js'
import { SKILL_NAME } from '../constants.js'

/** The entry skill: routing and the six iron rules, no stage knowledge. */
export interface SkillContribution {
  name: string
  description: string
  source: 'bundled'
  content: string
  whenToUse: string
}

/** Read once at module load; `apply()` itself performs no IO. */
const CONTENT = readBundledText('skills/entry.md')

/** Registration payload for `ctx.skills.register`. */
export function createSkill(): SkillContribution {
  return {
    name: SKILL_NAME,
    description:
      'Drive the novel writing engine: state, gates and the only allowed write paths. Use for any 小说/网文/写章/续写 task.',
    source: 'bundled',
    content: CONTENT,
    whenToUse:
      '用户要写小说章节、继续写、重写、检查章节一致性，或查看创作项目状态时。由本插件维护状态与门控。',
  }
}
