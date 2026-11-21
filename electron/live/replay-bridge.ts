import {Worker} from 'node:worker_threads';
import type {ParsedReplay} from '../../src/parser/types';
import type {BridgeMeta,BridgeRunRequest,BridgeRunResult,FileSessionOptions} from './file-session';
export type {BridgeMeta,BridgeRunRequest,BridgeRunResult} from './file-session';

export interface BridgeOptions extends FileSessionOptions {workerPath:string;maxSessions?:number;heapLimitMb?:number;inactivityTimeoutMs?:number;}
type Entry={worker:Worker;busy:boolean;lastUsed:number;sourcePath:string;reject?: (error:Error)=>void;callback?:Promise<void>;};

/** Persistent parser workers with bounded residency and acknowledged batch backpressure. */
export class ReplayBridge {
  private entries=new Map<string,Entry>();
  private waiters=new Set<()=>void>();
  private stopping=new Map<Worker,Promise<number>>();
  private operations=new Map<string,Promise<BridgeRunResult>>();
  private closed=false;
  private runId=0;
  private maximum:number;
  constructor(private options:BridgeOptions){this.maximum=Math.max(1,Math.floor(options.maxSessions??3));}
  get residentSessions():number{return this.entries.size+this.stopping.size;}
  private notify():void{for(const wake of this.waiters)wake();this.waiters.clear();}
  private terminate(worker:Worker):Promise<number>{
    const previous=this.stopping.get(worker);if(previous)return previous;
    const operation=worker.terminate();this.stopping.set(worker,operation);
    void operation.finally(()=>{this.stopping.delete(worker);this.notify();}).catch(()=>undefined);
    return operation;
  }
  private async obtain(request:BridgeRunRequest,signal:AbortSignal):Promise<Entry>{
    while(!this.closed&&!signal.aborted){
      const existing=this.entries.get(request.streamId);
      if(existing){
        if(existing.busy)throw new Error('Replay akışı zaten işleniyor.');
        if(existing.sourcePath===request.sourcePath)return existing;
        await this.release(request.streamId);continue;
      }
      if(this.entries.size+this.stopping.size>=this.maximum){
        const candidate=[...this.entries].filter(([,entry])=>!entry.busy).sort((a,b)=>a[1].lastUsed-b[1].lastUsed)[0];
        if(candidate){await this.release(candidate[0]);continue;}
        await new Promise<void>(resolve=>{
          const wake=()=>{signal.removeEventListener('abort',wake);this.waiters.delete(wake);resolve();};
          this.waiters.add(wake);signal.addEventListener('abort',wake,{once:true});
          if(signal.aborted||this.closed)wake();
        });continue;
      }
      const worker=new Worker(this.options.workerPath,{resourceLimits:{maxOldGenerationSizeMb:Math.max(16,Math.floor(this.options.heapLimitMb??128))}});
      const entry:Entry={worker,busy:false,lastUsed:Date.now(),sourcePath:request.sourcePath};
      this.entries.set(request.streamId,entry);
      // An idle native worker can still fail; never leave an unhandled EventEmitter error.
      worker.on('error',error=>{entry.reject?.(error);if(this.entries.get(request.streamId)===entry){this.entries.delete(request.streamId);void this.terminate(worker);}this.notify();});
      worker.on('exit',code=>{entry.reject?.(new Error(`Replay köprüsü kapandı (${code}).`));if(this.entries.get(request.streamId)===entry)this.entries.delete(request.streamId);this.notify();});
      return entry;
    }
    throw new Error(this.closed?'Replay köprüsü kapalı.':'İşlem durduruldu.');
  }
  async run(request:BridgeRunRequest,signal:AbortSignal,onBatch:(parsed:ParsedReplay,meta:BridgeMeta)=>Promise<void>|void):Promise<BridgeRunResult>{
    const entry=await this.obtain(request,signal);
    if(signal.aborted||this.closed||this.entries.get(request.streamId)!==entry){await this.release(request.streamId);throw new Error('İşlem durduruldu.');}
    entry.busy=true;const runId=++this.runId;
    const operation=new Promise<BridgeRunResult>((resolve,reject)=>{
      let settled=false,awaitingCallback=false;
      let timer:ReturnType<typeof setTimeout>|undefined;
      const stopTimer=()=>{if(timer)clearTimeout(timer);timer=undefined;};
      const arm=()=>{stopTimer();timer=setTimeout(()=>fail(new Error('Replay köprüsü ilerleme üretmeyi durdurdu.')),Math.max(1000,this.options.inactivityTimeoutMs??30000));timer.unref();};
      const cleanup=()=>{stopTimer();signal.removeEventListener('abort',abort);entry.worker.removeListener('message',message);entry.reject=undefined;entry.busy=false;entry.lastUsed=Date.now();};
      const finish=(result:BridgeRunResult)=>{if(settled)return;settled=true;cleanup();this.notify();resolve(result);};
      const fail=(error:Error)=>{
        if(settled)return;settled=true;cleanup();
        if(this.entries.get(request.streamId)===entry)this.entries.delete(request.streamId);
        // The native worker is stopped immediately. An already admitted callback still
        // owns its DB work and must settle before cancellation releases the queue slot.
        const admitted=entry.callback?.catch(()=>undefined);
        void Promise.allSettled([this.terminate(entry.worker),admitted]).then(()=>reject(error));
      };
      const abort=()=>fail(new Error('İşlem durduruldu.'));
      const message=(value:{type:string;runId:number;parsed?:ParsedReplay;meta?:BridgeMeta;result?:BridgeRunResult;error?:string})=>{
        if(settled||value.runId!==runId)return;
        if(value.type==='progress'){if(!awaitingCallback)arm();return;}
        if(value.type==='batch'&&value.parsed&&value.meta){
          if(awaitingCallback){fail(new Error('Replay köprüsü ACK beklemeden yeni paket grubu gönderdi.'));return;}
          awaitingCallback=true;stopTimer();
          const callback=Promise.resolve().then(async()=>{if(!settled&&!signal.aborted)await onBatch(value.parsed!,value.meta!);});
          entry.callback=callback;
          callback.then(()=>{
            if(entry.callback===callback)entry.callback=undefined;
            if(settled)return;awaitingCallback=false;arm();entry.worker.postMessage({type:'ack',runId});
          },error=>fail(error instanceof Error?error:new Error(String(error))));
        }else if(value.type==='result'&&value.result)finish(value.result);
        else if(value.type==='error')fail(new Error(value.error??'Replay köprüsü başarısız oldu.'));
      };
      entry.reject=fail;entry.worker.on('message',message);signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted){abort();return;}
      arm();entry.worker.postMessage({type:'run',runId,request,options:{batchBytes:this.options.batchBytes,maxMetadataBytes:this.options.maxMetadataBytes}});
    });
    this.operations.set(request.streamId,operation);
    void operation.finally(()=>{if(this.operations.get(request.streamId)===operation)this.operations.delete(request.streamId);}).catch(()=>undefined);
    return operation;
  }
  async release(streamId:string):Promise<void>{
    const entry=this.entries.get(streamId),operation=this.operations.get(streamId);
    if(!entry){await operation?.catch(()=>undefined);return;}
    this.entries.delete(streamId);entry.reject?.(new Error('Replay akışı durduruldu.'));
    await Promise.allSettled([this.terminate(entry.worker),entry.callback,operation]);this.notify();
  }
  async close():Promise<void>{this.closed=true;this.notify();await Promise.all([...this.entries.keys()].map(id=>this.release(id)));await Promise.all([...this.stopping.values()]);await Promise.allSettled([...this.operations.values()]);}
}
