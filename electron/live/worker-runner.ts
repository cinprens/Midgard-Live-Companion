import { Worker } from 'node:worker_threads';
import type { ParsedReplay } from '../../src/parser/types';

export type SnapshotParser=(bytes:ArrayBuffer,filename:string,signal:AbortSignal)=>Promise<ParsedReplay>;
export function workerSnapshotParser(workerPath:string,heapLimitMb:number,timeoutMs=60_000):SnapshotParser{
  return(bytes,filename,signal)=>new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new Error('İşlem durduruldu.'));return;}
    const worker=new Worker(workerPath,{resourceLimits:{maxOldGenerationSizeMb:heapLimitMb}});let settled=false;
    const finish=(error:Error|null,parsed?:ParsedReplay)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);const complete=()=>{if(error)reject(error);else resolve(parsed!);};void worker.terminate().then(complete,complete);};
    const abort=()=>finish(new Error('İşlem durduruldu.'));
    const timer=setTimeout(()=>finish(new Error('Canlı gözlem ayrıştırması zaman sınırını aştı.')),timeoutMs);
    signal.addEventListener('abort',abort,{once:true});
    worker.once('error',error=>finish(error));worker.once('exit',code=>{if(!settled)finish(new Error(`Canlı analiz işçisi sonuç üretmeden kapandı (${code}).`));});
    worker.once('message',(message:{ok:boolean;parsed?:ParsedReplay;error?:string})=>finish(message.ok&&message.parsed?null:new Error(message.error??'Replay ayrıştırılamadı.'),message.parsed));
    worker.postMessage({bytes,filename},[bytes]);
  });
}
