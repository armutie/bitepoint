import { describe, expect, it } from 'vitest'

import { ordinal } from './ordinal'

describe('ordinal', () => {
  it('suffixes positions the way they are said', () => {
    expect([1, 2, 3, 4, 8, 10].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '8th', '10th'])
    expect([11, 12, 13, 14].map(ordinal)).toEqual(['11th', '12th', '13th', '14th'])
    expect([21, 22, 23, 101, 111, 112].map(ordinal)).toEqual(['21st', '22nd', '23rd', '101st', '111th', '112th'])
  })
})
