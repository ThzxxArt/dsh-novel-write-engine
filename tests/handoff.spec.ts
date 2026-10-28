import { describe, expect, it } from 'vitest'
import { advanceHandoff, chineseNumber, parseActProgress, projectHandoff } from '../src/engine/handoff.js'
import type { HandoffDocument } from '../src/types.js'

const handoff = (patch: Partial<HandoffDocument> = {}): HandoffDocument => ({
  schema_version: 1,
  current_chapter: 0,
  volume: 1,
  volume_name: '第一卷',
  act: '第一幕',
  act_progress: '0/0',
  next_chapter: 1,
  last_summary: '',
  open_hooks: [],
  updated_at: new Date(0).toISOString(),
  ...patch,
})

describe('0.1.3 handoff progression', () => {
  it('starts the first chapter at 1/5 and rolls acts only at the beat boundary', () => {
    expect(advanceHandoff(handoff(), 1)).toMatchObject({
      volume: 1,
      volume_name: '第一卷',
      act: '第一幕',
      act_progress: '1/5',
    })
    expect(advanceHandoff(handoff({ act_progress: '5/5' }), 6)).toMatchObject({
      act: '第二幕',
      act_progress: '1/5',
    })
    expect(advanceHandoff(handoff({ act: '第四幕', act_progress: '5/5' }), 21)).toMatchObject({
      volume: 1,
      act: '第五幕',
      act_progress: '1/5',
    })
  })

  it('applies volume/act overrides and inherits them for the next chapter', () => {
    const started = advanceHandoff(handoff({ act: '第四幕', act_progress: '4/5' }), 25, {
      volume: 2,
      volume_name: '长夜卷',
      act: '第一幕',
      act_progress: '1/5',
    })
    expect(started).toEqual({
      volume: 2,
      volume_name: '长夜卷',
      act: '第一幕',
      act_progress: '1/5',
    })
    const next = advanceHandoff(handoff({ ...started, current_chapter: 25 }), 26)
    expect(next).toMatchObject({ volume: 2, volume_name: '长夜卷', act: '第一幕', act_progress: '2/5' })
  })

  it('keeps an inherited volume name when the same volume is restated', () => {
    expect(
      advanceHandoff(
        handoff({ current_chapter: 7, volume_name: '长夜卷', act: '第二幕', act_progress: '3/5' }),
        8,
        {
          volume: 1,
        },
      ),
    ).toMatchObject({ volume: 1, volume_name: '长夜卷', act: '第二幕', act_progress: '4/5' })
  })

  it('projects the active chapter without mutating the stored handoff', () => {
    const stored = handoff({ current_chapter: 10, volume: 1, act: '第二幕', act_progress: '5/5' })
    expect(projectHandoff(stored, 11)).toMatchObject({ act: '第三幕', act_progress: '1/5' })
    expect(projectHandoff(handoff(), 1)).toMatchObject({ act: '第一幕', act_progress: '1/5' })
    expect(stored.act_progress).toBe('5/5')
  })

  it('validates progress and converts act numerals', () => {
    expect(parseActProgress('3/5')).toEqual({ done: 3, total: 5 })
    expect(parseActProgress('0/0')).toEqual({ done: 0, total: 0 })
    expect(parseActProgress('6/5')).toBeNull()
    expect(parseActProgress('x')).toBeNull()
    expect(parseActProgress(3)).toBeNull()
    expect(chineseNumber(1)).toBe('一')
    expect(chineseNumber(10)).toBe('十')
    expect(chineseNumber(12)).toBe('十二')
    expect(chineseNumber(20)).toBe('二十')
    expect(chineseNumber(100)).toBe('100')
  })

  it('handles a first archive and the active-chapter projection edges', () => {
    expect(advanceHandoff(null, 1)).toEqual({
      volume: 1,
      volume_name: '第一卷',
      act: '第一幕',
      act_progress: '1/5',
    })
    expect(
      advanceHandoff(null, 1, {
        volume: 2,
        volume_name: '长夜卷',
        act: '第三幕',
        act_progress: '2/5',
      }),
    ).toEqual({ volume: 2, volume_name: '长夜卷', act: '第三幕', act_progress: '2/5' })
    expect(projectHandoff(null, 1)).toMatchObject({ act: '第一幕', act_progress: '1/5' })
    expect(
      projectHandoff(handoff({ current_chapter: 10, act: '第二幕', act_progress: '3/5' }), 10),
    ).toMatchObject({ act: '第二幕', act_progress: '3/5' })
    expect(projectHandoff(handoff({ current_chapter: 2, act_progress: 'bad' }), 4)).toBeDefined()
  })

  it('applies act-only, progress-only and invalid-progress overrides', () => {
    expect(
      advanceHandoff(handoff({ act: '第一幕', act_progress: '2/5' }), 3, { act: '第二幕' }),
    ).toMatchObject({ act: '第二幕', act_progress: '1/5' })
    expect(
      advanceHandoff(handoff({ act: '第一幕', act_progress: '2/5' }), 3, { act_progress: '4/5' }),
    ).toMatchObject({ act: '第一幕', act_progress: '4/5' })
    expect(advanceHandoff(handoff({ act_progress: 'bad' }), 2)).toMatchObject({
      act: '第一幕',
      act_progress: '1/5',
    })
    expect(advanceHandoff(handoff({ act: '序章', act_progress: '5/5' }), 2)).toMatchObject({
      act: '序章',
      act_progress: '1/5',
    })
    expect(advanceHandoff(handoff({ act: '第十幕', act_progress: '5/5' }), 2)).toMatchObject({
      act: '第十一幕',
    })
    expect(advanceHandoff(handoff({ volume: 0 as never, volume_name: ' ' }), 2)).toMatchObject({
      volume: 1,
      volume_name: '第1卷',
    })
    expect(advanceHandoff(null, 2, { volume: 2 })).toMatchObject({
      volume: 2,
      volume_name: '第2卷',
      act_progress: '1/5',
    })
    expect(chineseNumber(0)).toBe('零')
    expect(chineseNumber(-1)).toBe('-1')
    expect(projectHandoff(handoff({ current_chapter: 0 }), 2)).toBeDefined()
    expect(advanceHandoff(handoff({ act: '第100幕', act_progress: '5/5' }), 2)).toMatchObject({
      act: '第101幕',
    })
  })
})
