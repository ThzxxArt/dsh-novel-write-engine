#!/usr/bin/env node
/**
 * Per-file isolated compilation: every source file must type-check on its own.
 * A file that only compiles because another file happened to import a type is
 * a latent publish bug; this script makes that visible.
 */
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const root = new URL('..', import.meta.url).pathname
const configPath = join(root, 'tsconfig.json')
const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
const compilerOptions = { ...parsed.options, noEmit: true, declaration: false, incremental: false }

const files = []
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'client') continue
      walk(absolute)
    } else if (entry.name.endsWith('.ts')) {
      files.push(absolute)
    }
  }
}
walk(join(root, 'src'))
files.sort()

let failures = 0
for (const file of files) {
  const program = ts.createProgram({ rootNames: [file], options: compilerOptions })
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file !== undefined && diagnostic.file.fileName === file)
  if (diagnostics.length > 0) {
    failures += 1
    console.error(`\n${relative(root, file)}`)
    for (const diagnostic of diagnostics) {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      const position =
        diagnostic.start === undefined
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
