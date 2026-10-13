/** Seamless, directional brush breakup. It affects deposited rubber, never the whole road. */
export function bakeRoadScuffDetail(size=512):Uint8Array {
 const data=new Uint8Array(size*size*4)
 const hash=(x:number,y:number)=>{let n=Math.imul(x+37,374761393)^Math.imul(y+83,668265263);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967296}
 const noise=(u:number,v:number,nx:number,ny:number)=>{
  const x=u*nx,y=v*ny,ix=Math.floor(x),iy=Math.floor(y),a=x-ix,b=y-iy,fx=a*a*(3-2*a),fy=b*b*(3-2*b)
  const h00=hash(ix%nx,iy%ny),h10=hash((ix+1)%nx,iy%ny),h01=hash(ix%nx,(iy+1)%ny),h11=hash((ix+1)%nx,(iy+1)%ny)
  return (h00+(h10-h00)*fx)*(1-fy)+(h01+(h11-h01)*fx)*fy
 }
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const u=x/size,v=y/size,i=(y*size+x)*4
  const dragged=noise(u,v,64,14),chips=noise(u,v,96,112),crumbs=noise(u,v,220,176)
  const grain=dragged*0.45+chips*0.35+crumbs*0.20
  data[i]=Math.round(Math.max(0,Math.min(1,(grain-0.15)*1.45))*255)
  data[i+1]=Math.round((noise(u,v,12,32)*0.55+noise(u,v,48,72)*0.45)*255)
  data[i+2]=Math.round(crumbs*255);data[i+3]=255
 }
 return data
}
