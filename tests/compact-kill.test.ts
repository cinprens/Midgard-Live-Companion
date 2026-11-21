import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {COMPACT_KILL_SCHEMA,CompactKillStore,CompactKillDailyStore,migrateCompactKills} from '../electron/compact-kill-store';
import {emptySummary,type ParsedReplay,type ReplayEvent} from '../src/parser';
import type {CharacterIdentity} from '../src/shared/types';
const closers:(()=>void)[]=[];
afterEach(()=>{for(const close of closers.splice(0).reverse())close();});
const START='2026-11-05T23:59:59+03:00';
const who=(id=1):CharacterIdentity=>({key:`recorded:${id}:Compact`,name:`Compact ${id}`,source:'recorded',playerId:id});
const meta=(id=1,suffix='')=>({sourcePath:path.resolve(`.qa/compact-${id}${suffix}.rrf`),streamId:`stream-${id}${suffix}`,recordingId:`recording-${id}`,hash:'synthetic',observedAt:'2026-11-06T00:00:00Z'});
const death=(timestamp:number,target=timestamp+1,player=1,monster=1176):ReplayEvent=>({id:`death-${target}`,eventType:'death',timestamp,targetId:target,actorId:player,monsterId:monster,monsterName:`Monster ${monster}`,entityKind:'mob',confidence:'estimated',attribution:'personal',rawData:{attackers:[player],killProof:{death:'vanish-kind-1',ownership:'exclusive-observed-attacker-estimate',targetActorId:target,lifecycleId:`wire:0:${target}:1`,scope:'replay-local',lastAttackTimestamp:timestamp}}});
function replay(edge:number,events:ReplayEvent[]=[],id=1,startedAt:string|null=START):ParsedReplay{return{filename:'compact.rrf',format:'RRF',version:5,status:'partial',profile:'rrf-v5-latam',compatibility:'skadi-unverified',events,diagnostics:[],unknownPackets:[],packetCount:Math.max(1,events.length),incremental:{delta:true,sequence:edge+1,recordingStart:edge===0,eventCount:events.length},summary:{...emptySummary(),durationMs:edge,startedAt,playerId:id,characterName:`Compact ${id}`}};}
function fixture(){const db=new DatabaseSync(':memory:');db.exec(COMPACT_KILL_SCHEMA);let store=new CompactKillStore(db);const daily=new CompactKillDailyStore(db);closers.push(()=>{store.close();db.close();});return{db,daily,get store(){return store;},reopen(){store.close();store=new CompactKillStore(db);}};}
const count=(f:ReturnType<typeof fixture>)=>f.store.snapshot().totals.observedDeaths;
const number=(db:DatabaseSync,sql:string)=>Number(db.prepare(sql).get()!.n);

describe('compact kill migration',()=>{
 it('shows reference names for unnamed counts while preserving recorded and installed monster names',()=>{
  const {db,store,daily}=fixture();
  db.exec("INSERT INTO compact_kill_totals VALUES('synthetic','2026-11-05',1002,3,NULL),('synthetic','2026-11-05',1001,2,'Recorded monster')");
  expect(store.snapshot().monsters.map(row=>row.monsterName)).toEqual(['Recorded monster','Poring']);
  expect(daily.read({date:'2026-11-05'}).monsters.map(row=>row.monsterName)).toEqual(['Recorded monster','Poring']);
  const installed=new Map([[1002,'Installed monster']]);
  store.setLocalMonsterNames(installed);daily.setLocalMonsterNames(installed);
  expect(store.snapshot().monsters[1].monsterName).toBe('Installed monster');
  expect(daily.read({date:'2026-11-05'}).monsters[1].monsterName).toBe('Installed monster');
  expect(db.prepare('SELECT monster_name FROM compact_kill_totals WHERE monster_id=1002').get()?.monster_name).toBeNull();
 });
 it('refuses to erase an inconsistent legacy own-damage summary',()=>{
  const db=new DatabaseSync(':memory:');closers.push(()=>db.close());db.exec('CREATE TABLE kill_own_damage_totals(observed INTEGER);INSERT INTO kill_own_damage_totals VALUES(2)');
  db.exec('BEGIN');expect(()=>migrateCompactKills(db)).toThrow('toplamı doğrulanamadı');db.exec('ROLLBACK');
  expect(number(db,'SELECT SUM(observed) n FROM kill_own_damage_totals')).toBe(2);expect(number(db,"SELECT COUNT(*) n FROM sqlite_schema WHERE type='table' AND name='compact_kill_totals'")).toBe(0);
 });
 it('preserves accepted daily/undated totals and unions durations without retaining event details',()=>{
  const db=new DatabaseSync(':memory:');closers.push(()=>db.close());
  db.exec(`CREATE TABLE kill_count_sessions(id TEXT PRIMARY KEY,character_key TEXT,character_name TEXT,recording_key TEXT,time_basis TEXT,anchor_ms REAL);
   CREATE TABLE kill_count_events(session_id TEXT,monster_id INTEGER,monster_name TEXT,event_ms REAL,target_id INTEGER,lifecycle_id TEXT,proof_json TEXT);
   CREATE TABLE kill_count_intervals(session_id TEXT,start_ms REAL,end_ms REAL);
   CREATE TABLE kill_own_damage_totals(observed INTEGER);`);
  const anchor=Date.parse(START);db.prepare('INSERT INTO kill_count_sessions VALUES(?,?,?,?,?,?)').run('a',who().key,who().name,'rec-a','replay-start',anchor);
  db.prepare('INSERT INTO kill_count_sessions VALUES(?,?,?,?,?,?)').run('b',who(2).key,who(2).name,'rec-b','observation-anchor',0);
  const insert=db.prepare('INSERT INTO kill_count_events VALUES(?,?,?,?,?,?,?)');
  for(const [session,time,accepted]of [['a',100,true],['a',1500,true],['a',1700,false],['b',500,true]] as const){const event=death(time);insert.run(session,event.monsterId!,event.monsterName!,time,event.targetId!,String((event.rawData!.killProof as Record<string,unknown>).lifecycleId),JSON.stringify({...event.rawData!.killProof as object,ownDamageAccepted:accepted}));}
  db.prepare('INSERT INTO kill_count_intervals VALUES(?,?,?)').run('a',anchor,anchor+2000);db.prepare('INSERT INTO kill_count_intervals VALUES(?,?,?)').run('a',anchor+500,anchor+1500);db.prepare('INSERT INTO kill_count_intervals VALUES(?,?,?)').run('b',0,1000);db.exec('INSERT INTO kill_own_damage_totals VALUES(3)');
  const before=db.prepare('SELECT * FROM kill_count_events').all();
  const result=migrateCompactKills(db);expect(result).toMatchObject({sourceAccepted:3,totalAccepted:3,datedAccepted:2,undatedAccepted:1,characters:2,dayRows:3,legacyOwnTotal:3,durationMs:3000});
  expect(migrateCompactKills(db)).toEqual(result);expect(db.prepare('SELECT * FROM kill_count_events').all()).toEqual(before);
  const store=new CompactKillStore(db),daily=new CompactKillDailyStore(db);expect(store.snapshot().totals).toMatchObject({observedDeaths:3,durationMs:3000,confirmedPersonalKills:0});
  for(const date of ['2026-11-05','2026-11-06'])expect(daily.read({date})).toMatchObject({undatedDeaths:1,totals:{observedDeaths:1,durationMs:1000}});
  expect(daily.read({date:'2026-11-05',characterKey:who(2).key})).toMatchObject({undatedDeaths:1,totals:{observedDeaths:0,durationMs:0}});
  expect(store.snapshot().monsters.every(row=>row.lastKilledAt===null)).toBe(true);
  for(const table of ['compact_kill_totals','compact_kill_days','compact_kill_characters'])expect(db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name).join(' ')).not.toMatch(/proof|event|recording|killed|timestamp|source_hash/);
 });
});

describe('compact live own-damage totals',()=>{
 it('baselines old history and counts only new own-damage deaths',()=>{
  const f=fixture();f.store.setLocalMonsterNames(new Map([[1176,'Vitata']]));f.store.observe(replay(1000,[death(1000)]),meta(),who());expect(count(f)).toBe(0);
  const own=death(2000),other=death(2100),unknown=death(2200);other.rawData!.attackers=[2];(other.rawData!.killProof as Record<string,unknown>).ownership='observed-other-attacker-estimate';unknown.rawData!.attackers=[];(unknown.rawData!.killProof as Record<string,unknown>).ownership='unknown';
  f.store.observe(replay(3000,[own,other,unknown]),meta(),who());f.store.observe(replay(3000,[own,other,unknown]),meta(),who());
  expect(f.store.snapshot().totals).toMatchObject({observedDeaths:1,unknownDeaths:1,confirmedPersonalKills:0,durationMs:2000});expect(number(f.db,'SELECT COUNT(*) n FROM compact_kill_totals')).toBe(1);expect(f.daily.read({date:'2026-11-06'}).monsters[0].monsterName).toBe('Vitata');
 });
 it('uses its saved frontier after restart and suppresses every explicit initial replay batch',()=>{
  const f=fixture();f.store.observe(replay(0),meta(),who());f.store.observe(replay(2000,[death(1000),death(2000)]),meta(),who());expect(count(f)).toBe(2);f.reopen();
  f.store.observe(replay(500,[death(100)]),meta(),who());f.store.observe(replay(2000,[death(1000),death(2000)]),meta(),who());expect(count(f)).toBe(2);
  f.store.observe(replay(3000,[death(1000),death(2000),death(3000)]),meta(),who());expect(count(f)).toBe(3);
  f.store.observe(replay(4000,[death(4000)]),{...meta(),initial:true},who());f.store.observe(replay(5000,[death(5000)]),{...meta(),initial:true},who());expect(count(f)).toBe(3);
  f.store.observe(replay(6000,[death(6000)]),meta(),who());expect(count(f)).toBe(4);
 });
 it('deduplicates concurrent copies and accepts a new same-time death only once',()=>{
  const f=fixture();f.store.observe(replay(0),meta(),who());f.store.observe(replay(0),meta(1,'copy'),who());
  f.store.observe(replay(1000,[death(1000,11)]),meta(),who());f.store.observe(replay(1000,[death(1000,11)]),meta(1,'copy'),who());
  f.store.observe(replay(1000,[death(1000,12)]),meta(1,'copy'),who());f.store.observe(replay(1000,[death(1000,11),death(1000,12)]),meta(),who());
  expect(f.store.snapshot().totals).toMatchObject({observedDeaths:2,durationMs:1000});
 });
 it('retracts recent conflicting attacker evidence and never re-promotes a partial own-only revision',()=>{
  const f=fixture(),own=death(1000);f.store.observe(replay(0),meta(),who());f.store.observe(replay(1000,[own]),meta(),who());expect(count(f)).toBe(1);
  const mixed={...own,rawData:{...own.rawData,attackers:[1,2]}};f.store.observe(replay(2000,[mixed]),meta(),who());expect(count(f)).toBe(0);f.store.observe(replay(3000,[own]),meta(),who());expect(count(f)).toBe(0);
 });
 it('retracts known contradictions from a copied initial or shorter replay without adding historical kills',()=>{
  for(const copy of [false,true]){
   const f=fixture(),own=death(1000);f.store.observe(replay(0),meta(),who());f.store.observe(replay(2000,[own]),meta(),who());expect(count(f)).toBe(1);
   const mixed={...own,rawData:{...own.rawData,attackers:[1,2]}};
   f.store.observe(replay(1000,[mixed,death(900)]),copy?{...meta(1,'copy'),initial:true}:meta(),who());
   expect(count(f)).toBe(0);expect(f.store.snapshot().totals.durationMs).toBe(2000);
  }
 });
 it('preserves unknown dates without inventing calendar totals',()=>{
  const f=fixture();f.store.observe(replay(0,[],1,null),meta(),who());f.store.observe(replay(2000,[death(1000)],1,null),meta(),who());
  expect(f.store.snapshot().totals).toMatchObject({observedDeaths:1,timeBasis:'observation-anchor',durationMs:2000});expect(f.daily.read({date:'2026-11-06'})).toMatchObject({undatedDeaths:1,totals:{observedDeaths:0,durationMs:0}});
 });
 it('unions overlapping recording coverage, splits midnight, and excludes a disconnected gap',()=>{
  const f=fixture();f.store.observe(replay(0),meta(),who());f.store.observe(replay(2000,[death(1500)]),meta(),who());
  const alternate='2026-11-05T23:59:59.100+03:00';f.store.observe(replay(0,[],1,alternate),meta(1,'other'),who());f.store.observe(replay(1900,[death(1000)],1,alternate),meta(1,'other'),who());
  expect(f.store.snapshot().totals.durationMs).toBe(2000);expect(f.daily.read({date:'2026-11-05'}).totals.durationMs).toBe(1000);expect(f.daily.read({date:'2026-11-06'}).totals.durationMs).toBe(1000);
  f.store.suspend(meta().sourcePath);f.store.suspend(meta(1,'other').sourcePath);f.store.observe(replay(4000),meta(),who());f.store.observe(replay(5000,[death(5000)]),meta(),who());expect(f.store.snapshot().totals.durationMs).toBe(3000);
 });
 it('rolls back count and proof-window changes if persistence fails',()=>{
  const f=fixture();f.store.observe(replay(0),meta(),who());f.db.exec("CREATE TRIGGER reject_compact BEFORE INSERT ON compact_kill_totals BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  expect(()=>f.store.observe(replay(1000,[death(1000)]),meta(),who())).toThrow('synthetic failure');expect(count(f)).toBe(0);f.db.exec('DROP TRIGGER reject_compact');f.store.observe(replay(1000,[death(1000)]),meta(),who());expect(count(f)).toBe(1);
 });
 it('keeps 50 characters and 1000 kills in day/type rows instead of event rows',()=>{
  const f=fixture();
  for(let id=1;id<=50;id++){f.store.observe(replay(0,[],id),meta(id),who(id));for(let n=1;n<=20;n++)f.store.observe(replay(n*1000,[death(n*1000,n,id)],id),meta(id),who(id));}
  expect(f.store.snapshot().characters).toHaveLength(50);expect(count(f)).toBe(1000);expect(f.store.snapshot().totals.durationMs).toBe(20000);
  expect(number(f.db,'SELECT COUNT(*) n FROM compact_kill_totals')).toBe(50);expect(number(f.db,'SELECT COUNT(*) n FROM compact_kill_cursors')).toBe(50);
  expect(f.daily.read({date:'2026-11-06',characterKey:who(25).key}).totals.observedDeaths).toBe(20);
  const internal=f.store as unknown as {sources:Map<unknown,unknown>;recordings:Map<unknown,unknown>;recent:Map<unknown,unknown>};expect(internal.sources.size).toBe(50);expect(internal.recent.size).toBeLessThanOrEqual(4096);
  f.store.syncStatuses([]);expect([internal.sources.size,internal.recordings.size,internal.recent.size]).toEqual([0,0,0]);expect(count(f)).toBe(1000);
 });
});
