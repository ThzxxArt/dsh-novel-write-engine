import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { readBundledText } from '../src/assets.js'
import { compileTaxonomy } from '../src/domain/taxonomy.js'

const base = (): Record<string, any> =>
  parse(readBundledText('taxonomy/taxonomy.yaml')) as Record<string, any>
const reject = (mutate: (raw: Record<string, any>) => void): void => {
  const raw = structuredClone(base())
  mutate(raw)
  expect(() => compileTaxonomy(raw)).toThrow(/taxonomy rejected/)
}

describe('taxonomy compile assertions', () => {
  it('rejects malformed majors and subs', () => {
    reject((raw) => {
      raw.taxonomy_version = 0
    })
    reject((raw) => {
      raw.majors = {}
    })
    reject((raw) => {
      raw.majors[0].id = 'Bad ID'
    })
    reject((raw) => {
      raw.majors[1].id = raw.majors[0].id
    })
    reject((raw) => {
      raw.majors[0].subs = {}
    })
    reject((raw) => {
      raw.majors[0].subs[0].id = 'wrong.prefix'
    })
    reject((raw) => {
      raw.majors[0].subs[1].id = raw.majors[0].subs[0].id
    })
    reject((raw) => {
      raw.majors[0].subs[0].label = ''
    })
    reject((raw) => {
      raw.majors[0].subs[0].audience_default = 'nobody'
    })
    reject((raw) => {
      raw.majors[0].subs[0].legacy_genre = '不存在的旧类型'
    })
    reject((raw) => {
      raw.majors[0].subs[0].profile = { unknown_key: 1 }
    })
    reject((raw) => {
      raw.majors[0].subs[0].profile = { foreshadow_min_dormancy: -1 }
    })
    reject((raw) => {
      raw.majors[0].platform_fit = { fanqie: 'huge' }
    })
    reject((raw) => {
      raw.majors[0].status = 'gone'
    })
    reject((raw) => {
      raw.majors[0].status = 'deprecated'
    })
  })

  it('rejects malformed tags', () => {
    reject((raw) => {
      raw.tags = {}
    })
    reject((raw) => {
      raw.tags[0].id = 'bad id'
    })
    reject((raw) => {
      raw.tags[0].facet = 'unknown'
    })
    reject((raw) => {
      raw.tags[0].id = 'plot.impostor'
    })
    reject((raw) => {
      raw.tags[1].id = raw.tags[0].id
    })
    reject((raw) => {
      raw.tags[0].label = ''
    })
    reject((raw) => {
      raw.tags[0].conflicts = ['world.nope']
    })
    reject((raw) => {
      raw.tags[0].conflicts = [raw.tags[0].id]
    })
    reject((raw) => {
      raw.tags.find((tag: { id: string }) => tag.id === 'world.modern_city').conflicts = ['world.cyber']
    })
    reject((raw) => {
      raw.tags[0].requires = ['world.nope']
    })
    reject((raw) => {
      raw.tags[0].recommended_for = ['fantasy.nope']
    })
    reject((raw) => {
      raw.tags[0].profile = { lexicon_add: 'not-an-array' }
    })
    reject((raw) => {
      raw.tags[0].profile = { dialogue_ratio: [0.6, 0.4] }
    })
    reject((raw) => {
      raw.tags[0].profile = { paragraph_max_words: 10 }
    })
    reject((raw) => {
      raw.tags[0].profile = { water_words: 2 }
    })
    reject((raw) => {
      raw.tags[0].profile = { pleasure_density: 0 }
    })
    reject((raw) => {
      raw.tags[0].status = 'gone'
    })
  })

  it('rejects requires cycles and deep chains', () => {
    reject((raw) => {
      raw.tags[0].requires = [raw.tags[0].id]
    })
    reject((raw) => {
      const a = raw.tags[0]
      const b = raw.tags[1]
      a.requires = [b.id]
      b.requires = [a.id]
    })
  })
})
