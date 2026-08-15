/**
 * Post-processing: the difference between "3D render" and "footage".
 *
 * The clean render is what puts this in the uncanny valley — crisp edges,
 * perfect flat colour, infinite depth of field. Real onboard footage has none
 * of those. What is faked here is the camera, not the world.
 *
 * **What the first grain got wrong**, and why it read as dots and patterns
 * laid over the screen rather than grain inside an image:
 *
 *  - the time seed was `fract(uTime)`, so the entire noise field **repeated
 *    once a second**. Noise that recurs on a beat stops being noise.
 *  - the hash was the classic `fract(sin(dot(p, k)) * 43758.5)`, whose
 *    periodicity shows as faint **diagonal moiré** at grain scales. That is
 *    the "patterns" you can see if you look closely.
 *  - it was per-pixel white noise: salt-and-pepper **dots**. Real grain is
 *    silver crystals with *size* — it clumps, at a scale fixed in device
 *    pixels rather than shrinking to dust on a dense display.
 *  - it was strongest in the shadows. Film grain peaks in the **midtones**
 *    and vanishes toward both black and white.
 *  - it was monochrome. Real grain sits in three emulsion layers, so it
 *    carries faint colour.
 *
 * All five are fixed below. Bloom gains **halation** — the warm spread film
 * gets from light scattering back off the base — by tinting the wider mips
 * progressively warmer, so a highlight's core stays white while its glow runs
 * amber. And a sub-LSB dither runs always, even in the clean mode, because
 * 8-bit output otherwise puts contour rings across the sky gradient.
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'

const BLOOM_STRENGTH = 0.28

const CompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSpeed: { value: 0 },
    /** 1 = clean render: no blur, CA, halation, grain or vignette. */
    uFlat: { value: 0 },
    /** Device pixels, so grain size is physical rather than fractional. */
    uResolution: { value: new THREE.Vector2(1, 1) },
    /** Frame counter — jitters the noise field so it never repeats. */
    uFrame: { value: 0 },
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
    uniform float uFlat;
    uniform vec2 uResolution;
    uniform float uFrame;
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

      // Radial blur, quadratic in speed and EDGE-ONLY: starting the falloff
      // near frame centre is the onset pattern of tunnel vision, and reads as
      // about-to-faint rather than fast.
      float spread = uSpeed * uSpeed * 0.05 * smoothstep(0.52, 1.05, dist) * live;
      float ca = (0.0006 + 0.002 * uSpeed) * smoothstep(0.45, 1.0, dist) * live;

      vec3 acc = vec3(0.0);
      const int TAPS = 6;
      for (int i = 0; i < TAPS; i++) {
        float t = float(i) / float(TAPS - 1);
        vec2 base = vUv - toC * spread * t;
        vec2 off = normalize(toC + 1e-6) * ca;
        acc.r += texture2D(tDiffuse, base + off).r;
        acc.g += texture2D(tDiffuse, base).g;
        acc.b += texture2D(tDiffuse, base - off).b;
      }
      vec3 col = acc / float(TAPS);

      // Gentle filmic shoulder: lifts mids, rolls off highlights.
      col = col * (1.0 + 0.12 * col) / (1.0 + 0.12);

      float lum = dot(col, vec3(0.299, 0.587, 0.114));

      // Halation: the light bloom has already spread runs warm, as on film
      // where it scatters back off the base.
      float hi = smoothstep(0.55, 1.0, lum);
      col = mix(col, col * vec3(1.06, 0.99, 0.92), hi * 0.6 * live);

      // --- film grain ---
      vec2 px = vUv * uResolution;
      // A fresh region of the noise field every frame: no repeat, ever.
      vec2 jitter = vec2(hash12(vec2(uFrame, 11.0)), hash12(vec2(uFrame, 23.0))) * 512.0;
      // Cell size in DEVICE pixels — the crystals are a physical size, so they
      // do not turn to dust on a dense display.
      float cell = 1.7;
      vec3 g = vec3(
        vnoise(px / cell + jitter),
        vnoise(px / cell + jitter + vec2(17.3, 5.1)),
        vnoise(px / cell + jitter + vec2(3.7, 29.9))
      ) - 0.5;
      // A coarser octave over the top, so the grain has structure rather than
      // one frequency — this is what stops it reading as a dot screen.
      g += (vnoise(px / (cell * 3.1) + jitter * 0.7) - 0.5) * 0.45;
      // Peaks in the midtones, vanishes toward black and toward white.
      float response = 4.0 * lum * (1.0 - lum);
      col += g * 0.055 * mix(0.25, 1.0, response) * live;

      // Vignette.
      col *= 1.0 - 0.3 * smoothstep(0.35, 1.05, dist * 1.55) * live;

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
  private frame = 0
  private effects = 1
  private performanceMode = false

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer = renderer
    this.scene = scene
    this.composer = new EffectComposer(renderer)
    this.renderPass = new RenderPass(scene, camera)
    // Threshold high enough that only sky, white kerb paint and the gantry
    // glow; a wide radius so it is a soft halo rather than a hard rim.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM_STRENGTH, 0.75, 0.75)
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
    u['uSpeed']!.value = Math.max(0, Math.min(speed01, 1))
    this.composer.render()
  }

  dispose(): void {
    this.composer.dispose()
    this.bloom.dispose()
  }
}
