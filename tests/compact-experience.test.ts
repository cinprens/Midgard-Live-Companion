import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {KillExperienceStore} from '../electron/kill-experience-store';
import {SoloExperienceDailyStore,SOLO_EXPERIENCE_DAILY_SCHEMA} from '../electron/solo-experience-daily-store';
import {COMPACT_EXPERIENCE_SCHEMA,migrateCompactExperience} from '../electron/compact-experience';
import {emptySummary,type ParsedReplay,type ReplayEvent} from '../src/parser';
import type {CharacterIdentity} from '../src/shared/types';
import type {KillExperienceControl} from '../src/shared/kill-experience';

const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanups.splice(0).reverse())close();});
function database(){
 const db=new DatabaseSync(':memory:');cleanups.push(()=>db.close());
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE finance_metadata(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE kill_experience_sessions(id TEXT PRIMARY KEY,character_key TEXT NOT NULL,data_json TEXT NOT NULL);
 CREATE TABLE kill_experience_groups(id TEXT PRIMARY KEY,data_json TEXT NOT NULL);
 CREATE TABLE kill_experience_rates(character_key TEXT,monster_id INTEGER,base_exp INTEGER,job_exp INTEGER,updated_at TEXT,PRIMARY KEY(character_key,monster_id));
 CREATE TABLE kill_experience_penalties(character_key TEXT PRIMARY KEY,percent INTEGER,updated_at TEXT);
 CREATE TABLE kill_experience_awards(session_id TEXT,event_key TEXT,monster_id INTEGER,base_exp INTEGER,job_exp INTEGER,PRIMARY KEY(session_id,event_key));
 CREATE TABLE kill_experience_losses(session_id TEXT,event_key TEXT,percent INTEGER,base_loss INTEGER,job_loss INTEGER,PRIMARY KEY(session_id,event_key));
 CREATE TABLE kill_count_sessions(character_key TEXT,character_name TEXT);`+SOLO_EXPERIENCE_DAILY_SCHEMA);
 return db;
}
const identity=(id=1):CharacterIdentity=>({key:`character-${id}`,name:`Character ${id}`,source:'recorded',playerId:id});
const meta=(id=1)=>({sourcePath:`C:\\SYNTHETIC\\${id}.rrf`,streamId:`stream-${id}`,recordingId:`recording-${id}`,hash:'synthetic'});
const tick=(timestamp:number):ReplayEvent=>({id:`tick-${timestamp}`,eventType:'status',timestamp,statusKey:'hp',amount:100,confidence:'certain'});
const death=(timestamp:number,target=timestamp,owner=1):ReplayEvent=>({id:`death-${target}`,eventType:'death',timestamp,monsterId:1176,targetId:target,actorId:owner,entityKind:'mob',confidence:'estimated',attribution:'personal',rawData:{attackers:[owner],killProof:{death:'vanish-kind-1',targetActorId:target,lifecycleId:`0:${target}:1`,scope:'replay-local',ownership:'exclusive-observed-attacker-estimate',lastAttackTimestamp:timestamp}}});
function replay(events:ReplayEvent[],startedAt:string|null='2026-11-06T23:59:58',id=1):ParsedReplay{
 return{filename:`${id}.rrf`,format:'RRF',version:5,status:'partial',profile:'rrf-v5-latam',compatibility:'skadi-unverified',diagnostics:[],unknownPackets:[],packetCount:events.length,events,summary:{...emptySummary(),characterName:`Character ${id}`,playerId:id,startedAt,liveTelemetry:{hp:100,maxHp:100,weight:0,maxWeight:100,weightPercent:0,baseLevel:10,jobLevel:10,currentBaseExp:null,currentJobExp:null,nextBaseExp:null,nextJobExp:null,lastBaseExpGain:null,lastJobExpGain:null,baseExpGained:null,jobExpGained:null,currentMap:null,jobTrack:'second',jobTrackSource:'rrf-session-class'}}};
}
const session=(store:KillExperienceStore,id=1)=>store.snapshot().characters.find(c=>c.characterKey===identity(id).key)!.session!;
function command(store:KillExperienceStore,action:KillExperienceControl['action'],id=1){const previous=store.snapshot().characters.find(c=>c.characterKey===identity(id).key)?.session;store.control({characterKey:identity(id).key,streamId:meta(id).streamId,recordingId:meta(id).recordingId,action,...(previous?{sessionId:previous.id}:{})});}
function start(store:KillExperienceStore,id=1,clock:string|null='2026-11-06T23:59:58'){store.observe(replay([tick(0)],clock,id),meta(id),identity(id));store.setRate({characterKey:identity(id).key,monsterId:1176,baseExp:100,jobExp:50});command(store,'start',id);}
const legacyTables=['solo_experience_calendar_awards','solo_experience_calendar_intervals','solo_experience_calendar_sessions','kill_experience_awards','kill_experience_losses','kill_experience_groups','kill_experience_sessions'];
function clearLegacy(db:DatabaseSync){for(const table of legacyTables)db.exec(`DELETE FROM ${table}`);}
function count(db:DatabaseSync,table:string){return Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);}
const withoutNotice=(value:ReturnType<SoloExperienceDailyStore['read']>)=>{const{notice,...data}=value;return data;};

describe('compact frozen solo EXP summaries',()=>{
 it('migrates frozen daily/all values exactly once before removing old details',()=>{
  const db=database(),old=new KillExperienceStore(db,{soloOnly:true});start(old);
  old.observe(replay([death(1000),tick(2000)]),meta(),identity());
  old.setRate({characterKey:identity().key,monsterId:1176,baseExp:300,jobExp:null});
  old.observe(replay([death(1000),death(3000),tick(4000)]),meta(),identity());
  command(old,'reset');old.observe(replay([death(5000),tick(6000)]),meta(),identity());
  const reader=new SoloExperienceDailyStore(db),daily=reader.read({date:'2026-11-07'}),all=reader.read({date:'2026-11-07',scopeMode:'all'}),current=session(old);old.close();
  const metrics=migrateCompactExperience(db);expect(metrics).toMatchObject({migrated:true,eligibleSessions:2,currentSessions:1,characters:1,dailyRows:2,all:{observedDeaths:3,durationMs:6000,baseExp:700,jobExp:50,missingJob:2},dated:{observedDeaths:3,durationMs:6000}});
  expect(migrateCompactExperience(db)).toEqual({...metrics,migrated:false});clearLegacy(db);
  const compact=new KillExperienceStore(db,{summaryOnly:true}),compactDaily=new SoloExperienceDailyStore(db,{summaryOnly:true});
  expect(session(compact)).toMatchObject({id:current.id,status:'source-unavailable',observedDeaths:1,base:{gained:300}});
  expect(withoutNotice(compactDaily.read({date:'2026-11-07'}))).toEqual(withoutNotice(daily));
  expect(withoutNotice(compactDaily.read({date:'2026-11-07',scopeMode:'all'}))).toEqual(withoutNotice(all));
  for(const table of legacyTables)expect(count(db,table)).toBe(0);
 });
 it('preserves legacy date-less totals, excludes unowned sessions and keeps an interval-only zero day',()=>{
  const db=database(),old=new KillExperienceStore(db,{soloOnly:true});start(old,1,null);old.observe(replay([death(1000),tick(2000)],null),meta(),identity());
  start(old,2);old.observe(replay([tick(4000)],'2026-11-06T23:59:58',2),meta(2),identity(2));
  const legacy={...JSON.parse(String(db.prepare('SELECT data_json FROM kill_experience_sessions WHERE character_key=?').get(identity().key)?.data_json)),id:'legacy',attributionPolicy:undefined,observedDeaths:999};
  db.prepare('INSERT INTO kill_experience_sessions VALUES(?,?,?)').run('legacy','legacy',JSON.stringify(legacy));
  const reader=new SoloExperienceDailyStore(db),before=reader.read({date:'2026-11-07',scopeMode:'all'});migrateCompactExperience(db);clearLegacy(db);
  const compact=new SoloExperienceDailyStore(db,{summaryOnly:true});expect(withoutNotice(compact.read({date:'2026-11-07',scopeMode:'all'}))).toEqual(withoutNotice(before));
  expect(compact.read({date:'2026-11-07'})).toMatchObject({undatedObservedDeaths:1,totals:{hasData:true,observedDeaths:0,durationMs:2000,base:{gained:0}}});
  expect(compact.read({date:'2026-11-08'}).totals).toMatchObject({hasData:false,durationMs:0,base:{gained:0,perHour:null}});
 });
 it('counts only own damage, freezes new rates, splits midnight and keeps raw tables empty',()=>{
  const db=database(),store=new KillExperienceStore(db,{summaryOnly:true}),daily=new SoloExperienceDailyStore(db,{summaryOnly:true});start(store);
  const other=death(1200,1200,2),mixed=death(1400);mixed.rawData!.attackers=[1,2];mixed.attribution='unknown';mixed.confidence='unknown';
  store.observe(replay([death(1000),other,mixed,tick(2000)]),meta(),identity());
  store.setRate({characterKey:identity().key,monsterId:1176,baseExp:300,jobExp:null});
  const events=[death(1000),death(3000),death(3000),tick(4000)];store.observe(replay(events),meta(),identity());store.observe(replay(events),meta(),identity());
  expect(session(store)).toMatchObject({observedDeaths:2,durationMs:4000,base:{gained:400},job:{gained:null,knownGained:50,missingDeaths:1}});
  expect(daily.read({date:'2026-11-06'}).totals).toMatchObject({observedDeaths:1,durationMs:2000,base:{gained:100},job:{gained:50}});
  expect(daily.read({date:'2026-11-07'}).totals).toMatchObject({observedDeaths:1,durationMs:2000,base:{gained:300},job:{gained:null,missingDeaths:1}});
  for(const table of legacyTables)expect(count(db,table)).toBe(0);
 });
 it('excludes pause and source gaps and silently baselines every restart chunk',()=>{
  const db=database();let store=new KillExperienceStore(db,{summaryOnly:true});start(store);
  store.observe(replay([death(1000),tick(2000)]),meta(),identity());command(store,'pause');
  store.observe(replay([death(3000),tick(4000)]),meta(),identity());command(store,'resume');
  store.observe(replay([death(5000),tick(6000)]),meta(),identity());
  store.syncStatuses([{id:'stream-1',sourcePath:meta().sourcePath,status:'missing',character:identity()}]);
  store.syncStatuses([{id:'stream-1',sourcePath:meta().sourcePath,status:'following',character:identity()}]);
  store.observe(replay([death(7000),tick(8000)]),meta(),identity());store.observe(replay([death(9000),tick(10000)]),meta(),identity());
  const before=session(store);expect(before).toMatchObject({observedDeaths:3,durationMs:6000});store.close();store=new KillExperienceStore(db,{summaryOnly:true});
  for(const timestamp of [11000,12000]){const parsed=replay([death(timestamp),tick(timestamp)]);parsed.incremental={delta:true,sequence:timestamp,recordingStart:false,eventCount:1};parsed.summary.durationMs=timestamp;store.observe(parsed,{...meta(),initial:true},identity());}
  expect(session(store)).toMatchObject({id:before.id,observedDeaths:3,durationMs:6000});
  store.observe(replay([death(13000),tick(14000)]),meta(),identity());
  expect(session(store)).toMatchObject({observedDeaths:4,durationMs:8000});
  expect(new SoloExperienceDailyStore(db,{summaryOnly:true}).read({date:'2026-11-07',scopeMode:'all'}).totals).toMatchObject({observedDeaths:4,durationMs:8000,base:{gained:400}});
 });
 it('retains one current session per character through resets and caps volatile event deduplication',()=>{
  const db=database(),store=new KillExperienceStore(db,{summaryOnly:true});start(store);
  for(let index=1;index<=20;index++){store.observe(replay([death(index*1000),tick(index*1000+1)]),meta(),identity());command(store,'reset');}
  expect(count(db,'compact_experience_current')).toBe(1);expect(count(db,'compact_experience_totals')).toBe(1);
  expect(new SoloExperienceDailyStore(db,{summaryOnly:true}).read({date:'2026-11-07',scopeMode:'all'}).totals.observedDeaths).toBe(20);
  const many=Array.from({length:8300},(_,index)=>death(30000+index));store.observe(replay([...many,tick(40000)]),meta(),identity());
  const seen=(store as unknown as {compactSeen:Map<string,Set<string>>}).compactSeen;expect(seen.size).toBe(1);expect([...seen.values()][0].size).toBeLessThanOrEqual(8192);
  expect(count(db,'compact_experience_current')).toBe(1);for(const table of legacyTables)expect(count(db,table)).toBe(0);
  expect(JSON.stringify(db.prepare('SELECT * FROM compact_experience_current').all())).not.toContain('death-');
 });
 it('clamps a shorter restart snapshot to the saved frontier and suppresses its old boundary',()=>{
  const db=database();let store=new KillExperienceStore(db,{summaryOnly:true});start(store);
  store.observe(replay([death(1000),death(2000)]),meta(),identity());const before=session(store);store.close();
  store=new KillExperienceStore(db,{summaryOnly:true});store.observe(replay([tick(0)]),{...meta(),initial:true},identity());
  store.observe(replay([death(1000),death(2000),death(2000,99)]),meta(),identity());
  expect(session(store)).toMatchObject({observedDeaths:2,durationMs:2000});
  store.observe(replay([death(3000),tick(4000)]),meta(),identity());expect(session(store)).toMatchObject({id:before.id,observedDeaths:3,durationMs:4000});
  expect(new SoloExperienceDailyStore(db,{summaryOnly:true}).read({date:'2026-11-07',scopeMode:'all'}).totals).toMatchObject({observedDeaths:3,durationMs:4000});
  expect(JSON.parse(String(db.prepare('SELECT data_json FROM compact_experience_current').get()!.data_json)).compactFrontier).toBe(4000);
 });
 it('does not turn a shortened source into new history when starting a replacement measurement',()=>{
  const db=database(),store=new KillExperienceStore(db,{summaryOnly:true});start(store);store.observe(replay([death(1000),death(2000)]),meta(),identity());
  store.observe(replay([tick(0)]),meta(),identity());command(store,'reset');
  store.observe(replay([death(1000),death(2000)]),meta(),identity());expect(session(store)).toMatchObject({observedDeaths:0,durationMs:0});
  store.observe(replay([death(3000),tick(4000)]),meta(),identity());expect(session(store)).toMatchObject({observedDeaths:1,durationMs:2000});
  expect(new SoloExperienceDailyStore(db,{summaryOnly:true}).read({date:'2026-11-07',scopeMode:'all'}).totals).toMatchObject({observedDeaths:3,durationMs:4000});
 });
 it('unions overlapping migrated coverage and rolls back invalid totals without deleting detail',()=>{
  const db=database(),store=new KillExperienceStore(db,{soloOnly:true});start(store);store.observe(replay([death(1000),tick(4000)]),meta(),identity());
  const interval=db.prepare('SELECT * FROM solo_experience_calendar_intervals').get()!;db.prepare('INSERT INTO solo_experience_calendar_intervals VALUES(?,?,?,?,?)').run('duplicate',interval.session_id!,interval.character_key!,interval.start_ms!,interval.end_ms!);
  const metrics=migrateCompactExperience(db);expect(metrics.dated.durationMs).toBe(4000);expect(count(db,'solo_experience_calendar_intervals')).toBe(2);
  const bad=database();bad.exec(COMPACT_EXPERIENCE_SCHEMA);bad.prepare('INSERT INTO kill_experience_sessions VALUES(?,?,?)').run('bad','bad',JSON.stringify({attributionPolicy:'own-damage-v1',observedDeaths:Number.MAX_SAFE_INTEGER+1}));
  expect(()=>migrateCompactExperience(bad)).toThrow('güvenli');expect(count(bad,'kill_experience_sessions')).toBe(1);expect(count(bad,'compact_experience_current')).toBe(0);
 });
});
