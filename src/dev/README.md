# Development harnesses

Nothing in here ships. `vite.config.ts` builds `index.html` only, so the pages
are reachable on the dev server and nowhere else, and the scripts are run by
hand with `npx vite-node src/dev/<name>.ts`.

This used to be sixty-odd scripts. Most were one-shot: a question was asked, a
script answered it, the answer went into a comment in `core/` and the script
stayed behind. What survives is the set that gets run *again* — the A/B, the
sweep, the trace, and the two bakes — because the racecraft rewrite has to be
measured against the same numbers the follower was tuned against.

Deleted, and reachable in git history if a question comes back: the per-axis
model-vs-car checks (`modelFit`, `ggvVsModel`, `gripAudit`, `accelCheck`), the
human-lap comparisons (`traceVsPlan`, `brakePoints`, `vsHuman`), and the
where-did-it-go family (`whereItDies`, `whyConservative`, `whatBinds`).

## Pages (dev server)

| page | what it shows |
|---|---|
| `race-lab.html` | a field of AI actually racing, live, with trails and an order board |

## Building things

| script | purpose |
|---|---|
| `bakeLines.ts` | `npm run bake-lines` — finds every line once and writes `public/lines/` |
| `bakeHumanLap.ts` | turns an exported human lap into a baked line |
| `checkBake.ts` | proves a baked line reproduces the line that was baked |

## Is the driver any good?

| script | purpose |
|---|---|
| `followerBench.ts` | **the A/B**: best clean lap per circuit, with tracking error |
| `followerTune.ts` | sweeps one knob at a time over four circuits |
| `traceFollower.ts` | per-tick trace of one lap |

**Tune on four circuits, not two.** Tuning on two gave `yawDamp: 0`, which was
best there and cost 7 s on a third. `TUNE_TRACKS` overrides the set.

**Measurement trap.** A held-speed skidpad lies at high speed: the engine cannot
beat the drag, so the car quietly decelerates and you read grip at a speed you
did not ask for. Coast down through the target instead. It cost an hour once.

**Do not reconstruct position by projecting a replay onto the centreline.** It is
ambiguous at a hairpin — it had a human taking a 20 m corner at 216 km/h, which
is about thirty g. The recorded trace carries distance directly; use it.
