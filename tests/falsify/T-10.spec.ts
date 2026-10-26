import { expect, it } from 'vitest'
import * as remote from '../../src/remote/index.js'

/** T-10 / INV-10: the remote surface is read-only at runtime, not only in types. */
it('T-10 the remote module exposes no write method', () => {
  expect(Object.keys(remote).sort()).toEqual(['panelHandler', 'panelPayload', 'panelRoute'])
  for (const [name, value] of Object.entries(remote)) {
    if (typeof value !== 'function') continue
    expect(['panelHandler', 'panelPayload', 'panelRoute'], name).toContain(name)
  }
  const route = remote.panelRoute({} as never)
  expect(route.handler).toBeTypeOf('function')
  expect(Object.keys(route).sort()).toEqual(['handler', 'kind', 'path'])
})
