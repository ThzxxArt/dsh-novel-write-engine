import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { SKILL_NAME } from '../constants.js'

/** The entry skill: routing and the six iron rules, no stage knowledge. */
export interface SkillContribution {
  name: string
  description: string
  source: 'bundled'
  content: string
  whenToUse: string
}

function entryPath(): string {
  const candidates = [
    fileURLToPath(new URL('../skills/entry.md', import.meta.url)),
    fileURLToPath(new URL('../../skills/entry.md', import.meta.url)),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

// Read once at module load; `apply()` itself performs no IO.
const CONTENT = readFileSync(entryPath(), 'utf8')

/** Registration payload for `ctx.skills.register`. */
export function createSkill(): SkillContribution {
  return {
    name: SKILL_NAME,
    description:
      'Drive the novel writing engine: state, gates and the only allowed write paths. Use for any 小说/网文/写章/续写 task.',
    source: 'bundled',
    content: CONTENT,
    whenToUse:
      '小说创作、章节推进、字数与门控核对、归档与导出。引擎版流程，与旧技能套件互斥，遇到冲突以本技能为准。',
  }
}
