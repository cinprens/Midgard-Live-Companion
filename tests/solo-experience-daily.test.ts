import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {SoloExperienceDailyStore,SOLO_EXPERIENCE_DAILY_SCHEMA} from '../electron/solo-experience-daily-store';
import {ExpansionStore} from '../electron/expansion-store';
import {killDailyBounds} from '../src/shared/kill-daily';

const cleanups:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
function fixture(){
 const db=new DatabaseSync(':memory:');cleanups.push(()=>db.close());
 db.exec('PRAGMA foreign_keys=ON;CREATE TABLE kill_experience_sessions(id TEXT PRIMARY KEY,character_key TEXT,data_json TEXT);'+SOLO_EXPERIENCE_DAILY_SCHEMA);
 const read=new SoloExperienceDailyStore(db);
 function session(id:string,key='one',deaths=0,base=0,job=0,duration=0,mode='single',attributionPolicy:string|undefined='own-damage-v1'){
  db.prepare('INSERT INTO kill_experience_sessions VALUES(?,?,?)').run(id,key,JSON.stringify({characterName:`Character ${key}`,mode,attributionPolicy,observedDeaths:deaths,durationMs:duration,base:{knownGained:base,missingDeaths:0},job:{knownGained:job,missingDeaths:0}}));
  if(mode==='single')db.prepare('INSERT INTO solo_experience_calendar_sessions VALUES(?,?,?,?,?,?,?)').run(id,key,`Character ${key}`,0,'2026-11-01T00:00:00','Europe/Istanbul',1);
 }
 function award(id:string,key:string,at:number,base:number|null,job:number|null,event=String(at)){db.prepare('INSERT INTO solo_experience_calendar_awards VALUES(?,?,?,?,?,?,?)').run(id,event,key,at,1313,base,job);}
 function interval(id:string,key:string,start:number,end:number,suffix=''){db.prepare('INSERT INTO solo_experience_calendar_intervals VALUES(?,?,?,?,?)').run(`${id}/${start}/${end}/${suffix}`,id,key,start,end);}
 return{db,read,session,award,interval};
}

describe('solo EXP Istanbul daily archive',()=>{
 it('excludes legacy environment totals, dated awards and intervals without rewriting the archive',()=>{
  const f=fixture(),start=killDailyBounds('2026-11-05').startMs;
  f.session('legacy','one',7,700,70,60000);f.session('new','one',1,100,10,10000);
  const legacy=JSON.parse(String(f.db.prepare('SELECT data_json FROM kill_experience_sessions WHERE id=?').get('legacy')?.data_json));delete legacy.attributionPolicy;
  f.db.prepare('UPDATE kill_experience_sessions SET data_json=? WHERE id=?').run(JSON.stringify(legacy),'legacy');
  f.award('legacy','one',start+1,700,70);f.interval('legacy','one',start,start+60000);
  f.award('new','one',start+2,100,10);f.interval('new','one',start,start+10000);
  const before=f.db.prepare('SELECT * FROM kill_experience_sessions ORDER BY id').all();
  for(const scopeMode of ['all','daily'])expect(f.read.read({date:'2026-11-05',scopeMode})).toMatchObject({undatedObservedDeaths:0,totals:{observedDeaths:1,durationMs:10000,base:{gained:100,perHour:36000}}});
  expect(f.db.prepare('SELECT * FROM kill_experience_sessions ORDER BY id').all()).toEqual(before);
  expect(f.db.prepare('SELECT COUNT(*) n FROM solo_experience_calendar_awards').get()?.n).toBe(2);
 });
 it('assigns midnight once and divides Replay time between the two days',()=>{
  const f=fixture(),midnight=killDailyBounds('2026-11-05').startMs;
  f.session('s','one',2,300,30,20000);f.award('s','one',midnight-5000,100,10);f.award('s','one',midnight,200,20);f.interval('s','one',midnight-10000,midnight+10000);
  const yesterday=f.read.read({date:'2026-11-04'}),today=f.read.read({date:'2026-11-05'});
  expect(yesterday.totals).toMatchObject({observedDeaths:1,durationMs:10000,base:{gained:100,perHour:36000}});
  expect(today.totals).toMatchObject({observedDeaths:1,durationMs:10000,base:{gained:200,perHour:72000}});
  expect(today.days.at(-2)).toMatchObject({date:'2026-11-04',observedDeaths:1});
  expect(f.read.read({date:'2026-11-05',scopeMode:'all'}).totals).toMatchObject({observedDeaths:2,durationMs:20000,base:{gained:300}});
 });
 it('distinguishes a tracked zero-gain day from a day with no observation',()=>{
  const f=fixture(),start=killDailyBounds('2026-11-05').startMs;f.session('s');f.interval('s','one',start,start+10000);
  expect(f.read.read({date:'2026-11-05'}).totals).toMatchObject({hasData:true,observedDeaths:0,base:{gained:0,perHour:0}});
  expect(f.read.read({date:'2026-11-06'}).totals).toMatchObject({hasData:false,observedDeaths:0,base:{perHour:null}});
 });
 it('unions duplicate same-character coverage but sums different character hours',()=>{
  const f=fixture(),start=killDailyBounds('2026-11-05').startMs;f.session('a','one',1,100,10,10000);f.session('b','two',1,200,20,10000);
  f.award('a','one',start+1,100,10);f.award('b','two',start+1,200,20);
  f.interval('a','one',start,start+10000);f.interval('a','one',start,start+10000,'duplicate');f.interval('b','two',start,start+10000);
  expect(f.read.read({date:'2026-11-05'}).totals).toMatchObject({durationMs:20000,base:{gained:300,perHour:54000}});
  const selected=f.read.read({date:'2026-11-05',characterKey:'one'});expect(selected.totals).toMatchObject({durationMs:10000,observedDeaths:1,base:{gained:100}});expect(selected.characters).toHaveLength(2);
 });
 it('preserves blank versus zero and keeps historical award values frozen',()=>{
  const f=fixture(),start=killDailyBounds('2026-11-05').startMs;f.session('s','one',2,300,0,10000);f.award('s','one',start+1,100,null);f.award('s','one',start+2,200,0);f.interval('s','one',start,start+10000);
  const result=f.read.read({date:'2026-11-05'});expect(result.totals).toMatchObject({base:{gained:300,missingDeaths:0},job:{gained:null,knownGained:0,missingDeaths:1,perHour:null}});
  f.db.exec('CREATE TABLE kill_experience_rates(base_exp INTEGER);INSERT INTO kill_experience_rates VALUES(999999);');
  expect(f.read.read({date:'2026-11-05'}).totals).toEqual(result.totals);
 });
 it('retains previous measurements in All and never invents legacy dates or mixes party sessions',()=>{
  const f=fixture(),start=killDailyBounds('2026-11-05').startMs;
  f.session('old','one',5,500,50,5000);f.session('new','one',2,400,40,10000);f.session('party','one',999,99999,99999,999999,'party');
  f.award('new','one',start+1,200,20,'a');f.award('new','one',start+2,200,20,'b');f.interval('new','one',start,start+10000);
  expect(f.read.read({date:'2026-11-05',scopeMode:'all'})).toMatchObject({undatedObservedDeaths:5,totals:{observedDeaths:7,durationMs:15000,base:{gained:900}}});
  expect(f.read.read({date:'2026-11-05'})).toMatchObject({undatedObservedDeaths:5,totals:{observedDeaths:2,base:{gained:400}}});
 });
 it.each([null,{}, {date:'2026-02-30'},{date:'2026-11-05',scopeMode:'weekly'},{date:'2026-11-05',unknown:true},{date:'2026-11-05',characterKey:''}])('rejects malformed requests %j',query=>{expect(()=>fixture().read.read(query)).toThrow();});
 it('returns bounded daily summaries from a large indexed synthetic archive',()=>{
  const f=fixture(),start=killDailyBounds('2026-10-01').startMs;f.session('s','one',20000,20000,20000,0);f.db.exec('BEGIN');
  for(let i=0;i<20000;i++)f.award('s','one',start+(i%100)*86400000+i,1,1,String(i));f.db.exec('COMMIT');
  const started=performance.now(),result=f.read.read({date:'2026-11-05'}),elapsed=performance.now()-started;
  expect(result.days).toHaveLength(7);expect(result.totals.observedDeaths).toBe(200);expect(JSON.stringify(result).length).toBeLessThan(20000);expect(elapsed).toBeLessThan(3000);
  expect(f.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM solo_experience_calendar_awards WHERE at_ms>=? AND at_ms<?').all(start,start+86400000).some(row=>String(row.detail).includes('INDEX'))).toBe(true);
 });
 it('backs up committed WAL state before migrating v11, preserving prior data and preferences',async()=>{
  const base=path.resolve('.qa');await mkdir(base,{recursive:true});const dir=await mkdtemp(path.join(base,'solo-daily-migration-'));
  cleanups.push(async()=>{expect(path.resolve(dir).startsWith(base+path.sep)).toBe(true);await rm(dir,{recursive:true,force:true});});
  const file=path.join(dir,'profile.sqlite'),seed=new ExpansionStore(file);seed.setSetting('live-view',{appearanceByCharacter:{one:'feminine-1'}});seed.setSetting('notification-targets',[1313]);seed.autoFarm.setPrice({itemId:603,unitPrice:123});seed.killExperience.setRate({characterKey:'one',monsterId:1313,baseExp:3289,jobExp:606});seed.close();
  const writer=new DatabaseSync(file);cleanups.push(()=>writer.close());writer.exec('PRAGMA journal_mode=WAL;DROP TABLE solo_experience_calendar_awards;DROP TABLE solo_experience_calendar_intervals;DROP TABLE solo_experience_calendar_sessions;DELETE FROM expansion_migrations WHERE version>=12;');
  writer.prepare('INSERT INTO expansion_settings VALUES(?,?)').run('wal-sentinel','{"preserved":true}');
  const settings=writer.prepare('SELECT * FROM expansion_settings ORDER BY key').all(),rates=writer.prepare('SELECT * FROM kill_experience_rates').all();
  const upgraded=new ExpansionStore(file);cleanups.push(()=>upgraded.close());expect(upgraded.soloExperienceMigrationBackupPath).toBeTruthy();
  const backup=new DatabaseSync(upgraded.soloExperienceMigrationBackupPath!,{readOnly:true});try{expect(backup.prepare('SELECT MAX(version) v FROM expansion_migrations').get()?.v).toBe(11);expect(backup.prepare('SELECT * FROM expansion_settings ORDER BY key').all()).toEqual(settings);expect(backup.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');}finally{backup.close();}
  expect(writer.prepare('SELECT MAX(version) v FROM expansion_migrations').get()?.v).toBe(13);expect(writer.prepare('SELECT * FROM expansion_settings ORDER BY key').all()).toEqual(settings);expect(writer.prepare('SELECT * FROM kill_experience_rates').all()).toEqual(rates);expect(upgraded.autoFarm.snapshot().prices[0].unitPrice).toBe(123);expect(writer.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect(writer.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');
 });
});
