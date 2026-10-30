import { describe, expect, it } from 'vitest'
import { verifyReference } from '../src/engine/gates.js'

describe('PG-09 repeated sentence matching', () => {
  it('maps a repeated quote to the referenced paragraph, not only the first occurrence', () => {
    const text =
      '同一句话落在这一段里，重复。\n\n同一句话落在这一段里，重复。\n\n第三段。\n\n第四段。\n\n第五段。'
    expect(verifyReference(text, { paragraph: 2, quote: '同一句话落在这一段里，重复。' })).toBeNull()
    expect(verifyReference(text, { paragraph: 5, quote: '同一句话落在这一段里，重复。' })).toMatch(
      /paragraph [12]/,
    )
  })
})
