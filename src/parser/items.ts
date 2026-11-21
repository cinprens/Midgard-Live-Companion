import type { ItemObservationSummary, ReplayEvent } from './types';
import {isVerifiedLootIncoming} from './inventory';

export const ITEM_PACKET_IDS = new Set([0x009d,0x009e,0x084b,0x0add,0x00a1,0x0a37,0x0b41]);
type Ground = { kind:'ground'; groundEntityId:number; itemId:number; amount:number; x:number; y:number; appearance:'entry'|'fall' };
type Obtained = { kind:'obtained'; itemId:number; amount:number; slot:number; result:0; itemType:number; equipLocation:number };
export type ItemPacket = Ground | Obtained | {kind:'disappear';groundEntityId:number} | {kind:'failed';result:number;slot:number} | {kind:'invalid';reason:string};

/** Independent decoding of published wire fields; no rAthena implementation is copied. */
export function decodeItemObservation(data:Uint8Array):ItemPacket|null {
  if(data.byteLength<2)return null;
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  const packet=view.getUint16(0,true);if(!ITEM_PACKET_IDS.has(packet))return null;
  const invalid=(reason:string):ItemPacket=>({kind:'invalid',reason});
  if(packet===0x00a1)return data.byteLength===6?{kind:'disappear',groundEntityId:view.getUint32(2,true)}:invalid('Yerdeki eşya kaybolma paketi tam 6 byte olmalıdır.');
  if(packet===0x0a37||packet===0x0b41){
    // 0a37: 16-bit name/card IDs (59 B) or 32-bit name/card IDs (69 B).
    // 0b41: 32-bit IDs, refine/grade moved to the tail (70 B).
    const legacy=packet===0x0a37&&data.byteLength===59;
    if(!(legacy||(packet===0x0a37&&data.byteLength===69)||(packet===0x0b41&&data.byteLength===70)))return invalid('Eşya edinme paketi doğrulanmış 59/69/70 byte düzenlerinden biriyle uyuşmuyor.');
    const resultOffset=legacy?24:packet===0x0a37?34:33;
    const result=view.getUint8(resultOffset);const slot=view.getUint16(2,true);
    if(result!==0)return{kind:'failed',result,slot};
    const itemId=legacy?view.getUint16(6,true):view.getUint32(6,true);const amount=view.getUint16(4,true);
    const flagAt=legacy?8:10;
    if(!itemId||!amount||slot<2||data[flagAt]!>1||data[flagAt+1]!>1)return invalid('Başarılı eşya edinme paketinde kimlik, miktar, slot veya durum alanı geçersiz.');
    return{kind:'obtained',itemId,amount,slot:slot-2,result:0,itemType:view.getUint8(resultOffset-1),equipLocation:view.getUint32(resultOffset-5,true)};
  }
  const entry=packet===0x009d;
  const item32=(packet===0x0add&&data.byteLength===24)||(entry&&data.byteLength===19);
  const expected=packet===0x009d||packet===0x009e?17:packet===0x084b?19:22;
  if(data.byteLength!==expected&&!item32)return invalid('Yerdeki eşya paketi doğrulanmış uzunlukla uyuşmuyor.');
  const groundEntityId=view.getUint32(2,true);const itemId=item32?view.getUint32(6,true):view.getUint16(6,true);
  const identifiedAt=item32?(entry?10:12):packet===0x009d||packet===0x009e?8:10;
  const x=view.getInt16(identifiedAt+1,true),y=view.getInt16(identifiedAt+3,true);
  const amount=view.getInt16(identifiedAt+(entry?5:7),true);
  if(!groundEntityId||!itemId||amount<=0||data[identifiedAt]!>1||x<0||y<0)return invalid('Yerdeki eşya paketinde kimlik, miktar, durum veya konum geçersiz.');
  return{kind:'ground',groundEntityId,itemId,amount,x,y,appearance:entry?'entry':'fall'};
}

export function summarizeItemObservations(events:ReplayEvent[]):ItemObservationSummary {
  const summary:ItemObservationSummary={groundCount:0,groundQuantity:0,obtainedCount:0,obtainedQuantity:0,personalDropCount:null,confidence:'observed-only',items:[]};
  const items=new Map<number,ItemObservationSummary['items'][number]>();const seen=new Set<string>();
  for(const event of events){
    if(seen.has(event.id)||!event.itemId||!Number.isFinite(event.amount)||event.amount!<=0)continue;
    seen.add(event.id);if(event.eventType!=='item-ground'&&event.eventType!=='item-obtained')continue;
    if(event.eventType==='item-obtained'&&!isVerifiedLootIncoming(event))continue;
    const row=items.get(event.itemId)??{itemId:event.itemId,groundCount:0,groundQuantity:0,obtainedCount:0,obtainedQuantity:0};
    items.set(event.itemId,row);
    if(event.eventType==='item-ground'){summary.groundCount++;summary.groundQuantity+=event.amount!;row.groundCount++;row.groundQuantity+=event.amount!;}
    else{summary.obtainedCount++;summary.obtainedQuantity+=event.amount!;row.obtainedCount++;row.obtainedQuantity+=event.amount!;}
  }
  summary.items=[...items.values()].sort((a,b)=>b.obtainedQuantity-a.obtainedQuantity||b.groundQuantity-a.groundQuantity||a.itemId-b.itemId);return summary;
}
