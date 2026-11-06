import { type Ticket, type Signal, type RoomConfig, type LobbyState } from './protocol'

const BASE=(import.meta.env['VITE_MULTIPLAYER_SERVER'] as string|undefined)?.replace(/\/$/,'')??'./multiplayer-api'
export async function service<T>(path:string,method='GET',body?:unknown,ticket?:Ticket):Promise<T> {
  const response=await fetch(BASE+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),
    ...(ticket?{Authorization:`Bearer ${ticket.token}`}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)})
  const data=await response.json().catch(()=>({error:'Room service unavailable'}))
  if(!response.ok)throw new Error(data.error??'Room service unavailable')
  return data as T
}
export const createRoom=(name:string,config:RoomConfig)=>service<Ticket>('/rooms','POST',{name,config})
export const joinRoom=(name:string,code:string)=>service<Ticket>(`/rooms/${encodeURIComponent(code)}/join`,'POST',{name})

/** Signaling goes through HTTP; race traffic goes only through the peer link. */
export class PeerLink {
  private pc:RTCPeerConnection|null=null
  private control:RTCDataChannel|null=null
  private fast:RTCDataChannel|null=null
  private timer:ReturnType<typeof setTimeout>|null=null
  private cursor=0
  private offered=false
  private closed=false
  private candidates:RTCIceCandidateInit[]=[]
  private signalChain:Promise<unknown>=Promise.resolve()
  onLobby:(s:LobbyState)=>void=()=>{}
  onOpen:()=>void=()=>{}
  onControl:(v:unknown)=>void=()=>{}
  onFast:(v:unknown)=>void=()=>{}
  onError:(message:string)=>void=()=>{}
  connected=false
  relayAvailable=false
  constructor(readonly ticket:Ticket) {}
  async open():Promise<void> {
    const ice=await service<{iceServers:RTCIceServer[];relay:boolean}>(`/rooms/${this.ticket.code}/ice`,'GET',undefined,this.ticket)
    this.relayAvailable=ice.relay
    if(this.closed)return
    const pc=new RTCPeerConnection({iceServers:ice.iceServers});this.pc=pc
    pc.onicecandidate=e=>{if(e.candidate)this.signal({kind:'candidate',data:e.candidate.toJSON()})}
    pc.onconnectionstatechange=()=>{
      if(pc.connectionState==='failed')this.fail('Could not connect the two drivers. A relay may be needed on these networks.')
      if(pc.connectionState==='disconnected')this.fail('Connection interrupted. The race has stopped.')
    }
    if(this.ticket.slot===0){this.bind(pc.createDataChannel('control'));this.bind(pc.createDataChannel('state',{ordered:false,maxRetransmits:0}))}
    else pc.ondatachannel=e=>this.bind(e.channel)
    void this.poll()
  }
  private bind(channel:RTCDataChannel):void {
    if(channel.label==='control')this.control=channel
    else if(channel.label==='state')this.fast=channel
    else{channel.close();return}
    channel.onmessage=e=>{
      if(typeof e.data!=='string'||e.data.length>100_000)return
      try{const value:unknown=JSON.parse(e.data);channel.label==='control'?this.onControl(value):this.onFast(value)}catch{/* malformed peer packet */}
    }
    channel.onopen=()=>{if(!this.connected&&this.control?.readyState==='open'&&this.fast?.readyState==='open'){this.connected=true;this.onOpen()}}
    channel.onclose=()=>{if(!this.closed)this.fail('The other driver left the room.')}
    channel.onerror=()=>this.fail('Connection interrupted. Please create a new room.')
  }
  controlSend(value:unknown):void {if(this.control?.readyState==='open')this.control.send(JSON.stringify(value))}
  fastSend(value:unknown):void {if(this.fast?.readyState==='open'&&this.fast.bufferedAmount<64_000)this.fast.send(JSON.stringify(value))}
  private signal(signal:Signal):void {
    this.signalChain=this.signalChain.then(()=>this.closed?undefined:service(`/rooms/${this.ticket.code}/signals`,'POST',{signal},this.ticket))
      .catch(()=>this.fail('The room service could not complete the connection.'))
  }
  private async accept(s:Signal):Promise<void> {
    const pc=this.pc;if(!pc)return
    if(s.kind==='candidate') {
      if(pc.remoteDescription)await pc.addIceCandidate(s.data as RTCIceCandidateInit)
      else this.candidates.push(s.data as RTCIceCandidateInit)
      return
    }
    await pc.setRemoteDescription(s.data as RTCSessionDescriptionInit)
    for(const c of this.candidates)await pc.addIceCandidate(c)
    this.candidates=[]
    if(s.kind==='offer'){const a=await pc.createAnswer();await pc.setLocalDescription(a);this.signal({kind:'answer',data:a})}
  }
  private async poll():Promise<void> {
    if(this.closed)return
    try {
      const state=await service<LobbyState&{signals:{id:number;signal:Signal}[];cursor:number}>(`/rooms/${this.ticket.code}?after=${this.cursor}`,'GET',undefined,this.ticket)
      if(this.closed)return
      this.onLobby(state)
      for(const entry of state.signals)await this.accept(entry.signal)
      this.cursor=state.cursor
      if(this.ticket.slot===0&&state.names[1]&&!this.offered&&this.pc){this.offered=true
        const offer=await this.pc.createOffer();await this.pc.setLocalDescription(offer);this.signal({kind:'offer',data:offer})}
    } catch(e){this.fail(e instanceof Error?e.message:'Room connection lost');return}
    if(!this.closed)this.timer=setTimeout(()=>void this.poll(),this.connected?10_000:650)
  }
  private fail(message:string):void {if(!this.closed){this.connected=false;this.onError(message);this.close()}}
  close():void {this.closed=true;this.connected=false;if(this.timer)clearTimeout(this.timer);this.pc?.close();this.pc=null}
}
