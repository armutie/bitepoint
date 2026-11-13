import { drivingBuildPlugin } from './tools/telemetryBuild'
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { buildRoomService } from './server/multiplayerApp'

export default defineConfig({
  plugins: [drivingBuildPlugin(), {
    name: 'bitepoint-room-service',
    async configureServer(server) {
      // Local development includes the room service in the same origin/port.
      const api = await buildRoomService({
        turnUrls: (process.env.TURN_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean),
        turnSecret: process.env.TURN_SECRET ?? '',
      })
      await api.ready()
      server.middlewares.use('/multiplayer-api', (req, res) => api.routing(req, res))
      server.httpServer?.once('close', () => { void api.close() })
    },
  }],
  // Relative base so a build drops onto any static host (Cloudflare Pages,
  // GitHub Pages project sites, a subdirectory) without a rebuild.
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        legacy: fileURLToPath(new URL('./legacy/index.html', import.meta.url)),
        // Linked from the main menu, so it has to ship: without this entry the
        // live site had no multiplayer page at all.
        multiplayer: fileURLToPath(new URL('./multiplayer.html', import.meta.url)),
      },
    },
  },
  test: {
    // The CPU-heavy simulation checks need thread workers to avoid fork RPC timeouts.
    pool: 'threads',
    maxWorkers: 2,
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
  },
})
