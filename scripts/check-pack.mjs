#!/usr/bin/env node
/** Verify the published tarball contains the data files and none of the sources. */
import { execFileSync } from 'node:child_process'

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' })
const parsed = JSON.parse(raw)
// npm <= 11 emits an array of pack results; npm 12 emits an object keyed by name.
const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
const files = entry.files.map((file) => file.path)

const required = [
  'lib/index.js',
  'lib/index.d.ts',
  'lib/client.js',
  'rulepacks/default.yaml',
  'briefs/P1.md',
  'briefs/P2.md',
  'briefs/P3.md',
  'briefs/P4.md',
  'briefs/P5.md',
  'briefs/P6.md',
  'briefs/P8.md',
  'locale/zh.json',
  'locale/en.json',
  'cordis.patch.yml',
  'presets/novel-write-engine.patch.yml',
]
const forbidden = /^(src|tests|scripts)\/|^DESIGN\.md$|^PLAN\.md$|\.map$/

const missing = required.filter((path) => !files.includes(path))
const leaked = files.filter((path) => forbidden.test(path))
if (missing.length > 0) console.error(`missing from tarball: ${missing.join(', ')}`)
if (leaked.length > 0) console.error(`must not ship: ${leaked.join(', ')}`)
if (missing.length > 0 || leaked.length > 0) process.exit(1)
console.log(`pack check passed: ${files.length} files`)
