import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { shell } from './carSurface'
import type { CarParams } from '../core/carParams'
import type { CarModel, CarSkin, WheelRig } from './carModel'

/** A race-field car keeps the silhouette and live wheels, without cockpit-scale geometry/materials. */
export function buildFieldCar(p: CarParams, skin: CarSkin, ghost = false): CarModel {
  const root=new THREE.Group(),owned:{dispose():void}[]=[]
  const material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:0.68,metalness:0.04,envMapIntensity:0.35,transparent:ghost,opacity:ghost?0.4:1,depthWrite:!ghost})
  const rainMaterial=new THREE.MeshStandardMaterial({color:0xdd2424,emissive:0xff2020,emissiveIntensity:ghost?0.2:2.0,transparent:ghost,opacity:ghost?0.4:1,depthWrite:!ghost})
  const spokeMaterial=new THREE.MeshStandardMaterial(),scuffMaterial=new THREE.MeshStandardMaterial()
  owned.push(material,rainMaterial,spokeMaterial,scuffMaterial)
  const body:THREE.BufferGeometry[]=[],half=p.width/2
  const coloured=(geometry:THREE.BufferGeometry,color:number)=>{
    const c=new THREE.Color(color),n=geometry.getAttribute('position').count,values=new Float32Array(n*3)
    for(let i=0;i<n;i++){values[i*3]=c.r;values[i*3+1]=c.g;values[i*3+2]=c.b}
    geometry.setAttribute('color',new THREE.BufferAttribute(values,3));return geometry
  }
  const box=(x:number,y:number,z:number,w:number,h:number,d:number,color:number)=>{
    const g=new THREE.BoxGeometry(w,h,d);g.translate(x,y,z);body.push(coloured(g,color))
  }
  const skinShell=(sections:Parameters<typeof shell>[0],color:number,z=0)=>{
    const g=shell(sections,10);g.translate(0,0,z);body.push(coloured(g,color))
  }
  box(-0.35,0.14,0,3.1,0.06,p.width*0.74,0x282e35)
  skinShell([[-0.85,0.3,0.15,0.25],[-0.2,0.32,0.17,0.29],[0.8,0.39,0.14,0.18]],skin.body)
  for(const side of [-1,1]){
    skinShell([[-0.7,0.50,0.13,0.12],[-0.25,0.58,0.10,0.12],[0.5,0.5,0.12,0.10]],skin.accent,side*0.29)
    skinShell([[-1.6,0.23,0.06,0.07],[-1.0,0.35,0.15,0.17],[-0.45,0.40,0.18,0.20],[0.37,0.4,0.075,0.14]],skin.body,side*0.50)
    box(0.30,0.70,side*0.66,0.14,0.07,0.24,skin.body)
  }
  skinShell([[-2.2,0.35,0.09,0.055],[-1.3,0.46,0.18,0.14],[-0.65,0.71,0.24,0.20]],skin.body)
  skinShell([[0.35,0.49,0.17,0.30],[1.1,0.45,0.14,0.24],[1.8,0.36,0.09,0.15],[2.6,0.24,0.04,0.10]],skin.accent)
  const intake=new THREE.SphereGeometry(1,12,8);intake.scale(0.15,0.16,0.12);intake.translate(-0.64,0.95,0);body.push(coloured(intake,skin.body))
  const helmet=new THREE.SphereGeometry(0.18,12,8);helmet.translate(-0.13,0.72,0);body.push(coloured(helmet,skin.body))
  const halo=new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.61,0.70,-0.42),new THREE.Vector3(0.08,0.84,-0.46),new THREE.Vector3(0.51,0.875,0),new THREE.Vector3(0.08,0.84,0.46),new THREE.Vector3(-0.61,0.70,0.42),
  ]),24,0.04,5,false);body.push(coloured(halo,0x282e35))
  box(0.60,0.73,0,0.045,0.28,0.035,0x282e35)
  const wing=p.lf+0.75,rear=-p.lr-0.55
  box(wing,0.18,0,0.40,0.04,p.width*0.92,0x282e35)
  box(wing-0.13,0.25,0,0.27,0.035,p.width*0.80,0x282e35)
  for(const side of [-1,1])box(wing,0.28,side*p.width*0.46,0.46,0.24,0.025,skin.body)
  box(rear,0.88,0,0.42,0.075,half*1.16,skin.accent)
  box(rear,0.65,0,0.16,0.035,half*1.16,0x282e35)
  box(rear,0.69,0,0.055,0.40,0.07,skin.body)
  for(const side of [-1,1])box(rear,0.77,side*half*0.58,0.46,0.40,0.025,0x282e35)
  const merge=(parts:THREE.BufferGeometry[])=>{const g=mergeGeometries(parts)!;for(const part of parts)part.dispose();owned.push(g);return g}
  const wheels:WheelRig[]=[],frontWheels:THREE.Object3D[]=[]
  for(const front of [true,false])for(const side of [-1,1] as const){
    const axle=front?p.lf:-p.lr,width=front?0.34:0.45,r=p.wheelRadius,shoulder=0.04
    const pivot=new THREE.Group();pivot.position.set(axle,r,side*(half-0.05-(width/2-0.15)))
    const steer=new THREE.Group();steer.position.z=front?-side*(width/2+0.012):0
    const spin=new THREE.Group();spin.position.z=-steer.position.z
    const profile=[new THREE.Vector2(r*0.55,-width/2),new THREE.Vector2(r-shoulder,-width/2),new THREE.Vector2(r-0.01,-width/2+0.015),new THREE.Vector2(r,-width/2+shoulder),new THREE.Vector2(r,width/2-shoulder),new THREE.Vector2(r-0.01,width/2-0.015),new THREE.Vector2(r-shoulder,width/2),new THREE.Vector2(r*0.55,width/2)]
    const tyre=new THREE.LatheGeometry(profile,18);tyre.rotateX(Math.PI/2)
    const rim=new THREE.CylinderGeometry(r*0.56,r*0.56,width+0.004,12);rim.rotateX(Math.PI/2)
    const parts=[coloured(tyre,0x252a30),coloured(rim,0x515761)]
    for(const face of [-1,1]){const band=new THREE.RingGeometry(r*0.80,r*0.86,18);if(face<0)band.rotateY(Math.PI);band.translate(0,0,face*(width/2+0.002));parts.push(coloured(band,0x9c8829))}
    const mesh=new THREE.Mesh(merge(parts),material);mesh.castShadow=!ghost;mesh.receiveShadow=!ghost;spin.add(mesh);steer.add(spin);pivot.add(steer);root.add(pivot)
    wheels.push({pivot,steer,spin,angle:0,baseY:r,front,sideZ:side});if(front)frontWheels.push(steer)
    // Fixed dark wishbone silhouettes are sufficient at field distance; exact contact still moves the wheels.
    for(const height of [0.27,0.43])box(axle,height,side*half*0.60,0.23,0.016,half*0.68,0x282e35)
  }
  const bodyMesh=new THREE.Mesh(merge(body),material);bodyMesh.castShadow=!ghost;bodyMesh.receiveShadow=!ghost;bodyMesh.matrixAutoUpdate=false;root.add(bodyMesh)
  const rainGeometry=new THREE.BoxGeometry(0.04,0.14,0.08);rainGeometry.translate(-2.27,0.38,0);owned.push(rainGeometry);root.add(new THREE.Mesh(rainGeometry,rainMaterial))
  return {root,wheels,frontWheels,materials:[material,rainMaterial],spokeMaterial,scuffMaterial,updateSuspension(){},updateCockpitSteering(){},dispose(){for(const resource of owned)resource.dispose()}}
}
