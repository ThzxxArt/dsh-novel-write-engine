import { defineConfig } from 'vite'

export default defineConfig({
  root: 'e2e',
  server: { host: '127.0.0.1', port: 4179, strictPort: true },
  resolve: { dedupe: ['react', 'react-dom'] },
})
