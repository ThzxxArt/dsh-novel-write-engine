import { join, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { copyPathAt, ensureDirAt, existsAt, listDirAt, readTextIfExists } from '../../assets.js'
import { initProjectV2, loadProjectV2 } from './layout.js'
import { mapLegacyGenre } from '../../domain/taxonomy.js'
import { loadTaxonomy } from '../../taxonomy.js'
import { openStudioDb } from '../../storage/db.js'
import { importMemoryChunks } from '../../storage/repositories/memory.js'
import { StudioError, STUDIO_ERROR_CODES } from '../../contracts/errors.js'
import type { ChapterPlan } from '../../contracts/artifacts.js'
import { saveCanon, saveChapterPlan, saveOutlinePlan, type BibleSnapshot } from '../book/store.js'

interface LegacyProject {
  title?: string
  author?: string
  genre?: string
  platform?: string
  description?: string
  created_at?: string
  targets?: {
    words_per_chapter?: [number, number]
    total_chapters?: number
    dialogue_ratio?: [number, number]
    min_cjk_chars?: number
  }
}

const readText = (path: string): string | null => readTextIfExists(path)

const readYaml = (path: string): Record<string, unknown> | null => {
  const text = readText(path)
  if (text === null) return null
  try {
    return parseYaml(text) as Record<string, unknown>
  } catch {
    return null
  }
}

const list = (path: string): string[] => listDirAt(path)

export interface ImportResult {
  root: string
  title: string
  chapters: number
  archived: number
  report: string
}

/** One-way 0.2.x -> 0.3.0 import. Never continues writing and never mutates the source. */
export async function importLegacyProject(from: string, to: string): Promise<ImportResult> {
  const source = resolve(from)
  const target = resolve(to)
  if (source === target)
    throw new StudioError(STUDIO_ERROR_CODES.IMPORT_INVALID, 'source and destination must differ')
  const legacy = readYaml(join(source, 'novel.yaml')) as LegacyProject | null
  if (legacy === null) throw new StudioError(STUDIO_ERROR_CODES.IMPORT_INVALID, `no novel.yaml at ${source}`)
  const taxonomy = loadTaxonomy()
  const mapped = mapLegacyGenre(String(legacy.genre ?? ''), taxonomy)
  if (mapped === null)
    throw new StudioError(
      STUDIO_ERROR_CODES.IMPORT_INVALID,
      `cannot map legacy genre ${String(legacy.genre)}`,
    )
  const sub = taxonomy.subById.get(mapped.sub)!
  const major = taxonomy.majorById.get(sub.id.split('.')[0]!)!
  const tags = [...mapped.tags]
  if (!tags.some((tag) => tag.startsWith('tone.') || tag.startsWith('theme.'))) tags.push('tone.hot_blooded')
  if (existsAt(join(target, 'studio.yaml'))) {
    throw new StudioError(
      STUDIO_ERROR_CODES.PROJECT_EXISTS,
      `destination ${target} already has a studio project`,
    )
  }
  await initProjectV2({
    root: target,
    title: String(legacy.title ?? '未命名'),
    author: String(legacy.author ?? ''),
    genre: { major: major.id, sub: sub.id, tags },
    audience: sub.audienceDefault,
    platform: String(legacy.platform ?? 'fanqie') as 'fanqie' | 'qidian' | 'qimao' | 'jinjiang',
    premise: String(legacy.description ?? ''),
    targets: {
      words_per_chapter: legacy.targets?.words_per_chapter ?? [2200, 3200],
      total_chapters: legacy.targets?.total_chapters ?? 120,
      dialogue_ratio: legacy.targets?.dialogue_ratio ?? [0.35, 0.55],
      min_cjk_chars: legacy.targets?.min_cjk_chars ?? 1800,
    },
  })
  const project = await loadProjectV2(target)
  const warnings: string[] = []
  const outlineRaw = readYaml(join(source, 'outline/outline.yaml'))
  const chaptersRaw = Array.isArray(outlineRaw?.chapters)
    ? (outlineRaw.chapters as Array<Record<string, unknown>>)
    : []
  const outlineChapters: ChapterPlan[] = chaptersRaw.map((card) => {
    const num = Number(card.num ?? 1)
    const target = Array.isArray(card.target_words)
      ? Number((card.target_words as unknown[])[0] ?? 2400)
      : 2400
    return {
      schema_version: 2,
      kind: 'ChapterPlan',
      chapter: num,
      // ChapterPlan requires a non-empty title/beats. Missing legacy cards get
      // explicit placeholders so the imported project is loadable, and the
      // report still warns that the source had no chapter cards.
      title: String(card.title ?? `第${num}章 未命名章节`),
      scene_type: String(card.scene_type ?? '日常过渡章') as ChapterPlan['scene_type'],
      pov: String((outlineRaw?.book as Record<string, unknown> | undefined)?.pov ?? '第三人称'),
      cast: Array.isArray(card.cast) ? card.cast.map(String) : ['主角'],
      goal: String(card.goal ?? '（旧稿未提供目标）'),
      conflict: String(card.conflict ?? '（旧稿未提供冲突）'),
      turn: String(card.notes ?? card.hook ?? '（旧稿未提供转折）'),
      outcome: String(card.goal ?? '（旧稿未提供结果）'),
      target_words: target,
      hook: String(card.hook ?? '（旧稿未提供钩子）'),
      foreshadows: [],
      notes: String(card.notes ?? '') === '' ? [] : [String(card.notes)],
      citations: [],
      open_questions: [],
    }
  })
  const book = (outlineRaw?.book ?? {}) as Record<string, unknown>
  if (outlineChapters.length > 0) {
    await saveOutlinePlan(project.store, {
      schema_version: 2,
      kind: 'OutlinePlan',
      logline: String(book.logline ?? ''),
      acts: [{ id: 'imported', title: '导入', summary: String(book.premise ?? '') }],
      volumes: Array.isArray(outlineRaw?.volumes)
        ? (outlineRaw!.volumes as Array<Record<string, unknown>>).map((volume, index) => ({
            id: String(volume.id ?? `v${index + 1}`),
            title: String(volume.title ?? `第${index + 1}卷`),
            start_chapter: Number(volume.start_chapter ?? 1),
            end_chapter: Number(volume.end_chapter ?? 1),
            arc: String(volume.arc ?? volume.goal ?? ''),
          }))
        : [
            {
              id: 'v1',
              title: '第一卷',
              start_chapter: 1,
              end_chapter: Math.max(1, outlineChapters.length),
              arc: '',
            },
          ],
      chapters: outlineChapters.map((card) => ({
        chapter: card.chapter,
        title: card.title,
        summary: card.goal,
        scene_type: card.scene_type,
        hook: card.hook,
      })),
      citations: [],
      open_questions: [],
    })
    for (const card of outlineChapters) await saveChapterPlan(project.store, card)
  } else warnings.push('legacy outline had no chapter cards')

  const worldbook = (readYaml(join(source, 'outline/worldbook.yaml')) ?? {}) as Record<string, unknown>
  const bible: BibleSnapshot = {
    premise: String(worldbook.premise ?? legacy.description ?? ''),
    themes: Array.isArray(worldbook.themes) ? worldbook.themes.join('\n- ') : '',
    styleGuide: '',
    fingerprint: {},
    world: {
      rules: Array.isArray(worldbook.rules)
        ? worldbook.rules.map((rule) =>
            typeof rule === 'string' ? rule : String((rule as { name?: unknown }).name ?? ''),
          )
        : [],
      factions: Array.isArray(worldbook.factions)
        ? worldbook.factions.map((faction) =>
            typeof faction === 'string' ? faction : String((faction as { name?: unknown }).name ?? ''),
          )
        : [],
      locations: Array.isArray(worldbook.locations)
        ? worldbook.locations.map((location) =>
            typeof location === 'string' ? location : String((location as { name?: unknown }).name ?? ''),
          )
        : [],
      glossary: Object.fromEntries(
        (Array.isArray(worldbook.glossary) ? worldbook.glossary : []).map((entry) => {
          const row = entry as { term?: unknown; definition?: unknown }
          return [String(row.term ?? ''), String(row.definition ?? '')]
        }),
      ),
    },
    characters: Array.isArray(worldbook.characters)
      ? (worldbook.characters as Array<Record<string, unknown>>).map((character) => ({
          ...character,
          slug: String(character.name ?? 'character')
            .toLowerCase()
            .replace(/\s+/g, '-'),
          voice: { signature_phrases: [], register: '' },
        }))
      : [],
  }
  await project.store.writeText('bible/premise.md', `${bible.premise}\n`)
  await project.store.writeText('bible/themes.md', `# 主题\n\n${bible.themes}\n`)
  await project.store.writeText('bible/style/guide.md', '# 文风指南\n\n（由 0.2.x 导入，未提供）\n')
  await project.store.writeText('bible/style/fingerprint.json', '{}\n')
  await project.store.writeText(
    'bible/world/rules.yaml',
    stringifyYaml(
      { schema_version: 2, rules: bible.world.rules, updated_at: new Date().toISOString() },
      { lineWidth: 0 },
    ),
  )
  await project.store.writeText(
    'bible/world/factions.yaml',
    stringifyYaml(
      { schema_version: 2, factions: bible.world.factions, updated_at: new Date().toISOString() },
      { lineWidth: 0 },
    ),
  )
  await project.store.writeText(
    'bible/world/locations.yaml',
    stringifyYaml(
      { schema_version: 2, locations: bible.world.locations, updated_at: new Date().toISOString() },
      { lineWidth: 0 },
    ),
  )
  await project.store.writeText(
    'bible/world/glossary.yaml',
    stringifyYaml(
      { schema_version: 2, terms: bible.world.glossary, updated_at: new Date().toISOString() },
      { lineWidth: 0 },
    ),
  )
  for (const character of bible.characters) {
    await project.store.writeText(
      `bible/characters/${String(character.slug)}.yaml`,
      stringifyYaml(
        { schema_version: 2, ...character, updated_at: new Date().toISOString() },
        { lineWidth: 0 },
      ),
    )
  }

  const state = (file: string): Record<string, unknown> =>
    (readYaml(join(source, 'state', file)) ?? {}) as Record<string, unknown>
  const charactersState = state('characters.yaml')
  const worldState = state('world.yaml')
  // Canon entities are records. Legacy state files commonly store plain
  // strings (`artifacts: [木匣]`), which must become `{ name }` or the imported
  // canon.yaml fails its own schema on the next load.
  const asRecords = (value: unknown): Array<Record<string, unknown>> =>
    Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? { name: item } : (item as Record<string, unknown>)))
      : []
  const canonical = {
    schema_version: 2 as const,
    entities: {
      characters: asRecords(charactersState.characters),
      locations: asRecords(worldState.locations),
      factions: asRecords(worldState.factions),
      items: asRecords(worldState.artifacts),
      concepts: asRecords(worldState.rules),
    },
    relationships: asRecords(state('relationships.yaml').items),
    timeline: asRecords(state('timeline.yaml').items),
    foreshadows: asRecords(state('foreshadows.yaml').items),
    resources: [],
    handoff: state('handoff.yaml'),
    next_seq: Number(state('foreshadows.yaml').next_seq ?? 1),
    updated_at: new Date().toISOString(),
  }
  await saveCanon(project.store, canonical as never)

  let archived = 0
  const memory: Array<{ sourcePath: string; text: string; chapter: number }> = []
  for (const file of list(join(source, 'chapters'))) {
    const match = /^chapter-(\d{3})\.md$/u.exec(file)
    if (match === null) continue
    const chapter = Number(match[1])
    const text = readText(join(source, 'chapters', file))
    if (text === null) continue
    await project.store.writeText(`manuscript/ch-${String(chapter).padStart(4, '0')}.md`, text)
    archived += 1
    memory.push({ sourcePath: `manuscript/ch-${String(chapter).padStart(4, '0')}.md`, text, chapter })
  }
  for (const file of list(join(source, 'reviews'))) {
    const match = /^ch(\d{3})\.review\.yaml$/u.exec(file)
    if (match === null) continue
    const chapter = Number(match[1])
    ensureDirAt(join(target, 'reviews', `ch-${String(chapter).padStart(4, '0')}`))
    await project.store.writeText(
      `reviews/ch-${String(chapter).padStart(4, '0')}/legacy.yaml`,
      readText(join(source, 'reviews', file)) ?? '',
    )
  }
  for (const file of list(join(source, 'checks'))) {
    const match = /^ch(\d{3})\.check\.yaml$/u.exec(file)
    if (match === null) continue
    const chapter = Number(match[1])
    await project.store.writeText(
      `reviews/ch-${String(chapter).padStart(4, '0')}/legacy-check.yaml`,
      readText(join(source, 'checks', file)) ?? '',
    )
  }
  if (existsAt(join(source, 'state/journal.jsonl'))) {
    ensureDirAt(join(target, '.studio', 'legacy'))
    copyPathAt(join(source, 'state/journal.jsonl'), join(target, '.studio', 'legacy', 'journal.jsonl'))
  }
  for (const dir of ['backups', 'history']) {
    if (existsAt(join(source, dir))) copyPathAt(join(source, dir), join(target, '.studio', 'legacy', dir))
  }
  const db = openStudioDb(join(target, '.studio', 'studio.db'))
  try {
    importMemoryChunks(db.orm, project.config.id, memory)
  } finally {
    db.close()
  }
  const report = [
    `# 导入报告`,
    ``,
    `- 源项目：${source}`,
    `- 目标项目：${target}`,
    `- 标题：${String(legacy.title ?? '')}`,
    `- 旧类型：${String(legacy.genre ?? '')}`,
    `- 新类型：${major.label} / ${sub.label}`,
    `- 新类型 ID：${mapped.sub}`,
    `- 推荐标签：${mapped.tags.join(', ')}`,
    `- 章节：${archived}`,
    `- 警告：${warnings.length === 0 ? '无' : warnings.join('；')}`,
    ``,
    `旧 review/check 已作为 legacy.yaml 只读保留；0.3.0 不会自动继续写。`,
    ``,
  ].join('\n')
  await project.store.writeText('IMPORT_REPORT.md', report)
  return { root: target, title: project.config.title, chapters: archived, archived, report }
}
