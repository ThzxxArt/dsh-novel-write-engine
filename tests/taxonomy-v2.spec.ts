import { describe, expect, it } from 'vitest'
import { loadTaxonomy } from '../src/taxonomy.js'
import { loadRulepack } from '../src/rulepack.js'
import { applyTaxonomyProfile } from '../src/kernel/gates/index.js'
import {
  assertGenreSelection,
  genrePath,
  mapLegacyGenre,
  resolveGenreProfile,
  sortTags,
  tagSummary,
  validateGenreSelection,
  type GenreSelection,
} from '../src/domain/taxonomy.js'
import { GENRES } from '../src/types.js'

const taxonomy = loadTaxonomy()

const selection = (overrides: Partial<GenreSelection> = {}): GenreSelection => ({
  major: 'fantasy',
  sub: 'fantasy.xianxia',
  tags: [
    'world.eastern_cultivation',
    'plot.progression',
    'prot.weak_to_strong',
    'set.leveling',
    'tone.hot_blooded',
    'pace.fast',
  ],
  audience: 'male',
  platform: 'fanqie',
  ...overrides,
})

describe('taxonomy v2', () => {
  it('G-01: has exactly 12 majors, 100 subs and 137 tags with unique ids', () => {
    expect(taxonomy.majors).toHaveLength(12)
    const subs = taxonomy.majors.flatMap((major) => major.subs)
    expect(subs).toHaveLength(100)
    expect(taxonomy.tags).toHaveLength(137)
    expect(new Set(taxonomy.majors.map((major) => major.id)).size).toBe(12)
    expect(new Set(subs.map((sub) => sub.id)).size).toBe(100)
    expect(new Set(taxonomy.tags.map((tag) => tag.id)).size).toBe(137)
  })

  it('G-02: every sub belongs to its major and every recommended tag exists', () => {
    for (const major of taxonomy.majors) {
      for (const sub of major.subs) {
        expect(sub.id.startsWith(`${major.id}.`)).toBe(true)
        for (const tag of sub.recommendedTags) expect(taxonomy.tagById.has(tag), tag).toBe(true)
      }
    }
  })

  it('has the documented per-facet counts', () => {
    const counts = Object.fromEntries(
      ['world', 'prot', 'plot', 'tone', 'theme', 'set', 'struct', 'pov', 'emo', 'pace', 'market'].map(
        (facet) => [facet, taxonomy.tags.filter((tag) => tag.facet === facet).length],
      ),
    )
    expect(counts).toEqual({
      world: 18,
      prot: 14,
      plot: 26,
      tone: 12,
      theme: 12,
      set: 14,
      struct: 8,
      pov: 5,
      emo: 8,
      pace: 8,
      market: 12,
    })
  })

  it('G-03: rejects conflicting tags in both directions', () => {
    const forward = validateGenreSelection(
      selection({ tags: ['prot.invincible', 'prot.weak_to_strong', 'tone.hot_blooded'] }),
      taxonomy,
    )
    expect(forward.ok).toBe(false)
    expect(forward.conflicts).toContainEqual(['prot.invincible', 'prot.weak_to_strong'])
    const reverse = validateGenreSelection(
      selection({ tags: ['prot.weak_to_strong', 'prot.invincible', 'tone.hot_blooded'] }),
      taxonomy,
    )
    expect(reverse.ok).toBe(false)
  })

  it('G-04: rejects a missing required tag and suggests it', () => {
    const result = validateGenreSelection(
      selection({ tags: ['plot.progression', 'set.leveling', 'tone.hot_blooded'] }),
      taxonomy,
    )
    // set.leveling requires plot.progression, which is present; use system panel instead.
    expect(result.ok).toBe(true)
    const missing = validateGenreSelection(
      selection({ tags: ['set.system_panel', 'tone.hot_blooded', 'theme.growth'] }),
      taxonomy,
    )
    expect(missing.ok).toBe(false)
    expect(missing.missing).toContain('plot.system_flow')
    expect(missing.suggestions).toContain('plot.system_flow')
  })

  it('G-05: enforces per-facet and total tag limits', () => {
    expect(
      validateGenreSelection(selection({ tags: ['tone.hot_blooded', 'theme.growth'] }), taxonomy).ok,
    ).toBe(false)
    const tooMany = validateGenreSelection(
      selection({
        tags: [
          'world.eastern_cultivation',
          'world.ancient_dynasty',
          'world.modern_city',
          'world.cthulhu',
          'tone.hot_blooded',
          'theme.growth',
          'plot.progression',
          'set.leveling',
          'prot.genius',
          'pace.fast',
          'emo.one_v_one',
          'market.male_frequency',
          'struct.linear',
        ],
      }),
      taxonomy,
    )
    expect(tooMany.ok).toBe(false)
  })

  it('G-06: tag order is stable regardless of input order', () => {
    const tags = ['pace.fast', 'world.eastern_cultivation', 'tone.hot_blooded', 'plot.progression']
    expect(sortTags(tags)).toEqual(sortTags([...tags].reverse()))
    expect(sortTags(tags)).toEqual([
      'world.eastern_cultivation',
      'plot.progression',
      'tone.hot_blooded',
      'pace.fast',
    ])
  })

  it('G-07: maps every legacy genre to a real sub and tags', () => {
    for (const legacy of GENRES) {
      const mapped = mapLegacyGenre(legacy, taxonomy)
      expect(mapped, legacy).not.toBeNull()
      expect(taxonomy.subById.has(mapped!.sub)).toBe(true)
      for (const tag of mapped!.tags) expect(taxonomy.tagById.has(tag)).toBe(true)
    }
  })

  it('G-08: rejects conflicting profile values from selected tags', () => {
    const result = validateGenreSelection(
      selection({
        sub: 'mystery.horror',
        major: 'mystery',
        tags: ['tone.oppressive', 'theme.survival', 'pace.fast', 'pace.slow', 'market.high_concept'],
      }),
      taxonomy,
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('paragraph_max_words')
  })

  it('G-09: changing major invalidates a sub from another major', () => {
    const result = validateGenreSelection(selection({ major: 'urban' }), taxonomy)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('does not belong to urban')
  })

  it('G-11: profile priority is tag > sub > major > global', () => {
    const resolved = resolveGenreProfile(selection(), taxonomy, { foreshadow_dormant_after: 99 })
    expect(resolved.sources.foreshadow_dormant_after).toBe('global')
    const withSub = resolveGenreProfile(
      selection({ sub: 'mystery.infinite', major: 'mystery' }),
      taxonomy,
      {},
    )
    expect(withSub.values.foreshadow_dormant_after).toBe(10)
    expect(withSub.sources.foreshadow_dormant_after).toBe('sub:mystery.infinite')
    const withTag = resolveGenreProfile(selection(), taxonomy, {})
    expect(withTag.values.paragraph_max_words).toBe(90)
    expect(withTag.sources.paragraph_max_words).toBe('tag:pace.fast')
  })

  it('G-12: rejects unknown sub and tag ids', () => {
    expect(validateGenreSelection(selection({ sub: 'fantasy.nope' }), taxonomy).ok).toBe(false)
    expect(
      validateGenreSelection(
        selection({ tags: ['world.eastern_cultivation', 'plot.progression', 'nope.nope'] }),
        taxonomy,
      ).ok,
    ).toBe(false)
  })

  it('G-13: taxonomy profiles override the compiled rulepack', () => {
    const probe = {
      config: {
        genre: {
          major: 'mystery',
          sub: 'mystery.infinite',
          tags: ['world.infinite_world', 'plot.dungeon', 'struct.infinite', 'tone.oppressive', 'pace.fast'],
        },
      },
      taxonomy,
    } as unknown as import('../src/kernel/project/layout.js').LoadedProject
    const pack = applyTaxonomyProfile(probe, loadRulepack())
    expect(pack.crosschapter.foreshadow_dormant_after).toBe(10)
    expect(pack.format.paragraph_max_words).toBe(90)
  })

  it('renders a stable path and tag summary', () => {
    expect(genrePath(selection(), taxonomy)).toBe('幻想 / 仙侠')
    expect(tagSummary(selection().tags, taxonomy)).toBe('东方修真 · 废柴逆袭 · 升级流 · 热血 · 等级 · 快节奏')
  })

  it('throws a structured error from assertGenreSelection', () => {
    expect(() =>
      assertGenreSelection(selection({ tags: ['tone.hot_blooded', 'theme.growth'] }), taxonomy),
    ).toThrowError(/select 3 to 12 tags/)
  })
})
