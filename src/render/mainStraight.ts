import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { outsideWall, pointAt, clearOfCircuit } from '../core/placement'
import type { Track } from '../core/track'
import type { Terrain } from './terrain'
import { planMainStraight, type StraightSite } from './mainStraightPlan'

type Disposable = { dispose(): void }

function signTexture(title: string, subtitle: string, light = false): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 128
  const c = canvas.getContext('2d')!
  c.fillStyle = light ? '#c8b77c' : '#193845'; c.fillRect(0, 0, 1024, 128)
  c.fillStyle = light ? '#26353a' : '#e0d8bc'; c.font = 'italic 800 62px sans-serif'
  c.textBaseline = 'middle'; c.fillText(title, 40, 59)
  c.font = '600 17px sans-serif'; c.textAlign = 'right'; c.fillText(subtitle, 980, 65)
  c.fillStyle = light ? '#817451' : '#617c83'; c.fillRect(0, 115, 1024, 5)
  // Soft vertical weathering, no dotted overlay.
  for (let x = 0; x < 1024; x += 7) { c.fillStyle = `rgba(29,26,22,${0.015 + 0.015 * Math.sin(x * 0.017)})`; c.fillRect(x, 0, 2, 128) }
  const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t
}

function crowdTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1024
  const c = canvas.getContext('2d')!; let seed = 17303
  const r = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const shirts = ['#928c80', '#ac463b', '#425b77', '#d2ccbd', '#333b42', '#a69358']
  for(let row=0;row<4;row++) for (let i = 0; i < 24; i++) {
    if (r() < 0.11) continue
    const x = 21 + i * 42 + (r() - 0.5) * 5, y = row*256 + 65 + r() * 34
    c.fillStyle = shirts[Math.floor(r() * shirts.length)]!
    c.beginPath(); c.moveTo(x - 8, y + 24); c.quadraticCurveTo(x - 21, y + 31, x - 19, y + 78)
    c.lineTo(x + 20, y + 78); c.quadraticCurveTo(x + 20, y + 31, x + 8, y + 24); c.fill()
    c.fillStyle = r() < 0.4 ? '#986d50' : '#c0a087'; c.beginPath(); c.ellipse(x, y + 12, 8, 12, 0, 0, Math.PI * 2); c.fill()
    c.fillStyle = r() < 0.5 ? '#474039' : '#555f67'; c.beginPath(); c.ellipse(x, y + 3, 9, 5, 0, Math.PI, Math.PI * 2); c.fill()
    c.fillStyle = '#343a41'; c.fillRect(x - 13, y + 78, 11, 30); c.fillRect(x + 3, y + 78, 11, 30)
  }
  const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t
}

function fenceTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128
  const c = canvas.getContext('2d')!; c.strokeStyle = '#aeb7ba'; c.lineWidth = 0.75
  for (let x = -128; x <= 256; x += 32) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x + 128, 128); c.moveTo(x, 0); c.lineTo(x - 128, 128); c.stroke() }
  const t = new THREE.CanvasTexture(canvas); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace; return t
}

/** Authored for the driver: a continuous, layered start/finish corridor. */
export function buildMainStraight(track: Track, terrain: Terrain): { root: THREE.Group; detailRoot: THREE.Group; replacesStart: boolean; dispose(): void } {
  const root = new THREE.Group(); root.name = 'main-straight-complex'
  const detailRoot = new THREE.Group(); detailRoot.name = 'main-straight-detail'
  const plan = planMainStraight(track, terrain), resources: Disposable[] = []
  if (!plan) return { root, detailRoot, replacesStart: false, dispose() {} }
  const teams = [signTexture('NORTHSTAR', 'RACING', false), signTexture('ARGON', 'MOTORSPORT', true), signTexture('VELA', 'RACING', false), signTexture('EMBER', 'MOTORSPORT', true)]
  const signs = [signTexture('BITE POINT', 'MOTORSPORT'), signTexture('CROFT BAY', 'RACING CIRCUIT', true)]
  const crowd = crowdTexture(), fence = fenceTexture(); resources.push(...signs, ...teams, crowd, fence)
  const materials: THREE.Material[] = [
    new THREE.MeshStandardMaterial({ color: 0xbcbcaf, roughness: 0.88 }), // concrete
    new THREE.MeshStandardMaterial({ color: 0x4a5258, roughness: 0.92 }), // recess / underside
    new THREE.MeshStandardMaterial({ color: 0xa7b5ba, roughness: 0.43, metalness: 0.55 }), // steel
    new THREE.MeshLambertMaterial({ color: 0x304452 }),
    new THREE.MeshStandardMaterial({ color: 0xc7c5b7, roughness: 0.64, metalness: 0.3 }), // roof
    new THREE.MeshStandardMaterial({ color: 0x365364, roughness: 0.83 }), // seats
    ...signs.map(map => new THREE.MeshStandardMaterial({ map, roughness: 0.82, side: THREE.DoubleSide })),
    new THREE.MeshLambertMaterial({ map: crowd, alphaTest: 0.35, side: THREE.DoubleSide }),
    new THREE.MeshLambertMaterial({ map: fence, color:0x849095, alphaTest: 0.15, side: THREE.DoubleSide }),
    ...teams.map((map,i)=>new THREE.MeshStandardMaterial({map,color:[0x8eb5bc,0xe4c493,0xbbc7c6,0xc27e6b][i]!, roughness:0.85,side:THREE.DoubleSide})),
    new THREE.MeshStandardMaterial({color:0x30404c,roughness:0.93}), // crew clothing
    new THREE.MeshStandardMaterial({color:0xb59a80,roughness:0.92}), // heads
    new THREE.MeshStandardMaterial({color:0x202429,roughness:0.95}), // parked tyres
    new THREE.MeshStandardMaterial({color:0xd4cfb8,roughness:0.91}), // lane paint
    new THREE.MeshStandardMaterial({color:0xb78855,roughness:0.86}), // warm garage fascia
    new THREE.MeshStandardMaterial({color:0x6a7c79,roughness:0.91}), // muted team fascia

  ]; resources.push(...materials)
  const opaque=new THREE.MeshLambertMaterial({vertexColors:true})
  const atlasCanvas=document.createElement('canvas');atlasCanvas.width=2048;atlasCanvas.height=512
  const atlasContext=atlasCanvas.getContext('2d')!,signIndices=[6,7,10,11,12,13]
  signIndices.forEach((index,i)=>atlasContext.drawImage((materials[index] as THREE.MeshStandardMaterial).map!.image as HTMLCanvasElement,(i%2)*1024+8,Math.floor(i/2)*160+16,1008,128))
  const atlas=new THREE.CanvasTexture(atlasCanvas);atlas.colorSpace=THREE.SRGBColorSpace;atlas.anisotropy=4
  const signage=new THREE.MeshLambertMaterial({map:atlas,vertexColors:true,side:THREE.DoubleSide})
  const shadowMaterial=new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:false})
  resources.push(opaque,atlas,signage,shadowMaterial)
  const shadows=new Map<number,THREE.BufferGeometry[]>()
  // Geometry is batched by material in 96m sections, so the whole lap isn't submitted to shadow/frustum passes.
  const batches = new Map<string, THREE.BufferGeometry[]>()
  let transform = new THREE.Matrix4(), section = 0, facing = 1
  const add = (geometry: THREE.BufferGeometry, material: number) => {
    geometry.applyMatrix4(transform)
    if(material===4){const list=shadows.get(section)??[];list.push(geometry.clone());shadows.set(section,list)}
    const tint=(materials[material] as THREE.MeshStandardMaterial).color
    const count=geometry.getAttribute('position').count,colors=new Float32Array(count*3)
    for(let i=0;i<count;i++){colors[i*3]=tint.r;colors[i*3+1]=tint.g;colors[i*3+2]=tint.b}
    geometry.setAttribute('color',new THREE.BufferAttribute(colors,3))
    const sign=signIndices.indexOf(material),uv=geometry.getAttribute('uv')
    if(sign>=0)for(let i=0;i<uv.count;i++){
      uv.setXY(i,((sign%2)*1024+8+uv.getX(i)*1008)/2048,1-(Math.floor(sign/2)*160+16+128)/512+uv.getY(i)*128/512)
    }
    const detail=material===5||(material>=14&&material<=17)
    const category=sign>=0?'sign':material===8?'crowd':material===9?'fence':detail?'detail':'opaque'
    const key=section+':'+category,list=batches.get(key)??[];list.push(geometry);batches.set(key,list)
  }
  const box = (x: number, y: number, z: number, w: number, h: number, d: number, material: number, pitch = 0) => {
    const g = new THREE.BoxGeometry(w, h, d); if (pitch) g.rotateX(pitch); g.translate(x, y, z); add(g, material)
  }
  const beam = (a: THREE.Vector3, b: THREE.Vector3, radius = 0.09, material = 2) => {
    const delta = b.clone().sub(a), g = new THREE.CylinderGeometry(radius, radius, delta.length(), 6)
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()))
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2); add(g, material)
  }
  const panel = (x: number, y: number, z: number, w: number, h: number, material: number, repetitions = 1, rotate = false) => {
    const g = new THREE.PlaneGeometry(w, h); if (rotate) g.rotateY(-Math.PI / 2); else if (facing < 0) g.rotateY(Math.PI)
    const uv = g.getAttribute('uv'); for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * repetitions)
    g.translate(x, y, z); add(g, material)
  }
  const setSite = (s: StraightSite) => {
    section = Math.floor(s.arc / 96); facing = s.side
    transform = new THREE.Matrix4().compose(new THREE.Vector3(s.x, terrain.height(s.x, s.y) - 0.04, -s.y),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw), new THREE.Vector3(1, 1, 1))
  }
  const pitSites=plan.sites.filter(s=>s.kind==='pit')
  for (const site of plan.sites) {
    setSite(site); const L = site.length, D = site.depth, side = site.side, front = side * D / 2
    if (site.kind === 'pit') {
      // The footprint contains a working lane in front of the garages, not just an office facade.
      const bayDepth=11, face=front-side*10.8, centre=face-side*bayDepth/2
      const team=Math.floor(site.arc/52)%4, banner=10+team
      const upperHeight=[8.7,8.7,10.7,10.7,8.7,8.7,11.6,11.6][Math.floor(site.arc/26)%8]!
      const fascia=team%2?18:19
      box(0,0.035,0,L+1.7,0.03,D+2.3,1)
      // A lane stripe and individual pit boxes explain the working space, without filling it with props.
      box(0,0.057,front-side*2.0,L+1.6,0.014,0.12,17)
      for(const x of [-7.0,5.5]) {
        box(x,0.062,face+side*2.5,0.12,0.018,4.8,17)
        box(x+2.6,0.062,face+side*4.85,5.2,0.018,0.12,17)
      }
      // Solid rear/ends and actual dark open bays. A few shutters are closed, the rest have depth.
      box(0,1.95,centre-side*(bayDepth/2-0.24),L,3.9,0.48,0)
      for(const x of [-L/2+0.24,L/2-0.24]) {
        box(x,1.95,face,0.48,3.9,0.5,0)
        if((x<0&&site===pitSites[0])||(x>0&&site===pitSites[pitSites.length-1]))box(x,1.95,centre,0.48,3.9,bayDepth,0)
      }
      box(0,4.1,centre,L+0.7,0.40,bayDepth+1.0,4)
      for(let bay=0;bay<4;bay++) {
        const x=-9+bay*6,closed=(Math.floor(site.arc/26)+bay)%6===0
        box(x-2.76,1.98,face,0.42,3.96,0.52,0)
        box(x,3.70,face+side*0.10,5.45,0.42,0.42,fascia)
        panel(x,3.76,face+side*0.33,5.1,0.28,banner)
        box(x,3.36,face-side*2.0,3.6,0.06,0.25,17)
        if(closed) {
          box(x,1.72,face-side*0.12,5.02,3.40,0.11,1)
          for(let row=0;row<4;row++)box(x,0.65+row*0.7,face-side*0.05,4.9,0.022,0.08,2)
        } else {
          box(x,1.70,face-side*9.5,5.10,3.40,0.12,14)
          // Sparse tall equipment stations remain visible through the garage opening.
          if((bay+team)%3===0){box(x+1.6,0.92,face-side*1.5,0.72,1.84,0.6,14);box(x+1.6,1.40,face-side*1.15,0.52,0.32,0.025,3)}
        }
      }
      // Broad upper masses: shaded hospitality glazing and deep canopies, with a varied roofline.
      const upper=upperHeight-4.35
      box(0,4.35+upper/2,centre-side*(bayDepth/2-0.20),L,upper,0.40,0)
      box(0,4.35,centre,L,0.24,bayDepth,1)
      // Continuous upper space avoids opaque module-end walls hiding every window at a driving angle.
      for(const x of [-L/2,L/2])if((x<0&&site===pitSites[0])||(x>0&&site===pitSites[pitSites.length-1]))box(x,4.35+upper/2,centre,0.30,upper,bayDepth,0)
      box(0,4.60+upper/2,face-side*0.65,L-0.6,Math.max(1.8,upper-1.05),0.30,1)
      for(const x of [-7.9,0,7.9]) {
        box(x,4.65+upper/2,face-side*0.40,7.4,Math.max(1.8,upper-1.15),0.08,3)
        box(x+3.85,4.65+upper/2,face+side*0.08,0.28,upper-0.55,0.75,0)
      }
      box(0,4.65,face+side*0.32,L+0.2,0.50,1.5,fascia)
      if(Math.floor(site.arc/26)%2===0)panel(0,4.65,face+side*1.08,L-0.4,0.34,7)
      const slope=(team%2?0.05:-0.035)*side
      box(0,upperHeight+0.35,centre+side*0.7,L+0.9,0.30,bayDepth+2.2,4,slope)
      box(0,upperHeight+0.10,centre+side*0.7,L+0.7,0.14,bayDepth+2.1,1,slope)
      // Selected garages have a car and two crew, rather than identical props in every bay.
      if(Math.floor(site.arc/26)%3===1) {
        const x=team%2?-6:6,z=face-side*1.8
        box(x,0.39,z,0.72,0.38,3.1,5);box(x,0.31,z+side*1.75,0.32,0.18,1.05,5)
        box(x,0.24,z+side*2.23,1.75,0.06,0.32,1);box(x,0.85,z-side*1.72,1.1,0.065,0.35,5)
        for(const axle of [-1.3,1.3])for(const edge of [-0.78,0.78]) {
          const tyre=new THREE.CylinderGeometry(0.33,0.33,0.28,12);tyre.rotateZ(Math.PI/2);tyre.translate(x+edge,0.33,z+axle);add(tyre,16)
        }
        for(const worker of [-1,1]) {
          const wx=x+worker*1.65,wz=face+side*(worker<0?1.2:2.8)
          box(wx,1.14,wz,0.37,0.55,0.25,14)
          for(const leg of [-1,1])beam(new THREE.Vector3(wx+leg*0.1,0.13,wz),new THREE.Vector3(wx+leg*0.1,0.92,wz),0.072,14)
          const head=new THREE.SphereGeometry(0.115,8,6);head.translate(wx,1.58,wz);add(head,15)
          beam(new THREE.Vector3(wx-0.23,1.31,wz),new THREE.Vector3(wx-0.30,0.92,wz+0.10),0.055,14)
          beam(new THREE.Vector3(wx+0.23,1.31,wz),new THREE.Vector3(wx+0.33,1.13,wz+side*0.19),0.055,14)
        }
      }
    } else {
      const rows = Math.min(12, Math.floor((D - 2.0) / 0.88)), top = 1.65 + rows * 0.55
      box(0, 0.50, 0, L, 1.0, D, 0)
      for (let row = 0; row < rows; row++) {
        const y = 1.4 + row * 0.55, z = front - side * (0.7 + row * 0.88)
        box(0, y - 0.22, z, L, 0.38, 0.92, 0)
        // Continuous seat backs preserve row silhouettes; individual chairs are below driving-view resolution.
        for(const x of [-L/4-0.5,L/4+0.5])box(x,y+0.20,z-side*0.20,L/2-1.4,0.26,0.07,5)
      }
      const rise=(rows-1)*0.55,run=(rows-1)*0.88
      for(const x of [-L/4-0.5,L/4+0.5]){
        const card=new THREE.PlaneGeometry(L/2-1.4,Math.hypot(rise,run)+1.4)
        card.rotateX(-side*Math.atan2(run,rise));card.translate(x,1.97+rise/2,front-side*(0.7+run/2));add(card,8)
      }
      for (const x of [-L / 2 + 0.4, L / 2 - 0.4]) {
        box(x, top / 2, -side * (D / 2 - 0.45), 0.35, top, 0.35, 0)
        box(x, (top + 3.0) / 2, -side * (D / 2 - 0.55), 0.23, top + 3.0, 0.23, 2)
        beam(new THREE.Vector3(x, top + 2.8, -side * (D / 2 - 0.55)), new THREE.Vector3(x, top + 1.6, front + side * 0.7))
        beam(new THREE.Vector3(x, top + 1.0, -side * (D / 2 - 0.55)), new THREE.Vector3(x, top + 2.0, 0))
      }
      const roofY = top + 2.0
      box(0, roofY, 0, L + 0.8, 0.22, D + 1.8, 4, side * 0.09)
      box(0, roofY - 0.19, 0, L + 0.65, 0.12, D + 1.7, 1, side * 0.09)
      box(0, roofY - 0.7, front + side * 0.75, L + 0.7, 0.48, 0.20, 2)
      for (let x = -L / 2 + 1; x < L / 2; x += 3.0) box(x, roofY + 0.13, 0, 0.055, 0.045, D + 1.7, 2, side * 0.09)
      // Front balustrade and dark banner below the crowd, away from the driving corridor.
      for (let x = -L / 2; x <= L / 2; x += 3) box(x, 1.9, front + side * 0.06, 0.055, 1.35, 0.055, 2)
      box(0, 2.55, front + side * 0.06, L, 0.055, 0.055, 2)
      panel(0, 1.1, front + side * 0.07, L, 0.7, 6)
    }
  }
  // Real open chain-link fencing, continuous along both walls. Roofline remains readable through it.
  for (const side of [-1, 1]) for (let arc = plan.start; arc + 4 <= plan.end; arc += 4) {
    const p = pointAt(track, arc + 2, outsideWall(track, arc + 2, side, 0.45))
    if (!clearOfCircuit(track, p.x, p.y, 0.1)) continue
    setSite({ arc: arc + 2, ...p, yaw: track.poseAt(arc + 2).yaw, side, length: 4, depth: 0, kind: 'pit' })
    box(-2, 2.40, 0, 0.075, 2.7, 0.075, 2); box(-2, 1.03, 0, 0.24, 0.18, 0.24, 0)
    box(0, 3.76, 0, 4.08, 0.045, 0.045, 2); box(0, 2.05, 0, 4.08, 0.032, 0.032, 2)
    const g = new THREE.PlaneGeometry(4, 2.6), uv = g.getAttribute('uv')
    for (let i = 0; i < uv.count; i++) { uv.setX(i, uv.getX(i) * 4); uv.setY(i, uv.getY(i) * 2.6) }
    g.translate(0, 2.42, 0); add(g, 9)
    // Wall faces are attached to the existing barrier, not floating roadside signs.
    const wall = pointAt(track, arc + 2, outsideWall(track, arc + 2, side, -0.025))
    transform.setPosition(wall.x, 0, -wall.y); panel(0, 0.55, 0, 4, 0.88, Math.floor(arc / 24) % 2 ? 6 : 7)
    box(-1.97, 0.57, -side * 0.015, 0.04, 0.91, 0.025, 1)
  }
  // Pedestrian bridge forms a middle-distance frame, with visible truss depth and an open underside.
  const arc = plan.bridge, p = track.poseAt(arc)
  section = Math.floor(arc / 96)
  transform = new THREE.Matrix4().compose(new THREE.Vector3(p.x, 0, -p.y),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw), new THREE.Vector3(1, 1, 1))
  const left = outsideWall(track, arc, 1, 2.0), right = outsideWall(track, arc, -1, 2.0)
  const z0 = -left, z1 = -right, width = z1 - z0, centre = (z0 + z1) / 2
  for (const z of [z0, z1]) { box(0, 4.15, z, 0.75, 8.3, 0.65, 0); box(0, 0.2, z, 1.3, 0.4, 1.3, 1) }
  box(0, 8.4, centre, 2.4, 0.36, width + 1.3, 1)
  for (const x of [-1.15, 1.15]) {
    box(x, 8.55, centre, 0.13, 0.13, width + 1, 2); box(x, 9.7, centre, 0.13, 0.13, width + 1, 2)
    for (let z = z0; z < z1; z += 3.5) {
      const end = Math.min(z + 3.5, z1)
      beam(new THREE.Vector3(x, 8.55, z), new THREE.Vector3(x, 9.7, end), 0.065)
      beam(new THREE.Vector3(x, 9.7, z), new THREE.Vector3(x, 8.55, end), 0.065)
    }
  }
  panel(-1.24, 9.14, centre, width * 0.59, 1.0, 6, 1, true)

  let triangleCount = 0
  const detailGroups=new Map<number,THREE.Group>()
  for (const [key, parts] of batches) {
    const [sectionKey,category]=key.split(':'),geometry=mergeGeometries(parts)!
    for(const part of parts)part.dispose()
    geometry.computeBoundingSphere();resources.push(geometry)
    const material=category==='sign'?signage:category==='crowd'?materials[8]:category==='fence'?materials[9]:opaque
    const mesh=new THREE.Mesh(geometry,material);mesh.name='straight-'+key
    mesh.castShadow=false;mesh.receiveShadow=true;mesh.matrixAutoUpdate=false
    if(category==='detail'||category==='crowd'||category==='fence'){
      const section=Number(sectionKey),group=detailGroups.get(section)??new THREE.Group();group.add(mesh);detailGroups.set(section,group)
    }else root.add(mesh)
    triangleCount+=(geometry.index?.count??geometry.getAttribute('position').count)/3
  }
  for(const [section,parts] of shadows){
    const geometry=mergeGeometries(parts)!;for(const part of parts)part.dispose();resources.push(geometry)
    const proxy=new THREE.Mesh(geometry,shadowMaterial);proxy.name='straight-roof-shadow-'+section;proxy.castShadow=true;proxy.matrixAutoUpdate=false;root.add(proxy)
  }
  for(const group of detailGroups.values()){
    const centre=new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3())
    // Keep world-space meshes under a stationary LOD origin; no matrix work after construction.
    const lod=new THREE.LOD();lod.position.copy(centre);group.position.copy(centre).negate()
    lod.addLevel(group,0);lod.addLevel(new THREE.Group(),115,0.15);detailRoot.add(lod)
  }
  batches.clear();shadows.clear()
  root.userData.triangles = triangleCount; root.userData.modules = plan.sites.length
  return { root, detailRoot, replacesStart: true, dispose: () => { for (const resource of resources) resource.dispose() } }
}
