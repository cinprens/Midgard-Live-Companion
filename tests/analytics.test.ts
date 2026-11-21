import { describe, expect, it } from 'vitest';
import { aggregate, selectRecords } from '../src/domain/analytics';
import type { AnalysisSummary, ReplayRecord } from '../src/shared/types';

function record(id: string, summary: Partial<AnalysisSummary> = {}, patch: Partial<ReplayRecord> = {}): ReplayRecord {
  return {
    id, filename: `${id}.rrf`, hash: id, size: 100, importedAt: '2026-11-01T10:00:00Z',
    status: 'analyzed', format: 'RRF', version: '5', diagnostics: [], error: null, overlapExcluded: false,
    summary: {
      durationMs: 3600000, startedAt: '2026-10-31T10:00:00Z', mapName: 'test-map',
      characterName: 'test-player', playerId: 100, deaths: 10, personalKills: 0,
      inferredKills: 3, partyKills: 0, unknownKills: 7, damage: 100, exp: null, drops: null,
      monsters: [{monsterId: 999999, name: 'Monster #999999', deaths: 10, personalKills: 0,
        inferredKills: 3, partyKills: 0, damage: 100, lastSeenMs: 5000}], timeline: [], ...summary,
    }, ...patch,
  };
}

describe('dashboard aggregate', () => {
  it('excludes overlapping and failed sessions from every aggregate', () => {
    const result = aggregate([
      record('accepted'), record('overlap', {deaths: 1000}, {overlapExcluded: true}),
      record('error', {deaths: 1000}, {status: 'error'}), record('unsupported', {}, {status: 'unsupported', summary: null}),
    ]);
    expect(result.included.map(item => item.id)).toEqual(['accepted']);
    expect(result.deaths).toBe(10);
    expect(result.ms).toBe(3600000);
    expect(result.monsters[0].deaths).toBe(10);
    expect(result.daily).toEqual([['2026-10-31', 10]]);
  });

  it('computes rate from total duration, rather than averaging session rates', () => {
    const result = aggregate([record('short'), record('long', {durationMs: 3 * 3600000, deaths: 30})]);
    expect(result.rate).toBe(10);
    expect(result.personal).toBe(0);
    expect(result.inferred).toBe(6);
  });

  it('preserves unknown EXP/drop when any included session lacks verified data', () => {
    const result = aggregate([record('known', {exp: 400, drops: 2}), record('unknown')]);
    expect(result.exp).toBeNull();
    expect(result.drops).toBeNull();
    expect(aggregate([]).exp).toBeNull();
    expect(aggregate([]).drops).toBeNull();
  });

  it('adds verified EXP/drop only when all included values are known', () => {
    const result = aggregate([record('a', {exp: 400, drops: 2}), record('b', {exp: 50, drops: 0})]);
    expect(result.exp).toBe(450);
    expect(result.drops).toBe(2);
  });

  it('retains unknown Monster IDs and the latest per-monster observation', () => {
    const result = aggregate([record('older'), record('newer', {startedAt: '2026-11-01T08:00:00Z'})]);
    expect(result.monsters).toHaveLength(1);
    expect(result.monsters[0].monsterId).toBe(999999);
    expect(result.monsters[0].lastSeen).toBe('2026-11-01T08:00:05.000Z');
    expect(result.monsters[0].sessions).toHaveLength(2);
  });
});

describe('dashboard date filtering', () => {
  it('uses replay date, falls back to import date and excludes future records in bounded filters', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    const records = [record('old', {startedAt: '2026-09-01T00:00:00Z'}),
      record('recent'), record('unknown-date', {startedAt: null}),
      record('future', {startedAt: '2026-11-02T00:00:00Z'})];
    expect(selectRecords(records, 7, now).map(item => item.id)).toEqual(['recent', 'unknown-date']);
    expect(selectRecords(records, 0, now)).toHaveLength(4);
  });
});
