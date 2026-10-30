import { describe, expect, it } from 'vitest'
import type { SummaryDto } from '../src/client/dto.js'
import type { PanelSummaryDto } from '../src/engine/projections.js'
import type { PanelBookData } from '../src/panel-contract.js'
import { REMOTE_VERSION } from '../src/constants.js'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false
type Assert<Value extends true> = Value

// The v6 bookData is the single shared wire type; client and server cannot drift.
type ClientBookData = Assert<Equal<NonNullable<SummaryDto['bookData']>, PanelBookData>>
type ServerBookData = Assert<Equal<NonNullable<PanelSummaryDto['bookData']>, PanelBookData>>
type ClientVersionMatches = Assert<Equal<SummaryDto['schemaVersion'], number>>

const clientBookData: ClientBookData = true
const serverBookData: ServerBookData = true
const versionMatches: ClientVersionMatches = true

describe('panel wire contract', () => {
  it('uses one shared bookData type and one protocol version', () => {
    expect(clientBookData).toBe(true)
    expect(serverBookData).toBe(true)
    expect(versionMatches).toBe(true)
    expect(REMOTE_VERSION).toBe(6)
  })
})
