/**
 * A headless two-player network simulation, for measuring what each driver
 * actually sees under a given connection.
 *
 * It wires the real pieces together the way the game does: the host's inputs
 * reach the authority directly, the guest's cross a simulated link with
 * latency, jitter and loss, and snapshots come back the same way. Nothing is
 * mocked except the wire and the clock.
 */
import type { CarState } from '../core/car'
import { DT } from '../core/sim'
import type { Track } from '../core/track'
import { RaceAuthority } from './authority'
import { hostLeadTicks, Predictor } from './prediction'
import type { InputFrame, RoomConfig, Snapshot } from './protocol'

export interface LinkProfile {
  /** One-way latency, ms. */
  latencyMs: number
  /** Extra random delay on top, 0..jitterMs, ms. */
  jitterMs: number
  /** Fraction of packets dropped, 0..1. */
  loss: number
}

export interface NetsimOptions {
  link: LinkProfile
  ticks?: number
  seed?: number
  /** Send a snapshot every N physics ticks (the game used 2). */
  snapshotEvery?: number
  /**
   * Carry the other car forward on the host by the guest's estimated input
   * latency, so the host sees the guest where the guest actually is.
   */
  hostLead?: boolean
  /** Start the cars alongside at speed, close enough that steering makes them touch. */
  sideBySide?: boolean
  /** Which way the side-by-side drivers lean: toward each other for one sign. */
  leanSign?: 1 | -1
}

export interface NetsimReport {
  /** How far the guest's own car jumps when a correction lands, metres (p95). */
  guestSnapP95: number
  /** The single worst jump of the guest's own car, metres. */
  guestSnapMax: number
  /** Guest's view of the host car vs where the host car really is, metres (p95). */
  guestViewErrorP95: number
  /** Host's view of the guest car vs where the guest car really is, metres (p95). */
  hostViewErrorP95: number
  /** Time from the guest's input to the authority applying it, ms (mean). */
  guestInputDelayMs: number
  /** Ticks with car-to-car contact, after warm-up: proof a contact run touched. */
  impacts: number
}

const p95 = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length * 0.95)]! : 0
}
const gap = (a: CarState, b: CarState): number => Math.hypot(a.x - b.x, a.y - b.y)

/** Scripted driving with the kind of sudden steering changes that make prediction hard. */
function driver(seed: number): (tick: number) => { steer: number; throttle: number } {
  let s = seed >>> 0, target = 0, next = 0
  const rand = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  return (tick) => {
    if (tick >= next) { target = (rand() - 0.5) * 0.3; next = tick + 20 + Math.floor(rand() * 40) }
    return { steer: target + Math.sin(tick * 0.05) * 0.04, throttle: 0.55 + 0.25 * Math.sin(tick * 0.01) }
  }
}

export function runNetsim(track: Track, config: RoomConfig, opts: NetsimOptions): NetsimReport {
  const ticks = opts.ticks ?? 1200, every = opts.snapshotEvery ?? 2
  let rs = (opts.seed ?? 7) >>> 0
  const rand = (): number => { rs = (rs * 22695477 + 1) >>> 0; return rs / 4294967296 }
  const delayTicks = (): number | null => {
    if (rand() < opts.link.loss) return null
    return Math.max(0, Math.round((opts.link.latencyMs + rand() * opts.link.jitterMs) / (DT * 1000)))
  }

  const authority = new RaceAuthority(track, config)
  authority.race.phase = 'racing'
  if (opts.sideBySide) {
    const pose = track.poseAt(250)
    for (const slot of [0, 1] as const) {
      const car = authority.race.sims[slot]!.car, lateral = slot === 0 ? -0.9 : 0.9
      car.setPose(pose.x - Math.sin(pose.yaw) * lateral, pose.y + Math.cos(pose.yaw) * lateral, pose.yaw)
      car.s.vx = 30; car.s.wheelVr = 30
    }
  }
  const host = new Predictor(track, config, 0), guest = new Predictor(track, config, 1)
  host.reconcile(authority.snapshot()); guest.reconcile(authority.snapshot())
  const drive = [driver(11), driver(23)]
  const up: { at: number; batch: InputFrame[] }[] = [], down: { at: number; s: Snapshot }[] = []
  // What the game estimates from its ping: the average one-way trip.
  const lead = opts.hostLead ? hostLeadTicks(2 * opts.link.latencyMs + opts.link.jitterMs) : 0

  const snaps: number[] = [], guestView: number[] = [], hostView: number[] = [], inputLag: number[] = []
  let impacts = 0
  // Side by side, the drivers also lean on each other in regular pulses, so a
  // contact run keeps colliding instead of drifting apart after the start.
  const lean = (slot: 0 | 1, tick: number): number =>
    opts.sideBySide && tick % 45 < 12 ? (slot === 0 ? 1 : -1) * (opts.leanSign ?? 1) * 0.12 : 0
  for (let tick = 1; tick <= ticks; tick++) {
    const h = drive[0]!(tick), g = drive[1]!(tick)
    authority.receive(0, [host.frame(h.steer * (opts.sideBySide ? 0.2 : 1) + lean(0, tick), h.throttle, 0, 2)])
    guest.frame(g.steer * (opts.sideBySide ? 0.2 : 1) + lean(1, tick), g.throttle, 0, 2)
    const d = delayTicks()
    if (d !== null) up.push({ at: tick + d, batch: guest.batch() })
    for (let i = up.length - 1; i >= 0; i--) if (up[i]!.at <= tick) authority.receive(1, up.splice(i, 1)[0]!.batch)

    const s = authority.step()
    if (tick % every === 0) {
      host.reconcile(s)
      const dd = delayTicks()
      if (dd !== null) down.push({ at: tick + dd, s })
    }
    for (let i = down.length - 1; i >= 0; i--) {
      if (down[i]!.at > tick) continue
      const m = down.splice(i, 1)[0]!
      if (guest.reconcile(m.s) && tick > 120) snaps.push(guest.correction)
    }
    if (tick <= 120) continue
    if (Array.from(authority.race.impacts).some((v) => v > 0)) impacts++
    // What each screen would show now, against where each car really is now:
    // the host car's truth is the authority (the host has no latency to it);
    // the guest car's truth is the guest's own prediction.
    const truthHost = authority.race.sims[0]!.car.s, truthGuest = guest.states[1]!
    guestView.push(gap(guest.display(0)[0]!, truthHost))
    hostView.push(gap(host.display(lead)[1]!, truthGuest))
    inputLag.push((guest.sequence - s.ack[1]!) * DT * 1000)
  }
  return {
    guestSnapP95: +p95(snaps).toFixed(3),
    guestSnapMax: +Math.max(0, ...snaps).toFixed(3),
    guestViewErrorP95: +p95(guestView).toFixed(3),
    hostViewErrorP95: +p95(hostView).toFixed(3),
    guestInputDelayMs: Math.round(inputLag.reduce((a, b) => a + b, 0) / Math.max(1, inputLag.length)),
    impacts,
  }
}
