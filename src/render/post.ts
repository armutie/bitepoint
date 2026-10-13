/** Restrained analogue onboard picture: scanlines, signal grain and sparse static dropouts. */
import * as THREE from 'three'
import { TvSignal } from './tvSignal'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'

const BLOOM_STRENGTH = 0.24

const CompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSpeed: { value: 0 },
    uSunScreen: { value: new THREE.Vector3(0.5, 0.5, 0) },
    /** 1 = clean render: no blur, CA, halation, grain or vignette. */
    uFlat: { value: 0 },
    /** Device pixels, so grain size is physical rather than fractional. */
    uResolution: { value: new THREE.Vector2(1, 1) },
    /** Frame counter — jitters the noise field so it never repeats. */
    uFrame: { value: 0 },
    uTvTime: { value: 0 },
    uSpecks: { value: 0 },
    /** Static band centre, half-height in pixels, intensity, event seed. */
    uStatic: { value: new THREE.Vector4(0.5, 4, 0, 0) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uSpeed;
    uniform vec3 uSunScreen;
    uniform float uFlat;
    uniform vec2 uResolution;
    uniform float uFrame;
    uniform float uTvTime;
    uniform float uSpecks;
    uniform vec4 uStatic;
    varying vec2 vUv;

    // Hoskins hash. No sin, so none of the diagonal moiré the sin-based one
    // shows at grain scales.
    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // Smooth value noise: grain that CLUMPS, instead of salt-and-pepper.
    float vnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
        mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x),
        f.y
      );
    }

    void main() {
      vec2 centre = vec2(0.5, 0.46); // where the road vanishes
      vec2 toC = vUv - centre;
      float dist = length(toC);
      float live = 1.0 - uFlat;

      // Keep the lens effect subpixel where another car fills the image.
      // The earlier speed-scaled smear spread its body and livery over several
      // pixels at the frame edge even when it matched the camera's speed.
      float spread = uSpeed * uSpeed * 0.005 * smoothstep(0.52, 1.05, dist) * live;
      float ca = (0.0002 + 0.0005 * uSpeed) * smoothstep(0.45, 1.0, dist) * live;

      vec2 tvPx = vUv * uResolution;
      float bandDistance = (tvPx.y - uStatic.x * uResolution.y) / max(uStatic.y, 1.0);
      float staticBand = exp(-bandDistance * bandDistance) * uStatic.z * live;
      float rowJitter = (hash12(vec2(floor(tvPx.y), uFrame + uStatic.w)) - 0.5) * staticBand * 8.0;
      float lineWobble = sin(vUv.y * 53.0 + uTvTime * 0.9) * 0.20 + sin(vUv.y * 191.0 - uTvTime * 1.3) * 0.08;
      float trackingTear = (hash12(vec2(uStatic.w, 7.0)) - 0.5) * staticBand * 22.0;
      vec2 signalUv = vUv + vec2((rowJitter + trackingTear + lineWobble * live) / uResolution.x, 0.0);
      // Three colour samples, rather than eighteen repeated taps across the whole image.
      vec2 colourOffset = normalize(toC + 1e-6) * ca;
      vec3 col = vec3(texture2D(tDiffuse, signalUv + colourOffset).r,
                      texture2D(tDiffuse, signalUv).g,
                      texture2D(tDiffuse, signalUv - colourOffset).b);
      // Only the outer image at speed needs motion smear. Preserve the sharp driving corridor.
      if (spread > 0.00002) {
        vec3 middle = texture2D(tDiffuse, signalUv - toC * spread * 0.5).rgb;
        vec3 trailing = texture2D(tDiffuse, signalUv - toC * spread).rgb;
        col = col * 0.5 + middle * 0.3 + trailing * 0.2;
      }
      // Analogue colour bandwidth is lower than luminance bandwidth. Keep the
      // road edges clear while colour spreads slightly sideways, like broadcast video.
      vec3 leftSignal = texture2D(tDiffuse, signalUv - vec2(1.4 / uResolution.x, 0.0)).rgb;
      vec3 rightSignal = texture2D(tDiffuse, signalUv + vec2(2.2 / uResolution.x, 0.0)).rgb;
      vec3 softColour = col * 0.50 + leftSignal * 0.22 + rightSignal * 0.28;
      float sharpY = dot(col, vec3(0.299, 0.587, 0.114));
      float softY = dot(softColour, vec3(0.299, 0.587, 0.114));
      vec3 broadcast = vec3(mix(sharpY, softY, 0.15)) + (softColour - vec3(softY)) * 0.94;
      col = mix(col, broadcast, live * 0.8);

      // Gentle filmic shoulder: lifts mids, rolls off highlights.
      col = col * (1.0 + 0.12 * col) / (1.0 + 0.12);

      float lum = dot(col, vec3(0.299, 0.587, 0.114));

      // Halation: the light bloom has already spread runs warm, as on film
      // where it scatters back off the base.
      float hi = smoothstep(0.55, 1.0, lum);
      col = mix(col, col * vec3(1.06, 0.99, 0.92), hi * 0.6 * live);

      // Fine monochrome receiver noise, mostly quiet; no full-screen snow.
      vec2 px = vUv * uResolution;
      vec2 jitter = vec2(hash12(vec2(uFrame, 11.0)), hash12(vec2(uFrame, 23.0))) * 512.0;
      float receiverNoise = vnoise(px / vec2(1.9, 1.0) + jitter) - 0.5;
      float fineSnow = hash12(floor(px) + jitter * 3.0) - 0.5;
      col += (receiverNoise * 0.018 + fineSnow * 0.009) * live;
      // Scattered receiver flecks arrive in uneven flurries with fully quiet gaps.
      vec2 crackleCell = floor(px / vec2(2.0, 1.4));
      float speckField = 0.3 + 0.7 * vnoise(vUv * vec2(5.0, 3.0) + floor(uTvTime * 0.7));
      float crackle = step(1.0 - 0.0007 * uSpecks * speckField, hash12(crackleCell + jitter));
      float polarity = hash12(crackleCell + vec2(uFrame, 173.0)) < 0.42 ? -0.16 : 0.22;
      col += crackle * polarity * live;
      // Stationary soft scanlines, with a weak phosphor colour bleed.
      float scan = 0.5 + 0.5 * cos(px.y * 3.14159265);
      col *= 1.0 - scan * 0.075 * live;
      float phosphor = mod(floor(px.x), 3.0);
      vec3 grille = phosphor < 1.0 ? vec3(1.0, 0.995, 0.995) : phosphor < 2.0 ? vec3(0.995, 1.0, 0.995) : vec3(0.995, 0.995, 1.0);
      col *= mix(vec3(1.0), grille, live);
      col += vec3(0.0025) * live;
      col *= 1.0 + sin(vUv.y * 8.0 - uTvTime * 0.45) * 0.003 * live;
      col = mix(col, vec3(lum), 0.025 * live);
      // Flecks appear only within a small, briefly disturbed band.
      float staticNoise = hash12(vec2(floor(px.x / 2.5), floor(px.y)) + vec2(uFrame * 7.0, uStatic.w));
      float fragments = smoothstep(0.25, 0.65, vnoise(vec2(px.x / 45.0 + uStatic.w, uFrame * 0.7)));
      col += (staticNoise - 0.38) * staticBand * (0.25 + 0.75 * fragments);

      // The lens reacts to the bright gaps in the actual image, rather than
      // projecting a flare through buildings or opaque cloud.
      if (uSunScreen.z > 0.002) {
      vec2 sunUV = clamp(uSunScreen.xy, vec2(0.002), vec2(0.998));
      vec3 source = texture2D(tDiffuse, sunUV).rgb;
      source = max(source, texture2D(tDiffuse, clamp(sunUV + vec2(0.009, 0.004), 0.002, 0.998)).rgb);
      source = max(source, texture2D(tDiffuse, clamp(sunUV - vec2(0.007, 0.005), 0.002, 0.998)).rgb);
      float sourceLum = dot(source, vec3(0.299, 0.587, 0.114));
      float glowVisible = smoothstep(0.42, 1.35, sourceLum) * uSunScreen.z * live;
      float aspect = uResolution.x / uResolution.y;
      vec2 glareDelta = (vUv - uSunScreen.xy) * vec2(aspect, 1.0);
      float radius = length(glareDelta);
      float veil = exp(-radius * radius * 7.0);
      // Glints vary continuously with lens alignment, never random flashing.
      float glimmer = 0.72 + 0.28 * sin(uSunScreen.x * 39.0 + uSunScreen.y * 23.0);
      float horizontalGlint = exp(-abs(glareDelta.y) * 260.0) * exp(-abs(glareDelta.x) * 12.0);
      float diagonalGlint = exp(-abs(glareDelta.y - glareDelta.x * 0.7) * 340.0) * exp(-radius * 18.0);
      col += vec3(1.0, 0.86, 0.67) * glowVisible * glimmer * (veil * 0.010 + horizontalGlint * 0.16 + diagonalGlint * 0.07);
      // Faint lens-element reflections drift along the sun-to-centre axis.
      vec2 lensAxis = vec2(0.5) - uSunScreen.xy;
      vec2 ghostA = uSunScreen.xy + lensAxis * 1.35;
      vec2 ghostB = uSunScreen.xy + lensAxis * 1.85;
      float ga = length((vUv - ghostA) * vec2(aspect, 1.0));
      float gb = length((vUv - ghostB) * vec2(aspect, 1.0));
      float ghostDisc = exp(-ga * ga / 0.0013);
      float ghostRing = exp(-pow((gb - 0.055) / 0.014, 2.0));
      col += glowVisible * glimmer * (vec3(0.47, 0.65, 0.49) * ghostDisc * 0.035 + vec3(0.85, 0.46, 0.25) * ghostRing * 0.028);

      }

      // Vignette.
      col *= 1.0 - 0.12 * smoothstep(0.35, 1.05, dist * 1.55) * live;

      // Sub-LSB dither, ALWAYS on — invisible as texture, but it breaks the
      // contour rings 8-bit output puts across a big smooth sky gradient.
      col += (hash12(px + uFrame) - 0.5) / 255.0;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
}

export class PostPipeline {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly composer: EffectComposer
  private readonly renderPass: RenderPass
  private readonly bloom: UnrealBloomPass
  private readonly composite: ShaderPass
  private readonly sunDirection = new THREE.Vector3()
  private readonly projectedSun = new THREE.Vector3()
  private readonly viewForward = new THREE.Vector3()
  private frame = 0
  private readonly tvSignal = new TvSignal()
  private lastSignalTime = performance.now()
  private effects = 1
  private performanceMode = false

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer = renderer
    this.scene = scene
    // MSAA must live on the composer's target; canvas antialiasing alone does not cover it.
    const target = new THREE.WebGLRenderTarget(1, 1, {type: THREE.HalfFloatType, samples: 2})
    this.composer = new EffectComposer(renderer, target)
    this.renderPass = new RenderPass(scene, camera)
    // Threshold high enough that only sky, white kerb paint and the gantry
    // glow; a wide radius so it is a soft halo rather than a hard rim.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM_STRENGTH, 0.82, 1.05)
    // Halation, the proper way: the wider the mip, the warmer it runs, so a
    // highlight's tight core stays white while its spread goes amber.
    this.bloom.bloomTintColors = [
      new THREE.Vector3(1.0, 1.0, 1.0),
      new THREE.Vector3(1.0, 0.97, 0.93),
      new THREE.Vector3(1.0, 0.93, 0.84),
      new THREE.Vector3(1.0, 0.88, 0.74),
      new THREE.Vector3(1.0, 0.83, 0.66),
    ]
    this.composite = new ShaderPass(CompositeShader)
    this.composer.addPass(this.renderPass)
    this.composer.addPass(this.bloom)
    this.composer.addPass(this.composite)
    // The composer renders in linear space; without this final conversion to
    // sRGB the whole frame comes out dark and washed.
    this.composer.addPass(new OutputPass())
  }

  setSunDirection(direction: THREE.Vector3): void {
    this.sunDirection.copy(direction).normalize()
  }

  setCamera(camera: THREE.Camera): void {
    this.renderPass.camera = camera
  }

  setSize(w: number, h: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio)
    this.composer.setSize(w, h)
    const u = this.composite.uniforms as Record<string, { value: THREE.Vector2 }>
    u['uResolution']!.value.set(w * pixelRatio, h * pixelRatio)
  }

  /** Camera-effects master, 0..1. At 0 this is a clean render: what pygame
   *  draws, bar the always-on dither. */
  setEffects(amount: number): void {
    const a = Math.max(0, Math.min(1, amount))
    this.effects = a
    this.bloom.strength = BLOOM_STRENGTH * a
    ;(this.composite.uniforms as Record<string, { value: number }>)['uFlat']!.value = 1 - a
  }

  setPerformanceMode(enabled: boolean): void {
    this.performanceMode = enabled
  }

  get active(): boolean {
    return !this.performanceMode && this.effects > 0
  }

  /** @param speed01 current speed over top speed, 0..1; drives the blur */
  render(speed01: number): void {
    // A zero-strength bloom pass is still a bloom pass, and a shader whose
    // visual contribution is zero still samples the frame six times. "Off"
    // and Performance Mode therefore bypass the composer, not merely its look.
    if (!this.active) {
      this.renderer.render(this.scene, this.renderPass.camera)
      return
    }
    const u = this.composite.uniforms as Record<string, { value: number }>
    // Wrapped well inside float precision, and long enough that the jitter
    // sequence has no perceptible period.
    this.frame = (this.frame + 1) % 8192
    u['uFrame']!.value = this.frame
    const now = performance.now()
    u['uTvTime']!.value = (now / 1000) % 4096
    const signal = this.tvSignal.advance(Math.min((now - this.lastSignalTime) / 1000, 0.1))
    this.lastSignalTime = now
    ;(this.composite.uniforms['uStatic']!.value as THREE.Vector4).set(signal.centre, signal.height, signal.strength, signal.seed)
    u['uSpecks']!.value = signal.specks
    u['uSpeed']!.value = Math.max(0, Math.min(speed01, 1))
    const camera = this.renderPass.camera
    camera.getWorldDirection(this.viewForward)
    this.projectedSun.copy(camera.position).addScaledVector(this.sunDirection, 1000).project(camera)
    const sx = this.projectedSun.x * 0.5 + 0.5, sy = this.projectedSun.y * 0.5 + 0.5
    const facing = THREE.MathUtils.smoothstep(this.viewForward.dot(this.sunDirection), 0.65, 0.95)
    const edge = 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(sx - 0.5), Math.abs(sy - 0.5)), 0.44, 0.65)
    ;(this.composite.uniforms['uSunScreen']!.value as THREE.Vector3).set(sx, sy, facing * edge)
    this.composer.render()
  }

  dispose(): void {
    this.composer.dispose()
    this.bloom.dispose()
  }
}
