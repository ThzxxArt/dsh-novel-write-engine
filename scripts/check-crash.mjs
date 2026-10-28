#!/usr/bin/env node
/**
 * True cross-process crash gate. A child process is SIGKILLed while a
 * single-file brief transaction is pending; the parent must recover the
 * journal and read the project again without a manual repair.
 *
 * Brief writes are deliberately one-file transactions: a kill can only land
 * before or after the rename, never between two renames, so this gate tests
 * recovery rather than the documented partial-rename refusal path.
 *
 * This needs the built `lib/` entry (run `pnpm build` first) and is run in the
 * release/build job, not in the source-level unit suite.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const lib = pathToFileURL(join(root, 'lib/index.js')).href
const temporary = await mkdtemp(join(tmpdir(), 'nwe-crash-'))
const projects = Array.from({ length: 16 }, (_, index) => join(temporary, `project-${index}`))
const project = projects[0]
const stateDir = join(temporary, 'state')
let child
let childOutput = ''
let childError = ''

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fail = async (message) => {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
  console.error(message)
  if (childOutput.trim() !== '') console.error(childOutput.trim())
  if (childError.trim() !== '') console.error(childError.trim())
  await rm(temporary, { recursive: true, force: true })
  process.exit(1)
}

try {
  const { EngineService, loadRulepack } = await import(lib)
  const config = {
    projectRoot: project,
    stateDir,
    tools: { mode: 'all' },
    quality: { minScore: 120 },
    briefs: { overrides: '' },
    storage: { backupRetention: 2 },
  }
  const parent = new EngineService(config, () => loadRulepack())
  for (const [index, projectRoot] of projects.entries()) {
    await parent.initProject({
      title: `Cross Process Crash ${index}`,
      genre: '都市现代',
      platform: 'fanqie',
      words_per_chapter: [80, 400],
      root: projectRoot,
    })
  }
  parent.dispose()

  const childCode = `
    import { EngineService, loadRulepack } from ${JSON.stringify(lib)}
    const roots = JSON.parse(process.argv[1])
    const stateDir = process.argv[2]
    const engine = new EngineService({
      projectRoot: roots[0],
      stateDir,
      tools: { mode: 'all' },
      quality: { minScore: 120 },
      briefs: { overrides: '' },
      storage: { backupRetention: 2 },
    }, () => loadRulepack())
    const stages = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P8']
    process.stdout.write('ready\\n')
    for (const root of roots) {
      for (const stage of stages) {
        await engine.getBrief({ stage, root })
      }
    }
    process.stdout.write('done\\n')
  `
  child = spawn(
    process.execPath,
    ['--input-type=module', '-e', childCode, JSON.stringify(projects), stateDir],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.on('data', (chunk) => {
    childOutput += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    childError += String(chunk)
  })

  const journalFor = (root) => join(root, 'state', 'journal.jsonl')
  const readTail = async (root) => {
    const text = await readFile(journalFor(root), 'utf8')
    let last = null
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line)
        if (record.op !== 'lock_reclaimed') last = record
      } catch {
        // A torn final line is not a transaction record.
      }
    }
    return last
  }
  let pendingProject = null
  let pendingTxid = null
  let killed = false
  for (let attempt = 0; attempt < 3 && !killed; attempt += 1) {
    pendingProject = null
    pendingTxid = null
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      for (const candidate of projects) {
        try {
          const last = await readTail(candidate)
          if (last?.status === 'pending') {
            pendingProject = candidate
            pendingTxid = String(last.txid)
            break
          }
        } catch {
          // The first transaction has not written this journal yet.
        }
      }
      if (pendingProject !== null) break
      if (child.exitCode !== null) break
      await sleep(1)
    }
    if (pendingProject === null || child.exitCode !== null) break
    if (process.platform !== 'win32') {
      child.kill('SIGSTOP')
      await sleep(5)
      const stopped = await readTail(pendingProject)
      if (stopped?.txid !== pendingTxid || stopped?.status !== 'pending') {
        child.kill('SIGCONT')
        continue
      }
    }
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null) resolve(undefined)
      else child.once('exit', () => resolve(undefined))
    })
    killed = child.kill('SIGKILL')
    await exited
  }
  if (!killed || child.signalCode !== 'SIGKILL') {
    await fail('the gate did not actually SIGKILL a pending child process')
  }
  if (childError.trim() !== '') {
    await fail('the crash child wrote an unexpected error before being killed')
  }

  const crashed = (await readFile(journalFor(pendingProject), 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((record) => record !== null && record.op !== 'lock_reclaimed')
  if (crashed.at(-1)?.txid !== pendingTxid || crashed.at(-1)?.status !== 'pending') {
    await fail('the SIGKILL did not land on the pending transaction; the gate did not prove crash recovery')
  }

  const recovered = new EngineService({ ...config, projectRoot: pendingProject }, () => loadRulepack())
  const status = await recovered.getStatus({ root: pendingProject })
  if (!status.data.project.title.startsWith('Cross Process Crash')) {
    await fail('status did not return the project after crash recovery')
  }
  // A mutation forces recoverPending() and the journal consistency check.
  await recovered.getBrief({ stage: 'P1', root: pendingProject })
  const journalAfter = await readFile(journalFor(pendingProject), 'utf8')
  const records = journalAfter
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
  const terminal = records.find(
    (record) => record.txid === pendingTxid && (record.status === 'committed' || record.status === 'aborted'),
  )
  if (terminal === undefined) {
    await fail(`pending transaction ${pendingTxid} has no terminal journal row after recovery`)
  }
  const last = [...records].reverse().find((record) => record.op !== 'lock_reclaimed')
  if (last?.status === 'pending') {
    await fail('the last journal transaction is still pending after recovery')
  }
  const characters = await recovered.queryState({ kind: 'characters', root: pendingProject })
  if (characters.data === null || typeof characters.data !== 'object') {
    await fail('characters ledger is not readable after recovery')
  }
  console.log('crash gate passed: SIGKILL left a pending row, recovery completed, project readable')
} catch (error) {
  await fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
  await rm(temporary, { recursive: true, force: true })
}
