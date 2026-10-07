/** Keyboard clutch procedure. No changes to the car's handling once launched. */
export class RaceLaunch {
  state: 'clutch' | 'throttle' | 'ready' | 'early' | 'launched' = 'clutch'
  private wasThrottle = false

  update(clutch: boolean, throttle: boolean, green: boolean): void {
    const pressedThrottle = throttle && !this.wasThrottle
    this.wasThrottle = throttle
    if (this.state === 'launched') return
    if (this.state === 'clutch' || this.state === 'early') {
      if (clutch) this.state = pressedThrottle ? 'ready' : 'throttle'
    } else if (this.state === 'throttle') {
      if (!clutch) this.state = 'clutch'
      else if (pressedThrottle) this.state = 'ready'
    } else if (!clutch) {
      this.state = green && throttle ? 'launched' : 'early'
    } else if (!throttle) this.state = 'throttle'
  }

  get message(): string {
    switch (this.state) {
      case 'clutch': return 'HOLD R · CLUTCH'
      case 'throttle': return 'KEEP R HELD · PRESS AND HOLD W'
      case 'ready': return 'HOLD R + W · RELEASE R WHEN THE LIGHTS GO OUT'
      case 'early': return 'EARLY RELEASE · HOLD R, THEN PRESS W AGAIN'
      case 'launched': return ''
    }
  }
}
