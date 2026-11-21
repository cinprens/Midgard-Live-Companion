import type {DatabaseSync} from 'node:sqlite';
import {COMPACT_KILL_SCHEMA,migrateCompactKills} from './compact-kill-store';
import {COMPACT_FARM_SCHEMA,migrateCompactFarm} from './compact-farm-store';
import {COMPACT_EXPERIENCE_SCHEMA,migrateCompactExperience} from './compact-experience';

const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
export function summaryDetailTables(db:DatabaseSync):string[]{
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row=>String(row.name)).filter(name=>
    /^(?:own_damage_)?(?:target_hunt_|hunt_analytics_)/.test(name)||
    /^(?:replay_|character_exp_|inventory_|kill_count_|solo_experience_calendar_|finance_calendar_)/.test(name)||
    /^kill_experience_(?:sessions|awards|losses|groups|group_candidates|group_observations|group_intervals)$/.test(name)||
    /^autofarm_(?:sessions|intervals|receipts|cursors|item_totals|correction_candidates)$/.test(name)||name==='kill_own_damage_totals');
}

/** The caller owns one atomic transaction. Aggregate verification precedes deletion. */
export function migrateSummaryArchive(db:DatabaseSync,progress?:(message:string)=>void):void{
  db.exec(COMPACT_KILL_SCHEMA+COMPACT_FARM_SCHEMA+COMPACT_EXPERIENCE_SCHEMA);
  progress?.('Günlük kesim toplamları hazırlanıyor…');
  const killed=migrateCompactKills(db);
  progress?.('Günlük eşya toplamları ve fiyatlar korunuyor…');
  const farm=migrateCompactFarm(db);
  progress?.('Günlük EXP toplamları hazırlanıyor…');
  const experience=migrateCompactExperience(db);
  const tables=summaryDetailTables(db);
  db.exec('PRAGMA defer_foreign_keys=ON;');
  const children=new Map(tables.map(name=>[name,[] as string[]]));
  for(const child of tables)for(const fk of db.prepare(`PRAGMA foreign_key_list(${quote(child)})`).all())children.get(String(fk.table))?.push(child);
  const visited=new Set<string>(),ordered:string[]=[];
  const visit=(name:string)=>{if(visited.has(name))return;visited.add(name);for(const child of children.get(name)??[])visit(child);ordered.push(name);};
  for(const table of tables)visit(table);
  progress?.('Toplamları korunmuş eski olay ayrıntıları temizleniyor…');
  for(const table of ordered)db.exec(`DELETE FROM ${quote(table)};`);
  progress?.('Günlük özetlerin bütünlüğü doğrulanıyor…');
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Günlük özet geçişinde kayıt ilişkileri doğrulanamadı; eski kayıtlar korunuyor.');
  if(db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Error('Günlük özet geçişinde veritabanı doğrulanamadı; eski kayıtlar korunuyor.');
  // Fail closed if an obsolete writer is accidentally reconnected in a future change.
  for(const table of tables)db.exec(`CREATE TRIGGER IF NOT EXISTS ${quote(`summary_block_${table}`)} BEFORE INSERT ON ${quote(table)} BEGIN SELECT RAISE(ABORT,'Ayrıntılı olay kaydı bu sürümde kapalı.'); END;`);
  db.prepare('INSERT INTO expansion_settings(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run('summary-storage-migration',JSON.stringify({version:14,killed,farm,experience}));
  db.prepare("INSERT INTO finance_metadata(key,value) VALUES('summary_compaction_pending','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  db.exec("INSERT INTO expansion_migrations VALUES(14,datetime('now'));");
}

/** VACUUM is atomic; a busy database can retry on the next launch. */
export function compactSummaryArchive(db:DatabaseSync,progress?:(message:string)=>void):boolean{
  if(db.prepare("SELECT value FROM finance_metadata WHERE key='summary_compaction_pending'").get()?.value!=='1')return false;
  progress?.('Kayıt dosyası küçültülüyor. Büyük arşivlerde birkaç dakika sürebilir…');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  db.prepare("DELETE FROM finance_metadata WHERE key='summary_compaction_pending'").run();
  return true;
}
