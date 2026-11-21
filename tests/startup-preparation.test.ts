import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {build} from 'esbuild';
import {prepareStartupDatabase} from '../electron/startup-preparation';
import {ExpansionStore} from '../electron/expansion-store';
import {summaryDetailTables} from '../electron/summary-migration';
import {emptySummary,type ParsedReplay,type ReplayEvent} from '../src/parser';

mkdirSync('.qa',{recursive:true});
const directory=mkdtempSync(path.resolve('.qa','startup-preparation-'));
const realWorker=path.join(directory,'startup-worker.cjs');
beforeAll(async()=>{await build({entryPoints:['electron/startup-worker.ts'],outfile:realWorker,bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron','node:*'],logLevel:'silent'});});
afterAll(()=>rmSync(directory,{recursive:true,force:true}));
function fixture(script:string){
  const folder=mkdtempSync(path.join(directory,'case-')),worker=path.join(folder,'worker.cjs'),file=path.join(folder,'profile.sqlite');
  writeFileSync(worker,`const {parentPort,workerData}=require('node:worker_threads');const fs=require('node:fs');\n${script}`);
  return{worker,file};
}

describe('database startup worker lifecycle',()=>{
  it('keeps the caller responsive and waits for normal worker exit after done',async()=>{
    const f=fixture(`parentPort.postMessage({type:'progress',message:'Günlük toplamlar hazırlanıyor'});parentPort.postMessage({type:'progress',message:'Günlük toplamlar hazırlanıyor'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);parentPort.postMessage({type:'done'});parentPort.postMessage({type:'done'});setTimeout(()=>{fs.writeFileSync(workerData.filePath+'.closed','closed');parentPort.close();},50);`);
    const progress:string[]=[];let beats=0,finished=0;const timer=setInterval(()=>beats++,10);
    try{await prepareStartupDatabase(f.file,f.worker,message=>progress.push(message)).then(()=>{finished++;expect(existsSync(f.file+'.closed')).toBe(true);});}finally{clearInterval(timer);}
    expect(beats).toBeGreaterThanOrEqual(3);expect(finished).toBe(1);expect(progress).toEqual(['Günlük toplamlar hazırlanıyor']);expect(readFileSync(f.file+'.closed','utf8')).toBe('closed');
  });
  it('waits for error cleanup before rejecting and ignores subsequent success/progress',async()=>{
    const f=fixture(`parentPort.postMessage({type:'progress',message:'Arşiv hazırlanıyor'});parentPort.postMessage({type:'error',message:'Özet doğrulanamadı'});parentPort.postMessage({type:'done'});parentPort.postMessage({type:'progress',message:'Geçersiz ilerleme'});setTimeout(()=>{fs.writeFileSync(workerData.filePath+'.closed','closed');parentPort.close();},40);`),progress:string[]=[];
    await expect(prepareStartupDatabase(f.file,f.worker,message=>progress.push(message))).rejects.toThrow('Özet doğrulanamadı');
    expect(existsSync(f.file+'.closed')).toBe(true);expect(progress).toEqual(['Arşiv hazırlanıyor']);
  });
  it('reports thrown worker failures without exposing stack traces or request arguments',async()=>{
    const f=fixture(`throw new Error('database is locked');`);
    await expect(prepareStartupDatabase(f.file,f.worker,()=>{})).rejects.toThrow('Arşiv başka bir işlem tarafından kullanılıyor');
  });
  it('rejects a clean exit without completion instead of treating it as a prepared database',async()=>{
    const f=fixture(`parentPort.postMessage({type:'unknown'});parentPort.close();`);
    await expect(prepareStartupDatabase(f.file,f.worker,()=>{})).rejects.toThrow('tamamlandığını bildirmeden');
  });
  it('rejects an abnormal exit even when an early done message was sent',async()=>{
    const f=fixture(`parentPort.postMessage({type:'done'});process.exitCode=2;parentPort.close();`);
    await expect(prepareStartupDatabase(f.file,f.worker,()=>{})).rejects.toThrow('beklenmedik biçimde');
  });
  it('does not expose a private worker path when the packaged worker is absent',async()=>{
    const f=fixture('');
    await expect(prepareStartupDatabase(f.file,path.join(path.dirname(f.worker),'missing-private-worker.cjs'),()=>{})).rejects.toThrow('Başlangıç hazırlık dosyası bulunamadı veya açılamadı');
  });
  it('does not abort preparation when a progress presentation callback throws',async()=>{
    const f=fixture(`parentPort.postMessage({type:'progress',message:'Hazırlanıyor'});parentPort.postMessage({type:'done'});parentPort.close();`);
    await expect(prepareStartupDatabase(f.file,f.worker,()=>{throw new Error('Synthetic UI callback failure');})).resolves.toBeUndefined();
  });
  it('prepares a real synthetic legacy database, closes it, and preserves totals on reopen',async()=>{
    const f=fixture(''),owner={key:'recorded:42:Startup',name:'Startup',source:'recorded' as const,playerId:42};
    const death:ReplayEvent={id:'startup-death',eventType:'death',timestamp:1000,targetId:1001,actorId:42,monsterId:1176,entityKind:'mob',confidence:'estimated',attribution:'personal',rawData:{attackers:[42],killProof:{death:'vanish-kind-1',ownership:'exclusive-observed-attacker-estimate',targetActorId:1001,lifecycleId:'wire:0:1001:1',scope:'replay-local',lastAttackTimestamp:900}}};
    const replay:ParsedReplay={filename:'startup.rrf',format:'RRF',version:5,status:'partial',profile:'rrf-v5-latam',compatibility:'skadi-unverified',events:[death],diagnostics:[],unknownPackets:[],packetCount:1,summary:{...emptySummary(),playerId:42,characterName:'Startup',startedAt:'2026-11-07T00:00:00+03:00',durationMs:1000}};
    const old=new ExpansionStore(f.file,{ownDamageOnly:true});
    try{old.killCount.observe(replay,{sourcePath:path.join(path.dirname(f.file),'synthetic.rrf'),streamId:'s',recordingId:'r',hash:'synthetic'},owner);old.autoFarm.setPrice({itemId:501,unitPrice:25});expect(old.killCount.snapshot().totals.observedDeaths).toBe(1);}finally{old.close();}
    const progress:string[]=[];await prepareStartupDatabase(f.file,realWorker,message=>progress.push(message));
    const db=new DatabaseSync(f.file);
    try{expect(db.prepare('SELECT MAX(version) v FROM expansion_migrations').get()!.v).toBe(14);expect(db.prepare('PRAGMA quick_check').get()!.quick_check).toBe('ok');expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect(summaryDetailTables(db).every(table=>db.prepare(`SELECT COUNT(*) n FROM "${table}"`).get()!.n===0)).toBe(true);db.exec('BEGIN EXCLUSIVE;COMMIT');}finally{db.close();}
    const current=new ExpansionStore(f.file);
    try{expect(current.summaryOnly).toBe(true);expect(current.killCount.snapshot().totals.observedDeaths).toBe(1);expect(current.killDaily.read({date:'2026-11-07'}).totals.observedDeaths).toBe(1);expect(current.autoFarm.snapshot().prices).toEqual(expect.arrayContaining([expect.objectContaining({itemId:501,unitPrice:25})]));}finally{current.close();}
    expect(progress.length).toBeGreaterThan(0);
    await expect(prepareStartupDatabase(f.file,realWorker,()=>{})).resolves.toBeUndefined();
    expect(existsSync(f.file+'-wal')?readFileSync(f.file+'-wal').byteLength:0).toBe(0);
  });
});
