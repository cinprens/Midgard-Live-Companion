import type {DatabaseSync} from 'node:sqlite';
import type {SoloExperienceDailyState,SoloExperiencePeriodTotals} from '../src/shared/solo-experience-daily';
import type {KillExperienceTrack} from '../src/shared/kill-experience';
import {isKillDailySelectableDate,killDailyBounds,shiftKillDailyDate} from '../src/shared/kill-daily';
import {compactTotalsFromRow,migrateCompactExperience} from './compact-experience';

export const SOLO_EXPERIENCE_DAILY_SCHEMA=`
 CREATE TABLE solo_experience_calendar_sessions(session_id TEXT PRIMARY KEY REFERENCES kill_experience_sessions(id),character_key TEXT NOT NULL,character_name TEXT NOT NULL,anchor_ms REAL,raw_started_at TEXT,time_zone TEXT NOT NULL,clock_version INTEGER NOT NULL);
 CREATE TABLE solo_experience_calendar_awards(session_id TEXT NOT NULL REFERENCES kill_experience_sessions(id),event_key TEXT NOT NULL,character_key TEXT NOT NULL,at_ms REAL NOT NULL,monster_id INTEGER NOT NULL,base_exp INTEGER,job_exp INTEGER,PRIMARY KEY(session_id,event_key));
 CREATE INDEX solo_experience_calendar_award_time ON solo_experience_calendar_awards(at_ms,character_key);
 CREATE INDEX solo_experience_calendar_award_character_time ON solo_experience_calendar_awards(character_key,at_ms);
 CREATE TABLE solo_experience_calendar_intervals(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES kill_experience_sessions(id),character_key TEXT NOT NULL,start_ms REAL NOT NULL,end_ms REAL NOT NULL,CHECK(end_ms>=start_ms));
 CREATE INDEX solo_experience_calendar_interval_time ON solo_experience_calendar_intervals(start_ms,end_ms,character_key);
`;

const amount=(value:unknown):number=>{const n=Number(value??0);if(!Number.isSafeInteger(n)||n<0)throw new Error('EXP arşiv toplamı güvenli sayı aralığında değil.');return n;};
const sum=(a:number,b:number)=>amount(a+b);
const blankTrack=():KillExperienceTrack=>({gained:0,knownGained:0,perHour:null,knownPerHour:null,missingDeaths:0,lost:0,knownLost:0,net:0,knownNet:0,missingLosses:0});
const blank=():SoloExperiencePeriodTotals=>({observedDeaths:0,durationMs:0,hasData:false,base:blankTrack(),job:blankTrack()});
const ownSession="json_extract(s.data_json,'$.attributionPolicy')='own-damage-v1' AND COALESCE(json_extract(s.data_json,'$.mode'),'single')='single' AND json_extract(s.data_json,'$.groupId') IS NULL";
function finalize(t:SoloExperiencePeriodTotals):SoloExperiencePeriodTotals {
 for(const track of [t.base,t.job]){
  track.gained=track.missingDeaths?null:track.knownGained;track.net=track.gained;track.knownNet=track.knownGained;
  const hourly=t.durationMs>0?track.knownGained/t.durationMs*3600000:null;
  track.knownPerHour=hourly!==null&&Number.isFinite(hourly)&&hourly<=Number.MAX_SAFE_INTEGER?hourly:null;
  track.perHour=track.gained===null?null:track.knownPerHour;
 }
 return t;
}
function combine(values:SoloExperiencePeriodTotals[]):SoloExperiencePeriodTotals {
 const out=blank();for(const value of values){out.hasData ||=value.hasData;out.observedDeaths=sum(out.observedDeaths,value.observedDeaths);out.durationMs=sum(out.durationMs,value.durationMs);for(const kind of ['base','job'] as const){out[kind].knownGained=sum(out[kind].knownGained,value[kind].knownGained);out[kind].missingDeaths=sum(out[kind].missingDeaths,value[kind].missingDeaths);}}return finalize(out);
}
function union(spans:[number,number][]):number {
 spans.sort((a,b)=>a[0]-b[0]);let result=0,end=-Infinity;for(const [start,right]of spans){if(right>Math.max(end,start))result=sum(result,right-Math.max(end,start));end=Math.max(end,right);}return result;
}

/** Frozen awarded amounts, not current monster rates; undated history stays undated. */
export class SoloExperienceDailyStore {
 constructor(private db:DatabaseSync,private options:{summaryOnly?:boolean}={}){if(options.summaryOnly)migrateCompactExperience(db);}
 read(value:unknown):SoloExperienceDailyState {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['date','scopeMode','characterKey'].includes(k)))throw new Error('EXP günlüğü sorgusu geçersiz.');
  const query=value as Record<string,unknown>,date=query.date,mode=query.scopeMode??'daily',characterKey=query.characterKey??null;
  if(!isKillDailySelectableDate(date)||!['all','daily'].includes(String(mode))||characterKey!==null&&(typeof characterKey!=='string'||!characterKey.length||characterKey.length>2048||/[\u0000-\u001f\u007f]/.test(characterKey)))throw new Error('EXP günlüğü tarihi veya karakteri geçersiz.');
  if(this.options.summaryOnly)return this.readCompact(date,mode as 'all'|'daily',characterKey as string|null);
  const names=new Map<string,string>(),archive=new Map<string,SoloExperiencePeriodTotals>();
  for(const row of this.db.prepare('SELECT character_key,data_json FROM kill_experience_sessions ORDER BY rowid').all()){
   const session=JSON.parse(String(row.data_json));if((session.mode??'single')!=='single'||session.groupId)continue;
   const key=String(row.character_key);names.set(key,String(session.characterName??key));
   if(session.attributionPolicy!=='own-damage-v1')continue;
   const t=archive.get(key)??blank();t.hasData=true;t.observedDeaths=sum(t.observedDeaths,amount(session.observedDeaths));t.durationMs=sum(t.durationMs,amount(session.durationMs));
   for(const kind of ['base','job']as const){t[kind].knownGained=sum(t[kind].knownGained,amount(session[kind]?.knownGained));t[kind].missingDeaths=sum(t[kind].missingDeaths,amount(session[kind]?.missingDeaths));}archive.set(key,t);
  }
  for(const row of this.db.prepare('SELECT character_key,character_name FROM solo_experience_calendar_sessions').all())names.set(String(row.character_key),String(row.character_name));
  const dates=Array.from({length:7},(_,i)=>shiftKillDailyDate(date,i-6)),bounds=dates.map(killDailyBounds),first=bounds[0].startMs,last=bounds[6].endMs;
  const byDay=dates.map(()=>new Map<string,SoloExperiencePeriodTotals>()),spans=dates.map(()=>new Map<string,[number,number][]>());
  const bucket=(index:number,key:string)=>{let t=byDay[index].get(key);if(!t){t=blank();byDay[index].set(key,t);}return t;};
  // Each day is a half-open Istanbul interval; midnight belongs only to the new day.
  for(let index=0;index<7;index++){
   const b=bounds[index];
   const rows=this.db.prepare(`SELECT a.character_key,COUNT(*) deaths,SUM(COALESCE(a.base_exp,0)) base,SUM(COALESCE(a.job_exp,0)) job,SUM(a.base_exp IS NULL) missing_base,SUM(a.job_exp IS NULL) missing_job FROM solo_experience_calendar_awards a JOIN kill_experience_sessions s ON s.id=a.session_id WHERE a.at_ms>=? AND a.at_ms<? AND ${ownSession} GROUP BY a.character_key`).all(b.startMs,b.endMs);
   for(const row of rows){const key=String(row.character_key),t=bucket(index,key);t.hasData=true;t.observedDeaths=amount(row.deaths);t.base.knownGained=amount(row.base);t.job.knownGained=amount(row.job);t.base.missingDeaths=amount(row.missing_base);t.job.missingDeaths=amount(row.missing_job);}
  }
  const intervals=this.db.prepare(`SELECT i.character_key,i.start_ms,i.end_ms FROM solo_experience_calendar_intervals i JOIN kill_experience_sessions s ON s.id=i.session_id WHERE i.start_ms<? AND i.end_ms>? AND i.end_ms>i.start_ms AND ${ownSession}`).all(last,first);
  for(const row of intervals){const key=String(row.character_key),left=Number(row.start_ms),right=Number(row.end_ms);if(!Number.isSafeInteger(left)||!Number.isSafeInteger(right))throw new Error('EXP takip aralığı geçersiz.');for(let i=0;i<7;i++){const start=Math.max(left,bounds[i].startMs),end=Math.min(right,bounds[i].endMs);if(end<=start)continue;bucket(i,key).hasData=true;const list=spans[i].get(key)??[];list.push([start,end]);spans[i].set(key,list);}}
  for(let i=0;i<7;i++)for(const [key,t]of byDay[i]){t.durationMs=union(spans[i].get(key)??[]);finalize(t);}
  const selected=mode==='all'?archive:byDay[6];
  const characters=[...names].map(([key,name])=>({characterKey:key,characterName:name,totals:finalize(selected.get(key)??blank())}));
  const selectedTotals=[...selected].filter(([key])=>characterKey===null||key===characterKey).map(([,t])=>t);
  const dated=new Map(this.db.prepare(`SELECT a.character_key,COUNT(*) n FROM solo_experience_calendar_awards a JOIN kill_experience_sessions s ON s.id=a.session_id WHERE ${ownSession} GROUP BY a.character_key`).all().map(row=>[String(row.character_key),amount(row.n)]));
  let undatedObservedDeaths=0;for(const [key,t]of archive)if(characterKey===null||key===characterKey)undatedObservedDeaths=sum(undatedObservedDeaths,Math.max(0,t.observedDeaths-(dated.get(key)??0)));
  return{date,scopeMode:mode as 'all'|'daily',timeZone:'Europe/Istanbul',characters,totals:combine(selectedTotals),days:dates.map((day,index)=>({date:day,...combine([...byDay[index]].filter(([key])=>characterKey===null||key===characterKey).map(([,t])=>t))})),undatedObservedDeaths,
   notice:'Kendi hasarına göre tahmini solo kazanım; kesin kişisel kesim değildir. Yalnız kendi hasarı görülen hedef ölümleri sayılır. Eski çevre gözlemleri arşivde korunur, bu toplamlara eklenmez. Günler İstanbul takvimine ayrılır. Çoklu karakterde saatlik hesap karakterlerin takip süreleri toplamını kullanır; party hesabı değildir.'};
 }
 private readCompact(date:string,mode:'all'|'daily',characterKey:string|null):SoloExperienceDailyState {
  const names=new Map<string,string>(),archive=new Map<string,SoloExperiencePeriodTotals>();
  const period=(row:Record<string,unknown>)=>{const value=compactTotalsFromRow(row),result=blank();result.hasData=value.hasData;result.observedDeaths=value.observedDeaths;result.durationMs=value.durationMs;result.base.knownGained=value.baseExp;result.job.knownGained=value.jobExp;result.base.missingDeaths=value.missingBase;result.job.missingDeaths=value.missingJob;return finalize(result);};
  for(const row of this.db.prepare('SELECT * FROM compact_experience_totals').all()){const key=String(row.character_key);names.set(key,String(row.character_name));archive.set(key,period(row));}
  for(const row of this.db.prepare('SELECT character_key,data_json FROM compact_experience_current').all()){const s=JSON.parse(String(row.data_json));names.set(String(row.character_key),String(s.characterName??row.character_key));}
  const dates=Array.from({length:7},(_,index)=>shiftKillDailyDate(date,index-6)),byDay=dates.map(()=>new Map<string,SoloExperiencePeriodTotals>());
  for(const row of this.db.prepare('SELECT * FROM compact_experience_daily WHERE day>=? AND day<=?').all(dates[0],date)){const index=dates.indexOf(String(row.day));if(index>=0)byDay[index].set(String(row.character_key),period(row));}
  const selected=mode==='all'?archive:byDay[6],selectedTotals=[...selected].filter(([key])=>characterKey===null||key===characterKey).map(([,t])=>t);
  const dated=new Map(this.db.prepare('SELECT character_key,SUM(observed_deaths) n FROM compact_experience_daily GROUP BY character_key').all().map(row=>[String(row.character_key),amount(row.n)]));
  let undatedObservedDeaths=0;for(const[key,t]of archive)if(characterKey===null||key===characterKey)undatedObservedDeaths=sum(undatedObservedDeaths,Math.max(0,t.observedDeaths-(dated.get(key)??0)));
  return{date,scopeMode:mode,timeZone:'Europe/Istanbul',characters:[...names].map(([key,name])=>({characterKey:key,characterName:name,totals:selected.get(key)??blank()})),totals:combine(selectedTotals),days:dates.map((day,index)=>({date:day,...combine([...byDay[index]].filter(([key])=>characterKey===null||key===characterKey).map(([,t])=>t))})),undatedObservedDeaths,notice:'Kendi hasarına göre tahmini solo kazanım; kesin kişisel kesim değildir. Günlük EXP değerleri kazanım anındaki ayarlarla korunur. Eski çevre gözlemleri bu toplamlara eklenmez. Günler İstanbul takvimine ayrılır; olay ayrıntıları saklanmaz.'};
 }
}
