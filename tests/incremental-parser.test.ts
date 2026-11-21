import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {IncrementalReplayParser,parseReplay,isReliableInventoryIncoming} from '../src/parser';
import type {IncrementalReplayBootstrap,ReplayEvent} from '../src/parser';

const bytes=(n:number)=>new Uint8Array(n);
const view=(data:Uint8Array)=>new DataView(data.buffer,data.byteOffset,data.byteLength);
const concat=(...parts:Uint8Array[])=>{const out=bytes(parts.reduce((sum,part)=>sum+part.length,0));let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;};
const u32=(n:number)=>{const out=bytes(4);view(out).setUint32(0,n,true);return out;};
const tlv=(tag:number,data:Uint8Array)=>{const out=bytes(6);view(out).setInt16(0,tag,true);view(out).setInt32(2,data.length,true);return concat(out,data);};
const text=(value:string)=>new TextEncoder().encode(value+'\0');
const packet=(id:number,n:number)=>{const out=bytes(n);view(out).setUint16(0,id,true);return out;};
function encrypt(input:Uint8Array){const out=new Uint8Array(input),date=bytes(4);view(date).setInt16(0,2026,true);date[2]=11;date[3]=1;const k1=view(date).getInt32(0,true)>>5,k2=(12<<8)>>3;for(let i=0;i<Math.floor(out.length/4);i++)view(out).setInt32(i*4,view(out).getInt32(i*4,true)^Math.imul(k1+i+1,k2),true);return out;}
function frame(data:Uint8Array,time:number,index=0){const out=bytes(10);view(out).setInt32(0,index,true);view(out).setInt32(4,time,true);view(out).setUint16(8,data.length,true);return concat(out,encrypt(data));}
const status=(parameter:number,amount:number)=>{const out=packet(0x00b0,8);view(out).setUint16(2,parameter,true);view(out).setInt32(4,amount,true);return out;};
const unknown=()=>packet(0x7777,24);
const zeroTimeUnknown=()=>packet(0x08ae,20);
const spawn=(aid:number)=>{const out=packet(0x0857,74);view(out).setUint16(2,out.length,true);out[4]=5;view(out).setUint32(5,aid,true);view(out).setInt16(19,1002,true);out.set(text('Hode'),69);return out;};
const damage=(aid:number)=>{const out=packet(0x02e1,33);view(out).setUint32(2,42,true);view(out).setUint32(6,aid,true);view(out).setUint32(10,900,true);view(out).setInt32(22,100,true);view(out).setInt16(26,1,true);return out;};
const death=(aid:number)=>{const out=packet(0x0080,7);view(out).setUint32(2,aid,true);out[6]=1;return out;};
const ack=(amount=3)=>{const out=packet(0x0b41,70);view(out).setUint16(2,7,true);view(out).setUint16(4,amount,true);view(out).setUint32(6,501,true);out[10]=1;out[32]=3;return out;};
const start=(type=0)=>{const out=packet(0x0b08,5);view(out).setUint16(2,5,true);out[4]=type;return out;};
const end=(type=0)=>{const out=packet(0x0b0b,4);out[2]=type;return out;};
const list=(type=0)=>{const out=packet(0x0b09,39);view(out).setUint16(2,39,true);out[4]=type;view(out).setUint16(5,7,true);view(out).setUint32(7,501,true);out[11]=3;view(out).setUint16(12,30,true);return out;};
const map=()=>{const out=packet(0x0091,22);out.set(text('qa_field'),2);return out;};
function fixture(packets:{time:number;data:Uint8Array}[]=[],initial?:Uint8Array,extraSession=bytes(0)){
  const header=bytes(352);header.set(text('<< Ragnarok Replay File Version 0.05 >>'));header[100]=5;view(header).setInt16(104,2026,true);header[106]=11;header[107]=1;header[109]=12;
  const record=concat(tlv(281,bytes(0)),tlv(285,u32(7)),tlv(287,u32(20)),tlv(291,u32(501)),tlv(282,bytes(0)));
  const definitions=[{type:2,data:concat(...[0,1,2,3].map(id=>tlv(id,bytes(0))),tlv(964,text('Synthetic')),tlv(965,text('qa_field')),tlv(970,u32(0)))},{type:3,data:concat(tlv(1010,u32(42)),tlv(1014,u32(7)),tlv(1016,u32(40)),tlv(1019,u32(20)),extraSession)},{type:8,data:tlv(4510,record)},...(initial?[{type:14,data:tlv(1,initial)}]:[])];
  let at=header.length;
  const sections=definitions.map(({type,data},index)=>{const encoded=encrypt(data),out={type,data:encoded,offset:at},a=112+(index+1)*10;view(header).setUint16(a,type,true);view(header).setInt32(a+2,encoded.length,true);view(header).setInt32(a+6,at,true);at+=encoded.length;return out;});
  const frames=concat(...packets.map(({time,data},index)=>frame(data,time,index)));view(header).setUint16(112,1,true);view(header).setInt32(114,frames.length,true);view(header).setInt32(118,at,true);
  return{bootstrap:{header:header.buffer,sections} as IncrementalReplayBootstrap,frames,full:concat(header,...sections.map(section=>section.data),frames)};
}
const push=(parser:IncrementalReplayParser,data:Uint8Array,closed=false)=>parser.push(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength) as ArrayBuffer,{closed});

describe('incremental v5 packet bridge',()=>{
  it('publishes only timed EXP readings at the latest level without changing prior snapshots',()=>{
    const packets = [[1,850], [22,900], [2,460], [11,41], [22,1200], [55,1], [2,5], [23,300], [1,0]];
    const file = fixture(packets.map(([key,value],index) => ({time:index+1,data:status(key,value)})),status(1,700));
    const parser = new IncrementalReplayParser(file.bootstrap,'timed-exp.rrf');
    const opening = push(parser,bytes(0)).summary.liveTelemetry;
    expect(opening?.timedExp).toEqual({});
    const readUntil = (start:number,end:number) => push(parser,file.frames.subarray(start*18,end*18)).summary.liveTelemetry;
    const before = readUntil(0,3);
    expect(before?.timedExp).toEqual({base:{balance:850,required:900},job:{balance:460}});
    expect(readUntil(3,5)?.timedExp).toEqual({base:{required:1200},job:{balance:460}});
    const after = readUntil(5,9);
    expect(after?.timedExp).toEqual({base:{balance:0,required:1200},job:{reset:true,balance:5,required:300}});
    expect(before?.timedExp?.base).toEqual({balance:850,required:900});
    expect(parseReplay(file.full.buffer,'timed-exp.rrf').summary.liveTelemetry).toEqual(after);
  });
  it('accumulates positive wallet changes across fragments independently for each recording and skips cached initial packets',()=>{
    const wallet = (amount:number) => {const data=status(20,amount);view(data).setUint16(0,0x00b1,true);return data;};
    const makeSource = (opening:number) => fixture([120,80,80,200].map((amount,i)=>({time:i+1,data:wallet(amount)})),
      wallet(9999),tlv(1051,u32(opening)));
    for (const [opening,gained] of [[100,140],[0,240]]) {
      const file=makeSource(opening),parser=new IncrementalReplayParser(file.bootstrap,'wallet.rrf');
      const openingOnly=push(parser,bytes(0));
      expect(openingOnly.summary.liveTelemetry).toMatchObject({zenyBalance:opening,zenyReceived:null});
      const increases:(number|undefined)[]=[];
      for(let i=0;i<file.frames.length;i+=5){
        const delta=push(parser,file.frames.subarray(i,i+5));
        increases.push(...delta.events.filter(event=>event.statusKey==='zenyBalance').map(event=>event.walletIncrease));
      }
      const finished=push(parser,bytes(0),true);
      expect(finished.summary.liveTelemetry).toMatchObject({zenyBalance:200,zenyReceived:gained});
      const full=parseReplay(file.full.buffer,'wallet.rrf');
      expect(full.summary.liveTelemetry).toEqual(finished.summary.liveTelemetry);
      expect(increases).toEqual([120-opening,0,0,120]);
      expect(full.events.filter(event=>event.statusKey==='zenyBalance').map(event=>event.walletIncrease)).toEqual(increases);
    }
  });
  it('keeps the opening balance across fragments and counts only rewards in the timed stream',()=>{
    const reward=(amount:number,kind:number)=>{const data=packet(0x07f6,14);view(data).setUint32(2,42,true);
      view(data).setInt32(6,amount,true);view(data).setUint16(10,kind,true);return data;};
    const session=concat(tlv(1015,concat(u32(1200),u32(0))),tlv(1018,concat(u32(2000),u32(0))),tlv(1055,u32(50)),tlv(1054,u32(450)));
    const source=fixture([{time:1,data:reward(0,2)},{time:2,data:reward(125,1)}],reward(999,1),session);
    const parser=new IncrementalReplayParser(source.bootstrap,'snapshot.rrf');
    push(parser,source.frames.subarray(0,15));
    const incremental=push(parser,source.frames.subarray(15),true);
    const full=parseReplay(source.full.buffer,'snapshot.rrf');
    expect(incremental.summary.liveTelemetry).toEqual(full.summary.liveTelemetry);
    expect(full.summary.liveTelemetry).toMatchObject({recordingStartExp:{base:{level:40,amount:1200,required:2000},
      job:{level:20,amount:50,required:450}},currentBaseExp:null,baseExpGained:125,jobExpGained:0});
    expect(full.events.filter(event=>event.eventType==='exp-gain')).toHaveLength(2);
  });
  it.each([1,7,13,65536])('counts the observed zero-time unknown without changing wire/event identity; fragment size=%s',fragmentSize=>{
    const source=fixture([{time:0,data:zeroTimeUnknown()},{time:1000,data:spawn(100)},{time:1001,data:damage(100)},{time:1002,data:ack()},{time:0,data:zeroTimeUnknown()},{time:1002,data:ack()},{time:0,data:zeroTimeUnknown()},{time:1003,data:death(100)},{time:1600,data:unknown()}]);
    const parser=new IncrementalReplayParser(source.bootstrap,'zero-time.rrf'),events=new Map<string,ReplayEvent>();let actual;
    for(let at=0;at<source.frames.length;at+=fragmentSize){actual=push(parser,source.frames.subarray(at,at+fragmentSize));for(const event of actual.events)events.set(event.id,event);}
    actual=push(parser,bytes(0),true);for(const event of actual.events)events.set(event.id,event);
    expect(actual.status).toBe('partial');expect(actual.packetCount).toBe(9);expect(actual.incremental?.eventCount).toBe(5);
    expect(actual.unknownPackets).toEqual([{packetId:'0x08ae',count:3},{packetId:'0x7777',count:1}]);expect(actual.diagnostics.filter(value=>value.code==='ZERO_TIME_UNKNOWN_PACKET')).toHaveLength(1);
    expect([...events.keys()]).toEqual(['packet-2','packet-3','packet-4','packet-6','packet-8']);
    expect([...events.values()].filter(event=>event.eventType==='inventory-ack').map(event=>event.rawData?.inventoryOccurrence)).toEqual([1,2]);
    expect(events.get('packet-8')?.rawData?.killProof).toMatchObject({lifecycleId:'wire:0:100:1000:1',mapEpoch:0,lastAttackTimestamp:1001});
    expect(actual.summary.observedDeaths).toBe(1);expect(actual.summary.durationMs).toBe(1600);expect(actual.summary.inventoryFlow).toMatchObject({incomingQuantity:0,pendingCount:0});
    const context=parser as unknown as {wireOffset:number;lastTime:number};expect(context.wireOffset).toBe(source.full.byteLength);expect(context.lastTime).toBe(1600);
  });
  it.each([
    {name:'allowlisted ID with a negative timestamp',data:zeroTimeUnknown(),time:-1},
    {name:'allowlisted ID with a positive regressing timestamp',data:zeroTimeUnknown(),time:50},
    {name:'a different unknown ID with a zero timestamp',data:unknown(),time:0},
    {name:'a supported status with a zero timestamp',data:status(5,7000),time:0},
    {name:'a supported map change with a zero timestamp',data:map(),time:0},
  ])('still rejects $name',({data,time})=>{
    const source=fixture(),parser=new IncrementalReplayParser(source.bootstrap,'strict.rrf'),valid=push(parser,frame(status(5,8000),100));
    const rejected=push(parser,frame(data,time));expect(rejected.status).toBe('invalid');expect(rejected.events).toEqual([]);expect(rejected.summary).toEqual(valid.summary);expect(rejected.packetCount).toBe(1);expect(rejected.diagnostics.at(-1)?.message).toContain('INVALID_TIMESTAMP_ORDER');
  });
  it('keeps pending inventory time unchanged through the zero-time unknown and later drains normal proof',()=>{
    const source=fixture(),parser=new IncrementalReplayParser(source.bootstrap,'pending-zero.rrf');push(parser,frame(status(24,1000),0));const first=push(parser,concat(frame(ack(),100),frame(status(24,1003),101)));
    const ignored=push(parser,frame(zeroTimeUnknown(),0));expect(ignored.events).toEqual([]);expect(ignored.summary.durationMs).toBe(101);expect(ignored.summary.inventoryFlow).toMatchObject({incomingQuantity:0,pendingCount:1});
    const matured=push(parser,frame(unknown(),601));expect(matured.events).toHaveLength(1);expect(matured.events[0].id).toBe(first.events.find(e=>e.itemId===501)?.id);expect(isReliableInventoryIncoming(matured.events[0])).toBe(true);expect(matured.summary.inventoryFlow).toMatchObject({incomingQuantity:3,pendingCount:0});
  });
  it('preserves map epochs and actor lifecycle identity around the zero-time unknown',()=>{
    const common=[{time:100,data:spawn(100)},{time:101,data:damage(100)},{time:102,data:death(100)},{time:103,data:map()},{time:104,data:spawn(100)},{time:105,data:death(100)}];
    const ordinary=fixture(common),interleaved=fixture([...common.slice(0,2),{time:0,data:zeroTimeUnknown()},...common.slice(2,4),{time:0,data:zeroTimeUnknown()},...common.slice(4)]);
    const first=push(new IncrementalReplayParser(ordinary.bootstrap,'map.rrf'),ordinary.frames,true),second=push(new IncrementalReplayParser(interleaved.bootstrap,'map.rrf'),interleaved.frames,true);
    const proofs=(list:ReplayEvent[])=>list.filter(event=>event.eventType==='death').map(event=>event.rawData?.killProof);
    expect(second.status).toBe('partial');expect(proofs(second.events)).toEqual(proofs(first.events));expect(second.summary).toEqual(first.summary);
  });
  it('matches full parser totals across fragmented packets and returns only new events',()=>{
    const source=fixture([{time:0,data:spawn(100)},{time:100,data:damage(100)},{time:101,data:death(100)},{time:200,data:status(5,7000)},{time:300,data:unknown()},{time:400,data:ack()},{time:1000,data:unknown()}]);
    const expected=parseReplay(source.full.buffer,'synthetic.rrf'),parser=new IncrementalReplayParser(source.bootstrap,'synthetic.rrf'),events=new Map<string,ReplayEvent>();let actual;
    for(let at=0;at<source.frames.length;at+=13){actual=push(parser,source.frames.subarray(at,at+13));for(const event of actual.events)events.set(event.id,event);}
    actual=push(parser,bytes(0),true);
    for(const event of actual.events)events.set(event.id,event);
    expect(actual.status).toBe('partial');expect(actual.summary).toEqual(expected.summary);expect(actual.packetCount).toBe(7);
    expect([...events.values()].some(event=>event.eventType==='unknown')).toBe(false);expect(actual.unknownPackets).toEqual([{packetId:'0x7777',count:2}]);
    expect(push(parser,bytes(0),true).events).toEqual([]);expect(actual.incremental?.eventCount).toBe(5);
  });
  it('emits a previous pending ACK revision when an unknown-only append matures its proof',()=>{
    const source=fixture(),parser=new IncrementalReplayParser(source.bootstrap,'pending.rrf');push(parser,frame(status(24,1000),0));
    const first=push(parser,concat(frame(ack(),100),frame(status(24,1003),101)));expect(first.events.find(e=>e.eventType==='inventory-ack')?.rawData?.pendingInventory).toBe(true);expect(first.summary.inventoryFlow).toMatchObject({incomingQuantity:0,pendingCount:1});
    const second=push(parser,frame(unknown(),601));expect(second.events).toHaveLength(1);expect(second.events[0].id).toBe(first.events.find(e=>e.itemId===501)?.id);expect(isReliableInventoryIncoming(second.events[0])).toBe(true);
    expect(second.summary.inventoryFlow).toMatchObject({incomingQuantity:3,pendingCount:0});expect(second.summary.itemObservations?.obtainedQuantity).toBe(3);expect(second.incremental?.eventCount).toBe(3);expect(second.summary.durationMs).toBe(601);
    expect(first.events.find(e=>e.eventType==='inventory-ack')?.rawData?.pendingInventory).toBe(true);
  });
  it('revises a prior ACK transfer source across batches without repeating income',()=>{
    const source=fixture(),parser=new IncrementalReplayParser(source.bootstrap,'transfer.rrf');
    push(parser,concat(frame(start(2),0),frame(list(2),1),frame(end(2),2)));
    const first=push(parser,frame(ack(),100));expect(first.events.at(-1)?.rawData?.inventorySource).toBe('unknown');
    const removal=packet(0x00f6,8);view(removal).setUint16(2,7,true);view(removal).setUint32(4,3,true);
    const revised=push(parser,frame(removal,101));expect(revised.events).toHaveLength(1);expect(revised.events[0].id).toBe(first.events[0].id);expect(revised.events[0].rawData).toMatchObject({inventorySource:'storage',transferProof:'matching-container-delete'});
    const mature=push(parser,frame(unknown(),601));expect(mature.summary.inventoryFlow?.incomingQuantity).toBe(0);expect(mature.summary.itemObservations?.obtainedQuantity).toBe(0);
  });
  it('reclassifies a prior pending receipt as client repair without leaving item totals behind',()=>{
    const source=fixture(),parser=new IncrementalReplayParser(source.bootstrap,'repair.rrf'),first=push(parser,frame(ack(),100));
    expect(first.summary.itemObservations?.obtainedQuantity).toBe(0);
    const failure=packet(0x012c,3),removal=packet(0x07fa,8);failure[2]=1;view(removal).setUint16(4,7,true);view(removal).setUint16(6,3,true);
    const corrected=push(parser,concat(frame(failure,101),frame(removal,102)));
    const revision=corrected.events.find(event=>event.id===first.events[0].id);
    expect(revision?.eventType).toBe('inventory-ack');expect(revision?.rawData?.excludedReason).toBe('failed-cart-client-repair');expect(corrected.summary.inventoryFlow).toMatchObject({incomingQuantity:0,pendingCount:0,excludedRefreshCount:1});
    expect(corrected.summary.itemObservations).toMatchObject({obtainedCount:0,obtainedQuantity:0,items:[]});
  });
  it('preserves deterministic occurrence counters across batches and rebuilds',()=>{
    const source=fixture(),one=new IncrementalReplayParser(source.bootstrap,'copy.rrf'),two=new IncrementalReplayParser(source.bootstrap,'copy.rrf');
    const a=push(one,frame(ack(),100)),b=push(one,frame(ack(),100)),combined=push(two,concat(frame(ack(),100),frame(ack(),100)));
    expect(a.events[0].rawData?.inventoryOccurrence).toBe(1);expect(b.events.find(event=>event.id==='packet-2')?.rawData?.inventoryOccurrence).toBe(2);
    expect(combined.events.map(event=>({id:event.id,occurrence:event.rawData?.inventoryOccurrence}))).toEqual([{id:'packet-1',occurrence:1},{id:'packet-2',occurrence:2}]);
    expect(a.incremental?.recordingStart).toBe(true);expect(b.incremental?.recordingStart).toBe(false);
  });
  it('keeps initial inventory ACKs excluded, own deaths and map-reset life proofs deterministic',()=>{
    const source=fixture([{time:1,data:spawn(100)},{time:2,data:damage(100)},{time:3,data:death(100)},{time:4,data:death(42)},{time:5,data:map()},{time:6,data:spawn(100)},{time:7,data:death(100)}],ack()),expected=parseReplay(source.full.buffer,'initial.rrf');
    const parser=new IncrementalReplayParser(source.bootstrap,'initial.rrf'),result=push(parser,source.frames,true);
    expect(result.summary).toEqual(expected.summary);expect(result.events.find(event=>event.eventType==='inventory-ack')?.rawData?.inventoryBaseline).toBe(true);
    const proof=(event:ReplayEvent)=>{const {lifecycleId,...rest}=event.rawData?.killProof as Record<string,unknown>;return rest;};
    expect(result.events.filter(event=>event.eventType==='death').map(proof)).toEqual(expected.events.filter(event=>event.eventType==='death').map(proof));
    expect(result.events.filter(event=>event.eventType==='death').every(event=>String((event.rawData?.killProof as Record<string,unknown>).lifecycleId).startsWith('wire:'))).toBe(true);
    expect(result.events.filter(event=>event.eventType==='player-death')).toHaveLength(1);
  });
  it('handles more than 400000 packets and over seven days without retaining unknown history',()=>{
    const source=fixture(),parser=new IncrementalReplayParser(source.bootstrap,'long.rrf'),sample=frame(unknown(),8*24*3600000),batch=bytes(sample.length*1000);
    for(let at=0;at<batch.length;at+=sample.length)batch.set(sample,at);
    let result;
    for(let i=0;i<520;i++)result=push(parser,batch);
    expect(result!.status).toBe('partial');expect(result!.packetCount).toBe(520000);expect(result!.events).toEqual([]);expect(result!.unknownPackets).toEqual([{packetId:'0x7777',count:520000}]);expect(result!.summary.durationMs).toBe(8*24*3600000);expect(result!.diagnostics.length).toBeLessThan(10);
  });
  it.each([false,true])('keeps over 100000 completed actor lives bounded; frequent maps=%s',frequentMaps=>{
    const source=fixture(),parser=new IncrementalReplayParser(source.bootstrap,'actor-lives.rrf');let result;
    for(let batch=0;batch<110;batch++){
      const frames:Uint8Array[]=[];
      for(let i=0;i<1000;i++){
        const aid=batch*1000+i+100,time=(batch*1000+i)*1000;
        frames.push(frame(spawn(aid),time),frame(death(aid),time+1));
        if(i%2===0){const vanish=death(aid);vanish[6]=0;frames.push(frame(vanish,time+2));}
        if(frequentMaps&&i%50===49)frames.push(frame(map(),time+3));
      }
      result=push(parser,concat(...frames));expect(result.status).not.toBe('invalid');
    }
    expect(result!.summary.observedDeaths).toBe(110000);expect(result!.summary.monsters[0].observedDeaths).toBe(110000);
    const context=parser as unknown as {entities:Map<number,unknown>;deadContexts:Map<number,unknown>;seenDeaths:Set<number>};
    expect(context.entities.size).toBeLessThanOrEqual(4096);expect(context.deadContexts.size).toBeLessThanOrEqual(4096);expect(context.seenDeaths.size).toBeLessThanOrEqual(4096);
  });
  it('uses stable wire identity when an actor id starts a new observed life',()=>{
    const source=fixture(),one=new IncrementalReplayParser(source.bootstrap,'reused.rrf'),two=new IncrementalReplayParser(source.bootstrap,'reused.rrf'),frames=concat(frame(spawn(100),0),frame(death(100),1),frame(spawn(100),40000),frame(death(100),40001));
    const together=push(one,frames,true),splitA=push(two,frames.subarray(0,95)),splitB=push(two,frames.subarray(95),true),split=[...splitA.events,...splitB.events];
    const ids=(events:ReplayEvent[])=>events.filter(event=>event.eventType==='death').map(event=>(event.rawData?.killProof as Record<string,unknown>).lifecycleId);
    expect(ids(together.events)).toEqual(['wire:0:100:0:1','wire:0:100:40000:1']);expect(ids(split)).toEqual(ids(together.events));expect(together.summary.observedDeaths).toBe(2);
  });
  it('keeps death life identity stable when unrelated unknown/status frames are inserted',()=>{
    const baseline=fixture([{time:0,data:status(24,123)},{time:100,data:spawn(100)},{time:101,data:damage(100)},{time:102,data:death(100)},{time:200,data:spawn(100)},{time:201,data:death(100)}]);
    const rewritten=fixture([{time:0,data:status(24,123)},{time:50,data:unknown()},{time:75,data:status(24,123)},{time:100,data:spawn(100)},{time:101,data:damage(100)},{time:102,data:death(100)},{time:150,data:unknown()},{time:200,data:spawn(100)},{time:201,data:death(100)}]);
    const first=push(new IncrementalReplayParser(baseline.bootstrap,'stable.rrf'),baseline.frames,true),second=push(new IncrementalReplayParser(rewritten.bootstrap,'stable.rrf'),rewritten.frames,true);
    const ids=(events:ReplayEvent[])=>events.filter(event=>event.eventType==='death').map(event=>(event.rawData?.killProof as Record<string,unknown>).lifecycleId);
    expect(ids(first.events)).toEqual(['wire:0:100:100:1','wire:0:100:200:1']);expect(ids(second.events)).toEqual(ids(first.events));expect(second.summary).toEqual(first.summary);
  });
  it('distinguishes explicit revive lives at one timestamp and ignores ordinary visibility updates',()=>{
    const source=fixture(),revive=packet(0x0148,8);view(revive).setUint32(2,100,true);
    const frames=concat(frame(spawn(100),100),frame(spawn(100),100),frame(death(100),100),frame(revive,100),frame(spawn(100),100),frame(death(100),100));
    const result=push(new IncrementalReplayParser(source.bootstrap,'revived.rrf'),frames,true);
    const deaths=result.events.filter(event=>event.eventType==='death');
    expect(deaths.map(event=>(event.rawData?.killProof as Record<string,unknown>).lifecycleId)).toEqual(['wire:0:100:100:1','wire:0:100:100:2']);
    expect(result.summary.observedDeaths).toBe(2);
  });
  it('keeps same-timestamp lifecycle occurrences identical across fragmented batch boundaries',()=>{
    const source=fixture(),revive=packet(0x0148,8);view(revive).setUint32(2,100,true);
    const frames=concat(frame(spawn(100),100),frame(death(100),100),frame(revive,100),frame(spawn(100),100),frame(death(100),100),frame(map(),101),frame(spawn(100),101),frame(death(100),101));
    const one=push(new IncrementalReplayParser(source.bootstrap,'batch.rrf'),frames,true),parser=new IncrementalReplayParser(source.bootstrap,'batch.rrf'),events:ReplayEvent[]=[];
    for(let at=0;at<frames.length;at+=17)events.push(...push(parser,frames.subarray(at,at+17)).events);
    const ids=(list:ReplayEvent[])=>list.filter(event=>event.eventType==='death').map(event=>(event.rawData?.killProof as Record<string,unknown>).lifecycleId);
    expect(ids(events)).toEqual(ids(one.events));expect(ids(events)).toEqual(['wire:0:100:100:1','wire:0:100:100:2','wire:1:100:101:1']);
  });
  it('preserves the last completed summary and stops on malformed or out-of-order input',()=>{
    const source=fixture(),parser=new IncrementalReplayParser(source.bootstrap,'broken.rrf'),valid=push(parser,frame(status(5,8000),100));
    const invalid=push(parser,concat(frame(status(5,7000),200),frame(unknown(),50)));
    expect(invalid.status).toBe('invalid');expect(invalid.events).toEqual([]);expect(invalid.packetCount).toBe(1);expect(invalid.summary).toEqual(valid.summary);expect(invalid.diagnostics.at(-1)?.message).toContain('INVALID_TIMESTAMP_ORDER');
    expect(push(parser,frame(status(5,6000),300)).summary).toEqual(valid.summary);
  });
  it('retains a partial tail and never matures a closed truncated ACK using missing evidence',()=>{
    const source=fixture(),parser=new IncrementalReplayParser(source.bootstrap,'tail.rrf'),receipt=frame(ack(),100),next=frame(unknown(),600);
    const first=push(parser,concat(receipt,next.subarray(0,12)),true);
    expect(first.packetCount).toBe(1);expect(first.summary.inventoryFlow?.pendingCount).toBe(1);expect(first.diagnostics.some(d=>d.code==='TRUNCATED_PACKET')).toBe(true);
    const completed=push(parser,next.subarray(12));expect(completed.packetCount).toBe(2);expect(completed.summary.inventoryFlow?.incomingQuantity).toBe(0);
  });
  it('matches bundled real fixture summary without loading the session into parser memory',()=>{
    const file=readFileSync('tests/fixtures/latam-mergulho-test.rrf'),raw=file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength),expected=parseReplay(raw,'fixture.rrf'),sections:IncrementalReplayBootstrap['sections']=[],frames:Uint8Array[]=[];
    const h=new DataView(raw);
    for(let slot=0;slot<24;slot++){const at=112+slot*10,type=h.getUint16(at,true),declared=h.getInt32(at+2,true),offset=h.getInt32(at+6,true);if(!declared&&!offset)continue;const length=declared||file.length-offset,data=new Uint8Array(raw,offset,length);if(type===1)frames.push(data);else if([2,3,8,14,15].includes(type))sections.push({type,data,offset});}
    const parser=new IncrementalReplayParser({header:raw.slice(0,352),sections},'fixture.rrf');let result;
    for(const part of frames)for(let at=0;at<part.length;at+=1024)result=push(parser,part.subarray(at,at+1024));result=push(parser,bytes(0),true);
    expect(result.status).not.toBe('invalid');expect(result.packetCount).toBe(expected.packetCount);expect(result.summary).toEqual(expected.summary);
  });
});
