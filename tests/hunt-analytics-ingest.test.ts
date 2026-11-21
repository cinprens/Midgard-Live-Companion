import {afterEach, describe, expect, it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdir, mkdtemp, readdir, rm} from 'node:fs/promises';
import path from 'node:path';
import {HUNT_ANALYTICS_SCHEMA, HuntAnalyticsIngest} from '../electron/hunt-analytics-ingest';
import {ExpansionStore} from '../electron/expansion-store';
import {HuntAnalyticsStore} from '../electron/hunt-analytics-store';
import {replayClockBasis} from '../src/shared/replay-clock-basis';
import {emptySummary, type ParsedReplay, type ReplayEvent} from '../src/parser';
import type {CharacterIdentity, LiveStreamStatus} from '../src/shared/types';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
const who: CharacterIdentity = {key: 'char:1', name: 'PrensCin', playerId: 1, source: 'recorded'};
const source = path.resolve('.qa/analytics-input.rrf');
const info = (hash: string, initial = false) => ({sourcePath: source, streamId: 'stream:1', hash, recordingId: 'record:1', initial});
function death(timestamp: number, targetId = timestamp): ReplayEvent {return {id: String(timestamp), timestamp, eventType: 'death', targetId, monsterId: 1313, monsterName: 'Mobster', mapId: 'cmd_fild02', entityKind: 'mob', confidence: 'unknown', rawData: {killProof: {death: 'vanish-kind-1', targetActorId: targetId, lifecycleId: `wire:${timestamp}:${targetId}`, scope: 'replay-local'}}};}
function replay(edge: number, events: ReplayEvent[] = [], startedAt: string | null = '2026-11-05T23:59:00'): ParsedReplay {return {filename: 'synthetic.rrf', format: 'RRF', version: 5, status: 'partial', profile: 'rrf-v5-latam', compatibility: 'skadi-unverified', diagnostics: [], unknownPackets: [], packetCount: events.length, events, incremental: {delta: true, sequence: edge + 1, recordingStart: edge === 0, eventCount: events.length}, summary: {...emptySummary(), startedAt, durationMs: edge, playerId: 1, characterName: who.name}};}
function fixture() {const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); db.exec(HUNT_ANALYTICS_SCHEMA); const ingest = new HuntAnalyticsIngest(db); cleanup.push(() => {ingest.close(); db.close();}); return {db, ingest};}
const monitors = (status: LiveStreamStatus = 'following') => [{id: 'stream:1', sourcePath: source, status, character: who}];

describe('explicit Replay clock interpretation', () => {
  it('interprets naive Istanbul headers independently of the machine timezone', () => {
    const previous = process.env.TZ;
    try {
      for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
        process.env.TZ = zone;
        expect(replayClockBasis('2026-11-05T23:59:00')).toMatchObject({anchorMs: Date.parse('2026-11-05T20:59:00Z'), status: 'configured', timeZone: 'Europe/Istanbul', version: 1});
      }
    } finally {if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;}
  });
  it('preserves explicit offsets and rejects impossible or missing local clocks', () => {
    expect(replayClockBasis('2026-11-05T23:59:00.123+03:00')).toMatchObject({anchorMs: Date.parse('2026-11-05T20:59:00.123Z'), status: 'explicit'});
    for (const value of [null, '2026-02-30T12:00:00', '2026-11-05T25:00:00', 'not-a-clock']) expect(replayClockBasis(value).status).toBe('unknown');
    // Turkey's 2015 daylight saving transitions include a gap and repeated clock.
    expect(replayClockBasis('2015-03-29T03:30:00').status).toBe('unknown');
    expect(replayClockBasis('2015-11-08T03:30:00').status).toBe('unknown');
  });
});

describe('automatic hunt analytics evidence ingestion', () => {
  it('keeps bootstrap history descriptive and starts prospective coverage at the read frontier', () => {
    const {db, ingest} = fixture(); ingest.syncStatuses(monitors());
    ingest.observe(replay(30000, [death(10000)]), info('old-1', true), who);
    ingest.observe(replay(60000, [death(45000)]), info('old-2', true), who);
    ingest.observe(replay(120000, [death(90000)]), info('live'), who);
    const anchor = Date.parse('2026-11-05T20:59:00Z');
    expect(db.prepare('SELECT start_ms,end_ms,provenance FROM hunt_analytics_intervals ORDER BY start_ms').all()).toEqual([{start_ms: anchor, end_ms: anchor + 60001, provenance: 'legacy'}, {start_ms: anchor + 60000, end_ms: anchor + 120001, provenance: 'prospective'}]);
    expect(db.prepare('SELECT event_ms,provenance FROM hunt_analytics_events ORDER BY replay_ms').all()).toEqual([{event_ms: anchor + 10000, provenance: 'legacy'}, {event_ms: anchor + 45000, provenance: 'legacy'}, {event_ms: anchor + 90000, provenance: 'prospective'}]);
  });
  it('includes a death in the last known packet without waiting for another packet', () => {
    const {db, ingest} = fixture(); const start = '2026-11-05T12:00:00';
    ingest.observe(replay(0, [], start), info('start', true), who);
    expect(db.prepare('SELECT COUNT(*) n FROM hunt_analytics_intervals').get()?.n).toBe(0);
    ingest.observe(replay(600000, [death(600000)], start), info('last-packet'), who);
    const result = new HuntAnalyticsStore(db).read({monsterId: 1313, date: '2026-11-05', scope: {kind: 'character', characterKey: who.key}, reference: 'previous-day', trendDays: 7});
    expect(result.current).toMatchObject({observations: 1, durationMs: 600001, excludedObservations: 0});
    expect(result.quality.partial).toBe(false);
  });
  it('assigns an exact-midnight terminal death to the new day only', () => {
    const {db, ingest} = fixture(); ingest.observe(replay(0), info('start', true), who);
    ingest.observe(replay(60000, [death(60000)]), info('midnight'), who);
    const reader = new HuntAnalyticsStore(db), query = {monsterId: 1313, scope: {kind: 'character', characterKey: who.key}, reference: 'previous-day', trendDays: 7};
    expect(reader.read({...query, date: '2026-11-05'}).current).toMatchObject({observations: 0, durationMs: 60000});
    expect(reader.read({...query, date: '2026-11-06'}).current).toMatchObject({observations: 1, durationMs: 1, ratePerHour: null, excludedObservations: 0});
  });
  it('promotes copied legacy evidence only when the original supplies a newly covered slice, including decoder aliases', () => {
    const {db, ingest} = fixture(); ingest.observe(replay(0), info('start', true), who);
    ingest.observe(replay(10000, [death(5000)]), info('live-one'), who);
    const alternate = death(17000); (alternate.rawData!.killProof as Record<string, unknown>).lifecycleId = '0:17000:1';
    ingest.observe(replay(20000, [death(15000), alternate]), {...info('copy-ahead', true), sourcePath: `${source}.copy`}, who);
    expect(db.prepare("SELECT COUNT(*) n FROM hunt_analytics_events WHERE provenance='legacy'").get()?.n).toBe(2);
    ingest.observe(replay(20000, [death(15000), death(17000)]), info('original-caught-up'), who);
    expect(db.prepare("SELECT COUNT(*) n FROM hunt_analytics_events WHERE provenance='legacy'").get()?.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM hunt_analytics_events').get()?.n).toBe(3);
    expect(db.prepare('SELECT COUNT(*) n FROM hunt_analytics_event_aliases').get()?.n).toBe(1);
    expect(new HuntAnalyticsStore(db).read({monsterId: 1313, date: '2026-11-05', scope: {kind: 'character', characterKey: who.key}, reference: 'previous-day', trendDays: 7}).current).toMatchObject({observations: 3, excludedObservations: 0, excludedDurationMs: 0});
  });
  it('never upgrades bootstrap deaths merely because old timestamps are replayed by a later snapshot', () => {
    const {db, ingest} = fixture(); const old = death(5000), alternate = death(3000); (alternate.rawData!.killProof as Record<string, unknown>).lifecycleId = '0:3000:1';
    ingest.observe(replay(5000, [old, alternate]), info('bootstrap', true), who);
    ingest.observe(replay(10000, [old, death(3000), death(8000)]), info('whole-replay'), who);
    expect(db.prepare('SELECT replay_ms,provenance FROM hunt_analytics_events ORDER BY replay_ms').all()).toEqual([{replay_ms: 3000, provenance: 'legacy'}, {replay_ms: 5000, provenance: 'legacy'}, {replay_ms: 8000, provenance: 'prospective'}]);
  });
  it('does not multiply observations when a Replay is read twice or copied to another path', () => {
    const {db, ingest} = fixture(); ingest.observe(replay(0), info('start', true), who);
    const parsed = replay(120000, [death(50000), death(80000)]);
    ingest.observe(parsed, info('first'), who); ingest.observe(parsed, info('first'), who);
    ingest.observe(parsed, {...info('copy', true), sourcePath: `${source}.copy`, recordingId: 'copied'}, who);
    expect(db.prepare('SELECT COUNT(*) n FROM hunt_analytics_events').get()?.n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) n FROM hunt_analytics_recordings').get()?.n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM hunt_analytics_sources').get()?.n).toBe(2);
    expect(db.prepare("SELECT COUNT(*) n FROM hunt_analytics_events WHERE provenance='prospective'").get()?.n).toBe(2);
  });
  it('keeps independently started same-character recordings separate for overlap exclusion', () => {
    const {db, ingest} = fixture(); ingest.observe(replay(0), info('a', true), who);
    ingest.observe(replay(60000, [death(30000)], '2026-11-05T23:59:10'), {...info('b', true), sourcePath: `${source}.other`}, who);
    expect(db.prepare('SELECT COUNT(*) n FROM hunt_analytics_recordings').get()?.n).toBe(2);
  });
  it('aliases decoder upgrades once without swallowing distinct same-time wire lifecycles', () => {
    const {db, ingest} = fixture(); ingest.observe(replay(0), info('start', true), who);
    const old = death(30000, 50); (old.rawData!.killProof as Record<string, unknown>).lifecycleId = '0:50:1';
    ingest.observe(replay(60000, [old]), info('legacy-decoder'), who);
    const first = death(30000, 50), second = death(30000, 50); (second.rawData!.killProof as Record<string, unknown>).lifecycleId = 'wire:30000:50:second';
    ingest.observe(replay(60000, [first, second]), info('wire-decoder'), who);
    ingest.observe(replay(60000, [first, second]), info('wire-reread'), who);
    expect(db.prepare('SELECT COUNT(*) n FROM hunt_analytics_events').get()?.n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) n FROM hunt_analytics_event_aliases').get()?.n).toBe(1);
  });
  it('does not bridge pause/resume gaps and retains a status and continuity ledger', () => {
    const {db, ingest} = fixture(); ingest.syncStatuses(monitors()); ingest.observe(replay(0), info('start', true), who);
    ingest.observe(replay(60000, [death(30000)]), info('live'), who);
    const firstSegment = db.prepare("SELECT segment_id FROM hunt_analytics_intervals WHERE provenance='prospective'").get()?.segment_id;
    ingest.syncStatuses(monitors('paused')); ingest.syncStatuses(monitors());
    ingest.observe(replay(180000, [death(120000)]), info('resumed'), who);
    ingest.observe(replay(240000, [death(210000)]), info('new-live'), who);
    expect(db.prepare("SELECT SUM(end_ms-start_ms) duration FROM hunt_analytics_intervals WHERE provenance='prospective'").get()?.duration).toBe(120002);
    expect(db.prepare("SELECT provenance FROM hunt_analytics_events WHERE replay_ms=120000").get()?.provenance).toBe('legacy');
    expect(db.prepare("SELECT segment_id FROM hunt_analytics_events WHERE replay_ms=210000").get()?.segment_id).not.toBe(firstSegment);
    expect(db.prepare("SELECT COUNT(*) n FROM hunt_analytics_statuses WHERE status='paused'").get()?.n).toBe(1);
  });
  it('keeps restart catchup descriptive and resumes from the new frontier', () => {
    const {db, ingest} = fixture(); ingest.observe(replay(0), info('start', true), who); ingest.observe(replay(60000, [death(30000)]), info('live'), who); ingest.close();
    const reopened = new HuntAnalyticsIngest(db); reopened.observe(replay(180000, [death(30000), death(120000)]), info('reopen', true), who); reopened.observe(replay(240000, [death(210000)]), info('new'), who);
    expect(db.prepare('SELECT replay_ms,provenance FROM hunt_analytics_events ORDER BY replay_ms').all()).toEqual([{replay_ms: 30000, provenance: 'prospective'}, {replay_ms: 120000, provenance: 'legacy'}, {replay_ms: 210000, provenance: 'prospective'}]);
    reopened.close();
  });
  it('creates one durable recording generation for a multi-batch explicit reset', () => {
    const {db, ingest} = fixture(); ingest.observe(replay(0), info('start', true), who); ingest.observe(replay(60000, [death(30000)]), info('a'), who);
    ingest.observe(replay(0), {...info('reset0', true), recordingReset: true}, who);
    ingest.observe(replay(10000), {...info('reset1', true), recordingReset: true}, who);
    ingest.observe(replay(60000, [death(30000)]), info('b'), who);
    expect(db.prepare('SELECT COUNT(*) n FROM hunt_analytics_recordings').get()?.n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) n FROM hunt_analytics_events').get()?.n).toBe(2);
    expect(db.prepare('SELECT MAX(generation) n FROM hunt_analytics_sources').get()?.n).toBe(1);
  });
  it('retains unknown clock evidence without inventing dates or duration', () => {
    const {db, ingest} = fixture(); ingest.observe(replay(120000, [death(30000)], null), info('unknown'), who);
    expect(db.prepare('SELECT event_ms,provenance FROM hunt_analytics_events').get()).toMatchObject({event_ms: null, provenance: 'legacy'});
    expect(db.prepare('SELECT COUNT(*) n FROM hunt_analytics_intervals').get()?.n).toBe(0);
  });
});

describe('analytics schema migration preservation', () => {
  it('backs up committed WAL data before schema 9 to 10 and leaves old observations/settings intact', async () => {
    await mkdir('.qa', {recursive: true}); const dir = await mkdtemp(path.resolve('.qa/analytics-migration-')); cleanup.push(() => rm(dir, {recursive: true, force: true}));
    const file = path.join(dir, 'profile.sqlite'), original = new ExpansionStore(file);
    original.killCount.observe(replay(60000, [death(30000)]), info('legacy'), who); original.setSetting('kill-view', {favoriteIds: [1313], characterKey: who.key}); original.close();
    const writer = new DatabaseSync(file); cleanup.push(() => writer.close());
    writer.exec(`PRAGMA journal_mode=WAL; DROP TABLE hunt_analytics_event_aliases; DROP TABLE hunt_analytics_events; DROP TABLE hunt_analytics_intervals; DROP TABLE hunt_analytics_sources; DROP TABLE hunt_analytics_statuses; DROP TABLE hunt_analytics_recordings; DROP TABLE hunt_analytics_metadata; DROP TABLE IF EXISTS solo_experience_calendar_awards;DROP TABLE IF EXISTS solo_experience_calendar_intervals;DROP TABLE IF EXISTS solo_experience_calendar_sessions;DELETE FROM expansion_migrations WHERE version>=12;DELETE FROM expansion_migrations WHERE version>=10;`);
    writer.prepare('INSERT INTO expansion_settings VALUES(?,?)').run('wal-only-sentinel', JSON.stringify({retained: true}));
    const oldEvents = writer.prepare('SELECT * FROM kill_count_events ORDER BY id').all(), oldSettings = writer.prepare('SELECT * FROM expansion_settings ORDER BY key').all();
    const migrated = new ExpansionStore(file); cleanup.push(() => migrated.close());
    expect(migrated.analyticsMigrationBackupPath).toBeTruthy();
    const backup = new DatabaseSync(migrated.analyticsMigrationBackupPath!, {readOnly: true});
    try {expect(backup.prepare('SELECT MAX(version) version FROM expansion_migrations').get()?.version).toBe(9); expect(backup.prepare('SELECT * FROM expansion_settings ORDER BY key').all()).toEqual(oldSettings); expect(backup.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');} finally {backup.close();}
    expect(writer.prepare('SELECT * FROM kill_count_events ORDER BY id').all()).toEqual(oldEvents);
    expect(writer.prepare('SELECT * FROM expansion_settings ORDER BY key').all()).toEqual(oldSettings);
    expect(writer.prepare('SELECT MAX(version) version FROM expansion_migrations').get()?.version).toBe(13);
    expect(writer.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect((await readdir(dir)).filter(name => name.includes('.before-hunt-analytics-'))).toHaveLength(1);
  });
});
