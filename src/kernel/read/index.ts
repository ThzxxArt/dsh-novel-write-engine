import type { LoadedProject } from '../project/layout.js'
import type { StudioDb } from '../../storage/db.js'
import { clearMemory, upsertMemoryChunk } from '../../storage/repositories/memory.js'
import { loadBible, listChapterPlans } from '../book/store.js'
import { sha256Hex } from '../../domain/hash.js'

const digest = (text: string): string => `sha256:${sha256Hex(text)}`

/** Rebuild FTS/index rows from files; the DB is disposable, the files are truth. */
export async function rebuildProjectIndex(
  project: LoadedProject,
  db: StudioDb,
): Promise<{ indexed: number; removed: number }> {
  const removed = clearMemory(db.orm, project.config.id)
  let indexed = 0
  const add = (input: {
    kind: string
    chapter?: number | null
    sourcePath: string
    text: string
    meta?: Record<string, unknown>
  }): void => {
    if (input.text.trim() === '') return
    upsertMemoryChunk(db.orm, {
      projectId: project.config.id,
      kind: input.kind,
      chapter: input.chapter ?? null,
      sourcePath: input.sourcePath,
      sourceHash: digest(input.text),
      text: input.text,
      meta: input.meta ?? {},
    })
    indexed += 1
  }
  const manuscripts = (await project.store.list('manuscript')).filter((name) => /^ch-\d{4}\.md$/u.test(name))
  for (const name of manuscripts) {
    const chapter = Number(name.slice(3, 7))
    const text = await project.store.readText(`manuscript/${name}`)
    if (text !== null) add({ kind: 'chapter', chapter, sourcePath: `manuscript/${name}`, text })
  }
  const plans = await listChapterPlans(project.store)
  for (const plan of plans) {
    add({
      kind: 'plan',
      chapter: plan.chapter,
      sourcePath: `outline/chapters/ch-${String(plan.chapter).padStart(4, '0')}.yaml`,
      text: JSON.stringify(plan, null, 2),
      meta: { entities: plan.cast },
    })
  }
  const canon = await project.store.readText('state/canon.yaml')
  if (canon !== null) add({ kind: 'canon', sourcePath: 'state/canon.yaml', text: canon })
  const bible = await loadBible(project.store)
  add({ kind: 'bible', sourcePath: 'bible/premise.md', text: bible.premise })
  add({ kind: 'bible', sourcePath: 'bible/themes.md', text: bible.themes })
  add({ kind: 'style', sourcePath: 'bible/style/guide.md', text: bible.styleGuide })
  add({ kind: 'world', sourcePath: 'bible/world/rules.yaml', text: bible.world.rules.join('\n') })
  add({ kind: 'world', sourcePath: 'bible/world/locations.yaml', text: bible.world.locations.join('\n') })
  add({ kind: 'world', sourcePath: 'bible/world/factions.yaml', text: bible.world.factions.join('\n') })
  add({
    kind: 'world',
    sourcePath: 'bible/world/glossary.yaml',
    text: Object.entries(bible.world.glossary)
      .map(([term, definition]) => `${term}：${definition}`)
      .join('\n'),
  })
  for (const character of bible.characters) {
    const name = String(character.name ?? character.slug ?? '')
    add({
      kind: 'bible',
      sourcePath: `bible/characters/${String(character.slug ?? name)}.yaml`,
      text: JSON.stringify(character, null, 2),
      meta: { entities: name === '' ? [] : [name] },
    })
  }
  for (const entry of bible.codex ?? []) {
    add({
      kind: 'world',
      sourcePath: `bible/world/codex.yaml#${String(entry.key ?? entry.name ?? '')}`,
      text: JSON.stringify(entry, null, 2),
    })
  }
  return { indexed, removed }
}
