export interface TrackLimitsEvent {
  offence: number
  seconds: number
}

/** One offence per excursion; half a second back on track rearms the detector. */
export class TrackLimits {
  offences = 0
  penaltySeconds = 0
  lastEvent: TrackLimitsEvent | null = null
  private excursion = false
  private onTrackTicks = 0

  update(offTrack: boolean, active = true): TrackLimitsEvent | null {
    if (!active) return null
    if (!offTrack) {
      if (++this.onTrackTicks >= 30) this.excursion = false
      return null
    }
    this.onTrackTicks = 0
    if (this.excursion) return null
    this.excursion = true
    this.offences++
    const seconds = this.offences <= 2 ? 0 : this.offences === 3 ? 3 : 5
    this.penaltySeconds += seconds
    this.lastEvent = { offence: this.offences, seconds }
    return this.lastEvent
  }
}
