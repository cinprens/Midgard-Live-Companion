import { randomUUID, createHash } from 'node:crypto';
import { opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisSummary, LiveResourceLimits, LiveRuntimeState, LiveStreamState } from '../../src/shared/types';
import type { ParsedReplay } from '../../src/parser/types';
import { deriveLiveLimits, FairWorkQueue, MIB } from './resources';
import { ChangingReplayError, fileSignature, RrfStreamReader } from './reader';
import { workerSnapshotParser, type SnapshotParser } from './worker-runner';
import { ReplayBridge, type BridgeMeta } from './replay-bridge';

export interface StableSnapshotMeta {
  streamId:string;sourcePath:string;filename:string;revision:number;size:number;hash:string;observedAt:string;readPosition:number;
  recordingReset?:boolean;
  initial?:boolean;
}
export interface LiveControllerOptions {
  workerPath?:string;
  bridgeWorkerPath?:string;
  parser?:SnapshotParser;
  limits?:Partial<LiveResourceLimits>;
  onUpdate?:()=>void;
  onSnapshot?:(parsed:ParsedReplay,meta:StableSnapshotMeta)=>Promise<void>|void;
  onStable?:(parsed:ParsedReplay,meta:StableSnapshotMeta)=>Promise<void>|void;
  clock?:()=>number;
  autoPoll?:boolean;
  idleAfterMs?:number;
  maxInactiveFolderStreams?:number;
}
interface Entry {
  state:LiveStreamState;reader:RrfStreamReader;signature:string|null;parsedSignature:string|null;
  lastChangeAt:number;stableSamples:number;savedHash:string|null;lastUsed:number;generation:number;
  stableProcessedSignature:string|null;
  lastSourceIdentity?:string;
  lastSourceSize?:number;
  recordingResetPending?:boolean;
  failureSignature?:string;
  retryAt?:number;
  failures?:number;
  lastParsed?:ParsedReplay;
  acceptedPacketFrontier:number;
  acceptedRecordingStartedAt?:string|null;
  folderNeedsBaseline?:boolean;
  folderAwaitingChange?:boolean;
  activityReplayFrontier?:number;
  folderSourceIdentity?:string;
  folderSourceSize?:number;
}
interface FolderCandidate {path:string;signature:string;identity:string;size:number;}
const keyFor=(file:string)=>process.platform==='win32'?file.toLowerCase():file;
const observationNotice='DENEYSEL SNAPSHOT: Skadi canlı çözümleme doğrulanmadı. Sabit boyut, kaydın kapandığını kanıtlamaz.';
const toSummary=(parsed:ParsedReplay):AnalysisSummary=>({
  durationMs:parsed.summary.durationMs,startedAt:parsed.summary.startedAt,mapName:parsed.summary.mapName,
  characterName:parsed.summary.characterName,playerId:parsed.summary.playerId,deaths:parsed.summary.observedDeaths,
  personalKills:parsed.summary.certainPersonalKills,inferredKills:parsed.summary.estimatedPersonalKills,
  partyKills:parsed.summary.partyKills,unknownKills:parsed.summary.unknownKills,damage:parsed.summary.totalDamage,
  exp:parsed.summary.totalExp,drops:parsed.summary.dropCount,
  liveTelemetry:parsed.summary.liveTelemetry,
  inventoryBaselineKnown:parsed.summary.inventoryFlow?.baselineKnown,
  inventoryPendingCount:parsed.summary.inventoryFlow?.pendingCount,
  itemObservations:parsed.summary.itemObservations?{...parsed.summary.itemObservations,items:parsed.summary.itemObservations.items.slice(0,1000)}:undefined,
  // Stream cards retain bounded summaries. The archive callback receives the complete parsed snapshot.
  monsters:parsed.summary.monsters.slice(0,1000).map(monster=>({monsterId:monster.monsterId,name:monster.name.slice(0,1024),deaths:monster.observedDeaths,personalKills:monster.certainPersonalKills,inferredKills:monster.estimatedPersonalKills,partyKills:monster.partyKills,damage:monster.damage,lastSeenMs:monster.lastSeenMs})),
  timeline:parsed.summary.timeline.slice(-1440),
});

/** Unlimited registered streams, resource-admitted snapshot workers, and independent per-file cursors. */
export class LiveController {
  readonly limits:LiveResourceLimits;
  private entries=new Map<string,Entry>();
  private byPath=new Map<string,string>();
  private queue:FairWorkQueue;
  private parser:SnapshotParser;
  private clock:()=>number;
  private timer:ReturnType<typeof setInterval>|null=null;
  private refreshPromise:Promise<void>|null=null;
  private closed=false;
  private discovery:LiveRuntimeState['discovery']={enabled:false,folder:null,blockedReason:null};
  private cacheBudget:number;
  private heapAllowance:number;
  private autoPoll:boolean;
  private bridge:ReplayBridge|null=null;
  private candidates=new Map<string,FolderCandidate>();
  private folderGeneration=0;
  private folderChange:Promise<void>=Promise.resolve();
  private idleAfterMs:number;
  private maxInactiveFolderStreams:number;
  constructor(private options:LiveControllerOptions={}){
    this.limits=deriveLiveLimits({pollIntervalMs:options.parser?1500:500,...options.limits});this.clock=options.clock??Date.now;this.autoPoll=options.autoPoll!==false;
    this.idleAfterMs=Math.max(1000,Math.floor(options.idleAfterMs??15000));this.maxInactiveFolderStreams=Math.max(1,Math.floor(options.maxInactiveFolderStreams??32));
    this.cacheBudget=Math.floor(this.limits.memoryBudgetBytes/3);
    const activeBudget=this.limits.memoryBudgetBytes-this.cacheBudget;
    this.heapAllowance=Math.min(128*MIB,Math.max(16*MIB,Math.floor(activeBudget/3)));
    // Tiny injected-parser test budgets need no native worker heap reservation.
    if(options.parser)this.heapAllowance=0;
    if(activeBudget<=this.heapAllowance)throw new Error('Canlı analiz için ayrılan bellek bütçesi işçi başlatmaya yeterli değil.');
    this.limits.perFileBytes=Math.min(this.limits.perFileBytes,Math.max(1,Math.floor((activeBudget-this.heapAllowance)/2)));
    if(!options.parser&&!options.workerPath)throw new Error('Canlı analiz işçisi yolu gerekli.');
    this.parser=options.parser??workerSnapshotParser(options.workerPath!,Math.max(16,Math.floor(this.heapAllowance/MIB)));
    if(!options.parser){
      const workers=Math.max(1,Math.min(this.limits.maxWorkers,Math.floor(activeBudget/(this.heapAllowance+2*MIB))));
      this.limits.maxWorkers=workers;
      this.bridge=new ReplayBridge({workerPath:options.bridgeWorkerPath??path.join(path.dirname(options.workerPath!),'bridge-worker.cjs'),maxSessions:workers,heapLimitMb:Math.max(16,Math.floor(this.heapAllowance/MIB)),batchBytes:256*1024});
    }
    this.queue=new FairWorkQueue(this.limits.maxWorkers,activeBudget,()=>this.emit());
  }
  snapshot():LiveRuntimeState{
    const streams=[...this.entries.values()].map(entry=>({...entry.state,diagnostics:[...entry.state.diagnostics]}));
    return{streams,limits:{...this.limits},activeWorkers:this.queue.activeWorkers,queuedCount:this.queue.queuedCount,bufferedBytes:this.cachedBytes()+this.queue.reservedBytes,discovery:{...this.discovery,candidateCount:this.candidates.size,waitingCount:streams.filter(stream=>stream.sourceMode==='folder'&&stream.liveActivity==='waiting').length,liveCount:streams.filter(stream=>stream.sourceMode==='folder'&&stream.liveActivity==='live').length,idleCount:streams.filter(stream=>stream.sourceMode==='folder'&&stream.liveActivity==='idle').length,idleAfterMs:this.idleAfterMs},compatibility:'skadi-unverified',mode:this.bridge?'incremental':'experimental-snapshots'};
  }
  async addFiles(files:string[],registration:{paused?:boolean}={}):Promise<void>{
    if(this.closed)throw new Error('Canlı gözlem kapalı.');
    for(const file of files){
      if(path.extname(file).toLowerCase()!=='.rrf')continue;
      let actual=path.resolve(file),size=0,registrationError:unknown=null;
      if(!registration.paused){try{actual=await realpath(file);const info=await stat(actual);if(!info.isFile())throw new Error('Replay kaynağı bir dosya değil.');size=info.size;}catch(error){registrationError=error;}}
      const key=keyFor(actual);if(this.byPath.has(key))continue;
      const id=randomUUID();const now=this.clock();
      const state:LiveStreamState={id,filename:path.basename(actual),sourcePath:actual,sourceMode:'manual',status:registration.paused?'paused':registrationError?'missing':'queued',revision:0,readPosition:0,fileSize:size,bytesReadTotal:0,lastActivityAt:null,lastSuccessfulReadAt:null,diagnostics:registrationError?[observationNotice,this.message(registrationError)]:[observationNotice],packetCount:0,eventCount:0,summary:null,compatibility:'skadi-unverified'};
      this.entries.set(id,{state,reader:new RrfStreamReader(actual,this.bridge?Number.MAX_SAFE_INTEGER:this.limits.perFileBytes),signature:null,parsedSignature:null,lastChangeAt:now,stableSamples:0,savedHash:null,lastUsed:now,generation:0,stableProcessedSignature:null,acceptedPacketFrontier:0});this.byPath.set(key,id);
    }
    if(!registration.paused)this.startTimer();this.emit();if(!registration.paused)await this.refresh();
  }
  async restorePaused(files:string[]):Promise<void>{await this.addFiles(files,{paused:true});}
  async addFolder(directory:string,options:{discover:boolean;policyVerified?:boolean;replaceSources?:boolean;restore?:boolean}):Promise<void>{
    const operation=this.folderChange.then(async()=>{
      if(this.closed)throw new Error('Canlı gözlem kapalı.');
      let actual=path.resolve(directory),problem:string|null=null;
      try{actual=await realpath(actual);if(!(await stat(actual)).isDirectory())throw new Error('Seçilen Replay yolu bir klasör değil.');}
      catch(error){if(!options.restore||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;problem=this.message(error);}
      this.folderGeneration++;this.discovery.enabled=false;
      if(this.refreshPromise)await this.refreshPromise;
      if(this.closed)return;
      if(options.replaceSources)await Promise.all([...this.entries.keys()].map(id=>this.control(id,'remove')));
      else for(const entry of [...this.entries.values()])if(entry.state.sourceMode==='folder')await this.control(entry.state.id,'remove');
      if(this.closed)return;
      this.candidates.clear();this.discovery={enabled:options.discover,folder:actual,blockedReason:problem,lastScanAt:null};
      this.startTimer();this.emit();await this.refresh();
    });
    this.folderChange=operation.catch(()=>undefined);await operation;
  }
  async refresh():Promise<void>{
    if(this.closed)return;if(this.refreshPromise)return this.refreshPromise;
    const operation=this.inspectStreams();this.refreshPromise=operation;
    try{await operation;}finally{this.refreshPromise=null;}
  }
  async waitForIdle():Promise<void>{if(this.refreshPromise)await this.refreshPromise;await this.queue.waitForIdle();}
  hasCurrentSnapshot(id:string):boolean{
    const entry=this.entries.get(id);
    return !!entry&&(!entry.folderNeedsBaseline)&&entry.parsedSignature!==null&&entry.parsedSignature===entry.signature&&!this.queue.has(id)&&entry.state.summary!==null&&['following','settled'].includes(entry.state.status);
  }
  async control(id:string,action:'pause'|'resume'|'stop'|'remove'):Promise<void>{
    const entry=this.entries.get(id);if(!entry)throw new Error('Canlı kayıt bulunamadı.');
    if(action==='resume'){
      entry.generation++;entry.state.status='queued';entry.parsedSignature=null;entry.failureSignature=undefined;entry.retryAt=undefined;entry.failures=0;entry.reader.releaseBuffer();this.startTimer();this.emit();await this.refresh();return;
    }
    entry.generation++;this.queue.cancel(id);entry.reader.releaseBuffer();entry.state.status=action==='pause'?'paused':'stopped';
    if(entry.state.sourceMode==='folder')entry.state.liveActivity=entry.state.lastValidatedProgressAt?'idle':'waiting';
    await this.bridge?.release(id);
    if(action==='remove'){this.entries.delete(id);this.byPath.delete(keyFor(entry.state.sourcePath));}
    this.emit();
  }
  async close():Promise<void>{
    if(this.closed)return;this.closed=true;this.folderGeneration++;if(this.timer)clearInterval(this.timer);this.timer=null;
    for(const entry of this.entries.values()){entry.generation++;entry.state.status='stopped';entry.reader.releaseBuffer();}
    if(this.refreshPromise)await this.refreshPromise.catch(()=>undefined);await this.queue.close();await this.bridge?.close();this.emit();
  }
  private emit():void{this.options.onUpdate?.();}
  private resetSuccessfulRead(entry:Entry):void{
    entry.state.lastSuccessfulReadAt=null;entry.state.lastValidatedProgressAt=null;entry.activityReplayFrontier=-1;entry.acceptedPacketFrontier=0;entry.acceptedRecordingStartedAt=undefined;
    if(entry.state.sourceMode==='folder'){entry.folderNeedsBaseline=true;entry.activityReplayFrontier=-1;entry.state.liveActivity='waiting';entry.state.lastValidatedProgressAt=null;}
  }
  private prepareSuccessfulReadScope(entry:Entry,parsed:ParsedReplay,recordingReset=false):void{
    if(recordingReset||entry.acceptedRecordingStartedAt!==undefined&&entry.acceptedRecordingStartedAt!==parsed.summary.startedAt)this.resetSuccessfulRead(entry);
  }
  private commitSuccessfulRead(entry:Entry,parsed:ParsedReplay,baseline=false):void{
    entry.acceptedRecordingStartedAt=parsed.summary.startedAt;
    if(entry.state.sourceMode==='folder'){
      const frontier=parsed.events.reduce((latest,event)=>event.eventType!=='unknown'&&Number.isFinite(event.timestamp)&&event.timestamp>=0?Math.max(latest,event.timestamp):latest,-1);
      const progressed=Number.isSafeInteger(parsed.packetCount)&&parsed.packetCount>entry.acceptedPacketFrontier&&frontier>(entry.activityReplayFrontier??-1);
      if(!entry.folderNeedsBaseline&&progressed){const now=new Date(this.clock()).toISOString();entry.state.liveActivity='live';entry.state.lastValidatedProgressAt=now;entry.state.lastSuccessfulReadAt=now;}
      entry.acceptedPacketFrontier=Math.max(entry.acceptedPacketFrontier,parsed.packetCount);entry.activityReplayFrontier=Math.max(entry.activityReplayFrontier??-1,frontier);return;
    }
    if(Number.isSafeInteger(parsed.packetCount)&&parsed.packetCount>entry.acceptedPacketFrontier){
      const latest=parsed.events.reduce((end,event)=>event.eventType!=='unknown' && Number.isFinite(event.timestamp)?Math.max(end,event.timestamp):end,-1);
      if(!baseline && entry.acceptedPacketFrontier>0 && latest>(entry.activityReplayFrontier??-1)){
        entry.state.lastValidatedProgressAt=new Date(this.clock()).toISOString();
      }
      entry.activityReplayFrontier=Math.max(latest,entry.activityReplayFrontier??-1);
      entry.acceptedPacketFrontier=parsed.packetCount;entry.state.lastSuccessfulReadAt=new Date(this.clock()).toISOString();
    }
  }
  private startTimer():void{if(this.autoPoll&&!this.timer&&!this.closed){this.timer=setInterval(()=>void this.refresh().catch(()=>undefined),this.limits.pollIntervalMs);this.timer.unref();}}
  private cachedBytes():number{return[...this.entries.values()].reduce((sum,entry)=>sum+entry.reader.bufferedBytes,0);}
  private ensureCache(entry:Entry,size:number):void{
    const additional=Math.max(0,size-entry.reader.bufferedBytes);
    const candidates=[...this.entries.values()].filter(item=>item!==entry&&!this.queue.isRunning(item.state.id)).sort((a,b)=>a.lastUsed-b.lastUsed);
    for(const previous of candidates){if(this.cachedBytes()+additional<=this.cacheBudget)break;previous.reader.releaseBuffer();}
    if(this.cachedBytes()+additional>this.cacheBudget)throw new Error('Canlı dosya tamponu için bellek bütçesi dolu; kuyruk yeniden deneyecek.');
  }
  private async resetFolderEntry(entry:Entry,candidate?:FolderCandidate,recordingReset=false):Promise<void>{
    entry.generation++;this.queue.cancel(entry.state.id);entry.reader.releaseBuffer();
    await this.bridge?.release(entry.state.id);
    if(recordingReset)this.resetSuccessfulRead(entry);
    else{entry.folderNeedsBaseline=true;entry.state.liveActivity=entry.state.lastValidatedProgressAt?'idle':'waiting';}
    entry.folderAwaitingChange=true;entry.recordingResetPending=entry.recordingResetPending||recordingReset;
    entry.failureSignature=undefined;entry.retryAt=undefined;entry.failures=0;
    if(candidate){entry.signature=candidate.signature;entry.parsedSignature=candidate.signature;entry.stableProcessedSignature=candidate.signature;entry.state.fileSize=candidate.size;entry.folderSourceIdentity=candidate.identity;entry.folderSourceSize=candidate.size;}
  }
  private async discoverFiles():Promise<void>{
    const folder=this.discovery.folder,generation=this.folderGeneration;if(!folder||!this.discovery.enabled)return;
    const current=()=>!this.closed&&generation===this.folderGeneration&&this.discovery.enabled;
    const actual=await realpath(folder);if(keyFor(actual)!==keyFor(folder))throw new Error('Replay klasör yolu değişti; klasörü yeniden seçin.');
    const handle=await opendir(folder),seen=new Set<string>();
    let recordingsChanged=false;
    for await(const item of handle){
      if(!current())return;
      if(!item.isFile()||item.isSymbolicLink()||path.extname(item.name).toLowerCase()!=='.rrf')continue;
      const file=path.join(folder,item.name),canonical=await realpath(file).catch(()=>null);if(!canonical||!current())continue;
      if(keyFor(path.dirname(canonical))!==keyFor(folder)||keyFor(canonical)!==keyFor(file))continue;
      const info=await stat(canonical).catch(()=>null);if(!info?.isFile()||!current())continue;
      const key=keyFor(canonical),signature=fileSignature(info),identity=signature.split(':').slice(0,3).join(':');seen.add(key);
      const candidate:FolderCandidate={path:canonical,signature,identity,size:info.size},previous=this.candidates.get(key),entryId=this.byPath.get(key),entry=entryId?this.entries.get(entryId):undefined;
      this.candidates.set(key,candidate);
      // Appending gameplay doesn't change the recording-start balances read by the EXP page.
      if (!previous || previous.identity!==identity || info.size<previous.size ||
          (info.size===previous.size && previous.signature!==signature)) recordingsChanged=true;
      if(!previous||previous.identity!==identity||info.size<previous.size){
        // A new/copy/replaced file first establishes a size/identity baseline. Its old contents never activate it.
        if(entry?.state.sourceMode==='folder')await this.resetFolderEntry(entry,candidate,(entry.folderSourceIdentity!==undefined&&entry.folderSourceIdentity!==identity)||(entry.folderSourceSize!==undefined&&info.size<entry.folderSourceSize));
        continue;
      }
      if(entry?.state.sourceMode==='folder'){entry.folderSourceIdentity=identity;entry.folderSourceSize=info.size;}
      if(info.size<=previous.size)continue;
      if(entry){if(entry.state.sourceMode==='folder')entry.folderAwaitingChange=false;continue;}
      const id=randomUUID(),now=this.clock(),state:LiveStreamState={id,filename:path.basename(canonical),sourcePath:canonical,sourceMode:'folder',liveActivity:'waiting',lastValidatedProgressAt:null,status:'queued',revision:0,readPosition:0,fileSize:info.size,bytesReadTotal:0,lastActivityAt:null,lastSuccessfulReadAt:null,diagnostics:[observationNotice],packetCount:0,eventCount:0,summary:null,compatibility:'skadi-unverified'};
      this.entries.set(id,{state,reader:new RrfStreamReader(canonical,this.bridge?Number.MAX_SAFE_INTEGER:this.limits.perFileBytes),signature:null,parsedSignature:null,lastChangeAt:now,stableSamples:0,savedHash:null,lastUsed:now,generation:0,stableProcessedSignature:null,acceptedPacketFrontier:0,folderNeedsBaseline:true,activityReplayFrontier:-1,folderSourceIdentity:identity,folderSourceSize:info.size});this.byPath.set(key,id);
    }
    if(!current())return;
    for(const key of this.candidates.keys())if(!seen.has(key)){
      this.candidates.delete(key);
      recordingsChanged=true;
    }
    if(recordingsChanged)this.discovery.recordingsRevision=(this.discovery.recordingsRevision??0)+1;
    this.discovery.blockedReason=null;this.discovery.lastScanAt=new Date(this.clock()).toISOString();
  }
  private async maintainFolderEntries():Promise<void>{
    const now=this.clock();
    for(const entry of this.entries.values()){
      if(entry.state.sourceMode!=='folder')continue;
      const lastProgress=entry.state.lastValidatedProgressAt?Date.parse(entry.state.lastValidatedProgressAt):null;
      if(entry.state.liveActivity==='live'&&lastProgress!==null&&now-lastProgress>=this.idleAfterMs)entry.state.liveActivity='idle';
      // Keep the bounded resident parser so the first event after silence remains a delta.
      // The bridge's memory-admitted LRU and inactive-entry pruning release old workers.
    }
    const automatic=[...this.entries.values()].filter(entry=>entry.state.sourceMode==='folder');
    const owner=(entry:Entry)=>{const summary=entry.state.summary;return summary&&Number.isSafeInteger(summary.playerId)&&summary.playerId!==null&&summary.playerId>0?JSON.stringify([summary.playerId,summary.characterName]):null;};
    const activeOwners=new Set(automatic.filter(entry=>entry.state.liveActivity==='live').map(owner).filter((value):value is string=>value!==null));
    const inactive=automatic.filter(entry=>entry.state.liveActivity!=='live'&&!this.queue.has(entry.state.id)).sort((a,b)=>(Date.parse(b.state.lastValidatedProgressAt??'')||b.lastUsed)-(Date.parse(a.state.lastValidatedProgressAt??'')||a.lastUsed));
    const retainedOwners=new Set<string>();let retained=0;
    for(const entry of inactive){const key=owner(entry),duplicate=entry.state.liveActivity==='idle'&&key!==null&&(activeOwners.has(key)||retainedOwners.has(key));
      if(duplicate||retained>=this.maxInactiveFolderStreams)await this.control(entry.state.id,'remove');
      else{retained++;if(key!==null&&entry.state.liveActivity==='idle')retainedOwners.add(key);}
    }
  }
  private async inspectStreams():Promise<void>{
    if(this.discovery.enabled){try{await this.discoverFiles();}catch(error){
      const interrupted=this.discovery.blockedReason===null;this.discovery.blockedReason=this.message(error);
      if(interrupted){this.candidates.clear();for(const entry of this.entries.values())if(entry.state.sourceMode==='folder')await this.resetFolderEntry(entry);}
    }}
    for(const entry of this.entries.values()){
      if(this.closed)break;if(['paused','stopped'].includes(entry.state.status))continue;
      if(entry.state.sourceMode==='folder'&&entry.folderAwaitingChange)continue;
      try{
        const info=await entry.reader.inspect();const signature=fileSignature(info),now=this.clock();
        if(signature!==entry.signature){
          const replaced=entry.signature?.split(':').slice(0,3).join(':')!==signature.split(':').slice(0,3).join(':')||info.size<entry.state.fileSize;
          if(replaced)this.resetSuccessfulRead(entry);
          if(replaced||entry.retryAt===Infinity){entry.failureSignature=undefined;entry.retryAt=undefined;entry.failures=0;}
          entry.signature=signature;entry.lastChangeAt=now;entry.stableSamples=1;entry.state.fileSize=info.size;
        }
        else entry.stableSamples++;
        if(this.queue.has(entry.state.id))continue;
        if(entry.state.sourceMode==='folder'&&entry.failureSignature===signature)continue;
        if(entry.failureSignature&&(entry.failureSignature===signature||entry.retryAt!==Infinity)&&now<(entry.retryAt??Infinity))continue;
        const stable=entry.stableSamples>=3&&now-entry.lastChangeAt>=this.limits.settleMs&&now-info.mtimeMs>=this.limits.settleMs;
        if(entry.parsedSignature===signature&&(!stable||entry.stableProcessedSignature===signature)){if(stable&&entry.state.summary)entry.state.status='settled';continue;}
        const required=this.bridge?this.heapAllowance+2*MIB:info.size*2+this.heapAllowance;
        if(required>this.queue.memoryBudgetBytes){entry.state.status='resource-wait';entry.state.diagnostics=[observationNotice,'Bu snapshot işçi bellek bütçesine sığmıyor. Daha küçük kayıt seçin veya kaynak bütçesini artırın.'];continue;}
        entry.state.status='queued';const generation=entry.generation;
        this.queue.enqueue({id:entry.state.id,bytes:required,run:signal=>this.process(entry,generation,stable,signature,signal)});
      }catch(error){
        if(this.queue.has(entry.state.id))this.queue.cancel(entry.state.id);
        const code=(error as NodeJS.ErrnoException).code;entry.state.status=code==='ENOENT'?'missing':'error';entry.state.diagnostics=[observationNotice,this.message(error)];entry.reader.releaseBuffer();
        if(entry.state.sourceMode==='folder')entry.state.liveActivity=entry.state.lastValidatedProgressAt?'idle':'waiting';
      }
    }
    if(!this.closed)await this.maintainFolderEntries();
    this.emit();
  }
  private async process(entry:Entry,generation:number,stable:boolean,expectedSignature:string,signal:AbortSignal):Promise<void>{
    if(this.bridge)return this.processBridge(entry,generation,stable,expectedSignature,signal);
    const current=()=>!this.closed&&!signal.aborted&&this.entries.get(entry.state.id)===entry&&entry.generation===generation;
    try{
      if(!current())return;
      // Appending writers can also patch earlier bodies without changing the header. Before any
      // archive checkpoint, rehydrate from disk rather than trusting the provisional append cache.
      if(stable)entry.reader.releaseBuffer();
      this.ensureCache(entry,entry.state.fileSize);entry.state.status='reading';this.emit();
      const snapshot=await entry.reader.read(signal);if(!current())return;
      const sourceIdentity=snapshot.signature.split(':').slice(0,3).join(':');
      const sourceChanged=entry.lastSourceIdentity!==undefined&&(entry.lastSourceIdentity!==sourceIdentity||snapshot.size<(entry.lastSourceSize??0));
      entry.recordingResetPending=entry.recordingResetPending||sourceChanged;
      entry.lastSourceIdentity=sourceIdentity;entry.lastSourceSize=snapshot.size;
      stable=stable&&snapshot.signature===expectedSignature&&entry.signature===expectedSignature&&this.clock()-entry.lastChangeAt>=this.limits.settleMs;
      entry.state.fileSize=snapshot.size;
      if(snapshot.signature!==entry.signature){entry.signature=snapshot.signature;entry.lastChangeAt=this.clock();entry.stableSamples=1;}
      entry.lastUsed=this.clock();entry.state.bytesReadTotal=entry.reader.bytesReadTotal;entry.state.readPosition=entry.reader.readPosition;
      if(snapshot.changed){entry.state.revision++;entry.state.lastActivityAt=new Date(this.clock()).toISOString();}
      // A header rewrite invalidates the reader cache, but is still the same live recording.
      // Keep its last coherent summary visible until the replacement parse completes.
      if(sourceChanged||snapshot.size===0){entry.state.summary=null;entry.state.contentHash=undefined;entry.state.packetCount=0;entry.state.eventCount=0;entry.savedHash=null;this.resetSuccessfulRead(entry);}
      if(snapshot.size===0){entry.state.status='following';entry.state.diagnostics=[observationNotice,'Dosya boş; ilk tamamlanmış başlık bekleniyor.'];entry.parsedSignature=snapshot.signature;return;}
      entry.state.status='analyzing';this.emit();const hash=createHash('sha256').update(new Uint8Array(snapshot.bytes)).digest('hex');
      const parsed=await this.parser(snapshot.bytes,entry.state.filename,signal);if(!current())return;
      stable=stable&&entry.signature===snapshot.signature&&this.clock()-entry.lastChangeAt>=this.limits.settleMs;
      entry.state.contentHash=hash;entry.state.packetCount=parsed.packetCount;entry.state.eventCount=parsed.events.length;
      entry.state.diagnostics=[observationNotice,...parsed.diagnostics.slice(0,100).map(item=>`[${item.code}] ${item.message}`),...parsed.unknownPackets.slice(0,100).map(item=>`[UNKNOWN_PACKET] ${item.packetId}: ${item.count}`)];
      const supported=parsed.status==='supported'||parsed.status==='partial';if(supported)entry.state.summary=toSummary(parsed);
      entry.state.status=!supported?'error':stable?'settled':'following';entry.parsedSignature=snapshot.signature;
      if(supported&&current()){
        this.prepareSuccessfulReadScope(entry,parsed,entry.recordingResetPending);
        await this.options.onSnapshot?.(parsed,{streamId:entry.state.id,sourcePath:entry.state.sourcePath,filename:entry.state.filename,revision:entry.state.revision,size:snapshot.size,hash,observedAt:new Date(this.clock()).toISOString(),readPosition:entry.state.readPosition,recordingReset:entry.recordingResetPending,initial:entry.state.sourceMode==='folder'?entry.folderNeedsBaseline:undefined});
        if(current()){this.commitSuccessfulRead(entry,parsed);entry.recordingResetPending=false;if(entry.state.sourceMode==='folder')entry.folderNeedsBaseline=false;}
      }
      if(!current())return;
      if(stable&&supported&&entry.savedHash!==hash){
        await this.options.onStable?.(parsed,{streamId:entry.state.id,sourcePath:entry.state.sourcePath,filename:entry.state.filename,revision:entry.state.revision,size:snapshot.size,hash,observedAt:new Date(this.clock()).toISOString(),readPosition:entry.state.readPosition});
        if(current())entry.savedHash=hash;
      }
      if(stable&&current())entry.stableProcessedSignature=snapshot.signature;
    }catch(error){
      if(current()){
        entry.state.status=error instanceof ChangingReplayError?'following':this.message(error).includes('tamponu')?'resource-wait':(error as NodeJS.ErrnoException).code==='ENOENT'?'missing':'error';
        entry.state.diagnostics=[observationNotice,this.message(error)];entry.reader.releaseBuffer();
        if(entry.state.sourceMode==='folder')entry.state.liveActivity=entry.state.lastValidatedProgressAt?'idle':'waiting';
      }
    }finally{if(!current())entry.reader.releaseBuffer();else this.emit();}
  }
  private async processBridge(entry:Entry,generation:number,stable:boolean,expectedSignature:string,signal:AbortSignal):Promise<void>{
    const current=()=>!this.closed&&!signal.aborted&&this.entries.get(entry.state.id)===entry&&entry.generation===generation;
    const applyMeta=(meta:BridgeMeta)=>{
      const changed=meta.signature!==entry.parsedSignature;
      entry.state.fileSize=meta.size;entry.state.readPosition=meta.readPosition;entry.state.bytesReadTotal=meta.bytesReadTotal;
      entry.state.contentHash=meta.verifiedHash??meta.hash;
      if(changed&&meta.signature!==entry.signature){entry.signature=meta.signature;entry.lastChangeAt=this.clock();entry.stableSamples=1;}
      if(changed)entry.state.lastActivityAt=new Date(this.clock()).toISOString();
      entry.lastUsed=this.clock();
    };
    try{
      if(!current())return;
      entry.state.status='reading';this.emit();
      const result=await this.bridge!.run({streamId:entry.state.id,sourcePath:entry.state.sourcePath,filename:entry.state.filename,verify:stable},signal,async(parsed,meta)=>{
        if(!current())return;
        applyMeta(meta);
        if(!['supported','partial'].includes(parsed.status))throw new Error(parsed.diagnostics.find(value=>value.severity==='error')?.message??'Replay köprüsü geçerli sonuç üretemedi.');
        const recordingReset=(meta.recordingReset||entry.recordingResetPending===true)&&parsed.incremental?.recordingStart;
        this.prepareSuccessfulReadScope(entry,parsed,recordingReset);
        if(recordingReset){entry.state.summary=null;entry.state.packetCount=0;entry.state.eventCount=0;entry.savedHash=null;entry.lastParsed=undefined;}
        entry.state.revision++;
        entry.state.packetCount=parsed.packetCount;
        entry.state.eventCount=parsed.incremental?.eventCount??parsed.events.length;
        entry.state.summary=toSummary(parsed);entry.state.status='analyzing';
        entry.state.diagnostics=['Artımlı okuma: yalnız yeni ve değişen desteklenen olaylar işlenir. Skadi uyumluluğu deneysel.',...parsed.diagnostics.slice(0,100).map(value=>`[${value.code}] ${value.message}`),...parsed.unknownPackets.slice(0,100).map(value=>`[UNKNOWN_PACKET] ${value.packetId}: ${value.count}`)];
        await this.options.onSnapshot?.(parsed,{streamId:entry.state.id,sourcePath:entry.state.sourcePath,filename:entry.state.filename,revision:entry.state.revision,size:meta.size,hash:meta.hash,observedAt:new Date(this.clock()).toISOString(),readPosition:meta.readPosition,recordingReset,initial:meta.initial||entry.folderNeedsBaseline===true});
        if(!current())return;
        this.commitSuccessfulRead(entry,parsed,meta.initial);
        if(!meta.catchingUp&&entry.state.sourceMode==='folder'){entry.folderNeedsBaseline=false;entry.recordingResetPending=false;}
        entry.lastParsed={...parsed,events:[]};
        this.emit();
      });
      if(!current())return;
      applyMeta(result);
      if(result.pending){entry.state.status='following';entry.state.diagnostics=[...entry.state.diagnostics.filter(value=>!value.startsWith('[PENDING]')),...(result.diagnostics??[]).map(value=>`[PENDING] ${value}`)];return;}
      entry.failureSignature=undefined;entry.retryAt=undefined;entry.failures=0;
      entry.parsedSignature=result.signature;
      stable=stable&&result.signature===expectedSignature&&entry.signature===result.signature;
      entry.state.status=stable?'settled':'following';
      if(stable&&entry.lastParsed&&entry.savedHash!==(result.verifiedHash??result.hash)){
        await this.options.onStable?.(entry.lastParsed,{streamId:entry.state.id,sourcePath:entry.state.sourcePath,filename:entry.state.filename,revision:entry.state.revision,size:result.size,hash:result.verifiedHash??result.hash,observedAt:new Date(this.clock()).toISOString(),readPosition:result.readPosition});
        if(current())entry.savedHash=result.verifiedHash??result.hash;
      }
      if(stable&&current())entry.stableProcessedSignature=result.signature;
    }catch(error){
      if(current()){
        if(entry.lastParsed){entry.state.summary=toSummary(entry.lastParsed);entry.state.packetCount=entry.lastParsed.packetCount;entry.state.eventCount=entry.lastParsed.incremental?.eventCount??entry.lastParsed.events.length;}
        else{entry.state.summary=null;entry.state.packetCount=0;entry.state.eventCount=0;}
        entry.failures=(entry.failures??0)+1;entry.failureSignature=expectedSignature;
        const text=this.message(error),permanent=/memory limit|out of memory|metadata sınırı|desteklenmiyor|güvenli.*sınır/i.test(text);
        entry.retryAt=permanent?Infinity:this.clock()+Math.min(60000,1000*2**Math.min(entry.failures,6));
        entry.state.status=(error as NodeJS.ErrnoException).code==='ENOENT'?'missing':'error';
        entry.state.diagnostics=[text,permanent?'Kaynak değişene veya yeniden devam ettirilene kadar tekrar denenmez.':'Son geçerli özet korunuyor; yeniden denemeler artan aralıklarla yapılır.'];
        if(entry.state.sourceMode==='folder')entry.state.liveActivity=entry.state.lastValidatedProgressAt?'idle':'waiting';
      }
    }finally{if(current())this.emit();}
  }
  private message(error:unknown):string{
    const code=(error as NodeJS.ErrnoException)?.code;if(code==='ENOENT')return'Kaynak dosya bulunamadı; taşınmış, yeniden adlandırılmış veya kapanmış olabilir. Yol yeniden göründüğünde kontrol edilir.';
    if(code==='EACCES'||code==='EPERM'||code==='EBUSY')return'Kaynak dosya kilitli veya okunamıyor; izinler değiştirilmeyecek. Sonraki gözlemde tekrar denenir.';
    return error instanceof Error?error.message:String(error);
  }
}
