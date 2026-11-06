import { createHash } from 'node:crypto'
import { readdirSync,readFileSync } from 'node:fs'
import { resolve,relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
/** Identify actual local physics/control/recorder code without invoking git or reading secrets. */
export function drivingBuildPlugin():Plugin{
  const name='virtual:bitepoint-driving-build',resolved='\0'+name,root=fileURLToPath(new URL('../',import.meta.url))
  const fingerprint=()=>{
    const files:string[]=[]
    const walk=(directory:string)=>{for(const f of readdirSync(directory,{withFileTypes:true})){const p=resolve(directory,f.name);if(f.isDirectory())walk(p);else if(f.name.endsWith('.ts')&&!f.name.endsWith('.test.ts'))files.push(p)}}
    for(const p of ['src/core','src/shared','src/game','src/telemetry'])walk(resolve(root,p))
    const hash=createHash('sha256');for(const p of files.sort()){hash.update(relative(root,p).replaceAll('\\','/'));hash.update(readFileSync(p,'utf8').replaceAll('\r\n','\n'))}
    return hash.digest('hex')
  }
  return {name:'bitepoint-driving-build',resolveId(id){if(id===name)return resolved},load(id){if(id===resolved)return `export const buildId=${JSON.stringify(fingerprint())}`},
    handleHotUpdate(context){if(/src[\\/](core|shared|game|telemetry)[\\/]/.test(context.file)){
      const module=context.server.moduleGraph.getModuleById(resolved)
      if(module){context.server.moduleGraph.invalidateModule(module);return [...context.modules,module]}
    }}}
}
