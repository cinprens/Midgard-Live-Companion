import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,mkdtemp,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import {FinanceDailyStore,FINANCE_DAILY_SCHEMA} from '../electron/finance-daily-store';
import {ExpansionStore} from '../electron/expansion-store';
import {emptySummary,type ParsedReplay,type ReplayEvent} from '../src/parser';
import {killDailyBounds} from '../src/shared/kill-daily';

const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
function fixture(){
  const db=new DatabaseSync(':memory:');cleanup.push(()=>db.close());
  db.exec(`CREATE TABLE autofarm_sessions(id TEXT PRIMARY KEY,character_key TEXT,character_name TEXT,recording_key TEXT,time_basis TEXT,status TEXT,updated_at TEXT);
    CREATE TABLE autofarm_cursors(source_key TEXT PRIMARY KEY,session_id TEXT,recording_key TEXT,last_replay_ms REAL,monitor_start_ms REAL,baseline_counts_json TEXT,anchor_ms REAL,history_mode INTEGER);
    CREATE TABLE autofarm_intervals(id TEXT PRIMARY KEY,session_id TEXT,source_key TEXT,start_ms REAL,end_ms REAL);
    CREATE TABLE autofarm_receipts(id TEXT PRIMARY KEY,session_id TEXT,character_key TEXT,item_id INTEGER,quantity INTEGER,event_ms REAL,recorded_at TEXT,source_hash TEXT,inventory_source TEXT,confidence TEXT,item_name TEXT,excluded_reason TEXT,decoder_revision INTEGER);
    CREATE TABLE autofarm_prices(item_id INTEGER PRIMARY KEY,unit_price REAL,updated_at TEXT);CREATE TABLE finance_metadata(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE item_database(item_id INTEGER,name TEXT);`);
  db.exec(FINANCE_DAILY_SCHEMA);const daily=new FinanceDailyStore(db);
  const session=(id:string,character='a',anchor=Date.parse('2026-11-04T21:00:00Z'),known=true)=>{
    db.prepare('INSERT INTO autofarm_sessions VALUES(?,?,?,?,?,?,?)').run(id,character,`Avcı ${character}`,id,'replay-start','stopped','2040-01-01T00:00:00Z');
    if(known)db.prepare('INSERT INTO finance_calendar_sessions VALUES(?,?,?,?,?,?,?)').run(id,anchor,new Date(anchor).toISOString(),'UTC',1,'replay-header',0);
    return anchor;
  };
  const span=(id:string,session:string,start:number,end:number,mapped=true)=>{db.prepare('INSERT INTO autofarm_intervals VALUES(?,?,?,?,?)').run(id,session,id,start,end);if(mapped)db.prepare('INSERT INTO finance_calendar_intervals VALUES(?,?,?,?)').run(id,session,start,end);};
  const receipt=(id:string,session:string,ms:number,quantity=1,item=501,excluded:string|null=null)=>{
    const key=String(db.prepare('SELECT character_key FROM autofarm_sessions WHERE id=?').get(session)!.character_key);
    db.prepare('INSERT INTO autofarm_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,session,key,item,quantity,ms,'2040-01-01T00:00:00Z','synthetic','unknown','unknown',`Eşya ${item}`,excluded,2);
  };
  const price=(item:number,value:number|null)=>db.prepare('INSERT INTO autofarm_prices VALUES(?,?,?) ON CONFLICT(item_id) DO UPDATE SET unit_price=excluded.unit_price').run(item,value,'2040-01-01T00:00:00Z');
  return{db,daily,session,span,receipt,price};
}

describe('read-only daily finance projection',()=>{
  it('cuts receipt dates at Istanbul midnight and never uses archive insertion date',()=>{
    const{daily,session,span,receipt,price}=fixture(),anchor=session('r','a',Date.parse('2026-11-04T20:59:00Z'));price(501,10);
    span('s','r',anchor,anchor+86520000);receipt('before','r',59999,2);receipt('midnight','r',60000,3);receipt('last','r',86459999,4);receipt('next','r',86460000,5);
    expect(daily.read({date:'2026-11-05'})).toMatchObject({timeZone:'Europe/Istanbul',priceBasis:'current-shared-prices',totals:{quantity:7,knownValue:70,durationMs:86400000},undatedQuantity:0,durationPartial:false});
    expect(daily.read({date:'2026-11-04'}).totals.quantity).toBe(2);expect(daily.read({date:'2026-11-06'}).totals.quantity).toBe(5);expect(daily.read({date:'2040-01-01'}).totals.quantity).toBe(0);
  });
  it('unions overlapping character hours while keeping all selected-day distributions',()=>{
    const{daily,session,span,receipt,price}=fixture();price(501,100);
    for(const key of ['a','b']){const anchor=session(key,key);span(`s-${key}`,key,anchor,anchor+3600000);receipt(`e-${key}`,key,1000,key==='a'?7:13);}
    const all=daily.read({date:'2026-11-05'});expect(all.totals).toMatchObject({quantity:20,knownValue:2000,durationMs:3600000,knownHourlyValue:2000});
    const own=daily.read({date:'2026-11-05',characterKey:'a'});expect(own.totals).toMatchObject({quantity:7,knownValue:700});expect(own.characters.map(row=>row.totals.quantity)).toEqual([7,13]);expect(own.days.at(-1)?.knownValue).toBe(700);
  });
  it('keeps unknown prices distinct from zero and revalues old dates using current shared prices',()=>{
    const{daily,session,span,receipt,price}=fixture(),anchor=session('r');span('s','r',anchor,anchor+3600000);receipt('zero','r',1000,5,501);receipt('unknown','r',2000,2,502);price(501,0);
    expect(daily.read({date:'2026-11-05'}).totals).toMatchObject({knownValue:0,estimatedValue:null,partial:true,unpricedQuantity:2,knownHourlyValue:0,hourlyValue:null});
    price(502,20);expect(daily.read({date:'2026-11-05'}).totals).toMatchObject({knownValue:40,estimatedValue:40,partial:false,knownHourlyValue:40});
    price(501,10);expect(daily.read({date:'2026-11-05'}).totals.knownValue).toBe(90);
  });
  it('keeps undated and conflicting clocks in all-time accounting, excludes corrected receipts',()=>{
    const{daily,session,span,receipt,db}=fixture(),anchor=session('known');span('s','known',anchor,anchor+3600000);receipt('ok','known',1000,3);receipt('excluded','known',2000,99,501,'storage');
    session('unknown','a',anchor,false);receipt('undated','unknown',1000,5);session('conflict','b');receipt('conflicted','conflict',1000,7);db.exec("UPDATE finance_calendar_sessions SET conflicting=1 WHERE session_id='conflict'");
    expect(daily.read({date:'2026-11-05'})).toMatchObject({totals:{quantity:3},undatedQuantity:12});expect(daily.read({date:'2026-11-05',characterKey:'a'}).undatedQuantity).toBe(5);
  });
  it('suppresses hourly value when a recovered date has unmapped historical coverage',()=>{
    const{daily,session,span,receipt,price}=fixture(),anchor=session('r');price(501,10);span('unmapped','r',anchor,anchor+3600000,false);span('new','r',anchor+3600000,anchor+3660000);receipt('old','r',1000,100);receipt('new','r',3610000,1);
    const value=daily.read({date:'2026-11-05'});expect(value).toMatchObject({durationPartial:true,totals:{quantity:101,knownValue:1010,knownHourlyValue:null,hourlyValue:null,durationMs:60000}});expect(value.characters[0].totals.knownHourlyValue).toBeNull();expect(value.days.at(-1)?.durationPartial).toBe(true);
  });
  it('counts negative event times as undated exactly once across known and unknown sessions',()=>{
    const{daily,session,receipt}=fixture();session('known');session('unknown','b',Date.parse('2026-11-04T21:00:00Z'),false);
    receipt('known-negative','known',-1,3);receipt('unknown-negative','unknown',-1,5);receipt('unknown-positive','unknown',1000,7);receipt('excluded-negative','known',-1,100,501,'storage');
    expect(daily.read({date:'2026-11-05'})).toMatchObject({totals:{quantity:0},undatedQuantity:15});expect(daily.read({date:'2026-11-05',characterKey:'a'}).undatedQuantity).toBe(3);expect(daily.read({date:'2026-11-05',characterKey:'b'}).undatedQuantity).toBe(12);
  });
  it('retains known zero days and no-duration rate unknown while keeping the calendar seven days long',()=>{
    const{daily,session,span}=fixture(),anchor=session('r');span('s','r',anchor,anchor+3600000);
    const day=daily.read({date:'2026-11-05'});expect(day.totals).toMatchObject({quantity:0,estimatedValue:0,knownHourlyValue:0});expect(day.days).toHaveLength(7);expect(day.days[0].date).toBe('2026-10-30');expect(daily.read({date:'2026-11-06'}).totals.knownHourlyValue).toBeNull();
  });
  it('uses catalog then receipt then local names without touching prices or source rows',()=>{
    const{daily,db,session,span,receipt}=fixture(),anchor=session('r');span('s','r',anchor,anchor+3600000);receipt('e','r',1000,3);daily.setLocalItemNames(new Map([[501,'Yerel ad']]));
    db.exec("UPDATE autofarm_receipts SET item_name=NULL");expect(daily.read({date:'2026-11-05'}).items[0].itemName).toBe('Yerel ad');db.exec("INSERT INTO item_database VALUES(501,'Katalog ad')");
    const before=JSON.stringify(db.prepare('SELECT * FROM autofarm_receipts').all());for(let i=0;i<3;i++)expect(daily.read({date:'2026-11-05'}).items[0].itemName).toBe('Katalog ad');expect(JSON.stringify(db.prepare('SELECT * FROM autofarm_receipts').all())).toBe(before);
  });
  it('validates dates and scopes before any SQL and supports calendar boundaries',()=>{
    const{daily}=fixture();for(const value of [null,[],{}, {date:'2026-02-30'},{date:'2026-11-05',extra:true},{date:'2026-11-05',characterKey:''},{date:'2026-11-05',characterKey:'bad\n'}])expect(()=>daily.read(value)).toThrow();
    for(const date of ['0001-01-07','9999-12-30'])expect(daily.read({date}).days).toHaveLength(7);
  });
});

const who={key:'recorded:1',name:'Avcı',playerId:1,source:'recorded' as const};
function incoming(ms:number,amount=1):ReplayEvent{return{id:`receipt-${ms}`,eventType:'item-obtained',timestamp:ms,itemId:501,amount,actorId:1,confidence:'certain',rawData:{inventoryWeightProof:{kind:'own-weight-increase',ownerActorId:1,before:100,after:120,receiptTimestamp:ms,weightTimestamp:ms+100,confirmedAt:ms+500,scope:'receipt-batch'},inventoryAction:'incoming',inventorySource:'unknown',parserProof:'source-defined-add-delta',quantitySemantics:'added-delta',inventoryBaseline:false,skadiVerified:false,replayContextVerified:true,inventoryHistoryReliable:true,slot:1}};}
function replay(startedAt:string|null,events:ReplayEvent[]):ParsedReplay{return{filename:'SYNTHETIC.rrf',format:'RRF',version:5,status:'partial',profile:'rrf-v5-latam',compatibility:'skadi-unverified',diagnostics:[],unknownPackets:[],packetCount:events.length,events,summary:{...emptySummary(),startedAt,playerId:1,characterName:'Avcı'}};}
const tick=(timestamp:number):ReplayEvent=>({id:`tick-${timestamp}`,eventType:'status',timestamp,statusKey:'hp',amount:100,confidence:'certain'});
async function profile(){await mkdir('.qa',{recursive:true});const directory=await mkdtemp(path.resolve('.qa/finance-daily-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));const file=path.join(directory,'profile.sqlite'),store=new ExpansionStore(file);cleanup.push(()=>store.close());return{directory,file,store};}

describe('finance calendar provenance and migration',()=>{
  it('does not backfill legacy sessions from null, inconsistent or observation-only anchors',()=>{
    const{db,session,span,receipt,daily}=fixture(),anchor=Date.parse('2026-11-04T21:00:00Z');
    for(const key of ['valid','mixed-null','conflict','observed']){session(key,'a',anchor,false);span(`s-${key}`,key,anchor,anchor+60000,false);receipt(`e-${key}`,key,1000,1);}
    db.exec("UPDATE autofarm_sessions SET time_basis='observation-anchor' WHERE id='observed'");
    const cursor=db.prepare('INSERT INTO autofarm_cursors VALUES(?,?,?,?,?,?,?,?)');
    for(const key of ['valid','mixed-null','conflict','observed'])cursor.run(`${key}-1`,key,key,60000,0,'{}',anchor,1);
    cursor.run('mixed-null-2','mixed-null','mixed-null',60000,0,'{}',null,1);cursor.run('conflict-2','conflict','conflict',60000,0,'{}',anchor+3600000,1);
    db.exec(FINANCE_DAILY_SCHEMA);
    expect(db.prepare('SELECT session_id FROM finance_calendar_sessions').all().map(row=>row.session_id)).toEqual(['valid']);
    expect(daily.read({date:'2026-11-05'})).toMatchObject({totals:{quantity:1,durationMs:60000},undatedQuantity:3});
  });
  it('normalizes naive replay headers independently of import date and host timezone without recounting copies',async()=>{
    const{directory,store}=await profile(),parsed=replay('2026-11-04T23:59:00',[incoming(59000,2),incoming(60000,3),tick(3660000)]),meta={sourcePath:path.join(directory,'a.rrf'),streamId:'a',hash:'a',recordingId:'a',includeReplayHistory:true,observedAt:'2040-01-01T00:00:00Z'};
    const old=process.env.TZ;try{process.env.TZ='America/New_York';store.autoFarm.observe(parsed,meta,who);store.autoFarm.observe(parsed,{...meta,sourcePath:path.join(directory,'copy.rrf'),streamId:'copy',hash:'copy'},who);}finally{if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}
    store.autoFarm.setPrice({itemId:501,unitPrice:10});expect(store.autoFarm.snapshot().totals.quantity).toBe(5);expect(store.financeDaily.read({date:'2026-11-04'}).totals.quantity).toBe(2);expect(store.financeDaily.read({date:'2026-11-05'}).totals).toMatchObject({quantity:3,knownValue:30,durationMs:3600000});
  });
  it('preserves unknown-date gains in all-time total rather than assigning the import day',async()=>{
    const{directory,store}=await profile();store.autoFarm.observe(replay(null,[incoming(1000,4),tick(60000)]),{sourcePath:path.join(directory,'a.rrf'),streamId:'a',hash:'a',recordingId:'a',includeReplayHistory:true,observedAt:'2026-11-05T10:00:00Z'},who);
    expect(store.autoFarm.snapshot().totals.quantity).toBe(4);expect(store.financeDaily.read({date:'2026-11-05'})).toMatchObject({totals:{quantity:0},undatedQuantity:4});
  });
  it('backs up committed schema10 WAL data, preserves ledgers and only recovers explicit unambiguous anchors',async()=>{
    const{directory,file,store}=await profile();store.autoFarm.observe(replay('2026-11-05T00:00:00Z',[incoming(1000,4),tick(60000)]),{sourcePath:path.join(directory,'a.rrf'),streamId:'a',hash:'a',recordingId:'a',includeReplayHistory:true},who);store.setSetting('keep-finance',{favoriteIds:[501],dailyDate:null});store.close();cleanup.pop();
    const writer=new DatabaseSync(file);cleanup.push(()=>writer.close());writer.exec('PRAGMA journal_mode=WAL;DROP TABLE finance_calendar_intervals;DROP TABLE finance_calendar_sessions;DROP TABLE IF EXISTS solo_experience_calendar_awards;DROP TABLE IF EXISTS solo_experience_calendar_intervals;DROP TABLE IF EXISTS solo_experience_calendar_sessions;DELETE FROM expansion_migrations WHERE version>=12;DELETE FROM expansion_migrations WHERE version=11;');writer.prepare('INSERT INTO expansion_settings VALUES(?,?)').run('wal-sentinel','{"keep":42}');
    const rows=JSON.stringify(writer.prepare('SELECT * FROM autofarm_receipts').all()),settings=JSON.stringify(writer.prepare('SELECT * FROM expansion_settings ORDER BY key').all());
    const reopened=new ExpansionStore(file);cleanup.push(()=>reopened.close());expect(reopened.financeMigrationBackupPath).toContain('before-finance-daily');
    const backup=new DatabaseSync(reopened.financeMigrationBackupPath!,{readOnly:true});try{expect(backup.prepare('SELECT MAX(version) version FROM expansion_migrations').get()?.version).toBe(10);expect(JSON.stringify(backup.prepare('SELECT * FROM expansion_settings ORDER BY key').all())).toBe(settings);expect(backup.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');}finally{backup.close();}
    expect(JSON.stringify(writer.prepare('SELECT * FROM autofarm_receipts').all())).toBe(rows);expect(JSON.stringify(writer.prepare('SELECT * FROM expansion_settings ORDER BY key').all())).toBe(settings);expect(reopened.financeDaily.read({date:'2026-11-05'})).toMatchObject({totals:{quantity:4,durationMs:60000},undatedQuantity:0});expect(writer.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect((await readdir(directory)).filter(name=>name.includes('before-finance-daily'))).toHaveLength(1);
  });
});
