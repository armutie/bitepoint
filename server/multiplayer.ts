import { buildRoomService } from './multiplayerApp'
const app=await buildRoomService({
  origins:(process.env.MP_ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean),
  turnUrls:(process.env.TURN_URLS??'').split(',').map(s=>s.trim()).filter(Boolean),
  turnSecret:process.env.TURN_SECRET??'',
})
await app.listen({port:Number(process.env.PORT??8788),host:process.env.HOST??'127.0.0.1'})
console.log(`[multiplayer] room service on ${app.listeningOrigin}`)
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().finally(()=>process.exit(0))})
