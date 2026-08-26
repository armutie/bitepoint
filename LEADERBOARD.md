# Verified leaderboard

The released game remains a static GitHub Pages site. Supabase supplies the
persistent identity, PostgreSQL database, and one Edge Function that replays
submitted inputs before any time reaches the global board.

```text
Browser game
  |-- provisional driver name in localStorage
  |-- Google session when the driver chooses to publish
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

- Choosing a name before signing in only saves that name on the current device.
  It does not reserve the name or publish a lap.
- Google sign-in reserves the chosen name and unlocks global lap submission.
- Reserved usernames are globally unique case-insensitively. Display case is
  preserved.
- Names are 3-16 ASCII letters/numbers; `_` and `-` are allowed internally.
- The Supabase session is persisted by `supabase-js`; no recovery code or
  password is shown to the player.
- Before sign-in the profile action is **Change name**, not **Log out**. A local
  name can be changed freely because it owns nothing globally.
- After sign-in the profile action is **Log out**. The reserved profile and its
  laps remain recoverable through the same Google account.
- Clearing browser storage loses only an unsigned local name. A Google profile
  can be restored on another device.

The Edge Function rejects anonymous users on profile and lap writes, so direct
anonymous Auth calls cannot squat usernames. Anonymous Sign-Ins and Manual
Identity Linking may remain enabled only to upgrade profiles created by an
earlier build; new clients do not create anonymous users.

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

Board reads and ghosts are public. Profile and lap routes require a
non-anonymous Supabase Auth JWT. Database tables have RLS enabled and grant no
direct browser access; official writes use the function's service role.

## Supabase deployment

The GitHub integration reads the `supabase/` directory:

- `supabase/migrations/20260824000100_leaderboard.sql` creates the schema,
  transactional PB replacement, board query, and submission rate limit.
- `supabase/functions/leaderboard/index.ts` is the verification API.
- `supabase/config.toml` enables the function and keeps legacy anonymous/manual
  linking available for local migration testing.

Before enabling **Deploy to production** in the Supabase GitHub integration:

1. enable the Google provider in Supabase Auth and configure its OAuth client;
2. confirm the connected repository is `armutie/bitepoint`, branch `main`,
   working directory `.`;
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
profile, but unlike production it reserves the name immediately and cannot test
Google sign-in. Use the connected Supabase project for the real identity flow.
