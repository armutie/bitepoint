import { isLegacyTyrePath } from '../features'
export function drivingLibraryUrl(href:string):string{
  const base=new URL(href)
  if(isLegacyTyrePath(base.pathname)){base.pathname=base.pathname.replace(/legacy(?:\/index\.html)?\/?$/,'');base.search='';base.hash=''}
  return new URL('driving-data.html',base).href
}
