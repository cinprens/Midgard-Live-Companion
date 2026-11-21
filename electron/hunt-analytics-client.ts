import {Worker} from 'node:worker_threads';
import type {HuntAnalyticsState,HuntAnalyticsEvidencePage} from '../src/shared/hunt-analytics';

interface Pending {resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;}
/** The renderer never receives raw archives; a bounded queue feeds a read-only worker. */
export class HuntAnalyticsClient {
  private worker:Worker|null=null;
  private pending=new Map<number,Pending>();
  private sequence=0;
  private closed=false;
  constructor(private databasePath:string,private workerPath:string,private timeoutMs=30000,private options:{ownDamageOnly?:boolean}={}){}
  private fail(error:Error):void {
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}
    this.pending.clear();
  }
  private start():Worker {
    if(this.worker)return this.worker;
    const worker=new Worker(this.workerPath,{workerData:{databasePath:this.databasePath,ownDamageOnly:this.options.ownDamageOnly===true}});this.worker=worker;
    worker.on('message',(message:{id:number;result?:unknown;error?:string})=>{
      const pending=this.pending.get(message.id);if(!pending)return;
      this.pending.delete(message.id);clearTimeout(pending.timer);
      if(message.error)pending.reject(new Error(message.error));else pending.resolve(message.result);
    });
    worker.on('error',error=>{if(this.worker===worker){this.worker=null;this.fail(error);}});
    worker.on('exit',()=>{if(this.worker===worker){this.worker=null;this.fail(new Error('Av analizi okuma bağlantısı kapandı. Tekrar deneyin.'));}});
    worker.unref();return worker;
  }
  private request(method:'read'|'evidence',query:unknown):Promise<unknown> {
    if(this.closed)return Promise.reject(new Error('Uygulama kapanırken analiz okunamaz.'));
    if(this.pending.size>=32)return Promise.reject(new Error('Av analizi meşgul. Biraz sonra tekrar deneyin.'));
    return new Promise((resolve,reject)=>{
      const id=++this.sequence;
      try{
        const worker=this.start(),timer=setTimeout(()=>{
          if(!this.pending.has(id))return;
          this.worker=null;this.fail(new Error('Av analizi zaman aşımına uğradı. Tekrar deneyin.'));void worker.terminate();
        },this.timeoutMs);
        this.pending.set(id,{resolve,reject,timer});worker.postMessage({id,method,query});
      }catch(error){const pending=this.pending.get(id);if(pending)clearTimeout(pending.timer);this.pending.delete(id);reject(error);}
    });
  }
  read(query:unknown):Promise<HuntAnalyticsState>{return this.request('read',query) as Promise<HuntAnalyticsState>;}
  evidence(query:unknown):Promise<HuntAnalyticsEvidencePage>{return this.request('evidence',query) as Promise<HuntAnalyticsEvidencePage>;}
  async close():Promise<void>{this.closed=true;this.fail(new Error('Av analizi kapatıldı.'));const worker=this.worker;this.worker=null;await worker?.terminate();}
}
