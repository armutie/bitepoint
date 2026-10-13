import type { AudioInput } from './mix'
import { EnginePerformance, POWER_RPM, COAST_RPM } from './engineMix'

import powerURL from '/audio/engine/power.wav?url'
import coastURL from '/audio/engine/coast.wav?url'
import catchURL from '/audio/engine/exhaust-catch.mp3?url'

const URLs = [powerURL, coastURL, catchURL]
let bank: Promise<ArrayBuffer[]> | undefined

async function buffers(ctx: BaseAudioContext): Promise<AudioBuffer[]> {
  // Cache bytes across sessions; decode once per context. Never decode or
  // generate samples in the animation/physics loop.
  bank ??= Promise.all(URLs.map(async url => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Engine sample ${response.status}: ${url}`)
    return response.arrayBuffer()
  })).catch(error => { bank = undefined; throw error })
  return Promise.all((await bank).map(bytes => ctx.decodeAudioData(bytes.slice(0))))
}

/** Two continuously looping voices, no worklet, convolution or frame-time DSP. */
export class EngineVoice {
  readonly level: GainNode
  private readonly sources: AudioBufferSourceNode[] = []
  private readonly gains: GainNode[] = []
  private readonly nodes: AudioNode[] = []
  private readonly filter: BiquadFilterNode
  private stopped = false
  private readonly performance = new EnginePerformance()
  private readonly transients = new Map<AudioBufferSourceNode, { gain: GainNode; end: number }>()
  private readonly transientFilter: BiquadFilterNode
  private readonly catchSample: AudioBuffer
  private readonly ctx: BaseAudioContext
  private sleeping = true

  static async create(ctx: BaseAudioContext, destination: AudioNode): Promise<EngineVoice> {
    const samples = await buffers(ctx)
    if (ctx.state === 'closed') throw new Error('Engine context closed while loading')
    return new EngineVoice(ctx, destination, samples)
  }

  private constructor(ctx: BaseAudioContext, destination: AudioNode, samples: AudioBuffer[]) {
    this.ctx = ctx
    this.catchSample = samples[2]!
    this.transientFilter = ctx.createBiquadFilter()
    this.transientFilter.type = 'lowpass'
    this.transientFilter.frequency.value = 1500
    this.transientFilter.Q.value = 0.55
    const body = ctx.createBiquadFilter()
    body.type = 'lowshelf'
    body.frequency.value = 220
    body.gain.value = 3.8
    const highpass = ctx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 32
    highpass.Q.value = 0.7
    this.filter = ctx.createBiquadFilter()
    this.filter.type = 'lowpass'
    this.filter.frequency.value = 900
    this.filter.Q.value = 0.55
    this.level = ctx.createGain()
    this.level.gain.value = 0 // Late loading in a paused menu must remain silent.
    body.connect(highpass).connect(this.filter).connect(this.level).connect(destination)
    this.transientFilter.connect(this.level)
    this.nodes.push(body, highpass, this.filter, this.level, this.transientFilter)
    samples.slice(0, 2).forEach((buffer, i) => {
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.loop = true
      source.playbackRate.value = 1200 / (i === 0 ? POWER_RPM : COAST_RPM)
      const gain = ctx.createGain()
      gain.gain.value = 0
      source.connect(gain).connect(body)
      source.start()
      this.sources.push(source)
      this.gains.push(gain)
      this.nodes.push(source, gain)
    })
  }

  update(input: AudioInput, time: number) {
    this.sleeping = false
    const mix = this.performance.update(input, time)
    this.sources[0]!.playbackRate.setTargetAtTime(mix.powerRate, time, mix.pitchTau)
    this.sources[1]!.playbackRate.setTargetAtTime(mix.coastRate, time, mix.pitchTau)
    this.gains[0]!.gain.setTargetAtTime(mix.powerGain, time, 0.018)
    this.gains[1]!.gain.setTargetAtTime(mix.coastGain, time, 0.025)
    this.level.gain.setTargetAtTime(mix.level, time, 0.022)
    this.filter.frequency.setTargetAtTime(mix.cutoff, time, 0.032)
    if (mix.event) {
      const strength = mix.event === 'up' ? 0.25 : mix.event === 'down' ? 0.055 : 0.14
      this.catch(time, strength, 1.3 + mix.eventColour * 0.55, mix.eventColour)
      // An occasional quieter after-pulse, confined to that shift/lift event.
      if (mix.event !== 'down' && mix.eventColour > 0.62) this.catch(time + 0.075 + mix.eventColour * 0.035,
        strength * 0.32, 1.65, 1 - mix.eventColour)
    }
    return mix
  }

  private catch(time: number, strength: number, rate: number, colour: number): void {
    if (this.stopped || [...this.transients.values()].filter(v => v.end > time).length >= 4) return
    const source = this.ctx.createBufferSource()
    source.buffer = this.catchSample
    source.playbackRate.value = rate
    const gain = this.ctx.createGain()
    // Short, dark sample fragment: an exhaust catch, not the source's full bang.
    gain.gain.setValueAtTime(0, time)
    gain.gain.linearRampToValueAtTime(strength, time + 0.004)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.13)
    source.connect(gain).connect(this.transientFilter)
    this.transients.set(source, { gain, end: time + 0.15 })
    source.onended = () => {
      source.disconnect(); gain.disconnect(); this.transients.delete(source)
    }
    source.start(time, 0.005 + colour * 0.018)
    source.stop(time + 0.15)
  }

  idle(time: number): void {
    this.level.gain.setTargetAtTime(0, time, 0.12)
    if (this.sleeping) return
    this.sleeping = true
    this.performance.reset()
    this.stopTransients(time)
  }

  private stopTransients(time = this.ctx.currentTime, disconnect = false): void {
    for (const [source, { gain, end }] of this.transients) {
      source.stop(Math.min(time, end))
      if (disconnect) { source.disconnect(); gain.disconnect() }
    }
    if (disconnect) this.transients.clear()
  }

  dispose(): void {
    if (this.stopped) return
    this.stopped = true
    this.stopTransients(this.ctx.currentTime, true)
    for (const source of this.sources) source.stop()
    for (const node of this.nodes) node.disconnect()
  }
}
