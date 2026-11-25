import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { compileRulepack } from '../src/rules/compiler.js'
import { runMachineChecks } from '../src/rules/pipeline.js'
import type { MachineOptions } from '../src/rules/pipeline.js'
import type { Rulepack } from '../src/rules/types.js'
import {
  archiveDelta,
  bootstrapToDraft,
  cleanText,
  FIXTURE_WAIVERS,
  harness,
  sampleReview,
  sampleSemantic,
  sampleSummary,
  writeDraft,
} from './helpers.js'

/**
 * 0.2.20 WP3: the write path must not lose a row silently.
 *
 * Every test here is an invariant an author relies on: amending one document
 * cannot delete a row from it, a replay key covers every input that changes the
 * result, and a restore cannot leave a reference dangling. Each one was checked
 * against 0.2.19 first; the red state is recorded in
 * `docs/0.2.20-implementation-log.md`.
 */
describe('0.2.20 WP3: amend keeps every ledger row', () => {
  it('refuses to drop a worldbook row without allow_delete', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '账本之书', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      const worldbook = {
        schema_version: 1 as const,
        updated_at: '2026-01-01T00:00:00.000Z',
        premise: '一座旧城',
        setting: '雨夜',
        rules: [{ name: '没有超能力', description: '一切都有代价' }],
        factions: [{ name: '码头帮', description: '管着水路', goal: '守住码头' }],
        locations: [
          { name: '码头', description: '旧码头', layout: '石阶与货栈', capacity: 40 },
          { name: '当铺', description: '窄门面', layout: '一进三间', capacity: 8 },
        ],
        characters: [{ name: '周慎', role: '主角', description: '账房先生', arc: '从旁观到动手' }],
        glossary: [{ term: '蜡印', definition: '封口用的暗红印记' }],
        backstory: [{ time: '二十年前', event: '旧案未结' }],
        facts: [{ alias: '白银', value: 120, unit: '两' }],
        themes: ['旧账'],
      }
      await engine.amend({ path: 'outline/worldbook.yaml', content: worldbook, reason: '建立世界观', root })

      // Drop one location: a truncated page or a careless rewrite must not erase
      // an entity the manuscript already cites.
      const truncated = { ...worldbook, locations: [worldbook.locations[0]!] }
      await expect(
        engine.amend({ path: 'outline/worldbook.yaml', content: truncated, reason: 'trim', root }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })

      // 0.2.20 WP3: the blanket flag is gone. Naming the row is the only way,
      // and a named row that is not actually missing is reported as a typo.
      await expect(
        engine.amend({
          path: 'outline/worldbook.yaml',
          content: truncated,
          reason: 'merge the two shops',
          allow_delete: true,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({
          path: 'outline/worldbook.yaml',
          content: truncated,
          reason: 'typo',
          deleted: ['locations.name:仓库'],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const allowed = await engine.amend({
        path: 'outline/worldbook.yaml',
        content: truncated,
        reason: 'merge the two shops',
        deleted: ['locations.name:当铺'],
        root,
      })
      expect(allowed.data).toBeDefined()
      const after = (await engine.queryState({ kind: 'worldbook', root })).data as {
        locations: unknown[]
      }
      expect(after.locations).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })

  it('refuses to drop a glossary term, a backstory row or a declared fact', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '账本之书', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      const base = {
        schema_version: 1 as const,
        updated_at: '2026-01-01T00:00:00.000Z',
        premise: '',
        setting: '',
        rules: [],
        factions: [],
        locations: [],
        characters: [],
        glossary: [
          { term: '蜡印', definition: '封口' },
          { term: '合账', definition: '月底对账' },
        ],
        backstory: [{ time: '二十年前', event: '旧案' }],
        facts: [{ alias: '白银', value: 120, unit: '两' }],
        themes: [],
      }
      await engine.amend({ path: 'outline/worldbook.yaml', content: base, reason: '建立', root })
      await expect(
        engine.amend({
          path: 'outline/worldbook.yaml',
          content: { ...base, glossary: [base.glossary[0]!] },
          reason: 'trim',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({
          path: 'outline/worldbook.yaml',
          content: { ...base, facts: [] },
          reason: 'trim',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({
          path: 'outline/worldbook.yaml',
          content: { ...base, backstory: [] },
          reason: 'trim',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.20 WP3: the replay key covers every input', () => {
  it('does not treat a changed acknowledge_until_chapter as the same check', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = `${cleanText()}\n\n账本一：2 × 3 = 7。\n\n账本二：4 × 5 = 19。`
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      await engine.getBrief({ stage: 'P6', root })
      // Content-only to start: a full-scope pass would move the pipeline to
      // ready_to_archive and the follow-up checks would be refused by stage
      // order instead of exercising the replay key.
      const first = await engine.runCheck({
        chapter: 1,
        scope: ['content'],
        semantic: sampleSemantic(text),
        root,
      })
      const advisory = first.data.advisory_instances[0]!
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({
        chapter: 1,
        scope: ['content'],
        semantic: sampleSemantic(text),
        acknowledge: [advisory.id],
        acknowledge_reasons: { [advisory.id]: '已知' },
        acknowledge_until_chapter: 5,
        root,
      })
      const five = (await engine.queryState({ kind: 'check', chapter: 1, root })).data as {
        machine: { acknowledged_findings?: Array<{ expires_at_chapter?: number }> }
      }
      expect(five.machine.acknowledged_findings?.[0]?.expires_at_chapter).toBe(5)

      // Same findings, same reasons, different expiry. If the expiry is not part
      // of the replay key the second call is "the same attempt" and the stored
      // expiry silently stays at 5.
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({
        chapter: 1,
        scope: ['content'],
        semantic: sampleSemantic(text),
        acknowledge: [advisory.id],
        acknowledge_reasons: { [advisory.id]: '已知' },
        acknowledge_until_chapter: 9,
        root,
      })
      const nine = (await engine.queryState({ kind: 'check', chapter: 1, root })).data as {
        machine: { acknowledged_findings?: Array<{ expires_at_chapter?: number }> }
      }
      expect(nine.machine.acknowledged_findings?.[0]?.expires_at_chapter).toBe(9)
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.20 WP3: a damaged historical document is repairable', () => {
  it('returns a historical review and check as {error, message, path, raw} instead of throwing', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(text),
        self_check_waivers: FIXTURE_WAIVERS,
        root,
      })
      await engine.getBrief({ stage: 'P8', root })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      // Chapter 2 becomes active; chapter 1's review and check are historical.
      await writeFile(join(root, 'reviews/ch001.review.yaml'), 'dimensions: [unclosed\n', 'utf8')
      await writeFile(join(root, 'checks/ch001.check.yaml'), 'verdict: [unclosed\n', 'utf8')
      const review = (await engine.queryState({ kind: 'review', chapter: 1, root })).data as Record<
        string,
        unknown
      >
      expect(review.error).toBe('REVIEW_UNREADABLE')
      expect(review.path).toBe('reviews/ch001.review.yaml')
      expect(String(review.raw)).toContain('unclosed')
      const check = (await engine.queryState({ kind: 'check', chapter: 1, root })).data as Record<
        string,
        unknown
      >
      expect(check.error).toBe('CHECK_UNREADABLE')
      expect(String(check.raw)).toContain('unclosed')
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.20 WP3: a malformed summary is a schema error, not a crash', () => {
  it('names the field and the expected shape instead of throwing a TypeError', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      await engine.getBrief({ stage: 'P3', root })
      const bad = { ...sampleSummary(), continuity: 'next chapter' }
      await expect(
        engine.submitDraft({
          chapter: 1,
          content: cleanText(),
          chapter_title: '开端之雨',
          scene_type: '日常过渡章',
          narrator: '他',
          summary: bad as never,
          root,
        }),
      ).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
        message: expect.stringContaining('summary.continuity'),
        details: expect.objectContaining({ field: 'summary' }),
      })
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.20 WP3: a multi-stage brief stamps each book with its own round', () => {
  it('shows the review round on P4 and the revision round on P5 in one call', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      const issue = {
        id: 'REV-001',
        severity: 'blocker' as const,
        dimension: 'R-W-01',
        location: '第 1 段',
        problem: '缺动机',
        fix: '补一句',
        status: 'open' as const,
      }
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text, { issues: [issue] }), root })
      await engine.getBrief({ stage: 'P5', root })
      const revised = text.replace('不快不慢', '忽快忽慢')
      await engine.submitRevision({
        chapter: 1,
        content: revised,
        issues: [{ ...issue, status: 'fixed', evidence: '走廊尽头传来脚步声，忽快忽慢，在门口停了两秒' }],
        proof: sampleReview(1, revised).proof,
        root,
      })
      // Second review clears the blocker: review=2, revise=1, stage=P6.
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, revised), root })
      const both = await engine.getBrief({ stages: ['P4', 'P5'], root })
      const books = both.data.briefs ?? []
      const p4 = books.find((book) => book.stage === 'P4')!
      const p5 = books.find((book) => book.stage === 'P5')!
      // The active stage is P6, which is neither P4 nor P5. The old code read
      // the counter from the *pipeline* stage, so both books said "round 3";
      // each book must name the counter it will consume.
      expect(p4.content).toContain('第 3 轮')
      expect(p5.content).toContain('第 2 轮')
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.20 WP3: the tool schema cannot fall behind the engine', () => {
  it('lets novel_amend target every path the engine accepts, including briefs.yaml', async () => {
    const { createNovelTools } = await import('../src/tools/index.js')
    const tools = createNovelTools({} as never) as unknown as Array<{
      name: string
      parameters: { properties: Record<string, { enum?: readonly string[] }> }
    }>
    const amend = tools.find((tool) => tool.name === 'novel_amend')!
    const paths = amend.parameters.properties.path?.enum ?? []
    expect(paths).toContain('state/briefs.yaml')
    expect(paths).toContain('outline/worldbook.yaml')
  })
})

describe('0.2.20 WP3: an outline card typo is rejected by name', () => {
  it('lists the unknown field and the allowed set', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '章卡之书', genre: '都市现代', platform: 'fanqie', root })
      await expect(
        engine.submitOutline({
          chapters: [
            {
              num: 1,
              title: '开端之雨',
              scene_type: '日常过渡章',
              goal: '动机',
              conflict: '阻力',
              hook: '钩子',
              target_words: [80, 400],
              targetWords: [80, 400],
            } as never,
          ],
          root,
        }),
      ).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
        message: expect.stringContaining('targetWords'),
        details: expect.objectContaining({ received: ['targetWords'] }),
      })
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.20 WP3: filesystem failures carry an actionable code', () => {
  it('names a too-long path instead of leaking the libuv message', async () => {
    const { FsStore } = await import('../src/store/fs.js')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const root = await mkdtemp(join(tmpdir(), 'novel-path-'))
    try {
      const store = new FsStore(root)
      await expect(store.writeText(`${'x'.repeat(300)}.yaml`, 'value: 1\n')).rejects.toMatchObject({
        code: 'ENGINE_IO_PATH_TOO_LONG',
        hint: expect.stringContaining('shorten the project root path'),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('0.2.20 WP3: the Markdown export cannot gain structure from prose', () => {
  it('escapes a paragraph that starts with heading, quote or list syntax', async () => {
    const { renderMarkdown } = await import('../src/export/render.js')
    const markdown = renderMarkdown(
      {
        schema_version: 1,
        title: '书',
        genre: '都市现代',
        platform: 'fanqie',
        author: '',
        description: '',
        created_at: '2026-01-01',
        targets: { words_per_chapter: [80, 400], total_chapters: null, dialogue_ratio: [0.1, 0.9] },
      },
      [
        {
          num: 1,
          title: '开端',
          text: '# 这不是标题\n\n> 这不是引用\n\n- 这不是列表\n\n普通的段落。',
        },
      ] as never,
    )
    expect(markdown).toContain('\\# 这不是标题')
    expect(markdown).toContain('\\> 这不是引用')
    expect(markdown).toContain('\\- 这不是列表')
    expect(markdown).toContain('普通的段落。')
    // The chapter heading itself is still real structure.
    expect(markdown).toContain('## 第1章 开端')
  })
})

describe('0.2.20 WP3: audit filters fail loudly', () => {
  it('rejects an unknown op instead of returning an empty page', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '审计之书', genre: '都市现代', platform: 'fanqie', root })
      await expect(engine.auditHistory({ op: 'submitDraftt', root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
        message: expect.stringContaining('submitDraftt'),
        details: expect.objectContaining({ field: 'op', allowed: expect.arrayContaining(['submitDraft']) }),
      })
      const ok = await engine.auditHistory({ op: 'initProject', root })
      expect(ok.data.length).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.20 WP3: word count says what it counted', () => {
  it('labels the active-chapter mode and names the chapter', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      const active = await engine.countWords({ root })
      expect(active.data.mode).toBe('active-chapter')
      expect(active.data.counted_chapter).toBe(1)
      expect(active.data.total_word_count).toBeGreaterThan(0)
      const explicit = await engine.countWords({ chapter: 1, root })
      expect(explicit.data.mode).toBe('chapter')
      const literal = await engine.countWords({ text: '一 二 三' })
      expect(literal.data.mode).toBeUndefined()
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.20 WP3: entity anchors and reading proofs agree on "in the text"', () => {
  it('accepts an anchor whose punctuation the manuscript renders as full-width', async () => {
    const { matchEntityText } = await import('../src/engine/entity-anchors.js')
    const { matchEvidence } = await import('../src/domain/text.js')
    // The manuscript quotes dialogue with 「」; the anchor was written with
    // ASCII quotes and no whitespace. PG-09 folds quote style and whitespace
    // before matching; a raw `includes` did not, so the same quote was valid for
    // one gate and missing for the other.
    const text = '他推开门，雨声涌了进来：「屋里没人。」'
    const anchor = '他推开门，雨声涌了进来："屋里没人。"'
    expect(matchEvidence(text, anchor).found).toBe(true)
    expect(matchEntityText(text, '码头', [anchor]).ok).toBe(true)
  })
})

describe('0.2.20 WP6: the docs agree with the engine', () => {
  it('documents the 0.2.20 contract additions the tool surface actually has', async () => {
    const { readFileSync } = await import('node:fs')
    const tools = readFileSync('docs/tools.md', 'utf8')
    for (const needle of [
      'context_meta',
      'self_check_waivers',
      'machine_scores',
      'scoring_basis',
      'strict_cross',
      'quotes: ascii | curly',
      'ENGINE_IO_DISK_FULL',
    ]) {
      expect(tools, `docs/tools.md must document ${needle}`).toContain(needle)
    }
    const readme = readFileSync('README.md', 'utf8')
    // The golden path must offer the mandatory style choice with every pack id.
    for (const pack of [
      'cold-suspense',
      'hot-blooded-fast',
      'ensemble-power',
      'infinite-flow',
      'light-daily',
      'romance-push-pull',
      'steady-farming',
      'weird-horror',
      'none',
    ]) {
      expect(readme, `README must list the ${pack} pack id`).toContain(pack)
    }
  })
})

describe('0.2.20 WP6: the quality tab names its yardstick', () => {
  it('reports how many samples the engine scored and how many are self-report', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      const review = sampleReview(1, text)
      await engine.submitReview({ chapter: 1, ...review, root })
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(text),
        self_check_waivers: FIXTURE_WAIVERS,
        root,
      })
      await engine.getBrief({ stage: 'P8', root })
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const section = await engine.panelSection({ root, section: 'quality' })
      const quality = (section.items as { quality?: { scoring_basis?: unknown } }).quality
      expect(quality?.scoring_basis).toBeDefined()
      expect(quality?.scoring_basis).toMatchObject({
        machine: expect.any(Number),
        self_report: expect.any(Number),
      })
      // A chapter reviewed with `machine_scores` present is scored by the engine.
      expect((quality?.scoring_basis as { machine: number }).machine).toBe(1)
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.20 WP5: the zero-tolerance lexicon can fire inside a sentence', () => {
  const pack = () =>
    compileRulepack(
      structuredClone(parseYaml(readFileSync('rulepacks/default.yaml', 'utf8')) as Record<string, unknown>),
    )
  const options = (text: string): MachineOptions => ({
    chapter: 1,
    title: null,
    genre: '都市现代',
    sceneType: '日常过渡章',
    rulepack: pack(),
    summary: null,
    evidence: {
      characters: null,
      previousText: null,
      previousTexts: [],
      foreshadows: null,
      timeline: null,
      relationships: null,
      world: null,
      locks: null,
    },
    ...{ text },
  })
  const codes = (text: string) =>
    runMachineChecks(text, options(text)).violations.map((violation) => violation.code)

  it('flags 不禁 / 仿佛 / 似乎 in normal prose, not only between punctuation', () => {
    // The old `standalone` mode required punctuation on both sides, so these
    // three terms — the ones the mode was written for — never matched.
    expect(codes('他不禁笑了。')).toContain('LEX_ZERO_TOLERANCE')
    expect(codes('她仿佛看见了什么。')).toContain('LEX_ZERO_TOLERANCE')
    expect(codes('他似乎不太愿意。')).toContain('LEX_ZERO_TOLERANCE')
  })

  it('still ignores the term when a neighbour makes it part of a longer word', () => {
    // `excludeLeft` / `excludeRight` are the compound guard; the default pack
    // lists none for these three, so a pack that needs one declares it.
    const custom = structuredClone(pack()) as Rulepack
    const entry = custom.lexicon.zero_tolerance.find((row) => row.term === '似乎')
    entry!.excludeRight = ['是']
    const text = '他似乎是走了。'
    const hits = runMachineChecks(text, {
      ...options(text),
      rulepack: custom,
    }).violations.filter((violation) => violation.code === 'LEX_ZERO_TOLERANCE')
    expect(hits).toEqual([])
  })
})

describe('0.2.20 WP5: duplicate detection uses bigrams, not SimHash', () => {
  const pack = () =>
    compileRulepack(
      structuredClone(parseYaml(readFileSync('rulepacks/default.yaml', 'utf8')) as Record<string, unknown>),
    )
  const run = (text: string, previous: string) =>
    runMachineChecks(text, {
      chapter: 2,
      title: null,
      genre: '都市现代',
      sceneType: '日常过渡章',
      rulepack: pack(),
      summary: null,
      evidence: {
        characters: null,
        previousText: previous,
        previousTexts: [previous],
        previousChapterNums: [1],
        foreshadows: null,
        timeline: null,
        relationships: null,
        world: null,
        locks: null,
      },
    }).violations.filter((violation) => violation.code === 'DUPLICATE_PARAGRAPH')

  it('flags a copied paragraph', () => {
    const paragraph = '雨打在窗上，他数着檐下的水声，一直数到第三十六下才停下来，然后把手里的信折好放进内袋。'
    const hits = run(`${paragraph}\n\n门开了，来人没有抬头。`, paragraph)
    expect(hits).toHaveLength(1)
    // Blocker requires a shared 8-character run *and* the similarity threshold;
    // the advisory alone is the rule doing its job on a verbatim copy.
    expect(['blocker', 'advisory']).toContain(hits[0]!.severity)
  })

  it('stays silent on unrelated prose that shares only common bigrams', () => {
    // SimHash scored pairs like these around 0.7, which is why the advisory line
    // had to sit above 0.75 and still fired on ordinary chapters.
    const previous = '雨打在窗上，他数着檐下的水声，一直数到第三十六下才停下来，然后把手里的信折好放进内袋。'
    const current = '码头上的风比城里硬，吹得人睁不开眼。他把帽檐压低，顺着货栈的阴影往北走，脚下全是碎木屑。'
    expect(run(current, previous)).toEqual([])
  })
})

describe('0.2.20 WP5: METAPHOR_STACK needs a concrete vehicle', () => {
  const pack = () =>
    compileRulepack(
      structuredClone(parseYaml(readFileSync('rulepacks/default.yaml', 'utf8')) as Record<string, unknown>),
    )
  const codes = (text: string, sceneType: '日常过渡章' | '战斗/动作章' = '日常过渡章') =>
    runMachineChecks(text, {
      chapter: 1,
      title: null,
      genre: '都市现代',
      sceneType,
      rulepack: pack(),
      summary: null,
      evidence: {
        characters: null,
        previousText: null,
        previousTexts: [],
        foreshadows: null,
        timeline: null,
        relationships: null,
        world: null,
        locks: null,
      },
    }).violations.map((violation) => violation.code)

  it('reports a stack of similes that each name an object', () => {
    // Two concrete vehicles in one sentence: this is the shape the rule exists
    // for, and the pack's `concrete_anchors` confirm both.
    expect(codes('她的眼睛像两口井，像两潭死水。')).toContain('METAPHOR_STACK')
  })

  it('stays silent when the anchor is a verb suffix rather than an object', () => {
    // 「说不出口」 contains 口, but 口 is the tail of 出口, not something to
    // picture; the vehicle test excludes an anchor that follows a verb suffix.
    expect(codes('他心里像是被什么东西压着，像是说不出口，又像是忘了。')).not.toContain('METAPHOR_STACK')
  })

  it('raises the short-paragraph threshold in an action chapter', () => {
    // Three one-beat paragraphs are choreography in a fight scene and a habit in
    // a quiet one.
    const beats = ['他一刀。', '对面退了。', '他跟上。', '门在身后合上，走廊里只剩下雨声。'].join('\n\n')
    expect(codes(beats, '日常过渡章')).toContain('SHORT_PARAGRAPH')
    expect(codes(beats, '战斗/动作章')).not.toContain('SHORT_PARAGRAPH')
  })
})

describe('0.2.20 WP6-C: panel tab counts describe what the tab holds', () => {
  it('counts the quality tab as 15 dimensions + 13 checklist rows, and health as its findings', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      await engine.getBrief({ stage: 'P6', root })
      await engine.runCheck({
        chapter: 1,
        semantic: sampleSemantic(text),
        self_check_waivers: FIXTURE_WAIVERS,
        root,
      })
      await engine.getBrief({ stage: 'P8', root })
      // The book-level quality block reads archived chapters, so the fixture has
      // to archive before the tab has anything to count.
      await engine.archiveChapter({ chapter: 1, state_delta: archiveDelta(sampleSummary()), root })
      const quality = await engine.panelSection({ root, section: 'quality' })
      // The count is what the tab holds — fifteen score dimensions plus however
      // many checklist rows the book has — not "1 payload object". The rows are
      // per-archived-chapter, so the assertion is relational rather than a
      // hard-coded 28: a book with one archived chapter has thirteen.
      const qualityItems = quality.items as {
        dimensions?: unknown[]
        self_check?: { items?: unknown[] } | null
      }
      expect(qualityItems.dimensions).toHaveLength(15)
      const rows = qualityItems.self_check?.items?.length ?? 0
      expect(quality.total).toBe(15 + rows)
      const health = await engine.panelSection({ root, section: 'health' })
      expect(health.total).toBe(0)
      const items = health.items as { blocking?: unknown[]; state_errors?: unknown[] }
      expect(health.total).toBe((items.blocking?.length ?? 0) + (items.state_errors?.length ?? 0))
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.20 WP6-C: the worldbook preview says how much it shows', () => {
  it('caps each structured group at 20 rows and reports the real total', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '预览之书', genre: '都市现代', platform: 'fanqie', root })
      await engine.getBrief({ stage: 'P1', root })
      const locations = Array.from({ length: 35 }, (_, index) => ({
        name: `地点${index + 1}`,
        description: `第 ${index + 1} 处`,
        layout: '一进三间',
        capacity: 10,
      }))
      await engine.amend({
        path: 'outline/worldbook.yaml',
        reason: '灌入地点',
        content: {
          schema_version: 1,
          updated_at: '2026-01-01T00:00:00.000Z',
          premise: '',
          setting: '',
          rules: [],
          factions: [],
          locations,
          characters: [],
          glossary: [],
          backstory: [],
          facts: [],
          themes: [],
        },
        root,
      })
      const section = await engine.panelSection({ root, section: 'worldbook' })
      const counts = (section as { counts?: Record<string, { total: number; shown: number }> }).counts
      expect(counts?.locations).toEqual({ total: 35, shown: 20 })
      expect(section.truncated).toBe(true)
    } finally {
      await cleanup()
    }
  })
})

describe('0.2.20 WP3: doctor reports backups no transaction claims', () => {
  it('names orphan backup directories instead of deleting them', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await bootstrapToDraft({ root, engine })
      const text = cleanText()
      await writeDraft({ root, engine, text })
      await engine.getBrief({ stage: 'P4', root })
      await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
      // A crashed transaction: a directory with the marker and manifest but no
      // journal row. `listBackups` shows it; `novel_restore` cannot use it.
      const orphan = '11111111-1111-1111-1111-111111111111'
      await mkdir(join(root, 'backups', orphan), { recursive: true })
      await writeFile(join(root, 'backups', orphan, '.engine-backup'), '', 'utf8')
      await writeFile(join(root, 'backups', orphan, 'manifest.json'), '{}', 'utf8')
      const report = await engine.doctor({ root })
      const check = (
        report.data.checks as Array<{ id: string; severity: string; detail: string; hint?: string }>
      ).find((entry) => entry.id === 'backups')!
      expect(check.severity).toBe('warning')
      expect(check.detail).toContain('1 个没有对应事务')
      expect(check.hint).toContain(orphan)
      // It reports and tells the user what to do; nothing was deleted.
      expect(await engine.queryState({ kind: 'backups', root })).toBeDefined()
      const listed = (await engine.queryState({ kind: 'backups', root })).data as {
        backups: Array<{ name: string }>
      }
      expect(listed.backups.some((entry) => entry.name === orphan)).toBe(true)
    } finally {
      await cleanup()
    }
  })
})
