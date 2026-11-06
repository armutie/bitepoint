import {describe,it,expect} from 'vitest'
import {createHmac} from 'node:crypto'
import {buildRoomService} from './multiplayerApp'
import {PROTOCOL,type Ticket} from '../src/multiplayer/protocol'
const config={protocol:PROTOCOL,trackId:'power_8',preset:'legacy',laps:3,contact:false,manual:false,abs:true}
describe('private multiplayer room service',()=>{
  it('limits a room to two drivers and keeps signaling private to the recipient',async()=>{
    const app=await buildRoomService()
    try{
      const host=(await app.inject({method:'POST',url:'/rooms',payload:{name:'Host',config}})).json<Ticket>()
      const base=`/rooms/${host.code}`,h={authorization:`Bearer ${host.token}`}
      expect((await app.inject({url:base})).statusCode).toBe(401)
      const guest=(await app.inject({method:'POST',url:base+'/join',payload:{name:'Guest'}})).json<Ticket>()
      expect((await app.inject({method:'POST',url:base+'/join',payload:{name:'Third'}})).statusCode).toBe(409)
      const signal={kind:'offer',data:{type:'offer',sdp:'test'}}
      expect((await app.inject({method:'POST',url:base+'/signals',headers:h,payload:{signal}})).statusCode).toBe(200)
      expect((await app.inject({url:base,headers:h})).json().signals).toHaveLength(0)
      const g={authorization:`Bearer ${guest.token}`}
      expect((await app.inject({url:base,headers:g})).json().signals).toHaveLength(1)
      expect((await app.inject({method:'POST',url:base+'/signals',headers:g,payload:{signal}})).statusCode).toBe(403)
      expect((await app.inject({method:'DELETE',url:base,headers:g})).statusCode).toBe(200)
      expect((await app.inject({url:base,headers:h})).statusCode).toBe(404)
    }finally{await app.close()}
  })
  it('rejects mismatched builds and supplies expiring TURN credentials without disclosing its secret',async()=>{
    const secret='unit-test-turn-secret',now=1_800_000_000_000
    const app=await buildRoomService({now:()=>now,origins:['https://example.test'],turnUrls:['turn:relay.example:3478'],turnSecret:secret})
    try{
      expect((await app.inject({method:'POST',url:'/rooms',payload:{name:'Host',config:{...config,protocol:'old'}}})).statusCode).toBe(400)
      expect((await app.inject({method:'POST',url:'/rooms',headers:{origin:'https://other.test'},payload:{name:'Host',config}})).statusCode).toBe(403)
      const host=(await app.inject({method:'POST',url:'/rooms',payload:{name:'Host',config}})).json<Ticket>()
      const r=await app.inject({url:`/rooms/${host.code}/ice`,headers:{authorization:`Bearer ${host.token}`}})
      const ice=r.json().iceServers[1]
      expect(ice.username).toBe(`${now/1000+3600}:${host.code}:0`)
      expect(ice.credential).toBe(createHmac('sha1',secret).update(ice.username).digest('base64'))
      expect(r.body).not.toContain(secret)
    }finally{await app.close()}
  })
  it('expires abandoned rooms',async()=>{
    let now=1000;const app=await buildRoomService({now:()=>now})
    try{const t=(await app.inject({method:'POST',url:'/rooms',payload:{name:'Host',config}})).json<Ticket>()
      now+=91_000;expect((await app.inject({url:`/rooms/${t.code}`,headers:{authorization:`Bearer ${t.token}`}})).statusCode).toBe(404)
    }finally{await app.close()}
  })
})
