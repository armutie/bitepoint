# Bite Point

A focused browser racing simulation built to feel good on keyboard and mouse.
Choose Time Trial across five circuits with two car setups, personal bests,
ghosts and sector timing, or a race event at Croft Bay with the Low Drag setup.

[Play Bite Point](https://armutie.github.io/bitepoint/)

## Controls

- Mouse: steer
- `W` / `S`: throttle and brake
- `C`: change camera
- `R`: restart the lap
- `Esc`: pause

The complete control reference is available from the main menu.

## Race events

Choose the race distance, opponents and difficulty in the event menu. One-shot
qualifying sets the starting grid: the AI drives the run-up for five seconds,
with one red light each second. Take control when all five go out; the first
line crossing starts the clock. An invalid or abandoned lap starts at the back.
Qualifying returns to the event menu before you enter the race.

In the race, hold `R` to start the lights, hold `W`, then release `R` at lights
out. Track limits give two warnings, then a 3-second penalty, then 5 seconds for
each further excursion. Penalties are included in final times and positions.
Proximity chevrons show nearby cars behind in white and alongside in red across
the full track width.

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
npm run api:dev
npm test
npm run build
```

The production build is written to `dist/`. GitHub Pages deploys it automatically
after changes reach `main`.

The optional verified global leaderboard uses Supabase Auth, PostgreSQL, and an
Edge Function that replays every submitted lap. The local Fastify service stays
available for zero-setup UI work. Identity, verification, schema, and deployment
are documented in [LEADERBOARD.md](LEADERBOARD.md).

## Legacy tyres

The previous tyre model remains playable at
[the legacy build](https://armutie.github.io/bitepoint/legacy/). Its records and
ghosts are isolated from the current physics.
