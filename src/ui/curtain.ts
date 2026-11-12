/**
 * The curtain between the menu and a session.
 *
 * Starting a session does a burst of work on the main thread: the cars are
 * built, their shaders compiled, the ghost and the opponents set up. It used to
 * happen with the menu already gone and nothing drawn yet, so pressing Drive
 * froze the last frame of the menu circuit for a moment. The curtain fades in
 * over the menu first, the work happens behind it, and it fades out once the
 * first frame of the session is on screen.
 */
export class Curtain {
  readonly root: HTMLElement
  private readonly title: HTMLElement
  private readonly context: HTMLElement
  private liftOnFrame = false
  private generation = 0

  constructor(parent: HTMLElement, private readonly fadeMs = 220) {
    this.root = document.createElement('div')
    this.root.className = 'curtain'
    this.root.setAttribute('role', 'status')
    this.root.setAttribute('aria-live', 'polite')
    this.root.style.setProperty('--curtain-ms', `${fadeMs}ms`)

    const inner = document.createElement('div')
    inner.className = 'curtain-inner'
    const kicker = document.createElement('p')
    kicker.className = 'curtain-kicker'
    kicker.textContent = 'Loading'
    this.title = document.createElement('h2')
    this.title.className = 'curtain-title'
    this.context = document.createElement('p')
    this.context.className = 'curtain-context'
    const bar = document.createElement('div')
    bar.className = 'curtain-bar'
    bar.append(document.createElement('span'))
    inner.append(kicker, this.title, this.context, bar)
    this.root.append(inner)
    parent.append(this.root)
  }

  get covering(): boolean {
    return this.root.classList.contains('is-on')
  }

  /**
   * Fade in and resolve once fully opaque and painted, so whatever the caller
   * does next happens out of sight. Already covering resolves at once.
   */
  async cover(title: string, context: string): Promise<void> {
    const generation = ++this.generation
    this.liftOnFrame = false
    this.title.replaceChildren(title, period())
    this.context.textContent = context
    if (this.covering) return
    this.root.classList.add('is-on')
    await wait(this.fadeMs + 30)
    // Two frames: one to paint the opaque curtain, one to be sure it was.
    if (generation === this.generation) await frames(2)
  }

  /** Fade out after the next frame is drawn — call when the session is ready. */
  liftAfterFrame(): void {
    if (this.covering) this.liftOnFrame = true
  }

  /** Fade out now: a start that went back to the menu instead. */
  lift(): void {
    this.generation++
    this.liftOnFrame = false
    this.root.classList.remove('is-on')
  }

  /** Call straight after the loop draws a session frame. */
  afterFrame(): void {
    if (!this.liftOnFrame) return
    this.liftOnFrame = false
    // One more frame, so the picture under the curtain is the settled one.
    void frames(1).then(() => this.lift())
  }
}

function period(): HTMLElement {
  const s = document.createElement('span')
  s.className = 'flow-period'
  s.textContent = '.'
  return s
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Wait `n` animation frames, or give up after 100 ms when nothing paints. */
function frames(n: number): Promise<void> {
  return new Promise(resolve => {
    let left = n
    let done = false
    const finish = (): void => { if (!done) { done = true; resolve() } }
    const step = (): void => { if (--left <= 0) finish(); else requestAnimationFrame(step) }
    requestAnimationFrame(step)
    setTimeout(finish, 100 * n)
  })
}
