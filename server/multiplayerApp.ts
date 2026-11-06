import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { randomBytes, createHmac } from 'node:crypto'
import { validConfig, type RoomConfig, type Signal, type Slot } from '../src/multiplayer/protocol'

interface Room {
  config:RoomConfig; tokens:[string,string|null]; names:[string,string|null]
  signals:{id:number;to:Slot;signal:Signal}[]; next:number; touched:number; created:number
}
interface ServiceOptions { origins?:string[]; now?:()=>number; turnUrls?:string[]; turnSecret?:string }
const token=()=>randomBytes(24).toString('base64url')
const nameOf=(v:unknown)=>typeof v==='string'?v.trim().slice(0,24).replace(/[\u0000-\u001f]/g,''):''
export async function buildRoomService(opts:ServiceOptions={}) {
  const app=Fastify({bodyLimit:80*1024,logger:false}),rooms=new Map<string,Room>(),now=opts.now??Date.now
  const origins=opts.origins??[]
  await app.register(cors,{origin:origins.length?origins:false})
  await app.register(rateLimit,{max:600,timeWindow:'1 minute'})
  const expired=(r:Room)=>now()-r.touched>90_000||now()-r.created>4*3600_000
  const sweep=setInterval(()=>{for(const [code,r] of rooms)if(expired(r))rooms.delete(code)},30_000)
  sweep.unref();app.addHook('onClose',async()=>clearInterval(sweep))
  app.addHook('onRequest',async(req,reply)=>{
    // Bearer tokens also protect requests from other web origins; explicit CORS
    // governs hosted browser access. Creation/join reject unapproved Origins.
    const origin=req.headers.origin
    if(origin&&origins.length&&!origins.includes(origin))return reply.code(403).send({error:'Origin not allowed'})
    reply.header('Cache-Control','no-store')
  })
  function roomFor(code:string) {const r=rooms.get(code);if(r&&expired(r)){rooms.delete(code);return undefined}return r}
  function slotFor(r:Room,auth:string|undefined):Slot|null {
    const t=auth?.startsWith('Bearer ')?auth.slice(7):''
    if(t&&t===r.tokens[0])return 0
    if(t&&t===r.tokens[1])return 1
    return null
  }
  app.get('/health',async()=>({ok:true}))
  app.post<{Body:{name?:unknown;config?:unknown}}>('/rooms',{config:{rateLimit:{max:12,timeWindow:'1 minute'}}},async(req,reply)=>{
    if(!validConfig(req.body?.config)||!nameOf(req.body?.name))return reply.code(400).send({error:'Invalid room settings'})
    for(const [k,r] of rooms)if(expired(r))rooms.delete(k)
    if(rooms.size>=100)return reply.code(503).send({error:'Room service is full. Try again later.'})
    let code:string
    do{code=randomBytes(4).toString('hex').slice(0,6).toUpperCase()}while(rooms.has(code))
    const access=token(),r:Room={config:{...req.body.config},tokens:[access,null],names:[nameOf(req.body.name),null],signals:[],next:1,touched:now(),created:now()}
    rooms.set(code,r);return reply.code(201).send({code,token:access,slot:0,config:r.config})
  })
  app.post<{Params:{code:string};Body:{name?:unknown}}>('/rooms/:code/join',{config:{rateLimit:{max:24,timeWindow:'1 minute'}}},async(req,reply)=>{
    const code=req.params.code.toUpperCase(),r=roomFor(code)
    if(!r)return reply.code(404).send({error:'Room not found or expired'})
    if(r.tokens[1])return reply.code(409).send({error:'This room already has two drivers'})
    if(!nameOf(req.body?.name))return reply.code(400).send({error:'Enter a driver name'})
    const access=token();r.tokens[1]=access;r.names[1]=nameOf(req.body.name);r.touched=now()
    return {code,token:access,slot:1,config:r.config}
  })
  app.get<{Params:{code:string};Querystring:{after?:string}}>('/rooms/:code',async(req,reply)=>{
    const r=roomFor(req.params.code.toUpperCase())
    if(!r)return reply.code(404).send({error:'The room has closed'})
    const slot=slotFor(r,req.headers.authorization)
    if(slot===null)return reply.code(401).send({error:'Invalid room ticket'})
    r.touched=now()
    const after=Number(req.query.after??0)
    if(!Number.isSafeInteger(after)||after<0)return reply.code(400).send({error:'Invalid cursor'})
    return {names:r.names,config:r.config,signals:r.signals.filter(s=>s.to===slot&&s.id>after),cursor:r.next-1}
  })
  app.post<{Params:{code:string};Body:{signal?:Signal}}>('/rooms/:code/signals',async(req,reply)=>{
    const r=roomFor(req.params.code.toUpperCase())
    if(!r)return reply.code(404).send({error:'The room has closed'})
    const slot=slotFor(r,req.headers.authorization)
    if(slot===null)return reply.code(401).send({error:'Invalid room ticket'})
    const s=req.body?.signal
    if(!s||!['offer','answer','candidate'].includes(s.kind)||!s.data||typeof s.data!=='object')return reply.code(400).send({error:'Invalid connection message'})
    if((s.kind==='offer'&&slot!==0)||(s.kind==='answer'&&slot!==1))return reply.code(403).send({error:'Invalid connection role'})
    if(r.signals.length>=256)return reply.code(429).send({error:'Too many connection messages'})
    r.signals.push({id:r.next++,to:(1-slot) as Slot,signal:s});r.touched=now();return {ok:true}
  })
  app.get<{Params:{code:string}}>('/rooms/:code/ice',async(req,reply)=>{
    const code=req.params.code.toUpperCase(),r=roomFor(code)
    if(!r)return reply.code(404).send({error:'Room not found'})
    const slot=slotFor(r,req.headers.authorization)
    if(slot===null)return reply.code(401).send({error:'Invalid room ticket'})
    const iceServers:RTCIceServer[]=[{urls:'stun:stun.l.google.com:19302'}]
    if(opts.turnSecret&&opts.turnUrls?.length) {
      const username=`${Math.floor(now()/1000)+3600}:${code}:${slot}`
      const credential=createHmac('sha1',opts.turnSecret).update(username).digest('base64')
      iceServers.push({urls:opts.turnUrls,username,credential})
    }
    return {iceServers,relay:iceServers.length>1}
  })
  app.delete<{Params:{code:string}}>('/rooms/:code',async(req,reply)=>{
    const code=req.params.code.toUpperCase(),r=roomFor(code)
    if(r&&slotFor(r,req.headers.authorization)===null)return reply.code(401).send({error:'Invalid room ticket'})
    rooms.delete(code);return {ok:true}
  })
  return app
}
