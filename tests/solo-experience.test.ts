import { describe, expect, it } from 'vitest';
import { captureSoloExperienceReference, projectSoloExperience, type SoloExperienceSessionInput } from '../src/domain/solo-experience';
import { emptyLiveTelemetry } from '../src/parser/telemetry';
import type { SoloExperienceReference } from '../src/shared/solo-experience';
import type { KillExperienceTrack } from '../src/shared/kill-experience';

const reference = (extra: Partial<SoloExperienceReference> = {}): SoloExperienceReference => ({ baseLevel: 1, jobLevel: 1, jobTrack: 'first', ...extra });
function track(gained: number | null, extra: Partial<KillExperienceTrack> = {}): KillExperienceTrack {
  return { gained, knownGained: gained ?? 0, perHour: -123, knownPerHour: -456, missingDeaths: 0,
    lost: 0, knownLost: 0, net: gained, knownNet: gained ?? 0, missingLosses: 0, ...extra };
}
const session = (base = 0, job = 0, durationMs = 3_600_000): SoloExperienceSessionInput => ({ base: track(base), job: track(job), durationMs });

describe('solo session estimated EXP', () => {
  it('does not report progress at the current Base or class-specific Job cap even with stale amounts',()=>{
    const projection = projectSoloExperience(captureSoloExperienceReference({...emptyLiveTelemetry(),baseLevel:80,jobLevel:50,jobClassId:1,
      timedExp:{base:{required:123},job:{required:456}}},'2026-11-21T10:00:00'),session(403,76));
    expect(projection.base).toMatchObject({gained:403,requiredExp:null,percent:null});
    expect(projection.job).toMatchObject({gained:76,requiredExp:null,percent:null});
  });
  it('only uses the applicable table and does not guess a Job class after a reset',()=>{
    const live = {...emptyLiveTelemetry(),baseLevel:57,jobLevel:30,jobClassId:8};
    const post = captureSoloExperienceReference({...live,timedExp:{job:{reset:true}}},'2026-11-12T04:45:00Z');
    expect(post.requirements).toEqual({base:{amount:16_874_400,source:'official-table'},job:null});
    expect(captureSoloExperienceReference(live,'2026-11-12T04:44:59Z').requirements).toBeUndefined();
    expect(captureSoloExperienceReference(live,null).requirements).toEqual({base:null,job:null});
    expect(captureSoloExperienceReference({...live,timedExp:{base:{required:0}}},'2026-11-13T12:00:00').requirements?.base).toBeNull();
  });
  it('reports gross gains, their starting-level equivalents and independent hourly rates', () => {
    const result = projectSoloExperience(reference(), session(1250, 170, 1_800_000));
    expect(result.base).toMatchObject({ status: 'estimated', level: 1, gained: 1250, knownGained: 1250, requiredExp: 2500, percent: 50, perHour: 2500, knownPerHour: 2500 });
    expect(result.job).toMatchObject({ status: 'estimated', level: 1, gained: 170, requiredExp: 340, percent: 50, perHour: 340 });
  });

  it('lets the percentage exceed 100 without presenting a current percentage or inferred new level', () => {
    const frozen = Object.freeze(reference());
    const result = projectSoloExperience(frozen, session(6500, 1020, 7_200_000));
    expect(result.base).toMatchObject({ level: 1, requiredExp: 2500, gained: 6500, percent: 260, perHour: 3250 });
    expect(result.job).toMatchObject({ level: 1, requiredExp: 340, percent: 300 });
    expect(result.job.perHour).toBeCloseTo(510, 8);
    expect(frozen).toEqual(reference());
    expect(result.base).not.toHaveProperty('currentExp');
    expect(result.base).not.toHaveProperty('levelsGained');
  });

  it('uses gross gained and active duration, never net or existing net hourly fields', () => {
    const s = session(500, 200, 1_800_000);
    s.base.net = -9000; s.base.lost = 9500; s.base.knownNet = -9000; s.observedPlayerDeaths = 3;
    expect(projectSoloExperience(reference(), s).base).toMatchObject({ status: 'estimated', gained: 500, percent: 20, perHour: 1000 });
  });

  it('does not invalidate known gains after a death or excluded source interval', () => {
    const s = { ...session(500, 100), observedPlayerDeaths: 1, soloCoverageIncomplete: true };
    const result = projectSoloExperience(reference(), s);
    expect(result.base).toMatchObject({ status: 'estimated', gained: 500, percent: 20, perHour: 500 });
    expect(result.job.status).toBe('estimated');
    expect(result.base.notice).toContain('eksik kalan aralıklar');
  });

  it('treats zero rates as known zero, distinct from a blank rate', () => {
    const result = projectSoloExperience(reference(), session());
    for (const value of [result.base, result.job]) expect(value).toMatchObject({ status: 'estimated', gained: 0, percent: 0, perHour: 0, knownGained: 0 });
    const s = session(500, 100); s.base = track(null, { knownGained: 500, missingDeaths: 1 });
    const partial = projectSoloExperience(reference(), s);
    expect(partial.base).toMatchObject({ status: 'incomplete', gained: null, knownGained: 500, percent: null, perHour: null, knownPerHour: 500 });
    expect(partial.job).toMatchObject({ status: 'estimated', gained: 100, perHour: 100 });
  });

  it('keeps totals unknown even if an inconsistent incomplete track carries a subtotal in gained', () => {
    const s = session(500); s.base.missingDeaths = 1;
    expect(projectSoloExperience(reference(), s).base).toMatchObject({ status: 'incomplete', gained: null, knownGained: 500, percent: null, perHour: null });
    s.base = track(null);
    expect(projectSoloExperience(reference(), s).base.status).toBe('incomplete');
  });

  it.each([null, undefined])('keeps amounts and rates usable without a reference (%s)', value => {
    const result = projectSoloExperience(value, session(500, 100));
    expect(result.base).toMatchObject({ status: 'estimated', level: null, percent: null, requiredExp: null, gained: 500, perHour: 500 });
    expect(result.job).toMatchObject({ status: 'estimated', percent: null, gained: 100, perHour: 100 });
  });

  it('uses only the selected Job table and leaves its percentage unknown when the track is unknown', () => {
    expect(projectSoloExperience(reference({ jobTrack: 'novice' }), session(0, 6)).job.percent).toBe(50);
    expect(projectSoloExperience(reference({ jobTrack: 'second' }), session(0, 1250)).job.percent).toBe(50);
    const result = projectSoloExperience(reference({ jobTrack: null }), session(500, 100));
    expect(result.base.percent).toBe(20);
    expect(result.job).toMatchObject({ status: 'estimated', level: 1, requiredExp: null, percent: null, gained: 100, perHour: 100 });
  });

  it('does not invent a requirement at the table cap or beyond the table', () => {
    const result = projectSoloExperience(reference({ baseLevel: 70, jobTrack: 'novice', jobLevel: 10 }), session(500, 100));
    expect(result.base).toMatchObject({ status: 'estimated', level: 70, requiredExp: null, percent: null, gained: 500, perHour: 500 });
    expect(result.job).toMatchObject({ level: 10, requiredExp: null, percent: null, gained: 100 });
    expect(projectSoloExperience(reference({ baseLevel: 71 }), session(500)).base.percent).toBeNull();
  });

  it.each([0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('leaves hourly rates unknown for an unavailable or invalid duration %s', durationMs => {
    const result = projectSoloExperience(reference(), session(500, 100, durationMs));
    expect(result.base).toMatchObject({ gained: 500, percent: 20, perHour: null, knownPerHour: null });
    expect(result.job.perHour).toBeNull();
  });

  it('supports short nonzero periods without silently requiring a full hour', () => {
    expect(projectSoloExperience(reference(), session(10, 0, 60_000)).base.perHour).toBe(600);
  });

  it('rejects unsafe counts and hides derived values exceeding the supported numeric range', () => {
    const s = session(Number.MAX_SAFE_INTEGER + 1); s.base.knownGained = 0;
    expect(projectSoloExperience(reference(), s).base).toMatchObject({ status: 'unavailable', gained: null, percent: null, perHour: null });
    const result = projectSoloExperience(reference({ jobTrack: 'novice' }), session(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1));
    expect(result.base.gained).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.base.perHour).toBeNull();
    expect(result.job.percent).toBeNull();
    expect(result.job.perHour).toBeNull();
  });

  it.each([-1, 0.5, NaN, Infinity])('does not calculate from invalid gained EXP %s', gained => {
    const s = session(gained); s.base.knownGained = 0;
    expect(projectSoloExperience(reference(), s).base.status).toBe('unavailable');
  });

  it('rejects invalid coverage counters without suppressing the other channel', () => {
    const s = session(500, 100); s.base.missingDeaths = NaN;
    const result = projectSoloExperience(reference(), s);
    expect(result.base.status).toBe('unavailable'); expect(result.job.status).toBe('estimated');
  });

  it('does not turn malformed saved level/table values into a percentage', () => {
    const result = projectSoloExperience({ baseLevel: 1.5, jobLevel: 1, jobTrack: 'unknown' } as unknown as SoloExperienceReference, session(500, 100));
    expect(result.base).toMatchObject({ level: null, percent: null, gained: 500 });
    expect(result.job).toMatchObject({ level: 1, percent: null, gained: 100 });
  });
});
