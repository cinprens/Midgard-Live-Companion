import {describe,expect,it} from 'vitest';
import {mkdirSync,mkdtempSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ExpansionStore} from '../electron/expansion-store';
import {IncrementalReplayParser} from '../src/parser/incremental';
import type {ParsedReplay} from '../src/parser/types';

const bytes=(n:number)=>new Uint8Array(n),view=(data:Uint8Array)=>new DataView(data.buffer,data.byteOffset,data.byteLength);
const concat=(...parts:Uint8Array[])=>{const result=bytes(parts.reduce((sum,part)=>sum+part.length,0));let at=0;for(const part of parts){result.set(part,at);at+=part.length;}return result;};
const packet=(id:number,n:number)=>{const result=bytes(n);view(result).setUint16(0,id,true);return result;};
const u32=(value:number)=>{const result=bytes(4);view(result).setUint32(0,value,true);return result;};
const tlv=(tag:number,data:Uint8Array)=>{const head=bytes(6);view(head).setInt16(0,tag,true);view(head).setInt32(2,data.length,true);return concat(head,data);};
function encrypt(input:Uint8Array){const result=new Uint8Array(input),date=bytes(4);view(date).setInt16(0,2026,true);date[2]=11;date[3]=1;const k1=view(date).getInt32(0,true)>>5,k2=(12<<8)>>3;for(let i=0;i<Math.floor(result.length/4);i++)view(result).setInt32(i*4,view(input).getInt32(i*4,true)^Math.imul(k1+i+1,k2),true);return result;}
function frame(time:number,data:Uint8Array){const head=bytes(10);view(head).setInt32(4,time,true);view(head).setUint16(8,data.length,true);return concat(head,encrypt(data));}
const start=(type:number)=>{const p=packet(0x0b08,5);view(p).setUint16(2,5,true);p[4]=type;return p;};
const end=(type:number)=>{const p=packet(0x0b0b,4);p[2]=type;return p;};
const list=(type:number)=>{const p=packet(0x0b09,39);view(p).setUint16(2,39,true);p[4]=type;view(p).setUint16(5,type===0?7:299,true);view(p).setUint32(7,501,true);p[11]=3;view(p).setUint16(12,20,true);return p;};
const hp=(amount:number)=>{const p=packet(0x00b0,8);view(p).setUint16(2,5,true);view(p).setInt32(4,amount,true);return p;};
const weight=(amount:number)=>{const p=packet(0x00b0,8);view(p).setUint16(2,24,true);view(p).setInt32(4,amount,true);return p;};
const ack=(amount:number)=>{const p=packet(0x0b41,70);view(p).setUint16(2,7,true);view(p).setUint16(4,amount,true);view(p).setUint32(6,501,true);p[10]=1;p[32]=3;return p;};
const deposit=()=>{const p=packet(0x0a0a,57);view(p).setUint16(2,299,true);view(p).setUint32(4,3,true);view(p).setUint32(8,501,true);p[12]=3;p[13]=1;return p;};
const withdrawal=()=>{const p=packet(0x00f6,8);view(p).setUint16(2,299,true);view(p).setUint32(4,3,true);return p;};
const remove=()=>{const p=packet(0x07fa,8);view(p).setUint16(2,4,true);view(p).setUint16(4,7,true);view(p).setUint16(6,3,true);return p;};
const map=()=>{const p=packet(0x0091,22);p.set(new TextEncoder().encode('qa_storage\0'),2);return p;};
function parser(){const head=bytes(352);head.set(new TextEncoder().encode('<< Ragnarok Replay File Version 0.05 >>'));head[100]=5;view(head).setInt16(104,2026,true);head[106]=11;head[107]=1;head[109]=12;const seed=concat(tlv(281,bytes(0)),tlv(285,u32(7)),tlv(287,u32(20)),tlv(291,u32(501)),tlv(282,bytes(0)));return new IncrementalReplayParser({header:head.buffer,sections:[{type:3,offset:352,data:encrypt(tlv(1010,u32(42)))},{type:8,offset:368,data:encrypt(tlv(4510,seed))}]},'SYNTHETIC-storage-cycle.rrf');}
function context(){mkdirSync('.qa',{recursive:true});const directory=mkdtempSync(path.resolve('.qa/storage-cycle-')),database=path.join(directory,'test.sqlite'),sourcePath=path.join(directory,'SYNTHETIC-only.rrf');return{directory,database,sourcePath};}
const identity={key:'recorded:42:StorageTest',name:'SYNTHETIC Storage',source:'recorded' as const,playerId:42};
function replay(store:ExpansionStore,p:IncrementalReplayParser,sourcePath:string,entries:[number,Uint8Array][],chunkSize=100000){const wire=concat(...entries.map(([time,data])=>frame(time,data)));let result:ParsedReplay|undefined;for(let at=0;at<wire.length;at+=chunkSize){const part=wire.slice(at,at+chunkSize);result=p.push(part.buffer,{closed:false});expect(result.status).not.toBe('invalid');store.autoFarm.observe(result,{sourcePath,streamId:'test',recordingId:'same-recording',hash:`${at}-${wire.length}`,bootstrap:true,includeReplayHistory:result.events.some(event=>event.rawData?.inventoryHistoryReliable===true)},identity);}return result!;}

describe('storage wire to persistent farm income',()=>{
  it.each([true,false])('keeps a deposit/withdrawal at zero then counts two real items once across reopen; withdrawal first %s',first=>{
    const c=context();let store=new ExpansionStore(c.database);let p=parser();
    const baseline:[number,Uint8Array][]=[[0,hp(1000)],[1,weight(100)]];
    replay(store,p,c.sourcePath,baseline);
    const cycle:[number,Uint8Array][]=[[100,map()],[101,start(2)],[102,end(2)],[200,remove()],[201,deposit()],[250,weight(100)],...(first?[[300,withdrawal()],[301,ack(3)]]:[[300,ack(3)],[301,withdrawal()]]) as [number,Uint8Array][],[302,packet(0x08ae,2)],[303,weight(130)],[1000,hp(900)],[1001,weight(130)]];
    // The tolerated control frame is physically between progressing packets with raw time zero.
    cycle.find(([,data])=>view(data).getUint16(0,true)===0x08ae)![0]=0;
    const result=replay(store,p,c.sourcePath,cycle,first?13:100000);
    expect(result.summary.liveTelemetry?.hp).toBe(900);expect(store.autoFarm.snapshot().totals.quantity).toBe(0);
    const drops:[number,Uint8Array][]=[[1200,ack(2)],[1250,weight(150)],[1800,hp(800)]];replay(store,p,c.sourcePath,drops,17);
    expect(store.autoFarm.snapshot().totals.quantity).toBe(2);store.close();
    store=new ExpansionStore(c.database);p=parser();replay(store,p,c.sourcePath,[...baseline,...cycle,...drops],7);expect(store.autoFarm.snapshot().totals.quantity).toBe(2);store.close();
    const db=new DatabaseSync(c.database,{readOnly:true});try{expect(db.prepare('SELECT quantity,decoder_revision,excluded_reason FROM autofarm_receipts').all()).toEqual([{quantity:2,decoder_revision:3,excluded_reason:null}]);}finally{db.close();}
  });
  it('keeps healthy bag gains after a bad depot list but excludes unresolved withdrawals',()=>{
    const c=context(),store=new ExpansionStore(c.database),p=parser();try{
      replay(store,p,c.sourcePath,[[0,hp(1000)],[1,weight(100)],[100,start(2)],[101,list(2).slice(0,38)],[102,end(2)],[200,withdrawal()],[201,ack(3)],[202,weight(130)],[800,hp(900)],[801,weight(130)]]);
      expect(store.autoFarm.snapshot().totals.quantity).toBe(0);
      const result=replay(store,p,c.sourcePath,[[1200,ack(2)],[1250,weight(150)],[1800,hp(800)]]);
      expect(result.summary.inventoryFlow?.baselineKnown).toBe(true);expect(result.summary.liveTelemetry?.hp).toBe(800);expect(store.autoFarm.snapshot().totals.quantity).toBe(2);
    }finally{store.close();}
  });
  it('requires a complete fresh bag after an interrupted bag list while HP and map keep updating',()=>{
    const c=context(),store=new ExpansionStore(c.database),p=parser();try{
      const held=replay(store,p,c.sourcePath,[[0,hp(1000)],[1,weight(100)],[100,start(0)],[101,map()],[200,ack(3)],[201,weight(130)],[800,hp(900)]]);
      expect(held.summary.inventoryFlow?.baselineKnown).toBe(false);expect(store.autoFarm.snapshot().totals.quantity).toBe(0);
      const result=replay(store,p,c.sourcePath,[[900,start(0)],[901,list(0)],[902,end(0)],[903,weight(130)],[1200,ack(2)],[1250,weight(150)],[1800,hp(800)]]);
      expect(result.summary.inventoryFlow?.baselineKnown).toBe(true);expect(store.autoFarm.snapshot().totals.quantity).toBe(2);
    }finally{store.close();}
  });
});
