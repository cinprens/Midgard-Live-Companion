import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {isConfirmedMonsterDeath,isOwnDamageKill,type ParsedReplay,type ReplayEvent} from '../src/parser';
import type {CharacterIdentity,LiveStreamStatus} from '../src/shared/types';
import type {KillCountState,KillCountStatus,KillCountTimeBasis,KillCountTotals,KillCountMonster} from '../src/shared/kill-count';
import {isKillDailySelectableDate,killDailyDate,killDailyBounds,shiftKillDailyDate,type KillDailyState} from '../src/shared/kill-daily';
import {replayClockBasis} from '../src/shared/replay-clock-basis';
import {ownDamageEventSql} from './own-damage-query';
import {referenceGameNames} from './reference-game-names';

export const COMPACT_KILL_SCHEMA=`
 CREATE TABLE IF NOT EXISTS compact_kill_characters(character_key TEXT PRIMARY KEY,character_name TEXT NOT NULL,status TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS compact_kill_totals(character_key TEXT NOT NULL,date TEXT NOT NULL,monster_id INTEGER NOT NULL,count INTEGER NOT NULL CHECK(count>=0),monster_name TEXT,PRIMARY KEY(character_key,date,monster_id));
 CREATE INDEX IF NOT EXISTS compact_kill_total_date ON compact_kill_totals(date,character_key);
 CREATE TABLE IF NOT EXISTS compact_kill_days(character_key TEXT NOT NULL,date TEXT NOT NULL,duration_ms REAL NOT NULL CHECK(duration_ms>=0),PRIMARY KEY(character_key,date));
 CREATE TABLE IF NOT EXISTS compact_kill_cursors(character_key TEXT PRIMARY KEY,recording_key TEXT NOT NULL,frontier_ms REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS compact_kill_clocks(character_key TEXT PRIMARY KEY,watermark_ms REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS compact_kill_metadata(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
`;
type Row=Record<string,unknown>;
type Span=[number,number];
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const sourceKey=(value:string)=>hash(path.resolve(value).toLowerCase());
const status=(value:LiveStreamStatus):KillCountStatus=>value==='paused'?'paused':value==='stopped'?'stopped':value==='missing'?'missing':value==='error'?'unavailable':'tracking';
const validTime=(value:number)=>Number.isSafeInteger(value)&&Number.isFinite(new Date(value).getTime());
const dayAt=(value:number)=>validTime(value)?killDailyDate(new Date(value)):'';
function merge(spans:Span[]):Span[]{
 const result:Span[]=[];
 for(const [start,end]of spans.filter(([a,b])=>validTime(a)&&validTime(b)&&b>a).sort((a,b)=>a[0]-b[0])){
  const last=result.at(-1);if(last&&start<=last[1])last[1]=Math.max(last[1],end);else result.push([start,end]);
 }
 return result;
}
function splitDays(start:number,end:number,visit:(date:string,duration:number)=>void):void{
 let cursor=start,steps=0;
 while(cursor<end){if(++steps>10000)throw new Error('Kesim süresi takvim sınırını aşıyor; özet dönüşümü durduruldu.');const date=dayAt(cursor);if(!date)throw new Error('Kesim süresi geçersiz bir takvim değeri içeriyor.');const right=Math.min(end,killDailyBounds(date).endMs);if(right<=cursor)throw new Error('Kesim takvim sınırı ilerlemiyor.');visit(date,right-cursor);cursor=right;}
}
function hasTable(db:DatabaseSync,name:string):boolean{return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);}
export interface CompactKillMigrationMetrics {sourceAccepted:number;totalAccepted:number;datedAccepted:number;undatedAccepted:number;characters:number;dayRows:number;legacyOwnTotal:number|null;durationMs:number;}
/** Called inside the owning schema migration transaction. No source archive row is modified. */
export function migrateCompactKills(db:DatabaseSync):CompactKillMigrationMetrics{
 db.exec(COMPACT_KILL_SCHEMA);
 const metrics=():CompactKillMigrationMetrics=>{
  const row=db.prepare("SELECT COALESCE(SUM(count),0) total,COALESCE(SUM(CASE WHEN date='' THEN count ELSE 0 END),0) undated FROM compact_kill_totals").get()!;
  const source=Number(db.prepare("SELECT value FROM compact_kill_metadata WHERE key='migration_source_count'").get()?.value??0);
  return{sourceAccepted:source,totalAccepted:Number(row.total),datedAccepted:Number(row.total)-Number(row.undated),undatedAccepted:Number(row.undated),characters:Number(db.prepare('SELECT COUNT(*) n FROM compact_kill_characters').get()!.n),dayRows:Number(db.prepare('SELECT COUNT(*) n FROM compact_kill_totals').get()!.n),legacyOwnTotal:hasTable(db,'kill_own_damage_totals')?Number(db.prepare('SELECT COALESCE(SUM(observed),0) n FROM kill_own_damage_totals').get()!.n):null,durationMs:Number(db.prepare("SELECT duration_ms FROM compact_kill_days WHERE character_key='' AND date='*'").get()?.duration_ms??0)};
 };
 if(db.prepare("SELECT 1 FROM compact_kill_metadata WHERE key='migrated'").get())return metrics();
 let sourceAccepted=0;
 if(hasTable(db,'kill_count_sessions')){
  const sessions=db.prepare('SELECT rowid sequence,* FROM kill_count_sessions ORDER BY rowid').all();
  const saveCharacter=db.prepare("INSERT INTO compact_kill_characters VALUES(?,?,'stopped') ON CONFLICT(character_key) DO UPDATE SET character_name=excluded.character_name");
  const saveCursor=db.prepare('INSERT INTO compact_kill_cursors VALUES(?,?,?) ON CONFLICT(character_key) DO UPDATE SET recording_key=excluded.recording_key,frontier_ms=excluded.frontier_ms');
  for(const session of sessions){
   saveCharacter.run(String(session.character_key),String(session.character_name));
   const eventEdge=hasTable(db,'kill_count_events')?Number(db.prepare('SELECT COALESCE(MAX(event_ms),0) n FROM kill_count_events WHERE session_id=?').get(String(session.id))!.n):0;
   const intervalEdge=hasTable(db,'kill_count_intervals')?Number(db.prepare('SELECT COALESCE(MAX(end_ms),?) n FROM kill_count_intervals WHERE session_id=?').get(Number(session.anchor_ms),String(session.id))!.n)-Number(session.anchor_ms):0;
   saveCursor.run(String(session.character_key),String(session.recording_key),Math.max(0,eventEdge,intervalEdge));
  }
  if(hasTable(db,'kill_count_events')){
   const grouped=new Map<string,{character:string;date:string;monster:number;count:number;name:string|null}>();
   for(const row of db.prepare(`SELECT s.character_key,s.time_basis,s.anchor_ms,e.monster_id,e.monster_name,e.event_ms FROM kill_count_events e JOIN kill_count_sessions s ON s.id=e.session_id WHERE ${ownDamageEventSql('e')}`).iterate()){
    const time=Number(row.anchor_ms)+Number(row.event_ms),date=row.time_basis==='replay-start'&&Number(row.event_ms)>=0?dayAt(time):'';
    const character=String(row.character_key),monster=Number(row.monster_id),key=JSON.stringify([character,date,monster]),value=grouped.get(key)??{character,date,monster,count:0,name:null};
    value.count++;if(row.monster_name!==null)value.name=String(row.monster_name);grouped.set(key,value);sourceAccepted++;
   }
   const insert=db.prepare('INSERT INTO compact_kill_totals VALUES(?,?,?,?,?) ON CONFLICT(character_key,date,monster_id) DO UPDATE SET count=count+excluded.count,monster_name=COALESCE(excluded.monster_name,monster_name)');
   for(const value of grouped.values())insert.run(value.character,value.date,value.monster,value.count,value.name);
  }
  if(hasTable(db,'kill_count_intervals')){
   const groups=new Map<string,{all:Span[];dated:Span[]}>();
   for(const row of db.prepare('SELECT s.character_key,s.time_basis,i.start_ms,i.end_ms FROM kill_count_intervals i JOIN kill_count_sessions s ON s.id=i.session_id').iterate()){
    const a=Number(row.start_ms),b=Number(row.end_ms);if(!validTime(a)||!validTime(b)||b<a)throw new Error('Kesim takip aralığı geçersiz; özet dönüşümü durduruldu.');if(b===a)continue;
    for(const key of [String(row.character_key),'']){const value=groups.get(key)??{all:[],dated:[]};value.all.push([a,b]);if(row.time_basis==='replay-start')value.dated.push([a,b]);groups.set(key,value);}
   }
   const saveDay=db.prepare('INSERT INTO compact_kill_days VALUES(?,?,?) ON CONFLICT(character_key,date) DO UPDATE SET duration_ms=duration_ms+excluded.duration_ms');
   for(const [character,value]of groups){
    const all=merge(value.all);saveDay.run(character,'*',all.reduce((sum,[a,b])=>sum+b-a,0));
    for(const [a,b]of merge(value.dated))splitDays(a,b,(date,duration)=>saveDay.run(character,date,duration));
    if(all.length)db.prepare('INSERT INTO compact_kill_clocks VALUES(?,?) ON CONFLICT(character_key) DO UPDATE SET watermark_ms=MAX(watermark_ms,excluded.watermark_ms)').run(character,all.at(-1)![1]);
   }
  }
 }
 db.prepare("INSERT INTO compact_kill_metadata VALUES('migration_source_count',?)").run(sourceAccepted);
 const result=metrics();if(result.totalAccepted!==sourceAccepted||result.legacyOwnTotal!==null&&result.legacyOwnTotal!==sourceAccepted)throw new Error('Kesim özet dönüşümü toplamı doğrulanamadı.');
 db.prepare("INSERT INTO compact_kill_metadata VALUES('migrated',1)").run();return result;
}

export interface CompactKillObservation {sourcePath:string;streamId:string;hash:string;recordingId:string;recordingReset?:boolean;observedAt?:string;initial?:boolean;}
interface Recording {frontier:number;keys:Set<string>;saturated:boolean;character:string;anchor:number;dated:boolean;}
interface Recent {recording:string;character:string;date:string;monster:number;name:string|null;timestamp:number;accepted:boolean;conflict:boolean;}
const MAX_SOURCES=256,MAX_FRONTIER=1024,MAX_RECENT=4096;
const keyOf=(recording:string,event:ReplayEvent)=>hash(JSON.stringify([recording,event.timestamp,event.targetId,event.monsterId]));
function totals(count:number,duration:number,types:number,basis:KillCountTimeBasis):KillCountTotals{return{totalKills:null,confirmedPersonalKills:0,observedDeaths:count,unknownDeaths:count,killsPerHour:null,knownKillsPerHour:count>0&&duration>0?0:null,durationMs:duration,monsterTypes:types,uncertain:count>0,range:{min:0,max:count},timeBasis:basis};}
function projectMonsters(rows:Row[],duration:number,basis:KillCountTimeBasis,names:Map<number,string>):KillCountMonster[]{
 const groups=new Map<number,{count:number;name:string|null}>();for(const row of rows){const id=Number(row.monster_id),value=groups.get(id)??{count:0,name:null};value.count+=Number(row.count);if(row.monster_name!==null)value.name=String(row.monster_name);groups.set(id,value);}
 return[...groups].sort(([a],[b])=>a-b).map(([monsterId,value])=>({monsterId,monsterName:names.get(monsterId)??value.name??referenceGameNames.monsters.get(monsterId)??`Canavar #${monsterId}`,lastKilledAt:null,totals:totals(value.count,duration,1,basis)}));
}

/** Keeps day/type totals and a bounded, volatile window for duplicate/conflicting proof. */
export class CompactKillStore {
 private sources=new Map<string,{recording:string;character:string}>();
 private recordings=new Map<string,Recording>();
 private recent=new Map<string,Recent>();
 private names=new Map<number,string>();
 private cache?:KillCountState;
 private revision:number;
 constructor(private db:DatabaseSync){this.db.prepare("UPDATE compact_kill_characters SET status='stopped' WHERE status='tracking'").run();this.revision=Number(this.db.prepare("SELECT value FROM compact_kill_metadata WHERE key='revision'").get()?.value??0);}
 private transaction(action:()=>void):void{this.db.exec('BEGIN IMMEDIATE');try{action();this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
 private changed():void{this.revision++;this.cache=undefined;this.db.prepare("INSERT INTO compact_kill_metadata VALUES('revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.revision);}
 setLocalMonsterNames(names:Map<number,string>):void{this.names=new Map(names);this.revision++;this.cache=undefined;}
 invalidate():void{this.cache=undefined;}
 private forgetSource(key:string):void{const source=this.sources.get(key);this.sources.delete(key);if(source&&![...this.sources.values()].some(value=>value.recording===source.recording)){this.recordings.delete(source.recording);for(const [id,value]of this.recent)if(value.recording===source.recording)this.recent.delete(id);}}
 private adjust(value:Recent,amount:1|-1):void{
  if(amount===1)this.db.prepare('INSERT INTO compact_kill_totals VALUES(?,?,?,?,?) ON CONFLICT(character_key,date,monster_id) DO UPDATE SET count=count+1,monster_name=COALESCE(excluded.monster_name,monster_name)').run(value.character,value.date,value.monster,1,value.name);
  else this.db.prepare('UPDATE compact_kill_totals SET count=MAX(0,count-1) WHERE character_key=? AND date=? AND monster_id=?').run(value.character,value.date,value.monster);
 }
 private cover(character:string,start:number,end:number,dated:boolean):void{
  if(!validTime(start)||!validTime(end)||end<=start)return;
  const previous=this.db.prepare('SELECT watermark_ms FROM compact_kill_clocks WHERE character_key=?').get(character);
  const from=Math.max(start,previous?Number(previous.watermark_ms):start);
  this.db.prepare('INSERT INTO compact_kill_clocks VALUES(?,?) ON CONFLICT(character_key) DO UPDATE SET watermark_ms=MAX(watermark_ms,excluded.watermark_ms)').run(character,end);
  if(end<=from)return;
  const insert=this.db.prepare('INSERT INTO compact_kill_days VALUES(?,?,?) ON CONFLICT(character_key,date) DO UPDATE SET duration_ms=duration_ms+excluded.duration_ms');
  insert.run(character,'*',end-from);if(dated)splitDays(from,end,(date,duration)=>insert.run(character,date,duration));
 }
 observe(parsed:ParsedReplay,meta:CompactKillObservation,character:CharacterIdentity):void{
  if(['invalid','unsupported'].includes(parsed.status))return;
  const source=sourceKey(meta.sourcePath),strong=parsed.summary.startedAt!==null&&parsed.summary.playerId!==null&&parsed.summary.characterName!==null;
  const recording=hash(strong?JSON.stringify([parsed.summary.startedAt,parsed.summary.playerId,parsed.summary.characterName]):`${source}:${meta.recordingId}`);
  let edge=Number.isSafeInteger(parsed.summary.durationMs)?Math.max(0,parsed.summary.durationMs):0;
  for(const event of parsed.events)if(Number.isSafeInteger(event.timestamp)&&event.timestamp>=0)edge=Math.max(edge,event.timestamp);
  const previousSource=this.sources.get(source),old=this.recordings.get(recording),basis=replayClockBasis(parsed.summary.startedAt);
  const saved=!old&&!meta.recordingReset?this.db.prepare('SELECT recording_key,frontier_ms FROM compact_kill_cursors WHERE character_key=?').get(character.key):undefined;
  const baseline=meta.initial===true||meta.recordingReset===true||!previousSource||previousSource.recording!==recording||!old||old.character!==character.key;
  const now=Date.parse(meta.observedAt??new Date().toISOString()),state:Recording=old&&!meta.recordingReset&&old.character===character.key?{...old,keys:new Set(old.keys)}:{frontier:Math.max(edge,saved?.recording_key===recording?Number(saved.frontier_ms):0),keys:new Set(),saturated:!!saved&&saved.recording_key===recording,character:character.key,anchor:basis.anchorMs??(Number.isFinite(now)?now:Date.now())-edge,dated:basis.anchorMs!==null};
  const prior=state.frontier;
  const acceptNew=!baseline&&edge>=prior;
  const events=parsed.events.filter(event=>Number.isSafeInteger(event.timestamp)&&event.timestamp>=0&&isConfirmedMonsterDeath(event));
  const staged=new Map<string,Recent>();
  this.transaction(()=>{
   this.db.prepare("INSERT INTO compact_kill_characters VALUES(?,?,'tracking') ON CONFLICT(character_key) DO UPDATE SET character_name=excluded.character_name,status=excluded.status").run(character.key,character.name);
   if(!meta.recordingReset){
    for(const event of events){
     const key=keyOf(recording,event),previous=staged.get(key)??this.recent.get(key),known=previous?{...previous}:undefined,proof=event.rawData?.killProof as Row|undefined,attackers=event.rawData?.attackers;
     const conflict=proof?.ownership==='observed-other-attacker-estimate'||Number.isSafeInteger(parsed.summary.playerId)&&parsed.summary.playerId!==null&&parsed.summary.playerId>0&&Array.isArray(attackers)&&attackers.some(value=>Number.isSafeInteger(value)&&value>0&&value!==parsed.summary.playerId);
     const own=isOwnDamageKill(event,parsed.summary.playerId);
     if(known){
      if(conflict){known.conflict=true;if(known.accepted){this.adjust(known,-1);known.accepted=false;}}
      else if(acceptNew&&own&&!known.accepted&&!known.conflict){this.adjust(known,1);known.accepted=true;}
      staged.set(key,known);
      continue;
     }
     if(!acceptNew||event.timestamp<prior||event.timestamp===prior&&(state.saturated||state.keys.has(key)))continue;
     const value:Recent={recording,character:character.key,date:state.dated?dayAt(state.anchor+event.timestamp):'',monster:event.monsterId!,name:this.names.get(event.monsterId!)??event.monsterName??null,timestamp:event.timestamp,accepted:own&&!conflict,conflict};
     if(value.accepted)this.adjust(value,1);staged.set(key,value);
    }
    if(acceptNew&&edge>prior)for(const key of [character.key,''])this.cover(key,state.anchor+prior,state.anchor+edge,state.dated);
   }
   if(edge>state.frontier||meta.recordingReset){state.keys.clear();state.saturated=false;}
   state.frontier=Math.max(state.frontier,edge);
   for(const event of events)if(event.timestamp===state.frontier){if(state.keys.size<MAX_FRONTIER)state.keys.add(keyOf(recording,event));else state.saturated=true;}
   this.db.prepare('INSERT INTO compact_kill_cursors VALUES(?,?,?) ON CONFLICT(character_key) DO UPDATE SET recording_key=excluded.recording_key,frontier_ms=excluded.frontier_ms').run(character.key,recording,state.frontier);
   this.changed();
  });
  if(meta.recordingReset)for(const[id,value]of this.recent)if(value.recording===recording)this.recent.delete(id);
  for(const[id,value]of staged)this.recent.set(id,value);
  if(previousSource&&previousSource.recording!==recording)this.forgetSource(source);
  this.sources.delete(source);this.sources.set(source,{recording,character:character.key});this.recordings.set(recording,state);
  while(this.sources.size>MAX_SOURCES)this.forgetSource(this.sources.keys().next().value!);
  for(const[id,value]of this.recent)if(value.recording===recording&&state.frontier-value.timestamp>60000)this.recent.delete(id);
  while(this.recent.size>MAX_RECENT)this.recent.delete(this.recent.keys().next().value!);
 }
 suspend(sourcePath:string,value:KillCountStatus='paused'):void{
  const key=sourceKey(sourcePath),source=this.sources.get(key);if(!source)return;this.forgetSource(key);
  this.transaction(()=>{this.db.prepare('UPDATE compact_kill_characters SET status=? WHERE character_key=?').run([...this.sources.values()].some(row=>row.character===source.character)?'tracking':value,source.character);this.changed();});
 }
 syncStatuses(streams:{sourcePath:string;status:LiveStreamStatus;character?:CharacterIdentity}[]):void{
  const keys=new Set(streams.map(value=>sourceKey(value.sourcePath)));
  for(const stream of streams)if(['paused','stopped','missing','error'].includes(stream.status))this.suspend(stream.sourcePath,status(stream.status));
  for(const[key,value]of [...this.sources])if(!keys.has(key)){this.forgetSource(key);this.transaction(()=>{this.db.prepare('UPDATE compact_kill_characters SET status=? WHERE character_key=?').run([...this.sources.values()].some(row=>row.character===value.character)?'tracking':'stopped',value.character);this.changed();});}
 }
 snapshot():KillCountState{
  if(this.cache)return this.cache;
  const rows=this.db.prepare('SELECT * FROM compact_kill_totals WHERE count>0').all(),characters=this.db.prepare('SELECT * FROM compact_kill_characters ORDER BY character_key').all();
  const duration=(key:string)=>Number(this.db.prepare("SELECT duration_ms FROM compact_kill_days WHERE character_key=? AND date='*'").get(key)?.duration_ms??0);
  const basis=(selected:Row[]):KillCountTimeBasis=>selected.some(row=>row.date==='')?(selected.some(row=>row.date!=='')?'mixed':'observation-anchor'):'replay-start';
  const count=(selected:Row[])=>selected.reduce((sum,row)=>sum+Number(row.count),0),globalDuration=duration(''),globalBasis=basis(rows),monsters=projectMonsters(rows,globalDuration,globalBasis,this.names);
  const projected=characters.map(row=>{const key=String(row.character_key),own=rows.filter(value=>value.character_key===key),ownDuration=duration(key),ownBasis=basis(own),monsters=projectMonsters(own,ownDuration,ownBasis,this.names);return{characterKey:key,characterName:String(row.character_name),sessionId:null,status:row.status as KillCountStatus,available:true,monsters,totals:totals(count(own),ownDuration,monsters.length,ownBasis)};});
  return this.cache={countBasis:'own-damage',revision:this.revision,status:projected.some(row=>row.status==='tracking')?'tracking':projected.at(-1)?.status??'waiting',characters:projected,monsters,totals:totals(count(rows),globalDuration,monsters.length,globalBasis),notice:'Yalnız kendi hasarına göre tahmini kesimlerin karakter, gün ve yaratık toplamları saklanır. Tek tek kesim saati ve olay geçmişi saklanmaz.'};
 }
 close():void{this.sources.clear();this.recordings.clear();this.recent.clear();this.cache=undefined;}
}

export class CompactKillDailyStore {
 private names=new Map<number,string>();
 setLocalMonsterNames(names:Map<number,string>):void{this.names=new Map(names);}
 constructor(private db:DatabaseSync){}
 read(value:unknown):KillDailyState{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['date','characterKey'].includes(key)))throw new Error('Günlük av sorgusu geçersiz.');
  const input=value as {date:unknown;characterKey?:unknown};if(!isKillDailySelectableDate(input.date))throw new Error('Günlük av tarihi geçersiz.');
  const key=input.characterKey??null;if(key!==null&&(typeof key!=='string'||!key.length||key.length>512||/[\u0000-\u001f\u007f]/.test(key)))throw new Error('Karakter seçimi geçersiz.');
  const date=input.date,days=Array.from({length:7},(_,n)=>({date:shiftKillDailyDate(date,n-6),observedDeaths:0}));
  const rows=this.db.prepare(`SELECT * FROM compact_kill_totals WHERE date>=? AND date<=? AND count>0 ${key!==null?'AND character_key=?':''}`).all(days[0].date,date,...(key!==null?[key]:[]));
  for(const row of rows){const day=days.find(value=>value.date===row.date);if(day)day.observedDeaths+=Number(row.count);}
  const selected=rows.filter(row=>row.date===date),duration=Number(this.db.prepare('SELECT duration_ms FROM compact_kill_days WHERE character_key=? AND date=?').get(key??'',date)?.duration_ms??0),monsters=projectMonsters(selected,duration,'replay-start',this.names);
  const undated=Number(this.db.prepare(`SELECT COALESCE(SUM(count),0) n FROM compact_kill_totals WHERE date='' ${key!==null?'AND character_key=?':''}`).get(...(key!==null?[key]:[]))!.n);
  return{countBasis:'own-damage',date,timeZone:'Europe/Istanbul',days,totals:totals(selected.reduce((sum,row)=>sum+Number(row.count),0),duration,monsters.length,'replay-start'),monsters,undatedDeaths:undated,notice:'Türkiye saatine göre günlük kendi hasarına dayalı tahmini kesim toplamları. Tarihi bilinmeyen toplamlar yalnız Tümü görünümünde korunur.'};
 }
}
