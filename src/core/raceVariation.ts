import { seeded } from './racecraft'

function shuffled(count: number, seed: number): number[] {
  const values=Array.from({length:count},(_,i)=>i)
  const random=seeded(seed>>>0)
  for(let i=count-1;i>0;i--) {
    const j=Math.floor(random()*(i+1))
    ;[values[i],values[j]]=[values[j]!,values[i]!]
  }
  return values
}

/** Stable pace rank per AI identity; a car number is not a skill ranking. */
export const aiPaceRanks=(seed:number,count:number):number[]=>shuffled(count,seed^0x62f31a7b)

/** Mix AI starting positions while preserving the player's qualifying place. */
export function mixedAiGrid(seed:number,grid:readonly number[]):number[] {
  const player=grid.length-1
  const ai=shuffled(player,seed^0x183a9c45)
  let next=0
  return grid.map((id)=>id===player?player:ai[next++]!)
}
