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
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const shell = process.platform === 'win32'
const npm = shell ? 'npm.cmd' : 'npm'
const dsh = process.env.DSH_BIN ?? 'dsh'
const profile = `nwe-host-${process.pid}`
const headlessProfile = `nwe-headless-${process.pid}`
const keep = process.env.DSH_KEEP_HOST === '1'
const temporary = await mkdtemp(join(tmpdir(), 'nwe-host-'))
const env = { ...process.env, DSH_HOME: temporary, NO_COLOR: '1', DSH_TELEMETRY_DISABLED: '1' }
const smokeProject = join(temporary, 'host-smoke-project')
const expectedNovelTools = [
  'novel_init',
  'novel_status',
  'novel_brief',
  'novel_plan_world',
  'novel_plan_chapter',
  'novel_write_draft',
  'novel_review',
  'novel_revise',
  'novel_check',
  'novel_archive',
  'novel_word_count',
  'novel_state',
  'novel_amend',
  'novel_rollback',
  'novel_diff',
  'novel_export',
  'novel_audit',
  'novel_pipeline',
]
let packed
let child
let mock
let hostStderr = ''

const run = (args, options = {}) =>
  execFileSync(dsh, args, {
    cwd: root,
    env: options.env ?? env,
    encoding: 'utf8',
    shell,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout ?? 120_000,
  })

/**
 * Non-blocking sibling of `run`. The headless smoke talks to the in-process
 * Messages mock; `execFileSync` would block this event loop and deadlock the
 * mock before it could answer the first request.
 */
const runAsync = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const childProcess = spawn(dsh, args, {
      cwd: root,
      env: options.env ?? env,
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    childProcess.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    childProcess.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      childProcess.kill('SIGTERM')
      reject(
        Object.assign(new Error(`command timed out after ${options.timeout ?? 180_000}ms`), {
          stdout,
          stderr,
        }),
      )
    }, options.timeout ?? 180_000)
    childProcess.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    childProcess.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(Object.assign(new Error(`command exited with code ${String(code)}`), { stdout, stderr }))
    })
  })

/**
 * Minimal Messages API peer for the headless smoke. It is intentionally local
 * to this script: the release gate must not add a runtime dependency, and a
 * green unit suite cannot prove the host mounted the tools.
 */
const startMessagesMock = () =>
  new Promise((resolve, reject) => {
    const requests = []
    let toolIssued = false
    const server = createServer(async (request, response) => {
      try {
        const path = new URL(request.url ?? '/', 'http://mock.invalid').pathname
        if (request.method !== 'POST' || !path.endsWith('/v1/messages')) {
          response.writeHead(404).end()
          return
        }
        const chunks = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        requests.push(body)
        const tools = Array.isArray(body.tools) ? body.tools : []
        const hasInit = tools.some((tool) => tool?.name === 'novel_init')
        if (process.env.DSH_DEBUG_HOST === '1') {
          console.error(
            `mock request ${requests.length}: ${path}; tools=${tools.length}; novel_init=${String(hasInit)}`,
          )
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        const send = (payload) => {
          response.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`)
        }
        send({
          type: 'message_start',
          message: {
            id: 'host-smoke-message',
            type: 'message',
            role: 'assistant',
            model: 'host-smoke',
            content: [],
            usage: { input_tokens: 8, output_tokens: 0 },
          },
        })
        if (hasInit && !toolIssued) {
          toolIssued = true
          send({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'host-smoke-call', name: 'novel_init', input: {} },
          })
          send({
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify({
                title: 'Host Smoke',
                genre: '都市现代',
                platform: 'fanqie',
                project_root: smokeProject,
              }),
            },
          })
          send({ type: 'content_block_stop', index: 0 })
          send({
            type: 'message_delta',
            delta: { stop_reason: 'tool_use', stop_sequence: null },
            usage: { output_tokens: 8 },
          })
        } else {
          send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
          send({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'NWE_HOST_TOOL_OK' },
          })
          send({ type: 'content_block_stop', index: 0 })
          send({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 3 },
          })
        }
        send({ type: 'message_stop' })
        response.end()
      } catch (error) {
        reject(error)
        response.destroy()
      }
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        baseURL: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => done(undefined))
          }),
      })
    })
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

  // Stop the Web process before booting a second profile against the same
  // DSH_HOME; a live Web session can hold host-wide state that makes the
  // headless cold boot appear to hang.
  await stop()
  child = undefined

  // A panel route proves the bundle mounted, not that the host registered the
  // tools. Run the real headless app against a local Messages peer and require
  // one actual novel_init call plus a final answer.
  mock = await startMessagesMock()
  run(['--profile', headlessProfile, '--from-default-profile', 'headless', '--dump-config'])
  run(['plugin', '--profile', headlessProfile, 'add', packed])
  const headlessConfig = run(['--profile', headlessProfile, '--dump-config'])
  if (!headlessConfig.includes('# == dsh-novel-write-engine')) {
    throw new Error('headless profile is missing the plugin layer')
  }
  if (!headlessConfig.includes('id: preset-novel-write-engine')) {
    throw new Error('headless profile is missing the novel preset')
  }
  let smoke
  try {
    smoke = await runAsync(
      [
        '--profile',
        headlessProfile,
        '--permission-mode',
        'danger-full-access',
        'create the host smoke project',
      ],
      {
        env: {
          ...env,
          DEEPSEEK_API_KEY: 'host-smoke-key',
          DEEPSEEK_BASE_URL: mock.baseURL,
          DSH_PERMISSION_MODE: 'danger-full-access',
        },
        timeout: Number(process.env.DSH_SMOKE_TIMEOUT_MS ?? 180_000),
      },
    )
  } catch (error) {
    throw new Error(
      `headless smoke failed after ${mock.requests.length} model request(s): ${error instanceof Error ? error.message : String(error)}\n${String(error?.stdout ?? '')}\n${String(error?.stderr ?? '')}`,
    )
  }
  if (!smoke.includes('NWE_HOST_TOOL_OK')) {
    throw new Error(`headless smoke did not receive the final marker; output: ${smoke}`)
  }
  if (!existsSync(join(smokeProject, 'novel.yaml'))) {
    throw new Error('headless smoke called the model but novel_init did not create the project')
  }
  const wire = JSON.stringify(mock.requests)
  for (const tool of expectedNovelTools) {
    if (!wire.includes(tool)) throw new Error(`headless request never exposed ${tool}`)
  }
  if (!wire.includes('tool_result')) throw new Error('headless did not return a tool result to the model')
  console.log('host gate passed: headless exposed novel_init and executed it through the host')

  await mock.close()
  mock = undefined
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
  if (mock !== undefined) await mock.close()
  if (!keep) {
    await rm(temporary, { recursive: true, force: true })
    if (packed !== undefined) await rm(packed, { force: true })
  } else {
    console.error(`kept temporary host home: ${temporary}`)
    console.error(`kept packed tarball: ${packed ?? '(none)'}`)
  }
}
