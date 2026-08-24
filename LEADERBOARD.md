# Verified leaderboard

The released game remains a static GitHub Pages site. Supabase supplies the
persistent identity, PostgreSQL database, and one Edge Function that replays
submitted inputs before any time reaches the global board.

```text
Browser game
  |-- anonymous Supabase Auth session (saved on this device)
  |-- optional Google identity linked to that same user
  |-- recorded lap inputs
  v
Supabase Edge Function
  |-- validates the JWT on protected routes
  |-- replays inputs through the shared physics
  |-- derives official timing and ghost data
  v
Supabase PostgreSQL
  |-- unique public usernames keyed to auth.users
  |-- metadata for every accepted lap
  `-- replay payload for each player's current PB
```

## Identity

- The browser creates an anonymous Auth user only when a name is claimed.
- Usernames are globally unique case-insensitively. Display case is preserved.
- Names are 3â€“16 ASCII letters/numbers; `_` and `-` are allowed internally.
- The Supabase session is persisted by `supabase-js`; no recovery code or
  password is shown to the player.
- Linking Google upgrades the same anonymous user. Its username, laps, and ID
  do not move or change.
- Clearing browser storage loses an unlinked profile. A Google-linked profile
  can be opened on another device.

Supabase Anonymous Sign-Ins and Manual Identity Linking must be enabled in the
project's Auth settings. Google itself can remain disabled until the lock-in UI
is ready to be exercised against a configured OAuth client.

## Lap trust and retention

`POST /v1/laps` accepts the recorded starting state and per-tick controls, not
an authoritative time. The Edge Function uses the same `TimeAttackSim` as the
browser to:

1. reject malformed channels, impossible starting states, off-track laps, and
   traces that do not finish on their final tick;
2. derive lap time and three sectors;
3. derive the delta trace and ghost path again on the server.

Client-supplied time, sectors, trace, path, player name, and timestamp are not
trusted. Every accepted lap keeps timing metadata. Only a player's current
best on each track/difficulty/ruleset keeps the larger replay payload.

Every physics-affecting release gets a new ruleset string in
`src/shared/ruleset.ts`. Old data remains stored but cannot compete with the new
simulation.

## HTTP surface

The function is deployed at `/functions/v1/leaderboard`; routes below are
relative to it.

```text
POST /v1/profiles
GET  /v1/me
GET  /v1/leaderboards
GET  /v1/leaderboards/entries/:id/ghost
POST /v1/laps
GET  /health
```

Board reads and ghosts are public. Profile and lap routes validate a Supabase
Auth JWT inside the function. Database tables have RLS enabled and grant no
direct browser access; official writes use the function's service role.

## Supabase deployment

The GitHub integration reads the `supabase/` directory:

- `supabase/migrations/20260824000100_leaderboard.sql` creates the schema,
  transactional PB replacement, board query, and submission rate limit.
- `supabase/functions/leaderboard/index.ts` is the verification API.
- `supabase/config.toml` enables the function and local anonymous/manual-link
  Auth behavior.

Before enabling **Deploy to production** in the Supabase GitHub integration:

1. enable Anonymous Sign-Ins and Manual Linking in the remote Auth settings;
2. confirm the connected repository is `armutie/bitepoint`, branch
   `bitepoint-lab`, working directory `.`;
3. push the `supabase/` directory and let the integration apply the migration
   and deploy the function;
4. set GitHub Actions variables `SUPABASE_URL` and
   `SUPABASE_PUBLISHABLE_KEY` for the Pages build;
5. add the GitHub Pages URL and local development URLs to Supabase Auth's
   redirect allow-list.

The service-role key is injected into Edge Functions by Supabase. Never put it
in the browser, GitHub Pages variables, source control, or a `VITE_` variable.

## Local fallback

The existing Fastify API remains available for zero-setup UI work:

```bash
npm run dev
npm run api:dev
```

Without Supabase browser variables, development uses
`http://127.0.0.1:8787`. Without `DATABASE_URL`, that API uses temporary
in-memory storage and resets when it exits. It mirrors the low-friction device
profile but cannot test Google linking; use the Supabase local stack or the
connected lab project for that flow.
