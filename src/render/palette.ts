/**
 * The colour palette, taken from ``racing/render3d.py`` rather than invented.
 *
 * Those colours were authored and iterated against the same circuits this
 * renderer draws, and the first web palette drifted from them in ways that
 * changed the whole read of the scene — barriers went red (which is the KERB
 * colour, so the world looked dressed in kerb paint) and the grass went light
 * and yellowish, which is most of why it read as a golf course.
 *
 * Values are the Python constants converted to hex. Names kept the same so the
 * two files can be diffed by eye.
 */

const rgb = (r: number, g: number, b: number): number => (r << 16) | (g << 8) | b

export const PALETTE = {
  // Sky. Zenith and horizon; the fog must match the horizon or the far road
  // dissolves into a colour the sky does not contain.
  SKY_TOP: rgb(96, 140, 190),
  SKY_BOT: rgb(168, 196, 220),

  GRASS: rgb(38, 92, 46),
  TARMAC: rgb(58, 60, 66),
  TARMAC_FAR: rgb(44, 46, 52),

  GRAVEL: rgb(152, 143, 128),

  // Barriers: grey and blue segments under a sunlit crest rail.
  BARRIER_A: rgb(156, 161, 168),
  BARRIER_B: rgb(48, 80, 128),
  BARRIER_CREST: rgb(206, 210, 216),

  KERB_A: rgb(212, 64, 58),
  KERB_B: rgb(235, 235, 238),

  /** Track-limit line painted on the boundary (grey-white). */
  LIMIT: rgb(188, 190, 196),

  START_LIGHT: rgb(238, 240, 244),
  START_DARK: rgb(28, 30, 36),

  /** Transverse tarmac seams — the speed cue on straights. */
  SEAM: rgb(80, 82, 92),

  GRID_PAINT: rgb(216, 218, 224),

  GANTRY_LEG: rgb(46, 49, 56),
  GANTRY_BANNER: rgb(188, 44, 42),
  GANTRY_STRIPE: rgb(232, 234, 238),

  PIT_WALL: rgb(78, 82, 90),
  PIT_DECK: rgb(168, 172, 180),

  /** Brake boards: amber for the earlier (50 m) board, red for the last (20 m). */
  BRAKE_POST: rgb(54, 57, 64),
  BRAKE_ACCENT_FAR: rgb(232, 150, 40),
  BRAKE_ACCENT_NEAR: rgb(214, 58, 50),

  TRUNK: rgb(74, 52, 36),
  TREES: [rgb(36, 86, 44), rgb(46, 102, 52), rgb(30, 78, 40), rgb(54, 112, 60)],

  STAND_CONCRETE: rgb(110, 114, 122),
  STAND_ROOF: rgb(60, 64, 72),
  /** Crowd blocks on the risers — team colours, shirts, empty seats. */
  CROWD: [rgb(196, 60, 54), rgb(60, 110, 190), rgb(230, 230, 235), rgb(50, 54, 62), rgb(240, 200, 60)],
} as const
