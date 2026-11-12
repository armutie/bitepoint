import { describe, expect, it } from 'vitest'

import manifest from '../../public/tracks/manifest.json'
import { RELEASED_TRACKS } from './released'
import { RELEASED_TRACK_MAP } from './releasedTrackData'

describe('released circuits', () => {
  it('gives the lap verifiers exactly the circuits the menu offers', () => {
    expect([...RELEASED_TRACK_MAP.keys()].sort()).toEqual([...RELEASED_TRACKS].sort())
  })

  it('lists every released circuit in the manifest', () => {
    const ids = new Set(manifest.map((entry) => entry.id))
    for (const id of RELEASED_TRACKS) expect(ids.has(id)).toBe(true)
  })
})
