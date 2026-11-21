import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,rmSync,statSync} from 'node:fs';
import path from 'node:path';
import {ExpansionStore} from '../electron/expansion-store';
import {summaryDetailTables} from '../electron/summary-migration';
import {emptySummary,type ParsedReplay,type ReplayEvent} from '../src/parser';
import type {CharacterIdentity} from '../src/shared/types';

const clean:(()=>void)[]=[];
afterEach(()=>{for(const action of clean.splice(0).reverse())action();});
const character:CharacterIdentity={key:'recorded:42:Summary',name:'Summary',source:'recorded',playerId:42};
function fixture(){mkdirSync('.qa',{recursive:true});const dir=mkdtempSync(path.resolve('.qa','summary-storage-'));clean.push(()=>rmSync(dir,{recursive:true,force:true}));return{file:path.join(dir,'profile.sqlite'),source:path.join(dir,'replay.rrf')};}
function death(n:number,own=true):ReplayEvent {return{id:`death-${n}`,timestamp:n*1000,eventType:'death',actorId:own?42:99,targetId:1000+n,monsterId:1176,entityKind:'mob',confidence:'estimated',attribution:own?'personal':'unknown',rawData:{attackers:[own?42:99],killProof:{death:'vanish-kind-1',targetActorId:1000+n,lifecycleId:`wire:${n}:1`,scope:'replay-local',ownership:'exclusive-observed-attacker-estimate',lastAttackTimestamp:n*1000}}};}
function loot(n:number):ReplayEvent {const timestamp=n*1000;return{id:`loot-${n}`,timestamp,eventType:'item-obtained',actorId:42,itemId:501,amount:2,confidence:'certain',rawData:{slot:5,inventoryOccurrence:n,inventoryAction:'incoming',inventorySource:'unknown',parserProof:'source-defined-add-delta',quantitySemantics:'added-delta',inventoryBaseline:false,inventoryHistoryReliable:true,inventoryWeightProof:{kind:'own-weight-increase',ownerActorId:42,before:100,after:120,receiptTimestamp:timestamp,weightTimestamp:timestamp+100,confirmedAt:timestamp+500,scope:'receipt-batch'}}};}
function parsed(edge:number,events:ReplayEvent[]):ParsedReplay{return{filename:'replay.rrf',format:'RRF',version:5,status:'partial',profile:'rrf-v5-latam',compatibility:'skadi-unverified',diagnostics:[],unknownPackets:[],packetCount:events.length,events,incremental:{delta:true,sequence:edge+1,recordingStart:edge===0,eventCount:events.length},summary:{...emptySummary(),startedAt:'2026-11-06T23:59:50+03:00',durationMs:edge,playerId:42,characterName:character.name}};}
function feed(store:ExpansionStore,source:string,edge:number,events:ReplayEvent[]=[]){const value=parsed(edge,events),meta={sourcePath:source,streamId:'stream',hash:`hash-${edge}`,recordingId:'recording',includeExperience:false,size:edge+100,initial:edge===0};store.observeReplay(value,meta,character);store.autoFarm.observe(value,{...meta,bootstrap:meta.initial},character);store.killCount.observe(value,meta,character);store.huntAnalytics.observe(value,meta,character);store.targetHunt.observe(value,{...meta,bootstrap:meta.initial},character);store.killExperience.observe(value,meta,character);}
function read<T>(file:string,action:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(file,{readOnly:true});try{return action(db);}finally{db.close();}}

describe('summary-only production storage integration',()=>{
 it('converts legacy details atomically, preserves daily totals/prices, and prevents detailed writers',()=>{
  const f=fixture();let store=new ExpansionStore(f.file,{ownDamageOnly:true,killExperienceSoloOnly:true,lightweightHistory:true});
  try{
   feed(store,f.source,0);store.autoFarm.setPrice({itemId:501,unitPrice:25});store.killExperience.setRate({characterKey:character.key,monsterId:1176,baseExp:100,jobExp:50});store.killExperience.control({characterKey:character.key,streamId:'stream',recordingId:'recording',action:'start'});
   feed(store,f.source,6000,[death(5),loot(5)]);feed(store,f.source,16000,[death(15),loot(15),death(14,false)]);
   const prior={kills:store.killCount.snapshot().totals.observedDeaths,loot:store.autoFarm.snapshot().totals.quantity,prices:store.autoFarm.snapshot().prices,days:['2026-11-06','2026-11-07'].map(date=>({date,kills:store.killDaily.read({date}).totals.observedDeaths,quantity:store.financeDaily.read({date}).totals.quantity,experience:store.soloExperienceDaily.read({date}).totals}))};
   expect(prior.kills).toBe(2);expect(prior.loot).toBe(4);store.close();
   store=new ExpansionStore(f.file,{summaryOnly:true,ownDamageOnly:true,killExperienceSoloOnly:true});
   expect(store.killCount.snapshot().totals.observedDeaths).toBe(prior.kills);expect(store.autoFarm.snapshot().totals.quantity).toBe(prior.loot);expect(store.autoFarm.snapshot().prices).toEqual(prior.prices);
   for(const day of prior.days){expect(store.killDaily.read({date:day.date}).totals.observedDeaths).toBe(day.kills);expect(store.financeDaily.read({date:day.date}).totals.quantity).toBe(day.quantity);expect(store.soloExperienceDaily.read({date:day.date}).totals).toEqual(day.experience);}
   expect(read(f.file,db=>summaryDetailTables(db).map(table=>db.prepare(`SELECT count(*) n FROM "${table}"`).get()!.n).every(n=>n===0))).toBe(true);
   expect(read(f.file,db=>db.prepare('PRAGMA foreign_key_check').all())).toEqual([]);
   feed(store,f.source,16000,[death(5),loot(5),death(15),loot(15)]);
   feed(store,f.source,21000,[death(20),loot(20)]);
   expect(store.killCount.snapshot().totals.observedDeaths).toBe(3);expect(store.autoFarm.snapshot().totals.quantity).toBe(6);
   expect(read(f.file,db=>summaryDetailTables(db).every(table=>db.prepare(`SELECT count(*) n FROM "${table}"`).get()!.n===0))).toBe(true);
   store.close();store=new ExpansionStore(f.file);
   expect(store.summaryOnly).toBe(true);expect(store.killCount.snapshot().totals.observedDeaths).toBe(3);expect(store.autoFarm.snapshot().totals.quantity).toBe(6);
   expect(read(f.file,db=>db.prepare('SELECT MAX(version) version FROM expansion_migrations').get()!.version)).toBe(14);
  }finally{store.close();}
 });
 it('grows by day and type, not by the number of same-day kills and loot events',()=>{
  const f=fixture(),store=new ExpansionStore(f.file,{summaryOnly:true});
  try{
   feed(store,f.source,0);store.killExperience.setRate({characterKey:character.key,monsterId:1176,baseExp:100,jobExp:50});store.killExperience.control({characterKey:character.key,streamId:'stream',recordingId:'recording',action:'start'});
   const batch=(start:number)=>{const events:ReplayEvent[]=[];for(let n=start;n<start+100;n++)events.push(death(n),loot(n));feed(store,f.source,(start+100)*1000,events);};
   batch(100);
   const countRows=()=>read(f.file,db=>db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'compact_%' ORDER BY name").all().map(row=>[row.name,db.prepare(`SELECT count(*) n FROM "${row.name}"`).get()!.n]));
   const rows=countRows();for(let n=200;n<2100;n+=100)batch(n);
   expect(store.killCount.snapshot().totals.observedDeaths).toBe(2000);expect(store.autoFarm.snapshot().totals.quantity).toBe(4000);expect(countRows()).toEqual(rows);
   expect(read(f.file,db=>summaryDetailTables(db).every(table=>db.prepare(`SELECT count(*) n FROM "${table}"`).get()!.n===0))).toBe(true);
   expect(store.killCount.snapshot().monsters.every(m=>m.lastKilledAt===null)).toBe(true);
   expect(statSync(f.file).size).toBeLessThan(4*1024*1024);
  }finally{store.close();}
 });
 it('rolls back the migration if a legacy aggregate cannot be represented safely',()=>{
  const f=fixture(),old=new ExpansionStore(f.file,{ownDamageOnly:true});feed(old,f.source,0);feed(old,f.source,2000,[death(1)]);old.close();
  const db=new DatabaseSync(f.file);db.prepare('INSERT INTO kill_experience_sessions VALUES(?,?,?)').run('bad','bad',JSON.stringify({mode:'single',attributionPolicy:'own-damage-v1',characterName:'Bad',observedDeaths:Number.MAX_SAFE_INTEGER+10,durationMs:0,base:{knownGained:0,missingDeaths:0},job:{knownGained:0,missingDeaths:0}}));db.close();
  expect(()=>new ExpansionStore(f.file,{summaryOnly:true})).toThrow();
  expect(read(f.file,db=>db.prepare('SELECT MAX(version) v FROM expansion_migrations').get()!.v)).toBe(13);
  expect(read(f.file,db=>db.prepare('SELECT count(*) n FROM kill_count_events').get()!.n)).toBe(1);
 });
});
