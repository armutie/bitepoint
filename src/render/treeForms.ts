import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
const rng=(seed:number)=>()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296}
export interface TreeForm { wood:THREE.BufferGeometry; leaves:THREE.BufferGeometry; farLeaves:THREE.BufferGeometry; height:number; radius:number }

/** Overlapping branch-grown crown lobes. Each card describes a leafy cluster, not a twig. */
export function buildTreeForm(variant:number):TreeForm {
 const r=rng(72091+variant*2179),wood:THREE.BufferGeometry[]=[],near:THREE.BufferGeometry[]=[],far:THREE.BufferGeometry[]=[]
 const lobes:{point:THREE.Vector3;radius:number;flatten:number}[]=[]
 const narrow=variant===2,spread=variant===4?1.22:narrow?0.73:1
 const lean=variant===1?0.85:variant===3?-0.65:0.16
 const limb=(from:THREE.Vector3,to:THREE.Vector3,base:number,tip:number)=>{
  const delta=to.clone().sub(from),g=new THREE.CylinderGeometry(tip,base,delta.length(),6,1,true)
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),delta.clone().normalize()))
  g.translate(...from.clone().add(to).multiplyScalar(0.5).toArray());wood.push(g)
 }
 const trunk=[new THREE.Vector3(0,0,0),new THREE.Vector3(0.08,2.8,0.02),new THREE.Vector3(lean*0.5,5.3,-0.12),new THREE.Vector3(lean,7.8,0.12),new THREE.Vector3(lean*1.2,10.2,-0.06)]
 for(let t=0;t<4;t++)limb(trunk[t]!,trunk[t+1]!,0.34-t*0.065,0.275-t*0.065)
 for(let b=0;b<10;b++){
  const angle=b*2.399+variant*0.63+(r()-0.5)*0.6
  const baseHeight=4.0+b/10*4.2+(r()-0.5)*0.5
  const start=new THREE.Vector3(lean*baseHeight/8,baseHeight,0)
  const reach=(2.3+r()*1.5)*spread
  const point=new THREE.Vector3(Math.cos(angle)*reach+lean,baseHeight+1.8+r()*1.1,Math.sin(angle)*reach)
  const knee=start.clone().lerp(point,0.58);knee.y-=0.55
  limb(start,knee,0.16-b*0.007,0.075);limb(knee,point,0.075,0.018)
  // Only two useful secondary limbs; small hidden twigs do not earn their geometry.
  for(const side of [-1,1]){
   const end=point.clone().add(new THREE.Vector3(Math.cos(angle+side*0.7)*0.9,0.7,Math.sin(angle+side*0.7)*0.9))
   limb(knee.clone().lerp(point,0.45),end,0.04,0.009)
  }
  lobes.push({point,radius:(1.9+r()*0.7)*spread,flatten:variant===4?0.65:0.87})
 }
 lobes.push({point:new THREE.Vector3(lean,10.4,0),radius:2.3*spread,flatten:0.9},{point:new THREE.Vector3(lean-0.8,8.8,0.7),radius:2.4*spread,flatten:0.92})
 const crownCentre=new THREE.Vector3(lean,8.3,0)
 for(let l=0;l<lobes.length;l++)for(let i=0;i<12;i++){
  const lobe=lobes[l]!,angle=i*2.399+l*0.7+r()*0.45,vertical=1-2*(i+0.5)/12,radial=Math.sqrt(1-vertical*vertical)
  const direction=new THREE.Vector3(Math.cos(angle)*radial,vertical*lobe.flatten,Math.sin(angle)*radial)
  const point=lobe.point.clone().addScaledVector(direction,lobe.radius*(i%3===0?0.35:0.72))
  const orientation=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1),direction.clone().normalize())
  orientation.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),r()*Math.PI*2))
  const width=lobe.radius*(1.15+r()*0.3),height=width*(0.82+r()*0.25),tile=(l+i+variant)%4
  const card=(scale:number)=>{
   const g=new THREE.PlaneGeometry(width*scale,height*scale);g.applyQuaternion(orientation);g.translate(...point.toArray())
   const p=g.getAttribute('position'),n=g.getAttribute('normal'),uv=g.getAttribute('uv'),colors=new Float32Array(p.count*3)
   for(let v=0;v<p.count;v++){
    // Canopy normals shade the whole crown; plane normals would expose cardboard faces.
    const position=new THREE.Vector3().fromBufferAttribute(p,v)
    const normal=position.clone().sub(crownCentre);normal.y=normal.y*0.6+2.5;normal.normalize();n.setXYZ(v,normal.x,normal.y,normal.z)
    const outer=Math.min(1,Math.hypot(position.x-lean,position.z)/(5*spread))
    const shade=THREE.MathUtils.clamp(0.64+outer*0.2+(position.y-5)*0.025+(r()-0.5)*0.06,0.60,1)
    colors.set([shade,shade,shade],v*3)
    uv.setXY(v,(uv.getX(v)+tile%2)/2,(uv.getY(v)+Math.floor(tile/2))/2)
   }
   g.setAttribute('color',new THREE.BufferAttribute(colors,3))
   return g
  }
  near.push(card(1));if(i%2===0)far.push(card(1.27))
 }
 const form={wood:mergeGeometries(wood)!,leaves:mergeGeometries(near)!,farLeaves:mergeGeometries(far)!,height:12,radius:5}
 for(const g of [...wood,...near,...far])g.dispose()
 // Include both levels so the placement footprint and shared scale cover the larger distant cards.
 form.leaves.computeBoundingBox();form.farLeaves.computeBoundingBox()
 const bounds=form.leaves.boundingBox!.clone().union(form.farLeaves.boundingBox!)
 form.height=bounds.max.y;form.radius=0
 for(const g of [form.leaves,form.farLeaves]){const p=g.getAttribute('position');for(let i=0;i<p.count;i++)form.radius=Math.max(form.radius,Math.hypot(p.getX(i),p.getZ(i)))}
 return form
}
