/**
 * Vehicle parameters and the named handling presets.
 *
 * A direct port of the ``CarParams`` dataclass and the preset factories in
 * ``racing/car.py``. Values are not re-tuned here — the whole point of the port
 * is that the browser drives the same car the Python sim does, and the test
 * suite asserts these against the parameters exported from Python.
 *
 * Field names are camelCase where Python has snake_case; nothing else moves.
 */

const deg = (d: number): number => (d * Math.PI) / 180.0

export interface CarParams {
  mass: number
  inertiaZ: number
  /** m, CG to front axle (larger -> more static load on the rear) */
  lf: number
  /** m, CG to rear axle */
  lr: number
  /** m, CG height — drives weight transfer */
  hCg: number
  width: number
  /** peak tyre-road friction at the reference load */
  mu: number
  /** grip drop per unit normalised load change; 0 disables load sensitivity */
  muLoadSens: number
  fzRefScale: number
  /** multiplies rear-axle grip — the rear tyres are wider */
  rearGripBias: number

  /**
   * Scales the whole engine torque curve. The curve is the shape of a
   * combustion engine's delivery and is shared by every car; this is how much
   * engine is bolted to a given chassis. 1.0 = the ~462 kW baseline.
   */
  torqueScale: number
  /** N, used only for braking/reverse scaling */
  maxEngineForce: number
  gearRatios: readonly number[]
  finalDrive: number
  idleRpm: number
  redlineRpm: number
  shiftUpRpm: number
  shiftDownRpm: number
  /** s of torque cut during a gearchange */
  shiftTime: number
  /**
   * The auto box will not drop into FIRST above this road speed (m/s).
   *
   * Purely rpm-based downshifting cannot express this. 2->1 fires when the revs
   * in 2nd fall past `shiftDownRpm`, and on the f1 car that is 70 km/h — first
   * gear picked up at 70 km/h, with its torque multiplication, is a guaranteed
   * spin the moment the throttle is touched. The reason to stay out of first is
   * not the engine speed, it is the gear, so the rule has to be about the gear.
   */
  firstGearSpeed: number

  wheelRadius: number
  wheelInertia: number
  /** m/s, floor on road speed in the slip-ratio denominator */
  slipVxFloor: number
  maxBrakeForce: number
  /** fraction of brake force to the front axle */
  brakeBias: number

  tractionControl: boolean
  tcSlip: number
  tcFullSpeed: number
  tcOffSpeed: number
  /**
   * The speed taper suits a launch but leaves SECOND unprotected. By 50 km/h it
   * has already opened the ceiling to 0.49, and second is short enough to reach
   * it — so a corner exit spins even though traction control is on. The taper
   * asks the wrong question: what makes second spin is the torque multiplication
   * of the gear, not the road speed.
   *
   * So gears at or below `tcGearMax` get a flat ceiling the taper cannot raise.
   * Real F1 traction control ran per-gear maps (pre-2008) for exactly this.
   * -1 disables it, which is the default: only presets that opt in change.
   */
  tcGearSlip: number
  /** 0-based highest gear TC clamps flat; 1 == second. -1 disables. */
  tcGearMax: number

  absOn: boolean
  absSlip: number
  absGain: number
  absFloor: number

  /**
   * Drive weight transfer from the force the tyres can actually deliver rather
   * than the force commanded. Off is the legacy behaviour, in which a full brake
   * command at low speed unloads the rear as if the car were pulling a
   * deceleration it cannot reach — which is what made a mid-corner brake stab a
   * cheat code. See the long note in racing/car.py.
   */
  trueLoadTransfer: boolean

  dragCoef: number
  downforceCoef: number
  aeroRearBias: number
  rollingResistance: number

  maxSteer: number
  steerRateLo: number
  steerRateHi: number
  highSpeedSteer: number
  steerSpeedRef: number
  /** use total road speed for steering assistance instead of longitudinal vx */
  steerUsesRoadSpeed: boolean
  /** m, tyre slip-angle relaxation length */
  relaxLen: number

  /** Visual only: how the hood cam pitches under braking and power. */
  divePitch: number
  squatPitch: number
  pitchSmooth: number
}

/** The ``CarParams`` dataclass defaults — the ``nimble`` car. */
export function defaultParams(): CarParams {
  return {
    mass: 1000.0,
    inertiaZ: 1650.0,
    lf: 1.7,
    lr: 1.55,
    hCg: 0.32,
    width: 1.9,
    mu: 1.7,
    muLoadSens: 0.0,
    fzRefScale: 1.0,
    rearGripBias: 1.25,

    torqueScale: 1.0,
    maxEngineForce: 18000.0,
    gearRatios: [3.44, 2.56, 1.97, 1.53, 1.19, 0.94],
    finalDrive: 3.2,
    idleRpm: 1200.0,
    redlineRpm: 8200.0,
    shiftUpRpm: 7800.0,
    // 3200 was far too low: a gear was entered at 7800 rpm and only left at
    // 3200, a 2.4x hysteresis window that survived the old wide ratios and
    // became absurd with close ones. Braking from 250 the car held SEVENTH all
    // the way down to 106 km/h — the whole braking zone in one gear at 3100
    // rpm, off the power for the exit.
    //
    // 5200 is the highest value that cannot hunt. The bound is the widest ratio
    // step in any preset (nimble's 1.344): downshift there and the engine lands
    // at 5200 x 1.344 = 6988, which must stay under shiftUpRpm. 6000 lands at
    // 8062 and hunts; 5200 leaves 800 rpm of margin.
    //
    // But the ceiling is not the right choice. At 5200 the box holds SECOND all
    // the way to 90 km/h — 5862 rpm — and a corner exit there peaks at 0.17 slip
    // ratio. 4600 takes third instead: 0.10 slip, and marginally quicker with it
    // (187 vs 186 km/h three seconds later), because the spin was costing more
    // than the shorter gear was giving. Exits at 50, 70 and 110 km/h are
    // unchanged, so this buys calm at 90 for nothing.
    //
    // Do not reach for 3800 as "calmer still": it lands within a few rpm of the
    // threshold in third and flickers back to second. 3400 is stable but drops
    // to sixth by 110 km/h and gives up 16 km/h over three seconds.
    shiftDownRpm: 4600.0,
    shiftTime: 0.15,
    // ~30 km/h, roughly where second finally starts to lug.
    firstGearSpeed: 8.5,

    wheelRadius: 0.33,
    wheelInertia: 2.4,
    slipVxFloor: 2.5,
    maxBrakeForce: 32000.0,
    brakeBias: 0.55,

    tractionControl: true,
    tcSlip: 0.12,
    tcFullSpeed: 8.0,
    tcOffSpeed: 22.0,
    tcGearSlip: 0.14,
    tcGearMax: -1,

    absOn: false,
    absSlip: deg(2.0),
    absGain: 30.0,
    absFloor: 0.05,

    trueLoadTransfer: false,

    dragCoef: 1.05,
    downforceCoef: 2.6,
    aeroRearBias: 0.5,
    rollingResistance: 120.0,

    // General-purpose/generated-track lock. The released circuit setups narrow
    // this to F1 geometry without invalidating archived RL demonstrations.
    maxSteer: deg(30.0),
    steerRateLo: deg(300.0),
    steerRateHi: deg(110.0),
    highSpeedSteer: 0.36,
    steerSpeedRef: 55.0,
    steerUsesRoadSpeed: false,
    relaxLen: 0.55,

    divePitch: deg(1.3),
    squatPitch: deg(0.6),
    pitchSmooth: 0.28,
  }
}

export const wheelbase = (p: CarParams): number => p.lf + p.lr
/** Body length — for drawing and the hitbox only. */
export const carLength = (p: CarParams): number => wheelbase(p) + 0.9

/**
 * Traction control positions on the wheel — the slip ratio each one allows.
 *
 * Index 0 is OFF and has no ceiling at all; every other index is a flat ceiling
 * applied in every gear, which replaces both the speed taper and the per-gear
 * cap while the rotary is driving TC. One number instead of three because a
 * driver turning a knob mid-corner needs "more" and "less", not a model.
 *
 * The ladder is hung off the grip peak (~0.16, position 3): above it you are
 * trading drive for rotation, below it you are trading rotation for drive.
 * Position 4 is 0.14, which is what the low gears were tuned to, so the default
 * position reproduces the car as it drives with no rotary at all.
 */
export const TC_LEVELS: readonly number[] = [0, 0.3, 0.22, 0.18, 0.14, 0.1]

/** Highest selectable TC position. */
export const TC_LEVEL_MAX = TC_LEVELS.length - 1

/** Where the rotary sits before anyone turns it: the tuned low-gear ceiling. */
export const TC_LEVEL_DEFAULT = 4

export type PresetName =
  | 'f1' | 'legacy' | 'classic' | 'nimble' | 'poise' | 'boat' | 'un' | 'ov' | 'test'

/**
 * The cars the menu offers, and the names they wear.
 *
 * A deliberately short list. `poise`, `boat`, `un`, `ov` and `test` still exist
 * in `PRESETS` below — they are the setup experiments the Python side drives
 * through `play.py --handling`, and the parity fixture asserts every one of
 * them — but they are chassis experiments rather than cars anyone picks, so the
 * menu no longer offers them.
 *
 * The keys are not the labels, and deliberately so. Boards are keyed by the
 * preset string (`keyOf` in storage/records.ts), so a key that moves takes every
 * stored lap time with it. Labels are free to change; keys are not.
 *
 * `f1` is off the menu — it was the Experimental build and nobody is going to
 * finish it. It stays in `PRESETS` because the parity fixtures and the barrier
 * cases are generated on it, so the key is still load-bearing; it is simply not
 * a car anyone can pick.
 *
 * The two that are left say what they are. `legacy` is the seven-speed with the
 * new gearbox, per-gear traction control and the 4600 rpm downshift — still
 * being tuned, hence F1-Test. `classic` is the pre-gearbox tune, pinned and not
 * moving, hence Stable.
 */
export type MenuPresetName = Extract<PresetName, 'legacy' | 'classic'>

/** Presets in the order the car-select menu should offer them. */
export const PRESET_ORDER: readonly MenuPresetName[] = ['legacy', 'classic']

/**
 * No blurb field, deliberately. The car rows used to carry a line of copy each
 * ("Rewards real technique. Big mechanical grip, huge brakes.") above a set of
 * stat bars; the spec table that replaced the bars says all of it in numbers a
 * driver can compare, and the sentence was left saying it again in adjectives.
 */
export interface PresetInfo {
  readonly name: MenuPresetName
  readonly label: string
}

export const PRESET_INFO: Record<MenuPresetName, PresetInfo> = {
  legacy: { name: 'legacy', label: 'Low drag' },
  classic: { name: 'classic', label: 'High downforce' },
}

/**
 * The menu name of a preset, or the raw key for one the menu does not list —
 * `play.py --handling ov` is a legitimate way to be driving a car with no card.
 */
export function presetLabel(name: PresetName): string {
  return PRESET_INFO[name as MenuPresetName]?.label ?? name
}

/**
 * The gearbox both setups run. Homologated, in the F1 sense: one ladder for the
 * car rather than one per setup.
 *
 * Teams did once cut ratios per circuit — tall for Monza, short for Monaco —
 * but F1 has homologated them since 2014: nominate a set for the season and
 * change the wing instead. It is also not worth doing here. The two setups top
 * out eleven km/h apart, so per-setup ratios would be a four percent rescale
 * nobody could feel, bought with a second ladder to keep in step with this one.
 */
const GP_RATIOS: readonly number[] = [3.03, 2.53, 2.11, 1.75, 1.46, 1.21, 1.01]

const PRESETS: Record<PresetName, () => CarParams> = {
  nimble: () => defaultParams(),

  boat: () => ({
    ...defaultParams(),
    rearGripBias: 1.35,
    downforceCoef: 1.9,
    aeroRearBias: 0.56,
    tractionControl: false,
    divePitch: deg(2.6),
    squatPitch: deg(1.2),
    pitchSmooth: 0.14,
  }),

  // A fair understeer/oversteer pair: the same car as nimble with only the
  // race-engineer setup knobs moved, symmetrically about the baseline. A
  // head-to-head is decided by setup, not a hidden hardware advantage.
  un: () => ({
    ...defaultParams(),
    lf: 1.55,
    lr: 1.7,
    aeroRearBias: 0.56,
    brakeBias: 0.62,
  }),

  ov: () => ({
    ...defaultParams(),
    lf: 1.85,
    lr: 1.4,
    aeroRearBias: 0.48,
    brakeBias: 0.48,
  }),

  // Tuned so the technique an F1 driver actually uses is the fast one: honest
  // load transfer plus a low CG kill the free rotation a mid-corner brake stab
  // used to buy, and grip moves from the fast corners to the slow ones.
  // Built to the real longitudinal spec. `legacy` launched HARDER than a real
  // F1 car but ran out of breath above 150 km/h — 6.2 s to 200 against a real
  // 4.9, and it never reached 300 at all — because 462 kW in 1000 kg is half
  // the power-to-weight of the real thing. Regulation mass, ~740 kW, eight
  // gears, and drag trimmed to put the terminal speed where it belongs.
  // Measured with the playable pedal ramp: 0-100 2.7 s, 0-200 5.3 s,
  // 0-300 10.8 s, 328 km/h. The calmer launch gives up the former drag-strip
  // numbers instead of reaching them through near-total driven-wheel slip.
  f1: () => ({
    ...defaultParams(),
    mass: 800.0,
    // Preserve the baseline yaw-inertia-per-kilo. The former 1250 made the
    // chassis rotate faster as well as accelerate faster.
    inertiaZ: 1320.0,
    hCg: 0.26,
    // A strong slick without the previous 2.26 g static axle-summed budget;
    // load sensitivity keeps aero grip from growing linearly without limit.
    mu: 1.75,
    muLoadSens: 0.12,
    downforceCoef: 2.6,
    aeroRearBias: 0.52,
    dragCoef: 0.95,
    torqueScale: 1.6,
    gearRatios: [2.89, 2.46, 2.10, 1.78, 1.52, 1.29, 1.10, 0.94],
    maxBrakeForce: 42000.0,
    brakeBias: 0.6,
    trueLoadTransfer: true,
    // Stay near the tyre's slip peak through the launch, then progressively
    // release once gearing and downforce have given the rear axle some margin.
    tcSlip: 0.10,
    tcFullSpeed: 20.0,
    tcOffSpeed: 180.0,
    maxSteer: deg(30.0),
    steerRateLo: deg(220.0),
    steerRateHi: deg(90.0),
    highSpeedSteer: 0.30,
    divePitch: deg(1.6),
    squatPitch: deg(0.5),
    pitchSmooth: 0.22,
  }),

  // The grand-prix tune the game is built around.
  //
  // SEVEN speeds, evenly spaced, shifting at 100 / 120 / 144 / 173 / 208 / 251
  // / 300 km/h. Every one of them is used. The old six shifted into 5th at 255
  // and was drag-limited at 270, so 6th was a lugging overdrive entered for the
  // last fifteen km/h — five gears did all the work, in huge steps.
  //
  // Eight was tried first and is the wrong answer, for a reason worth
  // recording: N evenly-spaced gears over a fixed speed range get shorter as N
  // rises, and a short second gear is a second gear that spins its wheels.
  // Measured flat out in 2nd from a 60 km/h corner exit —
  //
  //     original six-speed (2nd = 2.56)   peak slip 0.48
  //     eight-speed        (2nd = 2.86)   peak slip 1.00
  //     this seven-speed   (2nd = 2.53)   peak slip 0.42
  //
  // — and the eight-speed was SLOWER for it, 114 km/h three seconds after the
  // exit against 126, because the extra multiplication went into smoke rather
  // than drive. Seven is cleaner and quicker: 0-250 in 9.48 s against 9.55.
  //
  // Note this is NOT F1 gearing, which spreads eight ratios over about 120-330.
  // This is a GT/prototype ladder, which suits 1000 kg and 462 kW.
  /**
   * The high-downforce setup: slower down the straight, faster round the bend.
   *
   * The same car as `legacy` with a different aero and gearing sheet — a Monaco
   * wing against a Monza one, which is the honest way to offer two of the same
   * machine. Measured through a 60 m corner: 190 km/h against the low-drag
   * car's 181, for a top speed of 272 against 290. Nine km/h of corner for
   * eighteen of straight — small enough that the circuit decides which is right,
   * which is what makes it a setup rather than a difficulty.
   *
   * It was 2.8 first, worth 215 km/h through that corner: half again the
   * low-drag car's cornering speed. That did not read as a setup so much as an
   * easier game, because corners stopped being the part you had to get right. A
   * setup should move WHERE lap time comes from, not remove one of the places
   * it is won.
   *
   * Mass, power, grip, brakes and every geometry figure are `legacy`'s, and
   * that is the point rather than an omission: this is a setup sheet, not a
   * second vehicle. It replaces an earlier `classic` — the pre-gearbox build,
   * kept around to be driven back to back while that work happened. Useful
   * then, and not a car to offer anyone, because it was not different from the
   * new one so much as worse than it: same chassis, longer shifts, lazier
   * downshifts, and 20 km/h slower with nothing given back.
   */
  classic: () => ({
    ...defaultParams(),
    gearRatios: GP_RATIOS,
    shiftTime: 0.06,
    tcGearMax: 1,
    tcGearSlip: 0.14,
    // The trade itself: downforce buys cornering grip, and the drag that comes
    // with it takes the top end away.
    downforceCoef: 2.05,
    dragCoef: 1.05,
    hCg: 0.26,
    mu: 2.0,
    maxBrakeForce: 42000.0,
    brakeBias: 0.6,
    trueLoadTransfer: true,
    maxSteer: deg(22.0),
    steerRateLo: deg(160.0),
    highSpeedSteer: 10.8 / 22.0,
    steerUsesRoadSpeed: true,
    divePitch: deg(1.6),
    squatPitch: deg(0.5),
    pitchSmooth: 0.22,
  }),

  legacy: () => ({
    ...defaultParams(),
    gearRatios: GP_RATIOS,
    // Trimmed from 1.05 so the top of the gearbox is reachable. Eight ratios
    // under a 271 km/h ceiling left 8th a six km/h band — the lugging overdrive
    // straight back. At 0.86 the car runs to 290 and 8th gets 24 km/h to work
    // in. Downforce is untouched at 1.8: a cleaner car, not a lower-downforce
    // one, which is how you buy top speed without giving back the cornering.
    dragCoef: 0.86,
    // A seamless shift, and it is what makes eight gears worth having.
    // Measured: eight ratios with the old 0.15 s cut reach 250 km/h in 11.73 s
    // against the six-speed's 11.33, because two extra torque cuts cost more
    // than the tighter rpm band gains. At 0.06 s the same eight do it in
    // 10.93 s, holding a mean of 7441 rpm against 6528 — living at the power
    // peak instead of falling off it twice a lap.
    shiftTime: 0.06,
    // Per-gear traction control in first and second. The speed taper alone had
    // already released to a 0.49 ceiling by 50 km/h, so a second-gear exit
    // peaked at 0.47 slip and a standing start at a full 1.00. Both are past
    // the grip peak (~0.16), which is why holding 0.14 costs so little: 50 km/h
    // exit 172.3 -> 170.0 km/h after three seconds, launch 190.5 -> 186.8 after
    // five. Two km/h for a car that no longer needs to be pointed dead straight
    // before the throttle.
    tcGearMax: 1,
    tcGearSlip: 0.14,
    hCg: 0.26,
    mu: 2.0,
    downforceCoef: 1.8,
    maxBrakeForce: 42000.0,
    brakeBias: 0.6,
    trueLoadTransfer: true,
    maxSteer: deg(22.0),
    steerRateLo: deg(160.0),
    highSpeedSteer: 10.8 / 22.0,
    steerUsesRoadSpeed: true,
    divePitch: deg(1.6),
    squatPitch: deg(0.5),
    pitchSmooth: 0.22,
  }),

  // The f1 platform without the f1 grip: tyres, aero and CG height stay at
  // nimble's, so the grip at every speed is identical and any difference you
  // feel is the physics being honest rather than extra grip flattering it.
  poise: () => ({
    ...defaultParams(),
    maxBrakeForce: 52000.0,
    trueLoadTransfer: true,
  }),

  test: () => ({
    ...defaultParams(),
    lf: 1.85,
    lr: 1.4,
    aeroRearBias: 0.49,
    brakeBias: 0.59,
  }),
}

export function handlingPreset(name: PresetName): CarParams {
  const make = PRESETS[name]
  if (!make) throw new Error(`unknown handling preset ${name}`)
  return make()
}

/**
 * Wind every driver aid up to beginner settings, in place.
 *
 * Nothing here is invented — these are the aids the car already models, turned
 * up. Grass grip is deliberately absent: that is a property of the surface, not
 * the vehicle, and lives on the sim rather than here.
 */
export function applyEasyAids(p: CarParams): CarParams {
  p.tractionControl = true
  p.tcSlip = 0.07
  p.tcFullSpeed = 12.0
  p.tcOffSpeed = 400.0
  p.absOn = true
  p.absSlip = deg(1.2)
  p.absGain = 45.0
  // More rear grip than front means the front washes out first. Running wide is
  // recoverable by lifting; a snap of oversteer at speed is not.
  p.rearGripBias = 1.45
  return p
}
