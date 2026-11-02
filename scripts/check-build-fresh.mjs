#!/usr/bin/env node
/**
 * Prepack hard gate: refuse to pack a tarball built from stale sources.
 *
 * `check:pack` proves the right files are present and that no sources leaked,
 * but it cannot tell a fresh `lib/` from an old one, and `npm publish` ships
 * whatever `lib/` holds. This runs from `prepack`, so `npm pack` and
 * `npm publish` both stop here when a source file is newer than the build.
 *
 * Silence on success is deliberate: `check:pack` parses `npm pack --json`, and
 * lifecycle scripts inherit stdio, so anything on stdout would corrupt it.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Files that change the emitted JavaScript or its declarations. */
const sources = ['tsdown.config.ts', 'tsdown.client.config.ts', 'tsconfig.json', 'tsconfig.client.json']

/** Outputs the published tarball requires; the oldest one decides freshness. */
const outputs = ['lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'lib/types/client/index.d.ts']

function sourcesUnder(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourcesUnder(path))
    else if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

const mtime = (path) => statSync(path).mtimeMs
const exists = (path) => {
  try {
    statSync(join(root, path))
    return true
  } catch {
    return false
  }
}

const missing = outputs.filter((path) => !exists(path))
if (missing.length > 0) {
  console.error(`build output missing: ${missing.join(', ')}`)
  console.error('run `corepack pnpm build` before packing or publishing.')
  process.exit(1)
}

let newest = { path: '', at: 0 }
for (const path of [...sources.map((name) => join(root, name)), ...sourcesUnder(join(root, 'src'))]) {
  const at = mtime(path)
  if (at > newest.at) newest = { path, at }
}

const oldestBuild = outputs
  .map((path) => ({ path, at: mtime(join(root, path)) }))
  .sort((left, right) => left.at - right.at)[0]

if (newest.at > oldestBuild.at) {
  console.error(`stale build: ${newest.path} is newer than ${oldestBuild.path}`)
  console.error('run `corepack pnpm build` before packing or publishing.')
  process.exit(1)
}
