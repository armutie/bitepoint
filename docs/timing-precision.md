# Precise timing — 2026-10-11

The player noticed frequent lap times ending in .000, .050 and .067. The old
lap and sector clocks measured whole 60 Hz ticks (16.667 ms), despite displaying
three decimal places. Increasing physics frequency would spend CPU on the wrong
problem.

New laps interpolate the forward start/finish and sector crossings between
successive track projections. A fractional remainder starts the next lap at
the line, so no distance or time is lost at the tick end. Sector splits use
the same clock and sum exactly to the completed lap. Final traces end on the
line, with its crossing time; the identical-drive live delta remains zero.

Recording timing format 2 includes the pre-start state and crossing tick input
(rollingStart). Verification derives both crossing fractions from authoritative
physics rather than trusting a client timing correction. It requires the first
input to cross the start line, preventing an extra untimed approach. Manual
gears, TC and ABS still reproduce the vehicle exactly.

The first ghost pose has a negative pathStartTime relative to the line; stored
paths seek using elapsed lap time, with position and shortest-angle interpolation.
Existing recordings without the timing marker keep their original tick times,
load normally, and remain verifiable. Their old values are not retroactively
made more precise. Race finish times and same-tick finish order use the crossing
fraction too. Playback's full input span includes the partial ticks either side
of the lap, so LapReplay.duration is a playback span, not the verified lap time.

Physics remains 60 Hz with the same 10 integration substeps. No renderer,
handling, asphalt, tree, camera or lighting settings were altered.

Validation: the full 506-test suite and browser/API production build passed.
Analytical gate tests distinguish a 1 ms crossing difference at 60 Hz, cover
sectors, reverse crossings, next-lap remainder and same-tick race finish order.
Real-lap tests cover exact verification, older recordings, storage and ghost
alignment. Four before/after laps over 23,982 identical-input ticks showed zero
vehicle-position difference and exactly matching live/verified lap times. One
example changed from 1:38.900 to 1:38.908; another from 1:38.883 to 1:38.884.

A warmed, alternating nine-sample CPU benchmark measured 3.863 to 3.940
microseconds per car tick (median): about 0.00155 ms extra per tick for 20 cars.
This isolates simulation timing overhead, not browser GPU or full-game FPS.
Crossing interpolation provides finer timing resolution; it is an estimate of
motion between physics updates, not a claim that the simulation runs at 1000 Hz.

Evidence: C:/Users/might/Documents/Codex/2026-10-10/pl/outputs/bitepoint-timing-verification.json
# Pause clock correction — 2026-10-11

The user clarified that the suspicious endings also appeared in the pause
menu. The previous fix interpolated completed lap and sector crossings, but
the pause status and live HUD still read the elapsed clock at a physics tick.

The live HUD now includes the game loop's fractional accumulator. Pressing
pause synchronizes to the input event timestamp, completes any due fixed tick
before controls are released, and freezes the remaining fraction. The pause
menu and held HUD show that same time. Resume retains the fraction and excludes
all paused wall time. Restart and new sessions clear the fraction; stopping and
restarting browser animation for visibility changes preserves it.

Completed lap/sector timing and replay verification remain deterministic at
60 Hz. The pause change adds no higher-frequency physics or rendering work.

Validation: 58 relevant loop, timing, replay, qualifying and HUD tests passed,
including four new tests covering 1 ms pause differences, menu time exclusion,
due-tick completion, fraction reset and browser stop/start. Final browser/API
production build succeeded. In the actual pause menu 0:06.481 stayed frozen;
resuming for about 0.753 seconds produced 0:07.234, matching the held HUD. The
test drive was off track, so its invalid marker is expected and unrelated to
timing. Screenshot: outputs/bitepoint-pause-timing.png in the workspace.
