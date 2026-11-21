import { DatabaseSync } from 'node:sqlite';
import { createHash,randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import {closeSync, fsyncSync, openSync} from 'node:fs';
import path from 'node:path';
import type { ParsedReplay,ReplayEvent } from '../src/parser/types';
import {inventoryConfirmationTime,isVerifiedLootIncoming} from '../src/parser/inventory';
import type { CharacterIdentity } from '../src/shared/types';
import type { CatalogEntry,CatalogKind,CatalogOverview,CatalogPackage,CatalogPage,CatalogRecord,CatalogSearch,CatalogSource,InventoryObservation } from '../src/shared/expansion';
import { applyFinanceCommand,createFinanceState,type FinanceCommand,type FinanceState } from '../src/domain/finance';
import { EXPERIENCE_REQUIREMENTS,EXPERIENCE_DATASET_VERSION } from '../src/domain/experience-table';
import { AutoFarmStore } from './auto-farm-store';
import { KillCountStore } from './kill-count-store';
import { KillExperienceStore } from './kill-experience-store';
import { TargetHuntStore } from './target-hunt-store';
import { KillHistoryStore } from './kill-history-store';
import { KillDailyStore } from './kill-daily-store';
import {HUNT_ANALYTICS_SCHEMA, HuntAnalyticsIngest} from './hunt-analytics-ingest';
import {OWN_DAMAGE_HUNT_SCHEMA} from './own-damage-schemas';
import {ownDamageEventSql} from './own-damage-query';
import {FINANCE_DAILY_SCHEMA,FinanceDailyStore} from './finance-daily-store';
import {SOLO_EXPERIENCE_DAILY_SCHEMA,SoloExperienceDailyStore} from './solo-experience-daily-store';
import {CompactKillStore,CompactKillDailyStore} from './compact-kill-store';
import {CompactAutoFarmStore,CompactFinanceDailyStore} from './compact-farm-store';
import {SummaryTargetHuntStore,SummaryHuntAnalytics} from './summary-hunt';
import {migrateSummaryArchive,compactSummaryArchive} from './summary-migration';

const KINDS:CatalogKind[]=['item','monster','map','skill','drop','experience'];
const MAX_IMPORT_BYTES=16*1024*1024,MAX_IMPORT_RECORDS=50000;
const LICENSE_NOTICE='RO ZERO DATABASE ana sayfa ve iletişim sayfasında yeniden dağıtım lisansı doğrulanamadı; toplu içerik kopyalanmadı. Yalnızca kaynak ve kullanım izni belirtilen kullanıcı paketleri içe alınır.';
const fold=(text:string)=>text.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i');
const obj=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function text(value:unknown,label:string,max=200):string{if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw new Error(`${label} geçerli bir metin olmalıdır.`);return value.trim().normalize('NFC');}
function amount(value:unknown,label:string,maximum=Number.MAX_SAFE_INTEGER):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>maximum)throw new Error(`${label} sıfır veya pozitif güvenli tam sayı olmalıdır.`);return value;}
function date(value:unknown,label:string):string{const result=text(value,label,40);if(!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(result)||!Number.isFinite(Date.parse(result)))throw new Error(`${label} geçerli bir ISO tarih olmalıdır.`);return result;}
function validateSource(value:unknown):CatalogSource{
  if(!obj(value)||Object.keys(value).some(key=>!['id','name','url','license','version','updatedAt','permission'].includes(key)))throw new Error('Kaynak alanları geçersiz.');
  const id=text(value.id,'Kaynak kimliği',80);if(!/^[a-zA-Z0-9_.-]+$/.test(id))throw new Error('Kaynak kimliği yalnızca harf, sayı, nokta, alt çizgi ve tire içerebilir.');
  const url=text(value.url,'Kaynak adresi',2000);if(!/^https?:\/\//i.test(url)&&!url.startsWith('user:'))throw new Error('Kaynak adresi HTTP(S) veya user: olmalıdır.');
  if(!['user-provided','redistributable','official-facts'].includes(String(value.permission)))throw new Error('Veri kullanım izni belirtilmelidir.');
  return{id,name:text(value.name,'Kaynak adı'),url,license:text(value.license,'Lisans / kullanım izni',1000),version:text(value.version,'Kaynak sürümü',100),updatedAt:date(value.updatedAt,'Güncelleme tarihi'),permission:value.permission as CatalogSource['permission']};
}
export function validateCatalogPackage(value:unknown):CatalogPackage{
  if(!obj(value)||value.schemaVersion!==1||Object.keys(value).some(key=>!['schemaVersion','source','records'].includes(key))||!Array.isArray(value.records)||value.records.length>MAX_IMPORT_RECORDS)throw new Error('Katalog paketi schemaVersion:1, source ve en fazla 50.000 records içermelidir.');
  const source=validateSource(value.source),seen=new Set<string>();
  const records=value.records.map(raw=>{
    if(!obj(raw)||Object.keys(raw).some(key=>!['kind','id','name','category','baseExp','jobExp','npcSell','monsterId','itemId','chance','level','track','required'].includes(key))||!KINDS.includes(raw.kind as CatalogKind))throw new Error('Katalog satırı alanları geçersiz.');
    const row:CatalogRecord={kind:raw.kind as CatalogKind,id:text(String(raw.id??''),'Kayıt kimliği',100),name:text(raw.name,'Kayıt adı',300)};
    if(['item','monster','skill'].includes(row.kind)&&(!/^\d+$/.test(row.id)||Number(row.id)<1||Number(row.id)>0xffffffff))throw new Error('Item, monster ve skill kimlikleri pozitif 32 bit sayı olmalıdır.');
    if(row.kind==='map'&&!/^[a-z0-9_@.-]{1,100}$/i.test(row.id))throw new Error('Harita kimliği geçersiz.');
    if(raw.category!==undefined)row.category=text(raw.category,'Kategori',80);
    for(const key of ['baseExp','jobExp','npcSell','required'] as const)if(raw[key]!==undefined)row[key]=raw[key]===null?null:amount(raw[key],key);
    for(const key of ['monsterId','itemId'] as const)if(raw[key]!==undefined){row[key]=amount(raw[key],key,0xffffffff);if(!row[key])throw new Error(`${key} pozitif olmalıdır.`);}
    if(raw.chance!==undefined){if(raw.chance!==null&&(typeof raw.chance!=='number'||!Number.isFinite(raw.chance)||raw.chance<0||raw.chance>1))throw new Error('Drop olasılığı 0–1 aralığında veya null olmalıdır.');row.chance=raw.chance as number|null;}
    if(raw.level!==undefined){row.level=amount(raw.level,'Seviye',1000);if(row.level<1)throw new Error('Seviye pozitif olmalıdır.');}
    if(raw.track!==undefined){if(!['base','novice','first','second'].includes(String(raw.track)))throw new Error('EXP sınıfı geçersiz.');row.track=raw.track as CatalogRecord['track'];}
    if(row.kind==='drop'&&(!row.monsterId||!row.itemId))throw new Error('Drop ilişkisi monsterId ve itemId gerektirir.');
    if(row.kind==='experience'&&(!row.level||!row.track||row.required===undefined))throw new Error('EXP satırı level, track ve required gerektirir.');
    const key=`${row.kind}:${row.id}`;if(seen.has(key))throw new Error(`Pakette yinelenen kayıt: ${key}`);seen.add(key);return row;
  });return{schemaVersion:1,source,records};
}

/** A quoted CSV reader with bounded input. Newlines in quotes and doubled quotes are supported. */
export function parseCatalogCsv(source:string):CatalogPackage{
  const rows:string[][]=[];let row:string[]=[],field='',quoted=false,closed=false;
  for(let index=0;index<=source.length;index++){
    const ch=source[index];if(quoted){if(ch==='"'&&source[index+1]==='"'){field+='"';index++;}else if(ch==='"'){quoted=false;closed=true;}else if(ch===undefined)throw new Error('CSV tırnağı kapanmamış.');else field+=ch;continue;}
    if(ch==='"'){if(field||closed)throw new Error('CSV tırnak konumu geçersiz.');quoted=true;continue;}
    if(ch===','||ch==='\n'||ch===undefined){row.push(field);field='';closed=false;if(ch!==','){if(row.some(value=>value.trim()))rows.push(row);row=[];if(rows.length>MAX_IMPORT_RECORDS+1)throw new Error('CSV satır sınırı aşıldı.');}continue;}
    if(ch==='\r'&&(source[index+1]==='\n'||index===source.length-1))continue;
    if(closed)throw new Error('CSV tırnağından sonra ayraç bekleniyor.');field+=ch;
  }
  if(rows.length<2)throw new Error('CSV başlık ve veri satırı içermelidir.');
  const headers=rows.shift()!.map(value=>value.trim()),allowed=['sourceId','sourceName','sourceUrl','license','version','updatedAt','permission','kind','id','name','category','baseExp','jobExp','npcSell','monsterId','itemId','chance','level','track','required'];
  if(new Set(headers).size!==headers.length||headers.some(key=>!allowed.includes(key)))throw new Error('CSV başlıkları geçersiz veya yinelenmiş.');
  const values=rows.map(columns=>{if(columns.length!==headers.length)throw new Error('CSV sütun sayısı uyuşmuyor.');return Object.fromEntries(headers.map((key,index)=>[key,columns[index]]));});
  const first=values[0],metadata=['sourceId','sourceName','sourceUrl','license','version','updatedAt','permission'];if(values.some(value=>metadata.some(key=>value[key]!==first[key])))throw new Error('CSV tek bir kaynak/sürüm içermelidir.');
  const records=values.map(value=>{const record:Record<string,unknown>={};for(const key of headers.filter(key=>!metadata.includes(key))){const input=value[key];if(!input.trim()&&!['kind','id','name'].includes(key))continue;record[key]=['baseExp','jobExp','npcSell','monsterId','itemId','chance','level','required'].includes(key)?input==='null'?null:Number(input):input;}return record;});
  return validateCatalogPackage({schemaVersion:1,source:{id:first.sourceId,name:first.sourceName,url:first.sourceUrl,license:first.license,version:first.version,updatedAt:first.updatedAt,permission:first.permission},records});
}
export async function readCatalogPackage(file:string):Promise<CatalogPackage>{
  const extension=path.extname(file).toLowerCase();if(!['.json','.csv'].includes(extension))throw new Error('JSON veya CSV veri paketi seçin.');
  const handle=await open(file,'r');try{const before=await handle.stat();if(!before.isFile()||before.size>MAX_IMPORT_BYTES)throw new Error('Veri paketi 16 MiB sınırını aşmamalıdır.');const bytes=Buffer.alloc(before.size);let position=0;while(position<bytes.length){const result=await handle.read(bytes,position,bytes.length-position,position);if(!result.bytesRead)break;position+=result.bytesRead;}const after=await handle.stat();if(position!==bytes.length||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('Veri paketi okunurken değişti.');const content=bytes.toString('utf8').replace(/^\uFEFF/,'');return extension==='.json'?validateCatalogPackage(JSON.parse(content)):parseCatalogCsv(content);}finally{await handle.close();}
}

interface Cursor {recording_id:string;watermark:number;counts_json:string;}
export interface ReplayExpansionMeta {sourcePath:string;hash:string;size:number;recordingId:string;recordingReset?:boolean;observedAt?:string;includeExperience?:boolean;initial?:boolean;}
export class ExpansionStore {
  private db:DatabaseSync;
  private financeCache:FinanceState;
  private lastSnapshots=new Map<string,string>();
  private lastExpValues=new Map<string,string>();
  private overviewCache:CatalogOverview|undefined;
  readonly autoFarm:AutoFarmStore|CompactAutoFarmStore;
  readonly killCount:KillCountStore|CompactKillStore;
  readonly killExperience:KillExperienceStore;
  readonly targetHunt:TargetHuntStore|SummaryTargetHuntStore;
  readonly killHistory:KillHistoryStore;
  readonly killDaily:KillDailyStore|CompactKillDailyStore;
  readonly financeDaily:FinanceDailyStore|CompactFinanceDailyStore;
  readonly soloExperienceDaily:SoloExperienceDailyStore;
  readonly huntAnalytics:HuntAnalyticsIngest|SummaryHuntAnalytics;
  analyticsMigrationBackupPath:string|null=null;
  financeMigrationBackupPath:string|null=null;
  soloExperienceMigrationBackupPath:string|null=null;
  ownDamageMigrationBackupPath:string|null=null;
  get summaryOnly():boolean{return this.options.summaryOnly===true;}
  constructor(public readonly filePath:string,private options:{killExperienceSoloOnly?:boolean;ownDamageOnly?:boolean;lightweightHistory?:boolean;summaryOnly?:boolean;onStartupProgress?:(message:string)=>void}={}){
    this.db=new DatabaseSync(filePath);try{
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');this.migrate();
      this.financeCache=this.loadFinance();this.seedExperience();
      this.autoFarm=this.summaryOnly?new CompactAutoFarmStore(this.db):new AutoFarmStore(this.db);
      this.killCount=this.summaryOnly?new CompactKillStore(this.db):new KillCountStore(this.db,{ownDamageOnly:options.ownDamageOnly===true});
      this.killExperience=new KillExperienceStore(this.db,{soloOnly:options.killExperienceSoloOnly===true||this.summaryOnly,summaryOnly:this.summaryOnly});
      this.targetHunt=this.summaryOnly?new SummaryTargetHuntStore(()=>this.killCount.snapshot()):new TargetHuntStore(this.db,{ownDamageOnly:options.ownDamageOnly===true});
      this.killHistory=new KillHistoryStore(this.db,{ownDamageOnly:options.ownDamageOnly===true||this.summaryOnly});
      this.killDaily=this.summaryOnly?new CompactKillDailyStore(this.db):new KillDailyStore(this.db,{ownDamageOnly:options.ownDamageOnly===true});
      this.financeDaily=this.summaryOnly?new CompactFinanceDailyStore(this.db):new FinanceDailyStore(this.db);
      this.soloExperienceDaily=new SoloExperienceDailyStore(this.db,{summaryOnly:this.summaryOnly});
      this.huntAnalytics=this.summaryOnly?new SummaryHuntAnalytics():new HuntAnalyticsIngest(this.db,{ownDamageOnly:options.ownDamageOnly===true,lightweightHistory:options.lightweightHistory===true});
    }catch(error){this.db.close();throw error;}
  }
  private migrate():void{
    this.db.exec('CREATE TABLE IF NOT EXISTS expansion_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
    const current=this.db.prepare('SELECT MAX(version) version FROM expansion_migrations').get() as {version:number|null};if((current.version??0)>14)throw new Error('Veritabanı bu uygulamadan daha yeni bir sürüme ait; dosyada değişiklik yapılmadı.');
    if(current.version===14)this.options.summaryOnly=true;
    if(current.version!==null&&current.version<13&&this.filePath!==':memory:'){
      this.options.onStartupProgress?.('Önceki kayıt sürümü için güvenli geçiş hazırlanıyor…');
      const destination=`${this.filePath}.before-${current.version<10?'hunt-analytics':current.version<11?'finance-daily':current.version<12?'solo-experience-daily':'own-damage'}-${Date.now()}-${randomUUID()}.sqlite`;
      // SQLite snapshots the live connection, including committed WAL pages.
      this.db.prepare('VACUUM INTO ?').run(destination);
      const fd=openSync(destination,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}
      const backup=new DatabaseSync(destination,{readOnly:true});try{
        if(backup.prepare('PRAGMA quick_check').get()?.quick_check!=='ok'||backup.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Veritabanı geçişi için oluşturulan yedek doğrulanamadı; geçiş uygulanmadı.');
      }finally{backup.close();}
      if(current.version<10)this.analyticsMigrationBackupPath=destination;
      if(current.version<11)this.financeMigrationBackupPath=destination;
      this.soloExperienceMigrationBackupPath=destination;
      this.ownDamageMigrationBackupPath=destination;
    }
    if((current.version??0)<1)this.transaction(()=>{this.db.exec(`
      CREATE TABLE database_sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,license TEXT NOT NULL,version TEXT NOT NULL,updated_at TEXT NOT NULL,permission TEXT NOT NULL);
      CREATE TABLE database_versions(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES database_sources(id),version TEXT NOT NULL,checksum TEXT NOT NULL,imported_at TEXT NOT NULL,record_count INTEGER NOT NULL,source_json TEXT NOT NULL,UNIQUE(source_id,version));
      CREATE TABLE catalog_records(source_id TEXT NOT NULL REFERENCES database_sources(id),kind TEXT NOT NULL,record_id TEXT NOT NULL,name TEXT NOT NULL,search_text TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(source_id,kind,record_id));
      CREATE INDEX catalog_search ON catalog_records(kind,record_id,source_id);
      CREATE TABLE item_database(source_id TEXT NOT NULL REFERENCES database_sources(id),item_id INTEGER NOT NULL,name TEXT NOT NULL,category TEXT,npc_sell INTEGER,data_json TEXT NOT NULL,PRIMARY KEY(source_id,item_id));
      CREATE TABLE monster_database(source_id TEXT NOT NULL REFERENCES database_sources(id),monster_id INTEGER NOT NULL,name TEXT NOT NULL,base_exp INTEGER,job_exp INTEGER,data_json TEXT NOT NULL,PRIMARY KEY(source_id,monster_id));
      CREATE TABLE map_database(source_id TEXT NOT NULL REFERENCES database_sources(id),map_id TEXT NOT NULL,name TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(source_id,map_id));
      CREATE TABLE skill_database(source_id TEXT NOT NULL REFERENCES database_sources(id),skill_id INTEGER NOT NULL,name TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(source_id,skill_id));
      CREATE TABLE monster_item_drops(source_id TEXT NOT NULL REFERENCES database_sources(id),relation_id TEXT NOT NULL,monster_id INTEGER NOT NULL,item_id INTEGER NOT NULL,chance REAL,data_json TEXT NOT NULL,PRIMARY KEY(source_id,relation_id));
      CREATE TABLE experience_requirements(source_id TEXT NOT NULL REFERENCES database_sources(id),track TEXT NOT NULL,level INTEGER NOT NULL,required INTEGER,source_url TEXT NOT NULL,verified_at TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(source_id,track,level));
      CREATE TABLE item_prices(id TEXT PRIMARY KEY,data_json TEXT NOT NULL);
      CREATE TABLE farm_sessions(id TEXT PRIMARY KEY,character_key TEXT NOT NULL,data_json TEXT NOT NULL);
      CREATE TABLE finance_transactions(id TEXT PRIMARY KEY,kind TEXT NOT NULL,source_key TEXT UNIQUE,data_json TEXT NOT NULL);
      CREATE TABLE finance_expenses(id TEXT PRIMARY KEY,data_json TEXT NOT NULL);
      CREATE TABLE finance_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE expansion_settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL);
      CREATE TABLE replay_observations(hash TEXT PRIMARY KEY,source_key TEXT NOT NULL,recording_id TEXT NOT NULL,size INTEGER NOT NULL,observed_at TEXT NOT NULL);
      CREATE TABLE replay_cursors(source_key TEXT PRIMARY KEY,recording_id TEXT NOT NULL,watermark REAL NOT NULL,counts_json TEXT NOT NULL);
      CREATE TABLE character_exp_snapshots(id TEXT PRIMARY KEY,character_key TEXT NOT NULL,source_hash TEXT NOT NULL REFERENCES replay_observations(hash),observed_at TEXT NOT NULL,telemetry_json TEXT NOT NULL,UNIQUE(character_key,source_hash));
      CREATE TABLE character_exp_events(id TEXT PRIMARY KEY,character_key TEXT NOT NULL,source_hash TEXT NOT NULL REFERENCES replay_observations(hash),recording_key TEXT NOT NULL,timestamp_ms REAL NOT NULL,kind TEXT NOT NULL,amount INTEGER NOT NULL,observed_at TEXT NOT NULL,confidence TEXT NOT NULL);
      CREATE TABLE inventory_events(id TEXT PRIMARY KEY,character_key TEXT NOT NULL,character_name TEXT NOT NULL,source_hash TEXT NOT NULL REFERENCES replay_observations(hash),item_id INTEGER NOT NULL,amount INTEGER NOT NULL,direction TEXT NOT NULL,classification TEXT NOT NULL,timestamp_ms REAL NOT NULL,observed_at TEXT NOT NULL,confidence TEXT NOT NULL);
      CREATE TABLE inventory_snapshots(id TEXT PRIMARY KEY,character_key TEXT NOT NULL,observed_at TEXT NOT NULL,data_json TEXT NOT NULL);
      CREATE INDEX exp_events_character_time ON character_exp_events(character_key,observed_at);
      CREATE INDEX inventory_events_character_time ON inventory_events(character_key,observed_at);
      CREATE INDEX inventory_inbox_time ON inventory_events(classification,observed_at DESC);
      INSERT INTO expansion_migrations VALUES(1,datetime('now'));
    `);});
    if((current.version??0)<2)this.transaction(()=>{this.db.exec(`
      CREATE TABLE autofarm_sessions(id TEXT PRIMARY KEY,character_key TEXT NOT NULL,character_name TEXT NOT NULL,recording_key TEXT NOT NULL,time_basis TEXT NOT NULL,status TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE autofarm_intervals(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES autofarm_sessions(id),source_key TEXT NOT NULL,start_ms REAL NOT NULL,end_ms REAL NOT NULL);
      CREATE TABLE autofarm_receipts(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES autofarm_sessions(id),character_key TEXT NOT NULL,item_id INTEGER NOT NULL,quantity INTEGER NOT NULL,event_ms REAL NOT NULL,recorded_at TEXT NOT NULL,source_hash TEXT NOT NULL,inventory_source TEXT NOT NULL,confidence TEXT NOT NULL,item_name TEXT);
      CREATE TABLE autofarm_prices(item_id INTEGER PRIMARY KEY,unit_price REAL,updated_at TEXT NOT NULL);
      CREATE TABLE autofarm_cursors(source_key TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES autofarm_sessions(id),recording_key TEXT NOT NULL,last_replay_ms REAL NOT NULL);
      CREATE TABLE autofarm_item_totals(character_key TEXT NOT NULL,item_id INTEGER NOT NULL,quantity INTEGER NOT NULL,item_name TEXT,PRIMARY KEY(character_key,item_id));
      CREATE INDEX autofarm_receipt_items ON autofarm_receipts(character_key,item_id);
      CREATE INDEX autofarm_receipt_recent ON autofarm_receipts(character_key,recorded_at DESC);
      CREATE INDEX autofarm_session_identity ON autofarm_sessions(character_key,recording_key);
      CREATE INDEX catalog_item_lookup ON item_database(item_id);
      INSERT INTO expansion_migrations VALUES(2,datetime('now'));
    `);
      // Only shared prices migrate. Legacy quantities, unclassified observations and manual
      // transactions are preserved in their original tables, never recast as automatic loot.
      const insert=this.db.prepare('INSERT OR IGNORE INTO autofarm_prices VALUES(?,?,?)');
      for(const row of this.db.prepare('SELECT data_json FROM item_prices ORDER BY rowid').all()){const price=JSON.parse(String(row.data_json));if(price.characterKey===null&&Number.isSafeInteger(price.itemId)&&price.itemId>0){const value=price.method==='npc'?price.npcPrice:price.marketPrice;if(value===null||typeof value==='number'&&Number.isFinite(value)&&value>=0)insert.run(price.itemId,value,price.updatedAt);}}
    });
    if((current.version??0)<3)this.transaction(()=>{this.db.exec(`
      ALTER TABLE autofarm_cursors ADD COLUMN monitor_start_ms REAL;
      ALTER TABLE autofarm_cursors ADD COLUMN baseline_counts_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE autofarm_cursors ADD COLUMN anchor_ms REAL;
      ALTER TABLE autofarm_cursors ADD COLUMN history_mode INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE autofarm_receipts ADD COLUMN excluded_reason TEXT;
      UPDATE autofarm_cursors SET monitor_start_ms=last_replay_ms;
      INSERT INTO expansion_migrations VALUES(3,datetime('now'));
    `);});
    if((current.version??0)<4)this.transaction(()=>{this.db.exec(`
      CREATE TABLE kill_count_sessions(id TEXT PRIMARY KEY,character_key TEXT NOT NULL,character_name TEXT NOT NULL,recording_key TEXT NOT NULL UNIQUE,time_basis TEXT NOT NULL,anchor_ms REAL NOT NULL,status TEXT NOT NULL,updated_at TEXT NOT NULL,identity_source TEXT NOT NULL);
      CREATE TABLE kill_count_intervals(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES kill_count_sessions(id),source_key TEXT NOT NULL,start_ms REAL NOT NULL,end_ms REAL NOT NULL);
      CREATE TABLE kill_count_events(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES kill_count_sessions(id),character_key TEXT NOT NULL,recording_key TEXT NOT NULL,monster_id INTEGER NOT NULL,target_id INTEGER NOT NULL,lifecycle_id TEXT NOT NULL,event_ms REAL NOT NULL,personal INTEGER NOT NULL,observed_at TEXT NOT NULL,source_hash TEXT NOT NULL,monster_name TEXT,proof_json TEXT NOT NULL,UNIQUE(recording_key,target_id,lifecycle_id));
      CREATE TABLE kill_count_totals(recording_key TEXT NOT NULL,character_key TEXT NOT NULL,monster_id INTEGER NOT NULL,personal INTEGER NOT NULL,observed INTEGER NOT NULL,unknown INTEGER NOT NULL,last_killed_ms REAL NOT NULL,monster_name TEXT,PRIMARY KEY(recording_key,monster_id));
      CREATE INDEX kill_count_character_monsters ON kill_count_totals(character_key,monster_id);
      CREATE INDEX kill_count_events_session_time ON kill_count_events(session_id,event_ms);
      CREATE INDEX catalog_monster_lookup ON monster_database(monster_id);
      INSERT INTO expansion_migrations VALUES(4,datetime('now'));
    `);});
    if((current.version??0)<5)this.transaction(()=>{this.db.exec(`
      CREATE TABLE IF NOT EXISTS kill_experience_rates(character_key TEXT NOT NULL,monster_id INTEGER NOT NULL,base_exp INTEGER,job_exp INTEGER,updated_at TEXT NOT NULL,PRIMARY KEY(character_key,monster_id));
      CREATE TABLE IF NOT EXISTS kill_experience_sessions(id TEXT PRIMARY KEY,character_key TEXT NOT NULL,data_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS kill_experience_character_sessions ON kill_experience_sessions(character_key);
      CREATE TABLE IF NOT EXISTS kill_experience_awards(session_id TEXT NOT NULL REFERENCES kill_experience_sessions(id),event_key TEXT NOT NULL,monster_id INTEGER NOT NULL,base_exp INTEGER,job_exp INTEGER,PRIMARY KEY(session_id,event_key));
      INSERT INTO expansion_migrations VALUES(5,datetime('now'));
    `);});
    if((current.version??0)<6)this.transaction(()=>{this.db.exec(`
      CREATE TABLE IF NOT EXISTS kill_experience_penalties(character_key TEXT PRIMARY KEY,percent INTEGER NOT NULL CHECK(percent IN (0,5,10)),updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kill_experience_losses(session_id TEXT NOT NULL REFERENCES kill_experience_sessions(id),event_key TEXT NOT NULL,percent INTEGER NOT NULL CHECK(percent IN (0,5,10)),base_loss INTEGER,job_loss INTEGER,PRIMARY KEY(session_id,event_key));
      INSERT INTO expansion_migrations VALUES(6,datetime('now'));
    `);});
    if((current.version??0)<7)this.transaction(()=>{this.db.exec(`
      CREATE TABLE IF NOT EXISTS kill_experience_groups(id TEXT PRIMARY KEY,data_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kill_experience_group_candidates(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES kill_experience_groups(id),map_id TEXT,target_id INTEGER NOT NULL,monster_id INTEGER NOT NULL,clock_ms REAL);
      CREATE INDEX IF NOT EXISTS kill_experience_candidate_match ON kill_experience_group_candidates(group_id,map_id,target_id,monster_id,clock_ms);
      CREATE TABLE IF NOT EXISTS kill_experience_group_observations(group_id TEXT NOT NULL REFERENCES kill_experience_groups(id),source_key TEXT NOT NULL,event_key TEXT NOT NULL,candidate_id TEXT NOT NULL REFERENCES kill_experience_group_candidates(id),event_ms REAL NOT NULL,PRIMARY KEY(group_id,source_key,event_key),UNIQUE(group_id,candidate_id,source_key));
      CREATE TABLE IF NOT EXISTS kill_experience_group_intervals(id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES kill_experience_groups(id),source_key TEXT NOT NULL,start_ms REAL NOT NULL,end_ms REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS kill_experience_group_time ON kill_experience_group_intervals(group_id);
      INSERT INTO expansion_migrations VALUES(7,datetime('now'));
    `);});
    if((current.version??0)<8)this.transaction(()=>{this.db.exec(`
      CREATE TABLE IF NOT EXISTS target_hunt_metadata(key TEXT PRIMARY KEY,value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS target_hunt_sources(source_key TEXT NOT NULL,recording_key TEXT NOT NULL,frontier_ms REAL NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(source_key,recording_key));
      CREATE TABLE IF NOT EXISTS target_hunt_candidates(id TEXT PRIMARY KEY,monster_id INTEGER NOT NULL,monster_name TEXT,map_id TEXT,target_id INTEGER NOT NULL,clock_ms REAL,event_ms REAL NOT NULL,time_basis TEXT NOT NULL,segment_id TEXT NOT NULL,source_key TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS target_hunt_matching ON target_hunt_candidates(map_id,target_id,monster_id,clock_ms);
      CREATE INDEX IF NOT EXISTS target_hunt_chronology ON target_hunt_candidates(monster_id,time_basis,clock_ms,event_ms);
      CREATE TABLE IF NOT EXISTS target_hunt_observations(source_key TEXT NOT NULL,recording_key TEXT NOT NULL,event_key TEXT NOT NULL,candidate_id TEXT NOT NULL REFERENCES target_hunt_candidates(id),event_ms REAL NOT NULL,PRIMARY KEY(source_key,recording_key,event_key),UNIQUE(candidate_id,source_key));
      CREATE TABLE IF NOT EXISTS target_hunt_intervals(id TEXT PRIMARY KEY,segment_id TEXT NOT NULL,source_key TEXT NOT NULL,start_ms REAL NOT NULL,end_ms REAL NOT NULL);
      INSERT INTO expansion_migrations VALUES(8,datetime('now'));
    `);});
    if((current.version??0)<9)this.transaction(()=>{
      if(!this.db.prepare('PRAGMA table_info(autofarm_receipts)').all().some(row=>row.name==='decoder_revision'))this.db.exec('ALTER TABLE autofarm_receipts ADD COLUMN decoder_revision INTEGER NOT NULL DEFAULT 1');
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS autofarm_correction_candidates(
        receipt_id TEXT PRIMARY KEY REFERENCES autofarm_receipts(id),reason TEXT NOT NULL,
        first_detected_at TEXT NOT NULL,last_detected_at TEXT NOT NULL,
        decoder_revision INTEGER NOT NULL,evidence_json TEXT NOT NULL
      );
      INSERT INTO expansion_migrations VALUES(9,datetime('now'));
    `);});
    if((current.version??0)<10)this.transaction(()=>{this.db.exec(HUNT_ANALYTICS_SCHEMA);this.db.prepare("INSERT INTO expansion_migrations VALUES(10,datetime('now'))").run();});
    if((current.version??0)<11)this.transaction(()=>{this.db.exec(FINANCE_DAILY_SCHEMA);this.db.prepare("INSERT INTO expansion_migrations VALUES(11,datetime('now'))").run();});
    if((current.version??0)<12)this.transaction(()=>{this.db.exec(SOLO_EXPERIENCE_DAILY_SCHEMA);this.db.prepare("INSERT INTO expansion_migrations VALUES(12,datetime('now'))").run();});
    if((current.version??0)<13)this.transaction(()=>{
      this.db.exec(OWN_DAMAGE_HUNT_SCHEMA);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS kill_own_damage_totals(recording_key TEXT NOT NULL,character_key TEXT NOT NULL,monster_id INTEGER NOT NULL,personal INTEGER NOT NULL,observed INTEGER NOT NULL,unknown INTEGER NOT NULL,last_killed_ms REAL NOT NULL,monster_name TEXT,PRIMARY KEY(recording_key,monster_id));
        CREATE INDEX IF NOT EXISTS kill_own_damage_character_monsters ON kill_own_damage_totals(character_key,monster_id);
        INSERT OR IGNORE INTO kill_own_damage_totals
          SELECT e.recording_key,s.character_key,e.monster_id,0,COUNT(*),COUNT(*),MAX(s.anchor_ms+e.event_ms),MAX(e.monster_name)
          FROM kill_count_events e JOIN kill_count_sessions s ON s.id=e.session_id
          WHERE ${ownDamageEventSql('e')} GROUP BY e.recording_key,e.monster_id;
        INSERT INTO expansion_migrations VALUES(13,datetime('now'));
      `);
    });
    // Query accelerators do not change stored observations.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS target_hunt_observation_time ON target_hunt_observations(source_key,recording_key,event_ms);
      CREATE INDEX IF NOT EXISTS kill_count_replay_death ON kill_count_events(recording_key,target_id,event_ms,monster_id);
    `);
    if(this.summaryOnly){
      if((current.version??0)<14)this.transaction(()=>migrateSummaryArchive(this.db,this.options.onStartupProgress));
      compactSummaryArchive(this.db,this.options.onStartupProgress);
    }
  }
  private transaction<T>(action:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=action();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private loadFinance():FinanceState{
    const state=createFinanceState();
    state.prices=this.db.prepare('SELECT data_json FROM item_prices ORDER BY rowid').all().map(row=>JSON.parse(String(row.data_json)));
    state.sessions=this.db.prepare('SELECT data_json FROM farm_sessions ORDER BY rowid').all().map(row=>JSON.parse(String(row.data_json)));
    state.events=this.db.prepare('SELECT data_json FROM finance_transactions ORDER BY rowid').all().map(row=>JSON.parse(String(row.data_json)));
    state.revision=Number(this.db.prepare("SELECT value FROM finance_metadata WHERE key='revision'").get()?.value??0);return state;
  }
  financeState():FinanceState{return this.financeCache;}
  getSetting(key:string):unknown{const row=this.db.prepare('SELECT value_json FROM expansion_settings WHERE key=?').get(key);return row?JSON.parse(String(row.value_json)):undefined;}
  setSetting(key:string,value:unknown):void{const serialized=JSON.stringify(value);if(key.length>100||serialized===undefined||serialized.length>1024*1024)throw new Error('Ayar boyutu geçersiz.');this.db.prepare('INSERT INTO expansion_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(key,serialized);}
  financeCommand(command:FinanceCommand):FinanceState{
    const previous=this.financeCache,next=applyFinanceCommand(previous,command,{id:randomUUID});if(next===previous)return next;
    if(next.events.length<previous.events.length)throw new Error('Finans olay defteri geriye doğru kısaltılamaz.');
    this.transaction(()=>{
      if(command.type==='price.set'||command.type==='price.remove'){
        this.db.exec('DELETE FROM item_prices;');const price=this.db.prepare('INSERT INTO item_prices VALUES(?,?)');
        for(const row of next.prices)price.run(hash(JSON.stringify([row.itemId,row.characterKey])),JSON.stringify(row));
      }
      if(command.type.startsWith('session.')){
        const oldSessions=new Map(previous.sessions.map(row=>[row.id,JSON.stringify(row)])),session=this.db.prepare('INSERT INTO farm_sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json');
        for(const row of next.sessions){const serialized=JSON.stringify(row);if(oldSessions.get(row.id)!==serialized)session.run(row.id,row.characterKey,serialized);}
      }
      const event=this.db.prepare('INSERT INTO finance_transactions VALUES(?,?,?,?)'),expense=this.db.prepare('INSERT INTO finance_expenses VALUES(?,?)');
      for(const row of next.events.slice(previous.events.length)){event.run(row.id,row.kind,(row as unknown as {sourceKey?:string}).sourceKey??null,JSON.stringify(row));if(row.kind==='expense')expense.run(row.id,JSON.stringify(row));}
      this.db.prepare("INSERT INTO finance_metadata VALUES('revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(next.revision));
    });this.financeCache=next;return next;
  }
  importCatalog(input:CatalogPackage,officialSeed=false):void{
    const packet=validateCatalogPackage(input),checksum=hash(JSON.stringify(packet)),previous=this.db.prepare('SELECT checksum FROM database_versions WHERE source_id=? AND version=?').get(packet.source.id,packet.source.version);
    if(packet.source.id==='official-skadi-exp'&&!officialSeed)throw new Error('Uygulamanın resmî EXP kaynağı kullanıcı paketiyle değiştirilemez. Ayrı bir kaynak kimliği kullanın.');
    if(previous){if(previous.checksum===checksum)return;throw new Error('Aynı kaynak sürümü farklı içerikle değiştirilemez. Yeni bir sürüm adı kullanın.');}
    this.transaction(()=>{
      const source=packet.source;this.db.prepare('INSERT INTO database_sources VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,license=excluded.license,version=excluded.version,updated_at=excluded.updated_at,permission=excluded.permission').run(source.id,source.name,source.url,source.license,source.version,source.updatedAt,source.permission);
      for(const table of ['catalog_records','item_database','monster_database','map_database','skill_database','monster_item_drops','experience_requirements'])this.db.prepare(`DELETE FROM ${table} WHERE source_id=?`).run(source.id);
      const general=this.db.prepare('INSERT INTO catalog_records VALUES(?,?,?,?,?,?)');
      for(const row of packet.records){const data=JSON.stringify(row);general.run(source.id,row.kind,row.id,row.name,fold(`${row.id} ${row.name}`),data);
        if(row.kind==='item')this.db.prepare('INSERT INTO item_database VALUES(?,?,?,?,?,?)').run(source.id,Number(row.id),row.name,row.category??null,row.npcSell??null,data);
        else if(row.kind==='monster')this.db.prepare('INSERT INTO monster_database VALUES(?,?,?,?,?,?)').run(source.id,Number(row.id),row.name,row.baseExp??null,row.jobExp??null,data);
        else if(row.kind==='map')this.db.prepare('INSERT INTO map_database VALUES(?,?,?,?)').run(source.id,row.id,row.name,data);
        else if(row.kind==='skill')this.db.prepare('INSERT INTO skill_database VALUES(?,?,?,?)').run(source.id,Number(row.id),row.name,data);
        else if(row.kind==='drop')this.db.prepare('INSERT INTO monster_item_drops VALUES(?,?,?,?,?,?)').run(source.id,row.id,row.monsterId!,row.itemId!,row.chance??null,data);
        else this.db.prepare('INSERT INTO experience_requirements VALUES(?,?,?,?,?,?,?)').run(source.id,row.track!,row.level!,row.required??null,source.url,source.updatedAt,data);
      }
      this.db.prepare('INSERT INTO database_versions VALUES(?,?,?,?,?,?,?)').run(randomUUID(),source.id,source.version,checksum,new Date().toISOString(),packet.records.length,JSON.stringify(source));
    });this.overviewCache=undefined;this.autoFarm?.invalidate();this.killCount?.invalidate();
  }
  private seedExperience():void{
    const first=EXPERIENCE_REQUIREMENTS[0];
    this.importCatalog({schemaVersion:1,source:{id:'official-skadi-exp',name:'Ragnarok Zero Global resmî EXP tablosu',url:first.sourceUrl,license:'Kaynak gösterilen sayısal olgular; istemci varlığı veya üçüncü taraf toplu veritabanı değildir.',version:EXPERIENCE_DATASET_VERSION,updatedAt:first.verifiedAt,permission:'official-facts'},records:EXPERIENCE_REQUIREMENTS.map(row=>({kind:'experience',id:`${row.jobTrack}:${row.level}`,name:`${row.jobTrack} ${row.level} → ${row.level+1}`,level:row.level,track:row.jobTrack,required:row.required}))},true);
    // Keep the official published-row indexing and validation metadata with each individual value.
    this.transaction(()=>{const update=this.db.prepare('UPDATE experience_requirements SET source_url=?,verified_at=?,data_json=? WHERE source_id=? AND track=? AND level=?');for(const row of EXPERIENCE_REQUIREMENTS)update.run(row.sourceUrl,row.verifiedAt,JSON.stringify(row),'official-skadi-exp',row.jobTrack,row.level);});
  }
  catalogOverview():CatalogOverview{
    if(this.overviewCache)return this.overviewCache;
    const counts=Object.fromEntries(KINDS.map(kind=>[kind,0])) as Record<CatalogKind,number>;for(const row of this.db.prepare('SELECT kind,COUNT(*) count FROM catalog_records GROUP BY kind').all())counts[String(row.kind) as CatalogKind]=Number(row.count);
    const sources=this.db.prepare('SELECT * FROM database_sources ORDER BY name,id').all().map(row=>this.source(row));return this.overviewCache={counts,sources,versions:Number(this.db.prepare('SELECT COUNT(*) count FROM database_versions').get()!.count),licenseNotice:LICENSE_NOTICE};
  }
  private source(row:Record<string,unknown>):CatalogSource{return{id:String(row.id),name:String(row.name),url:String(row.url),license:String(row.license),version:String(row.version),updatedAt:String(row.updated_at),permission:row.permission as CatalogSource['permission']};}
  catalogItemNames():{itemId:number;name:string;category:string|null}[]{
    const rows=this.db.prepare(`SELECT item_id,name,lower(trim(category)) kind
      FROM item_database WHERE rowid IN (SELECT MAX(rowid) FROM item_database GROUP BY item_id) ORDER BY item_id`).all();
    return rows.map(row=>({itemId:Number(row.item_id),name:String(row.name),category:row.kind===null?null:String(row.kind)}));
  }
  catalogMonsterNames():Map<number,string>{
    const rows=this.db.prepare('SELECT monster_id,name FROM monster_database WHERE rowid IN (SELECT MAX(rowid) FROM monster_database GROUP BY monster_id)').all();
    return new Map(rows.map(row=>[Number(row.monster_id),String(row.name)]));
  }
  searchCatalog(input:CatalogSearch):CatalogPage{
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['kind','text','after','limit'].includes(key)))throw new Error('Katalog araması geçersiz.');
    if(input.kind!==undefined&&!KINDS.includes(input.kind))throw new Error('Katalog türü geçersiz.');if(input.text!==undefined&&(typeof input.text!=='string'||input.text.length>200))throw new Error('Arama metni en fazla 200 karakter olmalıdır.');
    const limit=input.limit??50;if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Arama sayfası 1–100 kayıt içerebilir.');
    let cursor=['','',''];if(input.after!==undefined){if(typeof input.after!=='string'||input.after.length>1000)throw new Error('Arama sayfası işareti geçersiz.');try{cursor=JSON.parse(Buffer.from(input.after,'base64url').toString('utf8'));if(!Array.isArray(cursor)||cursor.length!==3||cursor.some(value=>typeof value!=='string'))throw new Error();}catch{throw new Error('Arama sayfası işareti geçersiz.');}}
    const search=fold(input.text??'').replace(/[\\%_]/g,value=>`\\${value}`);
    const rows=this.db.prepare(`SELECT c.kind,c.record_id,c.source_id,c.data_json,s.* FROM catalog_records c JOIN database_sources s ON s.id=c.source_id WHERE (? IS NULL OR c.kind=?) AND c.search_text LIKE ? ESCAPE '\\' AND (c.kind,c.record_id,c.source_id)>(?,?,?) ORDER BY c.kind,c.record_id,c.source_id LIMIT ?`).all(input.kind??null,input.kind??null,`%${search}%`,...cursor,limit+1);
    const entries:CatalogEntry[]=rows.slice(0,limit).map(row=>({...JSON.parse(String(row.data_json)),source:this.source(row)}));
    const last=rows[limit-1];return{rows:entries,nextCursor:rows.length>limit?Buffer.from(JSON.stringify([last.kind,last.record_id,last.source_id])).toString('base64url'):null};
  }
  inventoryInbox(limit=100):InventoryObservation[]{return this.db.prepare('SELECT * FROM inventory_events WHERE classification=? ORDER BY observed_at DESC,rowid DESC LIMIT ?').all('unclassified',Math.min(100,Math.max(1,limit))).map(row=>({id:String(row.id),characterKey:String(row.character_key),characterName:String(row.character_name),itemId:Number(row.item_id),amount:Number(row.amount),at:String(row.observed_at),direction:row.direction as 'in'|'out',classification:'unclassified',sourceHash:String(row.source_hash),confidence:'skadi-unverified',note:'Envanter bildirimi gözlemi; farm geliri olduğu doğrulanmadı. Aynı eşyanın yeniden gösterimi veya transfer olabilir.'}));}
  observeReplay(parsed:ParsedReplay,meta:ReplayExpansionMeta,character:CharacterIdentity):void{
    if(this.summaryOnly)return;
    const sourceKey=hash(path.resolve(meta.sourcePath).toLowerCase()),characterKey=character.key,now=meta.observedAt??new Date().toISOString();
    // Automatic farm receipts and daily ledgers are persisted by their owning stores.
    if(this.options.lightweightHistory&&meta.includeExperience===false)return;
    if(!parsed.incremental?.delta&&this.lastSnapshots.get(sourceKey)===meta.hash&&!meta.recordingReset)return;
    const identityComplete=parsed.summary.startedAt!==null&&parsed.summary.playerId!==null;
    const recordingKey=identityComplete?hash(JSON.stringify([parsed.summary.startedAt,parsed.summary.playerId,parsed.summary.characterName])):hash(`${sourceKey}:${meta.recordingId}`);
    const previous=this.db.prepare('SELECT * FROM replay_cursors WHERE source_key=?').get(sourceKey) as unknown as Cursor|undefined;
    const baseline=meta.initial||!previous||previous.recording_id!==meta.recordingId||meta.recordingReset;
    const counts=new Map<string,number>(),oldCounts:Record<string,number>=baseline?{}:JSON.parse(previous.counts_json);let watermark=baseline?-1:previous.watermark;
    const lootBaseline=baseline?parsed.events.reduce((maximum,event)=>Number.isFinite(event.timestamp)?Math.max(maximum,event.timestamp):maximum,-1):oldCounts._lootBaseline??previous!.watermark;
    const candidates=parsed.events.filter(event=>(event.eventType==='item-obtained'?!this.options.lightweightHistory&&isVerifiedLootIncoming(event,parsed.summary.playerId):!this.options.lightweightHistory&&String(event.eventType)==='item-removed'||meta.includeExperience!==false&&['exp-gain','exp-loss'].includes(event.eventType))&&Number.isFinite(event.timestamp)).sort((a,b)=>a.timestamp-b.timestamp);
    const finalTimestamp=candidates.at(-1)?.timestamp??watermark;
    this.transaction(()=>{
      let observationSaved=false;
      const saveObservation=()=>{if(!observationSaved){this.db.prepare('INSERT OR IGNORE INTO replay_observations VALUES(?,?,?,?,?)').run(meta.hash,sourceKey,meta.recordingId,meta.size,now);observationSaved=true;}};
      if(meta.includeExperience!==false&&parsed.summary.liveTelemetry){const t=parsed.summary.liveTelemetry;const normalized={baseLevel:t.baseLevel,jobLevel:t.jobLevel,currentBaseExp:t.currentBaseExp,currentJobExp:t.currentJobExp,nextBaseExp:t.nextBaseExp,nextJobExp:t.nextJobExp,lastBaseExpGain:t.lastBaseExpGain,lastJobExpGain:t.lastJobExpGain,baseExpGained:t.baseExpGained,jobExpGained:t.jobExpGained},serialized=JSON.stringify(normalized);const latest=this.lastExpValues.get(characterKey)??this.db.prepare('SELECT telemetry_json FROM character_exp_snapshots WHERE character_key=? ORDER BY observed_at DESC,rowid DESC LIMIT 1').get(characterKey)?.telemetry_json;if(latest!==serialized){saveObservation();this.db.prepare('INSERT OR IGNORE INTO character_exp_snapshots VALUES(?,?,?,?,?)').run(hash(`${characterKey}:${meta.hash}`),characterKey,meta.hash,now,serialized);}}
      const occurrences=new Map<string,number>();let occurrenceTime=-1;
      for(const event of candidates){
        if(event.timestamp!==occurrenceTime){occurrences.clear();occurrenceTime=event.timestamp;}
        const semantic=JSON.stringify([event.timestamp,event.eventType,event.expKind,event.itemId,event.amount,event.actorId,event.targetId]),fingerprint=hash(semantic),occurrence=(occurrences.get(fingerprint)??0)+1;occurrences.set(fingerprint,occurrence);
        if(event.timestamp===finalTimestamp)counts.set(fingerprint,occurrence);
        const incoming=event.eventType==='item-obtained';
        const effectiveTimestamp=incoming?inventoryConfirmationTime(event)!:event.timestamp;
        const fresh=!baseline&&(!incoming||event.timestamp>lootBaseline)&&(parsed.incremental?.delta||effectiveTimestamp>previous!.watermark||effectiveTimestamp===previous!.watermark&&!oldCounts._saturated&&occurrence>(oldCounts[fingerprint]??0));if(!fresh)continue;
        const eventKey=parsed.incremental?.delta?hash(`${recordingKey}:delta:${event.id}`):hash(`${recordingKey}:${fingerprint}:${occurrence}`);if(!Number.isSafeInteger(event.amount)||Number(event.amount)<=0)continue;
        if(event.eventType==='exp-gain'||event.eventType==='exp-loss'){
          if(this.db.prepare('SELECT 1 FROM character_exp_events WHERE id=?').get(eventKey))continue;
          saveObservation();this.db.prepare('INSERT INTO character_exp_events VALUES(?,?,?,?,?,?,?,?,?)').run(eventKey,characterKey,meta.hash,recordingKey,event.timestamp,event.expKind??'unknown',event.eventType==='exp-loss'?-event.amount!:event.amount!,now,'skadi-unverified');
        }else if(event.itemId){
          if(this.db.prepare('SELECT 1 FROM inventory_events WHERE id=?').get(eventKey))continue;
          saveObservation();this.db.prepare('INSERT INTO inventory_events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(eventKey,characterKey,character.name,meta.hash,event.itemId,event.amount!,String(event.eventType)==='item-removed'?'out':'in','unclassified',event.timestamp,now,'skadi-unverified');
        }
      }
      const boundedCounts=finalTimestamp<watermark?oldCounts:Object.fromEntries([...counts.entries()].slice(0,4096));if(counts.size>4096)boundedCounts._saturated=1;boundedCounts._lootBaseline=lootBaseline;watermark=Math.max(watermark,finalTimestamp);
      this.db.prepare('INSERT INTO replay_cursors VALUES(?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET recording_id=excluded.recording_id,watermark=excluded.watermark,counts_json=excluded.counts_json').run(sourceKey,meta.recordingId,watermark,JSON.stringify(boundedCounts));
    });this.lastSnapshots.set(sourceKey,meta.hash);if(meta.includeExperience!==false&&parsed.summary.liveTelemetry){const t=parsed.summary.liveTelemetry;this.lastExpValues.set(characterKey,JSON.stringify({baseLevel:t.baseLevel,jobLevel:t.jobLevel,currentBaseExp:t.currentBaseExp,currentJobExp:t.currentJobExp,nextBaseExp:t.nextBaseExp,nextJobExp:t.nextJobExp,lastBaseExpGain:t.lastBaseExpGain,lastJobExpGain:t.lastJobExpGain,baseExpGained:t.baseExpGained,jobExpGained:t.jobExpGained}));}
  }
  stats():{expEvents:number;expSnapshots:number;inventoryEvents:number;observations:number}{const count=(table:string)=>Number(this.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get()!.count);return{expEvents:count('character_exp_events'),expSnapshots:count('character_exp_snapshots'),inventoryEvents:count('inventory_events'),observations:count('replay_observations')};}
  close():void{this.huntAnalytics.close();this.targetHunt.close();this.killExperience.close();this.killCount.close();this.autoFarm.close();this.lastSnapshots.clear();this.lastExpValues.clear();this.db.close();}
}
