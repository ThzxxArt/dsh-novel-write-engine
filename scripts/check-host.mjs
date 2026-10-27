#!/usr/bin/env node
/**
 * Release-shaped host gate: install the packed tarball into a disposable DSH
 * profile, boot the real Web app, prove the panel route is authenticated, and
 * remove the plugin again. This intentionally does not use the test harness:
 * a green unit suite cannot prove that the host actually mounts the bundle.
 *
 * Usage:
 *   pnpm check:host
 *   DSH_BIN=/path/to/dsh pnpm check:host
 *
 * Set DSH_KEEP_HOST=1 to keep the temporary home for debugging.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const shell = process.platform === 'win32'
const npm = shell ? 'npm.cmd' : 'npm'
const dsh = process.env.DSH_BIN ?? 'dsh'
const profile = `nwe-host-${process.pid}`
const keep = process.env.DSH_KEEP_HOST === '1'
const temporary = await mkdtemp(join(tmpdir(), 'nwe-host-'))
const env = { ...process.env, DSH_HOME: temporary, NO_COLOR: '1' }
let packed
let child
let hostStderr = ''

const run = (args, options = {}) =>
  execFileSync(dsh, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    shell,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout ?? 120_000,
  })

const stop = async () => {
  if (child === undefined || child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(undefined)
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
  })
}

const waitForUrl = () =>
  new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      reject(new Error(`host did not print a Web URL within 60s\n${buffer}`))
    }, 60_000)
    const onData = (chunk) => {
      buffer += String(chunk)
      const match = /dsh web:\s+(http:\/\/\S+)/.exec(buffer)
      if (match !== null) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        resolve(match[1])
      }
    }
    child.stdout.on('data', onData)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer)
        reject(new Error(`host exited before printing a URL (code ${code})\n${buffer}`))
      }
    })
  })

try {
  try {
    run(['--version'])
  } catch (error) {
    console.error(`cannot run ${dsh}: ${error instanceof Error ? error.message : String(error)}`)
    console.error('set DSH_BIN to a DSH CLI binary with Web support')
    process.exit(2)
  }

  const raw = execFileSync(npm, ['pack', '--json'], { cwd: root, encoding: 'utf8', shell })
  const parsed = JSON.parse(raw)
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  packed = join(root, entry.filename)

  // The disposable profile must start from the shipped Web template; a bare
  // profile has no Web app and would never listen on a port.
  run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  run(['plugin', '--profile', profile, 'add', packed])
  const installed = run(['--profile', profile, '--dump-config'])
  if (!installed.includes('# == dsh-novel-write-engine')) {
    throw new Error('plugin layer is missing from --dump-config after install')
  }
  if (!installed.includes('id: preset-novel-write-engine')) {
    throw new Error('preset row is missing from --dump-config after install')
  }

  child = spawn(dsh, ['--profile', profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: root,
    env,
    shell,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (chunk) => {
    hostStderr += String(chunk)
  })
  const url = await waitForUrl()
  const response = await fetch(url, { redirect: 'manual' })
  if (response.status !== 303) {
    throw new Error(`expected the token URL to redirect, got HTTP ${response.status}`)
  }
  const cookie = response.headers.getSetCookie?.()[0]?.split(';')[0]
  if (cookie === undefined || cookie === '') {
    throw new Error('token redirect did not set a session cookie')
  }
  const panel = new URL('/api/novel-write-engine/panel', url)
  const anonymous = await fetch(panel)
  if (anonymous.status !== 401) {
    throw new Error(`anonymous panel request should be 401, got ${anonymous.status}`)
  }
  const authorized = await fetch(panel, { headers: { cookie } })
  if (authorized.status !== 200) {
    throw new Error(`authenticated panel request should be 200, got ${authorized.status}`)
  }
  const body = await authorized.json()
  if (body.schemaVersion !== 1) throw new Error('panel payload has no schemaVersion 1')
  console.log(`host gate passed: plugin mounted, panel 401→200, preset present (${url})`)

  await stop()
  child = undefined
  run(['plugin', '--profile', profile, 'remove', 'dsh-novel-write-engine'])
  const removed = run(['--profile', profile, '--dump-config'])
  if (removed.includes('# == dsh-novel-write-engine')) {
    throw new Error('plugin layer is still present after remove')
  }
  console.log('host gate passed: remove removes the layer')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  if (hostStderr.trim() !== '') console.error(hostStderr.trim())
  process.exitCode = 1
} finally {
  await stop()
  if (!keep) {
    await rm(temporary, { recursive: true, force: true })
    if (packed !== undefined) await rm(packed, { force: true })
  } else {
    console.error(`kept temporary host home: ${temporary}`)
    console.error(`kept packed tarball: ${packed ?? '(none)'}`)
  }
}
