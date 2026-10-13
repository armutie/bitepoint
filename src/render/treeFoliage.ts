import * as THREE from 'three'
const rng=(seed:number)=>()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296}

/** Four dense, irregular leafy clusters. Fine leaves merge into shaded mass at driving distance. */
export function treeFoliageTexture():THREE.CanvasTexture {
 const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=1024
 const c=canvas.getContext('2d')!,r=rng(57183)
 for(let tile=0;tile<4;tile++){
  c.save();c.translate(tile%2*512,Math.floor(tile/2)*512)
  const clumps=Array.from({length:9},(_,i)=>{const angle=i*2.399,reach=i===0?0:70+r()*70;return {x:256+Math.cos(angle)*reach,y:256+Math.sin(angle)*reach,rx:58+r()*40,ry:56+r()*35}})
  // Back to front: shaded interiors first, interlocking lit leaf surfaces second.
  for(let layer=0;layer<3;layer++)for(let i=0;i<800;i++){
   const clump=clumps[i%clumps.length]!,angle=r()*Math.PI*2,reach=Math.sqrt(r())
   const x=clump.x+Math.cos(angle)*reach*clump.rx,y=clump.y+Math.sin(angle)*reach*clump.ry
   if(x<24||x>488||y<24||y>488)continue
   const length=5+r()*10,width=length*(0.35+r()*0.25),value=layer===0?108+r()*35:153+r()*80
   c.save();c.translate(x,y);c.rotate(angle*0.55+(r()-0.5)*2.5)
   const rgb=(a:number,b:number,d:number)=>`rgb(${Math.round(a)},${Math.round(b)},${Math.round(d)})`
   const gradient=c.createLinearGradient(-length,-width,length,width)
   gradient.addColorStop(0,rgb(value*0.69,value*0.77,value*0.61))
   gradient.addColorStop(0.48,rgb(value,value*1.04,value*0.87))
   gradient.addColorStop(1,rgb(value*0.76,value*0.85,value*0.66))
   c.fillStyle=gradient;c.beginPath();c.moveTo(-length,0);c.quadraticCurveTo(0,-width*1.8,length,0);c.quadraticCurveTo(0,width*1.5,-length,0);c.fill()
   if(i%4===0){c.strokeStyle='rgba(38,49,30,0.22)';c.lineWidth=0.7;c.beginPath();c.moveTo(-length*0.7,0);c.lineTo(length*0.7,0);c.stroke()}
   c.restore()
  }
  c.restore()
 }
 const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=4
 return texture
}
