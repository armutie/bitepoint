import { describe, expect, it } from 'vitest'
import { standing } from './homeBoard'

const board = [
  { playerName: 'Mika', time: 88.4 },
  { playerName: 'Abdur', time: 88.9 },
  { playerName: 'Lena', time: 89.3 },
  { playerName: 'Sam', time: 91.0 },
]

describe('home leaderboard standing', () => {
  it('finds the player on the board and the gap to the place above', () => {
    const s = standing(board, 'Lena', null, true)!
    expect(s.position).toBe(3)
    expect(s.gap).toBeCloseTo(0.4)
    expect(s.unsaved).toBe(false)
  })

  it('says nothing to beat for the fastest lap', () => {
    expect(standing(board, 'Mika', null, true)!.gap).toBeNull()
  })

  it('places a faster lap kept on this device, ignoring the player’s own slower entry', () => {
    const s = standing(board, 'Sam', { time: 89.0 }, true)!
    expect(s).toMatchObject({ position: 3, unsaved: true })
    expect(s.gap).toBeCloseTo(0.1)
  })

  it('has no place for a player without a lap', () => {
    expect(standing(board, 'Nobody', null, true)).toBeNull()
    expect(standing(board, null, null, true)).toBeNull()
  })

  it('does not invent a position below a board that was cut off', () => {
    const s = standing(board, null, { time: 95 }, false)!
    expect(s.position).toBeNull()
    expect(s.gap).toBeNull()
  })
})
