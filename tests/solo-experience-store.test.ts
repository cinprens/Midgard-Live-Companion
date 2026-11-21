import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ExpansionStore } from '../electron/expansion-store';
import { emptySummary, type ParsedReplay, type ReplayEvent } from '../src/parser';
import { experienceRequirement } from '../src/domain/experience-table';
import type { CharacterIdentity } from '../src/shared/types';
import type { KillExperienceControl } from '../src/shared/kill-experience';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function profile(soloOnly = true) {
  const qa = path.resolve('.qa');
  await mkdir(qa, { recursive: true });
  const dir = await mkdtemp(path.join(qa, 'solo-experience-'));
  cleanups.push(async () => {
    if (!path.resolve(dir).startsWith(`${qa}${path.sep}`)) throw new Error('Test cleanup outside QA directory');
    await rm(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'profile.sqlite');
  let active = new ExpansionStore(file, { killExperienceSoloOnly: soloOnly });
  cleanups.push(() => active.close());
  return { dir, file, get model() { return active.killExperience; }, reopen(solo = true) {
    active.close(); active = new ExpansionStore(file, { killExperienceSoloOnly: solo }); return active.killExperience;
  } };
}
const who = (id = 1): CharacterIdentity => ({ key: `recorded:${id}:Solo`, name: `Solo ${id}`, source: 'recorded', playerId: id });
const tick = (timestamp: number): ReplayEvent => ({ id: `tick-${timestamp}`, eventType: 'status', timestamp, confidence: 'certain', statusKey: 'hp', amount: 100 });
function death(timestamp: number, target = timestamp, monsterId = 1176, life = `0:${target}:1`, playerId = 1): ReplayEvent {
  return { id: `death-${target}-${life}`, timestamp, eventType: 'death', targetId: target, actorId: playerId, monsterId, entityKind: 'mob', confidence: 'estimated', attribution: 'personal', rawData: { attackers: [playerId], killProof: { death: 'vanish-kind-1', targetActorId: target, lifecycleId: life, scope: 'replay-local', ownership: 'exclusive-observed-attacker-estimate', lastAttackTimestamp: timestamp } } };
}
function parsed(events: ReplayEvent[], id = 1): ParsedReplay {
  return { filename: `${id}.rrf`, format: 'RRF', version: 5, status: 'partial', profile: 'rrf-v5-latam', compatibility: 'skadi-unverified', diagnostics: [], unknownPackets: [], packetCount: events.length, events,
    summary: { ...emptySummary(), characterName: `Solo ${id}`, playerId: id, startedAt: '2026-11-05T00:00:00Z',
      liveTelemetry: { hp: 100, maxHp: 100, weight: 0, maxWeight: 100, weightPercent: 0, baseLevel: 10, jobLevel: 10, currentBaseExp: null, currentJobExp: null, nextBaseExp: null, nextJobExp: null, lastBaseExpGain: null, lastJobExpGain: null, baseExpGained: null, jobExpGained: null, currentMap: null, jobTrack: 'second', jobTrackSource: 'rrf-session-class' } } };
}
function delta(events: ReplayEvent[], durationMs: number, sequence = 1): ParsedReplay {
  const value = parsed(events); value.summary.durationMs = durationMs;
  value.incremental = { delta: true, sequence, recordingStart: false, eventCount: sequence };
  return value;
}
const meta = (dir: string, id = 1, streamId = `stream-${id}`) => ({ sourcePath: path.join(dir, `${id}.rrf`), streamId, recordingId: `recording-${id}`, hash: 'test-hash' });
const command = (id = 1, action: KillExperienceControl['action'] = 'start'): KillExperienceControl => ({ characterKey: who(id).key, streamId: `stream-${id}`, recordingId: `recording-${id}`, action });
const rate = (id = 1, baseExp: number | null = 100, jobExp: number | null = 50, monsterId = 1176) => ({ characterKey: who(id).key, monsterId, baseExp, jobExp });
const session = (model: ExpansionStore['killExperience'], id = 1) => model.snapshot().characters.find(value => value.characterKey === who(id).key)!.session!;
const control = (model: ExpansionStore['killExperience'], action: KillExperienceControl['action'], id = 1) => ({ ...command(id, action), sessionId: session(model, id).id });
function ledger(file: string, sql: string) {
  const read = new DatabaseSync(file, { readOnly: true });
  try { return read.prepare(sql).all(); } finally { read.close(); }
}
function atClock(events: ReplayEvent[], rawStartedAt: string | null, id = 1): ParsedReplay {
  const value = parsed(events, id); value.summary.startedAt = rawStartedAt; return value;
}
function start(model: ExpansionStore['killExperience'], dir: string, id = 1) {
  model.observe(parsed([tick(0)], id), meta(dir, id), who(id)); model.setRate(rate(id)); model.control(command(id));
}

describe('solo gross EXP estimates', () => {
  it('awards only own damage deaths and excludes other, mixed, unattributed and wrong-owner deaths', async () => {
    const {dir,file,model}=await profile();start(model,dir);
    const own=death(1000),other=death(2000),mixed=death(3000),unattributed=death(4000),wrongOwner=death(5000,5000,1176,'0:5000:1',2);
    other.actorId=undefined;other.attribution='other';other.rawData!.attackers=[2];
    (other.rawData!.killProof as Record<string,unknown>).ownership='observed-other-attacker-estimate';
    mixed.actorId=undefined;mixed.attribution='unknown';mixed.confidence='unknown';mixed.rawData!.attackers=[1,2];
    (mixed.rawData!.killProof as Record<string,unknown>).ownership='unknown';
    unattributed.actorId=undefined;unattributed.attribution='unknown';unattributed.confidence='unknown';unattributed.rawData!.attackers=[];
    Object.assign(unattributed.rawData!.killProof as object,{ownership:'unknown',lastAttackTimestamp:null});
    const replay=parsed([own,other,mixed,unattributed,wrongOwner,tick(6000)]);
    model.observe(replay,meta(dir),who());model.observe(replay,meta(dir),who());
    expect(session(model)).toMatchObject({attributionPolicy:'own-damage-v1',observedDeaths:1,durationMs:6000,base:{gained:100},job:{gained:50}});
    expect(ledger(file,'SELECT * FROM kill_experience_awards')).toHaveLength(1);
    expect(ledger(file,'SELECT * FROM solo_experience_calendar_awards')).toHaveLength(1);
  });
  it('keeps a pre-filter solo session intact and inactive until a new filtered measurement starts',async()=>{
    const setup=await profile();start(setup.model,setup.dir);
    setup.model.observe(parsed([death(1000),tick(2000)]),meta(setup.dir),who());
    const original=session(setup.model),writer=new DatabaseSync(setup.file);
    const saved=JSON.parse(String(writer.prepare('SELECT data_json FROM kill_experience_sessions WHERE id=?').get(original.id)?.data_json));
    delete saved.attributionPolicy;
    writer.prepare('UPDATE kill_experience_sessions SET data_json=? WHERE id=?').run(JSON.stringify(saved),original.id);writer.close();
    const before=ledger(setup.file,'SELECT * FROM kill_experience_sessions'),model=setup.reopen();
    model.observe(parsed([death(1000),death(3000),tick(4000)]),meta(setup.dir),who());
    model.syncStatuses([{id:'stream-1',sourcePath:meta(setup.dir).sourcePath,status:'following',currentSnapshot:true,character:who()}]);
    expect(session(model)).toMatchObject({id:original.id,status:'stopped',observedDeaths:1,base:{gained:100}});
    expect(session(model).attributionPolicy).toBeUndefined();
    expect(()=>model.control(control(model,'resume'))).toThrow();
    expect(ledger(setup.file,'SELECT * FROM kill_experience_sessions')).toEqual(before);
    model.control(control(model,'reset'));
    model.observe(parsed([death(1000),death(3000),death(5000),tick(6000)]),meta(setup.dir),who());
    expect(session(model)).toMatchObject({attributionPolicy:'own-damage-v1',observedDeaths:1,base:{gained:100}});
    const archive=ledger(setup.file,'SELECT data_json FROM kill_experience_sessions').map(row=>JSON.parse(String(row.data_json)));
    expect(archive).toHaveLength(2);expect(archive.find(row=>row.id===original.id)).toMatchObject({observedDeaths:1,base:{knownGained:100}});
  });
  it('starts without manual percentages, freezes automatic level reference and separates gross total from percent equivalent', async () => {
    const { dir, model } = await profile(); start(model, dir);
    const newer = parsed([death(1000), tick(3600000)]); newer.summary.liveTelemetry!.baseLevel = 11;
    model.observe(newer, meta(dir), who());
    const current = session(model);
    expect(current.soloReference).toEqual({ baseLevel: 10, jobLevel: 10, jobTrack: 'second' });
    expect(current.soloProgress?.base).toMatchObject({ status: 'estimated', level: 10, gained: 100, perHour: 100 });
    expect(current.soloProgress?.base.percent).toBeCloseTo(100 / experienceRequirement('base', 10)!.required! * 100);
    expect(current).not.toHaveProperty('soloAnchor');
    model.control(control(model, 'reset'));
    expect(session(model).soloReference?.baseLevel).toBe(11);
    expect(session(model).base.gained).toBe(0);
  });
  it('freezes only configured targets, excludes unknown monsters and applies changed rates only to future awards', async () => {
    const { dir, model } = await profile(); start(model, dir);
    model.observe(parsed([death(1000), death(1500, 9, 9999), tick(2000)]), meta(dir), who());
    model.setRate(rate(1, 300, 90)); model.setRate(rate(1, 900, 800, 9999));
    model.observe(parsed([death(1000), death(1500, 9, 9999), death(3000), death(3100, 10, 9999), tick(4000)]), meta(dir), who());
    expect(session(model)).toMatchObject({ targetMonsterIds: [1176], observedDeaths: 2, base: { gained: 400, missingDeaths: 0 }, job: { gained: 140 } });
    model.control(control(model, 'reset'));
    model.observe(parsed([death(1000), death(3000), death(5000, 11, 9999), tick(6000)]), meta(dir), who());
    expect(session(model)).toMatchObject({ targetMonsterIds: [1176, 9999], observedDeaths: 1, base: { gained: 900 } });
  });
  it('freezes the measured threshold or the applicable official threshold for each new measurement only', async () => {
    const profileData = await profile();
    const {dir,model} = profileData;
    const preview = atClock([tick(0)],'2026-11-21T01:00:00');
    const telemetry = preview.summary.liveTelemetry!;
    Object.assign(telemetry,{baseLevel:57,jobLevel:30,jobClassId:8,
      recordingStartExp:{base:{level:57,amount:403,required:20_000_000}},
    });
    model.observe(preview,meta(dir),who()); model.setRate(rate()); model.control(command());
    const original = session(model);
    expect(original.soloReference?.requirements?.base).toEqual({source:'replay',amount:20_000_000});
    expect(original.soloReference?.requirements?.job?.source).toBe('official-table');
    telemetry.baseLevel = 64;
    preview.events = [death(1000),tick(2000)];
    model.observe(preview,meta(dir),who());
    expect(session(model).soloProgress?.base).toMatchObject({level:57,requiredExp:20_000_000,percent:0.0005});
    model.control(control(model,'reset'));
    expect(session(model).soloReference?.requirements?.base).toEqual({source:'official-table',amount:119_575_100});
    expect(session(profileData.reopen()).soloReference?.requirements?.base).toEqual({source:'official-table',amount:119_575_100});
    const archived = ledger(profileData.file,'SELECT data_json FROM kill_experience_sessions').map(r=>JSON.parse(String(r.data_json)));
    expect(archived.find(row=>row.id===original.id).soloReference.requirements.base).toEqual({source:'replay',amount:20_000_000});
  });
  it('excludes existing history, deduplicates full snapshots and counts new lifecycles at an existing timestamp', async () => {
    const { dir, model } = await profile(); const old = death(1000, 41);
    model.observe(parsed([old]), meta(dir), who()); model.setRate(rate()); model.control(command());
    const one = death(1000, 42), next = death(2000, 42, 1176, '0:42:2');
    model.observe(parsed([old, one, one, next, tick(2000)]), meta(dir), who());
    model.observe(parsed([old, one, one, next, tick(2000)]), meta(dir), who());
    expect(session(model)).toMatchObject({ observedDeaths: 2, durationMs: 1000, base: { gained: 200 } });
  });
  it('uses cumulative Replay duration for eventless incremental batches and remembers boundary deaths', async () => {
    const { dir, model } = await profile(); model.observe(delta([death(1000)], 1000), meta(dir), who()); model.setRate(rate()); model.control(command());
    model.observe(delta([death(1000, 42)], 1000, 2), meta(dir), who());
    model.observe(delta([], 1000, 3), meta(dir), who());
    model.observe(delta([death(1000, 42)], 1000, 4), meta(dir), who());
    model.observe(delta([], 3601000, 5), meta(dir), who());
    expect(session(model)).toMatchObject({ observedDeaths: 1, durationMs: 3600000, base: { gained: 100, perHour: 100 } });
  });
  it('keeps three characters independent and ignores a copied Replay when another source is selected', async () => {
    const { dir, model } = await profile();
    for (const id of [1, 2, 3]) { start(model, dir, id); model.setRate(rate(id, id * 100, id * 10)); }
    const copy = { ...meta(dir), sourcePath: path.join(dir, 'copy.rrf'), streamId: 'copy' };
    model.observe(parsed([death(1000), tick(2000)]), copy, who());
    expect(session(model).observedDeaths).toBe(0);
    for (const id of [1, 2, 3]) model.observe(parsed([death(1000, 1000, 1176, '0:1000:1', id), tick(2000)], id), meta(dir, id), who(id));
    expect([1, 2, 3].map(id => session(model, id).base.gained)).toEqual([100, 200, 300]);
    expect(model.snapshot().sources).toHaveLength(4);
    expect(model.getSource('stream-1', meta(dir).sourcePath)?.recordingId).toBe('recording-1');
    expect(model.getSource('stream-1', copy.sourcePath)).toBeNull();
  });
  it('skips paused observations and duration while keeping gross gains on resume', async () => {
    const { dir, model } = await profile(); start(model, dir);
    model.observe(parsed([death(1000), tick(2000)]), meta(dir), who()); model.control(control(model, 'pause'));
    model.observe(parsed([death(1000), death(3000), tick(4000)]), meta(dir), who()); model.control(control(model, 'resume'));
    model.observe(parsed([death(1000), death(3000), death(5000), tick(6000)]), meta(dir), who());
    expect(session(model)).toMatchObject({ observedDeaths: 2, durationMs: 4000, base: { gained: 200 }, soloProgress: { base: { status: 'estimated' } } });
  });
  it('preserves totals/reference across restart and baselines every initial incremental chunk', async () => {
    const setup = await profile(); start(setup.model, setup.dir);
    setup.model.observe(parsed([death(1000), tick(2000)]), meta(setup.dir), who());
    const id = session(setup.model).id, model = setup.reopen();
    const binding = { ...meta(setup.dir, 1, 'reattached'), initial: true };
    model.observe(delta([death(1000)], 1000), binding, who());
    model.observe(delta([death(3000)], 4000, 2), binding, who());
    expect(session(model)).toMatchObject({ id, streamId: 'reattached', observedDeaths: 1, durationMs: 2000, base: { gained: 100 } });
    model.observe(delta([death(5000)], 6000, 3), { ...binding, initial: false }, who());
    expect(session(model)).toMatchObject({ id, observedDeaths: 2, durationMs: 4000, base: { gained: 200 }, soloReference: { baseLevel: 10 } });
    const read = new DatabaseSync(setup.file, { readOnly: true });
    try { expect(JSON.parse(String(read.prepare('SELECT data_json FROM kill_experience_sessions WHERE id=?').get(id)?.data_json))).toMatchObject({ soloReference: { baseLevel: 10 }, targetMonsterIds: [1176] }); }
    finally { read.close(); }
  });
  it('waits for a startup placeholder identity before reattaching the same recording without recounting history', async () => {
    const setup = await profile(); start(setup.model, setup.dir);
    setup.model.observe(parsed([death(1000), tick(2000)]), meta(setup.dir), who());
    const id = session(setup.model).id, model = setup.reopen();
    const binding = { ...meta(setup.dir, 1, 'reattached'), initial: true };
    const monitor = { id: binding.streamId, sourcePath: binding.sourcePath };
    model.syncStatuses([{ ...monitor, status: 'reading', currentSnapshot: false, character: { key: 'unassigned:reattached', name: 'Karakter adı bekleniyor', source: 'unassigned', playerId: null } }]);
    expect(session(model)).toMatchObject({ id, status: 'source-unavailable', observedDeaths: 1, durationMs: 2000 });
    model.observe(delta([death(1000), death(3000)], 4000), binding, who());
    model.syncStatuses([{ ...monitor, status: 'settled', currentSnapshot: true, character: who() }]);
    expect(session(model)).toMatchObject({ id, status: 'running', streamId: 'reattached', observedDeaths: 1, durationMs: 2000 });
    model.observe(delta([death(5000)], 6000, 2), { ...binding, initial: false }, who());
    expect(session(model)).toMatchObject({ id, status: 'running', observedDeaths: 2, durationMs: 4000, base: { gained: 200 } });
    const anchor = Date.parse('2026-11-05T00:00:00Z');
    expect(ledger(setup.file, 'SELECT start_ms,end_ms FROM solo_experience_calendar_intervals ORDER BY start_ms').map(row => [Number(row.start_ms) - anchor, Number(row.end_ms) - anchor])).toEqual([[0, 2000], [4000, 6000]]);
  });
  it.each(['recorded', 'manual'] as const)('still invalidates a confirmed %s character change while a source is loading', async source => {
    const { dir, model } = await profile(); start(model, dir);
    model.syncStatuses([{ id: 'stream-1', sourcePath: meta(dir).sourcePath, status: 'reading', currentSnapshot: false, character: { key: `${source}:other`, name: 'Other', source, playerId: null } }]);
    expect(session(model)).toMatchObject({ status: 'recording-changed', observedDeaths: 0 });
  });
  it('keeps legacy party sessions inactive without rewriting stored data and rejects party controls except stop', async () => {
    const setup = await profile(false), legacy = setup.model;
    for (const id of [1, 2]) { legacy.observe(parsed([tick(0)], id), meta(setup.dir, id), who(id)); legacy.setRate(rate(id)); }
    legacy.control({ ...command(), sources: [command(), command(2)].map(({ characterKey, streamId, recordingId }) => ({ characterKey, streamId, recordingId })) });
    legacy.observe(parsed([death(1000), tick(2000)]), meta(setup.dir), who());
    const readBefore = new DatabaseSync(setup.file, { readOnly: true });
    const before = readBefore.prepare('SELECT data_json FROM kill_experience_sessions ORDER BY id').all(); readBefore.close();
    const model = setup.reopen();
    for (const id of [1, 2]) model.observe(parsed([death(1000), death(3000), tick(4000)], id), meta(setup.dir, id), who(id));
    model.syncStatuses([1, 2].map(id => ({ id: `stream-${id}`, sourcePath: meta(setup.dir, id).sourcePath, status: 'following' as const, character: who(id) })));
    expect(session(model)).toMatchObject({ mode: 'party', status: 'stopped', base: { gained: 100 } });
    expect(() => model.control(control(model, 'resume'))).toThrow(/tek karakter/);
    const readAfter = new DatabaseSync(setup.file, { readOnly: true });
    try { expect(readAfter.prepare('SELECT data_json FROM kill_experience_sessions ORDER BY id').all()).toEqual(before); }
    finally { readAfter.close(); }
    expect(() => model.control({ ...control(model, 'stop'), groupId: session(model).groupId! })).not.toThrow();
  });
  it('leaves legacy single sessions inactive and ignores existing death penalties in a fresh solo session', async () => {
    const setup = await profile(false); start(setup.model, setup.dir); setup.model.setDeathPenalty({ characterKey: who().key, percent: 10 });
    const model = setup.reopen(); model.observe(parsed([tick(0)]), meta(setup.dir), who());
    expect(session(model).status).toBe('stopped'); expect(() => model.control(control(model, 'resume'))).toThrow();
    model.control({ ...command(), sessionId: session(model).id });
    const own: ReplayEvent = { id: 'own-death', timestamp: 1500, eventType: 'player-death', actorId: 1, targetId: 1, entityKind: 'pc', confidence: 'certain', attribution: 'personal', rawData: { source: 'own-death-vanish', observedDeath: true, baseLevel: 10, jobLevel: 10, jobTrack: 'second' } };
    model.observe(parsed([death(1000), own, tick(3600000)]), meta(setup.dir), who());
    expect(session(model)).toMatchObject({ observedPlayerDeaths: 0, base: { gained: 100, lost: 0, perHour: 100 }, soloProgress: { base: { status: 'estimated', perHour: 100 } } });
    expect(model.snapshot().characters[0].deathPenaltyPercent).toBe(10);
    expect(() => model.setDeathPenalty({ characterKey: who().key, percent: 5 })).toThrow();
  });
  it('rejects stale/malformed controls, empty target setup and manual anchor injection', async () => {
    const { dir, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who());
    expect(() => model.control(command())).toThrow(/en az bir/);
    model.setRate(rate(1, null, null)); expect(() => model.control(command())).toThrow(/en az bir/);
    model.setRate(rate()); model.control(command());
    expect(() => model.control(command(1, 'pause'))).toThrow(/değişti/);
    expect(() => model.control(command())).toThrow(/değişti/);
    const old = control(model, 'reset'); model.control(old);
    expect(() => model.control(old)).toThrow(/değişti/);
    expect(() => model.control({ ...old, action: 'start' })).toThrow(/değişti/);
    expect(() => model.control({ ...command(), soloAnchor: {} } as KillExperienceControl)).toThrow(/geçersiz/);
    expect(() => model.control({ ...control(model, 'start'), sources: [command(), command(2)] })).toThrow(/tek karakter/);
    expect(() => model.control({ ...control(model, 'start'), recordingId: 'stale' })).toThrow(/güncel/);
  });
  it('keeps missing rate channels incomplete without corrupting known totals or historical awards', async () => {
    const { dir, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate(1, 0, null)); model.control(command());
    model.observe(parsed([death(1000), tick(3600000)]), meta(dir), who()); model.setRate(rate(1, 30, 20));
    model.observe(parsed([death(1000), death(3601000), tick(7200000)]), meta(dir), who());
    expect(session(model)).toMatchObject({ base: { gained: 30, missingDeaths: 0 }, job: { gained: null, knownGained: 20, missingDeaths: 1 }, soloProgress: { base: { status: 'estimated', perHour: 15 }, job: { status: 'incomplete', gained: null, knownGained: 20, knownPerHour: 10 } } });
  });
  it('shows unavailable percentage with unknown levels while retaining gain and hourly values', async () => {
    const { dir, model } = await profile(); const value = parsed([tick(0)]); delete value.summary.liveTelemetry;
    model.observe(value, meta(dir), who()); model.setRate(rate()); model.control(command()); model.observe(parsed([death(1000), tick(3600000)]), meta(dir), who());
    expect(session(model)).toMatchObject({ soloReference: { baseLevel: null, jobLevel: null, jobTrack: null }, soloProgress: { base: { status: 'estimated', gained: 100, perHour: 100, percent: null } } });
  });
  it('invalidates a replaced recording and refuses invalid snapshots as selectable sources', async () => {
    const { dir, model } = await profile(); start(model, dir);
    model.observe(parsed([tick(0)]), { ...meta(dir), recordingId: 'replacement', recordingReset: true }, who());
    expect(session(model).status).toBe('recording-changed'); expect(() => model.control(control(model, 'resume'))).toThrow();
    const bad = parsed([]); bad.status = 'invalid'; model.observe(bad, meta(dir), who());
    expect(model.getSource('stream-1')).toBeNull(); expect(() => model.control(control(model, 'start'))).toThrow(/güncel/);
  });
  it('dates only new target awards around Istanbul midnight and freezes their earned EXP values', async () => {
    const { dir, file, model } = await profile(), raw = '2026-11-05T23:59:50';
    const old = death(1000), beforeMidnight = death(9000), afterMidnight = death(11000);
    model.observe(atClock([old, tick(2000)], raw), meta(dir), who()); model.setRate(rate()); model.control(command());
    model.observe(atClock([old, beforeMidnight, tick(10000)], raw), meta(dir), who());
    model.setRate(rate(1, 250, 80));
    const latest = atClock([old, beforeMidnight, afterMidnight, death(12000, 99, 9999), tick(20000)], raw);
    model.observe(latest, meta(dir), who()); model.observe(latest, meta(dir), who());
    const awards = ledger(file, 'SELECT at_ms,base_exp,job_exp FROM solo_experience_calendar_awards ORDER BY at_ms');
    expect(awards).toEqual([
      { at_ms: Date.parse('2026-11-05T23:59:59+03:00'), base_exp: 100, job_exp: 50 },
      { at_ms: Date.parse('2026-11-06T00:00:01+03:00'), base_exp: 250, job_exp: 80 },
    ]);
    expect(ledger(file, 'SELECT start_ms,end_ms FROM solo_experience_calendar_intervals ORDER BY start_ms')).toEqual([
      { start_ms: Date.parse('2026-11-05T23:59:52+03:00'), end_ms: Date.parse('2026-11-06T00:00:10+03:00') },
    ]);
    expect(ledger(file, 'SELECT anchor_ms,raw_started_at,time_zone,clock_version FROM solo_experience_calendar_sessions')).toEqual([
      { anchor_ms: Date.parse('2026-11-05T23:59:50+03:00'), raw_started_at: raw, time_zone: 'Europe/Istanbul', clock_version: 1 },
    ]);
    expect(session(model)).toMatchObject({ observedDeaths: 2, durationMs: 18000, base: { gained: 350 } });
  });
  it('uses identical instants for explicit UTC and local Istanbul headers independent of the host timezone', async () => {
    const { dir, file, model } = await profile(); const original = process.env.TZ;
    try {
      for (const [id, raw, zone] of [[1, '2026-11-05T23:59:50', 'America/New_York'], [2, '2026-11-05T20:59:50Z', 'Asia/Tokyo']] as const) {
        process.env.TZ = zone;
        model.observe(atClock([tick(0)], raw, id), meta(dir, id), who(id)); model.setRate(rate(id)); model.control(command(id));
        model.observe(atClock([death(11000, 11000, 1176, '0:11000:1', id), tick(20000)], raw, id), meta(dir, id), who(id));
      }
    } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
    expect(ledger(file, 'SELECT at_ms FROM solo_experience_calendar_awards ORDER BY character_key')).toEqual([
      { at_ms: Date.parse('2026-11-06T00:00:01+03:00') }, { at_ms: Date.parse('2026-11-06T00:00:01+03:00') },
    ]);
  });
  it('never dates paused/restart history or bridges those gaps with calendar duration', async () => {
    const setup = await profile(); start(setup.model, setup.dir);
    setup.model.observe(parsed([death(1000), tick(2000)]), meta(setup.dir), who()); setup.model.control(control(setup.model, 'pause'));
    setup.model.observe(parsed([death(1000), death(3000), tick(4000)]), meta(setup.dir), who()); setup.model.control(control(setup.model, 'resume'));
    setup.model.observe(parsed([death(1000), death(3000), death(5000), tick(6000)]), meta(setup.dir), who());
    const model = setup.reopen();
    model.observe(delta([death(1000)], 2000), { ...meta(setup.dir), initial: true }, who());
    model.observe(delta([death(7000)], 8000, 2), { ...meta(setup.dir), initial: true }, who());
    model.observe(delta([death(9000)], 10000, 3), meta(setup.dir), who());
    const anchor = Date.parse('2026-11-05T00:00:00Z');
    expect(ledger(setup.file, 'SELECT at_ms FROM solo_experience_calendar_awards ORDER BY at_ms').map(row => Number(row.at_ms) - anchor)).toEqual([1000, 5000, 9000]);
    expect(ledger(setup.file, 'SELECT start_ms,end_ms FROM solo_experience_calendar_intervals ORDER BY start_ms').map(row => [Number(row.start_ms) - anchor, Number(row.end_ms) - anchor])).toEqual([[0, 2000], [4000, 6000], [8000, 10000]]);
    expect(session(model)).toMatchObject({ observedDeaths: 3, durationMs: 6000 });
  });
  it('continues undated gross gains for unknown or conflicting clock metadata', async () => {
    const { dir, file, model } = await profile();
    model.observe(atClock([tick(0)], null), meta(dir), who()); model.setRate(rate()); model.control(command());
    model.observe(atClock([death(1000), tick(2000)], null), meta(dir), who());
    expect(ledger(file, 'SELECT anchor_ms,raw_started_at FROM solo_experience_calendar_sessions')).toEqual([{ anchor_ms: null, raw_started_at: null }]);
    expect(ledger(file, 'SELECT * FROM solo_experience_calendar_awards')).toEqual([]);
    expect(ledger(file, 'SELECT * FROM solo_experience_calendar_intervals')).toEqual([]);
    expect(session(model).base.gained).toBe(100);
    start(model, dir, 2);
    model.observe(parsed([death(1000, 1000, 1176, '0:1000:1', 2), tick(2000)], 2), meta(dir, 2), who(2));
    const edit = new DatabaseSync(file);
    try { edit.prepare('UPDATE solo_experience_calendar_sessions SET clock_version=99 WHERE character_key=?').run(who(2).key); } finally { edit.close(); }
    model.observe(parsed([death(1000, 1000, 1176, '0:1000:1', 2), death(3000, 3000, 1176, '0:3000:1', 2), tick(4000)], 2), meta(dir, 2), who(2));
    expect(session(model, 2).base.gained).toBe(200);
    expect(ledger(file, 'SELECT COUNT(*) n FROM solo_experience_calendar_awards')[0].n).toBe(1);
    expect(ledger(file, 'SELECT COUNT(*) n FROM kill_experience_awards')[0].n).toBe(3);
  });
  it('starts calendar history prospectively for an existing solo session without repricing old awards', async () => {
    const { dir, file, model } = await profile(); start(model, dir);
    model.observe(parsed([death(1000), tick(2000)]), meta(dir), who());
    const edit = new DatabaseSync(file);
    try { edit.exec('PRAGMA foreign_keys=ON; DELETE FROM solo_experience_calendar_awards; DELETE FROM solo_experience_calendar_intervals; DELETE FROM solo_experience_calendar_sessions;'); } finally { edit.close(); }
    model.setRate(rate(1, 250, 80));
    model.observe(parsed([death(1000), death(3000), tick(4000)]), meta(dir), who());
    expect(ledger(file, 'SELECT base_exp,job_exp FROM solo_experience_calendar_awards')).toEqual([{ base_exp: 250, job_exp: 80 }]);
    expect(ledger(file, 'SELECT base_exp,job_exp FROM kill_experience_awards ORDER BY rowid')).toEqual([{ base_exp: 100, job_exp: 50 }, { base_exp: 250, job_exp: 80 }]);
    expect(ledger(file, 'SELECT end_ms-start_ms duration FROM solo_experience_calendar_intervals')).toEqual([{ duration: 2000 }]);
    expect(session(model)).toMatchObject({ observedDeaths: 2, durationMs: 4000, base: { gained: 350 } });
  });
  it('recovers after a fresh accepted snapshot even when it arrived before the missing status was cleared', async () => {
    const { dir, file, model } = await profile(); start(model, dir);
    model.observe(parsed([death(1000), tick(2000)]), meta(dir), who());
    const monitor = { id: 'stream-1', sourcePath: meta(dir).sourcePath, character: who() };
    model.syncStatuses([{ ...monitor, status: 'missing', currentSnapshot: false }]);
    // This is the production order: the parser callback precedes the controller's
    // accepted/current status. The missing source flag is still in the registry.
    model.observe(parsed([death(1000), death(3000), tick(4000)]), meta(dir), who());
    model.syncStatuses([{ ...monitor, status: 'following', currentSnapshot: false }]);
    expect(session(model)).toMatchObject({ status: 'source-unavailable', observedDeaths: 1, durationMs: 2000 });
    model.syncStatuses([{ ...monitor, status: 'settled', currentSnapshot: true }]);
    expect(session(model)).toMatchObject({ status: 'running', observedDeaths: 1, durationMs: 2000 });
    model.observe(parsed([death(1000), death(3000), death(5000), tick(6000)]), meta(dir), who());
    expect(session(model)).toMatchObject({ status: 'running', observedDeaths: 2, durationMs: 4000, base: { gained: 200 } });
    const anchor = Date.parse('2026-11-05T00:00:00Z');
    expect(ledger(file, 'SELECT start_ms,end_ms FROM solo_experience_calendar_intervals ORDER BY start_ms').map(row => [Number(row.start_ms) - anchor, Number(row.end_ms) - anchor])).toEqual([[0, 2000], [4000, 6000]]);
  });
  it('recovers an unchanged accepted Replay but never resumes a manually paused measurement', async () => {
    const { dir, model } = await profile(); start(model, dir);
    model.observe(parsed([death(1000), tick(2000)]), meta(dir), who());
    const monitor = { id: 'stream-1', sourcePath: meta(dir).sourcePath, character: who() };
    model.syncStatuses([{ ...monitor, status: 'missing', currentSnapshot: false }]);
    model.syncStatuses([{ ...monitor, status: 'settled', currentSnapshot: true }]);
    expect(session(model)).toMatchObject({ status: 'running', observedDeaths: 1, durationMs: 2000 });
    model.control(control(model, 'pause'));
    model.syncStatuses([{ ...monitor, status: 'missing', currentSnapshot: false }]);
    model.syncStatuses([{ ...monitor, status: 'settled', currentSnapshot: true }]);
    model.observe(parsed([death(1000), death(3000), tick(4000)]), meta(dir), who());
    expect(session(model)).toMatchObject({ status: 'paused', observedDeaths: 1, durationMs: 2000 });
  });
});
