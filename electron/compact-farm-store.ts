import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {inventoryConfirmationTime,isVerifiedLootIncoming,type ParsedReplay,type ReplayEvent} from '../src/parser';
import {rareDropCategory,type RareDropCategory} from '../src/shared/rare-drop';
import type {CharacterIdentity,LiveStreamState,LiveStreamStatus,RecentLootSummary} from '../src/shared/types';
import type {AutoFarmCharacter,AutoFarmCorrectionPreview,AutoFarmItem,AutoFarmPrice,AutoFarmState,AutoFarmStatus,AutoFarmTimeBasis,AutoFarmTotals,FarmPriceInput} from '../src/shared/auto-farm';
import type {FinanceDailyState} from '../src/shared/finance-daily';
import {isKillDailySelectableDate,killDailyBounds,killDailyDate,shiftKillDailyDate} from '../src/shared/kill-daily';
import {replayClockBasis} from '../src/shared/replay-clock-basis';
import {unionFarmMilliseconds,type AutoFarmObservation} from './auto-farm-store';
import {referenceGameNames} from './reference-game-names';

export const COMPACT_FARM_SCHEMA=`
CREATE TABLE IF NOT EXISTS compact_farm_characters(character_key TEXT PRIMARY KEY,character_name TEXT NOT NULL,status TEXT NOT NULL,time_basis TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS compact_farm_totals(character_key TEXT NOT NULL,day TEXT NOT NULL,item_id INTEGER NOT NULL,quantity INTEGER NOT NULL,item_name TEXT,PRIMARY KEY(character_key,day,item_id));
CREATE INDEX IF NOT EXISTS compact_farm_total_day ON compact_farm_totals(day,character_key,item_id);
CREATE TABLE IF NOT EXISTS compact_farm_durations(character_key TEXT NOT NULL,day TEXT NOT NULL,duration_ms REAL NOT NULL,partial INTEGER NOT NULL DEFAULT 0,time_basis TEXT NOT NULL,PRIMARY KEY(character_key,day));
CREATE TABLE IF NOT EXISTS compact_farm_cursors(character_key TEXT PRIMARY KEY,recording_key TEXT NOT NULL,seen_ms REAL NOT NULL,packet_count INTEGER NOT NULL,anchor_ms REAL,coverage_end_ms REAL,source_key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS compact_farm_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS autofarm_prices(item_id INTEGER PRIMARY KEY,unit_price REAL,updated_at TEXT NOT NULL);
`;
type Row=Record<string,unknown>;
type Span=[number,number];
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const sourceKey=(value:string)=>digest(path.resolve(value).toLowerCase());
const exists=(db:DatabaseSync,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const readMeta=(db:DatabaseSync,key:string)=>db.prepare('SELECT value FROM compact_farm_metadata WHERE key=?').get(key)?.value;
const meta=(db:DatabaseSync,key:string,value:string|number)=>db.prepare('INSERT INTO compact_farm_metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));
const basis=(values:string[]):AutoFarmTimeBasis=>values.length&&values.every(value=>value===values[0])?values[0] as AutoFarmTimeBasis:'mixed';
const dayAt=(timestamp:number):string=>Number.isFinite(timestamp)&&Math.abs(timestamp)<=8640000000000000?killDailyDate(new Date(timestamp)):'';
function splitDays(start:number,end:number):{day:string;start:number;end:number}[]{
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return[];
  const result:{day:string;start:number;end:number}[]=[];let at=start;
  while(at<end){if(result.length>36600)throw new Error('Süre özeti tarih aralığı güvenli sınırı aşıyor.');const day=dayAt(at);if(!day)break;const next=Math.min(end,killDailyBounds(day).endMs);if(next<=at)throw new Error('Gün sınırı çözülemedi.');result.push({day,start:at,end:next});at=next;}return result;
}
function addDuration(db:DatabaseSync,key:string,day:string,duration:number,partial:boolean,timeBasis:AutoFarmTimeBasis){
  db.prepare(`INSERT INTO compact_farm_durations VALUES(?,?,?,?,?) ON CONFLICT(character_key,day) DO UPDATE SET duration_ms=duration_ms+excluded.duration_ms,partial=MAX(partial,excluded.partial),time_basis=CASE WHEN time_basis=excluded.time_basis THEN time_basis ELSE 'mixed' END`).run(key,day,Math.max(0,duration),partial?1:0,timeBasis);
}
export interface CompactFarmMigrationMetrics {legacyReceiptCount:number;legacyQuantity:number;compactQuantity:number;itemRows:number;characterCount:number;allTimeDurationMs:number;alreadyMigrated:boolean;}
/** Called by the owning migration transaction. Legacy tables are deliberately left intact. */
export function migrateCompactFarm(db:DatabaseSync):CompactFarmMigrationMetrics{
  const metrics=():CompactFarmMigrationMetrics=>({legacyReceiptCount:Number(readMeta(db,'legacy_receipts')??0),legacyQuantity:Number(readMeta(db,'legacy_quantity')??0),compactQuantity:Number(db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM compact_farm_totals').get()?.n??0),itemRows:Number(db.prepare('SELECT COUNT(*) n FROM compact_farm_totals').get()?.n??0),characterCount:Number(db.prepare('SELECT COUNT(*) n FROM compact_farm_characters').get()?.n??0),allTimeDurationMs:Number(db.prepare("SELECT duration_ms FROM compact_farm_durations WHERE character_key='' AND day='*'").get()?.duration_ms??0),alreadyMigrated:true});
  if(readMeta(db,'migrated')==='1')return metrics();
  if(Number(db.prepare('SELECT COUNT(*) n FROM compact_farm_totals').get()?.n))throw new Error('Özet finans göçü için hedef tablolar boş olmalıdır.');
  let receiptCount=0,quantity=0;
  const sessions=new Map<string,{character:string;anchor:number|null;partial:boolean;basis:AutoFarmTimeBasis}>();
  const calendar=exists(db,'finance_calendar_sessions'),mapped=exists(db,'finance_calendar_intervals');
  if(exists(db,'autofarm_sessions'))for(const row of db.prepare('SELECT * FROM autofarm_sessions ORDER BY rowid').iterate()){
    const c=calendar?db.prepare('SELECT * FROM finance_calendar_sessions WHERE session_id=?').get(String(row.id)):undefined;
    const anchor=c&&Number(c.conflicting)===0&&Number(c.clock_version)===1&&typeof c.anchor_ms==='number'&&Number.isFinite(c.anchor_ms)&&Math.abs(c.anchor_ms)<=8640000000000000?c.anchor_ms:null;
    const partial=!mapped||!db.prepare('SELECT 1 FROM finance_calendar_intervals WHERE session_id=? LIMIT 1').get(String(row.id))||!!db.prepare('SELECT 1 FROM autofarm_intervals i WHERE i.session_id=? AND NOT EXISTS(SELECT 1 FROM finance_calendar_intervals c WHERE c.interval_id=i.id) LIMIT 1').get(String(row.id));
    sessions.set(String(row.id),{character:String(row.character_key),anchor,partial,basis:row.time_basis as AutoFarmTimeBasis});
    db.prepare(`INSERT INTO compact_farm_characters VALUES(?,?,?,?) ON CONFLICT(character_key) DO UPDATE SET character_name=excluded.character_name,time_basis=CASE WHEN time_basis=excluded.time_basis THEN time_basis ELSE 'mixed' END`).run(String(row.character_key),String(row.character_name),'stopped',String(row.time_basis));
  }
  const insert=db.prepare(`INSERT INTO compact_farm_totals VALUES(?,?,?,?,?) ON CONFLICT(character_key,day,item_id) DO UPDATE SET quantity=quantity+excluded.quantity,item_name=COALESCE(excluded.item_name,item_name)`);
  if(exists(db,'autofarm_receipts'))for(const row of db.prepare('SELECT session_id,character_key,item_id,quantity,event_ms,item_name FROM autofarm_receipts WHERE excluded_reason IS NULL').iterate()){
    const count=Number(row.quantity),itemId=Number(row.item_id),session=sessions.get(String(row.session_id));
    if(!session||!Number.isSafeInteger(count)||count<0||!Number.isSafeInteger(itemId)||itemId<1)throw new Error('Eski eşya toplamı güvenle özetlenemedi; kaynak kayıtlar korunuyor.');
    const day=session.anchor!==null&&Number(row.event_ms)>=0?dayAt(session.anchor+Number(row.event_ms)):'';
    if(count)insert.run(String(row.character_key),day,itemId,count,row.item_name===null?null:String(row.item_name));receiptCount++;quantity+=count;if(!Number.isSafeInteger(quantity))throw new Error('Eski eşya toplamı kesin sayı sınırını aşıyor; kaynak kayıtlar korunuyor.');
    if(day&&session.partial)addDuration(db,String(row.character_key),day,0,true,'replay-start');
    if(day&&session.partial)addDuration(db,'',day,0,true,'replay-start');
  }
  const spans=new Map<string,Span[]>(),daily=new Map<string,{key:string;day:string;spans:Span[]}>();
  const addSpan=(key:string,start:number,end:number)=>{const list=spans.get(key)??[];list.push([start,end]);spans.set(key,list);};
  if(exists(db,'autofarm_intervals'))for(const row of db.prepare('SELECT i.*,s.character_key FROM autofarm_intervals i JOIN autofarm_sessions s ON s.id=i.session_id').iterate()){
    const start=Number(row.start_ms),end=Number(row.end_ms);if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)throw new Error('Eski farm süresi geçersiz; özet göçü durduruldu.');addSpan(String(row.character_key),start,end);addSpan('',start,end);
  }
  for(const[key,list]of spans)addDuration(db,key,'*',unionFarmMilliseconds(list),false,key?String(db.prepare('SELECT time_basis FROM compact_farm_characters WHERE character_key=?').get(key)?.time_basis??'mixed') as AutoFarmTimeBasis:basis([...sessions.values()].map(session=>session.basis)));
  if(mapped)for(const row of db.prepare('SELECT * FROM finance_calendar_intervals').iterate()){
    const session=sessions.get(String(row.session_id));if(!session||session.anchor===null)continue;
    for(const part of splitDays(Number(row.start_ms),Number(row.end_ms)))for(const key of [session.character,'']){const id=JSON.stringify([key,part.day]),entry=daily.get(id)??{key,day:part.day,spans:[]};entry.spans.push([part.start,part.end]);daily.set(id,entry);}
  }
  for(const entry of daily.values()){
    addDuration(db,entry.key,entry.day,unionFarmMilliseconds(entry.spans),false,'replay-start');
    const name=`calendar_end:${digest(entry.key)}`,previous=Number(readMeta(db,name)??-Infinity);meta(db,name,entry.spans.reduce((end,span)=>Math.max(end,span[1]),previous));
  }
  if(exists(db,'autofarm_cursors'))for(const row of db.prepare('SELECT c.*,s.character_key FROM autofarm_cursors c JOIN autofarm_sessions s ON s.id=c.session_id ORDER BY s.rowid').iterate()){
    const session=sessions.get(String(row.session_id));if(!session)continue;
    const coverage=spans.get(session.character),end=coverage?.length?coverage.reduce((end,span)=>Math.max(end,span[1]),-Infinity):null;
    db.prepare('INSERT INTO compact_farm_cursors VALUES(?,?,?,?,?,?,?) ON CONFLICT(character_key) DO UPDATE SET recording_key=excluded.recording_key,seen_ms=excluded.seen_ms,anchor_ms=excluded.anchor_ms,coverage_end_ms=excluded.coverage_end_ms,source_key=excluded.source_key').run(session.character,String(row.recording_key),Math.max(0,Number(row.last_replay_ms)||0),0,session.anchor,end,String(row.source_key));
  }
  if(exists(db,'autofarm_sessions'))for(const row of db.prepare('SELECT * FROM autofarm_sessions ORDER BY rowid DESC').iterate()){
    const key=String(row.character_key),list=spans.get(key),session=sessions.get(String(row.id)),end=list?.length?list.reduce((end,span)=>Math.max(end,span[1]),-Infinity):null;
    db.prepare('INSERT OR IGNORE INTO compact_farm_cursors VALUES(?,?,?,?,?,?,?)').run(key,String(row.recording_key),0,0,session?.anchor??null,end,'');
  }
  const allSpans=spans.get('');if(allSpans?.length)meta(db,'coverage_end',allSpans.reduce((end,span)=>Math.max(end,span[1]),-Infinity));
  meta(db,'legacy_receipts',receiptCount);meta(db,'legacy_quantity',quantity);
  const actual=Number(db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM compact_farm_totals').get()?.n??0);if(actual!==quantity)throw new Error('Özet finans göçünde miktar doğrulaması başarısız.');
  meta(db,'revision',exists(db,'finance_metadata')?Number(db.prepare("SELECT value FROM finance_metadata WHERE key='autofarm_revision'").get()?.value??0):0);meta(db,'migrated',1);
  return{...metrics(),alreadyMigrated:false};
}

class CompactFarmView{
  protected names=new Map<number,string>();
  private categories:ReadonlyMap<number,'card'|'costume'>=new Map();
  setRareCategories(categories:ReadonlyMap<number,'card'|'costume'>){this.categories=categories;}
  constructor(protected db:DatabaseSync){}
  setLocalItemNames(names:Map<number,string>):void{this.names=new Map(names);}
  protected catalogLookup(){
    return exists(this.db,'item_database')?this.db.prepare('SELECT name,category FROM item_database WHERE item_id=? ORDER BY rowid DESC LIMIT 1'):null;
  }
  protected prices():AutoFarmPrice[]{return this.db.prepare('SELECT * FROM autofarm_prices ORDER BY item_id').all().map(row=>({itemId:Number(row.item_id),unitPrice:row.unit_price===null?null:Number(row.unit_price),updatedAt:String(row.updated_at)}));}
  protected items(day:string|null,key:string|null,prices:AutoFarmPrice[]):AutoFarmItem[]{
    const rows=this.db.prepare(`SELECT t.item_id,SUM(t.quantity) quantity,MAX(t.item_name) name,m.value rare_category
      FROM compact_farm_totals t LEFT JOIN compact_farm_metadata m ON m.key='rare-kind:'||t.item_id
      WHERE (? IS NULL OR t.day=?) AND (? IS NULL OR t.character_key=?) AND t.quantity>0 GROUP BY t.item_id ORDER BY t.item_id`).all(day,day,key,key);
    const values=new Map(prices.map(price=>[price.itemId,price.unitPrice])),lookup=this.catalogLookup();
    return rows.map(row=>{
      const itemId=Number(row.item_id),quantity=Number(row.quantity),unitPrice=values.get(itemId)??null;
      const entry=lookup?.get(itemId),kind=String(entry?.category??'').trim().toLowerCase();
      const saved=row.rare_category;
      const rareCategory=saved==='card'||saved==='costume'?saved:this.categories.get(itemId)??(kind==='card'||kind==='costume'?kind:undefined);
      return {itemId,itemName:String(entry?.name??row.name??this.names.get(itemId)??referenceGameNames.items.get(itemId)??`Eşya #${itemId}`),quantity,unitPrice,value:unitPrice===null?null:unitPrice*quantity,sourceLabel:'Çantaya gelen eşya',...(rareCategory?{rareCategory}:{})};
    });
  }
  protected duration(day:string,key:string|null){const row=this.db.prepare('SELECT * FROM compact_farm_durations WHERE character_key=? AND day=?').get(key??'',day);return{durationMs:Number(row?.duration_ms??0),partial:Number(row?.partial??0)!==0,timeBasis:(row?.time_basis??'replay-start') as AutoFarmTimeBasis};}
  protected totals(items:AutoFarmItem[],day:string,key:string|null,available=true):AutoFarmTotals{
    const duration=this.duration(day,key),knownValue=items.reduce((sum,item)=>sum+(item.value??0),0),unpriced=items.filter(item=>item.unitPrice===null),partial=unpriced.length>0;
    return{knownValue,estimatedValue:available&&!partial?knownValue:null,hourlyValue:available&&!partial&&!duration.partial&&duration.durationMs>0?knownValue*3600000/duration.durationMs:null,knownHourlyValue:available&&!duration.partial&&duration.durationMs>0?knownValue*3600000/duration.durationMs:null,durationMs:duration.durationMs,unpricedItems:unpriced.length,unpricedQuantity:unpriced.reduce((sum,item)=>sum+item.quantity,0),partial,quantity:items.reduce((sum,item)=>sum+item.quantity,0),distinctItems:items.length,timeBasis:duration.timeBasis};
  }
  protected characters(day:string|null,prices:AutoFarmPrice[]):AutoFarmCharacter[]{return this.db.prepare('SELECT * FROM compact_farm_characters ORDER BY rowid').all().map(row=>{const characterKey=String(row.character_key),items=this.items(day,characterKey,prices),available=day!==null||items.length>0;return{characterKey,characterName:String(row.character_name),sessionId:null,status:row.status as AutoFarmStatus,available,items,totals:this.totals(items,day??'*',characterKey,available)};});}
}
interface RecentReceipt{id:string;itemId:number;amount:number;day:string;name:string|null;timestamp:number;streamId:string;packetOrder:number;}
export interface RarePickup {id:string;itemId:number;itemName:string;quantity:number;category:RareDropCategory}
interface StreamLoot {characterKey:string;recording:string;source:string;receipts:RecentReceipt[];settled:RecentReceipt[];}
const RECENT_PICKUP_COUNT=3;
const newestFirst=(a:RecentReceipt,b:RecentReceipt)=>b.timestamp-a.timestamp || b.packetOrder-a.packetOrder;
const lastThree=(receipts:RecentReceipt[])=>receipts.sort(newestFirst).slice(0,RECENT_PICKUP_COUNT);
interface Runtime{characterKey:string;recording:string;frontier:number;packetCount:number;monitor:number;anchor:number|null;durationAnchor:number;coverage:number|null;recent:Map<string,RecentReceipt>;seen:Map<string,number>;pending:Map<string,number>;recoverUntil:number;protectedFrontier:number;status:AutoFarmStatus;}
const stateFor=(status:LiveStreamStatus):AutoFarmStatus=>status==='paused'?'paused':status==='stopped'?'stopped':status==='missing'?'missing':status==='error'?'unavailable':'tracking';
const excluded=(event:ReplayEvent)=>['trade','storage','cart','purchase','quest','refresh'].includes(String(event.rawData?.inventorySource))||['excluded-client-refresh','excluded-unresolved-transfer'].includes(String(event.rawData?.parserProof));
export class CompactAutoFarmStore extends CompactFarmView{
  private lastByStream=new Map<string,StreamLoot>();
  private runtime=new Map<string,Runtime>();
  private sources=new Map<string,string>();
  private alerts:{characterKey:string;id:string;itemId:number;quantity:number;rareCategory?:RareDropCategory}[]=[];
  private coverage=new Map<string,{baseEnd:number|null;spans:Span[]}>();
  constructor(db:DatabaseSync){super(db);this.db.prepare("UPDATE compact_farm_characters SET status='stopped' WHERE status='tracking'").run();}
  private transaction(action:()=>void):void{const previous=this.coverage;this.coverage=new Map(previous);this.db.exec('BEGIN IMMEDIATE');try{action();this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');this.coverage=previous;throw error;}}
  private changed():void{meta(this.db,'revision',Number(readMeta(this.db,'revision')??0)+1);}
  override setLocalItemNames(names:Map<number,string>):void{super.setLocalItemNames(names);this.changed();}
  setPrice(input:FarmPriceInput):void{
    if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['itemId','unitPrice'].includes(key))||!Number.isSafeInteger(input.itemId)||input.itemId<1||input.itemId>0xffffffff||input.unitPrice!==null&&(!Number.isFinite(input.unitPrice)||input.unitPrice<0||input.unitPrice>1e12))throw new Error('Geçerli eşya kimliği ve sıfır veya pozitif fiyat gerekli.');
    this.transaction(()=>{this.db.prepare('INSERT INTO autofarm_prices VALUES(?,?,?) ON CONFLICT(item_id) DO UPDATE SET unit_price=excluded.unit_price,updated_at=excluded.updated_at').run(input.itemId,input.unitPrice,new Date().toISOString());this.changed();});
  }
  observe(parsed:ParsedReplay,observation:AutoFarmObservation,character:CharacterIdentity,categoryFor?:(id:number)=>RareDropCategory|undefined):RarePickup[]{
    const pickups=new Map<string,RarePickup>();
    let catalog:ReturnType<CompactAutoFarmStore['catalogLookup']>|undefined;
    if(observation.recordingReset)this.lastByStream.delete(observation.streamId);
    if(['invalid','unsupported'].includes(parsed.status))return [];
    const source=sourceKey(observation.sourcePath),strong=parsed.summary.startedAt!==null&&parsed.summary.playerId!==null&&parsed.summary.characterName!==null,recording=digest(strong?JSON.stringify([parsed.summary.startedAt,parsed.summary.playerId,parsed.summary.characterName]):`${source}:${observation.recordingId}`);
    const previous=this.lastByStream.get(observation.streamId);
    if(previous && (previous.recording!==recording || previous.characterKey!==character.key || previous.source!==source))this.lastByStream.delete(observation.streamId);
    const anchor=replayClockBasis(parsed.summary.startedAt).anchorMs;let edge=Math.max(0,parsed.incremental?.delta?parsed.summary.durationMs:0);for(const event of parsed.events)if(Number.isFinite(event.timestamp))edge=Math.max(edge,event.timestamp);
    if(!Number.isSafeInteger(edge)||!character.key||character.key.length>512)throw new Error('Farm özeti için geçerli karakter ve Replay ilerlemesi gerekli.');
    let current=this.runtime.get(character.key);const saved=this.db.prepare('SELECT * FROM compact_farm_cursors WHERE character_key=?').get(character.key);
    let freshWindow=false;
    if(!current||current.recording!==recording||observation.recordingReset){
      freshWindow=true;
      if(saved&&String(saved.recording_key)!==recording&&anchor!==null&&typeof saved.anchor_ms==='number'&&anchor<saved.anchor_ms)return [];
      const continuing=saved&&saved.recording_key===recording&&!observation.recordingReset,frontier=continuing?Number(saved.seen_ms):edge;
      current={characterKey:character.key,recording,frontier,packetCount:continuing?Number(saved.packet_count):0,monitor:frontier,anchor,durationAnchor:anchor??Date.parse(observation.observedAt??new Date().toISOString())-edge,coverage:typeof saved?.coverage_end_ms==='number'?saved.coverage_end_ms:null,recent:new Map(),seen:new Map(),pending:new Map(),recoverUntil:continuing?frontier:-1,protectedFrontier:continuing?frontier:-1,status:'tracking'};
      if(!continuing)observation={...observation,bootstrap:true};
    }
    const entry={...current,recent:new Map(current.recent),seen:new Map(current.seen),pending:new Map(current.pending)},bootstrap=observation.bootstrap===true,oldEdge=entry.frontier,occurrences=new Map<string,number>();let alerts=[...this.alerts];
    const affectedStreams=new Set<string>();
    this.transaction(()=>{
      this.db.prepare(`INSERT INTO compact_farm_characters VALUES(?,?,?,?) ON CONFLICT(character_key) DO UPDATE SET character_name=excluded.character_name,status='tracking',time_basis=CASE WHEN time_basis=excluded.time_basis THEN time_basis ELSE 'mixed' END`).run(character.key,character.name,'tracking',anchor===null?'observation-anchor':'replay-start');
      for(const event of parsed.events){
        if(!['inventory-ack','item-obtained'].includes(event.eventType)||!Number.isSafeInteger(event.timestamp)||event.timestamp<0)continue;
        if(parsed.incremental?.delta&&(!Number.isSafeInteger(event.rawData?.inventoryOccurrence)||Number(event.rawData?.inventoryOccurrence)<1))continue;
        const semantic=JSON.stringify([event.timestamp,event.itemId,event.amount,event.rawData?.slot]),occurrence=typeof event.rawData?.inventoryOccurrence==='number'?event.rawData.inventoryOccurrence:(occurrences.get(semantic)??0)+1;occurrences.set(semantic,occurrence);
        const id=digest(`${recording}:${semantic}:${occurrence}`),accepted=entry.recent.get(id);
        if(excluded(event)){
          if(accepted){
            this.db.prepare('UPDATE compact_farm_totals SET quantity=MAX(0,quantity-?) WHERE character_key=? AND day=? AND item_id=?').run(accepted.amount,character.key,accepted.day,accepted.itemId);
            entry.recent.delete(id);alerts=alerts.filter(alert=>alert.id!==id);pickups.delete(id);
            affectedStreams.add(accepted.streamId);
          }
          entry.pending.delete(id);continue;
        }
        if(event.rawData?.pendingInventory===true){if(event.actorId===parsed.summary.playerId&&Number.isSafeInteger(event.actorId)&&Number(event.actorId)>0&&edge-event.timestamp<=1500&&(!bootstrap&&event.timestamp>entry.monitor||bootstrap&&entry.recoverUntil>=event.timestamp&&entry.recoverUntil-event.timestamp<=1500))entry.pending.set(id,event.timestamp);continue;}
        if(!isVerifiedLootIncoming(event,parsed.summary.playerId))continue;
        const confirmedAt=inventoryConfirmationTime(event)!,pending=entry.pending.has(id)&&oldEdge-event.timestamp<=1500;entry.pending.delete(id);
        if(entry.seen.has(id))continue;
        const alreadySettled=confirmedAt<entry.protectedFrontier||confirmedAt===entry.protectedFrontier&&entry.protectedFrontier>event.timestamp+500;
        if(bootstrap||alreadySettled||event.timestamp<=entry.monitor&&!pending||confirmedAt<oldEdge&&!pending||edge<=event.timestamp+500||confirmedAt>edge){entry.seen.set(id,event.timestamp);continue;}
        const day=anchor===null?'':dayAt(anchor+event.timestamp),itemId=event.itemId!,amount=event.amount!,name=this.names.get(itemId)??null;
        this.db.prepare(`INSERT INTO compact_farm_totals VALUES(?,?,?,?,?) ON CONFLICT(character_key,day,item_id) DO UPDATE SET quantity=quantity+excluded.quantity,item_name=COALESCE(excluded.item_name,item_name)`).run(character.key,day,itemId,amount,name);
        const receipt={id,itemId,amount,day,name,timestamp:event.timestamp,streamId:observation.streamId,packetOrder:Number(/^packet-(\d+)$/.exec(event.id)?.[1]??0)};
        const packetCategory=rareDropCategory(event.rawData?.itemType,event.rawData?.equipLocation);
        if(catalog===undefined)catalog=this.catalogLookup();
        const imported=catalog?.get(itemId),catalogKind=String(imported?.category??'').trim().toLowerCase();
        const category=packetCategory??categoryFor?.(itemId)??(catalogKind==='card'||catalogKind==='costume'?catalogKind:undefined);
        if(packetCategory)meta(this.db,`rare-kind:${itemId}`,packetCategory);
        entry.recent.set(id,receipt);entry.seen.set(id,event.timestamp);
        alerts.push({characterKey:character.key,id,itemId,quantity:amount,...(category?{rareCategory:category}:{})});
        if(category)pickups.set(id,{id,itemId,itemName:String(imported?.name??name??referenceGameNames.items.get(itemId)??`Eşya #${itemId}`),quantity:amount,category});
        affectedStreams.add(receipt.streamId);
      }
      if(!bootstrap&&edge>oldEdge)this.recordDuration(entry,oldEdge,edge);
      if(bootstrap)entry.monitor=Math.max(entry.monitor,edge);
      else entry.recoverUntil=-1;
      entry.frontier=Math.max(entry.frontier,edge);entry.packetCount=Math.max(entry.packetCount,parsed.packetCount);entry.status='tracking';
      this.db.prepare('INSERT INTO compact_farm_cursors VALUES(?,?,?,?,?,?,?) ON CONFLICT(character_key) DO UPDATE SET recording_key=excluded.recording_key,seen_ms=excluded.seen_ms,packet_count=excluded.packet_count,anchor_ms=excluded.anchor_ms,coverage_end_ms=excluded.coverage_end_ms,source_key=excluded.source_key').run(character.key,recording,entry.frontier,entry.packetCount,anchor,entry.coverage,source);this.changed();
    });
    this.runtime.set(character.key,entry);this.alerts=alerts;this.sources.set(source,character.key);
    while(this.sources.size>256){
      const oldest=this.sources.keys().next().value!,owner=this.sources.get(oldest)!;
      this.sources.delete(oldest);
      for(const [id,window] of this.lastByStream)if(window.source===oldest)this.lastByStream.delete(id);
      if(![...this.sources.values()].includes(owner))this.runtime.delete(owner);
    }
    for(const map of [entry.pending,entry.seen]){for(const[id,time]of map)if(entry.frontier-time>10000)map.delete(id);while(map.size>4096)map.delete(map.keys().next().value!);}
    // A resumed reader starts a new correction window; the previous visible pickups are settled.
    if(freshWindow)for(const window of this.lastByStream.values()){
      if(window.characterKey===character.key && window.recording===recording)window.settled=window.receipts;
    }
    const retired=new Map<string,RecentReceipt[]>();
    const settle=(receipt:RecentReceipt)=>{
      const list=retired.get(receipt.streamId)??[];
      list.push(receipt);retired.set(receipt.streamId,list);
      affectedStreams.add(receipt.streamId);entry.recent.delete(receipt.id);
    };
    for(const receipt of entry.recent.values())if(entry.frontier-receipt.timestamp>10000)settle(receipt);
    while(entry.recent.size>4096)settle(entry.recent.values().next().value!);
    for(const streamId of affectedStreams){
      const previous=this.lastByStream.get(streamId);
      if(streamId!==observation.streamId && (!previous || previous.characterKey!==character.key || previous.recording!==recording))continue;
      // Three settled pickups suffice to fill any gaps after recent transfers are reclassified.
      const settled=lastThree([...(retired.get(streamId)??[]).reverse(),...(previous?.settled??[])]);
      const correctable=[...entry.recent.values()].filter(receipt=>receipt.streamId===streamId).reverse();
      const receipts=lastThree([...correctable,...settled]);
      if(receipts.length)this.lastByStream.set(streamId,{characterKey:character.key,recording,source:previous?.source??source,receipts,settled});
      else this.lastByStream.delete(streamId);
    }
    if(this.alerts.length>2048)this.alerts.splice(0,this.alerts.length-2048);
    return [...pickups.values()];
  }
  private recordDuration(entry:Runtime,from:number,to:number):void{
    const start=entry.durationAnchor+from,end=entry.durationAnchor+to;if(!Number.isFinite(start)||!Number.isFinite(end))return;
    const globalValue=readMeta(this.db,'coverage_end'),global=globalValue===undefined?null:Number(globalValue);
    for(const[key,covered]of [[entry.characterKey,entry.coverage],['',global]] as const){
      const all=this.uncovered(`all:${key}`,start,end,covered);addDuration(this.db,key,'*',all.spans.reduce((sum,[a,b])=>sum+b-a,0),all.partial,entry.anchor===null?'observation-anchor':'replay-start');
      if(entry.anchor!==null){
        const name=`calendar_end:${digest(key)}`,old=readMeta(this.db,name),calendar=this.uncovered(`calendar:${key}`,start,end,old===undefined?null:Number(old));
        for(const[a,b]of calendar.spans)for(const part of splitDays(a,b))addDuration(this.db,key,part.day,part.end-part.start,false,'replay-start');
        if(calendar.partial)for(const part of splitDays(start,end))addDuration(this.db,key,part.day,0,true,'replay-start');
        meta(this.db,name,Math.max(old===undefined?end:Number(old),end));
      }
    }
    entry.coverage=Math.max(entry.coverage??end,end);meta(this.db,'coverage_end',Math.max(global??end,end));
  }
  private uncovered(scope:string,start:number,end:number,persistedEnd:number|null):{spans:Span[];partial:boolean}{
    const context=this.coverage.get(scope)??{baseEnd:persistedEnd,spans:[]},begin=context.baseEnd===null?start:Math.max(start,context.baseEnd),partial=context.baseEnd!==null&&start<context.baseEnd;
    let parts:Span[]=end>begin?[[begin,end]]:[];
    for(const[a,b]of context.spans)parts=parts.flatMap(([from,to])=>b<=from||a>=to?[[from,to] as Span]:[...(from<a?[[from,a] as Span]:[]),...(to>b?[[b,to] as Span]:[])]);
    const merged:Span[]=[];for(const span of [...context.spans,...parts].sort((a,b)=>a[0]-b[0])){const previous=merged.at(-1);if(previous&&span[0]<=previous[1])previous[1]=Math.max(previous[1],span[1]);else merged.push([...span]);}
    this.coverage.set(scope,merged.length>4096?{baseEnd:Math.max(end,persistedEnd??end),spans:[]}:{baseEnd:context.baseEnd,spans:merged});return{spans:parts,partial};
  }
  suspend(sourcePath:string,state:AutoFarmStatus='paused'):void{const source=sourceKey(sourcePath),key=this.sources.get(source);this.sources.delete(source);if(!key||[...this.sources.values()].includes(key))return;this.runtime.delete(key);this.db.prepare('UPDATE compact_farm_characters SET status=? WHERE character_key=?').run(state,key);this.changed();}
  syncStatuses(streams:{id?:string;sourcePath:string;status:LiveStreamStatus}[]):void{
    const known=new Map(streams.map(stream=>[sourceKey(stream.sourcePath),stream.id]));
    for(const [id,last] of this.lastByStream)if(!known.has(last.source) || (known.get(last.source)!==undefined && known.get(last.source)!==id))this.lastByStream.delete(id);
    for(const stream of streams)if(['paused','stopped','missing','error'].includes(stream.status))this.suspend(stream.sourcePath,stateFor(stream.status));
    for(const[source,key]of [...this.sources])if(!known.has(source)){this.sources.delete(source);if(![...this.sources.values()].includes(key)){this.runtime.delete(key);this.db.prepare("UPDATE compact_farm_characters SET status='stopped' WHERE character_key=?").run(key);this.changed();}}
  }
  lastLootFor(streamId:string,characterKey:string|undefined):{itemId:number;quantity:number}|undefined{
    const last=this.lastByStream.get(streamId);
    if(!last || last.characterKey!==characterKey)return undefined;
    const first=last.receipts[0];
    return {itemId:first.itemId,quantity:first.amount};
  }
  recentLootFor(streamId:string,characterKey:string|undefined):RecentLootSummary|undefined{
    const last=this.lastByStream.get(streamId);
    if(!last || last.characterKey!==characterKey)return undefined;
    const receipts=last.receipts;
    const quantities=new Map<number,number>();
    let totalQuantity=0;
    for(const {itemId,amount} of receipts){
      quantities.set(itemId,(quantities.get(itemId)??0)+amount);
      totalQuantity+=amount;
    }
    return {pickupCount:receipts.length,totalQuantity,items:Array.from(quantities,([itemId,quantity])=>({itemId,quantity}))};
  }
  attachTaskbarDailyLoot(streams: Pick<LiveStreamState, 'character' | 'recentLoot' | 'lastLoot' | 'dailyLoot'>[], date=killDailyDate()):void {
    if (!streams.length) return;
    // Aggregate in SQLite. The renderer only needs item counts for the three displayed pickups.
    const totals = new Map(this.db.prepare(`SELECT character_key, SUM(quantity) AS total
      FROM compact_farm_totals WHERE day=? AND quantity>0 GROUP BY character_key`).all(date)
      .map(row => [String(row.character_key), Number(row.total)]));
    const count = this.db.prepare('SELECT quantity FROM compact_farm_totals WHERE character_key=? AND day=? AND item_id=?');
    for (const stream of streams) {
      if (!stream.character?.key || stream.character.source === 'unassigned') {
        delete stream.dailyLoot;
        continue;
      }
      const key = stream.character.key;
      const itemQuantities: Record<number, number> = {};
      const items = stream.recentLoot?.items ?? (stream.lastLoot ? [stream.lastLoot] : []);
      for (const {itemId} of items) {
        itemQuantities[itemId] = Number(count.get(key, date, itemId)?.quantity ?? 0);
      }
      stream.dailyLoot = {date, totalQuantity: totals.get(key) ?? 0, itemQuantities};
    }
  }
  snapshot():AutoFarmState{const prices=this.prices(),items=this.items(null,null,prices),characters=this.characters(null,prices);return{revision:Number(readMeta(this.db,'revision')??0),status:characters.some(character=>character.status==='tracking')?'tracking':characters.at(-1)?.status??'waiting',items,characters,totals:this.totals(items,'*',null,items.length>0),prices,notice:'Yalnız karakter, gün ve eşya toplamları saklanır. Eşya olay geçmişi tutulmaz; tutarlar güncel ortak fiyat tahminidir.'};}
  alertReceipts(characterKey:string):{id:string;itemId:number;quantity:number;value:number|null;verified:boolean}[]{const prices=new Map(this.prices().map(price=>[price.itemId,price.unitPrice]));return this.alerts.filter(alert=>alert.characterKey===characterKey).map(alert=>({...alert,value:prices.get(alert.itemId)==null?null:prices.get(alert.itemId)!*alert.quantity,verified:false}));}
  correctionPreview():AutoFarmCorrectionPreview{return{decoderRevision:3,priceBasis:'current-shared-prices',applied:false,candidates:[],totals:{candidateCount:0,quantity:0,knownCurrentValue:0,currentEstimatedValue:0,unpricedQuantity:0},notice:'Ayrıntılı eşya geçmişi saklanmadığı için geçmiş olay incelemesi bulunmuyor.'};}
  invalidate():void{this.changed();}
  close():void{this.db.prepare("UPDATE compact_farm_characters SET status='stopped' WHERE status='tracking'").run();this.runtime.clear();this.sources.clear();this.lastByStream.clear();this.alerts=[];this.coverage.clear();}
}

export class CompactFinanceDailyStore extends CompactFarmView{
  read(value:unknown):FinanceDailyState{
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['date','characterKey'].includes(key)))throw new Error('Günlük finans sorgusu geçersiz.');
    const query=value as {date:unknown;characterKey?:unknown};if(!isKillDailySelectableDate(query.date))throw new Error('Günlük finans tarihi geçersiz.');
    const key=query.characterKey??null;if(key!==null&&(typeof key!=='string'||!key.length||key.length>512||/[\u0000-\u001f\u007f]/.test(key)))throw new Error('Finans karakter seçimi geçersiz.');
    const date=query.date,prices=this.prices(),items=this.items(date,key,prices),characters=this.characters(date,prices),days=Array.from({length:7},(_,index)=>{const day=shiftKillDailyDate(date,index-6),totals=this.totals(this.items(day,key,prices),day,key);return{date:day,quantity:totals.quantity,knownValue:totals.knownValue,partial:totals.partial,durationMs:totals.durationMs,durationPartial:this.duration(day,key).partial};});
    return{date,timeZone:'Europe/Istanbul',priceBasis:'current-shared-prices',days,undatedQuantity:this.items('',key,prices).reduce((sum,item)=>sum+item.quantity,0),durationPartial:this.duration(date,key).partial,revision:Number(readMeta(this.db,'revision')??0),status:characters.some(character=>character.status==='tracking')?'tracking':characters.at(-1)?.status??'waiting',items,characters,totals:this.totals(items,date,key),prices,notice:'Günlük karakter ve eşya toplamları Türkiye saatine göre saklanır; saatli olay geçmişi tutulmaz. Tarihi bilinmeyen miktarlar yalnız Tümü görünümündedir.'};
  }
}
