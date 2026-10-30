/**
 * Array-parameter semantics are authored here as a separate contract. The DSH
 * tool schema subset intentionally rejects unknown JSON Schema keywords such
 * as `x-semantics`, so the executable schema carries the same declaration in
 * the parameter description and this table is enforced by tool-contract.spec.
 */
export type ArraySemantics = 'upsert' | 'replace' | 'append' | 'remove'

export interface ArrayParameterContract {
  semantics: ArraySemantics
  /** A `replace` parameter whose list is a persisted collection must name its removal control. */
  remove_param?: string
  /** A `replace` parameter may also require an explicit confirmation boolean. */
  confirm_param?: string
}

export const ARRAY_PARAMETER_CONTRACT: Record<string, Record<string, ArrayParameterContract>> = {
  novel_init: {
    words_per_chapter: { semantics: 'replace' },
    themes: { semantics: 'replace' },
    selling_points: { semantics: 'replace' },
  },
  novel_blueprint: {
    themes: { semantics: 'replace' },
    selling_points: { semantics: 'replace' },
    volumes: { semantics: 'replace', confirm_param: 'confirm_remove' },
  },
  novel_outline: {
    chapters: { semantics: 'upsert', remove_param: 'remove' },
    volumes: { semantics: 'upsert', remove_param: 'remove_volumes' },
    remove: { semantics: 'remove' },
    remove_volumes: { semantics: 'remove' },
  },
  novel_plan_world: {
    constraints: { semantics: 'replace' },
    continuity_notes: { semantics: 'replace' },
    characters: { semantics: 'replace' },
    locations: { semantics: 'replace' },
  },
  novel_plan_chapter: {
    beats: { semantics: 'replace' },
    target_words: { semantics: 'replace' },
    cast: { semantics: 'replace' },
  },
  novel_review: {
    dimensions: { semantics: 'replace' },
    issues: { semantics: 'replace' },
    proof: { semantics: 'replace' },
  },
  novel_revise: {
    issues: { semantics: 'replace' },
    proof: { semantics: 'replace' },
  },
  novel_check: {
    scope: { semantics: 'replace' },
    semantic: { semantics: 'replace' },
    acknowledge: { semantics: 'replace' },
  },
  novel_worldbook: {
    rules: { semantics: 'replace' },
    factions: { semantics: 'replace' },
    locations: { semantics: 'replace' },
    characters: { semantics: 'replace' },
    glossary: { semantics: 'replace' },
    backstory: { semantics: 'replace' },
    facts: { semantics: 'replace' },
    themes: { semantics: 'replace' },
  },
  novel_state: {
    chapter_range: { semantics: 'replace' },
  },
  novel_restore: {
    paths: { semantics: 'replace' },
  },
}

export const NON_ARRAY_JSON_PARAMS = new Set([
  'novel_write_draft.summary',
  'novel_revise.patch',
  'novel_revise.summary',
  'novel_archive.state_delta',
  'novel_archive.handoff',
  'novel_amend.content',
  'novel_outline.book',
])

export const arraySemanticsDescription = (semantics: ArraySemantics, description: string): string =>
  `[x-semantics: ${semantics}] ${description}`

export const declaredArraySemantics = (description: unknown): ArraySemantics | null => {
  if (typeof description !== 'string') return null
  const match = /\[x-semantics:\s*(upsert|replace|append|remove)\]/.exec(description)
  return (match?.[1] as ArraySemantics | undefined) ?? null
}
