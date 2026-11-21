import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {KillDailyStore} from '../electron/kill-daily-store';
import {KillHistoryStore} from '../electron/kill-history-store';
import {isKillDailyDate,isKillDailySelectableDate,KILL_DAILY_MIN_DATE,KILL_DAILY_MAX_DATE,killDailyBounds,killDailyDate,shiftKillDailyDate} from '../src/shared/kill-daily';

const databases:DatabaseSync[]=[];
function fixture(){
  const db=new DatabaseSync(':memory:');databases.push(db);
  db.exec(`
    CREATE TABLE kill_count_sessions(id TEXT PRIMARY KEY,character_key TEXT,character_name TEXT,recording_key TEXT UNIQUE,time_basis TEXT,anchor_ms REAL,status TEXT,updated_at TEXT,identity_source TEXT);
    CREATE TABLE kill_count_intervals(id TEXT PRIMARY KEY,session_id TEXT,source_key TEXT,start_ms REAL,end_ms REAL);
    CREATE TABLE kill_count_events(id TEXT PRIMARY KEY,session_id TEXT,character_key TEXT,recording_key TEXT,monster_id INTEGER,target_id INTEGER,lifecycle_id TEXT,event_ms REAL,personal INTEGER,observed_at TEXT,source_hash TEXT,monster_name TEXT,proof_json TEXT);
    CREATE INDEX kill_count_events_session_time ON kill_count_events(session_id,event_ms);
    CREATE TABLE kill_count_totals(recording_key TEXT,character_key TEXT,monster_id INTEGER,personal INTEGER,observed INTEGER,unknown INTEGER,last_killed_ms REAL,monster_name TEXT,PRIMARY KEY(recording_key,monster_id));
    CREATE TABLE monster_database(monster_id INTEGER,name TEXT);
    CREATE TABLE target_hunt_candidates(monster_id INTEGER,clock_ms REAL,event_ms REAL,time_basis TEXT);
    CREATE TABLE target_hunt_observations(candidate_id TEXT);
    CREATE TABLE target_hunt_intervals(segment_id TEXT,start_ms REAL,end_ms REAL);
    CREATE TABLE finance_transactions(id TEXT,data_json TEXT);
    INSERT INTO finance_transactions VALUES('legacy','{"quantity":1234,"price":42}');
  `);
  const daily=new KillDailyStore(db),history=new KillHistoryStore(db);
  const session=(id:string,character='c1',basis='replay-start',start='2026-11-04T20:00:00Z')=>db.prepare('INSERT INTO kill_count_sessions VALUES(?,?,?,?,?,?,?,?,?)').run(id,character,character,id,basis,Date.parse(start),'stopped','2026-11-05T12:00:00Z','metadata');
  const event=(id:string,at:string,recording='r1',monster=1313,personal=0)=>{
    const record=db.prepare('SELECT * FROM kill_count_sessions WHERE id=?').get(recording)!,clock=Date.parse(at),character=String(record.character_key);
    db.prepare('INSERT INTO kill_count_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,recording,character,recording,monster,1,id,clock-Number(record.anchor_ms),personal,'2026-11-05T12:00:00Z','hash',monster===1313?'Mobster':'Seal','{}');
    db.prepare('INSERT INTO kill_count_totals VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(recording_key,monster_id) DO UPDATE SET personal=personal+excluded.personal,observed=observed+1,unknown=unknown+excluded.unknown,last_killed_ms=MAX(last_killed_ms,excluded.last_killed_ms)').run(recording,character,monster,personal,1,personal?0:1,clock,monster===1313?'Mobster':'Seal');
  };
  const span=(id:string,recording:string,start:string,end:string)=>db.prepare('INSERT INTO kill_count_intervals VALUES(?,?,?,?,?)').run(id,recording,id,Date.parse(start),Date.parse(end));
  return{db,daily,history,session,event,span};
}
afterEach(()=>{for(const db of databases.splice(0))db.close();});

describe('daily Kill Count calendar projections',()=>{
  it('uses Turkey midnight with a half-open day and keeps processing time separate',()=>{
    const{daily,session,event,span}=fixture();session('r1');
    event('before','2026-11-04T20:59:59.999Z');event('midnight','2026-11-04T21:00:00Z');event('last','2026-11-05T20:59:59.999Z');event('tomorrow','2026-11-05T21:00:00Z');
    span('all','r1','2026-11-04T20:30:00Z','2026-11-05T21:30:00Z');
    const day=daily.read({date:'2026-11-05'});
    expect(day).toMatchObject({date:'2026-11-05',timeZone:'Europe/Istanbul',undatedDeaths:0,totals:{observedDeaths:2,durationMs:86400000,monsterTypes:1,timeBasis:'replay-start'}});
    expect(day.days).toHaveLength(7);expect(day.days[0].date).toBe('2026-10-30');expect(day.days.at(-2)).toEqual({date:'2026-11-04',observedDeaths:1});expect(day.days.at(-1)).toEqual({date:'2026-11-05',observedDeaths:2});
    expect(day.monsters[0]).toMatchObject({monsterId:1313,lastKilledAt:'2026-11-05T20:59:59.999Z',totals:{observedDeaths:2}});
    expect(daily.read({date:'2026-11-06'}).totals.observedDeaths).toBe(1);
  });
  it('unions overlapping sources and clips durations while respecting character filters',()=>{
    const{daily,db,session,event,span}=fixture();session('r1');session('r2','c2');
    event('a','2026-11-04T21:10:00Z','r1',1317,1);event('b','2026-11-04T21:20:00Z','r2',1313,1);
    span('one','r1','2026-11-04T20:30:00Z','2026-11-04T22:00:00Z');span('two','r2','2026-11-04T21:30:00Z','2026-11-04T23:00:00Z');span('same-recording','r1','2026-11-04T21:40:00Z','2026-11-04T21:45:00Z');
    db.prepare('INSERT INTO monster_database VALUES(?,?)').run(1317,'Yerel Seal');
    const all=daily.read({date:'2026-11-05'});expect(all.totals).toMatchObject({observedDeaths:2,durationMs:7200000,monsterTypes:2,uncertain:true,totalKills:null,range:{min:1,max:2}});
    const character=daily.read({date:'2026-11-05',characterKey:'c1'});expect(character.totals).toMatchObject({observedDeaths:1,durationMs:3600000,totalKills:1,uncertain:false});expect(character.monsters.map(monster=>monster.monsterName)).toEqual(['Yerel Seal']);
    expect(daily.read({date:'2026-11-05',characterKey:'missing'}).totals).toMatchObject({observedDeaths:0,durationMs:0,monsterTypes:0,totalKills:null});
  });
  it('retains undated records separately and never invents a calendar date from observation anchors',()=>{
    const{daily,session,event,span}=fixture();session('known');session('unknown','c1','observation-anchor');session('other','c2','observation-anchor');
    event('a','2026-11-04T22:00:00Z','known');event('b','2026-11-04T22:00:00Z','unknown');event('c','2026-11-04T22:00:00Z','other');
    span('known-time','known','2026-11-04T21:00:00Z','2026-11-04T22:00:00Z');span('unknown-time','unknown','2026-11-04T21:00:00Z','2026-11-05T12:00:00Z');
    const all=daily.read({date:'2026-11-05'});expect(all.totals).toMatchObject({observedDeaths:1,durationMs:3600000});expect(all.undatedDeaths).toBe(2);expect(all.days.at(-1)?.observedDeaths).toBe(1);
    expect(daily.read({date:'2026-11-05',characterKey:'c1'}).undatedDeaths).toBe(1);
  });
  it('validates the full query and actual calendar days before reading the database',()=>{
    const{daily,history}=fixture();for(const value of [null,[],{}, {date:'2026-02-29'},{date:'2026-13-01'},{date:'2026-1-01'},{date:'2026-11-05T00:00:00Z'},{date:'2026-11-05',unknown:true},{date:'2026-11-05',characterKey:''},{date:'2026-11-05',characterKey:'bad\nkey'},{date:'2026-11-05',characterKey:3}])expect(()=>daily.read(value)).toThrow();
    for(const date of ['2026-02-29','nope',123])expect(()=>history.events({date})).toThrow();
    expect(()=>history.records({date:'2026-11-05'})).toThrow();
  });
  it('accepts first and last selectable dates and rejects dates outside the shared calendar range',()=>{
    const{daily,history}=fixture();
    for(const date of [KILL_DAILY_MIN_DATE,KILL_DAILY_MAX_DATE]){
      expect(isKillDailySelectableDate(date)).toBe(true);const state=daily.read({date});expect(state.date).toBe(date);expect(state.days).toHaveLength(7);expect(state.days.at(-1)?.date).toBe(date);expect(state.totals.observedDeaths).toBe(0);expect(history.events({date}).items).toEqual([]);
    }
    for(const date of ['0001-01-01','0001-01-06','9999-12-31']){
      expect(isKillDailyDate(date)).toBe(true);expect(isKillDailySelectableDate(date)).toBe(false);expect(()=>daily.read({date})).toThrow(/geçersiz/);expect(()=>history.events({date})).toThrow(/geçersiz/);
    }
  });
  it('date-scopes event detail pages and cursors without losing duplicate timestamps',()=>{
    const{history,session,event}=fixture();session('r1');session('unknown','c1','observation-anchor');
    event('previous','2026-11-04T20:59:59.999Z');event('next','2026-11-05T21:00:00Z');event('undated','2026-11-04T22:00:00Z','unknown');
    for(let i=0;i<30;i++)event(`e${i}`,'2026-11-04T22:00:00Z');
    const first=history.events({date:'2026-11-05',limit:25}),second=history.events({date:'2026-11-05',after:first.nextCursor,limit:25});
    expect(first.scope.date).toBe('2026-11-05');expect(first.items).toHaveLength(25);expect(second.items).toHaveLength(5);expect(new Set([...first.items,...second.items].map(item=>item.id)).size).toBe(30);
    expect([...first.items,...second.items].every(item=>item.id.startsWith('e'))).toBe(true);
    expect(()=>history.events({date:'2026-11-04',after:first.nextCursor})).toThrow(/kapsama/);expect(()=>history.events({after:first.nextCursor})).toThrow(/kapsama/);
    expect(history.events({date:'2026-11-05',recordingKey:'r1',monsterId:1313,characterKey:'c1',limit:100}).items).toHaveLength(30);
  });
  it('repeated daily and detail reads preserve archive rows, overall totals and finance',()=>{
    const{db,daily,history,session,event,span}=fixture();session('r1');event('a','2026-11-04T22:00:00Z');span('source','r1','2026-11-04T21:00:00Z','2026-11-04T23:00:00Z');
    const snapshot=()=>['kill_count_sessions','kill_count_events','kill_count_totals','kill_count_intervals','finance_transactions'].map(table=>JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()));const before=snapshot();
    const first=daily.read({date:'2026-11-05'});for(let i=0;i<3;i++){expect(daily.read({date:'2026-11-05'})).toEqual(first);daily.read({date:'2026-11-04'});history.events({date:'2026-11-05'});}expect(snapshot()).toEqual(before);
  });
});

describe('daily calendar helpers',()=>{
  it('uses Istanbul instead of the host timezone and handles valid leap days',()=>{
    expect(killDailyDate(new Date('2026-11-04T21:00:00Z'))).toBe('2026-11-05');expect(killDailyDate(new Date('2026-11-04T20:59:59Z'))).toBe('2026-11-04');
    expect(killDailyBounds('2026-11-05')).toEqual({startMs:Date.parse('2026-11-04T21:00:00Z'),endMs:Date.parse('2026-11-05T21:00:00Z')});
    expect(isKillDailyDate('2024-02-29')).toBe(true);expect(isKillDailyDate('2026-02-29')).toBe(false);expect(isKillDailyDate('0000-01-01')).toBe(false);expect(shiftKillDailyDate('2024-03-01',-1)).toBe('2024-02-29');
  });
  it('resolves historical Istanbul offsets from IANA timezone data',()=>{
    expect(killDailyBounds('2015-01-01')).toEqual({startMs:Date.parse('2014-12-31T22:00:00Z'),endMs:Date.parse('2015-01-01T22:00:00Z')});
    expect(killDailyBounds('2015-07-01')).toEqual({startMs:Date.parse('2015-06-30T21:00:00Z'),endMs:Date.parse('2015-07-01T21:00:00Z')});
  });
  it('can resolve the upper calendar boundary without truncating its extended ISO year',()=>{
    const bounds=killDailyBounds('9999-12-31');expect(Number.isFinite(bounds.startMs)).toBe(true);expect(Number.isFinite(bounds.endMs)).toBe(true);expect(bounds.endMs-bounds.startMs).toBe(86400000);expect(new Date(bounds.endMs).toISOString()).toBe('9999-12-31T21:00:00.000Z');
  });
});
