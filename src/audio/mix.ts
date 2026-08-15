/**
 * Physics state to audio parameters. Pure functions, no Web Audio.
 *
 * Split out so the part that decides *how loud a slide is* can be read, argued
 * with and tested, while the part that wires oscillators stays a thin shell.
 * Every number here is a named quantity in real units, because tuning this is
 * done entirely by ear and a graph of anonymous magic constants is untunable.
 *
 * Three rules run through all of it, and they are the anti-annoyance work:
 *
 * 1. **Nothing switches on.** Every level crosses a soft knee (`smoothstep`,
 *    not a ramp and certainly not a threshold), so a sound arrives by growing
 *    out of silence. A tyre that starts squealing the instant a number crosses
 *    a value is the single most irritating thing a driving game does.
 * 2. **Everything has a ceiling well under 1.** These are supporting layers;
 *    none of them is allowed to be the loudest thing in the mix, ever.
 * 3. **Bright is banned.** Cutoffs are capped low deliberately. High-frequency
 *    content is what makes continuous noise fatiguing after ninety seconds, and
 *    a resonant squeal is just a sine wave wearing a costume.
 */

/** Hermite soft knee. Zero below `lo`, one above `hi`, gentle at both ends. */
export function smoothstep(lo: number, hi: number, x: number): number {
  if (hi <= lo) return x >= hi ? 1 : 0
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

// --- tyres ------------------------------------------------------------------

/**
 * Slip angles either side of the rasp, in radians.
 *
 * MEASURED, not guessed — the first set of these was invented and the tyres
 * were inaudible as a result. Taken off the f1 traces in
 * `__fixtures__/physics.json`, above 8 m/s:
 *
 *     steady_corner  0.21 rad (12 deg)   trail_brake         0.21
 *     lift_off       0.34                power_on_oversteer  0.36
 *     brake_stab     0.40                steer_sweep         0.42
 *
 * So a committed fast corner already lives at 0.21 rad. Anything with a knee
 * above that is silent for the whole of ordinary hard driving, which is what
 * the first attempt did.
 *
 * The rasp is therefore essentially fully up by 0.24: if you are cornering
 * hard, you hear the tyres working.
 */
export const SLIP_QUIET = 0.05
export const SLIP_LOUD = 0.24

/** Longitudinal slip ratio: wheelspin on power, lock-up under brakes. */
export const SPIN_QUIET = 0.12
export const SPIN_LOUD = 0.55

/**
 * Where the squeal starts, well after the rasp.
 *
 * A tyre makes two different noises and the first version only had one of
 * them. The rasp is rubber dragged over aggregate: broadband, and it is what a
 * tyre does as soon as it works hard. The squeal is stick-slip — the tread
 * block grabs, loads up, releases, and does it again some hundreds of times a
 * second — and it is *pitched*, which is the entire reason a squeal sounds
 * like a squeal instead of a hiss.
 *
 * Filtered noise with a slowly sweeping cutoff and no resonance is, precisely,
 * the sound of sweeping. Hence the broom.
 *
 * Stick-slip needs real sliding velocity to get going, so this knee sits later
 * than the rasp's: lean on the tyres and you get roar, actually slide and it
 * starts to sing.
 */
/**
 * EXPERIMENT: a narrow knee, because stick-slip is a THRESHOLD.
 *
 * This was 0.16-0.33, a band of 0.17 rad, and you could hear the squeal ramp
 * up and down across it — which is not what a tyre does. A tyre is either
 * gripping or it has broken away; the transition is abrupt and the sound is
 * intermittent, not a fader being pushed. 0.19-0.25 is close to a switch, with
 * just enough softness left to avoid an actual click.
 *
 * This deliberately reintroduces suddenness, having spent the first pass
 * removing it. The distinction that makes it correct rather than a regression:
 * the original problem was a sound arriving with no cause, at a threshold that
 * meant nothing. This one arrives because the tyre genuinely let go.
 */
export const SQUEAL_QUIET = 0.18
export const SQUEAL_LOUD = 0.28

/** The edge now tracks the squeal almost exactly: if it sings, it is sharp. */
export const EDGE_QUIET = 0.19
export const EDGE_LOUD = 0.26

/**
 * Ceilings, and they are the whole mix philosophy in four numbers.
 *
 * The rear is allowed to be louder than the front because a rear slide is the
 * more urgent thing to know about.
 *
 * These were far too low to start with, for a reason worth recording: the test
 * that guarded them added the gains up as if they were correlated. Uncorrelated
 * noise sources do not sum in amplitude, they sum in POWER — six layers at 0.2
 * are not 1.2, they are `sqrt(6)*0.2 = 0.49`. Guarding against the arithmetic
 * sum forced every layer down to a third of where it should sit, which is how
 * the kerbs ended up right and the tyres ended up silent.
 */
export const RASP_MAX_FRONT = 0.18
export const RASP_MAX_REAR = 0.24

/**
 * EXPERIMENT — the deliberately piercing squeal.
 *
 * Turned up hard on purpose to find the ceiling by overshooting it. The
 * expectation is that this is too much and it squeals constantly; the point is
 * to hear where "too much" actually is rather than keep creeping up on it.
 *
 * To wind it back, these are the values it came from:
 *
 *     SQUEAL_MAX_FRONT 0.17   SQUEAL_MAX_REAR 0.26
 *     EDGE_QUIET       0.24   EDGE_LOUD       0.46
 *     partial trims    0.55 / 0.28    Q 9 / 7 / 6    EDGE_CEILING 2400
 *     RASP_DUCK        0 (no ducking at all)
 */
export const SQUEAL_MAX_FRONT = 0.28
export const SQUEAL_MAX_REAR = 0.42

/**
 * How far a squealing tyre pushes its own rasp out of the way, 0..1.
 *
 * The mix bug underneath "it gets drowned out": the rasp band is 900-1700 Hz
 * and the squeal's second and third partials are 720-1800 and 1080-2400. They
 * are not merely both loud, they are in the SAME PLACE, so the broadband layer
 * masks the harmonics that make the squeal a squeal. No amount of turning the
 * squeal up fixes that; the rasp has to move.
 *
 * This is the "only two or three things loud at once" rule finally implemented:
 * once a tyre is singing, the singing is the information and the roar is not.
 */
export const RASP_DUCK = 0.8

/**
 * EXPERIMENT: the front tyres are muted. Set to 1 to bring them back.
 *
 * Two tyres squealing at once is mush — they sit in the same band, chatter at
 * similar rates, and the ear gives up trying to separate them. Silencing the
 * front leaves the rear alone in that space, where it can be as sharp as it
 * likes without fighting anything.
 *
 * The cost is real and worth stating: understeer becomes inaudible. The front
 * washing wide is exactly the sort of thing sound is good at telling you, and
 * with this at 0 the car will only ever announce the rear letting go. If the
 * sharp rear turns out to be right, the front probably wants to come back at
 * something like 0.3 rather than at parity.
 */
export const FRONT_TYRE_LEVEL = 0

/** Uncorrelated noise layers combine in power, not amplitude. */
export const combinedLevel = (...gains: number[]): number =>
  Math.sqrt(gains.reduce((sum, g) => sum + g * g, 0))

/**
 * Below this the tyres are silent whatever the slip says (m/s).
 *
 * A stationary car turned to full lock has a large slip angle and must make no
 * noise at all. Without this gate the car sits on the grid squealing.
 */
export const TYRE_GATE_LO = 5
export const TYRE_GATE_HI = 11

export interface AudioInput {
  /** Road speed, m/s. */
  speed: number
  /** Body-frame forward speed, for the longitudinal slip denominator. */
  vx: number
  /** Driven-wheel surface speed, m/s. */
  wheelVr: number
  /** Front and rear slip angles, radians. */
  slipF: number
  slipR: number
  onKerb: boolean
  onGrass: boolean
  /** Engine speed and its redline, rpm. */
  rpm: number
  redlineRpm: number
  /** Signed pedal: positive drive, negative brake. */
  throttle: number
  /** Seconds left of the gearchange torque cut; 0 when in gear. */
  shiftTimer: number
}

// --- engine -----------------------------------------------------------------

/**
 * Firings per revolution x 2. A V6 fires three times per revolution of a
 * four-stroke, so the firing frequency is `rpm/60 * 3` — 60 Hz at a 1200 rpm
 * idle, 410 Hz at the 8200 rpm redline. That is the note the engine sings.
 */
export const ENGINE_CYLINDERS = 6

/**
 * How the engine's harmonics fall away, MEASURED from INSIDE a car.
 *
 * The second reference replaced the first, and the difference matters more than
 * any tuning done between them. The first was a distant exterior mic on an
 * idling car: broadband, reverberant, centroid 979 Hz, flatness 0.391. The
 * second is a cabin mic during acceleration — what a driver actually sits in —
 * and it is a completely different sound:
 *
 *     centroid 154 Hz      flatness 0.083      50% of energy below 129 Hz
 *     20-60 Hz    16.1%    250-500 Hz   22.2%
 *     60-125 Hz   32.7%    500-1000 Hz   0.6%
 *     125-250 Hz  28.2%    above 1 kHz   0.1%
 *
 * 99.2% below 500 Hz. Everything the previous version did to sound "raw" put
 * energy where a real cabin has none at all.
 *
 * The rolloff is steep, and the first two are equal — a 1/n series would put h2
 * at half of h1, which is why a naive additive engine sounds thin.
 */
export const ENGINE_HARMONICS = [
  1.0, 1.0, 0.6, 0.34, 0.25, 0.16, 0.15, 0.09, 0.085, 0.042, 0.059, 0.03, 0.042, 0.027,
] as const

/**
 * Share of engine energy carried by the harmonics rather than by broadband.
 *
 * MEASURED at 30%, with a spectral flatness of 0.391 — an engine is mostly
 * NOISE with harmonic structure on top of it, not a harmonic stack. This is the
 * whole defence against whine: a pure additive engine is 100% tonal, and 100%
 * tonal at a frequency that tracks a pedal is precisely the sound everyone
 * complains about.
 */
export const ENGINE_TONAL_SHARE = 0.72

/** Level of the cabin floor, relative to the engine's overall gain. */
export const ENGINE_RUMBLE = 0.85

/**
 * How much louder the engine's three layers are together than `ENGINE_MAX`.
 *
 * The ceiling used to be applied to each layer separately — tonal, induction
 * noise and cabin rumble — so the engine's real combined level was 1.31x the
 * number written down, and every comparison against the tyre and kerb ceilings
 * was wrong by that factor. Dividing by this makes `ENGINE_MAX` mean what it
 * says, which matters now that it is being set by ear against the other
 * layers rather than in isolation.
 */
export const ENGINE_LAYER_SUM = Math.sqrt(
  ENGINE_TONAL_SHARE + (1 - ENGINE_TONAL_SHARE) + ENGINE_RUMBLE * ENGINE_RUMBLE,
)

/**
 * Ceiling — the engine's COMBINED level, all three layers together.
 *
 * This is the first value that has actually been applied. Every earlier
 * reduction went in ahead of the saturator and therefore controlled distortion
 * rather than volume, which is why the engine stayed loud however far the
 * number came down. See `Engine.level`.
 *
 * Set low on purpose: it is the only sound that is always there, and a layer
 * that never stops has to sit further back than one that comes and goes. The
 * kerbs and the tyres are events, and events can be louder than the thing they
 * happen over.
 */
export const ENGINE_MAX = 0.1

/**
 * The engine is MUTED for now. Set to false to bring it back.
 *
 * Parked rather than deleted: the tyres, surface, wind and impacts are working
 * and the engine is not, and leaving a sound that is not right underneath ones
 * that are makes it impossible to judge either. Everything it needs — the
 * measured harmonic profile, the cabin floor, the post-saturator level control
 * — stays wired up and tested, so this is one word away from being audible
 * again once there is a reference worth tuning it against.
 *
 * Applied in the GRAPH, not here. `levelsFor` goes on reporting what the engine
 * would be doing, so the mapping stays under test while it is silent — mute it
 * in the mapping and the tests for lift-off, the gearchange cut and the ceiling
 * all quietly start passing on zeroes.
 */
export const ENGINE_MUTED = true

/**
 * Strength of the HALF-ORDER content, relative to the firing harmonics.
 *
 * The lumpiness. A V-engine does not fire evenly — the vee angle and the crank
 * throws mean the bangs are not equally spaced — and the audible result is
 * energy at half the firing frequency and its odd multiples. That is the whole
 * reason a V8 burbles and an inline-four drones, and building the wave from
 * clean firing harmonics alone is why this sounded like an organ.
 *
 * So the oscillator runs at HALF the firing frequency: even harmonics carry the
 * measured profile, odd harmonics carry the uneven firing at this fraction.
 */
export const ENGINE_HALF_ORDER = 0.4

/**
 * The engine wave, as harmonic amplitudes of a fundamental at HALF the firing
 * frequency. Even entries are the firing harmonics, odd are the half-orders.
 */
export function engineWaveProfile(): number[] {
  const out: number[] = []
  for (let k = 1; k <= ENGINE_HARMONICS.length * 2; k++) {
    const near = ENGINE_HARMONICS[Math.max(0, Math.floor(k / 2) - (k % 2 === 0 ? 1 : 0))] ?? 0.2
    out.push(k % 2 === 0 ? near : ENGINE_HALF_ORDER * near)
  }
  return out
}

export const firingFrequency = (rpm: number): number => (rpm / 60) * (ENGINE_CYLINDERS / 2)

export interface AudioLevels {
  /** 0..1 gains. */
  windGain: number
  raspFront: number
  raspRear: number
  squealFront: number
  squealRear: number
  surfaceGain: number
  /** Filter cutoffs, Hz. */
  windCutoff: number
  /** Centre of the rasp's band — deliberately above the wind's ceiling. */
  raspCentre: number
  surfaceCutoff: number
  /**
   * Rate of the rasp's roughness, Hz.
   *
   * The thing that separates rubber from air. Wind is smooth: a continuous
   * pressure sound with no structure. A tyre is granular — the contact patch is
   * banging over aggregate — and that graininess is what your ear uses to tell
   * them apart, far more than the frequency band does.
   */
  raspGrain: number
  /** Stick-slip pitch per axle, Hz — the note the tyre is singing. */
  squealFreqFront: number
  squealFreqRear: number
  /**
   * How much harmonic edge the squeal carries, 0..1, per axle.
   *
   * The difference between a warm scrub and one that cuts. Stick-slip is
   * periodic, so a real squeal is a harmonic series, and the second and third
   * partials are what land in the 1–2.4 kHz region where the ear is getting
   * sensitive. That is where "piercing" actually comes from — a bright *hiss*
   * is just fatiguing, but bright *harmonics* read as a sound with a pitch,
   * cutting through, which is what you want to be told about.
   *
   * Deliberately arrives later than the squeal itself. Lean on the car and it
   * stays warm; get it properly sideways and it starts to shout. That way the
   * piercing quality is reserved for the moment it is worth being piercing,
   * rather than being a property of the sound that wears you down over a lap.
   */
  squealEdgeFront: number
  squealEdgeRear: number
  /**
   * How much of the rear's noise is wheelspin rather than a slide, 0..1.
   *
   * The counterweight to the edge. Where `squealEdge` adds harmonics and pitch,
   * this adds chatter and takes the tone away — so the same layer covers both
   * "sideways and screaming" and "lit up in a straight line" without them
   * sounding like the same event.
   */
  squealRoughRear: number
  /**
   * Rate of the squeal's amplitude flutter, Hz.
   *
   * Real stick-slip is not steady; it stutters. Without this the pitched layer
   * is a held tone, which is the other way this goes wrong.
   */
  squealGrain: number
  /** Kerb rumble modulation rate, Hz. Zero when not on a kerb. */
  rumbleRate: number

  /** Engine: overall level, and the firing frequency it is built on. */
  engineGain: number
  engineFreq: number
  /**
   * Brightness of the whole engine, Hz.
   *
   * Follows LOAD as well as revs, which is the part that stops it being a siren
   * on a slider. On-throttle and off-throttle are completely different sounds
   * at the same engine speed: lift at 7000 rpm and a real car goes dark and
   * hollow instantly, while the pitch barely moves. An engine mapped on revs
   * alone cannot do that, and no amount of tuning saves it.
   */
  engineCutoff: number
  /** Fundamental wander, Hz. A perfectly steady engine is a synthesiser. */
  engineJitter: number
  /**
   * How hard the engine is driven into saturation, 0..1.
   *
   * The raw. An exhaust is a violently nonlinear thing — pressure waves
   * clipping against pipe walls, a sound that distorts long before it reaches
   * you — and a sum of clean sine partials has none of that. This drives a
   * waveshaper, which folds the harmonics into each other and produces the
   * intermodulation that reads as guttural rather than as a chord.
   *
   * Rises with load: an engine on the overrun is comparatively polite, and the
   * same engine at full throttle is not.
   */
  engineDrive: number
}

/**
 * The pitch a sliding tyre sings at, in Hz.
 *
 * MEASURED off a real handbrake-turn screech (see the note on `SQUEAL_CLUSTER`).
 * The strongest partials sit at 1194-1512 Hz with the spectral centroid at
 * 1957 Hz — so the entire previous range of 360-900 was more than an octave too
 * low. That, and not the lack of an oscillator, is why nothing sounded
 * piercing: the sound was correct in character and simply in the wrong place.
 *
 * Tracks sliding velocity — speed across the contact patch, `v·sin(slip)` —
 * because that is what sets the grab-release rate, so the pitch rises as the
 * slide is pushed and falls as it is gathered up.
 */
export function squealPitch(speed: number, slip: number): number {
  const slideSpeed = speed * Math.sin(Math.min(Math.abs(slip), Math.PI / 2))
  return 950 + 550 * smoothstep(1, 15, slideSpeed)
}

/**
 * Partial ratios, measured rather than assumed.
 *
 * The real screech is NOT a harmonic series. Its strongest peaks come out at
 * 1194, 1245, 1304, 1382, 1433, 1473 and 1512 Hz — ratios of 1.00, 1.04, 1.09,
 * 1.16, 1.20, 1.23, 1.27 — a dense cluster inside a fifth, plus one separate
 * partial at 2.17x. Nothing at 2.00 or 3.00 at all.
 *
 * That is a body with many close modes, not an oscillator, and it explains
 * why an f/2f/3f stack sounded synthetic no matter how it was tuned: a
 * harmonic series is exactly what this is not.
 */
export const SQUEAL_CLUSTER = [1.0, 1.12, 1.24] as const
export const SQUEAL_UPPER = 2.17

/** How fast the driven wheels are slipping relative to the road, 0..~1. */
export function slipRatio(wheelVr: number, vx: number): number {
  const denom = Math.max(Math.abs(vx), 3)
  return Math.abs(wheelVr - vx) / denom
}

export function levelsFor(input: AudioInput): AudioLevels {
  const { speed } = input
  const gate = smoothstep(TYRE_GATE_LO, TYRE_GATE_HI, speed)

  const lateralF = smoothstep(SLIP_QUIET, SLIP_LOUD, Math.abs(input.slipF))
  const lateralR = smoothstep(SLIP_QUIET, SLIP_LOUD, Math.abs(input.slipR))
  // The rear takes whichever is worse: sliding sideways and spinning up sound
  // like the same event to a driver, and both mean the same thing — gone.
  const longitudinal = smoothstep(SPIN_QUIET, SPIN_LOUD, slipRatio(input.wheelVr, input.vx))
  const rear = Math.max(lateralR, longitudinal)

  const squealF = smoothstep(SQUEAL_QUIET, SQUEAL_LOUD, Math.abs(input.slipF))
  const squealR = Math.max(
    smoothstep(SQUEAL_QUIET, SQUEAL_LOUD, Math.abs(input.slipR)),
    smoothstep(0.25, 0.8, slipRatio(input.wheelVr, input.vx)),
  )

  // The rasp lives ABOVE the wind, not on top of it. Both were lowpassed pink
  // noise at overlapping cutoffs, which is one sound at two volumes — the tyres
  // were not quiet so much as indistinguishable. This is a band, sitting clear
  // of the wind's 620 Hz ceiling.
  const worst = Math.max(lateralF, rear)
  const raspCentre = 900 + 800 * worst

  // Wind: dark and quiet. This is a pressure sensation, not a hiss — the top
  // end is rolled off hard so it can sit under everything for a whole lap.
  // Pulled down from 760 Hz to leave clear air between it and the rasp.
  const windGain = 0.16 * smoothstep(4, 62, speed)
  const windCutoff = 200 + 420 * smoothstep(0, 70, speed)

  // Surface. Grass is a broad, dull roar; a kerb is louder and a little
  // brighter, and gets its rattle from the rumble modulation rather than from
  // being turned up.
  const surfaceGain = input.onGrass ? 0.3 * gate : input.onKerb ? 0.22 * gate : 0
  const surfaceCutoff = input.onGrass ? 480 : 900
  // Roughly one rib per 0.85 m of travel, held inside a range that stays a
  // rumble: above ~40 Hz it turns into a pitch, below ~5 it is a flutter.
  const rumbleRate = input.onKerb ? Math.min(40, Math.max(5, speed / 0.85)) : 0

  return {
    windGain,
    windCutoff,
    // Each axle's rasp is ducked by its OWN squeal, not by the pair. A front
    // that is scrubbing while the rear sings should still be heard scrubbing —
    // that combination is understeer-into-oversteer, and losing half of it
    // would throw away the most useful thing the tyres have to say.
    raspFront: FRONT_TYRE_LEVEL * RASP_MAX_FRONT * lateralF * gate * (1 - RASP_DUCK * squealF),
    raspRear: RASP_MAX_REAR * rear * gate * (1 - RASP_DUCK * squealR),
    squealFront: FRONT_TYRE_LEVEL * SQUEAL_MAX_FRONT * squealF * gate,
    squealRear: SQUEAL_MAX_REAR * squealR * gate,
    squealFreqFront: squealPitch(speed, input.slipF),
    squealFreqRear: squealPitch(speed, input.slipR),
    // LATERAL ONLY. The two ways of losing traction do not sound alike, and
    // driving the edge off both was why the tonal version felt wrong under
    // power: a spinning wheel does not squeal, it scrabbles. Stick-slip needs
    // the contact patch to be dragged sideways while still gripping in bursts,
    // which is a cornering phenomenon. Lock a wheel or light it up in a
    // straight line and you get a broadband roar with no note in it at all.
    squealEdgeFront: FRONT_TYRE_LEVEL > 0
      ? smoothstep(EDGE_QUIET, EDGE_LOUD, Math.abs(input.slipF))
      : 0,
    squealEdgeRear: smoothstep(EDGE_QUIET, EDGE_LOUD, Math.abs(input.slipR)),
    // ...and the longitudinal share drives roughness instead. Wheelspin gets
    // to be loud and chattery; only sliding sideways gets to pierce.
    squealRoughRear: smoothstep(0.2, 0.7, slipRatio(input.wheelVr, input.vx)),
    // MEASURED: the reference screech modulates at 3.5 Hz with a depth of 0.70
    // — a slow, deep swell, not a chatter. Every version of this so far has
    // been far too fast (17-41, then 26-64 Hz), and that busy flutter is a
    // good part of what read as "weird and oscillatey". Slowed right down.
    squealGrain: 3 + 3.5 * Math.max(squealF, squealR),
    surfaceGain,
    raspCentre,
    // Roughness rises with road speed — faster over the aggregate, busier the
    // texture. Held between 30 and 110 Hz: below that it is a wobble, above it
    // stops being roughness and starts being timbre.
    raspGrain: Math.min(110, Math.max(30, speed * 1.6)),
    surfaceCutoff,
    rumbleRate,
    ...engineLevels(input),
  }
}

/**
 * The engine, as gains and frequencies.
 *
 * Three things carry the whole design. The level follows load, so a lift is
 * audible before the revs have moved. The brightness follows load AND revs, so
 * the same engine speed sounds different on and off the throttle. And the
 * gearchange is not faked — the sim already cuts torque for 0.15 s on an
 * upshift, so muting through `shiftTimer` produces a real gap in a real place.
 */
function engineLevels(input: AudioInput): {
  engineGain: number
  engineFreq: number
  engineCutoff: number
  engineJitter: number
  engineDrive: number
} {
  const rev = Math.min(1, Math.max(0, input.rpm / Math.max(input.redlineRpm, 1)))
  const load = Math.min(1, Math.max(0, input.throttle))
  const freq = firingFrequency(Math.max(input.rpm, 0))

  // Quiet at idle, loud on load, and rising with revs — but never silent,
  // because an engine you cannot hear at all reads as a stall.
  let gain = ENGINE_MAX * (0.3 + 0.7 * load) * (0.45 + 0.55 * rev)
  // The torque cut, straight from the physics. Not a scripted blip: the sim
  // really does stop making power here, so the hole is in the right place and
  // lasts exactly as long as the gearbox takes.
  if (input.shiftTimer > 0) gain *= 0.22

  return {
    engineGain: gain,
    engineFreq: freq,
    // RELATIVE TO THE FUNDAMENTAL, not an absolute frequency — the mistake
    // that made this thin. The reference puts 85% of its energy below 6.3x its
    // own firing frequency, so the right cutoff is a multiple of f0, and it
    // then opens naturally as the engine revs instead of being a fixed 5.2 kHz
    // window with almost nothing in the top four fifths of it.
    //
    // At a 1200 rpm idle off the throttle that is ~240 Hz; at the 8200 rpm
    // redline flat out, ~2.9 kHz.
    // Slightly wider than the reference's 6.3x, because the saturation below
    // generates its grit in the low orders and filtering at exactly the
    // measured point would shave off the harmonics that carry the growl.
    engineCutoff: Math.min(freq * (5 + 4 * load), 3600),
    // 0.35%, down hard from 1.8%. That was audible as VIBRATO — a smooth
    // sinusoidal wobble on the pitch, which is the most recognisably
    // synthesised thing a sound can do. Cycle-to-cycle variation in a real
    // engine is small and irregular, not a 5.7 Hz warble at nearly 2%.
    engineJitter: freq * 0.0035,
    // Driven much harder: 1.5 idling, 7 flat out.
    //
    // This is where guttural comes from, given the sound has to stay low. A
    // steep harmonic profile through a low filter is smooth and hollow —
    // correct in its spectral balance and lifeless. Saturation fills the
    // low-order harmonics in with intermodulation, which is density rather
    // than brightness, and density at low frequency is exactly what "growl"
    // means. It is also what a real exhaust does.
    engineDrive: 0.22 + 0.78 * load,
  }
}

/**
 * Loudness of a barrier hit, from the impulse the physics actually reported.
 *
 * Square-rooted and capped: the difference between a brush and a shunt should
 * be audible, but a 30 kN·s shunt must not be six times the level of a 5 kN·s
 * one — it should be *a bit* louder and a lot heavier, which is the filter's
 * job rather than the gain's.
 */
export function impactGain(impulse: number): number {
  if (impulse <= 0) return 0
  return Math.min(0.55, 0.55 * Math.sqrt(impulse / 26000))
}
