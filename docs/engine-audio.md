# Engine audio — first sample-based pass

Implemented in `C:/Users/might/Desktop/Projects/bitepoint-lab` on 2026-10-12.

Direction: deep, textured engine note; audible RPM rise and gear-change drop;
avoid sustained piercing whine. Manual transmission changes are outside this pass.

Replaced the disabled oscillator engine with two continuously looping V8 samples:
power and coast. Pitch follows actual engine RPM, independent of road speed and
pedal position. Equal-power load blend changes character when lifting. Actual
shiftTimer briefly reduces power and volume; subsequent pitch follows physics RPM.
Low shelf adds body, sub-bass is trimmed, and a damped low-pass limits harshness.
All parameters glide; playback remains behind existing master volume and limiter.
Pause/menu fades remain intact. Late async sample loading starts at zero gain.
Loading can retry on the next Drive gesture; disposal stops and disconnects voices.

Source: Generic V8 Engine Sound by DerMeehdrescher / Meehdrescher Studios:
https://opengameart.org/content/generic-v8-engine-sound
CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/
The source does not establish physical recording versus synthesis.
Adapted samples retain CC BY-SA 4.0. Credits available in Settings and beside files.
Adaptations: mono, DC removal, cycle-aligned crossfade, RMS normalization.

Cost: 196,624 bytes of WAV assets, two buffer sources, three filters, three gain
nodes. No added rendering geometry, shader work, worklets or per-frame sample DSP.
Engine control update remains under the existing ~60 Hz audio scheduling cap.
This is not a full in-game CPU/GPU performance benchmark.

Validation:
- TypeScript passed; 35 audio tests passed; complete client/API production build passed.
- Browser decoded actual assets and rendered the production EngineVoice graph.
- 20-second idle/acceleration/two-shift/lift/pause preview: 201 ms offline render,
  peak 0.3361, RMS 0.0812, no clipping; paused tail peak 0.0000945.
- Live Drive/pause/menu flow produced no warning or error logs. Sound setting remains Low.
- Local audition page: http://127.0.0.1:5178/tools/engine-preview.html
- Preview file: bitepoint-engine-preview.wav (adapted CC BY-SA 4.0 audio, same credits).

Limits: this is a first audition, not a by-ear quality certification. One RPM anchor
per load state means the idle texture stretches more than a professional multi-RPM
bank. If the character is liked, additional matched low/mid-RPM samples would be
the next quality improvement. Do not add unrelated noise layers to compensate.
Do not alter engine RPM or shift physics just to make the soundtrack more dramatic.

Backups: work/engine-audio/before. Existing tyres, wind, impacts and surface audio
were preserved; obsolete engine-only mappings and tests were replaced.
# Engine articulation and braking downshifts — 2026-10-13

Project: C:/Users/might/Desktop/Projects/bitepoint-lab

## Changes

- Audio receives the actual zero-based gear and idle RPM.
- Upshifts traverse the RPM change over a brief articulation window, unload the
  power layer and retain coast body. The former 76% volume dip is now 32%.
- Downshifts have a short audio-only rev-match flare and throttle-like bark,
  settling back to actual RPM. No extra torque is introduced by the sound.
- Short excerpts of a licensed sampled exhaust catch mark shifts. Source offset,
  rate and occasional quiet after-pulses vary; sustained coasting does not trigger
  continuous crackles. A substantial lift can occasionally trigger one catch.
- Very small, slowly varying colour/level changes reduce rigidity without RPM
  vibrato. Slightly more low-shelf body; braking coast has a little more weight
  than neutral lift. Cornering rattles were not added.
- Pausing cancels event tails and resets gear detection, avoiding phantom shifts.

## Automatic gearbox

Hard braking now raises the downshift threshold according to brake input. The
candidate lower gear must land below both redline and upshift RPM with a 650 RPM
margin. One gear at a time, with the existing clutch/torque interruption. Braking
also avoids an unnecessary upshift unless RPM has exceeded redline. Acceleration
and ordinary coasting retain their previous schedules; first gear remains guarded.

New player sessions enable this schedule. The optional `brakeAwareAuto: true`
recording flag travels through storage, verification and input replay. Existing
recordings omit it and reproduce the original schedule. AI stays on its existing
gearbox tuning.

## Validation

- All 516 tests passed across 48 files. Client and API production builds passed.
- New checks cover connected upshifts, braking blips, event counts, pause/resume,
  constant-RPM variation, early braking shifts, over-rev guards, brake-release
  hunting, unchanged acceleration and new/old lap replay compatibility.
- Browser rendered actual low-drag Car automatic driving with the new braking
  schedule: six upshifts and six downshifts, no audio warnings/errors.
- Same 25-second driving trace, previous audio vs new: peaks 0.3378 / 0.3501;
  RMS 0.0761 / 0.0841; neither clips. New paused tail reaches zero.
- Hard braking begins at 15 s. First downshift at 15.033 s, then 15.317, 15.583,
  15.850, 16.083 and guarded first gear at 17.017 s.
- New isolated offline render 394 ms for 25 s audio; previous 442 ms. This is an
  audio render measurement, not an in-game frame-rate benchmark.
- Added asset 49,783 bytes. Two constant loop voices; one extra low-pass and at
  most four short transient voices. No extra renderer work.

## Audition and source

http://127.0.0.1:5178/tools/engine-preview.html presents previous/new audio on the
same actual gearbox trace. Local export: outputs/bitepoint-engine-shifts.wav.
Checks: outputs/bitepoint-engine-shift-checks.json. Backups: work/engine-shifts/before.

Added source: "BACKFIRE.ogg" by CeebFrack, CC0, public high-quality MP3 preview:
https://freesound.org/people/CeebFrack/sounds/105351/
https://creativecommons.org/publicdomain/zero/1.0/
Existing loop credits remain CC BY-SA 4.0 by DerMeehdrescher / Meehdrescher Studios.
The transient is a designed backfire effect, not an authentic gearbox recording.
Credits are included with the game assets and accessible through Settings.

Technical reference consulted: Wreckfest engine audio guide (Audiokinetic), which
describes separate load/coast blend tracks and RPM/load-driven playback:
https://www.audiokinetic.com/media/blog/LoopBasedCarEngineDesign/vehicle_audio_modding_guide_for_wreckfest-Wwise2019_2_9.pdf

Remaining limit: sustained engine texture still uses one RPM anchor per load
state. More matched RPM recordings would be the substantial next improvement;
small modulation and transient events cannot replace that. Subjective audio
quality needs the user's by-ear driving review.

# Downshift reference refinement — 2026-10-13

Local source: `C:/Users/might/Downloads/f126_gameplay.mp3` (30:20.656).
Correct matching video: https://www.youtube.com/watch?v=EVMVm1ETH9I
First race of 2026! F1 26 Season EP-1 Australia (No Commentary).

The initially supplied JmWcSHgNOjM video was a different recording. Its HUD
observations are excluded from this comparison. The user corrected the source
before this pass's tuning changes. Speed HUD uses MPH, converted below.

## Observed matching HUD frames

| Video time | Gear | MPH | km/h | Displayed RPM |
| --- | --- | --- | --- | --- |
| 6:05.500 | 8 | 169 | 272.0 | 10,359 |
| 6:05.767 | 7 | 158 | 254.3 | 10,624 |
| 6:06.033 | 6 | 130 | 209.2 | 9,208 |
| 6:06.300 | 5 | 116 | 186.7 | 9,717 |

HUD values are read from paused 30 FPS frames, not exported telemetry. The MP3
was frame-demuxed at 299.807–390.008 s and decoded to 16 kHz mono for analysis.
Spectrograms in work/engine-shifts show a sharper rising pulse followed by falling
harmonic contours in braking zones. Harmonic tracking is an estimate and does
not establish exact RPM independently. Pitch tracking has noisy/octave-ambiguous
regions and was not used as a literal target RPM curve.

Bitepoint's low-drag car has seven gears and an 8,200 RPM redline. Reference audio
uses a different car/gearbox. This refinement matches the shape and articulation
of braking pulses while retaining Bitepoint's actual RPM/gear progression.

## Downshift-only refinement

- Pitch interpolation reaches the lower gear in 45 ms (previously 110 ms).
- Asymmetric blip: 45 ms attack, 28 ms release time constant, faded out by 155 ms
  (previously a symmetric 230 ms pulse). These are reference-inspired tuning
  choices, not exact parameters measured from the commercial game's implementation.
- Flare ceiling reduced from 320 to 180 RPM; blip throttle weight .86 -> .64.
- Downshift exhaust catch strength .18 -> .055; no second downshift pop.
- Upshift and lift behavior preserved. Physics and automatic shift timing unchanged.

## Checks

42 audio tests passed, including sharp downshift attack, falling tail, settling at
actual RPM, no pause/resume phantom events and bounded timbre variation. Full client
and API production build passed. The full 516-test suite passed in the immediately
preceding gearbox pass; this subsequent change is confined to audio articulation.

Browser comparison uses the identical actual automatic drive, six upshifts and six
downshifts. Both render without clipping, peak .3501. New RMS .0832 versus .0842.
New paused tail reaches zero. 498 ms offline render for 25 s audio; not a FPS benchmark.
No new audio assets or constant nodes were added.

Comparison: http://127.0.0.1:5178/tools/engine-preview.html
Exports: outputs/bitepoint-downshift-previous.wav, outputs/bitepoint-downshift-new.wav.
Measurements: outputs/bitepoint-downshift-refinement-checks.json and
outputs/bitepoint-downshift-wave-comparison.json.
Backups: work/engine-shifts/reference-before.

Subjective hearing was not available to the assistant. The pass uses waveform,
spectral and HUD measurements plus the user's listening feedback. Final by-ear
assessment belongs to the user's driving review. The provided commercial audio
is only a private reference and is not used as a game asset or in the build.

# Automatic gearing for keyboard brake bursts — 2026-10-13

User clarification: automatic should select an appropriate lower gear as speed
falls, including coasting between keyboard brake taps. Brief braking memory alone
does not address a generally tall coast gear.

New player sessions use automatic schedule 2. Normal downshift RPM is raised from
4,600 to 68% of upshift RPM (5,304 for the playable 7,800 shift point), independent
of brake strength. Each candidate lower gear is still checked against redline and
the upshift threshold, with a 650 RPM margin; shifts remain one gear at a time and
retain clutch delay. First gear remains guarded at road speed. Acceleration
upshift points are unchanged. No input-ramp, audio, tyre or rendering changes.

Record compatibility: absent `brakeAwareAuto` reproduces the original schedule;
true reproduces the prior brake-pressure schedule; 2 reproduces the new road-RPM
schedule. Both flags are stored, verified and replayed. AI tuning is unchanged.
This avoids adding transient braking-memory state to recorded car poses.

Validation:
- 100 targeted audio/gearbox/sim/storage checks passed.
- 131 vehicle/timing/API checks passed (9 gearbox checks overlap the first run).
- Coast from fifth at about 140 km/h selects fourth with no brake input.
- Coasting from fifth at 100 km/h selects third or lower within 12 physics ticks.
- A sub-0.2 pedal dab followed by neutral coasting still reaches the next gear.
- Accelerating states match the previous schedule exactly over 12 seconds.
- Release/coast does not immediately reverse a downshift.
- Original and both updated recording schedules verify and replay correctly.
- Complete browser/API production build passed.

Backups: work/engine-shifts/road-auto-before.
Game: http://127.0.0.1:5178/ . Start a fresh session for the new schedule.
