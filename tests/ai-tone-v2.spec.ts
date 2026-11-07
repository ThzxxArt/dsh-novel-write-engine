import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { readBundledText } from '../src/assets.js'
import { compileRulepack } from '../src/rules/compiler.js'
import { loadRulepack } from '../src/rulepack.js'
import {
  CANONICAL_AI_TONE_PHRASES,
  normalizeForAiTone,
  scanAiTone,
  type AiToneHistoryEntry,
} from '../src/rules/ai-tone.js'
import { AI_TONE_RULES } from '../src/codes.js'

const lexical = loadRulepack().lexicon.ai_tone!

const scan = (
  text: string,
  history: AiToneHistoryEntry[] = [],
  signaturePhrases: string[] = [],
  chapter = 1,
) => scanAiTone(text, lexical, { chapter, history, signaturePhrases })

describe('rulepack v2 ai_tone', () => {
  it('loads 7 categories and 39 entries from the default pack', () => {
    expect(Object.keys(lexical.categories)).toHaveLength(7)
    expect(lexical.entries).toHaveLength(39)
    expect(new Set(lexical.entries.map((entry) => entry.id)).size).toBe(39)
  })

  it('T-31: covers all 50 canonical phrases', () => {
    const samples: Record<string, string> = {
      '行，xxx': '行，认了。',
      什么心思都写着xx上: '什么心思都写在脸上。',
      xx比xx沉: '这句比那句沉。',
      xx比xx重: '这句比那句重。',
      xx比xx稳: '这句比那句稳。',
      xx比xx轻: '这句比那句轻。',
      没接你的xxx: '没接你的话。',
      没接你那句xx: '没接你那句话。',
      '这话是ta告诉你的，还是你自己想明白的': '这话是他告诉你的，还是你自己想明白的。',
      xx就是认了: '他就是认了。',
    }
    for (const phrase of CANONICAL_AI_TONE_PHRASES) {
      const result = scan(samples[phrase] ?? `${phrase}。`)
      expect(result.entryIds.length, phrase).toBeGreaterThan(0)
    }
  })

  it('T-32: narration meta is a blocker, dialogue first use is advisory', () => {
    const narration = scan('这句话稳。')
    expect(narration.findings[0]?.severity).toBe('blocker')
    const dialogue = scan('“这句话稳。”')
    expect(dialogue.findings[0]?.severity).toBe('advisory')
    expect(dialogue.findings[0]?.dialogue).toBe(true)
  })

  it('T-32b: a second dialogue meta hit escalates to blocker', () => {
    const result = scan('“这句话稳。”他说。“这句话我不接。”')
    const meta = result.findings.filter((finding) => finding.code === AI_TONE_RULES.META)
    expect(meta).toHaveLength(2)
    expect(meta.map((finding) => finding.severity)).toEqual(['advisory', 'blocker'])
  })

  it('T-33: exempts action context, concrete measurements and normal bookkeeping', () => {
    expect(scan('他下盘很稳。').findings).toHaveLength(0)
    expect(scan('声音稳住了。').findings).toHaveLength(0)
    expect(scan('这块铁比那块重三斤。').findings).toHaveLength(0)
    expect(scan('他把账记下了。').findings).toHaveLength(0)
  })

  it('T-34: consecutive chapters and three occurrences in ten chapters trigger repeat', () => {
    const consecutive = scan('我记下了。', [{ chapter: 4, entries: ['AI-ACK-001'] }], [], 5)
    expect(consecutive.findings.some((finding) => finding.code === AI_TONE_RULES.REPEAT)).toBe(true)
    const distant = scan(
      '我记下了。',
      [
        { chapter: 2, entries: ['AI-ACK-001'] },
        { chapter: 4, entries: ['AI-ACK-001'] },
      ],
      [],
      5,
    )
    expect(distant.findings.some((finding) => finding.code === AI_TONE_RULES.REPEAT)).toBe(true)
  })

  it('T-35: density triggers on three categories or five hits in one window', () => {
    const result = scan('我记下了。这句话稳。比之前的都重。睡吧，我守着。你掂量。')
    expect(result.findings.some((finding) => finding.code === AI_TONE_RULES.DENSITY)).toBe(true)
  })

  it('T-36: a signature phrase is allowed once, the second use is a finding', () => {
    const once = scan('“我记下了。”', [], ['我记下了'])
    expect(once.findings).toHaveLength(0)
    expect(once.suppressedEntryIds).toContain('AI-ACK-001')
    const twice = scan('“我记下了。我记下了。”', [], ['我记下了'])
    expect(twice.findings.some((finding) => finding.entryId === 'AI-ACK-001')).toBe(true)
  })

  it('T-36b: a signature phrase does not suppress a different AI phrase in the same sentence', () => {
    const result = scan('“这句话稳，睡吧，我守着。”', [], ['这句话稳'])
    expect(result.findings.some((finding) => finding.entryId === 'AI-PROT-001')).toBe(true)
  })

  it('T-37: rejects a rulepack with an invalid regex', () => {
    const raw = parse(readBundledText('rulepacks/default.yaml')) as Record<string, any>
    raw.lexicon.ai_tone.entries.push({
      id: 'AI-META-999',
      category: 'meta_commentary',
      match: 'regex',
      pattern: '(unclosed',
      severity: 'advisory',
      note: 'bad',
      replacement: 'bad',
    })
    expect(() => compileRulepack(raw)).toThrowError(/regex does not compile/)
  })

  it('T-39: rejects unsupported template slots', () => {
    const raw = parse(readBundledText('rulepacks/default.yaml')) as Record<string, any>
    raw.lexicon.ai_tone.entries.push({
      id: 'AI-TPL-999',
      category: 'template_phrase',
      match: 'template',
      template: '行，{nefarious}',
      severity: 'advisory',
      note: 'bad',
      replacement: 'bad',
    })
    expect(() => compileRulepack(raw)).toThrowError(/unsupported template slot|template is invalid/)
  })

  it('T-40: whitespace-normalised text still matches', () => {
    const result = scan('我 记 下 了 。')
    expect(result.entryIds).toContain('AI-ACK-001')
  })

  it('replacement text is always actionable', () => {
    for (const entry of lexical.entries) expect(entry.replacement.length).toBeGreaterThan(0)
  })

  it('normalises full-width and half-width punctuation', () => {
    expect(normalizeForAiTone('我,记下了!').text).toBe('我，记下了！')
  })
})
