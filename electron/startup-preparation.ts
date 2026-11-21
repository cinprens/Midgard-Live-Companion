import {Worker} from 'node:worker_threads';

const fallback='Arşiv hazırlığı tamamlanamadı.';

/** Only a short message crosses into the UI; worker data, paths and stacks do not. */
function readableError(value:unknown):Error{
  const code=value&&typeof value==='object'?'code' in value?String(value.code):'':'';
  if(['ERR_WORKER_PATH','ERR_WORKER_UNSUPPORTED_EXTENSION','MODULE_NOT_FOUND','ENOENT'].includes(code))return new Error('Başlangıç hazırlık dosyası bulunamadı veya açılamadı.');
  const message=typeof value==='string'?value:value instanceof Error?value.message:'';
  if(/database is (?:locked|busy)/i.test(message))return new Error('Arşiv başka bir işlem tarafından kullanılıyor. Diğer MIDGARD penceresini kapatıp yeniden deneyin.');
  const clean=message.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,1000);
  return new Error(clean||fallback);
}

/** Preparation owns the database until the worker has closed it and exited. */
export function prepareStartupDatabase(filePath:string,workerPath:string,onProgress:(message:string)=>void):Promise<void>{
  return new Promise((resolve,reject)=>{
    let worker:Worker;
    try{worker=new Worker(workerPath,{workerData:{filePath}});}catch(error){reject(readableError(error));return;}
    let done=false,failure:Error|undefined,lastProgress:string|undefined;
    const message=(value:unknown)=>{
      if(!value||typeof value!=='object')return;
      const item=value as {type?:unknown;message?:unknown};
      if(item.type==='error'){failure??=readableError(item.message);return;}
      if(failure||done)return;
      if(item.type==='done'){done=true;return;}
      if(item.type!=='progress'||typeof item.message!=='string')return;
      const text=item.message.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,1000);
      if(!text||text===lastProgress)return;
      lastProgress=text;
      try{onProgress(text);}catch{/* A cosmetic update must never interrupt the database transaction. */}
    };
    const error=(value:Error)=>{failure??=readableError(value);};
    worker.on('message',message);worker.on('error',error);
    worker.once('exit',code=>{
      worker.off('message',message);worker.off('error',error);
      if(failure){reject(failure);return;}
      if(code!==0){reject(new Error('Arşiv hazırlığı beklenmedik biçimde durdu. Uygulamayı yeniden açarak tekrar deneyin.'));return;}
      if(!done){reject(new Error('Arşiv hazırlığı tamamlandığını bildirmeden kapandı.'));return;}
      resolve();
    });
  });
}
