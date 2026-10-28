import type { ArchiveHandoff, HandoffDocument } from '../types.js'

/** The visible volume/act position for one chapter. */
export interface HandoffPosition {
  volume: number
  volume_name: string
  act: string
  act_progress: string
}

const ACT_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const

/** Chinese numerals for the act labels the task books use. */
export const chineseNumber = (value: number): string => {
  if (!Number.isInteger(value) || value < 0) return String(value)
  if (value < 10) return ACT_DIGITS[value]!
  if (value === 10) return '十'
  if (value < 20) return `十${ACT_DIGITS[value - 10]!}`
  if (value < 100) {
    const tens = Math.floor(value / 10)
    const ones = value % 10
    return `${ACT_DIGITS[tens]!}十${ones === 0 ? '' : ACT_DIGITS[ones]!}`
  }
  return String(value)
}

const parseActNumber = (act: string): number | null => {
  const match = /^第\s*([零一二三四五六七八九十百\d]+)\s*幕$/.exec(act.trim())
  if (match === null) return null
  const raw = match[1]!
  if (/^\d+$/.test(raw)) return Number(raw)
  if (raw === '十') return 10
  const ten = raw.indexOf('十')
  if (ten !== -1) {
    const left = raw.slice(0, ten)
    const right = raw.slice(ten + 1)
    const tens = left === '' ? 1 : ACT_DIGITS.indexOf(left as (typeof ACT_DIGITS)[number])
    const ones = right === '' ? 0 : ACT_DIGITS.indexOf(right as (typeof ACT_DIGITS)[number])
    if (tens < 0 || ones < 0) return null
    return tens * 10 + ones
  }
  const index = ACT_DIGITS.indexOf(raw as (typeof ACT_DIGITS)[number])
  return index < 0 ? null : index
}

const nextAct = (act: string): string => {
  const value = parseActNumber(act)
  return value === null ? act : `第${chineseNumber(value + 1)}幕`
}

/** `n/d`, with a non-zero denominator; `0/0` is the initialized handoff. */
export const parseActProgress = (value: unknown): { done: number; total: number } | null => {
  if (typeof value !== 'string') return null
  const match = /^(\d+)\/(\d+)$/.exec(value.trim())
  if (match === null) return null
  const done = Number(match[1])
  const total = Number(match[2])
  if (!Number.isSafeInteger(done) || !Number.isSafeInteger(total)) return null
  if (done < 0 || total < 0 || done > total) return null
  return { done, total }
}

const firstPosition = (chapter: number): HandoffPosition => {
  const block = Math.max(0, chapter - 1)
  return {
    volume: 1,
    volume_name: '第一卷',
    act: `第${chineseNumber(Math.floor(block / 5) + 1)}幕`,
    act_progress: `${(block % 5) + 1}/5`,
  }
}

const advanceProgress = (previous: HandoffDocument): { act: string; act_progress: string } => {
  const act = typeof previous.act === 'string' && previous.act.trim() !== '' ? previous.act : '第一幕'
  const progress = parseActProgress(previous.act_progress)
  if (progress === null || progress.total === 0) return { act, act_progress: '1/5' }
  if (progress.done < progress.total) {
    return { act, act_progress: `${progress.done + 1}/${progress.total}` }
  }
  return { act: nextAct(act), act_progress: `1/${progress.total}` }
}

const volumeOf = (previous: HandoffDocument | null): number =>
  previous !== null && Number.isInteger(previous.volume) && previous.volume >= 1 ? previous.volume : 1

const volumeNameOf = (previous: HandoffDocument | null, volume: number): string =>
  previous !== null && typeof previous.volume_name === 'string' && previous.volume_name.trim() !== ''
    ? previous.volume_name
    : `第${volume}卷`

/**
 * Advance from the stored handoff of the previous chapter to the next chapter.
 * The archive override is applied as a starting point: changing volume resets
 * the act, while changing only the act starts its first beat.
 */
export const advanceHandoff = (
  previous: HandoffDocument | null,
  chapter: number,
  override?: ArchiveHandoff,
): HandoffPosition => {
  if (previous === null) {
    const position = firstPosition(chapter)
    const volume = override?.volume ?? position.volume
    return {
      volume,
      volume_name:
        override?.volume_name ?? (volume === position.volume ? position.volume_name : `第${volume}卷`),
      act: override?.act ?? position.act,
      act_progress: override?.act_progress ?? (volume === position.volume ? position.act_progress : '1/5'),
    }
  }
  const previousVolume = volumeOf(previous)
  const volume = override?.volume ?? previousVolume
  const volumeChanged = volume !== previousVolume
  const base = volumeChanged ? { act: '第一幕', act_progress: '1/5' } : advanceProgress(previous)
  const act = override?.act ?? base.act
  const actProgress =
    override?.act_progress ??
    (override?.act !== undefined && override.act !== previous.act ? '1/5' : base.act_progress)
  return {
    volume,
    volume_name: override?.volume_name ?? (volumeChanged ? `第${volume}卷` : volumeNameOf(previous, volume)),
    act,
    act_progress: actProgress,
  }
}

/** Project the stored handoff to the active chapter without changing the file. */
export const projectHandoff = (previous: HandoffDocument | null, chapter: number): HandoffPosition => {
  if (previous === null) return firstPosition(chapter)
  const current = Number.isInteger(previous.current_chapter) ? previous.current_chapter : chapter - 1
  if (current >= chapter) {
    const volume = volumeOf(previous)
    return {
      volume,
      volume_name: volumeNameOf(previous, volume),
      act: previous.act,
      act_progress: previous.act_progress,
    }
  }
  let position: HandoffPosition = {
    volume: volumeOf(previous),
    volume_name: volumeNameOf(previous, volumeOf(previous)),
    act: previous.act,
    act_progress: previous.act_progress,
  }
  for (let step = current; step < chapter; step += 1) {
    const fake = {
      ...previous,
      volume: position.volume,
      volume_name: position.volume_name,
      act: position.act,
      act_progress: position.act_progress,
    } as HandoffDocument
    position = {
      volume: position.volume,
      volume_name: position.volume_name,
      ...advanceProgress(fake),
    }
  }
  return position
}
