/**
 * Dev-only harness: watch a field of `LineFollower`s actually race.
 *
 * Not part of the game bundle — reached only via /race-lab.html on the dev
 * server. `raceBench` answers "how fast, how much contact, how far off the
 * line" in numbers, and numbers are the right tool for a regression. They are
 * the wrong tool for the question this answers, which is what the driving LOOKS
 * like: whether a car turns in early, whether it is slow because it lifted or
 * because it ran wide, whether two cars touching was a racing incident or one
 * of them driving into the other. Every fault fixed in the follower so far was
 * found by looking at what it did rather than at what it scored.
 *
 * This is the real `Race`, stepped at 60 Hz, with the real controller. Nothing
 * is replayed: what is on screen is being decided as it is drawn.
 *
 * URL overrides:
 *
 *   /race-lab.html?track=technical_8&field=1.10,1.05,1.00&laps=5&speed=4
 */
import {
  atCommitment, buildRacingLineSteps, type RacingLine,
} from '../core/racingLine'
import { LineFollower } from '../core/referenceDriver'
import { carLength, handlingPreset, type CarParams } from '../core/carParams'
import { Race } from '../core/race'
import { DT } from '../core/sim'
import { loadManifest, loadTrack, type Track } from '../core/track'

const errBox = document.getElementById('err') as HTMLPreElement
const fail = (msg: string): void => {
  errBox.hidden = false
  errBox.textContent = msg
}
window.addEventListener('error', (e) => fail(`${e.message}\n${e.error?.stack ?? ''}`))

const qs = new URLSearchParams(window.location.search)
const canvas = document.getElementById('view') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!
const el = (id: string): HTMLElement => document.getElementById(id)!
const trackSel = el('track') as HTMLSelectElement
const spreadSel = el('spread') as HTMLSelectElement
const followSel = el('follow') as HTMLSelectElement
const rate = el('rate') as HTMLInputElement
const playBtn = el('play') as HTMLButtonElement
const showLines = el('showLines') as HTMLInputElement
const showTrails = el('showTrails') as HTMLInputElement
const banner = el('banner')
const board = document.querySelector('#board tbody') as HTMLTableSectionElement

/** One colour per grid slot, in pole order. */
const COLOURS = ['#4fc3f7', '#ff8a5c', '#8de07a', '#e07ad0', '#ffd166', '#9aa7ff']

const LAPS = Number(qs.get('laps') ?? 3)
const params = handlingPreset('f1')

interface Car {
  follower: LineFollower
  line: RacingLine
  commitment: number
  /** Recent world positions, for the trail. */
  trail: number[]
  lastLap: number | null
  contactFor: number
}

interface Session {
  track: Track
  race: Race
  cars: Car[]
}

let session: Session | null = null
let playing = true
/** Simulation seconds still owed to the sim, so speed changes stay smooth. */
let owed = 0

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 20]
const TRAIL_TICKS = 260

// --- building -----------------------------------------------------------------

/**
 * Build the shape, yielding to the browser so the page stays alive.
 *
 * The search is half a minute of solid arithmetic and doing it in one call
 * would freeze the tab on a blank canvas for the whole of it. The generator
 * behind `buildRacingLine` exists for exactly this — see `line-lab`.
 */
async function buildShape(track: Track, p: CarParams): Promise<RacingLine> {
  const steps = buildRacingLineSteps(track, p)
  for (;;) {
    const until = performance.now() + 24
    let r = steps.next()
    while (!r.done && performance.now() < until) r = steps.next()
    if (r.done) return r.value
    const s = r.value
    banner.textContent = s.stage === 'seed'
      ? 'building the racing line — relaxing…'
      : `optimising — round ${s.round}, ${s.kept} of ${s.trials} kept,` +
        ` ${s.lapTime.toFixed(2)} s`
    await new Promise((res) => requestAnimationFrame(() => res(null)))
  }
}

async function begin(): Promise<void> {
  session = null
  banner.hidden = false
  const track = await loadTrack(trackSel.value)
  const shape = await buildShape(track, params)
  const commitments = spreadSel.value.split(',').map(Number)

  const race = new Race(
    track,
    commitments.map((_, i) => ({ slot: i, params })),
    { laps: LAPS, trackId: trackSel.value },
  )
  const cars: Car[] = commitments.map((c) => {
    const line = atCommitment(shape, params, c)
    return {
      follower: new LineFollower(params, line), line, commitment: c,
      trail: [], lastLap: null, contactFor: 0,
    }
  })
  session = { track, race, cars }

  followSel.innerHTML = '<option value="-1">Whole circuit</option>'
  commitments.forEach((c, i) => {
    const o = document.createElement('option')
    o.value = String(i)
    o.textContent = `Follow car ${i} (${c.toFixed(2)})`
    followSel.append(o)
  })

  race.beginCountdown()
  banner.hidden = true
  fitView()
}

// --- view ----------------------------------------------------------------------

let scale = 1
let panX = 0
let panY = 0
/** Cached road outline in world space, rebuilt only when the circuit changes. */
let outline: { lx: number[]; ly: number[]; rx: number[]; ry: number[] } | null = null

function buildOutline(track: Track): void {
  const n = 900
  const lx: number[] = []; const ly: number[] = []
  const rx: number[] = []; const ry: number[] = []
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * track.length
    const pose = track.poseAt(s)
    const half = track.halfAt(s)
    const nx = -Math.sin(pose.yaw)
    const ny = Math.cos(pose.yaw)
    lx.push(pose.x + nx * half); ly.push(pose.y + ny * half)
    rx.push(pose.x - nx * half); ry.push(pose.y - ny * half)
  }
  outline = { lx, ly, rx, ry }
}

function fitView(): void {
  if (!session) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(canvas.clientWidth * dpr)
  canvas.height = Math.round(canvas.clientHeight * dpr)
  buildOutline(session.track)
  const o = outline!
  const xs = [...o.lx, ...o.rx]
  const ys = [...o.ly, ...o.ry]
  const minX = Math.min(...xs); const maxX = Math.max(...xs)
  const minY = Math.min(...ys); const maxY = Math.max(...ys)
  const pad = 26 * dpr
  const follow = Number(followSel.value)
  if (follow < 0) {
    scale = Math.min(
      (canvas.width - 2 * pad) / (maxX - minX),
      (canvas.height - 2 * pad) / (maxY - minY),
    )
    panX = canvas.width / 2 - ((minX + maxX) / 2) * scale
    panY = canvas.height / 2 + ((minY + maxY) / 2) * scale
  } else {
    scale = 9 * dpr
  }
}

const sx = (x: number): number => x * scale + panX
const sy = (y: number): number => -y * scale + panY

function draw(): void {
  if (!session || !outline) return
  const { race, cars } = session
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const follow = Number(followSel.value)
  if (follow >= 0) {
    const s = race.sims[follow]!.car.s
    panX = canvas.width / 2 - s.x * scale
    panY = canvas.height / 2 + s.y * scale
  }

  ctx.fillStyle = '#06080b'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Road.
  const o = outline
  ctx.beginPath()
  for (let i = 0; i < o.lx.length; i++) {
    const px = sx(o.lx[i]!); const py = sy(o.ly[i]!)
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
  }
  for (let i = o.rx.length - 1; i >= 0; i--) ctx.lineTo(sx(o.rx[i]!), sy(o.ry[i]!))
  ctx.closePath()
  ctx.fillStyle = '#151b23'
  ctx.fill()
  ctx.strokeStyle = '#2b3746'
  ctx.lineWidth = 1.4 * dpr
  ctx.stroke()

  // Racing lines, if asked for. Every car has its own, but they share a shape,
  // so one is drawn unless the field is running different geometry.
  if (showLines.checked) {
    const line = cars[0]!.line
    ctx.beginPath()
    for (let i = 0; i <= line.x.length; i++) {
      const j = i % line.x.length
      const px = sx(line.x[j]!); const py = sy(line.y[j]!)
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.34)'
    ctx.lineWidth = 1.2 * dpr
    ctx.setLineDash([6 * dpr, 6 * dpr])
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Trails: where each car actually went.
  if (showTrails.checked) {
    for (let k = 0; k < cars.length; k++) {
      const t = cars[k]!.trail
      if (t.length < 4) continue
      ctx.beginPath()
      for (let i = 0; i < t.length; i += 2) {
        const px = sx(t[i]!); const py = sy(t[i + 1]!)
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
      }
      ctx.strokeStyle = COLOURS[k % COLOURS.length]! + '66'
      ctx.lineWidth = 1.6 * dpr
      ctx.stroke()
    }
  }

  // Cars.
  const L = carLength(params)
  const W = params.width
  for (let k = 0; k < cars.length; k++) {
    const s = race.sims[k]!.car.s
    ctx.save()
    ctx.translate(sx(s.x), sy(s.y))
    ctx.rotate(-s.yaw)
    ctx.fillStyle = COLOURS[k % COLOURS.length]!
    ctx.fillRect((-L / 2) * scale, (-W / 2) * scale, L * scale, W * scale)
    // A contact flashes white for a few frames so a touch is not missed at 8x.
    if (cars[k]!.contactFor > 0) {
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2 * dpr
      ctx.strokeRect((-L / 2) * scale, (-W / 2) * scale, L * scale, W * scale)
    }
    ctx.restore()
    if (scale > 3) {
      ctx.fillStyle = '#06080b'
      ctx.font = `${9 * dpr}px ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(k), sx(s.x), sy(s.y))
    }
  }
}

// --- the loop -------------------------------------------------------------------

function step(): void {
  if (!session) return
  const { race, cars } = session
  const actions = race.sims.map((sim, k) => {
    const { steer, pedal } = cars[k]!.follower.next(sim.car.s)
    return { steer, throttle: pedal }
  })
  const results = race.step(actions)
  for (let k = 0; k < race.size; k++) {
    const c = cars[k]!
    const s = race.sims[k]!.car.s
    c.trail.push(s.x, s.y)
    if (c.trail.length > TRAIL_TICKS * 2) c.trail.splice(0, c.trail.length - TRAIL_TICKS * 2)
    if (race.sims[k]!.lapsCompleted > 0) c.follower.flying = true
    if (race.impacts[k]! > 0) c.contactFor = 12
    else if (c.contactFor > 0) c.contactFor--
    const lap = results[k]!.lapCompleted
    if (lap) c.lastLap = lap.time
  }
}

function tick(): void {
  requestAnimationFrame(tick)
  if (!session) return
  const { race } = session

  if (playing) {
    owed += SPEEDS[Number(rate.value)]! / 60
    // A wall-clock guard as well as a tick budget: at 20x on a slow machine the
    // honest thing is to run slow, not to stop painting.
    const until = performance.now() + 12
    let n = 0
    while (owed >= DT && performance.now() < until && n < 4000) {
      if (race.phase === 'finished') break
      step()
      owed -= DT
      n++
    }
    if (owed > 1) owed = 1
  }

  draw()
  readout()
}

function readout(): void {
  if (!session) return
  const { race, cars } = session
  const order = race.standings()
  const leader = order[0]!
  const rows: string[] = []
  for (let pos = 0; pos < order.length; pos++) {
    const k = order[pos]!
    const c = cars[k]!
    const sim = race.sims[k]!
    const s = sim.car.s
    // Metres of track to the leader — the honest measure mid-race, since a
    // time gap is only defined once both have crossed the same point.
    const gap = race.gapToLeader(k)
    rows.push(
      `<tr>` +
      `<td><span class="chip" style="background:${COLOURS[k % COLOURS.length]}"></span>` +
      `${pos + 1}. car ${k}</td>` +
      `<td>${Math.min(sim.lapsCompleted + 1, race.laps)}/${race.laps}</td>` +
      `<td>${(Math.hypot(s.vx, s.vy) * 3.6).toFixed(0)}</td>` +
      `<td>${k === leader ? '—' : gap.toFixed(0) + ' m'}</td>` +
      `<td>${c.lastLap === null ? '—' : c.lastLap.toFixed(2)}</td>` +
      `<td class="${sim.offTrack ? 'off' : c.contactFor > 0 ? 'hit' : ''}">` +
      `${sim.offTrack ? 'OFF' : c.contactFor > 0 ? 'CONTACT' : c.follower.maxLineError.toFixed(1) + ' m'}</td>` +
      `</tr>`,
    )
  }
  board.innerHTML = rows.join('')

  const phase = race.phase
  banner.hidden = phase === 'racing'
  if (phase === 'countdown') banner.textContent = `lights out in ${Math.ceil(race.countdownTicks / 60)}…`
  else if (phase === 'finished') banner.textContent = `flag — ${race.raceTime.toFixed(1)} s`
  playBtn.textContent = phase === 'finished' ? 'Done' : playing ? 'Pause' : 'Play'
  el('rateOut').textContent = `x${SPEEDS[Number(rate.value)]}`
}

// --- wiring ---------------------------------------------------------------------

async function boot(): Promise<void> {
  const manifest = await loadManifest()
  for (const t of manifest) {
    const o = document.createElement('option')
    o.value = t.id
    o.textContent = `${t.label} — ${t.id}`
    trackSel.append(o)
  }
  trackSel.value = qs.get('track') ?? manifest[0]?.id ?? 'balanced_8'
  const field = qs.get('field')
  if (field) {
    const o = document.createElement('option')
    o.value = field
    o.textContent = `From the URL: ${field}`
    spreadSel.prepend(o)
    spreadSel.value = field
  }

  for (const c of [trackSel, spreadSel]) c.addEventListener('change', () => { void begin() })
  followSel.addEventListener('change', fitView)
  const wanted = Number(qs.get('speed'))
  if (Number.isFinite(wanted) && wanted > 0) {
    // Nearest available multiplier rather than an exact one, so the slider and
    // the URL cannot disagree about what speed the race is running at.
    let best = 0
    for (let i = 1; i < SPEEDS.length; i++) {
      if (Math.abs(SPEEDS[i]! - wanted) < Math.abs(SPEEDS[best]! - wanted)) best = i
    }
    rate.value = String(best)
  }
  playBtn.addEventListener('click', () => { playing = !playing })
  el('restart').addEventListener('click', () => { playing = true; void begin() })
  window.addEventListener('resize', fitView)

  await begin()
  tick()
}

boot().catch((e: unknown) => fail(String(e)))
