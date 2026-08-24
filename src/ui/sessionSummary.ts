import { SECTORS } from '../core/sim'

/** A light session record: enough to explain a run without retaining replays. */
export interface SessionLap {
  number: number
  time: number
  valid: boolean
  sectors: (number | null)[]
}

export interface SessionSummary {
  trackLabel: string
  carLabel: string
  easy: boolean
  /** The personal best before this run began, never a value set during it. */
  personalBestBefore: number | null
  laps: SessionLap[]
}

export interface SectorBest {
  sector: number
  time: number
  lap: number
}

export interface SessionAnalysis {
  validLaps: SessionLap[]
  fastest: SessionLap | null
  bestSectors: (SectorBest | null)[]
  theoreticalBest: number | null
  theoreticalGain: number | null
  /** First clean lap to session best; null when the best was set immediately. */
  improvement: number | null
  observation: string | null
}

/**
 * Extract only claims strong enough to put in front of a driver.
 *
 * The chart can show every wobble without editorialising. Words have a higher
 * bar: a PB, a material gain through the run, or a genuinely tight final set.
 */
export function analyseSession(summary: SessionSummary): SessionAnalysis {
  const validLaps = summary.laps.filter((lap) => lap.valid && Number.isFinite(lap.time))
  const fastest = validLaps.reduce<SessionLap | null>(
    (best, lap) => !best || lap.time < best.time ? lap : best,
    null,
  )

  const bestSectors: (SectorBest | null)[] = Array.from({ length: SECTORS }, () => null)
  for (const lap of validLaps) {
    for (let sector = 0; sector < SECTORS; sector++) {
      const time = lap.sectors[sector]
      const best = bestSectors[sector]
      if (time !== null && time !== undefined && Number.isFinite(time) && (!best || time < best.time)) {
        bestSectors[sector] = { sector, time, lap: lap.number }
      }
    }
  }

  const completeSectors = bestSectors.filter((sector): sector is SectorBest => sector !== null)
  const theoreticalBest = completeSectors.length === SECTORS
    ? completeSectors.reduce((sum, sector) => sum + sector.time, 0)
    : null
  const theoreticalGain = fastest && theoreticalBest !== null
    ? Math.max(0, fastest.time - theoreticalBest)
    : null

  const first = validLaps[0] ?? null
  const improvement = first && fastest && fastest.number !== first.number && first.time - fastest.time >= 0.05
    ? first.time - fastest.time
    : null

  return {
    validLaps,
    fastest,
    bestSectors,
    theoreticalBest,
    theoreticalGain,
    improvement,
    observation: observationFor(summary, validLaps, fastest),
  }
}

function observationFor(
  summary: SessionSummary,
  valid: SessionLap[],
  fastest: SessionLap | null,
): string | null {
  if (!fastest) return null

  const pb = summary.personalBestBefore
  if (pb !== null && pb - fastest.time >= 0.01) {
    return `New personal best by ${seconds(pb - fastest.time)} — set on lap ${fastest.number}.`
  }

  const first = valid[0]
  if (first && fastest.number !== first.number) {
    const gain = first.time - fastest.time
    if (gain >= 0.25) {
      const strongest = strongestSectorGain(first, fastest)
      const source = strongest !== null && strongest.gain >= Math.max(0.08, gain * 0.45)
        ? ` Most of it came in sector ${strongest.sector + 1}.`
        : ''
      return `You found ${seconds(gain)} over ${valid.length} clean laps.${source}`
    }
  }

  if (valid.length >= 3) {
    const last = valid.slice(-3)
    const times = last.map((lap) => lap.time)
    const spread = Math.max(...times) - Math.min(...times)
    if (spread <= 0.35) {
      return `Your last three clean laps landed within ${seconds(spread)}.`
    }
  }

  return null
}

function strongestSectorGain(
  first: SessionLap,
  fastest: SessionLap,
): { sector: number; gain: number } | null {
  let strongest: { sector: number; gain: number } | null = null
  for (let sector = 0; sector < SECTORS; sector++) {
    const before = first.sectors[sector]
    const after = fastest.sectors[sector]
    if (before === null || before === undefined || after === null || after === undefined) continue
    const gain = before - after
    if (!strongest || gain > strongest.gain) strongest = { sector, gain }
  }
  return strongest
}

const seconds = (value: number): string => `${value.toFixed(2)}s`
