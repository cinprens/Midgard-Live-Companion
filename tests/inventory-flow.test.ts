import {describe,expect,it} from 'vitest';
import {decodeInventorySeed,InventoryFlow,isReliableInventoryIncoming,parseReplay} from '../src/parser';
import type {ReplayEvent} from '../src/parser/types';
const bytes=(size:number)=>new Uint8Array(size);
const view=(data:Uint8Array)=>new DataView(data.buffer,data.byteOffset,data.byteLength);
const packet=(id:number,size:number)=>{const data=bytes(size);view(data).setUint16(0,id,true);return data;};
const concat=(...parts:Uint8Array[])=>{const output=bytes(parts.reduce((sum,part)=>sum+part.length,0));let at=0;for(const part of parts){output.set(part,at);at+=part.length;}return output;};
const u32=(n:number)=>{const data=bytes(4);view(data).setUint32(0,n,true);return data;};
const tlv=(tag:number,data:Uint8Array)=>{const head=bytes(6);view(head).setUint16(0,tag,true);view(head).setUint32(2,data.length,true);return concat(head,data);};
const record=(slot:number,itemId:number,amount:number,name='')=>concat(tlv(281,bytes(0)),tlv(285,u32(slot+2)),tlv(287,u32(amount)),tlv(291,u32(itemId)),tlv(292,new TextEncoder().encode(name)),tlv(282,bytes(0)));
const seed=(amount=20)=>decodeInventorySeed([{id:4510,data:record(5,501,amount)}]);
const receipt=(timestamp:number,amount=3,itemId=501,slot=5):ReplayEvent=>({id:`a-${timestamp}-${slot}`,timestamp,eventType:'item-obtained',actorId:42,itemId,amount,packetId:'0x0b41',confidence:'certain',rawData:{}});
function start(type=0){const data=packet(0x0b08,5);view(data).setUint16(2,5,true);data[4]=type;return data;}
function end(type=0){const data=packet(0x0b0b,4);data[2]=type;return data;}
function list(type=0,slot=7,itemId=501,amount=20){const data=packet(0x0b09,39);view(data).setUint16(2,data.length,true);data[4]=type;view(data).setUint16(5,slot,true);view(data).setUint32(7,itemId,true);data[11]=3;view(data).setUint16(12,amount,true);return data;}
function remove(timestamp:number,slot=5,amount=3,reason=0){const data=packet(0x07fa,8);view(data).setUint16(2,reason,true);view(data).setUint16(4,slot+2,true);view(data).setUint16(6,amount,true);return{data,base:{id:`r-${timestamp}`,timestamp,packetId:'0x07fa'}};}
function control(flow:InventoryFlow,data:Uint8Array,timestamp=0,owner=42){return flow.control(data,{id:`p-${timestamp}`,timestamp},owner);}
function containerDelete(id:number,slot:number,amount:number){const data=packet(id,8);view(data).setUint16(2,slot,true);view(data).setUint32(4,amount,true);return data;}
function storageAdd(slot=299,amount=3,itemId=501){const data=packet(0x0a0a,57);view(data).setUint16(2,slot,true);view(data).setUint32(4,amount,true);view(data).setUint32(8,itemId,true);data[12]=3;data[13]=1;return data;}

describe('RRF inventory snapshot is baseline, never income',()=>{
  it('walks variable-length TLV records including custom names instead of guessing fixed strides',()=>{
    const data=concat(record(5,501,20),record(8,912,125,'Çağrı özel eşya'));
    expect(decodeInventorySeed([{id:4510,data}])).toMatchObject({known:true,rejectedChunks:0,slots:[{slot:5,itemId:501,amount:20},{slot:8,itemId:912,amount:125}]});
  });
  it('rejects broken chains, duplicate conflicting slots and missing bag context',()=>{
    expect(decodeInventorySeed([{id:4510,data:record(5,501,20).subarray(0,30)}]).known).toBe(false);
    expect(decodeInventorySeed([{id:4510,data:concat(record(5,501,20),record(5,912,1))}]).known).toBe(false);
    expect(decodeInventorySeed([{id:4516,data:record(5,501,20)}]).known).toBe(false);
  });
  it('keeps a valid empty bag and duplicated equipped views separate from receipts',()=>{
    expect(decodeInventorySeed([{id:4510,data:bytes(0)}])).toMatchObject({known:true,slots:[]});
    expect(decodeInventorySeed([{id:4510,data:record(5,501,1)},{id:4601,data:record(5,501,1)}]).slots).toHaveLength(1);
  });
});
describe('verified delta receipts and conservative refresh exclusions',()=>{
  it('counts the added delta, not the whole prior stack, and supports history only with context',()=>{
    const flow=new InventoryFlow(seed()),event=receipt(100,125);flow.observeWeight(1000,0,42);flow.receipt(event,5,3,false);flow.observeWeight(1125,101,42);flow.finalize(1000,false);
    expect(event).toMatchObject({amount:125,rawData:{beforeAmount:20,inventoryAction:'incoming',quantitySemantics:'added-delta',inventoryHistoryReliable:true,replayContextVerified:true,skadiVerified:false}});
    expect(isReliableInventoryIncoming(event)).toBe(true);
    expect(flow.summary([event]).incomingQuantity).toBe(125);
  });
  it('keeps an ACK without a bag baseline out of automatic valuation',()=>{
    const flow=new InventoryFlow({known:false,slots:[],rejectedChunks:0}),event=receipt(100);flow.receipt(event,5,3,false);flow.finalize(1000,true);
    expect(event.eventType).toBe('inventory-ack');expect(event.rawData?.parserProof).toBe('ack-layout-only');expect(isReliableInventoryIncoming(event)).toBe(false);
  });
  it('never counts initial packet ACKs, existing equipment display or replacement as incoming',()=>{
    const flow=new InventoryFlow(seed()),initial=receipt(0),gear=receipt(100);
    flow.receipt(initial,5,3,true);flow.receipt(gear,5,5,false);flow.finalize(2000,true);
    expect(initial.eventType).toBe('inventory-ack');expect(gear.eventType).toBe('inventory-ack');expect(flow.summary([initial,gear]).incomingQuantity).toBe(0);
    const second=new InventoryFlow(seed());const removed=remove(100);second.control(removed.data,removed.base,42);
    const replacement=receipt(101,1,1201);second.receipt(replacement,5,4,false);second.finalize(2000,true);expect(isReliableInventoryIncoming(replacement)).toBe(false);
  });
  it('seeds and replaces full bag lists without treating any positive list difference as new gain',()=>{
    const flow=new InventoryFlow({known:false,slots:[],rejectedChunks:0});control(flow,start());control(flow,list());const completed=control(flow,end());
    expect(completed.events[0].eventType).toBe('inventory-snapshot');expect(completed.events.filter(isReliableInventoryIncoming)).toHaveLength(0);
    control(flow,start(),100);control(flow,list(0,7,501,999),101);control(flow,end(),102);
    const event=receipt(1000,2);flow.receipt(event,5,3,false);flow.finalize(2000,false);expect(event.amount).toBe(2);expect(event.rawData?.beforeAmount).toBe(999);
  });
  it('fails closed on incomplete list context, invalid widths and unexplained slot replacement',()=>{
    const flow=new InventoryFlow(seed());control(flow,start());
    const event=receipt(100);flow.receipt(event,5,3,false);flow.finalize(1000,true);expect(isReliableInventoryIncoming(event)).toBe(false);
    expect(control(flow,list().subarray(0,38)).error).toBeTruthy();expect(control(flow,end()).error).toBeTruthy();
    const other=new InventoryFlow(seed()),swapped=receipt(100,1,999);other.receipt(swapped,5,3,false);other.finalize(1000,true);expect(isReliableInventoryIncoming(swapped)).toBe(false);
  });
  it('holds an open-file ACK tail pending until follow-up packets mature it',()=>{
    const flow=new InventoryFlow(seed()),event=receipt(100);flow.observeWeight(1000,0,42);flow.receipt(event,5,3,false);flow.observeWeight(1003,101,42);flow.finalize(200,false);
    expect(event.rawData?.pendingInventory).toBe(true);expect(isReliableInventoryIncoming(event)).toBe(false);
    flow.finalize(600,false);expect(isReliableInventoryIncoming(event)).toBe(false);flow.finalize(601,false);expect(isReliableInventoryIncoming(event)).toBe(true);expect(event.timestamp).toBe(100);
  });
  it('marks failed cart client repair as refresh even when delete follows ACK in the same frame',()=>{
    const flow=new InventoryFlow(seed()),failure=packet(0x012c,3);failure[2]=1;control(flow,failure,100);
    const event=receipt(101);flow.receipt(event,5,3,false);const removed=remove(102);flow.control(removed.data,removed.base,42);flow.finalize(1000,false);
    expect(event.eventType).toBe('inventory-ack');expect(isReliableInventoryIncoming(event)).toBe(false);
  });
});
describe('known transfers and own consumption',()=>{
  it.each([true,false])('tracks a new storage slot and matches withdrawal before/after ACK: %s',before=>{
    const flow=new InventoryFlow(seed());control(flow,start(2));control(flow,end(2),1);
    const removal=remove(10,5,3,4);flow.control(removal.data,removal.base,42);
    expect(control(flow,storageAdd(),11).events).toEqual([]);
    const event=receipt(101,3),withdrawal=containerDelete(0x00f6,299,3);
    if(before)control(flow,withdrawal,100);flow.receipt(event,5,3,false);if(!before)control(flow,withdrawal,102);flow.finalize(1000,false);
    expect(event.rawData).toMatchObject({inventorySource:'storage',transferProof:'matching-container-delete',transferContainer:2});
    flow.observeWeight(1000,1499,42);const next=receipt(1500,2);flow.receipt(next,5,3,false);flow.observeWeight(1002,1501,42);flow.finalize(2100,false);
    expect(isReliableInventoryIncoming(next)).toBe(true);expect(next.rawData?.inventorySource).toBe('unknown');
  });
  it('updates a storage stack and selects the latest explicitly opened storage type without changing bag indices',()=>{
    const flow=new InventoryFlow(seed());control(flow,start(2));control(flow,list(2,299,501,10));control(flow,end(2));
    control(flow,storageAdd(299,3),10);control(flow,containerDelete(0x00f6,299,13),20);
    const first=receipt(21,13);flow.receipt(first,5,3,false);expect(first.rawData?.inventorySource).toBe('storage');
    control(flow,start(3),100);control(flow,end(3),101);control(flow,storageAdd(299,4,912),102);control(flow,containerDelete(0x00f6,299,4),103);
    const second=receipt(104,4,912,8);flow.receipt(second,8,3,false);expect(second.rawData).toMatchObject({inventorySource:'storage',transferContainer:3});
    flow.observeWeight(1000,999,42);const bag=receipt(1000,2);flow.receipt(bag,5,3,false);flow.observeWeight(1002,1001,42);flow.finalize(1600,false);expect(bag.rawData?.beforeAmount).toBe(33);expect(isReliableInventoryIncoming(bag)).toBe(true);
  });
  it.each([true,false])('holds unresolved withdrawals before/after ACK out of income and then resumes normal drops: %s',before=>{
    const flow=new InventoryFlow(seed());control(flow,start(2));control(flow,end(2));
    const event=receipt(100,3),withdrawal=containerDelete(0x00f6,299,3);
    if(before)control(flow,withdrawal,99);flow.receipt(event,5,3,false);if(!before)control(flow,withdrawal,101);flow.finalize(1000,false);
    expect(event.rawData).toMatchObject({parserProof:'excluded-unresolved-transfer',inventorySource:'unknown',excludedReason:'unresolved-container-transfer'});expect(isReliableInventoryIncoming(event)).toBe(false);
    flow.observeWeight(1000,1499,42);const normal=receipt(1500,2);flow.receipt(normal,5,3,false);flow.observeWeight(1002,1501,42);flow.finalize(2100,false);expect(isReliableInventoryIncoming(normal)).toBe(true);expect(flow.summary([event,normal]).incomingQuantity).toBe(2);
  });
  it('keeps unresolved transfer uncertainty for the full window rather than accepting a second possible ACK',()=>{
    const flow=new InventoryFlow(seed());control(flow,containerDelete(0x00f6,299,3),100);
    const a=receipt(101,3),b=receipt(102,3);flow.receipt(a,5,3,false);flow.receipt(b,5,3,false);flow.finalize(1000,false);
    expect(isReliableInventoryIncoming(a)).toBe(false);expect(isReliableInventoryIncoming(b)).toBe(false);
  });
  it('retains unresolved evidence for all pending ACKs beyond the recent64 display window',()=>{
    const flow=new InventoryFlow(seed()),events=Array.from({length:65},(_,index)=>receipt(100+index,3));
    for(const event of events)flow.receipt(event,5,3,false);
    control(flow,containerDelete(0x00f6,299,3),200);flow.finalize(1000,false);
    expect(events.every(event=>!isReliableInventoryIncoming(event))).toBe(true);
  });
  it('keeps a bounded conservative fence if more than64 unresolved transfers share a follow-up window',()=>{
    const flow=new InventoryFlow(seed());for(let amount=1;amount<=65;amount++)control(flow,containerDelete(0x00f6,299,amount),100+amount);
    const held=receipt(200,1);flow.receipt(held,5,3,false);flow.finalize(800,false);expect(isReliableInventoryIncoming(held)).toBe(false);
    flow.observeWeight(1000,999,42);const later=receipt(1000,2);flow.receipt(later,5,3,false);flow.observeWeight(1002,1001,42);flow.finalize(1600,false);expect(isReliableInventoryIncoming(later)).toBe(true);
  });
  it('does not lose income exclusion when more than64 resolved transfers await their ACKs',()=>{
    const flow=new InventoryFlow(seed());control(flow,start(2));control(flow,end(2));
    for(let index=0;index<65;index++){control(flow,storageAdd(299+index,1,1000+index),100);control(flow,containerDelete(0x00f6,299+index,1),101+index);}
    const held=receipt(200,1,1000,8);flow.receipt(held,8,3,false);flow.finalize(800,false);expect(isReliableInventoryIncoming(held)).toBe(false);
  });
  it('does not let malformed storage or cart lists invalidate a valid bag and requires a new full bag list after a bag failure',()=>{
    const flow=new InventoryFlow(seed());
    for(const type of [1,2,3]){control(flow,start(type));expect(control(flow,list(type).subarray(0,38)).error).toBeTruthy();expect(control(flow,end(type)).error).toBeTruthy();expect(flow.summary([]).baselineKnown).toBe(true);}
    flow.observeWeight(1000,999,42);const normal=receipt(1000,2);flow.receipt(normal,5,3,false);flow.observeWeight(1002,1001,42);flow.finalize(1600,false);expect(isReliableInventoryIncoming(normal)).toBe(true);
    control(flow,start(0),2000);control(flow,list(0).subarray(0,38),2001);control(flow,end(0),2002);
    const held=receipt(2100,2);flow.receipt(held,5,3,false);flow.finalize(2700,false);expect(isReliableInventoryIncoming(held)).toBe(false);expect(flow.summary([]).baselineKnown).toBe(false);
    control(flow,start(0),3000);control(flow,list(0),3001);control(flow,end(0),3002);
    flow.observeWeight(1000,3099,42);const recovered=receipt(3100,2);flow.receipt(recovered,5,3,false);flow.observeWeight(1002,3101,42);flow.finalize(3700,false);expect(isReliableInventoryIncoming(recovered)).toBe(true);
  });
  it('keeps map-interrupted bag refresh unknown until a complete list and discards old storage context',()=>{
    const flow=new InventoryFlow(seed());control(flow,start(2));control(flow,end(2));control(flow,storageAdd(),10);control(flow,start(0),20);flow.mapChanged();
    expect(flow.summary([]).baselineKnown).toBe(false);expect(control(flow,storageAdd(),30).error).toBeTruthy();
    control(flow,start(0),40);control(flow,list(0),41);control(flow,end(0),42);expect(flow.summary([]).baselineKnown).toBe(true);
    control(flow,containerDelete(0x00f6,299,3),100);const held=receipt(101,3);flow.receipt(held,5,3,false);flow.finalize(1000,false);expect(isReliableInventoryIncoming(held)).toBe(false);
  });
  it('rejects unsupported storage-add layouts, invalid values, conflicting slots and overflowing stacks without damaging bag trust',()=>{
    const flow=new InventoryFlow(seed());expect(control(flow,storageAdd()).error).toBeTruthy();
    control(flow,start(2));control(flow,end(2));
    for(const data of [storageAdd().subarray(0,56),storageAdd(4096),storageAdd(299,0),storageAdd(299,3,0)]){expect(control(flow,data,10).error).toBeTruthy();expect(flow.summary([]).baselineKnown).toBe(true);}
    control(flow,storageAdd(299,0xffffffff),20);expect(control(flow,storageAdd(299,1),21).error).toBeTruthy();
    control(flow,storageAdd(299,3),30);expect(control(flow,storageAdd(299,1,912),31).error).toBeTruthy();expect(flow.summary([]).baselineKnown).toBe(true);
    control(flow,packet(0x00f8,2),40);expect(control(flow,storageAdd(),41).error).toBeTruthy();
  });
  it.each([true,false])('matches storage withdrawal %s before/after bag ACK without calling it farm income',before=>{
    const flow=new InventoryFlow(seed());control(flow,start(2));control(flow,list(2,299,717,55));control(flow,end(2));
    const event=receipt(100,25,717,8),deletion=containerDelete(0x00f6,299,25);
    if(before)control(flow,deletion,99);flow.receipt(event,8,3,false);if(!before)control(flow,deletion,101);flow.finalize(1000,false);
    expect(event.rawData).toMatchObject({inventorySource:'storage',transferProof:'matching-container-delete'});expect(isReliableInventoryIncoming(event)).toBe(false);
  });
  it('keeps cart and trade incoming classified as transfers rather than unknown farm gain',()=>{
    const flow=new InventoryFlow(seed());control(flow,start(1));control(flow,list(1,7,501,20));control(flow,end(1));control(flow,containerDelete(0x0125,7,3),99);
    const cart=receipt(100);flow.receipt(cart,5,3,false);const accept=packet(0x00e7,3);accept[2]=3;control(flow,accept,200);
    const trade=receipt(201,1);flow.receipt(trade,5,3,false);flow.finalize(1000,false);expect(cart.rawData?.inventorySource).toBe('cart');expect(trade.rawData?.inventorySource).toBe('trade');
  });
  it('uses own successful use-ACK remaining quantity and ignores another actor',()=>{
    const flow=new InventoryFlow(seed(20)),use=packet(0x01c8,15);view(use).setUint16(2,7,true);view(use).setUint32(4,501,true);view(use).setUint32(8,99,true);view(use).setUint16(12,4,true);use[14]=1;
    control(flow,use,100);const first=receipt(101,1);flow.receipt(first,5,3,false);expect(first.rawData?.beforeAmount).toBe(20);
    view(use).setUint32(8,42,true);control(flow,use,200);const second=receipt(201,1);flow.receipt(second,5,3,false);expect(second.rawData?.beforeAmount).toBe(4);
  });
  it('emits removals as state changes without producing negative farm income',()=>{
    const flow=new InventoryFlow(seed()),r=remove(100,5,3,4),result=flow.control(r.data,r.base,42);
    expect(result.events[0]).toMatchObject({eventType:'inventory-removal',itemId:501,amount:3,rawData:{inventorySource:'storage',negativeFarmIncome:false}});
    expect(result.events.filter(isReliableInventoryIncoming)).toHaveLength(0);
  });
});
describe('RRF parser integration with variable-length initial bag',()=>{
  function encode(input:Uint8Array){const result=new Uint8Array(input),date=bytes(4);view(date).setInt16(0,2026,true);date[2]=11;date[3]=1;const k1=view(date).getInt32(0,true)>>5,k2=(12<<8)>>3;for(let i=0;i<Math.floor(input.length/4);i++)view(result).setInt32(i*4,view(input).getInt32(i*4,true)^Math.imul(k1+i+1,k2),true);return result;}
  it('keeps initial20 items out, then normalizes a real125-item ACK delta exactly once',()=>{
    const header=bytes(352);header.set(new TextEncoder().encode('<< Ragnarok Replay File Version 0.05 >>'));header[100]=5;view(header).setInt16(104,2026,true);header[106]=11;header[107]=1;header[109]=12;
    const bag=encode(tlv(4510,record(5,501,20,'İsim uzunluğu değişkendir'))),ack=packet(0x0b41,70);view(ack).setUint16(2,7,true);view(ack).setUint16(4,125,true);view(ack).setUint32(6,501,true);ack[10]=1;ack[32]=3;
    const status=(amount:number)=>{const data=packet(0x00b0,8);view(data).setUint16(2,24,true);view(data).setInt32(4,amount,true);return data;};
    const frame=(data:Uint8Array,time:number)=>{const head=bytes(10);view(head).setInt32(4,time,true);view(head).setUint16(8,data.length,true);return concat(head,encode(data));};
    const session=encode(tlv(1010,u32(42))),stream=concat(frame(status(1000),0),frame(ack,100),frame(status(1125),101),frame(status(1125),601));
    for(const [slot,type,start,length]of[[0,8,352,bag.length],[1,3,352+bag.length,session.length],[2,1,352+bag.length+session.length,stream.length]]){const at=112+slot*10;view(header).setUint16(at,type,true);view(header).setInt32(at+2,length,true);view(header).setInt32(at+6,start,true);}
    const result=parseReplay(concat(header,bag,session,stream).buffer,'synthetic-inventory.rrf'),events=result.events.filter(isReliableInventoryIncoming);
    expect(events).toHaveLength(1);expect(events[0].amount).toBe(125);expect(events[0].rawData?.beforeAmount).toBe(20);expect(result.summary.inventoryFlow?.incomingQuantity).toBe(125);expect(result.compatibility).toBe('skadi-unverified');
  });
});
