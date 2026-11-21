import type { LiveTelemetry } from '../parser/types';
import type { LiveStreamState } from '../shared/types';
import { groupLiveSources, isLiveSourceActive, selectedLiveSource } from './live-workspace';
import { replayBalanceDifference, type ReplayExperienceInterval, type ReplayExperiencePoint } from './replay-experience-comparison';
import {skadiNextLevelRequirement, usesRebalancedExp} from './skadi-level-cap';

type Track = 'base' | 'job';
type Start = {level:number; amount:number; required:number};

export interface ReplayExpTrack {
  level: number | null;
  startingLevel: number | null;
  startingBalance: number | null;
  currentBalance: number | null;
  observedGain: number | null;
  balanceChange: number | null;
  progress: {level:number; balance:number; required:number; remaining:number; percent:number; source:'last-balance'|'recording-start'; requirementSource:'replay'|'official'} | null;
}
export interface ReplayExpCharacter {
  key: string;
  name: string;
  streams: LiveStreamState[];
  stream?: LiveStreamState;
  point?: ReplayExperiencePoint;
  filename: string;
  startedAt: string | null;
  base: ReplayExpTrack;
  job: ReplayExpTrack;
}

const count = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const positive = (value: number | null | undefined) => count(value) || null;
const validStart = (value: Start | undefined): value is Start => !!value && positive(value.level) !== null &&
  positive(value.required) !== null && count(value.amount) !== null && value.amount < value.required;

function readTrack(kind: Track, startedAt:string|null, telemetry?: LiveTelemetry, point?: ReplayExperiencePoint): ReplayExpTrack {
  const opening = telemetry?.recordingStartExp?.[kind] ?? point?.exp[kind];
  const start = validStart(opening) ? opening : null;
  const levelKey = kind === 'base' ? 'baseLevel' : 'jobLevel';
  const startingLevel = start?.level ?? positive(point?.[levelKey]) ?? (kind === 'job' ? positive(telemetry?.recordingStartJobLevel) : null);
  const level = positive(telemetry?.[levelKey]) ?? startingLevel;
  const fresh = telemetry?.timedExp?.[kind];
  const balance = count(fresh?.balance);
  const sameLevelThreshold = !fresh?.reset && start && level===start.level ? start.required : null;
  const reported = fresh?.required !== undefined ? positive(fresh.required) : sameLevelThreshold;
  const useGuide = balance!==null && fresh?.required===undefined && reported===null && usesRebalancedExp(startedAt);
  // Losing Job levels can mean a class change. The session's original class is then stale.
  const jobClass = kind==='job' && fresh?.reset ? null : telemetry?.jobClassId??point?.jobClassId;
  const required = useGuide ? skadiNextLevelRequirement(kind,level,jobClass) : reported;
  const current = level !== null && balance !== null && required !== null && balance < required
    ? {level, amount:balance, required} : null;
  const measured = current ?? start;
  // Older summaries lack level provenance. Keep their last reading visible without deriving a net or progress from it.
  const lastBalance = telemetry?.[kind === 'base' ? 'currentBaseExp' : 'currentJobExp'];
  return {
    level, startingLevel, startingBalance:start?.amount ?? null,
    currentBalance:telemetry?.timedExp === undefined ? count(lastBalance) : balance,
    observedGain:count(telemetry?.[kind === 'base' ? 'baseExpGained' : 'jobExpGained']),
    balanceChange:current && start && !fresh?.reset ? replayBalanceDifference(start,current) : null,
    progress:measured && {
      level:measured.level, balance:measured.amount, required:measured.required, remaining:measured.required - measured.amount,
      percent:measured.amount / measured.required * 100, source:current ? 'last-balance' : 'recording-start',
      requirementSource:current && useGuide ? 'official' : 'replay',
    },
  };
}

const fileKey = (path: string): string => {
  const normalized = path.replace(/\\/g,'/');
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
};
const folderKey = (path: string) => fileKey(path).split('/').slice(0,-1).join('/');
function recordedKey(stream?: LiveStreamState): string | undefined {
  const summary = stream?.summary;
  if (summary?.playerId && summary.characterName) return `recorded:${summary.playerId}:${encodeURIComponent(summary.characterName)}`;
  return stream?.character?.source === 'recorded' ? stream.character.key : undefined;
}

function groupBy<T>(items: readonly T[], keyFor: (item:T)=>string): Map<string,T[]> {
  const groups = new Map<string,T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key,[item]);
  }
  return groups;
}

export function replayExperienceCharacters(streams: readonly LiveStreamState[], preferredSource?: string | null, latestStarts: readonly ReplayExperiencePoint[] = []): ReplayExpCharacter[] {
  const rows: ReplayExpCharacter[] = [];
  const archived = new Set(latestStarts);
  for (const [key, sources] of groupLiveSources(streams)) {
    // Two installations can record the same account/name in different worlds.
    const folders = groupBy(sources, s => folderKey(s.sourcePath));
    for (const [folder, local] of folders) {
      const stream = selectedLiveSource(local, preferredSource)!;
      const identity = recordedKey(stream);
      const matches = latestStarts.filter(point => point.sourcePath && (identity
        ? point.characterKey === identity && folderKey(point.sourcePath) === folder
        : fileKey(point.sourcePath) === fileKey(stream.sourcePath)));
      const latest = matches.length === 1 ? matches[0] : undefined;
      if (latest) archived.delete(latest);
      const hasTelemetry = !!stream.summary?.liveTelemetry;
      const liveStart = stream.summary?.startedAt;
      const preferred = preferredSource === stream.id || !!preferredSource && fileKey(preferredSource) === fileKey(stream.sourcePath);
      const useNewerStart = !!latest && !!liveStart && latest.startedAt > liveStart && !isLiveSourceActive(stream) && !preferred;
      const point = latest && (!hasTelemetry || useNewerStart || liveStart === latest.startedAt) ? latest : undefined;
      const fromArchive = !!point && (!hasTelemetry || useNewerStart);
      const telemetry = fromArchive ? undefined : stream.summary?.liveTelemetry;
      const startedAt = fromArchive ? point.startedAt : liveStart ?? null;
      rows.push({
        key, name:stream.character?.name || stream.summary?.characterName || point?.character || stream.filename,
        stream:fromArchive ? undefined : stream, streams:local, point,
        filename:fromArchive ? point.filename : stream.filename, startedAt,
        base:readTrack('base',startedAt,telemetry,point), job:readTrack('job',startedAt,telemetry,point),
      });
    }
  }
  for (const point of archived) {
    rows.push({key:point.characterKey, name:point.character, streams:[], point, filename:point.filename, startedAt:point.startedAt,
      base:readTrack('base',point.startedAt,undefined,point), job:readTrack('job',point.startedAt,undefined,point)});
  }
  for (const sameKey of groupBy(rows,row=>row.key).values()) {
    if (sameKey.length < 2) continue;
    for (const row of sameKey) row.key = JSON.stringify([row.key, row.point?.identity ?? folderKey(row.stream!.sourcePath)]);
  }
  return rows;
}

export function intervalForReplayCharacter(row: ReplayExpCharacter, intervals: readonly ReplayExperienceInterval[]): ReplayExperienceInterval | undefined {
  const identity = recordedKey(row.stream) ?? row.point?.characterKey;
  const path = row.stream?.sourcePath ?? row.point?.sourcePath;
  const matches = intervals.filter(interval => interval.characterKey === identity && interval.after.startedAt === row.startedAt &&
    (row.point && interval.identity ? interval.identity === row.point.identity
      : path && interval.after.sourcePath && folderKey(path) === folderKey(interval.after.sourcePath)));
  return matches.length === 1 ? matches[0] : undefined;
}
