import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_OPERATION_COUNT,
  ADMIN_OPERATION_GROUPS,
  COMMAND_COMBINATIONS,
  COMMAND_ENTRY,
  COMMAND_FORM_COUNT,
  COMMAND_GROUPS,
} from '../src/command-reference.js'
import { ADMIN_OPERATION_NAMES, IMPLEMENTED_ADMIN_OPERATION_NAMES } from '../src/commands/admin.js'
import { PANEL_VERSION } from '../src/constants.js'

const allCommandForms = (): string[] => [
  ...COMMAND_ENTRY.map((command) => command.form),
  ...COMMAND_GROUPS.flatMap((group) => group.items.map((command) => command.form)),
]

describe('command reference', () => {
  it('lists every implemented admin operation exactly once', () => {
    const referenced = ADMIN_OPERATION_GROUPS.flatMap((group) =>
      group.items.map((operation) => operation.name),
    )
    expect(ADMIN_OPERATION_COUNT).toBe(25)
    expect(referenced).toHaveLength(ADMIN_OPERATION_COUNT)
    expect(new Set(referenced).size).toBe(referenced.length)
    expect([...referenced].sort()).toEqual([...ADMIN_OPERATION_NAMES].sort())
    expect([...ADMIN_OPERATION_NAMES].sort()).toEqual([...IMPLEMENTED_ADMIN_OPERATION_NAMES].sort())
  })

  it('covers the five entries and all named /novel forms without duplicates', () => {
    const forms = allCommandForms()
    expect(COMMAND_ENTRY).toHaveLength(5)
    expect(COMMAND_FORM_COUNT).toBe(25)
    expect(new Set(forms).size).toBe(forms.length)
    for (const form of [
      '/novel',
      '/novel-next',
      '/novel-stats',
      '/novel-export <kind>',
      '/novel-admin [<op> <json>]',
      '/novel projects --prune',
      '/novel projects --prune --yes',
      '/novel scan --register',
      '/novel export md',
      '/novel export txt',
      '/novel export epub',
      '/novel export outline',
      '/novel export worldbook',
      '/novel export proposal',
      '/novel admin <op> <json>',
    ]) {
      expect(forms, form).toContain(form)
    }
    expect(COMMAND_COMBINATIONS.length).toBeGreaterThanOrEqual(5)
    for (const combination of COMMAND_COMBINATIONS) {
      expect(combination.steps.length, combination.title).toBeGreaterThanOrEqual(2)
      expect(combination.note.length, combination.title).toBeGreaterThan(10)
    }
  })

  it('keeps the tutorial version aligned with package.json', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    expect(PANEL_VERSION).toBe(manifest.version)
  })
})
