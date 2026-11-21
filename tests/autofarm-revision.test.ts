import {afterEach,describe,expect,it} from 'vitest';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {execFileSync,spawnSync} from 'node:child_process';
import path from 'node:path';
import {ExpansionStore} from '../electron/expansion-store';
import {AUTOFARM_DECODER_REVISION} from '../electron/auto-farm-store';
import {emptySummary,type ParsedReplay,type ReplayEvent} from '../src/parser';
const stores=new Set<ExpansionStore>(),directories:string[]=[];
afterEach(async()=>{for(const store of stores)store.close();stores.clear();for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true});});
function open(file:string){const store=new ExpansionStore(file);stores.add(store);return store;}
function close(store:ExpansionStore){store.close();stores.delete(store);}
async function profile(){await mkdir('.qa',{recursive:true});const dir=await mkdtemp(path.resolve('.qa/autofarm-revision-'));directories.push(dir);const file=path.join(dir,'audit.sqlite');return{dir,file,store:open(file)};}
function inspect<T>(file:string,read:(db:DatabaseSync)=>T){const db=new DatabaseSync(file,{readOnly:true});try{return read(db);}finally{db.close();}}
function edit(file:string,action:(db:DatabaseSync)=>void){const db=new DatabaseSync(file);try{action(db);}finally{db.close();}}
const character={key:'recorded:42:Çağrı',name:'Çağrı',source:'recorded' as const,playerId:42};
function incoming(timestamp:number,amount=3,source='unknown',itemId=501):ReplayEvent{return{id:`wire-${timestamp}-${itemId}`,timestamp,eventType:'item-obtained',itemId,amount,packetId:'0x0b41',confidence:'certain',actorId:42,rawData:{inventoryWeightProof:{kind:'own-weight-increase',ownerActorId:42,before:100,after:120,receiptTimestamp:timestamp,weightTimestamp:timestamp,confirmedAt:timestamp+500,scope:'receipt-batch'},slot:5,inventoryOccurrence:1,inventoryAction:'incoming',inventorySource:source,parserProof:'source-defined-add-delta',quantitySemantics:'added-delta',inventoryBaseline:false,inventoryHistoryReliable:true}};}
function unresolved(event:ReplayEvent):ReplayEvent{return{...event,rawData:{...event.rawData,inventoryAction:'unverified',inventorySource:'unknown',parserProof:'excluded-unresolved-transfer',excludedReason:'unresolved-container-transfer',inventoryHistoryReliable:false}};}
function replay(events:ReplayEvent[],edge=1000,sequence=1):ParsedReplay{return{filename:'synthetic.rrf',format:'RRF',version:5,status:'partial',profile:'rrf-v5-latam',compatibility:'skadi-unverified',packetCount:sequence,unknownPackets:[],diagnostics:[],events,incremental:{delta:true,sequence,recordingStart:sequence===1,eventCount:events.length},summary:{...emptySummary(),startedAt:'2026-11-03T00:00:00Z',characterName:character.name,playerId:42,durationMs:edge}};}
function meta(dir:string,hash='first',observedAt='2026-11-03T01:00:00Z'){return{sourcePath:path.join(dir,'synthetic.rrf'),streamId:'audit-stream',recordingId:'audit-recording',hash,observedAt};}
async function legacyProfile(){
  const fixture=await profile();fixture.store.autoFarm.observe(replay([incoming(100)]),meta(fixture.dir),character);fixture.store.autoFarm.setPrice({itemId:501,unitPrice:100});
  fixture.store.financeCommand({type:'price.set',price:{itemId:501,itemName:'Eski fiyat',characterKey:null,npcPrice:null,marketPrice:25,buyCost:null,method:'market'}});
  close(fixture.store);
  edit(fixture.file,db=>{db.exec("DROP TABLE autofarm_correction_candidates;ALTER TABLE autofarm_receipts DROP COLUMN decoder_revision;DROP TABLE IF EXISTS solo_experience_calendar_awards;DROP TABLE IF EXISTS solo_experience_calendar_intervals;DROP TABLE IF EXISTS solo_experience_calendar_sessions;DELETE FROM expansion_migrations WHERE version>=12;DELETE FROM expansion_migrations WHERE version>=9;");db.prepare('INSERT INTO expansion_settings VALUES(?,?)').run('unchanged',JSON.stringify({favoriteIds:[501],sound:'preserved'}));});
  return{...fixture,store:undefined};
}
describe('versioned automatic farm receipt corrections',()=>{
  it.each([1,2])('preserves revision%d receipts when new weight proof is missing and never treats those legacy rows as new alerts',async revision=>{
    const{store,file,dir}=await profile();store.autoFarm.observe(replay([incoming(100)]),meta(dir),character);
    close(store);edit(file,db=>db.prepare('UPDATE autofarm_receipts SET decoder_revision=?').run(revision));
    const opened=open(file),before=inspect(file,db=>db.prepare('SELECT * FROM autofarm_receipts').all());
    const unproven=incoming(100);delete unproven.rawData!.inventoryWeightProof;
    opened.autoFarm.observe(replay([unproven],1600,2),meta(dir,'old-no-weight'),character);
    expect(opened.autoFarm.snapshot().totals.quantity).toBe(3);
    expect(opened.autoFarm.correctionPreview().candidates).toEqual([]);
    expect(opened.autoFarm.alertReceipts(character.key)).toEqual([]);
    expect(inspect(file,db=>db.prepare('SELECT * FROM autofarm_receipts').all())).toEqual(before);
  });
  it('migrates v8 receipts to legacy revision1 while preserving receipt fields, totals, prices and settings',async()=>{
    const{file}=await legacyProfile();
    const before=inspect(file,db=>({receipts:db.prepare('SELECT * FROM autofarm_receipts').all(),totals:db.prepare('SELECT * FROM autofarm_item_totals').all(),prices:db.prepare('SELECT * FROM autofarm_prices').all(),manualPrices:db.prepare('SELECT * FROM item_prices').all(),settings:db.prepare('SELECT * FROM expansion_settings').all()}));
    const store=open(file);expect(store.autoFarm.snapshot().totals).toMatchObject({quantity:3,estimatedValue:300});
    inspect(file,db=>{
      expect(db.prepare('SELECT MAX(version) version FROM expansion_migrations').get()?.version).toBe(13);
      expect(db.prepare('SELECT * FROM autofarm_receipts').all()).toEqual(before.receipts.map(row=>({...row,decoder_revision:1})));
      for(const[table,rows]of[['autofarm_item_totals',before.totals],['autofarm_prices',before.prices],['item_prices',before.manualPrices],['expansion_settings',before.settings]] as const)expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });
    expect(store.autoFarm.correctionPreview().candidates).toEqual([]);
    close(store);const reopened=open(file);expect(reopened.autoFarm.snapshot().totals.quantity).toBe(3);
  });
  it('keeps legacy receipt and total unchanged on reread or new storage proof and persists one correction candidate',async()=>{
    const{file,dir}=await legacyProfile(),store=open(file);
    const before=inspect(file,db=>db.prepare('SELECT * FROM autofarm_receipts').get());
    store.autoFarm.observe(replay([incoming(100)]),{...meta(dir,'reread'),bootstrap:true},character);
    expect(inspect(file,db=>db.prepare('SELECT decoder_revision FROM autofarm_receipts').get()?.decoder_revision)).toBe(1);
    const proof=incoming(100,3,'storage');proof.rawData={...proof.rawData,transferProof:'matching-container-delete',transferContainer:2};
    store.autoFarm.observe(replay([proof],1500,2),meta(dir,'proof'),character);
    store.autoFarm.observe(replay([proof],2000,3),meta(dir,'repeated-proof','2026-11-03T01:01:00Z'),character);
    expect(inspect(file,db=>db.prepare('SELECT * FROM autofarm_receipts').get())).toEqual(before);
    expect(store.autoFarm.snapshot().totals).toMatchObject({quantity:3,estimatedValue:300});
    const preview=store.autoFarm.correctionPreview();expect(preview).toMatchObject({decoderRevision:3,applied:false,priceBasis:'current-shared-prices',totals:{candidateCount:1,quantity:3,currentEstimatedValue:300}});
    expect(preview.candidates[0]).toMatchObject({originalDecoderRevision:1,proposedDecoderRevision:3,reason:'storage',quantity:3,proposedQuantityDelta:-3,currentUnitPrice:100,proposedCurrentValueDelta:-300,firstDetectedAt:'2026-11-03T01:00:00.000Z',lastDetectedAt:'2026-11-03T01:01:00.000Z',evidenceStatus:'proven-non-income',evidence:{sourcePath:meta(dir).sourcePath,streamId:'audit-stream',sourceHash:'repeated-proof',packetId:'0x0b41',transferProof:'matching-container-delete',transferContainer:2,eventTimestamp:100}});
    close(store);const reopened=open(file);expect(reopened.autoFarm.correctionPreview()).toEqual(preview);expect(reopened.autoFarm.snapshot().totals.quantity).toBe(3);
  });
  it('adds previously unrecorded catch-up income once as revision3 without upgrading legacy duplicates',async()=>{
    const{file,dir}=await legacyProfile(),store=open(file),events=[incoming(100),incoming(700,2)];
    store.autoFarm.observe(replay(events,1000),{...meta(dir,'catch-up'),bootstrap:true},character);
    store.autoFarm.observe(replay(events,1500,2),meta(dir,'repeat'),character);
    expect(store.autoFarm.snapshot().totals.quantity).toBe(5);
    expect(inspect(file,db=>db.prepare('SELECT event_ms,decoder_revision FROM autofarm_receipts ORDER BY event_ms').all())).toEqual([{event_ms:100,decoder_revision:1},{event_ms:700,decoder_revision:3}]);
    const revised=[incoming(100,3,'storage'),incoming(700,2,'storage')];
    store.autoFarm.observe(replay(revised,2000,3),meta(dir,'late-proof'),character);
    store.autoFarm.observe(replay(revised,2200,4),meta(dir,'repeat-late-proof'),character);
    expect(store.autoFarm.snapshot().totals.quantity).toBe(3);expect(store.autoFarm.correctionPreview().totals.candidateCount).toBe(1);
    close(store);const reopened=open(file);reopened.autoFarm.observe(replay(revised,2300),meta(dir,'after-restart'),character);expect(reopened.autoFarm.snapshot().totals.quantity).toBe(3);
  });
  it.each(['storage','unresolved'])('corrects a new revision3 receipt once when delayed %s evidence arrives',async(kind)=>{
    const{store,file,dir}=await profile(),event=incoming(100);store.autoFarm.observe(replay([event]),meta(dir),character);
    const proof=kind==='unresolved'?unresolved(event):incoming(100,3,'storage');
    store.autoFarm.observe(replay([proof],1500,2),meta(dir,'proof'),character);store.autoFarm.observe(replay([proof],2000,3),meta(dir,'repeat'),character);
    expect(store.autoFarm.snapshot().totals.quantity).toBe(0);expect(store.autoFarm.correctionPreview().candidates).toEqual([]);
    expect(inspect(file,db=>db.prepare('SELECT quantity,decoder_revision,excluded_reason FROM autofarm_receipts').get())).toEqual({quantity:3,decoder_revision:AUTOFARM_DECODER_REVISION,excluded_reason:kind==='unresolved'?'unresolved-container-transfer':'storage'});
    store.autoFarm.observe(replay([event],2300,4),meta(dir,'older-classification'),character);expect(store.autoFarm.snapshot().totals.quantity).toBe(0);
  });
  it('keeps a legacy unresolved transfer only as an explicitly uncertain proposal',async()=>{
    const{file,dir}=await legacyProfile(),store=open(file);store.autoFarm.observe(replay([unresolved(incoming(100))]),meta(dir,'unresolved'),character);
    expect(store.autoFarm.snapshot().totals.quantity).toBe(3);
    expect(store.autoFarm.correctionPreview().candidates[0]).toMatchObject({reason:'unresolved-container-transfer',evidenceStatus:'unresolved-transfer',evidenceNote:expect.stringContaining('kesin bir depo eşleşmesi değildir')});
  });
  it('does not create receipts for recognized transfers, then accepts normal drop income',async()=>{
    const{store,dir}=await profile();store.autoFarm.observe(replay([incoming(100,3,'storage'),unresolved(incoming(200,3))]),meta(dir),character);
    expect(store.autoFarm.snapshot().totals.quantity).toBe(0);store.autoFarm.observe(replay([incoming(1000,2)],1600,2),meta(dir,'normal-drop'),character);
    expect(store.autoFarm.snapshot().totals.quantity).toBe(2);expect(store.autoFarm.correctionPreview().candidates).toEqual([]);
  });
  it('keeps exclusion and quantity retraction atomic on SQL failure',async()=>{
    const{store,dir,file}=await profile();store.autoFarm.observe(replay([incoming(100)]),meta(dir),character);
    edit(file,db=>db.exec("CREATE TRIGGER audit_fail_reduction BEFORE UPDATE ON autofarm_item_totals BEGIN SELECT RAISE(ABORT,'blocked reduction');END;"));
    expect(()=>store.autoFarm.observe(replay([incoming(100,3,'storage')],1500,2),meta(dir,'proof'),character)).toThrow('blocked reduction');
    inspect(file,db=>{expect(db.prepare('SELECT excluded_reason FROM autofarm_receipts').get()?.excluded_reason).toBeNull();expect(db.prepare('SELECT quantity FROM autofarm_item_totals').get()?.quantity).toBe(3);});
    edit(file,db=>db.exec('DROP TRIGGER audit_fail_reduction'));
    store.autoFarm.observe(replay([incoming(100,3,'storage')],1600,3),meta(dir,'retry'),character);expect(store.autoFarm.snapshot().totals.quantity).toBe(0);
  });
  it('reads current prices without writing proposals and keeps missing prices distinct from true zero',async()=>{
    const{file,dir}=await legacyProfile(),store=open(file);store.autoFarm.observe(replay([incoming(100,3,'storage')]),meta(dir,'proof'),character);
    const saved=inspect(file,db=>db.prepare('SELECT * FROM autofarm_correction_candidates').all());
    store.autoFarm.setPrice({itemId:501,unitPrice:null});expect(store.autoFarm.correctionPreview()).toMatchObject({totals:{currentEstimatedValue:null,unpricedQuantity:3},candidates:[{currentUnitPrice:null,currentEstimatedValue:null,proposedCurrentValueDelta:null}]});
    store.autoFarm.setPrice({itemId:501,unitPrice:0});expect(store.autoFarm.correctionPreview()).toMatchObject({totals:{currentEstimatedValue:0,unpricedQuantity:0},candidates:[{currentUnitPrice:0,currentEstimatedValue:0,proposedCurrentValueDelta:0}]});
    expect(inspect(file,db=>db.prepare('SELECT * FROM autofarm_correction_candidates').all())).toEqual(saved);
    store.autoFarm.setPrice({itemId:501,unitPrice:200});expect(store.autoFarm.correctionPreview().candidates[0].currentEstimatedValue).toBe(600);expect(store.autoFarm.snapshot().totals.quantity).toBe(3);
  });
  it('exports JSON and readable proposals using the same preview while leaving the source database byte-identical',async()=>{
    const{file,dir}=await legacyProfile(),store=open(file);store.autoFarm.observe(replay([unresolved(incoming(100))]),meta(dir,'proof'),character);const expected=store.autoFarm.correctionPreview();close(store);
    const before=await readFile(file),out=path.join(dir,'export');
    execFileSync(process.execPath,['scripts/export-autofarm-corrections.mjs','--database',file,'--output-dir',out],{cwd:path.resolve('.'),encoding:'utf8'});
    const report=JSON.parse(await readFile(path.join(out,'autofarm-corrections.json'),'utf8'));const{databasePath,exportedAt,...preview}=report;
    expect(databasePath).toBe(file);expect(exportedAt).toEqual(expect.any(String));expect(preview).toEqual(expected);
    const text=await readFile(path.join(out,'autofarm-corrections.md'),'utf8');expect(text).toContain('Hiçbir öneri uygulanmadı');expect(text).toContain('kesin bir depo eşleşmesi değildir');expect(text).toContain('güncel ortak fiyat tahminidir');expect(await readFile(file)).toEqual(before);
    const rerun=spawnSync(process.execPath,['scripts/export-autofarm-corrections.mjs','--database',file,'--output-dir',out],{cwd:path.resolve('.'),encoding:'utf8'});expect(rerun.status).toBe(1);expect(await readFile(file)).toEqual(before);
  });
  it('refuses to migrate an old database or write outside the workspace and has no apply option',async()=>{
    const{file,dir}=await legacyProfile(),before=await readFile(file);
    const run=(extra:string[])=>spawnSync(process.execPath,['scripts/export-autofarm-corrections.mjs','--database',file,...extra],{cwd:path.resolve('.'),encoding:'utf8'});
    const oldSchema=run(['--output-dir',path.join(dir,'old-export')]);expect(oldSchema.status).toBe(1);expect(oldSchema.stderr).toContain('migration veya onarım uygulamaz');
    const outside=run(['--output-dir',path.resolve('..','autofarm-output-forbidden')]);expect(outside.status).toBe(1);expect(outside.stderr).toContain('çalışma alanının içinde');
    expect(run(['--output-dir',path.join(dir,'apply-export'),'--apply']).status).toBe(1);
    expect(await readFile(file)).toEqual(before);expect(inspect(file,db=>db.prepare('SELECT MAX(version) version FROM expansion_migrations').get()?.version)).toBe(8);
  });
});
