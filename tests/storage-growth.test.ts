import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {ExpansionStore} from '../electron/expansion-store';
import {HUNT_ANALYTICS_SCHEMA,HuntAnalyticsIngest} from '../electron/hunt-analytics-ingest';
import {emptySummary,type ParsedReplay,type ReplayEvent} from '../src/parser';
import type {CharacterIdentity,LiveStreamStatus} from '../src/shared/types';

const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
const who:CharacterIdentity={key:'recorded:42:Storage',name:'Storage',source:'recorded',playerId:42};
const start='2026-11-05T23:59:50+03:00';
const tick=(timestamp:number):ReplayEvent=>({id:`tick-${timestamp}`,timestamp,eventType:'status',statusKey:'hp',amount:100,confidence:'certain'});
const loot=(timestamp:number):ReplayEvent=>({id:`loot-${timestamp}`,timestamp,eventType:'item-obtained',actorId:42,itemId:501,amount:2,confidence:'certain',rawData:{slot:5,inventoryOccurrence:1,inventoryAction:'incoming',inventorySource:'unknown',parserProof:'source-defined-add-delta',quantitySemantics:'added-delta',inventoryBaseline:false,inventoryHistoryReliable:true,inventoryWeightProof:{kind:'own-weight-increase',ownerActorId:42,before:100,after:120,receiptTimestamp:timestamp,weightTimestamp:timestamp+100,confirmedAt:timestamp+500,scope:'receipt-batch'}}});
const death=(timestamp:number):ReplayEvent=>({id:`death-${timestamp}`,timestamp,eventType:'death',actorId:42,targetId:timestamp+1,monsterId:1176,entityKind:'mob',confidence:'estimated',attribution:'personal',rawData:{attackers:[42],killProof:{death:'vanish-kind-1',targetActorId:timestamp+1,lifecycleId:`wire:${timestamp}:1`,scope:'replay-local',ownership:'exclusive-observed-attacker-estimate',lastAttackTimestamp:timestamp}}});
function replay(edge:number,events:ReplayEvent[]=[]):ParsedReplay{return{filename:'growth.rrf',format:'RRF',version:5,status:'partial',profile:'rrf-v5-latam',compatibility:'skadi-unverified',diagnostics:[],unknownPackets:[],packetCount:events.length,events,incremental:{delta:true,sequence:edge+1,recordingStart:edge===0,eventCount:events.length},summary:{...emptySummary(),startedAt:start,durationMs:edge,playerId:42,characterName:who.name}};}
async function profile(lightweightHistory=false){
  const qa=path.resolve('.qa');await mkdir(qa,{recursive:true});const dir=await mkdtemp(path.join(qa,'storage-growth-'));
  cleanup.push(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'profile.sqlite');
  let active=new ExpansionStore(file,{lightweightHistory,ownDamageOnly:true,killExperienceSoloOnly:true});
  cleanup.push(()=>active.close());
  const meta=(hash:string)=>({sourcePath:path.join(dir,'growth.rrf'),streamId:'stream',recordingId:'recording',hash,size:100,includeExperience:false});
  const read=(sql:string)=>{const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare(sql).all();}finally{db.close();}};
  return{file,meta,read,get store(){return active;},reopen(slim=true){active.close();active=new ExpansionStore(file,{lightweightHistory:slim,ownDamageOnly:true,killExperienceSoloOnly:true});}};
}

describe('bounded read metadata and retained daily ledgers',()=>{
  it.each([false,true])('stores no per-poll metadata for 1000 empty reads (lightweight=%s)',async lightweight=>{
    const f=await profile(lightweight);
    for(let n=0;n<1000;n++)f.store.observeReplay(replay(n,[tick(n)]),f.meta(`poll-${n}`),who);
    expect(f.store.stats()).toEqual({expEvents:0,expSnapshots:0,inventoryEvents:0,observations:0});
    expect(f.read('SELECT COUNT(*) n FROM replay_cursors')[0].n).toBe(lightweight?0:1);
  });
  it('writes a parent only for a newly inserted event and retains old inbox rows when slim mode starts',async()=>{
    const f=await profile();f.store.observeReplay(replay(0),f.meta('baseline'),who);
    f.store.observeReplay(replay(1600,[loot(1000)]),f.meta('receipt'),who);
    for(let n=0;n<50;n++)f.store.observeReplay(replay(1600,[loot(1000)]),f.meta(`duplicate-${n}`),who);
    expect(f.store.stats()).toMatchObject({inventoryEvents:1,observations:1});
    const old=f.read('SELECT * FROM inventory_events'),parents=f.read('SELECT * FROM replay_observations');
    f.reopen();f.store.observeReplay(replay(2600,[loot(2000)]),f.meta('ignored-inbox'),who);
    expect(f.read('SELECT * FROM inventory_events')).toEqual(old);expect(f.read('SELECT * FROM replay_observations')).toEqual(parents);
    expect(f.read('PRAGMA foreign_key_check')).toEqual([]);
  });
  it('keeps daily loot, own kills, earned EXP and prices while suppressing the redundant inbox',async()=>{
    const profiles=await Promise.all([profile(false),profile(true)]);
    for(const f of profiles){
      const feed=(edge:number,events:ReplayEvent[])=>{const parsed=replay(edge,events),meta=f.meta(`read-${edge}`);f.store.observeReplay(parsed,meta,who);f.store.autoFarm.observe(parsed,meta,who);f.store.killCount.observe(parsed,meta,who);f.store.killExperience.observe(parsed,meta,who);};
      feed(0,[]);f.store.autoFarm.setPrice({itemId:501,unitPrice:25});f.store.killExperience.setRate({characterKey:who.key,monsterId:1176,baseExp:100,jobExp:50});
      f.store.killExperience.control({characterKey:who.key,streamId:'stream',recordingId:'recording',action:'start'});
      for(let n=1;n<=200;n++){const edge=n*100;feed(edge,n===50||n===150?[loot(edge-600),death(edge),tick(edge)]:[tick(edge)]);}
    }
    for(const date of ['2026-11-05','2026-11-06']){
      const baseline=profiles[0].store,slim=profiles[1].store;
      expect(slim.financeDaily.read({date}).totals).toEqual(baseline.financeDaily.read({date}).totals);
      expect(slim.killDaily.read({date})).toEqual(baseline.killDaily.read({date}));
      expect(slim.soloExperienceDaily.read({date}).totals).toEqual(baseline.soloExperienceDaily.read({date}).totals);
      expect(slim.financeDaily.read({date}).totals).toMatchObject({quantity:2,knownValue:50,durationMs:10000});
      expect(slim.soloExperienceDaily.read({date}).totals).toMatchObject({observedDeaths:1,durationMs:10000,base:{gained:100},job:{gained:50}});
    }
    expect(profiles.map(f=>f.store.stats().inventoryEvents)).toEqual([2,0]);
    expect(profiles[1].store.autoFarm.snapshot().prices).toMatchObject([{itemId:501,unitPrice:25}]);
    for(const f of profiles){expect(f.read('SELECT COUNT(*) n FROM solo_experience_calendar_intervals')[0].n).toBe(1);expect(f.read('SELECT COUNT(*) n FROM autofarm_receipts')[0].n).toBe(2);expect(f.read('PRAGMA foreign_key_check')).toEqual([]);}
    const saved=profiles[1].store.financeDaily.read({date:'2026-11-06'}).totals;profiles[1].reopen();
    expect(profiles[1].store.financeDaily.read({date:'2026-11-06'}).totals).toEqual(saved);
    expect(profiles[1].store.autoFarm.snapshot().prices).toMatchObject([{itemId:501,unitPrice:25}]);
  });
  it('retains actual coverage breaks while suppressing 1000 active read-state transitions',()=>{
    const db=new DatabaseSync(':memory:');db.exec(HUNT_ANALYTICS_SCHEMA);const ingest=new HuntAnalyticsIngest(db,{lightweightHistory:true});cleanup.push(()=>{ingest.close();db.close();});
    const source=path.resolve('.qa/status-growth.rrf'),monitor=(status:LiveStreamStatus)=>[{id:'stream',sourcePath:source,status,character:who}],meta=(hash:string)=>({sourcePath:source,streamId:'stream',recordingId:'recording',hash});
    ingest.syncStatuses(monitor('following'));ingest.observe(replay(0),meta('base'),who);
    for(let n=0;n<1000;n++)ingest.syncStatuses(monitor(n%2?'following':'reading'));
    ingest.observe(replay(1000,[death(900)]),meta('first'),who);
    expect(db.prepare('SELECT COUNT(*) n FROM hunt_analytics_statuses').get()?.n).toBe(1);
    ingest.syncStatuses(monitor('missing'));ingest.syncStatuses(monitor('error'));ingest.syncStatuses(monitor('following'));
    ingest.observe(replay(3000),meta('reconnect'),who);ingest.observe(replay(4000,[death(3900)]),meta('next'),who);
    expect(db.prepare('SELECT status FROM hunt_analytics_statuses ORDER BY id').all()).toEqual([{status:'following'},{status:'missing'},{status:'following'}]);
    const spans=db.prepare("SELECT start_ms,end_ms FROM hunt_analytics_intervals WHERE provenance='prospective' ORDER BY start_ms").all(),anchor=Date.parse(start);
    expect(spans).toEqual([{start_ms:anchor,end_ms:anchor+1001},{start_ms:anchor+3000,end_ms:anchor+4001}]);
    expect(db.prepare('SELECT COUNT(*) n FROM hunt_analytics_events').get()?.n).toBe(2);
  });
  it('releases removed hunt runtimes and reconnects using persisted cursors without duplicating daily kills',async()=>{
    const f=await profile(true),store=f.store,base=f.meta('base');store.targetHunt.setTargets({monsterIds:[1176]});
    const monitor=(status:LiveStreamStatus='following',sourcePath=base.sourcePath)=>[{id:'stream',sourcePath,status,character:who}];
    const sync=(streams:ReturnType<typeof monitor>)=>{store.targetHunt.syncStatuses(streams);store.huntAnalytics.syncStatuses(streams);};
    const sizes=()=>[store.targetHunt,store.huntAnalytics].map(value=>(value as unknown as {runtime:Map<string,unknown>}).runtime.size);
    const feed=(edge:number,events:ReplayEvent[],initial=false)=>{const parsed=replay(edge,events),meta={...base,hash:`edge-${edge}-${initial}`,initial};store.targetHunt.observe(parsed,{...meta,bootstrap:initial},who);store.huntAnalytics.observe(parsed,meta,who);store.killCount.observe(parsed,meta,who);};
    sync(monitor());feed(0,[],true);feed(1000,[death(1000)]);
    const savedTarget=f.read('SELECT recording_key,frontier_ms FROM own_damage_target_hunt_sources'),savedAnalytics=f.read('SELECT recording_key,frontier_ms,generation FROM own_damage_hunt_analytics_sources');
    sync(monitor('missing'));expect(sizes()).toEqual([1,1]);sync([]);expect(sizes()).toEqual([0,0]);
    expect(f.read('SELECT recording_key,frontier_ms FROM own_damage_target_hunt_sources')).toEqual(savedTarget);
    expect(f.read('SELECT recording_key,frontier_ms,generation FROM own_damage_hunt_analytics_sources')).toEqual(savedAnalytics);
    sync(monitor());feed(1000,[death(1000)],true);feed(2000,[death(2000)]);
    expect(f.read('SELECT COUNT(*) n FROM own_damage_target_hunt_candidates')[0].n).toBe(2);
    expect(f.read('SELECT COUNT(*) n FROM own_damage_hunt_analytics_events')[0].n).toBe(2);
    expect(store.killDaily.read({date:'2026-11-05'}).totals.observedDeaths).toBe(2);
    for(let n=0;n<50;n++){
      const sourcePath=path.join(path.dirname(base.sourcePath),`rotation-${n}.rrf`);sync(monitor('following',sourcePath));
      const meta={...base,sourcePath,hash:`rotate-${n}`,initial:true};store.targetHunt.observe(replay(0),{...meta,bootstrap:true},who);store.huntAnalytics.observe(replay(0),meta,who);
      expect(sizes()).toEqual([1,1]);sync([]);expect(sizes()).toEqual([0,0]);
    }
    expect(store.killDaily.read({date:'2026-11-05'}).totals.observedDeaths).toBe(2);
    expect(f.read('PRAGMA foreign_key_check')).toEqual([]);
  });
});
