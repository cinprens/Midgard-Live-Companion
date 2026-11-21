import {describe,it,expect,afterEach} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {KillHistoryStore} from '../electron/kill-history-store';

const databases:DatabaseSync[]=[];
const anchor=Date.parse('2026-11-02T10:00:00Z');
function fixture(){
  const db=new DatabaseSync(':memory:');databases.push(db);
  db.exec(`
    CREATE TABLE kill_count_sessions(id TEXT PRIMARY KEY,character_key TEXT,character_name TEXT,recording_key TEXT UNIQUE,time_basis TEXT,anchor_ms REAL,status TEXT,updated_at TEXT,identity_source TEXT);
    CREATE TABLE kill_count_intervals(id TEXT PRIMARY KEY,session_id TEXT,source_key TEXT,start_ms REAL,end_ms REAL);
    CREATE TABLE kill_count_events(id TEXT PRIMARY KEY,session_id TEXT,character_key TEXT,recording_key TEXT,monster_id INTEGER,target_id INTEGER,lifecycle_id TEXT,event_ms REAL,personal INTEGER,observed_at TEXT,source_hash TEXT,monster_name TEXT,proof_json TEXT);
    CREATE TABLE kill_count_totals(recording_key TEXT,character_key TEXT,monster_id INTEGER,personal INTEGER,observed INTEGER,unknown INTEGER,last_killed_ms REAL,monster_name TEXT,PRIMARY KEY(recording_key,monster_id));
    CREATE TABLE target_hunt_candidates(id TEXT PRIMARY KEY,monster_id INTEGER,monster_name TEXT,map_id TEXT,target_id INTEGER,clock_ms REAL,event_ms REAL,time_basis TEXT,segment_id TEXT,source_key TEXT);
    CREATE TABLE target_hunt_observations(source_key TEXT,recording_key TEXT,event_key TEXT,candidate_id TEXT,event_ms REAL);
    CREATE TABLE target_hunt_intervals(id TEXT PRIMARY KEY,segment_id TEXT,source_key TEXT,start_ms REAL,end_ms REAL);
    CREATE TABLE finance_transactions(id TEXT PRIMARY KEY,data_json TEXT);
    INSERT INTO finance_transactions VALUES('legacy','{"quantity":1234,"price":42}');
  `);
  const reader=new KillHistoryStore(db);
  const record=(key='r1',character='c1',basis='replay-start')=>{db.prepare('INSERT INTO kill_count_sessions VALUES(?,?,?,?,?,?,?,?,?)').run(key,character,`Oyuncu ${character}`,key,basis,anchor,'stopped','2026-11-02T19:00:00Z','metadata');};
  const event=(id:string,time:number,recording='r1',monster=1313,personal=0)=>{const s=db.prepare('SELECT * FROM kill_count_sessions WHERE recording_key=?').get(recording)!;db.prepare('INSERT INTO kill_count_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,recording,String(s.character_key),recording,monster,Number(id.replace(/\D/g,''))||1,id,time,personal,'2026-11-02T19:00:00Z','sha',monster===1313?'Mobster':`Canavar ${monster}`,'{}');};
  const candidate=(id:string,time:number|null,options:{map?:string|null;segment?:string;monster?:number;basis?:string;replay?:number;observations?:number}={})=>{const monster=options.monster??1313;db.prepare('INSERT INTO target_hunt_candidates VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,monster,'Mobster',options.map===undefined?'pay_dun':options.map,1,time,options.replay??time??0,options.basis??(time===null?'local-record':'replay-clock'),options.segment??'segment-1','source1');for(let i=0;i<(options.observations??1);i++)db.prepare('INSERT INTO target_hunt_observations VALUES(?,?,?,?,?)').run(`source${i}`,`record${i}`,id,id,options.replay??time??0);};
  const cover=(start:number,end:number,segment='segment-1')=>db.prepare('INSERT INTO target_hunt_intervals VALUES(?,?,?,?,?)').run(`i-${start}-${end}-${segment}`,segment,'source',start,end);
  return{db,reader,record,event,candidate,cover};
}
afterEach(()=>{for(const db of databases.splice(0))db.close();});

describe('bounded Kill Count archive readers',()=>{
  it('validates query documents, limits, keys, monster IDs and cursor scope',()=>{
    const{reader,record,event}=fixture();record();for(let i=0;i<30;i++)event(`e${i}`,i);
    for(const value of [null,[],{limit:1},{limit:'25'},{limit:101},{recordingKey:''},{characterKey:'bad\nkey'},{unknown:true},{monsterId:0},{monsterId:1.5},{after:'!'}])expect(()=>reader.events(value)).toThrow();
    expect(()=>reader.records({monsterId:1313})).toThrow();expect(()=>reader.rhythm({monsterId:1313,limit:100})).toThrow();expect(()=>reader.rhythm({monsterId:1313,characterKey:'c1'})).toThrow();
    const page=reader.events({recordingKey:'r1',limit:25});expect(page.nextCursor).not.toBeNull();
    expect(()=>reader.events({recordingKey:'different',after:page.nextCursor})).toThrow(/kapsama/);
    expect(()=>reader.events({recordingKey:'r1',monsterId:1313,after:page.nextCursor})).toThrow(/kapsama/);
    expect(()=>reader.records({after:page.nextCursor})).toThrow(/kapsama/);
    const forged=Buffer.from(JSON.stringify({version:1,kind:'events',scope:'wrong',position:[0,1]})).toString('base64url');expect(()=>reader.events({after:forged})).toThrow();
  });
  it('pages recording identities and retrieves a persisted old recording by exact key',()=>{
    const{reader,record}=fixture();for(let i=0;i<55;i++)record(`r${i}`,i%2?'a':'b');
    const one=reader.records({limit:25}),two=reader.records({limit:25,after:one.nextCursor});
    expect(one.items).toHaveLength(25);expect(two.items).toHaveLength(25);expect(new Set([...one.items,...two.items].map(item=>item.recordingKey)).size).toBe(50);
    const filtered=reader.records({characterKey:'a',limit:100});expect(filtered.items).toHaveLength(27);expect(filtered.items.every(item=>item.characterKey==='a')).toBe(true);
    expect(reader.records({recordingKey:'r0'}).items.map(item=>item.recordingKey)).toEqual(['r0']);
    expect(()=>reader.records({characterKey:'a',after:one.nextCursor})).toThrow();
  });
  it('unions overlapping record intervals and reads materialized observation counts',()=>{
    const{reader,record,db}=fixture();record();db.exec(`INSERT INTO kill_count_intervals VALUES('a','r1','s1',${anchor},${anchor+3600000}),('b','r1','s2',${anchor+1800000},${anchor+7200000}),('c','r1','s3',${anchor+3000},${anchor+4000}); INSERT INTO kill_count_totals VALUES('r1','c1',1313,0,34,34,${anchor+1000},'Mobster');`);
    expect(reader.records().items[0]).toMatchObject({recordingKey:'r1',startedAt:'2026-11-02T10:00:00.000Z',endedAt:'2026-11-02T12:00:00.000Z',durationMs:7200000,observedDeaths:34,confirmedPersonalKills:0,unknownDeaths:34,monsterTypes:1});
  });
  it('keeps archive ingestion order separate from a selected recording Replay chronology',()=>{
    const{reader,record,event}=fixture();record();event('early',100);event('latest',900);event('late-arrival',200);
    expect(reader.events().scope.order).toBe('archive-order-desc');expect(reader.events().items.map(item=>item.id)).toEqual(['late-arrival','latest','early']);
    const selected=reader.events({recordingKey:'r1'});expect(selected.scope.order).toBe('recording-time-desc');expect(selected.items.map(item=>item.id)).toEqual(['latest','late-arrival','early']);
    expect(selected.items[0]).toMatchObject({eventAt:'2026-11-02T10:00:00.900Z',recordedAt:'2026-11-02T19:00:00Z',personal:false});
  });
  it('paginates duplicate timestamps without missing or repeating events and respects filters',()=>{
    const{reader,record,event}=fixture();record();record('r2','c2');for(let i=0;i<35;i++)event(`e${i}`,100);for(let i=0;i<5;i++)event(`x${i}`,500,'r2',1001);
    const first=reader.events({recordingKey:'r1',monsterId:1313,limit:25}),second=reader.events({recordingKey:'r1',monsterId:1313,limit:25,after:first.nextCursor});
    expect(first.items).toHaveLength(25);expect(second.items).toHaveLength(10);expect(second.nextCursor).toBeNull();expect(new Set([...first.items,...second.items].map(item=>item.id)).size).toBe(35);
    expect(reader.events({characterKey:'c2'}).items).toHaveLength(5);expect(reader.events({monsterId:1001}).items.every(item=>item.monsterId===1001)).toBe(true);expect(reader.events({recordingKey:'r1',characterKey:'c2'}).items).toEqual([]);
  });
  it('does not turn observation-anchor or processing timestamps into the actual death clock',()=>{
    const{reader,record,event}=fixture();record('unknown','c1','observation-anchor');event('old',1234,'unknown');
    expect(reader.records().items[0]).toMatchObject({startedAt:null,endedAt:null,timeBasis:'observation-anchor'});
    expect(reader.events().items[0]).toMatchObject({eventAt:null,replayMs:1234,recordedAt:'2026-11-02T19:00:00Z',timeBasis:'observation-anchor',personal:false});
  });
  it('bounds a page at one hundred raw events',()=>{
    const{reader,record,event}=fixture();record();for(let i=0;i<400;i++)event(`e${i}`,i);
    for(const size of [25,50,100] as const){const page=reader.events({limit:size});expect(page.items).toHaveLength(size);expect(page.nextCursor).not.toBeNull();}
  });
  it('computes 4 and 6 minute observed intervals from fully covered candidate pairs',()=>{
    const{reader,candidate,cover}=fixture();candidate('first',10000);candidate('second',250000);candidate('third',610000,{observations:3});cover(0,700000);
    const page=reader.rhythm({monsterId:1313});expect(page.scope).toBe('all-sources');expect(page.items.map(item=>item.intervalMs)).toEqual([360000,240000,null]);expect(page.items[0].rawObservations).toBe(3);
  });
  it('fetches a predecessor outside the returned page and scopes rhythm cursors',()=>{
    const{reader,candidate,cover}=fixture();for(let i=0;i<30;i++)candidate(`c${i}`,i*60000);cover(0,30*60000);
    const first=reader.rhythm({monsterId:1313,limit:25});expect(first.items).toHaveLength(25);expect(first.items.at(-1)?.intervalMs).toBe(60000);
    const second=reader.rhythm({monsterId:1313,limit:25,after:first.nextCursor});expect(second.items).toHaveLength(5);expect(second.items.at(-1)?.intervalMs).toBeNull();expect(new Set([...first.items,...second.items].map(item=>item.id)).size).toBe(30);
    expect(()=>reader.rhythm({monsterId:1001,after:first.nextCursor})).toThrow();
    const malformed=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString('utf8'));malformed.position[0]=2;
    expect(()=>reader.rhythm({monsterId:1313,after:Buffer.from(JSON.stringify(malformed)).toString('base64url')})).toThrow(/saat alanı/);
  });
  it('never bridges a coverage gap, a changed map or a changed continuity segment',()=>{
    const{reader,candidate,cover}=fixture();candidate('a',10000);candidate('b',250000);candidate('c',610000);candidate('d',700000,{map:'other'});candidate('e',800000);candidate('f',900000,{segment:'new'});cover(0,400000);cover(500000,850000);cover(850000,1000000,'new');
    const byId=new Map(reader.rhythm({monsterId:1313}).items.map(item=>[item.id,item]));
    expect(byId.get('b')?.intervalMs).toBe(240000);for(const id of ['a','c','d','e','f'])expect(byId.get(id)?.intervalMs).toBeNull();
  });
  it('keeps missing map and common-clock values unknown and pages unknown clocks separately',()=>{
    const{reader,candidate,cover}=fixture();candidate('a',1000);candidate('no-map',2000,{map:null});for(let i=0;i<28;i++)candidate(`local${i}`,null,{replay:i*1000});cover(0,5000);
    const first=reader.rhythm({monsterId:1313,limit:25}),second=reader.rhythm({monsterId:1313,limit:25,after:first.nextCursor});
    expect(first.items.slice(0,2).map(item=>item.id)).toEqual(['no-map','a']);expect(first.items[0].intervalMs).toBeNull();expect([...first.items,...second.items].filter(item=>item.eventAt===null)).toHaveLength(28);expect(second.items.every(item=>item.intervalMs===null)).toBe(true);
  });
  it('does not mutate legacy ledger or observation rows during archive queries',()=>{
    const{db,reader,record,event,candidate,cover}=fixture();record();event('event',10);candidate('target',10);cover(0,20);
    const snapshot=()=>['finance_transactions','kill_count_sessions','kill_count_events','target_hunt_candidates','target_hunt_intervals'].map(name=>JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all()));
    const before=snapshot();reader.records();reader.events();reader.rhythm({monsterId:1313});expect(snapshot()).toEqual(before);
  });
});
