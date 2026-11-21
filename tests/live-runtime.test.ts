import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { LiveController } from '../electron/live/controller';
import { FairWorkQueue, deriveLiveLimits, MIB } from '../electron/live/resources';
import { RrfStreamReader } from '../electron/live/reader';
import { parseReplay } from '../src/parser';
import type { ParsedReplay } from '../src/parser/types';

const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const item of cleanup.splice(0).reverse())await item();});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function directory(){await mkdir('.qa',{recursive:true});const result=await mkdtemp(path.resolve('.qa/live-runtime-test-'));cleanup.push(()=>rm(result,{recursive:true,force:true}));return result;}
async function fixtureFiles(count=1){const dir=await directory();const files:string[]=[];for(let i=0;i<count;i++){const file=path.join(dir,`record-${i}.rrf`);await copyFile(path.resolve('tests/fixtures/latam-mergulho-test.rrf'),file);files.push(file);}return{dir,files};}
function controller(options:ConstructorParameters<typeof LiveController>[0]={}){
  const value=new LiveController({autoPoll:false,parser:async(bytes,filename)=>parseReplay(bytes,filename),limits:{memoryBudgetBytes:3*MIB,maxWorkers:2,settleMs:0},...options});cleanup.push(()=>value.close());return value;
}

describe('independent positional RRF readers',()=>{
  it('keeps append positions independent and only reads the appended tail plus bounded header',async()=>{
    const dir=await directory(),first=path.join(dir,'first.rrf'),second=path.join(dir,'second.rrf');
    await writeFile(first,new Uint8Array(1024));await writeFile(second,new Uint8Array(512));
    const a=new RrfStreamReader(first,4096),b=new RrfStreamReader(second,4096),signal=new AbortController().signal;
    await a.read(signal);await b.read(signal);const before=a.bytesReadTotal;
    await appendFile(first,new Uint8Array([1,2,3]));const snapshot=await a.read(signal);
    expect(snapshot.reset).toBe(false);expect(a.readPosition).toBe(1027);expect(b.readPosition).toBe(512);
    expect(a.bytesReadTotal-before).toBe(355);expect(new Uint8Array(snapshot.bytes).slice(-3)).toEqual(new Uint8Array([1,2,3]));
  });
  it('resets on truncation, in-place header rewrite and replacement identity',async()=>{
    const dir=await directory(),file=path.join(dir,'source.rrf');await writeFile(file,new Uint8Array(700));
    const reader=new RrfStreamReader(file,4096),signal=new AbortController().signal;await reader.read(signal);
    await writeFile(file,new Uint8Array(50));expect((await reader.read(signal)).reset).toBe(true);expect(reader.readPosition).toBe(50);
    const updated=new Uint8Array(50);updated[4]=99;await writeFile(file,updated);expect((await reader.read(signal)).reset).toBe(true);
    const replacement=path.join(dir,'new.rrf');await writeFile(replacement,new Uint8Array(50));await rename(file,path.join(dir,'old.rrf'));await rename(replacement,file);
    expect((await reader.read(signal)).reset).toBe(true);
  });
  it('rejects growth beyond its file cap before allocating it',async()=>{
    const dir=await directory(),file=path.join(dir,'large.rrf');await writeFile(file,new Uint8Array(100));
    const reader=new RrfStreamReader(file,50);await expect(reader.read(new AbortController().signal)).rejects.toThrow('canlı dosya sınırını');expect(reader.bufferedBytes).toBe(0);
  });
});

describe('resource admitted fair worker queue',()=>{
  it('limits working memory and executes FIFO without allowing a large waiting job to starve',async()=>{
    const queue=new FairWorkQueue(4,100);const order:string[]=[];let active=0,peak=0;
    for(const [id,bytes]of[['first',60],['large',80],['small',10]]as const)queue.enqueue({id,bytes,run:async()=>{order.push(id);active++;peak=Math.max(peak,active);await delay(4);active--;}});
    await queue.waitForIdle();expect(order).toEqual(['first','large','small']);expect(peak).toBe(2);expect(queue.reservedBytes).toBe(0);await queue.close();
  });
  it('deduplicates queued IDs and cancellation releases the slot only after the task settles',async()=>{
    const queue=new FairWorkQueue(1,100);let finished=false,nextSawFinished=false;
    queue.enqueue({id:'a',bytes:60,run:signal=>new Promise<void>(resolve=>signal.addEventListener('abort',()=>{void delay(5).then(()=>{finished=true;resolve();});},{once:true}))});
    expect(queue.enqueue({id:'a',bytes:60,run:async()=>{}})).toBe(false);await delay(1);
    queue.enqueue({id:'b',bytes:60,run:async()=>{nextSawFinished=finished;}});queue.cancel('a');await queue.waitForIdle();expect(nextSawFinished).toBe(true);await queue.close();
  });
  it('derives a resource limit rather than a character-count limit',()=>{
    const limits=deriveLiveLimits({memoryBudgetBytes:9*MIB,maxWorkers:7});expect(limits.maxWorkers).toBe(7);expect(limits.perFileBytes).toBe(3*MIB);
  });
});

describe('experimental multi-source controller',()=>{
  it('advances successful read time only after a snapshot ACK beyond the recording frontier',async()=>{
    const{files}=await fixtureFiles(),data=await readFile(files[0]),base=parseReplay(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),'source.rrf');
    let now=Date.now()+10000,count=5,startedAt=base.summary.startedAt,first=true,reject=false,entered!:()=>void,release!:()=>void;
    const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const live=controller({clock:()=>now,parser:async()=>({...base,packetCount:count,events:[],summary:{...base.summary,startedAt}}),onSnapshot:async()=>{if(first){first=false;entered();await gate;}if(reject)throw new Error('SYNTHETIC snapshot ACK failed');}});
    try{
      await live.addFiles(files);await ready;expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBeNull();now+=1000;release();await live.waitForIdle();const id=live.snapshot().streams[0].id,firstStamp=new Date(now).toISOString();expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBe(firstStamp);expect(live.snapshot().streams[0].summary?.inventoryBaselineKnown).toBe(base.summary.inventoryFlow?.baselineKnown);
      now+=1000;await live.refresh();await live.waitForIdle();await live.refresh();await live.waitForIdle();expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBe(firstStamp);
      count=6;reject=true;now+=1000;await appendFile(files[0],new Uint8Array([1]));await live.refresh();await live.waitForIdle();expect(live.snapshot().streams[0].status).toBe('error');expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBe(firstStamp);
      reject=false;now+=1000;await live.control(id,'resume');await live.waitForIdle();const secondStamp=new Date(now).toISOString();expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBe(secondStamp);
      now+=1000;await live.control(id,'pause');expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBe(secondStamp);await live.control(id,'resume');await live.waitForIdle();expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBe(secondStamp);
      now+=1000;startedAt='2026-11-02T12:00:00';count=1;await appendFile(files[0],new Uint8Array([2]));await live.refresh();await live.waitForIdle();expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBe(new Date(now).toISOString());
      now+=1000;await writeFile(files[0],new Uint8Array());await live.refresh();await live.waitForIdle();expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBeNull();
    }finally{release();}
  });
  it('does not mark a late snapshot ACK fresh after its generation is paused',async()=>{
    const{files}=await fixtureFiles();let now=Date.now()+10000,entered!:()=>void,release!:()=>void;
    const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const live=controller({clock:()=>now,onSnapshot:async()=>{entered();await gate;}});
    try{await live.addFiles(files);await ready;const id=live.snapshot().streams[0].id;expect(live.snapshot().streams[0].lastSuccessfulReadAt).toBeNull();now+=1000;const pausing=live.control(id,'pause');release();await pausing;await live.waitForIdle();expect(live.snapshot().streams[0]).toMatchObject({status:'paused',lastSuccessfulReadAt:null});}finally{release();}
  });
  it('keeps the remaining selected files running when one selected path has disappeared',async()=>{
    const{dir,files}=await fixtureFiles(2);const live=controller();await live.addFiles([files[0],path.join(dir,'disappeared.rrf'),files[1]]);await live.waitForIdle();const streams=live.snapshot().streams;expect(streams).toHaveLength(3);expect(streams.filter(s=>s.summary?.characterName==='Preá')).toHaveLength(2);expect(streams.find(s=>s.filename==='disappeared.rrf')?.status).toBe('missing');
  });
  it('registers more than five streams, parses in parallel and bounds retained snapshot buffers',async()=>{
    const{files}=await fixtureFiles(24);let active=0,peak=0;
    const live=controller({parser:async(bytes,filename)=>{active++;peak=Math.max(peak,active);await delay(4);const parsed=parseReplay(bytes,filename);active--;return parsed;}});
    await live.addFiles(files);await live.waitForIdle();const state=live.snapshot();
    expect(state.streams).toHaveLength(24);expect(peak).toBe(2);expect(state.streams.every(s=>s.summary?.characterName==='Preá')).toBe(true);
    expect(state.bufferedBytes).toBeLessThanOrEqual(state.limits.memoryBudgetBytes);expect(state.compatibility).toBe('skadi-unverified');expect(state.mode).toBe('experimental-snapshots');
    expect(new Set(state.streams.map(s=>s.id)).size).toBe(24);expect(state.streams.every(s=>s.readPosition===49809)).toBe(true);
  });
  it('keeps provisional incomplete files out of archive callbacks and commits stable snapshots once',async()=>{
    const{files}=await fixtureFiles();const full=await readFile(files[0]);await writeFile(files[0],full.subarray(0,64));let now=Date.now()+10000;const saved:string[]=[];
    const live=controller({clock:()=>now,onStable:async(_parsed,meta)=>{saved.push(meta.hash);}});
    await live.addFiles(files);await live.waitForIdle();expect(live.snapshot().streams[0].summary).toBeNull();
    now+=100;await live.refresh();await live.waitForIdle();await live.refresh();await live.waitForIdle();expect(saved).toHaveLength(0);
    await writeFile(files[0],full);now+=100;await live.refresh();await live.waitForIdle();expect(live.snapshot().streams[0].summary?.damage).toBeGreaterThan(0);
    now+=100;await live.refresh();await live.waitForIdle();await live.refresh();await live.waitForIdle();expect(saved).toHaveLength(1);
    const readBefore=live.snapshot().streams[0].bytesReadTotal;await live.refresh();await live.waitForIdle();expect(saved).toHaveLength(1);expect(live.snapshot().streams[0].bytesReadTotal).toBe(readBefore);
  });
  it('handles pause, resume, missing file, reappearance, stop and removal without reusing another stream state',async()=>{
    const{dir,files}=await fixtureFiles(2);const live=controller();await live.addFiles(files);await live.waitForIdle();const first=live.snapshot().streams[0];
    await live.control(first.id,'pause');await appendFile(files[0],new Uint8Array([4]));await live.refresh();await live.waitForIdle();expect(live.snapshot().streams[0].status).toBe('paused');expect(live.snapshot().streams[0].fileSize).toBe(49809);
    await live.control(first.id,'resume');await live.waitForIdle();expect(live.snapshot().streams[0].readPosition).toBe(49810);
    await rename(files[0],path.join(dir,'moved-away.rrf'));await live.refresh();await live.waitForIdle();expect(live.snapshot().streams[0].status).toBe('missing');
    await copyFile(files[1],files[0]);await live.refresh();await live.waitForIdle();expect(live.snapshot().streams[0].summary?.characterName).toBe('Preá');
    await live.control(first.id,'stop');await live.refresh();expect(live.snapshot().streams[0].status).toBe('stopped');await live.control(first.id,'remove');expect(live.snapshot().streams).toHaveLength(1);
  });
  it('baselines a selected local folder without activating unchanged historical copies',async()=>{
    const{dir,files}=await fixtureFiles();const live=controller();await live.addFolder(dir,{discover:true,policyVerified:false});await live.waitForIdle();
    expect(live.snapshot().discovery).toMatchObject({enabled:true,blockedReason:null,candidateCount:1});expect(live.snapshot().streams).toHaveLength(0);
    const next=path.join(dir,'new.rrf');await copyFile(files[0],next);await live.refresh();await live.waitForIdle();expect(live.snapshot().streams).toHaveLength(0);expect(live.snapshot().discovery.candidateCount).toBe(2);
    await appendFile(next,new Uint8Array([1,2,3]));await live.refresh();await live.waitForIdle();expect(live.snapshot().streams).toHaveLength(1);expect(live.snapshot().streams[0]).toMatchObject({sourceMode:'folder',liveActivity:'waiting',lastValidatedProgressAt:null});
  });
  it('restores granted sources as paused without reading files or starting workers',async()=>{
    const live=controller();await live.restorePaused([path.resolve('.qa/no-longer-existing.rrf')]);const state=live.snapshot();expect(state.streams).toHaveLength(1);expect(state.streams[0].status).toBe('paused');expect(state.streams[0].bytesReadTotal).toBe(0);expect(state.activeWorkers).toBe(0);
  });
  it('retries an unsupported stable file only after it changes',async()=>{
    const{files}=await fixtureFiles();const bytes=await readFile(files[0]);bytes[100]=9;await writeFile(files[0],bytes);let calls=0;let now=Date.now()+10000;
    const live=controller({clock:()=>now,parser:async(bytes,name)=>{calls++;return parseReplay(bytes,name);}});await live.addFiles(files);await live.waitForIdle();now+=1;
    await live.refresh();await live.waitForIdle();await live.refresh();await live.waitForIdle();const stableCalls=calls;
    await live.refresh();await live.waitForIdle();expect(calls).toBe(stableCalls);expect(live.snapshot().streams[0].status).toBe('error');
  });
  it('rehydrates stable checkpoints when a writer patches old body bytes while appending',async()=>{
    const{files}=await fixtureFiles();let now=Date.now()+10000;const saved:string[]=[];
    const live=controller({clock:()=>now,onStable:(_parsed,meta)=>{saved.push(meta.hash);}});await live.addFiles(files);await live.waitForIdle();
    const patched=await readFile(files[0]);patched[450]^=1;await writeFile(files[0],Buffer.concat([patched,Buffer.from([7,8,9])]));now+=100;
    await live.refresh();await live.waitForIdle();await live.refresh();await live.waitForIdle();await live.refresh();await live.waitForIdle();
    const actualHash=createHash('sha256').update(await readFile(files[0])).digest('hex');expect(saved).toEqual([actualHash]);
  });
  it('waits for an admitted archive callback before closing the controller',async()=>{
    const{files}=await fixtureFiles();let now=Date.now()+10000;let entered!:()=>void,release!:()=>void,finished=false;
    const enteredPromise=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const live=controller({clock:()=>now,onStable:async()=>{entered();await gate;finished=true;}});await live.addFiles(files);await live.waitForIdle();now++;
    await live.refresh();await live.refresh();await enteredPromise;let closed=false;const closing=live.close().then(()=>{closed=true;});await delay(2);expect(closed).toBe(false);
    release();await closing;expect(finished).toBe(true);expect(live.snapshot().activeWorkers).toBe(0);expect(live.snapshot().bufferedBytes).toBe(0);
  });
  it('cancels an active parse without committing its result after pause',async()=>{
    const{files}=await fixtureFiles();let entered!:()=>void,saved=0;const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});
    const live=controller({parser:async(_bytes,_filename,signal)=>{entered();return new Promise<ParsedReplay>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));},onStable:()=>{saved++;}});
    await live.addFiles(files);await enteredPromise;await live.control(live.snapshot().streams[0].id,'pause');await live.waitForIdle();expect(saved).toBe(0);expect(live.snapshot().streams[0].summary).toBeNull();expect(live.snapshot().streams[0].status).toBe('paused');
  });
  it('retains item observation totals while bounding the idle stream item list',async()=>{
    const{files}=await fixtureFiles();const live=controller({parser:async(bytes,name)=>{const result=parseReplay(bytes,name);result.summary.itemObservations={groundCount:1500,groundQuantity:1500,obtainedCount:0,obtainedQuantity:0,personalDropCount:null,confidence:'observed-only',items:Array.from({length:1500},(_,itemId)=>({itemId,groundCount:1,groundQuantity:1,obtainedCount:0,obtainedQuantity:0}))};return result;}});
    await live.addFiles(files);await live.waitForIdle();expect(live.snapshot().streams[0].summary?.itemObservations?.groundCount).toBe(1500);expect(live.snapshot().streams[0].summary?.itemObservations?.items).toHaveLength(1000);expect(live.snapshot().streams[0].summary?.drops).toBeNull();
  });
});
