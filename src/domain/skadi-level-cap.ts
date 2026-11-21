import {jobTrackForClass} from '../parser/telemetry';
import {replayClockBasis} from '../shared/replay-clock-basis';
import {experienceRequirement, type ExperienceKind} from './experience-table';

export const SKADI_EXP_REBALANCE_DAY = '2026-11-12';
export const SKADI_LEVEL_POLICY = {
  asOf: '2026-11-21', base: 80, job: 70,
  jobCaps: {novice: 10, first: 50, second: 70},
  baseSource: 'https://roz.mygnjoy.com/en/news/notice/192',
  jobSource: 'https://roz.mygnjoy.com/en/intro/guide/21',
} as const;

// Service reopening times in official maintenance completion notices 136 and 192.
const octoberExpansion = Date.parse('2026-10-01T07:15:00Z');
const novemberExpansion = Date.parse('2026-11-12T04:45:00Z');

// Official guide 21, verified 2026-11-21. The value at index L is the cost
// to reach L+1. This indexing also matches the post-update Skadi Replay headers.
const baseRequirements = [
  2100, 2400, 2700, 3100, 3500, 4000, 4600, 5200, 5900, 6700,
  7700, 8800, 10100, 11600, 13300, 15200, 17400, 20000, 23000, 26400,
  30300, 34800, 40000, 46000, 52900, 60800, 69900, 80300, 92300, 106100,
  122000, 140300, 161300, 185400, 213200, 245100, 281800, 324000, 372600, 428400,
  492600, 566400, 651300, 748900, 861200, 990300, 1138800, 1309600, 1506000, 1731900,
  8659500, 9525400, 10477900, 11525600, 12678100, 13945900, 15340400, 16874400, 18561800, 20417900,
  81671600, 89838700, 98822500, 108704700, 119575100, 131532600, 144685800, 159154300, 175069700, 192576600,
  577729800, 606616200, 636947000, 668794300, 702234000, 737345700, 774212900, 812923500, 853569600, 896248000,
] as const;

export function usesRebalancedExp(startedAt:string|null):boolean {
  const time = replayClockBasis(startedAt).anchorMs;
  return time !== null && time >= novemberExpansion;
}

export function replayTrackAtCap(kind:ExperienceKind, level:number|null, startedAt:string|null,
  jobClassId?:number|null):boolean {
  if (level===null || !Number.isSafeInteger(level) || level<1) return false;
  const time = replayClockBasis(startedAt).anchorMs;
  if (time===null || time<octoberExpansion) return false;
  if (kind==='base') return level === (time>=novemberExpansion ? SKADI_LEVEL_POLICY.base : 70);
  const track = jobTrackForClass(jobClassId??null);
  return track!==null && level===SKADI_LEVEL_POLICY.jobCaps[track];
}

/** Current Global guide costs. Callers select the applicable rules from the recording date. */
export function skadiNextLevelRequirement(kind:ExperienceKind, level:number|null, jobClassId?:number|null):number|null {
  if (level===null || !Number.isSafeInteger(level) || level<1) return null;
  if (kind==='base') return baseRequirements[level]??null;
  const track = jobTrackForClass(jobClassId??null);
  if (track===null || level>=SKADI_LEVEL_POLICY.jobCaps[track]) return null;
  // The three Job tables match the pre-patch edition of the official guide.
  return experienceRequirement('job',level,track)?.required??null;
}
