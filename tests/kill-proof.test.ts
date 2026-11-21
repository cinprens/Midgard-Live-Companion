import {describe,expect,it} from 'vitest';
import {combatPacketEvidence,isConfirmedMonsterDeath,isConfirmedPersonalKill,isOwnDamageKill,analyzeEvents} from '../src/parser';
import type {ReplayEvent} from '../src/parser';
const death=(patch:Partial<ReplayEvent>={}):ReplayEvent=>({id:'death',timestamp:100,eventType:'death',targetId:100,monsterId:1002,entityKind:'mob',confidence:'unknown',attribution:'unknown',
  rawData:{killProof:{death:'vanish-kind-1',targetActorId:100,lifecycleId:'0:100:1',scope:'replay-local',ownership:'unknown'}},...patch});
describe('strict death evidence and explicit personal-kill contract',()=>{
  it('requires a typed mob and normalized death proof, never amount or a name alone',()=>{
    expect(isConfirmedMonsterDeath(death())).toBe(true);
    for(const patch of[{eventType:'damage',amount:999999},{entityKind:'pc'},{entityKind:'npc'},{rawData:{observedDeath:true}},{rawData:{killProof:{death:'damage-zero-hp'}}}]as Partial<ReplayEvent>[])expect(isConfirmedMonsterDeath(death(patch))).toBe(false);
  });
  it('rejects confidence-only, sole-attacker, missing owner and vanish-as-killer ownership claims',()=>{
    const claimed=death({actorId:42,confidence:'certain',attribution:'personal'});
    expect(isConfirmedPersonalKill(claimed,42)).toBe(false);expect(analyzeEvents([claimed],{playerId:42}).certainPersonalKills).toBe(0);
    const explicit=death({actorId:42,confidence:'certain',attribution:'personal',rawData:{killProof:{...claimed.rawData!.killProof as object,ownership:'explicit-killer-id',killerActorId:42,ownershipVerified:true,ownershipPacketId:'0x0080'}}});
    expect(isConfirmedPersonalKill(explicit,42)).toBe(false);
    explicit.rawData!.killProof={...explicit.rawData!.killProof as object,ownershipPacketId:'0xffff'};
    expect(isConfirmedPersonalKill(explicit,42)).toBe(true);expect(isConfirmedPersonalKill(explicit,99)).toBe(false);expect(isConfirmedPersonalKill(explicit,null)).toBe(false);
    expect(analyzeEvents([explicit],{playerId:42}).certainPersonalKills).toBe(1);
  });
  it('reads unsigned combat ticks only at source-defined offsets and exact widths',()=>{
    for(const[id,length,offset]of[[0x008a,29,10],[0x02e1,33,10],[0x08c8,34,10],[0x01de,33,12]]){
      const data=new Uint8Array(length),view=new DataView(data.buffer);view.setUint16(0,id,true);view.setUint32(offset,0xffffffff,true);
      expect(combatPacketEvidence(data)?.serverTick).toBe(0xffffffff);expect(combatPacketEvidence(data.subarray(0,length-1))).toBeNull();
    }
  });
});

describe('own-damage estimate contract',()=>{
  const ownDeath=():ReplayEvent=>death({actorId:42,attribution:'personal',confidence:'estimated',
    rawData:{attackers:[42],killProof:{...death().rawData!.killProof as object,ownership:'exclusive-observed-attacker-estimate',lastAttackTimestamp:90}}});
  it('accepts only the known recording owner and never promotes the estimate to confirmed ownership',()=>{
    const event=ownDeath();
    expect(isOwnDamageKill(event,42)).toBe(true);
    expect(isConfirmedPersonalKill(event,42)).toBe(false);
    for(const owner of[undefined,null,0,-1,1.5,NaN,Infinity,0x100000000,99])expect(isOwnDamageKill(event,owner)).toBe(false);
    for(const patch of[{actorId:99},{actorId:undefined},{attribution:'unknown'},{attribution:'other'},{attribution:'party'},
      {confidence:'certain'},{confidence:'unknown'},{eventType:'damage'},{entityKind:'pc'}]as Partial<ReplayEvent>[])
      expect(isOwnDamageKill({...event,...patch},42)).toBe(false);
  });
  it('requires an exclusive observed attacker and complete mob-death proof',()=>{
    const event=ownDeath();
    for(const attackers of[undefined,null,[],[99],[42,99],[42,42],['42'],{0:42,length:1}])
      expect(isOwnDamageKill({...event,rawData:{...event.rawData,attackers}},42)).toBe(false);
    for(const patch of[{ownership:'unknown'},{ownership:'explicit-killer-id'},{death:'damage-zero-hp'},{targetActorId:101},{lifecycleId:''}])
      expect(isOwnDamageKill({...event,rawData:{...event.rawData,killProof:{...event.rawData!.killProof as object,...patch}}},42)).toBe(false);
  });
  it('accepts the ten-second boundary but rejects missing, invalid, future and stale damage clocks',()=>{
    const event=ownDeath();
    for(const elapsed of[0,10000])expect(isOwnDamageKill({...event,timestamp:90+elapsed},42)).toBe(true);
    for(const timestamp of[89,10091,NaN,Infinity])expect(isOwnDamageKill({...event,timestamp},42)).toBe(false);
    for(const lastAttackTimestamp of[undefined,null,-1,NaN,Infinity,'90'])
      expect(isOwnDamageKill({...event,rawData:{...event.rawData,killProof:{...event.rawData!.killProof as object,lastAttackTimestamp}}},42)).toBe(false);
  });
});
