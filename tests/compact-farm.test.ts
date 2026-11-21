import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {COMPACT_FARM_SCHEMA,CompactAutoFarmStore,CompactFinanceDailyStore,migrateCompactFarm} from '../electron/compact-farm-store';
import {emptySummary,type ParsedReplay,type ReplayEvent} from '../src/parser';
import type {LiveStreamState} from '../src/shared/types';

const cleanup:(()=>void)[]=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
const who={key:'recorded:42',name:'Alpha',source:'recorded' as const,playerId:42};
const start='2026-11-04T23:59:00';
const metadata={sourcePath:'C:/synthetic/source.rrf',streamId:'source',hash:'ignored',recordingId:'recording',observedAt:'2026-11-05T10:00:00Z'};
function replay(events:ReplayEvent[],edge=events.reduce((n,event)=>Math.max(n,event.timestamp),0),startedAt:string|null=start):ParsedReplay{return{filename:'SYNTHETIC.rrf',format:'RRF',version:5,status:'partial',profile:'rrf-v5-latam',compatibility:'skadi-unverified',diagnostics:[],unknownPackets:[],events,packetCount:Math.ceil(edge/10),summary:{...emptySummary(),startedAt,playerId:42,characterName:'Alpha',durationMs:edge},incremental:{delta:true,sequence:1,recordingStart:false,eventCount:events.length}};}
function incoming(timestamp:number,amount=2,itemId=501,weightTimestamp=timestamp+100):ReplayEvent{return{id:`SECRET_RECEIPT_ID_${timestamp}`,timestamp,eventType:'item-obtained',actorId:42,itemId,amount,confidence:'certain',rawData:{inventoryAction:'incoming',parserProof:'source-defined-add-delta',quantitySemantics:'added-delta',inventoryBaseline:false,inventorySource:'unknown',inventoryHistoryReliable:true,slot:5,inventoryOccurrence:1,inventoryWeightProof:{kind:'own-weight-increase',ownerActorId:42,before:100,after:120,receiptTimestamp:timestamp,weightTimestamp,confirmedAt:Math.max(timestamp+500,weightTimestamp),scope:'receipt-batch'}}};}
const pending=(timestamp:number):ReplayEvent=>({...incoming(timestamp),eventType:'inventory-ack',rawData:{pendingInventory:true,slot:5,inventoryOccurrence:1}});
function fixture(){const db=new DatabaseSync(':memory:');db.exec(COMPACT_FARM_SCHEMA);cleanup.push(()=>db.close());const farm=new CompactAutoFarmStore(db),daily=new CompactFinanceDailyStore(db);return{db,farm,daily};}
function baseline(farm:CompactAutoFarmStore,startedAt:string|null=start){farm.observe(replay([],0,startedAt),{...metadata,bootstrap:true},who);}

describe('compact live farm totals without event storage',()=>{
  it('uses a reference label without turning a receipt into a rare drop',()=>{
    const {farm,db}=fixture();baseline(farm);
    expect(farm.observe(replay([incoming(100,1,4001)],800),metadata,who)).toEqual([]);
    const row=farm.snapshot().items.find(item=>item.itemId===4001);
    expect(row?.itemName).toBe('Poring Card');
    expect(row?.rareCategory).toBeUndefined();
    expect(db.prepare('SELECT item_name FROM compact_farm_totals WHERE item_id=4001').get()?.item_name).toBeNull();
    const confirmed=incoming(1200,1,4001);Object.assign(confirmed.rawData!,{itemType:6});
    expect(farm.observe(replay([confirmed],1900),metadata,who)).toMatchObject([{itemName:'Poring Card',category:'card'}]);
  });
  it('emits one rare pickup per new personal receipt across overlapping streams',()=>{
    const{farm}=fixture();
    const card=incoming(1100,2,61234),costume=incoming(1120,1,56),regular=incoming(1130,1,4001);
    Object.assign(card.rawData!,{itemType:6});Object.assign(costume.rawData!,{itemType:4,equipLocation:0x2000});
    Object.assign(regular.rawData!,{itemType:4,equipLocation:0x100});
    const oldCard=incoming(100,1,61234);Object.assign(oldCard.rawData!,{itemType:6});
    expect(farm.observe(replay([oldCard],650),metadata,who)).toEqual([]);
    const added=farm.observe(replay([card,costume,regular],1700),metadata,who);
    expect(added).toMatchObject([{category:'card',itemId:61234,quantity:2},{category:'costume',itemId:56,quantity:1}]);
    expect(added[0].id).not.toEqual(added[1].id);
    expect(farm.observe(replay([card,costume],1800),{...metadata,sourcePath:'C:/synthetic/copy.rrf'},who)).toEqual([]);
    const other={...incoming(1900,1,777),actorId:99},storage=incoming(1900,1,888),custom=incoming(1901,1,999);
    Object.assign(storage.rawData!,{itemType:6,inventorySource:'storage'});
    expect(farm.observe(replay([other,storage,custom],2500),metadata,who,id=>id===999?'costume':undefined)).toMatchObject([{itemId:999,category:'costume'}]);
    expect(farm.alertReceipts(who.key).find(r=>r.itemId===61234)).toMatchObject({rareCategory:'card'});
  });
  it('uses imported names and exact imported item categories for live scenes',()=>{
    const {db,farm}=fixture();baseline(farm);
    db.exec("CREATE TABLE item_database(item_id INTEGER,name TEXT,category TEXT);INSERT INTO item_database VALUES(4255,'Orc Lady Card','Card'),(7711,'Costume Voucher','Etc'),(8159,'Ribbon','Costume')");
    const output=farm.observe(replay([incoming(100,1,4255),incoming(200,1,7711),incoming(300,1,8159)],1000),metadata,who);
    expect(output.map(({itemName,category})=>({itemName,category}))).toEqual([
      {itemName:'Orc Lady Card',category:'card'},{itemName:'Ribbon',category:'costume'},
    ]);
  });
  it('keeps only the newest accepted bag delta per live source, independent of totals and alerts',()=>{
    const {db,farm}=fixture();baseline(farm);
    expect(farm.lastLootFor(metadata.streamId,who.key)).toBeUndefined();
    const early=incoming(100,5),late={...incoming(250,1),id:'packet-12'},tied={...incoming(250,3,502),id:'packet-15'};
    farm.observe(replay([tied,late,early],1000),metadata,who);
    expect(farm.snapshot().totals.quantity).toBe(9);
    expect(farm.lastLootFor(metadata.streamId,who.key)).toEqual({itemId:502,quantity:3});
    expect(farm.lastLootFor(metadata.streamId,'another-character')).toBeUndefined();
    const copy={...metadata,sourcePath:'C:/synthetic/copy.rrf',streamId:'copy'};
    farm.observe(replay([early,late,tied],1100),copy,who);
    expect(farm.lastLootFor('copy',who.key)).toBeUndefined();
    const correction={...tied,eventType:'inventory-ack' as const,rawData:{...tied.rawData,inventorySource:'storage'}};
    farm.observe(replay([correction],1200),copy,who);
    expect(farm.lastLootFor(metadata.streamId,who.key)).toEqual({itemId:501,quantity:1});
    farm.suspend(metadata.sourcePath);
    expect(farm.lastLootFor(metadata.streamId,who.key)).toEqual({itemId:501,quantity:1});
    farm.observe(replay([early,late],1300),{...metadata,recordingReset:true},who);
    expect(farm.lastLootFor(metadata.streamId,who.key)).toBeUndefined();
    farm.close();
    expect(new CompactAutoFarmStore(db).lastLootFor(metadata.streamId,who.key)).toBeUndefined();
  });
  it('counts only own weighted loot and deduplicates delayed revisions and copied replay sources',()=>{
    const{db,farm}=fixture();baseline(farm);farm.observe(replay([pending(100)],400),metadata,who);expect(farm.snapshot().totals.quantity).toBe(0);
    const event=incoming(100);farm.observe(replay([event],601),metadata,who);farm.observe(replay([event],700),metadata,who);farm.observe(replay([event],700),{...metadata,sourcePath:'C:/synthetic/copy.rrf'},who);
    expect(farm.snapshot().totals.quantity).toBe(2);expect(farm.alertReceipts(who.key)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) n FROM compact_farm_cursors').get()?.n).toBe(1);expect(JSON.stringify(db.prepare('SELECT * FROM compact_farm_cursors').all())).not.toContain('SECRET_RECEIPT_ID');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name)).not.toContain('autofarm_receipts');
  });
  it('groups only the last three pickups, ordering same-tick events by their packet position',()=>{
    const {farm}=fixture();baseline(farm);
    const early=incoming(100,15,501);
    const middle={...incoming(220,2,502),id:'packet-22'};
    const late={...incoming(220,1,503),id:'packet-24'};
    const latest=incoming(300,3,502);
    farm.observe(replay([latest,late,early,middle],1000),metadata,who);
    const summary={pickupCount:3,totalQuantity:6,items:[{itemId:502,quantity:5},{itemId:503,quantity:1}]};
    expect(farm.recentLootFor(metadata.streamId,who.key)).toEqual(summary);
    expect(farm.lastLootFor(metadata.streamId,who.key)).toEqual({itemId:502,quantity:3});
    farm.observe(replay([middle,latest,early,late],1100),metadata,who);
    expect(farm.recentLootFor(metadata.streamId,who.key)).toEqual(summary);
    expect(farm.recentLootFor(metadata.streamId,'unrelated')).toBeUndefined();
    const other={...metadata,streamId:'b',sourcePath:'C:/synthetic/b.rrf'};
    const character={...who,key:'recorded:99:Beta',name:'Beta',playerId:99};
    const betaReplay=(events:ReplayEvent[],edge:number)=>{
      const parsed=replay(events,edge);
      parsed.summary.playerId=character.playerId;parsed.summary.characterName=character.name;
      return parsed;
    };
    const betaItem=incoming(600,7,900);
    betaItem.actorId=99;(betaItem.rawData!.inventoryWeightProof as {ownerActorId:number}).ownerActorId=99;
    farm.observe(betaReplay([],0),{...other,bootstrap:true},character);
    farm.observe(betaReplay([betaItem],1300),other,character);
    expect(farm.recentLootFor('b',character.key)).toEqual({pickupCount:1,totalQuantity:7,items:[{itemId:900,quantity:7}]});
    expect(farm.recentLootFor(metadata.streamId,who.key)).toEqual(summary);
    farm.observe(replay([],1400),{...metadata,recordingReset:true},who);
    expect(farm.recentLootFor(metadata.streamId,who.key)).toBeUndefined();
  });
  it('restores settled pickups after several later receipts are reclassified through a copied recording',()=>{
    const {db,farm}=fixture();baseline(farm);
    const first=[incoming(50,3,501),incoming(120,1,502),incoming(150,2,501)];
    farm.observe(replay(first,1000),metadata,who);
    // These leave the store's ten-second correction window, then all three become hidden.
    farm.observe(replay([],12000),metadata,who);
    const newer=[incoming(12100,7,503),incoming(12200,1,504),incoming(12300,4,505),incoming(12400,2,506)];
    farm.observe(replay(newer,14000),metadata,who);
    expect(farm.recentLootFor(metadata.streamId,who.key)?.totalQuantity).toBe(7);
    const corrected=newer.map(event=>({...event,eventType:'inventory-ack' as const,rawData:{...event.rawData,inventorySource:'storage'}}));
    const copy={...metadata,sourcePath:'C:/synthetic/copy.rrf',streamId:'copy'};
    db.exec("CREATE TRIGGER reject_corrections BEFORE UPDATE ON compact_farm_cursors BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;");
    expect(()=>farm.observe(replay(corrected,14200),copy,who)).toThrow();
    expect(farm.recentLootFor(metadata.streamId,who.key)?.totalQuantity).toBe(7);
    db.exec('DROP TRIGGER reject_corrections');
    farm.observe(replay(corrected,14200),copy,who);
    expect(farm.recentLootFor('copy',who.key)).toBeUndefined();
    expect(farm.recentLootFor(metadata.streamId,who.key)).toEqual({pickupCount:3,totalQuantity:6,items:[{itemId:501,quantity:5},{itemId:502,quantity:1}]});
    farm.close();
    expect(new CompactAutoFarmStore(db).recentLootFor(metadata.streamId,who.key)).toBeUndefined();
  });
  it('retains the three visible pickups when monitoring the same recording resumes',()=>{
    const {farm}=fixture();baseline(farm);
    const list=[incoming(100,1,501),incoming(110,2,502),incoming(120,3,503)];
    farm.observe(replay(list,700),metadata,who);
    const visible=farm.recentLootFor(metadata.streamId,who.key);
    farm.suspend(metadata.sourcePath);
    farm.observe(replay([],710),{...metadata,bootstrap:true},who);
    const next=incoming(1500,1,504);
    farm.observe(replay([next],2100),metadata,who);
    expect(farm.recentLootFor(metadata.streamId,who.key)?.items.map(item=>item.itemId)).toEqual([504,503,502]);
    farm.observe(replay([{...next,rawData:{...next.rawData,inventorySource:'cart'}}],2200),metadata,who);
    expect(farm.recentLootFor(metadata.streamId,who.key)).toEqual(visible);
  });
  it('shows the character’s complete daily quantity and daily counts for only the newest items, including corrections',()=>{
    const {farm}=fixture();
    baseline(farm);
    const early=incoming(100,9,501);
    const pickups=[incoming(50,12,999),early,incoming(200,2,502),incoming(300,4,503),incoming(400,1,501)];
    farm.observe(replay(pickups,1200),metadata,who);
    type LootRow = Pick<LiveStreamState,'character'|'recentLoot'|'dailyLoot'>;
    const row:LootRow={character:who,recentLoot:farm.recentLootFor(metadata.streamId,who.key)};
    const namesake:LootRow={character:{...who,key:'manual:other',source:'manual'}};
    const date='2026-11-04';
    farm.attachTaskbarDailyLoot([row,namesake],date);
    expect(row.recentLoot?.items.map(item=>item.itemId)).toEqual([501,503,502]);
    expect(row.dailyLoot).toEqual({date,totalQuantity:28,itemQuantities:{501:10,502:2,503:4}});
    expect(namesake.dailyLoot).toEqual({date,totalQuantity:0,itemQuantities:{}});
    const correction={...early,rawData:{...early.rawData,inventorySource:'storage'}};
    farm.observe(replay([correction],1500),metadata,who);
    farm.attachTaskbarDailyLoot([row],date);
    expect(row.dailyLoot).toEqual({date,totalQuantity:19,itemQuantities:{501:1,502:2,503:4}});
    row.character={...who,source:'unassigned'};
    farm.attachTaskbarDailyLoot([row],date);
    expect(row.dailyLoot).toBeUndefined();
  });
  it('sums separate recordings across restart and switches daily counters at Istanbul midnight',()=>{
    const {db,farm}=fixture();
    baseline(farm);
    farm.observe(replay([incoming(59000,2),incoming(60000,3)],61000),metadata,who);
    const nextStart='2026-11-05T00:10:00';
    const other={...metadata,sourcePath:'C:/synthetic/next.rrf',streamId:'next',recordingId:'next'};
    farm.observe(replay([],0,nextStart),{...other,bootstrap:true},who);
    farm.observe(replay([incoming(100,5)],800,nextStart),other,who);
    farm.close();
    const reopened=new CompactAutoFarmStore(db);
    const row:Pick<LiveStreamState,'character'|'lastLoot'|'dailyLoot'>={character:who};
    reopened.attachTaskbarDailyLoot([row],'2026-11-05');
    expect(row.dailyLoot).toEqual({date:'2026-11-05',totalQuantity:8,itemQuantities:{}});
    row.lastLoot={itemId:501,quantity:5};
    reopened.attachTaskbarDailyLoot([row],'2026-11-04');
    expect(row.dailyLoot).toEqual({date:'2026-11-04',totalQuantity:2,itemQuantities:{501:2}});
    reopened.attachTaskbarDailyLoot([row],'2026-11-06');
    expect(row.dailyLoot).toEqual({date:'2026-11-06',totalQuantity:0,itemQuantities:{501:0}});
  });
  it('rejects missing proof, foreign owners, transfers, failed baseline and first-import historical receipts',()=>{
    const{farm}=fixture();farm.observe(replay([incoming(100)],1000),{...metadata,includeReplayHistory:true},who);expect(farm.snapshot().totals.quantity).toBe(0);
    const noProof=incoming(1100);delete noProof.rawData!.inventoryWeightProof;
    const foreign={...incoming(1200),actorId:99},storage=incoming(1300);storage.rawData!.inventorySource='storage';
    farm.observe(replay([noProof,foreign,storage],2000),metadata,who);expect(farm.snapshot().totals.quantity).toBe(0);
    farm.observe(replay([incoming(2100)],2700),metadata,who);expect(farm.snapshot().totals.quantity).toBe(2);
  });
  it('persists only summary cursors, suppresses restart history, and recovers a pending weighted receipt',()=>{
    const{db,farm}=fixture();baseline(farm);farm.observe(replay([incoming(100)],601),metadata,who);farm.observe(replay([pending(1000)],1500),metadata,who);farm.close();
    const reopened=new CompactAutoFarmStore(db);expect(reopened.alertReceipts(who.key)).toEqual([]);
    reopened.observe(replay([incoming(100),pending(1000)],1500),{...metadata,bootstrap:true},who);expect(reopened.snapshot().totals.quantity).toBe(2);
    reopened.observe(replay([incoming(1000)],1501),metadata,who);expect(reopened.snapshot().totals.quantity).toBe(4);
    reopened.close();const again=new CompactAutoFarmStore(db);again.observe(replay([incoming(100),incoming(1000)],1501),{...metadata,bootstrap:true},who);expect(again.snapshot().totals.quantity).toBe(4);
  });
  it.each([{receipt:1000,weight:1100,frontier:1501},{receipt:900,weight:1500,frontier:1500}])('does not resurrect an already settled receipt from a truncated bootstrap: %j',({receipt,weight,frontier})=>{
    const{db,farm}=fixture();baseline(farm);const event=incoming(receipt,2,501,weight);farm.observe(replay([event],frontier),metadata,who);expect(farm.snapshot().totals.quantity).toBe(2);farm.close();
    const reopened=new CompactAutoFarmStore(db);reopened.observe(replay([pending(receipt)],1200),{...metadata,bootstrap:true},who);reopened.observe(replay([event],frontier),metadata,who);expect(reopened.snapshot().totals.quantity).toBe(2);
  });
  it('keeps Istanbul dates and unknown dates separate and revalues old totals with current shared prices',()=>{
    const{farm,daily}=fixture();baseline(farm);farm.observe(replay([incoming(59000,2),incoming(60000,3)],61000),metadata,who);farm.setPrice({itemId:501,unitPrice:10});
    expect(daily.read({date:'2026-11-04'}).totals).toMatchObject({quantity:2,knownValue:20});expect(daily.read({date:'2026-11-05'}).totals).toMatchObject({quantity:3,knownValue:30});
    farm.setPrice({itemId:501,unitPrice:0});expect(daily.read({date:'2026-11-05'}).totals.estimatedValue).toBe(0);farm.setPrice({itemId:501,unitPrice:null});expect(daily.read({date:'2026-11-05'}).totals.estimatedValue).toBeNull();
    const unknown={...who,key:'undated'};farm.observe(replay([],0,null),{...metadata,sourcePath:'C:/unknown.rrf',bootstrap:true},unknown);farm.observe(replay([incoming(100,7)],601,null),{...metadata,sourcePath:'C:/unknown.rrf'},unknown);expect(farm.snapshot().totals.quantity).toBe(12);expect(daily.read({date:'2026-11-05'}).undatedQuantity).toBe(7);
  });
  it('keeps elapsed totals on reopening, excludes gaps, and unions simultaneous character coverage',()=>{
    const{db,farm}=fixture();baseline(farm);const second={...who,key:'second'};farm.observe(replay([],0),{...metadata,sourcePath:'C:/second.rrf',bootstrap:true},second);
    farm.observe(replay([],3600000),metadata,who);farm.observe(replay([],3600000),{...metadata,sourcePath:'C:/second.rrf'},second);expect(farm.snapshot().totals.durationMs).toBe(3600000);expect(farm.snapshot().characters.map(row=>row.totals.durationMs)).toEqual([3600000,3600000]);
    farm.close();const reopened=new CompactAutoFarmStore(db);reopened.observe(replay([],7200000),{...metadata,bootstrap:true},who);reopened.observe(replay([],7260000),metadata,who);expect(reopened.snapshot().totals.durationMs).toBe(3660000);
  });
  it('applies proven live transfer correction from bounded RAM and never replays its alert',()=>{
    const{farm}=fixture();baseline(farm);const event=incoming(100);farm.observe(replay([event],601),metadata,who);expect(farm.snapshot().totals.quantity).toBe(2);
    const correction={...event,eventType:'inventory-ack' as const,rawData:{...event.rawData,inventorySource:'storage'}};farm.observe(replay([correction],700),metadata,who);expect(farm.snapshot().totals.quantity).toBe(0);expect(farm.alertReceipts(who.key)).toHaveLength(0);farm.observe(replay([event],800),metadata,who);expect(farm.snapshot().totals.quantity).toBe(0);
  });
  it('supports more than fifty characters with one bounded cursor per character',()=>{
    const{db,farm}=fixture();for(let n=0;n<51;n++){const identity={...who,key:`char-${n}`};farm.observe(replay([],0),{...metadata,sourcePath:`C:/char-${n}.rrf`,bootstrap:true},identity);}
    expect(farm.snapshot().characters).toHaveLength(51);expect(db.prepare('SELECT COUNT(*) n FROM compact_farm_cursors').get()?.n).toBe(51);
  });
  it('rolls back in-memory dedup and alerts together with a failed database transaction',()=>{
    const{db,farm}=fixture();baseline(farm);db.exec("CREATE TRIGGER reject_cursor BEFORE UPDATE ON compact_farm_cursors BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;");
    expect(()=>farm.observe(replay([incoming(100)],601),metadata,who)).toThrow('synthetic write failure');expect(farm.snapshot().totals.quantity).toBe(0);expect(farm.alertReceipts(who.key)).toEqual([]);expect(farm.lastLootFor(metadata.streamId,who.key)).toBeUndefined();
    db.exec('DROP TRIGGER reject_cursor');farm.observe(replay([incoming(100)],601),metadata,who);expect(farm.snapshot().totals.quantity).toBe(2);expect(farm.alertReceipts(who.key)).toHaveLength(1);
  });
  it('unions out-of-order live coverage without a false partial rate and keeps unknown calendar coverage separate',()=>{
    const{farm,daily}=fixture();baseline(farm);const second={...who,key:'second'};farm.observe(replay([],0),{...metadata,sourcePath:'C:/second.rrf',bootstrap:true},second);
    farm.observe(replay([incoming(100)],3600000),metadata,who);farm.observe(replay([],1800000),{...metadata,sourcePath:'C:/second.rrf'},second);farm.setPrice({itemId:501,unitPrice:10});expect(farm.snapshot().totals).toMatchObject({durationMs:3600000,knownHourlyValue:20});expect(daily.read({date:'2026-11-05'}).durationPartial).toBe(false);
  });
});

describe('validated legacy aggregation',()=>{
  it('preserves nonexcluded quantities, names, prices, exact old union durations and unknown dates without deleting legacy rows',()=>{
    const{db}=fixture();db.exec(`CREATE TABLE autofarm_sessions(id TEXT PRIMARY KEY,character_key TEXT,character_name TEXT,recording_key TEXT,time_basis TEXT,status TEXT,updated_at TEXT);
      CREATE TABLE autofarm_receipts(id TEXT PRIMARY KEY,session_id TEXT,character_key TEXT,item_id INTEGER,quantity INTEGER,event_ms REAL,item_name TEXT,excluded_reason TEXT);
      CREATE TABLE autofarm_intervals(id TEXT PRIMARY KEY,session_id TEXT,source_key TEXT,start_ms REAL,end_ms REAL);
      CREATE TABLE autofarm_cursors(source_key TEXT PRIMARY KEY,session_id TEXT,recording_key TEXT,last_replay_ms REAL,anchor_ms REAL);
      CREATE TABLE finance_calendar_sessions(session_id TEXT PRIMARY KEY,anchor_ms REAL,clock_version INTEGER,conflicting INTEGER);
      CREATE TABLE finance_calendar_intervals(interval_id TEXT PRIMARY KEY,session_id TEXT,start_ms REAL,end_ms REAL);`);
    const anchor=Date.parse('2026-11-04T20:59:00Z'),recording=createHash('sha256').update(JSON.stringify([start,42,'Alpha'])).digest('hex');
    db.prepare('INSERT INTO autofarm_sessions VALUES(?,?,?,?,?,?,?)').run('a',who.key,'Alpha',recording,'replay-start','tracking','old');db.prepare('INSERT INTO autofarm_sessions VALUES(?,?,?,?,?,?,?)').run('b','unknown','Unknown','unknown-record','observation-anchor','stopped','old');
    db.prepare('INSERT INTO finance_calendar_sessions VALUES(?,?,1,0)').run('a',anchor);
    db.prepare('INSERT INTO autofarm_intervals VALUES(?,?,?,?,?)').run('ia','a','source',anchor,anchor+120000);db.prepare('INSERT INTO autofarm_intervals VALUES(?,?,?,?,?)').run('ib','b','other',anchor,anchor+60000);db.prepare('INSERT INTO finance_calendar_intervals VALUES(?,?,?,?)').run('ia','a',anchor,anchor+120000);
    for(const[id,session,key,time,quantity,excluded]of [['before','a',who.key,59000,2,null],['after','a',who.key,60000,3,null],['excluded','a',who.key,60001,99,'storage'],['unknown','b','unknown',1,4,null]] as const)db.prepare('INSERT INTO autofarm_receipts VALUES(?,?,?,?,?,?,?,?)').run(id,session,key,501,quantity,time,'Legacy item',excluded);
    db.prepare('INSERT INTO autofarm_cursors VALUES(?,?,?,?,?)').run('source','a',recording,120000,anchor);db.prepare('INSERT INTO autofarm_prices VALUES(?,?,?)').run(501,10,'preserved-price-time');
    const result=migrateCompactFarm(db);expect(result).toMatchObject({legacyReceiptCount:3,legacyQuantity:9,compactQuantity:9,characterCount:2,allTimeDurationMs:120000,alreadyMigrated:false});expect(db.prepare('SELECT COUNT(*) n FROM autofarm_receipts').get()?.n).toBe(4);
    const farm=new CompactAutoFarmStore(db),daily=new CompactFinanceDailyStore(db);expect(farm.snapshot().totals).toMatchObject({quantity:9,knownValue:90,durationMs:120000});expect(daily.read({date:'2026-11-04'})).toMatchObject({totals:{quantity:2,durationMs:60000},undatedQuantity:4});expect(daily.read({date:'2026-11-05'}).totals).toMatchObject({quantity:3,durationMs:60000});expect(farm.snapshot().prices[0].updatedAt).toBe('preserved-price-time');
    expect(migrateCompactFarm(db).alreadyMigrated).toBe(true);expect(farm.snapshot().totals.quantity).toBe(9);
    farm.observe(replay([incoming(59000),incoming(60000,3)],120000),{...metadata,bootstrap:true},who);expect(farm.snapshot().totals.quantity).toBe(9);
  });
});
