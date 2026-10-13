import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { buildTreeForm } from './treeForms'
import { treeFoliageTexture } from './treeFoliage'
import type { Track } from '../core/track'
import type { Terrain } from './terrain'
import { planDriverEnvironment, type TreeSite, type BuildingSite } from './driverEnvironmentPlan'

type Disposable={dispose():void}
const rng=(seed:number)=>()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296}

function addTrees(root:THREE.Group,sites:TreeSite[],terrain:Terrain,disposables:Disposable[]):void {
 const texture=treeFoliageTexture()
 const foliage=new THREE.MeshLambertMaterial({map:texture,alphaTest:0.4,side:THREE.DoubleSide,vertexColors:true})
 // Preserve outward crown lighting on both faces of the cutout cards.
 foliage.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\nnormal *= faceDirection;\n#endif')}
 foliage.customProgramCacheKey=()=> 'canopy-volume-lighting-v1'
 // Slightly warm wood; fine vertical bark relief catches the low sun.
 const size=128,bark=new Uint8Array(size*size*4),r=rng(31247)
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const i=(y*size+x)*4,value=125+Math.sin(x*0.9+Math.sin(y*0.06)*0.8)*25+r()*20
  bark[i]=value;bark[i+1]=value;bark[i+2]=value;bark[i+3]=255
 }
 const barkMap=new THREE.DataTexture(bark,size,size);barkMap.needsUpdate=true;barkMap.wrapS=barkMap.wrapT=THREE.RepeatWrapping
 const wood=new THREE.MeshStandardMaterial({color:0x6a6252,bumpMap:barkMap,bumpScale:0.022,roughness:0.95})
 disposables.push(texture,foliage,barkMap,wood)
 for(let variant=0;variant<6;variant++){
  const prototype=buildTreeForm(variant);disposables.push(prototype.wood,prototype.leaves,prototype.farLeaves)
  const variantOf=(t:TreeSite)=>t.prototype??(t.variant*2+(Math.floor(t.arc*11+t.height*17)%2))
  const trees=sites.filter(t=>variantOf(t)===variant)
  const chunks=new Map<string,TreeSite[]>()
  for(const t of trees){const key=Math.floor(t.x/100)+','+Math.floor(t.y/100),chunk=chunks.get(key)??[];chunk.push(t);chunks.set(key,chunk)}
  for(const chunk of chunks.values()){
   const centre=new THREE.Vector3(chunk.reduce((sum,t)=>sum+t.x,0)/chunk.length,0,-chunk.reduce((sum,t)=>sum+t.y,0)/chunk.length)
   // Keep one crown silhouette at every distance. Texture mipmaps reduce leaf detail
   // naturally; swapping enlarged far cards made whole groups appear to shrink.
   const treesRoot=new THREE.Group();treesRoot.name='stable-tree-canopies';treesRoot.position.copy(centre)
   {
    const geometry=prototype.leaves
    const group=new THREE.Group(),trunks=new THREE.InstancedMesh(prototype.wood,wood,chunk.length),canopies=new THREE.InstancedMesh(geometry,foliage,chunk.length)
    for(let i=0;i<chunk.length;i++){
     const t=chunk[i]!,variation=Math.sin(t.arc*1.37+t.height)*0.10
     const matrix=new THREE.Matrix4().compose(new THREE.Vector3(t.x-centre.x,terrain.height(t.x,t.y),-t.y-centre.z),new THREE.Quaternion().setFromEuler(new THREE.Euler(variation*0.10,t.rotation,variation*0.18,'YXZ')),new THREE.Vector3(t.radius/prototype.radius*(1+variation),t.height/prototype.height,t.radius/prototype.radius*(1-variation)))
     trunks.setMatrixAt(i,matrix);canopies.setMatrixAt(i,matrix)
     canopies.setColorAt(i,new THREE.Color().setHSL(0.255+variation*0.16,0.32,0.40+variation*0.20))
    }
    trunks.instanceMatrix.needsUpdate=true;canopies.instanceMatrix.needsUpdate=true
    if(canopies.instanceColor)canopies.instanceColor.needsUpdate=true
    for(const mesh of [trunks,canopies]){mesh.castShadow=true;mesh.receiveShadow=mesh===trunks;mesh.computeBoundingSphere();group.add(mesh);disposables.push(mesh)}
    treesRoot.add(group)
   }
   root.add(treesRoot)
  }
 }

}
function addBuilding(root:THREE.Group,site:BuildingSite,terrain:Terrain,materials:THREE.Material[],disposables:Disposable[]):void {
 const group=new THREE.Group();group.position.set(site.x,terrain.height(site.x,site.y)-0.06,-site.y);group.rotation.y=site.yaw
 const parts:THREE.BufferGeometry[][]=materials.map(()=>[])
 const box=(x:number,y:number,z:number,w:number,h:number,d:number,mat:number)=>{const g=new THREE.BoxGeometry(w,h,d);g.translate(x,y,z);parts[mat]!.push(g)}
 const L=site.length,D=site.depth,H=site.height
 box(0,H/2,0,L,H,D,site.style===2?4:0)
 box(0,0.3,0,L+0.3,0.6,D+0.3,3)
 box(0,H+0.18,0,L+1.0,0.36,D+1.0,3)
 // Recessed dark glazing, contrasting frames, deep reveals and floor ledges.
 for(const side of [-1,1])for(let floor=0;floor<Math.floor(H/3);floor++){
  const y=2+floor*3,z=side*(D/2+0.06)
  for(let x=-L/2+1.6;x<L/2-1;x+=2.8){
   box(x,y,z,2.1,1.55,0.08,1)
   box(x,y+0.84,z,2.3,0.12,0.22,2);box(x,y-0.84,z,2.3,0.12,0.35,2)
   for(const edge of [-1,1])box(x+edge*1.1,y,z,0.1,1.6,0.22,2)
   box(x,y,z+side*0.05,0.07,1.55,0.14,2)
  }
  box(0,y-1.1,side*(D/2+0.14),L+0.2,0.20,0.40,3)
 }
 if(site.style===0){
  // Garages under a real projecting canopy; upper offices remain visible over the wall.
  for(let x=-L/2+3;x<L/2-1;x+=5)for(const side of [-1,1]){
   box(x,1.5,side*(D/2+0.1),3.5,2.5,0.10,3)
   for(let slat=0;slat<6;slat++)box(x,0.55+slat*0.36,side*(D/2+0.16),3.5,0.04,0.08,2)
  }
  box(0,3.2,0,L+0.8,0.22,D+2,2)
 }else if(site.style===1){
  box(0,H+0.8,0,L*0.75,1.2,D*0.7,1)
  box(0,H+1.6,0,L*0.84,0.30,D*0.8,3)
  for(const side of [-1,1])for(let x=-L/2+1;x<L/2;x+=2.5)box(x,H-1.8,side*(D/2+0.16),0.22,2.6,0.5,2)
 }else{
  // Short tiled-looking pitched roof, useful as a distinct corner landmark.
  for(const side of [-1,1]){
   const g=new THREE.BoxGeometry(L+0.8,0.25,D*0.56);g.rotateX(side*0.23);g.translate(0,H+0.55,side*D*0.25);parts[4]!.push(g)
  }
 }
 box(L*0.26,H+0.7,0,3,0.9,2,3)
 for(let m=0;m<parts.length;m++)if(parts[m]!.length){
  const geometry=mergeGeometries(parts[m]!)!;for(const p of parts[m]!)p.dispose()
  const mesh=new THREE.Mesh(geometry,materials[m]);mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);disposables.push(geometry)
 }
 root.add(group)
}
export function buildDriverEnvironment(track:Track,terrain:Terrain):{root:THREE.Group;dispose():void}{
 const root=new THREE.Group();root.name='driver-environment';const disposables:Disposable[]=[]
 const plan=planDriverEnvironment(track,terrain)
 const materials=[
  new THREE.MeshStandardMaterial({color:0xc2bcae,roughness:0.9}),
  new THREE.MeshStandardMaterial({color:0x435666,roughness:0.24,metalness:0.35}),
  new THREE.MeshStandardMaterial({color:0xc8cbc5,roughness:0.7,metalness:0.15}),
  new THREE.MeshStandardMaterial({color:0x55575b,roughness:0.9}),
  new THREE.MeshStandardMaterial({color:0x896757,roughness:0.94}),
 ];disposables.push(...materials)
 for(const site of plan.buildings)addBuilding(root,site,terrain,materials,disposables)
 addTrees(root,plan.trees,terrain,disposables)
 root.userData.buildings=plan.buildings.length;root.userData.trees=plan.trees.length
 return {root,dispose:()=>{for(const d of disposables)d.dispose()}}
}
