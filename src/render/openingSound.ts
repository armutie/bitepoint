import powerURL from '/audio/engine/power.wav?url'

import type { Track } from '../core/track'
import { OPENING_CARS, OPENING_END, OpeningShot } from './openingShot'

/**
 * The opening shot's soundtrack, for the promo cut of the video (dev only:
 * `recordOpening({ audio: true })` in main.ts). The site's own copy stays
 * silent, since a browser only autoplays video that is muted.
 *
 * Rendered offline from the same shot the picture is, so it is in sync by
 * construction: each car is the game's engine loop pitched to a racing
 * engine's scream, louder and brighter as it closes, Doppler-shifted by its
 * speed towards or away from the camera, and panned by where it is relative to
 * where the camera is pointing. Under it, wind and a distant crowd; on each
 * pass, a rush of air and a thump through the camera.
 *
 * The engine sample is "Generic V8 Engine Sound" by DerMeehdrescher,
 * CC BY-SA 4.0 (public/audio/engine/CREDITS.txt): credit it where the video
 * is posted.
 */
const RATE = 48_000
/** Automation points per second. */
const STEPS = 200
const SOUND = 343
/** Playback rate of the engine loop (recorded at 5570 rpm) for each car: ~12-13k rpm. */
const PITCH = [2.3, 2.18, 2.42]

/** Revs through the run: a steady climb as the car accelerates, no gear changes. */
function revs(dt: number): number {
  return 10600 + 1500 * Math.min(1, Math.max(0, (dt + 2.6) / 5))
}

export interface OpeningSoundOptions {
  /** Seconds of sound; past the shot's end the cars carry on down the straight. */
  seconds?: number | undefined
  /** A commentary recording, played over the circuit's loudspeakers from the start. */
  commentary?: string | undefined
}

export async function renderOpeningSound(track: Track, options: OpeningSoundOptions = {}): Promise<AudioBuffer> {
  const seconds = options.seconds ?? OPENING_END
  const length = Math.ceil((seconds + 0.4) * RATE)
  const ctx = new OfflineAudioContext(2, length, RATE)
  const engine = await ctx.decodeAudioData(await (await fetch(powerURL)).arrayBuffer())
  const noise = noiseBuffer(ctx, 4)

  // Walk the shot at the automation rate: distance, approach speed and
  // bearing of every car, as the camera sees it.
  const shot = new OpeningShot(track)
  const n = Math.ceil((seconds + 0.4) * STEPS)
  const dist = OPENING_CARS.map(() => new Float32Array(n))
  const bearing = OPENING_CARS.map(() => new Float32Array(n))
  for (let i = 0; i < n; i++) {
    shot.heroes().forEach((car, k) => {
      const dx = car.x - shot.eye.x, dz = -car.y - shot.eye.z
      dist[k]![i] = Math.max(1.5, Math.hypot(dx, dz, 0.75 - shot.eye.y))
      // Right of where the camera points is positive: pan right.
      bearing[k]![i] = Math.sin(wrap(Math.atan2(dz, dx) - shot.heading))
    })
    shot.step(1 / STEPS)
  }

  const master = ctx.createDynamicsCompressor()
  master.threshold.value = -10
  master.knee.value = 6
  master.ratio.value = 3
  master.attack.value = 0.004
  master.release.value = 0.18
  const out = ctx.createGain()
  out.gain.value = 0.8
  master.connect(out).connect(ctx.destination)

  const curve = (values: Float32Array, param: AudioParam): void => { param.setValueCurveAtTime(values, 0, n / STEPS) }
  const passTimes: number[] = []

  OPENING_CARS.forEach((car, k) => {
    const d = dist[k]!, b = bearing[k]!
    const at = car.passT - car.lead / 81
    passTimes.push(at)
    const rate = new Float32Array(n), gain = new Float32Array(n), cutoff = new Float32Array(n)
    const pan = new Float32Array(n), whoosh = new Float32Array(n), level = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      // Speed along the line to the camera: negative closing, positive leaving.
      const radial = (d[Math.min(i + 1, n - 1)]! - d[Math.max(i - 1, 0)]!) * STEPS / 2
      rate[i] = PITCH[k]! * revs(i / STEPS - at) / 12000 * SOUND / (SOUND + radial)
      // Falls away faster than distance alone, so a pass is a real event,
      // but never to nothing: a car this loud carries the length of a straight.
      level[i] = Math.max(Math.min(1, (8 / d[i]!) ** 1.45) * 0.95, 0.06 * Math.min(1, 500 / d[i]!))
      gain[i] = level[i]!
      // Air takes the top off far away; up close it is all edge.
      cutoff[i] = 900 + 14000 * Math.min(1, 14 / d[i]!)
      pan[i] = b[i]! * 0.9
      whoosh[i] = Math.min(1, (5 / d[i]!) ** 2) * 0.55
    }
    // Two layers of the same loop, a fifth apart: body and scream.
    for (const [layer, mix] of [[1, 1], [1.5, 0.32]] as const) {
      const source = ctx.createBufferSource()
      source.buffer = engine
      source.loop = true
      curve(rate.map((r) => r * layer), source.playbackRate)
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      curve(cutoff, filter.frequency)
      const g = ctx.createGain()
      curve(gain.map((v) => v * mix), g.gain)
      const p = ctx.createStereoPanner()
      curve(pan, p.pan)
      source.connect(filter).connect(g).connect(p).connect(master)
      // Each car's loop starts at its own point, so no two are in phase.
      source.start(0, (k * 0.37) % engine.duration)
    }
    // The rush of air as it goes by.
    const air = ctx.createBufferSource()
    air.buffer = noise
    air.loop = true
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = 1400
    band.Q.value = 0.6
    const ag = ctx.createGain()
    curve(whoosh, ag.gain)
    const ap = ctx.createStereoPanner()
    curve(pan, ap.pan)
    air.connect(band).connect(ag).connect(ap).connect(master)
    air.start(0, k * 0.5)
    // And the thump through the camera as it does.
    const thump = ctx.createOscillator()
    thump.frequency.setValueAtTime(70, at)
    thump.frequency.exponentialRampToValueAtTime(38, at + 0.3)
    const tg = ctx.createGain()
    tg.gain.setValueAtTime(0, 0)
    tg.gain.setValueAtTime(0, at - 0.01)
    tg.gain.linearRampToValueAtTime(0.35, at + 0.01)
    tg.gain.exponentialRampToValueAtTime(0.001, at + 0.4)
    thump.connect(tg).connect(master)
    thump.start(Math.max(0, at - 0.02))
    thump.stop(at + 0.5)
  })

  // Cars elsewhere on the circuit: faint, filtered, coming and going.
  for (const [k, side, base] of [[0, -0.7, 2.05], [1, 0.65, 2.25]] as const) {
    const source = ctx.createBufferSource()
    source.buffer = engine
    source.loop = true
    const rate = new Float32Array(n), gain = new Float32Array(n), pan = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / STEPS
      rate[i] = base * (0.93 + 0.05 * Math.sin(t * 0.7 + k * 1.9))
      gain[i] = 0.018 + 0.016 * (0.5 + 0.5 * Math.sin(t * 0.55 + k * 2.4))
      pan[i] = side * (0.7 + 0.3 * Math.sin(t * 0.3 + k))
    }
    curve(rate, source.playbackRate)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 850
    const g = ctx.createGain()
    curve(gain, g.gain)
    const p = ctx.createStereoPanner()
    curve(pan, p.pan)
    source.connect(filter).connect(g).connect(p).connect(master)
    source.start(0, 0.9 + k * 0.6)
  }

  // Wind at the pit wall.
  const wind = ctx.createBufferSource()
  wind.buffer = noise
  wind.loop = true
  const windFilter = ctx.createBiquadFilter()
  windFilter.type = 'lowpass'
  windFilter.frequency.value = 380
  const windGain = ctx.createGain()
  windGain.gain.value = 0.06
  wind.connect(windFilter).connect(windGain).connect(master)
  wind.start(0, 1.3)

  // The crowd: a full murmur and a higher chatter over it, rising into a cheer
  // as each car goes by and settling back after.
  const cheer = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / STEPS
    let lift = 0
    for (const at of passTimes) {
      const since = t - at + 0.25
      if (since > 0) lift = Math.max(lift, Math.min(1, since / 0.35) * Math.exp(-Math.max(0, since - 0.35) / 2.2))
    }
    cheer[i] = 0.075 + 0.006 * Math.sin(t * 1.3) + 0.11 * lift
  }
  for (const [freq, q, mix, offset] of [[650, 0.7, 1, 2.1], [1700, 1.1, 0.45, 0.4]] as const) {
    const crowd = ctx.createBufferSource()
    crowd.buffer = noise
    crowd.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = freq
    filter.Q.value = q
    const g = ctx.createGain()
    curve(cheer.map((v) => v * mix), g.gain)
    crowd.connect(filter).connect(g).connect(master)
    crowd.start(0, offset)
  }

  if (options.commentary) {
    const voice = await ctx.decodeAudioData(await (await fetch(options.commentary)).arrayBuffer())
    loudspeaker(ctx, voice, master)
  }

  // A short fade in and out, so the clip neither starts nor ends on a click.
  out.gain.setValueAtTime(0, 0)
  out.gain.linearRampToValueAtTime(0.8, 0.08)
  out.gain.setValueAtTime(0.8, seconds - 0.35)
  out.gain.linearRampToValueAtTime(0, seconds)

  return ctx.startRendering()
}

/**
 * A voice over the circuit's public address: squeezed into the band a horn
 * speaker can carry, driven a little hard, and heard from several speakers
 * down the straight at once, each a little later and duller than the last,
 * in open air. Mixed under the engines, so a car going by drowns it out.
 */
function loudspeaker(ctx: BaseAudioContext, voice: AudioBuffer, destination: AudioNode): void {
  const source = ctx.createBufferSource()
  source.buffer = voice
  // To mono: a PA is one voice from everywhere.
  const mono = ctx.createGain()
  mono.channelCount = 1
  mono.channelCountMode = 'explicit'
  mono.channelInterpretation = 'speakers'
  const low = ctx.createBiquadFilter()
  low.type = 'highpass'
  low.frequency.value = 420
  low.Q.value = 0.9
  const high = ctx.createBiquadFilter()
  high.type = 'lowpass'
  high.frequency.value = 3600
  high.Q.value = 0.9
  const horn = ctx.createBiquadFilter()
  horn.type = 'peaking'
  horn.frequency.value = 1800
  horn.gain.value = 7
  horn.Q.value = 1.2
  const drive = ctx.createWaveShaper()
  const shape = new Float32Array(1024)
  for (let i = 0; i < shape.length; i++) {
    const x = (i / (shape.length - 1)) * 2 - 1
    shape[i] = Math.tanh(x * 2.2) / Math.tanh(2.2)
  }
  drive.curve = shape
  drive.oversample = '2x'
  const level = ctx.createGain()
  level.gain.value = 0.11
  source.connect(mono).connect(low).connect(high).connect(horn).connect(drive).connect(level)

  // The nearest speaker, slightly to the left, and the others down the straight.
  const near = ctx.createStereoPanner()
  near.pan.value = -0.2
  level.connect(near).connect(destination)
  for (const [delay, gain, pan, dull] of [[0.085, 0.42, 0.35, 2600], [0.19, 0.28, -0.45, 2000], [0.33, 0.17, 0.15, 1500]] as const) {
    const d = ctx.createDelay(1)
    d.delayTime.value = delay
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = dull
    const g = ctx.createGain()
    g.gain.value = gain
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    level.connect(d).connect(f).connect(g).connect(p).connect(destination)
  }
  // Open air: a short, bright tail rather than a hall.
  const tail = ctx.createConvolver()
  const impulse = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * 1.3), ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const data = impulse.getChannelData(c)
    let seed = 777 + c * 31
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 16807) % 2147483647
      data[i] = (seed / 2147483647 * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.32))
    }
  }
  tail.buffer = impulse
  const wet = ctx.createGain()
  wet.gain.value = 0.16
  level.connect(tail).connect(wet).connect(destination)
  source.start(0)
}

/** A few seconds of soft (roughly pink) noise, stereo-decorrelated. */
function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(2, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c)
    let b0 = 0, b1 = 0, b2 = 0, seed = 1234 + c * 999
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 16807) % 2147483647
      const white = seed / 2147483647 * 2 - 1
      b0 = 0.99765 * b0 + white * 0.099046
      b1 = 0.963 * b1 + white * 0.2965164
      b2 = 0.57 * b2 + white * 1.0526913
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.2
    }
  }
  return buffer
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a))
}
