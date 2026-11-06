import { describe,expect,it } from 'vitest'
import { aiPaceRanks,mixedAiGrid } from './raceVariation'
describe('race AI variation',()=>{
  it('is repeatable for a race seed and keeps every AI rank exactly once',()=>{
    const ranks=aiPaceRanks(123,5)
    expect(aiPaceRanks(123,5)).toEqual(ranks)
    expect([...ranks].sort()).toEqual([0,1,2,3,4])
    expect(aiPaceRanks(456,5)).not.toEqual(ranks)
  })
  it('does not always make car 1 fastest or put the fastest AI on pole',()=>{
    const winners=new Set<number>(), poles=new Set<number>()
    for(let seed=1;seed<=30;seed++) {
      const ranks=aiPaceRanks(seed,5), grid=mixedAiGrid(seed,[0,1,2,3,4,5])
      winners.add(ranks.indexOf(0))
      poles.add(ranks[grid[0]!]!)
    }
    expect(winners.size).toBeGreaterThan(3)
    expect(poles.size).toBeGreaterThan(3)
  })
  it('keeps the player in their earned grid place and retains all identities',()=>{
    for(const grid of [[5,0,1,2,3,4],[0,1,5,2,3,4],[0,1,2,3,4,5]]) {
      const mixed=mixedAiGrid(17,grid)
      expect(mixed.indexOf(5)).toBe(grid.indexOf(5))
      expect([...mixed].sort()).toEqual([0,1,2,3,4,5])
      expect(mixedAiGrid(17,grid)).toEqual(mixed)
    }
  })
})
