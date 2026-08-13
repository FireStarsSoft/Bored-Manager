import { defineConfig } from 'vite'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string
}

/**
 * The server half, bundled with Vite rather than plain esbuild because
 * server/services/modules-host.ts still discovers module folders through
 * import.meta.glob. Dependencies stay external, so express/ws/ssh2 are loaded
 * from node_modules at runtime.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'shared') }
  },
  define: {
    // Stamped into the bundle and logged at startup, so logs always show
    // WHICH build is actually running (guards against stale out/ copies).
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  build: {
    ssr: resolve(__dirname, 'server/index.ts'),
    outDir: resolve(__dirname, 'out/server'),
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'index.mjs' } }
  }
})
