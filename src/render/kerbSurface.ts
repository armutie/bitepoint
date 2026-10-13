import * as THREE from 'three'

/** Directional tyre wear over textured paint; freshness varies independently per side. */
export function weatherKerb(material: THREE.MeshStandardMaterial): void {
  const concrete = new THREE.Color(0x85837a)
  material.onBeforeCompile = shader => {
    shader.uniforms.kerbConcrete = { value: concrete }
    shader.vertexShader = 'attribute vec3 kerbSurface; varying vec3 vKerbSurface;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvKerbSurface = kerbSurface;')
    shader.fragmentShader = `uniform vec3 kerbConcrete; varying vec3 vKerbSurface;
      float kerbHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float kerbNoise(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(kerbHash(i), kerbHash(i + vec2(1.0, 0.0)), f.x), mix(kerbHash(i + vec2(0.0, 1.0)), kerbHash(i + vec2(1.0)), f.x), f.y);
      }
    ` + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      float along = vKerbSurface.x;
      float across = vKerbSurface.y;
      float sideSeed = vKerbSurface.z * 137.0;
      float age = 0.08 + 0.92 * smoothstep(0.25, 0.79, kerbNoise(vec2(along * 0.055, sideSeed)));
      // Warp the lanes and vary their width so wear does not form parallel rails.
      float warp = (kerbNoise(vec2(along * 0.19, sideSeed + 11.0)) - 0.5) * 0.22;
      float lateral = across + warp;
      float widths = kerbNoise(vec2(along * 0.065, sideSeed + 29.0));
      float broad = kerbNoise(vec2(along * 0.095 + sideSeed, lateral * 3.4));
      broad = 0.70 * broad + 0.30 * kerbNoise(vec2(along * 0.24 - sideSeed, lateral * 7.0));
      float dragged = kerbNoise(vec2(along * 0.32 + sideSeed, lateral * mix(6.0, 17.0, widths)));
      float thin = kerbNoise(vec2(along * 0.62 - sideSeed, lateral * 43.0));
      float thinMarks = smoothstep(0.67, 0.90, thin);
      // Slowly changing mixtures create clean, streaked and broadly rubbered sections.
      float smudgeMix = smoothstep(0.28, 0.75, kerbNoise(vec2(along * 0.048, sideSeed + 47.0)));
      float traceMix = kerbNoise(vec2(along * 0.085, sideSeed + 73.0));
      float smudges = smoothstep(0.26, 0.79, broad);
      float traces = smoothstep(0.36, 0.86, dragged);
      float streaks = mix(traces * (0.18 + 0.36 * traceMix), smudges * 0.63, smudgeMix);
      streaks += thinMarks * (0.07 + 0.24 * (1.0 - smudgeMix)) * traceMix;
      float longDrag = broad;
      float edge = 1.0 - smoothstep(0.0, 0.22, across);
      float dirt = edge * (0.2 + 0.8 * kerbNoise(vec2(along * 0.28, sideSeed + across * 8.0)));
      float rubbedPaint = smoothstep(0.64, 0.88, longDrag) * age * (0.18 + 0.55 * edge);
      diffuseColor.rgb = mix(diffuseColor.rgb, kerbConcrete * 0.86, rubbedPaint);
      // Cleaner sections retain gentle dragged paint variation, rather than flat fill.
      float paintDrag = kerbNoise(vec2(along * 0.45 + sideSeed, across * 42.0));
      diffuseColor.rgb *= 0.92 + 0.08 * paintDrag;
      diffuseColor.rgb *= 1.0 - streaks * (0.08 + 0.65 * age) - dirt * (0.12 + 0.16 * age);
    `)
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      // Shallow elongated surface relief survives even on recently painted sections.
      float relief = 0.00025 * kerbNoise(vec2(vKerbSurface.x * 3.7 + vKerbSurface.z * 19.0, vKerbSurface.y * 23.0));
      normal = perturbNormalArb(-vViewPosition, normal, vec2(dFdx(relief), dFdy(relief)), faceDirection);
    `)
  }
  material.customProgramCacheKey = () => 'blended-kerb-v3'
}
