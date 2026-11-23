import { FORMAT_RULES, PUNCTUATION_RULES, SELFCHECK_RULES, STYLE_RULES } from '../codes.js'
import { dialogueCharacterRatio, paragraphSpans, splitSentenceSpans } from '../domain/text.js'
import { metaphorHits, stylePatternToRegExp, styleVocabulary } from '../domain/style.js'
import { isBlank } from '../domain/wordcount.js'
import type { Rule, RuleContext } from './types.js'
import type {
  SelfCheckBasis,
  SelfCheckDocument,
  SelfCheckEvidence,
  SelfCheckId,
  SelfCheckItem,
  Severity,
  Violation,
} from '../types.js'

/**
 * 0.2.19 submission self-check rules (SC-1 … SC-13).
 *
 * These are the items on the editor's pre-submission checklist turned into
 * decisions the engine can state, point at and repeat. Three properties hold for
 * all eleven:
 *
 * 1. **Gated on `rulepack.selfcheck`.** A pack without the block produces no
 *    finding, so the eleven codes never appear on a pre-0.2.19 project.
 * 2. **Paragraph-anchored.** Every finding names the paragraph it is about, in
 *    the same 1-based numbering `splitParagraphs` gives every other rule.
 * 3. **One owner per question.** S7 (dash), S10's upper bound (long paragraph)
 *    and S13 (separator) keep their existing codes; this module adds only the
 *    eleven questions nothing asked before.
 */

const v = (code: string, severity: Severity, paragraph: number, detail: string): Violation => ({
  code,
  severity,
  location: { paragraph },
  detail,
})

const selfcheckOf = (ctx: RuleContext): NonNullable<RuleContext['rulepack']['selfcheck']> | null =>
  ctx.rulepack.selfcheck ?? null

/** Local alias so the module reads without repeating `paragraphSpans`. */
const splitParagraphsOf = (text: string): string[] => paragraphSpans(text).map((span) => span.text)

/** A paragraph excerpt small enough to read in a receipt. */
const excerpt = (text: string, limit = 40): string => {
  const chars = Array.from(text)
  return chars.length <= limit ? text : `${chars.slice(0, limit).join('')}…`
}

const nonWsLength = (text: string): number => Array.from(text).filter((char) => !isBlank(char)).length

/** A sentence as the rhythm metrics see it: no trailing terminator, no closers. */
const sentenceBody = (text: string): string =>
  text
    .replace(/[。！？!?…]+$/u, '')
    .replace(/[」』”"'’）)】\]]+$/u, '')
    .trim()

const countOccurrences = (text: string, needle: string): number => {
  if (needle === '') return 0
  let count = 0
  let index = text.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

/* ------------------------------------------------------------- S1 metaphor */

/**
 * S1 · 比喻只保留最贴切的一个.
 *
 * A stack is more similes than `max_per_sentence` inside **one sentence**; a
 * paragraph is also reported when `max_stacks_per_paragraph` sentences in it
 * each stack. Two sentences with one simile each is ordinary prose — that is the
 * boundary the item is often misread as crossing.
 */
const metaphorStack: Rule = (ctx) => {
  const block = selfcheckOf(ctx)
  if (block === null) return []
  const hits = metaphorHits(ctx.text, styleVocabulary(ctx.rulepack).metaphor)
  if (hits.length === 0) return []
  const sentences = splitSentenceSpans(ctx.text)
  if (sentences.length === 0) return []

  interface Stacked {
    sentence: (typeof sentences)[number]
    markers: string[]
  }
  const bySentence = new Map<number, Stacked>()
  for (const hit of hits) {
    const index = sentences.findIndex((span) => hit.start >= span.start && hit.start < span.end)
    if (index === -1) continue
    const row = bySentence.get(index) ?? { sentence: sentences[index]!, markers: [] }
    row.markers.push(hit.marker)
    bySentence.set(index, row)
  }

  const byParagraph = new Map<number, Stacked[]>()
  for (const row of bySentence.values()) {
    if (row.markers.length <= block.metaphor.max_per_sentence) continue
    const rows = byParagraph.get(row.sentence.paragraph) ?? []
    rows.push(row)
    byParagraph.set(row.sentence.paragraph, rows)
  }

  const results: Violation[] = []
  for (const [paragraph, rows] of [...byParagraph.entries()].sort((left, right) => left[0] - right[0])) {
    const worst = rows.reduce(
      (best, row) => (row.markers.length > best.markers.length ? row : best),
      rows[0]!,
    )
    const stacked = rows.length
    // A paragraph is reported when one sentence already overflows the limit, or
    // when several sentences each overflow it.
    const overLimit = worst.markers.length > block.metaphor.max_per_sentence
    if (!overLimit && stacked < block.metaphor.max_stacks_per_paragraph) continue
    results.push(
      v(
        SELFCHECK_RULES.METAPHOR_STACK,
        'advisory',
        paragraph,
        `比喻堆叠：一句里 ${worst.markers.length} 个（上限 ${block.metaphor.max_per_sentence}），本段 ${stacked} 句堆叠（上限 ${block.metaphor.max_stacks_per_paragraph}）；命中 ${[...new Set(worst.markers)].join('、')}；原句「${excerpt(sentenceBody(worst.sentence.text))}」`,
      ),
    )
  }
  return results
}

/* -------------------------------------------------------------- S2 concrete */

/**
 * S2 · 画面感.
 *
 * The machine only supplies the fact layer: a paragraph built out of abstract
 * nouns with no sensory word and no body cue is *declared* abstract. Whether it
 * can be pictured is the P4 model's answer, and only that answer may deduct
 * `R-W-12`.
 */
const proseAbstract: Rule = (ctx) => {
  const block = selfcheckOf(ctx)
  if (block === null) return []
  const nouns = block.concrete.abstract_nouns.filter((noun) => noun !== '')
  if (nouns.length === 0) return []
  const sensory = ctx.rulepack.semantics.sensory_density.senses
  const cues = ctx.rulepack.semantics.emotion_cues?.terms ?? []
  const dominant = ctx.rulepack.punctuation.dialogue_dominant_ratio
  const results: Violation[] = []
  for (const [index, paragraph] of splitParagraphsOf(ctx.text).entries()) {
    if (dialogueCharacterRatio(paragraph) >= dominant) continue
    const hits = nouns.reduce((total, noun) => total + countOccurrences(paragraph, noun), 0)
    if (hits < block.concrete.min_per_paragraph) continue
    const anchors =
      sensory.reduce((total, term) => total + countOccurrences(paragraph, term), 0) +
      cues.reduce((total, term) => total + countOccurrences(paragraph, term), 0)
    if (anchors > 0) continue
    const found = nouns.filter((noun) => paragraph.includes(noun))
    results.push(
      v(
        SELFCHECK_RULES.PROSE_ABSTRACT,
        'advisory',
        index + 1,
        `抽象词 ${hits} 个（${found.join('、')}），本段没有感官词也没有身体反应；原句「${excerpt(paragraph)}」`,
      ),
    )
  }
  return results
}

/* --------------------------------------------------------------- S3 formula */

/**
 * S3 · 固定句式.
 *
 * Two halves, one code. (a) A 关联词 frame repeated inside one paragraph is a
 * formula; the window is the paragraph because a 3000-character chapter may
 * legitimately use 不是……而是…… once. (b) A two-character opener that starts
 * three or more paragraphs is the same tic at chapter scale.
 */
const frameRepeat: Rule = (ctx) => {
  const block = selfcheckOf(ctx)
  if (block === null) return []
  const results: Violation[] = []
  const paragraphs = splitParagraphsOf(ctx.text)
  // C8 hand-over, plan §8 S3: a formula the style pack already bans belongs to
  // `STYLE_BANNED_PATTERN`, which carries the author's own replacement advice and
  // the pack's severity ladder. Reporting it twice on the same span would make
  // the author fix one thing twice.
  const bannedByStyle = new Set(ctx.style?.banned_patterns ?? [])

  for (const [index, paragraph] of paragraphs.entries()) {
    for (const frame of block.frames) {
      if (bannedByStyle.has(frame.pattern)) continue
      const hits = (paragraph.match(stylePatternToRegExp(frame.pattern)) ?? []).length
      if (hits <= frame.max) continue
      results.push(
        v(
          SELFCHECK_RULES.FRAME_REPEAT,
          'advisory',
          index + 1,
          `固定句式「${frame.pattern}」在本段出现 ${hits} 次（上限 ${frame.max}）`,
        ),
      )
    }
  }

  const prefixChars = block.opening_repeat.prefix_chars
  if (prefixChars >= 1 && block.opening_repeat.min_count >= 2) {
    // WP7: two exclusions the checklist implies but a word list cannot express.
    //
    // 1. A paragraph that opens with a quote opens with dialogue, not with a
    //    formula; `"我` is not an opener.
    // 2. A paragraph that opens with a *declared character name* is the author
    //    naming who acts. On the real manuscript 陈嘉 opened 8 paragraphs and
    //    that is subject-first narration, not a tic — the names come from the
    //    character ledger, which the rule already receives as evidence.
    const names = new Set((ctx.evidence.characters?.characters ?? []).map((row) => row.name))
    const openers = new Map<string, number[]>()
    for (const [index, paragraph] of paragraphs.entries()) {
      if (/^["“「『]/.test(paragraph)) continue
      const head = Array.from(paragraph).slice(0, prefixChars).join('')
      if (Array.from(head).length < prefixChars) continue
      const first = Array.from(paragraph)[0]!
      if (block.opening_repeat.exclude.includes(first)) continue
      if ([...names].some((name) => name !== '' && paragraph.startsWith(name))) continue
      const rows = openers.get(head) ?? []
      rows.push(index + 1)
      openers.set(head, rows)
    }
    for (const [head, rows] of openers) {
      if (rows.length < block.opening_repeat.min_count) continue
      results.push(
        v(
          SELFCHECK_RULES.FRAME_REPEAT,
          'advisory',
          rows[0]!,
          `句首「${head}」在本章出现 ${rows.length} 次（上限 ${block.opening_repeat.min_count - 1}），第 ${rows.join('、')} 段`,
        ),
      )
    }
  }
  return results
}

/* -------------------------------------------------------------- S4 parallel */

interface SentenceRow {
  paragraph: number
  body: string
  length: number
}

const sentenceRows = (text: string): SentenceRow[] =>
  splitSentenceSpans(text).map((span) => {
    const body = sentenceBody(span.text)
    return { paragraph: span.paragraph, body, length: Array.from(body).length }
  })

/** Same first character, or same first two characters: the shape of a 排比. */
const sameShape = (run: readonly SentenceRow[]): boolean => {
  const bodies = run.map((row) => Array.from(row.body))
  const head = bodies[0]!
  const char = head[0]
  if (char === undefined) return false
  if (bodies.every((body) => body[0] === char)) return true
  const pair = head.slice(0, 2).join('')
  return pair.length === 2 && bodies.every((body) => body.slice(0, 2).join('') === pair)
}

const lengthsClose = (run: readonly SentenceRow[], delta: number): boolean => {
  for (let index = 1; index < run.length; index += 1) {
    if (Math.abs(run[index]!.length - run[index - 1]!.length) > delta) return false
  }
  return true
}

/**
 * S4 · 短句排比.
 *
 * (a) A run of at least `min_run` sentences inside one paragraph, all of the
 * same shape and nearly the same length. (b) A run of `min_run` consecutive
 * paragraphs each holding exactly one short sentence — the "一行一句" form that
 * `UNIFORM_SENTENCE` cannot see, because its window is a single paragraph.
 */
const parallelRun: Rule = (ctx) => {
  const block = selfcheckOf(ctx)
  if (block === null) return []
  const bump = ctx.sceneType === '战斗/动作章' ? 1 : 0
  const minRun = block.parallel.min_run + bump
  const dominant = ctx.rulepack.punctuation.dialogue_dominant_ratio
  const paragraphs = splitParagraphsOf(ctx.text)
  const results: Violation[] = []

  // (a) sentence runs inside a paragraph
  const rows = sentenceRows(ctx.text)
  const byParagraph = new Map<number, SentenceRow[]>()
  for (const row of rows) {
    const list = byParagraph.get(row.paragraph) ?? []
    list.push(row)
    byParagraph.set(row.paragraph, list)
  }
  for (const [paragraph, list] of byParagraph) {
    const body = paragraphs[paragraph - 1]
    if (body === undefined || dialogueCharacterRatio(body) >= dominant) continue
    let best: SentenceRow[] = []
    let run: SentenceRow[] = []
    for (const row of list) {
      const candidate = [...run, row]
      if (
        run.length === 0 ||
        (lengthsClose(candidate, block.parallel.length_delta) && sameShape(candidate))
      ) {
        run = candidate
      } else {
        // A break does not erase the previous sentence: (他走。他停。) is still a
        // pair, so the run restarts from the pair rather than from `row` alone.
        const pair = [run.at(-1)!, row]
        run = lengthsClose(pair, block.parallel.length_delta) && sameShape(pair) ? pair : [row]
      }
      if (run.length > best.length) best = run
    }
    if (best.length < minRun) continue
    results.push(
      v(
        SELFCHECK_RULES.PARALLEL_RUN,
        'advisory',
        paragraph,
        `连续 ${best.length} 句同构短句（首「${Array.from(best[0]!.body).slice(0, 2).join('')}」，句长 ${best
          .map((row) => row.length)
          .join('/')}，阈值 ${minRun}）`,
      ),
    )
  }

  // (b) one short sentence per paragraph, across paragraphs
  const singles = paragraphs.map((paragraph, index) => {
    const list = byParagraph.get(index + 1) ?? []
    if (list.length !== 1) return null
    if (dialogueCharacterRatio(paragraph) >= dominant) return null
    const row = list[0]!
    return row.length <= block.parallel.max_short_sentence ? row : null
  })
  let runStart = -1
  let bestStart = -1
  let bestLength = 0
  for (const [index, row] of singles.entries()) {
    if (row === null) {
      runStart = -1
      continue
    }
    if (runStart === -1) runStart = index
    const length = index - runStart + 1
    if (length > bestLength) {
      bestLength = length
      bestStart = runStart
    }
  }
  if (bestLength >= minRun && bestStart !== -1) {
    results.push(
      v(
        SELFCHECK_RULES.PARALLEL_RUN,
        'advisory',
        bestStart + 1,
        `连续 ${bestLength} 段一行一句短句（第 ${bestStart + 1}…${bestStart + bestLength} 段，阈值 ${minRun}）`,
      ),
    )
  }
  return results
}

/* ------------------------------------------------------------ S5 enumeration */

const PARAGRAPH_KEY_RE = /^([^：:，。]{1,8})[：:](.{1,})$/u

/**
 * S5 · 清单罗列.
 *
 * (a) three consecutive sentences opening with an ordinal, (b) one sentence
 * carrying five or more 顿号 with short items, (c) three consecutive
 * `短名词：说明` paragraphs. System panels (`【】`, `system_labels`) are exempt:
 * they are the one place a list is the right form.
 */
const enumeration: Rule = (ctx) => {
  const block = selfcheckOf(ctx)
  if (block === null) return []
  const paragraphs = splitParagraphsOf(ctx.text)
  const labels = ctx.rulepack.format.system_labels
  const exempt = (paragraph: string): boolean =>
    (paragraph.startsWith('【') && paragraph.endsWith('】')) ||
    labels.some((label) => new RegExp(label).test(paragraph))
  const results: Violation[] = []

  // (a) ordinal-led sentence run
  const ordinals = block.enumeration.ordinals.filter((ordinal) => ordinal !== '')
  if (ordinals.length > 0) {
    const rows = sentenceRows(ctx.text)
    let run = 0
    let runStart = 0
    let reported = false
    for (const [index, row] of rows.entries()) {
      const starts = ordinals.some((ordinal) => row.body.startsWith(ordinal))
      if (starts) {
        if (run === 0) runStart = index
        run += 1
        if (run >= block.enumeration.min_items && !reported) {
          reported = true
          results.push(
            v(
              SELFCHECK_RULES.ENUMERATION,
              'advisory',
              row.paragraph,
              `连续 ${run} 句以序数开头（第 ${runStart + 1}…${index + 1} 句，阈值 ${block.enumeration.min_items}）`,
            ),
          )
        }
        continue
      }
      run = 0
    }
  }

  // (b) a 顿号 run inside one sentence
  for (const row of sentenceRows(ctx.text)) {
    const parts = row.body.split('、')
    if (parts.length - 1 < 5) continue
    const short = parts.filter((part) => Array.from(part).length <= block.enumeration.max_item_chars).length
    if (short < 3) continue
    results.push(
      v(
        SELFCHECK_RULES.ENUMERATION,
        'advisory',
        row.paragraph,
        `一句里 ${parts.length - 1} 个顿号、${short} 个短分项：清单式罗列；原句「${excerpt(row.body)}」`,
      ),
    )
  }

  // (c) consecutive 短名词：说明 paragraphs
  let runStart = -1
  for (let index = 0; index <= paragraphs.length; index += 1) {
    const paragraph = paragraphs[index]
    const shaped = paragraph !== undefined && !exempt(paragraph) && PARAGRAPH_KEY_RE.test(paragraph)
    if (shaped) {
      if (runStart === -1) runStart = index
      continue
    }
    const length = runStart === -1 ? 0 : index - runStart
    if (length >= block.enumeration.min_items) {
      results.push(
        v(
          SELFCHECK_RULES.ENUMERATION,
          'advisory',
          runStart + 1,
          `连续 ${length} 段「短名词：说明」（第 ${runStart + 1}…${index} 段，阈值 ${block.enumeration.min_items}）`,
        ),
      )
    }
    runStart = -1
  }
  return results
}

/* -------------------------------------------------------- S6 dialogue beats */

/**
 * S6 · 短对话之间要穿插动作、神态或场景.
 *
 * A run of `min_run` consecutive dialogue-dominant paragraphs with no narration
 * between them. A pack that declares `dialogue.allow_interruptions` is asking for
 * the interruption style, so it gets two more lines before the rule speaks.
 */
const dialogueRun: Rule = (ctx) => {
  const block = selfcheckOf(ctx)
  if (block === null) return []
  const bump = ctx.style?.dialogue.allow_interruptions === true ? 2 : 0
  const minRun = block.dialogue_run.min_run + bump
  const paragraphs = splitParagraphsOf(ctx.text)
  const results: Violation[] = []
  let runStart = -1
  for (let index = 0; index <= paragraphs.length; index += 1) {
    const paragraph = paragraphs[index]
    const dialogue =
      paragraph !== undefined && dialogueCharacterRatio(paragraph) >= block.dialogue_run.dialogue_share
    if (dialogue) {
      if (runStart === -1) runStart = index
      continue
    }
    const length = runStart === -1 ? 0 : index - runStart
    if (length >= minRun) {
      results.push(
        v(
          SELFCHECK_RULES.DIALOGUE_RUN,
          'advisory',
          runStart + 1,
          `连续 ${length} 段纯对白没有穿插动作（第 ${runStart + 1}…${index} 段，阈值 ${minRun}）`,
        ),
      )
    }
    runStart = -1
  }
  return results
}

/* ------------------------------------------------------- S8 quote pairing */

/**
 * S8 · 人物对话使用引号，对话与旁白区分清楚.
 *
 * An odd number of straight quotes in one paragraph means one of them is
 * unpaired, so the rest of the paragraph renders as dialogue. That is mechanical
 * damage, not taste, which is why it blocks. Curly and CJK quotes stay with
 * `ILLEGAL_QUOTE`, the more specific owner of "wrong quote character".
 */
const quoteUnbalanced: Rule = (ctx) => {
  // 0.2.19: gated like the other ten. A pack without the block must keep the
  // pre-0.2.19 output, and this code did not exist before 0.2.19.
  if (selfcheckOf(ctx) === null) return []
  const results: Violation[] = []
  for (const [index, paragraph] of splitParagraphsOf(ctx.text).entries()) {
    const count = (paragraph.match(/"/g) ?? []).length
    if (count === 0 || count % 2 === 0) continue
    results.push(
      v(
        SELFCHECK_RULES.QUOTE_UNBALANCED,
        'blocker',
        index + 1,
        `本段 ${count} 个半角引号，未配对；near "${excerpt(paragraph)}"`,
      ),
    )
  }
  return results
}

/* -------------------------------------------------------- S9 punctuation */

const HALFWIDTH_MARKS = new Set([',', '.', '?', '!', ':', ';', '(', ')'])
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u

/**
 * S9 · 中文全角标点，不留空格，不使用特殊符号.
 *
 * The half-width test is deliberately conservative: a mark only counts when a
 * Chinese character sits on one side of it. `3.5%`, `10,000`, `U.S.`, `A/B` and a
 * whole English paragraph therefore stay silent, because a blocklist that
 * rejects legal numbers would block correct manuscripts.
 */
const punctStandard: Rule = (ctx) => {
  const block = selfcheckOf(ctx)
  if (block === null) return []
  const results: Violation[] = []
  const spans = paragraphSpans(ctx.text)
  const lines = ctx.text.split('\n')

  // Trailing and leading ASCII spaces need the raw line: `splitParagraphs`
  // trims them, so a paragraph-level scan can never see one.
  const margins = new Map<number, string[]>()
  let paragraph = 0
  for (const line of lines) {
    if (line.trim() === '') continue
    paragraph += 1
    const marks: string[] = []
    if (block.punctuation.spaces) {
      if (line.startsWith(' ')) marks.push('段首半角空格')
      if (line.endsWith(' ')) marks.push('段尾半角空格')
    }
    if (marks.length > 0) margins.set(paragraph, marks)
  }

  for (const [index, span] of spans.entries()) {
    const text = span.text
    const marks: string[] = [...(margins.get(index + 1) ?? [])]
    if (block.punctuation.halfwidth) {
      for (let at = 0; at < text.length; at += 1) {
        const char = text[at]!
        if (!HALFWIDTH_MARKS.has(char)) continue
        const left = text[at - 1]
        const right = text[at + 1]
        const touchesChinese =
          (left !== undefined && CJK.test(left)) || (right !== undefined && CJK.test(right))
        if (!touchesChinese) continue
        // A mark inside a Latin/digit run (3.5%, 10,000, U.S., A/B) has no Chinese
        // on either side and never gets this far. A "both sides are Latin" guard
        // used to sit here; it could not be reached, because the check above
        // already returns for exactly that case.
        marks.push(`半角「${char}」`)
      }
    }
    if (block.punctuation.spaces) {
      for (let at = 1; at < text.length; at += 1) {
        if (text[at] !== ' ') continue
        const left = text[at - 1]
        const right = text[at + 1]
        if (left !== undefined && right !== undefined && CJK.test(left) && CJK.test(right)) {
          marks.push('中文字之间的半角空格')
          break
        }
      }
    }
    for (const symbol of block.punctuation.odd_symbols) {
      if (symbol !== '' && text.includes(symbol)) marks.push(`特殊符号「${symbol}」`)
    }
    if (marks.length === 0) continue
    results.push(
      v(
        SELFCHECK_RULES.PUNCT_STANDARD,
        'blocker',
        index + 1,
        `${[...new Set(marks)].join('；')}；near "${excerpt(text, 20)}"`,
      ),
    )
  }
  return results
}

/* ---------------------------------------------------------- S10 paragraph */

/**
 * S10 · 没有几百字的长段落，也没有三五个字就另起一段.
 *
 * The upper bound is `LONG_PARAGRAPH` and stays there. This rule owns the lower
 * bound only, and it skips dialogue lines: a one-word reply on its own line is
 * the form the item asks for elsewhere.
 */
const shortParagraph: Rule = (ctx) => {
  const block = selfcheckOf(ctx)
  if (block === null) return []
  const dominant = ctx.rulepack.punctuation.dialogue_dominant_ratio
  const paragraphs = splitParagraphsOf(ctx.text)
  const stub = (paragraph: string): boolean => {
    if (nonWsLength(paragraph) >= block.paragraph.min_chars) return false
    if (/^["“「『]/.test(paragraph)) return false
    return dialogueCharacterRatio(paragraph) < dominant
  }
  // WP7: a *run* of stubs is the habit the checklist describes. One four-character
  // paragraph is a beat ("咸。"), and reporting each one put this code at 2.97% of
  // paragraphs on a real manuscript.
  const results: Violation[] = []
  let runStart = -1
  for (let index = 0; index <= paragraphs.length; index += 1) {
    const paragraph = paragraphs[index]
    if (paragraph !== undefined && stub(paragraph)) {
      if (runStart === -1) runStart = index
      continue
    }
    const length = runStart === -1 ? 0 : index - runStart
    if (length >= block.paragraph.min_run) {
      results.push(
        v(
          SELFCHECK_RULES.SHORT_PARAGRAPH,
          'advisory',
          runStart + 1,
          `连续 ${length} 段只有三五个字（第 ${runStart + 1}…${index} 段，下限 ${block.paragraph.min_chars} 字，阈值 ${block.paragraph.min_run} 段）：${paragraphs
            .slice(runStart, index)
            .map((row) => `「${excerpt(row, 8)}」`)
            .join('')}`,
        ),
      )
    }
    runStart = -1
  }
  return results
}

/* ------------------------------------------------------- S11 line breaking */

const BREAK_TAILS = new Set(['，', ',', '、', '：', ':', '；', ';'])

/**
 * S11 · 完整的一句话放在同一段.
 *
 * A paragraph that ends on a comma, a colon or a dash and whose successor is not
 * a new line of dialogue was cut in the middle of a sentence.
 */
const midSentenceBreak: Rule = (ctx) => {
  const block = selfcheckOf(ctx)
  if (block === null) return []
  const paragraphs = splitParagraphsOf(ctx.text)
  const results: Violation[] = []
  for (let index = 0; index + 1 < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index]!
    const last = paragraph.at(-1)!
    const broken = BREAK_TAILS.has(last) || paragraph.endsWith('——') || paragraph.endsWith('—')
    if (!broken) continue
    const next = paragraphs[index + 1]!
    if (/^["“「『]/.test(next)) continue
    results.push(
      v(
        SELFCHECK_RULES.MID_SENTENCE_BREAK,
        'advisory',
        index + 1,
        `本段以「${paragraph.endsWith('——') ? '——' : last}」结尾，句子在段间被截断；下一段「${excerpt(next, 20)}」`,
      ),
    )
  }
  return results
}

/* ------------------------------------------------------- S12 chapter break */

const CHAPTER_END_CLOSERS = new Set(['。', '！', '？', '…', '"', '!', '?'])

/**
 * S12 · 在句子完整结束处，或者形成悬念的卡点位置分章.
 *
 * The machine half is mechanical: a chapter that ends mid-sentence cannot be a
 * cliffhanger, it is a truncation. Whether the ending creates a hook stays with
 * the model's `hook_strength`.
 */
const chapterEndOpen: Rule = (ctx) => {
  const block = selfcheckOf(ctx)
  if (block === null) return []
  const paragraphs = splitParagraphsOf(ctx.text)
  const last = paragraphs.at(-1)
  if (last === undefined) return []
  const end = last.at(-1)!
  if (CHAPTER_END_CLOSERS.has(end)) return []
  return [
    v(
      SELFCHECK_RULES.CHAPTER_END_OPEN,
      'advisory',
      paragraphs.length,
      `正文以「${end}」结尾，句子没有结束；最后一段「${excerpt(last)}」`,
    ),
  ]
}

/* -------------------------------------------------------- S13 transition */

/**
 * S13 · 省略号、分割线只用于场景转换.
 *
 * `SCENE_SEPARATOR` keeps ownership and is *stricter* than the checklist: a
 * separator is banned outright, not only outside a scene change. This extension
 * adds the one form the pack's list cannot express — a paragraph that is nothing
 * but ellipses or dashes — to the same owner instead of inventing a new code.
 */
const separatorOnlyParagraph: Rule = (ctx) => {
  // 0.2.19: the extension travels with the block it belongs to. `SCENE_SEPARATOR`
  // itself predates 0.2.19 and keeps firing on any pack; only this *new* trigger
  // is gated, so a pre-0.2.19 pack still reports exactly what it used to.
  if (selfcheckOf(ctx) === null) return []
  const results: Violation[] = []
  for (const [index, paragraph] of splitParagraphsOf(ctx.text).entries()) {
    if (!/^[…—\u2026\u2014]+$/u.test(paragraph)) continue
    results.push(
      v(
        FORMAT_RULES.SCENE_SEPARATOR,
        'blocker',
        index + 1,
        `整段只有「${paragraph}」，按分割线处理；转场不需要符号`,
      ),
    )
  }
  return results
}

/* ----------------------------------------------------------------- plumbing */

/**
 * The eleven implementations. `METAPHOR_STACK` … `CHAPTER_END_OPEN` are
 * registered here; `separatorOnlyParagraph` extends the existing
 * `SCENE_SEPARATOR` owner, so it is merged into that rule by `checks.ts`.
 */
export const SELFCHECK_RULE_IMPLEMENTATIONS: Readonly<Record<string, Rule>> = {
  [SELFCHECK_RULES.METAPHOR_STACK]: metaphorStack,
  [SELFCHECK_RULES.PROSE_ABSTRACT]: proseAbstract,
  [SELFCHECK_RULES.FRAME_REPEAT]: frameRepeat,
  [SELFCHECK_RULES.PARALLEL_RUN]: parallelRun,
  [SELFCHECK_RULES.ENUMERATION]: enumeration,
  [SELFCHECK_RULES.DIALOGUE_RUN]: dialogueRun,
  [SELFCHECK_RULES.QUOTE_UNBALANCED]: quoteUnbalanced,
  [SELFCHECK_RULES.PUNCT_STANDARD]: punctStandard,
  [SELFCHECK_RULES.SHORT_PARAGRAPH]: shortParagraph,
  [SELFCHECK_RULES.MID_SENTENCE_BREAK]: midSentenceBreak,
  [SELFCHECK_RULES.CHAPTER_END_OPEN]: chapterEndOpen,
}

export { separatorOnlyParagraph }

/* ------------------------------------------------------- the thirteen items */

/**
 * The checklist itself: thirteen rows, fixed order, one basis each.
 *
 * `check:docs` asserts `docs/selfcheck.md` against this table line by line, so
 * the document an author reads and the decision the engine makes cannot drift
 * apart — the same discipline the tool count and the gate order already follow.
 */
export interface SelfCheckSpecEntry {
  id: SelfCheckId
  category: 'voice' | 'layout'
  title: string
  basis: SelfCheckBasis
  /** Every code that can make this row fail. */
  codes: readonly string[]
  /** The subject the row judges; a chapter without it reports `na`. */
  requires: 'text' | 'dialogue'
}

export const SELF_CHECK_SPEC: readonly SelfCheckSpecEntry[] = [
  {
    id: 'SC-METAPHOR',
    category: 'voice',
    title: '比喻：只保留最贴切的一个，其余全部删掉',
    basis: 'hybrid',
    codes: [SELFCHECK_RULES.METAPHOR_STACK, STYLE_RULES.METAPHOR_DENSITY],
    requires: 'text',
  },
  {
    id: 'SC-CONCRETE',
    category: 'voice',
    title: '画面感：过于精确或抽象的描写删掉，不能想象出具体画面的描写也删掉',
    basis: 'model',
    codes: [SELFCHECK_RULES.PROSE_ABSTRACT],
    requires: 'text',
  },
  {
    id: 'SC-FORMULA',
    category: 'voice',
    title: '固定句式：没有重复使用由相同关联词构成的固定句式',
    basis: 'hybrid',
    codes: [SELFCHECK_RULES.FRAME_REPEAT, STYLE_RULES.BANNED_PATTERN],
    requires: 'text',
  },
  {
    id: 'SC-PARALLEL',
    category: 'voice',
    title: '短句排比：没有反复使用结构相同或者一行一句的排比短句',
    basis: 'hybrid',
    codes: [SELFCHECK_RULES.PARALLEL_RUN, PUNCTUATION_RULES.UNIFORM_SENTENCE],
    requires: 'text',
  },
  {
    id: 'SC-LIST',
    category: 'voice',
    title: '清单罗列：不用大段文字罗列清单（系统面板、任务列表等除外）',
    basis: 'hybrid',
    codes: [SELFCHECK_RULES.ENUMERATION],
    requires: 'text',
  },
  {
    id: 'SC-DIALOGUE-BEAT',
    category: 'voice',
    title: '短对话：短对话之间穿插了动作、神态或场景',
    basis: 'hybrid',
    codes: [SELFCHECK_RULES.DIALOGUE_RUN],
    requires: 'dialogue',
  },
  {
    id: 'SC-DASH',
    category: 'layout',
    title: '破折号：慎用，只在真正需要补充说明或语气转变时使用',
    basis: 'machine',
    codes: [PUNCTUATION_RULES.DASH_BUDGET],
    requires: 'text',
  },
  {
    id: 'SC-QUOTE',
    category: 'layout',
    title: '对话标点：人物对话使用引号，对话与旁白区分清楚',
    basis: 'hybrid',
    codes: [SELFCHECK_RULES.QUOTE_UNBALANCED, FORMAT_RULES.ILLEGAL_QUOTE],
    requires: 'dialogue',
  },
  {
    id: 'SC-PUNCT',
    category: 'layout',
    title: '标点统一：中文全角标点，不留空格，也没有使用特殊符号',
    basis: 'machine',
    codes: [SELFCHECK_RULES.PUNCT_STANDARD, FORMAT_RULES.SEMICOLON, FORMAT_RULES.ENGLISH_ELLIPSIS],
    requires: 'text',
  },
  {
    id: 'SC-PARAGRAPH',
    category: 'layout',
    title: '段落：没有几百字的长段落，也没有三五个字就另起一段',
    basis: 'machine',
    codes: [FORMAT_RULES.LONG_PARAGRAPH, SELFCHECK_RULES.SHORT_PARAGRAPH],
    requires: 'text',
  },
  {
    id: 'SC-LINEBREAK',
    category: 'layout',
    title: '分行：完整的一句话放在同一段，没有在中间随意回车',
    basis: 'machine',
    codes: [SELFCHECK_RULES.MID_SENTENCE_BREAK],
    requires: 'text',
  },
  {
    id: 'SC-CHAPTER-BREAK',
    category: 'layout',
    title: '分章：在句子完整结束处，或者形成悬念的卡点位置分章',
    basis: 'hybrid',
    codes: [SELFCHECK_RULES.CHAPTER_END_OPEN],
    requires: 'text',
  },
  {
    id: 'SC-TRANSITION',
    category: 'layout',
    title: '转场：省略号、分割线只用于场景转换、时间跳转，没有乱入',
    basis: 'machine',
    codes: [FORMAT_RULES.SCENE_SEPARATOR],
    requires: 'text',
  },
]

/** One model answer supplied through `novel_check`. */
export interface SelfCheckAnswer {
  id: SelfCheckId
  verdict: 'pass' | 'fail'
  note: string
  evidence?: string
}

export interface SelfCheckInput {
  text: string
  chapter: number
  contentHash: string
  violations: readonly Violation[]
  answers?: readonly SelfCheckAnswer[]
}

const evidenceOf = (text: string, violations: readonly Violation[], limit = 4): SelfCheckEvidence[] => {
  const paragraphs = splitParagraphsOf(text)
  const rows: SelfCheckEvidence[] = []
  const seen = new Set<number>()
  for (const violation of violations) {
    const paragraph = violation.location.paragraph
    if (paragraph === undefined || seen.has(paragraph)) continue
    seen.add(paragraph)
    const source = paragraphs[paragraph - 1] ?? ''
    rows.push({ paragraph, quote: excerpt(source, 40), detail: violation.detail })
    if (rows.length >= limit) break
  }
  return rows
}

/**
 * Build the thirteen rows for one chapter.
 *
 * The one non-obvious rule is the hybrid/model split. A machine finding can
 * never be talked out of: if any code behind a `hybrid` row fired, the row fails
 * whatever the model submitted (plan §5, invariant 5). The reverse is allowed —
 * a `model` row may pass while `PROSE_ABSTRACT` fired, because "is this
 * imaginable" is exactly the question the machine cannot answer.
 */
export function buildSelfCheck(input: SelfCheckInput): SelfCheckDocument {
  const answers = new Map((input.answers ?? []).map((answer) => [answer.id, answer]))
  const textEmpty = input.text.trim() === ''
  const hasDialogue = input.text.includes('"')
  const items: SelfCheckItem[] = SELF_CHECK_SPEC.map((entry) => {
    const fired = input.violations.filter((violation) => entry.codes.includes(violation.code))
    const answer = answers.get(entry.id)
    const row: SelfCheckItem = {
      id: entry.id,
      category: entry.category,
      title: entry.title,
      basis: entry.basis,
      verdict: 'pass',
      codes: [...entry.codes],
      evidence: evidenceOf(input.text, fired),
    }
    const notes: string[] = []
    if (textEmpty) {
      row.verdict = 'na'
      row.evidence = []
      notes.push('本章没有正文')
    } else if (entry.requires === 'dialogue' && !hasDialogue) {
      row.verdict = 'na'
      row.evidence = []
      notes.push('本章没有对白')
    } else if (entry.basis === 'machine') {
      row.verdict = fired.length > 0 ? 'fail' : 'pass'
    } else if (entry.basis === 'hybrid') {
      if (fired.length > 0) {
        row.verdict = 'fail'
        notes.push('机器已给出证据：模型不得改判为 pass')
      } else if (answer === undefined) {
        // Nothing mechanical to show and no judgement offered: the machine half
        // passed, so the row passes, but the receipt says the other half is
        // missing rather than pretending a model read it.
        notes.push('机器未发现证据；本章没有模型判定')
      } else {
        row.verdict = answer.verdict
        notes.push(answer.note)
        if (answer.evidence !== undefined && answer.evidence.trim() !== '') {
          row.evidence = [...row.evidence, { paragraph: 0, quote: answer.evidence, detail: '模型给出的理由' }]
        }
      }
    } else if (answer !== undefined) {
      row.verdict = answer.verdict
      notes.push(answer.note)
      if (answer.evidence !== undefined && answer.evidence.trim() !== '') {
        row.evidence = [...row.evidence, { paragraph: 0, quote: answer.evidence, detail: '模型给出的理由' }]
      }
    } else if (fired.length > 0) {
      row.verdict = 'na'
      notes.push(`机器已标出 ${fired.length} 段抽象描写，等待模型判定「可成像 / 不可成像」`)
    } else {
      notes.push('机器未标出需要判定的段落')
    }
    if (notes.length > 0) row.note = notes.join('；')
    return row
  })
  return {
    schema_version: 1,
    chapter: input.chapter,
    content_hash: input.contentHash,
    items,
    summary: {
      pass: items.filter((item) => item.verdict === 'pass').length,
      fail: items.filter((item) => item.verdict === 'fail').length,
      na: items.filter((item) => item.verdict === 'na').length,
    },
  }
}

/** Spec entry for one id, or undefined for an unknown id. */
export function selfCheckSpec(id: string): SelfCheckSpecEntry | undefined {
  return SELF_CHECK_SPEC.find((entry) => entry.id === id)
}
