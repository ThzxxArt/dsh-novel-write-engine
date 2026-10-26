import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ERROR_CODES, EngineFaultError } from './types.js'

/**
 * The only reader of bundled assets. `apply()` performs no IO; the engine and
 * brief library call this lazily. Paths are resolved from the package layout
 * (`lib/../briefs`) or the source layout (`src/../../briefs`).
 */
export function bundledPath(relativePath: string): string {
  const candidates = [
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

/** Directory containing a bundled asset family (`briefs`, `skills`). */
export function bundledDir(relativeDirectory: string): string {
  return dirname(bundledPath(`${relativeDirectory}/placeholder`))
}

/** Read a bundled asset; a missing file is a packaging fault, not user input. */
export function readBundledText(relativePath: string): string {
  return readTextAt(bundledPath(relativePath), `bundled asset ${relativePath}`)
}

/** Ensure an absolute directory exists (init and overrides). */
export function ensureDirAt(path: string): void {
  mkdirSync(path, { recursive: true })
}

/** Read an optional file; `null` means it is absent, never an IO failure. */
export function readTextIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw new EngineFaultError(
      ERROR_CODES.CONFIG_INVALID,
      `cannot read ${path}`,
      'check the path and its permissions',
      { cause: error },
    )
  }
}

/** Read an explicitly supplied file (CLI validation and user brief overrides). */
export function readTextAt(path: string, label = path): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new EngineFaultError(
      ERROR_CODES.CONFIG_INVALID,
      `cannot read ${label} at ${path}`,
      'reinstall the plugin or point the override directory at a readable path',
      { cause: error },
    )
  }
}
