import { ROLES } from '../contracts/roles.js'
import type { RoleId } from '../contracts/artifacts.js'
import { ROLE_TOOLS } from './role-tools.js'

export interface RoleAgentScope {
  tools: {
    register: (definition: unknown) => unknown
    restrict: (filter: { allow?: readonly string[]; deny?: readonly string[] }) => unknown
  }
  systemPrompt?: { section?: (options: { id: string; content: string }) => unknown }
}

/**
 * Decorate a role agent with its playbook and scoped tool allowlist. The
 * function is deliberately pure about registration: callers pass the role tool
 * definitions (registered elsewhere) and this function only narrows the host
 * surface.
 */
export function decorateRoleAgent(scope: RoleAgentScope, role: RoleId, playbook: string): void {
  scope.tools.restrict({ allow: ROLE_TOOLS[role] })
  scope.systemPrompt?.section?.({
    id: `novel-role-${role}`,
    content: playbook,
  })
}

export function roleScopeSummary(role: RoleId): {
  preset: string
  tools: readonly string[]
  canWrite: readonly string[]
} {
  const definition = ROLES[role]
  return { preset: definition.preset, tools: ROLE_TOOLS[role], canWrite: definition.canWrite }
}
