import * as THREE from 'three'
import type { Track } from '../core/track'
import { bakeRoadSurfaceMask } from './roadSurfaceMask'
import { bakeRoadScuffDetail } from './roadScuffDetail'
export { roadWearAt } from './roadSurfaceMask'

/** One precomputed surface sample replaces the old rubber mask and fragment noise. */
export function makeRubberTexture(track:Track):THREE.DataTexture {
 const baked=bakeRoadSurfaceMask(track)
 const texture=new THREE.DataTexture(baked.data,baked.width,baked.height,THREE.RGBAFormat)
 texture.wrapS=THREE.ClampToEdgeWrapping;texture.wrapT=THREE.RepeatWrapping
 texture.magFilter=THREE.LinearFilter;texture.minFilter=THREE.LinearMipmapLinearFilter
 texture.generateMipmaps=true;texture.colorSpace=THREE.NoColorSpace;texture.anisotropy=8;texture.needsUpdate=true
 texture.userData.roadSpan=baked.span
 return texture
}

export function makeRoadScuffTexture():THREE.DataTexture {
 const texture=new THREE.DataTexture(bakeRoadScuffDetail(),512,512,THREE.RGBAFormat)
 texture.wrapS=texture.wrapT=THREE.RepeatWrapping
 texture.magFilter=THREE.LinearFilter;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.generateMipmaps=true
 texture.colorSpace=THREE.NoColorSpace;texture.anisotropy=8;texture.needsUpdate=true
 return texture
}

/** Lap-aligned appearance remains part of the road material, with no overlay geometry. */
export function applyRoadWear(material:THREE.MeshStandardMaterial,surface:THREE.Texture,lapLength:number,detail:THREE.Texture):void {
 material.onBeforeCompile=shader=>{
  shader.uniforms.roadSurface={value:surface};shader.uniforms.roadSpan={value:surface.userData.roadSpan}
  shader.uniforms.roadScuffs={value:detail};shader.uniforms.roadLapLength={value:lapLength}
  shader.vertexShader='attribute vec3 roadWear; varying vec3 vRoadWear;\n'+shader.vertexShader
  shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvRoadWear = roadWear;')
  shader.fragmentShader='uniform sampler2D roadSurface; uniform sampler2D roadScuffs; uniform float roadSpan; uniform float roadLapLength; varying vec3 vRoadWear;\n'+shader.fragmentShader
  shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
   vec4 surfaceWear = texture2D(roadSurface, vec2(0.5 + vRoadWear.x / roadSpan, vRoadWear.y));
   vec3 scuff = texture2D(roadScuffs, vec2(vRoadWear.x * 0.42, vRoadWear.y * roadLapLength * 0.14)).rgb;
   float breakup = smoothstep(0.07, 0.40, surfaceWear.r);
   float raggedRubber = clamp((surfaceWear.r - (scuff.g - 0.5) * 0.16 * breakup) * (0.50 + scuff.r * 1.30), 0.0, 0.82);
   float rubberWear = mix(surfaceWear.r, raggedRubber, surfaceWear.a);
   float surfaceTone = 0.72 + surfaceWear.g * 0.55;
   float surfacePolish = surfaceWear.b;
   diffuseColor.rgb *= surfaceTone * (1.0 - rubberWear * 0.90);
  `)
  shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>',`#include <roughnessmap_fragment>
   roughnessFactor = clamp(roughnessFactor - surfacePolish * 0.06 + breakup * (scuff.b - 0.4) * 0.07 + (surfaceTone - 1.0) * 0.12, 0.66, 0.94);
  `)
  shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
   normal = normalize(mix(nonPerturbedNormal, normal, 1.0 - surfacePolish * 0.12));
  `)
 }
 material.customProgramCacheKey=()=> 'road-surface-scuffs-v5'
}
