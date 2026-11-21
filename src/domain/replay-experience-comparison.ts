import type {LiveTelemetry} from '../parser/types';
import {usesRebalancedExp} from './skadi-level-cap';

export interface ReplayExperiencePoint {
  character: string;
  characterKey: string;
  identity: string;
  filename: string;
  sourcePath?: string;
  startedAt: string;
  jobClassId: number | null;
  baseLevel?: number | null;
  jobLevel?: number | null;
  exp: NonNullable<LiveTelemetry['recordingStartExp']>;
}

export interface ReplayExperienceInterval {
  character: string;
  characterKey: string;
  before: { filename: string; startedAt: string };
  after: { filename: string; startedAt: string; sourcePath?: string };
  identity?: string;
  base: number | null;
  job: number | null;
}

export interface ReplayComparisonResult {
  intervals: ReplayExperienceInterval[];
  latestStarts?: ReplayExperiencePoint[];
  inspected: number;
  unreadable: number;
}

type Balance = {level:number; amount:number; required:number};
export function replayBalanceDifference(a: Balance, b: Balance): number | null {
  let delta: number;
  if (a.level === b.level && a.required === b.required) delta = b.amount - a.amount;
  else if (b.level === a.level + 1) delta = a.required - a.amount + b.amount;
  else return null;
  return Number.isSafeInteger(delta) ? delta : null;
}

function difference(before: ReplayExperiencePoint, after: ReplayExperiencePoint, track: 'base' | 'job'): number | null {
  // A patch can change the underlying balance without an in-game award.
  if (track === 'base' && usesRebalancedExp(before.startedAt)!==usesRebalancedExp(after.startedAt)) return null;
  const a = before.exp[track], b = after.exp[track];
  return a && b && before.jobClassId != null && before.jobClassId === after.jobClassId ? replayBalanceDifference(a,b) : null;
}

/** Duplicate copies count as one start. Conflicting copies cannot establish an endpoint. */
function endpoint(points: ReplayExperiencePoint[]): ReplayExperiencePoint | null {
  const first = points[0];
  return points.every(point => point.jobClassId === first.jobClassId &&
    point.baseLevel === first.baseLevel && point.jobLevel === first.jobLevel &&
    (['base','job'] as const).every(kind => {
      const a = first.exp[kind], b = point.exp[kind];
      return a?.amount === b?.amount && a?.level === b?.level && a?.required === b?.required;
    })) ? first : null;
}

export function summarizeReplayStarts(points: readonly ReplayExperiencePoint[]) {
  const groups = new Map<string, Map<string, ReplayExperiencePoint[]>>();
  for (const point of points) {
    const times = groups.get(point.identity) ?? new Map<string, ReplayExperiencePoint[]>();
    const copies = times.get(point.startedAt) ?? [];
    copies.push(point);
    times.set(point.startedAt, copies);
    groups.set(point.identity, times);
  }
  const intervals: ReplayExperienceInterval[] = [];
  const latestStarts: ReplayExperiencePoint[] = [];
  for (const times of groups.values()) {
    const starts = [...times.keys()].sort().slice(-2);
    const after = endpoint(times.get(starts[starts.length-1])!);
    if (!after) continue;
    latestStarts.push(after);
    if (starts.length < 2) continue;
    const before = endpoint(times.get(starts[0])!);
    if (!before) continue;
    intervals.push({
      character: after.character,
      characterKey: after.characterKey,
      before: {filename: before.filename, startedAt: before.startedAt},
      after: {filename: after.filename, startedAt: after.startedAt, sourcePath: after.sourcePath},
      identity: after.identity,
      base: difference(before, after, 'base'), job: difference(before, after, 'job'),
    });
  }
  intervals.sort((a,b) => b.after.startedAt.localeCompare(a.after.startedAt) || a.character.localeCompare(b.character, 'tr'));
  latestStarts.sort((a,b) => b.startedAt.localeCompare(a.startedAt) || a.character.localeCompare(b.character, 'tr'));
  return {intervals, latestStarts};
}

export function latestReplayIntervals(points: readonly ReplayExperiencePoint[]): ReplayExperienceInterval[] {
  return summarizeReplayStarts(points).intervals;
}
