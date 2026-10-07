# Local race planning

## Race launch and nearby car clarity (follow-up)

The browser race waits for **R, then W** before starting its five-light sequence. Holding both keeps the car still while the cockpit rev display and audio respond to the throttle. After all five lights are red, lights out is held for a repeatable, seeded random 1–3 seconds. The player launches by releasing R after lights out while continuing to hold W. W alone cannot launch, releasing R early requires re-arming, and R regains its restart shortcut after the launch. AI reaction delays remain independent. The launch is a keyboard game control; it does not change the vehicle physics or implement a simulated mechanical clutch.

Nearby opponents now interpolate between the same physics ticks as the player and camera. Their previous raw positions were jumping against a smooth camera. The speed-scaled screen-edge blur and colour separation were also reduced about tenfold where a large nearby car could be smeared across several pixels. Bloom, grain, and the rest of the camera treatment remain. The grid HUD shows a prompt for each launch step and no longer shows a misleading invalid-lap/restart warning before launch.

The launch integration tests exercise waiting, arming, early release, randomized all-red hold, stationary player versus moving AI, and actual movement after R is released. The updated browser grid, control reference, prompt placement, and pause menu were visually checked. The rendering change should be assessed during play beside another car; the automated checks do not quantify perceived sharpness.

This branch replaces the race session's separate passing, defending and space-giving steering decisions with one local path planner. It is a playable prototype: passing and queue escape are tested, but close corner fighting is not solved.

## Architecture

The supplied recorded lap remains the immutable reference. No online lap optimiser runs. Each driver evaluates a small set of lateral destinations against nearby cars, upcoming bends, its available pace and the cost of changing its existing decision. A continuous transition joins the chosen destination to the current path, retaining the previous path's direction. The existing follower drives that path. Vehicle physics and handling settings are unchanged.

Passing and defending are incentives in the same calculation, not two steering controllers. A faster driver recognises spare pace even after a slower car has forced it to match speed. Defensive positioning is encouraged before braking. An overlapping rival imposes a side boundary until actual clearance, rather than trusting a predicted end of overlap. Traffic speed limits apply to the intended corridor, avoiding the blanket braking that made side-by-side driving timid.

Decisions run at 10 Hz, staggered across drivers. Steering and immediate longitudinal safety run at 60 Hz. Path curvature limits use the recorded lap's demonstrated lateral demand and a physical grip floor; an overly low floor previously made ordinary lane changes unnecessarily slow.

The reference controller now locates itself globally on its first tick, so rolling scenarios can start away from the start line. Subsequent searches stay local.

## Variation

Each race gets a seed; each driver gets stable preferences from that seed:

- Reaction after green: 100–300 ms. The player's controls are not delayed.
- A small passing-side tie-break preference, clearance between 0.60 and 0.75 m, and slightly different defensive preparation timing.
- Up to 0.25 m of personal offset on long open straights. The car rejoins before upcoming braking or cornering. No random steering noise or arbitrary multi-metre corner offsets.

The browser supplies a fresh seed at each new race. `RaceSetup.seed` and the headless bench allow repeatable runs. Existing corner-mistake behaviour uses the same race seed; its difficulty bands were not redesigned.

## Validation

Run from `web`:

```powershell
npm run build
npm test -- --run src/core/trafficPlanner.test.ts src/core/trafficPace.test.ts
node node_modules/vite-node/vite-node.mjs src/dev/spaceBench.ts power_8 legacy 3 ruthless
$env:SEED='2'
node node_modules/vite-node/vite-node.mjs src/dev/spaceBench.ts power_8 legacy 3 ruthless
```

Thirteen new checks cover actual vehicle simulations: a clean pass, escape from a matched-speed queue, maintaining pace alongside, defensive positioning before braking, recorded-path preservation without variation, six seeded overtaking cases, reproducible start reactions, and three complete-lap comparisons. Both extremes of straight-line variation remain within 0.25 seconds of the unmodified follower's best valid lap on the recorded Croft Bay line, with no additional off-track time.

The final five-seed, three-lap Croft Bay/Low Drag bench has a slower scripted player starting on pole, holding its line without yielding. All five AI pass and finish in every sample; AI off-track time is zero. Passing requires a full car length plus margin ahead for one second, using unwrapped track progress (the old heading-based counter counted false passes on bends).

| Seed | AI completing a pass | Player contact ticks | Largest player impulse, N·s |
| --- | --- | --- | --- |
| 40503 | 5/5 | 128 | 6217 |
| 1 | 5/5 | 271 | 9132 |
| 2 | 5/5 | 467 | 9130 |
| 3 | 5/5 | 580 | 9119 |
| 101 | 5/5 | 279 | 9123 |

These results **do not demonstrate consistently clean wheel-to-wheel racing**. In particular, corner convergence against an opponent that holds its reference line can produce hard contact. The unchanged branch's corresponding default bench had 294 player-contact ticks and 5843 N·s peak impulse. Contact is not uniformly improved across the new seeds. Do not use the cleaner default sample as a blanket safety claim.

Headless simulation plus all six cars' AI/control averaged roughly 0.10–0.16 ms per tick locally. This excludes rendering and is not a browser FPS guarantee. The actual browser game was checked through race selection, countdown, moving opponents and pause/menu.

The pre-existing `raceSession.test.ts` parked-player/technical_8/classic test fails its six-second off-track bound on untouched `e1ca383` (10.42 s). It also fails here (9.07 s); its assertion has not been relaxed. Final full-suite result: **398 passed, one known baseline failure**, using `npm test -- --pool=threads --maxWorkers=2 --reporter=dot`. Forked-worker runs encountered a reporting timeout; thread workers resolved it. The thirteen focused new tests and production build pass.

## Limits and next work

The candidate scoring uses short-horizon extrapolation, not knowledge of another driver's inputs. It does not solve coupled trajectories through a whole corner. The recorded reference is an excellent fast route but a poor universal prediction of what a human opponent will do. Improving corner occupancy prediction and handling a shrinking outside corridor are the next substantial work; increasing blanket avoidance would reintroduce the timid behaviour.

Most measured behaviour here is Croft Bay with Low Drag and its recorded lap. The old branch contains other baked assets that fail its existing grip-envelope validation; they were not regenerated or silently replaced with an expensive online optimiser.

## Research basis

There is no single architecture shared by all racing games. Separate tactical modes are a legitimate published design in [Game AI Pro, Racing AI Architecture](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter38_An_Architecture_Overview_for_AI_in_Racing_Games.pdf). Andrew Fray's [Context Steering chapter](https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter18_Context_Steering_Behavior-Driven_Steering_at_the_Macro_Scale.pdf), discussing F1 2011, motivates evaluating movement interest and danger together. [Heat Vision](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter41_The_Heat_Vision_System_for_Racing_AI.pdf) is another positional-utility approach. This implementation is a small deterministic planner informed by those principles, not a reproduction of proprietary current F1 or Gran Turismo code, and not a claim to replicate Sophy's learned policy.
