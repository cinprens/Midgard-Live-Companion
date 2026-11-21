import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ExpansionStore } from '../electron/expansion-store';
import { emptySummary, emptyLiveTelemetry, type ParsedReplay, type ReplayEvent } from '../src/parser';
import type { CharacterIdentity, LiveStreamStatus } from '../src/shared/types';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const who = (id = 1): CharacterIdentity => ({ key: `char:${id}`, name: `Karakter ${id}`, playerId: id, source: 'recorded' });
const tick = (timestamp: number): ReplayEvent => ({ id: `tick-${timestamp}`, eventType: 'status', timestamp, confidence: 'certain', statusKey: 'hp', amount: 100 });
function death(timestamp: number, target = timestamp, monsterId = 1313, lifecycle = `0:${target}:1`): ReplayEvent {
  return { id: `death-${target}-${lifecycle}`, timestamp, eventType: 'death', targetId: target, monsterId, entityKind: 'mob', confidence: 'unknown', attribution: 'unknown', mapId: 'cmd_fild02', rawData: { killProof: { death: 'vanish-kind-1', targetActorId: target, lifecycleId: lifecycle, scope: 'replay-local', ownership: 'unknown' } } };
}
function replay(events: ReplayEvent[], id = 1, startedAt: string | null = '2026-11-01T12:00:00'): ParsedReplay {
  return { filename: `${id}.rrf`, format: 'RRF', version: 5, status: 'partial', profile: 'rrf-v5-latam', compatibility: 'skadi-unverified', diagnostics: [], unknownPackets: [], packetCount: events.length, events, summary: { ...emptySummary(), characterName: who(id).name, playerId: id, startedAt } };
}
function deltaReplay(events: ReplayEvent[], durationMs: number, sequence: number): ParsedReplay { return { ...replay(events), incremental: { delta: true, sequence, recordingStart: sequence === 1, eventCount: events.length }, summary: { ...replay(events).summary, durationMs } }; }
function wireDeath(timestamp: number, targetId: number, ordinal: number): ReplayEvent { return death(timestamp, targetId, 1313, `wire:0:${targetId}:${ordinal}`); }
const meta = (dir: string, id = 1, hash = 'first') => ({ sourcePath: path.join(dir, `${id}.rrf`), streamId: `stream-${id}`, recordingId: `record-${id}`, hash });
const streams = (dir: string, ids = [1], status: LiveStreamStatus = 'following') => ids.map(id => ({ id: `stream-${id}`, sourcePath: meta(dir, id).sourcePath, status, character: who(id) }));
const target = (store: ExpansionStore, id = 1313) => store.targetHunt.snapshot().targets.find(value => value.monsterId === id)!;
async function profile() { await mkdir('.qa', { recursive: true }); const dir = await mkdtemp(path.resolve('.qa/target-hunt-')); cleanup.push(() => rm(dir, { recursive: true, force: true })); const file = path.join(dir, 'timing.sqlite'), store = new ExpansionStore(file); cleanup.push(() => store.close()); return { dir, file, store, hunt: store.targetHunt }; }

describe('automatic observed target timing', () => {
  it('loads three historical deaths immediately and averages their completed 4 and 6 minute intervals', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir)); hunt.observe(replay([death(10000), death(250000), death(610000), tick(670000)]), meta(dir), who());
    expect(target(store)).toMatchObject({ monsterName: 'Mobster', deathCount: 3, completedIntervals: 2, lastIntervalMs: 360000, averageIntervalMs: 300000, sinceLastDeathMs: 60000, continuityBroken: false });
    expect(target(store).lastDeathAt).toBe('2026-11-01T12:10:10.000');
    expect(hunt.snapshot().session).toMatchObject({ status: 'tracking', activeDurationMs: 670000 });
  });
  it('keeps first-death intervals unknown and freezes elapsed Replay time on unchanged snapshots', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir)); const events = [death(60000), tick(90000)]; hunt.observe(replay(events), meta(dir), who());
    expect(target(store)).toMatchObject({ deathCount: 1, lastIntervalMs: null, averageIntervalMs: null, completedIntervals: 0, sinceLastDeathMs: 30000 });
    hunt.observe(replay(events), { ...meta(dir), observedAt: '2030-01-01T00:00:00Z' }, who()); expect(target(store).sinceLastDeathMs).toBe(30000);
  });
  it('deduplicates three asynchronously initialized source histories without breaking for unassigned character labels', async () => {
    const { dir, store, hunt } = await profile();
    let current = streams(dir, [1, 2, 3]).map(value => ({ ...value, character: { key: `unassigned:${value.id}`, name: value.id, source: 'unassigned', playerId: null } as CharacterIdentity }));
    hunt.syncStatuses(current);
    for (const id of [3, 1, 2]) {
      hunt.observe(replay([death(10000, 500), death(250000, 501), death(610000, 502), tick(670000)], id), meta(dir, id), who(id));
      current = current.map(value => value.id === `stream-${id}` ? { ...value, character: who(id) } : value); hunt.syncStatuses(current);
    }
    expect(target(store)).toMatchObject({ deathCount: 3, rawObservations: 9, duplicateCandidates: 6, completedIntervals: 2, averageIntervalMs: 300000, lastIntervalMs: 360000, sinceLastDeathMs: 60000 });
    expect(hunt.snapshot().session).toMatchObject({ activeDurationMs: 670000, coverage: { availableSources: 3, totalSources: 3, partial: false } });
  });
  it('recomputes chronological intervals when another source supplies an earlier unseen death later', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir, [1, 2]));
    hunt.observe(replay([death(10000, 500), death(610000, 502), tick(670000)]), meta(dir), who()); expect(target(store).averageIntervalMs).toBe(600000);
    hunt.observe(replay([death(250000, 501), tick(670000)], 2), meta(dir, 2), who(2));
    expect(target(store)).toMatchObject({ deathCount: 3, completedIntervals: 2, averageIntervalMs: 300000, lastIntervalMs: 360000, sinceLastDeathMs: 60000 });
  });
  it('does not manufacture a completed target interval between disjoint initial Replay recording windows', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir, [1, 2]));
    hunt.observe(replay([death(10000, 500), tick(20000)]), meta(dir), who());
    hunt.observe(replay([death(10000, 501), tick(20000)], 2, '2026-11-01T13:00:00'), meta(dir, 2), who(2));
    expect(target(store)).toMatchObject({ deathCount: 2, completedIntervals: 0, lastIntervalMs: null, averageIntervalMs: null, sinceLastDeathMs: 10000 });
    expect(hunt.snapshot().session?.activeDurationMs).toBe(40000);
  });
  it('marks elapsed target time unknown across an uncovered Replay clock gap while retaining earlier valid intervals', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir, [1, 2]));
    hunt.observe(replay([death(10000, 500), death(15000, 501), tick(20000)]), meta(dir), who());
    hunt.observe(replay([death(10000, 600, 30001), tick(20000)], 2, '2026-11-01T13:00:00'), meta(dir, 2), who(2));
    expect(target(store)).toMatchObject({ deathCount: 2, completedIntervals: 1, averageIntervalMs: 5000, lastIntervalMs: null, sinceLastDeathMs: null, continuityBroken: true });
    expect(hunt.snapshot().session?.activeDurationMs).toBe(40000);
  });
  it('keeps targets independent and updates selected target/name views without importing historical events again', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir)); hunt.observe(replay([death(10000), death(70000), death(20000, 90, 30001), death(140000, 91, 30001), tick(150000)]), meta(dir), who());
    const revision = hunt.snapshot().revision; hunt.setTargets({ monsterIds: [1313] }); expect(hunt.snapshot().revision).toBe(revision);
    hunt.setTargets({ monsterIds: [1313, 30001] }); hunt.setLocalMonsterNames(new Map([[30001, 'SENTETİK Hit Monster']]));
    expect(target(store)).toMatchObject({ deathCount: 2, averageIntervalMs: 60000 }); expect(target(store, 30001)).toMatchObject({ monsterName: 'SENTETİK Hit Monster', deathCount: 2, averageIntervalMs: 120000 });
  });
  it('allows rapid same-actor respawns but removes repeated reads and matching other-client observations', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir, [1, 2, 3]));
    for (const id of [1, 2, 3]) { const value = replay([death(1000, 500, 1313, `${id}:500:1`), death(1450, 500, 1313, `${id}:500:2`), tick(2000)], id); hunt.observe(value, meta(dir, id), who(id)); hunt.observe(value, meta(dir, id), who(id)); }
    expect(target(store)).toMatchObject({ deathCount: 2, rawObservations: 6, duplicateCandidates: 4, lastIntervalMs: 450, averageIntervalMs: 450 });
  });
  it('breaks pause gaps, preserves old completed intervals and quietly baselines unread resumed history', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir)); const old = [death(10000), death(250000), death(610000)]; hunt.observe(replay([...old, tick(670000)]), meta(dir), who());
    hunt.syncStatuses(streams(dir, [1], 'paused')); expect(target(store)).toMatchObject({ sinceLastDeathMs: null, lastIntervalMs: null, continuityBroken: true, completedIntervals: 2, averageIntervalMs: 300000 });
    hunt.syncStatuses(streams(dir)); const gap = [...old, death(700000), tick(800000)]; hunt.observe(replay(gap), meta(dir, 1, 'return'), who()); expect(target(store).deathCount).toBe(3);
    hunt.observe(replay([...gap, death(900000), tick(930000)]), meta(dir, 1, 'fresh'), who()); expect(target(store)).toMatchObject({ deathCount: 4, lastIntervalMs: null, completedIntervals: 2, averageIntervalMs: 300000, sinceLastDeathMs: 30000 });
    hunt.observe(replay([...gap, death(900000), death(1000000), tick(1030000)]), meta(dir, 1, 'next'), who()); expect(target(store)).toMatchObject({ deathCount: 5, lastIntervalMs: 100000, completedIntervals: 3, averageIntervalMs: 700000 / 3 });
  });
  it('marks partial and resource-limited source coverage instead of timing across hidden deaths', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir, [1, 2])); const old = [death(10000), death(70000)];
    for (const id of [1, 2]) hunt.observe(replay([...old, tick(80000)], id), meta(dir, id), who(id));
    hunt.syncStatuses([...streams(dir), ...streams(dir, [2], 'resource-wait')]); hunt.observe(replay([...old, death(130000), tick(150000)]), meta(dir, 1, 'partial'), who());
    expect(target(store)).toMatchObject({ deathCount: 3, lastIntervalMs: null, completedIntervals: 1, averageIntervalMs: 60000, sinceLastDeathMs: null, continuityBroken: true });
    expect(hunt.snapshot().session?.coverage).toMatchObject({ availableSources: 1, totalSources: 2, partial: true });
  });
  it('keeps archived target totals but exposes no ghost sources after every monitored Replay is removed', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir)); hunt.observe(replay([death(10000), tick(70000)]), meta(dir), who());
    hunt.syncStatuses([]);
    expect(hunt.snapshot().session).toMatchObject({ status: 'stopped', sources: [], coverage: { availableSources: 0, totalSources: 0 } });
    expect(target(store)).toMatchObject({ deathCount: 1, sinceLastDeathMs: null, continuityBroken: true });
  });
  it('preserves counts and average through restart but never bridges the closed interval', async () => {
    const { dir, file, store, hunt } = await profile(); hunt.syncStatuses(streams(dir)); const old = [death(10000), death(70000)]; hunt.observe(replay([...old, tick(80000)]), meta(dir), who()); store.close(); cleanup.pop();
    const reopened = new ExpansionStore(file); cleanup.push(() => reopened.close()); const next = reopened.targetHunt; next.syncStatuses(streams(dir));
    const current = [...old, death(100000), tick(140000)]; next.observe(replay(current), meta(dir, 1, 'reopen'), who()); expect(target(reopened)).toMatchObject({ deathCount: 2, completedIntervals: 1, averageIntervalMs: 60000, lastIntervalMs: null, sinceLastDeathMs: null, continuityBroken: true });
    next.observe(replay([...current, death(200000), tick(230000)]), meta(dir, 1, 'new'), who()); expect(target(reopened)).toMatchObject({ deathCount: 3, lastIntervalMs: null, completedIntervals: 1, averageIntervalMs: 60000, sinceLastDeathMs: 30000 });
  });
  it('uses a durable new generation for an explicit same-header recording reset and baselines its old contents', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir)); hunt.observe(replay([death(10000, 500), tick(20000)]), meta(dir), who());
    hunt.observe(replay([tick(0)]), { ...meta(dir, 1, 'reset'), recordingReset: true }, who());
    hunt.observe(replay([death(10000, 500), tick(20000)]), meta(dir, 1, 'new-generation'), who());
    expect(target(store)).toMatchObject({ deathCount: 2, lastIntervalMs: null, completedIntervals: 0 });
  });
  it('leaves timing unknown when map or recording clock evidence is missing', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir));
    hunt.observe(replay([{ ...death(10000), mapId: undefined }, { ...death(70000), mapId: undefined }, tick(80000)]), meta(dir), who());
    expect(target(store)).toMatchObject({ deathCount: 2, completedIntervals: 0, lastIntervalMs: null, averageIntervalMs: null, sinceLastDeathMs: null });
    const { dir: secondDir, store: second, hunt: noClock } = await profile(); noClock.syncStatuses(streams(secondDir)); noClock.observe(replay([death(10000), death(70000), tick(80000)], 1, null), meta(secondDir), who());
    expect(target(second)).toMatchObject({ deathCount: 2, lastDeathAt: null, lastIntervalMs: null, averageIntervalMs: null, sinceLastDeathMs: null });
    expect(noClock.snapshot().session?.coverage.matchingUnavailable).toBe(2);
  });
  it('never treats damage, player deaths, NPC deaths or unsupported proof as a target kill', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir));
    hunt.observe(replay([{ ...death(10), eventType: 'damage' }, { ...death(20), entityKind: 'pc' }, { ...death(30), eventType: 'player-death' }, { ...death(40), rawData: {} }, tick(100)]), meta(dir), who());
    expect(target(store)).toMatchObject({ deathCount: 0, averageIntervalMs: null });
    for (const monsterIds of [[0], [-1], [1.2], [0x100000000], ['1313']]) expect(() => hunt.setTargets({ monsterIds } as never)).toThrow();
  });
  it('disables EXP persistence explicitly while preserving inventory observations and default compatibility', async () => {
    const { dir, store } = await profile();
    const value = replay([tick(0)]); value.summary.liveTelemetry = { ...emptyLiveTelemetry(), baseLevel: 10, currentBaseExp: 100 };
    store.observeReplay(value, { ...meta(dir), size: 1, includeExperience: false }, who());
    value.events.push({ id: 'exp', timestamp: 1000, eventType: 'exp-gain', expKind: 'base', amount: 200, actorId: 1, confidence: 'certain', attribution: 'personal' }, { id: 'item', timestamp: 1000, eventType: 'item-obtained', itemId: 501, amount: 2, actorId:1, confidence: 'certain',rawData:{inventoryAction:'incoming',inventorySource:'unknown',parserProof:'source-defined-add-delta',quantitySemantics:'added-delta',inventoryBaseline:false,inventoryWeightProof:{kind:'own-weight-increase',ownerActorId:1,before:100,after:120,receiptTimestamp:1000,weightTimestamp:1100,confirmedAt:1500,scope:'receipt-batch'}} });
    store.observeReplay(value, { ...meta(dir, 1, 'updated'), size: 2, includeExperience: false }, who());
    expect(store.stats()).toMatchObject({ expEvents: 0, expSnapshots: 0, inventoryEvents: 1 });
    store.observeReplay(value, { ...meta(dir, 1, 'compatibility'), size: 3 }, who()); expect(store.stats().expSnapshots).toBe(1);
  });
  it('adds timing tables at schema 8 without deleting old finance, settings or archived EXP tables', async () => {
    const { file, store } = await profile(); store.autoFarm.setPrice({ itemId: 501, unitPrice: 123 }); store.setSetting('keep', true); store.close(); cleanup.pop();
    const edit = new DatabaseSync(file); try { edit.exec('DROP TABLE target_hunt_observations; DROP TABLE target_hunt_candidates; DROP TABLE target_hunt_intervals; DROP TABLE target_hunt_sources; DROP TABLE target_hunt_metadata; DROP TABLE IF EXISTS solo_experience_calendar_awards;DROP TABLE IF EXISTS solo_experience_calendar_intervals;DROP TABLE IF EXISTS solo_experience_calendar_sessions;DELETE FROM expansion_migrations WHERE version>=12;DELETE FROM expansion_migrations WHERE version>=8;'); } finally { edit.close(); }
    const reopened = new ExpansionStore(file); cleanup.push(() => reopened.close()); expect(reopened.getSetting('keep')).toBe(true); expect(reopened.autoFarm.snapshot().prices[0].unitPrice).toBe(123);
    const check = new DatabaseSync(file, { readOnly: true }); try { expect(check.prepare('SELECT MAX(version) version FROM expansion_migrations').get()?.version).toBe(13); expect(check.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='kill_experience_awards'").get()?.n).toBe(1); expect(check.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok'); expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]); } finally { check.close(); }
  });
  it('keeps every resumed bootstrap batch quiet without shrinking saved frontier or bridging its gap', async () => {
    const { dir, file, store, hunt } = await profile(); hunt.syncStatuses(streams(dir));
    hunt.observe(replay([death(1000), death(2000), tick(3000)]), meta(dir), who());store.close();cleanup.pop();
    const opened = new ExpansionStore(file); cleanup.push(() => opened.close()); const resumed = opened.targetHunt; resumed.syncStatuses(streams(dir));
    resumed.observe(deltaReplay([death(1000)], 1000, 1), { ...meta(dir, 1, 'prefix'), bootstrap: true }, who());
    resumed.observe(deltaReplay([death(2000), death(4000)], 5000, 2), { ...meta(dir, 1, 'bootstrap-end'), bootstrap: true }, who());
    expect(target(opened)).toMatchObject({ deathCount: 2, completedIntervals: 1, sinceLastDeathMs: null });
    expect(resumed.snapshot().session?.activeDurationMs).toBe(3000);
    resumed.observe(deltaReplay([death(6000)], 7000, 3), meta(dir, 1, 'live'), who());
    expect(target(opened)).toMatchObject({ deathCount: 3, completedIntervals: 1, lastIntervalMs: null, sinceLastDeathMs: 1000 });
    resumed.observe(deltaReplay([death(8000)], 9000, 4), meta(dir, 1, 'live-next'), who());
    expect(target(opened)).toMatchObject({ deathCount: 4, completedIntervals: 2, averageIntervalMs: 1500, lastIntervalMs: 2000 });
  });
  it('counts first-source delta history across all bootstrap batches and safely rebuilds shorter prefixes', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir));
    hunt.observe(deltaReplay([death(100)], 200, 1), { ...meta(dir), bootstrap: true }, who());
    hunt.observe(deltaReplay([death(400)], 500, 2), { ...meta(dir), bootstrap: true }, who());
    expect(target(store)).toMatchObject({ deathCount: 2, completedIntervals: 1, averageIntervalMs: 300, sinceLastDeathMs: 100 });
    hunt.observe(deltaReplay([death(100)], 200, 1), { ...meta(dir), bootstrap: true }, who());
    expect(target(store)).toMatchObject({ deathCount: 2, completedIntervals: 1, averageIntervalMs: 300, sinceLastDeathMs: 100 });
    expect(hunt.snapshot().session?.activeDurationMs).toBe(500);
  });
  it('rebuilds cached intervals when a late source fills an earlier coverage gap', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir, [1, 2, 3]));
    hunt.observe(replay([death(10000, 1), tick(20000)]), meta(dir), who());
    hunt.observe(replay([death(10000, 2), tick(20000)], 2, '2026-11-01T13:00:00'), meta(dir, 2), who(2));
    expect(target(store).completedIntervals).toBe(0);
    hunt.observe(replay([tick(3600000)], 3, '2026-11-01T12:00:20'), meta(dir, 3), who(3));
    expect(target(store)).toMatchObject({ deathCount: 2, completedIntervals: 1, averageIntervalMs: 3600000 });
  });
  it('aliases legacy observations on decoder upgrade without swallowing a second same-time wire lifecycle', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir));
    hunt.observe(replay([death(100, 10), tick(100)]), meta(dir), who());
    hunt.observe(deltaReplay([wireDeath(100, 10, 5)], 100, 1), meta(dir, 1, 'upgrade'), who());
    expect(target(store)).toMatchObject({ deathCount: 1, rawObservations: 1 });
    hunt.observe(deltaReplay([wireDeath(100, 10, 6)], 100, 2), meta(dir, 1, 'respawn'), who());
    expect(target(store)).toMatchObject({ deathCount: 2, rawObservations: 2 });
    hunt.observe(deltaReplay([wireDeath(100, 10, 5), wireDeath(100, 10, 6)], 100, 3), meta(dir, 1, 'rebuild'), who());
    hunt.observe(replay([death(100, 10), death(100, 10, 1313, '0:10:2'), tick(100)]), meta(dir, 1, 'legacy-fallback'), who());
    expect(target(store)).toMatchObject({ deathCount: 2, rawObservations: 2 });
    hunt.observe(deltaReplay([wireDeath(100, 10, 7)], 100, 4), meta(dir, 1, 'third-respawn'), who());
    expect(target(store)).toMatchObject({ deathCount: 3, rawObservations: 3 });
  });
  it('updates tail aggregates without reading complete history on status-only and chronological append batches', async () => {
    const { dir, store, hunt } = await profile(); hunt.syncStatuses(streams(dir));
    hunt.observe(replay([...Array.from({ length: 10000 }, (_, index) => death(index + 1, index + 10)), tick(20000)]), meta(dir), who());
    expect(target(store).completedIntervals).toBe(9999);
    const internal = hunt as unknown as { db: DatabaseSync }, db = internal.db, queries: string[] = [];
    internal.db = new Proxy(db, { get(original, property) { if (property === 'prepare') return (sql: string) => { queries.push(sql); return original.prepare(sql); }; const value = (original as unknown as Record<string | symbol, unknown>)[property]; return typeof value === 'function' ? value.bind(original) : value; } });
    try {
      hunt.observe(deltaReplay([], 25000, 1), meta(dir, 1, 'status-only'), who());
      expect(target(store)).toMatchObject({ deathCount: 10000, completedIntervals: 9999, averageIntervalMs: 1, sinceLastDeathMs: 15000 });
      hunt.observe(deltaReplay([death(30000, 50000)], 35000, 2), meta(dir, 1, 'append'), who());
      expect(target(store)).toMatchObject({ deathCount: 10001, completedIntervals: 10000, lastIntervalMs: 20000, averageIntervalMs: 29999 / 10000 });
      expect(queries.some(sql => sql.includes('LAG(') || sql.includes('COUNT(*) raw'))).toBe(false);
    } finally { internal.db = db; }
  });
});
