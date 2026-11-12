/**
 * Remembers your last leaderboard position on each circuit, so a verified lap
 * can say how far it moved you.
 *
 * Kept per browser rather than fetched: the server only knows where you are
 * now, and "up 6 places" needs where you were. Losing it (a new browser,
 * cleared storage) costs one banner that says "on the board" instead.
 */
const KEY = 'bitepoint:last-rank:v1'

export interface RankNews {
  rank: number
  /** Places gained since the last time you were ranked here; null the first time. */
  gained: number | null
}

/**
 * Record `rank` on `trackId` and say whether it is worth a banner: the first
 * time you are on the board, or whenever you climb. Holding or dropping a place
 * is not news a lap should interrupt you with.
 */
export function recordRank(storage: Storage | null, trackId: string, rank: number): RankNews | null {
  const ranks = read(storage)
  const previous = ranks[trackId]
  ranks[trackId] = rank
  write(storage, ranks)
  if (previous === undefined) return { rank, gained: null }
  if (rank < previous) return { rank, gained: previous - rank }
  return null
}

function read(storage: Storage | null): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(Object.entries(parsed).filter(
      (entry): entry is [string, number] => Number.isInteger(entry[1]) && entry[1] > 0,
    ))
  } catch {
    return {}
  }
}

function write(storage: Storage | null, ranks: Record<string, number>): void {
  try { storage?.setItem(KEY, JSON.stringify(ranks)) } catch { /* private mode: no memory, no harm */ }
}
