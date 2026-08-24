export const USERNAME_MIN = 3
export const USERNAME_MAX = 16

export interface UsernameResult {
  username: string
  key: string
}

/**
 * Leaderboard handles are deliberately narrow. ASCII avoids confusable names,
 * while preserving the player's chosen case keeps the board personal.
 */
export function parseUsername(input: unknown): UsernameResult | null {
  if (typeof input !== 'string') return null
  const username = input.trim()
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) return null
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/.test(username)) return null
  return { username, key: username.toLowerCase() }
}

export const usernameHint =
  `${USERNAME_MIN}–${USERNAME_MAX} letters or numbers; _ and - may be used inside.`
