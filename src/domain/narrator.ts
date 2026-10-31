/**
 * One narrator-alias contract shared by PG-05, state_delta and lock capture.
 *
 * The plan format is `角色名（第一人称）` or `角色名（第一人称「我」）`. A
 * first-person manuscript says 「我」 instead of repeating the character name;
 * every consumer must accept that alias, and none may infer it from a bare
 * substring such as "林" inside "林砚".
 */
export const narratorName = (narrator: string): string => narrator.split(/[（(]/, 1)[0]!.trim()

/** The only documented first-person alias is the pronoun itself. */
export const narratorAliases = (narrator: string): string[] => (isFirstPersonNarrator(narrator) ? ['我'] : [])

/** Whether the plan declares first-person narration. */
export const isFirstPersonNarrator = (narrator: string): boolean =>
  narrator.includes('第一人称') && !narrator.includes('第三人称')

/**
 * True when `name` is the declared narrator and the manuscript uses the
 * declared first-person alias. A name that merely contains the narrator name
 * is not an alias.
 */
export const isNarratorAlias = (name: string, narrator: string, text: string): boolean => {
  if (text.includes(name)) return true
  if (narratorName(narrator) !== name) return false
  if (!isFirstPersonNarrator(narrator)) return false
  return narratorAliases(narrator).some((alias) => text.includes(alias))
}

/** Paragraph used for a newly locked character; prefers the named/aliased one. */
export const narratorAliasesFor = (name: string, narrator: string): string[] =>
  name === narratorName(narrator) ? narratorAliases(narrator) : []
