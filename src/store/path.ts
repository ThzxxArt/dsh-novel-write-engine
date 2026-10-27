import { isAbsolute, relative, resolve, sep } from 'node:path'
import { ERROR_CODES, EngineFaultError } from '../types.js'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Refuse anything that could escape the project root. */
export function assertSafeRelative(relativePath: string): void {
  const bad = (reason: string): never => {
    throw new EngineFaultError(ERROR_CODES.PATH_ESCAPE, `refusing path "${relativePath}": ${reason}`)
  }
  if (relativePath === '') bad('empty path')
  if (relativePath.includes('\0')) bad('contains NUL')
  if (relativePath.includes('\\')) bad('contains a backslash')
  if (isAbsolute(relativePath)) bad('absolute path')
  if (/^[A-Za-z]:/.test(relativePath)) bad('drive-qualified path')
  const segments = relativePath.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.') bad('empty segment')
    if (segment === '..') bad('parent traversal')
    if (WINDOWS_RESERVED.test(segment)) bad('Windows reserved name')
  }
}

/**
 * Resolve a project-relative path and prove the result stays inside the root.
 * Both checks are needed: the lexical one rejects obvious attacks, the resolved
 * one rejects symlink-free aliases such as `a/../b` that survived normalization.
 */
export function resolveInside(root: string, relativePath: string): string {
  assertSafeRelative(relativePath)
  const absoluteRoot = resolve(root)
  const absolute = resolve(absoluteRoot, relativePath)
  const inside = relative(absoluteRoot, absolute)
  // `..foo` is a legal file name, not parent traversal. Only the exact `..`
  // segment (or a path starting with `../`) escapes the root.
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new EngineFaultError(
      ERROR_CODES.PATH_ESCAPE,
      `refusing path "${relativePath}": escapes project root`,
    )
  }
  return absolute
}

/** Whether a resolved absolute path remains under the project root. */
export function isInside(root: string, absolutePath: string): boolean {
  const relativePath = relative(resolve(root), resolve(absolutePath))
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

/** Project-relative form used in journal entries and tool output. */
export function toProjectPath(root: string, absolutePath: string): string {
  return relative(resolve(root), resolve(absolutePath)).split(sep).join('/')
}
