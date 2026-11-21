import {describe,expect,it} from 'vitest';
import {InventoryFlow,IncrementalReplayParser,isReliableInventoryIncoming,isVerifiedLootIncoming,parseReplay} from '../src/parser';
import type {IncrementalReplayBootstrap,ReplayEvent} from '../src/parser';

const bytes=(n:number)=>new Uint8Array(n);
const view=(data:Uint8Array)=>new DataView(data.buffer,data.byteOffset,data.byteLength);
const concat=(...parts:Uint8Array[])=>{const out=bytes(parts.reduce((sum,part)=>sum+part.length,0));let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;};
const u32=(n:number)=>{const out=bytes(4);view(out).setUint32(0,n,true);return out;};
const tlv=(tag:number,data:Uint8Array)=>{const out=bytes(6);view(out).setInt16(0,tag,true);view(out).setInt32(2,data.length,true);return concat(out,data);};
const packet=(id:number,n:number)=>{const out=bytes(n);view(out).setUint16(0,id,true);return out;};
const status=(amount:number,parameter=24,id=0x00b0)=>{const out=packet(id,id===0x0acb?12:8);view(out).setUint16(2,parameter,true);if(id===0x0acb)view(out).setBigInt64(4,BigInt(amount),true);else view(out).setInt32(4,amount,true);return out;};
const ack=(amount=3)=>{const out=packet(0x0b41,70);view(out).setUint16(2,7,true);view(out).setUint16(4,amount,true);view(out).setUint32(6,501,true);out[10]=1;out[32]=3;return out;};
const map=()=>{const out=packet(0x0091,22);out.set(new TextEncoder().encode('other_map'),2);return out;};
const use=(owner=42)=>{const out=packet(0x01c8,15);view(out).setUint16(2,7,true);view(out).setUint32(4,501,true);view(out).setUint32(8,owner,true);view(out).setUint16(12,20,true);out[14]=1;return out;};
function encrypt(input:Uint8Array){const out=new Uint8Array(input),date=bytes(4);view(date).setInt16(0,2026,true);date[2]=11;date[3]=1;const k1=view(date).getInt32(0,true)>>5,k2=(12<<8)>>3;for(let i=0;i<Math.floor(out.length/4);i++)view(out).setInt32(i*4,view(out).getInt32(i*4,true)^Math.imul(k1+i+1,k2),true);return out;}
function frame(data:Uint8Array,time:number,index=0){const out=bytes(10);view(out).setInt32(0,index,true);view(out).setInt32(4,time,true);view(out).setUint16(8,data.length,true);return concat(out,encrypt(data));}
type Sample={time:number;data:Uint8Array};
const at=(time:number,data:Uint8Array):Sample=>({time,data});
function fixture(packets:Sample[],owner=42,initial?:Uint8Array){
  const header=bytes(352);header.set(new TextEncoder().encode('<< Ragnarok Replay File Version 0.05 >>'));header[100]=5;view(header).setInt16(104,2026,true);header[106]=11;header[107]=1;header[109]=12;
  const record=concat(tlv(281,bytes(0)),tlv(285,u32(7)),tlv(287,u32(20)),tlv(291,u32(501)),tlv(282,bytes(0)));
  const definitions=[{type:3,data:tlv(1010,u32(owner))},{type:8,data:tlv(4510,record)},...(initial?[{type:14,data:tlv(1,initial)}]:[])];let offset=header.length;
  const sections=definitions.map(({type,data},index)=>{const encoded=encrypt(data),section={type,data:encoded,offset},entry=112+(index+1)*10;view(header).setUint16(entry,type,true);view(header).setInt32(entry+2,encoded.length,true);view(header).setInt32(entry+6,offset,true);offset+=encoded.length;return section;});
  const frames=concat(...packets.map(({time,data},index)=>frame(data,time,index)));view(header).setUint16(112,1,true);view(header).setInt32(114,frames.length,true);view(header).setInt32(118,offset,true);
  return {bootstrap:{header:header.buffer,sections} as IncrementalReplayBootstrap,frames,full:concat(header,...sections.map(section=>section.data),frames)};
}
const push=(parser:IncrementalReplayParser,data:Uint8Array,closed=false)=>parser.push(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength) as ArrayBuffer,{closed});
const baseline=at(0,status(1000)),receipt=at(100,ack()),increase=at(101,status(1003)),finish=at(1800,status(500,5));
const trade=packet(0x00e7,3);trade[2]=3;
const withdrawal=packet(0x00f6,8);view(withdrawal).setUint16(2,299,true);view(withdrawal).setUint32(4,3,true);
const removal=packet(0x07fa,8);view(removal).setUint16(4,7,true);view(removal).setUint16(6,1,true);
const ground=packet(0x0add,24);view(ground).setUint32(2,777,true);view(ground).setUint32(6,501,true);ground[12]=1;view(ground).setInt16(19,3,true);

describe('self-addressed rare pickups',()=>{
  const rareAck=(type:number,location:number)=>{
    const data=ack(1);view(data).setUint16(2,9,true);view(data).setUint32(6,5123,true);
    data[32]=type;view(data).setUint32(28,location,true);return data;
  };
  const party=(type:number,location:number,owner=42,item=5123,layout=33)=>{
    const data=packet(layout===33?0x0b67:0x02b8,layout);
    view(data).setUint32(2,owner,true);
    if(layout===22)view(data).setUint16(6,item,true);else view(data).setUint32(6,item,true);
    view(data).setUint16(layout===33?28:layout-3,location,true);data[layout===33?30:layout-1]=type;return data;
  };
  const card=at(100,rareAck(6,0)),costume=at(100,rareAck(4,0x400)),flat=at(110,status(1000));
  it.each([
    {name:'new personal card and unchanged weight',events:[baseline,card,at(101,party(6,0)),flat,finish],count:1},
    {name:'zero-weight costume and no weight samples',events:[costume,at(101,party(4,0x400)),finish],count:1},
    {name:'legacy 16-bit party receipt',events:[card,at(101,party(6,0,42,5123,22)),finish],count:1},
    {name:'legacy 32-bit party receipt',events:[card,at(101,party(6,0,42,5123,32)),finish],count:1},
    {name:'other party member',events:[costume,at(101,party(4,0x400,99)),finish],count:0},
    {name:'other item',events:[card,at(101,party(6,0,42,5111)),finish],count:0},
    {name:'different equipment kind',events:[costume,at(101,party(4,0x100)),finish],count:0},
    {name:'nonadjacent',events:[card,at(101,status(123,5)),at(102,party(6,0)),finish],count:0},
    {name:'expired pairing',events:[card,at(351,party(6,0)),finish],count:0},
    {name:'trade',events:[at(0,trade),card,at(101,party(6,0)),finish],count:0},
    {name:'later storage correction',events:[card,at(101,party(6,0)),at(110,withdrawal.subarray(0,7)),finish],count:0},
    {name:'exact transfer boundary',events:[card,at(101,party(6,0)),at(600,status(5,5))],count:0},
  ])('$name',({events,count})=>{
    const source=fixture(events);
    const full=parseReplay(source.full.buffer,'party.rrf');
    expect(full.events.filter(e=>isVerifiedLootIncoming(e,42))).toHaveLength(count);
    const parser=new IncrementalReplayParser(source.bootstrap,'party.rrf'),latest=new Map<string,ReplayEvent>();
    for(const {time,data} of events)for(const event of push(parser,frame(data,time)).events)latest.set(event.id,event);
    for(const event of push(parser,bytes(0),true).events)latest.set(event.id,event);
    expect([...latest.values()].filter(e=>isVerifiedLootIncoming(e,42))).toHaveLength(count);
    expect(full.summary.inventoryFlow?.incomingQuantity).toBe(count);
  });
});

describe('raw own weight is required for a single inventory receipt',()=>{
  it.each([
    {name:'one delta with later own weight',packets:[baseline,receipt,increase,finish],amount:3},
    {name:'multi-item quantity in one ACK',packets:[baseline,at(100,ack(125)),at(101,status(1125)),finish],amount:125},
    {name:'32-bit alternative status',packets:[at(0,status(1000,24,0x00b1)),receipt,at(101,status(1003,24,0x00b1)),finish],amount:3},
    {name:'64-bit raw status',packets:[at(0,status(1000,24,0x0acb)),receipt,at(101,status(1003,24,0x0acb)),finish],amount:3},
    {name:'weight absent',packets:[baseline,receipt,finish],amount:0},
    {name:'first weight is baseline only',packets:[receipt,increase,finish],amount:0},
    {name:'maximum weight is not raw weight',packets:[baseline,receipt,at(101,status(99999,25)),finish],amount:0},
    {name:'unchanged weight',packets:[baseline,receipt,at(101,status(1000)),finish],amount:0},
    {name:'decreasing weight',packets:[baseline,receipt,at(101,status(999)),finish],amount:0},
    {name:'weight preceding ACK is never credit',packets:[baseline,at(50,status(1003)),receipt,finish],amount:0},
    {name:'weight after expiry',packets:[baseline,receipt,at(1601,status(1003)),finish],amount:0},
    {name:'inclusive 1500ms window',packets:[baseline,receipt,at(1600,status(1003)),finish],amount:3},
    {name:'one weight rise cannot fund two ACKs',packets:[baseline,receipt,at(100,ack()),increase,finish],amount:0},
    {name:'ordered ACK-weight pairs remain independent',packets:[baseline,receipt,increase,at(102,ack()),at(103,status(1006)),finish],amount:6},
    {name:'unknown recording owner',packets:[baseline,receipt,increase,finish],amount:0,owner:0},
    {name:'map interruption',packets:[baseline,receipt,at(101,map()),at(102,status(1003)),finish],amount:0},
    {name:'invalid telemetry interruption',packets:[baseline,receipt,at(101,status(1003).subarray(0,7)),at(102,status(1003)),finish],amount:0},
    {name:'invalid ACK interruption',packets:[baseline,receipt,at(101,ack().subarray(0,69)),at(102,status(1003)),finish],amount:0},
    {name:'own consumption interruption',packets:[baseline,receipt,at(101,use()),at(102,status(1003)),finish],amount:0},
    {name:'other player use does not change own bag',packets:[baseline,receipt,at(101,use(99)),at(102,status(1003)),finish],amount:3},
    {name:'unknown storage withdrawal interruption',packets:[baseline,receipt,at(101,withdrawal),at(102,status(1003)),finish],amount:0},
    {name:'known trade receipt excluded',packets:[baseline,at(50,trade),receipt,increase,finish],amount:0},
    {name:'own bag removal interruption',packets:[baseline,receipt,at(101,removal),at(102,status(1003)),finish],amount:0},
    {name:'decrease during follow-up invalidates provisional proof',packets:[baseline,receipt,increase,at(200,status(1000)),finish],amount:0},
    {name:'later map does not erase completed receipt',packets:[baseline,receipt,increase,at(700,map()),finish],amount:3},
    {name:'later invalid packet does not erase completed receipt',packets:[baseline,receipt,increase,at(700,status(1003).subarray(0,7)),finish],amount:3},
    {name:'closed stream cannot replace follow-up evidence',packets:[baseline,receipt,increase],amount:0},
    {name:'closed stream exactly at the transfer boundary stays unverified',packets:[baseline,receipt,increase,at(600,status(500,5))],amount:0},
    {name:'ground appearance plus weight is not receipt',packets:[baseline,at(100,ground),increase,finish],amount:0},
  ])('$name: full and fragmented readers agree',({packets,amount,owner})=>{
    const source=fixture(packets,owner??42),full=parseReplay(source.full.buffer,'weight.rrf');
    expect(full.summary.inventoryFlow?.incomingQuantity).toBe(amount);expect(full.summary.itemObservations?.obtainedQuantity).toBe(amount);
    for(const size of [1,19,65536]){
      const parser=new IncrementalReplayParser(source.bootstrap,'weight.rrf'),events=new Map<string,ReplayEvent>();let result;
      for(let offset=0;offset<source.frames.length;offset+=size){result=push(parser,source.frames.subarray(offset,offset+size));for(const event of result.events)events.set(event.id,event);}
      result=push(parser,bytes(0),true);for(const event of result.events)events.set(event.id,event);
      expect(result.summary,`fragment size ${size}`).toEqual(full.summary);
      expect([...events.values()].filter(event=>isVerifiedLootIncoming(event,42)).reduce((sum,event)=>sum+event.amount!,0)).toBe(amount);
    }
  });
  it('uses an explicit initial raw weight sample only as the baseline',()=>{
    const source=fixture([receipt,increase,finish],42,status(1000));
    expect(parseReplay(source.full.buffer,'initial.rrf').summary.inventoryFlow?.incomingQuantity).toBe(3);
    const parser=new IncrementalReplayParser(source.bootstrap,'initial.rrf');expect(push(parser,source.frames,true).summary.inventoryFlow?.incomingQuantity).toBe(3);
  });
  it('promotes an old ACK on a late weight append with its original time and deterministic confirmation time',()=>{
    const source=fixture([]),parser=new IncrementalReplayParser(source.bootstrap,'live.rrf');push(parser,frame(status(1000),0));
    const pending=push(parser,frame(ack(),100)),pendingEvent=pending.events.find(event=>event.itemId===501)!;
    expect(pendingEvent.eventType).toBe('inventory-ack');expect(pending.summary.itemObservations?.obtainedQuantity).toBe(0);
    const confirmed=push(parser,frame(status(1003),700)),event=confirmed.events.find(event=>event.id===pendingEvent.id)!;
    expect(isVerifiedLootIncoming(event,42)).toBe(true);expect(event.timestamp).toBe(100);
    expect(event.rawData?.inventoryWeightProof).toEqual({kind:'own-weight-increase',ownerActorId:42,before:1000,after:1003,receiptTimestamp:100,weightTimestamp:700,confirmedAt:700,scope:'receipt-batch'});
    expect(push(parser,frame(status(1003),701)).summary.inventoryFlow?.incomingQuantity).toBe(3);
    expect(push(parser,bytes(0)).events).toEqual([]);
  });
  it('waits beyond the inclusive transfer boundary and preserves deterministic confirmation time',()=>{
    const source=fixture([]),parser=new IncrementalReplayParser(source.bootstrap,'boundary-valid.rrf');
    const boundary=push(parser,concat(frame(status(1000),0),frame(ack(),100),frame(status(1003),101),frame(status(500,5),600)));
    expect(boundary.summary.inventoryFlow?.incomingQuantity).toBe(0);expect(boundary.summary.inventoryFlow?.pendingCount).toBe(1);
    const next=push(parser,frame(status(500,5),601)),event=next.events.find(event=>isVerifiedLootIncoming(event,42))!;
    expect(next.summary.inventoryFlow?.incomingQuantity).toBe(3);expect(event.timestamp).toBe(100);
    expect((event.rawData?.inventoryWeightProof as {confirmedAt:number}).confirmedAt).toBe(600);
    expect(push(parser,frame(status(500,5),602)).events.filter(event=>isVerifiedLootIncoming(event,42))).toEqual([]);
  });
  it('never emits a receipt before a storage correction at the inclusive follow-up boundary across append batches',()=>{
    const start=packet(0x0b08,5);view(start).setUint16(2,5,true);start[4]=2;
    const list=packet(0x0b09,39);view(list).setUint16(2,39,true);list[4]=2;view(list).setUint16(5,299,true);view(list).setUint32(7,501,true);list[11]=3;view(list).setUint16(12,20,true);
    const end=packet(0x0b0b,4);end[2]=2;
    const source=fixture([at(0,start),at(1,list),at(2,end),at(3,status(1000)),receipt,increase,at(600,status(500,5)),at(600,withdrawal),finish]);
    const full=parseReplay(source.full.buffer,'boundary.rrf'),parser=new IncrementalReplayParser(source.bootstrap,'boundary.rrf');
    const first=push(parser,concat(frame(start,0),frame(list,1),frame(end,2),frame(status(1000),3),frame(ack(),100),frame(status(1003),101),frame(status(500,5),600)));
    expect(first.summary.inventoryFlow?.incomingQuantity).toBe(0);expect(first.events.some(event=>isVerifiedLootIncoming(event,42))).toBe(false);
    const corrected=push(parser,frame(withdrawal,600));expect(corrected.summary.inventoryFlow?.incomingQuantity).toBe(0);expect(corrected.summary.itemObservations?.obtainedQuantity).toBe(0);
    const final=push(parser,frame(status(500,5),1800),true);expect(final.summary).toEqual(full.summary);expect(full.summary.inventoryFlow?.incomingQuantity).toBe(0);
  });
});

describe('shared verified-loot gate fails closed',()=>{
  const confirmed=()=>{
    const flow=new InventoryFlow({known:true,slots:[],rejectedChunks:0}),event:ReplayEvent={id:'receipt',timestamp:100,eventType:'item-obtained',actorId:42,itemId:501,amount:3,confidence:'certain',rawData:{}};
    flow.observeWeight(1000,0,42);flow.receipt(event,5,3,false);flow.observeWeight(1003,101,42);flow.finalize(601,false);return event;
  };
  it('requires the matching recording owner and complete proof',()=>{
    const event=confirmed();expect(isReliableInventoryIncoming(event)).toBe(true);expect(isVerifiedLootIncoming(event,42)).toBe(true);
    for(const owner of [null,0,-1,99,Number.NaN])expect(isVerifiedLootIncoming(event,owner)).toBe(false);
    expect(isVerifiedLootIncoming({...event,actorId:undefined})).toBe(false);
    expect(isVerifiedLootIncoming({...event,rawData:{...event.rawData,inventoryWeightProof:undefined}})).toBe(false);
  });
  it.each(['trade','storage','cart','purchase','quest','refresh','unrecognized-source',undefined])('rejects source %s despite a plausible weight rise',inventorySource=>{
    const event=confirmed();event.rawData={...event.rawData,inventorySource};expect(isVerifiedLootIncoming(event,42)).toBe(false);
  });
  it.each([{before:1003},{after:1000},{ownerActorId:99},{receiptTimestamp:101},{weightTimestamp:99},{weightTimestamp:1601},{confirmedAt:599},{confirmedAt:601},{scope:'item'},{kind:'percent-change'}])('rejects malformed proof %j',change=>{
    const event=confirmed();event.rawData={...event.rawData,inventoryWeightProof:{...(event.rawData?.inventoryWeightProof as object),...change}};expect(isVerifiedLootIncoming(event,42)).toBe(false);
  });
});
