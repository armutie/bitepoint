import { buildApp } from './app'
import { MemoryLeaderboardRepository } from './memoryRepository'
import { PostgresLeaderboardRepository } from './postgresRepository'

const databaseUrl = process.env.DATABASE_URL?.trim()
const repository = databaseUrl
  ? new PostgresLeaderboardRepository(databaseUrl)
  : new MemoryLeaderboardRepository()

if (!databaseUrl) {
  console.warn('[leaderboard] DATABASE_URL is absent; using temporary in-memory storage.')
}

const app = await buildApp({
  repository,
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
})

const port = Number(process.env.PORT ?? 8787)
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' })
console.log(`[leaderboard] listening on ${app.listeningOrigin}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().finally(() => process.exit(0))
  })
}
