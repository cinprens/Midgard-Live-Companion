import { afterEach,describe,expect,it } from 'vitest';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ExpansionStore } from '../electron/expansion-store';
import { emptySummary,type ParsedReplay,type ReplayEvent } from '../src/parser';

const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
async function profile(){await mkdir('.qa',{recursive:true});const dir=await mkdtemp(path.resolve('.qa/kill-count-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'midgard-live.sqlite'),store=new ExpansionStore(file);cleanup.push(()=>store.close());return{dir,file,store};}
function owner(index=1){return{key:`recorded:${index}:Karakter`,name:`Karakter ${index}`,source:'recorded' as const,playerId:index};}
const meta=(dir:string,index=1,hash='first')=>({sourcePath:path.join(dir,`${index}.rrf`),streamId:`stream-${index}`,hash,recordingId:`recording-${index}`,observedAt:'2026-11-01T01:00:00Z'});
const tick=(timestamp:number):ReplayEvent=>({id:`tick-${timestamp}`,timestamp,eventType:'status',statusKey:'hp',amount:100,confidence:'certain'});
function replay(events:ReplayEvent[],index=1):ParsedReplay{return{filename:`${index}.rrf`,format:'RRF',version:5,status:'partial',profile:'rrf-v5-latam',compatibility:'skadi-unverified',diagnostics:[],unknownPackets:[],packetCount:events.length,events,summary:{...emptySummary(),characterName:`Karakter ${index}`,playerId:index,startedAt:'2026-11-01T00:00:00Z'}};}
function deltaReplay(events:ReplayEvent[],durationMs:number,sequence:number):ParsedReplay{return{...replay(events),incremental:{delta:true,sequence,recordingStart:sequence===1,eventCount:events.length},summary:{...replay(events).summary,durationMs}};}
function wireDeath(timestamp:number,targetId:number,ordinal:number,personal=false):ReplayEvent{const event=death(timestamp,targetId,20001,personal);return{...event,rawData:{...event.rawData,killProof:{...(event.rawData!.killProof as Record<string,unknown>),lifecycleId:`wire:0:${targetId}:${ordinal}`}}};}
/** Explicit ownership here is a normalized future-source fixture, never a supported Skadi wire claim. */
function death(timestamp:number,targetId:number,monsterId=20001,personal=true,playerId=1,generation=1):ReplayEvent{return{id:`death-${targetId}-${generation}`,eventType:'death',timestamp,targetId,actorId:personal?playerId:undefined,monsterId,entityKind:'mob',confidence:personal?'certain':'unknown',attribution:personal?'personal':'unknown',rawData:{killProof:{death:'vanish-kind-1',scope:'replay-local',targetActorId:targetId,lifecycleId:`0:${targetId}:${generation}`,mapEpoch:0,spawnObserved:true,serverDeathTick:null,ownership:personal?'explicit-killer-id':'unknown',...(personal?{killerActorId:playerId,ownershipVerified:true,ownershipPacketId:'0x7f01'}:{})}}};}
describe('persistent evidence-gated kill counts',()=>{
  it('counts normalized explicit-proof Hode100 plus Sandman25 as125 and never substitutes damage',async()=>{
    const{dir,store}=await profile();store.killCount.setLocalMonsterNames(new Map([[20001,'Hode'],[20002,'Sandman']]));const events=[...Array.from({length:100},(_,i)=>death(i+1,i+100)),...Array.from({length:25},(_,i)=>death(i+101,i+1000,20002)),tick(3600000)];
    store.killCount.observe(replay(events),meta(dir),owner());const state=store.killCount.snapshot();expect(state.totals).toMatchObject({totalKills:125,confirmedPersonalKills:125,observedDeaths:125,unknownDeaths:0,killsPerHour:125,durationMs:3600000,uncertain:false});expect(state.monsters.map(row=>[row.monsterName,row.totals.totalKills])).toEqual([['Hode',100],['Sandman',25]]);
  });
  it('keeps damage, generic vanish and attacker estimates out of personal kills',async()=>{
    const{dir,store}=await profile(),estimate=death(10,100,20001,false);estimate.confidence='estimated';estimate.attribution='personal';estimate.actorId=1;(estimate.rawData!.killProof as Record<string,unknown>).ownership='exclusive-observed-attacker-estimate';
    store.killCount.observe(replay([{...death(1,99),eventType:'damage',amount:9999},{id:'unproven',eventType:'death',timestamp:2,monsterId:20001,targetId:98,entityKind:'mob',confidence:'certain'},estimate,tick(3600000)]),meta(dir),owner());expect(store.killCount.snapshot().totals).toMatchObject({totalKills:null,confirmedPersonalKills:0,observedDeaths:1,unknownDeaths:1,killsPerHour:null,uncertain:true});
  });
  it('deduplicates same replay copies, repeated packets and repeated lifecycle while allowing respawn',async()=>{
    const{dir,store}=await profile(),events=[death(100,10),{...death(100,10),id:'repeated-id'},{...death(101,10),id:'later-duplicate'},death(200,10,20001,true,1,2),tick(1000)],first=meta(dir);
    store.killCount.observe(replay(events),first,owner());store.killCount.observe(replay(events),{...first,sourcePath:path.join(dir,'copy.rrf'),hash:'copy'},owner());store.killCount.observe(replay(events),{...first,hash:'repeat'},owner());expect(store.killCount.snapshot().totals).toMatchObject({totalKills:2,observedDeaths:2});
  });
  it('preserves counts across partial tails and reopening without replaying events',async()=>{
    const{dir,file,store}=await profile(),events=[death(100,10),death(200,20),tick(2000)];store.killCount.observe(replay(events),meta(dir),owner());store.killCount.observe(replay(events.slice(0,1)),meta(dir,1,'partial'),owner());expect(store.killCount.snapshot().totals.totalKills).toBe(2);store.close();cleanup.pop();
    const opened=new ExpansionStore(file);cleanup.push(()=>opened.close());opened.killCount.observe(replay(events),meta(dir,1,'reopened'),owner());expect(opened.killCount.snapshot().totals.totalKills).toBe(2);opened.killCount.observe(replay([...events,death(2100,30)]),meta(dir,1,'new'),owner());expect(opened.killCount.snapshot().totals.totalKills).toBe(3);
  });
  it('does not claim an exact combined kill total for overlapping independent clients',async()=>{
    const{dir,store}=await profile();for(let index=1;index<=3;index++)store.killCount.observe(replay([death(1000,50,20001,true,index),tick(3600000)],index),meta(dir,index),owner(index));const state=store.killCount.snapshot();expect(state.totals).toMatchObject({totalKills:null,confirmedPersonalKills:3,observedDeaths:3,range:{min:1,max:3},killsPerHour:null,durationMs:3600000,uncertain:true});expect(state.characters.every(row=>row.totals.totalKills===1)).toBe(true);
  });
  it('sums nonoverlapping same-clock replay sessions without inventing cross-client overlap',async()=>{
    const{dir,store}=await profile(),first=replay([...Array.from({length:100},(_,i)=>death(i+1,i+100)),tick(3600000)]);store.killCount.observe(first,meta(dir),owner());const next=replay([...Array.from({length:25},(_,i)=>death(i+1,i+1000,20002)),tick(3600000)]);next.summary.startedAt='2026-11-01T02:00:00Z';store.killCount.observe(next,{...meta(dir,1,'next-session'),recordingId:'next-session'},owner());expect(store.killCount.snapshot().totals).toMatchObject({totalKills:125,confirmedPersonalKills:125,durationMs:7200000,killsPerHour:62.5,uncertain:false});
  });
  it('keeps unknown-clock aggregates uncertain and never inflates time with idle wall-clock ticks',async()=>{
    const{dir,store}=await profile();for(let index=1;index<=2;index++){const record=replay([death(100,50,20001,true,index),tick(3600000)],index);record.summary.startedAt=null;store.killCount.observe(record,meta(dir,index),owner(index));store.killCount.observe(record,{...meta(dir,index,'later-clock'),observedAt:'2026-11-02T20:00:00Z'},owner(index));}expect(store.killCount.snapshot().totals).toMatchObject({totalKills:null,durationMs:3600000,uncertain:true,timeBasis:'observation-anchor'});
  });
  it('registers unlimited dynamic character views and retains ownership when a source gets a manual label',async()=>{
    const{dir,store}=await profile();store.killCount.syncStatuses(Array.from({length:24},(_,index)=>({sourcePath:meta(dir,index).sourcePath,status:'following' as const,character:owner(index)})));expect(store.killCount.snapshot().characters).toHaveLength(24);
    const data=replay([death(100,10),tick(1000)]);store.killCount.observe(data,meta(dir),owner());store.killCount.observe(data,meta(dir),{...owner(),key:'manual:chosen',name:'Türkçe Özel Ad',source:'manual'});expect(store.killCount.snapshot().characters.find(row=>row.characterKey==='manual:chosen')?.totals.totalKills).toBe(1);expect(store.killCount.snapshot().totals.observedDeaths).toBe(1);
  });
  it('keeps a shared replay session tracking when one copy disappears from the stream list',async()=>{
    const{dir,store}=await profile(),data=replay([death(10,1),tick(1000)]),copy=path.join(dir,'copy.rrf');store.killCount.observe(data,meta(dir),owner());store.killCount.observe(data,{...meta(dir),sourcePath:copy,streamId:'copy'},owner());store.killCount.syncStatuses([{sourcePath:copy,status:'following',character:owner()}]);expect(store.killCount.snapshot().characters[0].status).toBe('tracking');
  });
  it('migrates v3 without changing prior finance, EXP or automatic farm values',async()=>{
    const{file,store}=await profile();store.autoFarm.setPrice({itemId:501,unitPrice:500});store.setSetting('existing-preference',{value:'koru'});const previous=store.financeState();store.close();cleanup.pop();const edit=new DatabaseSync(file);try{edit.exec('PRAGMA foreign_keys=OFF;DROP TABLE kill_count_events;DROP TABLE kill_count_totals;DROP TABLE kill_count_intervals;DROP TABLE kill_count_sessions;DROP INDEX catalog_monster_lookup;DROP TABLE IF EXISTS solo_experience_calendar_awards;DROP TABLE IF EXISTS solo_experience_calendar_intervals;DROP TABLE IF EXISTS solo_experience_calendar_sessions;DELETE FROM expansion_migrations WHERE version=12;DELETE FROM expansion_migrations WHERE version>=4;');}finally{edit.close();}
    const opened=new ExpansionStore(file);cleanup.push(()=>opened.close());expect(opened.financeState()).toEqual(previous);expect(opened.autoFarm.snapshot().prices[0]).toMatchObject({itemId:501,unitPrice:500});expect(opened.getSetting('existing-preference')).toEqual({value:'koru'});expect(opened.killCount.snapshot().totals.totalKills).toBeNull();
  });
  it('uses indexed dedup and materialized summaries for ten thousand deaths and inserts only the new one',async()=>{
    const{dir,file,store}=await profile(),events=Array.from({length:10000},(_,index)=>death(index+1,index+100));events.push(tick(3600000));const data=replay(events);store.killCount.observe(data,meta(dir),owner());const first=store.killCount.snapshot();store.killCount.observe(data,meta(dir),owner());expect(store.killCount.snapshot()).toBe(first);
    const inspect=new DatabaseSync(file);try{inspect.exec("CREATE TABLE test_kill_writes(count INTEGER);CREATE TRIGGER test_kill_insert BEFORE INSERT ON kill_count_events BEGIN INSERT INTO test_kill_writes VALUES(1);END;");store.killCount.observe(data,meta(dir,1,'same-events-new-hash'),owner());events.push(death(3600001,50000));store.killCount.observe(replay(events),meta(dir,1,'one-new'),owner());expect(inspect.prepare('SELECT COUNT(*) count FROM test_kill_writes').get()?.count).toBe(1);expect(store.killCount.snapshot().totals.totalKills).toBe(10001);}finally{inspect.close();}
  });
  it('retains cumulative delta time and promotes old evidence without replaying historical deaths',async()=>{
    const{dir,store}=await profile();const value=wireDeath(100,10,1);
    store.killCount.observe(deltaReplay([value],200,1),meta(dir),owner());
    store.killCount.observe(deltaReplay([],500,2),meta(dir),owner());
    expect(store.killCount.snapshot().totals).toMatchObject({observedDeaths:1,durationMs:500,confirmedPersonalKills:0});
    store.killCount.observe(deltaReplay([wireDeath(100,10,1,true)],500,3),meta(dir),owner());
    store.killCount.observe(deltaReplay([wireDeath(100,10,1,true)],100,1),meta(dir,1,'rebuild-prefix'),owner());
    expect(store.killCount.snapshot().totals).toMatchObject({observedDeaths:1,durationMs:500,confirmedPersonalKills:1,unknownDeaths:0});
  });
  it('aliases persisted legacy lifecycles bijectively to wire IDs across upgrade, restart and same-time respawns',async()=>{
    const{dir,file,store}=await profile();const old=death(100,10,20001,false);
    store.killCount.observe(replay([old,tick(200)]),meta(dir),owner());
    store.killCount.observe(deltaReplay([wireDeath(100,10,5)],300,1),meta(dir,1,'upgrade'),owner());
    expect(store.killCount.snapshot().totals.observedDeaths).toBe(1);
    store.killCount.observe(deltaReplay([wireDeath(100,10,6)],400,2),meta(dir,1,'same-time-respawn'),owner());
    expect(store.killCount.snapshot().totals.observedDeaths).toBe(2);
    store.killCount.observe(deltaReplay([wireDeath(100,10,5,true)],500,3),meta(dir,1,'promote'),owner());
    expect(store.killCount.snapshot().totals).toMatchObject({confirmedPersonalKills:1,observedDeaths:2,unknownDeaths:1});
    store.close();cleanup.pop();const opened=new ExpansionStore(file);cleanup.push(()=>opened.close());
    opened.killCount.observe(deltaReplay([wireDeath(100,10,5,true),wireDeath(100,10,6)],500,1),meta(dir,1,'reopen'),owner());
    expect(opened.killCount.snapshot().totals).toMatchObject({confirmedPersonalKills:1,observedDeaths:2,unknownDeaths:1});
    opened.killCount.observe(replay([old,death(100,10,20001,false,1,2),tick(600)]),meta(dir,1,'legacy-fallback'),owner());
    expect(opened.killCount.snapshot().totals.observedDeaths).toBe(2);
  });
});
