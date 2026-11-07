import { describe, expect, it, vi } from 'vitest'
import { decorateRoleAgent, roleScopeSummary } from '../src/agents/decorate.js'
import { presetOwner, ROLE_PRESET_IDS, rolePreset } from '../src/agents/presets.js'
import { assertRoleCanWrite, assertRoleTool, ROLE_TOOLS, roleDefinition } from '../src/agents/role-tools.js'

describe('agent role registry', () => {
  it('maps all 12 roles to presets', () => {
    expect(ROLE_PRESET_IDS).toHaveLength(12)
    expect(new Set(ROLE_PRESET_IDS).size).toBe(12)
    expect(rolePreset('drafter')).toBe('novel-role-drafter')
    expect(presetOwner('novel-role-drafter')).toBe('drafter')
    expect(presetOwner('unknown')).toBeUndefined()
    expect(roleDefinition('radar').canUseNetwork).toBe(true)
  })

  it('rejects tools and writes outside the role allowlist', () => {
    expect(ROLE_TOOLS.drafter).toContain('novel_draft_submit')
    expect(() => assertRoleTool('drafter', 'novel_draft_submit')).not.toThrow()
    expect(() => assertRoleTool('drafter', 'novel_archive_commit')).toThrow(/cannot use/)
    expect(() => assertRoleCanWrite('critic-prose', 'PolishPatch')).toThrow(/cannot write/)
    expect(() => assertRoleCanWrite('worldsmith', 'WorldbookPatch')).not.toThrow()
  })

  it('decorates a role agent with a restricted allowlist and playbook', () => {
    const restrict = vi.fn()
    const section = vi.fn()
    decorateRoleAgent(
      { tools: { register: vi.fn(), restrict }, systemPrompt: { section } },
      'planner',
      'playbook text',
    )
    expect(restrict).toHaveBeenCalledWith({ allow: ROLE_TOOLS.planner })
    expect(section).toHaveBeenCalledWith({ id: 'novel-role-planner', content: 'playbook text' })
    expect(roleScopeSummary('planner').preset).toBe('novel-role-planner')
  })
})
