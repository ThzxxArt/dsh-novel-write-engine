#!/usr/bin/env node
/**
 * Real out-of-disk-space gate (ENOSPC).
 *
 * The unit suite can only fake an IO failure; this gate mounts a 1 MB tmpfs,
 * initialises a real project on it and drives a real transaction whose staged
 * payload is larger than the free space. A real ENOSPC must then:
 *
 *   1. surface as a typed engine error (never a raw Node error / unhandled
 *      rejection); the underlying errno must still be visible in the cause
 *      chain, or the failure was not a real out-of-disk error;
 *   2. leave an `aborted` terminal row in `state/journal.jsonl` for the
 *      operation (txn.ts writes `aborted` when no target was renamed yet);
 *   3. leave no partial file behind: the project tree is byte-identical except
 *      for the appended journal, and `getStatus` still reads the project;
 *   4. not wedge the project: a later, smaller transaction on the same project
 *      (with space available again) commits normally.
 *
 * Exit codes: 0 proven, 1 the engine is broken or the write did not fail,
 * 2 not verified (no root / no usable tmpfs). Exit 2 prints
 * `ERRNO RESULT: SKIPPED (...)` — exactly `SKIPPED (no root)` when root is the
 * missing piece — and is never a pass.
 *
 * A real 1 MB tmpfs is obtained automatically, cheapest path first:
 *
 *   1. `NWE_ERRNO_TMPFS_DIR=/path` (an external caller already mounted one);
 *   2. `geteuid() === 0` -> mount directly;
 *   3. `unshare -Ur -m` works -> re-exec this script as mapped root inside a
 *      private user + mount namespace with `--in-user-namespace`, where it
 *      mounts its own tmpfs with plain `mount`. No sudo, no host privileges.
 *      `NWE_ERRNO_NO_NAMESPACE=1` skips this step (restricted hosts);
 *   4. otherwise `sudo -n mount`, so a missing password fails fast instead of
 *      hanging, and a failure exits 2 instead of pretending to pass.
 *
 * The `--in-user-namespace` marker only selects "mount here without re-exec";
 * it grants nothing. The child still proves the mount is a real tmpfs of at
 * most 8 MB (statfs magic + size) before asserting anything, so a forged marker
 * with no tmpfs exits 2, never 0.
 *
 * This needs the built `lib/` entry (run `corepack pnpm build` first) and runs
 * in the release/build job, not in the source-level unit suite. It is
 * deliberately a script and not a test: the repository forbids skipped tests.
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const LIB_ENTRY = join(REPO_ROOT, 'lib', 'index.js')

/** `statfs` type of tmpfs on Linux; anything else cannot produce ENOSPC safely. */
const TMPFS_MAGIC = 0x01021994
/** A larger tmpfs would need megabytes of filler to exhaust; refuse instead. */
const MAX_TMPFS_BYTES = 8 * 1024 * 1024
/** Write this much past the free space so the failure cannot be a boundary fluke. */
const PAYLOAD_HEADROOM = 256 * 1024
/** Unique marker so the retry can prove its own payload reached the disk. */
const MARKER = 'errno-gate-retry-ok'
const RETRY_MAX_CHARS = 4096

const JOURNAL_PATH = 'state/journal.jsonl'
const PIPELINE_PATH = 'state/pipeline.yaml'
const PROJECT_PATH = 'novel.yaml'

/** An unhandled rejection would make "typed error" a lie; record and fail instead. */
const rejections = []
process.on('unhandledRejection', (reason) => {
  rejections.push(reason instanceof Error ? reason.message : String(reason))
})

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim()
const clip = (text, max = 240) => {
  const line = oneLine(text)
  return line.length <= max ? line : `${line.slice(0, max)}...`
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/** Free/total bytes and the filesystem magic of `path`. */
const filesystem = async (path) => {
  const stats = await statfs(path)
  return {
    type: Number(stats.type),
    total: Number(stats.blocks) * Number(stats.bsize),
    free: Number(stats.bavail) * Number(stats.bsize),
  }
}

/** Flatten the `cause` chain so evidence shows the errno behind the engine code. */
const describeError = (error) => {
  const frames = []
  const seen = new Set()
  let cursor = error
  while (cursor !== null && cursor !== undefined && !seen.has(cursor) && frames.length < 8) {
    seen.add(cursor)
    const record = typeof cursor === 'object' ? cursor : { message: String(cursor) }
    frames.push({
      name: record.constructor?.name ?? typeof cursor,
      code: typeof record.code === 'string' ? record.code : '',
      message: record.message === undefined ? String(cursor) : String(record.message),
    })
    cursor = typeof cursor === 'object' ? cursor.cause : undefined
  }
  return frames
}

/** Every file (hashed) and directory in the project, keyed by project-relative path. */
const snapshotTree = async (root) => {
  const entries = new Map()
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const key = relative(root, absolute).split(sep).join('/')
      if (entry.isDirectory()) {
        entries.set(`${key}/`, 'dir')
        await walk(absolute)
      } else if (entry.isSymbolicLink()) {
        entries.set(key, 'symlink')
      } else {
        entries.set(key, sha256(await readFile(absolute)))
      }
    }
  }
  await walk(root)
  return entries
}

const diffTrees = (before, after) => {
  const drift = []
  for (const [key, value] of before) {
    const now = after.get(key)
    if (now === undefined) drift.push(`${key} disappeared`)
    else if (now !== value) drift.push(`${key} changed`)
  }
  for (const key of after.keys()) if (!before.has(key)) drift.push(`${key} appeared`)
  return drift
}

const parseJournal = (text) => {
  const rows = []
  let malformed = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      malformed += 1
    }
  }
  return { rows, malformed }
}

const readTextOrNull = async (path) => {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** Mount a 1 MB tmpfs with `sudo -n` so a missing password fails immediately. */
const mountWithSudo = (mountpoint) => {
  const result = spawnSync('sudo', ['-n', 'mount', '-t', 'tmpfs', '-o', 'size=1M', 'tmpfs', mountpoint], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (result.error !== undefined) return { ok: false, detail: result.error.message }
  if (result.status !== 0) {
    const detail = oneLine(result.stderr || result.stdout || `exit ${result.status}`)
    return { ok: false, detail }
  }
  return { ok: true }
}

/** Root / mapped root inside a user namespace: no sudo needed. */
const mountDirectly = (mountpoint) => {
  const result = spawnSync('mount', ['-t', 'tmpfs', '-o', 'size=1M', 'tmpfs', mountpoint], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (result.error !== undefined) return { ok: false, detail: result.error.message }
  if (result.status !== 0) {
    return { ok: false, detail: oneLine(result.stderr || result.stdout || `exit ${result.status}`) }
  }
  return { ok: true }
}

const unmount = (mountpoint, withSudo) => {
  const argv = withSudo ? ['sudo', '-n', 'umount', mountpoint] : ['umount', mountpoint]
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30_000 })
  if (result.error !== undefined) return { ok: false, detail: result.error.message }
  if (result.status !== 0) {
    return { ok: false, detail: oneLine(result.stderr || result.stdout || `exit ${result.status}`) }
  }
  return { ok: true }
}

/** A tmpfs no larger than 8 MB is the only thing this gate can exhaust cheaply. */
const tmpfsProblem = (info) => {
  if (info.type !== TMPFS_MAGIC) return `not a tmpfs (statfs type ${info.type})`
  if (info.total > MAX_TMPFS_BYTES) {
    return `${megabytes(info.total)}, but this gate needs at most ${megabytes(MAX_TMPFS_BYTES)}`
  }
  return null
}

const state = { base: '', mountpoint: '', mountedByUs: false, needSudo: false, workspace: '', label: '' }

const cleanup = async () => {
  if (state.mountedByUs) {
    const result = unmount(state.mountpoint, state.needSudo)
    if (!result.ok) {
      // A failed cleanup is a warning, never a failed run: the checks already ran.
      const command = state.needSudo ? `sudo umount ${state.mountpoint}` : `umount ${state.mountpoint}`
      console.log(`WARN cleanup: ${command} failed (${result.detail})`)
      console.log(`WARN cleanup: the tmpfs is still mounted; unmount it manually: ${command}`)
    }
  }
  if (state.workspace !== '') {
    await rm(state.workspace, { recursive: true, force: true }).catch(() => undefined)
  }
  if (state.base !== '') {
    await rm(state.base, { recursive: true, force: true }).catch((error) => {
      console.log(`WARN cleanup: could not remove ${state.base}: ${clip(error.message)}`)
    })
  }
}

/** Exit 2 helper: never a pass, always says what is unverified. */
const unverified = (reason, result = 'SKIPPED (no root)') => {
  console.log(`WARN ${reason}`)
  console.log(`ERRNO RESULT: ${result}`)
  console.log(
    'UNVERIFIED — no real ENOSPC was produced, so the engine ENOSPC path was NOT exercised; this is not a pass.',
  )
  return 2
}

/**
 * Can this user create a private mount namespace? A private user namespace is
 * enough to mount a tmpfs without root, so the gate does not need sudo here.
 */
const canUseUserNamespace = () => {
  const result = spawnSync('unshare', ['-Ur', '-m', 'true'], {
    encoding: 'utf8',
    timeout: 20_000,
    stdio: 'ignore',
  })
  return result.error === undefined && result.status === 0
}

/** True when the re-exec child ran: it printed its own result line already. */
let delegatedResult = false

/**
 * Re-run this script as mapped root inside a private user + mount namespace.
 * The `--in-user-namespace` marker is what stops the child from repeating this:
 * the child mounts its own tmpfs directly and runs the checks. stdout/stderr are
 * inherited so the child's own PASS/FAIL lines are passed through verbatim, and
 * its exit code becomes ours.
 */
const reexecInUserNamespace = () => {
  const result = spawnSync(
    'unshare',
    ['-Ur', '-m', '--map-root-user', process.execPath, fileURLToPath(import.meta.url), '--in-user-namespace'],
    { stdio: 'inherit', timeout: 300_000 },
  )
  if (result.error !== undefined) {
    return unverified(
      `unshare -Ur -m worked, but the namespace child could not start: ${result.error.message}`,
      'SKIPPED (no usable tmpfs)',
    )
  }
  if (result.status === null) {
    console.log(`FAIL gate crashed — the namespace child was killed by ${result.signal ?? 'a signal'}`)
    return 1
  }
  delegatedResult = true
  return result.status
}

/**
 * @param mode 'external' (NWE_ERRNO_TMPFS_DIR), 'namespace' (re-exec child),
 * 'root' (geteuid() === 0) or 'sudo' (last resort).
 */
const runGate = async (mode) => {
  const module = await import(pathToFileURL(LIB_ENTRY).href)
  const { EngineError, EngineService, ERROR_CODES, STAGING_DIR, loadRulepack } = module
  const ACCEPTED_CODES = new Set([ERROR_CODES.TXN_ABORTED, ERROR_CODES.IO_PERMISSION])

  state.base = await mkdtemp(join(tmpdir(), 'nwe-errno-'))
  const stateDir = join(state.base, 'state')
  await mkdir(stateDir, { recursive: true })

  if (mode === 'external') {
    const provided =
      typeof process.env.NWE_ERRNO_TMPFS_DIR === 'string' ? process.env.NWE_ERRNO_TMPFS_DIR : ''
    let providedDirectory = false
    try {
      providedDirectory = statSync(provided).isDirectory()
    } catch {
      providedDirectory = false
    }
    if (!providedDirectory) {
      return unverified(
        `NWE_ERRNO_TMPFS_DIR=${provided} is not an existing directory; mount a 1 MB tmpfs there first`,
        'SKIPPED (no usable tmpfs)',
      )
    }
    state.mountpoint = provided
    state.label = 'caller-provided'
    const problem = tmpfsProblem(await filesystem(state.mountpoint))
    if (problem !== null) {
      return unverified(
        `NWE_ERRNO_TMPFS_DIR=${provided} is ${problem}; only a small tmpfs can be exhausted`,
        'SKIPPED (no usable tmpfs)',
      )
    }
    // The caller owns the mount; never unmount it here.
    state.workspace = join(state.mountpoint, `nwe-errno-${randomUUID().slice(0, 8)}`)
    await mkdir(state.workspace)
  } else {
    state.mountpoint = join(state.base, 'mnt')
    await mkdir(state.mountpoint)
    const mounted = mode === 'sudo' ? mountWithSudo(state.mountpoint) : mountDirectly(state.mountpoint)
    if (!mounted.ok) {
      if (mode === 'sudo') {
        return unverified(`cannot mount a 1 MB tmpfs (needs root): ${mounted.detail}`)
      }
      return unverified(
        `cannot mount a 1 MB tmpfs inside this ${mode === 'namespace' ? 'user namespace' : 'root session'}: ${mounted.detail}`,
        'SKIPPED (no usable tmpfs)',
      )
    }
    state.mountedByUs = true
    state.needSudo = mode === 'sudo'
    state.label =
      mode === 'namespace'
        ? 'mounted in a user namespace'
        : mode === 'root'
          ? 'mounted as root'
          : 'mounted with sudo -n'
    if (mode === 'namespace') {
      // The child asked to be here; record the mount it made so any nested tool
      // sees the same tmpfs the checks use.
      process.env.NWE_ERRNO_TMPFS_DIR = state.mountpoint
    }
    state.workspace = state.mountpoint
    try {
      await writeFile(join(state.mountpoint, '.writable-probe'), 'ok')
      await rm(join(state.mountpoint, '.writable-probe'), { force: true })
    } catch (error) {
      return unverified(
        `the mounted tmpfs is not writable by this user (${clip(error.message)}); mount it with mode=1777 or run the gate as root`,
        'SKIPPED (no usable tmpfs)',
      )
    }
  }

  // Never trust a mount that merely reported success: a fake or wrong
  // filesystem would make every later check meaningless (and a marker from a
  // caller must never turn into a pass).
  const mountInfo = await filesystem(state.mountpoint)
  const mountProblem = tmpfsProblem(mountInfo)
  if (mountProblem !== null) {
    return unverified(
      `the mount at ${state.mountpoint} is ${mountProblem}; cannot force a real ENOSPC`,
      'SKIPPED (no usable tmpfs)',
    )
  }

  const projectRoot = join(state.workspace, 'project')
  console.log('ERRNO GATE — real out-of-disk-space probe')
  console.log(
    `tmpfs: ${state.mountpoint} (${megabytes(mountInfo.total)} total, ${mountInfo.free} bytes free, ${state.label})`,
  )
  console.log(`project: ${projectRoot}`)

  const engine = new EngineService(
    {
      projectRoot,
      stateDir,
      tools: { mode: 'all' },
      quality: { minScore: 120 },
      briefs: { overrides: '' },
      storage: { backupRetention: 5 },
    },
    () => loadRulepack(),
  )

  let failed = false
  const record = (ok, name, evidence) => {
    if (!ok) failed = true
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${evidence}`)
  }

  try {
    let init
    try {
      init = await engine.initProject({
        title: 'ENOSPC Gate',
        genre: '都市现代',
        platform: 'fanqie',
        words_per_chapter: [800, 1200],
        root: projectRoot,
      })
    } catch (error) {
      const frames = describeError(error)
      console.log(
        `FAIL setup — initialization on the tmpfs failed: ${frames.map((frame) => `${frame.name}(${frame.code || frame.message})`).join(' <- ')}`,
      )
      return 1
    }
    const journalBefore = (await readTextOrNull(join(projectRoot, JOURNAL_PATH))) ?? ''
    const beforeParsed = parseJournal(journalBefore)
    const initialised =
      resolve(init.data.root) === resolve(projectRoot) &&
      journalBefore !== '' &&
      beforeParsed.malformed === 0 &&
      beforeParsed.rows.some((row) => row.status === 'committed')
    if (!initialised) {
      console.log(
        `FAIL setup — init did not leave a readable committed journal (root=${init.data.root}, rows=${beforeParsed.rows.length}, malformed=${beforeParsed.malformed})`,
      )
      return 1
    }
    const treeBefore = await snapshotTree(projectRoot)
    const freeBefore = (await filesystem(state.mountpoint)).free

    // The staged document is the whole merged project, so one oversized field is
    // enough; ASCII keeps bytes == characters and the size arithmetic exact.
    const payloadChars = Math.max(PAYLOAD_HEADROOM, freeBefore + PAYLOAD_HEADROOM)
    let writeError = null
    try {
      await engine.amend({
        path: PROJECT_PATH,
        content: { description: 'x'.repeat(payloadChars) },
        reason: 'errno gate: force a real ENOSPC during staging',
        root: projectRoot,
      })
    } catch (error) {
      writeError = error
    }

    /* ------------------------------------------------------------------ 1 */
    const frames = describeError(writeError)
    const primary = frames[0] ?? { name: '(nothing thrown)', code: '', message: '' }
    // The engine may wrap the errno (txn.ts wraps any failure as TXN_ABORTED),
    // so the proof of a real ENOSPC is the cause frame that still carries it.
    const errno =
      frames.find((frame) => frame.code === 'ENOSPC') ??
      frames.find((frame) => /ENOSPC|no space left on device/i.test(frame.message))
    const typed = writeError instanceof EngineError
    const engineCode = typeof writeError?.code === 'string' ? writeError.code : ''
    const acceptableCode = ACCEPTED_CODES.has(engineCode) || engineCode.includes('_IO_')
    record(
      typed && acceptableCode && errno !== undefined && rejections.length === 0 && writeError !== null,
      'typed ENOSPC error',
      writeError === null
        ? `the oversized write was NOT refused: ${payloadChars} byte payload fitted into ${freeBefore} free bytes (harness bug, the engine was never pressured)`
        : [
            `typed=${primary.name}`,
            `code=${engineCode || '(none)'}`,
            `errno=${errno === undefined ? 'MISSING' : errno.code === '' ? 'in message' : errno.code}`,
            `cause=${clip(errno?.message ?? primary.message, 120)}`,
            `chain=${frames.map((frame) => frame.name).join(' <- ')}`,
            `free_before=${freeBefore}`,
            `payload=${payloadChars}`,
            `unhandled_rejections=${rejections.length}`,
          ].join(', '),
    )

    /* ------------------------------------------------------------------ 2 */
    const journalAfter = (await readTextOrNull(join(projectRoot, JOURNAL_PATH))) ?? ''
    const appended = journalAfter.startsWith(journalBefore)
      ? parseJournal(journalAfter.slice(journalBefore.length))
      : { rows: [], malformed: 0 }
    const afterParsed = parseJournal(journalAfter)
    const abortedRows = appended.rows.filter((row) => row.status === 'aborted' && row.op === 'amend')
    const aborted = abortedRows[0]
    const appendOnly = journalAfter.startsWith(journalBefore)
    record(
      appendOnly && appended.malformed === 0 && abortedRows.length === 1 && afterParsed.malformed === 0,
      'aborted journal record',
      [
        `status=${aborted?.status ?? '(none)'}`,
        `op=${aborted?.op ?? '(none)'}`,
        `txid=${aborted?.txid ?? '(none)'}`,
        `code=${aborted?.code ?? '(none)'}`,
        `appended_rows=${appended.rows.length}`,
        `journal_rows=${afterParsed.rows.length}`,
        `malformed=${afterParsed.malformed}`,
        `reason=${clip(aborted?.reason ?? '(none)', 120)}`,
        appendOnly ? 'journal=append-only' : 'journal=REWRITTEN',
      ].join(', '),
    )

    const claimed =
      Array.isArray(aborted?.files) && aborted.files.length > 0
        ? aborted.files.map(String)
        : [PROJECT_PATH, PIPELINE_PATH]

    /* ------------------------------------------------------------------ 3 */
    let statusError = null
    let status = null
    try {
      status = await engine.getStatus({ root: projectRoot })
    } catch (error) {
      statusError = error
    }
    const treeAfter = await snapshotTree(projectRoot)
    const drift = diffTrees(treeBefore, treeAfter).filter((line) => line !== `${JOURNAL_PATH} changed`)
    const leftovers = [...treeAfter.keys()].filter(
      (key) => key.endsWith('.tmp') || (key.startsWith(`${STAGING_DIR}/`) && key !== `${STAGING_DIR}/`),
    )
    const claimedState = claimed.map((path) => {
      const before = treeBefore.get(path) ?? null
      const after = treeAfter.get(path) ?? null
      return `${path}=${before === after ? (after === null ? 'absent' : 'pre-image') : 'CHANGED'}`
    })
    const claimedIntact = claimedState.every((line) => !line.endsWith('CHANGED'))
    record(
      drift.length === 0 && leftovers.length === 0 && claimedIntact && statusError === null,
      'no partial file survives',
      [
        `drift=${drift.length === 0 ? 0 : drift.slice(0, 4).join('; ')}`,
        `claimed=${claimedState.join(', ')}`,
        `staging_leftovers=${leftovers.length === 0 ? 0 : leftovers.slice(0, 4).join(', ')}`,
        statusError === null
          ? `getStatus=ok stage=${status.data.stage} chapter=${status.data.active_chapter} blocking=${(status.data.blocking ?? []).length}`
          : `getStatus=FAILED ${statusError?.code ?? ''} ${clip(statusError?.message ?? '', 120)}`,
      ].join(', '),
    )

    /* ------------------------------------------------------------------ 4 */
    const freeAfter = (await filesystem(state.mountpoint)).free
    const retryChars = Math.max(512, Math.min(RETRY_MAX_CHARS, Math.floor(freeAfter / 8)))
    let retry = null
    let retryError = null
    try {
      retry = await engine.amend({
        path: PROJECT_PATH,
        content: { description: `${MARKER}${'y'.repeat(retryChars)}` },
        reason: 'errno gate: retry with space available again',
        root: projectRoot,
      })
    } catch (error) {
      retryError = error
    }
    const journalFinal = (await readTextOrNull(join(projectRoot, JOURNAL_PATH))) ?? ''
    const finalParsed = parseJournal(journalFinal)
    const committedRows = finalParsed.rows.filter(
      (row) =>
        row.status === 'committed' &&
        row.op === 'amend' &&
        Array.isArray(row.files) &&
        row.files.includes(PROJECT_PATH),
    )
    const projectText = (await readTextOrNull(join(projectRoot, PROJECT_PATH))) ?? ''
    const projectReadable = projectText.includes(MARKER)
    let retryStatus = null
    let retryStatusError = null
    try {
      retryStatus = await engine.getStatus({ root: projectRoot })
    } catch (error) {
      retryStatusError = error
    }
    const retryFrames = describeError(retryError)
    record(
      retryError === null &&
        retry?.data.revision === init.revision + 1 &&
        committedRows.length >= 1 &&
        projectReadable &&
        retryStatusError === null,
      'later transaction succeeds',
      [
        retryError === null
          ? `amend committed revision=${retry?.data.revision} (expected ${init.revision + 1})`
          : `amend FAILED ${retryFrames.map((frame) => `${frame.name}(${frame.code || clip(frame.message, 80)})`).join(' <- ')}`,
        `free_after=${freeAfter}`,
        `retry_chars=${retryChars}`,
        `committed_amend_rows=${committedRows.length}`,
        `novel.yaml=${projectReadable ? 'payload written' : 'payload MISSING'}`,
        retryStatusError === null
          ? `getStatus=ok stage=${retryStatus.data.stage} chapter=${retryStatus.data.active_chapter}`
          : `getStatus=FAILED ${retryStatusError?.code ?? ''} ${clip(retryStatusError?.message ?? '', 120)}`,
      ].join(', '),
    )

    return failed ? 1 : 0
  } finally {
    engine.dispose()
  }
}

let code = 1
try {
  if (process.platform !== 'linux') {
    code = unverified(
      `this gate needs Linux tmpfs and statfs magic (running on ${process.platform})`,
      'SKIPPED (not linux)',
    )
  } else if (!existsSync(LIB_ENTRY)) {
    console.log(
      `FAIL setup — ${relative(REPO_ROOT, LIB_ENTRY)} is missing; run \`corepack pnpm build\` first`,
    )
  } else {
    // Pick the cheapest way to get a real 1 MB tmpfs, in this order:
    //   1. an externally mounted tmpfs (NWE_ERRNO_TMPFS_DIR);
    //   2. the re-exec child, which must not re-exec again (--in-user-namespace);
    //   3. this process already runs as root;
    //   4. a private user namespace (unshare -Ur -m), which needs no root;
    //   5. sudo -n, and if that fails: exit 2, not verified.
    // NWE_ERRNO_NO_NAMESPACE=1 skips step 4 (escape hatch for restricted hosts).
    const marker = process.argv.includes('--in-user-namespace')
    const provided =
      typeof process.env.NWE_ERRNO_TMPFS_DIR === 'string' ? process.env.NWE_ERRNO_TMPFS_DIR : ''
    const noNamespace = process.env.NWE_ERRNO_NO_NAMESPACE === '1'
    const isRoot = typeof process.geteuid === 'function' && process.geteuid() === 0
    if (provided !== '') {
      code = await runGate('external')
    } else if (marker) {
      // A caller may pass the marker; the child is then verified against a real
      // tmpfs before anything is asserted, so a forged marker can only yield 2.
      code = await runGate('namespace')
    } else if (isRoot) {
      code = await runGate('root')
    } else if (!noNamespace && canUseUserNamespace()) {
      code = reexecInUserNamespace()
    } else {
      code = await runGate('sudo')
    }
  }
} catch (error) {
  const frames = describeError(error)
  console.log(
    `FAIL gate crashed — ${frames.map((frame) => `${frame.name}: ${clip(frame.message)}`).join(' <- ')}`,
  )
  code = 1
} finally {
  await cleanup()
}

// When the checks ran in the re-exec child, it already printed its own result
// line and we propagate its exit code untouched; printing another would be a lie
// about which process decided the outcome.
if (!delegatedResult) {
  if (code === 0) console.log('ERRNO RESULT: PASS')
  if (code === 1) console.log('ERRNO RESULT: FAIL')
}
process.exitCode = code
