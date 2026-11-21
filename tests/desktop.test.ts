import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ReplayDatabase } from '../electron/database';
import { FileStabilityTracker } from '../electron/stable-files';
import { csvCell, recordsToCsv } from '../electron/export';
import { writeOutput } from '../electron/safe-output';
import type { ParsedReplay } from '../src/parser/types';

const cleanup: (() => Promise<void>|void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function database(): Promise<ReplayDatabase> {
  const directory = await mkdtemp(path.join(os.tmpdir(),'midgard-db-'));
  cleanup.push(() => rm(directory,{recursive:true,force:true}));
  const db = new ReplayDatabase(path.join(directory,'test.sqlite'));
  cleanup.push(() => db.close());
  return db;
}
function parsed(options: {date?:string|null; player?:number; character?:string; deaths?:number} = {}): ParsedReplay {
  const deaths = options.deaths ?? 10;
  return {filename:'fixture.rrf',format:'RRF',version:5,status:'supported',profile:'rrf-v5-latam',compatibility:'skadi-unverified',packetCount:deaths,unknownPackets:[],diagnostics:[],
    events:Array.from({length:deaths},(_,index) => ({id:String(index),timestamp:index*1000,eventType:'death' as const,targetId:1000+index,monsterId:999999,confidence:'certain' as const,attribution:'unknown' as const})),
    summary:{durationMs:60_000,startedAt:options.date === undefined ? '2026-01-01T12:00:00' : options.date,mapName:'test',characterName:options.character ?? 'Test',playerId:options.player ?? 1,observedDeaths:deaths,certainPersonalKills:0,estimatedPersonalKills:0,partyKills:0,otherKills:0,unknownKills:deaths,totalDamage:0,totalExp:null,dropCount:null,killsPerHour:deaths*60,monsters:[],timeline:[]}};
}
function meta(hash = 'a',id?:string) { return {id,filename:'fixture.rrf',sourcePath:'C:\\fixtures\\fixture.rrf',hash:hash.repeat(64),size:100}; }

describe('SQLite persistence',() => {
  it('retains unknown packet IDs and partial-analysis warning for the diagnostics screen',async()=>{
    const db=await database();const input=parsed();input.status='partial';input.unknownPackets=[{packetId:'0xdead',count:3}];
    const record=db.save(meta(),input);
    expect(record.diagnostics.some(d=>d.includes('[UNKNOWN_PACKET] 0xdead: 3'))).toBe(true);
    expect(record.diagnostics.some(d=>d.includes('[PARTIAL_ANALYSIS]'))).toBe(true);
    expect(record.summary?.deaths).toBe(10);
  });
  it('creates migrated tables, foreign keys and persists ten observed deaths without personal attribution',async () => {
    const db = await database();
    const record = db.save(meta(),parsed());
    expect(record.summary?.deaths).toBe(10);
    expect(record.summary?.personalKills).toBe(0);
    expect(db.eventCount()).toBe(10);
    const read = new DatabaseSync(db.filePath);
    expect((read.prepare('SELECT count(*) count FROM monster_kills').get() as {count:number}).count).toBe(10);
    expect((read.prepare('SELECT name FROM sqlite_master WHERE type=?').all('table')).length).toBeGreaterThanOrEqual(10);
    expect(read.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    read.close();
  });
  it('deduplicates the same hash even when renamed',async () => {
    const db = await database();
    const original = db.save(meta(),parsed());
    const second = db.save({...meta(),filename:'renamed.rrf'},parsed());
    expect(second.id).toBe(original.id);
    expect(db.records()).toHaveLength(1);
    expect(db.eventCount()).toBe(10);
  });
  it('excludes a later overlapping session with matching player and character without discarding its events',async () => {
    const db = await database();
    const first = db.save(meta('a'),parsed());
    const second = db.save(meta('b'),parsed({date:'2026-01-01T12:00:30'}));
    expect(db.records().find(record => record.id === first.id)?.overlapExcluded).toBe(false);
    expect(second.overlapExcluded).toBe(true);
    expect(db.eventCount()).toBe(20);
  });
  it('does not classify different characters as duplicate overlapping sessions',async () => {
    const db = await database();
    db.save(meta('a'),parsed());
    const other = db.save(meta('b'),parsed({character:'Other',player:2}));
    expect(other.overlapExcluded).toBe(false);
  });
  it('diagnoses missing absolute time instead of inventing duplicate matching',async () => {
    const db = await database();
    const record = db.save(meta(),parsed({date:null}));
    expect(record.diagnostics.some(line => line.includes('OVERLAP_UNKNOWN'))).toBe(true);
  });
  it('retains a successful analysis when reanalysis is invalid',async () => {
    const db = await database();
    const original = db.save(meta(),parsed());
    expect(() => db.save(meta('b',original.id),{...parsed(),status:'invalid',diagnostics:[{severity:'error',code:'BROKEN',message:'Bozuk dosya.'}]})).toThrow('Bozuk dosya');
    expect(db.records()[0].hash).toBe(original.hash);
    expect(db.eventCount()).toBe(10);
  });
  it('rolls back an event insertion error atomically',async () => {
    const db = await database();
    const original = db.save(meta(),parsed());
    const bad = parsed();
    bad.events[0].timestamp = undefined as unknown as number;
    expect(() => db.save(meta('b',original.id),bad)).toThrow();
    expect(db.records()[0].hash).toBe(original.hash);
    expect(db.eventCount()).toBe(10);
  });
  it('persists settings and completes a consistent SQLite backup',async () => {
    const db = await database();
    db.setSetting('watchRequested',true);
    db.save(meta(),parsed());
    const destination = path.join(path.dirname(db.filePath),'backup.sqlite');
    await db.backupTo(destination);
    const restored = new ReplayDatabase(destination);
    expect(restored.getSetting('watchRequested',false)).toBe(true);
    expect(restored.eventCount()).toBe(10);
    restored.close();
  });
});

describe('file completion and export safeguards',() => {
  it('requires three identical samples and minimum age',() => {
    const tracker = new FileStabilityTracker();
    expect(tracker.observe('a',{size:5,mtimeMs:1000},1500)).toBe(false);
    expect(tracker.observe('a',{size:5,mtimeMs:1000},2000)).toBe(false);
    expect(tracker.observe('a',{size:5,mtimeMs:1000},3000)).toBe(true);
  });
  it('resets completion when writer changes the file or renames it',() => {
    const tracker = new FileStabilityTracker();
    tracker.observe('a',{size:5,mtimeMs:1},5000);
    tracker.observe('a',{size:5,mtimeMs:1},5000);
    expect(tracker.observe('a',{size:6,mtimeMs:2},5000)).toBe(false);
    expect(tracker.observe('b',{size:5,mtimeMs:1},5000)).toBe(false);
    expect(tracker.observe('empty',{size:0,mtimeMs:1},5000)).toBe(false);
  });
  it('escapes CSV formulas and delimiters while preserving unknown numeric fields as empty',() => {
    expect(csvCell('=SUM(1,2)')).toBe('"\'=SUM(1,2)"');
    expect(csvCell('a"b,c')).toBe('"a""b,c"');
    expect(csvCell(null)).toBe('""');
    expect(recordsToCsv([])).toContain('EXP (doğrulanmış)');
  });
  it('replaces the destination directory entry rather than writing through the existing file inode',async () => {
    const directory = await mkdtemp(path.join(process.cwd(),'.qa-output-'));
    cleanup.push(() => rm(directory,{recursive:true,force:true}));
    const output = path.join(directory,'export.json');
    await writeFile(output,'previous export');
    const original = await stat(output,{bigint:true});
    await writeOutput(output,'new export');
    const updated = await stat(output,{bigint:true});
    expect(updated.ino).not.toBe(original.ino);
    expect(await readFile(output,'utf8')).toBe('new export');
  });
});
