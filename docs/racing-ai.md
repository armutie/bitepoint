# How the racing AI works, and what the field does

Written after two days of measuring our own AI against a human lap, and a
research pass over what shipped racing games and the autonomous-racing
literature actually do. It records the architecture, the findings that changed
the design, and the traps — several of which cost hours and produced confident
wrong answers.

## The shape of the thing

An AI driver here is three pieces, and keeping them separate is what makes any
of it debuggable:

| piece | file | job |
|---|---|---|
| **the line** | `core/racingLine.ts` | where to drive, as a lateral offset every 3 m |
| **the plan** | same, `speedProfile` | how fast at each of those points, and the pedal to get there |
| **the driver** | `core/referenceDriver.ts` | steering and pedal each tick to actually do it |

The line and plan are found offline and shipped as data (`public/lines/`,
see `core/bakedLines.ts`); only the driver runs in the game. Searching for a
line is half a minute of blocked main thread and the answer never changes, so a
race reads a file.

`RaceSession` (`core/raceSession.ts`) joins one human to N of these drivers.

## What the field does

[Game AI Pro ch.38, *An Architecture Overview for AI in Racing Games*][gaipro]
is the closest thing to a canonical description, and it describes three layers:

- **strategic** (seconds) — behaviour choice: racing, overtaking, defending,
  recovery, branch selection
- **tactical** (per frame) — refines those goals, short-range avoidance
- **control** — turns them into steering, brake and throttle

We have the control layer and a single strategic behaviour ("race"). Everything
in the tactical and strategic layers is unbuilt.

Elsewhere:

- **Assetto Corsa** uses a *recorded human lap* as the AI line — steering,
  throttle and brake — replayed and followed. At full strength its AI runs 2-3 s
  quicker than the lap it learned from. ([guide][acguide])
- **Gran Turismo Sophy** is deep reinforcement learning, and is famous partly
  because of what it cost: **1,000+ PlayStation 4s** and a bespoke distributed
  training platform. ([Nature][sophy], [technology][sophytech])
- **TUM's open-source stack** is the same pipeline we use — minimum-curvature
  seed, then minimum-time optimisation, then a forward/backward velocity solver
  — but its solver looks grip limits up in a **measured** `ggv` table rather
  than deriving them. ([repo][tum])

## Findings that changed the design

### The line's own noise was braking for corners that did not exist

Menger curvature through three points 3 m apart is a difference of nearly-equal
quantities and violently sensitive: **18 cm of zigzag between adjacent stations
reads as a 50 m radius corner**. The optimiser's minimum step is 15 cm, so it
was leaving wiggles at exactly that scale, and the speed profile dutifully
braked to 84 km/h for them.

Game AI Pro names this exactly:

> a racing line is a sum of its parts, or rather each part or node is not
> independent of those around it … all this will do is produce a kink in the
> racing line that is likely to have the effect of slowing down the AI

The fix is to smooth the **offsets and the curvature inside `geometry`**, where
the search is scored — smoothing only at the end would let the search collect
kinks it was never charged for. Worth 4.1 s of plan time on Croft Bay.

### Model lap time is the wrong objective

The optimiser minimises the *modelled* lap. It is good at that, and the model's
*ranking* of two lines matches which one drives faster. But a plan that sits at
the lateral limit for three quarters of a lap scores beautifully and leaves the
follower no margin anywhere, so the commitment search backs off and the lap that
gets driven is slower.

Refining the line against the **driven** lap instead — invalid laps scoring as
infinitely slow, so undriveable lines stop being worth having — gained **3.05 s
on Croft Bay**, while making the model time *worse* (51.796 → 52.332).

This is the recommended method, not a hack: Game AI Pro describes a Monte Carlo
or genetic search whose metric is the measured lap time, and warns that
per-node hill climbing is "prone to false solutions".

### One corner sets the commitment for the whole lap

`commitment` is a single scalar for the entire circuit and `fastestLap` raises
it until the lap goes invalid — so it is decided by whichever corner runs out of
road first, and every other corner is detuned to protect that one.

On Croft Bay the search settles at 0.856. Raising it barely (`dev/whoSetsCommitment.ts`):

| commitment | where it leaves the road |
|---|---|
| 0.856 | clean |
| 0.880 | 1468-1511 m, 1604-1649 m |
| 0.900 | 1465-1527 m |
| 1.000 | 0-50 m, 583-705 m, 1457-1504 m, 2561-2581 m |

**About 60 m of a 2581 m lap is capping the other 97.6%.** That is why the
5.2 s of commitment backoff is not a diffuse problem, and why refining on driven
laps pays: the coordinate descent moved the line where the car actually fails
and the commitment rose **0.856 → 0.956**, which is where its 2.93 s came from.
It is not finding a cleverer line so much as unlocking the whole lap.

Note also that commitment is not monotonic in driveability — at 1.10 the car
never completes a flying lap at all, so any search over it must treat "no lap" as
a distinct outcome from "slow lap".

### The model should be MEASURED, not made exact

The obvious worry about scoring lines on a model is that the model is a
different program from the game. It is, and knowingly: diffing which
`CarParams` each file reads, there are **32 physics parameters the car uses that
the model never touches** — tyre relaxation and combined slip, wheel inertia,
the torque cut on a shift, traction control, ABS, steering rate and lock, and
`inertiaZ`, because a quasi-steady-state model has no rotational dynamics by
construction.

Making it *exact* is the wrong project. We already have an exact model — it is
the sim. `driveLine` steps `TimeAttackSim.step`, the same method `main.ts` calls
for the player; verified end to end in `dev/physicsCheck.ts`, where the same
follower on the same line run through a real `RaceSession` laps **identical to
0.0000 s**. So "make the model exact" means "reimplement the sim", which would
then cost what the sim costs — about 70x a model trial. And an exact PHYSICS
model still would not predict the driven lap, because the driven lap contains
the follower.

What works is to stop deriving the limits and **look them up in a table measured
from the car** — TUM's approach, and `core/ggv.ts` already did the measuring.
Three things had to be fixed before it could be trusted.

**The measurement was running a different car.** Every sweep called
`car.step(cmd, 0, DT, 1.0)`, which passes 1.0 as SUBSTEPS — where it reads like
a grip multiplier. The game uses 10. So the whole table came off a car
integrated ten times more coarsely, and the error grew with speed: lateral grip
climbed to 6.08 g at 288 km/h and then *fell* at 306, which a car with
downforce cannot do. One argument, and it invalidated the table it was
measuring.

**It sampled speeds the car cannot reach.** Each run starts at 1.3x its target,
so asking for 90 m/s in a car that tops out at 80.5 placed it at 117 m/s and
read the grip on the way down from a state it can never occupy.

**The two axes are not equally trustworthy, and must be split.** Measuring the
whole envelope was tried once, wholesale, measured slower, and shelved with a
note blaming gearchanges. The rejection threw out the good half with the bad:

| column | verdict |
|---|---|
| `ay` | a steady state, cross-checked against an independent closed-loop skidpad to within **3%** from 54-198 km/h. The formula it replaces is 2-6% optimistic, consistently one way. **Use it.** |
| `axDrive` | a band average, folding a gearchange and the traction limit into every speed. **Do not plan against it.** |

But swapping the columns over was the wrong mechanism, and it took three
measured failures to find the right one:

**Drag was counted twice.** A ggv table carries tyre and engine limits with no
drag in them; `longitudinalLimit` returns the opposite convention. Feeding one
into the other charged drag twice on every straight — 22 km/h.

**The friction ellipse was applied to the ENGINE.** The ggv path multiplied its
whole drive column by the ellipse. Above **108 km/h this car is engine limited
with tyre grip to spare**, so cornering was charged against a limit the tyre
never set: 1.4 s lost in the 160-200 km/h band while its cornering caps agreed
with the derived model to 2%.

**So the measurement calibrates CORNERING, not the tyre and not the engine.**
`planningEnvelope` computes a per-speed `muScale` — how much of the derived
model's lateral capability is real — and `longitudinal` applies it to the
axle's lateral radius alone, keeping `min(tyre spare, engine)` intact. Scaling
`mu` instead was tried and charges the correction to braking too, where the
low-speed part of it (steering lock, not grip) has no business.

The measured **ellipse exponent of 3.0** goes in the same place. The per-axle
maths assumed a circle, which understates what is left for braking while
cornering — the corner-entry overlap a human lives on.

### What accuracy means, and where it stands

The metric is not lap time — that conflates the model with the controller. It
is: **at commitment 1.0, how many stations plan for more grip than the car was
measured to have?** A property of the plan alone.

Croft Bay, low drag (`dev/accuracy.ts`), against a human's **51.650**:

| | overdraw at 1.0 | plan at 1.0 | off the human |
|---|---|---|---|
| derived formula | 210 of 658 | 51.796 | 0.15 s (right level, wrong shape) |
| whole measured envelope | 0 of 698 | 55.882 | 4.2 s |
| column swap, drag counted twice | 0 of 695 | 55.545 | 3.9 s |
| calibrated `mu` | 0 of 656 | 52.145 | 0.5 s |
| **calibrated lateral radius + measured ellipse** | **0 of 660** | **51.873** | **0.22 s** |

The derived formula's *level* was nearly right while its *shape* was badly
wrong, which is why the error hid for so long: a lap time cannot see 210 corners
overdrawing grip when the errors cancel.

Two more things had to be true before any of it shipped. The baked file has to
carry `muScale`, or a loaded line plans **uncalibrated** — a different, slower
car than the offsets were found for. And the envelope has to be baked at **full
precision**: rounding it to four decimals looked harmless at five parts per
million and moved the line 78 mm and the lap 0.2 s, because the commitment
search bisects on whether a lap stays valid and an accept can flip on the last
bit.

**What accuracy cost:** the driven lap went 56.367 to 57.050, because an honest
plan is a more aggressive one and the commitment search backs further off it.
That is the controller's problem now, and it is finally measurable against a
target worth hitting.

**Still wrong:** the plan is 0.22 s SLOWER than a human, and a theoretical
optimum should be faster. The envelope is sustained-only and cannot see the
grip a car has before it settles. And the model still has no steering lock — at
54 km/h it would plan 2.09 g where the car makes 1.55, held back by **16 degrees
of lock** rather than by the tyres; the measured `ay` column hides this at the
speeds it samples, but a corner tighter than an 11.3 m radius is unsteerable at
any speed and nothing says so.

### The follower was a proportional controller chasing a moving setpoint

It ran a permanent 8 km/h deficit for 84% of a lap. It now feeds forward the
plan's own acceleration and corrects the remainder.

### Cross-track error must be measured to the LINE, not to a station

It was the distance to the nearest station — 3 m apart, and the car covers most
of one per tick at speed, so the value stepped as the nearest station changed.
That sawtooth went straight to the steering: **35 direction changes per second**
while the car crossed the line twice. Projecting onto the segment, and reading
the tangent continuously along it, cut steering activity nine-fold.

### The feedforward was missing the understeer gradient

`atan(L·k)` is the Ackermann angle — what a car with no tyre slip would need.
This car understeers by construction (`rearGripBias` 1.25), so it needs extra
lock in proportion to cornering load. Supplying none of it did not look like a
mistake, it looked like a home: the car sat **1.2-1.5 m outside the line through
every corner**, 97% of the error being steady bias rather than wobble.

The steady-state gradient measures 0.00161 rad per m/s². The swept optimum is
**0.0055** — 3.4x higher, because the extra is doing *transient* work a
feedforward with no memory cannot otherwise pay for.

### Edge margin and follower accuracy are coupled

`EDGE_MARGIN + OFF_TRACK_MARGIN` is the entire budget before a lap voids. At the
moment the car departs it is often only 2-3 m off the line — tracking fine — but
the line itself is at the edge. The commitment search hides this by backing off
rather than crashing, so it reads as slowness.

## The traps

Every one of these produced a confident, wrong answer.

- **A held-speed skidpad lies at high speed.** The engine cannot beat drag, so
  the car quietly decelerates and you read grip at a speed you did not ask for.
  It invented a 2.9 g plateau. Coast down through the target instead.
- **Never reconstruct a human's position by projecting a replay onto the
  centreline.** It is ambiguous at a hairpin — it had a human taking a 20 m
  corner at 216 km/h, about thirty g. The lap records its own `(distance, time)`
  trace; use that.
- **Comparing the LINE's curvature to the CENTRELINE's proves nothing.** A
  racing line legitimately curves where the road is straight.
- **Binning a driven path onto 3 m stations manufactures curvature.** Our
  profile rated a human's own line at 74 s that they had just driven in 51.9.
- **Tune the follower on four circuits, not two.** Two gave `yawDamp: 0`, best
  there and 7 s worse on a third.
- **An average cannot find a corner.** "It brakes where it should lift" is a
  claim about places; it needed a per-corner table to see.

## Tried, measured, rejected

| idea | result |
|---|---|
| measured `ggv` table for the whole envelope | slower laps — but the diagnosis was wrong and the rejection cost months of planning against a formula. The `ay` column was good; only `axDrive` was bad. Split them and it is the largest accuracy win in the project |
| per-corner commitment calibration | unstable, corrections hit their clamps |
| latching the brake with a Schmitt trigger | 110 applications → 66, and **2.6 s slower** — a latch cannot feed throttle back through a long corner |
| `brakeTrust` (the model is 13% pessimistic braking) | helps 3 of 4 circuits, costs a fourth 1.5 s |
| shortest-path seed instead of minimum-curvature | wins one circuit, loses two |
| GA with coherent mutation + crossover on coarse nodes, scored on the driven lap | **1.15 s** in 2672 laps, against coordinate descent's **2.93 s in 2285** — the textbook recommendation lost. The descent's wide raised-cosine bumps are already coherent mutation, and it keeps every improvement instead of discarding most of a generation |
| optimising coarse control points as the line itself | sampling 3 m stations to 18 m nodes and interpolating back rounds the apexes off — generation zero started **3.4 s worse** than the line it was given. Optimise a coarse CORRECTION added to the line instead: zero reproduces the line exactly |

## What difficulty should be

Game AI Pro's skill model is our `commitment` exactly — multiply available grip
in the cornering-speed and braking-distance calculations. Two warnings we should
heed:

- The usable range is **small**; variation compounds over laps and spreads a
  field unrealistically. Ours is about 0.86-1.18.
- Balance the **group** with skill, and balance **against the player** with
  vehicle physics — grip, power, torque — not by winding skill further.

A **biorhythm** — skill wobbling on a slow waveform — makes a driver
periodically vulnerable without weakening it overall, and is what stops a field
feeling mechanical. Not built yet.

## What to build next, and why

Three things wanted, in the order they were asked for. None of them is a tuning
change; all three are about the AI being *legible as a driver* rather than merely
quick, which is a different and harder target than a lap time.

### Difficulty as mistakes — BUILT, and only half the answer

`Mistakes` rolls at each corner as a car ARRIVES at it: mostly nothing,
occasionally a few tens of metres early or a few late. Rolled on arrival rather
than per tick, so a driver commits to its error instead of changing its mind
halfway down the braking zone, which would be a twitch rather than a mistake.

The first attempt gave each driver a FIXED misjudgement per corner, seeded once
— always three metres early at turn two, every lap. That is a personality, not a
mistake, and it makes a car MORE predictable, not less: three identical laps in
a row.

Early errors are large and late ones small (`LATE_SHARE` 0.2). That asymmetry is
what the two errors ARE, not a safety fudge: braking far too early costs a tenth
and nothing else, braking far too late ends the lap.

It works, it scales, and it never puts a car off — measured over five laps with
every corner deliberately got wrong:

| mistake chance | corners wrong | lap times | off-track ticks |
|---|---|---|---|
| 0 | 0 of 63 | 51.983-52.000 | 0 |
| 0.5 | 26 of 63 | 52.167-52.933 | 0 |
| 1.0 | 63 of 63 | 52.567-52.800 | 0 |

#### Late braking cannot be a difficulty lever, and the reason is a cliff

The late cap was first set at 20% of the mistake size by reasoning — braking
late looked dangerous — and reasoning is not a good enough basis for a constant.
Measured, forcing EVERY corner to be braked late:

| how late | lap times | off-track ticks |
|---|---|---|
| 3 m | 51.800-51.850 | 0 |
| 6 m | 51.733-51.767 | 0 |
| 7 m | 51.767-51.833 | 28, one lap invalid |
| 8 m | 51.767-52.783 | 214, four of five invalid |
| 9 m | 51.833-52.917 | 453, all invalid |
| 15 m | 52.183-53.683 | 867, all invalid |

Baseline with no mistakes is 51.983. So below about 6 m braking late is not a
cost at all, it is a GAIN, and above about 7 m it stops being a time loss and
becomes a void lap. There is no band in between where it costs a modest,
survivable amount — the cost function is a cliff rather than a slope.

The cap was therefore right and the reason given for it was wrong. The real
reason is not that late braking is dangerous: it is that a mistake which makes
the car FASTER is not a mistake.

#### And the plan's brake points are about 6 m conservative

The same measurement says something that has nothing to do with difficulty:
braking six metres later than planned, at every corner, is worth **0.2 s a lap**
and costs nothing (51.983 to 51.767). That is the follower leaving time on the
table, not a driver error — and it sits right against the cliff, so it is a
tuning question to be taken carefully rather than a free gain to bank.

**A braking mistake is intrinsically cheap here: about 0.011 s for 16 m.**
Brake early, arrive slower, accelerate out, and most of it comes back. Reaching a
tenth from a braking point alone would need something like 150 m of
misjudgement, which is not a mistake, it is a different corner.

So this gives character at the steady end (0.6 s of lap-to-lap variation) and
almost none at the ruthless end, where the chance is low and each error is
small. Getting a visible mistake out of a quick driver needs a different KIND of
error — missing an apex, or running wide on exit and losing the following
straight — because those compromise what comes next, and a braking point does
not.

### Difficulty must not just be "slower everywhere"

Today `commitment` scales the whole lap, so an easier car is uniformly slower —
including down the straights, where there is nothing to be bad at. That reads as
a slow car rather than as a lesser driver, and it is the giveaway that there is
no driver there at all.

What it should be instead: **straights identical at every difficulty — full
throttle is full throttle** — with the difference living in the corners, as
braking a few metres early or a few metres late and then having to correct.
Every difficulty should carry some of this, varying between drivers, so that
none of them is metronomic.

That is also the honest version of what difficulty IS. A weaker driver does not
have less engine; they arrive at the corner having got the braking point wrong.

Feasible, and the pieces exist. The follower's brake point comes from one
`urgency` calculation, and `core/corners.ts` now names every turn, so the error
can be applied per corner per driver from a per-driver seed — repeatable, not
random per tick. The care needed is in the bound: braking late has to stay
inside what the car can recover from, or "less skilled" becomes "off at turn
one". Braking EARLY is free; braking late is the part that needs a limit.

### Rejoining the line is not urgent — unless you are on the grass

`crossGain` now scales with the sharpest corner within `urgencyTime` seconds of
travel: full authority when a corner is imminent, `urgencyFloor` of it when the
road ahead is straight. **Off the road, the scaling is skipped entirely** — there
is no lap time out there, the grip is a fraction of the tarmac's, and "take your
time" has no version that applies.

**On a clean lap it does nothing**, and measuring it there nearly got it thrown
away: sweeping the floor across a 6.7x range moved the lap 0.016 s and the
commitment ceiling not at all, because on a recorded human line the car already
tracks to **0.21 m**. The behaviour exists for a car that has been HIT, and a
time trial never contains one.

The first measurement of the race case was wrong, and wrong in a way worth
recording. Shoving the car sideways *away* from the centreline reported the
lazier setting saving **27 km/h** after a nine-metre hit — but that shove put the
car on the GRASS, and what was being measured was a car loitering off the road
keeping its speed up. That is not a benefit, it is the bug.

Measured properly, with the off-track override in place:

| | on tarmac (7 m shove) | on grass (13 m shove) |
|---|---|---|
| floor 1.00 | 3.9 km/h given up | 2.20 s off the road |
| **floor 0.60** | **1.8 km/h** | **2.38 s** |
| floor 0.35 | 1.0 km/h | **4.32 s** |

So the prize on tarmac is 2-3 km/h rather than 27, and a floor much below 0.6
buys the last of it by dawdling on the grass. 0.6 takes most of the benefit and
almost none of the loitering.

Two traps in one experiment: judging a race fix on a time trial, where the
condition never arises; and then testing the race case with a displacement that
quietly changed which surface the car was on.

### Getting back to the line is not urgent on a straight

The follower treats cross-track error the same everywhere: `crossGain` is a
constant, so a car a metre off line on a 250 km/h straight corrects as hard as
one a metre off mid-corner. It is the wrong priority — on a straight the line
barely matters, and what matters is keeping the throttle down and the speed up.
Drifting back over a couple of hundred metres costs nothing.

The urgency should rise with how soon the next corner arrives, not sit flat.

Feasible, and likely to pay for itself twice: a car that is not fighting to
rejoin the line is also a car that can hold an offset long enough to complete an
overtake, which is one of the four reasons the overtaking layer failed. The
constraint is that the ramp has to lead the corner by at least a braking
distance, or the car arrives off-line with no time left to fix it.

### Choosing an overtaking line by "which side has more room" is not racing

Recorded as the third complaint and not yet specified. The current rule picks the
side with more road and avoids whatever the car ahead committed to, which is
blind in the sense that matters: it does not consider which side the NEXT corner
wants, whether the move can be completed before it arrives, or whether the pass
is worth attempting at all.

## The rail, stated plainly

The follower tracks `line.speed[station]`. That is a CEILING, not a target, and
it means a car can never arrive anywhere faster than the reference expected.

Measured in `racecraft-lab.html`: two cars on a straight, identical plans, one
given **30% less drag** — a DRS advantage, genuinely more speed available.

| | |
|---|---|
| actual speeds | **232 / 232 km/h** |
| what the plans want | 234 / 233 km/h |
| gap | frozen at 29.9 m |

The advantage is invisible. Both cars sit on their plan, and the faster car
cannot use what it has. Worse, the situation worth testing — a car arriving at a
corner FASTER than its plan expected, and having to cope — cannot arise at all,
because nothing ever exceeds the plan.

This is why overtaking kept turning into "add a lateral offset": a rail-follower
has no other lever. A driver arriving at a corner too quickly brakes earlier and
takes a wider entry; a rail-follower has no representation for either, because
both mean departing from a stored answer.

So the planner has to compute speed FORWARD FROM THE CAR'S ACTUAL STATE — its
speed now, the path it has chosen, and the grip it has — rather than scaling a
stored profile. `core/planner.ts` is the start of that: it chooses WHERE from
free space, and reasons about rivals rather than about deviation. It does not
yet plan speed, which is the half that makes an out-braking move possible.

## What is not built

- **Racecraft.** The field circulates in grid order. Overtaking, defending and
  recovery are a utility-scored state machine with hysteresis on the incumbent
  state — the same lesson the brake latch taught.
- **A results screen** at the flag.
- **Per-node controller parameters.** Adaptive lookahead is reported worth ~20%
  in the autonomous-racing literature; ours is one speed-scaled rule.

[gaipro]: https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter38_An_Architecture_Overview_for_AI_in_Racing_Games.pdf
[acguide]: https://www.overtake.gg/downloads/ac-fast-ai-line-guide.59546/
[sophy]: https://www.nature.com/articles/s41586-021-04357-7
[sophytech]: https://www.gran-turismo.com/us/gran-turismo-sophy/technology/
[tum]: https://github.com/TUMFTM/global_racetrajectory_optimization
