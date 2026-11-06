import { readFileSync, writeFileSync } from 'node:fs'
import { bakedToLine, type BakedLine } from '../core/bakedLines'
import { handlingPreset } from '../core/carParams'
import { PackTrafficPlanner } from '../core/packTrafficPlanner'
import { atCommitment } from '../core/racingLine'
import { TimeAttackSim } from '../core/sim'
import { Track, type TrackData } from '../core/track'
import { RacingRibbon, TrafficPlanner, type TrafficCar } from '../core/trafficPlanner'

const read = (file: string): string => readFileSync(new URL(`../../public/${file}`, import.meta.url), 'utf8')
const track = new Track(JSON.parse(read('tracks/power_8.json')) as TrackData)
const params = handlingPreset('legacy')
const shape = bakedToLine(JSON.parse(read('lines/power_8.legacy.json')) as BakedLine, track, params, 1)!
const ribbon = new RacingRibbon(track, shape)
const state = new TimeAttackSim(track, params, 'power_8', 'legacy').car.s
const samples = (count: number): TrafficCar[][] => Array.from({ length: 1000 }, (_, tick) =>
  Array.from({ length: count }, (_, slot) => {
    const i = (tick + slot * 4) % shape.x.length
    const next = (i + 1) % shape.x.length
    const s = { ...state, x: shape.x[i]!, y: shape.y[i]!, vx: shape.speed[i]! * 0.93,
      yaw: Math.atan2(shape.y[next]! - shape.y[i]!, shape.x[next]! - shape.x[i]!) }
    return { state: s, road: track.project(s.x, s.y), speed: s.vx }
  }))
const output = []
for (const count of [2, 6]) {
  const frames = samples(count)
  for (const kind of ['previous', 'smart'] as const) {
    const planners = Array.from({ length: count }, (_, slot) => {
      const line = atCommitment(shape, params, 0.93 + slot * 0.005)
      return kind === 'smart' ? new TrafficPlanner(ribbon, line, params)
        : new PackTrafficPlanner(ribbon, line, params)
    })
    const run = (ticks: number): void => {
      for (let tick = 0; tick < ticks; tick++) {
        const cars = frames[tick % frames.length]!
        planners.forEach((planner, slot) => {
          if (tick === 0 || (tick + slot) % 6 === 0) planner.update(cars, slot)
          planner.speedLimit(cars, slot)
        })
      }
    }
    run(600)
    const times: number[] = []
    for (let repeat = 0; repeat < 3; repeat++) {
      const began = performance.now()
      run(6000)
      times.push((performance.now() - began) / 6000)
    }
    output.push({ count, kind, msPerTick: times.sort((a, b) => a - b)[1], repeats: times })
  }
}
writeFileSync(process.argv[2] ?? 'overtake-profile.json', JSON.stringify({
  description: 'Median planner + safety CPU time per 60Hz tick over the same prerecorded positions; excludes physics/rendering/audio.', output,
}, null, 2))
console.log(JSON.stringify(output))

