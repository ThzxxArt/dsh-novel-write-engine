import { describe, expect, it } from 'vitest'
import { isExempt, runMachineChecks } from '../src/rules/pipeline.js'
import { loadRulepack } from '../src/rulepack.js'
import type { MachineOptions } from '../src/rules/pipeline.js'

const pack = loadRulepack()
const options = (overrides: Partial<MachineOptions> = {}): MachineOptions => ({
  chapter: 1,
  title: '第1章 开端之雨',
  genre: '都市现代',
  sceneType: '日常过渡章',
  rulepack: pack,
  summary: null,
  evidence: {
    previousText: null,
    foreshadows: null,
    timeline: null,
    relationships: null,
    world: null,
    locks: null,
  },
  ...overrides,
})

const codesOf = (text: string, overrides: Partial<MachineOptions> = {}): string[] =>
  runMachineChecks(text, options(overrides)).violations.map((violation) => violation.code)

describe('rule edge cases', () => {
  it('accepts a compliant title and rejects bodies outside 4..8 characters', () => {
    expect(codesOf('干净的正文。')).not.toContain('TITLE_FORMAT')
    expect(codesOf('干净的正文。', { title: '第1章 短' })).toContain('TITLE_FORMAT')
    expect(codesOf('干净的正文。', { title: '第1章 这是一个太长的章节标题' })).toContain('TITLE_FORMAT')
    expect(codesOf('干净的正文。', { title: '没有前缀' })).toContain('TITLE_FORMAT')
  })

  it('flags scene separators and keeps the dash budget when respected', () => {
    expect(codesOf('第一段。\n\n———\n\n第二段。')).toContain('SCENE_SEPARATOR')
    expect(codesOf('他说——然后走了——停下来。')).not.toContain('DASH_BUDGET')
  })

  it('relaxes contextual words for their genre and forbids them elsewhere', () => {
    const text = '这次赋能很关键。'.repeat(2)
    expect(codesOf(text, { genre: '都市现代' })).not.toContain('LEX_SOFT_LIMIT')
    expect(codesOf('这次赋能很关键。', { genre: '玄幻仙侠' })).toContain('LEX_SOFT_LIMIT')
  })

  it('reports exemptions and the quote ratio', () => {
    expect(isExempt(pack, 'SEMICOLON')).toBe(false)
    const exempt = { ...pack, exemptions: ['SEMICOLON'] }
    expect(isExempt(exempt, 'SEMICOLON')).toBe(true)
    expect(
      runMachineChecks('他说；走了。', options({ rulepack: exempt })).violations.some(
        (violation) => violation.code === 'SEMICOLON',
      ),
    ).toBe(false)
  })

  it('handles a text without sentences or punctuation', () => {
    const result = runMachineChecks('', options())
    expect(result.metrics.total_word_count).toBe(0)
    expect(result.quoteRatio).toBe(1)
    expect(result.paragraphCount).toBe(0)
  })
})
