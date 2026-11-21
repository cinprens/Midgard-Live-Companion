import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ParsedReplay, ReplayEvent } from '../src/parser/types';
import type { AnalysisJob, AnalysisSummary, ReplayRecord, CharacterIdentity, ManualCharacterInput } from '../src/shared/types';
import { compareCharacters, recordedCharacter, type CharacterComparison } from '../src/domain/characters';

interface FileRow { id: string; filename: string; source_path: string; hash: string; size: number; imported_at: string; status: ReplayRecord['status']; format: string; version: string; summary_json: string | null; diagnostics_json: string; error: string | null; overlap_excluded: number; }
export interface ImportMeta { id?: string; filename: string; sourcePath: string; hash: string; size: number; }

export function toSummary(parsed: ParsedReplay): AnalysisSummary {
  const summary = parsed.summary;
  return {
    durationMs: summary.durationMs, startedAt: summary.startedAt, mapName: summary.mapName,
    characterName: summary.characterName, playerId: summary.playerId,
    deaths: summary.observedDeaths, personalKills: summary.certainPersonalKills,
    inferredKills: summary.estimatedPersonalKills, partyKills: summary.partyKills,
    unknownKills: summary.unknownKills, damage: summary.totalDamage,
    exp: summary.totalExp, drops: summary.dropCount,
    monsters: summary.monsters.map(monster => ({ monsterId: monster.monsterId, name: monster.name,
      deaths: monster.observedDeaths, personalKills: monster.certainPersonalKills,
      inferredKills: monster.estimatedPersonalKills, partyKills: monster.partyKills,
      damage: monster.damage, lastSeenMs: monster.lastSeenMs })),
    timeline: summary.timeline,
    itemObservations: summary.itemObservations,
  };
}

export class ReplayDatabase {
  private db: DatabaseSync;
  private comparisonCache: CharacterComparison | null = null;
  private identityCache: { replays: Map<string,CharacterIdentity>; streams: Map<string,CharacterIdentity> } | null = null;
  constructor(public readonly filePath: string) {
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.migrate();
  }
  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`);
    const current = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {version: number | null};
    if ((current.version ?? 0) < 1) this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE characters(id INTEGER PRIMARY KEY, actor_id INTEGER, name TEXT NOT NULL, UNIQUE(actor_id,name));
      CREATE TABLE replay_files(id TEXT PRIMARY KEY, filename TEXT NOT NULL, source_path TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, imported_at TEXT NOT NULL, status TEXT NOT NULL,
        format TEXT NOT NULL, version TEXT NOT NULL, summary_json TEXT, diagnostics_json TEXT NOT NULL,
        error TEXT, overlap_excluded INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE replay_sessions(id TEXT PRIMARY KEY REFERENCES replay_files(id) ON DELETE CASCADE,
        character_id INTEGER REFERENCES characters(id), started_at TEXT, duration_ms INTEGER NOT NULL,
        map_name TEXT, compatibility TEXT NOT NULL, profile TEXT NOT NULL);
      CREATE TABLE replay_events(id TEXT PRIMARY KEY, replay_id TEXT NOT NULL REFERENCES replay_files(id) ON DELETE CASCADE,
        event_index INTEGER NOT NULL, timestamp_ms INTEGER NOT NULL, event_type TEXT NOT NULL,
        actor_id INTEGER, target_id INTEGER, monster_id INTEGER, amount REAL,
        confidence TEXT NOT NULL, attribution TEXT, event_json TEXT NOT NULL, UNIQUE(replay_id,event_index));
      CREATE TABLE monster_types(id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL);
      CREATE TABLE monster_kills(id TEXT PRIMARY KEY REFERENCES replay_events(id) ON DELETE CASCADE,
        replay_id TEXT NOT NULL REFERENCES replay_files(id) ON DELETE CASCADE, monster_id INTEGER REFERENCES monster_types(id),
        timestamp_ms INTEGER NOT NULL, confidence TEXT NOT NULL, attribution TEXT NOT NULL, counted INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE item_drops(id TEXT PRIMARY KEY REFERENCES replay_events(id) ON DELETE CASCADE,
        replay_id TEXT NOT NULL REFERENCES replay_files(id) ON DELETE CASCADE, item_id INTEGER, amount REAL, confidence TEXT NOT NULL);
      CREATE TABLE analysis_jobs(id TEXT PRIMARY KEY, replay_id TEXT REFERENCES replay_files(id) ON DELETE SET NULL,
        filename TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE application_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX idx_sessions_time ON replay_sessions(started_at);
      CREATE INDEX idx_events_replay_time ON replay_events(replay_id,timestamp_ms);
      CREATE INDEX idx_events_actor ON replay_events(actor_id,event_type);
      CREATE INDEX idx_kills_monster ON monster_kills(monster_id,timestamp_ms);
      CREATE INDEX idx_jobs_date ON analysis_jobs(created_at);
      INSERT INTO schema_migrations VALUES(1,datetime('now'));
      COMMIT;`);
    if ((current.version ?? 0) < 2) this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE manual_character_profiles(character_key TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE replay_character_mappings(replay_id TEXT PRIMARY KEY REFERENCES replay_files(id) ON DELETE CASCADE,
        character_key TEXT NOT NULL REFERENCES manual_character_profiles(character_key));
      CREATE TABLE stream_character_mappings(source_key TEXT PRIMARY KEY,
        character_key TEXT NOT NULL REFERENCES manual_character_profiles(character_key));
      CREATE INDEX idx_replay_character ON replay_character_mappings(character_key);
      CREATE INDEX idx_stream_character ON stream_character_mappings(character_key);
      INSERT INTO schema_migrations VALUES(2,datetime('now'));
      COMMIT;`);
  }
  private transaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { action(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  hasHash(hash: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM replay_files WHERE hash=?').get(hash)); }
  findByHash(hash: string): ReplayRecord | null {
    const row = this.db.prepare('SELECT * FROM replay_files WHERE hash=?').get(hash) as unknown as FileRow | undefined;
    return row ? this.toRecord(row) : null;
  }
  sourceFor(id: string): string | null {
    const row = this.db.prepare('SELECT source_path FROM replay_files WHERE id=?').get(id) as {source_path:string}|undefined;
    return row?.source_path ?? null;
  }
  findBySource(sourcePath: string): ReplayRecord | null {
    const sourceKey = this.sourceKey(sourcePath);
    const rows = this.db.prepare('SELECT * FROM replay_files ORDER BY imported_at DESC,rowid DESC').all() as unknown as FileRow[];
    const row = rows.find(item => this.sourceKey(item.source_path) === sourceKey);
    return row ? this.toRecord(row) : null;
  }
  private sourceKey(sourcePath: string): string { return path.resolve(sourcePath).toLowerCase(); }
  private invalidateCharacters(): void { this.comparisonCache=null;this.identityCache=null; }
  private identities(): { replays: Map<string,CharacterIdentity>; streams: Map<string,CharacterIdentity> } {
    if(this.identityCache)return this.identityCache;
    const replays=new Map<string,CharacterIdentity>(),streams=new Map<string,CharacterIdentity>();
    const replayRows=this.db.prepare(`SELECT m.replay_id AS target,p.character_key,p.name FROM replay_character_mappings m JOIN manual_character_profiles p USING(character_key)`).all() as {target:string;character_key:string;name:string}[];
    const streamRows=this.db.prepare(`SELECT m.source_key AS target,p.character_key,p.name FROM stream_character_mappings m JOIN manual_character_profiles p USING(character_key)`).all() as {target:string;character_key:string;name:string}[];
    for(const row of replayRows)replays.set(row.target,{key:row.character_key,name:row.name,source:'manual',playerId:null});
    for(const row of streamRows)streams.set(row.target,{key:row.character_key,name:row.name,source:'manual',playerId:null});
    this.identityCache={replays,streams};return this.identityCache;
  }
  manualCharacters(): CharacterIdentity[] {
    const rows=this.db.prepare('SELECT character_key,name FROM manual_character_profiles ORDER BY name,character_key').all() as {character_key:string;name:string}[];
    return rows.map(row=>({key:row.character_key,name:row.name,source:'manual',playerId:null}));
  }
  private manualProfile(input: ManualCharacterInput): CharacterIdentity {
    if(!input || typeof input!=='object' || typeof input.name!=='string' || input.name.trim().length<1 || input.name.trim().length>80 || /[\u0000-\u001f\u007f]/.test(input.name))throw new Error('Karakter adı 1–80 karakter olmalı ve kontrol karakteri içermemelidir.');
    const name=input.name.trim();
    if(input.key!==undefined) {
      if(typeof input.key!=='string' || input.key.length>100)throw new Error('Geçersiz manuel karakter kimliği.');
      const existing=this.db.prepare('SELECT character_key,name FROM manual_character_profiles WHERE character_key=?').get(input.key) as {character_key:string;name:string}|undefined;
      if(!existing)throw new Error('Seçilen manuel karakter bulunamadı.');
      return {key:existing.character_key,name:existing.name,source:'manual',playerId:null};
    }
    const key=`manual:${randomUUID()}`;
    this.db.prepare('INSERT INTO manual_character_profiles VALUES(?,?,?)').run(key,name,new Date().toISOString());
    return {key,name,source:'manual',playerId:null};
  }
  assignCharacter(replayId: string,input: ManualCharacterInput|null): ReplayRecord {
    if(!this.sourceFor(replayId))throw new Error('Replay kaydı bulunamadı.');
    this.transaction(()=>{
      if(input===null)this.db.prepare('DELETE FROM replay_character_mappings WHERE replay_id=?').run(replayId);
      else {const identity=this.manualProfile(input);this.db.prepare('INSERT INTO replay_character_mappings VALUES(?,?) ON CONFLICT(replay_id) DO UPDATE SET character_key=excluded.character_key').run(replayId,identity.key);}
    });
    this.invalidateCharacters();return this.records().find(record=>record.id===replayId)!;
  }
  assignStreamCharacter(sourcePath: string,input: ManualCharacterInput|null): CharacterIdentity|null {
    const sourceKey=this.sourceKey(sourcePath);let identity:CharacterIdentity|null=null;
    this.transaction(()=>{
      if(input===null)this.db.prepare('DELETE FROM stream_character_mappings WHERE source_key=?').run(sourceKey);
      else {identity=this.manualProfile(input);this.db.prepare('INSERT INTO stream_character_mappings VALUES(?,?) ON CONFLICT(source_key) DO UPDATE SET character_key=excluded.character_key').run(sourceKey,identity.key);}
    });
    this.invalidateCharacters();return identity;
  }
  streamCharacter(sourcePath: string): CharacterIdentity|null { return this.identities().streams.get(this.sourceKey(sourcePath)) ?? null; }
  private toRecord(row: FileRow): ReplayRecord {
    const record:ReplayRecord = { id: row.id, filename: row.filename, hash: row.hash, size: row.size,
      importedAt: row.imported_at, status: row.status, format: row.format, version: row.version,
      summary: row.summary_json ? JSON.parse(row.summary_json) as AnalysisSummary : null,
      diagnostics: JSON.parse(row.diagnostics_json) as string[], error: row.error,
      overlapExcluded: row.overlap_excluded === 1 };
    const identities=this.identities();
    record.character=identities.replays.get(row.id) ?? identities.streams.get(this.sourceKey(row.source_path)) ?? recordedCharacter(record);
    return record;
  }
  records(): ReplayRecord[] {
    return (this.db.prepare('SELECT * FROM replay_files ORDER BY imported_at DESC,id').all() as unknown as FileRow[]).map(row => this.toRecord(row));
  }
  save(meta: ImportMeta, parsed: ParsedReplay): ReplayRecord {
    const existing = this.findByHash(meta.hash);
    if (existing && existing.id !== meta.id) return existing;
    const id = meta.id ?? randomUUID();
    const invalid = parsed.status === 'invalid';
    if (meta.id && (invalid || (parsed.status === 'unsupported' && this.records().some(record => record.id === meta.id && record.summary !== null)))) throw new Error(parsed.diagnostics.map(item => item.message).join(' ') || 'Yeniden analiz başarısız; önceki sonuçlar korundu.');
    const summary = parsed.status === 'supported' || parsed.status === 'partial' ? toSummary(parsed) : null;
    const diagnostics = parsed.diagnostics.map(item => `[${item.code}] ${item.message}`);
    if (parsed.status === 'partial') diagnostics.push('[PARTIAL_ANALYSIS] Kısmi analiz: desteklenmeyen veya çözümlenemeyen paketler olabilir. Yalnızca tanınan olaylar hesaplandı.');
    for (const packet of parsed.unknownPackets) diagnostics.push(`[UNKNOWN_PACKET] ${packet.packetId}: ${packet.count} paket çözümlenemedi; olay türü veya alan düzeni bu profilde doğrulanmadı.`);
    if (summary && (summary.startedAt === null || summary.playerId === null || !summary.characterName || summary.durationMs <= 0)) diagnostics.push('[OVERLAP_UNKNOWN] Kayıt tarihi, oyuncu kimliği, karakter adı veya süre yeterince bilinmediği için diğer replaylerle olay düzeyinde örtüşme doğrulanamadı.');
    const status: ReplayRecord['status'] = invalid ? 'error' : summary ? 'analyzed' : 'unsupported';
    const error = invalid ? diagnostics.join(' ') || 'Bozuk RRF dosyası.' : null;
    this.transaction(() => {
      this.db.prepare(`INSERT INTO replay_files(id,filename,source_path,hash,size,imported_at,status,format,version,summary_json,diagnostics_json,error)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET filename=excluded.filename,source_path=excluded.source_path,
        hash=excluded.hash,size=excluded.size,status=excluded.status,format=excluded.format,version=excluded.version,
        summary_json=excluded.summary_json,diagnostics_json=excluded.diagnostics_json,error=excluded.error`)
        .run(id,meta.filename,meta.sourcePath,meta.hash,meta.size,new Date().toISOString(),status,parsed.format,String(parsed.version ?? 'Bilinmiyor'),summary ? JSON.stringify(summary) : null,JSON.stringify(diagnostics),error);
      this.db.prepare('DELETE FROM replay_sessions WHERE id=?').run(id);
      this.db.prepare('DELETE FROM replay_events WHERE replay_id=?').run(id);
      let characterId: number | null = null;
      if (summary?.characterName) {
        this.db.prepare('INSERT OR IGNORE INTO characters(actor_id,name) VALUES(?,?)').run(summary.playerId,summary.characterName);
        const character = this.db.prepare('SELECT id FROM characters WHERE actor_id IS ? AND name=?').get(summary.playerId,summary.characterName) as {id:number};
        characterId = character.id;
      }
      if (summary) this.db.prepare('INSERT INTO replay_sessions VALUES(?,?,?,?,?,?,?)').run(id,characterId,summary.startedAt,summary.durationMs,summary.mapName,parsed.compatibility,parsed.profile);
      const insertEvent = this.db.prepare('INSERT INTO replay_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      const insertMonster = this.db.prepare('INSERT OR IGNORE INTO monster_types VALUES(?,?,?)');
      const insertKill = this.db.prepare('INSERT INTO monster_kills VALUES(?,?,?,?,?,?,1)');
      const insertDrop = this.db.prepare('INSERT INTO item_drops VALUES(?,?,?,?,?)');
      parsed.events.forEach((event: ReplayEvent,index: number) => {
        const eventId = `${id}:${index}`;
        insertEvent.run(eventId,id,index,event.timestamp,event.eventType,event.actorId ?? null,event.targetId ?? null,event.monsterId ?? null,event.amount ?? null,event.confidence,event.attribution ?? null,JSON.stringify(event));
        if (event.monsterId !== undefined) insertMonster.run(event.monsterId,event.monsterName ?? `Monster #${event.monsterId}`,'replay-observed-unverified-name');
        if (event.eventType === 'death' && event.monsterId !== undefined) insertKill.run(eventId,id,event.monsterId,event.timestamp,event.confidence,event.attribution ?? 'unknown');
        if (event.eventType === 'drop' && event.confidence === 'certain') insertDrop.run(eventId,id,null,event.amount ?? null,event.confidence);
      });
      this.updateOverlapExclusions();
    });
    this.invalidateCharacters();
    return this.records().find(record => record.id === id)!;
  }
  comparison(): CharacterComparison {
    if(this.comparisonCache)return this.comparisonCache;
    const records=this.records();
    const events=new Map<string,ReplayEvent[]>();
    const eventBudget=200000;
    let count=0;
    const rows=this.db.prepare(`SELECT e.replay_id,e.event_index,e.timestamp_ms,e.event_type,e.actor_id,e.target_id,e.monster_id,
      json_extract(e.event_json,'$.mapId') AS map_id FROM replay_events e JOIN replay_files f ON f.id=e.replay_id
      WHERE f.status='analyzed' AND f.overlap_excluded=0 AND e.event_type IN ('spawn','death','map')
      ORDER BY e.replay_id,e.event_index LIMIT ?`).iterate(eventBudget+1);
    for(const row of rows) {
      if(++count>eventBudget)break;
      const replayId=String(row.replay_id),list=events.get(replayId) ?? [];
      list.push({id:String(row.event_index),timestamp:Number(row.timestamp_ms),eventType:row.event_type as ReplayEvent['eventType'],
        actorId:row.actor_id===null?undefined:Number(row.actor_id),targetId:row.target_id===null?undefined:Number(row.target_id),
        monsterId:row.monster_id===null?undefined:Number(row.monster_id),mapId:row.map_id===null?undefined:String(row.map_id),confidence:'unknown'});
      events.set(replayId,list);
    }
    const result=compareCharacters(records,events);
    if(count>eventBudget)result.uncertaintyReasons.push('Olay eşleştirme için 200.000 olaylık bellek bütçesine ulaşıldı. Tüm karakter özetleri korunur; olası tekrar adayları eksik olabilir.');
    this.comparisonCache=result;return result;
  }
  private updateOverlapExclusions(): void {
    const rows = this.db.prepare('SELECT * FROM replay_files ORDER BY imported_at ASC,rowid ASC').all() as unknown as FileRow[];
    const accepted: { playerId: number; character: string; start: number; end: number }[] = [];
    const update = this.db.prepare('UPDATE replay_files SET overlap_excluded=? WHERE id=?');
    const updateKills = this.db.prepare('UPDATE monster_kills SET counted=? WHERE replay_id=?');
    for (const row of rows) {
      const summary = row.summary_json ? JSON.parse(row.summary_json) as AnalysisSummary : null;
      let excluded = false;
      if (summary?.startedAt && summary.playerId !== null && summary.characterName && summary.durationMs > 0) {
        // Timestamps are replay-local wall clock labels; this comparison is deliberately conservative.
        const start = Date.parse(`${summary.startedAt.replace(/Z$/,'')}Z`);
        const end = start + summary.durationMs;
        if (Number.isFinite(start)) {
          excluded = accepted.some(previous => previous.playerId === summary.playerId && previous.character === summary.characterName && previous.start < end && start < previous.end);
          if (!excluded) accepted.push({playerId:summary.playerId,character:summary.characterName,start,end});
        }
      }
      update.run(excluded ? 1 : 0,row.id);
      updateKills.run(excluded ? 0 : 1,row.id);
    }
  }
  logJob(filename: string,status: string,message: string,replayId: string | null = null,id: string = randomUUID()): string {
    this.db.prepare(`INSERT INTO analysis_jobs VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET replay_id=excluded.replay_id,status=excluded.status,message=excluded.message`)
      .run(id,replayId,filename,status,message,new Date().toISOString());
    return id;
  }
  jobs(): AnalysisJob[] {
    const rows = this.db.prepare('SELECT id,filename,status,message,created_at FROM analysis_jobs ORDER BY created_at DESC,rowid DESC LIMIT 100').all() as {id:string;filename:string;status:string;message:string;created_at:string}[];
    return rows.map(row => ({id:row.id,filename:row.filename,status:row.status,message:row.message,createdAt:row.created_at}));
  }
  getSetting<T>(key: string,fallback: T): T {
    const row = this.db.prepare('SELECT value FROM application_settings WHERE key=?').get(key) as {value:string}|undefined;
    if (!row) return fallback;
    try { return JSON.parse(row.value) as T; } catch { return fallback; }
  }
  setSetting(key: string,value: unknown): void { this.db.prepare('INSERT INTO application_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)); }
  async backupTo(destination: string): Promise<void> { await backup(this.db,destination); }
  eventCount(): number { return Number((this.db.prepare('SELECT count(*) count FROM replay_events').get() as {count:number}).count); }
  exportEvents(): unknown[] { return this.db.prepare('SELECT replay_id,event_json FROM replay_events ORDER BY replay_id,event_index').all().map(row => ({replayId:row.replay_id,event:JSON.parse(String(row.event_json)) as ReplayEvent})); }
  close(): void { this.db.close(); }
}
