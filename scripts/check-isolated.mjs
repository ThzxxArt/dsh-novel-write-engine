#!/usr/bin/env node
/**
 * Per-file isolated compilation: every source file must type-check on its own.
 * A file that only compiles because another file happened to import a type is
 * a latent publish bug; this script makes that visible.
 */
import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const readOptions = (configName) => {
  const configPath = join(root, configName)
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'),
    )
  }
  const options = { ...parsed.options, noEmit: true, incremental: false }
  // The client config emits declarations; a noEmit single-file program cannot
  // combine those, and the inherited option would become a global TS5069.
  delete options.declaration
  delete options.emitDeclarationOnly
  delete options.declarationDir
  return options
}
const hostOptions = readOptions('tsconfig.json')
const clientOptions = readOptions('tsconfig.client.json')

const files = []
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) walk(absolute)
    else if (entry.name.endsWith('.ts')) files.push(absolute)
  }
}
walk(join(root, 'src'))
files.sort()
const clientRoot = join(root, 'src', 'client')

let failures = 0
for (const file of files) {
  const options = file.startsWith(clientRoot) ? clientOptions : hostOptions
  const program = ts.createProgram({ rootNames: [file], options })
  const all = ts.getPreEmitDiagnostics(program)
  const diagnostics = all.filter(
    (diagnostic) => diagnostic.file !== undefined && resolve(diagnostic.file.fileName) === resolve(file),
  )
  const global = all.filter((diagnostic) => diagnostic.file === undefined)
  if (diagnostics.length > 0 || global.length > 0) {
    failures += 1
    console.error(`\n${relative(root, file)}`)
    for (const diagnostic of [...diagnostics, ...global]) {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      const position =
        diagnostic.start === undefined || diagnostic.file === undefined
          ? ''
          : `:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`
      console.error(`  TS${diagnostic.code}${position} ${message}`)
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} file(s) do not compile in isolation`)
  process.exit(1)
}
console.log(`isolated check passed for ${files.length} source files`)
