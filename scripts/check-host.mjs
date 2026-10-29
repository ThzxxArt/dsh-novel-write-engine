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
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
if (process.platform === 'win32') {
  // The DSH CLI is a POSIX shim here; spawning it through cmd.exe with a
  // multi-word task silently changes argv. Refuse instead of printing a false
  // "passed" from a truncated prompt. Windows packaging is covered by
  // platform-build in CI.
  console.error('check:host is POSIX-only; use the platform-build job on Windows')
  process.exit(2)
}
const shell = process.platform === 'win32'
const npm = shell ? 'npm.cmd' : 'npm'
const dsh = process.env.DSH_BIN ?? 'dsh'
const profile = `nwe-host-${process.pid}`
const headlessProfile = `nwe-headless-${process.pid}`
const keep = process.env.DSH_KEEP_HOST === '1'
const temporary = await mkdtemp(join(tmpdir(), 'nwe-host-'))
const env = { ...process.env, DSH_HOME: temporary, NO_COLOR: '1', DSH_TELEMETRY_DISABLED: '1' }
const smokeProject = join(temporary, 'host-smoke-project')
let expectedNovelTools = []
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

  // The host gate must exercise the artifact built from this worktree, not a
  // stale lib/ left by an earlier run.
  try {
    execFileSync(npm, ['run', 'build'], {
      cwd: root,
      env,
      encoding: 'utf8',
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw new Error(
      `host gate could not rebuild lib/: ${error instanceof Error ? error.message : String(error)}`,
    )
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
  if (!installed.includes('name: 网文工坊')) {
    throw new Error('preset row has no readable 网文工坊 name in --dump-config')
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
  if (body.schemaVersion !== 4) throw new Error('panel payload has no schemaVersion 4')
  if (
    typeof body.selection !== 'object' ||
    body.selection === null ||
    typeof body.selection.source !== 'string' ||
    !Array.isArray(body.projects)
  ) {
    throw new Error('panel payload is missing projects/selection shape')
  }
  for (const project of body.projects) {
    if (
      typeof project !== 'object' ||
      project === null ||
      typeof project.root !== 'string' ||
      typeof project.title !== 'string' ||
      typeof project.active !== 'boolean' ||
      typeof project.registered !== 'boolean' ||
      !['ok', 'damaged', 'missing', 'unreadable'].includes(project.state)
    ) {
      throw new Error('panel project option is missing v4 fields')
    }
  }
  if (body.empty === true) {
    if (typeof body.error !== 'string' || body.error === '') {
      throw new Error('empty panel payload has no explanatory error text')
    }
  } else if (
    typeof body.summary !== 'object' ||
    body.summary === null ||
    typeof body.summary.root !== 'string' ||
    typeof body.chapters !== 'object' ||
    body.chapters === null ||
    typeof body.gates !== 'object' ||
    body.gates === null
  ) {
    throw new Error('panel payload is missing v4 summary.root/chapters/gates')
  }
  if (body.resume !== undefined && typeof body.resume?.text !== 'string') {
    throw new Error('panel resume field is not text')
  }
  console.log(`host gate passed: plugin mounted, panel 401→200, preset present (${url})`)

  // Stop the Web process before booting a second profile against the same
  // DSH_HOME; a live Web session can hold host-wide state that makes the
  // headless cold boot appear to hang.
  await stop()
  child = undefined

  // A panel route proves the bundle mounted, not that the host registered the
  // tools. Derive the expected names from the freshly built artifact instead of
  // duplicating them here; a hardcoded list silently drifts when a tool is
  // added or removed.
  const built = await import(pathToFileURL(join(root, 'lib/index.js')).href)
  expectedNovelTools = [...built.TOOL_NAMES]
  if (expectedNovelTools.length !== 28) {
    throw new Error(`expected 28 TOOL_NAMES in the built artifact, got ${expectedNovelTools.length}`)
  }
  // Run the real headless app against a local Messages peer and require one
  // actual novel_init call plus a final answer.
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
  // 0.2.1-rc.3 npm releases do not yet expose `--permission-mode`; keep the
  // gate compatible with both the source checkout and the published CLI.
  const headlessHelp = run(['--profile', headlessProfile, '--help'])
  const headlessArgs = [
    '--profile',
    headlessProfile,
    ...(headlessHelp.includes('--permission-mode') ? ['--permission-mode', 'danger-full-access'] : []),
    'create the host smoke project',
  ]
  let smoke
  try {
    smoke = await runAsync(headlessArgs, {
      env: {
        ...env,
        DEEPSEEK_API_KEY: 'host-smoke-key',
        DEEPSEEK_BASE_URL: mock.baseURL,
        DSH_PERMISSION_MODE: 'danger-full-access',
      },
      timeout: Number(process.env.DSH_SMOKE_TIMEOUT_MS ?? 180_000),
    })
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
  // Read the declared tool list, never a substring of the whole request JSON.
  // Persona/task-book text legitimately mentions tool names and used to make
  // this loop pass even when the host registered no tools at all.
  const declared = new Set()
  for (const request of mock.requests) {
    if (!Array.isArray(request.tools)) continue
    for (const tool of request.tools) {
      if (typeof tool?.name === 'string') declared.add(tool.name)
    }
  }
  const declaredNovel = [...declared].filter((name) => name.startsWith('novel_')).sort()
  const expectedNovel = [...expectedNovelTools].sort()
  if (
    declaredNovel.length !== expectedNovel.length ||
    declaredNovel.some((name, index) => name !== expectedNovel[index])
  ) {
    throw new Error(
      `headless declared ${declaredNovel.length} novel tools, expected ${expectedNovel.length}: ${declaredNovel.join(', ')}`,
    )
  }
  const toolResults = mock.requests.flatMap((request) =>
    Array.isArray(request.messages)
      ? request.messages.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.filter(
                (block) => block?.type === 'tool_result' && block?.tool_use_id === 'host-smoke-call',
              )
            : [],
        )
      : [],
  )
  if (toolResults.length === 0) {
    throw new Error('headless did not return a tool_result for host-smoke-call to the model')
  }
  if (!JSON.stringify(toolResults).includes('Host Smoke')) {
    throw new Error('headless tool_result did not carry the novel_init result')
  }
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
