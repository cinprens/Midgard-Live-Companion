import type { DatabaseSync } from 'node:sqlite';
import { createHash,randomUUID } from 'node:crypto';
import path from 'node:path';
import { isVerifiedLootIncoming,type ParsedReplay,type ReplayEvent } from '../src/parser';
import type { CharacterIdentity,LiveStreamStatus } from '../src/shared/types';
import type { AutoFarmCharacter,AutoFarmCorrectionCandidate,AutoFarmCorrectionEvidence,AutoFarmCorrectionPreview,AutoFarmItem,AutoFarmPrice,AutoFarmState,AutoFarmStatus,AutoFarmTimeBasis,AutoFarmTotals,FarmPriceInput } from '../src/shared/auto-farm';
import {replayClockBasis} from '../src/shared/replay-clock-basis';

const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const sourceKey=(source:string)=>digest(path.resolve(source).toLowerCase());
export const AUTOFARM_DECODER_REVISION=3;
export function readAutoFarmCorrectionPreview(db:Pick<DatabaseSync,'prepare'>,localNames:ReadonlyMap<number,string>=new Map()):AutoFarmCorrectionPreview{
  const rows=db.prepare(`SELECT c.receipt_id,c.reason,c.first_detected_at,c.last_detected_at,c.decoder_revision proposed_revision,c.evidence_json,
    r.character_key,r.item_id,r.quantity,r.decoder_revision original_revision,r.inventory_source,s.character_name,
    COALESCE((SELECT name FROM item_database WHERE item_id=r.item_id ORDER BY rowid DESC LIMIT 1),r.item_name) item_name,p.unit_price
    FROM autofarm_correction_candidates c JOIN autofarm_receipts r ON r.id=c.receipt_id
    JOIN autofarm_sessions s ON s.id=r.session_id LEFT JOIN autofarm_prices p ON p.item_id=r.item_id
    WHERE r.excluded_reason IS NULL ORDER BY c.first_detected_at,c.receipt_id`).all();
  const candidates:AutoFarmCorrectionCandidate[]=rows.map(row=>{
    const itemId=Number(row.item_id),quantity=Number(row.quantity),currentUnitPrice=row.unit_price===null?null:Number(row.unit_price),currentEstimatedValue=currentUnitPrice===null?null:quantity*currentUnitPrice;
    const evidence=JSON.parse(String(row.evidence_json)) as AutoFarmCorrectionEvidence;
    const unresolved=row.reason==='unresolved-container-transfer'||evidence.parserProof==='excluded-unresolved-transfer';
    return{receiptId:String(row.receipt_id),characterKey:String(row.character_key),characterName:String(row.character_name),itemId,itemName:String(row.item_name??localNames.get(itemId)??`Eşya #${itemId}`),quantity,
      originalDecoderRevision:Number(row.original_revision),proposedDecoderRevision:Number(row.proposed_revision),originalInventorySource:String(row.inventory_source),reason:String(row.reason),firstDetectedAt:String(row.first_detected_at),lastDetectedAt:String(row.last_detected_at),evidence,
      evidenceStatus:unresolved?'unresolved-transfer':'proven-non-income',evidenceNote:unresolved?'Transfer kaynağı çözülemedi; bu aday kesin bir depo eşleşmesi değildir.':'Yeni çözümleyici bu hareketi farm geliri dışında sınıflandırdı.',
      currentUnitPrice,currentEstimatedValue,proposedQuantityDelta:-quantity,proposedCurrentValueDelta:currentEstimatedValue===null?null:currentEstimatedValue===0?0:-currentEstimatedValue};
  });
  const quantity=candidates.reduce((sum,row)=>sum+row.quantity,0),knownCurrentValue=candidates.reduce((sum,row)=>sum+(row.currentEstimatedValue??0),0),unpricedQuantity=candidates.filter(row=>row.currentUnitPrice===null).reduce((sum,row)=>sum+row.quantity,0);
  return{decoderRevision:AUTOFARM_DECODER_REVISION,priceBasis:'current-shared-prices',applied:false,candidates,totals:{candidateCount:candidates.length,quantity,knownCurrentValue,currentEstimatedValue:unpricedQuantity?null:knownCurrentValue,unpricedQuantity},notice:'Yalnız inceleme önerisidir; eski gelir kayıtları ve toplamları değiştirilmedi. Zeny karşılıkları güncel ortak fiyat tahminidir; geçmiş satış veya edinme fiyatı değildir.'};
}
interface SourceRuntime {sessionId:string;recordingKey:string;characterKey:string;frontier:number;monitorStart:number;baselineCounts:Record<string,number>;anchor:number;intervalId:string;timeBasis:AutoFarmTimeBasis;status:AutoFarmStatus;historyMode:boolean;bootstrapActive?:boolean;bootstrapWindowEnd?:number;}
export interface AutoFarmObservation {
  sourcePath:string;streamId:string;hash:string;recordingId:string;recordingReset?:boolean;observedAt?:string;
  /** Only enable after the parser proves complete initial inventory context for historical deltas. */
  includeReplayHistory?:boolean;
  /** Existing contents are being replayed in batches, rather than newly appended live. */
  bootstrap?:boolean;
}
const status=(state:LiveStreamStatus):AutoFarmStatus=>state==='paused'?'paused':state==='stopped'?'stopped':state==='missing'?'missing':state==='error'?'unavailable':'tracking';
export function unionFarmMilliseconds(intervals:readonly [number,number][]):number{
  const sorted=intervals.filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).map(span=>[...span] as [number,number]).sort((a,b)=>a[0]-b[0]);let total=0,start=0,end=0,found=false;
  for(const[a,b]of sorted){if(!found||a>end){if(found)total+=end-start;start=a;end=b;found=true;}else end=Math.max(end,b);}return total+(found?end-start:0);
}
function semantic(event:ReplayEvent):string{return digest(JSON.stringify([event.timestamp,event.itemId,event.amount,event.rawData?.slot]));}
export class AutoFarmStore {
  private runtime=new Map<string,SourceRuntime>();
  private revision=0;
  private cache:AutoFarmState|undefined;
  private localNames=new Map<number,string>();
  constructor(private db:DatabaseSync){
    // A previous process cannot remain active. Existing quantities/intervals stay intact.
    this.db.prepare("UPDATE autofarm_sessions SET status='stopped' WHERE status='tracking'").run();
    this.revision=Number(this.db.prepare("SELECT value FROM finance_metadata WHERE key='autofarm_revision'").get()?.value??0);
  }
  private transaction<T>(action:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=action();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private changed():void{this.revision++;this.cache=undefined;this.db.prepare("INSERT INTO finance_metadata VALUES('autofarm_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(this.revision));}
  setPrice(input:FarmPriceInput):void{
    if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['itemId','unitPrice'].includes(key))||!Number.isSafeInteger(input.itemId)||input.itemId<1||input.itemId>0xffffffff||input.unitPrice!==null&&(typeof input.unitPrice!=='number'||!Number.isFinite(input.unitPrice)||input.unitPrice<0||input.unitPrice>1e12))throw new Error('Eşya kimliği ve sıfır veya pozitif birim fiyat gerekli; fiyatı kaldırmak için boş bırakın.');
    this.transaction(()=>{this.db.prepare('INSERT INTO autofarm_prices VALUES(?,?,?) ON CONFLICT(item_id) DO UPDATE SET unit_price=excluded.unit_price,updated_at=excluded.updated_at').run(input.itemId,input.unitPrice,new Date().toISOString());this.changed();});
  }
  setLocalItemNames(names:Map<number,string>):void{this.localNames=new Map(names);this.revision++;this.cache=undefined;}
  observe(parsed:ParsedReplay,meta:AutoFarmObservation,character:CharacterIdentity):void{
    const delta=parsed.incremental?.delta===true;
    const key=sourceKey(meta.sourcePath),now=Date.parse(meta.observedAt??new Date().toISOString());let edge=delta&&Number.isFinite(parsed.summary.durationMs)?Math.max(0,parsed.summary.durationMs):0;
    for(const event of parsed.events)if(Number.isFinite(event.timestamp)&&event.timestamp>=0)edge=Math.max(edge,event.timestamp);
    const strong=parsed.summary.startedAt!==null&&parsed.summary.playerId!==null&&parsed.summary.characterName!==null;
    const recordingKey=digest(strong?JSON.stringify([parsed.summary.startedAt,parsed.summary.playerId,parsed.summary.characterName]):`${key}:${meta.recordingId}`);
    const previous=this.runtime.get(key),baseline=!previous||previous.recordingKey!==recordingKey||previous.characterKey!==character.key||meta.recordingReset;
    if(!baseline&&edge<previous.frontier){if(!delta)return;edge=previous.frontier;}
    const incoming=parsed.events.filter(event=>Number.isFinite(event.timestamp)&&event.timestamp>=0&&['item-obtained','inventory-ack'].includes(event.eventType)&&Number.isSafeInteger(event.itemId)&&Number(event.itemId)>0&&Number.isSafeInteger(event.amount)&&Number(event.amount)>0).sort((a,b)=>a.timestamp-b.timestamp);
    let entry=previous;
    this.transaction(()=>{
      if(baseline){
        if(previous)this.finishRuntime(previous,'stopped');
        const saved=this.db.prepare('SELECT * FROM autofarm_cursors WHERE source_key=?').get(key);
        let existing=!meta.recordingReset?this.db.prepare('SELECT id FROM autofarm_sessions WHERE character_key=? AND recording_key=? ORDER BY rowid DESC LIMIT 1').get(character.key,recordingKey):undefined;
        if(saved?.recording_key===recordingKey&&!meta.recordingReset)existing=this.db.prepare('SELECT id FROM autofarm_sessions WHERE id=? AND character_key=?').get(String(saved.session_id),character.key)??existing;
        const sessionId=existing?String(existing.id):randomUUID();
        const started=parsed.summary.startedAt,absolute=started!==null&&/(?:Z|[+-]\d{2}:\d{2})$/.test(started)?Date.parse(started):NaN;
        const timeBasis:AutoFarmTimeBasis=Number.isFinite(absolute)?'replay-start':'observation-anchor';
        const continuing=saved?.recording_key===recordingKey&&!meta.recordingReset;
        if(delta&&continuing)edge=Math.max(edge,Number(saved.last_replay_ms));
        const anchor=Number.isFinite(absolute)?absolute:continuing&&saved.anchor_ms!==null?Number(saved.anchor_ms):now-edge;
        const history=meta.includeReplayHistory===true||continuing&&Number(saved.history_mode)===1;
        const monitorStart=continuing&&saved.monitor_start_ms!==null?Number(saved.monitor_start_ms):edge;
        const baselineCounts:Record<string,number>=continuing&&saved.monitor_start_ms!==null?JSON.parse(String(saved.baseline_counts_json)):{};
        if(!continuing||saved.monitor_start_ms===null){let retained=0;for(const event of parsed.events)if(event.eventType==='item-obtained'&&event.timestamp===monitorStart){const fingerprint=semantic(event),occurrence=delta?this.deltaOccurrence(event):1;if(fingerprint in baselineCounts)baselineCounts[fingerprint]=delta?Math.max(baselineCounts[fingerprint],occurrence):baselineCounts[fingerprint]+1;else if(retained++<4096)baselineCounts[fingerprint]=occurrence;else baselineCounts._saturated=1;}}
        const intervalId=randomUUID(),from=history?0:edge;
        this.db.prepare('INSERT INTO autofarm_sessions VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET character_name=excluded.character_name,status=excluded.status,updated_at=excluded.updated_at').run(sessionId,character.key,character.name,recordingKey,timeBasis,'tracking',new Date(now).toISOString());
        this.db.prepare('INSERT INTO autofarm_intervals VALUES(?,?,?,?,?)').run(intervalId,sessionId,key,anchor+from,anchor+edge);
        entry={sessionId,recordingKey,characterKey:character.key,frontier:edge,monitorStart,baselineCounts,anchor,intervalId,timeBasis,status:'tracking',historyMode:history,bootstrapWindowEnd:continuing&&saved.monitor_start_ms!==null?Number(saved.last_replay_ms):monitorStart};
      }
      const current=entry!,occurrences=new Map<string,number>();let seenTime=-1;
      if(delta&&meta.bootstrap){
        const monitoredThrough=current.bootstrapWindowEnd??current.frontier;
        if(!current.bootstrapActive&&monitoredThrough>current.monitorStart){const windows=Object.keys(current.baselineCounts).filter(key=>key.startsWith('_window:'));if(windows.length<64)current.baselineCounts[`_window:${current.monitorStart}:${monitoredThrough}`]=1;}
        if(edge>current.monitorStart)current.monitorStart=edge;
        for(const event of incoming)if(event.timestamp===current.monitorStart){const fingerprint=semantic(event),occurrence=this.deltaOccurrence(event);if(fingerprint in current.baselineCounts||Object.keys(current.baselineCounts).length<4096)current.baselineCounts[fingerprint]=Math.max(current.baselineCounts[fingerprint]??0,occurrence);else current.baselineCounts._saturated=1;}
      }
      current.bootstrapWindowEnd=undefined;
      current.bootstrapActive=delta&&meta.bootstrap===true;
      const monitoredWindows=delta?Object.keys(current.baselineCounts).filter(key=>key.startsWith('_window:')).map(key=>key.split(':').slice(1).map(Number)):[];
      const insertReceipt=this.db.prepare('INSERT OR IGNORE INTO autofarm_receipts(id,session_id,character_key,item_id,quantity,event_ms,recorded_at,source_hash,inventory_source,confidence,item_name,decoder_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'),findName=this.db.prepare('SELECT name FROM item_database WHERE item_id=? ORDER BY rowid DESC LIMIT 1'),increaseTotal=this.db.prepare('INSERT INTO autofarm_item_totals VALUES(?,?,?,?) ON CONFLICT(character_key,item_id) DO UPDATE SET quantity=quantity+excluded.quantity,item_name=COALESCE(excluded.item_name,item_name)'),findAccepted=this.db.prepare('SELECT character_key,item_id,quantity,decoder_revision FROM autofarm_receipts WHERE id=? AND excluded_reason IS NULL'),exclude=this.db.prepare('UPDATE autofarm_receipts SET excluded_reason=? WHERE id=? AND excluded_reason IS NULL'),reduce=this.db.prepare('UPDATE autofarm_item_totals SET quantity=MAX(0,quantity-?) WHERE character_key=? AND item_id=?');
      const proposeCorrection=this.db.prepare(`INSERT INTO autofarm_correction_candidates VALUES(?,?,?,?,?,?)
        ON CONFLICT(receipt_id) DO UPDATE SET reason=excluded.reason,last_detected_at=MAX(last_detected_at,excluded.last_detected_at),decoder_revision=excluded.decoder_revision,evidence_json=excluded.evidence_json`);
      for(const event of incoming){
        if(event.timestamp!==seenTime){occurrences.clear();seenTime=event.timestamp;}
        const fingerprint=semantic(event),count=delta?this.deltaOccurrence(event):(occurrences.get(fingerprint)??0)+1;occurrences.set(fingerprint,count);
        const eventId=digest(`${recordingKey}:${fingerprint}:${count}`),knownExcluded=['trade','storage','cart','purchase','quest'].includes(String(event.rawData?.inventorySource))||['excluded-client-refresh','excluded-unresolved-transfer'].includes(String(event.rawData?.parserProof));
        if(knownExcluded){
          const accepted=findAccepted.get(eventId);
          if(accepted){
            const reason=String(event.rawData?.excludedReason??event.rawData?.inventorySource??'proven-non-income');
            if(Number(accepted.decoder_revision)!==AUTOFARM_DECODER_REVISION){
              // Re-decoding an older receipt can propose a correction, never silently change its ledger total.
              const evidence:AutoFarmCorrectionEvidence={sourcePath:meta.sourcePath,streamId:meta.streamId,sourceHash:meta.hash,recordingId:meta.recordingId,eventId:event.id,packetId:event.packetId??null,eventTimestamp:event.timestamp,inventorySource:String(event.rawData?.inventorySource??'unknown'),parserProof:typeof event.rawData?.parserProof==='string'?event.rawData.parserProof:null,transferProof:typeof event.rawData?.transferProof==='string'?event.rawData.transferProof:null,transferContainer:typeof event.rawData?.transferContainer==='number'?event.rawData.transferContainer:null};
              const detectedAt=new Date(now).toISOString();proposeCorrection.run(eventId,reason,detectedAt,detectedAt,AUTOFARM_DECODER_REVISION,JSON.stringify(evidence));
            }else if(Number(exclude.run(reason,eventId).changes)>0)reduce.run(Number(accepted.quantity),String(accepted.character_key),Number(accepted.item_id));
          }
          continue;
        }
        // Missing new weight evidence is not proof that a legacy receipt was wrong.
        // Only the explicit transfer/refresh branch above may propose or apply a correction.
        if(event.rawData?.inventorySource!=='unknown'||!isVerifiedLootIncoming(event,parsed.summary.playerId))continue;
        const historyProof=event.rawData?.inventoryHistoryReliable===true;
        const priorMonitoring=monitoredWindows.some(([start,end])=>event.timestamp>start&&event.timestamp<=end||event.timestamp===start&&event.timestamp<=end&&!current.baselineCounts._saturated&&count>(current.baselineCounts[fingerprint]??0));
        const afterMonitoring=priorMonitoring||event.timestamp>current.monitorStart||event.timestamp===current.monitorStart&&!current.baselineCounts._saturated&&count>(current.baselineCounts[fingerprint]??0);
        if(!historyProof&&!afterMonitoring)continue;
        if(historyProof)current.historyMode=true;
        const itemName=findName.get(event.itemId!)?.name??this.localNames.get(event.itemId!)??null;
        const inserted=insertReceipt.run(eventId,current.sessionId,character.key,event.itemId!,event.amount!,event.timestamp,new Date(now).toISOString(),meta.hash,String(event.rawData?.inventorySource??'unknown'),'decoded-skadi-unverified',itemName as string|null,AUTOFARM_DECODER_REVISION);
        if(Number(inserted.changes)>0)increaseTotal.run(character.key,event.itemId!,event.amount!,itemName as string|null);
      }
      current.frontier=Math.max(current.frontier,edge);current.status='tracking';
      this.db.prepare('UPDATE autofarm_intervals SET start_ms=MIN(start_ms,?),end_ms=MAX(end_ms,?) WHERE id=?').run(current.historyMode?current.anchor:current.anchor+current.monitorStart,current.anchor+edge,current.intervalId);
      // Calendar dates have their own explicit clock provenance. Legacy accounting
      // anchors and durations remain byte-for-byte unchanged by this projection.
      const calendar=replayClockBasis(parsed.summary.startedAt);
      if(calendar.anchorMs!==null){
        this.db.prepare('INSERT OR IGNORE INTO finance_calendar_sessions VALUES(?,?,?,?,?,?,0)').run(current.sessionId,calendar.anchorMs,calendar.rawStartedAt,calendar.timeZone,calendar.version,'replay-header');
        this.db.prepare('UPDATE finance_calendar_sessions SET conflicting=1 WHERE session_id=? AND anchor_ms<>?').run(current.sessionId,calendar.anchorMs);
        this.db.prepare('INSERT INTO finance_calendar_intervals VALUES(?,?,?,?) ON CONFLICT(interval_id) DO UPDATE SET start_ms=MIN(start_ms,excluded.start_ms),end_ms=MAX(end_ms,excluded.end_ms)').run(current.intervalId,current.sessionId,calendar.anchorMs+(current.historyMode?0:current.monitorStart),calendar.anchorMs+edge);
      }
      this.db.prepare('UPDATE autofarm_sessions SET status=?,updated_at=?,character_name=? WHERE id=?').run('tracking',new Date(now).toISOString(),character.name,current.sessionId);
      this.db.prepare('INSERT INTO autofarm_cursors VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET session_id=excluded.session_id,recording_key=excluded.recording_key,last_replay_ms=excluded.last_replay_ms,monitor_start_ms=excluded.monitor_start_ms,baseline_counts_json=excluded.baseline_counts_json,anchor_ms=excluded.anchor_ms,history_mode=excluded.history_mode').run(key,current.sessionId,recordingKey,current.frontier,current.monitorStart,JSON.stringify(current.baselineCounts),current.anchor,current.historyMode?1:0);
      this.changed();
    });this.runtime.set(key,entry!);
  }
  correctionPreview():AutoFarmCorrectionPreview{return readAutoFarmCorrectionPreview(this.db,this.localNames);}
  private deltaOccurrence(event:ReplayEvent):number{
    const value=event.rawData?.inventoryOccurrence;
    if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new Error('Artımlı envanter olayının kalıcı tekrar kimliği eksik.');
    return value;
  }
  private finishRuntime(entry:SourceRuntime,state:AutoFarmStatus):void{entry.status=state;this.db.prepare('UPDATE autofarm_sessions SET status=? WHERE id=?').run(state,entry.sessionId);}
  suspend(sourcePath:string,state:AutoFarmStatus='paused'):void{
    const key=sourceKey(sourcePath),entry=this.runtime.get(key);if(!entry)return;
    this.transaction(()=>{this.finishRuntime(entry,state);this.db.prepare('UPDATE autofarm_cursors SET monitor_start_ms=NULL WHERE source_key=?').run(key);this.changed();});this.runtime.delete(key);
  }
  syncStatuses(streams:{sourcePath:string;status:LiveStreamStatus}[]):void{
    const known=new Set(streams.map(stream=>sourceKey(stream.sourcePath)));
    for(const stream of streams)if(['paused','stopped','missing','error'].includes(stream.status))this.suspend(stream.sourcePath,status(stream.status));
    for(const[key,entry]of this.runtime)if(!known.has(key)){this.transaction(()=>{this.finishRuntime(entry,'stopped');this.changed();});this.runtime.delete(key);}
  }
  private items(rows:Record<string,unknown>[],prices:Map<number,number|null>):AutoFarmItem[]{return rows.map(row=>{const itemId=Number(row.item_id),quantity=Number(row.quantity),unitPrice=prices.get(itemId)??null;return{itemId,itemName:String(row.name??this.localNames.get(itemId)??`Eşya #${itemId}`),quantity,unitPrice,value:unitPrice===null?null:quantity*unitPrice,sourceLabel:'Çantaya gelen eşya' as const};});}
  private totals(items:AutoFarmItem[],spans:[number,number][],basis:AutoFarmTimeBasis,available:boolean):AutoFarmTotals{
    const durationMs=unionFarmMilliseconds(spans),knownValue=items.reduce((sum,item)=>sum+(item.value??0),0),unpriced=items.filter(item=>item.unitPrice===null),partial=unpriced.length>0;
    return{knownValue,estimatedValue:available&&!partial?knownValue:null,hourlyValue:available&&!partial&&durationMs>0?knownValue*3600000/durationMs:null,knownHourlyValue:available&&durationMs>0?knownValue*3600000/durationMs:null,durationMs,unpricedItems:unpriced.length,unpricedQuantity:unpriced.reduce((sum,item)=>sum+item.quantity,0),partial,quantity:items.reduce((sum,item)=>sum+item.quantity,0),distinctItems:items.length,timeBasis:basis};
  }
  snapshot():AutoFarmState{
    if(this.cache)return this.cache;
    const prices=this.db.prepare('SELECT * FROM autofarm_prices ORDER BY item_id').all().map(row=>({itemId:Number(row.item_id),unitPrice:row.unit_price===null?null:Number(row.unit_price),updatedAt:String(row.updated_at)})),priceMap=new Map(prices.map(row=>[row.itemId,row.unitPrice]));
    const sessions=this.db.prepare('SELECT * FROM autofarm_sessions ORDER BY rowid').all(),intervals=this.db.prepare('SELECT i.*,s.character_key FROM autofarm_intervals i JOIN autofarm_sessions s ON s.id=i.session_id').all();
    const names="COALESCE((SELECT name FROM item_database d WHERE d.item_id=r.item_id ORDER BY rowid DESC LIMIT 1),r.item_name)";
    const grouped=this.db.prepare(`SELECT r.character_key,r.item_id,r.quantity,${names} name FROM autofarm_item_totals r WHERE r.quantity>0 ORDER BY r.item_id`).all();
    const allItems=this.items(this.db.prepare(`SELECT r.item_id,SUM(quantity) quantity,${names} name FROM autofarm_item_totals r WHERE r.quantity>0 GROUP BY r.item_id ORDER BY r.item_id`).all(),priceMap);
    const allSpans=intervals.map(row=>[Number(row.start_ms),Number(row.end_ms)] as [number,number]);
    const bases=[...new Set(sessions.map(row=>String(row.time_basis)))];const basis:AutoFarmTimeBasis=bases.length===1?bases[0] as AutoFarmTimeBasis:'mixed';
    const characters:AutoFarmCharacter[]=[...new Set(sessions.map(row=>String(row.character_key)))].map(key=>{
      const own=sessions.filter(row=>row.character_key===key),latest=own.at(-1)!,items=this.items(grouped.filter(row=>row.character_key===key),priceMap),spans=intervals.filter(row=>row.character_key===key).map(row=>[Number(row.start_ms),Number(row.end_ms)] as [number,number]),available=items.length>0;
      return{characterKey:key,characterName:String(latest.character_name),sessionId:String(latest.id),status:latest.status as AutoFarmStatus,available,items,totals:this.totals(items,spans,own.every(row=>row.time_basis===own[0].time_basis)?own[0].time_basis as AutoFarmTimeBasis:'mixed',available)};
    });
    return this.cache={revision:this.revision,status:characters.some(row=>row.status==='tracking')?'tracking':characters.at(-1)?.status??'waiting',items:allItems,characters,totals:this.totals(allItems,allSpans,basis,allItems.length>0),prices,notice:'Çantaya gelen eşyalar ortak fiyatlarla değerlenir. Başlangıç eşyaları ve tanınan depo/ticaret hareketleri toplam dışında kalır. Saatlik değer, paralel karakterlerin ortak Replay süresiyle hesaplanır.'};
  }
  alertReceipts(characterKey:string):{id:string;itemId:number;quantity:number;value:number|null;verified:boolean}[]{return this.db.prepare("SELECT r.id,r.item_id,r.quantity,p.unit_price FROM autofarm_receipts r LEFT JOIN autofarm_prices p ON p.item_id=r.item_id WHERE r.character_key=? AND r.excluded_reason IS NULL AND r.decoder_revision=? AND r.inventory_source='unknown' ORDER BY r.recorded_at DESC,r.rowid DESC LIMIT 2048").all(characterKey,AUTOFARM_DECODER_REVISION).map(row=>({id:String(row.id),itemId:Number(row.item_id),quantity:Number(row.quantity),value:row.unit_price===null?null:Number(row.quantity)*Number(row.unit_price),verified:false})).reverse();}
  invalidate():void{this.cache=undefined;}
  close():void{for(const entry of this.runtime.values())this.finishRuntime(entry,'stopped');this.runtime.clear();this.cache=undefined;}
}
