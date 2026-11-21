import type {DatabaseSync} from 'node:sqlite';
import {killDailyBounds,killDailyDate} from '../src/shared/kill-daily';

export const COMPACT_EXPERIENCE_SCHEMA=`
 CREATE TABLE IF NOT EXISTS compact_experience_totals(character_key TEXT PRIMARY KEY,character_name TEXT NOT NULL,observed_deaths INTEGER NOT NULL,duration_ms INTEGER NOT NULL,base_exp INTEGER NOT NULL,job_exp INTEGER NOT NULL,missing_base INTEGER NOT NULL,missing_job INTEGER NOT NULL,has_data INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS compact_experience_daily(character_key TEXT NOT NULL,day TEXT NOT NULL,character_name TEXT NOT NULL,observed_deaths INTEGER NOT NULL,duration_ms INTEGER NOT NULL,base_exp INTEGER NOT NULL,job_exp INTEGER NOT NULL,missing_base INTEGER NOT NULL,missing_job INTEGER NOT NULL,has_data INTEGER NOT NULL,coverage_end_ms INTEGER,PRIMARY KEY(character_key,day));
 CREATE INDEX IF NOT EXISTS compact_experience_daily_date ON compact_experience_daily(day,character_key);
 CREATE TABLE IF NOT EXISTS compact_experience_current(character_key TEXT PRIMARY KEY,data_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS compact_experience_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
`;
export interface CompactExperienceTotals {observedDeaths:number;durationMs:number;baseExp:number;jobExp:number;missingBase:number;missingJob:number;hasData:boolean;}
export interface CompactExperienceMigrationMetrics {
 migrated:boolean;eligibleSessions:number;currentSessions:number;characters:number;dailyRows:number;
 all:CompactExperienceTotals;dated:CompactExperienceTotals;
}
export const compactAmount=(value:unknown):number=>{const n=Number(value??0);if(!Number.isSafeInteger(n)||n<0)throw new Error('EXP özeti güvenli tam sayı sınırını aşıyor.');return n;};
const add=(left:number,right:number)=>compactAmount(left+right);
const zero=():CompactExperienceTotals=>({observedDeaths:0,durationMs:0,baseExp:0,jobExp:0,missingBase:0,missingJob:0,hasData:false});
const ownSession=(s:Record<string,any>)=>s.attributionPolicy==='own-damage-v1'&&(s.mode??'single')==='single'&&!s.groupId;
const ownSql="json_extract(s.data_json,'$.attributionPolicy')='own-damage-v1' AND COALESCE(json_extract(s.data_json,'$.mode'),'single')='single' AND json_extract(s.data_json,'$.groupId') IS NULL";
const exists=(db:DatabaseSync,table:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
export function compactTotalsFromRow(row:Record<string,unknown>|undefined):CompactExperienceTotals {
 return row?{observedDeaths:compactAmount(row.observed_deaths),durationMs:compactAmount(row.duration_ms),baseExp:compactAmount(row.base_exp),jobExp:compactAmount(row.job_exp),missingBase:compactAmount(row.missing_base),missingJob:compactAmount(row.missing_job),hasData:!!row.has_data}:zero();
}
function plus(total:CompactExperienceTotals,value:CompactExperienceTotals):CompactExperienceTotals {
 return{observedDeaths:add(total.observedDeaths,value.observedDeaths),durationMs:add(total.durationMs,value.durationMs),baseExp:add(total.baseExp,value.baseExp),jobExp:add(total.jobExp,value.jobExp),missingBase:add(total.missingBase,value.missingBase),missingJob:add(total.missingJob,value.missingJob),hasData:total.hasData||value.hasData};
}
function values(t:CompactExperienceTotals){return[t.observedDeaths,t.durationMs,t.baseExp,t.jobExp,t.missingBase,t.missingJob,Number(t.hasData)];}
function putTotal(db:DatabaseSync,key:string,name:string,t:CompactExperienceTotals):void {
 db.prepare('INSERT INTO compact_experience_totals VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(character_key) DO UPDATE SET character_name=excluded.character_name,observed_deaths=excluded.observed_deaths,duration_ms=excluded.duration_ms,base_exp=excluded.base_exp,job_exp=excluded.job_exp,missing_base=excluded.missing_base,missing_job=excluded.missing_job,has_data=excluded.has_data').run(key,name,...values(t));
}
function putDay(db:DatabaseSync,key:string,name:string,day:string,t:CompactExperienceTotals,coverage:number|null):void {
 db.prepare('INSERT INTO compact_experience_daily VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(character_key,day) DO UPDATE SET character_name=excluded.character_name,observed_deaths=excluded.observed_deaths,duration_ms=excluded.duration_ms,base_exp=excluded.base_exp,job_exp=excluded.job_exp,missing_base=excluded.missing_base,missing_job=excluded.missing_job,has_data=excluded.has_data,coverage_end_ms=excluded.coverage_end_ms').run(key,day,name,...values(t),coverage);
}
export function compactExperienceEnsureCharacter(db:DatabaseSync,key:string,name:string):void {
 const t=compactTotalsFromRow(db.prepare('SELECT * FROM compact_experience_totals WHERE character_key=?').get(key));t.hasData=true;putTotal(db,key,name,t);
}
/** Called in the session transaction; only frozen totals are written, never event IDs. */
export function compactExperienceGain(db:DatabaseSync,key:string,name:string,at:number|null,base:number|null,job:number|null):void {
 const gain={...zero(),observedDeaths:1,baseExp:base===null?0:compactAmount(base),jobExp:job===null?0:compactAmount(job),missingBase:Number(base===null),missingJob:Number(job===null),hasData:true};
 putTotal(db,key,name,plus(compactTotalsFromRow(db.prepare('SELECT * FROM compact_experience_totals WHERE character_key=?').get(key)),gain));
 if(at===null)return;
 const day=killDailyDate(new Date(at)),previous=db.prepare('SELECT * FROM compact_experience_daily WHERE character_key=? AND day=?').get(key,day);
 putDay(db,key,name,day,plus(compactTotalsFromRow(previous),gain),previous?.coverage_end_ms==null?null:Number(previous.coverage_end_ms));
}
/** Half-open Istanbul days; a scalar coverage frontier avoids keeping timestamp intervals. */
export function compactExperienceDuration(db:DatabaseSync,key:string,name:string,duration:number,from:number|null,to:number|null):void {
 const total=compactTotalsFromRow(db.prepare('SELECT * FROM compact_experience_totals WHERE character_key=?').get(key));
 total.durationMs=add(total.durationMs,compactAmount(duration));total.hasData=true;putTotal(db,key,name,total);
 if(from===null||to===null||to<=from)return;
 for(let left=from;left<to;){
  const day=killDailyDate(new Date(left)),bounds=killDailyBounds(day),right=Math.min(to,bounds.endMs);
  if(!Number.isSafeInteger(left)||!Number.isSafeInteger(right)||right<=left)throw new Error('EXP günlük süre sınırı geçersiz.');
  const previous=db.prepare('SELECT * FROM compact_experience_daily WHERE character_key=? AND day=?').get(key,day),t=compactTotalsFromRow(previous);
  const frontier=previous?.coverage_end_ms==null?left:Number(previous.coverage_end_ms);
  t.durationMs=add(t.durationMs,Math.max(0,right-Math.max(left,frontier)));t.hasData=true;
  putDay(db,key,name,day,t,Math.max(frontier,right));left=right;
 }
}
function aggregate(db:DatabaseSync,table:'compact_experience_totals'|'compact_experience_daily'):CompactExperienceTotals {
 let result=zero();for(const row of db.prepare(`SELECT * FROM ${table}`).iterate())result=plus(result,compactTotalsFromRow(row));return result;
}
/** Idempotent and savepoint-safe: the caller verifies metrics before deleting legacy detail. */
export function migrateCompactExperience(db:DatabaseSync):CompactExperienceMigrationMetrics {
 db.exec(COMPACT_EXPERIENCE_SCHEMA);
 const previous=db.prepare("SELECT value FROM compact_experience_metadata WHERE key='migration-v1'").get();
 if(previous)return{...JSON.parse(String(previous.value)),migrated:false};
 db.exec('SAVEPOINT compact_experience_migration');
 try{
  let eligibleSessions=0;let expected=zero();
  if(exists(db,'kill_experience_sessions'))for(const row of db.prepare('SELECT id,character_key,data_json FROM kill_experience_sessions ORDER BY rowid').iterate()){
   const s=JSON.parse(String(row.data_json)),key=String(row.character_key),name=String(s.characterName??key);
   let frontier=Number.isSafeInteger(s.compactFrontier)&&s.compactFrontier>=0?s.compactFrontier:null;
   if(exists(db,'compact_kill_cursors')){const cursor=db.prepare('SELECT recording_key,frontier_ms FROM compact_kill_cursors WHERE character_key=?').get(key);if(cursor&&cursor.recording_key===s.recordingKey&&Number.isSafeInteger(cursor.frontier_ms)&&Number(cursor.frontier_ms)>=0)frontier=Math.max(frontier??0,Number(cursor.frontier_ms));}
   if(exists(db,'solo_experience_calendar_sessions')){
    const calendar=db.prepare('SELECT anchor_ms FROM solo_experience_calendar_sessions WHERE session_id=?').get(String(row.id));
    if(calendar?.anchor_ms!==null&&Number.isSafeInteger(calendar?.anchor_ms)){
     const edge=db.prepare('SELECT MAX(value) edge FROM (SELECT MAX(end_ms) value FROM solo_experience_calendar_intervals WHERE session_id=? UNION ALL SELECT MAX(at_ms) value FROM solo_experience_calendar_awards WHERE session_id=?)').get(String(row.id),String(row.id));
     const relative=edge?.edge==null?null:Number(edge.edge)-Number(calendar!.anchor_ms);
     if(relative!==null&&Number.isSafeInteger(relative)&&relative>=0)frontier=Math.max(frontier??0,relative);
    }
   }
   db.prepare('INSERT INTO compact_experience_current VALUES(?,?) ON CONFLICT(character_key) DO UPDATE SET data_json=excluded.data_json').run(key,JSON.stringify({...s,id:String(row.id),characterKey:key,...(frontier===null?{}:{compactFrontier:frontier})}));
   if(!ownSession(s))continue;eligibleSessions++;
   const value={observedDeaths:compactAmount(s.observedDeaths),durationMs:compactAmount(s.durationMs),baseExp:compactAmount(s.base?.knownGained),jobExp:compactAmount(s.job?.knownGained),missingBase:compactAmount(s.base?.missingDeaths),missingJob:compactAmount(s.job?.missingDeaths),hasData:true};
   expected=plus(expected,value);putTotal(db,key,name,plus(compactTotalsFromRow(db.prepare('SELECT * FROM compact_experience_totals WHERE character_key=?').get(key)),value));
  }
  let expectedDated=zero();
  if(exists(db,'solo_experience_calendar_awards'))for(const row of db.prepare(`SELECT a.*,COALESCE(json_extract(s.data_json,'$.characterName'),a.character_key) name FROM solo_experience_calendar_awards a JOIN kill_experience_sessions s ON s.id=a.session_id WHERE ${ownSql}`).iterate()){
   const timestamp=Number(row.at_ms);if(!Number.isSafeInteger(timestamp)||!Number.isFinite(new Date(timestamp).getTime()))throw new Error('EXP arşiv tarihi geçersiz.');
   const key=String(row.character_key),day=killDailyDate(new Date(timestamp)),value={...zero(),observedDeaths:1,baseExp:row.base_exp===null?0:compactAmount(row.base_exp),jobExp:row.job_exp===null?0:compactAmount(row.job_exp),missingBase:Number(row.base_exp===null),missingJob:Number(row.job_exp===null),hasData:true};
   expectedDated=plus(expectedDated,value);const old=db.prepare('SELECT * FROM compact_experience_daily WHERE character_key=? AND day=?').get(key,day);
   putDay(db,key,String(row.name),day,plus(compactTotalsFromRow(old),value),old?.coverage_end_ms==null?null:Number(old.coverage_end_ms));
  }
  // Sorted spans make the compact frontier an exact union during migration.
  if(exists(db,'solo_experience_calendar_intervals'))for(const row of db.prepare(`SELECT i.*,COALESCE(json_extract(s.data_json,'$.characterName'),i.character_key) name FROM solo_experience_calendar_intervals i JOIN kill_experience_sessions s ON s.id=i.session_id WHERE ${ownSql} ORDER BY i.character_key,i.start_ms,i.end_ms`).iterate()){
   const from=Number(row.start_ms),to=Number(row.end_ms);if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||to<from)throw new Error('EXP takip aralığı geçersiz.');
   for(let left=from;left<to;){
    const day=killDailyDate(new Date(left)),right=Math.min(to,killDailyBounds(day).endMs);if(right<=left)throw new Error('EXP günlük süre sınırı geçersiz.');
    const key=String(row.character_key),old=db.prepare('SELECT * FROM compact_experience_daily WHERE character_key=? AND day=?').get(key,day),t=compactTotalsFromRow(old),frontier=old?.coverage_end_ms==null?left:Number(old.coverage_end_ms),duration=Math.max(0,right-Math.max(left,frontier));
    t.durationMs=add(t.durationMs,duration);t.hasData=true;expectedDated.durationMs=add(expectedDated.durationMs,duration);expectedDated.hasData=true;
    putDay(db,key,String(row.name),day,t,Math.max(frontier,right));left=right;
   }
  }
  const all=aggregate(db,'compact_experience_totals'),dated=aggregate(db,'compact_experience_daily');
  if(JSON.stringify(all)!==JSON.stringify(expected)||JSON.stringify(dated)!==JSON.stringify(expectedDated))throw new Error('EXP özeti doğrulanamadı; ayrıntı kayıtları korunuyor.');
  const count=(table:string)=>Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);
  const metrics={migrated:true,eligibleSessions,currentSessions:count('compact_experience_current'),characters:count('compact_experience_totals'),dailyRows:count('compact_experience_daily'),all,dated};
  db.prepare("INSERT INTO compact_experience_metadata VALUES('migration-v1',?)").run(JSON.stringify(metrics));db.exec('RELEASE compact_experience_migration');return metrics;
 }catch(error){db.exec('ROLLBACK TO compact_experience_migration;RELEASE compact_experience_migration');throw error;}
}
