#!/usr/bin/env node
/**
 * Load the built host and browser entries, not just their filenames.
 * A build that drops `apply` or changes the client banner id must fail here.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const require = createRequire(resolve(root, 'package.json'))
const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

const host = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)
check(host.name === manifest.name, `host export name ${String(host.name)} != ${manifest.name}`)
check(typeof host.apply === 'function', 'host entry does not export apply()')
check(Array.isArray(host.inject) && host.inject.includes('tools'), 'host entry does not inject tools')

const source = readFileSync(resolve(root, 'lib/client.js'), 'utf8')
check(
  source.startsWith('window.__ModuleLoader__.load({'),
  'client entry does not use the module loader banner',
)
let registration
const fakeWindow = {
  __ModuleLoader__: {
    load: (entry) => {
      registration = entry
    },
  },
}
try {
  new Function('window', source)(fakeWindow)
} catch (error) {
  failures.push(`client entry threw while loading: ${error instanceof Error ? error.message : String(error)}`)
}
check(registration?.id === manifest.name, `client entry id ${String(registration?.id)} != ${manifest.name}`)
if (typeof registration?.factory === 'function') {
  try {
    const client = registration.factory(require)
    check(typeof client.apply === 'function', 'client entry does not export apply()')
    check(typeof client.NovelPanel === 'function', 'client entry does not export NovelPanel')
    check(typeof client.NovelIcon === 'function', 'client entry does not export NovelIcon')
  } catch (error) {
    failures.push(`client factory threw: ${error instanceof Error ? error.message : String(error)}`)
  }
} else {
  failures.push('client entry has no factory')
}

if (failures.length > 0) {
  console.error(`artifact check failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`artifact check passed: ${manifest.name} host + client entries load`)
