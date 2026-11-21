import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {appendFile,mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {ReplayFileSession,type BridgeMeta} from '../electron/live/file-session';
import {ReplayBridge} from '../electron/live/replay-bridge';
import type {ParsedReplay} from '../src/parser/types';

const qa=path.resolve('.qa'),directories:string[]=[],bridges:ReplayBridge[]=[];
let workerPath:string;
const signal=()=>new AbortController().signal;
const request=(sourcePath:string,streamId='source',verify=false)=>({sourcePath,streamId,filename:path.basename(sourcePath),verify});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function directory(){await mkdir(qa,{recursive:true});const dir=await mkdtemp(path.join(qa,'bridge-test-'));directories.push(dir);return dir;}
async function source(bytes:Uint8Array){const file=path.join(await directory(),'source.rrf');await writeFile(file,bytes);return file;}
function encrypted(input:Uint8Array){const result=new Uint8Array(input),v=new DataView(result.buffer);const a=((2026|(11<<16)|(1<<24))>>5),b=(12<<8)>>3;for(let i=0;i<Math.floor(result.length/4);i++)v.setInt32(i*4,v.getInt32(i*4,true)^Math.imul(a+i+1,b),true);return result;}
function concat(parts:Uint8Array[]){const result=new Uint8Array(parts.reduce((sum,p)=>sum+p.length,0));let at=0;for(const p of parts){result.set(p,at);at+=p.length;}return result;}
function generic(id:number,data:Uint8Array){const head=new Uint8Array(6),v=new DataView(head.buffer);v.setInt16(0,id,true);v.setInt32(2,data.length,true);return concat([head,data]);}
function word(value:number){const bytes=new Uint8Array(4);new DataView(bytes.buffer).setUint32(0,value,true);return bytes;}
function packet(index:number){const bytes=new Uint8Array(8),v=new DataView(bytes.buffer);v.setUint16(0,0x00b0,true);v.setUint16(2,24,true);v.setUint32(4,index,true);return bytes;}
function frame(index:number){const data=packet(index),head=new Uint8Array(10),v=new DataView(head.buffer);v.setInt32(0,index,true);v.setInt32(4,index*100,true);v.setUint16(8,data.length,true);return concat([head,encrypted(data)]);}
function replay(count:number,open=false){
 const header=new Uint8Array(352),view=new DataView(header.buffer);header.set(new TextEncoder().encode('<< Ragnarok Replay File Version 0.05 >>'));header[100]=5;view.setInt16(104,2026,true);header[106]=11;header[107]=1;header[109]=12;
 const metadata=encrypted(concat([generic(0,new Uint8Array()),generic(1,new Uint8Array()),generic(2,new Uint8Array()),generic(3,new Uint8Array()),generic(964,new TextEncoder().encode('Synthetic\0')),generic(965,new TextEncoder().encode('test_map\0')),generic(970,word(count*100)),generic(971,word(count*200)),generic(972,word(count*300))]));
 const session=encrypted(generic(1010,word(42))),stream=concat(Array.from({length:count},(_,i)=>frame(i+1)));
 const components=open?[{type:2,data:metadata},{type:3,data:session},{type:1,data:stream}]:[{type:1,data:stream},{type:3,data:session},{type:2,data:metadata}];let at=352;
 for(let i=0;i<components.length;i++){const item=components[i],offset=112+i*10;view.setUint16(offset,item.type,true);view.setInt32(offset+2,item.type===1&&open?0:item.data.length,true);view.setInt32(offset+6,at,true);at+=item.data.length;}
 return concat([header,...components.map(v=>v.data)]);
}
function batches(){const list:{parsed:ParsedReplay;meta:BridgeMeta}[]=[];return{list,handle:async(parsed:ParsedReplay,meta:BridgeMeta)=>{list.push({parsed,meta});}};}

beforeAll(async()=>{const dir=await directory();workerPath=path.join(dir,'bridge-worker.cjs');await build({entryPoints:[path.resolve('electron/live/bridge-worker.ts')],outfile:workerPath,bundle:true,platform:'node',format:'cjs',target:'node24',external:['node:*']});});
afterEach(async()=>{await Promise.all(bridges.splice(0).map(bridge=>bridge.close()));});
afterAll(async()=>{for(const dir of directories){const absolute=path.resolve(dir);if(!absolute.startsWith(qa+path.sep))throw Error('Test cleanup outside .qa refused.');await rm(absolute,{recursive:true,force:true});}});

describe('bounded incremental Replay file session',()=>{
 it('keeps all initial catch-up batches silent and processes only the appended frame',async()=>{
  const bytes=replay(100,true),file=await source(bytes),session=new ReplayFileSession({batchBytes:1024}),first=batches();
  const start=await session.run(request(file),signal(),first.handle);
  expect(first.list.length).toBeGreaterThan(2);expect(first.list.every(batch=>batch.meta.initial)).toBe(true);expect(first.list.at(-1)!.parsed.packetCount).toBe(100);expect(start.readPosition).toBe(bytes.length);
  await appendFile(file,frame(101));const next=batches();const end=await session.run(request(file),signal(),next.handle);
  expect(next.list).toHaveLength(2);expect(next.list.every(batch=>!batch.meta.initial&&!batch.meta.recordingReset)).toBe(true);expect(next.list[0].parsed.incremental?.recordingStart).toBe(false);expect(next.list.at(-1)!.parsed.packetCount).toBe(101);
  expect(end.bytesReadTotal-start.bytesReadTotal).toBeLessThan(1024);expect(end.readPosition).toBe(bytes.length+18);
 });
 it('resumes a growing closed replay whose metadata moves after its packet region',async()=>{
  const file=await source(replay(100)),session=new ReplayFileSession({batchBytes:1024});await session.run(request(file),signal(),async()=>{});
  await writeFile(file,replay(101));const next=batches();await session.run(request(file),signal(),next.handle);
  expect(next.list.every(v=>!v.meta.initial&&!v.meta.recordingReset)).toBe(true);expect(next.list[0].parsed.incremental?.recordingStart).toBe(false);expect(next.list.at(-1)!.parsed.packetCount).toBe(101);
 });
 it('retains a partial EOF packet until its tail arrives',async()=>{
  const whole=replay(5,true),file=await source(whole.subarray(0,-3)),session=new ReplayFileSession(),first=batches();await session.run(request(file),signal(),first.handle);
  expect(first.list.at(-1)!.parsed.packetCount).toBe(4);await appendFile(file,whole.subarray(-3));const next=batches();await session.run(request(file),signal(),next.handle);expect(next.list.at(-1)!.parsed.packetCount).toBe(5);expect(next.list.every(v=>!v.meta.recordingReset)).toBe(true);
 });
 it('reports an incomplete header as pending and recovers when the header arrives',async()=>{
  const bytes=replay(3,true),file=await source(bytes.subarray(0,24)),session=new ReplayFileSession(),first=batches();const pending=await session.run(request(file),signal(),first.handle);expect(pending.pending).toBe(true);expect(first.list).toHaveLength(0);
  await writeFile(file,bytes);const next=batches();expect((await session.run(request(file),signal(),next.handle)).pending).toBe(false);expect(next.list.at(-1)!.parsed.packetCount).toBe(3);
 });
 it('invalidates parser state after truncation and after replacement at the same path',async()=>{
  const file=await source(replay(20,true)),session=new ReplayFileSession();await session.run(request(file),signal(),async()=>{});
  await writeFile(file,replay(4,true));const truncated=batches();await session.run(request(file),signal(),truncated.handle);expect(truncated.list.every(v=>v.meta.initial&&v.meta.recordingReset)).toBe(true);expect(truncated.list.at(-1)!.parsed.packetCount).toBe(4);
  const replacement=path.join(path.dirname(file),'replacement.rrf');await writeFile(replacement,replay(4,true));await rename(file,file+'.old');await rename(replacement,file);const replaced=batches();await session.run(request(file),signal(),replaced.handle);expect(replaced.list.every(v=>v.meta.initial&&v.meta.recordingReset)).toBe(true);
 });
 it('detects an old body rewrite while the file grows and returns a verified raw hash',async()=>{
  const file=await source(replay(20,true)),session=new ReplayFileSession();await session.run(request(file),signal(),async()=>{});
  const rewritten=replay(21,true);rewritten[rewritten.length-21*18+10+4]^=1;await writeFile(file,rewritten);
  const next=batches(),result=await session.run(request(file,'source',true),signal(),next.handle);
  expect(next.list.every(v=>v.meta.initial&&v.meta.reset&&!v.meta.recordingReset)).toBe(true);expect(next.list.at(-1)!.parsed.packetCount).toBe(21);expect(result.verifiedHash).toBe(createHash('sha256').update(rewritten).digest('hex'));
 });
 it('avoids repeated parse and IPC on unchanged polls, including stable verification',async()=>{
  const bytes=replay(20,true),file=await source(bytes),session=new ReplayFileSession();await session.run(request(file),signal(),async()=>{});const next=batches();
  const result=await session.run(request(file,'source',true),signal(),next.handle);expect(next.list).toHaveLength(0);expect(result.verifiedHash).toBe(createHash('sha256').update(bytes).digest('hex'));
 });
});

describe('persistent Replay worker bridge',()=>{
 function bridge(maxSessions=3){const value=new ReplayBridge({workerPath,maxSessions,batchBytes:1024,heapLimitMb:128});bridges.push(value);return value;}
 it('waits for each batch acknowledgement and cancels an active worker cleanly',async()=>{
  const file=await source(replay(300,true)),value=bridge(),abort=new AbortController();let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});let count=0;
  const running=value.run(request(file),abort.signal,async()=>{count++;entered();await gate;});let completed=false;const observed=running.then(()=>{completed=true;return null;},error=>{completed=true;return error as Error;});await ready;await delay(20);expect(count).toBe(1);abort.abort();await delay(20);expect(completed).toBe(false);release();expect((await observed)?.message).toContain('durduruldu');await value.close();expect(value.residentSessions).toBe(0);
 });
 it('evicts an idle parser when residency is full and rebuilds silently on return',async()=>{
  const a=await source(replay(10,true)),b=await source(replay(12,true)),value=bridge(1);
  await value.run(request(a,'a'),signal(),async()=>{});expect(value.residentSessions).toBe(1);await value.run(request(b,'b'),signal(),async()=>{});expect(value.residentSessions).toBe(1);
  const next=batches();await value.run(request(a,'a'),signal(),next.handle);expect(next.list.every(v=>v.meta.initial&&!v.meta.recordingReset)).toBe(true);expect(next.list.at(-1)!.parsed.packetCount).toBe(10);
 });
 it('keeps three sources independent and reads the changed source without replaying its history',async()=>{
  const files=await Promise.all([source(replay(20,true)),source(replay(30,true)),source(replay(40,true))]),value=bridge(3);
  await Promise.all(files.map((file,index)=>value.run(request(file,String(index)),signal(),async()=>{})));expect(value.residentSessions).toBe(3);
  await appendFile(files[0],frame(21));const next=batches();await value.run(request(files[0],'0'),signal(),next.handle);expect(next.list.at(-1)!.parsed.packetCount).toBe(21);expect(next.list.every(v=>!v.meta.initial)).toBe(true);
  const unchanged=batches();await value.run(request(files[1],'1'),signal(),unchanged.handle);expect(unchanged.list).toHaveLength(0);
 });
 it('does not change source bytes',async()=>{const bytes=replay(15,true),file=await source(bytes),value=bridge();await value.run(request(file,'source',true),signal(),async()=>{});expect(new Uint8Array(await readFile(file))).toEqual(bytes);});
 it('propagates a rejected consumer callback without waiting on its own rejection handler',async()=>{
  const file=await source(replay(15,true)),value=bridge();
  await expect(value.run(request(file),signal(),async()=>{throw new Error('consumer failed');})).rejects.toThrow('consumer failed');
  await value.close();expect(value.residentSessions).toBe(0);
 });
});
