import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {HuntAnalyticsStore} from './hunt-analytics-store';

if(!parentPort)throw new Error('Av analizi yalnız okuma işçisi içinde çalışabilir.');
const db=new DatabaseSync(workerData.databasePath,{readOnly:true});
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;');
let reader=new HuntAnalyticsStore(db,{ownDamageOnly:workerData.ownDamageOnly===true}),dataVersion=-1;
parentPort.on('message',(message:{id:number;method:'read'|'evidence';query:unknown})=>{
  try{
    if(message.method!=='read'&&message.method!=='evidence')throw new Error('Analiz işlemi geçersiz.');
    db.exec('BEGIN');
    try{
      // Also invalidate when a separately connected maintenance writer changes the database.
      const nextVersion=Number(db.prepare('PRAGMA data_version').get()!.data_version);
      if(nextVersion!==dataVersion){reader=new HuntAnalyticsStore(db,{ownDamageOnly:workerData.ownDamageOnly===true});dataVersion=nextVersion;}
      const result=message.method==='read'?reader.read(message.query):reader.evidence(message.query);
      db.exec('COMMIT');parentPort!.postMessage({id:message.id,result});
    }catch(error){db.exec('ROLLBACK');throw error;}
  }catch(error){parentPort!.postMessage({id:message.id,error:error instanceof Error?error.message:String(error)});}
});
parentPort.on('close',()=>db.close());
