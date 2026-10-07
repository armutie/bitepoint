import { formatTime } from '../storage/records'

export interface FinishRow {
  position: number
  name: string
  colour: string
  isPlayer: boolean
  finishedAt: number | null
  bestLap: number | null
  penaltySeconds?: number
}

export interface FinishResult {
  position: number
  field: number
  raceTime: number
  penaltySeconds?: number
  bestLap: number | null
  track: string
  car: string
  laps: number
  rows: FinishRow[]
}

/** The brief flag moment and the separate, final results screen. */
export class RaceFinish {
  readonly root: HTMLElement
  onRestart: () => void = () => {}
  onQuit: () => void = () => {}

  private readonly flagPlace: HTMLElement
  private readonly place: HTMLElement
  private readonly meta: HTMLElement
  private readonly time: HTMLElement
  private readonly best: HTMLElement
  private readonly rows: HTMLElement
  private readonly note: HTMLElement

  constructor() {
    const root = document.createElement('div')
    root.className = 'race-finish is-hidden'
    root.innerHTML = `
      <div class="race-finish-flag" role="status">
        <div class="race-finish-checks"></div>
        <span class="eyebrow">Race complete</span>
        <h1>Chequered flag</h1>
        <div class="race-finish-flag-place"></div>
        <div class="race-finish-checks"></div>
      </div>
      <main class="race-finish-results" aria-label="Race results">
        <div class="race-finish-results-inner">
          <header class="race-finish-header">
            <span class="eyebrow">Chequered flag</span>
            <h1>Race results</h1>
            <p class="race-finish-meta"></p>
          </header>
          <div class="race-finish-summary">
            <div class="race-finish-summary-place"><span>Finished</span><strong class="race-finish-place"></strong></div>
            <div><span>Race time</span><strong class="race-finish-time"></strong></div>
            <div><span>Best lap</span><strong class="race-finish-best"></strong></div>
          </div>
          <section class="race-finish-classification" aria-label="Classification">
            <h2>Classification</h2>
            <div class="race-finish-table-head"><span>Pos</span><span>Driver</span><span>Time / status</span><span>Best lap</span></div>
            <div class="race-finish-rows"></div>
            <p class="race-finish-note"></p>
          </section>
          <div class="race-finish-actions">
            <button class="btn btn-primary" type="button" data-action="restart">Race again</button>
            <button class="btn" type="button" data-action="quit">Main menu</button>
          </div>
        </div>
      </main>`
    this.root = root
    this.flagPlace = root.querySelector('.race-finish-flag-place')!
    this.place = root.querySelector('.race-finish-place')!
    this.meta = root.querySelector('.race-finish-meta')!
    this.time = root.querySelector('.race-finish-time')!
    this.best = root.querySelector('.race-finish-best')!
    this.rows = root.querySelector('.race-finish-rows')!
    this.note = root.querySelector('.race-finish-note')!
    root.querySelector('[data-action="restart"]')!.addEventListener('click', () => this.onRestart())
    root.querySelector('[data-action="quit"]')!.addEventListener('click', () => this.onQuit())
  }

  showFlag(position: number, field: number, penaltySeconds = 0): void {
    this.flagPlace.textContent = penaltySeconds > 0
      ? `On-road P${position} / ${field} · +${penaltySeconds}s penalty`
      : `P${position} / ${field}`
    this.root.classList.remove('is-hidden', 'is-results')
    this.root.classList.add('is-flag')
  }

  showResults(result: FinishResult): void {
    this.place.textContent = `P${result.position} / ${result.field}`
    this.meta.textContent = `${result.track} · ${result.car} · ${result.laps} ${result.laps === 1 ? 'lap' : 'laps'}`
    if (result.penaltySeconds) this.meta.textContent += ` · +${result.penaltySeconds}s time penalty`
    this.time.textContent = formatTime(result.raceTime)
    this.best.textContent = formatTime(result.bestLap)
    this.rows.replaceChildren(...result.rows.map((entry) => {
      const row = document.createElement('div')
      row.className = `race-finish-row${entry.isPlayer ? ' is-player' : ''}`
      const pos = document.createElement('span')
      pos.textContent = String(entry.position).padStart(2, '0')
      const driver = document.createElement('span')
      driver.className = 'race-finish-driver'
      const chip = document.createElement('i')
      chip.style.backgroundColor = entry.colour
      const name = document.createElement('span')
      name.textContent = entry.name
      driver.append(chip, name)
      const status = document.createElement('span')
      status.textContent = entry.finishedAt === null ? 'On track' : formatTime(entry.finishedAt)
      if (entry.penaltySeconds) status.textContent += ` (+${entry.penaltySeconds}s)`
      const best = document.createElement('span')
      best.textContent = formatTime(entry.bestLap)
      row.append(pos, driver, status, best)
      return row
    }))
    this.note.textContent = result.rows.some((entry) => entry.finishedAt === null)
      ? 'Other cars still on track are shown in their current order.' : ''
    if (result.rows.some((entry) => entry.penaltySeconds)) {
      this.note.textContent = `Times include track-limits penalties. ${this.note.textContent}`.trim()
    }
    this.root.classList.remove('is-hidden', 'is-flag')
    this.root.classList.add('is-results')
    this.root.querySelector<HTMLButtonElement>('[data-action="restart"]')?.focus()
  }

  hide(): void {
    this.root.classList.add('is-hidden')
    this.root.classList.remove('is-flag', 'is-results')
  }
}
