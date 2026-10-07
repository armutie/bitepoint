import { expect, it } from 'vitest'
import { MAX_OPPONENTS, MAX_RACE_LAPS } from '../core/raceSession'
import type { Selection } from './menu'
import { raceSelection } from './sessionSetup'

const selection: Selection = { mode: 'time', trackId: 'balanced_8', preset: 'classic',
  easy: false, ghost: true, ghostEntryId: 'a-time-trial-ghost', laps: 3, opponents: 5, difficulty: 'quick' }

it('switches a time trial to the supported race pairing without its pinned ghost', () => {
  expect(raceSelection(selection)).toEqual({ ...selection, mode: 'race', trackId: 'power_8',
    preset: 'legacy', ghostEntryId: null })
  expect(selection.trackId).toBe('balanced_8')
})

it('keeps selected race options and driving aids', () => {
  expect(raceSelection({ ...selection, laps: 7, opponents: 2, difficulty: 'ruthless', easy: true }))
    .toMatchObject({ laps: 7, opponents: 2, difficulty: 'ruthless', easy: true })
})

it('prevents older saved selections from launching an empty field or invalid distance', () => {
  expect(raceSelection({ ...selection, laps: -2, opponents: 0 })).toMatchObject({ laps: 1, opponents: 1 })
  expect(raceSelection({ ...selection, laps: 10000, opponents: 10000 }))
    .toMatchObject({ laps: MAX_RACE_LAPS, opponents: MAX_OPPONENTS })
  expect(raceSelection({ ...selection, laps: NaN, opponents: Infinity }))
    .toMatchObject({ laps: 3, opponents: 5 })
})
