import type * as THREE from 'three'

interface TimerExtension { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
/** Optional development instrumentation. Queries are polled asynchronously, never waited on. */
export class RenderProfiler {
  private readonly extension: TimerExtension | null
  private readonly pending: WebGLQuery[] = []
  private active: WebGLQuery | null = null
  private frame = 0
  private cpu: number[] = []
  private intervals: number[] = []
  private gpu: number[] = []
  private readonly panel: HTMLDivElement
  private lastReport = 0
  constructor(private readonly gl: WebGL2RenderingContext) {
    this.extension = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null
    this.panel = document.createElement('div'); this.panel.id = 'render-profile'
    this.panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:10000;pointer-events:none;background:#10151de8;color:#dce8d4;padding:10px;font:12px monospace;white-space:pre;border-radius:5px'
    document.body.append(this.panel)
  }
  begin(): void {
    const ext = this.extension
    if (!ext) return
    if (this.gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      for (const q of this.pending) this.gl.deleteQuery(q)
      this.pending.length = 0; this.gpu.length = 0
    } else while (this.pending.length && this.gl.getQueryParameter(this.pending[0]!, this.gl.QUERY_RESULT_AVAILABLE)) {
      const q = this.pending.shift()!
      this.gpu.push(this.gl.getQueryParameter(q, this.gl.QUERY_RESULT) / 1e6)
      if (this.gpu.length > 60) this.gpu.shift()
      this.gl.deleteQuery(q)
    }
    if (++this.frame % 8 === 0 && this.pending.length < 4) {
      this.active = this.gl.createQuery()
      if (this.active) this.gl.beginQuery(ext.TIME_ELAPSED_EXT, this.active)
    }
  }
  end(cpuMs: number, dt: number, renderer: THREE.WebGLRenderer): void {
    if (this.active && this.extension) {
      this.gl.endQuery(this.extension.TIME_ELAPSED_EXT); this.pending.push(this.active); this.active = null
    }
    this.cpu.push(cpuMs); this.intervals.push(dt * 1000)
    if (this.cpu.length > 120) { this.cpu.shift(); this.intervals.shift() }
    const now = performance.now()
    if (now - this.lastReport < 500) return
    this.lastReport = now
    const median = (a: number[]) => a.length ? a.slice().sort((a,b)=>a-b)[Math.floor(a.length/2)]!.toFixed(2) : '--'
    const p95 = (a: number[]) => a.length ? a.slice().sort((a,b)=>a-b)[Math.floor((a.length-1)*0.95)]!.toFixed(2) : '--'
    const info = renderer.info.render
    this.panel.textContent = `CPU median/P95: ${median(this.cpu)} / ${p95(this.cpu)} ms\nGPU median/P95: ${this.extension ? median(this.gpu)+' / '+p95(this.gpu)+' ms' : 'unavailable'}\nFrame median/P95: ${median(this.intervals)} / ${p95(this.intervals)} ms\nDraws: ${info.calls}  triangles: ${info.triangles}\nBuffer: ${renderer.domElement.width} x ${renderer.domElement.height}\nF8: hide profiler`
  }
  dispose(): void {
    if (this.active && this.extension) this.gl.endQuery(this.extension.TIME_ELAPSED_EXT)
    for (const query of [...this.pending, ...(this.active ? [this.active] : [])]) this.gl.deleteQuery(query)
    this.panel.remove()
  }
}
