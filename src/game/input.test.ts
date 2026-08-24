import { describe, expect, it } from 'vitest'

import { inputTypeAcceptsText } from './input'

describe('inputTypeAcceptsText', () => {
  it('protects username-style fields from game shortcuts', () => {
    expect(inputTypeAcceptsText('text')).toBe(true)
    expect(inputTypeAcceptsText('search')).toBe(true)
    expect(inputTypeAcceptsText('email')).toBe(true)
  })

  it('leaves non-text controls on their normal control-key rules', () => {
    expect(inputTypeAcceptsText('range')).toBe(false)
    expect(inputTypeAcceptsText('checkbox')).toBe(false)
    expect(inputTypeAcceptsText('button')).toBe(false)
  })
})
