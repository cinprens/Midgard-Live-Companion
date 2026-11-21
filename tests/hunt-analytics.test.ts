import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {HUNT_ANALYTICS_SCHEMA} from '../electron/hunt-analytics-ingest';
import {HuntAnalyticsStore} from '../electron/hunt-analytics-store';
import {killDailyBounds,shiftKillDailyDate} from '../src/shared/kill-daily';
import {validateHuntAnalyticsQuery,type HuntAnalyticsQuery} from '../src/shared/hunt-analytics';
import {compareHuntMetrics,intersectHuntSpans,overlappingHuntSpans,subtractHuntSpans,unionHuntSpans} from '../src/domain/hunt-analytics';

const databases:DatabaseSync[]=[];
const DATE='2026-11-05',HOUR=3600000;
const query=(extra:Partial<HuntAnalyticsQuery>={}):HuntAnalyticsQuery=>({monsterId:1313,date:DATE,scope:{kind:'character',characterKey:'c1'},reference:'previous-day',trendDays:7,...extra});
function fixture(){
  const db=new DatabaseSync(':memory:');databases.push(db);db.exec(HUNT_ANALYTICS_SCHEMA);const store=new HuntAnalyticsStore(db);
  const changed=()=>db.prepare("UPDATE hunt_analytics_metadata SET value=value+1 WHERE key='revision'").run();
  function record(id:string,character='c1',trusted=true){db.prepare('INSERT INTO hunt_analytics_recordings VALUES(?,?,?,?,?,?,?,?,?)').run(id,character,character,`${DATE}T00:00:00`,killDailyBounds(DATE).startMs,'Europe/Istanbul',1,trusted?'configured':'unknown','strong');changed();}
  function span(id:string,recording:string,date=DATE,hours=1,startHour=0,provenance='prospective',segment='s1'){const start=killDailyBounds(date).startMs+startHour*HOUR;db.prepare('INSERT INTO hunt_analytics_intervals VALUES(?,?,?,?,?,?,?)').run(id,recording,id,segment,start,start+hours*HOUR,provenance);changed();}
  function event(id:string,recording:string,date=DATE,offset=1000,provenance='prospective',target=1,map:string|null='cmd_fild02',segment='s1'){const character=String(db.prepare('SELECT character_key FROM hunt_analytics_recordings WHERE recording_key=?').get(recording)!.character_key);db.prepare('INSERT INTO hunt_analytics_events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,recording,character,1313,'Mobster',map,target,killDailyBounds(date).startMs+offset,offset,segment,provenance);changed();}
  function day(id:string,date:string,hours:number,count:number,character='c1',startHour=0){record(id,character);span(`${id}-span`,id,date,hours,startHour);for(let i=0;i<count;i++)event(`${id}-e${i}`,id,date,startHour*HOUR+1000+i*(hours*HOUR-2000)/Math.max(1,count), 'prospective',i+1);}
  return{db,store,record,span,event,day,changed};
}
afterEach(()=>{for(const db of databases.splice(0))db.close();});

describe('hunt interval algebra',()=>{
  it('unions copies but removes independent recording overlaps without double subtracting',()=>{
    expect(unionHuntSpans([[0,10],[2,6],[10,20]])).toEqual([[0,20]]);
    const overlap=overlappingHuntSpans([[[0,10]],[[5,15]],[[8,12]]]);expect(overlap).toEqual([[5,12]]);
    expect(subtractHuntSpans([[0,15]],overlap)).toEqual([[0,5],[12,15]]);
    expect(intersectHuntSpans([[0,10],[20,30]],[[5,25]])).toEqual([[5,10],[20,25]]);
  });
});

describe('hunt analytics prospective projections',()=>{
  it('distinguishes 50% count growth from a 25% tempo decrease',()=>{
    const f=fixture();f.day('yesterday','2026-11-04',2,40);f.day('today',DATE,4,60);
    const result=f.store.read(query());expect(result.current).toMatchObject({observations:60,durationMs:4*HOUR,ratePerHour:15});expect(result.reference.ratePerHour).toBe(20);expect(result.comparison).toMatchObject({eligible:true,rateChangePercent:-25,countChangePercent:50,referenceEquivalentCount:80});expect(result.insight).toContain('Gözlem adedi %50 arttı; saatlik tempo %25 azaldı');
  });
  it('weights previous seven days by duration and includes tracked zero-observation days',()=>{
    const f=fixture();f.day('one','2026-11-02',1,60);f.day('two','2026-11-03',3,60);f.day('zero','2026-11-04',2,0);f.day('today',DATE,1,40);
    const result=f.store.read(query({reference:'previous-7-days'}));expect(result.reference).toMatchObject({observations:120,durationMs:6*HOUR,ratePerHour:20,trackedDays:3});expect(result.comparison.rateChangePercent).toBe(100);expect(result.comparison.countChangePercent).toBeNull();expect(result.days.find(day=>day.date==='2026-11-04')).toMatchObject({observations:0,ratePerHour:0,durationMs:2*HOUR});expect(result.days.find(day=>day.date==='2026-11-01')).toMatchObject({observations:0,ratePerHour:null,durationMs:0});
  });
  it('applies rate and comparison sample gates and keeps thresholds out of confidence claims',()=>{
    const f=fixture();f.day('old','2026-11-04',1,40);f.day('new',DATE,.1,4);
    let result=f.store.read(query());expect(result.current.ratePerHour).toBeNull();expect(result.comparison.eligible).toBe(false);
    f.span('more','new',DATE,.1,.1);f.event('extra','new',DATE,.15*HOUR);result=f.store.read(query());expect(result.current.ratePerHour).toBe(25);expect(result.comparison.eligible).toBe(false);
  });
  it('requires three reference days and never produces Infinity from zero reference counts',()=>{
    const f=fixture();f.day('old','2026-11-04',3,0);f.day('new',DATE,1,30);
    const zero=f.store.read(query());expect(zero.comparison).toMatchObject({eligible:false,rateChangePercent:null,reason:'Önceki dönemde gözlem yok.'});
    f.event('one','old','2026-11-04');expect(f.store.read(query({reference:'previous-7-days'})).comparison.reason).toContain('3 kayıtlı gün');
  });
  it('deduplicates copied source intervals without excluding already prospective coverage',()=>{
    const f=fixture();f.day('one',DATE,1,10);f.span('copy','one');f.span('reopened','one',DATE,1,0,'legacy');const result=f.store.read(query());expect(result.current).toMatchObject({observations:10,durationMs:HOUR,excludedDurationMs:0});expect(result.quality.partial).toBe(false);
  });
  it('removes both the observations and duration of ambiguous independent overlaps',()=>{
    const f=fixture();f.record('one');f.record('two');f.span('a','one',DATE,2);f.span('b','two',DATE,2,1);
    f.event('first','one',DATE,.5*HOUR);f.event('overlap-a','one',DATE,1.5*HOUR);f.event('overlap-b','two',DATE,1.5*HOUR);f.event('last','two',DATE,2.5*HOUR);
    const result=f.store.read(query());expect(result.current).toMatchObject({observations:2,durationMs:2*HOUR,excludedObservations:2,excludedDurationMs:HOUR,ratePerHour:1});expect(result.quality.partial).toBe(true);expect(result.comparison.rateChangePercent).toBeNull();
  });
  it('does not borrow another recording coverage to make an uncovered event eligible',()=>{
    const f=fixture();f.record('one');f.record('two');f.span('a','one',DATE,1);f.span('b','two',DATE,1,2);f.event('bad','one',DATE,2.5*HOUR);
    expect(f.store.read(query()).current).toMatchObject({observations:0,excludedObservations:1,durationMs:2*HOUR});
  });
  it('excludes legacy or unknown-clock observations without changing archive rows',()=>{
    const f=fixture();f.record('known');f.record('unknown','c1',false);f.span('legacy','known',DATE,1,0,'legacy');f.span('bad-clock','unknown',DATE,1,2);f.event('legacy-event','known',DATE,1000,'legacy');f.event('unknown-event','unknown',DATE,2*HOUR+1000);
    const before=JSON.stringify(f.db.prepare('SELECT * FROM hunt_analytics_events').all()),result=f.store.read(query());expect(result.current).toMatchObject({observations:0,durationMs:0,excludedObservations:2,excludedDurationMs:2*HOUR});expect(result.quality.partial).toBe(true);expect(JSON.stringify(f.db.prepare('SELECT * FROM hunt_analytics_events').all())).toBe(before);
  });
  it('clamps current days at Istanbul midnight with no processing-time attribution',()=>{
    const f=fixture();f.record('one');f.span('around','one',DATE,2,-1);f.event('before','one',DATE,-1);f.event('midnight','one',DATE,0);f.event('next','one',DATE,86400000);
    expect(f.store.read(query()).current).toMatchObject({observations:1,durationMs:HOUR});
  });
  it('bounds the 28-day series and does not hide valid current comparison for older legacy data',()=>{
    const f=fixture();f.day('old','2026-11-04',1,20);f.day('new',DATE,1,30);f.record('legacy');f.span('legacy-span','legacy','2026-10-15',1,0,'legacy');f.event('legacy-e','legacy','2026-10-15',1000,'legacy');
    const result=f.store.read(query({trendDays:28}));expect(result.days).toHaveLength(28);expect(result.days[0].date).toBe(shiftKillDailyDate(DATE,-27));expect(result.comparison.eligible).toBe(true);expect(result.days.find(day=>day.date==='2026-10-15')?.partial).toBe(true);
  });
});

describe('estimated shared hunt scope',()=>{
  const shared=()=>query({scope:{kind:'shared',characterKeys:['c1','c2','c3']}});
  it('counts 100 common candidates from 300 raw observations with one union per character',()=>{
    const f=fixture();for(const character of ['c1','c2','c3'])f.day(character,DATE,1,100,character);f.span('duplicate-source','c1');
    const result=f.store.read(shared());expect(result.current).toMatchObject({observations:100,durationMs:HOUR,ratePerHour:100,excludedObservations:0});expect(result.durationBasis).toBe('shared-complete-replay');expect(f.db.prepare('SELECT COUNT(*) count FROM hunt_analytics_events').get()?.count).toBe(300);const evidence=f.store.evidence({...shared(),limit:25});expect(evidence.items.every(item=>item.rawObservations===3)).toBe(true);expect(evidence.total).toBe(100);
  });
  it('clips numerator to precisely the complete character coverage intersection',()=>{
    const f=fixture();f.record('one');f.record('two','c2');f.span('a','one',DATE,2);f.span('b','two',DATE,1,1);f.event('outside','one',DATE,.5*HOUR);f.event('inside-a','one',DATE,1.5*HOUR);f.event('inside-b','two',DATE,1.5*HOUR+500);
    const result=f.store.read(query({scope:{kind:'shared',characterKeys:['c1','c2']}}));expect(result.current).toMatchObject({observations:1,durationMs:HOUR,ratePerHour:1,excludedObservations:1,excludedDurationMs:HOUR});expect(result.quality.partial).toBe(true);
  });
  it('cannot derive common coverage from two files of the same character',()=>{
    const f=fixture();f.day('one',DATE,1,10);f.span('copy','one');const result=f.store.read(query({scope:{kind:'shared',characterKeys:['c1','absent']}}));expect(result.current.observations).toBe(0);expect(result.current.durationMs).toBe(0);
  });
  it('keeps distinct actors/maps and repeated deaths of one character separate',()=>{
    const f=fixture();f.record('one');f.record('two','c2');f.span('a','one');f.span('b','two');f.event('a1','one',DATE,1000);f.event('a2','one',DATE,1200);f.event('b1','two',DATE,1300);f.event('other-map','two',DATE,1400,'prospective',1,'other');f.event('other-actor','two',DATE,1500,'prospective',2);
    expect(f.store.read(query({scope:{kind:'shared',characterKeys:['c1','c2']}})).current.observations).toBe(4);
  });
  it('does not chain matching across more than 1500ms and marks unmatchable map data partial',()=>{
    const f=fixture();for(const [id,character]of [['one','c1'],['two','c2'],['three','c3']]){f.record(id,character);f.span(id,id);}
    f.event('a','one',DATE,1000);f.event('b','two',DATE,2000);f.event('c','three',DATE,3000);f.event('missing-map','one',DATE,5000,'prospective',2,null);
    const result=f.store.read(shared());expect(result.current).toMatchObject({observations:2,excludedObservations:1});expect(result.quality.partial).toBe(true);
  });
  it('keeps a candidate crossing midnight on its first observation day in both summary and evidence',()=>{
    const f=fixture();f.record('one');f.record('two','c2');f.span('a','one',DATE,2,-1);f.span('b','two',DATE,2,-1);f.event('before','one',DATE,-500);f.event('after','two',DATE,500);
    const q=query({scope:{kind:'shared',characterKeys:['c1','c2']}});expect(f.store.read(q).current.observations).toBe(0);expect(f.store.evidence(q).total).toBe(0);
    const previous={...q,date:'2026-11-04'};expect(f.store.read(previous).current.observations).toBe(1);expect(f.store.evidence(previous)).toMatchObject({total:1,items:[{rawObservations:2}]});
  });
  it('computes rhythm only across fully covered same-map same-segment intervals',()=>{
    const f=fixture();f.record('one');f.record('two','c2');f.span('a','one');f.span('b','two');for(let i=0;i<6;i++){f.event(`a${i}`,'one',DATE,1000+i*60000,'prospective',i);f.event(`b${i}`,'two',DATE,1000+i*60000,'prospective',i);}
    // Target zero cannot be matched; the remaining five candidates give four valid intervals.
    const q=query({scope:{kind:'shared',characterKeys:['c1','c2']}});expect(f.store.read(q).rhythm).toMatchObject({validIntervals:4,medianMs:null});
    f.event('a6','one',DATE,361000,'prospective',6);f.event('b6','two',DATE,361000,'prospective',6);expect(f.store.read(q).rhythm).toMatchObject({validIntervals:5,medianMs:60000,p25Ms:60000,p75Ms:60000});
    f.event('changed-segment-a','one',DATE,421000,'prospective',7,'cmd_fild02','s2');f.event('changed-segment-b','two',DATE,421000,'prospective',7,'cmd_fild02','s2');expect(f.store.read(q).rhythm?.validIntervals).toBe(5);
  });
});

describe('hunt query boundaries and evidence',()=>{
  it('validates bounded scope, dates, controls and canonical character order',()=>{
    for(const value of [null,{},query({monsterId:0}),query({date:'2026-02-29'}),query({scope:{kind:'shared',characterKeys:['c1']}}),query({scope:{kind:'shared',characterKeys:['c1','c1']}}),{...query(),surprise:true},{...query(),trendDays:365}])expect(()=>validateHuntAnalyticsQuery(value)).toThrow();
    expect(validateHuntAnalyticsQuery(query({scope:{kind:'shared',characterKeys:['z','a']}})).scope).toEqual({kind:'shared',characterKeys:['a','z']});
  });
  it('paginates repeated timestamps without duplicates and binds cursors to scope and revision',()=>{
    const f=fixture();f.record('one');f.span('span','one');for(let i=0;i<63;i++)f.event(`e${i}`,'one');
    const first=f.store.evidence({...query(),limit:25}),second=f.store.evidence({...query(),after:first.nextCursor,limit:25}),third=f.store.evidence({...query(),after:second.nextCursor,limit:25});expect(first.total).toBe(63);expect(first.items).toHaveLength(25);expect(second.items).toHaveLength(25);expect(third.items).toHaveLength(13);expect(third.nextCursor).toBeNull();expect(new Set([...first.items,...second.items,...third.items].map(item=>item.id)).size).toBe(63);
    expect(()=>f.store.evidence({...query({date:'2026-11-04'}),after:first.nextCursor})).toThrow(/kapsamı/);f.event('new','one');expect(()=>f.store.evidence({...query(),after:first.nextCursor})).toThrow(/verisi değişti/);
  });
  it('keeps comparison percentages null for a zero-duration period and zero target period',()=>{
    const current={observations:0,durationMs:HOUR,ratePerHour:0,excludedObservations:0,excludedDurationMs:0},reference={...current,observations:20,ratePerHour:20};expect(compareHuntMetrics(current,reference,'previous-day',1,false).rateChangePercent).toBeNull();expect(compareHuntMetrics({...current,durationMs:0},reference,'previous-day',1,false).rateChangePercent).toBeNull();
  });
});
