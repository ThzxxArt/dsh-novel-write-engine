import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { EngineBlockedError } from '../src/types.js'
import type { EngineService } from '../src/engine/service.js'
import {
  archiveDelta,
  cleanText,
  harness,
  readProjectFile,
  sampleReview,
  sampleSemantic,
  sampleSummary,
} from './helpers.js'

const TITLE = '开端之雨'
const SCENE = '日常过渡章' as const

const bookPlan = {
  premise: '一封没有署名的信把档案员拖回十年前的旧案。',
  logline: '小人物在旧案与现有秩序之间做选择。',
  themes: ['记忆', '责任'],
  tone: '冷峻、克制',
  pov: '第三人称限知',
  audience: '男频，18–30',
  selling_points: ['旧案', '群像'],
  ending: '主角保住城市，放弃私刑。',
  strict: true,
}

const outlineCard = {
  num: 1,
  title: TITLE,
  scene_type: SCENE,
  goal: '收到一封无名信',
  conflict: '是否拆开',
  hook: '蜡印上的日期是明天',
  cast: ['他'],
  target_words: [80, 400] as [number, number],
  volume: 1,
}

const planProject = async (engine: EngineService, root: string, strict = true): Promise<void> => {
  await engine.initProject({
    title: '测试之书',
    genre: '都市现代',
    platform: 'fanqie',
    root,
    words_per_chapter: [80, 400],
  })
  await engine.submitBookPlan({
    ...bookPlan,
    strict,
    volumes: [
      {
        title: '第一卷 雨夜来信',
        start_chapter: 1,
        end_chapter: 3,
        goal: '主角被卷入旧案',
        arc: '从旁观到入局',
        climax: '第3章 当面对质',
      },
    ],
    root,
  })
  await engine.submitOutline({ chapters: strict ? [outlineCard] : [], strict, root })
}

const planWorld = async (engine: EngineService, root: string): Promise<void> => {
  await engine.getBrief({ stage: 'P1', root })
  await engine.submitWorldPlan({
    chapter: 0,
    objective: '让主角收到一封无名信',
    constraints: ['没有超能力'],
    characters: [
      { name: '他', role: 'protagonist', current_state: '在旧办公室值夜' },
      { name: '配角A', role: 'supporting', current_state: '在楼下等候' },
    ],
    locations: [],
    continuity_notes: [],
    root,
  })
}

const planChapter = async (
  engine: EngineService,
  root: string,
  patch: Partial<typeof outlineCard> = {},
  castNames: string[] = ['他'],
): Promise<void> => {
  await engine.getBrief({ stage: 'P2', root })
  const card = { ...outlineCard, ...patch }
  await engine.submitChapterPlan({
    chapter: 0,
    title: card.title,
    scene_type: card.scene_type,
    narrator: '他',
    beats: ['风起', '信到', '拆封', '读信', '决定'],
    opening: '风从窗缝里挤进来',
    ending: '蜡印',
    target_words: card.target_words,
    cast: castNames.map((name) => ({
      name,
      entry_state: '值夜',
      goal: '确认信封来源',
      knowledge: ['旧案'],
      exit_change: '决定拆信',
    })),
    root,
  })
}

const writeAndArchive = async (engine: EngineService, root: string): Promise<void> => {
  const text = cleanText()
  await engine.getBrief({ stage: 'P3', root })
  await engine.submitDraft({
    chapter: 1,
    content: text,
    chapter_title: TITLE,
    scene_type: SCENE,
    narrator: '他',
    summary: sampleSummary(),
    root,
  })
  await engine.getBrief({ stage: 'P4', root })
  await engine.submitReview({ chapter: 1, ...sampleReview(1, text), root })
  await engine.getBrief({ stage: 'P6', root })
  await engine.runCheck({ chapter: 1, semantic: sampleSemantic(text), root })
  await engine.getBrief({ stage: 'P8', root })
  await engine.archiveChapter({
    chapter: 1,
    state_delta: archiveDelta(sampleSummary()),
    root,
  })
}

describe('0.2.0 whole-book lifecycle', () => {
  it('creates an outline and a worldbook with every new project', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '开局', genre: '都市现代', platform: 'fanqie', root })
      const outline = parseYaml((await readProjectFile(root, 'outline/outline.yaml'))!) as Record<
        string,
        unknown
      >
      expect(outline).toMatchObject({ schema_version: 1, chapters: [], volumes: [] })
      expect(outline.book).toMatchObject({ strict: false })
      const worldbook = parseYaml((await readProjectFile(root, 'outline/worldbook.yaml'))!) as Record<
        string,
        unknown
      >
      expect(worldbook).toMatchObject({ schema_version: 1, premise: '', rules: [], characters: [] })
      const status = await engine.getStatus({ root })
      expect(status.data.book).toMatchObject({
        strict: false,
        outline: { present: false, total: 0 },
        worldbook: { present: false, characters: 0 },
      })
      const guide = await engine.guide({ root })
      expect(guide.data.state).toBe('new')
      expect(guide.data.steps.map((step) => step.id)).toContain('outline')
    } finally {
      await cleanup()
    }
  })

  it('writes the blueprint and outline, enforces PG-13, and archives into the card', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await planProject(engine, root)
      const status = await engine.getStatus({ root })
      expect(status.data.book).toMatchObject({
        premise: bookPlan.premise,
        strict: true,
        outline: { present: true, total: 1, planned: 1, volumes: 1 },
      })
      expect(status.data.book?.outline.current).toMatchObject({ num: 1, title: TITLE })
      expect((await engine.getStatus({ root })).data.next.tool).toBe('novel_brief')

      await planWorld(engine, root)
      await planChapter(engine, root)
      await writeAndArchive(engine, root)

      const outline = parseYaml((await readProjectFile(root, 'outline/outline.yaml'))!) as {
        chapters: Array<Record<string, unknown>>
      }
      expect(outline.chapters[0]).toMatchObject({
        num: 1,
        title: TITLE,
        status: 'archived',
        word_count: expect.any(Number),
        score: expect.any(Number),
      })
      const after = await engine.getStatus({ root })
      expect(after.data.book?.outline.archived).toBe(1)
      expect(after.data.book?.outline.coverage).toBe(1)
      const stats = await engine.stats({ root })
      expect(stats.plannedChapters).toBe(0)
      expect(stats.outlineCoverage).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('rejects every PG-13 mismatch and the missing card in strict mode', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await planProject(engine, root)
      await planWorld(engine, root)
      for (const patch of [
        { title: '另一个标题' },
        { scene_type: '战斗/动作章' as const },
        { target_words: [2000, 3000] as [number, number] },
      ]) {
        await expect(planChapter(engine, root, patch as Partial<typeof outlineCard>)).rejects.toBeInstanceOf(
          EngineBlockedError,
        )
      }

      // Cast mismatch: the card names two actors, the plan only one.
      await engine.submitOutline({
        chapters: [{ ...outlineCard, cast: ['他', '配角A'] }],
        root,
      })
      await expect(planChapter(engine, root, {}, ['他'])).rejects.toBeInstanceOf(EngineBlockedError)

      // Strict mode without a card: P2 is refused before any write.
      await expect(engine.submitOutline({ chapters: [], strict: true, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      const outline = (await engine.queryState({ kind: 'outline', root })).data as {
        chapters: unknown[]
      }
      await engine.amend({
        path: 'outline/outline.yaml',
        content: { ...(outline as object), chapters: [] },
        reason: 'remove the card to prove the P2 refusal',
        root,
      })
      await expect(planChapter(engine, root)).rejects.toBeInstanceOf(EngineBlockedError)
    } finally {
      await cleanup()
    }
  })

  it('surfaces a card/plan mismatch at P3 and points back to P2', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await planProject(engine, root)
      await planWorld(engine, root)
      await planChapter(engine, root)
      await engine.submitOutline({
        strict: true,
        chapters: [{ ...outlineCard, title: '另一个标题' }],
        root,
      })
      const status = await engine.getStatus({ root })
      expect(status.data.stage).toBe('P3')
      expect(status.data.blocking).toContainEqual(expect.objectContaining({ code: 'PG-13' }))
      expect(status.data.next).toMatchObject({ tool: 'novel_rollback', args: { to_stage: 'P2' } })
    } finally {
      await cleanup()
    }
  })

  it('imports a Markdown outline, previews without writing, and applies it', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '导入之书', genre: '都市现代', platform: 'fanqie', root })
      const before = await readProjectFile(root, 'outline/outline.yaml')
      const content = [
        '# 导入之书',
        '> 旧案重启，档案员被迫入局。',
        '主题：记忆、责任',
        '基调：冷峻',
        '视角：第三人称限知',
        '读者：男频',
        '卖点：旧案、群像',
        '结局：保住城市',
        '',
        '## 第一卷 雨夜来信（第1-3章）',
        '目标：主角被卷入旧案',
        '弧线：从旁观到入局',
        '高潮：第3章 当面对质',
        '',
        '### 第1章 开端之雨',
        '场景：日常过渡章',
        '字数：80-400',
        '角色：他',
        '目标：收到无名信',
        '冲突：是否拆开',
        '钩子：蜡印上的日期是明天',
        '备注：第一场戏',
        '',
      ].join('\n')
      const preview = await engine.importOutline({
        format: 'markdown',
        content,
        dry_run: true,
        root,
      })
      expect(preview.data).toMatchObject({ applied: false, total: 1, planned: 1, archived: 0 })
      expect(await readProjectFile(root, 'outline/outline.yaml')).toBe(before)
      const applied = await engine.importOutline({ format: 'markdown', content, root })
      expect(applied.data).toMatchObject({ applied: true, total: 1, planned: 1 })
      const outline = parseYaml((await readProjectFile(root, 'outline/outline.yaml'))!) as {
        book: Record<string, unknown>
        volumes: Array<Record<string, unknown>>
        chapters: Array<Record<string, unknown>>
      }
      expect(outline.book).toMatchObject({ logline: '旧案重启，档案员被迫入局。', strict: true })
      expect(outline.volumes[0]).toMatchObject({ title: '第一卷 雨夜来信', start_chapter: 1, end_chapter: 3 })
      expect(outline.chapters[0]).toMatchObject({
        num: 1,
        title: TITLE,
        scene_type: SCENE,
        notes: '第一场戏',
      })
    } finally {
      await cleanup()
    }
  })

  it('preserves an explicit non-strict blueprint when importing an outline', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '宽松之书', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitBookPlan({ premise: '保留宽松模式', strict: false, root })
      await engine.submitOutline({ chapters: [{ ...outlineCard, volume: null }], strict: false, root })
      await engine.importOutline({
        format: 'yaml',
        content: [
          'chapters:',
          '  - num: 2',
          '    title: 旧城之影',
          '    scene_type: 纯叙事章',
          '    goal: 进入旧城',
          '    conflict: 门锁着',
          '    hook: 门后有人',
          '    target_words: [80, 400]',
        ].join('\n'),
        root,
      })
      const status = await engine.getStatus({ root })
      expect(status.data.book?.strict).toBe(false)
      expect(status.data.book?.outline).toMatchObject({ total: 1, planned: 1 })
    } finally {
      await cleanup()
    }
  })

  it('merges worldbook sections and keeps unknown sections intact', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '设定之书', genre: '都市现代', platform: 'fanqie', root })
      await engine.submitWorldbook({
        premise: '一座被旧案笼罩的城市。',
        setting: '当代，南方小城。',
        rules: [{ name: '记忆会失真', description: '越回想越不可靠' }],
        characters: [{ name: '他', role: '主角', description: '档案员', arc: '从自保到承担' }],
        root,
      })
      const first = await engine.queryState({ kind: 'worldbook', root })
      expect(first.data).toMatchObject({
        premise: '一座被旧案笼罩的城市。',
        rules: [{ name: '记忆会失真' }],
        characters: [{ name: '他' }],
      })
      await engine.submitWorldbook({ rules: [{ name: '新规则', description: '替换规则段' }], root })
      const second = await engine.queryState({ kind: 'worldbook', root })
      expect(second.data).toMatchObject({
        premise: '一座被旧案笼罩的城市。',
        characters: [{ name: '他' }],
        rules: [{ name: '新规则' }],
      })
      await expect(
        engine.submitWorldbook({
          characters: [
            { name: '他', role: '主角', description: 'a', arc: '' },
            { name: '他', role: '配角', description: 'b', arc: '' },
          ],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      const status = await engine.getStatus({ root })
      expect(status.data.book?.worldbook).toMatchObject({ characters: 1, rules: 1, present: true })
    } finally {
      await cleanup()
    }
  })

  it('reopens an archived chapter from its archive backup and re-archives it', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await planProject(engine, root)
      await planWorld(engine, root)
      await planChapter(engine, root)
      await writeAndArchive(engine, root)
      const reopened = await engine.reopenChapter({ chapter: 1, reason: '改结尾', root })
      expect(reopened.data).toMatchObject({ chapter: 1, stage: 'P3' })
      const status = await engine.getStatus({ root })
      expect(status.data).toMatchObject({ stage: 'P3', chapter: 1, active_chapter: 1 })
      expect((await engine.queryState({ kind: 'chapters', root })).data).toMatchObject({ chapters: [] })
      const outline = parseYaml((await readProjectFile(root, 'outline/outline.yaml'))!) as {
        chapters: Array<Record<string, unknown>>
      }
      expect(outline.chapters[0]).toMatchObject({ num: 1, status: 'planned', word_count: null })
      await writeAndArchive(engine, root)
      expect((await engine.getStatus({ root })).data.book?.outline.archived).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('requires a reason and refuses to overwrite a damaged outline on reopen', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await planProject(engine, root)
      await planWorld(engine, root)
      await planChapter(engine, root)
      await writeAndArchive(engine, root)
      await expect(engine.reopenChapter({ chapter: 1, reason: '   ', root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      const damaged = 'book: [not-a-map]\n'
      await writeFile(join(root, 'outline/outline.yaml'), damaged, 'utf8')
      await expect(engine.reopenChapter({ chapter: 1, reason: '改结尾', root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      expect(await readProjectFile(root, 'outline/outline.yaml')).toBe(damaged)
    } finally {
      await cleanup()
    }
  })

  it('reopens from backups when the archive journal predates the before map', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await planProject(engine, root)
      await planWorld(engine, root)
      await planChapter(engine, root)
      await writeAndArchive(engine, root)
      const journalText = (await readProjectFile(root, 'state/journal.jsonl'))!
      const rows = journalText
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      for (const row of rows) {
        if (row.op === 'archiveChapter' && row.status === 'committed') delete row.before
      }
      await writeFile(
        join(root, 'state/journal.jsonl'),
        `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
        'utf8',
      )
      await engine.reopenChapter({ chapter: 1, reason: '旧日志恢复', root })
      const status = await engine.getStatus({ root })
      expect(status.data).toMatchObject({ stage: 'P3', chapter: 1 })
      expect((await engine.queryState({ kind: 'chapters', root })).data).toMatchObject({ chapters: [] })
    } finally {
      await cleanup()
    }
  })

  it('protects archived cards and keeps non-strict mode optional', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await planProject(engine, root, false)
      await planWorld(engine, root)
      await planChapter(engine, root)
      await writeAndArchive(engine, root)
      const outlineDoc = parseYaml((await readProjectFile(root, 'outline/outline.yaml'))!) as Record<
        string,
        unknown
      >
      const archived = (outlineDoc.chapters as Array<Record<string, unknown>>)[0]!
      await expect(
        engine.submitOutline({
          chapters: [{ ...archived, title: '改过的标题' } as never],
          strict: false,
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({
          path: 'outline/outline.yaml',
          content: {
            ...outlineDoc,
            chapters: [{ ...archived, title: '改过的标题' }],
          },
          reason: '试图改归档卡',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(
        engine.amend({
          path: 'outline/outline.yaml',
          content: {
            ...outlineDoc,
            chapters: [{ ...archived, cast: ['他', '她'] }],
          },
          reason: '试图改归档卡 cast',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      // Re-submitting with no chapter list still keeps the archived card via backfill.
      const result = await engine.submitOutline({ chapters: [], strict: false, root })
      expect(result.data.archived).toBe(1)
      expect(result.data.strict).toBe(false)
    } finally {
      await cleanup()
    }
  })

  it('imports YAML/JSON and rejects malformed Markdown with a useful error', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '导入格式', genre: '都市现代', platform: 'fanqie', root })
      const yamlContent = [
        'book:',
        '  logline: YAML 导入的梗概',
        'chapters:',
        '  - num: 1',
        '    title: 开端之雨',
        '    scene_type: 日常过渡章',
        '    goal: 收信',
        '    conflict: 拆不拆',
        '    hook: 蜡印日期',
        '    cast: [他]',
        '    target_words: [80, 400]',
      ].join('\n')
      const applied = await engine.importOutline({ format: 'yaml', content: yamlContent, root })
      expect(applied.data).toMatchObject({ applied: true, total: 1, planned: 1 })
      const jsonContent = JSON.stringify({
        chapters: [
          {
            num: 1,
            title: '开端之雨',
            scene_type: '日常过渡章',
            goal: '收信',
            conflict: '拆不拆',
            hook: '蜡印日期',
            cast: ['他'],
            target_words: [80, 400],
          },
          {
            num: 2,
            title: '旧城之影',
            scene_type: '纯叙事章',
            goal: '进入旧城',
            conflict: '门锁着',
            hook: '门后有人',
            cast: [],
            target_words: [80, 400],
          },
        ],
      })
      const jsonApplied = await engine.importOutline({ format: 'json', content: jsonContent, root })
      expect(jsonApplied.data).toMatchObject({ applied: true, total: 2, planned: 2 })
      await expect(
        engine.importOutline({
          format: 'markdown',
          content: '### 第1章 缺场景\n字数：80-400\n目标：a\n冲突：b\n钩子：c',
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
    } finally {
      await cleanup()
    }
  })

  it('reports outline damage in status/doctor and blocks planning until amended', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await planProject(engine, root)
      await writeFile(join(root, 'outline/outline.yaml'), 'book: [not-a-map]\n', 'utf8')
      const status = await engine.getStatus({ root })
      expect(status.data.state_errors).toEqual([
        expect.objectContaining({ code: 'OUTLINE_UNREADABLE', path: 'outline/outline.yaml' }),
      ])
      const doctor = await engine.doctor({ root })
      expect(doctor.data.ok).toBe(false)
      expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id: 'outline', severity: 'error' }))
      // The corrupted outline is journal-tracked, so the next write fails
      // closed before the state gate is even evaluated.
      await expect(planWorld(engine, root)).rejects.toMatchObject({ code: 'ENGINE_TXN_ABORTED' })
    } finally {
      await cleanup()
    }
  })

  it('guards reopen against non-archived or in-progress chapters', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await planProject(engine, root)
      await expect(
        engine.reopenChapter({ chapter: 1, reason: 'not archived yet', root }),
      ).rejects.toMatchObject({ code: 'ENGINE_STAGE_ORDER' })
      await planWorld(engine, root)
      await planChapter(engine, root)
      await expect(
        engine.reopenChapter({ chapter: 1, reason: 'chapter is in progress', root }),
      ).rejects.toMatchObject({ code: 'ENGINE_STAGE_ORDER' })
    } finally {
      await cleanup()
    }
  })

  it('doctor reports missing stage products', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await planProject(engine, root)
      await planWorld(engine, root)
      await planChapter(engine, root)
      await writeFile(join(root, 'plans/ch001.chapter.yaml'), 'bad: [yaml\n', 'utf8')
      const broken = await engine.doctor({ root })
      expect(broken.data.checks).toContainEqual(
        expect.objectContaining({ id: 'stage-products', severity: 'error' }),
      )
    } finally {
      await cleanup()
    }
  })

  it('doctor reports missing outline cards for archived chapters', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await planProject(engine, root)
      await planWorld(engine, root)
      await planChapter(engine, root)
      await writeAndArchive(engine, root)
      const emptyOutline = {
        schema_version: 1,
        updated_at: new Date().toISOString(),
        book: {
          premise: '',
          logline: '',
          themes: [],
          tone: '',
          pov: '',
          audience: '',
          selling_points: [],
          ending: '',
          strict: false,
        },
        volumes: [],
        chapters: [],
      }
      await writeFile(join(root, 'outline/outline.yaml'), JSON.stringify(emptyOutline), 'utf8')
      const missingCard = await engine.doctor({ root })
      expect(missingCard.data.checks).toContainEqual(
        expect.objectContaining({ id: 'outline-coverage', severity: 'warning' }),
      )
    } finally {
      await cleanup()
    }
  })

  it('reports, diagnoses, searches and exports the book-level artifacts', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await planProject(engine, root)
      await planWorld(engine, root)
      await planChapter(engine, root)
      await writeAndArchive(engine, root)
      await engine.submitWorldbook({
        premise: '旧案之城',
        characters: [{ name: '他', role: '主角', description: '档案员', arc: '入局' }],
        root,
      })

      const report = await engine.report({ root })
      expect(report.data.progress).toMatchObject({ archived: 1, words: expect.any(Number) })
      expect(report.data.outline).toMatchObject({ archived: 1, planned: 0, drift: [] })
      expect(report.data.quality.dimensions.length).toBe(15)
      expect(report.data.activity.length).toBeGreaterThan(0)

      const panel = await engine.panelSummary({ root })
      expect(panel.book).toMatchObject({ strict: true, outline: { archived: 1, coverage: 1 } })
      expect(panel.health).toMatchObject({ ok: true, blocking: 0, stateErrors: 0 })
      expect(panel.quality?.scores.length).toBe(1)
      expect(panel.activity?.length).toBeGreaterThan(0)

      const doctor = await engine.doctor({ root })
      expect(doctor.data.ok).toBe(true)
      expect(doctor.data.checks.map((check) => check.id)).toContain('outline-drift')

      const search = await engine.search({ query: '信封', scope: 'chapters', root })
      expect(search.data.total).toBeGreaterThan(0)
      expect(search.data.results[0]).toMatchObject({ kind: 'chapters', chapter: 1 })
      expect(
        (await engine.search({ query: '信封', scope: 'summaries', root })).data.results[0],
      ).toMatchObject({
        kind: 'summaries',
        chapter: 1,
      })
      expect((await engine.search({ query: '无名信', scope: 'outline', root })).data.total).toBeGreaterThan(0)
      expect((await engine.search({ query: '旧案', scope: 'worldbook', root })).data.total).toBeGreaterThan(0)
      expect(
        (await engine.search({ query: 'protagonist', scope: 'ledgers', root })).data.total,
      ).toBeGreaterThan(0)

      for (const kind of ['outline', 'worldbook', 'proposal'] as const) {
        const result = await engine.export({ kind, root })
        expect(result.data.kind).toBe(kind)
        expect(await readProjectFile(root, result.data.files[0]!)).toContain('测试之书')
      }
    } finally {
      await cleanup()
    }
  })

  it('rejects invalid book-level inputs and exposes raw damaged planning documents', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      await engine.initProject({ title: '错误之书', genre: '都市现代', platform: 'fanqie', root })
      await expect(engine.search({ query: '   ', root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.search({ query: 'x', scope: 'bad' as never, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.search({ query: 'x'.repeat(201), root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(
        engine.submitBookPlan({
          volumes: [
            { title: 'a', start_chapter: 1, end_chapter: 3 },
            { title: 'b', start_chapter: 3, end_chapter: 5 },
          ],
          root,
        }),
      ).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(engine.submitWorldbook({ root })).rejects.toMatchObject({ code: 'ENGINE_SCHEMA_INVALID' })
      await expect(engine.export({ kind: 'pdf' as never, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await expect(engine.export({ kind: 'outline', chapter: 1, root })).rejects.toMatchObject({
        code: 'ENGINE_SCHEMA_INVALID',
      })
      await writeFile(join(root, 'outline/outline.yaml'), 'book: [bad]\n', 'utf8')
      const damaged = await engine.queryState({ kind: 'outline', root })
      expect(damaged.data).toMatchObject({ error: 'OUTLINE_UNREADABLE', path: 'outline/outline.yaml' })
      const chapter = await engine.queryState({ kind: 'planWorld', chapter: 99, root })
      expect(chapter.data).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('returns a useful guide and doctor report before a project exists', async () => {
    const { root, engine, cleanup } = await harness()
    try {
      const guide = await engine.guide({ root })
      expect(guide.data.state).toBe('no-project')
      expect(guide.data.next.tool).toBe('novel_init')
      const doctor = await engine.doctor({ root })
      expect(doctor.data.ok).toBe(false)
      expect(doctor.data.checks[0]).toMatchObject({ id: 'project', severity: 'error' })
    } finally {
      await cleanup()
    }
  })
})
