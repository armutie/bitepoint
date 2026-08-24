import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  // Relative base so a build drops onto any static host (Cloudflare Pages,
  // GitHub Pages project sites, a subdirectory) without a rebuild.
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        legacy: fileURLToPath(new URL('./legacy/index.html', import.meta.url)),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
  },
})
