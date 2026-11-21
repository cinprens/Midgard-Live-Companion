import { describe, expect, it } from 'vitest';
import { decodeTelemetry, decodeSessionTelemetry, jobTrackForClass, emptyLiveTelemetry, summarizeLiveTelemetry } from '../src/parser/telemetry';
import type { ReplayEvent } from '../src/parser/types';

function status(parameter: number, amount: number | bigint, id = 0x00b0): Uint8Array {
  const bytes = new Uint8Array(id === 0x0acb ? 12 : 8);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, id, true); view.setUint16(2, parameter, true);
  if (id === 0x0acb) view.setBigInt64(4, BigInt(amount), true);
  else view.setInt32(4, Number(amount), true);
  return bytes;
}
function exp(amount: number | bigint, parameter = 1, wide = true): Uint8Array {
  const bytes = new Uint8Array(wide ? 18 : 14), view = new DataView(bytes.buffer);
  view.setUint16(0, wide ? 0x0acc : 0x07f6, true); view.setUint32(2, 42, true);
  if (wide) view.setBigInt64(6, BigInt(amount), true); else view.setInt32(6, Number(amount), true);
  view.setUint16(wide ? 14 : 10, parameter, true); view.setUint16(wide ? 16 : 12, 1, true);
  return bytes;
}
const event = (id: string, extra: Partial<ReplayEvent>): ReplayEvent => ({ id, timestamp: 100, eventType: 'status', confidence: 'certain', ...extra });

function sessionNumber(id: number, value: number | bigint, width = 4) {
  const data = new Uint8Array(width), view = new DataView(data.buffer);
  if (width === 8) view.setBigUint64(0, BigInt(value), true);
  else view.setUint32(0, Number(value), true);
  return {id, data};
}
const ownerAndLevels = [sessionNumber(1010, 42), sessionNumber(1016, 65), sessionNumber(1019, 64)];

describe('source-defined self status and EXP telemetry', () => {
  it('clears unlevelled EXP balances when the first level arrives and excludes cached or unattributed readings', () => {
    const reading = (id: string, extra: Partial<ReplayEvent>) => event(id,{actorId:42,attribution:'personal',rawData:{source:'self-parameter-update',timed:true},...extra});
    const events = [reading('absolute',{statusKey:'baseExp',amount:100}),reading('first-level',{statusKey:'baseLevel',amount:12}),
      reading('unknown-owner',{statusKey:'baseExp',amount:500,actorId:undefined}),
      reading('cached',{statusKey:'nextBaseExp',amount:1000,rawData:{source:'self-parameter-update',timed:false}}),
      reading('job-cap',{statusKey:'nextJobExp',amount:2_808_348_671})];
    expect(summarizeLiveTelemetry(events).timedExp).toEqual({base:{},job:{required:0}});
  });
  it('reads the Skadi recording owner’s opening wallet and accepts only the observed self wallet packet', () => {
    const balance = sessionNumber(1051, 24595);
    expect(decodeSessionTelemetry([...ownerAndLevels,balance]).zenyBalance).toBe(24595);
    expect(decodeSessionTelemetry([balance]).zenyBalance).toBeUndefined();
    for (const values of [[balance,balance],[sessionNumber(1051,25,8)],[sessionNumber(1051,0xffffffff)]])
      expect(decodeSessionTelemetry([...ownerAndLevels,...values]).zenyBalance).toBeUndefined();
    expect(decodeTelemetry(status(20,24475,0x00b1))).toMatchObject({kind:'status',statusKey:'zenyBalance',amount:24475});
    expect(decodeTelemetry(status(20,-1,0x00b1))?.kind).toBe('invalid');
    expect(decodeTelemetry(status(20,24475,0x00b0))).toBeNull();
    expect(decodeTelemetry(status(20,24475,0x0acb))).toBeNull();
    expect(decodeTelemetry(status(127,950,0x00b1))).toBeNull();
  });
  it('keeps a lone reading unknown for income, accepts a measured zero and ignores repeated or unowned receipts', () => {
    const first = event('a',{statusKey:'zenyBalance',amount:80,attribution:'personal',actorId:42});
    const more = {...first,id:'b',amount:120};
    const other = {...more,id:'c',amount:9000,attribution:'other' as const};
    expect(summarizeLiveTelemetry([first])).toMatchObject({zenyBalance:80,zenyReceived:null});
    expect(summarizeLiveTelemetry([first],{zenyBalance:80})).toMatchObject({zenyBalance:80,zenyReceived:0});
    expect(summarizeLiveTelemetry([first,more,other,first,more])).toMatchObject({zenyBalance:120,zenyReceived:40});
    expect(summarizeLiveTelemetry([first,more],{zenyBalance:1,zenyReceived:Number.MAX_SAFE_INTEGER})).toMatchObject({zenyBalance:120,zenyReceived:null});
  });
  it('reads the owner’s starting balances and thresholds independently from subsequent updates and rewards', () => {
    const seed = decodeSessionTelemetry([...ownerAndLevels, sessionNumber(1015, 0, 8), sessionNumber(1018, 131532600, 8),
      sessionNumber(1055, 23476466), sessionNumber(1054, 37954312)]);
    expect(seed.recordingStartExp).toEqual({base: {level: 65, amount: 0, required: 131532600},
      job: {level: 64, amount: 23476466, required: 37954312}});
    const telemetry = summarizeLiveTelemetry([event('later', {statusKey: 'baseExp', amount: 10})], seed);
    expect(telemetry.recordingStartExp).toEqual(seed.recordingStartExp);
    expect(telemetry.currentBaseExp).toBe(10);
    expect(telemetry.baseExpGained).toBeNull();
    expect(telemetry.currentJobExp).toBeNull();
  });
  it('ignores missing or ambiguous owners, wrong widths, unsafe counts, and inconsistent thresholds', () => {
    const amounts = [sessionNumber(1015, 12, 8), sessionNumber(1018, 90, 8)];
    for (const owner of [[], [sessionNumber(1010, 0)], [sessionNumber(1010, 5), sessionNumber(1010, 6)]]) {
      expect(decodeSessionTelemetry([...owner, sessionNumber(1016, 1), ...amounts]).recordingStartExp).toBeUndefined();
    }
    for (const invalid of [
      [sessionNumber(1015, 12), amounts[1]], [amounts[0], ...amounts], [sessionNumber(1015, 90, 8), amounts[1]],
      [amounts[0], sessionNumber(1018, 0, 8)], [amounts[0], sessionNumber(1018, 9007199254740992n, 8)],
    ]) {
      expect(decodeSessionTelemetry([...ownerAndLevels, ...invalid]).recordingStartExp).toBeUndefined();
    }
    const capped = decodeSessionTelemetry([...ownerAndLevels, ...amounts, sessionNumber(1054, 2808348671), sessionNumber(1055, 0)]);
    expect(capped.recordingStartExp).toEqual({base: {level: 65, amount: 12, required: 90}});
  });
  it('maps only ordinary protocol classes to the compatible job table, never from job level', () => {
    expect(jobTrackForClass(0)).toBe('novice');
    for (const id of [1, 3, 6]) expect(jobTrackForClass(id)).toBe('first');
    for (const id of [7, 8, 12, 21]) expect(jobTrackForClass(id)).toBe('second');
    for (const id of [null, -1, 1.5, NaN, Infinity, 22, 23, 24, 4001, 4008, 4096, 4252]) expect(jobTrackForClass(id)).toBeNull();
  });
  it('reads source-mapped Session levels and class without turning adjacent bytes into current EXP', () => {
    const chunk = (id: number, value: number) => {
      const data = new Uint8Array(4); new DataView(data.buffer).setUint32(0, value, true); return { id, data };
    };
    const seed = decodeSessionTelemetry([chunk(1014, 8), chunk(1016, 53), chunk(1019, 55),
      { id: 1015, data: new Uint8Array(8).fill(1) }, { id: 1018, data: new Uint8Array(8).fill(2) }]);
    expect(seed).toEqual({ jobClassId: 8, jobTrack: 'second', jobTrackSource: 'rrf-session-class', baseLevel: 53, jobLevel: 55, recordingStartJobLevel: 55 });
    const result = summarizeLiveTelemetry([], seed);
    expect(result.currentBaseExp).toBeNull(); expect(result.currentJobExp).toBeNull();
    expect(result.baseExpGained).toBeNull(); expect(result.jobExpGained).toBeNull();
  });
  it('keeps missing, wrong-width and ambiguous Session class fields unknown', () => {
    const chunk = (id: number, value: number) => {
      const data = new Uint8Array(4); new DataView(data.buffer).setUint32(0, value, true); return { id, data };
    };
    expect(decodeSessionTelemetry([])).toEqual({ jobClassId: null, jobTrack: null, jobTrackSource: null });
    expect(decodeSessionTelemetry([{ id: 1014, data: new Uint8Array(8) }]).jobTrack).toBeNull();
    expect(decodeSessionTelemetry([chunk(1014, 8), chunk(1014, 1)]).jobClassId).toBeNull();
    expect(decodeSessionTelemetry([chunk(1014, 4008), chunk(1016, 0), chunk(1019, 69)])).toEqual({
      jobClassId: 4008, jobTrack: null, jobTrackSource: null, jobLevel: 69, recordingStartJobLevel: 69 });
    expect(decodeSessionTelemetry([chunk(1019, 43)]).jobTrack).toBeNull();
  });
  it('preserves the original Session job level across replayed increases and resets', () => {
    for (const [start, current] of [[1, 50], [50, 1]]) {
      const data = new Uint8Array(4); new DataView(data.buffer).setUint32(0, start, true);
      const seed = decodeSessionTelemetry([{ id: 1019, data }]);
      const telemetry = summarizeLiveTelemetry([event('job-change', { statusKey: 'jobLevel', amount: current })], seed);
      expect(telemetry.recordingStartJobLevel).toBe(start);
      expect(telemetry.jobLevel).toBe(current);
    }
    expect(summarizeLiveTelemetry([event('job', { statusKey: 'jobLevel', amount: 50 })]).recordingStartJobLevel).toBeNull();
  });
  it('uses job level55 and never treats skill points12 or actor-init0b1b as level/status', () => {
    expect(decodeTelemetry(status(55, 43))).toMatchObject({ kind: 'status', statusKey: 'jobLevel', amount: 43 });
    expect(decodeTelemetry(status(12, 5))).toBeNull();
    expect(decodeTelemetry(new Uint8Array([0x1b, 0x0b]))).toBeNull();
    expect(decodeTelemetry(new Uint8Array([0xfb, 0x07]))).toBeNull();
    expect(decodeTelemetry(new Uint8Array([0x05, 0x0b, 1, 0, 100, 0, 0, 0]))).toBeNull();
  });
  it('supports narrow/long/64-bit current EXP status without claiming EXP gained', () => {
    expect(decodeTelemetry(status(1, 123, 0x00b1))).toMatchObject({ kind: 'status', statusKey: 'baseExp', amount: 123 });
    expect(decodeTelemetry(status(2, 1234567890123n, 0x0acb))).toMatchObject({ kind: 'status', statusKey: 'jobExp', amount: 1234567890123 });
    const telemetry = summarizeLiveTelemetry([event('a', { statusKey: 'baseExp', amount: 900 }), event('b', { statusKey: 'baseExp', amount: 1500 })]);
    expect(telemetry.currentBaseExp).toBe(1500);
    expect(telemetry.baseExpGained).toBeNull();
  });
  it('decodes explicit signed gains and losses with owner and EXP kind', () => {
    expect(decodeTelemetry(exp(700))).toEqual({ kind: 'exp', actorId: 42, expKind: 'base', amount: 700, quest: true });
    expect(decodeTelemetry(exp(-50, 2, false))).toEqual({ kind: 'exp', actorId: 42, expKind: 'job', amount: -50, quest: true });
  });
  it('rejects unsafe integers, partial or trailing layouts and negative status', () => {
    expect(decodeTelemetry(status(1, 9007199254740992n, 0x0acb))?.kind).toBe('invalid');
    expect(decodeTelemetry(exp(9007199254740992n))?.kind).toBe('invalid');
    expect(decodeTelemetry(status(24, 100).subarray(0, 7))?.kind).toBe('invalid');
    expect(decodeTelemetry(new Uint8Array([...exp(1), 0]))?.kind).toBe('invalid');
    expect(decodeTelemetry(status(24, -1))?.kind).toBe('invalid');
  });
  it('keeps unknowns null, requires positive maxWeight, and preserves ratios over100%', () => {
    expect(emptyLiveTelemetry().weightPercent).toBeNull();
    expect(summarizeLiveTelemetry([event('w', { statusKey: 'weight', amount: 65 })]).weightPercent).toBeNull();
    expect(summarizeLiveTelemetry([event('w', { statusKey: 'weight', amount: 65 }), event('m', { statusKey: 'maxWeight', amount: 100 })]).weightPercent).toBe(65);
    expect(summarizeLiveTelemetry([], { weight: 1, maxWeight: 0 }).weightPercent).toBeNull();
    expect(summarizeLiveTelemetry([], { weight: 200, maxWeight: 100 }).weightPercent).toBe(200);
  });
  it('counts only explicit own positive gains once, separates base/job, and ignores losses', () => {
    const gain = event('g', { eventType: 'exp-gain', amount: 10, expKind: 'base', attribution: 'personal' });
    const telemetry = summarizeLiveTelemetry([gain, gain,
      event('loss', { eventType: 'exp-loss', amount: -20, expKind: 'base', attribution: 'personal' }),
      event('other', { eventType: 'exp-gain', amount: 500, expKind: 'base', attribution: 'other' }),
      event('job', { eventType: 'exp-gain', amount: 3, expKind: 'job', attribution: 'personal' }),
      event('map', { eventType: 'map', mapId: 'prontera' }),
    ], { baseLevel: 50, currentMap: 'field' });
    expect(telemetry.baseExpGained).toBe(10); expect(telemetry.jobExpGained).toBe(3);
    expect(telemetry.lastBaseExpGain).toBe(10); expect(telemetry.currentBaseExp).toBeNull();
    expect(telemetry.baseLevel).toBe(50); expect(telemetry.currentMap).toBe('prontera');
  });
  it('does not round or resume a cumulative total after safe integer overflow', () => {
    const gains = [Number.MAX_SAFE_INTEGER, 1, 1].map((amount, i) => event(String(i), { eventType: 'exp-gain', expKind: 'base', amount, attribution: 'personal' }));
    expect(summarizeLiveTelemetry(gains).baseExpGained).toBeNull();
  });
});
