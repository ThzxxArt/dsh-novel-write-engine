import { describe, expect, it } from 'vitest'
import { createNovelTools } from '../src/tools/index.js'
import {
  ARRAY_PARAMETER_CONTRACT,
  NON_ARRAY_JSON_PARAMS,
  declaredArraySemantics,
} from '../src/tools/semantics.js'

type Tool = ReturnType<typeof createNovelTools>[number]
type Schema = {
  type?: string
  description?: string
  properties?: Record<string, Schema & { type?: string; items?: Schema; required?: boolean }>
}

const tools = (): Map<string, Tool> => new Map(createNovelTools({} as never).map((tool) => [tool.name, tool]))

describe('0.2.4 tool array semantics contract', () => {
  it('declares semantics on every schema array parameter', () => {
    for (const tool of tools().values()) {
      const parameters = (tool.parameters as Schema).properties ?? {}
      for (const [name, parameter] of Object.entries(parameters)) {
        const contract = ARRAY_PARAMETER_CONTRACT[tool.name]?.[name]
        const key = `${tool.name}.${name}`
        if (parameter.type !== 'array' && parameter.type === undefined && contract === undefined) {
          expect(
            NON_ARRAY_JSON_PARAMS.has(key),
            `${key} is an untyped JSON parameter without a contract or non-array allowlist entry`,
          ).toBe(true)
          continue
        }
        if (parameter.type !== 'array' && contract === undefined) continue
        expect(contract, `${key} has no semantic declaration`).toBeDefined()
        expect(declaredArraySemantics(parameter.description), key).toBe(contract!.semantics)
      }
    }
  })

  it('keeps the persisted collection controls explicit', () => {
    const byName = tools()
    const outline = byName.get('novel_outline')!
    const outlineParams = (outline.parameters as Schema).properties!
    expect(outlineParams.remove).toBeDefined()
    expect(outlineParams.remove_volumes).toBeDefined()
    expect(declaredArraySemantics(outlineParams.chapters?.description)).toBe('upsert')
    expect(declaredArraySemantics(outlineParams.volumes?.description)).toBe('upsert')
    expect(declaredArraySemantics(outlineParams.remove?.description)).toBe('remove')

    const blueprint = byName.get('novel_blueprint')!
    const blueprintParams = (blueprint.parameters as Schema).properties!
    expect(declaredArraySemantics(blueprintParams.volumes?.description)).toBe('replace')
    expect(blueprintParams.confirm_remove?.type).toBe('boolean')

    for (const [toolName, parameters] of Object.entries(ARRAY_PARAMETER_CONTRACT)) {
      const tool = byName.get(toolName)
      expect(tool, toolName).toBeDefined()
      const schema = (tool!.parameters as Schema).properties ?? {}
      for (const [name, contract] of Object.entries(parameters)) {
        expect(schema[name], `${toolName}.${name}`).toBeDefined()
        if (contract.remove_param !== undefined) {
          expect(schema[contract.remove_param], `${toolName}.${contract.remove_param}`).toBeDefined()
        }
        if (contract.confirm_param !== undefined) {
          expect(schema[contract.confirm_param]?.type).toBe('boolean')
        }
      }
    }
  })
})
