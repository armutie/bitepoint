/**
 * The car-select spec sheet, read straight off ``CarParams``.
 *
 * This replaced a set of 0..1 stat bars. The bars were honest — each read a
 * real parameter — but normalised against invented endpoints, so they could
 * rank two cars and nothing more: a full Grip bar did not tell you the tyre
 * was at mu 2.0, and every car sat at one end or the other because there were
 * only three of them. A driver choosing a car wants the number.
 *
 * Still derived rather than authored, which was the good part of the old
 * design: retune a preset and this follows.
 */
import type { CarParams } from '../core/carParams'

/**
 * Engine output at `torqueScale` 1.0.
 *
 * The torque curve is shared by every car, so peak power is fixed for a given
 * scale; this is the figure the curve integrates to, and the value the preset
 * comments in `racing/car.py` quote.
 */
const BASE_KW = 462

/**
 * The setup sheet, as bars.
 *
 * Bars rather than figures because these are two trims of one car and the
 * question is "which way does this one lean", not "what is the coefficient".
 * The sheet has been both: 0..1 bars first, then numbers, now bars again — and
 * the reason the numbers won last time was that the bars were normalised
 * against invented endpoints, so a full Grip bar told you a car was the grippier
 * of three rather than anything about the tyre.
 *
 * What is different this time is that the endpoints are not invented. Every
 * domain below is the range THIS car covers across its setups, widened a little
 * so neither trim sits on an end. That also fixes the thing that would otherwise
 * make bars useless here: the two setups are four percent apart, and on a
 * zero-based bar four percent is two pixels. A bar from 0 would say these cars
 * are identical, which is exactly the lie the numbers were brought in to stop.
 *
 * Power is here knowing it reads the same on both. It is the one bar that is
 * supposed to: it says the engine is not what you are choosing between.
 */
export interface Bar {
  label: string
  /** 0..1 across the domain — for the bar only, never shown as a figure. */
  fill: number
  /** True when every setup reads the same here, so the UI can say so quietly. */
  shared?: boolean
}

/** [min, max] for each bar. See the note above on why none of these start at 0. */
const DOMAIN = {
  downforce: [1.6, 2.3],
  drag: [0.78, 1.13],
  // Widened at the bottom when both setups lost ~1.5 km/h to the driven-wheel
  // rpm fix: at [270, 296] the high-downforce car sat two thousandths off the
  // end of its own bar, which is the failure this domain exists to prevent.
  topSpeed: [268, 296],
  cornering: [184, 204],
  power: [300, 600],
} as const

const span = ([lo, hi]: readonly [number, number], v: number): number =>
  Math.max(0, Math.min(1, (v - lo) / (hi - lo)))

export function carBars(p: CarParams, preset?: string): Bar[] {
  const perf = preset ? PERFORMANCE[preset] : undefined
  return [
    { label: 'Downforce', fill: span(DOMAIN.downforce, p.downforceCoef) },
    { label: 'Drag', fill: span(DOMAIN.drag, p.dragCoef) },
    { label: 'Top speed', fill: perf ? span(DOMAIN.topSpeed, perf.topKmh) : 0 },
    { label: 'Cornering', fill: perf ? span(DOMAIN.cornering, perf.cornerKmh) : 0 },
    { label: 'Power', fill: span(DOMAIN.power, BASE_KW * p.torqueScale), shared: true },
  ]
}

/**
 * Measured, not guessed, and asserted against the sim in `carStats.test.ts`.
 *
 * Top speed is 60 s flat out from rest; cornering is the highest speed the car
 * holds a 60 m radius without the rear letting go. Both come out of the same
 * physics the game runs, so the test can re-derive them and fail if a retune
 * moves the car without moving the card — which is the only way a hand-written
 * number stays true.
 */
export const PERFORMANCE: Record<string, {
  topKmh: number; cornerKmh: number; downforce: number; drag: number
}> = {
  // Top speed came down about 1.5 km/h when engine rpm was moved onto the
  // driven wheel instead of the road: at terminal velocity the rear is turning
  // fractionally faster than the car is travelling, so the limiter now arrives
  // where it really would. Re-measured rather than tuned back out — the drag
  // figure describes the body, and bending it to recover a round number on a
  // card would be the card deciding the car.
  legacy: { topKmh: 288.4, cornerKmh: 189, downforce: 1.8, drag: 0.86 },
  classic: { topKmh: 270.5, cornerKmh: 200, downforce: 2.05, drag: 1.05 },
}

/** Power-to-weight, the one number that actually predicts how it will feel. */
export function powerToWeight(p: CarParams): string {
  return ((BASE_KW * p.torqueScale) / (p.mass / 1000)).toFixed(0)
}

/** Short tags for the aids and quirks a driver should know about up front. */
export function carTags(p: CarParams): string[] {
  const tags: string[] = []
  tags.push(p.tractionControl ? 'TC' : 'NO TC')
  if (p.absOn) tags.push('ABS')
  return tags
}
