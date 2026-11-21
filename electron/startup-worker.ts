import {parentPort,workerData} from 'node:worker_threads';
import {ExpansionStore} from './expansion-store';

if(!parentPort)throw new Error('Başlangıç hazırlığı yalnız işçi içinde çalışabilir.');
const port=parentPort;
let store:ExpansionStore|undefined;
try{
  if(!workerData||typeof workerData.filePath!=='string'||!workerData.filePath.trim())throw new Error('Arşiv hazırlık isteği geçersiz.');
  store=new ExpansionStore(workerData.filePath,{
    summaryOnly:true,ownDamageOnly:true,killExperienceSoloOnly:true,lightweightHistory:true,
    onStartupProgress:message=>port.postMessage({type:'progress',message}),
  });
  store.close();store=undefined;
  port.postMessage({type:'done'});
}catch(error){
  try{store?.close();}catch{/* Preserve the preparation failure when cleanup also fails. */}
  port.postMessage({type:'error',message:error instanceof Error?error.message:'Arşiv hazırlığı tamamlanamadı.'});
}finally{port.close();}
