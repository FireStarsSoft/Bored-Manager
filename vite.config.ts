import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string
}

/**
 * The browser half of the app. It is a plain SPA served by the Express server
 * out of out/renderer/; in dev it runs on Vite's own port and forwards /ws and
 * /api to the server process (npm run dev:server), so the same code paths work
 * either way.
 */
export default defineConfig({
  root: resolve(__dirname, 'src'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'shared')
    }
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  server: {
    proxy: (() => {
      const port = process.env.BM_PORT || '8686'
      const target = `http://localhost:${port}`
      return {
        '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
        '/api': target
      }
    })()
  },
  build: {
    outDir: resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'src/index.html') }
  }
})
