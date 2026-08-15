# Bite Point

A focused browser racing simulation built to feel good on keyboard and mouse.
Chase clean laps across four circuits with two distinct car setups, personal
bests, ghosts, sector timing and scalable graphics.

[Play Bite Point](https://armutie.github.io/bitepoint/)

## Controls

- Mouse: steer
- `W` / `S`: throttle and brake
- `C`: change camera
- `R`: restart the lap
- `Esc`: pause

The complete control reference is available from the main menu.

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
npm test
npm run build
```

The production build is written to `dist/`. GitHub Pages deploys it automatically
after changes reach `main`.

## Legacy tyres

The previous tyre model remains playable at
[the legacy build](https://armutie.github.io/bitepoint/legacy/). Its records and
ghosts are isolated from the current physics.
