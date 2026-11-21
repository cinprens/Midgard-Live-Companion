import { describe, expect, it } from 'vitest';
import { ExperienceTracker, EXPERIENCE_REQUIREMENTS, EXPERIENCE_DATASET, EXPERIENCE_DATASET_VERSION, experienceRequirement } from '../src/domain/experience';
import type { ExperienceEvent, ExperienceSnapshot } from '../src/domain/experience';
const status = (timestamp: number, statusKey: string, amount: number): ExperienceEvent => ({ timestamp, eventType: 'status', statusKey, amount });
const gain = (timestamp: number, amount: number, expKind: 'base' | 'job' = 'base'): ExperienceEvent => ({ timestamp, eventType: amount < 0 ? 'exp-loss' : 'exp-gain', amount, expKind, actorId: 42, attribution: 'personal' });
const snapshot = (events: ExperienceEvent[], patch: Partial<ExperienceSnapshot> = {}): ExperienceSnapshot => ({ streamId: 'a', recordingId: 'one', playerId: 42, observedAt: 0, events, ...patch });
const tracker = () => new ExperienceTracker({ clock: () => 0 });

describe('official versioned EXP requirements and level indexing', () => {
  it('retains all200 published numeric rows with individual source and verification metadata', () => {
    expect(EXPERIENCE_DATASET.rows).toHaveLength(200); expect(EXPERIENCE_REQUIREMENTS).toHaveLength(200);
    for (const row of EXPERIENCE_DATASET.rows) {
      expect(row.sourceUrl).toBe('https://roz.mygnjoy.com/en/intro/guide/21'); expect(row.verifiedAt).toBe('2026-11-01');
      expect(Number.isSafeInteger(row.requiredExp)).toBe(true);
    }
    expect(EXPERIENCE_DATASET_VERSION).toContain('2026-11-01');
  });
  it('uses destination-level rows and exactly reproduces BOTH supporting calculator totals', () => {
    const total = (kind: 'base' | 'job', jobTrack: 'first' | null) => Array.from({length:49}, (_, i) => experienceRequirement(kind, i + 1, jobTrack)!.required!).reduce((a, b) => a + b, 0);
    expect(total('base', null)).toBe(89006400); expect(total('job', 'first')).toBe(1685910);
    expect(experienceRequirement('base', 1)?.required).toBe(2500);
    expect(experienceRequirement('job', 1, 'first')?.required).toBe(340);
    expect(EXPERIENCE_DATASET.indexing.officialGuideExplicit).toBe(false);
  });
  it('supports secondjob50+ without guessing class or extrapolating beyond published levels', () => {
    expect(experienceRequirement('job', 50, 'second')?.required).toBe(1669250);
    expect(experienceRequirement('job', 69, 'second')?.required).toBe(115827366);
    expect(experienceRequirement('job', 70, 'second')?.required).toBeNull();
    expect(experienceRequirement('base', 70)?.required).toBeNull();
    expect(experienceRequirement('job', 20)).toBeNull(); expect(experienceRequirement('job', 51, 'first')).toBeNull();
  });
});
describe('independent live EXP states and calibration', () => {
  it('automatically selects only source-defined classes and keeps all three streams independent', () => {
    const value = tracker();
    for (const [streamId, jobClassId, jobTrack] of [['novice',0,'novice'],['first',1,'first'],['second',8,'second']] as const) {
      const view = value.observe(snapshot([status(0,'baseLevel',53),status(1,'jobLevel',20)], {streamId,telemetry:{jobClassId,jobTrack,jobTrackSource:'rrf-session-class'}}));
      expect(view).toMatchObject({jobClassId,jobTrack,jobTrackSource:'rrf-session-class',base:{level:53,current:null,expPerHour:null},job:{level:20,current:null,expPerHour:null}});
    }
    expect(Object.keys(value.views())).toHaveLength(3);
    expect(value.observe(snapshot([], {streamId:'unknown',telemetry:{jobClassId:4008,jobTrack:null,jobTrackSource:null}}))).toMatchObject({jobTrack:null,jobTrackSource:null,job:{required:null}});
    expect(value.observe(snapshot([], {streamId:'unproven',telemetry:{jobClassId:8,jobTrack:'second'}})).jobTrack).toBeNull();
  });
  it('keeps manual overrides above automatic classes and restores automatic selection on null', () => {
    const value = tracker(), source = snapshot([status(0,'jobLevel',20)], {telemetry:{jobClassId:8,jobTrack:'second',jobTrackSource:'rrf-session-class'}});
    value.observe(source);
    expect(value.setJobTrack('a','first')).toMatchObject({jobTrack:'first',jobTrackSource:'manual'});
    expect(value.observe({...source,observedAt:1000})).toMatchObject({jobTrack:'first',jobTrackSource:'manual'});
    expect(value.setJobTrack('a',null)).toMatchObject({jobTrack:'second',jobTrackSource:'rrf-session-class'});
    expect(value.calibrate({streamId:'a',kind:'job',percent:50})).toMatchObject({jobTrack:'second',jobTrackSource:'rrf-session-class',job:{status:'calibrated'}});
  });
  it('invalidates recording-start automatic class after a job-level drop without overriding manual intent', () => {
    const value = tracker(), telemetry = {jobClassId:8,jobTrack:'second' as const,jobTrackSource:'rrf-session-class' as const};
    const events = [status(0,'jobLevel',50)]; value.observe(snapshot(events,{telemetry}));
    const dropped = [...events,status(1000,'jobLevel',1)];
    expect(value.observe(snapshot(dropped,{telemetry,observedAt:1000}))).toMatchObject({jobTrack:null,jobTrackSource:null,job:{level:1,required:null}});
    expect(value.observe(snapshot(dropped,{telemetry,observedAt:2000})).jobTrack).toBeNull();
    value.setJobTrack('a','second');
    expect(value.observe(snapshot([...dropped,status(3000,'jobLevel',2),status(4000,'jobLevel',1)],{telemetry,observedAt:4000}))).toMatchObject({jobTrack:'second',jobTrackSource:'manual'});
    expect(value.setJobTrack('a',null).jobTrack).toBeNull();
    expect(value.observe(snapshot([status(0,'jobLevel',1)],{recordingId:'two',telemetry,observedAt:5000}))).toMatchObject({jobTrack:'second',jobTrackSource:'rrf-session-class'});
  });
  it('checks historical job-level resets against recording-start level without treating final telemetry as the start', () => {
    const value = tracker(), source = {jobClassId:8,jobTrack:'second' as const,jobTrackSource:'rrf-session-class' as const};
    expect(value.observe(snapshot([status(1000,'jobLevel',1)],{telemetry:{...source,recordingStartJobLevel:50,jobLevel:1}}))).toMatchObject({jobTrack:null,jobTrackSource:null,job:{level:1,required:null}});
    expect(value.observe(snapshot([status(0,'jobLevel',1),status(1000,'jobLevel',50)],{streamId:'ordinary-growth',telemetry:{...source,recordingStartJobLevel:1,jobLevel:50}}))).toMatchObject({jobTrack:'second',jobTrackSource:'rrf-session-class',job:{level:50}});
    expect(value.observe(snapshot([status(0,'jobLevel',50),status(1000,'jobLevel',1)],{streamId:'events-only',telemetry:source})).jobTrack).toBeNull();
    value.setJobTrack('a','first');
    expect(value.observe(snapshot([status(1000,'jobLevel',1)],{recordingId:'two',telemetry:{...source,recordingStartJobLevel:50,jobLevel:1}}))).toMatchObject({jobTrack:'first',jobTrackSource:'manual'});
  });
  it('shows waiting rather than zero for unreadable current EXP, even when level is known', () => {
    const view = tracker().observe(snapshot([status(1, 'baseLevel', 53)]));
    expect(view.base).toMatchObject({ level: 53, current: null, required: 30761200, status: 'waiting', gains5m: null, expPerHour: null });
    expect(view.job.required).toBeNull();
  });
  it('separates unverified packet observations, verified actual values and stale data', () => {
    const value = tracker(), events = [status(0, 'baseLevel', 1), status(1, 'baseExp', 500), status(2, 'nextBaseExp', 3000)];
    expect(value.observe(snapshot(events)).base).toMatchObject({ current: 500, required: 3000, requiredSource: 'packet', status: 'estimated' });
    expect(value.observe(snapshot(events, { liveVerified: true })).base.status).toBe('actual');
    expect(value.view('a', 120000)?.base.status).toBe('stale');
    expect(value.view('a', 120000)?.base.current).toBe(500);
  });
  it('calibrates absolute/percent values and keeps unknown job classes explicit', () => {
    const value = tracker(); value.observe(snapshot([status(0, 'baseLevel', 1), status(1, 'jobLevel', 50)]));
    expect(value.calibrate({streamId:'a',kind:'base',percent:40}).base).toMatchObject({ current: 1000, percent: 40, remaining: 1500, status: 'calibrated' });
    expect(() => value.calibrate({streamId:'a',kind:'job',percent:50})).toThrow('meslek');
    expect(value.calibrate({streamId:'a',kind:'job',jobTrack:'second',percent:50}).job.current).toBe(834625);
    expect(value.setJobTrack('a', 'first').job.current).toBeNull();
  });
  it('does not partially mutate level or class when calibration validation fails', () => {
    const value = tracker(); value.observe(snapshot([status(1, 'baseLevel', 1)]));
    expect(() => value.calibrate({streamId:'a',kind:'base',level:50,jobTrack:'second',percent:101})).toThrow();
    expect(value.view('a')).toMatchObject({ jobTrack: null, base: { level: 1, current: null } });
    expect(() => value.calibrate({streamId:'a',kind:'base',current:1,percent:1})).toThrow();
  });
  it('tracks three streams independently and clears them without any persistence', () => {
    const value = tracker();
    for (const id of ['a','b','c']) value.observe(snapshot([status(0,'baseLevel',1)],{streamId:id}));
    value.calibrate({streamId:'a',kind:'base',current:100}); value.calibrate({streamId:'b',kind:'base',current:200});
    expect(Object.keys(value.views())).toHaveLength(3); expect(value.view('c')?.base.current).toBeNull();
    value.remove('a'); expect(value.stats().streams).toBe(2); value.clear(); expect(value.stats()).toEqual({streams:0,buckets:0,fingerprints:0});
  });
});
describe('live-only gains, level carry, losses and deduplication', () => {
  it('does not create an hourly rate or latest gain from a single baseline current value', () => {
    const value = tracker(), events = [status(0,'baseLevel',1),status(1,'baseExp',100),gain(2,999)];
    value.observe(snapshot(events));
    expect(value.observe(snapshot(events,{observedAt:60000})).base).toMatchObject({current:100,expPerHour:null,lastGainAmount:null,lastGainAt:null,rateQuality:'waiting'});
  });
  it('reports separate latest Base/Job gains and source while avoiding absolute-plus-gain double counting', () => {
    const value = tracker(), events = [status(0,'baseLevel',1),status(1,'baseExp',100),status(2,'jobLevel',1),status(3,'jobExp',10)];
    value.observe(snapshot(events));
    const fresh = [...events,gain(60000,300),gain(60001,40,'job'),status(60002,'baseExp',400),status(60003,'jobExp',50)];
    const view = value.observe(snapshot(fresh,{observedAt:60003}));
    expect(view.base).toMatchObject({current:400,lastGainAmount:300,lastGainSource:'explicit',gains5m:300});
    expect(view.job).toMatchObject({current:50,lastGainAmount:40,lastGainSource:'explicit',gains5m:40});
    expect(view.base.expPerHour).toBeGreaterThan(view.job.expPerHour!);
    expect(value.observe(snapshot(fresh,{observedAt:61000})).base.gains5m).toBe(300);
    const difference = value.observe(snapshot([...fresh,status(62000,'baseExp',500)],{observedAt:62000}));
    expect(difference.base).toMatchObject({lastGainAmount:100,lastGainSource:'difference',gains5m:400,rateQuality:'estimated'});
    expect(value.observe(snapshot(fresh,{recordingId:'two',observedAt:70000})).base.lastGainAmount).toBeNull();
  });
  it('does not count any historical first-snapshot EXP events in live hourly gains', () => {
    const value = tracker(); const events = [status(0, 'baseLevel', 1), status(1, 'baseExp', 500), gain(2, 400)];
    const initial = value.observe(snapshot(events)); expect(initial.base.gains5m).toBe(0);
    expect(value.observe(snapshot(events, {observedAt:1000})).base.current).toBe(500);
    const next = value.observe(snapshot([...events, gain(1002, 100)], {observedAt:1000}));
    expect(next.base.current).toBe(600); expect(next.base.gains5m).toBe(100);
  });
  it('carries multiple levels from calibrated EXP using successive known requirements', () => {
    const value = tracker(); const events = [status(0,'baseLevel',1)]; value.observe(snapshot(events));
    value.calibrate({streamId:'a',kind:'base',current:2000});
    const view = value.observe(snapshot([...events,gain(1000,10000),status(1001,'baseLevel',2),status(1002,'baseLevel',3),status(1003,'baseLevel',4)],{observedAt:1003,telemetry:{baseLevel:4}}));
    expect(view.base).toMatchObject({level:4,current:2900,required:4300,status:'calibrated',gains5m:10000});
  });
  it('retains calculated carry when old level telemetry has not yet received the level packet', () => {
    const value = tracker(); value.observe(snapshot([status(0,'baseLevel',1)])); value.calibrate({streamId:'a',kind:'base',current:2400});
    expect(value.observe(snapshot([status(0,'baseLevel',1),gain(1000,200)],{observedAt:1000,telemetry:{baseLevel:1}})).base).toMatchObject({level:2,current:100});
  });
  it('uses fresh absolute current EXP without adding the same explicit gain twice', () => {
    const value = tracker(), events = [status(0,'baseLevel',1),status(1,'baseExp',100)]; value.observe(snapshot(events));
    expect(value.observe(snapshot([...events,status(1000,'baseExp',300),gain(1001,200)],{observedAt:1000,telemetry:{baseLevel:1,currentBaseExp:300}})).base).toMatchObject({current:300,gains5m:200});
  });
  it('handles current-before-level packets coherently and marks missing transition EXP unknown', () => {
    const value = tracker(), events = [status(0,'baseLevel',1),status(1,'baseExp',2400)]; value.observe(snapshot(events));
    expect(value.observe(snapshot([...events,status(1000,'baseExp',100),status(1001,'baseLevel',2)],{observedAt:1000,telemetry:{baseLevel:2,currentBaseExp:100}})).base).toMatchObject({level:2,current:100,gains5m:200,rateQuality:'estimated'});
    expect(value.observe(snapshot([...events,status(1000,'baseExp',100),status(1001,'baseLevel',2),status(2000,'baseLevel',4)],{observedAt:2000})).base.current).toBeNull();
  });
  it('invalidates an old-level requirement rather than rebinding cached telemetry to the new level', () => {
    const value = tracker(), events = [status(0,'baseLevel',1),status(1,'nextBaseExp',2500)];
    value.observe(snapshot(events));
    const result = value.observe(snapshot([...events,status(1000,'nextBaseExp',2500),status(1001,'baseLevel',2)],{observedAt:1001,telemetry:{baseLevel:2,nextBaseExp:2500}}));
    expect(result.base).toMatchObject({level:2,required:3000,requiredSource:'official-table'});
  });
  it('separates losses, never turns them into gained EXP, and avoids negative guessed values', () => {
    const value = tracker(), events = [status(0,'baseLevel',1)]; value.observe(snapshot(events)); value.calibrate({streamId:'a',kind:'base',current:200});
    const view = value.observe(snapshot([...events,gain(1000,100),gain(2000,-50)],{observedAt:2000}));
    expect(view.base).toMatchObject({current:250,gains5m:100,losses5m:50});
    expect(value.observe(snapshot([...events,gain(1000,100),gain(2000,-50),gain(3000,-999)],{observedAt:3000})).base.current).toBeNull();
  });
  it('deduplicates semantic same-timestamp occurrences and survives incomplete tail rollback', () => {
    const value = tracker(); value.observe(snapshot([]));
    expect(value.observe(snapshot([gain(100,50)],{observedAt:100})).base.gains5m).toBe(50);
    expect(value.observe(snapshot([gain(100,50),gain(100,50)],{observedAt:200})).base.gains5m).toBe(100);
    value.observe(snapshot([],{observedAt:300,complete:false}));
    expect(value.observe(snapshot([gain(100,50),gain(100,50)],{observedAt:400})).base.gains5m).toBe(100);
    expect(value.observe(snapshot([gain(100,50),gain(100,50),gain(500,25)],{observedAt:500})).base.gains5m).toBe(125);
  });
  it('never lowers occurrence counts when an incomplete tail keeps the same maximum timestamp', () => {
    const value = tracker(); value.observe(snapshot([]));
    const two = [gain(100,50),gain(100,50)];
    expect(value.observe(snapshot(two,{observedAt:100})).base.gains5m).toBe(100);
    expect(value.observe(snapshot([gain(100,50)],{observedAt:200,complete:false})).base.gains5m).toBe(100);
    expect(value.observe(snapshot(two,{observedAt:300})).base.gains5m).toBe(100);
    expect(value.observe(snapshot([...two,gain(100,50)],{observedAt:400})).base.gains5m).toBe(150);
  });
  it('silently resets live metrics for a new recording while preserving the chosen job track', () => {
    const value = tracker(); value.observe(snapshot([])); value.setJobTrack('a','second'); value.observe(snapshot([gain(1000,100)],{observedAt:1000}));
    const view = value.observe(snapshot([status(0,'jobLevel',51),gain(1000,999)],{recordingId:'two',observedAt:2000}));
    expect(view).toMatchObject({jobTrack:'second',base:{current:null,gains5m:null},job:{required:2086562}});
  });
  it('ignores another actor and party-attributed EXP rather than adding it to personal rates', () => {
    const value = tracker(); value.observe(snapshot([]));
    const view = value.observe(snapshot([{...gain(1000,100),actorId:99},{...gain(1001,200),attribution:'party'}],{observedAt:1001}));
    expect(view.base.gains5m).toBeNull();
  });
  it('requires explicit personal attribution and a matching known recording owner for hourly EXP', () => {
    const value = tracker(); value.observe(snapshot([]));
    const unowned = [{...gain(1000,100),actorId:undefined},{...gain(1001,200),attribution:'unknown'},{...gain(1002,300),attribution:undefined}];
    expect(value.observe(snapshot(unowned,{observedAt:1002})).base).toMatchObject({gains5m:null,expPerHour:null,lastGainAmount:null});
    value.observe(snapshot([],{streamId:'unknown-owner',playerId:null}));
    expect(value.observe(snapshot([gain(2000,500)],{streamId:'unknown-owner',playerId:null,observedAt:2000})).base.expPerHour).toBeNull();
    value.observe(snapshot([],{streamId:'zero-owner',playerId:0}));
    expect(value.observe(snapshot([{...gain(2000,500),actorId:0}],{streamId:'zero-owner',playerId:0,observedAt:2000})).base.gains5m).toBeNull();
  });
});
describe('rolling window decay, delayed data, rates and safe bounds', () => {
  it('ages gains through5/15/60 minute windows and decays hourly rate without new file packets', () => {
    const value = tracker(); value.observe(snapshot([])); value.observe(snapshot([gain(60000,600)],{observedAt:60000}));
    expect(value.view('a',60000)?.base).toMatchObject({gains5m:600,gains15m:600,expPerHour:36000});
    expect(value.view('a',360000)?.base).toMatchObject({gains5m:0,gains15m:600,expPerHour:6000});
    expect(value.view('a',960000)?.base).toMatchObject({gains15m:0,gains60m:600,expPerHour:0,etaSeconds:null});
    expect(value.view('a',3660000)?.base.gains60m).toBe(0); expect(value.stats().buckets).toBe(0);
  });
  it('uses replay-relative event timing rather than making delayed batches look newly earned', () => {
    const value = tracker(); value.observe(snapshot([]));
    const result = value.observe(snapshot([gain(60000,600)],{observedAt:20*60000}));
    expect(result.base).toMatchObject({gains5m:0,gains15m:0,gains60m:600,expPerHour:0,lastGainAt:60000});
  });
  it('keeps a delayed absolute EXP observation stale when final-value telemetry accompanies it', () => {
    const value = tracker(); value.observe(snapshot([status(0,'baseLevel',1)]));
    const result = value.observe(snapshot([status(0,'baseLevel',1),status(60000,'baseExp',600)],{observedAt:20*60000,telemetry:{baseLevel:1,currentBaseExp:600},liveVerified:true}));
    expect(result.base).toMatchObject({current:600,lastObservedAt:60000,status:'stale'});
  });
  it('computes ETA from net observed rate, not party multipliers or lifetime file EXP', () => {
    const value = tracker(); value.observe(snapshot([status(0,'baseLevel',1)])); value.calibrate({streamId:'a',kind:'base',current:1000});
    const result = value.observe(snapshot([status(0,'baseLevel',1),gain(60000,600),gain(60001,-100)],{observedAt:60001}));
    expect(result.base.current).toBe(1500); expect(result.base.remaining).toBe(1000);
    expect(result.base.etaSeconds).toBeCloseTo(120.002,2);
  });
  it('bounds one-second gain buckets and fingerprint saturation without duplicate replay', () => {
    const value = new ExperienceTracker({clock:()=>0,maxFingerprintsPerStream:8}); value.observe(snapshot([]));
    const events = Array.from({length:2000},(_,i)=>gain(1000,i+1)); value.observe(snapshot(events,{observedAt:1000}));
    const before = value.view('a',1000)?.base.gains5m;
    expect(value.observe(snapshot(events.slice(0,1),{observedAt:1500,complete:false})).base.gains5m).toBe(before);
    expect(value.observe(snapshot([...events,gain(1000,90000)],{observedAt:2000})).base.gains5m).toBe(before);
    expect(value.stats().fingerprints).toBe(8); expect(value.stats().buckets).toBe(1);
  });
});
