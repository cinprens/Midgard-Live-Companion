import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import type {AutoFarmCharacter,AutoFarmItem,AutoFarmPrice,AutoFarmTotals} from '../src/shared/auto-farm';
import type {FinanceDailyState} from '../src/shared/finance-daily';
import {isKillDailySelectableDate,killDailyBounds,shiftKillDailyDate} from '../src/shared/kill-daily';
import {unionFarmMilliseconds} from './auto-farm-store';

export const FINANCE_DAILY_SCHEMA=`
  CREATE TABLE IF NOT EXISTS finance_calendar_sessions(session_id TEXT PRIMARY KEY REFERENCES autofarm_sessions(id),anchor_ms REAL NOT NULL,raw_started_at TEXT,time_zone TEXT NOT NULL,clock_version INTEGER NOT NULL,provenance TEXT NOT NULL,conflicting INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS finance_calendar_intervals(interval_id TEXT PRIMARY KEY REFERENCES autofarm_intervals(id),session_id TEXT NOT NULL REFERENCES autofarm_sessions(id),start_ms REAL NOT NULL,end_ms REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS finance_calendar_interval_session_time ON finance_calendar_intervals(session_id,start_ms,end_ms);
  CREATE INDEX IF NOT EXISTS finance_receipt_calendar ON autofarm_receipts(session_id,event_ms,item_id,character_key,quantity,item_name) WHERE excluded_reason IS NULL;
  CREATE INDEX IF NOT EXISTS autofarm_interval_session ON autofarm_intervals(session_id,id);
  INSERT OR IGNORE INTO finance_calendar_sessions(session_id,anchor_ms,raw_started_at,time_zone,clock_version,provenance,conflicting)
    SELECT s.id,MIN(c.anchor_ms),NULL,'UTC',1,'legacy-explicit-cursor',0 FROM autofarm_sessions s JOIN autofarm_cursors c ON c.session_id=s.id AND c.recording_key=s.recording_key
    WHERE s.time_basis='replay-start'
    GROUP BY s.id HAVING MIN(c.anchor_ms)=MAX(c.anchor_ms)
      AND COUNT(*)=SUM(CASE WHEN typeof(c.anchor_ms) IN ('integer','real') AND ABS(c.anchor_ms)<=8640000000000000 THEN 1 ELSE 0 END);
  INSERT OR IGNORE INTO finance_calendar_intervals(interval_id,session_id,start_ms,end_ms)
    SELECT i.id,i.session_id,i.start_ms,i.end_ms FROM autofarm_intervals i JOIN finance_calendar_sessions c ON c.session_id=i.session_id
    WHERE c.provenance='legacy-explicit-cursor' AND c.conflicting=0;
`;

type Row=Record<string,unknown>;
type Span={characterKey:string;start:number;end:number};
const knownClock="c.conflicting=0 AND c.clock_version=1 AND typeof(c.anchor_ms) IN ('integer','real') AND ABS(c.anchor_ms)<=8640000000000000";
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));

/** Calendar projection only: receipt import time is never treated as the loot date. */
export class FinanceDailyStore {
  private localNames=new Map<number,string>();
  constructor(private db:DatabaseSync){}
  setLocalItemNames(names:Map<number,string>):void{this.localNames=new Map(names);}
  private totals(items:AutoFarmItem[],spans:Span[],durationPartial=false):AutoFarmTotals {
    const durationMs=unionFarmMilliseconds(spans.map(span=>[span.start,span.end])),knownValue=items.reduce((sum,item)=>sum+(item.value??0),0),unpriced=items.filter(item=>item.unitPrice===null),partial=unpriced.length>0;
    return{knownValue,estimatedValue:partial?null:knownValue,hourlyValue:!partial&&!durationPartial&&durationMs>0?knownValue*3600000/durationMs:null,knownHourlyValue:!durationPartial&&durationMs>0?knownValue*3600000/durationMs:null,durationMs,unpricedItems:unpriced.length,unpricedQuantity:unpriced.reduce((sum,item)=>sum+item.quantity,0),partial,quantity:items.reduce((sum,item)=>sum+item.quantity,0),distinctItems:items.length,timeBasis:'replay-start'};
  }
  private items(rows:Row[],prices:Map<number,number|null>):AutoFarmItem[] {
    const grouped=new Map<number,{quantity:number;name:string|null}>();
    for(const row of rows){const id=Number(row.item_id),entry=grouped.get(id)??{quantity:0,name:null};entry.quantity+=Number(row.quantity);if(row.name)entry.name=String(row.name);grouped.set(id,entry);}
    return [...grouped].sort(([a],[b])=>a-b).map(([itemId,row])=>{const unitPrice=prices.get(itemId)??null;return{itemId,itemName:row.name??this.localNames.get(itemId)??`Eşya #${itemId}`,quantity:row.quantity,unitPrice,value:unitPrice===null?null:row.quantity*unitPrice,sourceLabel:'Çantaya gelen eşya'};});
  }
  read(value:unknown):FinanceDailyState {
    if(!plain(value)||Object.keys(value).some(key=>!['date','characterKey'].includes(key))||!isKillDailySelectableDate(value.date))throw new Error('Günlük finans sorgusu veya tarihi geçersiz.');
    const characterKey=value.characterKey??null;
    if(characterKey!==null&&(typeof characterKey!=='string'||!characterKey.length||characterKey.length>512||/[\u0000-\u001f\u007f]/.test(characterKey)))throw new Error('Finans karakter seçimi geçersiz.');
    const date=value.date,days=Array.from({length:7},(_,index)=>({date:shiftKillDailyDate(date,index-6),quantity:0,knownValue:0,partial:false,durationMs:0,durationPartial:false}));
    const bounds=days.map(day=>killDailyBounds(day.date)),first=bounds[0].startMs,last=bounds.at(-1)!.endMs,args:SQLInputValue[]=[];
    const cases=bounds.slice(0,-1).map((bound,index)=>{args.push(bound.endMs);return`WHEN c.anchor_ms+r.event_ms<? THEN ${index}`;}).join(' ');args.push(first,last);
    // A single lower bound keeps SQLite on the selected time range instead of
    // choosing event_ms >= 0 and filtering a complete session afterward.
    const rows=this.db.prepare(`SELECT CASE ${cases} ELSE 6 END day,r.session_id,r.character_key,r.item_id,SUM(r.quantity) quantity,COALESCE((SELECT name FROM item_database i WHERE i.item_id=r.item_id ORDER BY rowid DESC LIMIT 1),MAX(r.item_name)) name FROM finance_calendar_sessions c CROSS JOIN autofarm_receipts r ON r.session_id=c.session_id WHERE ${knownClock} AND r.excluded_reason IS NULL AND r.event_ms>=MAX(0,?-c.anchor_ms) AND r.event_ms<?-c.anchor_ms GROUP BY day,r.session_id,r.character_key,r.item_id`).all(...args);
    // A recovered date does not prove historical duration. Never divide old
    // quantities by only a newly observed, shorter part of the same session.
    const missingCoverage=new Set(this.db.prepare(`SELECT s.id FROM autofarm_sessions s WHERE NOT EXISTS(SELECT 1 FROM finance_calendar_intervals i WHERE i.session_id=s.id) OR EXISTS(SELECT 1 FROM autofarm_intervals i WHERE i.session_id=s.id AND NOT EXISTS(SELECT 1 FROM finance_calendar_intervals c WHERE c.interval_id=i.id))`).all().map(row=>String(row.id)));
    const partialDuration=(own:Row[])=>own.some(row=>missingCoverage.has(String(row.session_id)));
    const prices:AutoFarmPrice[]=this.db.prepare('SELECT * FROM autofarm_prices ORDER BY item_id').all().map(row=>({itemId:Number(row.item_id),unitPrice:row.unit_price===null?null:Number(row.unit_price),updatedAt:String(row.updated_at)})),priceMap=new Map(prices.map(price=>[price.itemId,price.unitPrice]));
    const intervalRows=this.db.prepare(`SELECT s.character_key,MAX(i.start_ms,?) start,MIN(i.end_ms,?) end FROM finance_calendar_intervals i JOIN finance_calendar_sessions c ON c.session_id=i.session_id JOIN autofarm_sessions s ON s.id=i.session_id WHERE ${knownClock} AND i.start_ms<? AND i.end_ms>? AND i.end_ms>i.start_ms`).all(first,last,last,first);
    const intervals:Span[]=intervalRows.map(row=>({characterKey:String(row.character_key),start:Number(row.start),end:Number(row.end)}));
    const selectedRows=rows.filter(row=>Number(row.day)===6),selectedSpans=intervals.map(span=>({...span,start:Math.max(span.start,bounds[6].startMs),end:Math.min(span.end,bounds[6].endMs)})).filter(span=>span.end>span.start);
    const sessions=this.db.prepare('SELECT * FROM autofarm_sessions ORDER BY rowid').all(),characters:AutoFarmCharacter[]=[...new Set(sessions.map(row=>String(row.character_key)))].map(key=>{
      const latest=sessions.filter(row=>row.character_key===key).at(-1)!,own=selectedRows.filter(row=>row.character_key===key),items=this.items(own,priceMap),spans=selectedSpans.filter(span=>span.characterKey===key);
      return{characterKey:key,characterName:String(latest.character_name),sessionId:String(latest.id),status:latest.status as AutoFarmCharacter['status'],available:true,items,totals:this.totals(items,spans,partialDuration(own))};
    });
    for(let index=0;index<7;index++){
      const own=rows.filter(row=>Number(row.day)===index&&(!characterKey||row.character_key===characterKey)),items=this.items(own,priceMap),spans=intervals.filter(span=>!characterKey||span.characterKey===characterKey).map(span=>({...span,start:Math.max(span.start,bounds[index].startMs),end:Math.min(span.end,bounds[index].endMs)})).filter(span=>span.end>span.start),durationPartial=partialDuration(own),totals=this.totals(items,spans,durationPartial);
      Object.assign(days[index],{quantity:totals.quantity,knownValue:totals.knownValue,partial:totals.partial,durationMs:totals.durationMs,durationPartial});
    }
    const selected=selectedRows.filter(row=>!characterKey||row.character_key===characterKey),durationPartial=partialDuration(selected),items=this.items(selected,priceMap),totals=this.totals(items,selectedSpans.filter(span=>!characterKey||span.characterKey===characterKey),durationPartial);
    // Separate unknown clocks from invalid event times so valid sessions use the
    // negative-time index range rather than scanning every historical receipt.
    const scope=characterKey?'AND s.character_key=?':'';
    const undated=this.db.prepare(`SELECT COALESCE(SUM(quantity),0) quantity FROM (
      SELECT SUM(r.quantity) quantity FROM autofarm_sessions s LEFT JOIN finance_calendar_sessions c ON c.session_id=s.id CROSS JOIN autofarm_receipts r ON r.session_id=s.id WHERE (c.session_id IS NULL OR NOT (${knownClock})) AND r.excluded_reason IS NULL ${scope}
      UNION ALL
      SELECT SUM(r.quantity) quantity FROM autofarm_sessions s JOIN finance_calendar_sessions c ON c.session_id=s.id CROSS JOIN autofarm_receipts r ON r.session_id=s.id WHERE ${knownClock} AND r.event_ms<0 AND r.excluded_reason IS NULL ${scope}
    )`).get(...(characterKey?[characterKey,characterKey]:[]));
    return{date,timeZone:'Europe/Istanbul',priceBasis:'current-shared-prices',days,undatedQuantity:Number(undated?.quantity??0),durationPartial,revision:Number(this.db.prepare("SELECT value FROM finance_metadata WHERE key='autofarm_revision'").get()?.value??0),status:characters.some(row=>row.status==='tracking')?'tracking':characters.at(-1)?.status??'waiting',items,characters,totals,prices,notice:'Günlük tutarlar güncel ortak birim fiyatlarla hesaplanan tahmini çanta değeridir; geçmiş satış geliri veya edinme fiyatı değildir. Kayıt tarihi Türkiye saatine göredir; tarihi doğrulanamayan miktarlar yalnız Tümü görünümünde kalır.'};
  }
}
