const LITTLE_ENDIAN=new Uint8Array(new Uint16Array([1]).buffer)[0]===1
/** Reorder columns for compression; values remain exact Float64, including missing NaNs. */
export function columnBytes(input:Float64Array,rows:number,stride:number):ArrayBuffer{
  if(!Number.isInteger(rows)||rows<1||!Number.isInteger(stride)||stride<1||input.length<rows*stride)throw new Error('Invalid telemetry block')
  const output=new ArrayBuffer(rows*stride*8),view=new DataView(output)
  const numbers=new Float64Array(output)
  for(let c=0;c<stride;c++)for(let r=0;r<rows;r++){
    const i=c*rows+r,value=input[r*stride+c]!
    if(LITTLE_ENDIAN)numbers[i]=value;else view.setFloat64(i*8,value,true)
  }
  return output
}
export function rowNumbers(bytes:ArrayBuffer,rows:number,stride:number):Float64Array{
  if(bytes.byteLength!==rows*stride*8)throw new Error('Telemetry length mismatch')
  const view=new DataView(bytes),out=new Float64Array(rows*stride)
  for(let c=0;c<stride;c++)for(let r=0;r<rows;r++)out[r*stride+c]=view.getFloat64((c*rows+r)*8,true)
  return out
}
export async function checksum(bytes:ArrayBuffer):Promise<string>{
  if(crypto.subtle){const hash=await crypto.subtle.digest('SHA-256',bytes);return 'sha256:'+Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('')}
  let h=2166136261;for(const b of new Uint8Array(bytes))h=Math.imul(h^b,16777619)
  return 'fnv1a32:'+(h>>>0).toString(16).padStart(8,'0')
}
export async function compress(bytes:ArrayBuffer):Promise<{payload:Blob;gzip:boolean}>{
  const raw=new Blob([bytes])
  if(typeof CompressionStream==='undefined')return {payload:raw,gzip:false}
  return {payload:await new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).blob(),gzip:true}
}
export async function decompress(payload:Blob,gzip:boolean):Promise<ArrayBuffer>{
  return gzip?new Response(payload.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer():payload.arrayBuffer()
}
