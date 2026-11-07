import { ROLES } from '../contracts/roles.js'
import type { RoleId } from '../contracts/artifacts.js'

export const ROLE_PRESET_IDS = Object.values(ROLES).map((role) => role.preset)

export const rolePreset = (role: RoleId): string => ROLES[role].preset

export const presetOwner = (preset: string): RoleId | undefined =>
  Object.values(ROLES).find((role) => role.preset === preset)?.id
