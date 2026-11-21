import {describe,expect,it} from 'vitest';
import {IncrementalReplayParser,isConfirmedPersonalKill,isOwnDamageKill,parseReplay} from '../src/parser';
import type {IncrementalReplayBootstrap,ReplayEvent} from '../src/parser';

type Packet={time:number;data:Buffer};
const packet=(id:number,length:number)=>{const data=Buffer.alloc(length);data.writeUInt16LE(id);return data;};
const spawn=(aid:number,kind=5)=>{const data=packet(0x0857,74);data.writeUInt16LE(data.length,2);data[4]=kind;data.writeUInt32LE(aid,5);data.writeInt16LE(kind===5?1002:1,19);data.write('Hode\0',69);return data;};
const vanish=(aid:number,kind=1)=>{const data=packet(0x0080,7);data.writeUInt32LE(aid,2);data[6]=kind;return data;};
const damage=(source:number,target:number,amount=100)=>{const data=packet(0x02e1,33);data.writeUInt32LE(source,2);data.writeUInt32LE(target,6);data.writeInt32LE(amount,22);data.writeInt16LE(1,26);return data;};
const spDamage=()=>{const data=packet(0x08c8,34);data.writeUInt32LE(42,2);data.writeUInt32LE(100,6);data.writeInt32LE(100,22);data[26]=1;data.writeInt16LE(1,27);return data;};
const at=(time:number,data:Buffer):Packet=>({time,data});

// Independent v5 fixture encoder; both parser paths consume the resulting packet bytes.
function encrypt(input:Buffer):Buffer {
  const data=Buffer.from(input),date=Buffer.alloc(4);date.writeInt16LE(2026);date[2]=11;date[3]=1;
  const first=date.readInt32LE()>>5,second=(12<<8)>>3;
  for(let index=0;index<Math.floor(data.length/4);index++)data.writeInt32LE(data.readInt32LE(index*4)^Math.imul(first+index+1,second),index*4);
  return data;
}
const arrayBuffer=(data:Uint8Array)=>Uint8Array.from(data).buffer;
function fixture(packets:Packet[]) {
  const header=Buffer.alloc(352);header.write('<< Ragnarok Replay File Version 0.05 >>');header[100]=5;
  header.writeInt16LE(2026,104);header[106]=11;header[107]=1;header[109]=12;
  const sessionPlain=Buffer.alloc(10);sessionPlain.writeInt16LE(1010);sessionPlain.writeInt32LE(4,2);sessionPlain.writeUInt32LE(42,6);
  const session=encrypt(sessionPlain),frames=Buffer.concat(packets.map(({time,data},index)=>{
    const frame=Buffer.alloc(10);frame.writeInt32LE(index);frame.writeInt32LE(time,4);frame.writeUInt16LE(data.length,8);
    return Buffer.concat([frame,encrypt(data)]);
  }));
  header.writeUInt16LE(1,112);header.writeInt32LE(frames.length,114);header.writeInt32LE(header.length+session.length,118);
  header.writeUInt16LE(3,122);header.writeInt32LE(session.length,124);header.writeInt32LE(header.length,128);
  const bootstrap:IncrementalReplayBootstrap={header:arrayBuffer(header),sections:[{type:3,data:session,offset:header.length}]};
  return{bootstrap,frames,full:arrayBuffer(Buffer.concat([header,session,frames]))};
}
const cases:{name:string;packets:Packet[];expected:number[]}[]=[
  {name:'own positive HP damage',packets:[at(0,spawn(100)),at(10,damage(42,100)),at(20,vanish(100))],expected:[100]},
  {name:'nearby death without own damage',packets:[at(0,spawn(100)),at(20,vanish(100))],expected:[]},
  {name:'another player damage',packets:[at(0,spawn(99,0)),at(1,spawn(100)),at(10,damage(99,100)),at(20,vanish(100))],expected:[]},
  {name:'mixed attackers',packets:[at(0,spawn(100)),at(10,damage(42,100)),at(11,damage(99,100)),at(20,vanish(100))],expected:[]},
  {name:'earlier competing attacker',packets:[at(0,spawn(100)),at(10,damage(99,100)),at(20000,damage(42,100)),at(20001,vanish(100))],expected:[]},
  {name:'SP-only damage',packets:[at(0,spawn(100)),at(10,spDamage()),at(20,vanish(100))],expected:[]},
  {name:'zero damage',packets:[at(0,spawn(100)),at(10,damage(42,100,0)),at(20,vanish(100))],expected:[]},
  {name:'reused target lifecycle',packets:[at(0,spawn(100)),at(10,damage(42,100)),at(20,vanish(100)),at(30,spawn(100)),at(40,vanish(100))],expected:[100]},
  {name:'damage before leaving visibility',packets:[at(0,spawn(100)),at(10,damage(42,100)),at(20,vanish(100,0)),at(30,spawn(100)),at(40,vanish(100))],expected:[]},
  {name:'stale own damage',packets:[at(0,spawn(100)),at(10,damage(42,100)),at(10011,vanish(100))],expected:[]},
  {name:'damage to a different target',packets:[at(0,spawn(100)),at(1,spawn(101)),at(10,damage(42,100)),at(20,vanish(101))],expected:[]},
  {name:'damage without death',packets:[at(0,spawn(100)),at(10,damage(42,100))],expected:[]},
  {name:'unresolved companion attacker',packets:[at(0,spawn(100)),at(10,damage(77,100)),at(20,vanish(100))],expected:[]},
  {name:'non-mob death',packets:[at(0,spawn(100,0)),at(10,damage(42,100)),at(20,vanish(100))],expected:[]},
];

describe.each(['full','incremental'] as const)('%s parser own-damage filtering',mode=>{
  it.each(cases)('$name',({packets,expected})=>{
    const source=fixture(packets);let events:ReplayEvent[];
    if(mode==='full'){
      const result=parseReplay(source.full,'own-damage.rrf');expect(result.status).not.toBe('invalid');expect(result.summary.playerId).toBe(42);events=result.events;
    }else{
      const parser=new IncrementalReplayParser(source.bootstrap,'own-damage.rrf');events=[];
      for(let offset=0;offset<source.frames.length;offset+=11){
        const result=parser.push(arrayBuffer(source.frames.subarray(offset,offset+11)),{closed:false});
        expect(result.status).not.toBe('invalid');expect(result.summary.playerId).toBe(42);events.push(...result.events);
      }
      events.push(...parser.push(new ArrayBuffer(0),{closed:true}).events);
    }
    expect(events.filter(event=>isOwnDamageKill(event,42)).map(event=>event.targetId)).toEqual(expected);
    expect(events.filter(event=>isConfirmedPersonalKill(event,42))).toEqual([]);
  });
});
