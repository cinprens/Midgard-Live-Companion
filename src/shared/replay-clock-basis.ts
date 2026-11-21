/** Replay headers contain a local clock label, not an implicit host timezone. */
export const REPLAY_ANALYTICS_CLOCK_VERSION = 1;
export const REPLAY_ANALYTICS_TIME_ZONE = 'Europe/Istanbul';
export interface ReplayClockBasis {
  rawStartedAt: string | null;
  anchorMs: number | null;
  timeZone: string;
  version: number;
  status: 'configured' | 'explicit' | 'unknown';
}
const clock = new Intl.DateTimeFormat('en-GB', {timeZone: REPLAY_ANALYTICS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
function represented(timestamp: number): number {
  const p = Object.fromEntries(clock.formatToParts(timestamp).map(part => [part.type, part.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}
export function replayClockBasis(rawStartedAt: string | null): ReplayClockBasis {
  const unknown: ReplayClockBasis = {rawStartedAt, anchorMs: null, timeZone: REPLAY_ANALYTICS_TIME_ZONE, version: REPLAY_ANALYTICS_CLOCK_VERSION, status: 'unknown'};
  if (!rawStartedAt) return unknown;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?$/.exec(rawStartedAt);
  if (!match) return unknown;
  const [, y, m, d, h, min, s, fractional, zone] = match;
  const milliseconds = Number((fractional ?? '').padEnd(3, '0'));
  const desired = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s));
  if (Number(y) < 2000 || Number(y) > 2200 || !Number.isFinite(desired) || new Date(desired).toISOString().slice(0, 19) !== `${y}-${m}-${d}T${h}:${min}:${s}`) return unknown;
  if (zone) {
    const anchorMs = Date.parse(rawStartedAt);
    return Number.isSafeInteger(anchorMs) ? {...unknown, anchorMs, timeZone: zone === 'Z' ? 'UTC' : zone, status: 'explicit'} : unknown;
  }
  let candidate = desired;
  for (let attempt = 0; attempt < 4; attempt++) {
    const next = candidate + desired - represented(candidate);
    if (next === candidate) break;
    candidate = next;
  }
  // A skipped local clock (historic DST) cannot be silently normalized.
  if (represented(candidate) !== desired) return unknown;
  // A repeated local clock is ambiguous: do not arbitrarily select one offset.
  if (represented(candidate - 3600000) === desired || represented(candidate + 3600000) === desired) return unknown;
  return {...unknown, anchorMs: candidate + milliseconds, status: 'configured'};
}
