import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ExpansionStore } from '../electron/expansion-store';
import { LiveController } from '../electron/live/controller';
import { emptySummary, type ParsedReplay, type ReplayEvent } from '../src/parser';
import { experienceRequirement } from '../src/domain/experience-table';
import type { CharacterIdentity, LiveStreamStatus } from '../src/shared/types';
import type { KillExperienceControl } from '../src/shared/kill-experience';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function profile() {
  await mkdir('.qa', { recursive: true });
  const dir = await mkdtemp(path.resolve('.qa/kill-experience-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'estimate.sqlite'), store = new ExpansionStore(file);
  cleanups.push(() => store.close());
  return { dir, file, store, model: store.killExperience };
}
const who = (id = 1): CharacterIdentity => ({ key: `recorded:${id}:Player`, name: `Player ${id}`, source: 'recorded', playerId: id });
const tick = (timestamp: number): ReplayEvent => ({ id: `tick-${timestamp}`, eventType: 'status', timestamp, confidence: 'certain', statusKey: 'hp', amount: 100 });
function death(timestamp: number, target = timestamp, monsterId = 1176, life = `0:${target}:1`): ReplayEvent {
  return { id: `death-${target}-${life}`, timestamp, eventType: 'death', targetId: target, monsterId, entityKind: 'mob', confidence: 'unknown', attribution: 'unknown', rawData: { killProof: { death: 'vanish-kind-1', targetActorId: target, lifecycleId: life, scope: 'replay-local', ownership: 'unknown' } } };
}
function playerDeath(timestamp: number, id = `player-death-${timestamp}`, playerId = 1, baseLevel: number | null = 10, jobLevel: number | null = 10, jobTrack: string | null = 'second'): ReplayEvent {
  return { id, timestamp, eventType: 'player-death', actorId: playerId, targetId: playerId, entityKind: 'pc', confidence: 'certain', attribution: 'personal', rawData: { source: 'own-death-vanish', observedDeath: true, baseLevel, jobLevel, jobTrack } };
}
const expectedLoss = (kind: 'base' | 'job', level: number, percent: number, track: 'second' = 'second') => Number(BigInt(experienceRequirement(kind, level, track)!.required!) * BigInt(percent) / 100n);
function parsed(events: ReplayEvent[], id = 1, startedAt = '2026-11-01T00:00:00Z'): ParsedReplay {
  return { filename: `${id}.rrf`, format: 'RRF', version: 5, status: 'partial', profile: 'rrf-v5-latam', compatibility: 'skadi-unverified', diagnostics: [], unknownPackets: [], packetCount: events.length, events, summary: { ...emptySummary(), characterName: `Player ${id}`, playerId: id, startedAt } };
}
function meta(dir: string, id = 1, streamId = `stream-${id}`) { return { sourcePath: path.join(dir, `${id}.rrf`), streamId, hash: `hash-${id}`, recordingId: `recording-${id}` }; }
const command = (id = 1, action: KillExperienceControl['action'] = 'start'): KillExperienceControl => ({ characterKey: who(id).key, streamId: `stream-${id}`, recordingId: `recording-${id}`, action });
const rate = (id = 1, baseExp: number | null = 100, jobExp: number | null = 50, monsterId = 1176) => ({ characterKey: who(id).key, monsterId, baseExp, jobExp });
const session = (model: ExpansionStore['killExperience'], id = 1) => model.snapshot().characters.find(value => value.characterKey === who(id).key)!.session!;
function statuses(dir: string, id = 1, status: LiveStreamStatus = 'following') { return [{ id: `stream-${id}`, sourcePath: meta(dir, id).sourcePath, status, character: who(id) }]; }
const mob = (timestamp: number, target = 500, life = `0:${target}:1`, mapId = 'pay_dun00') => ({ ...death(timestamp, target, 1176, life), mapId });
function partyStart(ids = [1, 2, 3]): KillExperienceControl {
  return { ...command(ids[0]), sources: ids.map(id => ({ characterKey: who(id).key, streamId: `stream-${id}`, recordingId: `recording-${id}` })) };
}
function partyControl(model: ExpansionStore['killExperience'], action: KillExperienceControl['action'], id = 1): KillExperienceControl {
  const current = session(model, id);
  return { characterKey: who(id).key, streamId: current.streamId, recordingId: current.recordingId, sessionId: current.id, groupId: current.groupId!, action };
}
async function partyProfile(ids = [1, 2, 3]) {
  const value = await profile();
  for (const id of ids) { value.model.observe(parsed([tick(0)], id), meta(value.dir, id), who(id)); value.model.setRate(rate(id, id * 100, id * 50)); }
  value.model.control(partyStart(ids)); return value;
}

describe('death observation EXP estimates', () => {
  it('starts at the current replay frontier, excludes existing deaths and only counts confirmed monster deaths', async () => {
    const { dir, model } = await profile(), old = death(1000);
    model.observe(parsed([old, tick(2000)]), meta(dir), who()); model.setRate(rate()); model.control(command());
    const fake = { ...death(4000), entityKind: 'pc' }, damage = { ...death(5000), eventType: 'damage' as const };
    model.observe(parsed([old, death(3000), fake, damage, tick(6000)]), meta(dir), who());
    expect(session(model)).toMatchObject({ status: 'running', observedDeaths: 1, durationMs: 4000, base: { gained: 100 }, job: { gained: 50 } });
  });
  it('keeps three character rates independent and never folds another source into the selected character session', async () => {
    const { dir, model } = await profile();
    for (let id = 1; id <= 3; id++) { model.observe(parsed([tick(0)], id), meta(dir, id), who(id)); model.setRate(rate(id, id * 100, id * 10)); model.control(command(id)); }
    const copy = { ...meta(dir), sourcePath: path.join(dir, 'copy.rrf'), streamId: 'copy' };
    model.observe(parsed([death(1000), tick(3600000)]), copy, who());
    expect(session(model).observedDeaths).toBe(0);
    for (let id = 1; id <= 3; id++) model.observe(parsed([death(1000), tick(3600000)], id), meta(dir, id), who(id));
    expect([1, 2, 3].map(id => session(model, id).base.gained)).toEqual([100, 200, 300]);
    expect(model.snapshot()).not.toHaveProperty('total');
  });
  it('deduplicates rereads and same lifecycle while counting later respawns and new deaths at the same timestamp', async () => {
    const { dir, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate()); model.control(command());
    const one = death(1000, 42), repeat = death(1000, 42), respawn = death(2000, 42, 1176, '0:42:2');
    model.observe(parsed([one, repeat, tick(2000)]), meta(dir), who()); model.observe(parsed([one, repeat, tick(2000)]), meta(dir), who());
    model.observe(parsed([one, repeat, respawn, death(2000, 43)]), meta(dir), who());
    expect(session(model).observedDeaths).toBe(3); expect(session(model).base.gained).toBe(300);
  });
  it('freezes per-death awards so a rate edit changes only future observations', async () => {
    const { dir, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate()); model.control(command());
    model.observe(parsed([death(1000), tick(2000)]), meta(dir), who()); model.setRate(rate(1, 250, 80));
    model.observe(parsed([death(1000), death(3000), tick(4000)]), meta(dir), who());
    expect(session(model).base.gained).toBe(350); expect(session(model).job.gained).toBe(130);
  });
  it('excludes existing boundary deaths while accepting a newly appended lifecycle at the same timestamp', async () => {
    const { dir, model } = await profile(), old = death(1000, 1);
    model.observe(parsed([old]), meta(dir), who()); model.setRate(rate()); model.control(command());
    model.observe(parsed([old, death(1000, 2)]), meta(dir), who());
    expect(session(model)).toMatchObject({ observedDeaths: 1, durationMs: 0, base: { gained: 100, perHour: null } });
  });
  it('tracks missing Base and Job independently, retains known subtotals and never reprices missing historical deaths', async () => {
    const { dir, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate(1, 100, null)); model.control(command());
    model.observe(parsed([death(1000), death(2000, 8, 9999), tick(3600000)]), meta(dir), who());
    expect(session(model).base).toMatchObject({ gained: null, knownGained: 100, perHour: null, knownPerHour: 100, missingDeaths: 1 });
    expect(session(model).job).toMatchObject({ gained: null, knownGained: 0, perHour: null, knownPerHour: 0, missingDeaths: 2 });
    model.setRate(rate(1, 100, 50)); model.setRate(rate(1, 10, 10, 9999));
    expect(session(model).base.missingDeaths).toBe(1); expect(session(model).job.missingDeaths).toBe(2);
  });
  it('treats explicit zero as known and leaves rates unavailable at zero duration', async () => {
    const { dir, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate(1, 0, 0)); model.control(command());
    expect(session(model).base.perHour).toBeNull(); model.observe(parsed([death(1000), tick(3600000)]), meta(dir), who());
    expect(session(model).base).toMatchObject({ gained: 0, knownGained: 0, missingDeaths: 0, perHour: 0 });
  });
  it('includes active idle replay time but never advances from the wall clock or repeated frozen snapshots', async () => {
    const { dir, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate()); model.control(command());
    model.observe(parsed([death(1000), tick(3600000)]), { ...meta(dir), observedAt: '2026-11-01T04:00:00Z' }, who());
    expect(session(model).base.perHour).toBe(100);
    model.observe(parsed([death(1000), tick(3600000)]), { ...meta(dir), observedAt: '2026-11-02T04:00:00Z' }, who());
    expect(session(model).durationMs).toBe(3600000);
    model.observe(parsed([death(1000), tick(7200000)]), meta(dir), who()); expect(session(model).base.perHour).toBe(50);
  });
  it('pauses and resumes at a new baseline, skipping both unobserved death and time gaps', async () => {
    const { dir, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate()); model.control(command());
    model.observe(parsed([death(1000), tick(3600000)]), meta(dir), who()); model.control(command(1, 'pause'));
    const paused = [death(1000), death(7200000), tick(10800000)]; model.observe(parsed(paused), meta(dir), who());
    model.control(command(1, 'resume')); model.observe(parsed([...paused, death(10801000), tick(14400000)]), meta(dir), who());
    expect(session(model)).toMatchObject({ observedDeaths: 2, durationMs: 7200000, base: { gained: 200, perHour: 100 } });
  });
  it('handles missing or externally paused sources with a quiet return baseline', async () => {
    const { dir, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate()); model.control(command());
    model.observe(parsed([death(1000), tick(2000)]), meta(dir), who()); model.syncStatuses(statuses(dir, 1, 'missing'));
    expect(session(model).status).toBe('source-unavailable');
    model.syncStatuses(statuses(dir)); const comeback = [death(1000), death(3000), tick(4000)]; model.observe(parsed(comeback), meta(dir), who());
    expect(session(model)).toMatchObject({ status: 'running', observedDeaths: 1, durationMs: 2000 });
    model.observe(parsed([...comeback, death(5000), tick(6000)]), meta(dir), who());
    expect(session(model)).toMatchObject({ observedDeaths: 2, durationMs: 4000 });
    model.syncStatuses(statuses(dir, 1, 'paused')); expect(session(model).status).toBe('source-unavailable');
  });
  it('resets only the estimate at the current frontier and preserves configured rates and original stores', async () => {
    const { dir, store, model } = await profile(); store.autoFarm.setPrice({ itemId: 501, unitPrice: 123 });
    model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate()); model.control(command()); model.observe(parsed([death(1000), tick(2000)]), meta(dir), who());
    const oldId = session(model).id; model.control(command(1, 'reset'));
    expect(session(model)).toMatchObject({ observedDeaths: 0, durationMs: 0, status: 'running', base: { gained: 0 } }); expect(session(model).id).not.toBe(oldId);
    model.observe(parsed([death(1000), death(3000), tick(4000)]), meta(dir), who()); expect(session(model).base.gained).toBe(100);
    expect(store.autoFarm.snapshot().prices[0].unitPrice).toBe(123); expect(store.killCount.snapshot().totals.observedDeaths).toBe(0); expect(model.snapshot().characters[0].rates[0].baseExp).toBe(100);
  });
  it('preserves rates and totals across restart, reattaches a new stream ID and quietly skips the closed interval', async () => {
    const { dir, file, store, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate()); model.control(command());
    model.observe(parsed([death(1000), tick(2000)]), meta(dir), who()); store.close(); cleanups.pop();
    const reopened = new ExpansionStore(file); cleanups.push(() => reopened.close()); const next = reopened.killExperience;
    expect(session(next)).toMatchObject({ status: 'source-unavailable', observedDeaths: 1, base: { gained: 100 } });
    const current = [death(1000), death(3000), tick(4000)], changedMeta = meta(dir, 1, 'new-stream');
    next.observe(parsed(current), changedMeta, who()); expect(session(next)).toMatchObject({ status: 'running', streamId: 'new-stream', observedDeaths: 1, durationMs: 2000 });
    next.observe(parsed([...current, death(5000), tick(6000)]), changedMeta, who()); expect(session(next)).toMatchObject({ observedDeaths: 2, durationMs: 4000, base: { gained: 200 } });
    expect(next.snapshot().characters[0].characterName).toBe('Player 1');
  });
  it('detects recording replacement or truncation, freezes the prior estimate and requires a new start', async () => {
    const { dir, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate()); model.control(command()); model.observe(parsed([death(1000), tick(2000)]), meta(dir), who());
    model.observe(parsed([death(3000)], 1, '2026-11-01T02:00:00Z'), { ...meta(dir), recordingId: 'changed' }, who());
    expect(session(model)).toMatchObject({ status: 'recording-changed', observedDeaths: 1 });
    expect(() => model.control({ ...command(1, 'resume'), recordingId: 'changed' })).toThrow(/yeni/);
    model.control({ ...command(), recordingId: 'changed' }); expect(session(model).observedDeaths).toBe(0);
    model.observe(parsed([tick(0)], 1, '2026-11-01T02:00:00Z'), { ...meta(dir), recordingId: 'changed', recordingReset: true }, who()); expect(session(model).status).toBe('recording-changed');
    model.control({ ...command(1, 'stop'), recordingId: 'changed' }); expect(session(model).status).toBe('stopped');
  });
  it('stops on character reassignment and rejects mismatched or stale controls', async () => {
    const { dir, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate()); model.control(command());
    expect(() => model.control({ ...command(), recordingId: 'stale' })).toThrow();
    model.syncStatuses([{ ...statuses(dir)[0], character: who(2) }]); expect(session(model).status).toBe('recording-changed');
    model.control(command(1, 'stop')); expect(session(model).status).toBe('stopped');
    expect(() => model.control(command(1, 'resume'))).toThrow();
  });
  it('requires a new measurement when a selected stream is repointed to a different source file', async () => {
    const { dir, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate()); model.control(command());
    model.observe(parsed([death(1000)]), { ...meta(dir), sourcePath: path.join(dir, 'replacement.rrf') }, who());
    expect(session(model)).toMatchObject({ status: 'recording-changed', observedDeaths: 0 });
    expect(() => model.control(command(1, 'resume'))).toThrow();
  });
  it('prunes temporary loading identities after assignment and removal while retaining saved rate and session profiles', async () => {
    const { dir, model } = await profile();
    const loading = { ...statuses(dir)[0], status: 'reading' as const, character: { key: 'unassigned:stream-1', name: '1.rrf', source: 'unassigned' as const, playerId: null } };
    model.syncStatuses([loading]); expect(model.snapshot().characters.map(value => value.characterKey)).toEqual(['unassigned:stream-1']);
    model.syncStatuses([1, 2, 3, 4].map(id => statuses(dir, id)[0]));
    expect(model.snapshot().characters.map(value => value.characterKey)).toEqual([1, 2, 3, 4].map(id => who(id).key));
    model.setRate(rate(2)); model.observe(parsed([tick(0)], 3), meta(dir, 3), who(3)); model.control(command(3));
    model.syncStatuses([]);
    expect(model.snapshot().characters.map(value => value.characterKey).sort()).toEqual([who(2).key, who(3).key].sort());
    expect(session(model, 3).status).toBe('source-unavailable');
  });
  it('uses saved Kill Count names for rate-only profiles after restart without recreating temporary identities', async () => {
    const { dir, file, store, model } = await profile(); store.killCount.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate());
    store.close(); cleanups.pop();
    const reopened = new ExpansionStore(file); cleanups.push(() => reopened.close()); reopened.killExperience.syncStatuses([]);
    expect(reopened.killExperience.snapshot().characters).toEqual([expect.objectContaining({ characterKey: who().key, characterName: 'Player 1', session: null, rates: [expect.objectContaining({ baseExp: 100, jobExp: 50 })] })]);
  });
  it('rejects malformed rates, negative/fractional/nonfinite/unsafe EXP and unknown control fields', async () => {
    const { model } = await profile();
    for (const bad of [-1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, undefined, '100']) expect(() => model.setRate({ ...rate(), baseExp: bad as number })).toThrow();
    for (const monsterId of [0, -1, 1.5, 0x100000000]) expect(() => model.setRate({ ...rate(), monsterId })).toThrow();
    expect(() => model.setRate({ ...rate(), characterKey: '\n' })).toThrow();
    expect(() => model.setRate({ ...rate(), bonus: 2 } as ReturnType<typeof rate>)).toThrow();
    expect(() => model.control({ ...command(), multiplier: 2 } as KillExperienceControl)).toThrow();
    expect(model.snapshot().characters).toEqual([]);
  });
  it('rolls back overflow awards and stops the estimate without poisoning its prior totals', async () => {
    const { dir, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate(1, Number.MAX_SAFE_INTEGER, 0)); model.control(command());
    model.observe(parsed([death(1000), tick(3600000)]), meta(dir), who());
    expect(() => model.observe(parsed([death(1000), death(3600001), tick(7200000)]), meta(dir), who())).toThrow(/sınır/);
    expect(session(model)).toMatchObject({ status: 'stopped', observedDeaths: 1, durationMs: 3600000, base: { gained: Number.MAX_SAFE_INTEGER } });
  });
  it('adds schema 5 without changing prior finance, kill tables or saved preferences', async () => {
    const { file, store } = await profile(); store.setSetting('preserve-me', { value: 4 }); store.autoFarm.setPrice({ itemId: 501, unitPrice: 456 }); store.close(); cleanups.pop();
    const edit = new DatabaseSync(file); try { edit.exec('DROP TABLE kill_experience_losses; DROP TABLE kill_experience_penalties; DROP TABLE kill_experience_awards; DROP TABLE kill_experience_sessions; DROP TABLE kill_experience_rates; DROP TABLE IF EXISTS solo_experience_calendar_awards;DROP TABLE IF EXISTS solo_experience_calendar_intervals;DROP TABLE IF EXISTS solo_experience_calendar_sessions;DELETE FROM expansion_migrations WHERE version>=12;DELETE FROM expansion_migrations WHERE version>=5;'); } finally { edit.close(); }
    const reopened = new ExpansionStore(file); cleanups.push(() => reopened.close()); expect(reopened.getSetting('preserve-me')).toEqual({ value: 4 }); expect(reopened.autoFarm.snapshot().prices[0].unitPrice).toBe(456); expect(reopened.killCount.snapshot().totals.observedDeaths).toBe(0);
    const check = new DatabaseSync(file, { readOnly: true }); try { expect(check.prepare('SELECT MAX(version) version FROM expansion_migrations').get()?.version).toBe(13); expect(check.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok'); expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]); } finally { check.close(); }
  });
  it('defaults death penalties to disabled, counts only owner deaths and excludes existing deaths at start', async () => {
    const { dir, model } = await profile(), old = playerDeath(1000);
    model.observe(parsed([old, tick(2000)]), meta(dir), who()); model.control(command());
    model.observe(parsed([old, playerDeath(3000, 'own', 1, null, null, null), playerDeath(4000, 'other', 99), { ...playerDeath(5000), rawData: {} }, tick(3602000)]), meta(dir), who());
    expect(model.snapshot().characters[0].deathPenaltyPercent).toBe(0);
    expect(session(model)).toMatchObject({ observedPlayerDeaths: 1, observedDeaths: 0, base: { gained: 0, lost: 0, missingLosses: 0, net: 0, perHour: 0 }, job: { lost: 0, net: 0 } });
  });
  it('applies per-character 5 or 10 percent to both death-time level requirements and permits a negative net', async () => {
    const { dir, model } = await profile();
    for (const id of [1, 2]) {
      model.observe(parsed([tick(0)], id), meta(dir, id), who(id)); model.setRate(rate(id)); model.setDeathPenalty({ characterKey: who(id).key, percent: id === 1 ? 5 : 10 }); model.control(command(id));
      model.observe(parsed([death(1000), playerDeath(2000, `owner-${id}`, id), tick(3600000)], id), meta(dir, id), who(id));
    }
    for (const id of [1, 2]) {
      const percent = id === 1 ? 5 : 10, baseLoss = expectedLoss('base', 10, percent), jobLoss = expectedLoss('job', 10, percent);
      expect(session(model, id)).toMatchObject({ observedPlayerDeaths: 1, base: { gained: 100, lost: baseLoss, net: 100 - baseLoss, perHour: 100 - baseLoss }, job: { gained: 50, lost: jobLoss, net: 50 - jobLoss } });
    }
    expect(session(model).base.net).toBeLessThan(0);
  });
  it('freezes each death penalty award and handles separate same-timestamp resurrected deaths by packet identity', async () => {
    const { dir, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.control(command());
    const one = playerDeath(1000, 'first'); model.observe(parsed([one, tick(2000)]), meta(dir), who());
    model.setDeathPenalty({ characterKey: who().key, percent: 5 }); const two = playerDeath(3000, 'second');
    model.observe(parsed([one, two, tick(4000)]), meta(dir), who());
    model.setDeathPenalty({ characterKey: who().key, percent: 10 }); const three = playerDeath(5000, 'third'), four = playerDeath(5000, 'fourth');
    model.observe(parsed([one, two, three, three, four, tick(6000)]), meta(dir), who());
    const lost = expectedLoss('base', 10, 5) + 2 * expectedLoss('base', 10, 10);
    expect(session(model)).toMatchObject({ observedPlayerDeaths: 4, base: { lost, net: -lost } });
    model.setDeathPenalty({ characterKey: who().key, percent: 0 }); model.observe(parsed([one, two, three, four, playerDeath(7000), tick(8000)]), meta(dir), who());
    expect(session(model)).toMatchObject({ observedPlayerDeaths: 5, base: { lost } });
  });
  it('keeps absent, unsupported or capped death requirements unknown independently for Base and Job', async () => {
    const { dir, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setDeathPenalty({ characterKey: who().key, percent: 5 }); model.control(command());
    model.observe(parsed([playerDeath(1000, 'no-base', 1, null, 10), playerDeath(2000, 'no-job-track', 1, 10, 10, null), playerDeath(3000, 'outside-table', 1, 9999, 9999), tick(3600000)]), meta(dir), who());
    expect(session(model).base).toMatchObject({ gained: 0, lost: null, knownLost: expectedLoss('base', 10, 5), missingLosses: 2, net: null, perHour: null, knownNet: -expectedLoss('base', 10, 5), knownPerHour: -expectedLoss('base', 10, 5) });
    expect(session(model).job).toMatchObject({ lost: null, knownLost: expectedLoss('job', 10, 5), missingLosses: 2, net: null });
  });
  it('skips death losses across pause, source copies and restart gaps while retaining future configuration', async () => {
    const { dir, file, store, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setDeathPenalty({ characterKey: who().key, percent: 5 }); model.control(command());
    const one = playerDeath(1000), two = playerDeath(3000), three = playerDeath(5000), four = playerDeath(7000), five = playerDeath(9000);
    model.observe(parsed([one, tick(2000)]), meta(dir), who()); model.control(command(1, 'pause')); model.observe(parsed([one, two, tick(4000)]), meta(dir), who()); model.control(command(1, 'resume'));
    model.observe(parsed([one, two, three, tick(6000)]), meta(dir), who()); model.observe(parsed([one, two, three, four]), { ...meta(dir), streamId: 'copy', sourcePath: path.join(dir, 'copy.rrf') }, who());
    expect(session(model).observedPlayerDeaths).toBe(2); store.close(); cleanups.pop();
    const reopened = new ExpansionStore(file); cleanups.push(() => reopened.close()); const next = reopened.killExperience;
    next.observe(parsed([one, two, three, four, tick(8000)]), meta(dir), who()); next.observe(parsed([one, two, three, four, five, tick(10000)]), meta(dir), who());
    expect(session(next)).toMatchObject({ observedPlayerDeaths: 3, durationMs: 6000, base: { lost: 3 * expectedLoss('base', 10, 5) } });
    expect(next.snapshot().characters[0].deathPenaltyPercent).toBe(5);
    next.control(command(1, 'reset')); expect(session(next)).toMatchObject({ observedPlayerDeaths: 0, base: { lost: 0, net: 0 } });
  });
  it('retains penalty-only profiles and validates allowed percentages without touching existing estimates', async () => {
    const { model } = await profile();
    for (const percent of [-5, 1, 15, 5.5, NaN, undefined, '5']) expect(() => model.setDeathPenalty({ characterKey: who().key, percent } as never)).toThrow();
    expect(() => model.setDeathPenalty({ characterKey: who().key, percent: 5, both: true } as never)).toThrow();
    model.setDeathPenalty({ characterKey: who().key, percent: 10 }); model.syncStatuses([]);
    expect(model.snapshot().characters).toEqual([expect.objectContaining({ characterKey: who().key, deathPenaltyPercent: 10, rates: [], session: null })]);
  });
  it('migrates legacy v5 session JSON loss defaults without rewriting gross awards or user preferences', async () => {
    const { dir, file, store, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate()); model.control(command()); model.observe(parsed([death(1000), tick(3600000)]), meta(dir), who()); store.setSetting('keep-v5', { x: 1 }); store.close(); cleanups.pop();
    const edit = new DatabaseSync(file); try {
      const row = edit.prepare('SELECT id,data_json FROM kill_experience_sessions').get()!, legacy = JSON.parse(String(row.data_json)); delete legacy.observedPlayerDeaths;
      for (const track of [legacy.base, legacy.job]) for (const key of ['lost', 'knownLost', 'net', 'knownNet', 'missingLosses']) delete track[key];
      edit.prepare('UPDATE kill_experience_sessions SET data_json=? WHERE id=?').run(JSON.stringify(legacy), String(row.id));
      edit.exec('DROP TABLE kill_experience_losses; DROP TABLE kill_experience_penalties; DROP TABLE IF EXISTS solo_experience_calendar_awards;DROP TABLE IF EXISTS solo_experience_calendar_intervals;DROP TABLE IF EXISTS solo_experience_calendar_sessions;DELETE FROM expansion_migrations WHERE version>=12;DELETE FROM expansion_migrations WHERE version>=6;');
    } finally { edit.close(); }
    const reopened = new ExpansionStore(file); cleanups.push(() => reopened.close()); expect(reopened.getSetting('keep-v5')).toEqual({ x: 1 });
    expect(session(reopened.killExperience)).toMatchObject({ observedDeaths: 1, observedPlayerDeaths: 0, base: { gained: 100, lost: 0, net: 100, knownNet: 100, perHour: 100 } });
    expect(reopened.killExperience.snapshot().characters[0].deathPenaltyPercent).toBe(0);
    const check = new DatabaseSync(file, { readOnly: true }); try { expect(check.prepare('SELECT COUNT(*) total FROM kill_experience_awards').get()?.total).toBe(1); expect(check.prepare('SELECT MAX(version) version FROM expansion_migrations').get()?.version).toBe(13); expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]); } finally { check.close(); }
  });
  it('shares one approximately matched party death across three personal rates without multiplying Replay time', async () => {
    const { dir, model } = await partyProfile();
    for (const id of [1, 2, 3]) model.observe(parsed([mob(1000), tick(3600000)], id), meta(dir, id), who(id));
    for (const id of [1, 2, 3]) expect(session(model, id)).toMatchObject({ mode: 'party', rawObservations: 3, duplicateCandidates: 2, estimatedDeaths: 1, observedDeaths: 1, durationMs: 3600000, base: { gained: id * 100, perHour: id * 100 }, coverage: { availableSources: 3, totalSources: 3, partial: false } });
    expect(new Set([1, 2, 3].map(id => session(model, id).groupId)).size).toBe(1);
  });
  it('preserves rapid same-actor respawns within a source while matching their two lifecycles across sources', async () => {
    const { dir, model } = await partyProfile();
    for (const id of [1, 2, 3]) model.observe(parsed([mob(1000, 500, `${id}:500:1`), mob(1450, 500, `${id}:500:2`), tick(2000)], id), meta(dir, id), who(id));
    expect(session(model)).toMatchObject({ rawObservations: 6, duplicateCandidates: 4, estimatedDeaths: 2, base: { gained: 200 } });
    for (const id of [1, 2, 3]) model.observe(parsed([mob(1000, 500, `${id}:500:1`), mob(1450, 500, `${id}:500:2`), tick(2000)], id), meta(dir, id), who(id));
    expect(session(model).rawObservations).toBe(6);
  });
  it('keeps maps, actor IDs, time windows and missing clock/map observations separate instead of claiming verified unique kills', async () => {
    const { dir, model } = await partyProfile();
    model.observe(parsed([mob(1000), mob(1100, 501), tick(2000)]), meta(dir), who());
    model.observe(parsed([mob(1000, 500, '0:500:1', 'another_map'), mob(4000, 501), { ...mob(5000, 502), mapId: undefined }, tick(6000)], 2), meta(dir, 2), who(2));
    const unknownClock = parsed([mob(1000), tick(2000)], 3); unknownClock.summary.startedAt = null;
    model.observe(unknownClock, meta(dir, 3), who(3));
    expect(session(model).status).toBe('recording-changed');
    // A clock disappearing changes recording identity and safely stops the fixed group.
    expect(session(model)).toMatchObject({ rawObservations: 5, duplicateCandidates: 0, estimatedDeaths: 5, coverage: { matchingUnavailable: 1 } });
  });
  it('discloses unavailable matching when a selected Replay has no recording clock from the beginning', async () => {
    const { dir, model } = await profile();
    for (const id of [1, 2]) { const value = parsed([tick(0)], id); value.summary.startedAt = null; model.observe(value, meta(dir, id), who(id)); model.setRate(rate(id)); }
    model.control(partyStart([1, 2]));
    for (const id of [1, 2]) { const value = parsed([mob(1000), tick(2000)], id); value.summary.startedAt = null; model.observe(value, meta(dir, id), who(id)); }
    expect(session(model)).toMatchObject({ rawObservations: 2, duplicateCandidates: 0, estimatedDeaths: 2, durationMs: 2000, coverage: { matchingUnavailable: 2 } });
  });
  it('uses aligned recording intervals rather than adding different recording start offsets to shared duration', async () => {
    const { dir, model } = await profile();
    model.observe(parsed([tick(300000)]), meta(dir), who()); model.setRate(rate());
    model.observe(parsed([tick(0)], 2, '2026-11-01T00:05:00Z'), meta(dir, 2), who(2)); model.setRate(rate(2));
    model.control(partyStart([1, 2]));
    model.observe(parsed([tick(300000), mob(301000), tick(360000)]), meta(dir), who());
    model.observe(parsed([mob(1000), tick(60000)], 2, '2026-11-01T00:05:00Z'), meta(dir, 2), who(2));
    expect(session(model)).toMatchObject({ durationMs: 60000, rawObservations: 2, estimatedDeaths: 1, duplicateCandidates: 1, base: { perHour: 6000 } });
  });
  it('applies personal death losses only to the owner and freezes future rate changes on shared awards', async () => {
    const { dir, model } = await partyProfile(); model.setDeathPenalty({ characterKey: who().key, percent: 5 }); model.setDeathPenalty({ characterKey: who(2).key, percent: 10 });
    model.observe(parsed([mob(1000), playerDeath(2000), tick(3000)]), meta(dir), who());
    expect(session(model).base.lost).toBe(expectedLoss('base', 10, 5)); expect(session(model, 2).base.lost).toBe(0); expect(session(model, 3).observedPlayerDeaths).toBe(0);
    model.setRate(rate(2, 999, 888));
    model.observe(parsed([mob(1000), playerDeath(2000, 'other-death', 1), mob(4000, 501), playerDeath(5000, 'owner-b', 2), tick(6000)], 2), meta(dir, 2), who(2));
    expect(session(model, 2)).toMatchObject({ observedPlayerDeaths: 1, base: { gained: 200 + 999, lost: expectedLoss('base', 10, 10) } });
    expect(session(model)).toMatchObject({ observedPlayerDeaths: 1, base: { gained: 200 } }); expect(session(model, 3).base.gained).toBe(600);
  });
  it('pauses the whole group and rejects delayed source backfill before the common resume frontier', async () => {
    const { dir, model } = await partyProfile();
    model.observe(parsed([mob(1000), tick(2000)]), meta(dir), who()); model.control(partyControl(model, 'pause'));
    model.observe(parsed([mob(1000), mob(3000, 501), tick(4000)]), meta(dir), who());
    model.control(partyControl(model, 'resume'));
    // Source B had no updated paused snapshot; its delayed unique 3000ms observation must stay outside this segment.
    model.observe(parsed([mob(3000, 999), tick(4000)], 2), meta(dir, 2), who(2));
    model.observe(parsed([mob(1000), mob(3000, 501), mob(5000, 502), tick(6000)]), meta(dir), who());
    expect(session(model)).toMatchObject({ estimatedDeaths: 2, durationMs: 4000, base: { gained: 200 } });
    expect([1, 2, 3].map(id => session(model, id).status)).toEqual(['running', 'running', 'running']);
  });
  it('continues with partial coverage during member loss and quietly baselines a returning member', async () => {
    const { dir, model } = await partyProfile();
    for (const id of [1, 2, 3]) model.observe(parsed([mob(1000), tick(2000)], id), meta(dir, id), who(id));
    model.syncStatuses([...statuses(dir), ...statuses(dir, 2), ...statuses(dir, 3, 'missing')]);
    model.observe(parsed([mob(1000), mob(3000, 501), tick(4000)]), meta(dir), who());
    expect(session(model)).toMatchObject({ status: 'running', estimatedDeaths: 2, coverage: { availableSources: 2, totalSources: 3, partial: true } });
    model.syncStatuses([...statuses(dir), ...statuses(dir, 2), ...statuses(dir, 3)]);
    model.observe(parsed([mob(1000), mob(3000, 999), tick(4000)], 3), meta(dir, 3), who(3));
    expect(session(model).estimatedDeaths).toBe(2);
    model.observe(parsed([mob(1000), mob(3000, 999), mob(5000, 502), tick(6000)], 3), meta(dir, 3), who(3));
    expect(session(model)).toMatchObject({ estimatedDeaths: 3, coverage: { availableSources: 3, partial: false } });
  });
  it('does not move the active shared cutoff when a missing member returns ahead of the other Replay clocks', async () => {
    const { dir, model } = await partyProfile();
    model.observe(parsed([tick(110000)]), meta(dir), who());
    model.syncStatuses([...statuses(dir), ...statuses(dir, 2), ...statuses(dir, 3, 'missing')]);
    model.syncStatuses([...statuses(dir), ...statuses(dir, 2), ...statuses(dir, 3)]);
    model.observe(parsed([mob(119000, 800), tick(120000)], 3), meta(dir, 3), who(3));
    expect(session(model).estimatedDeaths).toBe(0);
    model.observe(parsed([mob(115000, 801), tick(116000)]), meta(dir), who());
    expect(session(model)).toMatchObject({ estimatedDeaths: 1, durationMs: 116000, base: { gained: 100 } });
  });
  it('preserves shared counters through restart, skips closed backfill and keeps source-local loss isolation', async () => {
    const { dir, file, store, model } = await partyProfile();
    for (const id of [1, 2, 3]) model.observe(parsed([mob(1000), tick(2000)], id), meta(dir, id), who(id));
    store.close(); cleanups.pop(); const reopened = new ExpansionStore(file); cleanups.push(() => reopened.close()); const next = reopened.killExperience;
    for (const id of [1, 2, 3]) next.observe(parsed([mob(1000), mob(3000, 501), tick(4000)], id), meta(dir, id, `reattach-${id}`), who(id));
    expect(session(next)).toMatchObject({ estimatedDeaths: 1, rawObservations: 3, durationMs: 2000 });
    for (const id of [1, 2, 3]) next.observe(parsed([mob(1000), mob(3000, 501), mob(5000, 502), tick(6000)], id), meta(dir, id, `reattach-${id}`), who(id));
    expect(session(next)).toMatchObject({ estimatedDeaths: 2, rawObservations: 6, duplicateCandidates: 4, durationMs: 4000, streamId: 'reattach-1' });
  });
  it('fixes group membership, rejects stale and terminal controls, and closes old groups entirely when regrouping', async () => {
    const { dir, model } = await partyProfile([1, 2, 3, 4]); const original = partyControl(model, 'reset');
    expect(() => model.control({ ...original, sources: partyStart([1, 2]).sources })).toThrow(/üyelerini/);
    model.control(original); expect(() => model.control(original)).toThrow(/değişti/);
    model.control(partyControl(model, 'stop')); expect(() => model.control(partyControl(model, 'pause'))).toThrow(/Durdurulmuş/); expect(() => model.control(partyControl(model, 'resume'))).toThrow();
    model.control(partyStart([1, 2, 3])); const oldGroup = session(model, 3).groupId;
    model.control(partyStart([1, 4]));
    expect(session(model, 2).status).toBe('stopped'); expect(session(model, 3)).toMatchObject({ groupId: oldGroup, status: 'stopped' });
    expect(session(model).groupId).toBe(session(model, 4).groupId); expect(session(model).groupId).not.toBe(oldGroup);
    model.observe(parsed([tick(0)], 4, '2026-11-01T00:05:00Z'), { ...meta(dir, 4), recordingId: 'replacement' }, who(4));
    expect(session(model).status).toBe('recording-changed'); expect(session(model, 4).status).toBe('recording-changed');
  });
  it('upgrades a v6 single estimate to v7 defaults without changing its award or penalty history', async () => {
    const { dir, file, store, model } = await profile(); model.observe(parsed([tick(0)]), meta(dir), who()); model.setRate(rate()); model.setDeathPenalty({ characterKey: who().key, percent: 5 }); model.control(command()); model.observe(parsed([mob(1000), playerDeath(2000), tick(3600000)]), meta(dir), who()); store.close(); cleanups.pop();
    const edit = new DatabaseSync(file); try {
      const row = edit.prepare('SELECT id,data_json FROM kill_experience_sessions').get()!, old = JSON.parse(String(row.data_json));
      for (const key of ['mode', 'groupId', 'sources', 'rawObservations', 'duplicateCandidates', 'estimatedDeaths', 'matchingWindowMs', 'coverage']) delete old[key];
      edit.prepare('UPDATE kill_experience_sessions SET data_json=? WHERE id=?').run(JSON.stringify(old), String(row.id));
      edit.exec('DROP TABLE kill_experience_group_observations; DROP TABLE kill_experience_group_candidates; DROP TABLE kill_experience_group_intervals; DROP TABLE kill_experience_groups; DROP TABLE IF EXISTS solo_experience_calendar_awards;DROP TABLE IF EXISTS solo_experience_calendar_intervals;DROP TABLE IF EXISTS solo_experience_calendar_sessions;DELETE FROM expansion_migrations WHERE version>=12;DELETE FROM expansion_migrations WHERE version>=7;');
    } finally { edit.close(); }
    const reopened = new ExpansionStore(file); cleanups.push(() => reopened.close());
    expect(session(reopened.killExperience)).toMatchObject({ mode: 'single', groupId: null, rawObservations: 1, estimatedDeaths: 1, base: { gained: 100, lost: expectedLoss('base', 10, 5) } });
    expect(reopened.killExperience.snapshot().characters[0].deathPenaltyPercent).toBe(5);
    const check = new DatabaseSync(file, { readOnly: true }); try { expect(check.prepare('SELECT COUNT(*) total FROM kill_experience_losses').get()?.total).toBe(1); expect(check.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok'); expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]); } finally { check.close(); }
  });
  it('freshens an unread paused gap through an in-flight old parser before resuming, without dropping the first future death', async () => {
    const { dir, model } = await profile(), files = [1, 2].map(id => path.join(dir, `${id}.rrf`));
    let enteredOld!: () => void, releaseOld!: () => void;
    const entered = new Promise<void>(resolve => { enteredOld = resolve; }), release = new Promise<void>(resolve => { releaseOld = resolve; });
    const events = (phase: number) => phase === 0 ? [tick(0)] : [mob(1000), ...(phase >= 2 ? [mob(3000, 501)] : []), ...(phase >= 3 ? [mob(5000, 502)] : []), tick(phase * 2000)];
    const live = new LiveController({ autoPoll: false, limits: { maxWorkers: 2, memoryBudgetBytes: 3 * 1024 * 1024, settleMs: 0 },
      parser: async (bytes, filename) => { const id = Number(path.basename(filename, '.rrf')), phase = bytes.byteLength - 352; if (phase === 1 && id === 1) { enteredOld(); await release; } return parsed(events(phase), id); },
      onSnapshot: (value, snapshot) => model.observe(value, { ...snapshot, recordingId: `recording-${value.summary.playerId}` }, who(value.summary.playerId!)),
    });
    cleanups.push(() => live.close());
    for (const file of files) await writeFile(file, new Uint8Array(352));
    await live.addFiles(files); await live.waitForIdle();
    const bindings = live.snapshot().streams.map(stream => ({ characterKey: who(Number(path.basename(stream.filename, '.rrf'))).key, streamId: stream.id, recordingId: `recording-${Number(path.basename(stream.filename, '.rrf'))}` }));
    for (const id of [1, 2]) model.setRate(rate(id));
    model.control({ ...bindings[0], action: 'start', sources: bindings }); model.control(partyControl(model, 'pause'));
    for (const file of files) await writeFile(file, new Uint8Array(353));
    await live.refresh(); await entered;
    for (const file of files) await writeFile(file, new Uint8Array(354));
    let inspected!: () => void; const firstInspection = new Promise<void>(resolve => { inspected = resolve; });
    const barrier = (async () => { await live.refresh(); inspected(); await live.waitForIdle(); await live.refresh(); await live.waitForIdle(); })();
    await firstInspection; expect(live.hasCurrentSnapshot(bindings[0].streamId)).toBe(false);
    releaseOld(); await barrier;
    expect(bindings.every(binding => live.hasCurrentSnapshot(binding.streamId))).toBe(true);
    expect(session(model)).toMatchObject({ status: 'paused', estimatedDeaths: 0, durationMs: 0 });
    model.control(partyControl(model, 'resume'));
    for (const file of files) await writeFile(file, new Uint8Array(355));
    await live.refresh(); await live.waitForIdle();
    expect(session(model)).toMatchObject({ status: 'running', estimatedDeaths: 1, rawObservations: 2, duplicateCandidates: 1, durationMs: 2000, base: { gained: 100 } });
  });
});
