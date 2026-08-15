/**
 * The Web Audio graph. Thin on purpose — the decisions live in `mix.ts`.
 *
 * Everything is filtered noise. There is not a single oscillator in here, and
 * that is deliberate: a tyre is broadband, and the moment you reach for a tone
 * to make a squeal you have built the exact sound that makes people turn the
 * audio off. Resonance is kept low (`Q` below 1.5) for the same reason.
 *
 * **Nothing is ever set directly.** Every gain and cutoff goes through
 * `setTargetAtTime`, with a faster time constant rising than falling. That
 * asymmetry is what stops a slide chattering as the tyre crosses in and out of
 * the knee: it arrives promptly and leaves slowly, like a real one.
 *
 * The context starts suspended — browsers require a gesture — so `resume()` has
 * to be called from a click. `Drive` is that click.
 */
import {
  impactGain, levelsFor, engineWaveProfile,
  ENGINE_LAYER_SUM, ENGINE_MUTED, ENGINE_RUMBLE, ENGINE_TONAL_SHARE,
  SQUEAL_CLUSTER, SQUEAL_UPPER, type AudioInput, type AudioLevels,
} from './mix'

/** Rise and fall time constants, seconds. Falling is slower on purpose. */
const TAU_UP = 0.06
const TAU_DOWN = 0.22
/** Cutoffs move slowly whichever way: a sweeping filter is very audible. */
const TAU_FILTER = 0.12

/** Seconds of noise generated once and looped by every layer. */
const NOISE_SECONDS = 3

export class Sound {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private layers: {
    wind: Layer
    raspFront: Layer
    raspRear: Layer
    surface: Layer
  } | null = null
  private squeals: { front: Squeal; rear: Squeal } | null = null
  private engine: Engine | null = null
  /** Kerb rattle: modulates the surface layer rather than adding a sound. */
  private rumble: OscillatorNode | null = null
  private rumbleDepth: GainNode | null = null
  private noise: AudioBuffer | null = null
  private level = 0.7
  private muted = false

  /**
   * Build the graph. Safe to call repeatedly; only the first does anything.
   *
   * Called from a user gesture, because an AudioContext created without one is
   * born suspended and silently stays that way.
   */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume()
      return
    }
    const Ctor = window.AudioContext ?? (window as unknown as {
      webkitAudioContext?: typeof AudioContext
    }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    this.ctx = ctx
    this.noise = makeNoise(ctx)

    // Master chain: gain into a limiter. The limiter is not for loudness, it
    // is so that a wall hit landing on top of a slide on top of a kerb cannot
    // add up to a clip.
    const master = ctx.createGain()
    master.gain.value = this.muted ? 0 : this.level
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -8
    limiter.knee.value = 6
    limiter.ratio.value = 12
    limiter.attack.value = 0.004
    limiter.release.value = 0.18
    master.connect(limiter).connect(ctx.destination)
    this.master = master

    this.layers = {
      wind: makeLayer(ctx, this.noise, master, 'lowpass', 0.7, 1.0),
      // The two axles are spread slightly left and right of centre. Not for
      // realism — so that front scrub and rear scrub can be told apart when
      // both are happening, which is exactly when it matters.
      // Bandpass, and grainy. Both rasps used to be lowpassed pink noise at
      // roughly the wind's own cutoff — the same sound three times over.
      raspFront: makeLayer(ctx, this.noise, master, 'bandpass', 1.6, 1.0, -0.25, true),
      raspRear: makeLayer(ctx, this.noise, master, 'bandpass', 1.6, 1.0, 0.25, true),
      surface: makeLayer(ctx, this.noise, master, 'lowpass', 0.8, 1.0),
    }
    this.squeals = {
      front: makeSqueal(ctx, this.noise, master, -0.25),
      // Centred while it is the only tyre making a sound. The pan existed to
      // separate two squeals; with one, offsetting it just makes the car sound
      // lopsided.
      rear: makeSqueal(ctx, this.noise, master, 0),
    }
    this.engine = makeEngine(ctx, this.noise, master)

    // The rumble oscillator runs continuously at whatever rate the kerb wants
    // and is scaled to nothing when off one, so there is no start/stop click.
    const rumble = ctx.createOscillator()
    rumble.type = 'sine'
    rumble.frequency.value = 12
    const depth = ctx.createGain()
    depth.gain.value = 0
    rumble.connect(depth).connect(this.layers.surface.gain.gain)
    rumble.start()
    this.rumble = rumble
    this.rumbleDepth = depth
  }

  /** 0..1, or muted. Applied immediately but smoothly. */
  setLevel(level: number, muted: boolean): void {
    this.level = Math.min(1, Math.max(0, level))
    this.muted = muted
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : this.level, this.ctx.currentTime, 0.05)
    }
  }

  /** Silence everything without tearing the graph down — for the menu. */
  idle(): void {
    if (!this.ctx || !this.layers) return
    const t = this.ctx.currentTime
    for (const layer of Object.values(this.layers)) {
      layer.gain.gain.setTargetAtTime(0, t, TAU_DOWN)
      layer.grainDepth?.gain.setTargetAtTime(0, t, TAU_DOWN)
    }
    if (this.squeals) {
      for (const s of Object.values(this.squeals)) {
        s.gain.gain.setTargetAtTime(0, t, TAU_DOWN)
        s.grainDepth.gain.setTargetAtTime(0, t, TAU_DOWN)
        s.grain2Depth.gain.setTargetAtTime(0, t, TAU_DOWN)
        s.trim4.gain.setTargetAtTime(0, t, TAU_DOWN)
      }
    }
    if (this.rumbleDepth) this.rumbleDepth.gain.setTargetAtTime(0, t, TAU_DOWN)
    if (this.engine) this.engine.level.gain.setTargetAtTime(0, t, TAU_DOWN)
  }

  update(input: AudioInput): void {
    if (!this.ctx || !this.layers) return
    const t = this.ctx.currentTime
    const l = levelsFor(input)

    ramp(this.layers.wind.gain.gain, l.windGain, t)
    ramp(this.layers.raspFront.gain.gain, l.raspFront, t)
    ramp(this.layers.raspRear.gain.gain, l.raspRear, t)
    ramp(this.layers.surface.gain.gain, l.surfaceGain, t)

    this.layers.wind.filter.frequency.setTargetAtTime(l.windCutoff, t, TAU_FILTER)
    this.layers.raspFront.filter.frequency.setTargetAtTime(l.raspCentre, t, TAU_FILTER)
    this.layers.raspRear.filter.frequency.setTargetAtTime(l.raspCentre * 0.85, t, TAU_FILTER)
    this.layers.surface.filter.frequency.setTargetAtTime(l.surfaceCutoff, t, TAU_FILTER)

    // The two axles are given slightly different grain rates so they read as
    // two tyres rather than one wide one.
    grainOn(this.layers.raspFront, l.raspGrain, l.raspFront, t)
    grainOn(this.layers.raspRear, l.raspGrain * 0.82, l.raspRear, t)

    if (this.squeals) {
      updateSqueal(
        this.squeals.front, l.squealFront, l.squealFreqFront, l.squealEdgeFront,
        0, l.squealGrain, t,
      )
      updateSqueal(
        this.squeals.rear, l.squealRear, l.squealFreqRear, l.squealEdgeRear,
        l.squealRoughRear, l.squealGrain * 0.87, t,
      )
    }

    if (this.engine) updateEngine(this.engine, l, t)

    if (this.rumble && this.rumbleDepth) {
      if (l.rumbleRate > 0) {
        this.rumble.frequency.setTargetAtTime(l.rumbleRate, t, 0.08)
        // Modulating to 70% depth, not 100%: a kerb that chops the sound to
        // silence between ribs reads as a stutter, not a rattle.
        this.rumbleDepth.gain.setTargetAtTime(l.surfaceGain * 0.7, t, TAU_UP)
      } else {
        this.rumbleDepth.gain.setTargetAtTime(0, t, TAU_DOWN)
      }
    }
  }

  /** A barrier hit. One short, dull thump scaled by the reported impulse. */
  impact(impulse: number): void {
    const gain = impactGain(impulse)
    if (!this.ctx || !this.master || !this.noise || gain <= 0) return
    const ctx = this.ctx
    const t = ctx.currentTime

    const src = ctx.createBufferSource()
    src.buffer = this.noise
    src.loop = false
    // Start somewhere random in the buffer so repeated hits are not identical.
    const offset = Math.random() * (NOISE_SECONDS - 0.4)

    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    // A big hit is DARKER, not louder — that is what makes it read as heavy.
    filter.frequency.value = 900 - 380 * (gain / 0.55)
    filter.Q.value = 0.7

    const env = ctx.createGain()
    env.gain.setValueAtTime(0, t)
    env.gain.linearRampToValueAtTime(gain, t + 0.006)
    env.gain.exponentialRampToValueAtTime(0.0008, t + 0.34)

    src.connect(filter).connect(env).connect(this.master)
    src.start(t, offset, 0.4)
    src.stop(t + 0.4)
    src.onended = () => {
      src.disconnect()
      filter.disconnect()
      env.disconnect()
    }
  }

  dispose(): void {
    this.rumble?.stop()
    if (this.engine) {
      for (const o of [
        this.engine.osc, this.engine.osc2, this.engine.jitter, this.engine.jitter2,
      ]) o.stop()
    }
    this.engine = null
    if (this.layers) for (const l of Object.values(this.layers)) l.grain?.stop()
    if (this.squeals) {
      for (const s of Object.values(this.squeals)) {
        s.grain.stop()
        s.grain2.stop()
      }
    }
    void this.ctx?.close()
    this.ctx = null
    this.layers = null
    this.squeals = null
    this.rumble = null
    this.rumbleDepth = null
  }
}

interface Layer {
  filter: BiquadFilterNode
  gain: GainNode
  /** Present on layers given a texture — see `raspGrain`. */
  grain?: OscillatorNode | undefined
  grainDepth?: GainNode | undefined
}

interface Squeal {
  /** Fundamental, second and third partials — see the note in `makeSqueal`. */
  f1: BiquadFilterNode
  f2: BiquadFilterNode
  f3: BiquadFilterNode
  /** Trims on the upper two, which is where the edge lives. */
  trim2: GainNode
  trim3: GainNode
  gain: GainNode
  /** Amplitude chatter, the audible stick-slip cycle. Two, deliberately. */
  grain: OscillatorNode
  grainDepth: GainNode
  grain2: OscillatorNode
  grain2Depth: GainNode
  /** The separate upper partial at 2.17x, which carries the edge. */
  f4: BiquadFilterNode
  trim4: GainNode
}

/**
 * The squeal's own time constants, far faster than everything else.
 *
 * A tyre lets go in milliseconds and hooks up again just as fast. The shared
 * 60/220 ms smoothing is right for wind and surface, which really do change
 * gradually, and it was what made the squeal audibly ramp up and down.
 */
const SQUEAL_TAU_UP = 0.045
const SQUEAL_TAU_DOWN = 0.12

/**
 * The upper partial is not allowed above here, Hz.
 *
 * MEASURED: the reference rolls off 85% of its energy by 2865 Hz, so 3000 is
 * about where the real thing stops rather than an arbitrary safety limit.
 */
const EDGE_CEILING = 3000

/**
 * The pitched half of a sliding tyre.
 *
 * Noise through HIGH-Q bandpasses, not oscillators. That distinction is the
 * whole thing: an oscillator gives you a siren, and plain filtered noise gives
 * you a broom. A resonant filter excited by noise rings at a pitch while
 * staying noisy, which is what stick-slip actually is.
 *
 * Three partials at f, 2f and 3f — a HARMONIC series, which the first version
 * was not. It used two resonances at a ratio of 1.47 to avoid sounding like a
 * whistle, and it worked, but it also meant the sound had no harmonic
 * structure and so never cut through. Stick-slip is periodic; a real squeal is
 * a harmonic series, and the upper partials landing between 1 and 2.4 kHz are
 * exactly where the ear is getting sensitive. That is where "piercing" comes
 * from, and it matters that it comes from harmonics rather than from a bright
 * hiss: harmonics read as a pitched sound cutting through, broadband treble
 * just reads as fatigue.
 *
 * The upper two are trimmed by `squealEdge`, so the edge is something the car
 * earns by actually sliding rather than a permanent property of the tyre.
 */
function makeSqueal(ctx: AudioContext, noise: AudioBuffer, dest: AudioNode, pan: number): Squeal {
  const src = ctx.createBufferSource()
  src.buffer = noise
  src.loop = true
  src.playbackRate.value = 0.9 + Math.random() * 0.2

  // A CLUSTER at 1.00 / 1.12 / 1.24, plus a separate partial at 2.17 — the
  // ratios measured off the reference, not a harmonic series. High Q, so each
  // rings rather than merely filtering; several close resonances excited by
  // the same noise beat against each other and produce the dense, live texture
  // a single peak cannot.
  const f1 = ctx.createBiquadFilter()
  f1.type = 'bandpass'
  f1.Q.value = 26
  f1.frequency.value = 1200

  const f2 = ctx.createBiquadFilter()
  f2.type = 'bandpass'
  f2.Q.value = 24
  f2.frequency.value = 1200 * SQUEAL_CLUSTER[1]

  const f3 = ctx.createBiquadFilter()
  f3.type = 'bandpass'
  f3.Q.value = 22
  f3.frequency.value = 1200 * SQUEAL_CLUSTER[2]

  const f4 = ctx.createBiquadFilter()
  f4.type = 'bandpass'
  f4.Q.value = 11
  f4.frequency.value = 1200 * SQUEAL_UPPER

  // The cluster members sit close in level — they are modes of one body, not a
  // series — while the upper partial is trimmed and rides on `edge`.
  const trim2 = ctx.createGain()
  trim2.gain.value = 0
  const trim3 = ctx.createGain()
  trim3.gain.value = 0
  const trim4 = ctx.createGain()
  trim4.gain.value = 0

  const gain = ctx.createGain()
  gain.gain.value = 0

  // TWO chatter oscillators at incommensurate rates, not one.
  //
  // A single LFO gives a regular warble, which is audibly a modulation. Two
  // that never line up beat against each other and produce something that
  // breaks up irregularly — which is what stick-slip does, and what makes the
  // difference between "a tone being wobbled" and "a tyre chattering".
  const grain = ctx.createOscillator()
  grain.type = 'triangle'
  grain.frequency.value = 30
  const grainDepth = ctx.createGain()
  grainDepth.gain.value = 0
  grain.connect(grainDepth).connect(gain.gain)
  grain.start()

  const grain2 = ctx.createOscillator()
  grain2.type = 'triangle'
  grain2.frequency.value = 30 * 1.37
  const grain2Depth = ctx.createGain()
  grain2Depth.gain.value = 0
  grain2.connect(grain2Depth).connect(gain.gain)
  grain2.start()

  // THE OSCILLATORS ARE GONE, and the measurement is why.
  //
  // The reference screech has a spectral flatness of 0.380 — decidedly noisy,
  // nowhere near a tone. The sawtooths were an attempt to fix "not piercing
  // enough" by adding tonality, when the real fault was that the whole thing
  // sat an octave and a half too low. Correct the frequency and the original
  // noise-through-resonances approach turns out to have been right; keep the
  // saws and it is a synthesiser doing an impression of a tyre.
  const panner = ctx.createStereoPanner()
  panner.pan.value = pan

  src.connect(f1).connect(gain)
  src.connect(f2).connect(trim2).connect(gain)
  src.connect(f3).connect(trim3).connect(gain)
  src.connect(f4).connect(trim4).connect(gain)
  gain.connect(panner).connect(dest)
  src.start()

  return {
    f1, f2, f3, f4, trim2, trim3, trim4, gain,
    grain, grainDepth, grain2, grain2Depth,
  }
}

function updateSqueal(
  s: Squeal, gain: number, freq: number, edge: number, rough: number,
  grainRate: number, now: number,
): void {
  // MEASURED: the reference takes 107 ms to go from 15% to 85%. Not instant —
  // the 12 ms snap was as wrong in one direction as the original 60 ms fade
  // was in the other. A screech arrives over about a tenth of a second, which
  // is quick enough to feel caused and slow enough not to click.
  s.gain.gain.setTargetAtTime(
    gain, now, gain > s.gain.gain.value ? SQUEAL_TAU_UP : SQUEAL_TAU_DOWN,
  )
  // The cluster tracks pitch together; the upper partial rides at 2.17x.
  s.f1.frequency.setTargetAtTime(freq, now, 0.03)
  s.f2.frequency.setTargetAtTime(freq * SQUEAL_CLUSTER[1], now, 0.03)
  s.f3.frequency.setTargetAtTime(freq * SQUEAL_CLUSTER[2], now, 0.03)
  s.f4.frequency.setTargetAtTime(Math.min(freq * SQUEAL_UPPER, EDGE_CEILING), now, 0.03)
  // Cluster members sit close in level — they are modes of one body, so they
  // are always all there. Only the 2.17x partial rides on the edge.
  s.trim2.gain.setTargetAtTime(0.9, now, 0.04)
  s.trim3.gain.setTargetAtTime(0.8, now, 0.04)
  s.trim4.gain.setTargetAtTime(0.5 * edge * (1 - 0.7 * rough), now, 0.04)
  s.grain.frequency.setTargetAtTime(grainRate, now, 0.05)
  s.grain2.frequency.setTargetAtTime(grainRate * 1.37, now, 0.05)
  // MEASURED: modulation depth 0.70 on the reference, so this stays deep — it
  // is the RATE that was wrong, not the amount. Wheelspin gets a little more,
  // being a wheel bouncing over the surface rather than a patch letting go.
  const depth = gain * (0.35 + 0.2 * rough)
  s.grainDepth.gain.setTargetAtTime(depth, now, SQUEAL_TAU_UP)
  s.grain2Depth.gain.setTargetAtTime(depth, now, SQUEAL_TAU_UP)

}

/**
 * One noise layer: source into a filter into a gain.
 *
 * `rate` detunes the playback so two layers reading the same buffer do not
 * correlate; identical noise in two places sums to one louder noise instead of
 * a wider one.
 */
function makeLayer(
  ctx: AudioContext, noise: AudioBuffer, dest: AudioNode,
  type: BiquadFilterType, q: number, rate: number, pan = 0, grainy = false,
): Layer {
  const src = ctx.createBufferSource()
  src.buffer = noise
  src.loop = true
  src.playbackRate.value = rate * (0.86 + Math.random() * 0.28)

  const filter = ctx.createBiquadFilter()
  filter.type = type
  filter.Q.value = q
  filter.frequency.value = 500

  const gain = ctx.createGain()
  gain.gain.value = 0

  let grain: OscillatorNode | undefined
  let grainDepth: GainNode | undefined
  if (grainy) {
    // A sawtooth, not a sine: the asymmetric shape gives a scrape rather than
    // a wobble, which is what a contact patch banging over aggregate is.
    grain = ctx.createOscillator()
    grain.type = 'sawtooth'
    grain.frequency.value = 60
    grainDepth = ctx.createGain()
    grainDepth.gain.value = 0
    grain.connect(grainDepth).connect(gain.gain)
    grain.start()
  }

  let tail: AudioNode = gain
  if (pan !== 0) {
    const panner = ctx.createStereoPanner()
    panner.pan.value = pan
    gain.connect(panner)
    tail = panner
  }
  src.connect(filter).connect(gain)
  tail.connect(dest)
  src.start()
  return { filter, gain, grain, grainDepth }
}

interface Engine {
  /** Two detuned periodic-wave oscillators — the harmonic 30%. */
  osc: OscillatorNode
  osc2: OscillatorNode
  tonal: GainNode
  /** Filtered noise — the broadband 70%. */
  noiseFilter: BiquadFilterNode
  noiseGain: GainNode
  /** Fixed formants: the exhaust and the body, which do not track revs. */
  bus: GainNode
  brightness: BiquadFilterNode
  /** Pre-gain into a fixed shaper: how hard the exhaust is driven. */
  drive: GainNode
  /**
   * The engine's actual volume, AFTER the saturator.
   *
   * It has to be here. Level set before a clipper does not control loudness at
   * all — it controls how hard the clipper works. Driving 7x into a `tanh`
   * pins the output near full scale whatever the input was, so turning the
   * engine "down" ahead of it only made it more distorted at the same volume.
   * Every attempt to quieten this failed for that reason.
   */
  level: GainNode
  /** Noise chopped once per firing event rather than hissing evenly. */
  fire: OscillatorNode
  fireDepth: GainNode
  /**
   * Cabin boom: a deep floor that does NOT rise with the engine.
   *
   * Why it sounded right at walking pace and thin at the top. At idle the wave
   * sits at 30 Hz with harmonics at 30/60/90, so everything is low; at the
   * redline it is at 205 Hz with harmonics at 205/410/615 and the entire
   * spectrum has migrated upward, leaving nothing underneath.
   *
   * A real cabin does not empty out like that, because its boom is the cavity
   * resonating — a property of the shell, not of engine speed. So this is a
   * fixed low band that stays put while the engine climbs through it.
   */
  rumbleFilter: BiquadFilterNode
  rumbleGain: GainNode
  /** Slow wander on the fundamental. */
  jitter: OscillatorNode
  jitterDepth: GainNode
  jitter2: OscillatorNode
  jitter2Depth: GainNode
}

/**
 * Soft-clip curve for the exhaust saturation.
 *
 * `tanh`, normalised so the curve still spans -1..1. Built once and never
 * changed — the AMOUNT of distortion is set by how hard the signal is driven
 * into it, not by swapping curves, because rebuilding a `WaveShaper` curve
 * every frame would be both expensive and audible as a click.
 */
function makeSoftClip(): Float32Array<ArrayBuffer> {
  const n = 2048
  const curve = new Float32Array(new ArrayBuffer(n * 4))
  const k = 3.2
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    curve[i] = Math.tanh(k * x) / Math.tanh(k)
  }
  return curve
}

/**
 * The engine.
 *
 * Built to the measurements rather than to the obvious design. The obvious
 * design is a stack of oscillators at multiples of the firing frequency, and it
 * produces the whine everyone knows: 100% tonal content whose pitch tracks a
 * pedal. The reference clip says an engine is only 30% harmonic and 70%
 * broadband, with a spectral flatness of 0.391 — much closer to filtered noise
 * than to a chord.
 *
 * So there are three parts:
 *
 * - a `PeriodicWave` carrying the measured harmonic profile, played by TWO
 *   oscillators detuned 0.4% so the tonal part is never perfectly periodic;
 * - a noise bed, bandpassed around the fourth harmonic, carrying most of the
 *   energy — this is combustion and induction turbulence, and it is what makes
 *   the sound have body instead of being a buzzer;
 * - two FIXED formants at 240 and 1150 Hz. Fixed matters: they are properties
 *   of the exhaust and the shell, so they stay put while the engine revs
 *   through them. Formants that track rpm are a synthesiser sweeping a filter,
 *   and the ear knows the difference immediately.
 */
function makeEngine(ctx: AudioContext, noise: AudioBuffer, dest: AudioNode): Engine {
  // Built at HALF the firing frequency: even harmonics are the firing
  // harmonics, odd ones are the uneven-firing half-orders that make a vee
  // engine lumpy instead of smooth. See `engineWaveProfile`.
  const profile = engineWaveProfile()
  const real = new Float32Array(profile.length + 1)
  const imag = new Float32Array(profile.length + 1)
  profile.forEach((a, i) => { imag[i + 1] = a })
  const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false })

  const osc = ctx.createOscillator()
  osc.setPeriodicWave(wave)
  osc.frequency.value = 30
  const osc2 = ctx.createOscillator()
  osc2.setPeriodicWave(wave)
  osc2.frequency.value = 30
  // 4 cents. At 11 the two beat against each other at up to ~1.2 Hz, which is
  // a slow tremolo you can count — one of the two things reading as "it
  // oscillates". Narrow enough now to thicken rather than throb.
  osc2.detune.value = 4

  const tonal = ctx.createGain()
  tonal.gain.value = 0

  const noiseSrc = ctx.createBufferSource()
  noiseSrc.buffer = noise
  noiseSrc.loop = true
  noiseSrc.playbackRate.value = 0.93
  const noiseFilter = ctx.createBiquadFilter()
  noiseFilter.type = 'bandpass'
  noiseFilter.Q.value = 0.8
  noiseFilter.frequency.value = 300
  const noiseGain = ctx.createGain()
  noiseGain.gain.value = 0

  const bus = ctx.createGain()
  bus.gain.value = 1

  // Both formants moved DOWN into the band the cabin actually has energy in.
  // The old pair sat at 240 and 1150 Hz, and 1150 is above 99% of a real
  // cabin's energy — it was emphasising a region with nothing in it.
  const boom = ctx.createBiquadFilter()
  boom.type = 'peaking'
  boom.frequency.value = 95
  boom.Q.value = 1.0
  // +4 and +3 dB, trimmed from +6 and +4: these sit AFTER the level control,
  // so a big boost there quietly puts the engine back over its own ceiling.
  boom.gain.value = 4
  const rasp = ctx.createBiquadFilter()
  rasp.type = 'peaking'
  rasp.frequency.value = 320
  rasp.Q.value = 1.3
  rasp.gain.value = 3

  const brightness = ctx.createBiquadFilter()
  brightness.type = 'lowpass'
  brightness.Q.value = 0.7
  brightness.frequency.value = 600

  // Saturation. The single biggest reason the old one sounded polite: a sum of
  // clean partials is an organ, and an exhaust is a violently nonlinear thing.
  // Driving the bus into a soft clip folds the harmonics into each other and
  // produces intermodulation, which is what reads as guttural.
  const drive = ctx.createGain()
  drive.gain.value = 1
  const shaper = ctx.createWaveShaper()
  shaper.curve = makeSoftClip()
  shaper.oversample = '2x'
  // The volume, downstream of the clipping. See the note on `level`.
  const level = ctx.createGain()
  level.gain.value = 0

  // Noise chopped once per firing event. A smooth hiss is induction noise from
  // fifty metres away; up close the broadband part arrives in slugs, one per
  // bang, and that pulsing is most of what "raw" means.
  // Triangle, not sawtooth: a saw's hard edge once per firing was audible as a
  // buzz riding on top of the note rather than as the note having texture.
  const fire = ctx.createOscillator()
  fire.type = 'triangle'
  fire.frequency.value = 60
  const fireDepth = ctx.createGain()
  fireDepth.gain.value = 0
  fire.connect(fireDepth).connect(noiseGain.gain)
  fire.start()

  // The cabin floor. Its own noise source so it stays uncorrelated with the
  // induction bed, and lowpassed hard so it is felt rather than heard.
  const rumbleSrc = ctx.createBufferSource()
  rumbleSrc.buffer = noise
  rumbleSrc.loop = true
  rumbleSrc.playbackRate.value = 0.61
  const rumbleFilter = ctx.createBiquadFilter()
  rumbleFilter.type = 'lowpass'
  rumbleFilter.frequency.value = 110
  rumbleFilter.Q.value = 1.2
  const rumbleGain = ctx.createGain()
  rumbleGain.gain.value = 0
  rumbleSrc.connect(rumbleFilter).connect(rumbleGain).connect(bus)
  rumbleSrc.start()

  // Two wanders at unrelated rates, so the fundamental never settles into a
  // pattern. Same trick as the tyre chatter, same reason.
  // SLOW: 0.9 and 2.3 Hz, down from 5.7 and 13.3. At the old rates this was
  // vibrato — a smooth periodic wobble on the pitch, and the single most
  // recognisably synthesised thing a sound can do. A real engine drifts; it
  // does not warble five times a second.
  const jitter = ctx.createOscillator()
  jitter.type = 'sine'
  jitter.frequency.value = 0.9
  const jitterDepth = ctx.createGain()
  jitterDepth.gain.value = 0
  const jitter2 = ctx.createOscillator()
  jitter2.type = 'sine'
  jitter2.frequency.value = 2.3
  const jitter2Depth = ctx.createGain()
  jitter2Depth.gain.value = 0
  for (const [j, d] of [[jitter, jitterDepth], [jitter2, jitter2Depth]] as const) {
    j.connect(d)
    d.connect(osc.frequency)
    d.connect(osc2.frequency)
    j.start()
  }

  osc.connect(tonal)
  osc2.connect(tonal)
  tonal.connect(bus)
  noiseSrc.connect(noiseFilter).connect(noiseGain).connect(bus)
  // Saturate FIRST, then shape. Distorting after the formants would smear the
  // resonances that make it a body; distorting before lets the formants pick
  // out the harmonics the clipping just created.
  bus.connect(drive).connect(shaper).connect(level)
  level.connect(boom).connect(rasp).connect(brightness).connect(dest)
  osc.start()
  osc2.start()
  noiseSrc.start()

  // The three sources are a fixed MIX, summing to unity — how the engine is
  // made up, not how loud it is. Loudness is `level`, after the clipper.
  tonal.gain.value = Math.sqrt(ENGINE_TONAL_SHARE) / ENGINE_LAYER_SUM
  noiseGain.gain.value = Math.sqrt(1 - ENGINE_TONAL_SHARE) / ENGINE_LAYER_SUM
  rumbleGain.gain.value = ENGINE_RUMBLE / ENGINE_LAYER_SUM
  fireDepth.gain.value = (Math.sqrt(1 - ENGINE_TONAL_SHARE) / ENGINE_LAYER_SUM) * 0.4

  return {
    osc, osc2, tonal, noiseFilter, noiseGain, bus, brightness, drive, level,
    fire, fireDepth, rumbleFilter, rumbleGain,
    jitter, jitterDepth, jitter2, jitter2Depth,
  }
}

function updateEngine(e: Engine, l: AudioLevels, now: number): void {
  const f = Math.max(l.engineFreq, 12)
  // HALF the firing frequency: the wave's even harmonics land on the firing
  // orders and its odd ones fill in the half-orders between them.
  e.osc.frequency.setTargetAtTime(f / 2, now, 0.03)
  e.osc2.frequency.setTargetAtTime(f / 2, now, 0.03)
  // The noise is chopped at the FULL firing rate — one slug per bang.
  e.fire.frequency.setTargetAtTime(f, now, 0.03)

  // The source mix is fixed at build time; only the level moves.
  e.level.gain.setTargetAtTime(ENGINE_MUTED ? 0 : l.engineGain, now, 0.04)

  // The noise bed rides just above the fundamental — the SECOND harmonic, not
  // the fourth. At the fourth it sat at 1.6 kHz near the redline, in the part
  // of the spectrum a real cabin has essentially nothing in.
  e.noiseFilter.frequency.setTargetAtTime(Math.min(f * 2, 900), now, 0.05)

  e.brightness.frequency.setTargetAtTime(l.engineCutoff, now, 0.05)
  // 1.5 idling to 7 flat out, up from 1-4.5. Driven into a LOW-passed band
  // this reads as density rather than brightness, which is what growl is.
  e.drive.gain.setTargetAtTime(1.5 + 5.5 * l.engineDrive, now, 0.06)
  e.jitterDepth.gain.setTargetAtTime(l.engineJitter, now, 0.2)
  e.jitter2Depth.gain.setTargetAtTime(l.engineJitter * 0.6, now, 0.2)
}

/** Drive a layer's texture. Depth scales with the layer, so silence stays silent. */
function grainOn(layer: Layer, rate: number, gain: number, now: number): void {
  if (!layer.grain || !layer.grainDepth) return
  layer.grain.frequency.setTargetAtTime(rate, now, 0.1)
  // 40% depth. Deeper starts chopping the sound into separate events, which
  // reads as a rattle rather than as a surface.
  layer.grainDepth.gain.setTargetAtTime(gain * 0.4, now, TAU_UP)
}

/** Asymmetric smoothing: prompt on the way up, unhurried on the way down. */
function ramp(param: AudioParam, target: number, now: number): void {
  param.setTargetAtTime(target, now, target > param.value ? TAU_UP : TAU_DOWN)
}

/**
 * A few seconds of pink-ish noise.
 *
 * White noise is too bright to sit under anything for long. This is Voss-style
 * running sums, which tilts the spectrum down about 3 dB per octave — much
 * closer to wind and rolling rubber, and far easier to listen to.
 */
function makeNoise(ctx: AudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * NOISE_SECONDS)
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1
    b0 = 0.99765 * b0 + white * 0.099046
    b1 = 0.963 * b1 + white * 0.2965164
    b2 = 0.57555 * b2 + white * 1.0526913
    data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.22
  }
  return buffer
}
