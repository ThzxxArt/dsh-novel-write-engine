import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('panel responsive structure', () => {
  it('keeps the single-column breakpoint and overflow guards for narrow screens', async () => {
    const source = await readFile(join(import.meta.dirname, '../src/client/panel.ts'), 'utf8')
    expect(source).toContain('overflow-x: hidden')
    expect(source).toContain('@media (max-width: 640px)')
    expect(source).toContain('.nwe-v6-grid { grid-template-columns: 1fr; }')
    expect(source).toContain('.nwe-chapter-extra {')
    expect(source).toContain('overflow-wrap: anywhere')
  })
})
