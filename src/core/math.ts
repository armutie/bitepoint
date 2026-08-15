/**
 * Numeric primitives matched to the Python sim's semantics.
 *
 * Most of the arithmetic in the port is plain IEEE-754 and needs no help. These
 * four do, because Python and JavaScript genuinely disagree about them, and each
 * disagreement is silent — the code runs and returns a plausible wrong number.
 */

/** ``np.clip``. */
export function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

/**
 * Python's ``%`` for floats, which is **not** JavaScript's.
 *
 * JS `%` is truncated (the result takes the sign of the dividend), Python's is
 * floored (it takes the sign of the divisor). So `-1 % 360` is `-1` in JS and
 * `359` in Python. Every wrap in the sim — lap arc length, heading angles —
 * depends on the Python behaviour, and gets it only via this function.
 */
export function pyMod(a: number, n: number): number {
  const r = a % n
  if (r !== 0 && r < 0 !== n < 0) return r + n
  return r
}

/** Wrap an angle to (-pi, pi]. Mirrors ``racing.car._wrap_angle``. */
export function wrapAngle(a: number): number {
  return pyMod(a + Math.PI, 2.0 * Math.PI) - Math.PI
}

/**
 * ``math.copysign``.
 *
 * `Math.sign` is not a substitute: it returns 0 for zero inputs, where copysign
 * returns ±1, and it does not distinguish -0 from +0.
 */
export function copysign(magnitude: number, sign: number): number {
  const m = Math.abs(magnitude)
  return sign < 0 || Object.is(sign, -0) ? -m : m
}

/**
 * ``np.interp`` for a strictly increasing ``xs``, clamped at both ends.
 *
 * The slope-first evaluation order is deliberate: it is what NumPy does, and
 * reordering it changes the last bits of the result.
 */
export function interp(x: number, xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length
  if (n === 0) return NaN
  if (x <= xs[0]!) return ys[0]!
  if (x >= xs[n - 1]!) return ys[n - 1]!

  // Binary search for the bracketing interval.
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid]! <= x) lo = mid
    else hi = mid
  }

  const x0 = xs[lo]!
  const x1 = xs[lo + 1]!
  const y0 = ys[lo]!
  const y1 = ys[lo + 1]!
  if (x0 === x1) return y0
  const slope = (y1 - y0) / (x1 - x0)
  return slope * (x - x0) + y0
}
