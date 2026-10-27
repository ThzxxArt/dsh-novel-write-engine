#!/usr/bin/env node
/**
 * Release-shaped install gate: pack the tarball, install it into an empty
 * consumer, and load both package halves from the installed name. This catches
 * `files` omissions, broken exports and entry points that work only in-tree.
 */
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const shell = process.platform === 'win32'
const npm = shell ? 'npm.cmd' : 'npm'
const temporary = await mkdtemp(join(tmpdir(), 'nwe-install-'))
let packed

try {
  const raw = execFileSync(npm, ['pack', '--json'], { cwd: root, encoding: 'utf8', shell })
  const parsed = JSON.parse(raw)
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  packed = join(root, entry.filename)

  const consumer = join(temporary, 'consumer')
  await mkdir(consumer)
  const installed = join(consumer, 'package.tgz')
  await copyFile(packed, installed)
  await rm(packed, { force: true })
  packed = undefined
  await writeFile(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'nwe-install-check', private: true, type: 'module' }, null, 2)}\n`,
  )
  execFileSync(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', './package.tgz'], {
    cwd: consumer,
    stdio: 'inherit',
    shell,
  })

  const smoke = join(consumer, 'smoke.mjs')
  await writeFile(
    smoke,
    [
      'let registration;',
      'globalThis.window = { __ModuleLoader__: { load: (entry) => { registration = entry; } } };',
      "const host = await import('dsh-novel-write-engine');",
      "await import('dsh-novel-write-engine/client');",
      "if (typeof host.apply !== 'function') throw new Error('host entry has no apply()');",
      "if (registration?.id !== 'dsh-novel-write-engine') throw new Error(`client id ${String(registration?.id)} is wrong`);",
      "if (typeof registration.factory !== 'function') throw new Error('client entry has no factory');",
      "console.log('consumer install check passed: host + client entry load from tarball');",
    ].join('\n'),
  )
  execFileSync(process.execPath, [smoke], { cwd: consumer, stdio: 'inherit' })
  console.log(`install check packed ${entry.filename}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
  if (packed !== undefined) await rm(packed, { force: true })
}
