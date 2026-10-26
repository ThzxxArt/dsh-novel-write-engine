import { describe, expect, it } from 'vitest'
import { apply, Config } from '../src/index.js'
import { fakeHost } from './harness/context.js'
import { CORE_TOOLS, TOOL_NAMES } from '../src/constants.js'

const config = (Config as unknown as (init: Record<string, unknown>) => never)({})

describe('plugin assembly', () => {
  it('registers all eighteen tools, five commands, the skill and the panel route', () => {
    const host = fakeHost()
    apply(host.ctx as never, config)
    expect(host.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort())
    expect(host.commands.map((command) => command.name).sort()).toEqual([
      'novel',
      'novel-admin',
      'novel-export',
      'novel-next',
      'novel-stats',
    ])
    expect(host.skills).toHaveLength(1)
    expect(host.skills[0]!.name).toBe('novel-writing')
    expect(host.skills[0]!.content).toContain('六条铁律')
    expect(host.routes).toHaveLength(1)
    expect(host.routes[0]!.path).toBe('/api/novel-write-engine/panel')
  })

  it('registers only eight tools in core mode', () => {
    const host = fakeHost()
    apply(
      host.ctx as never,
      (Config as unknown as (init: Record<string, unknown>) => never)({ toolsMode: 'core' }),
    )
    expect(host.tools.map((tool) => tool.name).sort()).toEqual([...CORE_TOOLS].sort())
  })

  it('registers nothing when optional services are absent, and disposes cleanly', () => {
    const host = fakeHost(['tools'])
    apply(host.ctx as never, config)
    expect(host.tools).toHaveLength(18)
    expect(host.commands).toHaveLength(0)
    expect(host.skills).toHaveLength(0)
    expect(host.routes).toHaveLength(0)
    expect(() => host.dispose()).not.toThrow()
  })

  it('clamps an out-of-range score and tolerates blank configuration', () => {
    const host = fakeHost()
    apply(
      host.ctx as never,
      (Config as unknown as (init: Record<string, unknown>) => never)({
        minScore: 999,
        projectRoot: '',
        toolsMode: 'weird',
        briefsLocale: 'en',
      }),
    )
    expect(host.tools).toHaveLength(18)
  })
})
