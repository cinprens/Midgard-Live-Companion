import { isConfirmedMonsterDeath } from '../parser/kills';
import type { ReplayEvent } from '../parser/types';
import { createDefaultAlertPreferences, validateAlertPreferences } from './notifications';
import type { AlertPreferences, LiveNotification, NotificationEvent, NotificationSnapshot } from './notifications';

export interface MonsterDeathAlertOptions {
  clock?:()=>number;
  nameForMonster?:(monsterId:number,observedName?:string)=>string|undefined|null;
  /** Optional per-character burst throttle; this is not cross-client kill deduplication. */
  perCharacterCooldownMs?:number;
  seenTtlMs?:number;
  streamTtlMs?:number;
  maxSeenKeys?:number;
  maxStreamStates?:number;
  maxFingerprintsPerStream?:number;
  maxNotificationsPerSnapshot?:number;
}
interface StreamState {
  recordingId:string;
  watermark:number;
  fingerprints:Set<string>;
  saturated:boolean;
  lastSeen:number;
}
const integerOption=(value:number|undefined,fallback:number,minimum:number,maximum:number):number=>{
  const result=value??fallback;
  if(!Number.isSafeInteger(result)||result<minimum||result>maximum)throw new Error('Yaratık bildirimi kaynak sınırı geçersiz.');
  return result;
};
function proof(event:NotificationEvent):Record<string,unknown>{
  const value=event.rawData?.killProof;
  return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
}
function normalizedDeath(event:NotificationEvent):ReplayEvent{
  return{id:event.id??'',eventType:'death',timestamp:event.timestamp,confidence:event.confidence??'unknown',
    actorId:event.actorId,targetId:event.targetId,monsterId:event.monsterId,monsterName:event.monsterName,
    entityKind:event.entityKind,attribution:event.attribution,packetId:event.packetId,mapId:event.mapId,rawData:event.rawData};
}
function semantic(event:NotificationEvent):string{
  return JSON.stringify([event.timestamp,event.targetId,event.monsterId,event.mapId??null,proof(event).lifecycleId]);
}
function lifecycle(event:NotificationEvent):string{
  return JSON.stringify([event.targetId,event.monsterId,event.mapId??null,proof(event).lifecycleId]);
}

/** Volatile observation alerts. Never claims who killed the monster. */
export class MonsterDeathAlertEngine {
  private preferences:AlertPreferences;
  private streams=new Map<string,StreamState>();
  private seen=new Map<string,number>();
  private cooldowns=new Map<string,number>();
  private sequence=0;
  private clock:()=>number;
  private nameForMonster:MonsterDeathAlertOptions['nameForMonster'];
  private cooldown:number;
  private seenTtl:number;
  private streamTtl:number;
  private maxSeen:number;
  private maxStreams:number;
  private maxFingerprints:number;
  private maxNotifications:number;
  private lastPrune=-Infinity;
  constructor(preferences:AlertPreferences=createDefaultAlertPreferences(),options:MonsterDeathAlertOptions={}){
    this.preferences=validateAlertPreferences(preferences);
    this.clock=options.clock??Date.now;this.nameForMonster=options.nameForMonster;
    this.cooldown=integerOption(options.perCharacterCooldownMs,0,0,3600000);
    this.seenTtl=integerOption(options.seenTtlMs,3600000,1000,24*3600000);
    this.streamTtl=integerOption(options.streamTtlMs,2*3600000,1000,24*3600000);
    this.maxSeen=integerOption(options.maxSeenKeys,16384,8,65536);
    this.maxStreams=integerOption(options.maxStreamStates,4096,1,16384);
    this.maxFingerprints=integerOption(options.maxFingerprintsPerStream,1024,8,4096);
    this.maxNotifications=integerOption(options.maxNotificationsPerSnapshot,16,1,64);
  }
  setPreferences(preferences:AlertPreferences):void{this.preferences=validateAlertPreferences(preferences);}
  observe(snapshot:NotificationSnapshot,preferences:AlertPreferences=this.preferences):LiveNotification[]{
    if(!snapshot.streamId||!snapshot.recordingId)throw new Error('Yaratık bildirimi için akış ve kayıt kimliği gerekli.');
    const now=this.clock();if(!Number.isFinite(now))throw new Error('Yaratık bildirimi zamanı geçersiz.');
    const selected=validateAlertPreferences(preferences);
    this.prune(now);
    let state=this.streams.get(snapshot.streamId);
    const baseline=!state||snapshot.reset===true||state.recordingId!==snapshot.recordingId;
    if(baseline)state={recordingId:snapshot.recordingId,watermark:-1,fingerprints:new Set(),saturated:false,lastSeen:now};
    const current=state!;
    current.lastSeen=now;
    this.streams.delete(snapshot.streamId);this.streams.set(snapshot.streamId,current);
    while(this.streams.size>this.maxStreams)this.streams.delete(this.streams.keys().next().value!);
    let maximum=-1;
    for(const event of snapshot.events)if(Number.isFinite(event.timestamp)&&event.timestamp>=0)maximum=Math.max(maximum,event.timestamp);
    // A temporary tail cut must neither rewind the cursor nor replay old alerts.
    if(!baseline&&maximum<current.watermark)return[];
    const next=new Set<string>();let saturated=false;
    const output:LiveNotification[]=[];
    let events=snapshot.events.filter(event=>Number.isFinite(event.timestamp)&&event.timestamp>=0&&event.eventType==='death'&&isConfirmedMonsterDeath(normalizedDeath(event)));
    for(let i=1;i<events.length;i++)if(events[i].timestamp<events[i-1].timestamp){events=[...events].sort((a,b)=>a.timestamp-b.timestamp);break;}
    const encountered=new Set<string>(),monsterIds=new Set(selected.selectedMonsterIds);
    for(const event of events){
      const identity=semantic(event);
      if(event.timestamp===maximum){if(next.size<this.maxFingerprints||next.has(identity))next.add(identity);else saturated=true;}
      if(event.timestamp<current.watermark||event.timestamp===current.watermark&&(current.saturated||current.fingerprints.has(identity)))continue;
      if(encountered.has(identity))continue;encountered.add(identity);
      // Baselines only advance this stream. They never poison global emitted keys.
      if(baseline||!selected.enabled.monster||!monsterIds.has(event.monsterId!))continue;
      const local=`local:${snapshot.streamId}:${snapshot.recordingId}:${lifecycle(event)}`;
      const shared=this.sharedKey(snapshot,event,identity);
      if(this.wasEmitted(local,now)||shared!==null&&this.wasEmitted(shared,now))continue;
      const characterKey=snapshot.characterKey??`stream:${snapshot.streamId}`;
      const last=this.cooldowns.get(characterKey);
      if(this.cooldown>0&&last!==undefined&&now-last<this.cooldown)continue;
      if(output.length>=this.maxNotifications)continue;
      const resolved=this.nameForMonster?.(event.monsterId!,event.monsterName)??event.monsterName??(event.monsterId===1313?'Mobster':`Yaratık #${event.monsterId}`);
      const name=resolved.trim().normalize('NFC').slice(0,120)||`Yaratık #${event.monsterId}`;
      output.push({id:`monster:${snapshot.streamId}:${++this.sequence}`,type:'monster',streamId:snapshot.streamId,character:snapshot.character,
        at:new Date(now).toISOString(),monsterId:event.monsterId,amount:1,subject:name,characterKey:snapshot.characterKey,
        message:`${name} ölümü görüldü. Öldüren karakter doğrulanamadı.`,audio:{volume:selected.volume,muted:selected.muted}});
      this.remember(local,now);if(shared!==null)this.remember(shared,now);
      if(this.cooldown>0){this.cooldowns.delete(characterKey);this.cooldowns.set(characterKey,now);while(this.cooldowns.size>this.maxStreams)this.cooldowns.delete(this.cooldowns.keys().next().value!);}
    }
    if(maximum===current.watermark){
      for(const key of current.fingerprints){if(next.size<this.maxFingerprints||next.has(key))next.add(key);else saturated=true;}
      saturated ||= current.saturated;
    }
    current.watermark=Math.max(current.watermark,maximum);current.fingerprints=next;current.saturated=saturated;
    return output;
  }
  remove(streamId:string):void{this.streams.delete(streamId);}
  clear():void{this.streams.clear();this.seen.clear();this.cooldowns.clear();this.lastPrune=-Infinity;}
  stats():{streams:number;seenKeys:number;cooldownKeys:number;fingerprints:number;maximumSeenKeys:number;maximumStreams:number}{
    let fingerprints=0;for(const stream of this.streams.values())fingerprints+=stream.fingerprints.size;
    return{streams:this.streams.size,seenKeys:this.seen.size,cooldownKeys:this.cooldowns.size,fingerprints,maximumSeenKeys:this.maxSeen,maximumStreams:this.maxStreams};
  }
  private sharedKey(snapshot:NotificationSnapshot,event:NotificationEvent,identity:string):string|null{
    const evidence=proof(event);
    if(evidence.serverEventIdVerified===true&&typeof evidence.serverEventId==='string'&&evidence.serverEventId.length>0&&evidence.serverEventId.length<=128&&typeof evidence.serverEventScope==='string'&&evidence.serverEventScope.length>0&&evidence.serverEventScope.length<=128){
      return`server:${evidence.serverEventScope}:${evidence.serverEventId}`;
    }
    if(snapshot.recordIdentityVerified===true&&typeof snapshot.recordingContentHash==='string'&&/^[a-f0-9]{64}$/i.test(snapshot.recordingContentHash)){
      return`replay:${snapshot.recordingId}:${snapshot.recordingContentHash.toLowerCase()}:${identity}`;
    }
    return null;
  }
  private wasEmitted(key:string,now:number):boolean{
    const at=this.seen.get(key);if(at===undefined)return false;
    if(now-at>=this.seenTtl){this.seen.delete(key);return false;}return true;
  }
  private remember(key:string,now:number):void{
    this.seen.delete(key);this.seen.set(key,now);while(this.seen.size>this.maxSeen)this.seen.delete(this.seen.keys().next().value!);
  }
  private prune(now:number):void{
    if(now-this.lastPrune<1000)return;this.lastPrune=now;
    for(const[key,at]of this.seen)if(now-at>=this.seenTtl)this.seen.delete(key);
    for(const[key,state]of this.streams)if(now-state.lastSeen>=this.streamTtl)this.streams.delete(key);
    for(const[key,at]of this.cooldowns)if(now-at>=Math.max(1000,this.cooldown))this.cooldowns.delete(key);
  }
}
