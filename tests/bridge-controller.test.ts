import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {appendFile,mkdir,mkdtemp,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';
import {LiveController,type LiveControllerOptions,type StableSnapshotMeta} from '../electron/live/controller';

const qa=path.resolve('.qa'),directories:string[]=[],controllers:LiveController[]=[];
let workerPath:string;
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function directory(){await mkdir(qa,{recursive:true});const dir=await mkdtemp(path.join(qa,'bridge-controller-test-'));directories.push(dir);return dir;}
async function source(bytes:Uint8Array){const file=path.join(await directory(),'SYNTHETIC-source.rrf');await writeFile(file,bytes);return file;}
function latch(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return{promise,release};}
function encrypted(input:Uint8Array){const data=new Uint8Array(input),view=new DataView(data.buffer),a=((2026|(11<<16)|(1<<24))>>5),b=(12<<8)>>3;for(let index=0;index<Math.floor(data.length/4);index++)view.setInt32(index*4,view.getInt32(index*4,true)^Math.imul(a+index+1,b),true);return data;}
function concat(parts:Uint8Array[]){const bytes=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}return bytes;}
function word(value:number){const bytes=new Uint8Array(4);new DataView(bytes.buffer).setUint32(0,value,true);return bytes;}
function generic(id:number,data:Uint8Array){const head=new Uint8Array(6),view=new DataView(head.buffer);view.setInt16(0,id,true);view.setInt32(2,data.length,true);return concat([head,data]);}
function packetFrame(packet:Uint8Array,index:number,time=index*100){const head=new Uint8Array(10),view=new DataView(head.buffer);view.setInt32(0,index,true);view.setInt32(4,time,true);view.setUint16(8,packet.length,true);return concat([head,encrypted(packet)]);}
function frame(index:number,known=false){const packet=new Uint8Array(known?8:2),view=new DataView(packet.buffer);view.setUint16(0,known?0x00b0:0x7ffe,true);if(known){view.setUint16(2,24,true);view.setUint32(4,777,true);}return packetFrame(packet,index);}
function replay(count:number){
 const header=new Uint8Array(352),view=new DataView(header.buffer);header.set(new TextEncoder().encode('<< Ragnarok Replay File Version 0.05 >>'));header[100]=5;view.setInt16(104,2026,true);header[106]=11;header[107]=1;header[109]=12;
 const metadata=encrypted(concat([...Array.from({length:4},(_,id)=>generic(id,new Uint8Array())),generic(964,new TextEncoder().encode('Synthetic\0')),generic(965,new TextEncoder().encode('test_map\0')),generic(970,word(count*100))])),session=encrypted(generic(1010,word(42))),stream=new Uint8Array(count*12);
 for(let index=0;index<count;index++)stream.set(frame(index+1),index*12);
 let at=352;for(const [slot,type,body]of[[0,2,metadata],[1,3,session],[2,1,stream]] as const){const offset=112+slot*10;view.setUint16(offset,type,true);view.setInt32(offset+2,type===1?0:body.length,true);view.setInt32(offset+6,at,true);at+=body.length;}
 return concat([header,metadata,session,stream]);
}
function controller(options:LiveControllerOptions={}){const value=new LiveController({autoPoll:false,workerPath:path.join(path.dirname(workerPath),'parser-worker.cjs'),bridgeWorkerPath:workerPath,clock:()=>Date.now()+10000,limits:{memoryBudgetBytes:384*1024*1024,maxWorkers:2,settleMs:0},...options});controllers.push(value);return value;}
async function refresh(live:LiveController){await live.refresh();await live.waitForIdle();}

beforeAll(async()=>{const dir=await directory();workerPath=path.join(dir,'bridge-worker.cjs');await build({entryPoints:[path.resolve('electron/live/bridge-worker.ts')],outfile:workerPath,bundle:true,platform:'node',format:'cjs',target:'node24',external:['node:*']});});
afterEach(async()=>{await Promise.all(controllers.splice(0).map(value=>value.close()));});
afterAll(async()=>{for(const dir of directories){const absolute=path.resolve(dir);if(!absolute.startsWith(qa+path.sep))throw Error('Controller test cleanup outside .qa refused.');await rm(absolute,{recursive:true,force:true});}});

describe('native incremental bridge controller',()=>{
 it('stamps only acknowledged completed packet progress across idle, resume, zero-time unknown and partial-tail reads',async()=>{
  const file=await source(replay(20)),entered=latch(),gate=latch();let now=Date.now()+10000,first=true;
  const live=controller({clock:()=>now,onSnapshot:async()=>{if(first){first=false;entered.release();await gate.promise;}}});
  try{
   await live.addFiles([file]);await entered.promise;expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBeNull();now+=1000;gate.release();await live.waitForIdle();const id=live.snapshot().streams[0].id,initialStamp=new Date(now).toISOString();expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBe(initialStamp);
   now+=1000;await refresh(live);await refresh(live);expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBe(initialStamp);
   await live.control(id,'pause');expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBe(initialStamp);now+=1000;await live.control(id,'resume');await live.waitForIdle();expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBe(initialStamp);
   const unknown=new Uint8Array(20);new DataView(unknown.buffer).setUint16(0,0x08ae,true);await appendFile(file,packetFrame(unknown,21,0));now+=1000;await refresh(live);const unknownStamp=new Date(now).toISOString();expect(live.snapshot().streams[0]).toMatchObject({packetCount:21,lastSuccessfulReadAt:unknownStamp,status:'following'});expect(live.snapshot().streams[0].summary?.durationMs).toBe(2000);
   const next=frame(22,true);now+=1000;await appendFile(file,next.subarray(0,5));await refresh(live);expect(live.snapshot().streams[0]).toMatchObject({packetCount:21,lastSuccessfulReadAt:unknownStamp});
   now+=1000;await appendFile(file,next.subarray(5));await refresh(live);expect(live.snapshot().streams[0]).toMatchObject({packetCount:22,lastSuccessfulReadAt:new Date(now).toISOString()});
  }finally{gate.release();}
 });
 it('does not refresh the accepted packet frontier while retrying the same invalid replay prefix',async()=>{
  const file=await source(replay(60000));let now=Date.now()+10000,callbacks=0;const live=controller({clock:()=>now,onSnapshot:()=>{callbacks++;}});
  await live.addFiles([file]);await live.waitForIdle();const before=live.snapshot().streams[0];expect(before.lastSuccessfulReadAt).toBe(new Date(now).toISOString());
  const malformed=new Uint8Array(11),view=new DataView(malformed.buffer);view.setInt32(0,60001,true);view.setInt32(4,6000100,true);view.setUint16(8,1,true);now+=1000;await appendFile(file,malformed);await refresh(live);expect(live.snapshot().streams[0].status).toBe('error');expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBe(before.lastSuccessfulReadAt);
  const beforeRetry=callbacks;now+=3000;await refresh(live);expect(callbacks).toBeGreaterThan(beforeRetry);expect(live.snapshot().streams[0].status).toBe('error');expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBe(before.lastSuccessfulReadAt);
 });
 it('resets freshness for a truncated or replaced recording before acknowledging its new packets',async()=>{
  const file=await source(replay(20));let now=Date.now()+10000,holdReplacement=false;const entered=latch(),gate=latch();
  const live=controller({clock:()=>now,onSnapshot:async(_parsed,meta)=>{if(holdReplacement&&meta.recordingReset){holdReplacement=false;entered.release();await gate.promise;}}});
  try{
   await live.addFiles([file]);await live.waitForIdle();expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBe(new Date(now).toISOString());
   now+=1000;await writeFile(file,new Uint8Array(24));await refresh(live);expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBeNull();
   now+=1000;await writeFile(file,replay(4));await refresh(live);expect(live.snapshot().streams[0]).toMatchObject({packetCount:4,lastSuccessfulReadAt:new Date(now).toISOString()});
   const replacement=path.join(path.dirname(file),'replacement.rrf');await writeFile(replacement,replay(4));await rename(file,file+'.old');await rename(replacement,file);holdReplacement=true;now+=1000;await live.refresh();await entered.promise;expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBeNull();now+=1000;gate.release();await live.waitForIdle();expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBe(new Date(now).toISOString());
  }finally{gate.release();}
 });
 it('keeps current-snapshot false through catch-up and marks every historical batch as initial',async()=>{
  const file=await source(replay(60000)),entered=latch(),gate=latch(),initial:boolean[]=[],currentDuringCallbacks:boolean[]=[];let first=true;
  const live=controller({onSnapshot:async(_parsed,meta)=>{initial.push(meta.initial===true);currentDuringCallbacks.push(live.hasCurrentSnapshot(meta.streamId));if(first){first=false;entered.release();await gate.promise;}}});
  try{await live.addFiles([file]);await entered.promise;const id=live.snapshot().streams[0].id;expect(live.hasCurrentSnapshot(id)).toBe(false);expect(live.snapshot().streams[0].readPosition).toBeLessThan(live.snapshot().streams[0].fileSize);gate.release();await live.waitForIdle();expect(initial.length).toBeGreaterThan(2);expect(initial.every(Boolean)).toBe(true);expect(currentDuringCallbacks.every(value=>!value)).toBe(true);expect(live.hasCurrentSnapshot(id)).toBe(true);expect(live.snapshot().streams[0].packetCount).toBe(60000);expect(live.snapshot().mode).toBe('incremental');}finally{gate.release();}
 });
 it('delivers only appended supported events without replaying historical unknown packets',async()=>{
  const file=await source(replay(10000));let initialEvents=0;const deltas:{initial:boolean|undefined;timestamps:number[];packetCount:number}[]=[];
  const live=controller({onSnapshot:(parsed,meta)=>{if(meta.initial)initialEvents+=parsed.events.length;else deltas.push({initial:meta.initial,timestamps:parsed.events.map(event=>event.timestamp),packetCount:parsed.packetCount});}});
  await live.addFiles([file]);await live.waitForIdle();const before=live.snapshot().streams[0];await appendFile(file,frame(10001,true));await refresh(live);const after=live.snapshot().streams[0];
  expect(before.lastValidatedProgressAt).toBeFalsy();expect(after.lastValidatedProgressAt).toBeTruthy();
  expect(initialEvents).toBe(0);expect(deltas).toHaveLength(2);expect(deltas.every(delta=>delta.initial===false)).toBe(true);expect(deltas.flatMap(delta=>delta.timestamps)).toEqual([1000100]);expect(after.packetCount).toBe(10001);expect(after.bytesReadTotal-before.bytesReadTotal).toBeLessThan(1024);expect(live.hasCurrentSnapshot(after.id)).toBe(true);
 });
 it('drains an admitted callback on pause, starts no further batch, and resumes silently',async()=>{
  const file=await source(replay(60000)),entered=latch(),gate=latch(),metadata:StableSnapshotMeta[]=[];let first=true;
  const live=controller({onSnapshot:async(_parsed,meta)=>{metadata.push(meta);if(first){first=false;entered.release();await gate.promise;}}});
  try{await live.addFiles([file]);await entered.promise;const id=live.snapshot().streams[0].id;expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBeNull();let paused=false;const pausing=live.control(id,'pause').then(()=>{paused=true;});await delay(20);expect(paused).toBe(false);gate.release();await pausing;await live.waitForIdle();expect(metadata).toHaveLength(1);expect(live.snapshot().streams[0].status).toBe('paused');expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBeNull();expect(live.hasCurrentSnapshot(id)).toBe(false);await appendFile(file,frame(60001,true));await live.control(id,'resume');await live.waitForIdle();expect(metadata.slice(1).every(meta=>meta.initial===true)).toBe(true);expect(live.snapshot().streams[0].packetCount).toBe(60001);expect(live.snapshot().streams[0].lastSuccessfulReadAt).not.toBeNull();expect(live.hasCurrentSnapshot(id)).toBe(true);}finally{gate.release();}
 });
 it('drains admitted asynchronous work before close and prevents callbacks after closure',async()=>{
  const file=await source(replay(60000)),entered=latch(),gate=latch();let callbacks=0,finished=false;
  const live=controller({onSnapshot:async()=>{callbacks++;entered.release();await gate.promise;finished=true;}});
  try{await live.addFiles([file]);await entered.promise;let closed=false;const closing=live.close().then(()=>{closed=true;});await delay(20);expect(closed).toBe(false);expect(finished).toBe(false);gate.release();await closing;expect(finished).toBe(true);expect(callbacks).toBe(1);await delay(20);expect(callbacks).toBe(1);expect(live.snapshot().activeWorkers).toBe(0);expect(live.snapshot().streams[0].status).toBe('stopped');}finally{gate.release();}
 });
 it('removes a running stream without a late callback resurrecting it',async()=>{
  const file=await source(replay(60000)),entered=latch(),gate=latch();let callbacks=0;
  const live=controller({onSnapshot:async()=>{callbacks++;entered.release();await gate.promise;}});
  try{await live.addFiles([file]);await entered.promise;const id=live.snapshot().streams[0].id;const removing=live.control(id,'remove');gate.release();await removing;await live.waitForIdle();await delay(20);expect(callbacks).toBe(1);expect(live.snapshot().streams).toHaveLength(0);expect(live.hasCurrentSnapshot(id)).toBe(false);}finally{gate.release();}
 });
 it('does not restart a worker for an unchanged unsupported source, and recovers after a source change',async()=>{
  const valid=replay(20),unsupported=new Uint8Array(valid);unsupported[100]=6;const file=await source(unsupported);let now=Date.now()+10000,attempts=0;let live:LiveController;
  live=controller({clock:()=>now,onUpdate:()=>{if(live?.snapshot().streams[0]?.status==='reading')attempts++;}});
  await live.addFiles([file]);await live.waitForIdle();const failed=live.snapshot().streams[0];expect(failed.status).toBe('error');expect(failed.summary).toBeNull();const initialAttempts=attempts;expect(initialAttempts).toBeGreaterThan(0);
  for(let index=0;index<8;index++){now+=120000;await refresh(live);}expect(attempts).toBe(initialAttempts);expect(live.snapshot().streams[0].status).toBe('error');
  await writeFile(file,valid);await refresh(live);expect(live.snapshot().streams[0].summary).not.toBeNull();expect(live.snapshot().streams[0].packetCount).toBe(20);expect(live.hasCurrentSnapshot(failed.id)).toBe(true);
 });
 it('puts a parser-invalid append in error state while retaining the last valid summary',async()=>{
  const file=await source(replay(20)),live=controller();await live.addFiles([file]);await live.waitForIdle();const before=live.snapshot().streams[0];
  const malformed=new Uint8Array(11),view=new DataView(malformed.buffer);view.setInt32(0,21,true);view.setInt32(4,2100,true);view.setUint16(8,1,true);await appendFile(file,malformed);await refresh(live);const after=live.snapshot().streams[0];
  expect(after.status).toBe('error');expect(after.summary).toEqual(before.summary);expect(after.packetCount).toBe(before.packetCount);expect(after.lastSuccessfulReadAt).toBe(before.lastSuccessfulReadAt);expect(after.diagnostics.join(' ')).toContain('paket uzunluğu');expect(live.hasCurrentSnapshot(after.id)).toBe(false);
 });
 it('retains the last acknowledged snapshot after ingestion failure and replays the failed event on resume',async()=>{
  const file=await source(replay(20));let now=Date.now()+10000,rejectLive=true,callbacks=0,failedEventIds:string[]=[];
  const ingestedEventIds:string[]=[],successfulMetadata:StableSnapshotMeta[]=[];
  const live=controller({clock:()=>now,onSnapshot:async(parsed,meta)=>{
   callbacks++;
   if(!meta.initial&&rejectLive&&parsed.events.length){failedEventIds=parsed.events.map(event=>event.id);throw new Error('SYNTHETIC ingestion failure');}
   ingestedEventIds.push(...parsed.events.map(event=>event.id));successfulMetadata.push(meta);
  }});
  await live.addFiles([file]);await live.waitForIdle();const before=live.snapshot().streams[0];expect(live.hasCurrentSnapshot(before.id)).toBe(true);expect(before.lastSuccessfulReadAt).toBe(new Date(now).toISOString());
  now+=1000;await appendFile(file,frame(21,true));await refresh(live);const failed=live.snapshot().streams[0];expect(failed.lastSuccessfulReadAt).toBe(before.lastSuccessfulReadAt);
  expect(failedEventIds).toHaveLength(1);expect(ingestedEventIds).toHaveLength(0);expect(failed.status).toBe('error');expect(failed.summary).toEqual(before.summary);expect(failed.packetCount).toBe(before.packetCount);expect(failed.eventCount).toBe(before.eventCount);expect(failed.diagnostics.join(' ')).toContain('SYNTHETIC ingestion failure');expect(live.hasCurrentSnapshot(failed.id)).toBe(false);
  const failedCallbacks=callbacks;for(let index=0;index<6;index++){now+=100;await refresh(live);}expect(callbacks).toBe(failedCallbacks);expect(live.snapshot().streams[0].status).toBe('error');
  now+=1000;rejectLive=false;const successfulBeforeResume=successfulMetadata.length;await live.control(failed.id,'resume');await live.waitForIdle();const recovered=live.snapshot().streams[0];expect(recovered.lastSuccessfulReadAt).toBe(new Date(now).toISOString());
  expect(recovered.status).not.toBe('error');expect(recovered.packetCount).toBe(21);expect(recovered.eventCount).toBe(before.eventCount+1);expect(recovered.summary?.liveTelemetry?.weight).toBe(777);expect(ingestedEventIds).toEqual(failedEventIds);expect(successfulMetadata.slice(successfulBeforeResume).every(meta=>meta.initial===true)).toBe(true);expect(live.hasCurrentSnapshot(recovered.id)).toBe(true);
 });
});
