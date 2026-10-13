/** Web Audio layers. Engine samples load after the first Drive gesture. */
import {
  impactGain, levelsFor, SQUEAL_CLUSTER, SQUEAL_UPPER, type AudioInput,
} from './mix'
import { EngineVoice } from './engine'

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
  private engine: EngineVoice | null = null
  private engineLoading: AudioContext | null = null
  /** Kerb rattle: modulates the surface layer rather than adding a sound. */
  private rumble: OscillatorNode | null = null
  private rumbleDepth: GainNode | null = null
  private noise: AudioBuffer | null = null
  private level = 0.7
  private muted = false
  /** Context time of the last `update`, for the rate cap below. */
  private lastUpdateAt = -1

  /**
   * Build the graph. Safe to call repeatedly; only the first does anything.
   *
   * Called from a user gesture, because an AudioContext created without one is
   * born suspended and silently stays that way.
   */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume()
      this.ensureEngine()
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
    this.ensureEngine()

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

  private ensureEngine(): void {
    const ctx = this.ctx
    if (!ctx || !this.master || this.engine || this.engineLoading === ctx) return
    this.engineLoading = ctx
    void EngineVoice.create(ctx, this.master).then(engine => {
      if (this.ctx !== ctx) engine.dispose()
      else this.engine = engine
    }).catch(error => {
      if (this.ctx === ctx) console.warn('Engine audio could not load', error)
    }).finally(() => {
      if (this.engineLoading === ctx) this.engineLoading = null
    })
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
    // Same rate cap as `update`, and the same gate: the menu calls this every
    // rendered frame to say "still silent", which needs saying at most 60
    // times a second.
    if (t - this.lastUpdateAt < 0.014) return
    this.lastUpdateAt = t
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
    this.engine?.idle(t)
  }

  update(input: AudioInput): void {
    if (!this.ctx || !this.layers) return
    const t = this.ctx.currentTime
    // Capped near the 60 Hz physics rate. This is called once per RENDERED
    // frame, and every call schedules ~35 automation events — on a 144 Hz
    // screen that is five thousand events a second describing a mix that only
    // changes when the physics ticks. The smoothing constants make each event
    // a target to glide to, so dropping the extras changes nothing audible.
    if (t - this.lastUpdateAt < 0.014) return
    this.lastUpdateAt = t
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

    this.engine?.update(input, t)

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
    this.engine?.dispose()
    this.engineLoading = null
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
    this.master = null
    this.lastUpdateAt = -1
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
