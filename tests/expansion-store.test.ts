import { afterEach,describe,expect,it } from 'vitest';
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExpansionStore,parseCatalogCsv,readCatalogPackage } from '../electron/expansion-store';
import { parseReplay } from '../src/parser';
import type {ReplayEvent} from '../src/parser/types';
import type { CatalogPackage } from '../src/shared/expansion';
const cleanup:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
async function folder(){await mkdir('.qa',{recursive:true});const dir=await mkdtemp(path.resolve('.qa/expansion-test-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function database(){const dir=await folder(),file=path.join(dir,'midgard-live.sqlite'),store=new ExpansionStore(file);cleanup.push(()=>store.close());return{dir,file,store};}
const packet=(version='1'):CatalogPackage=>({schemaVersion:1,source:{id:'user-pack',name:'Kendi izinli verim',url:'user:local',license:'Kullanıcı tarafından sağlandı; kişisel kullanım',version,updatedAt:'2026-11-01',permission:'user-provided'},records:[{kind:'item',id:'501',name:'Kırmızı İksir',npcSell:null},{kind:'item',id:'502',name:'Turuncu İksir',npcSell:25},{kind:'monster',id:'1002',name:'Test yaratığı',baseExp:1,jobExp:null},{kind:'map',id:'test_map',name:'Sınama haritası'},{kind:'skill',id:'1',name:'Sınama becerisi'},{kind:'drop',id:'1002:501',name:'Sınama ilişkisi',monsterId:1002,itemId:501,chance:null}]});
const incoming=(id:string,timestamp:number,itemId=501,amount=1,owner=123):ReplayEvent=>({id,eventType:'item-obtained',timestamp,itemId,amount,actorId:owner,confidence:'certain',rawData:{result:0,inventoryAction:'incoming',parserProof:'source-defined-add-delta',quantitySemantics:'added-delta',inventoryBaseline:false,inventorySource:'unknown',inventoryWeightProof:{kind:'own-weight-increase',ownerActorId:owner,before:60000,after:60010,receiptTimestamp:timestamp,weightTimestamp:timestamp+500,confirmedAt:timestamp+500,scope:'receipt-batch'}}});
describe('separate versioned expansion database',()=>{
  it('creates all expansion tables and official EXP provenance without changing the legacy archive',async()=>{
    const dir=await folder(),legacy=path.join(dir,'midgard-replay.sqlite');await writeFile(legacy,'DO NOT OPEN OR MIGRATE');const store=new ExpansionStore(path.join(dir,'midgard-live.sqlite'));cleanup.push(()=>store.close());
    const inspect=new DatabaseSync(store.filePath,{readOnly:true});try{const names=inspect.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name);expect(names).toEqual(expect.arrayContaining(['experience_requirements','character_exp_snapshots','character_exp_events','monster_database','item_database','item_prices','inventory_events','inventory_snapshots','farm_sessions','finance_transactions','finance_expenses','database_sources','database_versions','autofarm_correction_candidates']));expect(inspect.prepare('SELECT MAX(version) version FROM expansion_migrations').get()?.version).toBe(13);const row=inspect.prepare("SELECT * FROM experience_requirements WHERE track='second' AND level=51").get()!;expect(Number(row.required)).toBeGreaterThan(0);expect(row.source_url).toContain('roz.mygnjoy.com');expect(JSON.parse(String(row.data_json)).indexing).toBe('destination-level');}finally{inspect.close();}
    expect(await readFile(legacy,'utf8')).toBe('DO NOT OPEN OR MIGRATE');
  });
  it('imports Turkish catalog data with provenance, safe search and cursor pagination',async()=>{
    const{store}=await database();store.importCatalog(packet());expect(store.catalogOverview().counts.item).toBe(2);expect(store.searchCatalog({kind:'item',text:'kirmizi'}).rows[0]).toMatchObject({id:'501',npcSell:null,source:{license:packet().source.license,version:'1'}});
    const first=store.searchCatalog({kind:'item',limit:1});expect(first.nextCursor).not.toBeNull();expect(store.searchCatalog({kind:'item',limit:1,after:first.nextCursor!}).rows[0].id).toBe('502');expect(store.searchCatalog({text:"%' OR 1=1 --"}).rows).toEqual([]);
  });
  it('rolls back a conflicting source replacement atomically and preserves older versions',async()=>{
    const{store}=await database();store.importCatalog(packet());const broken=packet('2');broken.records=[{kind:'experience',id:'first',name:'A',track:'base',level:1,required:1},{kind:'experience',id:'second',name:'B',track:'base',level:1,required:2}];expect(()=>store.importCatalog(broken)).toThrow();expect(store.searchCatalog({kind:'item'}).rows).toHaveLength(2);expect(store.catalogOverview().sources.find(source=>source.id==='user-pack')?.version).toBe('1');
    const next=packet('2');next.records=[{kind:'item',id:'503',name:'Yeni eşya'}];store.importCatalog(next);expect(store.searchCatalog({kind:'item'}).rows.map(row=>row.id)).toEqual(['503']);expect(store.catalogOverview().versions).toBe(3);expect(()=>store.importCatalog({...next,records:[]})).toThrow('farklı içerikle');
  });
  it('reads bounded JSON and quoted CSV packages without losing declared permission',async()=>{
    const{dir,store}=await database(),file=path.join(dir,'catalog.json');await writeFile(file,JSON.stringify(packet()));store.importCatalog(await readCatalogPackage(file));
    const csv='sourceId,sourceName,sourceUrl,license,version,updatedAt,permission,kind,id,name,npcSell\ncustom,Özel,user:local,"Kişisel, izinli",1,2026-11-01,user-provided,item,999,"İksir ""özel""",null\n';const result=parseCatalogCsv(csv);expect(result.records[0]).toMatchObject({name:'İksir "özel"',npcSell:null});expect(result.source.license).toBe('Kişisel, izinli');expect(()=>parseCatalogCsv(csv+'"bad')).toThrow('tırnağı');
  });
  it('retains the financial ledger and its frozen acquisition price across reopen',async()=>{
    const dir=await folder(),file=path.join(dir,'midgard-live.sqlite');let store=new ExpansionStore(file);
    store.financeCommand({type:'price.set',price:{itemId:501,itemName:'İksir',characterKey:null,npcPrice:null,marketPrice:100,buyCost:null,method:'market'}});store.financeCommand({type:'session.start',characterKey:'char-a',characterName:'Işık'});const sessionId=store.financeState().sessions[0].id;
    store.financeCommand({type:'receipt.add',sessionId,itemId:501,itemName:'İksir',quantity:2,sourceKey:'observation-a'});store.financeCommand({type:'expense.add',sessionId,category:'travel',amount:5});const revision=store.financeState().revision;
    store.close();store=new ExpansionStore(file);cleanup.push(()=>store.close());expect(store.financeState().revision).toBe(revision);expect(store.financeState().events[0]).toMatchObject({kind:'receipt',price:{unitValue:100}});
    store.financeCommand({type:'receipt.add',sessionId,itemId:501,itemName:'İksir',quantity:2,sourceKey:'observation-a'});expect(store.financeState().revision).toBe(revision);
    store.financeCommand({type:'price.set',price:{itemId:501,itemName:'İksir',characterKey:null,npcPrice:null,marketPrice:200,buyCost:null,method:'market'}});expect(store.financeState().events[0]).toMatchObject({kind:'receipt',price:{unitValue:100}});
  });
  it('appends only new finance events and leaves unchanged prices and sessions unwritten',async()=>{
    const{file,store}=await database();store.financeCommand({type:'price.set',price:{itemId:501,itemName:'İksir',characterKey:null,npcPrice:null,marketPrice:100,buyCost:null,method:'market'}});store.financeCommand({type:'session.start',characterKey:'append-only',characterName:'Çevik'});const sessionId=store.financeState().sessions[0].id;
    for(let index=0;index<75;index++)store.financeCommand({type:'receipt.add',sessionId,itemId:501,itemName:'İksir',quantity:1});
    const inspect=new DatabaseSync(file);try{
      inspect.exec(`CREATE TABLE test_write_audit(kind TEXT NOT NULL);
        CREATE TRIGGER test_event_attempt BEFORE INSERT ON finance_transactions BEGIN INSERT INTO test_write_audit VALUES('event'); END;
        CREATE TRIGGER test_price_delete AFTER DELETE ON item_prices BEGIN INSERT INTO test_write_audit VALUES('price'); END;
        CREATE TRIGGER test_price_insert AFTER INSERT ON item_prices BEGIN INSERT INTO test_write_audit VALUES('price'); END;
        CREATE TRIGGER test_session_update AFTER UPDATE ON farm_sessions BEGIN INSERT INTO test_write_audit VALUES('session'); END;`);
      store.financeCommand({type:'receipt.add',sessionId,itemId:501,itemName:'İksir',quantity:1});store.financeCommand({type:'expense.add',sessionId,category:'travel',amount:5});
      expect(inspect.prepare('SELECT kind,COUNT(*) count FROM test_write_audit GROUP BY kind').all()).toEqual([{kind:'event',count:2}]);expect(inspect.prepare('SELECT COUNT(*) count FROM finance_transactions').get()?.count).toBe(77);
      store.financeCommand({type:'session.pause',sessionId});expect(inspect.prepare("SELECT COUNT(*) count FROM test_write_audit WHERE kind='session'").get()?.count).toBe(1);
    }finally{inspect.close();}
  });
  it('stores only new normalized EXP/inventory events, deduplicates replay copies and never makes automatic farm income',async()=>{
    const{dir,store}=await database(),bytes=await readFile(path.resolve('tests/fixtures/latam-mergulho-test.rrf')),parsed=parseReplay(Uint8Array.from(bytes).buffer,'source.rrf');parsed.summary.startedAt='2026-11-01T00:00:00Z';parsed.summary.playerId=123;parsed.summary.characterName='Işık';
    const character={key:'recorded:123:Işık',name:'Işık',source:'recorded' as const,playerId:123},meta={sourcePath:path.join(dir,'source.rrf'),hash:'first-hash',size:100,recordingId:'recording-a'};
    store.observeReplay(parsed,meta,character);expect(store.stats().expEvents).toBe(0);expect(store.inventoryInbox()).toEqual([]);
    const timestamp=Math.max(0,...parsed.events.map(event=>event.timestamp))+100;
    parsed.events.push({id:'exp-new',eventType:'exp-gain',timestamp,amount:50,expKind:'base',confidence:'certain'},incoming('item-new',timestamp,501,2));
    store.observeReplay(parsed,{...meta,hash:'second-hash'},character);store.observeReplay(parsed,{...meta,hash:'third-hash'},character);expect(store.stats().expEvents).toBe(1);expect(store.inventoryInbox()).toHaveLength(1);expect(store.inventoryInbox()[0]).toMatchObject({classification:'unclassified',amount:2,characterKey:character.key});expect(store.financeState().events).toHaveLength(0);
    const copy={...meta,sourcePath:path.join(dir,'copy.rrf'),hash:'copy-baseline'};store.observeReplay(parsed,copy,character);parsed.events.push(incoming('item-next',timestamp+100,502));store.observeReplay(parsed,{...meta,hash:'fourth-hash'},character);store.observeReplay(parsed,{...copy,hash:'copy-next'},character);expect(store.inventoryInbox()).toHaveLength(2);expect(store.financeState().events).toHaveLength(0);
  });
  it('keeps persistent same-timestamp cursors monotonic across temporarily missing tails and restart',async()=>{
    const dir=await folder(),file=path.join(dir,'midgard-live.sqlite'),bytes=await readFile(path.resolve('tests/fixtures/latam-mergulho-test.rrf')),parsed=parseReplay(Uint8Array.from(bytes).buffer,'source.rrf');
    parsed.summary.startedAt='2026-11-01T00:00:00Z';parsed.summary.playerId=44;parsed.summary.characterName='Bağımsız';parsed.events=[{id:'baseline',eventType:'exp-gain',timestamp:100,amount:1,expKind:'base',confidence:'certain'}];
    const character={key:'recorded:44:Bağımsız',name:'Bağımsız',source:'recorded' as const,playerId:44},meta={sourcePath:path.join(dir,'source.rrf'),hash:'baseline',size:100,recordingId:'cursor-test'};let store=new ExpansionStore(file);
    store.observeReplay(parsed,meta,character);const next={id:'tail',eventType:'exp-gain' as const,timestamp:200,amount:2,expKind:'base' as const,confidence:'certain' as const};parsed.events.push(next);store.observeReplay(parsed,{...meta,hash:'full'},character);expect(store.stats().expEvents).toBe(1);
    parsed.events.pop();store.observeReplay(parsed,{...meta,hash:'temporary-tail-missing'},character);parsed.events.push(next);store.observeReplay(parsed,{...meta,hash:'tail-restored'},character);expect(store.stats().expEvents).toBe(1);store.close();
    store=new ExpansionStore(file);cleanup.push(()=>store.close());store.observeReplay(parsed,{...meta,hash:'restarted'},character);expect(store.stats().expEvents).toBe(1);parsed.events.push({...next,id:'same-time-new',amount:3});store.observeReplay(parsed,{...meta,hash:'same-time-new'},character);expect(store.stats().expEvents).toBe(2);
  });
  it('requires an own-weight proof before placing any incoming observation in the inbox',async()=>{
    const{dir,store}=await database(),bytes=await readFile(path.resolve('tests/fixtures/latam-mergulho-test.rrf')),parsed=parseReplay(Uint8Array.from(bytes).buffer,'loot.rrf');
    parsed.events=[];parsed.summary.playerId=123;parsed.summary.startedAt='2026-11-01T00:00:00Z';
    const character={key:'recorded:123',name:'QA',source:'recorded' as const,playerId:123},meta={sourcePath:path.join(dir,'loot.rrf'),hash:'base',size:100,recordingId:'loot'};
    store.observeReplay(parsed,meta,character);
    const receipt=incoming('missing-weight',1000);
    parsed.events=[{...receipt,rawData:{...receipt.rawData,inventoryWeightProof:undefined}},
      {...incoming('pending',1001),eventType:'inventory-ack'},incoming('wrong-owner',1002,501,1,99),
      ...['trade','cart','storage','purchase','quest','refresh'].map((inventorySource,index)=>({...incoming(`transfer-${index}`,1100+index),rawData:{...incoming('',1100+index).rawData,inventorySource}})),
      {id:'unrelated-weight',eventType:'status',timestamp:1500,amount:65000,statusKey:'weight',confidence:'certain'}];
    store.observeReplay(parsed,{...meta,hash:'rejected'},character);expect(store.inventoryInbox()).toEqual([]);
    parsed.summary.playerId=null;parsed.events=[incoming('unknown-recording',2000)];store.observeReplay(parsed,{...meta,hash:'no-player'},character);expect(store.inventoryInbox()).toEqual([]);
    parsed.summary.playerId=123;parsed.events=[incoming('valid',3000,603,2)];store.observeReplay(parsed,{...meta,hash:'confirmed'},character);
    expect(store.inventoryInbox()).toEqual([expect.objectContaining({itemId:603,amount:2})]);expect(store.financeState().events).toEqual([]);
  });
  it.each([false,true])('deduplicates a delayed inventory revision without importing pending baseline history (delta=%s)',async delta=>{
    const{dir,store}=await database(),bytes=await readFile(path.resolve('tests/fixtures/latam-mergulho-test.rrf')),parsed=parseReplay(Uint8Array.from(bytes).buffer,'delayed.rrf');
    parsed.summary.playerId=123;parsed.summary.startedAt='2026-11-01T00:00:00Z';
    if(delta)parsed.incremental={delta:true,sequence:1,recordingStart:false,eventCount:1};
    const character={key:'recorded:123',name:'QA',source:'recorded' as const,playerId:123},meta={sourcePath:path.join(dir,'delayed.rrf'),hash:'initial',size:100,recordingId:'delayed'};
    parsed.events=[{...incoming('old',1000),eventType:'inventory-ack'}];store.observeReplay(parsed,meta,character);
    parsed.events=[incoming('old',1000)];store.observeReplay(parsed,{...meta,hash:'old-confirmed'},character);expect(store.inventoryInbox()).toEqual([]);
    parsed.events=[{...incoming('new',2000),eventType:'inventory-ack'},{id:'ahead',eventType:'exp-gain',timestamp:2200,amount:1,expKind:'base',confidence:'certain'}];
    store.observeReplay(parsed,{...meta,hash:'pending'},character);expect(store.inventoryInbox()).toEqual([]);
    parsed.events=[incoming('new',2000)];store.observeReplay(parsed,{...meta,hash:'new-confirmed'},character);store.observeReplay(parsed,{...meta,hash:'repeated-confirmation'},character);
    expect(store.inventoryInbox()).toEqual([expect.objectContaining({itemId:501,amount:1})]);
    parsed.events=[{...incoming('restart-pending',3000),eventType:'inventory-ack'}];store.observeReplay(parsed,{...meta,hash:'reset',recordingReset:true},character);
    parsed.events=[incoming('restart-pending',3000)];store.observeReplay(parsed,{...meta,hash:'reset-confirmed'},character);expect(store.inventoryInbox()).toHaveLength(1);
  });
  it('keeps three characters independent while processing repeated batches of normalized events',async()=>{
    const{dir,store}=await database(),bytes=await readFile(path.resolve('tests/fixtures/latam-mergulho-test.rrf'));
    for(let index=0;index<3;index++){
      const parsed=parseReplay(Uint8Array.from(bytes).buffer,`character-${index}.rrf`);parsed.summary.startedAt='2026-11-01T00:00:00Z';parsed.summary.playerId=index+1;parsed.summary.characterName=`Karakter ${index}`;parsed.events=[];
      const identity={key:`recorded:${index+1}`,name:`Karakter ${index}`,source:'recorded' as const,playerId:index+1},meta={sourcePath:path.join(dir,`${index}.rrf`),hash:`initial-${index}`,size:1000,recordingId:`session-${index}`};store.observeReplay(parsed,meta,identity);
      parsed.events=Array.from({length:500},(_,eventIndex)=>({id:String(eventIndex),eventType:'exp-gain' as const,timestamp:eventIndex,amount:1,expKind:'base' as const,confidence:'certain' as const}));store.observeReplay(parsed,{...meta,hash:`new-${index}`},identity);store.observeReplay(parsed,{...meta,hash:`repeated-${index}`},identity);
    }
    expect(store.stats().expEvents).toBe(1500);expect(store.financeState().events).toEqual([]);expect(store.inventoryInbox()).toEqual([]);
  });
});
