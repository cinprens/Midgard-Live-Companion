import type { ReplayEvent } from './types';
import {rareDropCategory} from '../shared/rare-drop';

export interface InventorySlot { slot: number; itemId: number; amount: number }
export interface InventorySeed { known: boolean; slots: InventorySlot[]; rejectedChunks: number }
const MAX_SLOTS = 4096;
const WEIGHT_WINDOW_MS = 1500, FOLLOW_UP_MS = 500;
const PARTY_RECEIPT_WINDOW_MS = 250;
export const INVENTORY_CONTROL_IDS = new Set([0x0b08,0x0b09,0x0b0a,0x0b39,0x0b0b,0x00af,0x07fa,0x01c8,0x0a0a,0x00f6,0x0125,0x00f8,0x00e7,0x01f5,0x00ee,0x00f0,0x012c,0x0b67,0x02b8]);
const safeSlot = (slot: number) => Number.isSafeInteger(slot) && slot >= 0 && slot < MAX_SLOTS;

/** Variable-length RRF item records: strict TLV boundaries, never fixed offsets. */
export function decodeInventorySeed(chunks: readonly { id: number; data: Uint8Array }[]): InventorySeed {
  const slots = new Map<number, InventorySlot>();
  let bagFound = false, rejectedChunks = 0;
  for (const chunk of chunks) {
    if (![4510,4601,4603].includes(chunk.id)) continue;
    if (chunk.id === 4510) bagFound = true;
    if (!chunk.data.length) continue;
    const view = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
    const decoded: InventorySlot[] = [];
    let at = 0, valid = true, records = 0;
    while (at < chunk.data.length && valid) {
      if (++records > MAX_SLOTS || at + 6 > chunk.data.length || view.getUint16(at,true) !== 281 || view.getUint32(at+2,true) !== 0) { valid = false; break; }
      at += 6;
      const fields = new Map<number, number>(); let ended = false;
      for (let count = 0; count < 64 && at + 6 <= chunk.data.length; count++) {
        const tag = view.getUint16(at,true), length = view.getUint32(at+2,true); at += 6;
        if (at + length > chunk.data.length || length > 1024 * 1024) { valid = false; break; }
        if (tag === 282) { ended = length === 0; break; }
        if (tag === 281) { valid = false; break; }
        if ([285,287,291].includes(tag)) {
          if (length !== 4 || fields.has(tag)) { valid = false; break; }
          fields.set(tag, view.getUint32(at,true));
        }
        at += length;
      }
      if (!ended || !valid || ![285,287,291].every(tag => fields.has(tag))) { valid = false; break; }
      const itemId = fields.get(291)!, amount = fields.get(287)!, slot = fields.get(285)! - 2;
      if (!itemId || !amount) continue;
      if (!safeSlot(slot) || amount > 65535) { valid = false; break; }
      decoded.push({slot,itemId,amount});
    }
    if (!valid || at !== chunk.data.length) { rejectedChunks++; continue; }
    for (const item of decoded) {
      const previous = slots.get(item.slot);
      if (previous && (previous.itemId !== item.itemId || previous.amount !== item.amount)) { rejectedChunks++; continue; }
      slots.set(item.slot, item);
    }
  }
  return {known:bagFound && rejectedChunks === 0,slots:[...slots.values()],rejectedChunks};
}

export interface InventoryWeightProof {
  // The scope describes an ACK receipt, possibly amount > 1; no per-item weight is inferred.
  kind:'own-weight-increase';ownerActorId:number;before:number;after:number;
  receiptTimestamp:number;weightTimestamp:number;confirmedAt:number;scope:'receipt-batch';
}
interface PartyPickupProof { ownerId:number; itemId:number; packetOrder:number; timestamp:number; itemType:number; equipLocation:number }
type IncomingEvent={id?:string;eventType:string;timestamp:number;actorId?:number;itemId?:number;amount?:number;confidence?:string;rawData?:Record<string,unknown>};
const actor=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=0xffffffff;
const nonIncome=(event:IncomingEvent)=>['trade','storage','cart','purchase','quest','refresh'].includes(String(event.rawData?.inventorySource));
/** A verified bag delta needs an exclusive weight rise or a matching addressed party pickup. */
export function inventoryConfirmationTime(event: IncomingEvent): number | null {
  const raw=event.rawData;
  if(event.eventType!=='item-obtained'||!actor(event.itemId)||!actor(event.amount)||!actor(event.actorId)||
    !Number.isSafeInteger(event.timestamp)||event.timestamp<0||event.confidence!=='certain'||
    raw?.inventoryAction!=='incoming'||raw.parserProof!=='source-defined-add-delta'||
    raw.quantitySemantics!=='added-delta'||raw.inventoryBaseline!==false)return null;
  const party=raw.partyPickupProof as PartyPickupProof|undefined;
  if(party&&raw.inventorySource==='unknown'&&Number.isSafeInteger(party.packetOrder)&&party.packetOrder>0&&
    event.id===`packet-${party.packetOrder-1}`&&party.ownerId===event.actorId&&party.itemId===event.itemId&&
    party.itemType===raw.itemType&&rareDropCategory(raw.itemType,raw.equipLocation)!==undefined&&
    (party.itemType===6||party.equipLocation===raw.equipLocation)&&
    Number.isSafeInteger(party.timestamp)&&party.timestamp>=event.timestamp&&party.timestamp-event.timestamp<=PARTY_RECEIPT_WINDOW_MS)
    return event.timestamp+FOLLOW_UP_MS;
  const proof=event.rawData?.inventoryWeightProof as Partial<InventoryWeightProof>|undefined;
  if(proof?.kind==='own-weight-increase'&&proof.scope==='receipt-batch'&&proof.ownerActorId===event.actorId&&
    Number.isSafeInteger(proof.before)&&proof.before!>=0&&Number.isSafeInteger(proof.after)&&proof.after!>proof.before!&&
    Number.isSafeInteger(event.timestamp)&&event.timestamp>=0&&proof.receiptTimestamp===event.timestamp&&
    Number.isSafeInteger(proof.weightTimestamp)&&proof.weightTimestamp!>=event.timestamp&&proof.weightTimestamp!-event.timestamp<=WEIGHT_WINDOW_MS&&
    Number.isSafeInteger(proof.confirmedAt)&&proof.confirmedAt===Math.max(event.timestamp+FOLLOW_UP_MS,proof.weightTimestamp!))return proof.confirmedAt;
  return null;
}
export function isReliableInventoryIncoming(event: IncomingEvent): boolean {return inventoryConfirmationTime(event)!==null;}
export function isVerifiedLootIncoming(event:IncomingEvent,playerId?:number|null):boolean {
  return isReliableInventoryIncoming(event)&&event.rawData?.inventorySource==='unknown'&&(playerId===undefined||actor(playerId)&&event.actorId===playerId);
}
interface PendingList { type: number; slots: Map<number,InventorySlot>; valid: boolean }
interface PendingRemoval { itemId: number; amount: number; timestamp: number; reason: number }
interface Receipt { event: ReplayEvent; eligible: boolean; weight?:InventoryWeightProof; party?:PartyPickupProof }
type EventBase = Pick<ReplayEvent,'id'|'timestamp'|'packetId'|'mapId'>;

/** Per-file inventory state; snapshots seed/replace state, never generate income. */
export class InventoryFlow {
  private bag: Map<number,InventorySlot>;
  private containers = new Map<number,Map<number,InventorySlot>>();
  private lists = new Map<number,PendingList>();
  private removals = new Map<number,PendingRemoval>();
  private receipts: Receipt[] = [];
  private pendingWeights=new Set<Receipt>();
  private recent: ReplayEvent[] = [];
  private transfers: {itemId:number;amount:number;source:'storage'|'cart';timestamp:number;type:number}[] = [];
  private unresolvedTransfers: {amount:number|null;timestamp:number;source:'storage'|'cart'}[] = [];
  private unresolvedOverflowUntil = -1;
  private known: boolean;
  private trade = false;
  private tradeUntil = -1;
  private repairUntil = -1;
  private storageType:2|3|null = null;
  private snapshots = 0;
  private rejected = 0;
  private emitted = new Map<string,ReplayEvent>();
  private weight:{amount:number;timestamp:number;owner:number}|null=null;
  constructor(seed: InventorySeed,private options:{maximumPending?:number}={}) { this.known = seed.known; this.bag = new Map(seed.slots.map(slot=>[slot.slot,{...slot}])); }
  mapChanged(timestamp?:number): void {
    if(timestamp!==undefined)this.finalize(timestamp,false);
    this.invalidateWeight('map-change');
    for(const type of this.lists.keys())this.invalidateContainer(type);
    this.lists.clear();this.trade=false;this.storageType=null;
    this.containers.delete(2);this.containers.delete(3);
    this.transfers=[];this.unresolvedTransfers=[];this.unresolvedOverflowUntil=-1;
  }
  /** Initial/invalid/interrupted weight samples cannot fund a receipt in another context. */
  invalidateWeight(reason='weight-context-interrupted'):void {
    this.weight=null;
    for(const receipt of this.pendingWeights)this.rejectWeight(receipt,reason);
  }
  private rejectWeight(receipt:Receipt,reason:string):void {
    if(receipt.party&&['weight-baseline-only','weight-did-not-increase','unmatched-own-weight','ambiguous-weight-receipts'].includes(reason))return;
    receipt.eligible=false;receipt.weight=undefined;this.pendingWeights.delete(receipt);
    const event=receipt.event;
    event.eventType='inventory-ack';event.rawData={...event.rawData,inventoryAction:'acknowledged',parserProof:'excluded-weight-unverified',
      inventoryWeightProof:undefined,replayContextVerified:false,inventoryHistoryReliable:false,pendingInventory:false,excludedReason:reason};
  }
  observeWeight(amount:number,timestamp:number,playerId:number|null|undefined,initial=false):void {
    if(!Number.isSafeInteger(amount)||amount<0||!Number.isSafeInteger(timestamp)||timestamp<0||!actor(playerId)){
      this.invalidateWeight('invalid-own-weight');return;
    }
    this.finalize(timestamp,false);
    const previous=this.weight;
    if(initial||!previous||previous.owner!==playerId||timestamp<previous.timestamp){
      this.invalidateWeight('weight-baseline-only');this.weight={amount,timestamp,owner:playerId};return;
    }
    if(amount<previous.amount)this.invalidateWeight('own-weight-decreased');
    this.weight={amount,timestamp,owner:playerId};
    const pending=[...this.pendingWeights].filter(receipt=>receipt.eligible&&!receipt.weight);
    const candidates=pending.filter(({event})=>event.actorId===playerId&&!nonIncome(event)&&
      event.timestamp>=previous.timestamp&&event.timestamp<=timestamp&&timestamp-event.timestamp<=WEIGHT_WINDOW_MS);
    if(amount>previous.amount&&candidates.length===1){
      const receipt=candidates[0],event=receipt.event;
      receipt.weight={kind:'own-weight-increase',ownerActorId:playerId,before:previous.amount,after:amount,receiptTimestamp:event.timestamp,
        weightTimestamp:timestamp,confirmedAt:Math.max(event.timestamp+FOLLOW_UP_MS,timestamp),scope:'receipt-batch'};
    }
    // One weight change cannot be reused by a later ACK or shared between ambiguous ACKs.
    for(const receipt of pending)if(!receipt.weight)this.rejectWeight(receipt,candidates.length>1?'ambiguous-weight-receipts':amount<=previous.amount?'weight-did-not-increase':'unmatched-own-weight');
  }
  private invalidateContainer(type:number):void {
    if(type===0)this.known=false;
    this.containers.delete(type);
    const pending=this.lists.get(type);if(pending)pending.valid=false;
  }
  private holdUnresolved(event:ReplayEvent):void {
    if(event.rawData?.transferProof||['trade','storage','cart','purchase','quest'].includes(String(event.rawData?.inventorySource))||event.rawData?.parserProof==='excluded-client-refresh')return;
    event.eventType='inventory-ack';
    event.rawData={...event.rawData,inventoryAction:'acknowledged',parserProof:'excluded-unresolved-transfer',inventorySource:'unknown',inventoryHistoryReliable:false,replayContextVerified:false,pendingInventory:false,excludedReason:'unresolved-container-transfer'};
    const receipt=this.receipts.find(value=>value.event===event);if(receipt){receipt.eligible=false;this.pendingWeights.delete(receipt);}
  }
  private evidenceEvents():ReplayEvent[]{return[...new Set([...this.receipts.map(value=>value.event),...this.recent])];}
  private unresolvedTransfer(amount:number|null,timestamp:number,source:'storage'|'cart'):void {
    this.unresolvedTransfers.push({amount,timestamp,source});
    if(this.unresolvedTransfers.length>64){const oldest=this.unresolvedTransfers.shift()!;this.unresolvedOverflowUntil=Math.max(this.unresolvedOverflowUntil,oldest.timestamp+500);}
    for(const event of this.evidenceEvents())if((amount===null||event.amount===amount)&&timestamp-event.timestamp>=0&&timestamp-event.timestamp<=500)this.holdUnresolved(event);
  }
  private exclude(event:ReplayEvent,reason:string):void {
    event.eventType='inventory-ack';event.rawData={...event.rawData,inventoryAction:'refresh',parserProof:'excluded-client-refresh',inventorySource:'refresh',inventoryHistoryReliable:false,replayContextVerified:false,pendingInventory:false,excludedReason:reason};
    const receipt=this.receipts.find(value=>value.event===event);if(receipt){receipt.eligible=false;receipt.weight=undefined;this.pendingWeights.delete(receipt);}
  }
  receipt(event:ReplayEvent,slot:number,itemType:number,initial:boolean):void {
    this.finalize(event.timestamp,false);
    if(this.receipts.length>=(this.options.maximumPending??Infinity))throw new Error('Artımlı envanter takip kapasitesi aşıldı; bekleyen eşya kanıtları atılmadı.');
    const amount=event.amount!,itemId=event.itemId!,before=this.bag.get(slot);
    const gear=[4,5,8,12].includes(itemType);
    const removed=this.removals.get(slot);
    const recentRemoval=removed&&event.timestamp-removed.timestamp>=0&&event.timestamp-removed.timestamp<=500;
    let eligible=this.known&&!initial&&!this.lists.has(0)&&safeSlot(slot)&&actor(event.actorId);
    let source=this.trade||event.timestamp<=this.tradeUntil?'trade':'unknown';
    const transfer=this.transfers.findIndex(value=>value.itemId===itemId&&value.amount===amount&&event.timestamp-value.timestamp>=0&&event.timestamp-value.timestamp<=500);
    const matchedTransfer=transfer>=0?this.transfers.splice(transfer,1)[0]:undefined;
    if(matchedTransfer&&source==='unknown')source=matchedTransfer.source;
    event.rawData={...event.rawData,inventoryAction:'acknowledged',inventorySource:source,quantitySemantics:'added-delta',inventoryBaseline:initial,
      parserProof:'ack-layout-only',replayContextVerified:false,inventoryHistoryReliable:false,skadiVerified:false,
      slot,itemType,beforeAmount:before?.itemId===itemId?before.amount:null};
    if(matchedTransfer)event.rawData={...event.rawData,transferProof:'matching-container-delete',transferContainer:matchedTransfer.type};
    if(initial||this.lists.has(0)) { this.exclude(event,initial?'initial-packet-snapshot':'inventory-list-refresh');eligible=false; }
    else if(event.timestamp<=this.repairUntil||(gear&&before)||(gear&&recentRemoval)) { this.exclude(event,'existing-equipment-or-client-replacement');eligible=false; }
    else if(before&&before.itemId!==itemId) { eligible=false;this.known=false;event.rawData.excludedReason='unexplained-slot-replacement'; }
    if(event.eventType!=='inventory-ack') {
      const quantity=(before?.itemId===itemId?before.amount:0)+amount;
      if(quantity>65535){eligible=false;this.known=false;event.rawData.excludedReason='slot-quantity-overflow';}
      else this.bag.set(slot,{slot,itemId,amount:quantity});
    } else if(gear) this.bag.set(slot,{slot,itemId,amount});
    if(nonIncome(event))eligible=false;
    if(!eligible)this.invalidateWeight('conflicting-inventory-receipt');
    event.eventType='inventory-ack';
    if(eligible)event.rawData={...event.rawData,inventoryAction:'pending',parserProof:'pending-own-weight',pendingInventory:true};
    const receipt={event,eligible};this.receipts.push(receipt);if(eligible)this.pendingWeights.add(receipt);this.recent.push(event);
    if(event.timestamp<=this.unresolvedOverflowUntil||this.unresolvedTransfers.some(value=>(value.amount===null||value.amount===amount)&&event.timestamp-value.timestamp>=0&&event.timestamp-value.timestamp<=500))this.holdUnresolved(event);
    while(this.recent.length>64||this.recent[0]&&event.timestamp-this.recent[0].timestamp>500)this.recent.shift();
    this.transfers=this.transfers.filter(value=>event.timestamp-value.timestamp<=500).slice(-64);
    this.unresolvedTransfers=this.unresolvedTransfers.filter(value=>event.timestamp-value.timestamp<=500).slice(-64);
  }
  control(data:Uint8Array,base:EventBase,playerId:number|null):{handled:boolean;events:ReplayEvent[];error?:string} {
    const view=new DataView(data.buffer,data.byteOffset,data.byteLength),id=view.getUint16(0,true);
    if(id===0x0b67||id===0x02b8){
      // ZC_ITEM_PICKUP_PARTY has no quantity. Pair it only with the immediately
      // preceding eligible bag ACK; that ACK supplies the actual quantity.
      const modern=id===0x0b67,shortId=!modern&&data.length===22;
      if(modern?data.length!==33:(!shortId&&data.length!==32))return{handled:true,events:[],error:'Parti ganimeti mesajının boyutu uyuşmuyor.'};
      const flags=shortId?8:10,itemType=data[modern?30:data.length-1]!;
      const equipLocation=view.getUint16(modern?28:data.length-3,true),category=rareDropCategory(itemType,equipLocation);
      if(!category||!actor(playerId)||view.getUint32(2,true)!==playerId||data[flags]!>1||data[flags+1]!>1)return{handled:true,events:[]};
      const itemId=shortId?view.getUint16(6,true):view.getUint32(6,true),packetOrder=Number(/^packet-(\d+)$/.exec(base.id)?.[1]);
      for(const pending of this.pendingWeights){
        const {event}=pending;
        if(!pending.eligible||event.id!==`packet-${packetOrder-1}`||event.itemId!==itemId||event.actorId!==playerId||
          event.rawData?.inventorySource!=='unknown'||event.rawData.itemType!==itemType||
          rareDropCategory(itemType,event.rawData.equipLocation)!==category||(category==='costume'&&event.rawData.equipLocation!==equipLocation)||
          base.timestamp<event.timestamp||base.timestamp-event.timestamp>PARTY_RECEIPT_WINDOW_MS)continue;
        pending.party={ownerId:playerId,itemId,itemType,equipLocation,packetOrder,timestamp:base.timestamp};break;
      }
      return{handled:true,events:[]};
    }
    if(!INVENTORY_CONTROL_IDS.has(id))return{handled:false,events:[]};
    this.finalize(base.timestamp,false);
    // Lists, transfers, own consumption and removals make a concurrent weight rise ambiguous.
    // Another actor's item-use ACK does not affect this bag.
    const ownUse=id!==0x01c8||(data.length===15||data.length===13)&&playerId!==null&&view.getUint32(data.length===15?8:6,true)===playerId;
    if(ownUse)this.invalidateWeight('inventory-context-changed');
    const invalid=(error:string)=>{
      this.invalidateWeight('invalid-inventory-control');
      this.rejected++;
      if([0x0b08,0x0b09,0x0b0a,0x0b39,0x0b0b].includes(id)){
        const type=id===0x0b0b?(data.length>=3?data[2]:undefined):(data.length>=5?data[4]:undefined);
        if(type!==undefined&&type<=3)this.invalidateContainer(type);
        else for(const pending of this.lists.values())this.invalidateContainer(pending.type);
      }else if(id===0x0a0a||id===0x00f6){if(this.storageType!==null)this.invalidateContainer(this.storageType);}
      else if(id===0x0125)this.invalidateContainer(1);
      return{handled:true,events:[],error};
    };
    const snapshotEvent=(type:number,complete:boolean,count:number):ReplayEvent=>({...base,eventType:'inventory-snapshot',confidence:'certain',attribution:'unknown',rawData:{inventoryAction:'snapshot',inventoryBaseline:true,listType:type,complete,slots:count,personalDrop:false,skadiVerified:false}});
    if(id===0x0b08){
      if(data.length<5||view.getUint16(2,true)!==data.length||data[4]!>3)return invalid('Envanter liste başlangıcı uzunluğu veya türü geçersiz.');
      const type=data[4]!;this.invalidateContainer(type);this.lists.set(type,{type,slots:new Map(),valid:true});if(type===2||type===3)this.storageType=type;
      return{handled:true,events:[]};
    }
    if(id===0x0b09||id===0x0b0a||id===0x0b39){
      const stride=id===0x0b09?34:id===0x0b0a?67:68;
      if(data.length<5||view.getUint16(2,true)!==data.length||data[4]!>3||(data.length-5)%stride)return invalid('Envanter liste kayıt uzunluğu kaynak profiliyle uyuşmuyor.');
      const type=data[4]!,pending=this.lists.get(type);
      if(!pending)return invalid('Envanter listesi başlangıç işareti olmadan geldi; miktarlar gelir sayılmadı.');
      for(let at=5;at<data.length;at+=stride){
        // Bag slots are logical index-2. Other containers keep their own raw
        // wire indices, so no unverified bag/storage offset conversion leaks in.
        const slot=view.getUint16(at,true)-(type===0?2:0),itemId=view.getUint32(at+2,true),amount=id===0x0b09?view.getUint16(at+7,true):1;
        if(!safeSlot(slot)||!itemId||!amount||pending.slots.has(slot)||pending.slots.size>=MAX_SLOTS){pending.valid=false;return invalid('Envanter listesinde yinelenen veya geçersiz slot var.');}
        pending.slots.set(slot,{slot,itemId,amount});
      }
      return{handled:true,events:[]};
    }
    if(id===0x0b0b){
      if(data.length!==4||data[2]!>3)return invalid('Envanter liste sonu uzunluğu veya türü geçersiz.');
      const type=data[2]!,pending=this.lists.get(type);this.lists.delete(type);
      if(!pending||!pending.valid||data[3]!==0)return invalid('Eksik veya başarısız envanter listesi başlangıç yerine kullanılmadı.');
      this.containers.set(type,pending.slots);if(type===0){this.bag=new Map(pending.slots);this.known=true;this.snapshots++;}
      return{handled:true,events:[snapshotEvent(type,true,pending.slots.size)]};
    }
    if(id===0x00e7||id===0x01f5){
      if(data.length!==(id===0x00e7?3:9))return invalid('Ticaret yanıtı paket uzunluğu geçersiz.');
      this.trade=data[2]===3;return{handled:true,events:[]};
    }
    if(id===0x00ee||id===0x00f0){
      if(data.length!==(id===0x00ee?2:3))return invalid('Ticaret sonu paket uzunluğu geçersiz.');
      if(this.trade)this.tradeUntil=base.timestamp+500;this.trade=false;return{handled:true,events:[]};
    }
    if(id===0x00f8){if(data.length!==2)return invalid('Depo kapanış paketi geçersiz.');if(this.storageType!==null)this.containers.delete(this.storageType);this.storageType=null;return{handled:true,events:[]};}
    if(id===0x012c){if(data.length!==3)return invalid('Cart hata bildirimi geçersiz.');this.repairUntil=base.timestamp+500;return{handled:true,events:[]};}
    if(id===0x0a0a){
      if(data.length!==57)return invalid('Depo ekleme paketi desteklenen 57 byte düzeniyle uyuşmuyor.');
      if(this.storageType===null)return invalid('Depo ekleme paketi açık depo türü doğrulanmadan geldi.');
      const type=this.storageType,slot=view.getUint16(2,true),amount=view.getUint32(4,true),itemId=view.getUint32(8,true);
      if(!safeSlot(slot)||!itemId||!amount)return invalid('Depo ekleme slotu, eşya veya miktarı geçersiz.');
      if(this.lists.has(type))return invalid('Depo eklemesi tamamlanmamış listeyle çakıştı; yeni tam depo listesi bekleniyor.');
      const container=this.containers.get(type)??new Map<number,InventorySlot>(),before=container.get(slot);
      if(before&&before.itemId!==itemId||(before?.amount??0)+amount>0xffffffff)return invalid('Depo eklemesi slot içeriğiyle çelişiyor veya miktar sınırını aşıyor.');
      container.set(slot,{slot,itemId,amount:(before?.amount??0)+amount});this.containers.set(type,container);
      return{handled:true,events:[]};
    }
    if(id===0x00f6||id===0x0125){
      const source=id===0x0125?'cart':'storage';
      if(data.length!==8){this.unresolvedTransfer(null,base.timestamp,source);return invalid('Depo/cart çıkarma paketi geçersiz.');}
      const type=id===0x0125?1:this.storageType,container=type===null?undefined:this.containers.get(type),slot=view.getUint16(2,true),amount=view.getUint32(4,true),before=container?.get(slot);
      if(!safeSlot(slot)){this.unresolvedTransfer(amount||null,base.timestamp,source);return invalid('Depo/cart çıkarma slotu geçersiz.');}
      if(amount>0&&before&&amount<=before.amount&&type!==null){
        const match=this.evidenceEvents().reverse().find(event=>!event.rawData?.transferProof&&event.itemId===before.itemId&&event.amount===amount&&base.timestamp-event.timestamp>=0&&base.timestamp-event.timestamp<=500);
        if(match){
          match.rawData={...match.rawData,inventorySource:type===1?'cart':'storage',transferProof:'matching-container-delete',transferContainer:type};
          // A same-timestamp follow-up may arrive after an incremental batch already emitted the receipt.
          this.rejectWeight(this.receipts.find(receipt=>receipt.event===match)??{event:match,eligible:false},'non-loot-inventory-source');
        }
        else {this.transfers.push({itemId:before.itemId,amount,source:type===1?'cart':'storage',timestamp:base.timestamp,type});if(this.transfers.length>64){const oldest=this.transfers.shift()!;this.unresolvedTransfer(oldest.amount,oldest.timestamp,oldest.source);}}
        if(amount>=before.amount)container!.delete(slot);else before.amount-=amount;
      }else if(amount>0){this.unresolvedTransfer(amount,base.timestamp,source);if(before&&type!==null)this.invalidateContainer(type);}
      return{handled:true,events:[]};
    }
    if(id===0x01c8){
      if(data.length!==15&&data.length!==13)return invalid('Eşya kullanım paketi uzunluğu geçersiz.');
      const wide=data.length===15,slot=view.getUint16(2,true)-2,itemId=wide?view.getUint32(4,true):view.getUint16(4,true),actor=view.getUint32(wide?8:6,true),remaining=view.getUint16(wide?12:10,true),success=data[wide?14:12];
      if(success!==0&&success!==1)return invalid('Eşya kullanım sonuç alanı geçersiz.');
      if(success===1&&playerId!==null&&actor===playerId&&safeSlot(slot)){
        const before=this.bag.get(slot);if(before&&before.itemId===itemId){if(remaining===0)this.bag.delete(slot);else before.amount=remaining;}
      }
      return{handled:true,events:[]};
    }
    const length=id===0x07fa?8:6;if(data.length!==length)return invalid('Çantadan çıkarma paketi uzunluğu geçersiz.');
    const reason=id===0x07fa?view.getUint16(2,true):0,slot=view.getUint16(id===0x07fa?4:2,true)-2,amount=view.getUint16(id===0x07fa?6:4,true),before=this.bag.get(slot);
    if(!safeSlot(slot))return invalid('Çantadan çıkarma slotu geçersiz.');
    if(!amount)return{handled:true,events:[]};
    if(before){
      this.removals.set(slot,{itemId:before.itemId,amount,timestamp:base.timestamp,reason});
      if(amount>=before.amount)this.bag.delete(slot);else before.amount-=amount;
      if(base.timestamp<=this.repairUntil){const match=[...this.recent].reverse().find(event=>event.rawData?.slot===slot&&event.amount===amount&&base.timestamp-event.timestamp<=500);if(match)this.exclude(match,'failed-cart-client-repair');}
    }
    return{handled:true,events:[{...base,eventType:'inventory-removal',itemId:before?.itemId,amount,actorId:playerId??undefined,confidence:'certain',attribution:'unknown',rawData:{inventoryAction:'removal',inventorySource:reason===4?'storage':reason===5?'cart':reason===6?'npc':'unknown',reason,slot,personalDrop:false,negativeFarmIncome:false}}]};
  }
  finalize(lastTimestamp:number,closedStream:boolean):void {
    for(const receipt of this.pendingWeights){
      const{event,eligible,weight,party}=receipt;if(!eligible)continue;
      if(!weight&&!party){if(closedStream||lastTimestamp-event.timestamp>WEIGHT_WINDOW_MS)this.rejectWeight(receipt,'missing-own-weight-increase');continue;}
      if(nonIncome(event)){this.rejectWeight(receipt,'non-loot-inventory-source');continue;}
      // Transfer evidence is valid through the inclusive +500ms boundary. A later
      // timestamp proves no further same-boundary packet can arrive in this stream.
      const mature=lastTimestamp>event.timestamp+FOLLOW_UP_MS&&(party!==undefined||lastTimestamp>=weight!.confirmedAt);
      event.eventType=mature?'item-obtained':'inventory-ack';
      event.rawData={...event.rawData,inventoryAction:mature?'incoming':'pending',parserProof:mature?'source-defined-add-delta':'pending-follow-up',inventoryWeightProof:mature?weight:undefined,partyPickupProof:mature?party:undefined,
        inventoryBaseline:false,replayContextVerified:mature,inventoryHistoryReliable:mature,pendingInventory:!mature};
      if(mature)this.pendingWeights.delete(receipt);
      if(closedStream&&!mature)this.rejectWeight(receipt,'incomplete-inventory-follow-up');
    }
  }
  /** Emit revisions while retaining only the protocol follow-up window. Full-file finalize stays unchanged. */
  drainChanges(lastTimestamp:number,closedStream:boolean):{event:ReplayEvent;previous?:ReplayEvent}[] {
    this.finalize(lastTimestamp,closedStream);
    const current=new Map<string,ReplayEvent>();
    for(const receipt of this.receipts)current.set(receipt.event.id,receipt.event);
    for(const event of this.recent)current.set(event.id,event);
    const changes:{event:ReplayEvent;previous?:ReplayEvent}[]=[];
    for(const event of current.values()){
      const previous=this.emitted.get(event.id);
      if(!previous||previous.eventType!==event.eventType||JSON.stringify(previous.rawData)!==JSON.stringify(event.rawData)){
        const copy={...event,rawData:event.rawData?{...event.rawData}:undefined};
        changes.push({event:copy,previous});this.emitted.set(event.id,copy);
      }
    }
    this.receipts=this.receipts.filter(({event,eligible})=>eligible&&event.rawData?.pendingInventory===true&&!closedStream);
    this.recent=this.recent.filter(event=>!closedStream&&lastTimestamp-event.timestamp<=500);
    this.transfers=this.transfers.filter(value=>!closedStream&&lastTimestamp-value.timestamp<=500);
    this.unresolvedTransfers=this.unresolvedTransfers.filter(value=>!closedStream&&lastTimestamp-value.timestamp<=500);
    if(closedStream||lastTimestamp>this.unresolvedOverflowUntil)this.unresolvedOverflowUntil=-1;
    const retained=new Set([...this.receipts.map(value=>value.event.id),...this.recent.map(value=>value.id)]);
    for(const id of this.emitted.keys())if(!retained.has(id))this.emitted.delete(id);
    return changes;
  }
  summary(events:ReplayEvent[]){
    const incoming=events.filter(isReliableInventoryIncoming);
    return{baselineKnown:this.known,incomingCount:incoming.length,incomingQuantity:incoming.reduce((sum,event)=>sum+event.amount!,0),
      excludedRefreshCount:events.filter(event=>event.eventType==='inventory-ack'&&event.rawData?.pendingInventory!==true).length,pendingCount:events.filter(event=>event.rawData?.pendingInventory===true).length,
      snapshotCount:this.snapshots,rejectedPackets:this.rejected,compatibility:'skadi-unverified' as const};
  }
}
