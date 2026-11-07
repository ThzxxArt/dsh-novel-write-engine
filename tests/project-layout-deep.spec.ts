import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stringify as stringifyYaml } from 'yaml'
import {
  initProjectV2,
  loadProjectV2,
  parseProjectTargets,
  profileFor,
  saveProjectConfig,
} from '../src/kernel/project/layout.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const validInput = (root: string) => ({
  root,
  title: '布局测试',
  genre: {
    major: 'mystery',
    sub: 'mystery.detective',
    tags: ['theme.mystery', 'plot.investigation', 'tone.cold'],
  },
  audience: 'general' as const,
  platform: 'fanqie' as const,
  targets: { total_chapters: 2 },
})

describe('project layout deep paths', () => {
  it('refuses missing, malformed, schema-drifted and inverted-target projects', async () => {
    const missing = mkdtempSync(join(tmpdir(), 'layout-missing-'))
    roots.push(missing)
    await expect(loadProjectV2(missing)).rejects.toMatchObject({ code: 'STUDIO_PROJECT_NOT_FOUND' })

    const broken = mkdtempSync(join(tmpdir(), 'layout-broken-'))
    roots.push(broken)
    writeFileSync(join(broken, 'studio.yaml'), '{broken')
    await expect(loadProjectV2(broken)).rejects.toMatchObject({ code: 'STUDIO_PROJECT_INVALID' })

    const drifted = mkdtempSync(join(tmpdir(), 'layout-drift-'))
    roots.push(drifted)
    writeFileSync(join(drifted, 'studio.yaml'), 'schema_version: 2\nformat_version: 2\nid: x\n')
    await expect(loadProjectV2(drifted)).rejects.toMatchObject({ code: 'STUDIO_PROJECT_INVALID' })

    const inverted = mkdtempSync(join(tmpdir(), 'layout-inverted-'))
    roots.push(inverted)
    await initProjectV2(validInput(inverted))
    const project = await loadProjectV2(inverted)
    const config = stringifyYaml({
      ...project.config,
      targets: { ...project.config.targets, words_per_chapter: [4000, 2000] },
    })
    writeFileSync(join(inverted, 'studio.yaml'), config)
    await expect(loadProjectV2(inverted)).rejects.toMatchObject({ code: 'STUDIO_PROJECT_INVALID' })
  })

  it('refuses duplicate init and invalid genre combinations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'layout-dup-'))
    roots.push(root)
    await initProjectV2(validInput(root))
    await expect(initProjectV2(validInput(root))).rejects.toMatchObject({
      code: 'STUDIO_PROJECT_EXISTS',
    })
    const project = await loadProjectV2(root)
    await expect(
      saveProjectConfig(project, {
        genre: {
          major: 'mystery',
          sub: 'mystery.detective',
          tags: ['world.eastern_cultivation', 'world.western_magic', 'tone.cold'],
        },
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/GENRE_SELECTION_INVALID/u) })
  })

  it('parses targets and resolves the taxonomy profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'layout-profile-'))
    roots.push(root)
    await initProjectV2(validInput(root))
    const project = await loadProjectV2(root)
    expect(
      parseProjectTargets({
        total_chapters: 2,
        words_per_chapter: [2200, 3200],
        dialogue_ratio: [0.3, 0.5],
        min_cjk_chars: 2000,
      }).total_chapters,
    ).toBe(2)
    expect(() => parseProjectTargets({ total_chapters: 0 })).toThrow()
    expect(profileFor(project).values).toBeDefined()
    expect(project.paths.root).toBe(root)
  })
})
