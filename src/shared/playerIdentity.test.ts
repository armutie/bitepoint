import { describe, expect, it } from 'vitest'

import { parseUsername } from './playerIdentity'

describe('leaderboard usernames', () => {
  it('preserves display case but keys names case-insensitively', () => {
    expect(parseUsername('  ApexFox  ')).toEqual({ username: 'ApexFox', key: 'apexfox' })
  })

  it('accepts restrained separators inside a name', () => {
    expect(parseUsername('late_braker-7')).toEqual({
      username: 'late_braker-7',
      key: 'late_braker-7',
    })
  })

  it.each(['ab', 'a'.repeat(17), '_driver', 'driver_', 'two words', 'drïver', '']) (
    'rejects %j',
    (username) => expect(parseUsername(username)).toBeNull(),
  )
})
