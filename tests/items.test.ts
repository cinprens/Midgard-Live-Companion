import { describe,expect,it } from 'vitest';
import { decodeItemObservation,parseReplay,summarizeItemObservations } from '../src/parser';

const make=(length:number,id:number)=>{const bytes=new Uint8Array(length);new DataView(bytes.buffer).setUint16(0,id,true);return bytes;};
const view=(bytes:Uint8Array)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
function ground(id=0x0add,modern=true,aid=701,item=501,quantity=3){
  const data=make(id===0x0add?(modern?24:22):id===0x084b?19:17,id);
  view(data).setUint32(2,aid,true);if(modern&&id===0x0add)view(data).setUint32(6,item,true);else view(data).setUint16(6,item,true);
  const flags=id===0x009d||id===0x009e?8:modern&&id===0x0add?12:10;
  data[flags]=1;view(data).setInt16(flags+1,120,true);view(data).setInt16(flags+3,150,true);
  view(data).setInt16(flags+(id===0x009d?5:7),quantity,true);return data;
}
function obtained(id=0x0a37,length=69,item=7642,quantity=3,result=0){
  const data=make(length,id);view(data).setUint16(2,7,true);view(data).setUint16(4,quantity,true);
  if(length===59)view(data).setUint16(6,item,true);else view(data).setUint32(6,item,true);
  data[length===59?8:10]=1;data[length===59?24:id===0x0a37?34:33]=result;return data;
}
function concat(...parts:Uint8Array[]){const output=new Uint8Array(parts.reduce((sum,b)=>sum+b.length,0));let at=0;for(const part of parts){output.set(part,at);at+=part.length;}return output;}
function encode(bytes:Uint8Array){
  const result=new Uint8Array(bytes);const date=new Uint8Array(4);view(date).setInt16(0,2026,true);date[2]=11;date[3]=1;
  const key1=view(date).getInt32(0,true)>>5,key2=(12<<8)>>3;
  for(let i=0;i<Math.floor(bytes.length/4);i++)view(result).setInt32(i*4,view(bytes).getInt32(i*4,true)^Math.imul(key1+i+1,key2),true);return result;
}
function rrf(packets:Uint8Array[]){
  const header=new Uint8Array(352);header.set(new TextEncoder().encode('<< Ragnarok Replay File Version 0.05 >>'));header[100]=5;view(header).setInt16(104,2026,true);header[106]=11;header[107]=1;header[109]=12;
  const stream=concat(...packets.map((packet,index)=>{const head=new Uint8Array(10);view(head).setInt32(0,index,true);view(head).setInt32(4,index*100,true);view(head).setUint16(8,packet.length,true);return concat(head,encode(packet));}));
  view(header).setUint16(112,1,true);view(header).setInt32(114,stream.length,true);view(header).setInt32(118,352,true);return concat(header,stream).buffer;
}
describe('source-defined item observations, not personal monster drops',()=>{
  it('decodes documented ground variants with the correct item width and quantity offset',()=>{
    for(const [id,modern] of [[0x009d,false],[0x009e,false],[0x084b,false],[0x0add,false],[0x0add,true]] as const){
      expect(decodeItemObservation(ground(id,modern))).toMatchObject({kind:'ground',itemId:501,amount:3,groundEntityId:701,x:120,y:150});
    }
    expect(decodeItemObservation(ground(0x0add,true,701,100001))).toMatchObject({itemId:100001});
  });
  it('decodes successful inventory additions in 16-bit, 32-bit and modern refine layouts',()=>{
    for(const [id,length] of [[0x0a37,59],[0x0a37,69],[0x0b41,70]]){
      const data=obtained(id,length),resultOffset=length===59?24:id===0x0a37?34:33;
      data[resultOffset-1]=4;view(data).setUint32(resultOffset-5,0x1400,true);
      expect(decodeItemObservation(data)).toEqual({kind:'obtained',itemId:7642,amount:3,slot:5,result:0,itemType:4,equipLocation:0x1400});
    }
  });
  it('reads the modern 19-byte floor-entry layout with a 32-bit item ID',()=>{
    const data=make(19,0x009d);view(data).setUint32(2,701,true);view(data).setUint32(6,601,true);
    data[10]=1;view(data).setInt16(11,120,true);view(data).setInt16(13,150,true);view(data).setInt16(15,3,true);data[17]=6;data[18]=9;
    expect(decodeItemObservation(data)).toEqual({kind:'ground',groundEntityId:701,itemId:601,amount:3,x:120,y:150,appearance:'entry'});
    const result=parseReplay(rrf([data]),'modern-entry.rrf');
    expect(result.summary.itemObservations).toMatchObject({groundCount:1,groundQuantity:3,personalDropCount:null});
    expect(result.summary.dropCount).toBeNull();expect(result.compatibility).toBe('skadi-unverified');
    view(data).setUint32(6,100001,true);expect(decodeItemObservation(data)).toMatchObject({itemId:100001});
    expect(decodeItemObservation(data.subarray(0,18))).toMatchObject({kind:'invalid'});
  });
  it('does not turn a failed pickup response into an obtained item',()=>{
    for(const [id,length] of [[0x0a37,59],[0x0a37,69],[0x0b41,70]])expect(decodeItemObservation(obtained(id,length,7642,3,6))).toEqual({kind:'failed',result:6,slot:7});
    const parsed=parseReplay(rrf([obtained(0x0a37,69,7642,3,6)]),'failed.rrf');
    expect(parsed.events.filter(e=>e.eventType==='item-obtained')).toHaveLength(0);expect(parsed.diagnostics.some(d=>d.code==='ITEM_RECEIVE_FAILED')).toBe(true);
  });
  it('rejects cut or unknown layouts instead of shifting fields',()=>{
    expect(decodeItemObservation(obtained().subarray(0,68))?.kind).toBe('invalid');
    expect(decodeItemObservation(make(67,0x0a37))?.kind).toBe('invalid');
    expect(decodeItemObservation(ground(0x0add,true,701,501,0))?.kind).toBe('invalid');
    const result=parseReplay(rrf([make(67,0x0a37)]),'unknown-layout.rrf');expect(result.unknownPackets).toContainEqual({packetId:'0x0a37',count:1});
  });
  it('deduplicates repeated appearances in one observed lifecycle while allowing an ID reused after disappearance',()=>{
    const disappear=make(6,0x00a1);view(disappear).setUint32(2,701,true);
    const result=parseReplay(rrf([ground(),ground(),disappear,ground(),obtained()]),'items.rrf');
    expect(result.summary.itemObservations).toMatchObject({groundCount:2,groundQuantity:6,obtainedCount:0,obtainedQuantity:0,personalDropCount:null,confidence:'observed-only'});
    expect(result.summary.dropCount).toBeNull();expect(result.summary.totalExp).toBeNull();expect(result.compatibility).toBe('skadi-unverified');
    expect(result.events.filter(e=>e.eventType==='item-ground')).toHaveLength(2);
    expect(result.events.find(e=>e.eventType==='inventory-ack')?.rawData?.monsterOriginUnknown).toBe(true);
  });
  it('resets floor-item visibility on a map change without assigning loot ownership',()=>{
    const map=make(22,0x0091);map.set(new TextEncoder().encode('other_map'),2);
    const result=parseReplay(rrf([ground(),map,ground()]),'map-items.rrf');expect(result.summary.itemObservations?.groundCount).toBe(2);
    expect(result.events.filter(e=>e.eventType==='item-ground').every(e=>e.attribution==='unknown')).toBe(true);
  });
  it('does not equate matching item IDs with the same ground object',()=>{
    const result=parseReplay(rrf([ground(0x0add,true,701),ground(0x0add,true,702)]),'two-items.rrf');expect(result.summary.itemObservations?.groundCount).toBe(2);
    const doubled=[...result.events,...result.events];expect(summarizeItemObservations(doubled).groundCount).toBe(2);
  });
});
