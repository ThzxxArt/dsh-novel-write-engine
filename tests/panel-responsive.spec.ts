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

  it('scrolls the page inside the fixed host while content lists keep local scroll', async () => {
    const source = await readFile(join(import.meta.dirname, '../src/client/panel.ts'), 'utf8')
    expect(source).toMatch(
      /\.nwe-root\s*\{[^}]*height: 100%;[^}]*overflow-y: auto;[^}]*scrollbar-width: none;/s,
    )
    expect(source).toContain('.nwe-root::-webkit-scrollbar { width: 0; height: 0; display: none; }')
    expect(source).toMatch(/\.nwe-workbench\s*\{[^}]*overflow: visible;/s)
    expect(source).not.toMatch(/\.nwe-workbench\s*\{[^}]*overflow-y: auto;/s)
    expect(source).not.toMatch(/\.nwe-hero[^}]*position:\s*sticky/s)
    expect(source).toMatch(/\.nwe-card-grid\s*\{[^}]*max-height:[^}]*overflow-y: auto;/s)
    expect(source).toContain('#nwe-panel-characters .nwe-card-grid')
    expect(source).toContain('.nwe-leads-layout > .nwe-subsection:has(.nwe-data-card[open])')
    expect(source).toContain('.nwe-worldbook-layout > .nwe-subsection:has(.nwe-data-card[open])')
    expect(source).toContain('.nwe-desk-main .nwe-chapters { overscroll-behavior: auto; }')
  })
})
