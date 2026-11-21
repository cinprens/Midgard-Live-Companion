import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {appendFile,copyFile,mkdir,mkdtemp,readFile,rename,rm,symlink,utimes,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'esbuild';
import {LiveController,type LiveControllerOptions,type StableSnapshotMeta} from '../electron/live/controller';
import type {ParsedReplay} from '../src/parser/types';

const qa=path.resolve('.qa'),directories:string[]=[],controllers:LiveController[]=[];
let workerPath:string;
const bytes=(n:number)=>new Uint8Array(n),view=(data:Uint8Array)=>new DataView(data.buffer,data.byteOffset,data.byteLength);
function concat(parts:Uint8Array[]){const out=bytes(parts.reduce((sum,part)=>sum+part.length,0));let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;}
const word=(n:number)=>{const data=bytes(4);view(data).setUint32(0,n,true);return data;};
const text=(value:string)=>new TextEncoder().encode(value+'\0');
const tlv=(id:number,data:Uint8Array)=>{const head=bytes(6);view(head).setInt16(0,id,true);view(head).setInt32(2,data.length,true);return concat([head,data]);};
function encrypt(input:Uint8Array){const out=new Uint8Array(input),a=((2026|(11<<16)|(1<<24))>>5),b=(12<<8)>>3;for(let i=0;i<Math.floor(out.length/4);i++)view(out).setInt32(i*4,view(input).getInt32(i*4,true)^Math.imul(a+i+1,b),true);return out;}
function frame(index:number,known=true,hp=1000){const data=bytes(known?8:2);view(data).setUint16(0,known?0x00b0:0x7777,true);if(known){view(data).setUint16(2,5,true);view(data).setInt32(4,hp,true);}const head=bytes(10);view(head).setInt32(0,index,true);view(head).setInt32(4,index*100,true);view(head).setUint16(8,data.length,true);return concat([head,encrypt(data)]);}
function replay(count=2,player=42,name='Alpha'){
  const header=bytes(352);header.set(text('<< Ragnarok Replay File Version 0.05 >>'));header[100]=5;view(header).setInt16(104,2026,true);header[106]=11;header[107]=1;header[109]=12;
  const metadata=encrypt(concat([...Array.from({length:4},(_,id)=>tlv(id,bytes(0))),tlv(964,text(name)),tlv(965,text('test_map')),tlv(970,word(0))])),session=encrypt(tlv(1010,word(player))),stream=concat(Array.from({length:count},(_,i)=>frame(i+1)));
  let offset=352;for(const[slot,type,data]of[[0,2,metadata],[1,3,session],[2,1,stream]]as const){const at=112+slot*10;view(header).setUint16(at,type,true);view(header).setInt32(at+2,type===1?0:data.length,true);view(header).setInt32(at+6,offset,true);offset+=data.length;}return concat([header,metadata,session,stream]);
}
async function directory(){await mkdir(qa,{recursive:true});const result=await mkdtemp(path.join(qa,'folder-live-test-'));directories.push(result);return result;}
function controller(options:LiveControllerOptions={}){const live=new LiveController({autoPoll:false,workerPath:path.join(path.dirname(workerPath),'parser-worker.cjs'),bridgeWorkerPath:workerPath,limits:{memoryBudgetBytes:384*1024*1024,maxWorkers:2,settleMs:1000000},...options});controllers.push(live);return live;}
async function refresh(live:LiveController){await live.refresh();await live.waitForIdle();}
beforeAll(async()=>{const folder=await directory();workerPath=path.join(folder,'bridge-worker.cjs');await build({entryPoints:['electron/live/bridge-worker.ts'],outfile:workerPath,bundle:true,platform:'node',format:'cjs',target:'node24',external:['node:*'],logLevel:'error'});});
afterEach(async()=>{await Promise.all(controllers.splice(0).map(live=>live.close()));});
afterAll(async()=>{for(const folder of directories){if(!path.resolve(folder).startsWith(qa+path.sep))throw Error('Unsafe fixture path');await rm(folder,{recursive:true,force:true});}});

describe('folder selection follows advancing recordings rather than old files',()=>{
  it('refreshes the EXP archive after replacing a file without changing the folder count', async()=>{
    const folder=await directory(), file=path.join(folder,'first.rrf'), replacement=path.join(folder,'second.rrf');
    await writeFile(file,replay());
    const live=controller({});
    await live.addFolder(folder,{discover:true});
    const revision=live.snapshot().discovery.recordingsRevision!;
    await appendFile(file,frame(3));
    await refresh(live);
    expect(live.snapshot().discovery.recordingsRevision).toBe(revision);
    await rename(file,replacement);
    await refresh(live);
    expect(live.snapshot().discovery).toMatchObject({candidateCount:1,recordingsRevision:revision+1});
  });
  it('registers no historical files or mtime-only copies; first parse is silent, later valid progress is live',async()=>{
    const folder=await directory(),file=path.join(folder,'old.rrf');await writeFile(file,replay());let now=Date.now()+100000;
    const received:{parsed:ParsedReplay;meta:StableSnapshotMeta}[]=[],live=controller({clock:()=>now,onSnapshot:(parsed,meta)=>{received.push({parsed,meta});}});
    await live.addFolder(folder,{discover:true,policyVerified:false});await refresh(live);
    expect(live.snapshot().discovery).toMatchObject({enabled:true,candidateCount:1,liveCount:0,blockedReason:null});expect(live.snapshot().streams).toEqual([]);expect(received).toEqual([]);
    await utimes(file,new Date(),new Date(now));await refresh(live);expect(live.snapshot().streams).toEqual([]);
    await appendFile(file,frame(3));now+=100;await refresh(live);
    expect(live.snapshot().streams[0]).toMatchObject({liveActivity:'waiting',sourceMode:'folder',packetCount:3,lastSuccessfulReadAt:null,lastValidatedProgressAt:null,summary:{playerId:42,liveTelemetry:{hp:1000}}});expect(received.every(value=>value.meta.initial)).toBe(true);
    received.length=0;await appendFile(file,frame(4,true,900));now+=100;await refresh(live);
    expect(live.snapshot().streams[0]).toMatchObject({liveActivity:'live',packetCount:4,lastValidatedProgressAt:new Date(now).toISOString(),summary:{liveTelemetry:{hp:900}}});expect(received.some(value=>value.meta.initial===false)).toBe(true);
    const stamp=live.snapshot().streams[0].lastValidatedProgressAt;await utimes(file,new Date(),new Date(now+1000));now+=100;await refresh(live);expect(live.snapshot().streams[0].lastValidatedProgressAt).toBe(stamp);
  });
  it('baselines newly copied nonempty files and newly empty files; two independently advancing clients stay live',async()=>{
    const folder=await directory(),first=path.join(folder,'one.rrf'),second=path.join(folder,'two.rrf'),live=controller();await live.addFolder(folder,{discover:true});
    await writeFile(first,replay(2,42,'Alpha'));await writeFile(second,bytes(0));await refresh(live);expect(live.snapshot().streams).toHaveLength(0);
    await appendFile(first,frame(3));await writeFile(second,replay(2,99,'Beta'));await refresh(live);expect(live.snapshot().streams).toHaveLength(2);expect(live.snapshot().streams.every(stream=>stream.liveActivity==='waiting')).toBe(true);
    await appendFile(first,frame(4));await appendFile(second,frame(3));await refresh(live);expect(live.snapshot().discovery.liveCount).toBe(2);expect(live.snapshot().streams.map(stream=>stream.summary?.playerId).sort()).toEqual([42,99]);
    expect(live.snapshot().streams.every(stream=>live.hasCurrentSnapshot(stream.id))).toBe(true);
  });
  it('does not turn unknown, partial, or invalid appended bytes into validated live activity',async()=>{
    const folder=await directory(),file=path.join(folder,'source.rrf'),live=controller();await writeFile(file,replay());await live.addFolder(folder,{discover:true});await appendFile(file,frame(3));await refresh(live);
    await appendFile(file,frame(4,false));await refresh(live);expect(live.snapshot().streams[0].liveActivity).toBe('waiting');
    const complete=frame(5);await appendFile(file,complete.subarray(0,8));await refresh(live);expect(live.snapshot().streams[0].liveActivity).toBe('waiting');
    await appendFile(file,complete.subarray(8));await refresh(live);expect(live.snapshot().streams[0].liveActivity).toBe('live');
    const stamp=live.snapshot().streams[0].lastValidatedProgressAt;const invalid=bytes(11);view(invalid).setInt32(4,600,true);view(invalid).setUint16(8,1,true);await appendFile(file,invalid);await refresh(live);expect(live.snapshot().streams[0]).toMatchObject({status:'error',liveActivity:'idle',lastValidatedProgressAt:stamp});
  });
  it('keeps last telemetry and a bounded parser on silence, preserving the first resumed delta',async()=>{
    const folder=await directory(),file=path.join(folder,'source.rrf');await writeFile(file,replay());let now=Date.now()+100000;
    const received:{parsed:ParsedReplay;meta:StableSnapshotMeta}[]=[],live=controller({clock:()=>now,onSnapshot:(parsed,meta)=>{received.push({parsed,meta});}});await live.addFolder(folder,{discover:true});await appendFile(file,frame(3));await refresh(live);await appendFile(file,frame(4,true,777));await refresh(live);
    now+=15001;await refresh(live);expect(live.snapshot().streams[0]).toMatchObject({liveActivity:'idle',summary:{liveTelemetry:{hp:777}}});
    expect((live as unknown as {bridge:{residentSessions:number}}).bridge.residentSessions).toBe(1);
    received.length=0;await appendFile(file,frame(5,true,888));now++;await refresh(live);expect(live.snapshot().streams[0]).toMatchObject({liveActivity:'live',summary:{liveTelemetry:{hp:888}}});
    expect(received.every(value=>value.meta.initial===false&&!value.meta.recordingReset)).toBe(true);expect(received.flatMap(value=>value.parsed.events).map(event=>event.timestamp)).toEqual([500]);
  });
  it('rebaselines truncation, replacement and rename without attributing their old packets to live progress',async()=>{
    const folder=await directory(),file=path.join(folder,'source.rrf'),received:StableSnapshotMeta[]=[],live=controller({onSnapshot:(_parsed,meta)=>{received.push(meta);}});await writeFile(file,replay());await live.addFolder(folder,{discover:true});await appendFile(file,frame(3));await refresh(live);await appendFile(file,frame(4));await refresh(live);
    await writeFile(file,replay(1));received.length=0;await refresh(live);expect(received).toEqual([]);expect(live.snapshot().streams[0].liveActivity).toBe('waiting');
    await appendFile(file,frame(2));await refresh(live);expect(received.some(meta=>meta.recordingReset&&meta.initial)).toBe(true);expect(live.snapshot().streams[0].liveActivity).toBe('waiting');
    await appendFile(file,frame(3));await refresh(live);expect(live.snapshot().streams[0].liveActivity).toBe('live');
    const replacement=path.join(folder,'replace.tmp');await writeFile(replacement,replay(7,99,'Beta'));await rename(file,path.join(folder,'previous.tmp'));await rename(replacement,file);received.length=0;await refresh(live);expect(received).toEqual([]);expect(live.snapshot().streams[0].liveActivity).toBe('waiting');
    await appendFile(file,frame(8));await refresh(live);expect(live.snapshot().streams[0].summary?.playerId).toBe(99);expect(live.snapshot().streams[0].liveActivity).toBe('waiting');
    const renamed=path.join(folder,'renamed.rrf');await rename(file,renamed);await refresh(live);expect(live.snapshot().streams.some(stream=>stream.sourcePath===renamed)).toBe(false);expect(live.snapshot().discovery.candidateCount).toBe(1);
  });
  it('recovers a missing saved folder and later folder disappearance without disabling discovery',async()=>{
    const parent=await directory(),folder=path.join(parent,'saved'),received:StableSnapshotMeta[]=[],live=controller({onSnapshot:(_parsed,meta)=>{received.push(meta);}});await live.addFolder(folder,{discover:true,restore:true});expect(live.snapshot().discovery).toMatchObject({enabled:true,folder});expect(live.snapshot().discovery.blockedReason).toBeTruthy();
    await mkdir(folder);const file=path.join(folder,'source.rrf');await writeFile(file,replay());await refresh(live);expect(live.snapshot().discovery.blockedReason).toBeNull();expect(live.snapshot().streams).toHaveLength(0);
    await appendFile(file,frame(3));await refresh(live);await appendFile(file,frame(4));await refresh(live);expect(live.snapshot().discovery.liveCount).toBe(1);
    const away=folder+'-away';await rename(folder,away);await refresh(live);expect(live.snapshot().discovery.enabled).toBe(true);expect(live.snapshot().discovery.blockedReason).toBeTruthy();expect(live.snapshot().streams[0].summary?.liveTelemetry?.hp).toBe(1000);
    await rename(away,folder);await refresh(live);expect(live.snapshot().discovery.blockedReason).toBeNull();expect(live.snapshot().discovery.liveCount).toBe(0);received.length=0;await appendFile(file,frame(5));await refresh(live);expect(live.snapshot().streams[0].liveActivity).not.toBe('live');expect(received.length).toBeGreaterThan(0);expect(received.every(meta=>meta.initial&&!meta.recordingReset)).toBe(true);await appendFile(file,frame(6));await refresh(live);expect(live.snapshot().streams[0].liveActivity).toBe('live');
    await expect(controller().addFolder(path.join(parent,'not-selected'),{discover:true})).rejects.toThrow();
  });
  it('switches folders atomically, replaces prior sources, and ignores nested or symlink directories',async()=>{
    const one=await directory(),two=await directory(),external=await directory(),file=path.join(one,'one.rrf'),live=controller();await writeFile(file,replay());await live.addFiles([file]);await live.waitForIdle();
    await live.addFolder(one,{discover:true,replaceSources:true});expect(live.snapshot().streams).toHaveLength(0);await appendFile(file,frame(3));await refresh(live);expect(live.snapshot().streams).toHaveLength(1);
    const nested=path.join(two,'nested');await mkdir(nested);await writeFile(path.join(nested,'nested.rrf'),replay());await writeFile(path.join(external,'external.rrf'),replay());await symlink(external,path.join(two,'linked'),process.platform==='win32'?'junction':'dir').catch(error=>{if(!['EPERM','EACCES'].includes(error.code))throw error;});
    await Promise.all([live.addFolder(one,{discover:true,replaceSources:true}),live.addFolder(two,{discover:true,replaceSources:true})]);await refresh(live);expect(live.snapshot().discovery).toMatchObject({folder:two,candidateCount:0});expect(live.snapshot().streams).toHaveLength(0);
  });
  it('retains at most the configured inactive auto streams and prunes a replaced idle recording for the same owner',async()=>{
    const folder=await directory(),files=[0,1,2].map(i=>path.join(folder,`source-${i}.rrf`));for(let i=0;i<files.length;i++)await writeFile(files[i],replay(2,42+i,`Owner${i}`));let now=Date.now()+100000;
    const live=controller({clock:()=>now,maxInactiveFolderStreams:2});await live.addFolder(folder,{discover:true});for(const file of files)await appendFile(file,frame(3));await refresh(live);await refresh(live);expect(live.snapshot().streams.length).toBeLessThanOrEqual(2);
    const old=files[2];await appendFile(old,frame(4));await refresh(live);await appendFile(old,frame(5));await refresh(live);now+=15001;await refresh(live);
    const newest=path.join(folder,'newest.rrf');await writeFile(newest,replay(2,44,'Owner2'));await refresh(live);await appendFile(newest,frame(3));await refresh(live);await appendFile(newest,frame(4));await refresh(live);await refresh(live);
    expect(live.snapshot().streams.filter(stream=>stream.summary?.playerId===44)).toHaveLength(1);expect(live.snapshot().streams.find(stream=>stream.summary?.playerId===44)?.sourcePath).toBe(newest);
  });
  it('waits for an admitted callback during folder replacement and cannot resurrect it after close',async()=>{
    const folder=await directory(),other=await directory(),file=path.join(folder,'source.rrf');await writeFile(file,replay());let entered!:()=>void,release!:()=>void,finished=false;
    const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});const live=controller({onSnapshot:async()=>{entered();await gate;finished=true;}});await live.addFolder(folder,{discover:true});await appendFile(file,frame(3));await live.refresh();await ready;
    let replaced=false;const switching=live.addFolder(other,{discover:true,replaceSources:true}).then(()=>{replaced=true;});await new Promise(resolve=>setTimeout(resolve,20));expect(replaced).toBe(false);release();await switching;expect(finished).toBe(true);expect(live.snapshot().streams).toHaveLength(0);
    await live.close();await expect(live.addFolder(folder,{discover:true})).rejects.toThrow('kapalı');expect(live.snapshot().streams).toHaveLength(0);
  });
});
