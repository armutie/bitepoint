/**
 * The colours a field is painted in, and nothing else.
 *
 * Its own module because two very different places need the same list: the
 * renderer, which builds cars out of them, and the HUD, which puts a matching
 * chip beside each name on the order board. A chip that does not match the car
 * it stands for is worse than no chip, so the list has to have one home — and
 * that home cannot be the renderer, because the HUD would then be importing
 * three.js to find out what colour something is.
 */
export interface Livery {
  body: number
  accent: number
}

/** The player, who is never one of the field. */
export const PLAYER_LIVERY: Livery = { body: 0x2f6fd0, accent: 0xe8eef7 }

/** One each, so no two cars on a grid look alike. */
export const FIELD_LIVERIES: readonly Livery[] = [
  { body: 0xb03028, accent: 0xf2e9e4 },
  { body: 0xc2c8d0, accent: 0x23262c },
  { body: 0x24262b, accent: 0xe08a20 },
  { body: 0xd8b23a, accent: 0x1e2126 },
  { body: 0x2c6e4f, accent: 0xe8ecef },
  { body: 0x2a4d8f, accent: 0xd9dee6 },
  { body: 0x7c3f8c, accent: 0xf0e6f4 },
  { body: 0xe0e4e8, accent: 0xb03028 },
  { body: 0x1f6f78, accent: 0xe8d9a0 },
  { body: 0xc2601c, accent: 0x1a1c20 },
]

/** A livery's body colour as CSS, for anything drawn in the DOM. */
export const liveryCss = (livery: Livery): string =>
  `#${livery.body.toString(16).padStart(6, '0')}`

/** The colour of the nth car in a field, wrapping if the field is bigger. */
export const fieldLivery = (i: number): Livery =>
  FIELD_LIVERIES[i % FIELD_LIVERIES.length]!
