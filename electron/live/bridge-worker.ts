import {parentPort} from 'node:worker_threads';
import {ReplayFileSession,type BridgeRunRequest,type FileSessionOptions} from './file-session';

if(!parentPort)throw new Error('Replay köprüsü worker olarak başlatılmalıdır.');
let session:ReplayFileSession|undefined;
let busy=false;
let acknowledge:((error?:string)=>void)|null=null;
parentPort.on('message',(message:{type:string;runId?:number;request?:BridgeRunRequest;options?:FileSessionOptions;error?:string})=>{
  if(message.type==='ack'){const done=acknowledge;acknowledge=null;done?.(message.error);return;}
  if(message.type!=='run'||!message.request)return;
  if(busy){parentPort!.postMessage({type:'error',runId:message.runId,error:'Replay köprüsünde eş zamanlı istek reddedildi.'});return;}
  busy=true;session??=new ReplayFileSession(message.options);
  const controller=new AbortController(),runId=message.runId;
  let peakHeapUsedBytes=0,peakExternalBytes=0;
  const sample=()=>{const memory=process.memoryUsage();peakHeapUsedBytes=Math.max(peakHeapUsedBytes,memory.heapUsed);peakExternalBytes=Math.max(peakExternalBytes,memory.external);return memory;};
  void session.run(message.request,controller.signal,async(parsed,meta)=>{
    sample();
    await new Promise<void>((resolve,reject)=>{
      acknowledge=error=>error?reject(new Error(error)):resolve();
      parentPort!.postMessage({type:'batch',runId,parsed,meta});
    });
  },()=>{sample();parentPort!.postMessage({type:'progress',runId});}).then(result=>{const memory=sample();parentPort!.postMessage({type:'result',runId,result:{...result,workerMemory:{heapUsedBytes:memory.heapUsed,externalBytes:memory.external,peakHeapUsedBytes,peakExternalBytes}}});},error=>parentPort!.postMessage({type:'error',runId,error:error instanceof Error?error.message:String(error)})).finally(()=>{busy=false;});
});
