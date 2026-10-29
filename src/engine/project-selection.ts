import { join, resolve } from 'node:path'
import {
  ARCHIVE_DIGESTS_FILE,
  BRIEF_RECEIPTS_FILE,
  CHAPTERS_DIR,
  CHECK_DIR,
  OUTLINE_FILE,
  PLAN_DIR,
  PROJECT_FILE,
  REVIEW_DIR,
  STATE_DIR,
  STATE_FILES,
  WORLDBOOK_FILE,
} from '../constants.js'
import { ERROR_CODES, EngineFaultError, EngineInputError, type Selection } from '../types.js'
import { FsStore, joinRel } from '../store/index.js'

/** How much of a candidate project can be inspected without loading a snapshot. */
export type ProjectState = 'ok' | 'damaged' | 'not-project' | 'missing' | 'unreadable'

export interface ProjectInspection {
  root: string
  state: ProjectState
  title: string
  created_at?: string
  error?: string
}

export interface ScanCandidate extends ProjectInspection {
  registered: boolean
}

export interface ScanResult {
  candidates: Array<ProjectInspection>
  truncated: boolean
}

export type WorkspaceDiscovery =
  { kind: 'one'; root: string } | { kind: 'many'; roots: string[] } | { kind: 'none' }

const MAX_SCAN_CANDIDATES = 50

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Filesystem access failures are unreadable; parse/schema faults are damage. */
const unreadableFsError = (error: unknown): boolean => {
  const code = (error as { code?: unknown }).code
  return (
    typeof code === 'string' &&
    ['EACCES', 'EPERM', 'EIO', 'EBUSY', 'ELOOP', 'EMFILE', 'ENFILE', 'EISDIR'].includes(code)
  )
}

/**
 * True when anything survives in the project directory besides novel.yaml.
 * Kept next to inspection so the panel, resolver and scanner agree on what
 * "a project used to be here" means.
 */
export async function hasProjectState(store: FsStore): Promise<boolean> {
  const stateFiles = [
    STATE_FILES.pipeline,
    STATE_FILES.chapters,
    STATE_FILES.characters,
    STATE_FILES.world,
    STATE_FILES.locks,
    STATE_FILES.timeline,
    STATE_FILES.foreshadows,
    STATE_FILES.relationships,
    STATE_FILES.handoff,
  ].map((file) => joinRel(STATE_DIR, file))
  stateFiles.push(joinRel(STATE_DIR, STATE_FILES.journal), ARCHIVE_DIGESTS_FILE, BRIEF_RECEIPTS_FILE)
  return (
    (await Promise.all(stateFiles.map((path) => store.exists(path)))).some(Boolean) ||
    (await store.list(CHAPTERS_DIR)).length > 0 ||
    (await store.list(PLAN_DIR)).length > 0 ||
    (await store.list(REVIEW_DIR)).length > 0 ||
    (await store.list(CHECK_DIR)).length > 0 ||
    (await store.exists(OUTLINE_FILE)) ||
    (await store.exists(WORLDBOOK_FILE))
  )
}

/**
 * Inspect one candidate without constructing a full Snapshot. `ok` and
 * `damaged` are both project evidence; only `not-project`/`missing` are absent.
 */
export async function inspectProject(root: string): Promise<ProjectInspection> {
  const absolute = resolve(root)
  const store = new FsStore(absolute)
  let directory: boolean
  try {
    // The root is the user's chosen path; a symlink to a real project is still
    // that project. Symlink avoidance applies to child enumeration only.
    const info = await store.statRoot()
    if (info === null) {
      return { root: absolute, state: 'missing', title: '（项目目录不存在）' }
    }
    directory = info.directory
  } catch (error) {
    return {
      root: absolute,
      state: 'unreadable',
      title: '（项目目录不可读）',
      error: errorText(error),
    }
  }
  if (!directory) {
    return { root: absolute, state: 'not-project', title: '（不是项目目录）' }
  }

  let projectExists: boolean
  try {
    projectExists = await store.exists(PROJECT_FILE)
  } catch (error) {
    return {
      root: absolute,
      state: 'unreadable',
      title: '（项目文件不可读）',
      error: errorText(error),
    }
  }

  if (projectExists) {
    try {
      const project = (await store.readDoc(PROJECT_FILE, 'project')) as {
        title?: unknown
        created_at?: unknown
      } | null
      if (project === null) {
        return {
          root: absolute,
          state: 'damaged',
          title: '（项目文件不可读）',
          error: `${PROJECT_FILE} disappeared during inspection`,
        }
      }
      return {
        root: absolute,
        state: 'ok',
        title: typeof project.title === 'string' ? project.title : '',
        ...(typeof project.created_at === 'string' && project.created_at !== ''
          ? { created_at: project.created_at }
          : {}),
      }
    } catch (error) {
      return {
        root: absolute,
        state: unreadableFsError(error) ? 'unreadable' : 'damaged',
        title: '（项目文件不可读）',
        error: errorText(error),
      }
    }
  }

  try {
    if (await hasProjectState(store)) {
      return {
        root: absolute,
        state: 'damaged',
        title: '（项目文件缺失）',
        error: `${PROJECT_FILE} is missing`,
      }
    }
  } catch (error) {
    return {
      root: absolute,
      state: 'unreadable',
      title: '（项目目录不可读）',
      error: errorText(error),
    }
  }
  return { root: absolute, state: 'not-project', title: '（不是项目）' }
}

/**
 * Enumerate the finite workspace shape: cwd, cwd/novel and direct child
 * directories. No ancestor walk, no recursion, and no symlink directory is
 * followed. `truncated` is explicit rather than a silent 50-row cut.
 */
export async function scanWorkspace(cwd: string, limit = MAX_SCAN_CANDIDATES): Promise<ScanResult> {
  const base = resolve(cwd)
  const store = new FsStore(base)
  const roots: string[] = [base]
  const add = (path: string): void => {
    const absolute = resolve(path)
    if (!roots.includes(absolute)) roots.push(absolute)
  }

  try {
    const novel = await store.lstat('novel')
    if (novel !== null && novel.directory && !novel.symbolicLink) add(join(base, 'novel'))
    for (const entry of await store.entries('.')) {
      if (!entry.directory || entry.symbolicLink) continue
      add(join(base, entry.name))
    }
  } catch {
    // A cwd that disappeared during scanning still yields the cwd probe; the
    // caller gets an empty result rather than a confusing partial read.
  }

  const bounded = Math.max(1, limit)
  const candidates: ProjectInspection[] = []
  let truncated = false
  for (const root of roots) {
    try {
      const inspection = await inspectProject(root)
      if (inspection.state === 'not-project' || inspection.state === 'missing') continue
      if (candidates.length >= bounded) {
        // Stop after the first candidate beyond the cap. Inspecting the rest
        // would make a huge workspace pay for every directory even though the
        // caller only promised to show the first `limit` projects.
        truncated = true
        break
      }
      candidates.push(inspection)
    } catch (error) {
      if (candidates.length >= bounded) {
        truncated = true
        break
      }
      candidates.push({
        root,
        state: 'unreadable',
        title: '（项目目录不可读）',
        error: errorText(error),
      })
    }
  }
  return { candidates, truncated }
}

/**
 * One/many/none classification with the §6.4 short-circuit order:
 * cwd itself, then cwd/novel, then exactly one readable direct child. Damaged
 * projects are not workspace discovery candidates; scan may still list them.
 */
export async function discoverWorkspace(cwd: string): Promise<WorkspaceDiscovery> {
  const base = resolve(cwd)
  const direct = await inspectProject(base)
  if (direct.state === 'ok') return { kind: 'one', root: direct.root }

  const store = new FsStore(base)
  const nested = join(base, 'novel')
  try {
    const info = await store.lstat('novel')
    if (info !== null && info.directory && !info.symbolicLink) {
      const candidate = await inspectProject(nested)
      if (candidate.state === 'ok') return { kind: 'one', root: candidate.root }
    }
  } catch {
    // An unreadable cwd cannot contribute a reliable workspace hint.
    return { kind: 'none' }
  }

  const roots: string[] = []
  try {
    for (const entry of await store.entries('.')) {
      if (!entry.directory || entry.symbolicLink) continue
      const candidate = await inspectProject(join(base, entry.name)).catch(() => null)
      if (candidate?.state !== 'ok') continue
      roots.push(candidate.root)
      if (roots.length > 50) break
    }
  } catch {
    return { kind: 'none' }
  }
  if (roots.length === 0) return { kind: 'none' }
  if (roots.length === 1) return { kind: 'one', root: roots[0]! }
  return { kind: 'many', roots }
}

export function describeCandidates(
  candidates: Array<{ root: string; title?: string; state?: ProjectState }>,
): string {
  return candidates
    .map((candidate) => {
      const title = candidate.title === undefined || candidate.title === '' ? '（无标题）' : candidate.title
      const state = candidate.state === undefined ? '' : ` [${candidate.state}]`
      return `- ${title}${state}: ${candidate.root}`
    })
    .join('\n')
}

export function ambiguousError(
  candidates: Array<{ root: string; title?: string; state?: ProjectState }>,
): EngineInputError {
  const list = describeCandidates(candidates)
  return new EngineInputError(
    ERROR_CODES.PROJECT_AMBIGUOUS,
    `multiple projects are available; choose one explicitly:\n${list}`,
    'pass project_root on the next tool call, or use /novel use <path|title>. The registry active project is not used as a silent default for an Agent session.',
  )
}

export function projectNotFoundError(root: string): EngineInputError {
  return new EngineInputError(
    ERROR_CODES.PROJECT_NOT_FOUND,
    `no novel project at ${resolve(root)}`,
    'call novel_init to create one, pass the correct project_root, or run /novel scan to discover projects',
  )
}

export function missingProjectError(input: {
  selection: Selection
  lastTitle?: string
  movedTo?: string
  cause?: unknown
}): EngineFaultError {
  const title = input.lastTitle === undefined || input.lastTitle === '' ? '' : `《${input.lastTitle}》`
  const moved =
    input.movedTo === undefined
      ? ''
      : ` A project with the same created_at is registered at ${input.movedTo};`
  return new EngineFaultError(
    ERROR_CODES.PROJECT_MISSING,
    `the project ${title} bound to this session is missing: ${input.selection.root}.${moved} projects are never switched automatically`,
    `restore the directory or mount, then retry; or explicitly run /novel use <new path> or pass project_root. The binding is kept.${input.movedTo === undefined ? '' : ` Candidate moved project: ${input.movedTo}.`}`,
    input.cause === undefined ? undefined : { cause: input.cause },
  )
}

export function identityMismatchError(input: {
  selection: Selection
  actualCreatedAt?: string
  actualTitle?: string
}): EngineInputError {
  const expected = input.selection.created_at ?? '（unknown）'
  const actual = input.actualCreatedAt ?? '（unknown）'
  const title = input.actualTitle === undefined || input.actualTitle === '' ? '' : `《${input.actualTitle}》`
  return new EngineInputError(
    ERROR_CODES.PROJECT_IDENTITY_MISMATCH,
    `the path ${input.selection.root} now contains a different project ${title} (created_at ${actual}; this session is bound to ${expected})`,
    'the binding was not switched and no write was attempted. Run /novel use <path> or pass project_root to confirm the replacement; old bindings keep failing closed.',
  )
}
