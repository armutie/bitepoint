/** Sparse, short analogue dropouts; timing is independent of render frame rate. */
export class TvSignal {
  private time = 0
  private next = 3.5
  private start = -1
  private duration = 0
  private centre = 0.5
  private height = 4
  private seed = 0
  private nextSpecks = 0.8
  private speckStart = -1
  private speckDuration = 0
  private speckIntensity = 0
  constructor(private readonly random: () => number = Math.random) {}

  advance(dt: number): { centre: number; height: number; strength: number; seed: number; specks: number } {
    this.time += Math.max(0, dt)
    if (this.time >= this.next) {
      this.start = this.time
      this.duration = 0.065 + this.random() * 0.045
      this.centre = 0.08 + this.random() * 0.84
      this.height = 1.5 + this.random() * 3.5
      this.seed = this.random() * 4096
      this.next = this.time + 3.5 + this.random() * 6
    }
    // Speck flurries have their own rhythm; they do not make tracking tears more frequent.
    if (this.time >= this.nextSpecks) {
      this.speckStart = this.time
      this.speckDuration = 0.10 + this.random() * 0.32
      this.speckIntensity = 0.3 + this.random() * 0.7
      this.nextSpecks = this.time + this.speckDuration + 0.7 + this.random() * 3.0
    }
    const speckPhase = this.time - this.speckStart
    const specks = this.speckStart >= 0 && speckPhase < this.speckDuration
      ? Math.max(0, Math.min(1, speckPhase / 0.025, (this.speckDuration - speckPhase) / 0.04)) * this.speckIntensity
      : 0
    const phase = this.time - this.start
    const envelope = this.start >= 0 && phase < this.duration
      ? Math.min(1, phase / 0.012, (this.duration - phase) / 0.022)
      : 0
    return { centre: this.centre, height: this.height, strength: Math.max(0, envelope) * 0.13, seed: this.seed, specks }
  }
}
