import { expect, it } from 'vitest'
import * as engine from '../src/engine/index.js'
import * as rules from '../src/rules/index.js'
import * as exporters from '../src/export/index.js'

/** A barrel is a runtime module too; importing it keeps the coverage gate honest. */
it('re-exports the engine, rules and export surfaces', () => {
  expect(engine).toHaveProperty('EngineService')
  expect(rules).toHaveProperty('runMachineChecks')
  expect(exporters).toHaveProperty('buildEpub')
})
