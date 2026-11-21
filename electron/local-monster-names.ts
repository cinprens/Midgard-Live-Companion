import {DatabaseSync} from 'node:sqlite';
import {open,realpath,stat} from 'node:fs/promises';
import path from 'node:path';

const MAX_CATALOG_BYTES=32*1024*1024,MAX_DATABASE_BYTES=128*1024*1024,MAX_MONSTERS=10000;
export interface LocalMonsterNames {names:Map<number,string>;source:'calculator-sqlite'|'calculator-bundled'|'none';}
/** Only ID/name metadata is used. Calculator prices, saves and game statistics are not imported. */
export function parseCalculatorMonsterNames(payload:string):Map<number,string>{
  if(Buffer.byteLength(payload,'utf8')>MAX_CATALOG_BYTES)throw new Error('Yerel yaratık kataloğu boyut sınırını aşıyor.');
  const value:unknown=JSON.parse(payload);
  if(!value||typeof value!=='object'||!('monsters' in value)||!Array.isArray(value.monsters)||value.monsters.length>MAX_MONSTERS)throw new Error('Yerel yaratık kataloğu tanınmadı.');
  const names=new Map<number,string>();
  for(const row of value.monsters){
    if(!row||typeof row!=='object'||!Number.isSafeInteger(row.id)||row.id<1||row.id>0xffffffff||typeof row.name!=='string')throw new Error('Yerel yaratık kaydı geçersiz.');
    const name=row.name.normalize('NFC').trim();
    if(!name||name.length>300||/[\u0000-\u001f\u007f\ufffd]/.test(name)||names.has(row.id))throw new Error('Yerel yaratık adı veya kimliği geçersiz.');
    names.set(row.id,name);
  }
  return names;
}
async function regularFile(file:string,maximum:number):Promise<boolean>{
  try{const resolved=await realpath(file);if(resolved.toLowerCase()!==path.resolve(file).toLowerCase())return false;const info=await stat(file);return info.isFile()&&info.size<=maximum;}catch{return false;}
}
/** The caller supplies the local Calculator installation directory; no remote requests or writes. */
export async function loadCalculatorMonsterNames(directory:string):Promise<LocalMonsterNames>{
  const database=path.resolve(directory,'Veriler','ragnarok.sqlite');
  if(await regularFile(database,MAX_DATABASE_BYTES)){
    let db:DatabaseSync|undefined;
    try{
      db=new DatabaseSync(database,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000;');
      const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='current_catalog'").get();
      if(table){
        const row=db.prepare('SELECT substr(payload,1,?) payload FROM current_catalog WHERE id=1 AND length(CAST(payload AS BLOB))<=?').get(MAX_CATALOG_BYTES,MAX_CATALOG_BYTES);
        if(row&&typeof row.payload==='string')return{names:parseCalculatorMonsterNames(row.payload),source:'calculator-sqlite'};
      }
    }catch{/* A missing/unsupported saved catalog can use the installed baseline below. */}finally{db?.close();}
  }
  const file=path.resolve(directory,'resources','app','data','catalog.json');
  if(await regularFile(file,MAX_CATALOG_BYTES)){
    let handle:Awaited<ReturnType<typeof open>>|undefined;
    try{
      handle=await open(file,'r');const before=await handle.stat();
      if(!before.isFile()||before.size>MAX_CATALOG_BYTES)return{names:new Map(),source:'none'};
      const bytes=Buffer.alloc(before.size);let at=0;
      while(at<bytes.length){const read=await handle.read(bytes,at,bytes.length-at,at);if(!read.bytesRead)throw new Error('Yerel yaratık kataloğu eksik okundu.');at+=read.bytesRead;}
      const after=await handle.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('Yerel yaratık kataloğu okunurken değişti.');
      return{names:parseCalculatorMonsterNames(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'')),source:'calculator-bundled'};
    }catch{/* Unknown metadata stays unknown; there is no synthetic name/count fallback. */}finally{await handle?.close();}
  }
  return{names:new Map(),source:'none'};
}
