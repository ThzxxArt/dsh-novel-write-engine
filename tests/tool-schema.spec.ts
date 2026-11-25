import { describe, expect, it, vi } from 'vitest'
import { createNovelTools, emptySummary } from '../src/tools/index.js'
import type { EngineService } from '../src/engine/service.js'

type Tool = ReturnType<typeof createNovelTools>[number]

const result = <T>(data: T): { data: T; revision: number; warnings: never[] } => ({
  data,
  revision: 1,
  warnings: [],
})

const tools = (): Map<string, Tool> =>
  new Map(
    createNovelTools({
      withSignal: vi.fn(async (_signal: unknown, task: () => Promise<unknown>) => task()),
      submitDraft: vi.fn(async () => result({ chapter: 1, stage: 'P4', metrics: {}, warnings: [] })),
      submitReview: vi.fn(async () => result({ chapter: 1, round: 1, total: 150 })),
      submitRevision: vi.fn(async () => result({ chapter: 1, stage: 'P4', round: 1 })),
      submitWorldPlan: vi.fn(async () => result({ chapter: 1, stage: 'P2', plan_file: 'state/x' })),
      submitOutline: vi.fn(async () => result({ planned: 0, archived: 1, total: 1 })),
      runCheck: vi.fn(async () => result({ chapter: 1, verdict: 'pass' })),
      archiveChapter: vi.fn(async () => result({ chapter: 1, assigned_keys: [] })),
    } as unknown as EngineService).map((tool) => [tool.name, tool]),
  )

const findType = (value: unknown, type: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => findType(item, type))
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.type === type) return true
  return Object.values(record).some((item) => findType(item, type))
}

describe('0.2.9 typed tool contract', () => {
  it('has no author-only json parameter in any of the 28 tools', () => {
    for (const [name, tool] of tools()) {
      expect(findType(tool.parameters, 'json'), `${name} still exposes type:json`).toBe(false)
    }
  })

  it('describes every schema node the host compiled down to "any value"', () => {
    // 0.2.20 review 4: `findType(parameters, 'json')` above can never fail. The
    // host compiles `type:'json'` to an untyped node (`{}`), so the parameter a
    // model must fill in arrived with no type and no description — and the
    // assertion looked for a string the compiler had already removed.
    const walk = (node: unknown, path: string, out: string[]): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}[${index}]`, out))
        return
      }
      if (typeof node !== 'object' || node === null) return
      const record = node as Record<string, unknown>
      const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(record, key)
      const typed = has('type') || has('oneOf') || has('anyOf') || has('enum') || has('const') || has('$ref')
      if (!typed && !has('properties') && !has('items') && !has('allOf')) {
        if (typeof record.description !== 'string' || record.description.trim() === '') {
          out.push(`${path} is an untyped schema node with no description`)
        }
      }
      if (has('properties')) {
        for (const [name, child] of Object.entries(record.properties as Record<string, unknown>)) {
          walk(child, `${path}.${name}`, out)
        }
      }
      if (has('items')) walk(record.items, `${path}[]`, out)
      for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
        if (!Array.isArray(record[key])) continue
        ;(record[key] as unknown[]).forEach((child, index) => walk(child, `${path}.${key}[${index}]`, out))
      }
    }
    const problems: string[] = []
    for (const [name, tool] of tools()) walk(tool.parameters, name, problems)
    expect(problems).toEqual([])
  })

  it('keeps the parameter block inside the agreed byte budget', () => {
    const bytes = [...tools().values()].reduce(
      (total, tool) => total + Buffer.byteLength(JSON.stringify(tool.parameters)),
      0,
    )
    // 0.2.19 raised this from 32,000 to 33,000 for `novel_check.self_check`:
    // thirteen checklist ids plus verdict/note/evidence is ~590 bytes of real
    // model-facing contract, not padding. Recorded as deviation P9 in
    // docs/0.2.19-acceptance.md; the guard still exists so the next addition has
    // to justify itself the same way.
    //
    // 0.2.20 raises it to 33,400 for `novel_check.self_check_waivers`, the only
    // way out of the new PG-12 rule that an unanswered checklist row blocks
    // archiving. The id enum is not repeated (the engine validates it against the
    // same spec), so the addition is ~250 bytes: two short strings and a
    // description that names the alternative to answering.
    // 0.2.20 raises it to 33,600 for `novel_amend.deleted`, which replaces the
    // blanket `allow_delete: true`. That parameter is gone, so the net addition
    // is one string array plus its description (~130 bytes): the tool now says
    // which rows it is deleting instead of asking permission to delete any.
    // 0.2.20 review raises it to 34,600 for three parameters that were read by
    // the engine but settable by no tool: `novel_init` could not create a
    // `quotes: curly` book (the field its own schema then rejected) and
    // `strict_cross` / `self_check_required` had no writer at all. `novel_audit`
    // also gained `latest` (its default page is now the head, so the recent page
    // needs a name) and a cursor description that explains the direction. Real
    // model-facing contract, not padding; the guard stays so the next addition
    // has to justify itself too.
    expect(bytes).toBeLessThanOrEqual(34_600)
  })

  it('types the outline book blueprint patch', () => {
    const book = (
      tools().get('novel_outline')!.parameters as {
        properties: {
          book: {
            type?: string
            additionalProperties?: boolean
            properties: Record<string, { type?: string }>
          }
        }
      }
    ).properties.book
    expect(book.type).toBe('object')
    expect(book.additionalProperties).toBe(false)
    expect(book.properties.premise.type).toBe('string')
    expect(book.properties.themes.type).toBe('array')
  })

  it('accepts a finite non-integer location capacity like the engine', async () => {
    await expect(
      tools()
        .get('novel_plan_world')!
        .execute(
          {
            objective: '目标',
            locations: [{ name: '地点', layout: '布局', capacity: 2.5 }],
          },
          {} as never,
        ),
    ).resolves.toBeTruthy()
  })

  it('accepts a minimal revision issue update', async () => {
    await expect(
      tools()
        .get('novel_revise')!
        .execute(
          {
            chapter: 1,
            issues: [{ id: 'REV-001', status: 'fixed', evidence: '已改掉' }],
          },
          {} as never,
        ),
    ).resolves.toBeTruthy()
  })

  it('rejects a null summary and a string dimensions array at the schema boundary', async () => {
    const map = tools()
    await expect(
      map.get('novel_write_draft')!.execute(
        {
          chapter: 1,
          content: '正文',
          chapter_title: '标题',
          scene_type: '日常过渡章',
          narrator: '他',
          summary: null,
        },
        {} as never,
      ),
    ).rejects.toThrow(/summary/)
    await expect(
      map.get('novel_review')!.execute(
        {
          chapter: 1,
          dimensions: 'oops',
          total: 150,
          proof: {
            opening: { paragraph: 1, quote: 'a' },
            middle: { paragraph: 2, quote: 'b' },
            ending: { paragraph: 3, quote: 'c' },
          },
        },
        {} as never,
      ),
    ).rejects.toThrow(/dimensions/)
  })

  it('accepts an archived-card round trip and a quote/newline heavy manuscript', async () => {
    const map = tools()
    await expect(
      map.get('novel_outline')!.execute(
        {
          chapters: [
            {
              num: 1,
              title: '开端之雨',
              scene_type: '日常过渡章',
              goal: '目标',
              conflict: '冲突',
              hook: '钩子',
              cast: ['他'],
              target_words: [100, 200],
              status: 'archived',
              archived_at: '2026-10-31T00:00:00.000Z',
              word_count: 180,
              score: 140,
              unknown_archived_field: true,
            },
          ],
        },
        {} as never,
      ),
    ).resolves.toBeTruthy()

    const paragraphs: string[] = []
    for (let index = 0; index < 44; index += 1) {
      paragraphs.push(
        index % 2 === 0
          ? `"这是第${index}段对白，他说：'别动。'他答：'好。'窗外的雨声压低了两个人的声音，谁也没有再开口。"`
          : `她看着窗外的雨，想起${index}年前的那封信，纸角已经发黄，桌上的灯把影子拉得很长，走廊尽头还有脚步声。`,
      )
    }
    const content = paragraphs.join('\n\n')
    const dialogueLines = content.split('\n\n').filter((line) => line.trim().startsWith('"')).length
    expect(Array.from(content).length).toBeGreaterThanOrEqual(2000)
    expect(Array.from(content).length).toBeLessThanOrEqual(3000)
    expect(dialogueLines / paragraphs.length).toBeGreaterThanOrEqual(0.4)
    expect(dialogueLines / paragraphs.length).toBeLessThanOrEqual(0.6)
    const summary = emptySummary()
    const args = {
      chapter: 1,
      content,
      chapter_title: '开端之雨',
      scene_type: '日常过渡章',
      narrator: '他',
      summary,
    }
    const roundTrip = JSON.parse(JSON.stringify(args)) as typeof args
    expect(roundTrip.content).toBe(content)
    expect(roundTrip.summary).toEqual(summary)
    await expect(map.get('novel_write_draft')!.execute(roundTrip, {} as never)).resolves.toBeTruthy()
  })
})
