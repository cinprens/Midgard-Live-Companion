import { afterEach,describe,expect,it } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ReplayDatabase } from '../electron/database';
import type { ParsedReplay } from '../src/parser/types';
const cleanup:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
async function setup(){const directory=await mkdtemp(path.join(os.tmpdir(),'midgard-characters-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));const file=path.join(directory,'archive.sqlite');const db=new ReplayDatabase(file);cleanup.push(()=>db.close());return {db,file};}
function parsed(name:string|null='Alice',playerId:number|null=42):ParsedReplay{return {filename:'source.rrf',format:'RRF',version:5,status:'partial',profile:'rrf-v5-latam',compatibility:'skadi-unverified',packetCount:2,unknownPackets:[],diagnostics:[],events:[
  {id:'s',eventType:'spawn',timestamp:0,actorId:100,monsterId:1002,mapId:'field',confidence:'certain'},
  {id:'d',eventType:'death',timestamp:5000,targetId:100,monsterId:1002,mapId:'field',confidence:'unknown'}],
  summary:{durationMs:60000,startedAt:'2026-11-01T12:00:00',mapName:'field',characterName:name,playerId,observedDeaths:1,certainPersonalKills:0,estimatedPersonalKills:0,partyKills:0,otherKills:0,unknownKills:1,totalDamage:0,totalExp:null,dropCount:null,killsPerHour:60,monsters:[],timeline:[]}};}
function meta(hash='a',id?:string){return {id,filename:'source.rrf',sourcePath:path.resolve(`.qa/${hash}.rrf`),hash:hash.repeat(64),size:100};}
describe('multi-character SQLite migrations and mappings',()=>{
  it('persists observed item quantities without turning them into verified personal drops',async()=>{
    const {db}=await setup();const input=parsed();input.summary.itemObservations={groundCount:1,groundQuantity:3,obtainedCount:1,obtainedQuantity:2,items:[{itemId:501,groundCount:1,groundQuantity:3,obtainedCount:1,obtainedQuantity:2}],personalDropCount:null,confidence:'observed-only'};
    const imported=db.save(meta(),input);expect(imported.summary?.itemObservations?.obtainedQuantity).toBe(2);expect(imported.summary?.drops).toBeNull();expect(db.comparison().characters[0].itemObservations?.items[0].itemId).toBe(501);expect(db.comparison().drops).toBeNull();
  });
  it('migrates existing v1 data without losing recordings, settings or normalized events',async()=>{
    const {db,file}=await setup();const source=db.save(meta(),parsed());db.setSetting('replayFolder','C:\\original');db.close();cleanup.pop();
    const legacy=new DatabaseSync(file);legacy.exec('DROP TABLE replay_character_mappings; DROP TABLE stream_character_mappings; DROP TABLE manual_character_profiles; DELETE FROM schema_migrations WHERE version=2;');legacy.close();
    const migrated=new ReplayDatabase(file);cleanup.push(()=>migrated.close());expect(migrated.records()[0].id).toBe(source.id);expect(migrated.eventCount()).toBe(2);expect(migrated.getSetting('replayFolder',null)).toBe('C:\\original');expect(migrated.manualCharacters()).toEqual([]);
    const check=new DatabaseSync(file);expect(check.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version).toBe(2);expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]);check.close();
  });
  it('persists manual assignment without rewriting parsed owner identity or manufacturing drop data',async()=>{
    const {db,file}=await setup();const source=db.save(meta(),parsed(null,null));const mapped=db.assignCharacter(source.id,{name:'Merchant'});
    expect(mapped.character?.name).toBe('Merchant');expect(mapped.character?.source).toBe('manual');expect(mapped.summary?.playerId).toBeNull();expect(mapped.summary?.characterName).toBeNull();expect(mapped.summary?.drops).toBeNull();
    db.close();cleanup.pop();const reopened=new ReplayDatabase(file);cleanup.push(()=>reopened.close());expect(reopened.records()[0].character?.name).toBe('Merchant');expect(reopened.comparison().damage).toBeNull();
  });
  it('does not overwrite manual mapping when later analysis provides a recorded name',async()=>{
    const {db}=await setup();const source=db.save(meta(),parsed(null,null));db.assignCharacter(source.id,{name:'Chosen'});const updated=db.save(meta('b',source.id),parsed('Recorded Alice'));
    expect(updated.character?.name).toBe('Chosen');expect(updated.summary?.characterName).toBe('Recorded Alice');expect(db.assignCharacter(source.id,null).character?.name).toBe('Recorded Alice');
  });
  it('binds a selected source before its first completed snapshot and lets replay override take precedence',async()=>{
    const {db}=await setup();const source=meta();const identity=db.assignStreamCharacter(source.sourcePath,{name:'Stream character'});
    expect(db.streamCharacter(source.sourcePath.toUpperCase())?.key).toBe(identity?.key);
    const imported=db.save(source,parsed());expect(imported.character?.key).toBe(identity?.key);
    const override=db.assignCharacter(imported.id,{name:'Replay character'});expect(override.character?.name).toBe('Replay character');
    expect(db.findBySource(source.sourcePath.toUpperCase())?.id).toBe(imported.id);
  });
  it('groups multiple manual recordings only when explicitly selecting the same persisted manual key',async()=>{
    const {db}=await setup();const a=db.save(meta('a'),parsed(null,null)),b=db.save(meta('b'),parsed(null,null));const mapped=db.assignCharacter(a.id,{name:'Merchant'});
    db.assignCharacter(b.id,{key:mapped.character!.key,name:'Merchant'});expect(db.comparison().characters).toHaveLength(1);expect(db.comparison().observedDeathsSum).toBe(2);expect(db.comparison().uniqueDeaths).toBeNull();
  });
  it('caches event-level comparison until a recording or mapping mutation',async()=>{
    const {db}=await setup();db.save(meta('a'),parsed('Alice'));db.save(meta('b'),parsed('Bob'));
    const first=db.comparison();expect(first.duplicateCandidates).toBe(1);expect(first.uniqueDeaths).toBeNull();expect(db.comparison()).toBe(first);
    db.logJob('any','completed','log changes do not alter data');expect(db.comparison()).toBe(first);
    const source=db.records()[0];db.assignCharacter(source.id,{name:'Manual'});expect(db.comparison()).not.toBe(first);
  });
  it('rejects invalid names and unknown manual keys atomically',async()=>{
    const {db}=await setup();const source=db.save(meta(),parsed());expect(()=>db.assignCharacter(source.id,{name:'\u0000bad'})).toThrow();expect(()=>db.assignCharacter(source.id,{name:'Valid',key:'missing'})).toThrow();expect(db.manualCharacters()).toEqual([]);expect(db.records()[0].character?.source).toBe('recorded');
  });
});
