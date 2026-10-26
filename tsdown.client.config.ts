import { defineConfig } from 'tsdown'

/**
 * Browser half, built as a lazy-CJS factory registered on the page module
 * loader. The id must equal the package name and the host only mounts this
 * half on the row whose specifier is exactly that name.
 */
export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'lib',
  clean: false,
  sourcemap: false,
  dts: false,
  deps: {
    neverBundle: ['react', 'react/jsx-runtime'],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner:
      'window.__ModuleLoader__.load({ id: "dsh-novel-write-engine", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
