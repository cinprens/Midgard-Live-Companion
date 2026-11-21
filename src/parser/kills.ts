import type {ReplayEvent} from './types';

export interface KillProof {
  death:'vanish-kind-1';
  ownership:'unknown'|'exclusive-observed-attacker-estimate'|'observed-other-attacker-estimate'|'explicit-killer-id';
  targetActorId:number;
  lifecycleId:string;
  mapEpoch:number;
  spawnObserved:boolean;
  scope:'replay-local';
  serverDeathTick:null;
  lastAttackServerTick:number|null;
  lastAttackTimestamp:number|null;
  /** This is a nearby clock sample, never the timestamp of the death itself. */
  lastServerClockTick:number|null;
  killerActorId?:number;
  ownershipVerified?:boolean;
  ownershipPacketId?:string;
}
const actor=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=0xffffffff;
const COMBAT_LENGTHS=new Map([[0x008a,29],[0x02e1,33],[0x08c8,34],[0x01de,33]]);
export function isConfirmedMonsterDeath(event:ReplayEvent):boolean {
  const proof=event.rawData?.killProof as Partial<KillProof>|undefined;
  return event.eventType==='death'&&event.entityKind==='mob'&&actor(event.monsterId)&&actor(event.targetId)&&
    proof?.death==='vanish-kind-1'&&proof.targetActorId===event.targetId&&proof.scope==='replay-local'&&
    typeof proof.lifecycleId==='string'&&proof.lifecycleId.length>0&&proof.lifecycleId.length<=128;
}
/** Current supported packets never produce explicit killer evidence. */
export function isConfirmedPersonalKill(event:ReplayEvent,playerId?:number|null):boolean {
  const proof=event.rawData?.killProof as Partial<KillProof>|undefined;
  const owner=playerId===undefined?event.actorId:playerId;
  return isConfirmedMonsterDeath(event)&&event.confidence==='certain'&&event.attribution==='personal'&&actor(owner)&&event.actorId===owner&&
    proof?.ownership==='explicit-killer-id'&&proof.killerActorId===owner&&proof.ownershipVerified===true&&
    typeof proof.ownershipPacketId==='string'&&/^0x[0-9a-f]{4}$/i.test(proof.ownershipPacketId)&&proof.ownershipPacketId.toLowerCase()!=='0x0080';
}
/** Own HP damage followed by a mob death is an estimate, never explicit killer evidence. */
export function isOwnDamageKill(event:ReplayEvent,playerId:number|null|undefined):boolean {
  const proof=event.rawData?.killProof as Partial<KillProof>|undefined;
  const attackers=event.rawData?.attackers;
  const lastAttack=proof?.lastAttackTimestamp;
  return isConfirmedMonsterDeath(event)&&actor(playerId)&&event.actorId===playerId&&
    event.attribution==='personal'&&event.confidence==='estimated'&&
    proof?.ownership==='exclusive-observed-attacker-estimate'&&Array.isArray(attackers)&&
    attackers.length===1&&attackers[0]===playerId&&typeof lastAttack==='number'&&Number.isFinite(lastAttack)&&
    Number.isFinite(event.timestamp)&&lastAttack>=0&&event.timestamp-lastAttack>=0&&event.timestamp-lastAttack<=10000;
}
export function combatPacketEvidence(data:Uint8Array):{serverTick:number;action:number;isSpDamage:boolean}|null {
  if(data.length<2)return null;
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength),id=view.getUint16(0,true);
  const length=COMBAT_LENGTHS.get(id);
  if(length===undefined||data.length!==length)return null;
  return{serverTick:view.getUint32(id===0x01de?12:10,true),action:data[id===0x008a?26:id===0x02e1?28:id===0x08c8?29:32]!,isSpDamage:id===0x08c8&&data[26]===1};
}
