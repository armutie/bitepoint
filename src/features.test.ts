import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'

import { isLegacyTyrePath, legacyTyreModeForLocation } from './features'

describe('legacy tyre entry point', () => {
  it('can load in the actual Node API runtime without Vite browser globals', () => {
    const moduleUrl = new URL('./features.ts', import.meta.url).href
    const script = `const flags = await import(${JSON.stringify(moduleUrl)});
      console.log([flags.SHOW_REFERENCE_DRIVER, flags.SHOW_RACING_LINE, flags.SHOW_FPS_OVERLAY]);`
    const output = execFileSync(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(output.trim()).toBe('[ false, false, false ]')
  })
  it('recognises root and subdirectory legacy pages', () => {
    expect(isLegacyTyrePath('/legacy/')).toBe(true)
    expect(isLegacyTyrePath('/bite-point/legacy/index.html')).toBe(true)
    expect(isLegacyTyrePath('/bite-point/')).toBe(false)
  })

  it('stays off in a worker with no browser location', () => {
    expect(legacyTyreModeForLocation(undefined)).toBe(false)
  })
})
