import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import type {KillCountMonster,KillCountTotals} from '../src/shared/kill-count';
import {isKillDailySelectableDate,KILL_DAILY_TIME_ZONE,killDailyBounds,shiftKillDailyDate,type KillDailyState} from '../src/shared/kill-daily';
import {unionFarmMilliseconds} from './auto-farm-store';
import {ownDamageEventSql} from './own-damage-query';

type Row=Record<string,unknown>;
type Span={recordingKey:string;start:number;end:number};
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const knownClock="s.time_basis='replay-start' AND typeof(s.anchor_ms) IN ('integer','real') AND ABS(s.anchor_ms)<=8640000000000000";

/** Read-only calendar projections: processing timestamps never establish an actual hunt date. */
export class KillDailyStore {
  constructor(private db:DatabaseSync,private options:{ownDamageOnly?:boolean}={}){}
  read(value:unknown):KillDailyState {
    if(!plain(value)||Object.keys(value).some(key=>!['date','characterKey'].includes(key))||!isKillDailySelectableDate(value.date))throw new Error('Günlük av sorgusu veya tarihi geçersiz.');
    const characterKey=value.characterKey??null;
    if(characterKey!==null&&(typeof characterKey!=='string'||characterKey.length<1||characterKey.length>512||/[\u0000-\u001f\u007f]/.test(characterKey)))throw new Error('Karakter seçimi geçersiz.');
    const date=value.date,days=Array.from({length:7},(_,index)=>({date:shiftKillDailyDate(date,index-6),observedDeaths:0}));
    const bounds=days.map(day=>killDailyBounds(day.date)),first=bounds[0].startMs,last=bounds[6].endMs;
    const args:SQLInputValue[]=[],cases=bounds.slice(0,-1).map((bound,index)=>{args.push(bound.endMs);return`WHEN s.anchor_ms+e.event_ms<? THEN ${index}`;}).join(' ');
    args.push(first,last);if(characterKey)args.push(characterKey);
    // Keep sessions outermost so SQLite can use the existing (session_id,event_ms) range index.
    const rows=this.db.prepare(`SELECT CASE ${cases} ELSE 6 END day,s.recording_key,e.monster_id,COUNT(*) observed,${this.options.ownDamageOnly?'0':'SUM(CASE WHEN e.personal=1 THEN 1 ELSE 0 END)'} personal,MAX(s.anchor_ms+e.event_ms) last_ms,COALESCE((SELECT name FROM monster_database m WHERE m.monster_id=e.monster_id ORDER BY m.rowid DESC LIMIT 1),MAX(e.monster_name)) name FROM kill_count_sessions s CROSS JOIN kill_count_events e ON e.session_id=s.id WHERE ${knownClock} ${this.options.ownDamageOnly?`AND ${ownDamageEventSql('e')}`:''} AND e.event_ms>=0 AND e.event_ms>=?-s.anchor_ms AND e.event_ms<?-s.anchor_ms ${characterKey?'AND s.character_key=?':''} GROUP BY day,s.recording_key,e.monster_id`).all(...args);
    for(const row of rows)days[Number(row.day)].observedDeaths+=Number(row.observed);
    const selected=rows.filter(row=>Number(row.day)===6),{startMs,endMs}=bounds[6];
    const intervalArgs:SQLInputValue[]=[startMs,endMs,endMs,startMs];if(characterKey)intervalArgs.push(characterKey);
    const spans=this.db.prepare(`SELECT s.recording_key,MAX(i.start_ms,?) start,MIN(i.end_ms,?) end FROM kill_count_sessions s JOIN kill_count_intervals i ON i.session_id=s.id WHERE ${knownClock} AND i.start_ms<? AND i.end_ms>? AND i.end_ms>i.start_ms ${characterKey?'AND s.character_key=?':''}`).all(...intervalArgs).map(row=>({recordingKey:String(row.recording_key),start:Number(row.start),end:Number(row.end)}));
    const undated=this.db.prepare(`SELECT COALESCE(SUM(t.observed),0) count FROM ${this.options.ownDamageOnly?'kill_own_damage_totals':'kill_count_totals'} t JOIN kill_count_sessions s ON s.recording_key=t.recording_key WHERE NOT (${knownClock}) ${characterKey?'AND s.character_key=?':''}`).get(...(characterKey?[characterKey]:[]))!;
    const groups=new Map<number,Row[]>();for(const row of selected){const id=Number(row.monster_id),group=groups.get(id)??[];group.push(row);groups.set(id,group);}
    const monsters:KillCountMonster[]=[...groups].map(([monsterId,own])=>({monsterId,monsterName:String(own.find(row=>row.name)?.name??`Canavar #${monsterId}`),lastKilledAt:new Date(own.reduce((last,row)=>Math.max(last,Number(row.last_ms)),-Infinity)).toISOString(),totals:this.totals(own,spans)}));
    return{countBasis:this.options.ownDamageOnly?'own-damage':'observed-deaths',date,timeZone:KILL_DAILY_TIME_ZONE,days,totals:this.totals(selected,spans),monsters,undatedDeaths:Number(undated.count),notice:(this.options.ownDamageOnly?'Yalnız kendi hasarına göre tahmini kesimler. ':'')+'Günler Türkiye saatine göre, başlangıç saati bilinen Replay kayıtlarından hesaplanır. Tarihi bilinmeyen gözlemler genel toplamda korunur. Kayıtlar arasında tekrar olabilir.'};
  }
  private totals(rows:Row[],spans:Span[]):KillCountTotals {
    const observedDeaths=rows.reduce((sum,row)=>sum+Number(row.observed),0),confirmedPersonalKills=rows.reduce((sum,row)=>sum+Number(row.personal),0),unknownDeaths=observedDeaths-confirmedPersonalKills;
    const recordings=new Map<string,number>();for(const row of rows)recordings.set(String(row.recording_key),(recordings.get(String(row.recording_key))??0)+Number(row.personal));
    const ownSpans=spans.filter(span=>recordings.has(span.recordingKey)).sort((a,b)=>a.start-b.start);let overlap=false;
    let first={key:'',end:-Infinity},second={key:'',end:-Infinity};
    for(const span of ownSpans){
      const key=span.recordingKey;
      if(first.key!==key&&first.end>=span.start||second.key!==key&&second.end>=span.start)overlap=true;
      if(first.key===key)first.end=Math.max(first.end,span.end);else if(second.key===key)second.end=Math.max(second.end,span.end);else if(span.end>first.end){second=first;first={key,end:span.end};}else if(span.end>second.end)second={key,end:span.end};
      if(second.end>first.end)[first,second]=[second,first];
    }
    // A missing duration cannot establish that multiple recordings are independent.
    if(recordings.size>1&&[...recordings.keys()].some(key=>!ownSpans.some(span=>span.recordingKey===key)))overlap=true;
    const uncertain=unknownDeaths>0||overlap,totalKills=observedDeaths>0&&!uncertain?confirmedPersonalKills:null,durationMs=unionFarmMilliseconds(spans.map(span=>[span.start,span.end]));
    let minimum=confirmedPersonalKills;if(overlap){minimum=0;for(const count of recordings.values())minimum=Math.max(minimum,count);}
    return{totalKills,confirmedPersonalKills,observedDeaths,unknownDeaths,killsPerHour:totalKills!==null&&durationMs>0?totalKills*3600000/durationMs:null,knownKillsPerHour:observedDeaths>0&&durationMs>0?confirmedPersonalKills*3600000/durationMs:null,durationMs,monsterTypes:new Set(rows.map(row=>Number(row.monster_id))).size,uncertain,range:{min:minimum,max:observedDeaths},timeBasis:'replay-start'};
  }
}
