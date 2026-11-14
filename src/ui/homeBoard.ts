import type { LeaderboardEntry } from '../storage/leaderboard'
import { formatTime } from '../storage/records'

/** Where the player stands on one circuit's board. */
export interface Standing {
  /** 1-based, or null when the lap is somewhere below the fetched board. */
  position: number | null
  time: number
  /** A lap on this device that is not on the public board yet. */
  unsaved: boolean
  /** Seconds to the lap one place up, null when already fastest. */
  gap: number | null
}

/**
 * The player's place on a board: their own public entry, or the faster of it
 * and a lap kept on this device. `entries` are fastest first.
 */
export function standing(
  entries: readonly Pick<LeaderboardEntry, 'playerName' | 'time'>[],
  playerName: string | null,
  local: { time: number } | null,
  complete: boolean,
): Standing | null {
  const mine = playerName ? entries.findIndex((e) => e.playerName === playerName) : -1
  const own = mine >= 0 ? entries[mine]! : null
  if (local && (!own || local.time < own.time)) {
    const ahead = entries.filter((e) => e.time < local.time && (!playerName || e.playerName !== playerName))
    const below = !complete && ahead.length === entries.length
    const target = ahead.at(-1)
    return {
      position: below ? null : ahead.length + 1,
      time: local.time,
      unsaved: true,
      gap: below || !target ? null : local.time - target.time,
    }
  }
  if (!own) return null
  const target = entries[mine - 1]
  return { position: mine + 1, time: own.time, unsaved: false, gap: target ? own.time - target.time : null }
}

export interface BoardPage {
  entries: readonly LeaderboardEntry[]
  scope: 'global' | 'personal'
}

export interface HomeBoardOptions {
  tracks: readonly { id: string; label: string }[]
  /** The circuit to show first: the one last driven. */
  start: string
  load: (trackId: string) => Promise<BoardPage>
  /** The player's name on the public board, if they have one. */
  playerName: string | null
  /** A lap on this device not on the board yet, for this circuit. */
  local: (trackId: string, page: BoardPage) => { time: number } | null
  open: (trackId: string) => void
  drive: (trackId: string) => void
  /** Save an unsaved lap on this circuit: sign in, then name. */
  save?: (trackId: string, rank: number | null) => void
  /** The circuit's outline, drawn as the board turns to it. */
  outline?: (trackId: string) => SVGSVGElement | null
}

const ROTATE_MS = 8000
const SHOWN = 3
/** The turn between circuits: outline and name, then the times. Matches the CSS. */
const TURN_MS = 1500

/**
 * The home screen's leaderboard: each circuit's fastest laps in turn, with the
 * player's own place and the gap to the lap above it. Built to bring people
 * back for one more lap, so it opens on the circuit they last drove.
 */
export class HomeBoard {
  readonly root = el('section', 'home-board')
  private index: number
  private timer: ReturnType<typeof setInterval> | null = null
  private held = false
  private readonly name = el('span', 'home-board-track')
  private readonly dots = el('div', 'home-board-dots')
  private readonly body = el('div', 'home-board-body')
  private readonly drive = el('button', 'home-board-drive')
  private request = 0
  private intro: HTMLElement | null = null
  private introTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: HomeBoardOptions) {
    this.index = Math.max(0, opts.tracks.findIndex((t) => t.id === opts.start))
    this.root.setAttribute('aria-label', 'Leaderboard')

    const head = el('header', 'home-board-head')
    const label = el('span', 'home-board-label')
    label.textContent = 'Leaderboard'
    const nav = el('div', 'home-board-nav')
    const prev = el('button', 'home-board-step')
    prev.textContent = '‹'
    prev.setAttribute('aria-label', 'Previous circuit')
    prev.addEventListener('click', () => this.go(this.index - 1))
    const next = el('button', 'home-board-step')
    next.textContent = '›'
    next.setAttribute('aria-label', 'Next circuit')
    next.addEventListener('click', () => this.go(this.index + 1))
    opts.tracks.forEach((track, i) => {
      const dot = el('button', 'home-board-dot')
      dot.setAttribute('aria-label', track.label)
      dot.addEventListener('click', () => this.go(i))
      this.dots.append(dot)
    })
    nav.append(prev, this.dots, next)
    head.append(label, nav)

    const titleRow = el('div', 'home-board-title')
    const open = el('button', 'home-board-open')
    open.textContent = 'Full board →'
    open.addEventListener('click', () => this.opts.open(this.current))
    this.drive.addEventListener('click', () => this.opts.drive(this.current))
    const links = el('div', 'home-board-links')
    links.append(this.drive, open)
    titleRow.append(this.name, links)

    this.body.addEventListener('click', () => this.opts.open(this.current))
    const stage = el('div', 'home-board-stage')
    stage.append(this.body)
    this.root.append(head, titleRow, stage)
    // Reading or pointing at it holds the circuit still.
    for (const [on, off] of [['mouseenter', 'mouseleave'], ['focusin', 'focusout']] as const) {
      this.root.addEventListener(on, () => { this.held = true })
      this.root.addEventListener(off, () => { this.held = false })
    }
    // Every board at once, so turning to the next circuit never waits.
    for (const track of opts.tracks) void opts.load(track.id).catch(() => {})
    this.show()
    this.timer = setInterval(() => {
      // The menu re-renders by replacing its panel; stop once this is gone.
      if (!this.root.isConnected) { this.stop(); return }
      if (!this.held && !document.hidden) this.go(this.index + 1, true)
    }, ROTATE_MS)
  }

  private get current(): string { return this.opts.tracks[this.index]!.id }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private go(i: number, _auto = false): void {
    const n = this.opts.tracks.length
    this.index = ((i % n) + n) % n
    this.turn()
    this.show()
  }

  /**
   * The circuit's outline draws itself with its name, then gives way to the
   * times. Over the rows, not beside them, so the panel never changes size.
   */
  private turn(): void {
    this.intro?.remove()
    if (this.introTimer) clearTimeout(this.introTimer)
    this.root.classList.remove('is-turning')
    void this.root.offsetWidth // restart the animations on a quick second turn
    this.root.classList.add('is-turning')
    const track = this.opts.tracks[this.index]!
    const map = this.opts.outline?.(track.id) ?? null
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (map && !reduced) {
      // A path length of one makes the drawing a 1 to 0 dash offset, whatever the circuit.
      for (const path of map.querySelectorAll('path')) path.setAttribute('pathLength', '1')
      const intro = el('div', 'home-board-intro')
      const frame = el('div', 'home-board-intro-map')
      frame.append(map)
      const name = el('span', 'home-board-intro-name')
      name.textContent = track.label
      intro.append(frame, name)
      this.body.before(intro)
      this.intro = intro
    }
    this.introTimer = setTimeout(() => {
      this.intro?.remove(); this.intro = null
      this.root.classList.remove('is-turning')
    }, TURN_MS)
  }

  private show(): void {
    const track = this.opts.tracks[this.index]!
    this.name.textContent = track.label
    this.drive.textContent = 'Drive it →'
    this.drive.setAttribute('aria-label', `Drive ${track.label}`)
    ;[...this.dots.children].forEach((dot, i) => dot.classList.toggle('is-on', i === this.index))
    const request = ++this.request
    this.opts.load(track.id).then((page) => {
      if (request === this.request) this.paint(track.label, page)
    }, () => {
      if (request !== this.request) return
      this.body.replaceChildren(note('Leaderboard unavailable right now.'))
    })
  }

  /**
   * The top three, then YOU as a row of the same list: your place, your time,
   * and what it takes to move up. In the top three, your own row lights up.
   */
  private paint(label: string, page: BoardPage): void {
    const local = this.opts.local(this.current, page)
    const place = standing(page.entries, this.opts.playerName, local, page.entries.length < 50)
    const list = el('ol', 'home-board-rows')
    let shownYou = false
    for (const [i, entry] of page.entries.slice(0, SHOWN).entries()) {
      // Not when a faster lap on this device has replaced their public one.
      const you = !!this.opts.playerName && entry.playerName === this.opts.playerName && !place?.unsaved
      shownYou ||= you
      list.append(boardRow(String(i + 1), entry.playerName, formatTime(entry.time), you ? youNote(place) : '', you))
    }
    if (!shownYou) {
      // Fourth is the next row down, not a gap: one continuous list.
      if (page.entries.length && place?.position !== SHOWN + 1) list.append(el('li', 'home-board-gap'))
      const row = place
        ? boardRow(place.position === null ? '—' : String(place.position), 'You', formatTime(place.time), youNote(place), true)
        : boardRow('—', 'You', '—:——.———', page.entries.length ? 'No lap here yet' : `Set the first lap on ${label}`, true, true)
      if (place?.unsaved && this.opts.save) {
        const save = el('button', 'home-board-save')
        save.textContent = 'Save with Google →'
        const trackId = this.current
        save.addEventListener('click', (event) => {
          event.stopPropagation()
          this.opts.save?.(trackId, place.position)
        })
        row.querySelector('.home-board-detail')?.replaceChildren(save)
        if (!row.querySelector('.home-board-detail')) row.querySelector('.home-board-name')?.append(save)
      }
      list.append(row)
    }
    this.body.replaceChildren(list)
  }
}

/** What the player's row says beside their name. */
function youNote(place: Standing | null): string {
  if (!place) return ''
  if (place.position === null) return place.unsaved ? 'Not on the board yet' : ''
  const gap = place.gap === null
    ? place.position === 1 ? 'Fastest' : ''
    : `+${place.gap.toFixed(3)} to P${place.position - 1}`
  return place.unsaved ? '' : gap
}

function boardRow(rank: string, name: string, time: string, detail: string, you: boolean, empty = false): HTMLElement {
  const row = el('li', 'home-board-row')
  row.classList.toggle('is-you', you)
  row.classList.toggle('is-empty', empty)
  const r = el('span', 'home-board-rank')
  r.textContent = rank
  const who = el('span', 'home-board-name')
  who.textContent = name
  if (you) {
    const tag = el('span', 'home-board-tag')
    tag.textContent = name === 'You' ? '' : 'You'
    if (tag.textContent) who.append(' ', tag)
    if (detail) {
      const d = el('span', 'home-board-detail')
      d.textContent = detail
      who.append(d)
    }
  }
  const t = el('span', 'home-board-time')
  t.textContent = time
  row.append(r, who, t)
  return row
}

function note(text: string): HTMLElement {
  const p = el('p', 'home-board-note')
  p.textContent = text
  return p
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}
