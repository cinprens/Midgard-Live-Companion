import { afterEach,describe,expect,it } from 'vitest';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ExpansionStore } from '../electron/expansion-store';
import { unionFarmMilliseconds } from '../electron/auto-farm-store';
import { emptySummary,type ParsedReplay,type ReplayEvent } from '../src/parser';
const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
async function profile(){await mkdir('.qa',{recursive:true});const dir=await mkdtemp(path.resolve('.qa/auto-farm-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'midgard-live.sqlite'),store=new ExpansionStore(file);cleanup.push(()=>store.close());return{dir,file,store};}
function identity(index=1){return{key:`recorded:${index}:Karakter`,name:`Karakter ${index}`,source:'recorded' as const,playerId:index};}
function replay(events:ReplayEvent[],index=1):ParsedReplay{return{filename:`${index}.rrf`,format:'RRF',version:5,status:'partial',profile:'rrf-v5-latam',compatibility:'skadi-unverified',diagnostics:[],unknownPackets:[],packetCount:events.length,events,summary:{...emptySummary(),characterName:`Karakter ${index}`,playerId:index,startedAt:'2026-11-01T00:00:00Z'}};}
const tick=(timestamp:number):ReplayEvent=>({id:`tick-${timestamp}`,eventType:'status',timestamp,statusKey:'hp',amount:100,confidence:'certain'});
function incoming(timestamp:number,itemId=501,amount=1,source='unknown',history=false,playerId=1):ReplayEvent{return{id:`incoming-${timestamp}-${itemId}`,eventType:'item-obtained',timestamp,itemId,amount,confidence:'certain',actorId:playerId,rawData:{inventoryWeightProof:{kind:'own-weight-increase',ownerActorId:playerId,before:100,after:120,receiptTimestamp:timestamp,weightTimestamp:timestamp,confirmedAt:timestamp+500,scope:'receipt-batch'},inventoryAction:'incoming',inventorySource:source,parserProof:'source-defined-add-delta',quantitySemantics:'added-delta',inventoryBaseline:false,skadiVerified:false,replayContextVerified:true,inventoryHistoryReliable:history,slot:1}};}
function deltaReplay(events:ReplayEvent[],durationMs:number,sequence:number):ParsedReplay{return{...replay(events),incremental:{delta:true,sequence,recordingStart:sequence===1,eventCount:events.length},summary:{...replay(events).summary,durationMs}};}
function deltaIncoming(timestamp:number,occurrence=1,source='unknown',history=false):ReplayEvent{const event=incoming(timestamp,501,2,source,history);return{...event,id:`packet-${timestamp}-${occurrence}`,rawData:{...event.rawData,inventoryOccurrence:occurrence}};}
const meta=(dir:string,index=1,hash='first')=>({sourcePath:path.join(dir,`${index}.rrf`),streamId:`stream-${index}`,hash,recordingId:`recording-${index}`,observedAt:'2026-11-01T01:00:00Z'});
describe('automatic inventory farm economy',()=>{
  it('counts only parser-proof new incoming deltas, not existing bag, ground, trade or removal observations',async()=>{
    const{dir,store}=await profile(),events=[tick(1000),incoming(500,501,90)];store.autoFarm.observe(replay(events),meta(dir),identity());expect(store.autoFarm.snapshot().totals.quantity).toBe(0);
    events.push(incoming(2000,501,125),{id:'ground',eventType:'item-ground',timestamp:2000,itemId:501,amount:999,confidence:'certain'},incoming(2000,502,20,'trade'),incoming(2000,503,20,'storage'),{...incoming(2000,504,20),rawData:{inventoryAction:'incoming',inventoryBaseline:true}});
    store.autoFarm.observe(replay(events),meta(dir,1,'next'),identity());const state=store.autoFarm.snapshot();expect(state.totals.quantity).toBe(125);expect(state.items.map(row=>row.itemId)).toEqual([501]);expect(state.items[0].sourceLabel).toBe('Çantaya gelen eşya');expect(state.totals.estimatedValue).toBeNull();expect(state.totals.unpricedQuantity).toBe(125);expect(store.financeState().events).toHaveLength(0);
    store.autoFarm.setPrice({itemId:501,unitPrice:500});expect(store.autoFarm.snapshot().items[0].value).toBe(62500);expect(store.autoFarm.snapshot().totals.estimatedValue).toBe(62500);
  });
  it('ingests first-snapshot historical deltas only with verified replay inventory context',async()=>{
    const{dir,store}=await profile();store.autoFarm.observe(replay([incoming(1000,501,3,'unknown',true),incoming(2000,502,99),tick(3600000)]),{...meta(dir),includeReplayHistory:true},identity());const state=store.autoFarm.snapshot();expect(state.totals.quantity).toBe(3);expect(state.items[0].itemId).toBe(501);expect(state.totals.durationMs).toBe(3600000);expect(state.totals.hourlyValue).toBeNull();
    store.autoFarm.setPrice({itemId:501,unitPrice:100});expect(store.autoFarm.snapshot().totals.hourlyValue).toBe(300);
  });
  it('shares prices and unions three simultaneous replay hours instead of adding three wall-clock hours',async()=>{
    const{dir,store}=await profile();for(let index=1;index<=3;index++){store.autoFarm.observe(replay([tick(0)],index),meta(dir,index),identity(index));store.autoFarm.observe(replay([tick(0),incoming(1800000,501,10,'unknown',false,index),tick(3600000)],index),meta(dir,index,'next'),identity(index));}
    store.autoFarm.setPrice({itemId:501,unitPrice:100});let state=store.autoFarm.snapshot();expect(state.totals.durationMs).toBe(3600000);expect(state.totals.quantity).toBe(30);expect(state.totals.hourlyValue).toBe(3000);expect(state.characters.map(row=>row.totals.hourlyValue)).toEqual([1000,1000,1000]);
    store.autoFarm.setPrice({itemId:501,unitPrice:500});state=store.autoFarm.snapshot();expect(state.totals.estimatedValue).toBe(15000);expect(state.characters.every(row=>row.items[0].unitPrice===500)).toBe(true);store.autoFarm.setPrice({itemId:501,unitPrice:null});expect(store.autoFarm.snapshot().totals.estimatedValue).toBeNull();
  });
  it('deduplicates repeated snapshots, copied replay sources and same-time events across partial tails',async()=>{
    const{dir,store}=await profile(),first=meta(dir),copy={...meta(dir),sourcePath:path.join(dir,'copy.rrf'),streamId:'copy'};store.autoFarm.observe(replay([tick(0)]),first,identity());store.autoFarm.observe(replay([tick(0)]),copy,identity());
    const events=[tick(0),incoming(1000,501,2)];store.autoFarm.observe(replay(events),{...first,hash:'new'},identity());store.autoFarm.observe(replay(events),{...copy,hash:'new-copy'},identity());store.autoFarm.observe(replay([tick(0)]),{...first,hash:'partial'},identity());store.autoFarm.observe(replay(events),{...first,hash:'restored'},identity());expect(store.autoFarm.snapshot().totals.quantity).toBe(2);
    events.push(incoming(1000,501,2));store.autoFarm.observe(replay(events),{...first,hash:'same-time-extra'},identity());store.autoFarm.observe(replay(events),{...copy,hash:'copy-extra'},identity());expect(store.autoFarm.snapshot().totals.quantity).toBe(4);
  });
  it('does not grow duration with the wall clock and excludes paused gaps and resumed file history',async()=>{
    const{dir,store}=await profile();store.autoFarm.observe(replay([tick(0)]),meta(dir),identity());store.autoFarm.observe(replay([incoming(1000,501,2),tick(3600000)]),meta(dir,1,'one-hour'),identity());store.autoFarm.suspend(meta(dir).sourcePath,'paused');expect(store.autoFarm.snapshot().totals.durationMs).toBe(3600000);
    const duringPause=[incoming(1000,501,2),incoming(7200000,501,99),tick(7200000)];store.autoFarm.observe(replay(duringPause),{...meta(dir,1,'resume'),observedAt:'2026-11-01T12:00:00Z'},identity());expect(store.autoFarm.snapshot().totals.quantity).toBe(2);expect(store.autoFarm.snapshot().totals.durationMs).toBe(3600000);
    store.autoFarm.observe(replay([...duringPause,incoming(7201000,501,1),tick(10800000)]),meta(dir,1,'another-hour'),identity());expect(store.autoFarm.snapshot().totals.durationMs).toBe(7200000);expect(store.autoFarm.snapshot().totals.quantity).toBe(3);
  });
  it('preserves confirmed quantities/prices across reopen and deduplicates real post-baseline replay gains',async()=>{
    const{dir,file,store}=await profile();store.autoFarm.observe(replay([tick(0)]),meta(dir),identity());store.autoFarm.observe(replay([incoming(1000,501,7),tick(2000)]),meta(dir,1,'old'),identity());store.autoFarm.setPrice({itemId:501,unitPrice:1.25});store.close();cleanup.pop();
    const opened=new ExpansionStore(file);cleanup.push(()=>opened.close());opened.autoFarm.observe(replay([incoming(1000,501,7),incoming(5000,501,50),tick(5000)]),meta(dir,1,'offline-history'),identity());expect(opened.autoFarm.snapshot().totals.quantity).toBe(57);expect(opened.autoFarm.snapshot().items[0].unitPrice).toBe(1.25);
    opened.autoFarm.observe(replay([incoming(1000,501,7),incoming(5000,501,50),incoming(6000,501,2),tick(6000)]),meta(dir,1,'new'),identity());expect(opened.autoFarm.snapshot().totals.quantity).toBe(59);
  });
  it('keeps missing prices unknown, zero prices real and zero-duration hourly rates unavailable',async()=>{
    const{dir,store}=await profile();store.autoFarm.observe(replay([tick(1000)]),meta(dir),identity());store.autoFarm.observe(replay([tick(1000),incoming(1000,999999,2)]),meta(dir,1,'same-time'),identity());expect(store.autoFarm.snapshot().totals.hourlyValue).toBeNull();expect(store.autoFarm.snapshot().items[0].itemName).toBe('Eşya #999999');store.autoFarm.setLocalItemNames(new Map([[999999,'Yerel Türkçe eşya']]));expect(store.autoFarm.snapshot().items[0].itemName).toBe('Yerel Türkçe eşya');store.autoFarm.setPrice({itemId:999999,unitPrice:0});expect(store.autoFarm.snapshot().totals.estimatedValue).toBe(0);expect(store.autoFarm.snapshot().totals.partial).toBe(false);expect(store.autoFarm.snapshot().totals.hourlyValue).toBeNull();
  });
  it('migrates v1 shared prices while preserving the old ledger without converting its quantities',async()=>{
    const{file,store}=await profile();store.financeCommand({type:'price.set',price:{itemId:501,itemName:'Eski ad',characterKey:null,npcPrice:null,marketPrice:500,buyCost:null,method:'market'}});store.financeCommand({type:'session.start',characterKey:'old-character',characterName:'Eski karakter'});store.financeCommand({type:'receipt.add',sessionId:store.financeState().sessions[0].id,itemId:501,itemName:'Eski ad',quantity:999});store.close();cleanup.pop();
    const edit=new DatabaseSync(file);try{edit.exec(`PRAGMA foreign_keys=OFF;DROP TABLE kill_count_events;DROP TABLE kill_count_totals;DROP TABLE kill_count_intervals;DROP TABLE kill_count_sessions;DROP INDEX catalog_monster_lookup;DROP TABLE autofarm_correction_candidates;DROP TABLE autofarm_receipts;DROP TABLE autofarm_item_totals;DROP TABLE autofarm_cursors;DROP TABLE autofarm_intervals;DROP TABLE autofarm_sessions;DROP TABLE autofarm_prices;DROP INDEX catalog_item_lookup;DROP TABLE IF EXISTS solo_experience_calendar_awards;DROP TABLE IF EXISTS solo_experience_calendar_intervals;DROP TABLE IF EXISTS solo_experience_calendar_sessions;DELETE FROM expansion_migrations WHERE version=12;DELETE FROM expansion_migrations WHERE version>=2;`);}finally{edit.close();}
    const opened=new ExpansionStore(file);cleanup.push(()=>opened.close());expect(opened.autoFarm.snapshot().totals.quantity).toBe(0);expect(opened.autoFarm.snapshot().prices[0]).toMatchObject({itemId:501,unitPrice:500});expect(opened.financeState().events).toHaveLength(1);
  });
  it('uses observation anchors when replay header clocks have no timezone',async()=>{
    const{dir,store}=await profile(),source=replay([tick(1000)]);source.summary.startedAt='2026-11-01T00:00:00';store.autoFarm.observe(source,meta(dir),identity());source.events.push(incoming(2000,501,1));store.autoFarm.observe(source,meta(dir,1,'later'),identity());expect(store.autoFarm.snapshot().totals.timeBasis).toBe('observation-anchor');expect(store.autoFarm.snapshot().totals.durationMs).toBe(1000);expect(unionFarmMilliseconds([[0,10],[5,15],[20,30]])).toBe(25);
  });
  it('accepts a deferred ACK when its older timestamp is promoted after the replay edge advanced, including restart',async()=>{
    const{dir,file,store}=await profile();store.autoFarm.observe(replay([tick(0)]),meta(dir),identity());const pending={...incoming(100,501,2),rawData:{inventoryAction:'pending',pendingInventory:true,inventorySource:'unknown',slot:1}};store.autoFarm.observe(replay([pending,tick(200)]),meta(dir,1,'pending'),identity());expect(store.autoFarm.snapshot().totals.quantity).toBe(0);store.close();cleanup.pop();
    const opened=new ExpansionStore(file);cleanup.push(()=>opened.close());const mature=[incoming(100,501,2),tick(700)];opened.autoFarm.observe(replay(mature),meta(dir,1,'mature'),identity());opened.autoFarm.observe(replay(mature),meta(dir,1,'same-mature'),identity());expect(opened.autoFarm.snapshot().totals.quantity).toBe(2);
  });
  it('promotes a contextual pending first-snapshot delta and reconstructs only the proven replay interval',async()=>{
    const{dir,store}=await profile(),pending={...incoming(100,501,2),rawData:{inventoryAction:'pending',pendingInventory:true,inventorySource:'unknown',slot:1}};store.autoFarm.observe(replay([pending,tick(200)]),meta(dir),identity());store.autoFarm.observe(replay([incoming(100,501,2,'unknown',true),tick(700)]),{...meta(dir,1,'mature'),includeReplayHistory:true},identity());expect(store.autoFarm.snapshot().totals.quantity).toBe(2);expect(store.autoFarm.snapshot().totals.durationMs).toBe(700);
  });
  it('retracts an earlier receipt only when later parser evidence proves a transfer or refresh, preserving the audit row',async()=>{
    const{dir,file,store}=await profile();store.autoFarm.observe(replay([tick(0)]),meta(dir),identity());store.autoFarm.observe(replay([incoming(1000,501,2),tick(2000)]),meta(dir,1,'unknown-source'),identity());expect(store.autoFarm.snapshot().totals.quantity).toBe(2);
    store.autoFarm.observe(replay([incoming(1000,501,2,'storage'),tick(3000)]),meta(dir,1,'proven-transfer'),identity());expect(store.autoFarm.snapshot().totals.quantity).toBe(0);const inspect=new DatabaseSync(file,{readOnly:true});try{expect(inspect.prepare('SELECT quantity,excluded_reason FROM autofarm_receipts').get()).toEqual({quantity:2,excluded_reason:'storage'});}finally{inspect.close();}
    store.autoFarm.observe(replay([incoming(1000,501,2),tick(4000)]),meta(dir,1,'temporary-missing-classification'),identity());expect(store.autoFarm.snapshot().totals.quantity).toBe(0);
  });
  it('deduplicates stable same-time delta occurrences across batches, legacy rereads and proof corrections',async()=>{
    const{dir,store}=await profile();store.autoFarm.observe(deltaReplay([tick(0)],0,1),{...meta(dir),bootstrap:true},identity());
    const first=deltaIncoming(100,1),second=deltaIncoming(100,2);
    store.autoFarm.observe(deltaReplay([first],200,2),meta(dir,1,'a'),identity());
    store.autoFarm.observe(deltaReplay([second],300,3),meta(dir,1,'b'),identity());
    store.autoFarm.observe(deltaReplay([first,second],300,4),meta(dir,1,'repeat'),identity());
    expect(store.autoFarm.snapshot().totals).toMatchObject({quantity:4,durationMs:300});
    store.autoFarm.observe(replay([first,second,tick(400)]),meta(dir,1,'legacy-rebuild'),identity());
    expect(store.autoFarm.snapshot().totals.quantity).toBe(4);
    store.autoFarm.observe(deltaReplay([deltaIncoming(100,1,'storage')],500,5),meta(dir,1,'reclassify'),identity());
    expect(store.autoFarm.snapshot().totals.quantity).toBe(2);
    store.autoFarm.observe(deltaReplay([],900,6),meta(dir,1,'unknown-only-progress'),identity());
    expect(store.autoFarm.snapshot().totals.durationMs).toBe(900);
  });
  it('silently baselines every initial delta batch while accepting parser-proven historical inventory',async()=>{
    const{dir,store}=await profile();
    store.autoFarm.observe(deltaReplay([deltaIncoming(100)],200,1),{...meta(dir),bootstrap:true},identity());
    store.autoFarm.observe(deltaReplay([deltaIncoming(300)],400,2),{...meta(dir,1,'second'),bootstrap:true},identity());
    expect(store.autoFarm.snapshot().totals.quantity).toBe(0);
    store.autoFarm.observe(deltaReplay([deltaIncoming(50,1,'unknown',true)],500,3),{...meta(dir,1,'proven'),bootstrap:true},identity());
    expect(store.autoFarm.snapshot().totals).toMatchObject({quantity:2,durationMs:500});
    store.autoFarm.observe(deltaReplay([deltaIncoming(300)],600,4),meta(dir,1,'old-bootstrap-correction'),identity());
    expect(store.autoFarm.snapshot().totals.quantity).toBe(2);
    store.autoFarm.observe(deltaReplay([deltaIncoming(700)],800,5),meta(dir,1,'live'),identity());
    expect(store.autoFarm.snapshot().totals.quantity).toBe(4);
  });
  it('keeps previously monitored pending deltas eligible through restart without counting unread bootstrap history',async()=>{
    const{dir,file,store}=await profile();store.autoFarm.observe(deltaReplay([tick(0)],0,1),{...meta(dir),bootstrap:true},identity());
    const pending=deltaIncoming(100);pending.rawData={...pending.rawData,inventoryAction:'pending',pendingInventory:true,parserProof:undefined};
    store.autoFarm.observe(deltaReplay([pending],200,2),meta(dir,1,'pending'),identity());store.close();cleanup.pop();
    const opened=new ExpansionStore(file);cleanup.push(()=>opened.close());
    opened.autoFarm.observe(deltaReplay([pending],200,1),{...meta(dir,1,'reopen-start'),bootstrap:true},identity());
    opened.autoFarm.observe(deltaReplay([deltaIncoming(100),deltaIncoming(300)],400,2),{...meta(dir,1,'reopen-end'),bootstrap:true},identity());
    expect(opened.autoFarm.snapshot().totals.quantity).toBe(2);
    opened.autoFarm.observe(deltaReplay([deltaIncoming(300),deltaIncoming(450)],500,3),meta(dir,1,'live'),identity());
    expect(opened.autoFarm.snapshot().totals.quantity).toBe(4);
  });
  it('requires a valid weight increase belonging to the recorded player and excludes unknown source labels from both income and alerts',async()=>{
    const{dir,store}=await profile();store.autoFarm.observe(replay([tick(0)]),meta(dir),identity());
    const noProof=incoming(100,501,10);delete noProof.rawData!.inventoryWeightProof;
    const flat=incoming(200,502,10);(flat.rawData!.inventoryWeightProof as Record<string,unknown>).after=100;
    const falling=incoming(300,503,10);(falling.rawData!.inventoryWeightProof as Record<string,unknown>).after=99;
    const foreign=incoming(400,504,10,'unknown',false,9);
    const mismatched=incoming(500,505,10);(mismatched.rawData!.inventoryWeightProof as Record<string,unknown>).ownerActorId=9;
    const late=incoming(600,506,10);(late.rawData!.inventoryWeightProof as Record<string,unknown>).weightTimestamp=2601;
    const namedSource=incoming(700,507,10,'unrecognized-source');
    const valid=incoming(800,508,2);
    store.autoFarm.observe(replay([noProof,flat,falling,foreign,mismatched,late,namedSource,valid,tick(3000)]),meta(dir,1,'proofs'),identity());
    expect(store.autoFarm.snapshot().totals.quantity).toBe(2);
    expect(store.autoFarm.snapshot().items.map(row=>row.itemId)).toEqual([508]);
    expect(store.autoFarm.alertReceipts(identity().key).map(row=>[row.itemId,row.quantity])).toEqual([[508,2]]);
    expect(store.autoFarm.correctionPreview().candidates).toEqual([]);
  });
});
