import type { LobbyState, Signal } from './protocol'
import type { Room } from './rooms'

/** How long a dropped link may take to come back before the race is ended. */
export const RECOVERY_MS=6000
/**
 * How long to wait for the direct link once both drivers are in the room,
 * before relaying through the room instead. A direct link between reachable
 * networks opens in well under two seconds; one that has not opened by now
 * almost never will (same Wi-Fi with client isolation, carrier NAT).
 */
export const RELAY_AFTER_MS=7000
const RELAY_HELLO='{"type":"relay"}'

/** The room only carries the handshake; race traffic goes only through the peer link. */
export class PeerLink {
  private pc:RTCPeerConnection|null=null
  private control:RTCDataChannel|null=null
  private fast:RTCDataChannel|null=null
  private offered=false
  private closed=false
  private candidates:RTCIceCandidateInit[]=[]
  /** Connection messages are handled strictly in order: an answer before its offer is a broken link. */
  private inbound:Promise<unknown>=Promise.resolve()
  private outbound:Promise<unknown>=Promise.resolve()
  private recoverTimer:ReturnType<typeof setTimeout>|null=null
  onLobby:(s:LobbyState)=>void=()=>{}
  onOpen:()=>void=()=>{}
  onControl:(v:unknown)=>void=()=>{}
  onFast:(v:unknown)=>void=()=>{}
  onError:(message:string)=>void=()=>{}
  connected=false
  relayAvailable=false
  /** True while the link has dropped and is being given time to recover. */
  reconnecting=false
  /** Race traffic is going through the room rather than directly. */
  relayed=false
  private relayTimer:ReturnType<typeof setTimeout>|null=null
  /** `forceRelay` skips the direct link: for trying the relay on one network. */
  constructor(readonly room:Room,private readonly opts:{forceRelay?:boolean}={}) {}
  get ticket(){return this.room.ticket}
  async open():Promise<void> {
    const forced=this.opts.forceRelay&&this.room.canRelay
    if(forced){this.startRoom();return}
    const ice=await this.room.iceServers()
    this.relayAvailable=ice.relay
    if(this.closed)return
    const pc=new RTCPeerConnection({iceServers:ice.iceServers});this.pc=pc
    pc.onicecandidate=e=>{if(e.candidate)this.signal({kind:'candidate',data:e.candidate.toJSON()})}
    pc.onconnectionstatechange=()=>{
      const state=pc.connectionState
      if(state==='failed'){
        // No direct path between these two networks: relay instead, if the room can.
        if(!this.connected&&this.room.canRelay){this.useRelay(true);return}
        this.fail(this.connected
        ?'Connection lost. The race has stopped.'
        :'Could not connect the two drivers. A relay may be needed on these networks.');return}
      // A momentary drop (Wi-Fi roaming, a busy router) usually recovers by
      // itself within a second or two. It used to end the race on the spot.
      if(state==='disconnected'&&!this.recoverTimer){this.reconnecting=true
        this.recoverTimer=setTimeout(()=>this.fail('Connection lost. The race has stopped.'),RECOVERY_MS)}
      if(state==='connected'&&this.recoverTimer){clearTimeout(this.recoverTimer);this.recoverTimer=null;this.reconnecting=false}
    }
    if(this.ticket.slot===0){this.bind(pc.createDataChannel('control'));this.bind(pc.createDataChannel('state',{ordered:false,maxRetransmits:0}))}
    else pc.ondatachannel=e=>this.bind(e.channel)
    this.startRoom()
  }
  private startRoom():void {
    this.room.start({
      lobby:s=>{
        this.onLobby(s)
        const other=s.names[1-this.ticket.slot]
        // Relaying, the room is the link: the other driver leaving it ends the race.
        if(this.relayed&&!other){this.fail('The other driver left the room.');return}
        if(other)this.armRelay()
        if(this.pc)this.inbound=this.inbound.then(()=>this.maybeOffer(s)).catch(()=>this.fail('The connection could not be set up.'))
      },
      signal:s=>{if(this.pc)this.inbound=this.inbound.then(()=>this.accept(s)).catch(()=>this.fail('The connection could not be set up.'))},
      relay:(channel,data)=>{
        // Either driver may give up on the direct link first; the other follows.
        if(!this.relayed)this.useRelay(false)
        if(data===RELAY_HELLO)return
        try{const value:unknown=JSON.parse(data);channel===0?this.onControl(value):this.onFast(value)}catch{/* malformed */}
      },
      error:m=>this.fail(m),
    })
  }
  /** Both drivers are in the room: start the clock on the direct link. */
  private armRelay():void {
    if(!this.room.canRelay||this.connected||this.relayTimer||this.closed)return
    const wait=this.opts.forceRelay?0:RELAY_AFTER_MS
    this.relayTimer=setTimeout(()=>{if(!this.connected)this.useRelay(true)},wait)
  }
  /** Give up on the direct link and carry the race through the room. */
  private useRelay(announce:boolean):void {
    if(this.relayed||this.closed)return
    this.relayed=true
    if(this.relayTimer){clearTimeout(this.relayTimer);this.relayTimer=null}
    if(this.recoverTimer){clearTimeout(this.recoverTimer);this.recoverTimer=null}
    // Quietly retire the direct attempt; its channels closing is not a departure.
    const pc=this.pc;this.pc=null
    if(pc){pc.onconnectionstatechange=null;pc.onicecandidate=null;pc.close()}
    if(announce)this.room.relay(0,RELAY_HELLO)
    this.connected=true;this.reconnecting=false
    this.room.connected();this.onOpen()
  }
  /** The host offers once the guest is in the room. */
  private async maybeOffer(s:LobbyState):Promise<void> {
    const pc=this.pc
    if(this.ticket.slot!==0||!s.names[1]||this.offered||!pc||this.closed)return
    this.offered=true
    const offer=await pc.createOffer();await pc.setLocalDescription(offer);this.signal({kind:'offer',data:offer})
  }
  private bind(channel:RTCDataChannel):void {
    if(channel.label==='control')this.control=channel
    else if(channel.label==='state')this.fast=channel
    else{channel.close();return}
    channel.onmessage=e=>{
      if(typeof e.data!=='string'||e.data.length>100_000)return
      try{const value:unknown=JSON.parse(e.data);channel.label==='control'?this.onControl(value):this.onFast(value)}catch{/* malformed peer packet */}
    }
    channel.onopen=()=>{if(!this.connected&&!this.relayed&&this.control?.readyState==='open'&&this.fast?.readyState==='open'){
      if(this.relayTimer){clearTimeout(this.relayTimer);this.relayTimer=null}
      this.connected=true;this.room.connected();this.onOpen()}}
    channel.onclose=()=>{if(!this.closed&&!this.relayed)this.fail('The other driver left the room.')}
    channel.onerror=()=>{if(!this.relayed)this.fail('Connection interrupted. Please create a new room.')}
  }
  controlSend(value:unknown):void {
    if(this.relayed){this.room.relay(0,JSON.stringify(value));return}
    if(this.control?.readyState==='open')this.control.send(JSON.stringify(value))
  }
  fastSend(value:unknown):void {
    if(this.relayed){this.room.relay(1,JSON.stringify(value));return}
    if(this.fast?.readyState==='open'&&this.fast.bufferedAmount<64_000)this.fast.send(JSON.stringify(value))
  }
  private signal(signal:Signal):void {
    this.outbound=this.outbound.then(()=>this.closed?undefined:this.room.send(signal))
      .catch(()=>this.fail('The room service could not complete the connection.'))
  }
  private async accept(s:Signal):Promise<void> {
    const pc=this.pc;if(!pc||this.closed)return
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
  private fail(message:string):void {if(!this.closed){this.connected=false;this.onError(message);this.close()}}
  /** Leave the room for good. */
  async leave():Promise<void> {this.close();await this.room.leave()}
  close():void {
    this.closed=true;this.connected=false
    if(this.recoverTimer)clearTimeout(this.recoverTimer)
    if(this.relayTimer)clearTimeout(this.relayTimer)
    this.room.close();this.pc?.close();this.pc=null
  }
}
